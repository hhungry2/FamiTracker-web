/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

#include "stdafx.h"
#include "FamiTrackerDoc.h"
#include "DetuneTable.h"
#include "Instrument.h"
#include "SeqInstrument.h"
#include "Instrument2A03.h"
#include "InstrumentFDS.h"
#include "InstrumentN163.h"
#include "InstrumentVRC7.h"
#include "DSample.h"
#include "PatternNote.h"
#include "APU/Types.h"
#include "nsf_import.h"
#include "nsf_log.h"
#include "text_encoding.h"

#include <algorithm>
#include <array>
#include <climits>
#include <cmath>
#include <cstdio>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>

namespace dnft {

using nsflog::ChannelFrame;

namespace {

// ---- the tracker's note tables (CSoundGen::DocumentPropertiesChanged()) -----------------

// A440 is note 45 in a module that is not retuned
const double A440_NOTE = 45.;

struct NoteTables {
	std::array<int, NOTE_COUNT> ntsc, pal, saw, fds, n163, s5b;
	std::array<int, NOTE_RANGE> vrc7;

	explicit NoteTables(int namcoChannels) {
		CDetuneNTSC ntscTable(A440_NOTE);
		CDetunePAL palTable(A440_NOTE);
		CDetuneSaw sawTable(A440_NOTE);
		CDetuneVRC7 vrc7Table(A440_NOTE);
		CDetuneFDS fdsTable(A440_NOTE);
		CDetuneN163 n163Table(A440_NOTE);
		CDetuneS5B s5bTable(A440_NOTE);
		for (int i = 0; i < NOTE_COUNT; ++i) {
			ntsc[i] = ntscTable.FrequencyToPeriod(ntscTable.NoteToFreq(i), 1, 0);
			pal[i] = palTable.FrequencyToPeriod(palTable.NoteToFreq(i), 1, 0);
			saw[i] = sawTable.FrequencyToPeriod(sawTable.NoteToFreq(i), 1, 0);
			if (i < NOTE_RANGE)
				vrc7[i] = vrc7Table.FrequencyToPeriod(vrc7Table.NoteToFreq(i), 1, 0);
			fds[i] = fdsTable.FrequencyToPeriod(fdsTable.NoteToFreq(i), 1, 0);
			n163[i] = std::min<int>(n163Table.FrequencyToPeriod(n163Table.NoteToFreq(i), 1, namcoChannels), 0xFFFF);
			s5b[i] = s5bTable.FrequencyToPeriod(s5bTable.NoteToFreq(i), 1, 0);
		}
	}
};

// ---- pitch ----------------------------------------------------------------------------------

// A note and the Pxx that bring the tracker's register value nearest to the NSF's
struct Pitch {
	int note;
	int fine;
};

// A note keeps sounding as it is while the pitch stays this close to it, so a vibrato or a
// slight slide shows as Pxx rather than as notes back and forth
const double KEEP_SEMITONES = 0.75;

// Among the notes from..to-1: `distance` how far a note is from the pitch, in semitones;
// `fine` the Pxx that reaches the pitch from the note, or something out of 0-255 when none
// does. The note to keep when it may stay, else the nearest one Pxx reaches.
template <typename Distance, typename Fine>
Pitch Nearest(int from, int to, int keep, Distance distance, Fine fine) {
	auto inRange = [](int f) { return f >= 0 && f <= 0xFF; };
	if (keep >= 0 && keep < NOTE_COUNT && std::abs(distance(keep)) < KEEP_SEMITONES && inRange(fine(keep)))
		return { keep, fine(keep) };
	from = std::max(from, 0);
	to = std::min(to, NOTE_COUNT);
	int best = -1;
	double bestDistance = 0;
	int closest = from;
	double closestDistance = 1e9;
	for (int n = from; n < to; ++n) {
		const double d = std::abs(distance(n));
		if (d < closestDistance) {
			closestDistance = d;
			closest = n;
		}
		if (inRange(fine(n)) && (best < 0 || d < bestDistance)) {
			best = n;
			bestDistance = d;
		}
	}
	if (best < 0)
		return { closest, std::clamp(fine(closest), 0, 0xFF) };
	return { best, fine(best) };
}

// Where `value` falls in a table that goes down (periods) or up (frequencies) with the note
int Bracket(const std::array<int, NOTE_COUNT> &table, double value) {
	const bool down = table[0] > table[NOTE_COUNT - 1];
	int lo = 0, hi = NOTE_COUNT - 1;
	while (hi - lo > 1) {
		const int mid = (lo + hi) / 2;
		if ((table[mid] > value) == down)
			lo = mid;
		else
			hi = mid;
	}
	return lo;
}

// The notes looked at around where the pitch falls in the table
const int SEARCH_NOTES = 3;

// Channels whose register is a period: the 2A03, MMC5, VRC6 and 5B's (Pxx subtracts from it)
Pitch PeriodPitch(const std::array<int, NOTE_COUNT> &table, int period, int keep) {
	period = std::max(period, 0);
	const int at = Bracket(table, period);
	return Nearest(at - SEARCH_NOTES, at + SEARCH_NOTES + 1, keep,
		[&](int n) { return 12. * std::log2((table[n] + 1.) / (period + 1.)); },
		[&](int n) { return table[n] - period + 0x80; });
}

// The FDS's frequency (Pxx adds to it)
Pitch FrequencyPitch(const std::array<int, NOTE_COUNT> &table, int freq, int keep) {
	freq = std::max(freq, 1);
	const int at = Bracket(table, freq);
	return Nearest(at - SEARCH_NOTES, at + SEARCH_NOTES + 1, keep,
		[&](int n) { return 12. * std::log2(static_cast<double>(freq) / std::max(table[n], 1)); },
		[&](int n) { return freq - table[n] + 0x80; });
}

// The N163's 18-bit frequency: the tracker writes (table + 16 * (Pxx - $80)) * 4
// (CChannelHandlerN163::CalculatePeriod()), so Pxx moves it 64 at a time. The notes either
// side of the nearest one land elsewhere between those steps: of the three, the one that
// comes closest to the frequency.
Pitch N163Pitch(const std::array<int, NOTE_COUNT> &table, int freq, int keep) {
	freq = std::max(freq, 1);
	const int at = Bracket(table, freq / 4.);
	auto fine = [&](int n) { return static_cast<int>(std::lround((freq - 4. * table[n]) / 64.)) + 0x80; };
	auto error = [&](int n) { return std::abs(freq - (4 * table[n] + 64 * (fine(n) - 0x80))); };
	const Pitch nearest = Nearest(at - SEARCH_NOTES, at + SEARCH_NOTES + 1, keep,
		[&](int n) { return 12. * std::log2(freq / (4. * std::max(table[n], 1))); }, fine);
	if (nearest.note == keep)
		return nearest;
	Pitch best = nearest;
	for (int n = std::max(nearest.note - 1, 0); n <= std::min(nearest.note + 1, NOTE_COUNT - 1); ++n) {
		const int f = fine(n);
		if (f >= 0 && f <= 0xFF && error(n) < error(best.note))
			best = { n, f };
	}
	return best;
}

// The VRC7's block and F-number: the tracker writes the note's octave as the block and its
// F-number from a table of the twelve notes, plus Pxx - $80. Notes of the octaves next to
// the block are looked at too, for F-numbers out of the table's reach.
Pitch Vrc7Pitch(const std::array<int, NOTE_RANGE> &table, int block, int fnum, int keep) {
	fnum = std::max(fnum, 1);
	auto distance = [&](int n) {
		const int octave = n / NOTE_RANGE;
		return 12. * std::log2(table[n % NOTE_RANGE] * std::ldexp(1., octave - block) / fnum);
	};
	// the F-number in the note's octave
	auto fine = [&](int n) {
		const int octave = n / NOTE_RANGE;
		return static_cast<int>(std::lround(std::ldexp(static_cast<double>(fnum), block - octave))) - table[n % NOTE_RANGE] + 0x80;
	};
	return Nearest((block - 1) * NOTE_RANGE, (block + 2) * NOTE_RANGE, keep, distance, fine);
}

// ---- what a channel does in a frame, as the tracker sees it -------------------------------

struct Shot {
	uint8_t effect = EF_NONE;
	uint8_t param = 0;
	bool operator==(const Shot &o) const { return effect == o.effect && param == o.param; }
};

const int FX_SLOTS = 3;

// The state a frame leaves a channel in. Between notes the values stay as they were, as
// they do in the tracker, so the rows of a frame follow from the states before and after it.
struct State {
	bool on = false;
	bool attack = false;			// the note restarts
	uint8_t off = NONE;				// HALT or RELEASE when the frame stops the note, else NONE
	int note = 0;					// 0-95; the noise's 0-15
	int fine = 0x80;
	int instrument = -1;
	int volume = 15;
	int duty = 0;
	int sweep = 0;					// the 2A03 pulse's sweep register while the hardware sweeps
	std::array<int, FX_SLOTS> fx { -1, -1, -1 };	// the chip's lasting effects (Converter::fxEffect)
	std::array<Shot, 2> shots { };					// effects of this frame alone

	void AddShot(effect_t effect, int param) {
		for (Shot &s : shots)
			if (s.effect == EF_NONE) {
				s.effect = effect;
				s.param = static_cast<uint8_t>(param);
				return;
			}
	}
	bool operator==(const State &o) const {
		return on == o.on && attack == o.attack && off == o.off && note == o.note && fine == o.fine &&
			instrument == o.instrument && volume == o.volume && duty == o.duty && sweep == o.sweep &&
			fx == o.fx && shots == o.shots;
	}
	uint64_t Hash() const {
		uint64_t h = 1469598103934665603ULL;
		auto mix = [&h](int v) { h = (h ^ static_cast<uint32_t>(v)) * 1099511628211ULL; };
		mix(on); mix(attack); mix(off); mix(note); mix(fine); mix(instrument); mix(volume); mix(duty); mix(sweep);
		for (int v : fx) mix(v);
		for (const Shot &s : shots) { mix(s.effect); mix(s.param); }
		return h;
	}
};

// ---- the module's instruments and samples ---------------------------------------------------

class Builder {
public:
	Builder(CFamiTrackerDoc &doc, const nsflog::Log &log, std::vector<std::string> &warnings) :
		m_Doc(doc), m_Log(log), m_Warnings(warnings) { }

	int Shared(int chip) {
		auto it = m_Shared.find(chip);
		if (it != m_Shared.end())
			return it->second;
		const char *name = chip == SNDCHIP_VRC6 ? "VRC6" : chip == SNDCHIP_S5B ? "5B" : "2A03";
		const int slot = Add(name, chip);
		m_Shared.emplace(chip, slot);
		return slot;
	}

	// One instrument for each wave the FDS played, with the modulation table it played with
	int Fds(uint16_t wave, uint16_t mod) {
		const auto key = std::make_pair(wave, mod);
		auto it = m_Fds.find(key);
		if (it != m_Fds.end())
			return it->second;
		int slot = Add("FDS " + std::to_string(m_Fds.size() + 1), SNDCHIP_FDS);
		if (slot >= 0) {
			auto pInst = std::dynamic_pointer_cast<CInstrumentFDS>(m_Doc.GetInstrument(slot));
			if (wave < m_Log.fdsWaves.size())
				for (int i = 0; i < CInstrumentFDS::WAVE_SIZE; ++i)
					pInst->SetSample(i, m_Log.fdsWaves[wave][i] & 0x3F);
			if (mod < m_Log.fdsMods.size())
				for (int i = 0; i < CInstrumentFDS::MOD_SIZE; ++i)
					pInst->SetModulation(i, m_Log.fdsMods[mod][i] & 7);
			pInst->SetModulationSpeed(0);
			pInst->SetModulationDepth(0);
			pInst->SetModulationDelay(0);
		}
		else
			slot = Fallback(m_Fds);
		m_Fds.emplace(key, slot);
		return slot;
	}

	// The N163's waves, an instrument for each place in its RAM (position and length),
	// with up to 64 waves each, chosen with Vxx: {instrument, wave}
	std::pair<int, int> N163(uint16_t wave) {
		auto it = m_N163Waves.find(wave);
		if (it != m_N163Waves.end())
			return it->second;
		std::pair<int, int> result { -1, 0 };
		if (wave < m_Log.n163Waves.size()) {
			const nsflog::N163Wave &w = m_Log.n163Waves[wave];
			int size = static_cast<int>(w.samples.size()) & ~3;
			if (size > CInstrumentN163::MAX_WAVE_SIZE) {
				Warn("n163Wave");
				size = CInstrumentN163::MAX_WAVE_SIZE;
			}
			size = std::max(size, 4);
			const auto place = std::make_pair(static_cast<int>(w.position), size);
			Group *pGroup = nullptr;
			auto g = m_N163Groups.find(place);
			if (g != m_N163Groups.end() && g->second.back().waves < CInstrumentN163::MAX_WAVE_COUNT)
				pGroup = &g->second.back();
			else {
				const int slot = Add("N163 " + std::to_string(m_N163Count + 1), SNDCHIP_N163);
				if (slot >= 0) {
					++m_N163Count;
					auto &list = m_N163Groups[place];
					list.push_back({ slot, 0 });
					pGroup = &list.back();
					auto pInst = std::dynamic_pointer_cast<CInstrumentN163>(m_Doc.GetInstrument(slot));
					pInst->SetWaveSize(size);
					pInst->SetWavePos(w.position);
					pInst->SetWaveCount(1);
				}
				else if (g != m_N163Groups.end())
					result = { g->second.back().slot, 0 };
				else if (!m_N163Groups.empty())
					result = { m_N163Groups.begin()->second.back().slot, 0 };
			}
			if (pGroup) {
				auto pInst = std::dynamic_pointer_cast<CInstrumentN163>(m_Doc.GetInstrument(pGroup->slot));
				const int index = pGroup->waves++;
				pInst->SetWaveCount(pGroup->waves);
				for (int i = 0; i < size; ++i)
					pInst->SetSample(index, i, i < static_cast<int>(w.samples.size()) ? w.samples[i] & 0x0F : 0);
				result = { pGroup->slot, index };
			}
		}
		m_N163Waves.emplace(wave, result);
		return result;
	}

	// The VRC7's patches: one instrument for each built-in one played, and for each custom one
	int Vrc7(int patch, uint16_t custom) {
		const int key = patch ? patch : 0x10000 + custom;
		auto it = m_Vrc7.find(key);
		if (it != m_Vrc7.end())
			return it->second;
		const std::string name = patch ? "VRC7 patch " + std::to_string(patch) : "VRC7 custom " + std::to_string(++m_Vrc7Custom);
		int slot = Add(name, SNDCHIP_VRC7);
		if (slot >= 0) {
			auto pInst = std::dynamic_pointer_cast<CInstrumentVRC7>(m_Doc.GetInstrument(slot));
			pInst->SetPatch(patch);
			if (!patch && custom < m_Log.vrc7Patches.size())
				for (int i = 0; i < 8; ++i)
					pInst->SetCustomReg(i, m_Log.vrc7Patches[custom][i]);
		}
		else
			slot = Fallback(m_Vrc7);
		m_Vrc7.emplace(key, slot);
		return slot;
	}

	// A key of a DPCM instrument that plays the sample at the rate: {instrument, note}, or
	// {-1, 0} when the module has no room for it
	std::pair<int, int> DpcmKey(uint16_t sample, int rate, bool loop) {
		const int key = sample << 5 | (rate & 0x0F) << 1 | (loop ? 1 : 0);
		auto it = m_Keys.find(key);
		if (it != m_Keys.end())
			return it->second;
		std::pair<int, int> result { -1, 0 };
		const int index = Sample(sample);
		if (index >= 0) {
			if (m_DpcmSlot < 0 || m_DpcmKeys >= NOTE_COUNT) {
				m_DpcmSlot = Add("DPCM " + std::to_string(++m_DpcmCount), SNDCHIP_NONE);
				m_DpcmKeys = 0;
			}
			if (m_DpcmSlot >= 0) {
				// from C-3 up, then the octaves below
				const int note = (FIRST_KEY + m_DpcmKeys++) % NOTE_COUNT;
				auto pInst = std::dynamic_pointer_cast<CInstrument2A03>(m_Doc.GetInstrument(m_DpcmSlot));
				pInst->SetSampleIndex(note / NOTE_RANGE, note % NOTE_RANGE, static_cast<char>(index + 1));
				pInst->SetSamplePitch(note / NOTE_RANGE, note % NOTE_RANGE, static_cast<char>((rate & 0x0F) | (loop ? 0x80 : 0)));
				pInst->SetSampleDeltaValue(note / NOTE_RANGE, note % NOTE_RANGE, -1);
				result = { m_DpcmSlot, note };
			}
		}
		m_Keys.emplace(key, result);
		return result;
	}

	// Once each (NsfImportResult::warnings)
	void Warn(const std::string &code) {
		if (std::find(m_Warnings.begin(), m_Warnings.end(), code) == m_Warnings.end())
			m_Warnings.push_back(code);
	}

private:
	static const int FIRST_KEY = 3 * NOTE_RANGE;

	struct Group {
		int slot;
		int waves;
	};

	int Add(const std::string &name, int chip) {
		const int slot = m_Doc.AddInstrument(text::FromUtf8(name, CInstrument::INST_NAME_MAX - 1).c_str(), chip);
		if (slot < 0) {
			Warn("instruments");
			return -1;
		}
		return slot;
	}

	template <typename Map>
	int Fallback(const Map &map) {
		for (const auto &e : map)
			if (e.second >= 0)
				return e.second;
		return -1;
	}

	// The module's sample for the log's
	int Sample(uint16_t sample) {
		auto it = m_Samples.find(sample);
		if (it != m_Samples.end())
			return it->second;
		int index = -1;
		if (sample < m_Log.samples.size()) {
			const std::vector<uint8_t> &bytes = m_Log.samples[sample];
			const unsigned size = static_cast<unsigned>(std::min<size_t>(bytes.size(), CDSample::MAX_SIZE));
			index = m_Doc.GetFreeSampleSlot();
			if (index < 0)
				Warn("samples");
			else if (m_Doc.GetTotalSampleSize() + size > static_cast<unsigned>(MAX_SAMPLE_SPACE)) {
				Warn("sampleSpace");
				index = -1;
			}
			else {
				CDSample *pSample = new CDSample(size);
				std::copy(bytes.begin(), bytes.begin() + size, reinterpret_cast<uint8_t *>(pSample->GetData()));
				pSample->SetName(("Sample " + std::to_string(sample + 1)).c_str());
				m_Doc.SetSample(index, pSample);
			}
		}
		m_Samples.emplace(sample, index);
		return index;
	}

	CFamiTrackerDoc &m_Doc;
	const nsflog::Log &m_Log;
	std::vector<std::string> &m_Warnings;
	std::map<int, int> m_Shared;
	std::map<std::pair<uint16_t, uint16_t>, int> m_Fds;
	std::map<std::pair<int, int>, std::vector<Group>> m_N163Groups;
	std::map<uint16_t, std::pair<int, int>> m_N163Waves;
	int m_N163Count = 0;
	std::map<int, int> m_Vrc7;
	int m_Vrc7Custom = 0;
	std::map<int, std::pair<int, int>> m_Keys;
	std::map<uint16_t, int> m_Samples;
	int m_DpcmSlot = -1;
	int m_DpcmKeys = 0;
	int m_DpcmCount = 0;
};

// ---- the channels ------------------------------------------------------------------------------

// Turns a channel's records into the states it is in, frame after frame
class Converter {
public:
	virtual ~Converter() = default;
	// `prev`: the state before the frame (the start state for the first), `last`: the
	// record before, or nullptr
	virtual void Convert(const ChannelFrame &f, const ChannelFrame *last, const State &prev, State &s) = 0;

	// The state before the first frame: the tracker's values when a song starts
	State Start() const {
		State s;
		s.duty = dutyDefault;
		for (int i = 0; i < FX_SLOTS; ++i)
			s.fx[i] = fxEffect[i] == EF_NONE ? -1 : fxDefault[i];
		return s;
	}

	bool hasVolume = true;
	bool hasDuty = false;
	bool hasFine = true;
	int dutyDefault = 0;
	std::array<effect_t, FX_SLOTS> fxEffect { EF_NONE, EF_NONE, EF_NONE };
	std::array<int, FX_SLOTS> fxDefault { 0, 0, 0 };
	bool fxOnNote = false;			// the FDS: a new instrument and a note reset them
	bool dutyOnInstrument = false;	// the N163: a new instrument resets the wave to the first
	bool reliableTriggers = true;	// false when the driver rewrites what restarts a note every frame

protected:
	// The usual reasons for a new note: the channel starts sounding, the driver restarts
	// it, or its volume comes back from nothing
	bool Attack(const ChannelFrame &f, const ChannelFrame *last, const State &prev) const {
		if (!prev.on)
			return true;
		if ((f.flags & nsflog::TRIGGER) && reliableTriggers)
			return true;
		// not the frame after a note began, which some drivers start silent
		return last && last->volume == 0 && f.volume > 0 && !prev.attack;
	}
	// Off: the tracker's note cut, once
	static void Off(State &s, const State &prev, uint8_t kind = HALT) {
		s.on = false;
		s.attack = false;
		s.off = prev.on ? kind : NONE;
	}
};

// The 2A03's and MMC5's pulses, the VRC6's pulses
class PulseConverter : public Converter {
public:
	enum Kind { APU_PULSE, MMC5_PULSE, VRC6_PULSE };
	PulseConverter(const std::array<int, NOTE_COUNT> &table, int instrument, Kind kind) :
		m_Table(table), m_iInstrument(instrument), m_iMaxDuty(kind == VRC6_PULSE ? 7 : 3),
		m_bVRC6(kind == VRC6_PULSE), m_bSweep(kind == APU_PULSE) {
		hasDuty = true;
	}
	void Convert(const ChannelFrame &f, const ChannelFrame *last, const State &prev, State &s) override {
		s = prev;
		s.attack = false;
		s.off = NONE;
		s.shots = { };
		s.sweep = 0;
		if (!(f.flags & nsflog::ON))
			return Off(s, prev);
		s.on = true;
		s.attack = Attack(f, last, prev);
		// The sweep unit moves the period twice a frame, more finely than a row can: the
		// tracker's Hxy and Ixy have the hardware do the same (and the tracker leaves the
		// period alone while it sweeps)
		if (m_bSweep) {
			const int reg = f.aux16a & 0xFF;
			if ((reg & 0x80) && (reg & 0x07))
				s.sweep = reg;
		}
		if (s.sweep && s.sweep == prev.sweep && !s.attack && prev.on) {
			s.note = prev.note;
			s.fine = prev.fine;
		}
		else {
			const Pitch p = PeriodPitch(m_Table, static_cast<int>(f.pitch), s.attack ? -1 : prev.note);
			s.note = p.note;
			s.fine = p.fine;
		}
		s.instrument = m_iInstrument;
		s.volume = f.volume & 0x0F;
		s.duty = f.timbre & m_iMaxDuty;
		// The driver restarted the phase, and the tracker would not: it writes the high
		// period byte (a VRC6 channel's enable) only when that changes
		if ((f.flags & nsflog::TRIGGER) && reliableTriggers && prev.on && last &&
			(m_bVRC6 || (last->pitch >> 8) == (f.pitch >> 8)))
			s.AddShot(EF_PHASE_RESET, 0);
	}

private:
	const std::array<int, NOTE_COUNT> &m_Table;
	int m_iInstrument;
	int m_iMaxDuty;
	bool m_bVRC6;
	bool m_bSweep;
};

class TriangleConverter : public Converter {
public:
	TriangleConverter(const std::array<int, NOTE_COUNT> &table, int instrument) : m_Table(table), m_iInstrument(instrument) {
		hasVolume = false;
	}
	void Convert(const ChannelFrame &f, const ChannelFrame *last, const State &prev, State &s) override {
		s = prev;
		s.attack = false;
		s.off = NONE;
		s.shots = { };
		if (!(f.flags & nsflog::ON))
			return Off(s, prev);
		s.on = true;
		s.attack = !prev.on || ((f.flags & nsflog::TRIGGER) && reliableTriggers);
		const Pitch p = PeriodPitch(m_Table, static_cast<int>(f.pitch), s.attack ? -1 : prev.note);
		s.note = p.note;
		s.fine = p.fine;
		s.instrument = m_iInstrument;
	}

private:
	const std::array<int, NOTE_COUNT> &m_Table;
	int m_iInstrument;
};

class NoiseConverter : public Converter {
public:
	explicit NoiseConverter(int instrument) : m_iInstrument(instrument) {
		hasDuty = true;
		hasFine = false;
	}
	void Convert(const ChannelFrame &f, const ChannelFrame *last, const State &prev, State &s) override {
		s = prev;
		s.attack = false;
		s.off = NONE;
		s.shots = { };
		if (!(f.flags & nsflog::ON))
			return Off(s, prev);
		s.on = true;
		// the tracker's noise notes count up as the period index counts down
		const int note = 15 - static_cast<int>(f.pitch & 0x0F);
		s.attack = Attack(f, last, prev) || note != prev.note;
		s.note = note;
		s.instrument = m_iInstrument;
		s.volume = f.volume & 0x0F;
		s.duty = f.timbre & 1;
	}

private:
	int m_iInstrument;
};

class DpcmConverter : public Converter {
public:
	explicit DpcmConverter(Builder &builder) : m_Builder(builder) {
		hasVolume = false;
		hasFine = false;
	}
	void Convert(const ChannelFrame &f, const ChannelFrame *last, const State &prev, State &s) override {
		s = prev;
		s.attack = false;
		s.off = NONE;
		s.shots = { };
		if (f.flags & nsflog::DELTA)
			s.AddShot(EF_DAC, f.aux8 & 0x7F);
		if (f.flags & nsflog::TRIGGER) {
			const auto key = m_Builder.DpcmKey(f.ref, f.pitch & 0x0F, (f.ref2 & 0x80) != 0);
			if (key.first >= 0) {
				s.on = true;
				s.attack = true;
				s.note = key.second;
				s.instrument = key.first;
				return;
			}
		}
		if (f.flags & nsflog::STOP) {
			// the tracker's release stops the sample, without its cut's write to $4011
			Off(s, prev, RELEASE);
			return;
		}
		// a sample that ends by itself needs nothing
		s.on = prev.on && (f.flags & nsflog::ON);
		if (!s.on)
			s.off = NONE;
	}

private:
	Builder &m_Builder;
};

class SawtoothConverter : public Converter {
public:
	SawtoothConverter(const std::array<int, NOTE_COUNT> &table, int instrument) : m_Table(table), m_iInstrument(instrument) {
		hasDuty = true;
	}
	void Convert(const ChannelFrame &f, const ChannelFrame *last, const State &prev, State &s) override {
		s = prev;
		s.attack = false;
		s.off = NONE;
		s.shots = { };
		if (!(f.flags & nsflog::ON))
			return Off(s, prev);
		s.on = true;
		s.attack = Attack(f, last, prev);
		const Pitch p = PeriodPitch(m_Table, static_cast<int>(f.pitch), s.attack ? -1 : prev.note);
		s.note = p.note;
		s.fine = p.fine;
		s.instrument = m_iInstrument;
		// The tracker's accumulator rate is the volume times two, plus 32 for V01
		// (CVRC6Sawtooth::CalculateVolume())
		const int rate = f.volume & 0x3F;
		s.volume = (rate & 0x1F) >> 1;
		s.duty = rate >> 5;
	}

private:
	const std::array<int, NOTE_COUNT> &m_Table;
	int m_iInstrument;
};

class Vrc7Converter : public Converter {
public:
	Vrc7Converter(const std::array<int, NOTE_RANGE> &table, Builder &builder) : m_Table(table), m_Builder(builder) { }
	void Convert(const ChannelFrame &f, const ChannelFrame *last, const State &prev, State &s) override {
		s = prev;
		s.attack = false;
		s.off = NONE;
		s.shots = { };
		if (!(f.flags & nsflog::ON)) {
			// a key off with the sustain bit releases slower: the tracker's ===
			return Off(s, prev, (f.flags & nsflog::SUSTAIN) ? RELEASE : HALT);
		}
		s.on = true;
		// only a key on restarts the note
		s.attack = !prev.on || (f.flags & nsflog::TRIGGER);
		const int block = (f.pitch >> 9) & 7;
		const Pitch p = Vrc7Pitch(m_Table, block, f.pitch & 0x1FF, s.attack ? -1 : prev.note);
		s.note = p.note;
		s.fine = p.fine;
		s.instrument = m_Builder.Vrc7(f.timbre & 0x0F, f.ref);
		s.volume = f.volume & 0x0F;
	}

private:
	const std::array<int, NOTE_RANGE> &m_Table;
	Builder &m_Builder;
};

class FdsConverter : public Converter {
public:
	FdsConverter(const std::array<int, NOTE_COUNT> &table, Builder &builder) : m_Table(table), m_Builder(builder) {
		fxEffect = { EF_FDS_MOD_DEPTH, EF_FDS_MOD_SPEED_HI, EF_FDS_MOD_SPEED_LO };
		fxDefault = { 0, 0, 0 };
		fxOnNote = true;
	}
	void Convert(const ChannelFrame &f, const ChannelFrame *last, const State &prev, State &s) override {
		s = prev;
		s.attack = false;
		s.off = NONE;
		s.shots = { };
		if (!(f.flags & nsflog::ON))
			return Off(s, prev);
		s.on = true;
		s.attack = Attack(f, last, prev);
		const Pitch p = FrequencyPitch(m_Table, static_cast<int>(f.pitch), s.attack ? -1 : prev.note);
		s.note = p.note;
		s.fine = p.fine;
		s.instrument = m_Builder.Fds(f.ref, f.ref2);
		// The tracker's FDS volume is (31 + 1) * (column + 1) / 16 - 1 = 2 * column + 1
		// (CChannelHandlerFDS::CalculateVolume())
		const int gain = std::min<int>(f.volume, 32);
		s.volume = std::clamp(gain / 2, 0, 15);
		// a halted modulator modulates nothing
		const bool halted = (f.aux16a & 0x8000) != 0;
		const int speed = f.aux16a & 0x0FFF;
		s.fx[0] = halted ? 0 : std::min<int>(f.aux16b, 0x3F);
		s.fx[1] = speed >> 8;
		s.fx[2] = speed & 0xFF;
	}

private:
	const std::array<int, NOTE_COUNT> &m_Table;
	Builder &m_Builder;
};

class N163Converter : public Converter {
public:
	N163Converter(const std::array<int, NOTE_COUNT> &table, Builder &builder) : m_Table(table), m_Builder(builder) {
		hasDuty = true;
		dutyOnInstrument = true;
	}
	void Convert(const ChannelFrame &f, const ChannelFrame *last, const State &prev, State &s) override {
		s = prev;
		s.attack = false;
		s.off = NONE;
		s.shots = { };
		if (!(f.flags & nsflog::ON))
			return Off(s, prev);
		s.on = true;
		s.attack = Attack(f, last, prev);
		const Pitch p = N163Pitch(m_Table, static_cast<int>(f.pitch), s.attack ? -1 : prev.note);
		s.note = p.note;
		s.fine = p.fine;
		const auto wave = m_Builder.N163(f.ref);
		if (wave.first >= 0) {
			s.instrument = wave.first;
			s.duty = wave.second;
		}
		s.volume = f.volume & 0x0F;
	}

private:
	const std::array<int, NOTE_COUNT> &m_Table;
	Builder &m_Builder;
};

class S5bConverter : public Converter {
public:
	// The first channel carries the noise period and the envelope's shape, the second its
	// period, which the chip's three channels share
	S5bConverter(const std::array<int, NOTE_COUNT> &table, int instrument, int index) :
		m_Table(table), m_iInstrument(instrument), m_iIndex(index) {
		hasDuty = true;
		dutyDefault = 1;	// S5B_MODE_SQUARE
		if (index == 0) {
			fxEffect = { EF_SUNSOFT_NOISE, EF_NONE, EF_NONE };
			fxDefault = { 0, 0, 0 };
		}
		else if (index == 1) {
			fxEffect = { EF_SUNSOFT_ENV_HI, EF_SUNSOFT_ENV_LO, EF_NONE };
			fxDefault = { 0, 0, 0 };
		}
	}
	void Convert(const ChannelFrame &f, const ChannelFrame *last, const State &prev, State &s) override {
		s = prev;
		s.attack = false;
		s.off = NONE;
		s.shots = { };
		// the shared registers are written whether this channel sounds or not
		if (m_iIndex == 0) {
			// the tracker writes the noise period inverted (CChannelHandlerS5B::UpdateRegs())
			s.fx[0] = ((f.aux16b >> 8) & 0x1F) ^ 0x1F;
			if (f.flags & nsflog::ENVELOPE)
				s.AddShot(EF_SUNSOFT_ENV_TYPE, f.aux16b & 0x0F);
		}
		else if (m_iIndex == 1) {
			s.fx[0] = f.aux16a >> 8;
			s.fx[1] = f.aux16a & 0xFF;
		}
		if (!(f.flags & nsflog::ON))
			return Off(s, prev);
		s.on = true;
		s.attack = Attack(f, last, prev);
		const Pitch p = PeriodPitch(m_Table, static_cast<int>(f.pitch), s.attack ? -1 : prev.note);
		s.note = p.note;
		s.fine = p.fine;
		s.instrument = m_iInstrument;
		s.volume = f.volume & 0x0F;
		// Vxx: 1 tone, 2 noise, 4 envelope, as the record has them
		s.duty = f.timbre & 7;
	}

private:
	const std::array<int, NOTE_COUNT> &m_Table;
	int m_iInstrument;
	int m_iIndex;
};

// ---- rows ---------------------------------------------------------------------------------

void SetNote(stChanNote &cell, int note) {
	cell.Note = static_cast<unsigned char>(note % NOTE_RANGE + NOTE_C);
	cell.Octave = static_cast<unsigned char>(note / NOTE_RANGE);
}

int EffectCount(const stChanNote &cell) {
	int n = 0;
	for (int i = 0; i < MAX_EFFECT_COLUMNS; ++i)
		if (cell.EffNumber[i] != EF_NONE)
			n = i + 1;
	return n;
}

// The row of a frame: what changed from the state before to the state after it
// `cut`: the channel may sound before the row though `p` does not (the row the song jumps
// back to), so a channel silent on it gets a note cut
stChanNote Row(const Converter &cv, const State &p, const State &s, bool cut = false) {
	stChanNote cell;
	int column = 0;
	auto add = [&](effect_t effect, int param) {
		if (column < MAX_EFFECT_COLUMNS) {
			cell.EffNumber[column] = effect;
			cell.EffParam[column] = static_cast<unsigned char>(param);
			++column;
		}
	};
	const unsigned char instrument = static_cast<unsigned char>(s.instrument >= 0 ? s.instrument : MAX_INSTRUMENTS);
	if (!s.on) {
		if (s.off != NONE)
			cell.Note = s.off;
		else if (cut && cv.hasVolume)
			cell.Note = HALT;
	}
	else {
		bool note = false;
		bool newInstrument = false;
		if (s.attack || !p.on || (s.note != p.note && s.instrument != p.instrument)) {
			SetNote(cell, s.note);
			cell.Instrument = instrument;
			note = true;
			newInstrument = s.instrument != p.instrument;
		}
		else if (s.note != p.note || (p.sweep && !s.sweep)) {
			// the note goes on at another pitch; a note also stops the tracker's sweep
			SetNote(cell, s.note);
			cell.Instrument = HOLD_INSTRUMENT;
		}
		else if (s.instrument != p.instrument) {
			cell.Instrument = instrument;
			newInstrument = true;
		}
		if (cv.hasVolume && s.volume != p.volume)
			cell.Vol = static_cast<unsigned char>(s.volume);
		if (cv.hasDuty && (s.duty != p.duty || (cv.dutyOnInstrument && newInstrument && s.duty != 0)))
			add(EF_DUTY_CYCLE, s.duty);
		if (cv.hasFine && s.fine != p.fine)
			add(EF_PITCH, s.fine);
		// Hxy sweeps up (the negate bit), Ixy down; either starts the sweep from the row's period
		if (s.sweep && (s.sweep != p.sweep || note))
			add((s.sweep & 0x08) ? EF_SWEEPUP : EF_SWEEPDOWN, s.sweep & 0x77);
		for (int i = 0; i < FX_SLOTS; ++i)
			if (cv.fxEffect[i] != EF_NONE && s.fx[i] >= 0 &&
				(s.fx[i] != p.fx[i] || (cv.fxOnNote && (note || newInstrument) && s.fx[i] != cv.fxDefault[i])))
				add(cv.fxEffect[i], s.fx[i]);
	}
	if (!s.on)
		// a silent channel still sets what it shares with the others
		for (int i = 0; i < FX_SLOTS; ++i)
			if (cv.fxEffect[i] != EF_NONE && s.fx[i] >= 0 && s.fx[i] != p.fx[i] && !cv.fxOnNote)
				add(cv.fxEffect[i], s.fx[i]);
	for (const Shot &shot : s.shots)
		if (shot.effect != EF_NONE)
			add(static_cast<effect_t>(shot.effect), shot.param);
	return cell;
}

// ---- loops --------------------------------------------------------------------------------------

// A song silent for this long until the frames played end has ended
const double SILENT_END_SECONDS = 3.;
// Periods of the writes looked at for where the states repeat
const int MAX_LOOP_CANDIDATES = 64;
// How long the frames have to go on repeating, at the least, to be a loop: a song repeats
// itself to the end of the frames played, while a note held where they end, the same
// writes frame after frame, does for that note alone
const double MIN_LOOP_SECONDS = 2.;
const double MIN_LOOP_SHARE = 0.25;		// of the frames played

struct Loop {
	int start = -1;		// the first frame of the part that repeats
	int length = 0;
};

// Where the frames start to repeat themselves for good: each start s and period p with
// frames[i] == frames[i + p] for every i >= s that the frames reach, seen at least twice
// over and for `minimum` frames (a few frames alike at the end are no loop), the shortest
// song (s + p) first. Z-function of the reversed frames: the suffix with period p is
// z[p] + p frames long.
std::vector<Loop> FindLoops(const std::vector<uint32_t> &frames, int minimum) {
	const int n = static_cast<int>(frames.size());
	std::vector<Loop> loops;
	if (n < 2)
		return loops;
	std::vector<uint32_t> r(frames.rbegin(), frames.rend());
	std::vector<int> z(n, 0);
	for (int i = 1, left = 0, right = 0; i < n; ++i) {
		if (i < right)
			z[i] = std::min(right - i, z[i - left]);
		while (i + z[i] < n && r[z[i]] == r[i + z[i]])
			++z[i];
		if (i + z[i] > right) {
			left = i;
			right = i + z[i];
		}
	}
	for (int p = 1; p <= n / 2; ++p)
		if (z[p] >= p && z[p] + p >= minimum)
			loops.push_back({ n - (z[p] + p), p });
	std::stable_sort(loops.begin(), loops.end(), [](const Loop &a, const Loop &b) {
		return a.start + a.length < b.start + b.length;
	});
	return loops;
}

// What to write on the row the song jumps back to: it is reached from the row before it
// and from the loop's last row. Where those leave the channel differently, the value is not
// known (UNKNOWN), and the row writes it.
const int UNKNOWN = INT_MIN;

State Either(const State &a, const State &b) {
	State m = a;
	m.on = a.on && b.on;
	auto merge = [](int x, int y) { return x == y ? x : UNKNOWN; };
	m.note = merge(a.note, b.note);
	m.fine = merge(a.fine, b.fine);
	m.instrument = merge(a.instrument, b.instrument);
	m.volume = merge(a.volume, b.volume);
	m.duty = merge(a.duty, b.duty);
	m.sweep = merge(a.sweep, b.sweep);
	for (int i = 0; i < FX_SLOTS; ++i)
		m.fx[i] = merge(a.fx[i], b.fx[i]);
	return m;
}

int ChannelId(const nsflog::ChannelHeader &c) {
	switch (c.chip) {
	case nsflog::APU: return CHANID_SQUARE1 + c.index;
	case nsflog::VRC6: return CHANID_VRC6_PULSE1 + c.index;
	case nsflog::VRC7: return CHANID_VRC7_CH1 + c.index;
	case nsflog::FDS: return CHANID_FDS;
	case nsflog::MMC5: return CHANID_MMC5_SQUARE1 + c.index;
	case nsflog::N163: return CHANID_N163_CH1 + c.index;
	case nsflog::S5B: return CHANID_S5B_CH1 + c.index;
	}
	return -1;
}

std::string ChipNames(int chips) {
	static const char *const NAMES[] = { "VRC6", "VRC7", "FDS", "MMC5", "N163", "5B" };
	std::string text = "2A03";
	for (int i = 0; i < 6; ++i)
		if (chips & (1 << i))
			text += std::string(" + ") + NAMES[i];
	return text;
}

std::string Time(int frames, double rate) {
	const int seconds = static_cast<int>(std::lround(frames / rate));
	char buffer[16];
	std::snprintf(buffer, sizeof(buffer), "%d:%02d", seconds / 60, seconds % 60);
	return buffer;
}

} // namespace

// ---- the import ------------------------------------------------------------------------------------

NsfImportResult ImportNsf(CFamiTrackerDoc &doc, const uint8_t *data, size_t size, const NsfImportOptions &options) {
	nsflog::Log log;
	if (!nsflog::Read(data, size, log))
		throw std::runtime_error("the NSF analysis is not readable");
	const int frameCount = static_cast<int>(log.FrameCount());
	if (frameCount == 0)
		throw std::runtime_error("the NSF played no frames");

	NsfImportResult result;
	const int track = 0;

	// ---- the module ----
	const int chips = log.chips & (SNDCHIP_VRC6 | SNDCHIP_VRC7 | SNDCHIP_FDS | SNDCHIP_MMC5 | SNDCHIP_N163 | SNDCHIP_S5B);
	const int namcoChannels = (chips & SNDCHIP_N163) ? std::clamp<int>(log.n163Channels, 1, 8) : 0;
	doc.SetNamcoChannels(namcoChannels, false);
	doc.SelectExpansionChip(static_cast<unsigned char>(chips), false);
	// Dendy plays at an NTSC CPU's pitch, 50 frames a second
	const bool pal = log.region == 1;
	doc.SetMachine(pal ? PAL : NTSC, false);
	const double rate = log.period > 0 ? 1e6 / log.period : (pal ? 50. : 60.);
	const double machineRate = pal ? 50. : 60.;
	const bool customRate = std::abs(rate - machineRate) >= 1.;
	doc.SetEngineSpeed(customRate ? std::clamp<int>(static_cast<int>(std::lround(rate)), 16, 400) : 0);
	// A row each frame: speed 1 at the tempo that makes the engine read a row every tick, or
	// none (the speed alone) when the rate is not the machine's
	doc.SetSongSpeed(track, 1);
	doc.SetSongTempo(track, customRate ? 0 : (pal ? 125 : 150));
	doc.SetSongName(text::FromUtf8(log.title, 31).c_str());
	doc.SetSongArtist(text::FromUtf8(log.artist, 31).c_str());
	doc.SetSongCopyright(text::FromUtf8(log.copyright, 31).c_str());
	const std::string title = !log.trackTitle.empty() ? log.trackTitle :
		log.songs > 1 ? "Song " + std::to_string(log.song + 1) : log.title;
	doc.SetTrackTitle(track, CString(text::FromUtf8(title, 255).c_str()));
	// the new module's instrument
	while (doc.GetInstrumentCount() > 0)
		for (unsigned i = 0; i < MAX_INSTRUMENTS; ++i)
			if (doc.IsInstrumentUsed(i))
				doc.RemoveInstrument(i);

	// ---- the channels ----
	const NoteTables tables(std::max(namcoChannels, 1));
	Builder builder(doc, log, result.warnings);
	struct Channel {
		int log;			// the record's index in a frame
		int column;			// the module's channel
		std::unique_ptr<Converter> converter;
	};
	std::vector<Channel> channels;
	for (size_t i = 0; i < log.channels.size(); ++i) {
		const nsflog::ChannelHeader &h = log.channels[i];
		if (h.chip == nsflog::N163 && h.index >= namcoChannels)
			continue;
		const int column = doc.GetChannelIndex(ChannelId(h));
		if (column < 0)
			continue;
		std::unique_ptr<Converter> cv;
		const auto &periods = pal ? tables.pal : tables.ntsc;
		switch (h.chip) {
		case nsflog::APU:
			switch (h.index) {
			case 0: case 1: cv.reset(new PulseConverter(periods, builder.Shared(SNDCHIP_NONE), PulseConverter::APU_PULSE)); break;
			case 2: cv.reset(new TriangleConverter(periods, builder.Shared(SNDCHIP_NONE))); break;
			case 3: cv.reset(new NoiseConverter(builder.Shared(SNDCHIP_NONE))); break;
			case 4: cv.reset(new DpcmConverter(builder)); break;
			}
			break;
		case nsflog::VRC6:
			if (h.index < 2)
				cv.reset(new PulseConverter(tables.ntsc, builder.Shared(SNDCHIP_VRC6), PulseConverter::VRC6_PULSE));
			else
				cv.reset(new SawtoothConverter(tables.saw, builder.Shared(SNDCHIP_VRC6)));
			break;
		case nsflog::VRC7: cv.reset(new Vrc7Converter(tables.vrc7, builder)); break;
		case nsflog::FDS: cv.reset(new FdsConverter(tables.fds, builder)); break;
		case nsflog::MMC5: cv.reset(new PulseConverter(tables.ntsc, builder.Shared(SNDCHIP_NONE), PulseConverter::MMC5_PULSE)); break;
		case nsflog::N163: cv.reset(new N163Converter(tables.n163, builder)); break;
		case nsflog::S5B: cv.reset(new S5bConverter(tables.s5b, builder.Shared(SNDCHIP_S5B), h.index)); break;
		}
		if (!cv)
			continue;
		// A driver that writes what restarts a note on every frame it sounds (the triangle's
		// $400B, as the tracker's own driver does) restarts nothing
		if (h.chip != nsflog::VRC7 && !(h.chip == nsflog::APU && h.index == 4)) {
			int on = 0, triggered = 0;
			for (int f = 0; f < frameCount; ++f) {
				const ChannelFrame &r = log.At(f, i);
				if (r.flags & nsflog::ON) {
					++on;
					if (r.flags & nsflog::TRIGGER)
						++triggered;
				}
			}
			cv->reliableTriggers = triggered * 2 <= on;
		}
		channels.push_back({ static_cast<int>(i), column, std::move(cv) });
	}
	if (channels.empty())
		throw std::runtime_error("the NSF has no channels the tracker knows");

	// ---- the states, frame by frame ----
	const size_t count = channels.size();
	std::vector<State> states(static_cast<size_t>(frameCount) * count);
	for (size_t c = 0; c < count; ++c) {
		Channel &ch = channels[c];
		State prev = ch.converter->Start();
		for (int f = 0; f < frameCount; ++f) {
			State &s = states[f * count + c];
			ch.converter->Convert(log.At(f, ch.log), f ? &log.At(f - 1, ch.log) : nullptr, prev, s);
			prev = s;
		}
	}
	auto stateAt = [&](int f, size_t c) -> const State & { return states[f * count + c]; };

	// ---- what to keep ----
	// Heard: sounding at some volume. Drivers leave channels enabled at volume 0 (the
	// tracker's own between notes and before the first), which sound like nothing.
	auto heard = [&](int f) {
		for (size_t c = 0; c < count; ++c) {
			const State &s = stateAt(f, c);
			if (s.on && (!channels[c].converter->hasVolume || s.volume > 0))
				return true;
		}
		return false;
	};
	int first = 0;
	if (options.trimSilence && !options.sourceRows)
		while (first < frameCount && !heard(first))
			++first;
	int last = frameCount - 1;
	while (last >= first && !heard(last))
		--last;
	if (last < first)
		throw std::runtime_error("the NSF made no sound");
	result.trimmed = first;

	int rows = frameCount - first;		// frames the song plays
	int loopRow = -1;
	if (options.sourceRows) {
		if (options.sourceRows < 1 || options.sourceRows > frameCount ||
			options.sourceLoopRow < -1 || options.sourceLoopRow >= options.sourceRows)
			throw std::runtime_error("invalid decoded NSF song boundaries");
		rows = options.sourceRows;
		loopRow = options.sourceLoopRow;
		result.stops = loopRow < 0;
	}
	else if (frameCount - 1 - last >= static_cast<int>(SILENT_END_SECONDS * rate)) {
		// It falls silent for good: it stops a frame after its last sound, which writes
		// what silences the channels
		rows = last + 2 - first;
		result.stops = true;
	}
	else if (options.loop) {
		// The driver writes the same again where the song repeats itself. Its states may
		// not quite: the frame counter that clocks the envelopes and the length counters
		// does not keep time with the play routine. A loop of the writes counts when the
		// channels sound mostly the same through it the second time.
		auto same = [&](const State &a, const State &b, size_t c) {
			const bool heardA = a.on && (!channels[c].converter->hasVolume || a.volume > 0);
			const bool heardB = b.on && (!channels[c].converter->hasVolume || b.volume > 0);
			// an envelope read at another point of the frame counter's steps is a step or two off
			return heardA == heardB && (!heardA || (a.note == b.note && std::abs(a.volume - b.volume) <= 2 && a.duty == b.duty));
		};
		// The channels' states repeat from where the writes do or later: a frame's state
		// depends on the writes before it, and in the first round those came from the part
		// before the loop. For a period of the writes, the start within a period from which
		// the states repeat best (a period at least half seen, a tenth of its frames at most
		// different), or -1.
		std::vector<int> differs;
		auto place = [&](const Loop &loop) {
			const int p = loop.length;
			const int limit = rows - p;		// frames with a frame a period after them
			if (loop.start >= limit)
				return -1;
			// a start is looked for within a period, a period from it at most
			const int stop = std::min(limit, loop.start + 2 * p);
			differs.assign(stop - loop.start + 1, 0);
			for (int f = loop.start; f < stop; ++f) {
				bool d = false;
				for (size_t c = 0; c < count && !d; ++c)
					d = !same(stateAt(first + f, c), stateAt(first + f + p, c), c);
				differs[f - loop.start + 1] = differs[f - loop.start] + (d ? 1 : 0);
			}
			// the start with the fewest frames different, the earliest of those
			int best = -1;
			double fewest = 0.1;
			for (int at = loop.start; at <= std::min(loop.start + p, limit - 1); ++at) {
				const int end = std::min(at + p, stop);
				const int seen = end - at;
				if (seen * 2 < p)
					break;
				const double share = static_cast<double>(differs[end - loop.start] - differs[at - loop.start]) / seen;
				if (share < fewest || (best < 0 && share <= fewest)) {
					best = at;
					fewest = share;
					if (share == 0)
						break;
				}
			}
			return best;
		};
		const std::vector<uint32_t> writes(log.writes.begin() + first, log.writes.begin() + frameCount);
		Loop found;
		int tried = 0;
		const int minimum = std::max(static_cast<int>(MIN_LOOP_SECONDS * rate), static_cast<int>(MIN_LOOP_SHARE * rows));
		for (const Loop &loop : FindLoops(writes, minimum)) {
			// the candidates come shortest first, and their starts can only move later
			if (found.start >= 0 && loop.start + loop.length >= found.start + found.length)
				break;
			if (++tried > MAX_LOOP_CANDIDATES)
				break;
			const int at = place(loop);
			if (at >= 0 && (found.start < 0 || at + loop.length < found.start + found.length))
				found = { at, loop.length };
		}
		if (found.start >= 0) {
			bool sound = false;
			for (int f = found.start; f < found.start + found.length && !sound; ++f)
				sound = heard(first + f);
			if (!sound) {
				// what repeats is silence: the song stops where it begins
				rows = found.start + 1;
				result.stops = true;
			}
			else {
				// The loop begins a frame into the part that repeats, where the state
				// before it is the same, or nearly, whether the song comes from the frame
				// before or jumps back from the end
				loopRow = found.start + 1;
				rows = loopRow + found.length;
			}
		}
		else {
			result.stops = true;
			result.warnings.push_back("noRepeat");
		}
	}
	else
		result.stops = true;

	// ---- rows ----
	std::vector<std::vector<stChanNote>> cells(count, std::vector<stChanNote>(rows));
	for (size_t c = 0; c < count; ++c) {
		const Converter &cv = *channels[c].converter;
		// What the loop's first row leaves unknown, while the channel stays silent after it
		// and nothing writes it
		State unknown;
		bool doubt = false;
		for (int r = 0; r < rows; ++r) {
			const int f = first + r;
			// the song starts from the tracker's own state; the row it jumps back to is also
			// reached from the loop's last row
			if (r == 0)
				cells[c][r] = Row(cv, cv.Start(), stateAt(f, c));
			else if (r == loopRow) {
				unknown = Either(stateAt(f - 1, c), stateAt(first + rows - 1, c));
				cells[c][r] = Row(cv, unknown, stateAt(f, c), stateAt(f - 1, c).on != stateAt(first + rows - 1, c).on);
				doubt = !stateAt(f, c).on;
				// what a silent channel shares with the others it has written on this row
				if (!cv.fxOnNote)
					unknown.fx = { 0, 0, 0 };
			}
			else if (doubt) {
				State before = stateAt(f - 1, c);
				auto keep = [](int known, int &value) { if (known == UNKNOWN) value = UNKNOWN; };
				keep(unknown.note, before.note);
				keep(unknown.fine, before.fine);
				keep(unknown.instrument, before.instrument);
				keep(unknown.volume, before.volume);
				keep(unknown.duty, before.duty);
				keep(unknown.sweep, before.sweep);
				for (int i = 0; i < FX_SLOTS; ++i)
					keep(unknown.fx[i], before.fx[i]);
				cells[c][r] = Row(cv, before, stateAt(f, c));
				doubt = !stateAt(f, c).on;
			}
			else
				cells[c][r] = Row(cv, stateAt(f - 1, c), stateAt(f, c));
		}
	}
	// The DPCM's delta counter left by frames left out
	for (size_t c = 0; c < count && first > 0; ++c)
		if (dynamic_cast<const DpcmConverter *>(channels[c].converter.get())) {
			for (int f = first - 1; f >= 0; --f) {
				const ChannelFrame &r = log.At(f, channels[c].log);
				if (r.flags & nsflog::DELTA) {
					stChanNote &cell = cells[c][0];
					const int column = EffectCount(cell);
					if (column < MAX_EFFECT_COLUMNS && std::none_of(cell.EffNumber, cell.EffNumber + MAX_EFFECT_COLUMNS, [](effect_t e) { return e == EF_DAC; })) {
						cell.EffNumber[column] = EF_DAC;
						cell.EffParam[column] = r.aux8 & 0x7F;
					}
					break;
				}
			}
		}

	// ---- frames ----
	const int introRows = loopRow >= 0 ? loopRow : rows;
	const int loopRows = loopRow >= 0 ? rows - loopRow : 0;
	auto framesFor = [&](int length) {
		auto sections = [length](int n) { return (n + length - 1) / length; };
		return sections(introRows) + sections(loopRows);
	};
	int length = std::clamp(options.patternLength, 1, MAX_PATTERN_LENGTH);
	while (framesFor(length) > MAX_FRAMES && length < MAX_PATTERN_LENGTH)
		length = std::min(length * 2, MAX_PATTERN_LENGTH);
	if (framesFor(length) > MAX_FRAMES) {
		// longer than the module holds: the song stops where it must
		result.warnings.push_back("tooLong");
		rows = std::min(rows, MAX_FRAMES * length);
		loopRow = -1;
		result.stops = true;
	}
	const int intro = loopRow >= 0 ? loopRow : rows;
	const int introFrames = (intro + length - 1) / length;
	const int loopFrames = loopRow >= 0 ? (rows - loopRow + length - 1) / length : 0;
	const int frames = std::max(1, introFrames + loopFrames);
	// the song row of each frame's first row and how many rows the frame has
	auto frameStart = [&](int frame) { return frame < introFrames ? frame * length : loopRow + (frame - introFrames) * length; };
	auto frameRows = [&](int frame) {
		const int end = frame < introFrames ? intro : rows;
		return std::min(length, end - frameStart(frame));
	};

	// The jumps: D00 where the part before the loop ends short of a frame, Bxx back to the
	// loop's first frame, C00 where the song stops. In the first channel with a column to
	// spare, else in the first channel's last.
	auto addGlobal = [&](int row, effect_t effect, int param) {
		for (size_t c = 0; c < count; ++c) {
			stChanNote &cell = cells[c][row];
			const int column = EffectCount(cell);
			if (column < MAX_EFFECT_COLUMNS) {
				cell.EffNumber[column] = effect;
				cell.EffParam[column] = static_cast<unsigned char>(param);
				return;
			}
		}
		cells[0][row].EffNumber[MAX_EFFECT_COLUMNS - 1] = effect;
		cells[0][row].EffParam[MAX_EFFECT_COLUMNS - 1] = static_cast<unsigned char>(param);
	};
	if (loopRow >= 0) {
		if (introFrames > 0 && intro % length)
			addGlobal(intro - 1, EF_SKIP, 0);
		addGlobal(rows - 1, EF_JUMP, introFrames);
	}
	else if (result.stops)
		addGlobal(rows - 1, EF_HALT, 0);

	doc.SetPatternLength(track, length);
	doc.SetFrameCount(track, frames);
	for (size_t c = 0; c < count; ++c) {
		const int column = channels[c].column;
		int effects = 1;
		for (const stChanNote &cell : cells[c])
			effects = std::max(effects, EffectCount(cell));
		doc.SetEffColumns(track, column, effects - 1);
		// the same rows share a pattern
		std::map<std::string, int> patterns;
		for (int frame = 0; frame < frames; ++frame) {
			const int start = frameStart(frame);
			const int n = std::max(0, frameRows(frame));
			std::string key;
			key.reserve(n * (4 + 2 * MAX_EFFECT_COLUMNS));
			for (int r = 0; r < n; ++r) {
				const stChanNote &cell = cells[c][start + r];
				key += static_cast<char>(cell.Note);
				key += static_cast<char>(cell.Octave);
				key += static_cast<char>(cell.Vol);
				key += static_cast<char>(cell.Instrument);
				for (int i = 0; i < MAX_EFFECT_COLUMNS; ++i) {
					key += static_cast<char>(cell.EffNumber[i]);
					key += static_cast<char>(cell.EffParam[i]);
				}
			}
			auto it = patterns.find(key);
			if (it == patterns.end()) {
				const int pattern = static_cast<int>(patterns.size());
				it = patterns.emplace(std::move(key), pattern).first;
				for (int r = 0; r < n; ++r)
					if (!(cells[c][start + r] == stChanNote()))
						doc.SetDataAtPattern(track, pattern, column, r, &cells[c][start + r]);
			}
			doc.SetPatternAtFrame(track, frame, column, it->second);
		}
	}

	result.rows = rows;
	result.loopRow = loopRow;
	result.rate = rate;

	// What the module came from
	std::string comment = "Imported from an NSF: " + log.title;
	if (!log.artist.empty())
		comment += " by " + log.artist;
	comment += "\r\nSong " + std::to_string(log.song + 1) + " of " + std::to_string(log.songs);
	if (!log.trackTitle.empty())
		comment += " (" + log.trackTitle + ")";
	comment += ", " + ChipNames(chips) + ", " + (log.region == 1 ? "PAL" : log.region == 2 ? "Dendy" : "NTSC");
	char hz[32];
	std::snprintf(hz, sizeof(hz), ", %.2f Hz", rate);
	comment += hz;
	comment += "\r\nA row is a frame. ";
	if (loopRow >= 0)
		comment += "It plays " + Time(intro, rate) + ", then " + Time(rows - loopRow, rate) + " over and over.";
	else
		comment += "It plays " + Time(rows, rate) + (result.stops ? " and stops." : ".");
	if (first > 0)
		comment += " The " + Time(first, rate) + " of silence before it are left out.";
	CString text(dnft::text::FromUtf8(comment, 65535).c_str());
	doc.SetComment(text, false);
	doc.SetModifiedFlag(TRUE);
	doc.SetExceededFlag(false);
	return result;
}

} // namespace dnft

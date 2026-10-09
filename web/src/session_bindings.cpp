/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// Javascript bindings of editing sessions (session.h): the module's document, read and
// changed through the tracker's own functions, and the audio of a session.
//
//   const session = dnft.createSession(48000);         // or openSession(at, size, 48000)
//   session.setCells(0, 0, 0, 0, cells);               // track, channel, pattern, row
//   session.play(0, dnft.PLAY_CURSOR, 0, 0);
//   session.render(buffer, 1024);
//   const bytes = session.save();                      // a .dnm file
//
// A pattern cell is 12 bytes, the fields of the tracker's stChanNote: note, octave,
// volume, instrument, the four effect numbers and the four effect parameters. Indices
// are checked; what is out of range throws.

#include "stdafx.h"
#include "FamiTracker.h"
#include "FamiTrackerDoc.h"
#include "SoundGen.h"
#include "TrackerChannel.h"
#include "Instrument.h"
#include "SeqInstrument.h"
#include "Instrument2A03.h"
#include "InstrumentFDS.h"
#include "InstrumentN163.h"
#include "InstrumentVRC7.h"
#include "DSample.h"
#include "Sequence.h"
#include "InstrumentManager.h"
#include "Bookmark.h"
#include "BookmarkCollection.h"
#include "BookmarkManager.h"
#include "APU/APU.h"
#include "RegisterState.h"
#include "InstrumentRecorder.h"
#include "Settings.h"
#include "engine_internal.h"
#include "session.h"
#include "export.h"
#include "text_encoding.h"

#include <emscripten/bind.h>

#include <algorithm>
#include <stdexcept>
#include <string>

using emscripten::val;

namespace {

const int CELL_SIZE = 12;

// The detune tables: NTSC and PAL 2A03, VRC6 sawtooth, VRC7, FDS, N163 (CDetuneDlg)
const int DETUNE_CHIPS = 6;
// The devices of the mix offsets, and how far they go: 12 dB in tenths
// (CModulePropertiesDlg)
const int MIX_DEVICES = 8;
const int MAX_LEVEL_OFFSET = 120;
// The VRC7's patches: 0 the instrument's own, 1-15 the built-in ones, 16-18 the drums'
const int OPLL_PATCHES = 19;
const size_t MAX_PATCH_NAME = 255;

const void *HeapPointer(uint32_t offset) {
	return reinterpret_cast<const void *>(static_cast<uintptr_t>(offset));
}

val CopyToJs(const uint8_t *data, size_t size) {
	val array = val::global("Uint8Array").new_(size);
	array.call<void>("set", val(emscripten::typed_memory_view(size, data)));
	return array;
}

val CopyToJs(const std::vector<uint8_t> &bytes) {
	return CopyToJs(bytes.data(), bytes.size());
}

std::vector<uint8_t> FromJs(const val &array) {
	return emscripten::convertJSArrayToNumberVector<uint8_t>(array);
}

// Text for the document, in at most maxBytes (some texts live in fixed buffers): in the
// code page the desktop tracker reads it in, or UTF-8 (text_encoding.h)
std::string ToDocument(const std::string &text, size_t maxBytes) {
	return dnft::text::FromUtf8(text, maxBytes);
}

// The longest string CDocumentFile::ReadString() reads back whole
const size_t MAX_FILE_STRING = 65535;

// Line breaks as `lineBreak`, whichever of CR LF, CR and LF the text has
std::string WithLineBreaks(const std::string &text, const char *lineBreak) {
	std::string out;
	out.reserve(text.size());
	for (size_t i = 0; i < text.size(); ++i) {
		if (text[i] == '\r' || text[i] == '\n') {
			out += lineBreak;
			if (text[i] == '\r' && i + 1 < text.size() && text[i + 1] == '\n')
				++i;
		}
		else
			out += text[i];
	}
	return out;
}

// {items: Int8Array, loop, release, setting}; loop and release are -1 when unset
val SequenceToJs(const CSequence *pSeq) {
	val result = val::object();
	const unsigned count = pSeq->GetItemCount();
	val items = val::global("Int8Array").new_(count);
	for (unsigned i = 0; i < count; ++i)
		items.set(i, static_cast<int>(pSeq->GetItem(i)));
	result.set("items", items);
	result.set("loop", static_cast<int>(pSeq->GetLoopPoint()));
	result.set("release", static_cast<int>(pSeq->GetReleasePoint()));
	result.set("setting", static_cast<int>(pSeq->GetSetting()));
	return result;
}

// The other way: the items are at most MAX_SEQUENCE_ITEMS, the setting one the kind of sequence has
void WriteSequence(CSequence *pSeq, int seqType, const val &items, int loop, int release, int setting) {
	const std::vector<int8_t> values = emscripten::convertJSArrayToNumberVector<int8_t>(items);
	const int count = std::min<int>(static_cast<int>(values.size()), MAX_SEQUENCE_ITEMS);
	pSeq->SetItemCount(count);
	for (int i = 0; i < count; ++i)
		pSeq->SetItem(i, values[i]);
	pSeq->SetLoopPoint(loop >= 0 && loop < count ? loop : -1);
	pSeq->SetReleasePoint(release >= 0 && release < count ? release : -1);
	pSeq->SetSetting(static_cast<seq_setting_t>(std::clamp(setting, 0, static_cast<int>(SEQ_SETTING_COUNT[seqType]) - 1)));
}

// Values of an array from the page, at most `count` of them, each within [min, max]; the
// rest of the count is `fill`
std::vector<int> BoundedValues(const val &array, size_t count, int min, int max, int fill = 0) {
	std::vector<int> values = emscripten::convertJSArrayToNumberVector<int>(array);
	values.resize(count, fill);
	for (int &value : values)
		value = std::clamp(value, min, max);
	return values;
}

void PackCell(const stChanNote &note, uint8_t *out) {
	out[0] = note.Note;
	out[1] = note.Octave;
	out[2] = note.Vol;
	out[3] = note.Instrument;
	for (int i = 0; i < MAX_EFFECT_COLUMNS; ++i) {
		out[4 + i] = note.EffNumber[i];
		out[8 + i] = note.EffParam[i];
	}
}

// What the tracker could not have written is made empty rather than trusted.
stChanNote UnpackCell(const uint8_t *in) {
	stChanNote note {};
	note.Note = in[0] <= ECHO ? in[0] : NONE;
	note.Octave = in[1] < OCTAVE_RANGE ? in[1] : 0;
	note.Vol = in[2] <= MAX_VOLUME ? in[2] : MAX_VOLUME;
	note.Instrument = in[3] <= MAX_INSTRUMENTS || in[3] == HOLD_INSTRUMENT ? in[3] : MAX_INSTRUMENTS;
	for (int i = 0; i < MAX_EFFECT_COLUMNS; ++i) {
		note.EffNumber[i] = in[4 + i] < EF_COUNT ? static_cast<effect_t>(in[4 + i]) : EF_NONE;
		note.EffParam[i] = note.EffNumber[i] == EF_NONE ? 0 : in[8 + i];
	}
	if (note.Note == NONE || note.Note == RELEASE || note.Note == HALT)
		note.Octave = 0;
	return note;
}

class EditSession {
public:
	explicit EditSession(std::shared_ptr<dnft::Session> session) : m_pSession(std::move(session)) {}

	// ---- audio -------------------------------------------------------------------------

	//! Fills frames * 2 int16 values (interleaved stereo) at the heap offset.
	void render(uint32_t target, uint32_t frames) {
		m_pSession->Render(reinterpret_cast<int16_t *>(static_cast<uintptr_t>(target)), frames);
	}

	//! Output frames rendered so far
	double position() const {
		return static_cast<double>(m_pSession->GetPosition());
	}

	//! [{at, frame, row}] for the rows the player read since the last call; frame -1
	//! where playback stopped
	val takeRowEvents() {
		val list = val::array();
		for (const auto &e : m_pSession->TakeRowEvents()) {
			val entry = val::object();
			entry.set("at", static_cast<double>(e.at));
			entry.set("frame", e.frame);
			entry.set("row", e.row);
			list.call<void>("push", entry);
		}
		return list;
	}

	void play(int track, int mode, int frame, int row) {
		m_pSession->Play(track, static_cast<dnft::Session::PlayMode>(std::clamp(mode, 0, 3)), frame, row);
	}

	void stop() {
		m_pSession->Stop();
	}

	val state() const {
		const dnft::PlayerState s = m_pSession->GetState();
		val result = val::object();
		result.set("playing", m_pSession->IsPlaying());
		result.set("track", s.track);
		result.set("frame", s.frame);
		result.set("row", s.row);
		result.set("speed", s.speed);
		result.set("tempo", s.tempo);
		result.set("timeMs", s.timeMs);
		result.set("bpm", s.bpm);
		return result;
	}

	void noteOn(int channel, int note, int octave, int instrument, int volume) {
		m_pSession->NoteOn(channel, note, octave, instrument, volume);
	}

	void noteOff(int channel, bool release) {
		m_pSession->NoteOff(channel, release);
	}

	//! Bit n mutes channel n
	void setMutedChannels(double mask) {
		m_pSession->SetMutedChannels(static_cast<uint64_t>(mask));
	}

	// ---- Tracker menu, View menu ---------------------------------------------------------

	//! Tracker > Play Row: the row's notes, with their effects, on the channels not muted
	void playRow(int track, int frame, int row) {
		m_pSession->PlayRow(track, frame, row);
	}

	//! Ctrl+click on a frame of the frame list while playing: the frame to go to next, or -1
	void setQueueFrame(int frame) {
		m_pSession->SetQueueFrame(frame);
	}

	int queueFrame() const {
		return m_pSession->GetQueueFrame();
	}

	//! Recall channel state (the state of the channel at the row, for the status line)
	std::string recallChannelState(int track, int channel, int frame, int row) {
		const std::string state = m_pSession->RecallChannelState(track, channel, frame, row);
		return dnft::detail::ToUtf8(state.c_str(), state.size());
	}

	//! Configuration > MIDI > Auto arpeggiate chords: the engine's setting (CSettings
	//! Midi.bMidiArpeggio); with it on, the notes held by hand take turns, a tick each
	void setAutoArpeggio(bool on) {
		theApp.GetSettings()->Midi.bMidiArpeggio = on;
	}

	bool autoArpeggio() const {
		return theApp.GetSettings()->Midi.bMidiArpeggio;
	}

	//! A note played by hand begins or ends (the notes the auto arpeggio goes through)
	void arpNote(int note, bool held, int channel) {
		m_pSession->ArpNote(note, held, channel);
	}

	//! Tracker > Kill Sound
	void killSound() {
		m_pSession->KillSound();
	}

	//! View > Meter Decay Rate: 0 slow, 1 fast
	void setMeterDecayRate(int rate) {
		m_pSession->SetMeterDecayRate(rate);
	}

	int meterDecayRate() const {
		return m_pSession->GetMeterDecayRate();
	}

	//! View > Average BPM: whether state().bpm is the average of the song played so far
	void setAverageBpm(bool average) {
		theApp.GetSettings()->Display.bAverageBPM = average;
	}

	//! [{at, levels}]: the volume meters (Uint8Array, 0-15 for each channel) after each tick
	//! that changed one, `at` the output frame the tick's audio begins at
	val takeLevelEvents() {
		val list = val::array();
		for (const auto &e : m_pSession->TakeLevelEvents()) {
			val entry = val::object();
			entry.set("at", static_cast<double>(e.at));
			entry.set("levels", CopyToJs(e.levels.data(), e.levels.size()));
			list.call<void>("push", entry);
		}
		return list;
	}

	//! View > Register State: for each address of the chip (SNDCHIP_*: 0 the 2A03, 1 VRC6, 2
	//! VRC7, 4 FDS, 8 MMC5, 16 N163, 32 5B) two bytes, the register's value and its age (the
	//! ticks since a write in the low four bits, since a new value in the high four; 15 is
	//! long ago). The module's chips only; zeros for an address the chip has no register at.
	val registers(int chip, const val &addresses) const {
		const std::vector<int> list = emscripten::vecFromJSArray<int>(addresses);
		std::vector<uint8_t> out(list.size() * 2);
		if (chip == 0 || Doc().ExpansionEnabled(static_cast<unsigned>(chip))) {
			const CSoundGen &generator = *theApp.GetSoundGenerator();
			for (size_t i = 0; i < list.size(); ++i)
				if (list[i] >= 0)
					if (const CRegisterState *state = generator.GetRegState(chip, list[i])) {
						out[2 * i] = state->GetValue();
						out[2 * i + 1] = static_cast<uint8_t>((state->GetNewValueTime() << 4) | state->GetLastUpdatedTime());
					}
		}
		return CopyToJs(out.data(), out.size());
	}

	//! The pitches the chip's channels sound at, in Hz (what the register view shows beside
	//! the registers): the first `count` of them; the FDS has its carrier then the modulated
	//! pitch, the 5B its three tones then the envelope
	val channelFrequencies(int chip, int count) const {
		val list = val::array();
		if (chip == 0 || Doc().ExpansionEnabled(static_cast<unsigned>(chip))) {
			const CSoundGen &generator = *theApp.GetSoundGenerator();
			for (int i = 0; i < count; ++i)
				list.call<void>("push", generator.GetChannelFrequency(chip, i));
		}
		return list;
	}

	//! The FDS modulator's counter, as the register view shows it
	int fdsModCounter() const {
		return theApp.GetSoundGenerator()->GetFDSModCounter();
	}

	// ---- Tracker > Record To Instrument ----------------------------------------------------

	//! The channel being recorded (an index of the module's channels, -1 for none) and the
	//! recorder's settings (Tracker > Recorder Settings)
	val recorder() const {
		const CSoundGen &generator = *theApp.GetSoundGenerator();
		val result = val::object();
		int channel = -1;
		const int type = generator.GetRecordChannel();
		for (int i = 0; type != -1 && i < Doc().GetChannelCount(); ++i)
			if (Doc().GetChannelType(i) == type)
				channel = i;
		result.set("channel", channel);
		std::unique_ptr<stRecordSetting> setting(generator.GetRecordSetting());
		result.set("interval", setting->Interval);
		result.set("count", setting->InstCount);
		result.set("reset", setting->Reset);
		return result;
	}

	//! Record To Instrument on a channel (or off with -1, or on the one it is on): the next
	//! playback records its registers into new instruments. Returns what stops it:
	//! "unsupported" (the DPCM and the VRC7 cannot be recorded), "instruments" (no free
	//! instrument slot), "sequences" (no free sequence), or "" for none.
	std::string setRecordChannel(int channel) {
		CSoundGen &generator = *theApp.GetSoundGenerator();
		if (channel < 0) {
			generator.SetRecordChannel(-1);
			return "";
		}
		CheckChannel(channel);
		const CFamiTrackerDoc &doc = Doc();
		const int type = doc.GetChannelType(channel);
		const int chip = doc.GetChipType(channel);
		if (type == CHANID_DPCM || chip == SNDCHIP_VRC7)
			return "unsupported";
		if (doc.GetInstrumentCount() >= MAX_INSTRUMENTS)
			return "instruments";
		if (chip != SNDCHIP_FDS) {
			inst_type_t instrument = INST_NONE;
			switch (chip) {
			case SNDCHIP_NONE: case SNDCHIP_MMC5: instrument = INST_2A03; break;
			case SNDCHIP_VRC6: instrument = INST_VRC6; break;
			case SNDCHIP_N163: instrument = INST_N163; break;
			case SNDCHIP_S5B: instrument = INST_S5B; break;
			}
			if (instrument != INST_NONE)
				for (int i = 0; i < SEQ_COUNT; ++i)
					if (doc.GetFreeSequence(instrument, i) == -1)
						return "sequences";
		}
		generator.SetRecordChannel(type == generator.GetRecordChannel() ? -1 : type);
		return "";
	}

	//! `interval` ticks (1-MAX_SEQUENCE_ITEMS) of each instrument, `count` (1-MAX_INSTRUMENTS)
	//! instruments; with `reset` the settings go back to the longest interval and 1
	//! instrument after a recording
	void setRecorderSettings(int interval, int count, bool reset) {
		theApp.GetSoundGenerator()->SetRecordSetting(new stRecordSetting {
			std::clamp(interval, 1, static_cast<int>(MAX_SEQUENCE_ITEMS)), std::clamp(count, 1, static_cast<int>(MAX_INSTRUMENTS)), reset});
	}

	//! The slots of the instruments the recorder made since the last call
	val takeRecordedInstruments() {
		val list = val::array();
		for (int slot : m_pSession->TakeRecordedInstruments())
			list.call<void>("push", slot);
		return list;
	}

	// ---- Configuration: Sound, Mixer and Emulation ---------------------------------------------

	//! The settings of the desktop's Sound (bass and treble filters, damping, volume), Mixer
	//! (levels of the devices, in tenths of dB: APU1, APU2, VRC6, VRC7, FDS, MMC5, N163, 5B)
	//! and Emulation pages (the FDS and N163 lowpass cutoffs, the N163's multiplexing, the
	//! VRC7's set of patches). They are the engine's, for every module, until changed.
	val soundSettings() const {
		const CSettings &settings = *theApp.GetSettings();
		val result = val::object();
		result.set("bassFilter", settings.Sound.iBassFilter);
		result.set("trebleFilter", settings.Sound.iTrebleFilter);
		result.set("trebleDamping", settings.Sound.iTrebleDamping);
		result.set("volume", settings.Sound.iMixVolume);
		result.set("fdsLowpass", settings.Emulation.iFDSLowpass);
		result.set("n163Lowpass", settings.Emulation.iN163Lowpass);
		result.set("disableN163Multiplexing", settings.Emulation.bNamcoMixing);
		result.set("vrc7Patch", settings.Emulation.iVRC7Patch);
		val levels = val::array();
		for (int *level : ChipLevels(theApp.GetSettings()))
			levels.call<void>("push", *level);
		result.set("levels", levels);
		return result;
	}

	//! Changes the ones that `values` has (out of range ones are brought into the range of
	//! the desktop's sliders) and sets the sound up again, which stops playback.
	void setSoundSettings(const val &values) {
		CSettings &settings = *theApp.GetSettings();
		const auto number = [&](const char *name, int &target, int low, int high) {
			if (values.hasOwnProperty(name))
				target = std::clamp(values[name].as<int>(), low, high);
		};
		number("bassFilter", settings.Sound.iBassFilter, 16, 4000);
		number("trebleFilter", settings.Sound.iTrebleFilter, 20, 20000);
		number("trebleDamping", settings.Sound.iTrebleDamping, 0, 90);
		number("volume", settings.Sound.iMixVolume, 0, 100);
		number("fdsLowpass", settings.Emulation.iFDSLowpass, 0, 8000);
		number("n163Lowpass", settings.Emulation.iN163Lowpass, 0, 12000);
		number("vrc7Patch", settings.Emulation.iVRC7Patch, 0, CAPU::OPLL_TONE_NUM - 1);
		if (values.hasOwnProperty("disableN163Multiplexing"))
			settings.Emulation.bNamcoMixing = values["disableN163Multiplexing"].as<bool>();
		if (values.hasOwnProperty("levels")) {
			const std::vector<int> levels = emscripten::vecFromJSArray<int>(values["levels"]);
			const std::vector<int *> targets = ChipLevels(&settings);
			for (size_t i = 0; i < levels.size() && i < targets.size(); ++i)
				*targets[i] = std::clamp(levels[i], -120, 120);
		}
		m_pSession->ApplyDocumentProperties();
	}

	// ---- file --------------------------------------------------------------------------

	//! The module as a .dnm file (Uint8Array)
	val save() {
		const std::vector<uint8_t> bytes = m_pSession->Save();
		return CopyToJs(bytes.data(), bytes.size());
	}

	//! A .dnm snapshot that does not mark the document as saved, including on failure.
	val saveSnapshot() {
		CFamiTrackerDoc &doc = Doc();
		struct RestoreModifiedFlag {
			CFamiTrackerDoc &doc;
			BOOL modified;
			~RestoreModifiedFlag() { doc.SetModifiedFlag(modified); }
		} restore {doc, doc.IsModified()};
		return save();
	}

	bool isModified() const {
		return m_pSession->IsModified();
	}

	// ---- module ------------------------------------------------------------------------

	val info() const {
		const CFamiTrackerDoc &doc = Doc();
		val result = val::object();
		result.set("type", m_pSession->GetType());
		result.set("program", m_pSession->GetProgram());
		result.set("title", dnft::detail::ToUtf8(doc.GetSongName(), 32));
		result.set("artist", dnft::detail::ToUtf8(doc.GetSongArtist(), 32));
		result.set("copyright", dnft::detail::ToUtf8(doc.GetSongCopyright(), 32));
		const CString comment = doc.GetComment();
		result.set("comment", WithLineBreaks(dnft::detail::ToUtf8(comment.GetString(), comment.GetLength()), "\n"));
		result.set("showComment", doc.ShowCommentOnOpen());
		result.set("pal", doc.GetMachine() == PAL);
		result.set("engineSpeed", doc.GetEngineSpeed());
		result.set("frameRate", doc.GetFrameRate());
		result.set("chips", static_cast<int>(doc.GetExpansionChip()));
		result.set("namcoChannels", doc.GetNamcoChannels());
		result.set("newVibrato", doc.GetVibratoStyle() == VIBRATO_NEW);
		result.set("linearPitch", doc.GetLinearPitch());
		result.set("speedSplitPoint", doc.GetSpeedSplitPoint());

		val tracks = val::array();
		for (unsigned i = 0; i < doc.GetTrackCount(); ++i) {
			const CString title = doc.GetTrackTitle(i);
			tracks.call<void>("push", val(dnft::detail::ToUtf8(title.GetString(), title.GetLength())));
		}
		result.set("tracks", tracks);

		val channels = val::array();
		for (int i = 0; i < doc.GetChannelCount(); ++i) {
			const CTrackerChannel *pChannel = doc.GetChannel(i);
			val entry = val::object();
			entry.set("name", std::string(pChannel->GetChannelName()));
			entry.set("shortName", std::string(pChannel->GetShortName()));
			entry.set("chip", static_cast<int>(pChannel->GetChip()));
			entry.set("id", static_cast<int>(pChannel->GetID()));
			channels.call<void>("push", entry);
		}
		result.set("channels", channels);
		return result;
	}

	void setTitle(const std::string &text) {
		Doc().SetSongName(ToDocument(text, 31).c_str());
	}

	void setArtist(const std::string &text) {
		Doc().SetSongArtist(ToDocument(text, 31).c_str());
	}

	void setCopyright(const std::string &text) {
		Doc().SetSongCopyright(ToDocument(text, 31).c_str());
	}

	//! Kept with the line breaks of the desktop's comment box (CR LF); showOnOpen: the
	//! desktop shows the comment when the file is opened
	void setComment(const std::string &text, bool showOnOpen) {
		CString comment(ToDocument(WithLineBreaks(text, "\r\n"), MAX_FILE_STRING).c_str());
		Doc().SetComment(comment, showOnOpen);
	}

	// ---- tracks ------------------------------------------------------------------------

	//! {title, frames, rows, speed, tempo, groove, highlight: [first, second],
	//!  effColumns: [per channel, 1-4], frameList: Uint8Array(frames * channels),
	//!  bookmarks: bookmarks()}
	val track(int track) const {
		const CFamiTrackerDoc &doc = Doc();
		CheckTrack(track);
		val result = val::object();
		const CString title = doc.GetTrackTitle(track);
		result.set("title", dnft::detail::ToUtf8(title.GetString(), title.GetLength()));
		const unsigned frames = doc.GetFrameCount(track);
		const int channels = doc.GetChannelCount();
		result.set("frames", frames);
		result.set("rows", doc.GetPatternLength(track));
		result.set("speed", doc.GetSongSpeed(track));
		result.set("tempo", doc.GetSongTempo(track));
		result.set("groove", doc.GetSongGroove(track));
		const stHighlight hl = doc.GetHighlight(track);
		val highlight = val::array();
		highlight.call<void>("push", hl.First);
		highlight.call<void>("push", hl.Second);
		result.set("highlight", highlight);
		val effColumns = val::array();
		for (int i = 0; i < channels; ++i)
			effColumns.call<void>("push", doc.GetEffColumns(track, i) + 1);
		result.set("effColumns", effColumns);
		std::vector<uint8_t> list(frames * channels);
		for (unsigned f = 0; f < frames; ++f)
			for (int c = 0; c < channels; ++c)
				list[f * channels + c] = static_cast<uint8_t>(doc.GetPatternAtFrame(track, f, c));
		result.set("frameList", CopyToJs(list.data(), list.size()));
		result.set("bookmarks", bookmarks(track));
		return result;
	}

	//! The track's bookmarks in the order it keeps them (the Bookmark Manager's): [{frame,
	//! row, name, highlight: [first, second] (-1: the track's own), persist (the highlight
	//! holds past the bookmark's frame)}]
	val bookmarks(int track) const {
		CheckTrack(track);
		val list = val::array();
		const CBookmarkCollection *pCol = Doc().GetBookmarkManager()->GetCollection(track);
		for (unsigned i = 0; i < pCol->GetCount(); ++i) {
			const CBookmark *pMark = pCol->GetBookmark(i);
			val entry = val::object();
			entry.set("frame", pMark->m_iFrame);
			entry.set("row", pMark->m_iRow);
			entry.set("name", dnft::detail::ToUtf8(pMark->m_sName.c_str(), pMark->m_sName.size()));
			val highlight = val::array();
			highlight.call<void>("push", pMark->m_Highlight.First);
			highlight.call<void>("push", pMark->m_Highlight.Second);
			entry.set("highlight", highlight);
			entry.set("persist", pMark->m_bPersist);
			list.call<void>("push", entry);
		}
		return list;
	}

	//! Replaces the track's bookmarks with a list as bookmarks() gives it. Those past the
	//! track's frames or rows are left out: the desktop refuses to open a module with one.
	void setBookmarks(int track, const val &list) {
		CheckTrack(track);
		CFamiTrackerDoc &doc = Doc();
		CBookmarkCollection *pCol = doc.GetBookmarkManager()->GetCollection(track);
		pCol->ClearBookmarks();
		const unsigned count = list["length"].as<unsigned>();
		for (unsigned i = 0; i < count; ++i) {
			const val entry = list[i];
			const int frame = entry["frame"].as<int>(), row = entry["row"].as<int>();
			if (frame < 0 || frame >= static_cast<int>(doc.GetFrameCount(track)) || row < 0 || row >= static_cast<int>(doc.GetPatternLength(track)))
				continue;
			auto pMark = new CBookmark(frame, row);
			const val highlight = entry["highlight"];
			pMark->m_Highlight.First = std::clamp(highlight[0].as<int>(), -1, MAX_PATTERN_LENGTH);
			pMark->m_Highlight.Second = std::clamp(highlight[1].as<int>(), -1, MAX_PATTERN_LENGTH);
			pMark->m_Highlight.Offset = 0;
			pMark->m_bPersist = entry["persist"].as<bool>();
			pMark->m_sName = ToDocument(entry["name"].as<std::string>(), MAX_FILE_STRING);
			pCol->AddBookmark(pMark);
		}
		doc.SetModifiedFlag();
	}

	int addTrack() {
		const int track = Doc().AddTrack();
		if (track < 0)
			throw std::runtime_error("the module has as many tracks as it can hold");
		return track;
	}

	void removeTrack(int track) {
		CheckTrack(track);
		if (Doc().GetTrackCount() < 2)
			throw std::runtime_error("a module keeps at least one track");
		m_pSession->Stop();
		Doc().RemoveTrack(track);
	}

	void setTrackTitle(int track, const std::string &title) {
		CheckTrack(track);
		Doc().SetTrackTitle(track, CString(ToDocument(title, MAX_FILE_STRING).c_str()));
	}

	//! Bookmarks on the rows that go are left out (see setBookmarks())
	void setPatternLength(int track, int rows) {
		CheckTrack(track);
		Doc().SetPatternLength(track, std::clamp(rows, 1, MAX_PATTERN_LENGTH));
		DropStrayBookmarks(track);
	}

	void setFrameCount(int track, int frames) {
		CheckTrack(track);
		Doc().SetFrameCount(track, std::clamp(frames, 1, MAX_FRAMES));
	}

	//! Ticks per row (1 to the speed split point - 1, or 255 with no tempo), or the groove
	void setSpeed(int track, int speed) {
		CheckTrack(track);
		CFamiTrackerDoc &doc = Doc();
		// CMainFrame::SetSpeed()
		if (doc.GetSongGroove(track))
			speed = std::clamp(speed, 0, MAX_GROOVE - 1);
		else
			speed = std::clamp(speed, MIN_SPEED, doc.GetSongTempo(track) ? doc.GetSpeedSplitPoint() - 1 : 0xFF);
		doc.SetSongSpeed(track, speed);
		ResetTempo(track);
	}

	void setTempo(int track, int tempo) {
		CheckTrack(track);
		CFamiTrackerDoc &doc = Doc();
		// CMainFrame::SetTempo(); 0 is the fixed tempo (CMainFrame::OnToggleFixTempo()): the speed alone
		// sets the pace, and the F effects of 20 and up set the speed
		doc.SetSongTempo(track, tempo == 0 ? 0 : std::clamp(tempo, doc.GetSpeedSplitPoint(), MAX_TEMPO));
		ResetTempo(track);
	}

	void setHighlight(int track, int first, int second) {
		CheckTrack(track);
		stHighlight hl = Doc().GetHighlight(track);
		hl.First = std::clamp(first, 0, MAX_PATTERN_LENGTH);
		hl.Second = std::clamp(second, 0, MAX_PATTERN_LENGTH);
		Doc().SetHighlight(track, hl);
	}

	//! 1-4 effect columns shown for the channel
	void setEffColumns(int track, int channel, int columns) {
		CheckTrack(track);
		CheckChannel(channel);
		Doc().SetEffColumns(track, channel, std::clamp(columns, 1, MAX_EFFECT_COLUMNS) - 1);
	}

	// ---- patterns ----------------------------------------------------------------------

	//! The pattern's rows (as many as the track's patterns have) as cells
	val pattern(int track, int channel, int pattern) const {
		CheckTrack(track);
		CheckChannel(channel);
		CheckPattern(pattern);
		const std::vector<uint8_t> cells = ReadPattern(track, channel, pattern);
		return CopyToJs(cells.data(), cells.size());
	}

	//! [{channel, pattern, data}] for every pattern of the track with something in it
	val patterns(int track) const {
		CheckTrack(track);
		const CFamiTrackerDoc &doc = Doc();
		val list = val::array();
		for (int c = 0; c < doc.GetChannelCount(); ++c)
			for (int p = 0; p < MAX_PATTERN; ++p)
				if (!doc.IsPatternEmpty(track, c, p)) {
					const std::vector<uint8_t> cells = ReadPattern(track, c, p);
					val entry = val::object();
					entry.set("channel", c);
					entry.set("pattern", p);
					entry.set("data", CopyToJs(cells.data(), cells.size()));
					list.call<void>("push", entry);
				}
		return list;
	}

	//! Writes cells (12 bytes each) from the row on, as far as the pattern goes
	void setCells(int track, int channel, int pattern, int row, const val &cells) {
		CheckTrack(track);
		CheckChannel(channel);
		CheckPattern(pattern);
		if (row < 0 || row >= MAX_PATTERN_LENGTH)
			throw std::out_of_range("no row " + std::to_string(row));
		const std::vector<uint8_t> bytes = FromJs(cells);
		CFamiTrackerDoc &doc = Doc();
		for (size_t at = 0; at + CELL_SIZE <= bytes.size() && row < MAX_PATTERN_LENGTH; at += CELL_SIZE, ++row) {
			const stChanNote note = UnpackCell(bytes.data() + at);
			doc.SetDataAtPattern(track, pattern, channel, row, &note);
		}
	}

	// ---- frames ------------------------------------------------------------------------

	void setFramePattern(int track, int frame, int channel, int pattern) {
		CheckFrame(track, frame);
		CheckChannel(channel);
		CheckPattern(pattern);
		Doc().SetPatternAtFrame(track, frame, channel, pattern);
		Doc().SetModifiedFlag();
	}

	//! The frame count and every frame's patterns (frames * channels), as track() gives them
	void setFrameList(int track, int frames, const val &list) {
		CheckTrack(track);
		CFamiTrackerDoc &doc = Doc();
		frames = std::clamp(frames, 1, MAX_FRAMES);
		const std::vector<uint8_t> patterns = FromJs(list);
		const int channels = doc.GetChannelCount();
		doc.SetFrameCount(track, frames);
		for (int f = 0; f < frames; ++f)
			for (int c = 0; c < channels; ++c)
				if (static_cast<size_t>(f * channels + c) < patterns.size())
					doc.SetPatternAtFrame(track, f, c, patterns[f * channels + c]);
		doc.SetModifiedFlag();
	}

	//! A frame of unused patterns at `frame`
	bool insertFrame(int track, int frame) {
		CheckTrack(track);
		if (frame < 0 || frame > static_cast<int>(Doc().GetFrameCount(track)))
			throw std::out_of_range("no frame " + std::to_string(frame));
		return Doc().InsertFrame(track, frame);
	}

	bool removeFrame(int track, int frame) {
		CheckFrame(track, frame);
		return Doc().RemoveFrame(track, frame);
	}

	//! A frame after `frame` that plays the same patterns
	bool duplicateFrame(int track, int frame) {
		CheckFrame(track, frame);
		return Doc().DuplicateFrame(track, frame);
	}

	//! A frame after `frame` with copies of its patterns
	bool cloneFrame(int track, int frame) {
		CheckFrame(track, frame);
		return Doc().CloneFrame(track, frame + 1);
	}

	bool moveFrame(int track, int frame, bool up) {
		CheckFrame(track, frame);
		return up ? Doc().MoveFrameUp(track, frame) : Doc().MoveFrameDown(track, frame);
	}

	//! `count` frames at `frame` (the frame count: after the last) that play pattern 0 in
	//! every channel; the bookmarks from there on move down with the frames
	//! (CFamiTrackerDoc::AddFrames(), as the frame editor's paste inserts)
	bool insertFrames(int track, int frame, int count) {
		CheckTrack(track);
		CFamiTrackerDoc &doc = Doc();
		if (frame < 0 || frame > static_cast<int>(doc.GetFrameCount(track)))
			throw std::out_of_range("no frame " + std::to_string(frame));
		if (count < 1 || !doc.AddFrames(track, frame, count))
			return false;
		doc.SetModifiedFlag();
		return true;
	}

	//! `count` frames from `frame` on removed, with their bookmarks, but never the last
	//! one left (CFamiTrackerDoc::DeleteFrames()); returns how many went
	int deleteFrames(int track, int frame, int count) {
		CheckFrame(track, frame);
		CFamiTrackerDoc &doc = Doc();
		const int frames = doc.GetFrameCount(track);
		doc.DeleteFrames(track, frame, std::clamp(count, 0, frames - frame));
		doc.SetModifiedFlag();
		return frames - static_cast<int>(doc.GetFrameCount(track));
	}

	//! The patterns of a block of the frame list: `list` has `channels` of them for each
	//! frame from `frame` on, from `channel` on; what is past the frames or the channels is
	//! left out (the frame editor's paste)
	void setFramePatterns(int track, int frame, int channel, int channels, const val &list) {
		CheckTrack(track);
		CFamiTrackerDoc &doc = Doc();
		const std::vector<uint8_t> patterns = FromJs(list);
		const int frames = doc.GetFrameCount(track), channelCount = doc.GetChannelCount();
		if (channels < 1)
			return;
		for (size_t i = 0; i < patterns.size(); ++i) {
			const int f = frame + static_cast<int>(i) / channels, c = channel + static_cast<int>(i) % channels;
			if (f >= 0 && f < frames && c >= 0 && c < channelCount)
				doc.SetPatternAtFrame(track, f, c, patterns[i]);
		}
		doc.SetModifiedFlag();
	}

	//! Each pattern that frames [frame0, frame1] play in channels [channel0, channel1],
	//! copied to the channel's first free pattern, which those frames then play; a pattern
	//! played more than once gets one copy (CFrameEditor::ClonePatterns(), the frame
	//! editor's Clone Patterns and Paste & Duplicate). The desktop's has no answer for a
	//! channel without free patterns: here its frames keep theirs. Returns how many
	//! patterns were left uncopied so.
	int clonePatterns(int track, int frame0, int frame1, int channel0, int channel1) {
		CheckFrame(track, frame0);
		CheckFrame(track, frame1);
		CheckChannel(channel0);
		CheckChannel(channel1);
		CFamiTrackerDoc &doc = Doc();
		std::vector<int> copies(MAX_CHANNELS * MAX_PATTERN, -1);
		int uncopied = 0;
		for (int f = std::min(frame0, frame1), last = std::max(frame0, frame1); f <= last; ++f)
			for (int c = std::min(channel0, channel1), end = std::max(channel0, channel1); c <= end; ++c) {
				const int old = doc.GetPatternAtFrame(track, f, c);
				int &copy = copies[c * MAX_PATTERN + old];
				if (copy < 0) {
					copy = static_cast<int>(doc.GetFirstFreePattern(track, c));
					if (copy < 0) {
						copy = old;
						++uncopied;
					}
					else
						doc.CopyPattern(track, copy, old, c);
				}
				doc.SetPatternAtFrame(track, f, c, copy);
			}
		doc.SetModifiedFlag();
		return uncopied;
	}

	//! The lowest pattern number the channel does not use (-1: none left)
	int freePattern(int track, int channel) const {
		CheckTrack(track);
		CheckChannel(channel);
		return static_cast<int>(Doc().GetFirstFreePattern(track, channel));
	}

	// ---- the Song menu and Module > Cleanup --------------------------------------------

	//! Song > Clear Patterns: every pattern of the track empty, and one frame (with the
	//! bookmarks of that frame)
	void clearPatterns(int track) {
		CheckTrack(track);
		Doc().ClearPatterns(track);
		DropStrayBookmarks(track);
	}

	//! Edit > Swap Channels: the two channels change their patterns, the patterns their
	//! frames play and their effect columns, in the track
	void swapChannels(int track, int first, int second) {
		CheckTrack(track);
		CheckChannel(first);
		CheckChannel(second);
		if (first != second)
			Doc().SwapChannels(track, first, second);
	}

	//! Song > Populate Unique Patterns: each frame plays patterns of its own, copies of
	//! what it played
	void populateUniquePatterns(int track) {
		CheckTrack(track);
		CFamiTrackerDoc &doc = Doc();
		// the desktop's makes the track anew and leaves its row highlight behind
		const stHighlight highlight = doc.GetHighlight(track);
		doc.PopulateUniquePatterns(track);
		doc.SetHighlight(track, highlight);
	}

	//! Song > Transpose Song: the notes C to B of the track, or of every track (`all`),
	//! `semitones` up or down, within C-0 to B-7, as CTransposeDlg::Transpose() does: in
	//! every pattern and every row, past the pattern length too, but not in the noise and
	//! DPCM channels nor the notes of the instruments in `excluded` (their numbers; a note
	//! without an instrument is always moved, where the desktop's reads past its table).
	//! Returns what changed, 8 bytes for each cell: track, channel, pattern, row, and the
	//! note and the octave before and after, for setNotes() to undo and redo it.
	val transposeSong(int track, bool all, int semitones, const val &excluded) {
		CheckTrack(track);
		CFamiTrackerDoc &doc = Doc();
		bool skip[MAX_INSTRUMENTS] = {};
		for (uint8_t index : FromJs(excluded))
			if (index < MAX_INSTRUMENTS)
				skip[index] = true;
		std::vector<uint8_t> changes;
		const bool modified = doc.IsModified() != FALSE;
		const int first = all ? 0 : track, last = all ? static_cast<int>(doc.GetTrackCount()) - 1 : track;
		for (int t = first; t <= last && semitones; ++t) {
			// the patterns with something in them, in any row: reading an empty one would
			// make room for all its rows (the desktop's reads them all)
			const unsigned length = doc.GetPatternLength(t);
			doc.SetPatternLength(t, MAX_PATTERN_LENGTH);
			std::vector<std::pair<int, int>> used;
			for (int c = doc.GetChannelCount() - 1; c >= 0; --c) {
				const int type = doc.GetChannelType(c);
				if (type == CHANID_NOISE || type == CHANID_DPCM)
					continue;
				for (int p = 0; p < MAX_PATTERN; ++p)
					if (!doc.IsPatternEmpty(t, c, p))
						used.emplace_back(c, p);
			}
			doc.SetPatternLength(t, length);
			for (const auto &[c, p] : used)
				for (int r = 0; r < MAX_PATTERN_LENGTH; ++r) {
					stChanNote note;
					doc.GetDataAtPattern(t, p, c, r, &note);
					if (note.Note < NOTE_C || note.Note > NOTE_B || (note.Instrument < MAX_INSTRUMENTS && skip[note.Instrument]))
						continue;
					const int midi = std::clamp(MIDI_NOTE(note.Octave, note.Note) + semitones, 0, NOTE_COUNT - 1);
					const int value = GET_NOTE(midi), octave = GET_OCTAVE(midi);
					if (value == note.Note && octave == note.Octave)
						continue;
					const uint8_t change[] = {
						static_cast<uint8_t>(t), static_cast<uint8_t>(c), static_cast<uint8_t>(p), static_cast<uint8_t>(r),
						note.Note, note.Octave, static_cast<uint8_t>(value), static_cast<uint8_t>(octave),
					};
					changes.insert(changes.end(), std::begin(change), std::end(change));
					note.Note = value;
					note.Octave = octave;
					doc.SetDataAtPattern(t, p, c, r, &note);
				}
		}
		doc.SetModifiedFlag(changes.empty() ? modified : TRUE);
		return CopyToJs(changes);
	}

	//! The notes transposeSong() changed, as they were (`after` false) or as it left them
	void setNotes(const val &changes, bool after) {
		const std::vector<uint8_t> list = FromJs(changes);
		CFamiTrackerDoc &doc = Doc();
		for (size_t at = 0; at + 8 <= list.size(); at += 8) {
			const uint8_t *change = list.data() + at;
			CheckTrack(change[0]);
			CheckChannel(change[1]);
			stChanNote note;
			doc.GetDataAtPattern(change[0], change[2], change[1], change[3], &note);
			note.Note = change[after ? 6 : 4];
			note.Octave = change[after ? 7 : 5];
			doc.SetDataAtPattern(change[0], change[2], change[1], change[3], &note);
		}
		if (!list.empty())
			doc.SetModifiedFlag();
	}

	//! Module > Cleanup: the instruments no pattern plays (and the sequences no instrument
	//! uses), the patterns no frame plays, the DPCM samples and assignments no note plays
	void removeUnusedInstruments() {
		Doc().RemoveUnusedInstruments();
	}

	void removeUnusedPatterns() {
		Doc().RemoveUnusedPatterns();
	}

	void removeUnusedSamples() {
		// the DPCM may be playing from one of them
		m_pSession->ReleaseSamples();
		Doc().RemoveUnusedSamples();
	}

	//! Module properties > Move up / Move down: the track changes places with the one
	//! before or after it; false when there is none. Stops playback.
	bool moveTrack(int track, bool up) {
		CheckTrack(track);
		const int other = up ? track - 1 : track + 1;
		if (other < 0 || other >= static_cast<int>(Doc().GetTrackCount()))
			return false;
		m_pSession->Stop();
		if (up)
			Doc().MoveTrackUp(track);
		else
			Doc().MoveTrackDown(track);
		return true;
	}

	//! Song > Estimate Song Length: {intro, loop} in seconds (loop 0 for a song that halts)
	//! and the frame rate, for the ticks
	val songLength(int track) const {
		CheckTrack(track);
		const CFamiTrackerDoc &doc = Doc();
		// CMainFrame::OnModuleEstimateSongLength()
		const double once = doc.GetStandardLength(track, 0);
		const double loop = doc.GetStandardLength(track, 1) - once;
		val result = val::object();
		result.set("intro", once - loop);
		result.set("loop", loop);
		result.set("frameRate", doc.GetFrameRate());
		return result;
	}

	// ---- instruments -------------------------------------------------------------------

	//! [{index, type, name}] for the slots in use
	val instruments() const {
		const CFamiTrackerDoc &doc = Doc();
		val list = val::array();
		for (int i = 0; i < MAX_INSTRUMENTS; ++i)
			if (auto pInst = doc.GetInstrument(i)) {
				val entry = val::object();
				entry.set("index", i);
				entry.set("type", static_cast<int>(pInst->GetType()));
				entry.set("name", dnft::detail::ToUtf8(pInst->GetName(), CInstrument::INST_NAME_MAX));
				list.call<void>("push", entry);
			}
		return list;
	}

	//! {index, type, name, and by the kind of instrument:
	//!  sequences: [{enabled, index}] for the 5 kinds (2A03, VRC6, N163, 5B: the sequences
	//!   are the module's, numbered, and shared between instruments),
	//!  dpcm: {samples, pitches, deltas} of the 96 notes (octave * 12 + semitone) for the 2A03:
	//!   the sample number (0: none, else the slot + 1), the pitch 0-15 with 0x80 for looping,
	//!   the initial delta counter (-1: off),
	//!  n163: {waveSize, wavePos, waveCount, waves: Uint8Array(waveCount * waveSize)},
	//!  fds: {wave: Uint8Array(64), modulation: Uint8Array(32), speed, depth, delay,
	//!   sequences: [sequence()] volume, arpeggio and pitch, which the instrument owns},
	//!  vrc7: {patch, registers: Uint8Array(8)} (0: the instrument's own patch)}
	val instrument(int index) const {
		const auto pInst = GetInstrument(index);
		val result = val::object();
		result.set("index", index);
		result.set("type", static_cast<int>(pInst->GetType()));
		result.set("name", dnft::detail::ToUtf8(pInst->GetName(), CInstrument::INST_NAME_MAX));
		if (auto pFds = std::dynamic_pointer_cast<CInstrumentFDS>(pInst)) {
			val fds = val::object();
			std::vector<uint8_t> wave(CInstrumentFDS::WAVE_SIZE), modulation(CInstrumentFDS::MOD_SIZE);
			for (size_t i = 0; i < wave.size(); ++i)
				wave[i] = pFds->GetSample(static_cast<int>(i));
			for (size_t i = 0; i < modulation.size(); ++i)
				modulation[i] = static_cast<uint8_t>(pFds->GetModulation(static_cast<int>(i)));
			fds.set("wave", CopyToJs(wave));
			fds.set("modulation", CopyToJs(modulation));
			fds.set("speed", pFds->GetModulationSpeed());
			fds.set("depth", pFds->GetModulationDepth());
			fds.set("delay", pFds->GetModulationDelay());
			val sequences = val::array();
			for (int i = 0; i < CInstrumentFDS::SEQUENCE_COUNT; ++i)
				sequences.call<void>("push", SequenceToJs(pFds->GetSequence(i)));
			fds.set("sequences", sequences);
			result.set("fds", fds);
		}
		else if (auto pSeqInst = std::dynamic_pointer_cast<CSeqInstrument>(pInst)) {
			val sequences = val::array();
			for (int i = 0; i < SEQ_COUNT; ++i) {
				val entry = val::object();
				entry.set("enabled", pSeqInst->GetSeqEnable(i) != 0);
				entry.set("index", pSeqInst->GetSeqIndex(i));
				sequences.call<void>("push", entry);
			}
			result.set("sequences", sequences);
		}
		if (auto p2A03 = std::dynamic_pointer_cast<CInstrument2A03>(pInst)) {
			val samples = val::global("Uint8Array").new_(NOTE_COUNT);
			val pitches = val::global("Uint8Array").new_(NOTE_COUNT);
			val deltas = val::global("Int8Array").new_(NOTE_COUNT);
			for (int octave = 0; octave < OCTAVE_RANGE; ++octave)
				for (int note = 0; note < NOTE_RANGE; ++note) {
					const int key = octave * NOTE_RANGE + note;
					samples.set(key, static_cast<int>(static_cast<uint8_t>(p2A03->GetSampleIndex(octave, note))));
					pitches.set(key, static_cast<int>(static_cast<uint8_t>(p2A03->GetSamplePitch(octave, note))));
					deltas.set(key, static_cast<int>(p2A03->GetSampleDeltaValue(octave, note)));
				}
			val dpcm = val::object();
			dpcm.set("samples", samples);
			dpcm.set("pitches", pitches);
			dpcm.set("deltas", deltas);
			result.set("dpcm", dpcm);
		}
		else if (auto pN163 = std::dynamic_pointer_cast<CInstrumentN163>(pInst)) {
			const int size = pN163->GetWaveSize(), count = pN163->GetWaveCount();
			std::vector<uint8_t> waves(static_cast<size_t>(size) * count);
			for (int wave = 0; wave < count; ++wave)
				for (int i = 0; i < size; ++i)
					waves[static_cast<size_t>(wave) * size + i] = static_cast<uint8_t>(pN163->GetSample(wave, i));
			val n163 = val::object();
			n163.set("waveSize", size);
			n163.set("wavePos", pN163->GetWavePos());
			n163.set("waveCount", count);
			n163.set("waves", CopyToJs(waves));
			result.set("n163", n163);
		}
		else if (auto pVrc7 = std::dynamic_pointer_cast<CInstrumentVRC7>(pInst)) {
			std::vector<uint8_t> registers(8);
			for (int i = 0; i < 8; ++i)
				registers[i] = pVrc7->GetCustomReg(i);
			val vrc7 = val::object();
			vrc7.set("patch", static_cast<int>(pVrc7->GetPatch()));
			vrc7.set("registers", CopyToJs(registers));
			result.set("vrc7", vrc7);
		}
		return result;
	}

	//! A new instrument for the chip (SNDCHIP_*); its index, or -1 when all slots are taken
	int addInstrument(int chip, const std::string &name) {
		return Doc().AddInstrument(ToDocument(name, CInstrument::INST_NAME_MAX - 1).c_str(), chip);
	}

	void removeInstrument(int index) {
		GetInstrument(index);
		Doc().RemoveInstrument(index);
	}

	//! A copy sharing the sequences; its index, or -1
	int cloneInstrument(int index) {
		GetInstrument(index);
		return Doc().CloneInstrument(index);
	}

	//! A copy with copies of the sequences; its index, or -1
	int deepCloneInstrument(int index) {
		GetInstrument(index);
		return Doc().DeepCloneInstrument(index);
	}

	void setInstrumentName(int index, const std::string &name) {
		GetInstrument(index);
		Doc().SetInstrumentName(index, ToDocument(name, CInstrument::INST_NAME_MAX - 1).c_str());
	}

	void setInstrumentSequence(int index, int seqType, bool enabled, int seqIndex) {
		auto pInst = GetSequenceInstrument(index, seqType);
		CheckSequence(seqType, seqIndex);
		pInst->SetSeqEnable(seqType, enabled ? 1 : 0);
		pInst->SetSeqIndex(seqType, seqIndex);
		Doc().SetModifiedFlag();
	}

	//! {items: Int8Array, loop, release, setting}; loop and release are -1 when unset
	val sequence(int instType, int seqType, int index) const {
		return SequenceToJs(GetSequence(instType, seqType, index));
	}

	void setSequence(int instType, int seqType, int index, const val &items, int loop, int release, int setting) {
		WriteSequence(GetSequence(instType, seqType, index), seqType, items, loop, release, setting);
		Doc().SetModifiedFlag();
	}

	//! The lowest sequence index no instrument uses, or -1
	int freeSequence(int instType, int seqType) const {
		CheckSequence(seqType, 0);
		return Doc().GetFreeSequence(static_cast<inst_type_t>(instType), seqType);
	}

	//! The number the instrument's "Select next empty slot" button picks for the kind of
	//! sequence: the lowest one no other instrument uses that has nothing in it (the
	//! instrument's own may be it), or -1. The instrument then uses it: see
	//! setInstrumentSequence().
	int nextFreeSequence(int index, int seqType) const {
		const auto pInst = GetSequenceInstrument(index, seqType);
		return Doc().GetFreeSequence(pInst->GetType(), seqType, pInst.get());
	}

	//! "Clone sequence": the instrument's sequence of the kind is copied into the lowest free
	//! number, which the instrument takes; that number, or -1 when there is none
	int cloneSequence(int index, int seqType) {
		const auto pInst = GetSequenceInstrument(index, seqType);
		CFamiTrackerDoc &doc = Doc();
		const inst_type_t type = pInst->GetType();
		const int free = doc.GetFreeSequence(type, seqType, pInst.get());
		if (free < 0)
			return -1;
		doc.GetSequence(type, free, seqType)->Copy(pInst->GetSequence(seqType));
		pInst->SetSeqIndex(seqType, free);
		doc.SetModifiedFlag();
		return free;
	}

	//! One of the FDS instrument's own sequences (0 volume, 1 arpeggio, 2 pitch)
	void setFdsSequence(int index, int seqType, const val &items, int loop, int release, int setting) {
		auto pFds = GetFds(index);
		if (seqType < 0 || seqType >= CInstrumentFDS::SEQUENCE_COUNT)
			throw std::out_of_range("no FDS sequence type " + std::to_string(seqType));
		WriteSequence(pFds->GetSequence(seqType), seqType, items, loop, release, setting);
		Doc().SetModifiedFlag();
	}

	// ---- instrument files --------------------------------------------------------------

	//! The instrument as an .fti file (Uint8Array), with the DPCM samples of the 2A03's
	val saveInstrument(int index) {
		GetInstrument(index);
		const std::string path = dnft::detail::NewPath("save.fti");
		dnft::detail::MessageCollector messages;
		Doc().SaveInstrument(index, CString(path.c_str()));
		const std::vector<uint8_t> bytes = dnft_compat::TakeFile(path);
		if (bytes.empty())
			throw std::runtime_error(messages.GetText().empty() ? "could not save the instrument" : messages.GetText());
		return CopyToJs(bytes);
	}

	//! Reads an .fti file into the first free instrument slot, which is its number. Its DPCM
	//! samples are added to the module's (one the module has already is not added again).
	//! Throws with the loader's message when it is not an instrument file, or the module has
	//! no room for it.
	int loadInstrument(const val &bytes) {
		CFamiTrackerDoc &doc = Doc();
		int slot = -1;
		for (int i = 0; i < MAX_INSTRUMENTS && slot < 0; ++i)
			if (!doc.GetInstrument(i))
				slot = i;
		if (slot < 0)
			throw std::runtime_error("the module has as many instruments as it can hold");
		const std::string path = dnft::detail::NewPath("load.fti");
		dnft_compat::PutFile(path, FromJs(bytes));
		dnft::detail::MessageCollector messages;
		int loaded = INVALID_INSTRUMENT;
		try {
			loaded = doc.LoadInstrument(CString(path.c_str()));
		}
		catch (...) {
			// what the loader does not handle, such as running out of memory, leaves the
			// instrument half made
			dnft_compat::TakeFile(path);
			doc.RemoveInstrument(slot);
			throw;
		}
		dnft_compat::TakeFile(path);
		if (loaded < 0)
			throw std::runtime_error(messages.GetText().empty() ? "not an instrument file" : messages.GetText());
		return loaded;
	}

	// ---- 2A03: the DPCM samples and where they play -----------------------------------------

	//! The sample a key plays, as instrument() gives it: `key` is octave * 12 + semitone,
	//! `sample` 0 for none or the slot + 1, `pitch` 0-15, `delta` the delta counter it starts
	//! at (-1: as it is)
	void setDpcmKey(int index, int key, int sample, int pitch, bool loop, int delta) {
		auto pInst = std::dynamic_pointer_cast<CInstrument2A03>(GetInstrument(index));
		if (!pInst)
			throw std::runtime_error("instrument " + std::to_string(index) + " has no DPCM samples");
		if (key < 0 || key >= NOTE_COUNT)
			throw std::out_of_range("no key " + std::to_string(key));
		const int octave = key / NOTE_RANGE, note = key % NOTE_RANGE;
		pInst->SetSampleIndex(octave, note, static_cast<char>(std::clamp(sample, 0, MAX_DSAMPLES)));
		pInst->SetSamplePitch(octave, note, static_cast<char>(std::clamp(pitch, 0, 15) | (loop ? 0x80 : 0)));
		pInst->SetSampleDeltaValue(octave, note, static_cast<char>(std::clamp(delta, -1, 127)));
		Doc().SetModifiedFlag();
	}

	//! {samples: [{index, name, size}] for the slots in use, used: bytes taken, capacity:
	//!  bytes the module may hold, maxSize: the longest sample, slots}
	val samples() const {
		const CFamiTrackerDoc &doc = Doc();
		val list = val::array();
		for (int i = 0; i < MAX_DSAMPLES; ++i)
			if (const CDSample *pSample = doc.GetSample(i)) {
				val entry = val::object();
				entry.set("index", i);
				entry.set("name", dnft::detail::ToUtf8(pSample->GetName(), CDSample::MAX_NAME_SIZE));
				entry.set("size", pSample->GetSize());
				list.call<void>("push", entry);
			}
		val result = val::object();
		result.set("samples", list);
		result.set("used", doc.GetTotalSampleSize());
		result.set("capacity", MAX_SAMPLE_SPACE);
		result.set("maxSize", static_cast<int>(CDSample::MAX_SIZE));
		result.set("slots", MAX_DSAMPLES);
		return result;
	}

	//! {index, name, data: Uint8Array}
	val sample(int index) const {
		const CDSample *pSample = GetSample(index);
		val result = val::object();
		result.set("index", index);
		result.set("name", dnft::detail::ToUtf8(pSample->GetName(), CDSample::MAX_NAME_SIZE));
		result.set("data", CopyToJs(reinterpret_cast<const uint8_t *>(pSample->GetData()), pSample->GetSize()));
		return result;
	}

	//! Puts a sample in the slot (replacing the one there), or in the first free one when
	//! `index` is -1; the slot. Throws when the module has no slot or no room for it.
	int setSample(int index, const std::string &name, const val &data) {
		CFamiTrackerDoc &doc = Doc();
		const std::vector<uint8_t> bytes = FromJs(data);
		if (bytes.empty() || bytes.size() > static_cast<size_t>(CDSample::MAX_SIZE))
			throw std::out_of_range("a DPCM sample takes 1 to " + std::to_string(CDSample::MAX_SIZE) + " bytes");
		unsigned freed = 0;
		if (index < 0) {
			index = doc.GetFreeSampleSlot();
			if (index < 0)
				throw std::runtime_error("the module has as many DPCM samples as it can hold");
		}
		else {
			if (index >= MAX_DSAMPLES)
				throw std::out_of_range("no sample slot " + std::to_string(index));
			if (const CDSample *pOld = doc.GetSample(index))
				freed = pOld->GetSize();
		}
		if (doc.GetTotalSampleSize() - freed + bytes.size() > static_cast<unsigned>(MAX_SAMPLE_SPACE))
			throw std::runtime_error("the DPCM samples would take more than " + std::to_string(MAX_SAMPLE_SPACE / 1024) + " KB");
		CDSample *pSample = new CDSample(static_cast<unsigned>(bytes.size()));
		std::copy(bytes.begin(), bytes.end(), reinterpret_cast<uint8_t *>(pSample->GetData()));
		pSample->SetName(ToDocument(name, CDSample::MAX_NAME_SIZE - 1).c_str());
		// the DPCM may be playing from the sample that goes
		m_pSession->ReleaseSamples();
		doc.SetSample(index, pSample);
		return index;
	}

	//! Takes the sample out of the module. Keys that played it play nothing.
	void removeSample(int index) {
		GetSample(index);
		m_pSession->ReleaseSamples();
		Doc().RemoveSample(index);
	}

	//! The sample editor's play button: plays the bytes (they need not be in the module) at
	//! pitch 0-15 from the 64 byte step `offset`; `deltaStart` starts the delta counter at 64
	//! rather than at 0
	void previewSample(const val &data, int offset, int pitch, bool deltaStart) {
		m_pSession->PreviewSample(FromJs(data), offset, pitch, deltaStart);
	}

	//! Stops a sample that previewSample() plays
	void stopPreview() {
		m_pSession->ReleaseSamples();
	}

	// ---- FDS: the wave, the modulation and their settings ---------------------------------

	//! The 64 steps of the wave, 0-63 each
	void setFdsWave(int index, const val &wave) {
		auto pFds = GetFds(index);
		const std::vector<int> values = BoundedValues(wave, CInstrumentFDS::WAVE_SIZE, 0, 63);
		for (int i = 0; i < CInstrumentFDS::WAVE_SIZE; ++i)
			pFds->SetSample(i, values[i]);
		WaveChanged();
	}

	//! The 32 steps of the modulation table, 0-7 each (0 no change, 1 +1, 2 +2, 3 +4, 4
	//! back to 0, 5 -4, 6 -2, 7 -1)
	void setFdsModulation(int index, const val &table) {
		auto pFds = GetFds(index);
		const std::vector<int> values = BoundedValues(table, CInstrumentFDS::MOD_SIZE, 0, CInstrumentFDS::MOD_Y - 1);
		for (int i = 0; i < CInstrumentFDS::MOD_SIZE; ++i)
			pFds->SetModulation(i, values[i]);
		WaveChanged();
	}

	//! Modulation rate 0-4095, depth 0-63 and delay 0-255
	void setFdsParams(int index, int speed, int depth, int delay) {
		auto pFds = GetFds(index);
		pFds->SetModulationSpeed(std::clamp(speed, 0, 4095));
		pFds->SetModulationDepth(std::clamp(depth, 0, 63));
		pFds->SetModulationDelay(std::clamp(delay, 0, 255));
		WaveChanged();
	}

	// ---- N163: the waves -----------------------------------------------------------------

	//! Sets the size (a multiple of 4, 4-240), the position (0-255, at most 240 less the
	//! size), and the waves: `count` (1-64) of `size` samples, 0-15 each, one after the
	//! other. Returns what came of them: {waveSize, wavePos, waveCount}
	val setN163(int index, int size, int pos, int count, const val &waves) {
		auto pInst = GetN163(index);
		size = std::clamp(size & ~3, 4, CInstrumentN163::MAX_WAVE_SIZE);
		count = std::clamp(count, 1, CInstrumentN163::MAX_WAVE_COUNT);
		const std::vector<int> values = BoundedValues(waves, static_cast<size_t>(size) * count, 0, 15);
		pInst->SetWaveSize(size);
		pInst->SetWavePos(std::clamp(pos, 0, 255));
		pInst->SetWaveCount(count);
		for (int wave = 0; wave < count; ++wave)
			for (int i = 0; i < size; ++i)
				pInst->SetSample(wave, i, values[static_cast<size_t>(wave) * size + i]);
		WaveChanged();
		val result = val::object();
		result.set("waveSize", pInst->GetWaveSize());
		result.set("wavePos", pInst->GetWavePos());
		result.set("waveCount", pInst->GetWaveCount());
		return result;
	}

	//! The samples of one wave (as many as the instrument's waves have), 0-15 each
	void setN163Wave(int index, int wave, const val &samples) {
		auto pInst = GetN163(index);
		if (wave < 0 || wave >= pInst->GetWaveCount())
			throw std::out_of_range("no wave " + std::to_string(wave));
		const std::vector<int> values = BoundedValues(samples, pInst->GetWaveSize(), 0, 15);
		for (int i = 0; i < pInst->GetWaveSize(); ++i)
			pInst->SetSample(wave, i, values[i]);
		WaveChanged();
	}

	// ---- VRC7: the patch -------------------------------------------------------------------

	//! The patch to play (0 the instrument's own, 1-15 the chip's), and the 8 registers of
	//! its own
	void setVrc7(int index, int patch, const val &registers) {
		auto pInst = std::dynamic_pointer_cast<CInstrumentVRC7>(GetInstrument(index));
		if (!pInst)
			throw std::runtime_error("instrument " + std::to_string(index) + " is not a VRC7 instrument");
		const std::vector<int> values = BoundedValues(registers, 8, 0, 255);
		for (int i = 0; i < 8; ++i)
			pInst->SetCustomReg(i, static_cast<unsigned char>(values[i]));
		pInst->SetPatch(std::clamp(patch, 0, 15));
		Doc().SetModifiedFlag();
	}

	//! {patches: Uint8Array(16 * 8), names: [16]}: the patches the module's VRC7 instruments
	//! choose from (the chip's, or the module's own with an external OPLL). Patch 0 is
	//! each instrument's own.
	val vrc7Patches() const {
		const CFamiTrackerDoc &doc = Doc();
		std::vector<uint8_t> patches(16 * 8);
		for (size_t i = 0; i < patches.size(); ++i)
			patches[i] = doc.GetOPLLPatchByte(static_cast<int>(i));
		val names = val::array();
		for (int i = 0; i < 16; ++i)
			names.call<void>("push", dnft::text::ToUtf8(doc.GetOPLLPatchName(i)));
		val result = val::object();
		result.set("patches", CopyToJs(patches));
		result.set("names", names);
		return result;
	}

	// ---- sound -------------------------------------------------------------------------

	//! Expansion chips (SNDCHIP_* bits) and N163 channels (1-8 with the N163). Moves the
	//! patterns of the channels kept, stops playback.
	void setExpansion(int chips, int namcoChannels) {
		CFamiTrackerDoc &doc = Doc();
		chips &= SNDCHIP_VRC6 | SNDCHIP_VRC7 | SNDCHIP_FDS | SNDCHIP_MMC5 | SNDCHIP_N163 | SNDCHIP_S5B;
		namcoChannels = chips & SNDCHIP_N163 ? std::clamp(namcoChannels, 1, 8) : 0;
		if (doc.GetExpansionChip() == chips && doc.GetNamcoChannels() == namcoChannels)
			return;
		// CModulePropertiesDlg::OnBnClickedOk()
		m_pSession->Stop();
		doc.SetNamcoChannels(namcoChannels, true);
		doc.SelectExpansionChip(static_cast<unsigned char>(chips), true);
		m_pSession->ApplyDocumentProperties();
	}

	void setMachine(bool pal) {
		Doc().SetMachine(pal ? PAL : NTSC, false);
		m_pSession->ApplyDocumentProperties();
	}

	//! Engine ticks per second, 0 for the machine's
	void setEngineSpeed(int hz) {
		Doc().SetEngineSpeed(hz == 0 ? 0 : std::clamp(hz, 16, 400));
		m_pSession->ApplyDocumentProperties();
	}

	//! Ctrl+Shift+S: the value from which an F effect sets the tempo, not the speed (32, or 21 as
	//! old modules had it); a value of the range the F effect takes
	void setSpeedSplitPoint(int point) {
		Doc().SetSpeedSplitPoint(std::clamp(point, 2, 255));
		m_pSession->ApplyDocumentProperties();
	}

	void setVibratoStyle(bool newStyle) {
		Doc().SetVibratoStyle(newStyle ? VIBRATO_NEW : VIBRATO_OLD);
		m_pSession->ApplyDocumentProperties();
	}

	void setLinearPitch(bool enable) {
		Doc().SetLinearPitch(enable);
		m_pSession->ApplyDocumentProperties();
	}

	//! {offsets: Int16Array(6 * 96), the period offset of each note (octave * 12 + note)
	//!  for the NTSC and PAL 2A03, VRC6 sawtooth, VRC7, FDS and N163, one table after the
	//!  other; semitone, cent: the tuning of the whole}
	val detune() const {
		const CFamiTrackerDoc &doc = Doc();
		std::vector<int16_t> offsets(DETUNE_CHIPS * NOTE_COUNT);
		for (int chip = 0; chip < DETUNE_CHIPS; ++chip)
			for (int note = 0; note < NOTE_COUNT; ++note)
				offsets[chip * NOTE_COUNT + note] = static_cast<int16_t>(doc.GetDetuneOffset(chip, note));
		val array = val::global("Int16Array").new_(offsets.size());
		array.call<void>("set", val(emscripten::typed_memory_view(offsets.size(), offsets.data())));
		val result = val::object();
		result.set("offsets", array);
		result.set("semitone", doc.GetTuningSemitone());
		result.set("cent", doc.GetTuningCent());
		return result;
	}

	//! Module > Detune Settings: offsets as detune() gives them, semitone -12 to 12, cent
	//! -100 to 100. Playback goes on with the new pitches.
	void setDetune(const val &offsets, int semitone, int cent) {
		const std::vector<int> values = emscripten::convertJSArrayToNumberVector<int>(offsets);
		CFamiTrackerDoc &doc = Doc();
		for (int chip = 0; chip < DETUNE_CHIPS; ++chip)
			for (int note = 0; note < NOTE_COUNT; ++note) {
				const size_t at = chip * NOTE_COUNT + note;
				if (at < values.size())
					doc.SetDetuneOffset(chip, note, std::clamp(values[at], -32768, 32767));
			}
		doc.SetTuning(std::clamp(semitone, -NOTE_RANGE, NOTE_RANGE), std::clamp(cent, -100, 100));
		// CFamiTrackerView::OnTrackerDetune(), CDetuneDlg::OnBnClickedOk()
		doc.ModifyIrreversible();
		theApp.GetSoundGenerator()->DocumentPropertiesChanged(&doc);
	}

	//! The 32 grooves: the entries of each (Uint8Array), null for the ones not set
	val grooves() const {
		const CFamiTrackerDoc &doc = Doc();
		val list = val::array();
		for (int i = 0; i < MAX_GROOVE; ++i) {
			const CGroove *pGroove = doc.GetGroove(i);
			if (!pGroove || !pGroove->GetSize()) {
				list.call<void>("push", val::null());
				continue;
			}
			std::vector<uint8_t> entries(pGroove->GetSize());
			for (size_t k = 0; k < entries.size(); ++k)
				entries[k] = pGroove->GetEntry(static_cast<int>(k));
			list.call<void>("push", CopyToJs(entries.data(), entries.size()));
		}
		return list;
	}

	//! Module > Groove Settings: the 32 grooves as grooves() gives them (an empty one or
	//! null: not set), entries 1-255, at most 128 of them. A module has room for 255 bytes
	//! of grooves (the entries and two more for each), or this throws. Tracks that played a
	//! groove that goes get speed 6 back, as the dialog does.
	void setGrooves(const val &list) {
		const unsigned count = list["length"].as<unsigned>();
		std::vector<std::vector<uint8_t>> grooves(MAX_GROOVE);
		int total = 0;
		for (unsigned i = 0; i < count && i < static_cast<unsigned>(MAX_GROOVE); ++i) {
			const val entries = list[i];
			if (entries.isNull() || entries.isUndefined())
				continue;
			for (const int entry : emscripten::convertJSArrayToNumberVector<int>(entries))
				grooves[i].push_back(static_cast<uint8_t>(std::clamp(entry, 1, 255)));
			if (grooves[i].size() > MAX_GROOVE_SIZE)
				throw std::out_of_range("groove " + std::to_string(i) + " has more than " + std::to_string(MAX_GROOVE_SIZE) + " entries");
			if (!grooves[i].empty())
				total += static_cast<int>(grooves[i].size()) + 2;
		}
		// CGrooveDlg::UpdateIndicators()
		if (total > 255)
			throw std::out_of_range("the grooves take " + std::to_string(total) + " bytes, more than 255");
		// CGrooveDlg::OnBnClickedApply()
		CFamiTrackerDoc &doc = Doc();
		for (int i = 0; i < MAX_GROOVE; ++i) {
			if (!grooves[i].empty()) {
				CGroove groove;
				groove.SetSize(static_cast<unsigned char>(grooves[i].size()));
				for (size_t k = 0; k < grooves[i].size(); ++k)
					groove.SetEntry(static_cast<unsigned char>(k), grooves[i][k]);
				doc.SetGroove(i, &groove);
				continue;
			}
			doc.SetGroove(i, nullptr);
			for (unsigned track = 0; track < doc.GetTrackCount(); ++track)
				if (doc.GetSongGroove(track) && doc.GetSongSpeed(track) == static_cast<unsigned>(i)) {
					doc.SetSongSpeed(track, DEFAULT_SPEED);
					doc.SetSongGroove(track, false);
					ResetTempo(track);
				}
		}
		doc.ModifyIrreversible();
	}

	//! The control panel's Speed / Groove button: the track's speed is a groove number
	//! (0-31) or ticks per row
	void setGrooveMode(int track, bool groove) {
		CheckTrack(track);
		CFamiTrackerDoc &doc = Doc();
		// CMainFrame::OnToggleGroove(), OnUpdateGrooveEdit()
		doc.SetSongGroove(track, groove);
		const int speed = static_cast<int>(doc.GetSongSpeed(track));
		doc.SetSongSpeed(track, groove ? std::clamp(speed, 0, MAX_GROOVE - 1) :
			std::clamp(speed, MIN_SPEED, doc.GetSongTempo(track) ? doc.GetSpeedSplitPoint() - 1 : 0xFF));
		doc.SetModifiedFlag();
		ResetTempo(track);
	}

	//! {levels: the level of each device in tenths of a dB (2A03 pulse, 2A03 triangle,
	//!  noise and DPCM, VRC6, VRC7, FDS, MMC5, N163, 5B), hardwareMixing}
	val mixing() const {
		const CFamiTrackerDoc &doc = Doc();
		val levels = val::array();
		for (int i = 0; i < MIX_DEVICES; ++i)
			levels.call<void>("push", doc.GetLevelOffset(i));
		val result = val::object();
		result.set("levels", levels);
		result.set("hardwareMixing", doc.GetSurveyMixCheck());
		return result;
	}

	//! Module properties: the device mix offsets, -12 to 12 dB, and hardware-based mixing.
	//! Resets the sound generator, which stops playback.
	void setMixing(const val &levels, bool hardwareMixing) {
		const std::vector<int> values = emscripten::convertJSArrayToNumberVector<int>(levels);
		CFamiTrackerDoc &doc = Doc();
		for (int i = 0; i < MIX_DEVICES && i < static_cast<int>(values.size()); ++i)
			doc.SetLevelOffset(i, static_cast<int16_t>(std::clamp(values[i], -MAX_LEVEL_OFFSET, MAX_LEVEL_OFFSET)));
		doc.SetSurveyMixCheck(hardwareMixing);
		m_pSession->ApplyDocumentProperties();
	}

	//! {external, patches: Uint8Array(19 * 8), names: [19]}: the VRC7's patches, the
	//! module's own when it has an external OPLL, otherwise the default set (which the
	//! module properties put in the module as they open). Patch 0 is each instrument's own.
	val opll() {
		CFamiTrackerDoc &doc = Doc();
		const bool external = doc.GetExternalOPLLChipCheck();
		// CModulePropertiesDlg::OnInitDialog()
		if (!external)
			doc.SetOPLLPatchSet(theApp.GetSettings()->Emulation.iVRC7Patch);
		std::vector<uint8_t> patches(OPLL_PATCHES * 8);
		for (size_t i = 0; i < patches.size(); ++i)
			patches[i] = doc.GetOPLLPatchByte(static_cast<int>(i));
		val names = val::array();
		for (int i = 0; i < OPLL_PATCHES; ++i)
			names.call<void>("push", dnft::text::ToUtf8(doc.GetOPLLPatchName(i)));
		val result = val::object();
		result.set("external", external);
		result.set("patches", CopyToJs(patches.data(), patches.size()));
		result.set("names", names);
		return result;
	}

	//! Module properties > External OPLL: the module's own patches 1-18 (8 register bytes
	//! each, patch 0's are left alone) and their names, or, with external false, the
	//! default set. Resets the sound generator, which stops playback.
	void setOpll(bool external, const val &patches, const val &names) {
		CFamiTrackerDoc &doc = Doc();
		// CModulePropertiesDlg::OnBnClickedOk()
		doc.SetExternalOPLLChipCheck(external);
		if (external) {
			const std::vector<uint8_t> bytes = FromJs(patches);
			for (size_t i = 8; i < bytes.size() && i < OPLL_PATCHES * 8; ++i)
				doc.SetOPLLPatchByte(static_cast<int>(i), bytes[i]);
			const unsigned count = names["length"].as<unsigned>();
			for (unsigned i = 1; i < count && i < static_cast<unsigned>(OPLL_PATCHES); ++i)
				doc.SetOPLLPatchName(i, ToDocument(names[i].as<std::string>(), MAX_PATCH_NAME));
		}
		else
			doc.SetOPLLPatchSet(theApp.GetSettings()->Emulation.iVRC7Patch);
		m_pSession->ApplyDocumentProperties();
	}

	// ---- other files -------------------------------------------------------------------

	//! File > Export Text (Uint8Array)
	val exportText() const {
		return CopyToJs(dnft::ExportText(Doc()));
	}

	//! File > Export JSON (Uint8Array)
	val exportJSON() const {
		return CopyToJs(dnft::ExportJson(Doc()));
	}

	//! File > Export Rows: a CSV table of the cells with something in them (Uint8Array)
	val exportRows() const {
		return CopyToJs(dnft::ExportRows(Doc()));
	}

	//! File > Create NSF: {files: [{name, data}], log, messages}, files empty when it
	//! failed. format: 'nsf', 'nsfe', 'nsf2', 'nes', 'bin', 'prg' or 'asm'; machine: 0 NTSC,
	//! 1 PAL, 2 both; extraData: the sources of an NSF around the music (bin, asm)
	val exportNSF(const std::string &format, int machine, bool extraData) {
		static const std::pair<const char *, dnft::NsfFormat> FORMATS[] = {
			{"nsf", dnft::NsfFormat::NSF}, {"nsfe", dnft::NsfFormat::NSFE}, {"nsf2", dnft::NsfFormat::NSF2},
			{"nes", dnft::NsfFormat::NES}, {"bin", dnft::NsfFormat::BIN}, {"prg", dnft::NsfFormat::PRG},
			{"asm", dnft::NsfFormat::ASM},
		};
		const auto kind = std::find_if(std::begin(FORMATS), std::end(FORMATS), [&](const auto &f) { return format == f.first; });
		if (kind == std::end(FORMATS))
			throw std::invalid_argument("no export format " + format);
		// the period and vibrato tables come from the sound generator playing the module
		if (!m_pSession->IsCurrent())
			throw std::runtime_error("another player or session has the sound generator");
		m_pSession->Stop();
		const dnft::NsfExport exported = dnft::ExportNsf(Doc(), kind->second, machine, extraData);
		val files = val::array();
		for (const auto &file : exported.files) {
			val entry = val::object();
			entry.set("name", file.name);
			entry.set("data", CopyToJs(file.data));
			files.call<void>("push", entry);
		}
		val result = val::object();
		result.set("files", files);
		result.set("log", exported.log);
		result.set("messages", exported.messages);
		return result;
	}

	//! File > Create WAV: see Session::BeginWave(); passes 0 renders for `seconds`
	void beginWave(int track, int passes, int seconds, double muted, uint32_t sampleRate) {
		m_pSession->BeginWave(track, passes, seconds, static_cast<uint64_t>(muted), sampleRate);
	}

	//! About `samples` more of the export: {samples: Int16Array (mono), done, progress}
	val renderWave(uint32_t samples) {
		std::vector<int16_t> out;
		out.reserve(samples + 4096);
		const bool more = m_pSession->RenderWave(out, samples);
		val array = val::global("Int16Array").new_(out.size());
		array.call<void>("set", val(emscripten::typed_memory_view(out.size(), out.data())));
		val result = val::object();
		result.set("samples", array);
		result.set("done", !more);
		result.set("progress", m_pSession->GetWaveProgress());
		return result;
	}

	//! Ends the export, or abandons it: the session's own output comes back
	void endWave() {
		m_pSession->EndWave();
	}

	//! Module properties > Import file, for the module at the heap offset: {tracks: [title],
	//! instruments, grooves, chips, namcoChannels}. finishImport() or cancelImport() next.
	val beginImport(uint32_t data, uint32_t size) {
		const CFamiTrackerDoc &imported = m_pSession->BeginImport(static_cast<const uint8_t *>(HeapPointer(data)), size);
		val tracks = val::array();
		for (unsigned i = 0; i < imported.GetTrackCount(); ++i) {
			const CString title = imported.GetTrackTitle(i);
			tracks.call<void>("push", val(dnft::detail::ToUtf8(title.GetString(), title.GetLength())));
		}
		int grooves = 0;
		for (int i = 0; i < MAX_GROOVE; ++i)
			if (imported.GetGroove(i))
				++grooves;
		val result = val::object();
		result.set("tracks", tracks);
		result.set("instruments", static_cast<int>(imported.GetInstrumentCount()));
		result.set("grooves", grooves);
		result.set("chips", static_cast<int>(imported.GetExpansionChip()));
		result.set("namcoChannels", imported.GetNamcoChannels());
		return result;
	}

	//! Imports the tracks whose flag is set, and what the flags ask for: {imported, messages}.
	//! What was imported before a failure stays.
	val finishImport(const val &tracks, bool instruments, bool grooves, bool detune) {
		const auto flags = emscripten::convertJSArrayToNumberVector<int>(tracks);
		std::string messages;
		const bool imported = m_pSession->FinishImport(std::vector<bool>(flags.begin(), flags.end()), instruments, grooves, detune, messages);
		val result = val::object();
		result.set("imported", imported);
		result.set("messages", messages);
		return result;
	}

	void cancelImport() {
		m_pSession->CancelImport();
	}

	//! What the text import reported about a file it still read (see importText())
	std::string takeWarning() {
		std::string warning;
		warning.swap(m_sWarning);
		return warning;
	}

	void setWarning(std::string warning) {
		m_sWarning = std::move(warning);
	}

	//! What the NSF import made (see importNsf()): {rows (the frames the song plays before
	//! it loops or stops), loopRow (where it jumps back to, -1 for none), stops, trimmed (the
	//! silent frames left out at the start), rate (frames a second), warnings: [codes, see
	//! nsf_import.h]}; null for other sessions
	val nsfReport() const {
		if (!m_pNsfReport)
			return val::null();
		val report = val::object();
		report.set("rows", m_pNsfReport->rows);
		report.set("loopRow", m_pNsfReport->loopRow);
		report.set("stops", m_pNsfReport->stops);
		report.set("trimmed", m_pNsfReport->trimmed);
		report.set("rate", m_pNsfReport->rate);
		val warnings = val::array();
		for (const std::string &w : m_pNsfReport->warnings)
			warnings.call<void>("push", w);
		report.set("warnings", warnings);
		return report;
	}

	void setNsfReport(const dnft::NsfImportResult &report) {
		m_pNsfReport = std::make_unique<dnft::NsfImportResult>(report);
	}

private:
	CFamiTrackerDoc &Doc() const {
		return m_pSession->GetDocument();
	}

	static std::vector<int *> ChipLevels(CSettings *settings) {
		auto &levels = settings->ChipLevels;
		return {&levels.iLevelAPU1, &levels.iLevelAPU2, &levels.iLevelVRC6, &levels.iLevelVRC7,
			&levels.iLevelFDS, &levels.iLevelMMC5, &levels.iLevelN163, &levels.iLevelS5B};
	}

	void CheckTrack(int track) const {
		if (track < 0 || track >= static_cast<int>(Doc().GetTrackCount()))
			throw std::out_of_range("no track " + std::to_string(track));
	}

	void CheckChannel(int channel) const {
		if (channel < 0 || channel >= Doc().GetChannelCount())
			throw std::out_of_range("no channel " + std::to_string(channel));
	}

	static void CheckPattern(int pattern) {
		if (pattern < 0 || pattern >= MAX_PATTERN)
			throw std::out_of_range("no pattern " + std::to_string(pattern));
	}

	void CheckFrame(int track, int frame) const {
		CheckTrack(track);
		if (frame < 0 || frame >= static_cast<int>(Doc().GetFrameCount(track)))
			throw std::out_of_range("no frame " + std::to_string(frame));
	}

	static void CheckSequence(int seqType, int index) {
		if (seqType < 0 || seqType >= SEQ_COUNT)
			throw std::out_of_range("no sequence type " + std::to_string(seqType));
		if (index < 0 || index >= MAX_SEQUENCES)
			throw std::out_of_range("no sequence " + std::to_string(index));
	}

	std::shared_ptr<CInstrument> GetInstrument(int index) const {
		auto pInst = index >= 0 && index < MAX_INSTRUMENTS ? Doc().GetInstrument(index) : nullptr;
		if (!pInst)
			throw std::out_of_range("no instrument " + std::to_string(index));
		return pInst;
	}

	// The instrument if its sequences are the module's numbered ones (not the FDS's own)
	std::shared_ptr<CSeqInstrument> GetSequenceInstrument(int index, int seqType) const {
		CheckSequence(seqType, 0);
		auto pInst = std::dynamic_pointer_cast<CSeqInstrument>(GetInstrument(index));
		if (!pInst || pInst->GetType() == INST_FDS)
			throw std::runtime_error("instrument " + std::to_string(index) + " has no numbered sequences");
		return pInst;
	}

	std::shared_ptr<CInstrumentFDS> GetFds(int index) const {
		auto pInst = std::dynamic_pointer_cast<CInstrumentFDS>(GetInstrument(index));
		if (!pInst)
			throw std::runtime_error("instrument " + std::to_string(index) + " is not an FDS instrument");
		return pInst;
	}

	std::shared_ptr<CInstrumentN163> GetN163(int index) const {
		auto pInst = std::dynamic_pointer_cast<CInstrumentN163>(GetInstrument(index));
		if (!pInst)
			throw std::runtime_error("instrument " + std::to_string(index) + " is not an N163 instrument");
		return pInst;
	}

	const CDSample *GetSample(int index) const {
		const CDSample *pSample = index >= 0 && index < MAX_DSAMPLES ? Doc().GetSample(index) : nullptr;
		if (!pSample)
			throw std::out_of_range("no DPCM sample " + std::to_string(index));
		return pSample;
	}

	// An edited wave or its settings are for the sound generator to read again (the
	// instrument editor of the desktop tells it the same)
	static void WaveChanged() {
		theApp.GetSoundGenerator()->WaveChanged();
	}

	CSequence *GetSequence(int instType, int seqType, int index) const {
		CheckSequence(seqType, index);
		if (instType != INST_2A03 && instType != INST_VRC6 && instType != INST_N163 && instType != INST_S5B)
			throw std::out_of_range("instruments of type " + std::to_string(instType) + " have no sequences");
		CSequence *pSeq = Doc().GetSequence(static_cast<inst_type_t>(instType), index, seqType);
		if (!pSeq)
			throw std::out_of_range("no sequence " + std::to_string(index));
		return pSeq;
	}

	std::vector<uint8_t> ReadPattern(int track, int channel, int pattern) const {
		const CFamiTrackerDoc &doc = Doc();
		const int rows = static_cast<int>(doc.GetPatternLength(track));
		std::vector<uint8_t> cells(rows * CELL_SIZE);
		// An unallocated pattern is empty: do not allocate it by reading
		if (doc.IsPatternEmpty(track, channel, pattern)) {
			const stChanNote blank {};
			for (int r = 0; r < rows; ++r)
				PackCell(blank, cells.data() + r * CELL_SIZE);
		}
		else
			for (int r = 0; r < rows; ++r) {
				stChanNote note;
				doc.GetDataAtPattern(track, pattern, channel, r, &note);
				PackCell(note, cells.data() + r * CELL_SIZE);
			}
		return cells;
	}

	void ResetTempo(int track) {
		// What the desktop does after changing speed or tempo, for the track playing
		if (m_pSession->IsPlaying() && m_pSession->GetState().track == track)
			theApp.GetSoundGenerator()->ResetTempo();
	}

	// The desktop's SetPatternLength() and ClearPatterns() leave bookmarks where the track
	// no longer reaches, and then cannot open the file it saves (ReadBlock_Bookmarks()
	// checks their frames and rows): they go here instead
	void DropStrayBookmarks(int track) {
		CFamiTrackerDoc &doc = Doc();
		CBookmarkCollection *pCol = doc.GetBookmarkManager()->GetCollection(track);
		for (unsigned i = pCol->GetCount(); i-- > 0;) {
			const CBookmark *pMark = pCol->GetBookmark(i);
			if (pMark->m_iFrame >= doc.GetFrameCount(track) || pMark->m_iRow >= doc.GetPatternLength(track))
				pCol->RemoveBookmark(i);
		}
	}

	std::shared_ptr<dnft::Session> m_pSession;
	std::string m_sWarning;
	std::unique_ptr<dnft::NsfImportResult> m_pNsfReport;
};

std::shared_ptr<EditSession> createSession(uint32_t sampleRate) {
	return std::make_shared<EditSession>(dnft::Session::Create(sampleRate));
}

//! @param data heap offset of a .dnm, .0cc or .ftm file
std::shared_ptr<EditSession> openSession(uint32_t data, uint32_t size, uint32_t sampleRate) {
	return std::make_shared<EditSession>(dnft::Session::Open(static_cast<const uint8_t *>(HeapPointer(data)), size, sampleRate));
}

//! File > Import Text: a session on the module in the tracker's text format at the heap
//! offset. Throws with the importer's message (the line it stopped at); the session's
//! takeWarning() gives what it reported about a file it still read.
std::shared_ptr<EditSession> importText(uint32_t data, uint32_t size, uint32_t sampleRate) {
	std::string warning;
	auto session = std::make_shared<EditSession>(dnft::Session::ImportText(static_cast<const uint8_t *>(HeapPointer(data)), size, sampleRate, warning));
	session->setWarning(std::move(warning));
	return session;
}

//! Import NSF: a session on the module made from an NSF's frame log at the heap offset (the
//! NSF analyzer's, dnft-nsf.mjs). options: {patternLength (rows), loop (end the song where
//! it repeats itself, with a jump back), trimSilence (leave out the silence before the first
//! sound)}. Throws when the log holds nothing to import; the session's nsfReport() tells
//! what was made.
std::shared_ptr<EditSession> importNsf(uint32_t data, uint32_t size, uint32_t sampleRate, val options) {
	dnft::NsfImportOptions o;
	if (options["patternLength"].isNumber())
		o.patternLength = std::clamp(options["patternLength"].as<int>(), 1, MAX_PATTERN_LENGTH);
	if (!options["loop"].isUndefined())
		o.loop = options["loop"].as<bool>();
	if (!options["trimSilence"].isUndefined())
		o.trimSilence = options["trimSilence"].as<bool>();
	dnft::NsfImportResult report;
	auto session = std::make_shared<EditSession>(dnft::Session::ImportNsf(static_cast<const uint8_t *>(HeapPointer(data)), size, sampleRate, o, report));
	session->setNsfReport(report);
	return session;
}

//! {letters: the letter of each effect number, defaults: the parameter an effect gets
//! when it is typed, byChip: {chip: {letter: effect}}}: what typing a letter in an
//! effect column enters, by the chip of the channel
val effectTable() {
	val letters = val::array();
	val defaults = val::array();
	for (int i = 0; i < EF_COUNT; ++i) {
		letters.call<void>("push", EFF_CHAR[i] == '\xff' ? std::string() : std::string(1, EFF_CHAR[i]));
		defaults.call<void>("push", effects[i].uiDefault);
	}
	val byChip = val::object();
	static const int CHIPS[] = {SNDCHIP_NONE, SNDCHIP_VRC6, SNDCHIP_VRC7, SNDCHIP_FDS, SNDCHIP_MMC5, SNDCHIP_N163, SNDCHIP_S5B};
	for (int chip : CHIPS) {
		val table = val::object();
		for (int ch = 0x20; ch < 0x7F; ++ch) {
			bool valid = false;
			const effect_t effect = GetEffectFromChar(static_cast<char>(ch), chip, &valid);
			if (valid && effect != EF_NONE)
				table.set(std::string(1, static_cast<char>(ch)), static_cast<int>(effect));
		}
		byChip.set(std::to_string(chip), table);
	}
	val result = val::object();
	result.set("letters", letters);
	result.set("defaults", defaults);
	result.set("byChip", byChip);
	return result;
}

//! How sessions read the bytes of a module's text (Uint8Array): text_encoding.h
std::string decodeText(const val &bytes) {
	const std::vector<uint8_t> data = FromJs(bytes);
	return dnft::text::ToUtf8(std::string_view(reinterpret_cast<const char *>(data.data()), data.size()));
}

//! How sessions write text into a module, in at most maxBytes (Uint8Array)
val encodeText(const std::string &text, uint32_t maxBytes) {
	const std::string bytes = dnft::text::FromUtf8(text, maxBytes);
	return CopyToJs(reinterpret_cast<const uint8_t *>(bytes.data()), bytes.size());
}

} // namespace

EMSCRIPTEN_BINDINGS(dnft_session) {
	emscripten::class_<EditSession>("Session")
		.smart_ptr<std::shared_ptr<EditSession>>("Session")
		.function("render", &EditSession::render)
		.function("position", &EditSession::position)
		.function("takeRowEvents", &EditSession::takeRowEvents)
		.function("play", &EditSession::play)
		.function("stop", &EditSession::stop)
		.function("state", &EditSession::state)
		.function("noteOn", &EditSession::noteOn)
		.function("noteOff", &EditSession::noteOff)
		.function("setMutedChannels", &EditSession::setMutedChannels)
		.function("playRow", &EditSession::playRow)
		.function("setQueueFrame", &EditSession::setQueueFrame)
		.function("queueFrame", &EditSession::queueFrame)
		.function("recallChannelState", &EditSession::recallChannelState)
		.function("setAutoArpeggio", &EditSession::setAutoArpeggio)
		.function("autoArpeggio", &EditSession::autoArpeggio)
		.function("arpNote", &EditSession::arpNote)
		.function("killSound", &EditSession::killSound)
		.function("setMeterDecayRate", &EditSession::setMeterDecayRate)
		.function("meterDecayRate", &EditSession::meterDecayRate)
		.function("setAverageBpm", &EditSession::setAverageBpm)
		.function("takeLevelEvents", &EditSession::takeLevelEvents)
		.function("registers", &EditSession::registers)
		.function("channelFrequencies", &EditSession::channelFrequencies)
		.function("fdsModCounter", &EditSession::fdsModCounter)
		.function("recorder", &EditSession::recorder)
		.function("setRecordChannel", &EditSession::setRecordChannel)
		.function("setRecorderSettings", &EditSession::setRecorderSettings)
		.function("takeRecordedInstruments", &EditSession::takeRecordedInstruments)
		.function("soundSettings", &EditSession::soundSettings)
		.function("setSoundSettings", &EditSession::setSoundSettings)
		.function("save", &EditSession::save)
		.function("saveSnapshot", &EditSession::saveSnapshot)
		.function("isModified", &EditSession::isModified)
		.function("info", &EditSession::info)
		.function("setTitle", &EditSession::setTitle)
		.function("setArtist", &EditSession::setArtist)
		.function("setCopyright", &EditSession::setCopyright)
		.function("setComment", &EditSession::setComment)
		.function("track", &EditSession::track)
		.function("bookmarks", &EditSession::bookmarks)
		.function("setBookmarks", &EditSession::setBookmarks)
		.function("swapChannels", &EditSession::swapChannels)
		.function("addTrack", &EditSession::addTrack)
		.function("removeTrack", &EditSession::removeTrack)
		.function("setTrackTitle", &EditSession::setTrackTitle)
		.function("setPatternLength", &EditSession::setPatternLength)
		.function("setFrameCount", &EditSession::setFrameCount)
		.function("setSpeed", &EditSession::setSpeed)
		.function("setTempo", &EditSession::setTempo)
		.function("setHighlight", &EditSession::setHighlight)
		.function("setEffColumns", &EditSession::setEffColumns)
		.function("pattern", &EditSession::pattern)
		.function("patterns", &EditSession::patterns)
		.function("setCells", &EditSession::setCells)
		.function("setFramePattern", &EditSession::setFramePattern)
		.function("setFrameList", &EditSession::setFrameList)
		.function("insertFrame", &EditSession::insertFrame)
		.function("removeFrame", &EditSession::removeFrame)
		.function("duplicateFrame", &EditSession::duplicateFrame)
		.function("cloneFrame", &EditSession::cloneFrame)
		.function("moveFrame", &EditSession::moveFrame)
		.function("insertFrames", &EditSession::insertFrames)
		.function("deleteFrames", &EditSession::deleteFrames)
		.function("setFramePatterns", &EditSession::setFramePatterns)
		.function("clonePatterns", &EditSession::clonePatterns)
		.function("freePattern", &EditSession::freePattern)
		.function("clearPatterns", &EditSession::clearPatterns)
		.function("populateUniquePatterns", &EditSession::populateUniquePatterns)
		.function("transposeSong", &EditSession::transposeSong)
		.function("setNotes", &EditSession::setNotes)
		.function("removeUnusedInstruments", &EditSession::removeUnusedInstruments)
		.function("removeUnusedPatterns", &EditSession::removeUnusedPatterns)
		.function("removeUnusedSamples", &EditSession::removeUnusedSamples)
		.function("moveTrack", &EditSession::moveTrack)
		.function("songLength", &EditSession::songLength)
		.function("instruments", &EditSession::instruments)
		.function("instrument", &EditSession::instrument)
		.function("addInstrument", &EditSession::addInstrument)
		.function("removeInstrument", &EditSession::removeInstrument)
		.function("cloneInstrument", &EditSession::cloneInstrument)
		.function("deepCloneInstrument", &EditSession::deepCloneInstrument)
		.function("setInstrumentName", &EditSession::setInstrumentName)
		.function("setInstrumentSequence", &EditSession::setInstrumentSequence)
		.function("sequence", &EditSession::sequence)
		.function("setSequence", &EditSession::setSequence)
		.function("freeSequence", &EditSession::freeSequence)
		.function("nextFreeSequence", &EditSession::nextFreeSequence)
		.function("cloneSequence", &EditSession::cloneSequence)
		.function("setFdsSequence", &EditSession::setFdsSequence)
		.function("saveInstrument", &EditSession::saveInstrument)
		.function("loadInstrument", &EditSession::loadInstrument)
		.function("setDpcmKey", &EditSession::setDpcmKey)
		.function("samples", &EditSession::samples)
		.function("sample", &EditSession::sample)
		.function("setSample", &EditSession::setSample)
		.function("removeSample", &EditSession::removeSample)
		.function("previewSample", &EditSession::previewSample)
		.function("stopPreview", &EditSession::stopPreview)
		.function("setFdsWave", &EditSession::setFdsWave)
		.function("setFdsModulation", &EditSession::setFdsModulation)
		.function("setFdsParams", &EditSession::setFdsParams)
		.function("setN163", &EditSession::setN163)
		.function("setN163Wave", &EditSession::setN163Wave)
		.function("setVrc7", &EditSession::setVrc7)
		.function("vrc7Patches", &EditSession::vrc7Patches)
		.function("setExpansion", &EditSession::setExpansion)
		.function("setMachine", &EditSession::setMachine)
		.function("setEngineSpeed", &EditSession::setEngineSpeed)
		.function("setSpeedSplitPoint", &EditSession::setSpeedSplitPoint)
		.function("setVibratoStyle", &EditSession::setVibratoStyle)
		.function("setLinearPitch", &EditSession::setLinearPitch)
		.function("detune", &EditSession::detune)
		.function("setDetune", &EditSession::setDetune)
		.function("grooves", &EditSession::grooves)
		.function("setGrooves", &EditSession::setGrooves)
		.function("setGrooveMode", &EditSession::setGrooveMode)
		.function("mixing", &EditSession::mixing)
		.function("setMixing", &EditSession::setMixing)
		.function("opll", &EditSession::opll)
		.function("setOpll", &EditSession::setOpll)
		.function("exportText", &EditSession::exportText)
		.function("exportJSON", &EditSession::exportJSON)
		.function("exportRows", &EditSession::exportRows)
		.function("exportNSF", &EditSession::exportNSF)
		.function("beginWave", &EditSession::beginWave)
		.function("renderWave", &EditSession::renderWave)
		.function("endWave", &EditSession::endWave)
		.function("beginImport", &EditSession::beginImport)
		.function("finishImport", &EditSession::finishImport)
		.function("cancelImport", &EditSession::cancelImport)
		.function("takeWarning", &EditSession::takeWarning)
		.function("nsfReport", &EditSession::nsfReport);

	emscripten::function("createSession", &createSession);
	emscripten::function("openSession", &openSession);
	emscripten::function("importText", &importText);
	emscripten::function("importNsf", &importNsf);
	emscripten::function("effects", &effectTable);
	emscripten::function("decodeText", &decodeText);
	emscripten::function("encodeText", &encodeText);

	emscripten::constant("PLAY_SONG", static_cast<int>(dnft::Session::PLAY_SONG));
	emscripten::constant("PLAY_FRAME", static_cast<int>(dnft::Session::PLAY_FRAME));
	emscripten::constant("PLAY_CURSOR", static_cast<int>(dnft::Session::PLAY_CURSOR));
	emscripten::constant("PLAY_PATTERN", static_cast<int>(dnft::Session::PLAY_PATTERN));
}

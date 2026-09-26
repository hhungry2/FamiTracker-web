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
#include "Sequence.h"
#include "InstrumentManager.h"
#include "engine_internal.h"
#include "session.h"

#include <emscripten/bind.h>

#include <algorithm>
#include <stdexcept>
#include <string>

using emscripten::val;

namespace {

const int CELL_SIZE = 12;

const void *HeapPointer(uint32_t offset) {
	return reinterpret_cast<const void *>(static_cast<uintptr_t>(offset));
}

val CopyToJs(const uint8_t *data, size_t size) {
	val array = val::global("Uint8Array").new_(size);
	array.call<void>("set", val(emscripten::typed_memory_view(size, data)));
	return array;
}

std::vector<uint8_t> FromJs(const val &array) {
	return emscripten::convertJSArrayToNumberVector<uint8_t>(array);
}

// The document keeps texts in fixed buffers of bytes: cut UTF-8 where a character ends.
std::string Truncate(std::string text, size_t maxBytes) {
	if (text.size() <= maxBytes)
		return text;
	size_t end = maxBytes;
	while (end > 0 && (static_cast<unsigned char>(text[end]) & 0xC0) == 0x80)
		--end;
	text.resize(end);
	return text;
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

	// ---- file --------------------------------------------------------------------------

	//! The module as a .dnm file (Uint8Array)
	val save() {
		const std::vector<uint8_t> bytes = m_pSession->Save();
		return CopyToJs(bytes.data(), bytes.size());
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
		result.set("comment", dnft::detail::ToUtf8(comment.GetString(), comment.GetLength()));
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
		Doc().SetSongName(Truncate(text, 31).c_str());
	}

	void setArtist(const std::string &text) {
		Doc().SetSongArtist(Truncate(text, 31).c_str());
	}

	void setCopyright(const std::string &text) {
		Doc().SetSongCopyright(Truncate(text, 31).c_str());
	}

	void setComment(const std::string &text) {
		CString comment(text.c_str());
		Doc().SetComment(comment, Doc().ShowCommentOnOpen());
	}

	// ---- tracks ------------------------------------------------------------------------

	//! {title, frames, rows, speed, tempo, groove, highlight: [first, second],
	//!  effColumns: [per channel, 1-4], frameList: Uint8Array(frames * channels)}
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
		return result;
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
		Doc().SetTrackTitle(track, CString(title.c_str()));
	}

	void setPatternLength(int track, int rows) {
		CheckTrack(track);
		Doc().SetPatternLength(track, std::clamp(rows, 1, MAX_PATTERN_LENGTH));
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
		// CMainFrame::SetTempo()
		doc.SetSongTempo(track, std::clamp(tempo, doc.GetSpeedSplitPoint(), MAX_TEMPO));
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

	//! The lowest pattern number the channel does not use (-1: none left)
	int freePattern(int track, int channel) const {
		CheckTrack(track);
		CheckChannel(channel);
		return static_cast<int>(Doc().GetFirstFreePattern(track, channel));
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

	//! {index, type, name, sequences: [{enabled, index}] for the 5 kinds when it has them}
	val instrument(int index) const {
		const auto pInst = GetInstrument(index);
		val result = val::object();
		result.set("index", index);
		result.set("type", static_cast<int>(pInst->GetType()));
		result.set("name", dnft::detail::ToUtf8(pInst->GetName(), CInstrument::INST_NAME_MAX));
		if (auto pSeqInst = std::dynamic_pointer_cast<CSeqInstrument>(pInst)) {
			val sequences = val::array();
			for (int i = 0; i < SEQ_COUNT; ++i) {
				val entry = val::object();
				entry.set("enabled", pSeqInst->GetSeqEnable(i) != 0);
				entry.set("index", pSeqInst->GetSeqIndex(i));
				sequences.call<void>("push", entry);
			}
			result.set("sequences", sequences);
		}
		return result;
	}

	//! A new instrument for the chip (SNDCHIP_*); its index, or -1 when all slots are taken
	int addInstrument(int chip, const std::string &name) {
		return Doc().AddInstrument(Truncate(name, CInstrument::INST_NAME_MAX - 1).c_str(), chip);
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
		Doc().SetInstrumentName(index, Truncate(name, CInstrument::INST_NAME_MAX - 1).c_str());
	}

	void setInstrumentSequence(int index, int seqType, bool enabled, int seqIndex) {
		auto pInst = std::dynamic_pointer_cast<CSeqInstrument>(GetInstrument(index));
		if (!pInst)
			throw std::runtime_error("instrument " + std::to_string(index) + " has no sequences");
		CheckSequence(seqType, seqIndex);
		pInst->SetSeqEnable(seqType, enabled ? 1 : 0);
		pInst->SetSeqIndex(seqType, seqIndex);
		Doc().SetModifiedFlag();
	}

	//! {items: Int8Array, loop, release, setting}; loop and release are -1 when unset
	val sequence(int instType, int seqType, int index) const {
		const CSequence *pSeq = GetSequence(instType, seqType, index);
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

	void setSequence(int instType, int seqType, int index, const val &items, int loop, int release, int setting) {
		CSequence *pSeq = GetSequence(instType, seqType, index);
		const std::vector<int8_t> values = emscripten::convertJSArrayToNumberVector<int8_t>(items);
		const int count = std::min<int>(static_cast<int>(values.size()), MAX_SEQUENCE_ITEMS);
		pSeq->SetItemCount(count);
		for (int i = 0; i < count; ++i)
			pSeq->SetItem(i, values[i]);
		pSeq->SetLoopPoint(loop >= 0 && loop < count ? loop : -1);
		pSeq->SetReleasePoint(release >= 0 && release < count ? release : -1);
		pSeq->SetSetting(static_cast<seq_setting_t>(std::clamp(setting, 0, static_cast<int>(SEQ_SETTING_COUNT[seqType]) - 1)));
		Doc().SetModifiedFlag();
	}

	//! The lowest sequence index no instrument uses, or -1
	int freeSequence(int instType, int seqType) const {
		CheckSequence(seqType, 0);
		return Doc().GetFreeSequence(static_cast<inst_type_t>(instType), seqType);
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

	void setVibratoStyle(bool newStyle) {
		Doc().SetVibratoStyle(newStyle ? VIBRATO_NEW : VIBRATO_OLD);
		m_pSession->ApplyDocumentProperties();
	}

	void setLinearPitch(bool enable) {
		Doc().SetLinearPitch(enable);
		m_pSession->ApplyDocumentProperties();
	}

private:
	CFamiTrackerDoc &Doc() const {
		return m_pSession->GetDocument();
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

	std::shared_ptr<dnft::Session> m_pSession;
};

std::shared_ptr<EditSession> createSession(uint32_t sampleRate) {
	return std::make_shared<EditSession>(dnft::Session::Create(sampleRate));
}

//! @param data heap offset of a .dnm, .0cc or .ftm file
std::shared_ptr<EditSession> openSession(uint32_t data, uint32_t size, uint32_t sampleRate) {
	return std::make_shared<EditSession>(dnft::Session::Open(static_cast<const uint8_t *>(HeapPointer(data)), size, sampleRate));
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
		.function("save", &EditSession::save)
		.function("isModified", &EditSession::isModified)
		.function("info", &EditSession::info)
		.function("setTitle", &EditSession::setTitle)
		.function("setArtist", &EditSession::setArtist)
		.function("setCopyright", &EditSession::setCopyright)
		.function("setComment", &EditSession::setComment)
		.function("track", &EditSession::track)
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
		.function("freePattern", &EditSession::freePattern)
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
		.function("setExpansion", &EditSession::setExpansion)
		.function("setMachine", &EditSession::setMachine)
		.function("setEngineSpeed", &EditSession::setEngineSpeed)
		.function("setVibratoStyle", &EditSession::setVibratoStyle)
		.function("setLinearPitch", &EditSession::setLinearPitch);

	emscripten::function("createSession", &createSession);
	emscripten::function("openSession", &openSession);
	emscripten::function("effects", &effectTable);

	emscripten::constant("PLAY_SONG", static_cast<int>(dnft::Session::PLAY_SONG));
	emscripten::constant("PLAY_FRAME", static_cast<int>(dnft::Session::PLAY_FRAME));
	emscripten::constant("PLAY_CURSOR", static_cast<int>(dnft::Session::PLAY_CURSOR));
	emscripten::constant("PLAY_PATTERN", static_cast<int>(dnft::Session::PLAY_PATTERN));
}

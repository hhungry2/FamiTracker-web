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
		Doc().SetTrackTitle(track, CString(ToDocument(title, MAX_FILE_STRING).c_str()));
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

	// ---- the Song menu and Module > Cleanup --------------------------------------------

	//! Song > Clear Patterns: every pattern of the track empty, and one frame
	void clearPatterns(int track) {
		CheckTrack(track);
		Doc().ClearPatterns(track);
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

	//! Module > Cleanup: the instruments no pattern plays (and the sequences no instrument
	//! uses), the patterns no frame plays, the DPCM samples and assignments no note plays
	void removeUnusedInstruments() {
		Doc().RemoveUnusedInstruments();
	}

	void removeUnusedPatterns() {
		Doc().RemoveUnusedPatterns();
	}

	void removeUnusedSamples() {
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
	std::string m_sWarning;
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
		.function("clearPatterns", &EditSession::clearPatterns)
		.function("populateUniquePatterns", &EditSession::populateUniquePatterns)
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
		.function("setExpansion", &EditSession::setExpansion)
		.function("setMachine", &EditSession::setMachine)
		.function("setEngineSpeed", &EditSession::setEngineSpeed)
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
		.function("takeWarning", &EditSession::takeWarning);

	emscripten::function("createSession", &createSession);
	emscripten::function("openSession", &openSession);
	emscripten::function("importText", &importText);
	emscripten::function("effects", &effectTable);
	emscripten::function("decodeText", &decodeText);
	emscripten::function("encodeText", &encodeText);

	emscripten::constant("PLAY_SONG", static_cast<int>(dnft::Session::PLAY_SONG));
	emscripten::constant("PLAY_FRAME", static_cast<int>(dnft::Session::PLAY_FRAME));
	emscripten::constant("PLAY_CURSOR", static_cast<int>(dnft::Session::PLAY_CURSOR));
	emscripten::constant("PLAY_PATTERN", static_cast<int>(dnft::Session::PLAY_PATTERN));
}

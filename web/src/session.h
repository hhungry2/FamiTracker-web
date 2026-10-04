/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// A module open for editing, with the sound generator playing it. Unlike a Player, a
// session renders without end, as the desktop tracker's audio runs while it is open:
// the output carries the song while it plays, and the notes played by hand (NoteOn)
// at any time. The document is the tracker's own, edited through GetDocument(); edits
// are heard the next time the player reads the row, as on the desktop.
//
// Like players, one session drives the sound generator at a time: the last one made
// (or player created) plays, the others render silence.

#pragma once

#include "engine.h"
#include "nsf_import.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

class CFamiTrackerDoc;

namespace dnft {

// A row the player read, at the output frame its audio begins at. A frame of -1 marks
// where playback stopped by itself (the end of a Cxx row).
struct RowEvent {
	uint64_t at;
	int frame;
	int row;
};

// The volume meters of the channels (0-15, the desktop's bars in the channel headers),
// after a tick that changed one, at the output frame its audio begins at
struct LevelEvent {
	uint64_t at;
	std::vector<uint8_t> levels;
};

class Session {
public:
	// The desktop tracker's new module: 2A03 only, one instrument, one frame of 64 rows.
	static std::shared_ptr<Session> Create(uint32_t sampleRate);
	// Parses a .dnm, .0cc or .ftm file. Throws LoadError.
	static std::shared_ptr<Session> Open(const uint8_t *data, size_t size, uint32_t sampleRate);
	// File > Import Text: a module in the tracker's text format. Throws LoadError with the
	// importer's message; `warning` gets what it reported about a file it did read (a
	// JSON block it could not parse).
	static std::shared_ptr<Session> ImportText(const uint8_t *data, size_t size, uint32_t sampleRate, std::string &warning);
	// Import NSF: the module made from an NSF's frame log (the NSF analyzer's, see
	// nsf_import.h). Throws LoadError when the log holds nothing to make one of.
	static std::shared_ptr<Session> ImportNsf(const uint8_t *log, size_t size, uint32_t sampleRate,
		const NsfImportOptions &options, NsfImportResult &result);
	~Session();
	Session(const Session &) = delete;
	Session &operator=(const Session &) = delete;

	CFamiTrackerDoc &GetDocument() const { return *m_pDocument; }
	// For opened files: "DNM" or "FTM", and the tracker that wrote it. Empty otherwise.
	const std::string &GetType() const { return m_sType; }
	const std::string &GetProgram() const { return m_sProgram; }

	// The module the way the desktop tracker saves it (a .dnm file). Clears the modified
	// flag. Throws std::runtime_error with the tracker's message when that fails.
	std::vector<uint8_t> Save();
	bool IsModified() const;

	// Interleaved stereo 16-bit output. It never ends.
	void Render(int16_t *out, uint32_t frames);
	// Output frames handed out so far
	uint64_t GetPosition() const { return m_iRendered; }
	// The rows read since the last call, in order.
	std::vector<RowEvent> TakeRowEvents();
	// The meter levels reported since the last call, in order.
	std::vector<LevelEvent> TakeLevelEvents();

	enum PlayMode {
		PLAY_SONG,		// from the top of the song
		PLAY_FRAME,		// from the top of the frame
		PLAY_CURSOR,	// from the row of the frame
		PLAY_PATTERN,	// the frame's patterns over and over
	};
	void Play(int track, PlayMode mode, int frame, int row);
	void Stop();
	bool IsPlaying() const;
	PlayerState GetState() const;

	// A note played by hand on a channel, as the desktop tracker plays the keys of its
	// note preview. Instrument 0-63 (or none), volume 0-15 or 16 for none.
	void NoteOn(int channel, int note, int octave, int instrument, int volume);
	// Releases the channel's note (release) or cuts it.
	void NoteOff(int channel, bool release);
	// Tracker > Play Row (CFamiTrackerView::OnTrackerPlayrow()): the notes of the row, with
	// their effects, on every channel that is not muted.
	void PlayRow(int track, int frame, int row);
	// Tracker > Kill Sound: stops the player and silences the APU and the channels.
	void KillSound();
	// A note played by hand (the keyboard, the piano, MIDI) begins or ends: for the auto
	// arpeggio (Configuration > MIDI), the note (octave * 12 + semitone) and its channel
	void ArpNote(int note, bool held, int channel);
	// Recall channel state: the state of a channel at the row (while the player plays, as it
	// is now), as the desktop's status line words it; empty for no such channel.
	std::string RecallChannelState(int track, int channel, int frame, int row);
	// Ctrl+click on a frame while playing (CFrameEditor::OnLButtonUp()): the frame the player
	// goes to when the one it plays ends, or -1 for none. It is taken with the jump
	// (CSoundGen::PlayerStepFrame()) and is dropped when the player starts or stops.
	void SetQueueFrame(int frame);
	int GetQueueFrame() const;
	// View > Meter Decay Rate (decay_rate_t: 0 slow, 1 fast)
	void SetMeterDecayRate(int rate);
	int GetMeterDecayRate() const { return m_iDecayRate; }
	// Instruments the instrument recorder made, as slots, since the last call.
	std::vector<int> TakeRecordedInstruments();
	// Bit n mutes channel n. Muting cuts what the channel plays.
	void SetMutedChannels(uint64_t mask);

	// The DPCM sample editor's preview (CSoundGen::PreviewSample()): plays the bytes as a
	// sample at pitch 0-15 from the 64 byte step `offset`, with the delta counter starting
	// at 64 or at 0 ("delta start"). Nothing plays when another player or session has the
	// sound generator.
	void PreviewSample(const std::vector<uint8_t> &data, int offset, int pitch, bool deltaStart);
	// Stops the preview, and lets go of the samples of the document, which the DPCM plays
	// from: to call before one of them is removed or replaced.
	void ReleaseSamples();

	// To call after changing what the sound generator sets up from the document: expansion
	// chips, machine, engine speed, vibrato style, linear pitch. Stops playback.
	void ApplyDocumentProperties();

	// Whether the session drives the sound generator (the exports that read its tables
	// need that)
	bool IsCurrent() const;

	// File > Create WAV: renders the track as the desktop's wave export does, mono at
	// `sampleRate`, with the channels of `muted` silent: `passes` times through the song,
	// or for `seconds` when `passes` is 0. Stops playback; the session's own output is
	// silent until EndWave().
	void BeginWave(int track, int passes, int seconds, uint64_t muted, uint32_t sampleRate);
	// Appends the audio of whole ticks to `out` until it holds `samples` or the export
	// is over. False once it is over.
	bool RenderWave(std::vector<int16_t> &out, size_t samples);
	// 0 to 1, as the desktop's progress dialog counts
	double GetWaveProgress() const;
	// Back to the session's own output, after the export or to abandon it
	void EndWave();
	bool IsRenderingWave() const { return m_bWave; }

	// Module properties > Import file: a module to take tracks, instruments, grooves
	// and detune tables from (CModuleImportDlg). Throws LoadError.
	const CFamiTrackerDoc &BeginImport(const uint8_t *data, size_t size);
	// Imports the tracks marked in `tracks` as new tracks, and what the flags ask for.
	// Both modules get the expansion chips of either, as on the desktop. Stops playback.
	// Returns false when something could not be imported (`messages` tells why); what
	// was imported before stays.
	bool FinishImport(const std::vector<bool> &tracks, bool instruments, bool grooves, bool detune, std::string &messages);
	void CancelImport();

private:
	Session(std::unique_ptr<CFamiTrackerDoc> document, uint32_t sampleRate);
	void Pump();
	void CollectLevels(uint64_t at);
	void DumpRecordedInstrument();

	std::unique_ptr<CFamiTrackerDoc> m_pDocument;
	std::string m_sType;
	std::string m_sProgram;
	uint32_t m_iSampleRate;
	unsigned m_iSerial;
	int m_iTrack = 0;
	uint64_t m_iMutedChannels = 0;
	uint64_t m_iRendered = 0;		// frames handed out
	std::vector<int16_t> m_Pending;	// mono samples rendered but not handed out yet
	size_t m_iPendingPos = 0;
	std::vector<RowEvent> m_RowEvents;
	std::vector<LevelEvent> m_LevelEvents;
	std::vector<uint8_t> m_LastLevels;
	std::vector<int> m_Recorded;
	int m_iDecayRate = 0;
	bool m_bWave = false;			// a wave export has the sound generator
	std::unique_ptr<CFamiTrackerDoc> m_pImport;	// the module of BeginImport()
};

} // namespace dnft

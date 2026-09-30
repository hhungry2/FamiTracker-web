/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// Runs CSoundGen without its audio thread. On the desktop, that thread takes messages
// from the user interface and loops over OnIdle(), which plays one engine tick and hands
// the audio to the sound card. Here the host makes those calls itself, in the same order,
// and takes the audio the way the desktop build's wave export does.

#pragma once

#include <cstdint>
#include <functional>

class CSoundGen;
class CFamiTrackerDoc;
class CFamiTrackerView;
class CDSample;

class CSoundGenHost {
public:
	// Receives the mono 16-bit samples of every rendered tick.
	using Sink = std::function<void(const int16_t *samples, uint32_t count)>;

	explicit CSoundGenHost(CSoundGen &gen);

	// Hands the document to the sound generator and sets up emulation and mixing for it,
	// as the desktop build does when a file is opened. Replaces any previous document.
	void Attach(CFamiTrackerDoc &doc, CFamiTrackerView &view);
	// Stops playback and forgets the document.
	void Detach();

	// Starts Track from the top. With `loop` false playback halts after one pass, where
	// the desktop build's wave export would stop for "play the song 1 time".
	void Start(int Track, bool loop);
	void Stop();

	// Audio without end, as the desktop tracker's is while it is open: nothing plays until
	// StartPlayer(), and halting the player (HaltPlayer() or the Cxx effect) leaves the
	// output running for the notes played by hand. Ended by Stop().
	void BeginStream();
	// The desktop's play commands (MODE_PLAY_*); the cursor is the view's selection.
	void StartPlayer(int Mode, int Track);
	void HaltPlayer();

	// The desktop's wave export (File > Create WAV): five silent ticks, Track from the
	// top for EndParam passes (or EndParam seconds when ByTime), five more ticks. Ticks
	// render it until IsRendering() turns false.
	bool BeginExport(int Track, bool ByTime, int EndParam);
	bool IsRendering() const;
	// To call before each tick of an export: ends one whose song has halted
	void EndExportIfHalted();
	// How far the export is, 0 to 1, as the desktop's progress dialog counts it
	double GetRenderProgress() const;

	// One tick of the engine: reads rows, updates channels, clocks the APU. The audio
	// produced goes to the sink.
	void Tick();

	// For playing up to a position without listening (CSoundChip::SetSkipping()): the
	// ticks go faster, and their audio is not to be used. The setting belongs to the
	// APU, which every Start() renews: set it after that.
	void SetSkipping(bool skip);

	// The instrument editor's sample preview (CSoundGen::PreviewSample(), which the desktop
	// answers on its audio thread): the DPCM plays `sample` at pitch 0-15 from the 64 byte
	// step `offset` in the next tick. A sample without a name is the sound generator's,
	// which deletes it once it has played. False (the sample is still the caller's) when
	// there is no APU to play it.
	bool PreviewSample(const CDSample *sample, int offset, int pitch);
	// Silences what the DPCM plays from, before the sample it points into is deleted or
	// replaced (CSoundGen::CancelPreviewSample())
	void CancelPreview();
	// A write to an APU register (CSoundGen::WriteAPU())
	void WriteAPU(int address, uint8_t value);

	// Rendering and playing (Start()); IsPlayerRunning() is about the player alone
	bool IsPlaying() const;
	bool IsPlayerRunning() const;
	// Whether the last tick read a row: the one GetFrame() and GetRow() gave before it
	bool RowWasRead() const;
	// The row the player reads next
	int GetFrame() const;
	int GetRow() const;
	int GetTrack() const;
	unsigned int GetTicks() const;
	int GetSpeed() const;
	int GetTempo() const;

	static void SetSink(Sink sink);
	static const Sink &GetSink();

private:
	// EndWhen and EndParam as CSoundGen keeps them (render_end_t, ticks or rows); the
	// player starts DelayTicks ticks after rendering does, and rendering stops as long
	// after the end
	bool BeginRendering(int Track, int EndWhen, unsigned int EndParam, int DelayTicks);
	void Configure();
	void RenewAPU();

	CSoundGen &m_Gen;
	bool m_bInitialized = false;
};

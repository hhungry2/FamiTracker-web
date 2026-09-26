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

	// One tick of the engine: reads rows, updates channels, clocks the APU. The audio
	// produced goes to the sink.
	void Tick();

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
	bool BeginRendering(int Track, bool loop);
	void Configure();
	void RenewAPU();

	CSoundGen &m_Gen;
	bool m_bInitialized = false;
};

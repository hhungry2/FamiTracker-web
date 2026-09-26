/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// Loading and playing modules with the tracker's own engine, for hosts that pull
// samples (a web page, a test). One player renders at a time: the engine drives the
// single sound generator the tracker core is built around.

#pragma once

#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

class CFamiTrackerDoc;

namespace dnft {

// What load errors throw: the text the desktop build would show in a message box.
class LoadError : public std::runtime_error {
public:
	using std::runtime_error::runtime_error;
};

struct ChannelInfo {
	std::string name;		// "Pulse 1"
	std::string shortName;	// "PU1"
	unsigned int chip;		// SNDCHIP_* (0 for the 2A03)
};

class Module {
public:
	// Parses a .dnm, .0cc or .ftm file.
	static std::shared_ptr<Module> Load(const uint8_t *data, size_t size);
	~Module();

	CFamiTrackerDoc &GetDocument() const { return *m_pDocument; }

	// "DNM" or "FTM" (0CC-FamiTracker writes the FamiTracker header)
	std::string GetType() const { return m_sType; }
	// The tracker that wrote the file, as far as the file tells
	std::string GetProgram() const { return m_sProgram; }
	std::string GetTitle() const;
	std::string GetAuthor() const;
	std::string GetCopyright() const;
	std::string GetComment() const;

	int GetTrackCount() const;
	std::string GetTrackTitle(int track) const;
	// Length of one pass through the track, up to where it loops or halts.
	uint32_t GetDurationMs(int track) const;
	// Length of the looped part (0 when the track halts).
	uint32_t GetLoopDurationMs(int track) const;

	// SNDCHIP_* bits
	unsigned int GetExpansionChips() const;
	std::string GetExpansionChipNames() const;
	int GetChannelCount() const;
	// The channels in the order of the patterns (and of the channel mute mask)
	std::vector<ChannelInfo> GetChannels() const;
	int GetNamcoChannels() const;
	bool IsPAL() const;
	unsigned int GetFrameRate() const;

private:
	Module() = default;

	std::unique_ptr<CFamiTrackerDoc> m_pDocument;
	std::string m_sType;
	std::string m_sProgram;
};

struct PlayerState {
	int track;
	int frame;
	int row;
	int pattern;	// pattern number of the first channel in the current frame
	int speed;
	int tempo;
	int channels;
	uint32_t timeMs;
};

class Player {
public:
	// Interleaved stereo 16-bit output at `sampleRate`.
	Player(std::shared_ptr<Module> module, int track, uint32_t sampleRate);
	~Player();
	Player(const Player &) = delete;
	Player &operator=(const Player &) = delete;

	// Fills frames * 2 samples. Returns false once the track is over; the rest of the
	// buffer is silence then.
	bool Render(int16_t *out, uint32_t frames);
	// Restarts and plays silently up to the position.
	void Seek(uint32_t ms);
	uint32_t GetPositionMs() const;
	PlayerState GetState() const;

	// Keep playing after the loop point (the default stops after one pass).
	void SetLoop(bool loop);
	// Bit n mutes channel n of the module.
	void SetMutedChannels(uint64_t mask);

private:
	bool IsCurrent() const;
	void Restart();
	bool Pump();

	std::shared_ptr<Module> m_pModule;
	int m_iTrack;
	uint32_t m_iSampleRate;
	bool m_bLoop = false;
	bool m_bEnded = false;
	uint64_t m_iMutedChannels = 0;
	uint64_t m_iRendered = 0;	// frames handed out since the start of the track
	std::vector<int16_t> m_Pending;	// mono samples rendered but not handed out yet
	size_t m_iPendingPos = 0;
	unsigned m_iSerial;
};

} // namespace dnft

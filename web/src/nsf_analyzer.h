/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// The first half of the NSF import: plays an NSF with NSFPlay (third_party/nsfplay) and
// writes down, frame by frame, what each channel of its chips does (nsf_log.h). Built
// into its own module, dnft-nsf.wasm, which the editor loads when it imports an NSF:
// the tracker's engine has its own, changed copies of some of NSFPlay's chips.

#pragma once

#include "nsf_log.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace dnft {

struct NsfTrack {
	std::string title;	// NSFe or NSF2 track label, or empty
	int time = -1;		// milliseconds, -1 when the file does not say
	int fade = -1;
};

struct NsfInfo {
	std::string error;	// empty when the file is an NSF NSFPlay reads
	std::string title, artist, copyright, ripper;
	int version = 0;
	int songs = 0;
	int start = 0;		// the first song, from 0
	int chips = 0;		// the expansion bits (nsflog::CHIP_*)
	int regions = 0;	// bit 0 NTSC, bit 1 PAL, bit 2 Dendy
	int preferred = 0;	// the region the file prefers: 0 NTSC, 1 PAL, 2 Dendy
	bool nsfe = false;
	int periodNtsc = 0;	// microseconds per frame
	int periodPal = 0;
	std::vector<NsfTrack> tracks;
};

NsfInfo ReadNsfInfo(const uint8_t *data, size_t size);

// The song (from 0) as NSFPlay plays it: `seconds` of mono samples at `rate`, the channels
// of `mask` muted (NSFPlay's MASK setting). Empty when the file is not read. For the tests:
// what an import is compared with.
std::vector<int16_t> RenderNsf(const uint8_t *data, size_t size, int song, double seconds, int rate, int mask);

class NsfAnalysis {
public:
	NsfAnalysis();
	~NsfAnalysis();
	NsfAnalysis(const NsfAnalysis &) = delete;
	NsfAnalysis &operator=(const NsfAnalysis &) = delete;

	// Reads the file. False when it is not an NSF NSFPlay reads (GetError() says why).
	bool Load(const uint8_t *data, size_t size);
	const std::string &GetError() const { return m_sError; }

	// Starts the song (from 0) and runs its init routine. region: -1 the one the file
	// prefers, 0 NTSC, 1 PAL. At most maxFrames frames are written down.
	bool Start(int song, int region, int maxFrames);
	// Plays up to `frames` more frames. Returns the number written down so far.
	int Run(int frames);
	// The song stopped (its play routine never returned) or maxFrames are down
	bool IsDone() const;
	int GetFrameCount() const;
	// The frame log so far (nsf_log.h)
	std::vector<uint8_t> GetLog() const;

	struct Impl;

private:
	std::unique_ptr<Impl> m_pImpl;
	std::string m_sError;
};

} // namespace dnft

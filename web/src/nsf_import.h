/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// The second half of the NSF import: turns the frame log of an NSF (nsf_log.h, written by
// the NSF analyzer) into a module. Every frame of the NSF becomes a row (speed 1), on
// which each channel gets what the NSF's driver did to it that frame:
//
// - a note where the channel starts sounding or the driver restarts the note (a key on,
//   a sample start, a phase reset), with the note nearest to the pitch and a Pxx that
//   makes the period or frequency the NSF's exactly; a note that slides away from its
//   pitch becomes a new note with the && instrument, which does not restart it;
// - ---, or === for the VRC7's sustained release and a stopped sample, where it stops;
// - the volume in the volume column, the duty in Vxx, and the chips' own effects: the
//   DPCM's Zxx, the FDS's modulation (Hxx, Ixx, Jxx), the 5B's noise and envelope (Wxx,
//   Hxx, Ixx, Jxx), =00 where the driver restarts a pulse's phase and the tracker would
//   not.
//
// The instruments have no sequences, as the frames carry what the sequences would: one
// for each chip, and for the FDS one for each wave (with its modulation table), for the
// N163 one for each place in its RAM (its waves, chosen with Vxx), for the VRC7 one for
// each patch. The DPCM's samples sit on the keys of DPCM instruments.
//
// Where the NSF starts to repeat itself, the song jumps back (Bxx); a song that falls
// silent stops there (C00). Patterns with the same rows are shared.

#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

class CFamiTrackerDoc;

namespace dnft {

struct NsfImportOptions {
	int patternLength = 128;	// rows (frames) per pattern; more when the song needs it
	bool loop = true;			// end the song where it starts repeating itself, with a jump back
	bool trimSilence = true;	// leave out the silent frames before the first sound
};

struct NsfImportResult {
	int rows = 0;			// rows the song plays before it loops or stops
	int loopRow = -1;		// the row it jumps back to, or -1
	bool stops = false;		// it falls silent and stops (C00)
	int trimmed = 0;		// silent frames left out at the start
	double rate = 60;		// frames (rows) a second
	// What could not be made as the NSF has it: "instruments" (more than a module holds:
	// some sounds use another's instrument), "samples" (more DPCM samples than a module
	// holds), "sampleSpace" (the samples take more room than a module has), "n163Wave"
	// (N163 waves longer than an instrument's are cut short), "noRepeat" (the song does not
	// repeat within the frames played: it stops where they end), "tooLong" (longer than a
	// module holds: cut short)
	std::vector<std::string> warnings;
};

// Fills a new module (as detail::NewDocument() makes it) from the frame log. Throws
// std::runtime_error when the log cannot be read or holds no sound.
NsfImportResult ImportNsf(CFamiTrackerDoc &doc, const uint8_t *log, size_t size, const NsfImportOptions &options);

} // namespace dnft

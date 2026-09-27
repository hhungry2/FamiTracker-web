/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// The desktop tracker's exports besides the wave file: File > Export Text, Export JSON,
// Export Rows, and the kinds of File > Create NSF (NSF, NSFe, NSF2, NES, BIN, PRG, ASM).
// They run the tracker's own exporters on a copy of the module, which some of them
// change (the NSF compiler and the JSON export fill in every pattern they read), so the
// module being edited stays as it is. The copy is what saving the module writes, and
// saving clears the modified flag.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

class CFamiTrackerDoc;

namespace dnft {

struct ExportedFile {
	std::string name;
	std::vector<uint8_t> data;
};

// File > Export Text, Export JSON, Export Rows (a CSV table of the cells with something
// in them). Throw std::runtime_error with the exporter's message.
std::vector<uint8_t> ExportText(CFamiTrackerDoc &doc);
std::vector<uint8_t> ExportJson(CFamiTrackerDoc &doc);
std::vector<uint8_t> ExportRows(const CFamiTrackerDoc &doc);

// The kinds of the NSF export dialog (CExportDialog)
enum class NsfFormat { NSF, NSFE, NSF2, NES, BIN, PRG, ASM };

struct NsfExport {
	// The file, or files: BIN writes music.bin and samples.bin, and with the extra data
	// BIN and ASM write the sources of an NSF built around the music (nsf_stub.s...).
	// Empty when the export failed.
	std::vector<ExportedFile> files;
	std::string log;		// what the dialog's output box shows
	std::string messages;	// what the desktop shows in message boxes
};

// `machine`: 0 NTSC, 1 PAL, 2 both, as the dialog's buttons (NES and PRG only know
// NTSC and PAL). `extraData`: the dialog's "extra data" box, for BIN and ASM. The period
// and vibrato tables come from the sound generator, which has to have the module
// attached (a current session).
NsfExport ExportNsf(CFamiTrackerDoc &doc, NsfFormat format, int machine, bool extraData);

} // namespace dnft

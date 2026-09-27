/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

#include "stdafx.h"
#include "FamiTracker.h"
#include "FamiTrackerDoc.h"
#include "PatternNote.h"
#include "TextExporter.h"
#include "JsonExporter.h"
#include "Compiler.h"
#include "dnft_compat.h"
#include "engine_internal.h"
#include "export.h"

#include <algorithm>
#include <cstdio>
#include <memory>
#include <set>
#include <stdexcept>

namespace dnft {

namespace {

// The module as the desktop saves it, read back. Saving clears the modified flag, as
// Session::Save() does.
std::unique_ptr<CFamiTrackerDoc> CopyDocument(CFamiTrackerDoc &doc) {
	const std::string path = detail::NewPath("copy.dnm");
	std::string error;
	bool saved;
	{
		detail::MessageCollector messages;
		saved = doc.OnSaveDocument(path.c_str()) != FALSE;
		error = messages.GetText();
	}
	std::vector<uint8_t> bytes = dnft_compat::TakeFile(path);
	if (!saved || bytes.empty())
		throw std::runtime_error(error.empty() ? "could not copy the module" : error);
	return detail::LoadDocument(bytes.data(), bytes.size()).document;
}

// Runs an exporter that writes a text file and returns an error message (empty when it
// succeeds) on a copy of the module
template <typename Exporter>
std::vector<uint8_t> ExportTextFile(CFamiTrackerDoc &doc, const char *name, Exporter exporter) {
	std::unique_ptr<CFamiTrackerDoc> copy = CopyDocument(doc);
	const std::string path = detail::NewPath(name);
	std::string error;
	{
		detail::MessageCollector messages;
		try {
			error = exporter(path.c_str(), copy.get());
		}
		catch (const std::exception &e) {
			// the JSON library refuses texts that are not UTF-8
			error = e.what();
		}
		if (error.empty() && !messages.GetText().empty())
			error = messages.GetText();
	}
	std::vector<uint8_t> bytes = dnft_compat::TakeFile(path);
	if (!error.empty())
		throw std::runtime_error(error);
	return bytes;
}

// The compiler's log, for its output box on the desktop
class StringLog : public CCompilerLog {
public:
	explicit StringLog(std::string &text) : m_Text(text) {}
	void WriteLog(std::string_view text) override { m_Text += text; }
	void Clear() override { m_Text.clear(); }

private:
	std::string &m_Text;
};

} // namespace

std::vector<uint8_t> ExportText(CFamiTrackerDoc &doc) {
	return ExportTextFile(doc, "export.txt", [](const char *path, CFamiTrackerDoc *pDoc) {
		CTextExport exporter;
		return std::string(exporter.ExportFile(path, pDoc).GetString());
	});
}

std::vector<uint8_t> ExportJson(CFamiTrackerDoc &doc) {
	return ExportTextFile(doc, "export.json", [](const char *path, CFamiTrackerDoc *pDoc) {
		CJsonExport exporter;
		return std::string(exporter.ExportFile(path, pDoc).GetString());
	});
}

std::vector<uint8_t> ExportRows(const CFamiTrackerDoc &doc) {
	// CTextExport::ExportRows(): a line for each cell with something in it. It reads
	// every pattern of every channel, which fills in the ones not used yet, some hundred
	// kilobytes each; the empty ones have no lines, so they are skipped here instead.
	// Lines end as in the desktop's file (written in text mode).
	std::string out = "ID,TRACK,CHANNEL,PATTERN,ROW,NOTE,OCTAVE,INST,VOLUME,FX1,FX1PARAM,FX2,FX2PARAM,FX3,FX3PARAM,FX4,FX4PARAM\r\n";
	char line[200];
	int id = 0;
	for (unsigned int t = 0; t < doc.GetTrackCount(); t++)
		for (int c = 0; c < doc.GetChannelCount(); c++)
			for (int p = 0; p < MAX_PATTERN; p++) {
				if (doc.IsPatternEmpty(t, c, p))
					continue;
				for (unsigned int r = 0; r < doc.GetPatternLength(t); r++) {
					stChanNote stCell;
					doc.GetDataAtPattern(t, p, c, r, &stCell);
					bool isEmpty = true;
					if (stCell.Note != NONE || stCell.Instrument != MAX_INSTRUMENTS || stCell.Vol != MAX_VOLUME) isEmpty = false;
					for (int fx = 0; fx < MAX_EFFECT_COLUMNS; fx++)
						if (stCell.EffNumber[fx] != EF_NONE) isEmpty = false;
					if (isEmpty) continue;
					std::snprintf(line, sizeof(line), "%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\r\n",
						id++, t, c, p, r, stCell.Note, stCell.Octave, stCell.Instrument, stCell.Vol,
						stCell.EffNumber[0], stCell.EffParam[0],
						stCell.EffNumber[1], stCell.EffParam[1],
						stCell.EffNumber[2], stCell.EffParam[2],
						stCell.EffNumber[3], stCell.EffParam[3]);
					out += line;
				}
			}
	return std::vector<uint8_t>(out.begin(), out.end());
}

NsfExport ExportNsf(CFamiTrackerDoc &doc, NsfFormat format, int machine, bool extraData) {
	// Where the files go. BIN puts the extra files in what it takes for the directory of
	// music.bin, which it gets by cutting the path at the length of the file's name:
	// that is the directory when both are as long. ASM cuts it right.
	static const std::string DIRECTORY = "memory/x/";
	static const std::string MUSIC = "music";
	static_assert(sizeof("memory/x/") == sizeof("music.bin"), "");

	static const char *const EXTENSIONS[] = {".nsf", ".nsfe", ".nsf", ".nes", ".bin", ".prg", ".asm"};
	const std::string primary = DIRECTORY + MUSIC + EXTENSIONS[static_cast<int>(format)];
	const std::string samples = DIRECTORY + "samples.bin";
	machine = std::clamp(machine, 0, 2);

	std::unique_ptr<CFamiTrackerDoc> copy = CopyDocument(doc);
	const std::vector<std::string> before = dnft_compat::ListFiles();
	NsfExport result;
	{
		detail::MessageCollector messages;
		{
			// CExportDialog::CreateNSF() and the others
			CCompiler compiler(copy.get(), new StringLog(result.log));
			switch (format) {
			case NsfFormat::NSF: compiler.ExportNSF(primary.c_str(), machine); break;
			case NsfFormat::NSFE: compiler.ExportNSFE(primary.c_str(), machine); break;
			case NsfFormat::NSF2: compiler.ExportNSF2(primary.c_str(), machine); break;
			case NsfFormat::NES: compiler.ExportNES(primary.c_str(), machine == 1); break;
			case NsfFormat::BIN: compiler.ExportBIN(primary.c_str(), samples.c_str(), machine, extraData); break;
			case NsfFormat::PRG: compiler.ExportPRG(primary.c_str(), machine == 1); break;
			case NsfFormat::ASM: compiler.ExportASM(primary.c_str(), machine, extraData); break;
			}
		}
		result.messages = messages.GetText();
	}

	// Everything the compiler wrote, the file asked for first
	const std::set<std::string> existed(before.begin(), before.end());
	std::vector<std::string> written;
	for (const std::string &path : dnft_compat::ListFiles())
		if (!existed.count(path))
			written.push_back(path);
	std::stable_partition(written.begin(), written.end(), [&](const std::string &path) { return path == primary; });
	for (const std::string &path : written) {
		const size_t slash = path.find_last_of('/');
		result.files.push_back({slash == std::string::npos ? path : path.substr(slash + 1), dnft_compat::TakeFile(path)});
	}
	// A failed export may leave the file opened for it empty
	if (result.files.empty() || written.front() != primary || result.files.front().data.empty())
		result.files.clear();
	return result;
}

} // namespace dnft

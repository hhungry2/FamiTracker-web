/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// What players (engine.cpp) and editing sessions (session.cpp) share: the core's single
// sound generator and the host that drives it, and the loading of modules.

#pragma once

#include "portable/SoundGenUI.h"
#include "soundgen_host.h"
#include "dnft_compat.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

class CFamiTrackerDoc;

namespace dnft::detail {

struct Engine {
	CFamiTrackerView view;
	std::unique_ptr<CSoundGenHost> host;
	// the player or session allowed to drive the sound generator; older ones fall silent
	unsigned current = 0;
	// where the sink puts rendered samples
	std::vector<int16_t> *target = nullptr;
};

Engine &GetEngine();

// Collects what the core would show in message boxes while it is alive. Collectors
// nest: the innermost one alive gets the messages.
class MessageCollector {
public:
	MessageCollector();
	~MessageCollector();
	MessageCollector(const MessageCollector &) = delete;
	MessageCollector &operator=(const MessageCollector &) = delete;
	const std::string &GetText() const { return m_sText; }

private:
	std::string m_sText;
	dnft_compat::MessageHandler m_Previous;
};

// Module texts are in whatever code page the author's Windows used. Valid UTF-8 is
// kept; anything else is read as Windows-1252, the most common case.
std::string ToUtf8(const char *text, size_t maxLength);

// A module file parsed by the tracker's loader, with what the file tells about the
// tracker that wrote it. Throws LoadError.
struct LoadedDocument {
	std::unique_ptr<CFamiTrackerDoc> document;
	std::string type;		// "DNM" or "FTM"
	std::string program;	// "Dn-FamiTracker", "0CC-FamiTracker" or "FamiTracker"
};
LoadedDocument LoadDocument(const uint8_t *data, size_t size);

// The desktop tracker's new module: 2A03 only, one instrument, one frame of 64 rows.
// Not attached to the sound generator.
std::unique_ptr<CFamiTrackerDoc> NewDocument();

// A path for a file in memory (see dnft_compat.h) that no other file has, ending in
// `name`
std::string NewPath(const std::string &name);

} // namespace dnft::detail

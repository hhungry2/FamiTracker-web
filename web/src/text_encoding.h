/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// The texts of modules: the title, the comment, the names of tracks and instruments...
// The desktop tracker keeps them as bytes of the ANSI code page of the Windows it runs
// on, which for the modules around is Windows-1252 (Western systems) or code page 932
// (Shift_JIS, Japanese ones); other programs write UTF-8.

#pragma once

#include <cstddef>
#include <string>
#include <string_view>

namespace dnft::text {

// A module's text as UTF-8: valid UTF-8 as it is, otherwise the reading of Windows-1252
// or of code page 932 that looks more like text in its language (a character cut off by
// the end of the text is left out).
std::string ToUtf8(std::string_view bytes);

// UTF-8 text as a module keeps it, in at most maxBytes, cut where a character ends: in
// the code page the desktop tracker would have it in (Windows-1252, else 932) when the
// text fits one and ToUtf8() reads it back as the same text, so the desktop shows it;
// in UTF-8 otherwise.
std::string FromUtf8(std::string_view text, size_t maxBytes);

} // namespace dnft::text

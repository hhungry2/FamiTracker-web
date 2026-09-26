/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// The host's side of the compatibility layer (compat/): where files come from and
// where the messages the core would show in a message box go.

#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace dnft_compat {

// CFile opens these paths from memory. Opening any other path fails.
void PutFile(const std::string &path, std::vector<uint8_t> content);
// Removes the file and returns what it held (empty when there was no such file).
std::vector<uint8_t> TakeFile(const std::string &path);
bool HasFile(const std::string &path);

// Messages the desktop build shows in message boxes. `type` carries the MB_ICON* bits.
// The handler's return value answers yes/no questions (IDYES, IDNO...).
using MessageHandler = std::function<int(const std::string &text, unsigned int type)>;
void SetMessageHandler(MessageHandler handler);

} // namespace dnft_compat

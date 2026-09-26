/*
** Dn-FamiTracker web port - Win32 compatibility layer
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// Generic-text mappings for the multibyte character set, which is what the desktop
// build uses (TCHAR is char).

#pragma once

#include <cstdlib>
#include <cstring>
#include <cstdio>

#ifndef _T
#define _T(x) x
#endif
#ifndef TEXT
#define TEXT(x) x
#endif
#ifndef __T
#define __T(x) x
#endif

#define _tcslen      std::strlen
#define _tcscpy      std::strcpy
#define _tcsncpy     std::strncpy
#define _tcscat      std::strcat
#define _tcscmp      std::strcmp
#define _tcsncmp     std::strncmp
#define _tcsicmp     _stricmp
#define _tcsnicmp    _strnicmp
#define _tcschr      std::strchr
#define _tcsrchr     std::strrchr
#define _tcsstr      std::strstr
#define _tcsdup      _strdup
#define _tcstol      std::strtol
#define _tcstoul     std::strtoul
#define _tcstod      std::strtod
#define _tstoi       std::atoi
#define _ttoi        std::atoi
#define _ttol        std::atol
#define _tstof       std::atof
#define _stprintf    std::sprintf
#define _stprintf_s  sprintf_s
#define _sntprintf_s _snprintf_s
#define _vstprintf_s vsprintf_s
#define _tprintf     std::printf
#define _ftprintf    std::fprintf
#define _tfopen      std::fopen
#define _tcscpy_s    strcpy_s
#define _tcsncpy_s   strncpy_s
#define _tcscat_s    strcat_s
#define _itot_s      _itoa_s
#define _istdigit    isdigit
#define _istspace    isspace
#define _istalpha    isalpha
#define _totupper    toupper
#define _totlower    tolower

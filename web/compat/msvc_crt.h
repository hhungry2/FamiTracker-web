/*
** Dn-FamiTracker web port - Win32 compatibility layer
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// The "secure" CRT functions and other MSVC runtime extensions. MSVC declares them in
// the standard headers, so some core sources use them without including anything
// Windows-specific; the build force-includes this file for that reason.

#pragma once

#include <cstddef>
#include <cstdio>
#include <cstring>
#include <cstdarg>
#include <strings.h>

#define _TRUNCATE ((size_t)-1)

inline int memcpy_s(void *dest, size_t destSize, const void *src, size_t count) {
	if (count > destSize)
		return 34;
	std::memcpy(dest, src, count);
	return 0;
}
inline int memmove_s(void *dest, size_t destSize, const void *src, size_t count) {
	if (count > destSize)
		return 34;
	std::memmove(dest, src, count);
	return 0;
}
// Only equivalent for conversions without %s/%c/%[ (which take an extra size argument
// in the _s variant). The core uses it for numbers only.
#define sscanf_s std::sscanf

inline int _stricmp(const char *a, const char *b) { return strcasecmp(a, b); }
inline int _strnicmp(const char *a, const char *b, size_t n) { return strncasecmp(a, b, n); }
inline int stricmp(const char *a, const char *b) { return strcasecmp(a, b); }
inline char *_strdup(const char *s) { return strdup(s); }

inline int vsprintf_s(char *buf, size_t size, const char *fmt, va_list args) {
	return std::vsnprintf(buf, size, fmt, args);
}
template <size_t N>
inline int vsprintf_s(char (&buf)[N], const char *fmt, va_list args) {
	return std::vsnprintf(buf, N, fmt, args);
}
inline int sprintf_s(char *buf, size_t size, const char *fmt, ...) {
	va_list args;
	va_start(args, fmt);
	int n = std::vsnprintf(buf, size, fmt, args);
	va_end(args);
	return n;
}
template <size_t N, typename... T>
inline int sprintf_s(char (&buf)[N], const char *fmt, T... args) {
	return std::snprintf(buf, N, fmt, args...);
}
inline int _vsnprintf_s(char *buf, size_t size, size_t count, const char *fmt, va_list args) {
	size_t limit = (count == _TRUNCATE || count + 1 > size) ? size : count + 1;
	return std::vsnprintf(buf, limit, fmt, args);
}
inline int _snprintf_s(char *buf, size_t size, size_t count, const char *fmt, ...) {
	va_list args;
	va_start(args, fmt);
	int n = _vsnprintf_s(buf, size, count, fmt, args);
	va_end(args);
	return n;
}
template <size_t N, typename... T>
inline int _snprintf_s(char (&buf)[N], size_t count, const char *fmt, T... args) {
	return _snprintf_s(buf, N, count, fmt, args...);
}
inline int strcpy_s(char *dst, size_t size, const char *src) {
	if (!size) return 34;
	std::strncpy(dst, src, size - 1);
	dst[size - 1] = 0;
	return 0;
}
template <size_t N>
inline int strcpy_s(char (&dst)[N], const char *src) { return strcpy_s(dst, N, src); }
inline int strncpy_s(char *dst, size_t size, const char *src, size_t count) {
	if (!size) return 34;
	size_t n = (count == _TRUNCATE) ? size - 1 : (count < size - 1 ? count : size - 1);
	size_t i = 0;
	for (; i < n && src[i]; ++i)
		dst[i] = src[i];
	dst[i] = 0;
	return 0;
}
template <size_t N>
inline int strncpy_s(char (&dst)[N], const char *src, size_t count) { return strncpy_s(dst, N, src, count); }
inline int strcat_s(char *dst, size_t size, const char *src) {
	size_t len = std::strlen(dst);
	return strcpy_s(dst + len, size > len ? size - len : 0, src);
}
template <size_t N>
inline int strcat_s(char (&dst)[N], const char *src) { return strcat_s(dst, N, src); }
inline int _itoa_s(int value, char *buf, size_t size, int radix) {
	if (radix == 16) std::snprintf(buf, size, "%x", value);
	else std::snprintf(buf, size, "%d", value);
	return 0;
}
inline char *_itoa(int value, char *buf, int radix) {
	if (radix == 16) std::sprintf(buf, "%x", value);
	else std::sprintf(buf, "%d", value);
	return buf;
}
inline int lstrlen(const char *s) { return s ? (int)std::strlen(s) : 0; }
#define lstrlenA lstrlen
inline char *lstrcpy(char *d, const char *s) { return std::strcpy(d, s); }
inline int lstrcmp(const char *a, const char *b) { return std::strcmp(a, b); }
inline int lstrcmpi(const char *a, const char *b) { return strcasecmp(a, b); }

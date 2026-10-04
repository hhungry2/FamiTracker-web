/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

#include "text_encoding.h"

#include <algorithm>
#include <cstdint>
#include <iterator>
#include <utility>
#include <vector>

namespace dnft::text {

namespace {

// CP932_DOUBLE: code page 932's double-byte characters
#include "cp932_table.inc"

// Windows-1252's characters for the bytes 0x80-0x9F, 0 for the five it has none for
const char16_t CP1252_80[32] = {
	0x20AC, 0x0000, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x0000, 0x017D, 0x0000,
	0x0000, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x0000, 0x017E, 0x0178,
};

const char32_t REPLACEMENT = 0xFFFD;

// ---- UTF-8 ------------------------------------------------------------------------------

bool IsUtf8(std::string_view s) {
	for (size_t i = 0; i < s.size();) {
		const unsigned char c = static_cast<unsigned char>(s[i]);
		// continuation bytes that follow the lead byte
		const size_t n = c < 0x80 ? 0 : (c & 0xE0) == 0xC0 ? 1 : (c & 0xF0) == 0xE0 ? 2 : (c & 0xF8) == 0xF0 ? 3 : 4;
		if (n == 4 || s.size() - i <= n)
			return false;
		for (size_t k = 1; k <= n; ++k)
			if ((static_cast<unsigned char>(s[i + k]) & 0xC0) != 0x80)
				return false;
		i += n + 1;
	}
	return true;
}

// The characters of valid UTF-8
std::u32string DecodeUtf8(std::string_view s) {
	std::u32string chars;
	for (size_t i = 0; i < s.size();) {
		const unsigned char c = static_cast<unsigned char>(s[i]);
		const size_t n = c < 0x80 ? 0 : c < 0xE0 ? 1 : c < 0xF0 ? 2 : 3;
		char32_t code = n == 0 ? c : c & (0x3F >> n);
		for (size_t k = 1; k <= n; ++k)
			code = code << 6 | (static_cast<unsigned char>(s[i + k]) & 0x3F);
		chars += code;
		i += n + 1;
	}
	return chars;
}

std::string EncodeUtf8(std::u32string_view chars) {
	std::string out;
	out.reserve(chars.size());
	for (const char32_t c : chars) {
		if (c < 0x80)
			out += static_cast<char>(c);
		else if (c < 0x800) {
			out += static_cast<char>(0xC0 | c >> 6);
			out += static_cast<char>(0x80 | (c & 0x3F));
		}
		else if (c < 0x10000) {
			out += static_cast<char>(0xE0 | c >> 12);
			out += static_cast<char>(0x80 | (c >> 6 & 0x3F));
			out += static_cast<char>(0x80 | (c & 0x3F));
		}
		else {
			out += static_cast<char>(0xF0 | c >> 18);
			out += static_cast<char>(0x80 | (c >> 12 & 0x3F));
			out += static_cast<char>(0x80 | (c >> 6 & 0x3F));
			out += static_cast<char>(0x80 | (c & 0x3F));
		}
	}
	return out;
}

std::string TruncateUtf8(std::string_view text, size_t maxBytes) {
	if (text.size() <= maxBytes)
		return std::string(text);
	size_t end = maxBytes;
	while (end > 0 && (static_cast<unsigned char>(text[end]) & 0xC0) == 0x80)
		--end;
	return std::string(text.substr(0, end));
}

// ---- the code pages ---------------------------------------------------------------------

// Windows-1252's reading of the bytes. Returns how many bytes it has no character for
// (read as U+FFFD).
int DecodeCp1252(std::string_view bytes, std::u32string &chars) {
	chars.clear();
	int errors = 0;
	for (const char byte : bytes) {
		const unsigned char b = static_cast<unsigned char>(byte);
		char32_t c = b >= 0x80 && b < 0xA0 ? CP1252_80[b - 0x80] : b;
		if (!c && b) {
			c = REPLACEMENT;
			++errors;
		}
		chars += c;
	}
	return errors;
}

// Rows of CP932_DOUBLE, or -1
int Cp932Lead(unsigned char b) {
	return b >= 0x81 && b <= 0x9F ? b - 0x81 : b >= 0xE0 && b <= 0xFC ? b - 0xE0 + 31 : -1;
}

int Cp932Trail(unsigned char b) {
	return b >= 0x40 && b <= 0x7E ? b - 0x40 : b >= 0x80 && b <= 0xFC ? b - 0x80 + 63 : -1;
}

// Code page 932's reading of the bytes. Returns how many characters it could not read
// (read as U+FFFD; an ASCII byte after a lead byte is read again, as the Encoding
// Standard's decoder does). A lead byte at the very end is left out: the text was cut
// there, in the middle of a character.
int DecodeCp932(std::string_view bytes, std::u32string &chars) {
	chars.clear();
	int errors = 0;
	for (size_t i = 0; i < bytes.size(); ++i) {
		const unsigned char b = static_cast<unsigned char>(bytes[i]);
		if (b < 0x80) {
			chars += b;
			continue;
		}
		// half-width katakana
		if (b >= 0xA1 && b <= 0xDF) {
			chars += static_cast<char32_t>(0xFF61 + (b - 0xA1));
			continue;
		}
		const int lead = Cp932Lead(b);
		if (lead >= 0 && i + 1 == bytes.size())
			break;
		const unsigned char next = lead >= 0 ? static_cast<unsigned char>(bytes[i + 1]) : 0;
		const int trail = lead >= 0 ? Cp932Trail(next) : -1;
		if (const char32_t c = trail >= 0 ? CP932_DOUBLE[lead][trail] : 0) {
			chars += c;
			++i;
			continue;
		}
		chars += REPLACEMENT;
		++errors;
		if (next >= 0x80)
			++i;
	}
	return errors;
}

// The bytes of a character in Windows-1252 (1, or 0 when it has none)
int EncodeCp1252(char32_t c, char *out) {
	if (c < 0x80 || (c >= 0xA0 && c <= 0xFF)) {
		out[0] = static_cast<char>(c);
		return 1;
	}
	const auto found = std::find(std::begin(CP1252_80), std::end(CP1252_80), c);
	if (found == std::end(CP1252_80))
		return 0;
	out[0] = static_cast<char>(0x80 + (found - std::begin(CP1252_80)));
	return 1;
}

// Code page 932's code of each double-byte character, by character
const std::vector<std::pair<char32_t, uint16_t>> &Cp932Codes() {
	static const std::vector<std::pair<char32_t, uint16_t>> codes = [] {
		std::vector<std::pair<char32_t, uint16_t>> list;
		const int leads = static_cast<int>(std::size(CP932_DOUBLE));
		const int trails = static_cast<int>(std::size(CP932_DOUBLE[0]));
		for (int lead = 0; lead < leads; ++lead) {
			const int first = lead < 31 ? 0x81 + lead : 0xE0 + lead - 31;
			// NEC's copies of IBM's characters: Windows writes IBM's (0xFA-0xFC)
			if (first == 0xED || first == 0xEE)
				continue;
			for (int trail = 0; trail < trails; ++trail)
				if (const char32_t c = CP932_DOUBLE[lead][trail])
					list.emplace_back(c, static_cast<uint16_t>(first << 8 | (trail < 63 ? 0x40 + trail : 0x80 + trail - 63)));
		}
		// a character with several codes gets the first, as Windows and the Encoding
		// Standard's encoder write it
		std::stable_sort(list.begin(), list.end(), [](const auto &a, const auto &b) { return a.first < b.first; });
		list.erase(std::unique(list.begin(), list.end(), [](const auto &a, const auto &b) { return a.first == b.first; }), list.end());
		return list;
	}();
	return codes;
}

// The bytes of a character in code page 932 (1 or 2, or 0 when it has none)
int EncodeCp932(char32_t c, char *out) {
	if (c < 0x80) {
		out[0] = static_cast<char>(c);
		return 1;
	}
	if (c >= 0xFF61 && c <= 0xFF9F) {
		out[0] = static_cast<char>(0xA1 + (c - 0xFF61));
		return 1;
	}
	const auto &codes = Cp932Codes();
	const auto found = std::lower_bound(codes.begin(), codes.end(), c, [](const auto &entry, char32_t code) { return entry.first < code; });
	if (found == codes.end() || found->first != c)
		return 0;
	out[0] = static_cast<char>(found->second >> 8);
	out[1] = static_cast<char>(found->second & 0xFF);
	return 2;
}

// ---- which reading ----------------------------------------------------------------------
// Bytes of Windows-1252 often read as code page 932 too: an accented letter and the one
// after it, or an apostrophe and a letter, make a kanji; signs and capitals with accents
// are half-width katakana. And kanji of code page 932 read as punctuation and letters of
// Windows-1252. Each reading gets points for what text in its language looks like.

bool IsAsciiLetter(char32_t c) {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

bool IsLatinLetter(char32_t c) {
	return (c >= 0xC0 && c <= 0xFF && c != 0xD7 && c != 0xF7) ||
		c == 0x0152 || c == 0x0153 || c == 0x0160 || c == 0x0161 || c == 0x0178 || c == 0x017D || c == 0x017E;
}

bool IsLetter(char32_t c) {
	return IsAsciiLetter(c) || IsLatinLetter(c);
}

bool IsLetterOrDigit(char32_t c) {
	return IsLetter(c) || (c >= '0' && c <= '9');
}

// Hiragana and katakana, with their marks (ー ・ ゛...)
bool IsKana(char32_t c) {
	return (c >= 0x3041 && c <= 0x309E) || (c >= 0x30A1 && c <= 0x30FE);
}

// Half-width katakana and their punctuation, the single bytes 0xA1-0xDF
bool IsHalfWidthKana(char32_t c) {
	return c >= 0xFF61 && c <= 0xFF9F;
}

// How much code page 932's reading looks like Japanese, by the runs of characters
// beyond ASCII
int JapaneseScore(const std::u32string &text) {
	int score = 0;
	for (size_t i = 0; i < text.size();) {
		if (text[i] < 0x80) {
			++i;
			continue;
		}
		size_t end = i;
		int kana = 0, halfWidth = 0;
		for (; end < text.size() && text[end] >= 0x80; ++end) {
			kana += IsKana(text[end]);
			halfWidth += IsHalfWidthKana(text[end]);
		}
		const int length = static_cast<int>(end - i);
		const int others = length - kana - halfWidth;	// kanji and signs
		const bool letterBefore = i > 0 && IsAsciiLetter(text[i - 1]);
		const bool letterAfter = end < text.size() && IsAsciiLetter(text[end]);
		score += 2 * kana;
		// half-width katakana make words; one alone is rather a sign or a capital letter
		// with an accent
		if (halfWidth > 1)
			score += halfWidth;
		else if (halfWidth == 1 && length == 1)
			score -= 2;
		// kanji make words, or stand alone
		if (length > 1 || (!letterBefore && !letterAfter))
			score += others;
		// inside a word of ASCII letters, it is rather an accent or an apostrophe
		if (letterBefore && letterAfter && !kana)
			score -= 2;
		i = end;
	}
	return score;
}

// How much Windows-1252's reading looks like a Western language
int WesternScore(const std::u32string &text) {
	int score = 0;
	for (size_t i = 0; i < text.size(); ++i) {
		const char32_t c = text[i];
		if (c < 0x80)
			continue;
		const char32_t before = i > 0 ? text[i - 1] : 0;
		const char32_t after = i + 1 < text.size() ? text[i + 1] : 0;
		switch (c) {
		case 0x2019:	// ’ an apostrophe, or a closing quote
			score += IsLetter(before);
			break;
		case 0x2018:	// ‘ “ opening quotes
		case 0x201C:
			score += IsLetterOrDigit(after) && !IsLetterOrDigit(before);
			break;
		case 0x201D:	// ” a closing quote
			score += before && before != ' ' && !IsLetterOrDigit(after);
			break;
		case 0x2013:	// – — dashes
		case 0x2014:
			score += (before == ' ' && after == ' ') || (IsLetterOrDigit(before) && IsLetterOrDigit(after));
			break;
		case 0x2026:	// …
			score += 1;
			break;
		case 0x0192: case 0x201A: case 0x201E: case 0x2020: case 0x2021:
		case 0x02C6: case 0x2030: case 0x2039: case 0x203A: case 0x02DC:
			// ƒ ‚ „ † ‡ ˆ ‰ ‹ › ˜, seldom in names and titles
			score -= 2;
			break;
		default:
			// a letter with an accent is part of a word; other signs (€ • © ° ½...) tell
			// nothing
			if (IsLatinLetter(c))
				score += IsLetter(before) || IsLetter(after) ? 1 : -1;
		}
	}
	return score;
}

} // namespace

std::string ToUtf8(std::string_view bytes) {
	if (IsUtf8(bytes))
		return std::string(bytes);
	std::u32string japanese, western;
	const int japaneseErrors = DecodeCp932(bytes, japanese);
	const int westernErrors = DecodeCp1252(bytes, western);
	bool isJapanese;
	if (japaneseErrors != westernErrors)
		isJapanese = japaneseErrors < westernErrors;
	else {
		const int j = JapaneseScore(japanese), w = WesternScore(western);
		isJapanese = j > w || (j == w && j > 0);
	}
	return EncodeUtf8(isJapanese ? japanese : western);
}

std::string FromUtf8(std::string_view text, size_t maxBytes) {
	const bool ascii = std::all_of(text.begin(), text.end(), [](char c) { return static_cast<unsigned char>(c) < 0x80; });
	// ASCII is the same in all of them; what is not UTF-8 is kept as it is
	if (ascii || !IsUtf8(text))
		return std::string(text.substr(0, maxBytes));
	const std::u32string chars = DecodeUtf8(text);
	for (const auto encode : {EncodeCp1252, EncodeCp932}) {
		std::string bytes;
		size_t count = 0;
		bool fits = true, full = false;
		for (const char32_t c : chars) {
			char code[2];
			const int size = encode(c, code);
			if (!size) {
				fits = false;
				break;
			}
			if (!full && bytes.size() + size <= maxBytes) {
				bytes.append(code, size);
				++count;
			}
			else
				full = true;
		}
		if (fits && ToUtf8(bytes) == EncodeUtf8(std::u32string_view(chars).substr(0, count)))
			return bytes;
	}
	return TruncateUtf8(text, maxBytes);
}

} // namespace dnft::text

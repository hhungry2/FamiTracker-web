/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// The frame log of an NSF: what the NSF analyzer (nsf_analyzer.cpp, built into
// dnft-nsf.wasm around NSFPlay) hands to the NSF import (nsf_import.cpp, in dnft.wasm).
// For every frame (a call of the NSF's play routine) and every channel of the chips the
// NSF uses, the state the channel was left in when the play routine returned, and what
// the routine's writes did to it on the way (a new note, a sample started...). The
// waves, samples and patches the channels play are listed once and referred to by
// number.
//
// The log is little-endian:
//   header       "DNFTNSFL", u16 version, u8 region (0 NTSC, 1 PAL, 2 Dendy), u8 chips
//                (the NSF header's expansion bits), u32 frames, u32 the play routine's
//                period in microseconds, u8 N163 channels (the most enabled at once),
//                u8 channels, u8 song, u8 total songs
//   channels     u8 chip, u8 index, for each channel
//   texts        title, artist, copyright, track title: u16 length and the bytes each
//   samples      u16 count; u16 length and the bytes each (DPCM)
//   FDS waves    u16 count; 64 bytes each (0-63)
//   FDS mod      u16 count; 32 bytes each (0-7)
//   N163 waves   u16 count; u8 position, u16 length, length bytes (0-15) each
//   VRC7 patches u16 count; 8 bytes each
//   frames       frames x channels ChannelFrame records
//   writes       u32 for each frame: a hash of the sound registers the frame wrote, in order

#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace dnft {
namespace nsflog {

const char MAGIC[8] = { 'D', 'N', 'F', 'T', 'N', 'S', 'F', 'L' };
const uint16_t VERSION = 2;

// The NSF header's expansion bits
enum : uint8_t {
	CHIP_VRC6 = 0x01,
	CHIP_VRC7 = 0x02,
	CHIP_FDS = 0x04,
	CHIP_MMC5 = 0x08,
	CHIP_N163 = 0x10,
	CHIP_S5B = 0x20,
};

// Where a channel record comes from (ChannelHeader::chip, with the channel's index)
enum Chip : uint8_t {
	APU,	// 0-1 pulse, 2 triangle, 3 noise, 4 DPCM
	VRC6,	// 0-1 pulse, 2 sawtooth
	VRC7,	// 0-5
	FDS,	// 0
	MMC5,	// 0-1 pulse
	N163,	// 0-7, as the tracker counts them: 0 has its registers at $78
	S5B,	// 0-2
};

enum Flags : uint8_t {
	ON = 0x01,			// the channel sounds (keyed, enabled, playing)
	TRIGGER = 0x02,		// the frame restarted the note: a key on, a sample start,
						// a write that resets the phase or the envelope
	SUSTAIN = 0x04,		// VRC7: the sustain bit
	DELTA = 0x08,		// DPCM: the frame wrote the delta counter ($4011), value in aux8
	ENVELOPE = 0x10,	// S5B: the frame restarted the envelope (wrote its shape)
	STOP = 0x20,		// DPCM: the frame stopped the sample that played
};

const uint16_t NO_REF = 0xFFFF;

// One channel in one frame, 16 bytes. What the fields hold depends on the channel:
//   pulse (APU, MMC5)  volume 0-15, timbre duty 0-3, pitch the period; aux16a the APU's
//                      sweep register ($4001, $4005)
//   pulse (VRC6)       volume 0-15, timbre duty 0-7 (bit 7: the "digital" mode), pitch the period
//   triangle           volume 15, pitch the period
//   noise              volume 0-15, timbre the mode (0 long, 1 short), pitch the period index 0-15
//   DPCM               pitch the rate 0-15, ref the sample (with TRIGGER: the one started),
//                      ref2 bit 7 the loop flag; aux8 with DELTA: the last value written
//   sawtooth           volume the accumulator rate 0-63, pitch the period
//   VRC7               volume 0-15 (15 the loudest), timbre the instrument 0-15, ref the
//                      custom patch when it is 0, pitch block << 9 | F-number
//   FDS                volume the gain 0-63 (32 and up are full), aux8 the master volume 0-3,
//                      pitch the frequency, ref the wave, ref2 the modulation table,
//                      aux16a the modulation frequency (bit 15: halted), aux16b the
//                      modulation depth (gain) 0-63
//   N163               volume 0-15, pitch the frequency (18 bits), ref the wave (position,
//                      length and samples), aux8 the wave's position
//   S5B                volume 0-15, timbre bit 0 tone, bit 1 noise, bit 2 envelope; pitch the
//                      period; aux16a the envelope period, aux16b low 4 bits the envelope
//                      shape, bits 8-12 the noise period
struct ChannelFrame {
	uint8_t flags;
	uint8_t volume;
	uint8_t timbre;
	uint8_t aux8;
	uint32_t pitch;
	uint16_t ref;
	uint16_t ref2;
	uint16_t aux16a;
	uint16_t aux16b;
};
static_assert(sizeof(ChannelFrame) == 16, "ChannelFrame is written as it is");

struct ChannelHeader {
	uint8_t chip;
	uint8_t index;
};

struct N163Wave {
	uint8_t position;
	std::vector<uint8_t> samples;
};

struct Log {
	uint8_t region = 0;
	uint8_t chips = 0;
	uint32_t period = 0;		// microseconds per frame
	uint8_t n163Channels = 0;
	uint8_t song = 0;
	uint8_t songs = 0;
	std::string title, artist, copyright, trackTitle;
	std::vector<ChannelHeader> channels;
	std::vector<std::vector<uint8_t>> samples;
	std::vector<std::vector<uint8_t>> fdsWaves;
	std::vector<std::vector<uint8_t>> fdsMods;
	std::vector<N163Wave> n163Waves;
	std::vector<std::vector<uint8_t>> vrc7Patches;
	std::vector<ChannelFrame> frames;		// frame-major: frames x channels
	// For each frame, a hash of the sound registers its writes went to and their values: a
	// driver does the same again when its song does, whatever the chips' timing does to
	// their state
	std::vector<uint32_t> writes;

	size_t FrameCount() const {
		return channels.empty() ? 0 : frames.size() / channels.size();
	}
	const ChannelFrame &At(size_t frame, size_t channel) const {
		return frames[frame * channels.size() + channel];
	}
};

// ---- writing -------------------------------------------------------------------------

class Writer {
public:
	std::vector<uint8_t> bytes;

	void U8(uint8_t v) { bytes.push_back(v); }
	void U16(uint16_t v) { U8(v & 0xFF); U8(v >> 8); }
	void U32(uint32_t v) { U16(v & 0xFFFF); U16(v >> 16); }
	void Bytes(const void *data, size_t size) {
		const uint8_t *p = static_cast<const uint8_t *>(data);
		bytes.insert(bytes.end(), p, p + size);
	}
	void Text(const std::string &s) {
		const size_t size = s.size() < 0xFFFF ? s.size() : 0xFFFF;
		U16(static_cast<uint16_t>(size));
		Bytes(s.data(), size);
	}
};

inline std::vector<uint8_t> Write(const Log &log) {
	Writer w;
	w.Bytes(MAGIC, sizeof(MAGIC));
	w.U16(VERSION);
	w.U8(log.region);
	w.U8(log.chips);
	w.U32(static_cast<uint32_t>(log.FrameCount()));
	w.U32(log.period);
	w.U8(log.n163Channels);
	w.U8(static_cast<uint8_t>(log.channels.size()));
	w.U8(log.song);
	w.U8(log.songs);
	for (const ChannelHeader &c : log.channels) {
		w.U8(c.chip);
		w.U8(c.index);
	}
	w.Text(log.title);
	w.Text(log.artist);
	w.Text(log.copyright);
	w.Text(log.trackTitle);
	w.U16(static_cast<uint16_t>(log.samples.size()));
	for (const auto &s : log.samples) {
		w.U16(static_cast<uint16_t>(s.size()));
		w.Bytes(s.data(), s.size());
	}
	w.U16(static_cast<uint16_t>(log.fdsWaves.size()));
	for (const auto &s : log.fdsWaves)
		w.Bytes(s.data(), 64);
	w.U16(static_cast<uint16_t>(log.fdsMods.size()));
	for (const auto &s : log.fdsMods)
		w.Bytes(s.data(), 32);
	w.U16(static_cast<uint16_t>(log.n163Waves.size()));
	for (const N163Wave &s : log.n163Waves) {
		w.U8(s.position);
		w.U16(static_cast<uint16_t>(s.samples.size()));
		w.Bytes(s.samples.data(), s.samples.size());
	}
	w.U16(static_cast<uint16_t>(log.vrc7Patches.size()));
	for (const auto &s : log.vrc7Patches)
		w.Bytes(s.data(), 8);
	for (const ChannelFrame &f : log.frames) {
		w.U8(f.flags);
		w.U8(f.volume);
		w.U8(f.timbre);
		w.U8(f.aux8);
		w.U32(f.pitch);
		w.U16(f.ref);
		w.U16(f.ref2);
		w.U16(f.aux16a);
		w.U16(f.aux16b);
	}
	for (size_t i = 0; i < log.FrameCount(); ++i)
		w.U32(i < log.writes.size() ? log.writes[i] : 0);
	return std::move(w.bytes);
}

// ---- reading -------------------------------------------------------------------------

class Reader {
public:
	Reader(const uint8_t *data, size_t size) : m_pData(data), m_iSize(size) { }

	bool Ok() const { return m_bOk; }
	uint8_t U8() {
		if (m_iPos + 1 > m_iSize) { m_bOk = false; return 0; }
		return m_pData[m_iPos++];
	}
	uint16_t U16() { const uint16_t lo = U8(); return lo | static_cast<uint16_t>(U8() << 8); }
	uint32_t U32() { const uint32_t lo = U16(); return lo | static_cast<uint32_t>(U16()) << 16; }
	bool Bytes(void *out, size_t size) {
		if (m_iPos + size > m_iSize) { m_bOk = false; return false; }
		std::memcpy(out, m_pData + m_iPos, size);
		m_iPos += size;
		return true;
	}
	std::vector<uint8_t> Vector(size_t size) {
		std::vector<uint8_t> v(size);
		if (!Bytes(v.data(), size))
			v.clear();
		return v;
	}
	std::string Text() {
		const size_t size = U16();
		std::string s(size, '\0');
		if (!Bytes(&s[0], size))
			s.clear();
		return s;
	}

private:
	const uint8_t *m_pData;
	size_t m_iSize;
	size_t m_iPos = 0;
	bool m_bOk = true;
};

// False when the bytes are not a frame log of this version, or are cut short
inline bool Read(const uint8_t *data, size_t size, Log &log) {
	Reader r(data, size);
	char magic[sizeof(MAGIC)];
	if (!r.Bytes(magic, sizeof(magic)) || std::memcmp(magic, MAGIC, sizeof(MAGIC)) || r.U16() != VERSION)
		return false;
	log.region = r.U8();
	log.chips = r.U8();
	const uint32_t frames = r.U32();
	log.period = r.U32();
	log.n163Channels = r.U8();
	const unsigned channels = r.U8();
	log.song = r.U8();
	log.songs = r.U8();
	log.channels.resize(channels);
	for (ChannelHeader &c : log.channels) {
		c.chip = r.U8();
		c.index = r.U8();
	}
	log.title = r.Text();
	log.artist = r.Text();
	log.copyright = r.Text();
	log.trackTitle = r.Text();
	log.samples.resize(r.U16());
	for (auto &s : log.samples)
		s = r.Vector(r.U16());
	log.fdsWaves.resize(r.U16());
	for (auto &s : log.fdsWaves)
		s = r.Vector(64);
	log.fdsMods.resize(r.U16());
	for (auto &s : log.fdsMods)
		s = r.Vector(32);
	log.n163Waves.resize(r.U16());
	for (N163Wave &s : log.n163Waves) {
		s.position = r.U8();
		s.samples = r.Vector(r.U16());
	}
	log.vrc7Patches.resize(r.U16());
	for (auto &s : log.vrc7Patches)
		s = r.Vector(8);
	if (!r.Ok() || static_cast<uint64_t>(frames) * channels * sizeof(ChannelFrame) > size)
		return false;
	log.frames.resize(static_cast<size_t>(frames) * channels);
	for (ChannelFrame &f : log.frames) {
		f.flags = r.U8();
		f.volume = r.U8();
		f.timbre = r.U8();
		f.aux8 = r.U8();
		f.pitch = r.U32();
		f.ref = r.U16();
		f.ref2 = r.U16();
		f.aux16a = r.U16();
		f.aux16b = r.U16();
	}
	log.writes.resize(frames);
	for (uint32_t &w : log.writes)
		w = r.U32();
	return r.Ok();
}

} // namespace nsflog
} // namespace dnft

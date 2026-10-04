/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// Javascript bindings of the NSF analyzer (dnft-nsf.mjs), the first half of the NSF import:
//
//   const nsf = await createDnFTNsf();
//   const at = nsf._malloc(bytes.length);
//   nsf.HEAPU8.set(bytes, at);
//   const info = nsf.nsfInfo(at, bytes.length);   // {error, title, songs, tracks...}
//   const analysis = new nsf.NsfAnalysis();
//   analysis.load(at, bytes.length);               // '' or why the file is not read
//   nsf._free(at);
//   analysis.start(song, -1, maxFrames);           // -1: the region the file prefers
//   while (!analysis.done()) analysis.run(600);    // frames at a time
//   const log = analysis.log();                    // for the engine's importNsf()
//   analysis.delete();

#include "nsf_analyzer.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

using emscripten::val;

namespace {

const uint8_t *HeapPointer(uint32_t offset) {
	return reinterpret_cast<const uint8_t *>(static_cast<uintptr_t>(offset));
}

val CopyToJs(const std::vector<uint8_t> &bytes) {
	val array = val::global("Uint8Array").new_(bytes.size());
	array.call<void>("set", val(emscripten::typed_memory_view(bytes.size(), bytes.data())));
	return array;
}

val CopyToJs(const std::vector<int16_t> &samples) {
	val array = val::global("Int16Array").new_(samples.size());
	array.call<void>("set", val(emscripten::typed_memory_view(samples.size(), samples.data())));
	return array;
}

//! {error ('' when the file is an NSF), title, artist, copyright, ripper, version, songs,
//! start (the first song, from 0), chips (the expansion bits), regions (bit 0 NTSC, 1 PAL,
//! 2 Dendy), preferred (0 NTSC, 1 PAL, 2 Dendy), nsfe, periodNtsc, periodPal (microseconds
//! per frame), tracks: [{title, time, fade}] (milliseconds, -1 when not given)}
val nsfInfo(uint32_t data, uint32_t size) {
	const dnft::NsfInfo info = dnft::ReadNsfInfo(HeapPointer(data), size);
	val result = val::object();
	result.set("error", info.error);
	result.set("title", info.title);
	result.set("artist", info.artist);
	result.set("copyright", info.copyright);
	result.set("ripper", info.ripper);
	result.set("version", info.version);
	result.set("songs", info.songs);
	result.set("start", info.start);
	result.set("chips", info.chips);
	result.set("regions", info.regions);
	result.set("preferred", info.preferred);
	result.set("nsfe", info.nsfe);
	result.set("periodNtsc", info.periodNtsc);
	result.set("periodPal", info.periodPal);
	val tracks = val::array();
	for (const dnft::NsfTrack &t : info.tracks) {
		val track = val::object();
		track.set("title", t.title);
		track.set("time", t.time);
		track.set("fade", t.fade);
		tracks.call<void>("push", track);
	}
	result.set("tracks", tracks);
	return result;
}

//! The song as NSFPlay plays it, to compare an import with: `seconds` of mono 16-bit
//! samples (Int16Array) at `rate`, with the channels of `mask` muted (NSFPlay's MASK
//! setting: bits 0-4 the 2A03's pulses, triangle, noise and DPCM, 5 the FDS, 6-8 the MMC5,
//! 9-13 the 5B, 12-14 the VRC6, 15-23 the VRC7, 21-28 the N163, as nsfplay.cpp shifts it)
val nsfRender(uint32_t data, uint32_t size, int song, double seconds, int rate, int mask) {
	return CopyToJs(dnft::RenderNsf(HeapPointer(data), size, song, seconds, rate, mask));
}

class Analysis {
public:
	//! '' when the file is read, else why not
	std::string load(uint32_t data, uint32_t size) {
		return m_Analysis.Load(HeapPointer(data), size) ? std::string() : m_Analysis.GetError();
	}
	//! Starts the song (from 0); region -1 the file's, 0 NTSC, 1 PAL
	bool start(int song, int region, int maxFrames) {
		return m_Analysis.Start(song, region, maxFrames);
	}
	//! Plays up to `frames` more; the frames written down so far
	int run(int frames) {
		return m_Analysis.Run(frames);
	}
	bool done() const {
		return m_Analysis.IsDone();
	}
	int frames() const {
		return m_Analysis.GetFrameCount();
	}
	//! The frame log (Uint8Array, src/nsf_log.h)
	val log() const {
		return CopyToJs(m_Analysis.GetLog());
	}

private:
	dnft::NsfAnalysis m_Analysis;
};

} // namespace

EMSCRIPTEN_BINDINGS(dnft_nsf) {
	emscripten::function("nsfInfo", &nsfInfo);
	emscripten::function("nsfRender", &nsfRender);
	emscripten::class_<Analysis>("NsfAnalysis")
		.constructor<>()
		.function("load", &Analysis::load)
		.function("start", &Analysis::start)
		.function("run", &Analysis::run)
		.function("done", &Analysis::done)
		.function("frames", &Analysis::frames)
		.function("log", &Analysis::log);
}

/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// Javascript bindings. The interface follows the one of the ZXTune web build
// (apps/zxtune-web), so a page can drive either engine the same way:
//
//   const dnft = await createDnFT();
//   const at = dnft._malloc(bytes.length);
//   dnft.HEAPU8.set(bytes, at);
//   const track = dnft.load(at, bytes.length, '');    // or '#2' for the second track
//   dnft._free(at);
//   const player = track.createPlayer(48000);
//   player.render(buffer, 4096);   // 4096 frames of interleaved int16 stereo at `buffer`

#include "engine.h"

#include <emscripten/bind.h>

#include <cstdlib>
#include <cstring>
#include <string>

namespace {

const char *const PLUGIN_ID = "DNFT";
const char *const PLUGIN_DESCRIPTION = "Dn-FamiTracker / 0CC-FamiTracker / FamiTracker modules";

// Module properties by the names ZXTune uses (see its src/module/attributes.h)
const char *const ATTR_TYPE = "Type";
const char *const ATTR_TITLE = "Title";
const char *const ATTR_AUTHOR = "Author";
const char *const ATTR_COMMENT = "Comment";
const char *const ATTR_PROGRAM = "Program";
const char *const ATTR_COMPUTER = "Computer";

// ZXTune's channel mask property: bit n mutes channel n
const char *const PROP_CHANNELS_MASK = "zxtune.core.channels_mask";
// ZXTune's loop property
const char *const PROP_LOOP = "zxtune.sound.loop";

const void *HeapPointer(uint32_t offset) {
	return reinterpret_cast<const void *>(static_cast<uintptr_t>(offset));
}

// "" or "#1" select the first track, "#n" the n-th.
int ParseSubpath(const std::string &subpath, int trackCount) {
	if (subpath.empty())
		return 0;
	if (subpath[0] != '#')
		throw std::runtime_error("no such track: " + subpath);
	char *end = nullptr;
	long n = std::strtol(subpath.c_str() + 1, &end, 10);
	if (*end || n < 1 || n > trackCount)
		throw std::runtime_error("no such track: " + subpath);
	return static_cast<int>(n - 1);
}

std::string MakeSubpath(int track, int trackCount) {
	return trackCount > 1 ? "#" + std::to_string(track + 1) : std::string();
}

class Player {
public:
	Player(std::shared_ptr<dnft::Module> module, int track, uint32_t samplerate) :
		m_Player(std::move(module), track, samplerate) {}

	//! Fills samples*2 int16 values at the given heap offset.
	//! @return false if the track is over- the rest of the buffer is silence
	bool render(uint32_t target, uint32_t samples) {
		return m_Player.Render(reinterpret_cast<int16_t *>(static_cast<uintptr_t>(target)), samples);
	}

	uint32_t getPosition() const {
		return m_Player.GetPositionMs();
	}

	//! Where the engine is (it renders ahead of what is audible)
	emscripten::val state() const {
		const dnft::PlayerState s = m_Player.GetState();
		auto result = emscripten::val::object();
		result.set("track", s.track);
		result.set("position", s.frame);
		result.set("pattern", s.pattern);
		result.set("line", s.row);
		// ticks per row, which ZXTune calls tempo; FamiTracker calls it speed
		result.set("tempo", s.speed);
		result.set("ftTempo", s.tempo);
		result.set("channels", s.channels);
		result.set("timeMs", s.timeMs);
		return result;
	}

	void seek(uint32_t position) {
		m_Player.Seek(position);
	}

	void setProperty(const std::string &name, const std::string &value) {
		setIntProperty(name, std::strtod(value.c_str(), nullptr));
	}

	void setIntProperty(const std::string &name, double value) {
		if (name == PROP_CHANNELS_MASK)
			m_Player.SetMutedChannels(static_cast<uint64_t>(value));
		else if (name == PROP_LOOP)
			m_Player.SetLoop(value != 0);
	}

private:
	dnft::Player m_Player;
};

class Track {
public:
	Track(std::shared_ptr<dnft::Module> module, int track) :
		m_pModule(std::move(module)), m_iTrack(track) {}

	uint32_t getDuration() const {
		return m_pModule->GetDurationMs(m_iTrack);
	}

	uint32_t getLoopDuration() const {
		return m_pModule->GetLoopDurationMs(m_iTrack);
	}

	std::string getProperty(const std::string &name, const std::string &defVal) const {
		std::string value;
		if (name == ATTR_TYPE)
			value = m_pModule->GetType();
		else if (name == ATTR_TITLE) {
			// the song title, or the track's when a module holds several
			value = m_pModule->GetTitle();
			if (m_pModule->GetTrackCount() > 1) {
				const std::string track = m_pModule->GetTrackTitle(m_iTrack);
				if (!track.empty())
					value = value.empty() ? track : value + " - " + track;
			}
		}
		else if (name == ATTR_AUTHOR)
			value = m_pModule->GetAuthor();
		else if (name == ATTR_COMMENT)
			value = m_pModule->GetComment();
		else if (name == ATTR_PROGRAM)
			value = m_pModule->GetProgram();
		else if (name == ATTR_COMPUTER)
			value = m_pModule->IsPAL() ? "NES (PAL)" : "NES (NTSC)";
		else if (name == "Copyright")
			value = m_pModule->GetCopyright();
		else if (name == "Chips")
			value = m_pModule->GetExpansionChipNames();
		else if (name == "Channels")
			value = std::to_string(m_pModule->GetChannelCount());
		else if (name == "FrameRate")
			value = std::to_string(m_pModule->GetFrameRate());
		else if (name == "Tracks")
			value = std::to_string(m_pModule->GetTrackCount());
		else if (name == "Track")
			value = std::to_string(m_iTrack + 1);
		else if (name == "TrackTitle")
			value = m_pModule->GetTrackTitle(m_iTrack);
		return value.empty() ? defVal : value;
	}

	//! [{name, shortName, chip}], in the order of the channel mask bits
	emscripten::val getChannels() const {
		auto list = emscripten::val::array();
		for (const auto &channel : m_pModule->GetChannels()) {
			auto entry = emscripten::val::object();
			entry.set("name", channel.name);
			entry.set("shortName", channel.shortName);
			entry.set("chip", channel.chip);
			list.call<void>("push", entry);
		}
		return list;
	}

	std::shared_ptr<Player> createPlayer(uint32_t samplerate) const {
		return std::make_shared<Player>(m_pModule, m_iTrack, samplerate);
	}

private:
	std::shared_ptr<dnft::Module> m_pModule;
	int m_iTrack;
};

std::shared_ptr<dnft::Module> LoadModule(uint32_t data, uint32_t size) {
	return dnft::Module::Load(static_cast<const uint8_t *>(HeapPointer(data)), size);
}

//! @param data heap offset of the module file, @param subpath "" or "#n" for the n-th track
std::shared_ptr<Track> load(uint32_t data, uint32_t size, const std::string &subpath) {
	auto module = LoadModule(data, size);
	const int track = ParseSubpath(subpath, module->GetTrackCount());
	return std::make_shared<Track>(std::move(module), track);
}

//! Lists the tracks of a module. Unlike load() this does not throw on unsupported
//! content- the list comes back empty.
emscripten::val detect(uint32_t data, uint32_t size) {
	auto tracks = emscripten::val::array();
	try {
		auto module = LoadModule(data, size);
		const int count = module->GetTrackCount();
		for (int i = 0; i < count; ++i) {
			Track track(module, i);
			auto entry = emscripten::val::object();
			entry.set("subpath", MakeSubpath(i, count));
			entry.set("type", track.getProperty(ATTR_TYPE, ""));
			entry.set("title", track.getProperty(ATTR_TITLE, ""));
			entry.set("author", track.getProperty(ATTR_AUTHOR, ""));
			entry.set("program", track.getProperty(ATTR_PROGRAM, ""));
			entry.set("durationMs", track.getDuration());
			tracks.call<void>("push", entry);
		}
	}
	catch (const dnft::LoadError &) {
	}
	auto result = emscripten::val::object();
	result.set("tracks", tracks);
	result.set("pictures", emscripten::val::array());
	return result;
}

//! {id, description, caps}, as ZXTune's plugins() reports them
emscripten::val plugins() {
	auto list = emscripten::val::array();
	auto entry = emscripten::val::object();
	entry.set("id", PLUGIN_ID);
	entry.set("description", PLUGIN_DESCRIPTION);
	entry.set("caps", 0);
	list.call<void>("push", entry);
	return list;
}

} // namespace

EMSCRIPTEN_BINDINGS(dnft) {
	emscripten::class_<Player>("Player")
		.smart_ptr<std::shared_ptr<Player>>("Player")
		.function("render", &Player::render)
		.function("getPosition", &Player::getPosition)
		.function("state", &Player::state)
		.function("seek", &Player::seek)
		.function("setProperty", &Player::setProperty)
		.function("setIntProperty", &Player::setIntProperty);

	emscripten::class_<Track>("Track")
		.smart_ptr<std::shared_ptr<Track>>("Track")
		.function("getDuration", &Track::getDuration)
		.function("getLoopDuration", &Track::getLoopDuration)
		.function("getProperty", &Track::getProperty)
		.function("getChannels", &Track::getChannels)
		.function("createPlayer", &Track::createPlayer);

	emscripten::function("load", &load);
	emscripten::function("detect", &detect);
	emscripten::function("plugins", &plugins);
}

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
#include "Settings.h"
#include "SoundGen.h"
#include "TrackerChannel.h"
#include "portable/SoundGenUI.h"
#include "dnft_compat.h"
#include "soundgen_host.h"
#include "engine.h"
#include "engine_internal.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace dnft {

namespace detail {

Engine &GetEngine() {
	static Engine engine;
	if (!engine.host) {
		theApp.InitInstance();
		engine.host = std::make_unique<CSoundGenHost>(*theApp.GetSoundGenerator());
		CSoundGenHost::SetSink([](const int16_t *samples, uint32_t count) {
			if (auto *target = GetEngine().target)
				target->insert(target->end(), samples, samples + count);
		});
	}
	return engine;
}

MessageCollector::MessageCollector() {
	dnft_compat::SetMessageHandler([this](const std::string &text, unsigned int type) {
		if (!m_sText.empty())
			m_sText += '\n';
		m_sText += text;
		// questions (such as whether to recover a file) are declined
		return (type & 0xF) == MB_YESNO || (type & 0xF) == MB_YESNOCANCEL ? IDNO : IDOK;
	});
}

MessageCollector::~MessageCollector() {
	dnft_compat::SetMessageHandler(nullptr);
}

} // namespace detail

using detail::Engine;
using detail::GetEngine;
using detail::ToUtf8;

namespace {

bool IsUtf8(const std::string &s) {
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

// Names of the blocks in a module file: after the header string and a 32-bit version,
// each block is a 16-byte name, a 32-bit version and a 32-bit size, then its data.
std::vector<std::string> ListBlocks(const uint8_t *data, size_t size) {
	static const char *const HEADERS[] = {"Dn-FamiTracker Module", "FamiTracker Module"};
	size_t at = 0;
	for (const char *header : HEADERS) {
		const size_t len = std::strlen(header);
		if (size >= len && std::memcmp(data, header, len) == 0) {
			at = len + 4;
			break;
		}
	}
	std::vector<std::string> blocks;
	while (at != 0 && size - at >= 24) {
		std::string name(reinterpret_cast<const char *>(data + at), strnlen(reinterpret_cast<const char *>(data + at), 16));
		if (name == "END")
			break;
		uint32_t blockSize;
		std::memcpy(&blockSize, data + at + 20, 4);
		blocks.push_back(std::move(name));
		if (blockSize > size - at - 24)
			break;
		at += 24 + blockSize;
	}
	return blocks;
}

} // namespace

namespace detail {

std::string ToUtf8(const char *text, size_t maxLength) {
	std::string raw(text, strnlen(text, maxLength));
	if (IsUtf8(raw))
		return raw;
	static const char16_t CP1252_80[32] = {
		0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0xFFFD, 0x017D, 0xFFFD,
		0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0x017E, 0x0178,
	};
	std::string out;
	for (unsigned char c : raw) {
		char32_t cp = c >= 0x80 && c < 0xA0 ? CP1252_80[c - 0x80] : c;
		if (cp < 0x80)
			out += static_cast<char>(cp);
		else if (cp < 0x800) {
			out += static_cast<char>(0xC0 | (cp >> 6));
			out += static_cast<char>(0x80 | (cp & 0x3F));
		}
		else {
			out += static_cast<char>(0xE0 | (cp >> 12));
			out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
			out += static_cast<char>(0x80 | (cp & 0x3F));
		}
	}
	return out;
}

LoadedDocument LoadDocument(const uint8_t *data, size_t size) {
	Engine &engine = GetEngine();
	CSoundGen &soundGen = *theApp.GetSoundGenerator();

	static unsigned serial = 0;
	const std::string path = "memory/module" + std::to_string(++serial);
	dnft_compat::PutFile(path, std::vector<uint8_t>(data, data + size));

	// The loader of the desktop build's module import, which leaves the playing document
	// alone. A new document still offers itself to the sound generator when nothing is
	// assigned; players and sessions attach theirs explicitly, so take it back.
	MessageCollector messages;
	const bool hadDocument = soundGen.GetDocument() != nullptr;
	std::unique_ptr<CFamiTrackerDoc> pDoc(CFamiTrackerDoc::LoadImportFile(path.c_str()));
	if (!hadDocument && soundGen.GetDocument())
		engine.host->Detach();
	dnft_compat::TakeFile(path);
	if (!pDoc)
		throw LoadError(messages.GetText().empty() ? "unsupported or malformed module" : messages.GetText());

	LoadedDocument loaded;
	loaded.document = std::move(pDoc);

	// Dn-FamiTracker writes its own header since 0.5.0.0; older versions, 0CC-FamiTracker
	// and FamiTracker share one. The blocks tell them apart.
	const bool dnHeader = size >= 14 && std::memcmp(data, "Dn-FamiTracker", 14) == 0;
	const auto blocks = ListBlocks(data, size);
	const auto has = [&blocks](std::initializer_list<const char *> names) {
		return std::any_of(names.begin(), names.end(), [&blocks](const char *name) {
			return std::find(blocks.begin(), blocks.end(), name) != blocks.end();
		});
	};
	loaded.type = dnHeader ? "DNM" : "FTM";
	if (dnHeader || has({"JSON", "PARAMS_EMU"}))
		loaded.program = "Dn-FamiTracker";
	else if (has({"PARAMS_EXTRA", "DETUNETABLES", "GROOVES", "BOOKMARKS"}))
		loaded.program = "0CC-FamiTracker";
	else
		loaded.program = "FamiTracker";
	return loaded;
}

} // namespace detail

// ---- Module ------------------------------------------------------------------------------------------

std::shared_ptr<Module> Module::Load(const uint8_t *data, size_t size) {
	detail::LoadedDocument loaded = detail::LoadDocument(data, size);
	auto module = std::shared_ptr<Module>(new Module());
	module->m_pDocument = std::move(loaded.document);
	module->m_sType = std::move(loaded.type);
	module->m_sProgram = std::move(loaded.program);
	return module;
}

Module::~Module() {
	Engine &engine = GetEngine();
	if (theApp.GetSoundGenerator()->GetDocument() == m_pDocument.get())
		engine.host->Detach();
}

std::string Module::GetTitle() const {
	return ToUtf8(m_pDocument->GetSongName(), 32);
}

std::string Module::GetAuthor() const {
	return ToUtf8(m_pDocument->GetSongArtist(), 32);
}

std::string Module::GetCopyright() const {
	return ToUtf8(m_pDocument->GetSongCopyright(), 32);
}

std::string Module::GetComment() const {
	CString comment = m_pDocument->GetComment();
	return ToUtf8(comment.GetString(), comment.GetLength());
}

int Module::GetTrackCount() const {
	return static_cast<int>(m_pDocument->GetTrackCount());
}

std::string Module::GetTrackTitle(int track) const {
	CString title = m_pDocument->GetTrackTitle(track);
	return ToUtf8(title.GetString(), title.GetLength());
}

uint32_t Module::GetDurationMs(int track) const {
	return static_cast<uint32_t>(std::lround(m_pDocument->GetStandardLength(track, 0) * 1000.0));
}

uint32_t Module::GetLoopDurationMs(int track) const {
	double once = m_pDocument->GetStandardLength(track, 0);
	double twice = m_pDocument->GetStandardLength(track, 1);
	return static_cast<uint32_t>(std::lround(std::max(0.0, twice - once) * 1000.0));
}

unsigned int Module::GetExpansionChips() const {
	return m_pDocument->GetExpansionChip();
}

std::string Module::GetExpansionChipNames() const {
	static const std::pair<unsigned, const char *> CHIPS[] = {
		{SNDCHIP_VRC6, "VRC6"}, {SNDCHIP_VRC7, "VRC7"}, {SNDCHIP_FDS, "FDS"},
		{SNDCHIP_MMC5, "MMC5"}, {SNDCHIP_N163, "N163"}, {SNDCHIP_S5B, "5B"},
	};
	std::string names = "2A03";
	for (const auto &[bit, name] : CHIPS)
		if (GetExpansionChips() & bit)
			names += std::string("+") + name;
	return names;
}

int Module::GetChannelCount() const {
	return m_pDocument->GetChannelCount();
}

std::vector<ChannelInfo> Module::GetChannels() const {
	std::vector<ChannelInfo> channels;
	for (int i = 0; i < m_pDocument->GetChannelCount(); ++i) {
		const CTrackerChannel *pChannel = m_pDocument->GetChannel(i);
		channels.push_back({pChannel->GetChannelName(), pChannel->GetShortName(), static_cast<unsigned>(pChannel->GetChip())});
	}
	return channels;
}

int Module::GetNamcoChannels() const {
	return m_pDocument->GetNamcoChannels();
}

bool Module::IsPAL() const {
	return m_pDocument->GetMachine() == PAL;
}

unsigned int Module::GetFrameRate() const {
	return m_pDocument->GetFrameRate();
}

// ---- Player ------------------------------------------------------------------------------------------

Player::Player(std::shared_ptr<Module> module, int track, uint32_t sampleRate) :
	m_pModule(std::move(module)),
	m_iTrack(std::clamp(track, 0, m_pModule->GetTrackCount() - 1)),
	m_iSampleRate(sampleRate)
{
	Engine &engine = GetEngine();
	m_iSerial = ++engine.current;

	// The APU renders at the rate from the settings (the wave export rate on the desktop)
	theApp.GetSettings()->Sound.iSampleRate = static_cast<int>(sampleRate);
	engine.view.SetDocument(&m_pModule->GetDocument());
	engine.host->Attach(m_pModule->GetDocument(), engine.view);
	Restart();
}

Player::~Player() {
	if (IsCurrent())
		GetEngine().host->Stop();
}

bool Player::IsCurrent() const {
	return GetEngine().current == m_iSerial;
}

void Player::Restart() {
	Engine &engine = GetEngine();
	m_Pending.clear();
	m_iPendingPos = 0;
	m_iRendered = 0;
	m_bEnded = false;
	engine.view.SetMutedChannels(m_iMutedChannels);
	engine.host->Start(m_iTrack, m_bLoop);
}

bool Player::Pump() {
	// Plays ticks until one produces audio. False once the track is over.
	Engine &engine = GetEngine();
	engine.target = &m_Pending;
	while (m_Pending.empty() && engine.host->IsPlaying())
		engine.host->Tick();
	engine.target = nullptr;
	return !m_Pending.empty();
}

bool Player::Render(int16_t *out, uint32_t frames) {
	uint32_t done = 0;
	if (IsCurrent() && !m_bEnded) {
		while (done < frames) {
			if (m_iPendingPos == m_Pending.size()) {
				m_Pending.clear();
				m_iPendingPos = 0;
				if (!Pump()) {
					m_bEnded = true;
					break;
				}
			}
			const size_t take = std::min<size_t>(frames - done, m_Pending.size() - m_iPendingPos);
			const int16_t *in = m_Pending.data() + m_iPendingPos;
			// the 2A03 and its expansions are mono
			for (size_t i = 0; i < take; ++i)
				out[2 * (done + i)] = out[2 * (done + i) + 1] = in[i];
			m_iPendingPos += take;
			done += static_cast<uint32_t>(take);
		}
	}
	std::fill(out + 2 * done, out + 2 * frames, int16_t(0));
	m_iRendered += done;
	return done == frames;
}

void Player::Seek(uint32_t ms) {
	if (!IsCurrent())
		return;
	const uint64_t target = static_cast<uint64_t>(ms) * m_iSampleRate / 1000;
	Restart();
	// The engine has no shortcut to a position: play up to it without keeping the audio
	while (!m_bEnded && m_iRendered + m_Pending.size() <= target) {
		m_iRendered += m_Pending.size();
		m_Pending.clear();
		if (!Pump())
			m_bEnded = true;
	}
	const size_t skip = static_cast<size_t>(std::min<uint64_t>(target - m_iRendered, m_Pending.size()));
	m_iPendingPos = skip;
	m_iRendered += skip;
}

uint32_t Player::GetPositionMs() const {
	return static_cast<uint32_t>(m_iRendered * 1000 / m_iSampleRate);
}

PlayerState Player::GetState() const {
	const CSoundGenHost &host = *GetEngine().host;
	const CFamiTrackerDoc &doc = m_pModule->GetDocument();
	PlayerState state {};
	state.track = m_iTrack;
	state.timeMs = GetPositionMs();
	state.channels = doc.GetChannelCount();
	if (IsCurrent()) {
		state.frame = host.GetFrame();
		state.row = host.GetRow();
		state.speed = host.GetSpeed();
		state.tempo = host.GetTempo();
		state.pattern = static_cast<int>(doc.GetPatternAtFrame(m_iTrack, state.frame, 0));
	}
	return state;
}

void Player::SetLoop(bool loop) {
	if (loop == m_bLoop)
		return;
	m_bLoop = loop;
	// The loop limit is set up when playback starts: restart where we are
	if (IsCurrent())
		Seek(GetPositionMs());
}

void Player::SetMutedChannels(uint64_t mask) {
	m_iMutedChannels = mask;
	if (IsCurrent())
		GetEngine().view.SetMutedChannels(mask);
}

} // namespace dnft

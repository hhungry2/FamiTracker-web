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
#include "text_encoding.h"

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
	m_Previous = dnft_compat::SetMessageHandler([this](const std::string &text, unsigned int type) {
		if (!m_sText.empty())
			m_sText += '\n';
		m_sText += text;
		// questions (such as whether to recover a file) are declined
		return (type & 0xF) == MB_YESNO || (type & 0xF) == MB_YESNOCANCEL ? IDNO : IDOK;
	});
}

MessageCollector::~MessageCollector() {
	dnft_compat::SetMessageHandler(std::move(m_Previous));
}

} // namespace detail

using detail::Engine;
using detail::GetEngine;
using detail::ToUtf8;

namespace {

// What Seek() plays exactly before the position it lands on, in milliseconds
constexpr uint32_t SEEK_EXACT_MS = 300;

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
	return text::ToUtf8(std::string_view(text, strnlen(text, maxLength)));
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

std::unique_ptr<CFamiTrackerDoc> NewDocument() {
	Engine &engine = GetEngine();
	CSoundGen &soundGen = *theApp.GetSoundGenerator();

	// As in LoadDocument(): a new document offers itself to the sound generator when
	// nothing is assigned, and needs one assigned while it sets itself up.
	MessageCollector messages;
	const bool hadDocument = soundGen.GetDocument() != nullptr;
	std::unique_ptr<CFamiTrackerDoc> pDoc(static_cast<CFamiTrackerDoc *>(CFamiTrackerDoc::CreateObject()));
	const bool created = pDoc->OnNewDocument() != FALSE;
	if (!hadDocument && soundGen.GetDocument())
		engine.host->Detach();
	if (!created)
		throw std::runtime_error(messages.GetText().empty() ? "could not create a module" : messages.GetText());
	return pDoc;
}

std::string NewPath(const std::string &name) {
	static unsigned serial = 0;
	return "memory/" + std::to_string(++serial) + "/" + name;
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
	if (IsCurrent())
		SeekTo(static_cast<uint64_t>(ms) * m_iSampleRate / 1000, false);
}

void Player::SeekTo(uint64_t target, bool restart) {
	// The engine has no shortcut to a position: play up to it without keeping the audio.
	// From where it is, when that is before the position; a restart otherwise.
	if (restart || m_bEnded || target < m_iRendered)
		Restart();

	// Far from the position nobody listens, so the chips take long steps instead of
	// following every change of level, which is several times faster. They end in the
	// state exact steps would leave them in, but the filters that smooth the sound (the
	// integrator of the Blip_Buffer above all) come out of the skipped part in another
	// one. Playing the last stretch exactly lets them settle: from the position on the
	// sound is the same, sample for sample but for the last bit with the N163.
	const uint64_t lead = static_cast<uint64_t>(m_iSampleRate) * SEEK_EXACT_MS / 1000;
	CSoundGenHost &host = *GetEngine().host;
	struct Guard {
		CSoundGenHost &host;
		~Guard() { host.SetSkipping(false); }
	} guard {host};

	uint64_t end = m_iRendered + (m_Pending.size() - m_iPendingPos);
	while (!m_bEnded && end <= target) {
		m_iRendered = end;
		m_Pending.clear();
		m_iPendingPos = 0;
		host.SetSkipping(end + lead < target);
		if (!Pump())
			m_bEnded = true;
		end = m_iRendered + m_Pending.size();
	}
	const size_t skip = static_cast<size_t>(std::min<uint64_t>(target - m_iRendered, m_Pending.size() - m_iPendingPos));
	m_iPendingPos += skip;
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
		SeekTo(m_iRendered, true);
}

void Player::SetMutedChannels(uint64_t mask) {
	m_iMutedChannels = mask;
	if (IsCurrent())
		GetEngine().view.SetMutedChannels(mask);
}

} // namespace dnft

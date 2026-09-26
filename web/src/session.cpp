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
#include "engine_internal.h"
#include "session.h"

#include <algorithm>
#include <stdexcept>

namespace dnft {

using detail::GetEngine;

namespace {
// Every tick produces audio; this only keeps a broken state from hanging Render().
const int MAX_SILENT_TICKS = 64;
}

std::shared_ptr<Session> Session::Create(uint32_t sampleRate) {
	detail::Engine &engine = GetEngine();
	CSoundGen &soundGen = *theApp.GetSoundGenerator();

	// As in LoadDocument(): a new document offers itself to the sound generator when
	// nothing is assigned, and needs one assigned while it sets itself up.
	detail::MessageCollector messages;
	const bool hadDocument = soundGen.GetDocument() != nullptr;
	std::unique_ptr<CFamiTrackerDoc> pDoc(static_cast<CFamiTrackerDoc *>(CFamiTrackerDoc::CreateObject()));
	const bool created = pDoc->OnNewDocument() != FALSE;
	if (!hadDocument && soundGen.GetDocument())
		engine.host->Detach();
	if (!created)
		throw std::runtime_error(messages.GetText().empty() ? "could not create a module" : messages.GetText());
	return std::shared_ptr<Session>(new Session(std::move(pDoc), sampleRate));
}

std::shared_ptr<Session> Session::Open(const uint8_t *data, size_t size, uint32_t sampleRate) {
	detail::LoadedDocument loaded = detail::LoadDocument(data, size);
	auto session = std::shared_ptr<Session>(new Session(std::move(loaded.document), sampleRate));
	session->m_sType = std::move(loaded.type);
	session->m_sProgram = std::move(loaded.program);
	return session;
}

Session::Session(std::unique_ptr<CFamiTrackerDoc> document, uint32_t sampleRate) :
	m_pDocument(std::move(document)),
	m_iSampleRate(sampleRate)
{
	detail::Engine &engine = GetEngine();
	m_iSerial = ++engine.current;

	// The APU renders at the rate from the settings (the wave export rate on the desktop)
	theApp.GetSettings()->Sound.iSampleRate = static_cast<int>(sampleRate);
	engine.view.SetDocument(m_pDocument.get());
	engine.view.SetSelection(0, 0);
	engine.view.SetMutedChannels(0);
	engine.host->Attach(*m_pDocument, engine.view);
	engine.host->BeginStream();
}

Session::~Session() {
	detail::Engine &engine = GetEngine();
	if (theApp.GetSoundGenerator()->GetDocument() == m_pDocument.get())
		engine.host->Detach();
}

bool Session::IsCurrent() const {
	return GetEngine().current == m_iSerial;
}

std::vector<uint8_t> Session::Save() {
	// The desktop's save writes a temporary file and moves it in place: both live in
	// memory here (compat/windows.h).
	static unsigned serial = 0;
	const std::string path = "memory/save" + std::to_string(++serial) + ".dnm";
	detail::MessageCollector messages;
	const bool saved = m_pDocument->OnSaveDocument(path.c_str()) != FALSE;
	std::vector<uint8_t> bytes = dnft_compat::TakeFile(path);
	if (!saved || bytes.empty())
		throw std::runtime_error(messages.GetText().empty() ? "could not save the module" : messages.GetText());
	return bytes;
}

bool Session::IsModified() const {
	return m_pDocument->IsModified() != FALSE;
}

void Session::Pump() {
	// Plays ticks until one produces audio, noting the rows the player reads
	detail::Engine &engine = GetEngine();
	CSoundGenHost &host = *engine.host;
	engine.target = &m_Pending;
	for (int ticks = 0; m_Pending.empty() && ticks < MAX_SILENT_TICKS; ++ticks) {
		const bool playing = host.IsPlayerRunning();
		const int frame = host.GetFrame();
		const int row = host.GetRow();
		// all that was rendered before has been handed out
		const uint64_t at = m_iRendered;
		host.Tick();
		// A Cxx row is read a second time when its time is up, which halts the player
		// (CSoundGen::ReadPatternRow()): that read is where playback stops.
		if (playing && !host.IsPlayerRunning())
			m_RowEvents.push_back({at, -1, -1});
		else if (playing && host.RowWasRead())
			m_RowEvents.push_back({at, frame, row});
	}
	engine.target = nullptr;
}

void Session::Render(int16_t *out, uint32_t frames) {
	uint32_t done = 0;
	if (IsCurrent()) {
		while (done < frames) {
			if (m_iPendingPos == m_Pending.size()) {
				m_Pending.clear();
				m_iPendingPos = 0;
				Pump();
				if (m_Pending.empty())
					break;
			}
			const size_t take = std::min<size_t>(frames - done, m_Pending.size() - m_iPendingPos);
			const int16_t *in = m_Pending.data() + m_iPendingPos;
			// the 2A03 and its expansions are mono
			for (size_t i = 0; i < take; ++i)
				out[2 * (done + i)] = out[2 * (done + i) + 1] = in[i];
			m_iPendingPos += take;
			m_iRendered += take;
			done += static_cast<uint32_t>(take);
		}
	}
	std::fill(out + 2 * done, out + 2 * frames, int16_t(0));
	m_iRendered += frames - done;
}

std::vector<RowEvent> Session::TakeRowEvents() {
	std::vector<RowEvent> events;
	events.swap(m_RowEvents);
	return events;
}

void Session::Play(int track, PlayMode mode, int frame, int row) {
	if (!IsCurrent())
		return;
	const CFamiTrackerDoc &doc = *m_pDocument;
	track = std::clamp(track, 0, static_cast<int>(doc.GetTrackCount()) - 1);
	frame = std::clamp(frame, 0, static_cast<int>(doc.GetFrameCount(track)) - 1);
	row = std::clamp(row, 0, static_cast<int>(doc.GetPatternLength(track)) - 1);

	static const play_mode_t MODES[] = {MODE_PLAY_START, MODE_PLAY, MODE_PLAY_CURSOR, MODE_PLAY_REPEAT};
	detail::Engine &engine = GetEngine();
	m_iTrack = track;
	engine.view.SetSelection(frame, row);
	engine.host->StartPlayer(MODES[std::clamp(static_cast<int>(mode), 0, 3)], track);
}

void Session::Stop() {
	if (!IsCurrent() || !IsPlaying())
		return;
	GetEngine().host->HaltPlayer();
	// where the audio rendered from now on begins
	m_RowEvents.push_back({m_iRendered + (m_Pending.size() - m_iPendingPos), -1, -1});
}

bool Session::IsPlaying() const {
	return IsCurrent() && GetEngine().host->IsPlayerRunning();
}

PlayerState Session::GetState() const {
	const CSoundGenHost &host = *GetEngine().host;
	PlayerState state {};
	state.track = m_iTrack;
	state.timeMs = static_cast<uint32_t>(m_iRendered * 1000 / m_iSampleRate);
	state.channels = m_pDocument->GetChannelCount();
	if (IsCurrent()) {
		state.frame = host.GetFrame();
		state.row = host.GetRow();
		state.speed = host.GetSpeed();
		state.tempo = host.GetTempo();
		if (state.frame < static_cast<int>(m_pDocument->GetFrameCount(m_iTrack)))
			state.pattern = static_cast<int>(m_pDocument->GetPatternAtFrame(m_iTrack, state.frame, 0));
	}
	return state;
}

void Session::NoteOn(int channel, int note, int octave, int instrument, int volume) {
	if (!IsCurrent() || channel < 0 || channel >= m_pDocument->GetChannelCount())
		return;
	// CFamiTrackerView::PlayNote()
	stChanNote NoteData {};
	NoteData.Note = static_cast<unsigned char>(std::clamp(note, static_cast<int>(NOTE_C), static_cast<int>(NOTE_B)));
	NoteData.Octave = static_cast<unsigned char>(std::clamp(octave, 0, OCTAVE_RANGE - 1));
	NoteData.Instrument = static_cast<unsigned char>(instrument >= 0 && instrument < MAX_INSTRUMENTS ? instrument : MAX_INSTRUMENTS);
	NoteData.Vol = static_cast<unsigned char>(volume >= 0 && volume < MAX_VOLUME ? volume : MAX_VOLUME);
	m_pDocument->GetChannel(channel)->SetNote(NoteData, NOTE_PRIO_2);
	theApp.GetSoundGenerator()->ForceReloadInstrument(channel);
}

void Session::NoteOff(int channel, bool release) {
	if (!IsCurrent() || channel < 0 || channel >= m_pDocument->GetChannelCount())
		return;
	// CFamiTrackerView::ReleaseNote() and HaltNote()
	stChanNote NoteData {};
	NoteData.Note = release ? RELEASE : HALT;
	theApp.GetSoundGenerator()->QueueNote(channel, NoteData, NOTE_PRIO_2);
}

void Session::SetMutedChannels(uint64_t mask) {
	const uint64_t silenced = mask & ~m_iMutedChannels;
	m_iMutedChannels = mask;
	if (!IsCurrent())
		return;
	GetEngine().view.SetMutedChannels(mask);
	// The player passes nothing to muted channels, which would leave their last note on:
	// the desktop cuts it (CFamiTrackerView::HaltNoteSingle()).
	for (int i = 0; i < m_pDocument->GetChannelCount() && i < 64; ++i)
		if (silenced >> i & 1)
			NoteOff(i, false);
}

void Session::ApplyDocumentProperties() {
	if (!IsCurrent())
		return;
	detail::Engine &engine = GetEngine();
	engine.host->Attach(*m_pDocument, engine.view);
	engine.host->BeginStream();
	engine.view.SetMutedChannels(m_iMutedChannels);
}

} // namespace dnft

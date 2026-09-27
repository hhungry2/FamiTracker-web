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
#include "portable/SoundGenUI.h"
#include "WaveFile.h"
#include "APU/APU.h"
#include "ChannelHandler.h"
#include "SoundGen.h"
#include "soundgen_host.h"

#include <climits>
#include <thread>

namespace {
CSoundGenHost::Sink g_Sink;
}

void CSoundGenHost::SetSink(Sink sink) {
	g_Sink = std::move(sink);
}

const CSoundGenHost::Sink &CSoundGenHost::GetSink() {
	return g_Sink;
}

// CSoundGen writes rendered audio here while m_bRendering is set (see FillBuffer()).
bool CWaveFile::OpenFile(LPTSTR, int, int, int) {
	return true;
}

void CWaveFile::CloseFile() {
}

void CWaveFile::WriteWave(char *Data, int Size) {
	if (g_Sink)
		g_Sink(reinterpret_cast<const int16_t *>(Data), static_cast<uint32_t>(Size) / sizeof(int16_t));
}

CSoundStream *CSoundInterface::OpenFloatChannel(int, int) {
	// The rate the APU renders at, so that CSoundGen sees nothing to resample
	return new CSoundStream(theApp.GetSettings()->Sound.iSampleRate);
}

CSoundGenHost::CSoundGenHost(CSoundGen &gen) : m_Gen(gen) {
}

void CSoundGenHost::Attach(CFamiTrackerDoc &doc, CFamiTrackerView &view) {
	CSoundGen &g = m_Gen;

	// Everything below runs on this thread, including what the desktop build
	// reserves for the audio thread.
	g.m_audioThreadID = std::this_thread::get_id();

	// A new document offers itself to the sound generator from its constructor, which
	// is only accepted while no other document is assigned.
	if (g.m_pDocument != &doc) {
		Detach();
		g.AssignDocument(&doc);
	}
	g.AssignView(&view);

	if (!m_bInitialized) {
		// CSoundGen::BeginThread() and the start of its thread: InitInstance() sets up
		// the audio device, the APU and the vibrato table, and needs a document for the
		// mixing levels.
		g.m_pSoundInterface = new CSoundInterface(nullptr);
		g.m_pSoundInterface->EnumerateDevices();
		g.InitInstance();
		m_bInitialized = true;
	}

	g.DocumentPropertiesChanged(&doc);
	Configure();
	g.OnStopPlayer(0, 0);
}

void CSoundGenHost::Configure() {
	CSoundGen &g = m_Gen;
	// What the audio thread does when it starts: reset the audio device, which gives the
	// APU its sample rate (from the settings) and the document's mixing levels. Then what
	// it does after CFamiTrackerDoc::OnOpenDocument(): switch the expansion chips and load
	// the machine settings.
	g.OnLoadSettings(0, 0);
	g.OnSetChip(g.m_pDocument->GetExpansionChip(), 0);
	g.LoadMachineSettings();
}

void CSoundGenHost::RenewAPU() {
	CSoundGen &g = m_Gen;
	// Chips keep some state through a reset (the N163's wave RAM holds its channel
	// registers), so what played before would leak into the start of the next track: a
	// click the desktop build's wave export hides in the silent ticks it starts with.
	// A new APU makes every start sound like the first one after the program started.
	delete g.m_pAPU;
	g.m_pAPU = new CAPU(&g);
	for (CChannelHandler *pChannel : g.m_pChannels)
		if (pChannel)
			pChannel->InitChannel(g.m_pAPU, g.m_iVibratoTable, &g);
	Configure();
	g.ResetAPU();
}

void CSoundGenHost::Detach() {
	CSoundGen &g = m_Gen;
	if (!g.m_pDocument)
		return;
	Stop();
	g.OnRemoveDocument(0, 0);
}

bool CSoundGenHost::BeginRendering(int Track, bool loop) {
	CSoundGen &g = m_Gen;
	Stop();
	if (!g.m_pDocument || !g.m_pDocument->IsFileLoaded())
		return false;

	// CSoundGen::RenderToFile() and OnStartRender(), without the wave file and without
	// the five silent ticks the export waits before playing.
	g.m_iRenderTrack = Track;
	g.m_iRenderRow = 0;
	if (loop) {
		g.m_iRenderEndWhen = SONG_TIME_LIMIT;
		g.m_iRenderEndParam = UINT_MAX;
		g.m_iRenderRowCount = 0;
	}
	else {
		g.m_iRenderEndWhen = SONG_LOOP_LIMIT;
		g.m_iRenderEndParam = g.m_pDocument->ScanActualLength(Track, 1);
		g.m_iRenderRowCount = g.m_iRenderEndParam;
	}
	g.m_pWaveFile = std::make_unique<CWaveFile>();
	RenewAPU();
	g.ResetBuffer();
	g.m_bRequestRenderStart = false;
	g.m_bRequestRenderStop = false;
	g.m_bStoppingRender = false;
	g.m_bRendering = true;
	g.m_iDelayedStart = 0;
	g.m_iDelayedEnd = 0;
	return true;
}

void CSoundGenHost::Start(int Track, bool loop) {
	if (BeginRendering(Track, loop))
		m_Gen.OnStartPlayer(MODE_PLAY_START, Track);
}

void CSoundGenHost::BeginStream() {
	// The time limit is never reached: rendering only ends when asked to.
	BeginRendering(0, true);
}

void CSoundGenHost::StartPlayer(int Mode, int Track) {
	CSoundGen &g = m_Gen;
	if (g.m_bRendering)
		g.OnStartPlayer(static_cast<play_mode_t>(Mode), Track);
}

void CSoundGenHost::HaltPlayer() {
	CSoundGen &g = m_Gen;
	if (g.m_bPlaying)
		g.OnStopPlayer(0, 0);
}

void CSoundGenHost::Stop() {
	CSoundGen &g = m_Gen;
	if (g.m_bRendering)
		g.StopRendering();
	else if (g.m_bPlaying)
		g.OnStopPlayer(0, 0);
}

void CSoundGenHost::Tick() {
	CSoundGen &g = m_Gen;
	if (!g.m_pDocument || !g.m_pSoundStream || !g.m_pDocument->IsFileLoaded())
		return;
	g.OnIdle();
}

bool CSoundGenHost::IsPlaying() const {
	return m_Gen.m_bRendering && m_Gen.IsPlaying();
}

bool CSoundGenHost::IsPlayerRunning() const {
	return m_Gen.IsPlaying();
}

bool CSoundGenHost::RowWasRead() const {
	// RunFrame() sets it for every tick it plays, true when it read a row
	return m_Gen.m_bUpdateRow;
}

int CSoundGenHost::GetFrame() const {
	return m_Gen.GetPlayerFrame();
}

int CSoundGenHost::GetRow() const {
	return m_Gen.GetPlayerRow();
}

int CSoundGenHost::GetTrack() const {
	return m_Gen.GetPlayerTrack();
}

unsigned int CSoundGenHost::GetTicks() const {
	return m_Gen.m_iPlayTicks;
}

int CSoundGenHost::GetSpeed() const {
	return m_Gen.m_iSpeed;
}

int CSoundGenHost::GetTempo() const {
	return m_Gen.m_iTempo;
}

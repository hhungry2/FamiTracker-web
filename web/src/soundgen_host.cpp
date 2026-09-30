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

#include <algorithm>
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

bool CSoundGenHost::BeginRendering(int Track, int EndWhen, unsigned int EndParam, int DelayTicks) {
	CSoundGen &g = m_Gen;
	Stop();
	if (!g.m_pDocument || !g.m_pDocument->IsFileLoaded())
		return false;

	// CSoundGen::RenderToFile() and OnStartRender(), without the wave file
	g.m_iRenderTrack = Track;
	g.m_iRenderRow = 0;
	g.m_iRenderEndWhen = static_cast<render_end_t>(EndWhen);
	g.m_iRenderEndParam = EndParam;
	g.m_iRenderRowCount = EndWhen == SONG_LOOP_LIMIT ? EndParam : 0;
	g.m_pWaveFile = std::make_unique<CWaveFile>();
	RenewAPU();
	g.ResetBuffer();
	g.m_bRequestRenderStart = false;
	g.m_bRequestRenderStop = false;
	g.m_bStoppingRender = false;
	g.m_bRendering = true;
	g.m_iDelayedStart = DelayTicks;
	g.m_iDelayedEnd = DelayTicks;
	return true;
}

void CSoundGenHost::Start(int Track, bool loop) {
	// without the five silent ticks the export waits before playing
	bool started = loop ?
		BeginRendering(Track, SONG_TIME_LIMIT, UINT_MAX, 0) :
		m_Gen.m_pDocument && BeginRendering(Track, SONG_LOOP_LIMIT, m_Gen.m_pDocument->ScanActualLength(Track, 1), 0);
	if (started)
		m_Gen.OnStartPlayer(MODE_PLAY_START, Track);
}

void CSoundGenHost::BeginStream() {
	// The time limit is never reached: rendering only ends when asked to.
	BeginRendering(0, SONG_TIME_LIMIT, UINT_MAX, 0);
}

bool CSoundGenHost::BeginExport(int Track, bool ByTime, int EndParam) {
	CSoundGen &g = m_Gen;
	if (!g.m_pDocument)
		return false;
	// CSoundGen::RenderToFile(): seconds count in ticks, passes in rows. OnStartRender()
	// waits five ticks before it plays and five after the end; the player starts from
	// the message OnIdle() posts when the wait is over (see Tick()).
	const unsigned int param = ByTime ?
		static_cast<unsigned int>(EndParam) * g.m_pDocument->GetFrameRate() :
		g.m_pDocument->ScanActualLength(Track, static_cast<unsigned int>(EndParam));
	return BeginRendering(Track, ByTime ? SONG_TIME_LIMIT : SONG_LOOP_LIMIT, param, 5);
}

bool CSoundGenHost::IsRendering() const {
	return m_Gen.m_bRendering;
}

void CSoundGenHost::EndExportIfHalted() {
	// The player checks the export's limit only while it plays (CSoundGen::RunFrame()),
	// so a song that halts (Cxx) before the limit would render silence without end: end
	// it the way reaching the limit does, five ticks later.
	CSoundGen &g = m_Gen;
	if (g.m_bRendering && !g.m_bPlaying && !g.m_iDelayedStart && !g.m_maybeSelfMessage && !g.m_bStoppingRender)
		g.m_bRequestRenderStop = true;
}

double CSoundGenHost::GetRenderProgress() const {
	// what the desktop's progress dialog shows (CWavProgressDlg::OnTimer())
	const CSoundGen &g = m_Gen;
	if (!g.m_bRendering)
		return 1.0;
	if (g.m_iRenderEndWhen == SONG_LOOP_LIMIT)
		return g.m_iRenderRowCount ? std::min(1.0, static_cast<double>(std::max(0, g.m_iRenderRow)) / g.m_iRenderRowCount) : 0.0;
	return g.m_iRenderEndParam ? std::min(1.0, static_cast<double>(g.m_iPlayTicks) / g.m_iRenderEndParam) : 0.0;
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
	// The audio thread's loop (CSoundGen::ThreadEntry()) handles the message the sound
	// generator posts itself (the start of an export's playback) before the next tick.
	// Messages from the user interface are not taken: the host makes those calls itself.
	if (g.m_maybeSelfMessage) {
		const GuiMessage message = *g.m_maybeSelfMessage;
		g.m_maybeSelfMessage = {};
		g.DispatchGuiMessage(message);
	}
	g.OnIdle();
}

void CSoundGenHost::SetSkipping(bool skip) {
	if (m_Gen.m_pAPU)
		m_Gen.m_pAPU->SetSkipping(skip);
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

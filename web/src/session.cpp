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
#include "DSample.h"
#include "TrackerChannel.h"
#include "TextExporter.h"
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
	return std::shared_ptr<Session>(new Session(detail::NewDocument(), sampleRate));
}

std::shared_ptr<Session> Session::Open(const uint8_t *data, size_t size, uint32_t sampleRate) {
	detail::LoadedDocument loaded = detail::LoadDocument(data, size);
	auto session = std::shared_ptr<Session>(new Session(std::move(loaded.document), sampleRate));
	session->m_sType = std::move(loaded.type);
	session->m_sProgram = std::move(loaded.program);
	return session;
}

std::shared_ptr<Session> Session::ImportText(const uint8_t *data, size_t size, uint32_t sampleRate, std::string &warning) {
	// CMainFrame::OnFileImportText(): the importer starts a new document and reads the
	// file into it
	std::unique_ptr<CFamiTrackerDoc> pDoc = detail::NewDocument();
	const std::string path = detail::NewPath("import.txt");
	dnft_compat::PutFile(path, std::vector<uint8_t>(data, data + size));
	std::string result;
	{
		detail::MessageCollector messages;
		CTextExport importer;
		result = importer.ImportFile(path.c_str(), pDoc.get()).GetString();
		if (result.empty())
			result = messages.GetText();
	}
	dnft_compat::TakeFile(path);
	// The importer stops at the first error and says where. Only a JSON block it could
	// not parse is reported after the rest was read, and then left out.
	warning.clear();
	if (!result.empty()) {
		if (result.rfind("JSON parsing error", 0) != 0)
			throw LoadError(result);
		warning = result;
	}
	pDoc->SetModifiedFlag(TRUE);
	pDoc->SetExceededFlag(false);
	return std::shared_ptr<Session>(new Session(std::move(pDoc), sampleRate));
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
	// a wave export has the sound generator meanwhile
	if (IsCurrent() && !m_bWave) {
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
	if (!IsCurrent() || m_bWave)
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
	if (!IsCurrent() || m_bWave || !IsPlaying())
		return;
	GetEngine().host->HaltPlayer();
	// where the audio rendered from now on begins
	m_RowEvents.push_back({m_iRendered + (m_Pending.size() - m_iPendingPos), -1, -1});
}

bool Session::IsPlaying() const {
	return IsCurrent() && !m_bWave && GetEngine().host->IsPlayerRunning();
}

PlayerState Session::GetState() const {
	const CSoundGenHost &host = *GetEngine().host;
	PlayerState state {};
	state.track = m_iTrack;
	state.timeMs = static_cast<uint32_t>(m_iRendered * 1000 / m_iSampleRate);
	state.channels = m_pDocument->GetChannelCount();
	if (IsCurrent() && !m_bWave) {
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
	if (!IsCurrent() || m_bWave || channel < 0 || channel >= m_pDocument->GetChannelCount())
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
	if (!IsCurrent() || m_bWave || channel < 0 || channel >= m_pDocument->GetChannelCount())
		return;
	// CFamiTrackerView::ReleaseNote() and HaltNote()
	stChanNote NoteData {};
	NoteData.Note = release ? RELEASE : HALT;
	theApp.GetSoundGenerator()->QueueNote(channel, NoteData, NOTE_PRIO_2);
}

void Session::PreviewSample(const std::vector<uint8_t> &data, int offset, int pitch, bool deltaStart) {
	if (!IsCurrent() || m_bWave || data.empty())
		return;
	CSoundGenHost &host = *GetEngine().host;
	// The sample has no name: the sound generator deletes it when it has played.
	CDSample *sample = new CDSample(static_cast<unsigned>(std::min<size_t>(data.size(), CDSample::MAX_SIZE)));
	std::copy_n(data.begin(), sample->GetSize(), reinterpret_cast<uint8_t *>(sample->GetData()));
	// the start has to leave something to play (CSoundGen::PlaySample())
	offset = std::clamp(offset, 0, static_cast<int>(((sample->GetSize() - 1) >> 4) >> 2));
	// CSampleEditorDlg::OnBnClickedPlay()
	host.WriteAPU(0x4011, deltaStart ? 64 : 0);
	if (!host.PreviewSample(sample, offset, std::clamp(pitch, 0, 15)))
		delete sample;
}

void Session::ReleaseSamples() {
	if (IsCurrent())
		GetEngine().host->CancelPreview();
}

void Session::SetMutedChannels(uint64_t mask) {
	const uint64_t silenced = mask & ~m_iMutedChannels;
	m_iMutedChannels = mask;
	// a wave export mutes channels of its own; EndWave() puts these back
	if (!IsCurrent() || m_bWave)
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
	// the export would go on with what it set up before
	EndWave();
	detail::Engine &engine = GetEngine();
	engine.host->Attach(*m_pDocument, engine.view);
	engine.host->BeginStream();
	engine.view.SetMutedChannels(m_iMutedChannels);
}

// ---- wave export -----------------------------------------------------------------------

void Session::BeginWave(int track, int passes, int seconds, uint64_t muted, uint32_t sampleRate) {
	if (!IsCurrent())
		throw std::runtime_error("another player or session has the sound generator");
	EndWave();
	Stop();
	detail::Engine &engine = GetEngine();
	track = std::clamp(track, 0, static_cast<int>(m_pDocument->GetTrackCount()) - 1);
	// CCreateWaveDlg: 1 to 99 passes, or 1 second to 99 minutes
	const bool byTime = passes <= 0;
	const int length = byTime ? std::clamp(seconds, 1, 99 * 60) : std::clamp(passes, 1, 99);

	// What was rendered for the session's own output is not heard any more.
	m_Pending.clear();
	m_iPendingPos = 0;
	m_bWave = true;
	// The wave export renders at the rate of the sound settings; the channels not
	// ticked in the dialog are muted in the view.
	theApp.GetSettings()->Sound.iSampleRate = static_cast<int>(sampleRate);
	engine.view.SetMutedChannels(muted);
	if (!engine.host->BeginExport(track, byTime, length)) {
		EndWave();
		throw std::runtime_error("could not start the export");
	}
}

bool Session::RenderWave(std::vector<int16_t> &out, size_t samples) {
	if (!m_bWave || !IsCurrent())
		throw std::runtime_error("the export was interrupted");
	detail::Engine &engine = GetEngine();
	CSoundGenHost &host = *engine.host;
	engine.target = &out;
	while (out.size() < samples && host.IsRendering()) {
		host.EndExportIfHalted();
		host.Tick();
	}
	engine.target = nullptr;
	return host.IsRendering();
}

double Session::GetWaveProgress() const {
	return m_bWave && IsCurrent() ? GetEngine().host->GetRenderProgress() : 1.0;
}

void Session::EndWave() {
	if (!m_bWave)
		return;
	m_bWave = false;
	if (!IsCurrent())
		return;
	detail::Engine &engine = GetEngine();
	theApp.GetSettings()->Sound.iSampleRate = static_cast<int>(m_iSampleRate);
	engine.view.SetMutedChannels(m_iMutedChannels);
	// stops what is left of the export
	engine.host->BeginStream();
}

// ---- module import -----------------------------------------------------------------------

const CFamiTrackerDoc &Session::BeginImport(const uint8_t *data, size_t size) {
	m_pImport.reset();
	m_pImport = detail::LoadDocument(data, size).document;
	return *m_pImport;
}

bool Session::FinishImport(const std::vector<bool> &tracks, bool instruments, bool grooves, bool detune, std::string &messages) {
	if (!m_pImport)
		throw std::runtime_error("no module to import from");
	std::unique_ptr<CFamiTrackerDoc> pImported = std::move(m_pImport);
	CFamiTrackerDoc &doc = *m_pDocument;
	Stop();
	EndWave();

	detail::MessageCollector collector;
	bool imported = true;
	{
		// CModuleImportDlg::LoadFile(): both modules get the expansion chips of either
		if (pImported->GetNamcoChannels() != doc.GetNamcoChannels()) {
			const int channels = std::max(pImported->GetNamcoChannels(), doc.GetNamcoChannels());
			pImported->SetNamcoChannels(channels, true);
			doc.SetNamcoChannels(channels, true);
			const unsigned char chips = pImported->GetExpansionChip() | doc.GetExpansionChip();
			pImported->SelectExpansionChip(chips, true);
			doc.SelectExpansionChip(chips, true);
		}
		if (pImported->GetExpansionChip() != doc.GetExpansionChip()) {
			const unsigned char chips = pImported->GetExpansionChip() | doc.GetExpansionChip();
			pImported->SelectExpansionChip(chips, true);
			doc.SelectExpansionChip(chips, true);
		}

		// CModuleImportDlg::OnBnClickedOk(): each step translates the numbers of what it
		// brings in for the tracks, or keeps them when it is not asked for
		int instrumentTable[MAX_INSTRUMENTS];
		int grooveMap[MAX_GROOVE];
		for (int i = 0; i < MAX_INSTRUMENTS; ++i)
			instrumentTable[i] = instruments ? 0 : i;
		for (int i = 0; i < MAX_GROOVE; ++i)
			grooveMap[i] = grooves ? 0 : i;
		imported = (!instruments || doc.ImportInstruments(pImported.get(), instrumentTable))
			&& (!grooves || doc.ImportGrooves(pImported.get(), grooveMap))
			&& (!detune || doc.ImportDetune(pImported.get()));
		for (unsigned int i = 0; imported && i < pImported->GetTrackCount(); ++i)
			if (i < tracks.size() && tracks[i])
				imported = doc.ImportTrack(static_cast<int>(i), pImported.get(), instrumentTable, grooveMap);
		if (!imported)
			AfxMessageBox(IDS_IMPORT_FAILED, MB_ICONERROR);
		doc.SetModifiedFlag();
		doc.SetExceededFlag();
	}
	messages = collector.GetText();
	// the channels, the detune tables
	ApplyDocumentProperties();
	return imported;
}

void Session::CancelImport() {
	m_pImport.reset();
}

} // namespace dnft

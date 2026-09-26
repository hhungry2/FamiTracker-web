/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// theApp, as far as the core uses it: the owner of the settings, the sound generator
// and the channel map, and the place messages are shown.

#include "stdafx.h"
#include "FamiTracker.h"
#include "Settings.h"
#include "SoundGen.h"
#include "Instrument.h"
#include "ChannelMap.h"
#include "VersionChecker.h"
#include "portable/SoundGenUI.h"

CFamiTrackerApp theApp;

CFamiTrackerApp::CFamiTrackerApp() :
	m_pMIDI(nullptr),
	m_pAccel(nullptr),
	m_pSettings(nullptr),
	m_pChannelMap(nullptr),
	m_customExporters(nullptr),
	m_pInstanceMutex(nullptr),
	m_hWndMapFile(nullptr),
	m_CoInitialized(false),
	m_bThemeActive(false),
	m_bVersionReady(false),
	m_bNewVersion(false),
	m_bStartUp(false)
#ifdef SUPPORT_TRANSLATIONS
	, m_hInstResDLL(nullptr)
#endif
{
}

BOOL CFamiTrackerApp::InitInstance()
{
	// The parts of the desktop start-up the core depends on, in the same order.
	// Settings come from the registry there; here every setting keeps its default.
	if (m_pSoundGenerator)
		return TRUE;
	m_pSettings = CSettings::GetObject();
	m_pSettings->LoadSettings();
	m_pMIDI = new CMIDI();
	m_pSoundGenerator = std::make_shared<CSoundGen>();
	m_pChannelMap = new CChannelMap();
	return TRUE;
}

int CFamiTrackerApp::ExitInstance()
{
	return 0;
}

BOOL CFamiTrackerApp::OnIdle(LONG)
{
	return FALSE;
}

BOOL CFamiTrackerApp::PreTranslateMessage(MSG *)
{
	return FALSE;
}

void CFamiTrackerApp::DisplayMessage(LPCTSTR lpszText, UINT nType, UINT nIDHelp)
{
	AfxMessageBox(lpszText, nType, nIDHelp);
}

void CFamiTrackerApp::DisplayMessage(UINT nIDPrompt, UINT nType, UINT nIDHelp)
{
	AfxMessageBox(nIDPrompt, nType, nIDHelp);
}

void CFamiTrackerApp::ThreadDisplayMessage(LPCTSTR lpszText, UINT nType, UINT nIDHelp)
{
	AfxMessageBox(lpszText, nType, nIDHelp);
}

void CFamiTrackerApp::ThreadDisplayMessage(UINT nIDPrompt, UINT nType, UINT nIDHelp)
{
	AfxMessageBox(nIDPrompt, nType, nIDHelp);
}

void CFamiTrackerApp::StopPlayerAndWait()
{
	// CFamiTrackerDoc::DeleteContents() stops playback before it clears a document. The
	// web build loads every module into a new document while another one may be playing,
	// and players detach their document before it goes away (see engine.cpp).
}

bool CFamiTrackerApp::IsPlaying() const
{
	return m_pSoundGenerator && m_pSoundGenerator->IsPlaying();
}

CMainFrame *CFamiTrackerApp::GetMainFrame() const
{
	return nullptr;
}

CCustomExporters *CFamiTrackerApp::GetCustomExporters() const
{
	return nullptr;
}

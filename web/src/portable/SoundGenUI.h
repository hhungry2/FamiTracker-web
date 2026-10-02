/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// What the sound generator sees of the desktop user interface, for builds that have
// none. SoundGen.cpp includes this in place of FamiTrackerView.h, VisualizerWnd.h,
// MainFrm.h, SoundInterface.h and MIDI.h; the classes keep their names and the members
// the sound generator calls, and are implemented by the web host (soundgen_host.cpp).

#pragma once

#include "stdafx.h"
#include "FamiTrackerViewMessage.h"
#include "gsl/span"
#include <cstdint>

class CFamiTrackerDoc;
class stChanNote;

// The view decides which notes reach the player (muted channels only pass global
// effects) and where playback starts from.
class CFamiTrackerView : public CView {
public:
	unsigned int GetSelectedFrame() const { return m_iSelectedFrame; }
	unsigned int GetSelectedRow() const { return m_iSelectedRow; }
	int GetMarkerFrame() const { return m_iSelectedFrame; }
	int GetMarkerRow() const { return m_iSelectedRow; }
	void PlayerTick() {}
	bool PlayerGetNote(int Track, int Frame, int Channel, int Row, stChanNote &NoteData);
	void MakeSilent() {}
	int GetAutoArpeggio(unsigned int) { return 0; }
	// The sound generator tells the view that a recorded instrument is ready (the instrument
	// recorder); the host takes it into the document after the tick, as the desktop's view
	// does when it gets the message.
	bool PostAudioMessage(AudioMessageId Message, WPARAM = 0, LPARAM = 0) {
		if (Message != AM_DUMP_INST)
			return false;
		++m_iPendingDumps;
		return true;
	}
	bool TakePendingDump() { return m_iPendingDumps > 0 && (--m_iPendingDumps, true); }

	// host side
	void SetDocument(CFamiTrackerDoc *pDoc) { m_pDoc = pDoc; }
	void SetSelection(unsigned int Frame, unsigned int Row) { m_iSelectedFrame = Frame; m_iSelectedRow = Row; }
	void SetMutedChannels(uint64_t Mask) { m_iMutedChannels = Mask; }
	bool IsChannelMuted(int Channel) const { return Channel < 64 && (m_iMutedChannels >> Channel & 1) != 0; }

private:
	CFamiTrackerDoc *m_pDoc = nullptr;
	unsigned int m_iSelectedFrame = 0;
	unsigned int m_iSelectedRow = 0;
	uint64_t m_iMutedChannels = 0;
	int m_iPendingDumps = 0;
};

class CVisualizerWnd : public CWnd {
public:
	void SetSampleRate(int) {}
	void FlushSamples(gsl::span<const short>) {}
	void ReportAudioProblem() {}
};

class CMainFrame : public CFrameWnd {
public:
	int GetSelectedInstrument() const { return 0; }
};

class CMIDI {
public:
	void WriteNote(unsigned char, unsigned char, unsigned char, unsigned char) {}
};

// Audio output. The web build renders the way the desktop build exports wave files, so
// the stream is only there for the sound generator to configure itself against: it
// reports the sample rate the APU renders at, which keeps the resampler out of the path.
enum class WaitResult {
	InternalError = 0,
	Interrupted = 1,
	Timeout,
	Ready,
	OutOfSync,
};

class CSoundStream {
public:
	explicit CSoundStream(unsigned int SampleRate) : m_iSampleRate(SampleRate) {}
	bool Play() { return true; }
	bool Stop() { return true; }
	bool ClearBuffer() { return true; }
	uint32_t FramesToPubBytes(uint32_t Frames) const { return Frames * sizeof(float); }
	uint32_t PubBytesToFrames(uint32_t Bytes) const { return Bytes / sizeof(float); }
	uint32_t TotalBufferSizeFrames() const { return m_iSampleRate / 10; }
	uint32_t TotalBufferSizeBytes() const { return FramesToPubBytes(TotalBufferSizeFrames()); }
	uint32_t GetSampleRate() const { return m_iSampleRate; }
	WaitResult WaitForReady(DWORD, bool) { return WaitResult::Ready; }
	uint32_t BufferFramesWritable() const { return TotalBufferSizeFrames(); }
	bool WriteBuffer(float const *, unsigned int) { return true; }

private:
	unsigned int m_iSampleRate;
};

class CSoundInterface {
public:
	explicit CSoundInterface(HANDLE) {}
	void EnumerateDevices() {}
	unsigned int GetDeviceCount() const { return 1; }
	bool SetupDevice(int) { return true; }
	void CloseDevice() {}
	CSoundStream *OpenFloatChannel(int Channels, int BufferLength);
	void CloseChannel(CSoundStream *pChannel) { delete pChannel; }
};

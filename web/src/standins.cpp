/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// Definitions the core links against whose desktop versions live in user interface
// sources that the web build leaves out.

#include "stdafx.h"
#include "FamiTracker.h"
#include "FamiTrackerDoc.h"
#include "PatternNote.h"
#include "portable/SoundGenUI.h"
#include "DetuneDlg.h"
#include "VersionChecker.h"
#include "libsamplerate/include/samplerate.h"

#include <algorithm>
#include <iterator>

// ---- CFamiTrackerView (see portable/SoundGenUI.h) ------------------------------------------

bool CFamiTrackerView::PlayerGetNote(int Track, int Frame, int Channel, int Row, stChanNote &NoteData)
{
	// CFamiTrackerView::PlayerGetNote() without the pattern editor's feedback
	m_pDoc->GetNoteData(Track, Frame, Channel, Row, &NoteData);

	if (!IsChannelMuted(Channel))
		return true;

	// These effects will pass even if the channel is muted
	static const int PASS_EFFECTS[] = {EF_HALT, EF_JUMP, EF_SPEED, EF_SKIP, EF_GROOVE,
		EF_VRC7_PORT, EF_VRC7_WRITE,
		EF_N163_WAVE_BUFFER,
		EF_SUNSOFT_ENV_HI, EF_SUNSOFT_ENV_LO, EF_SUNSOFT_ENV_TYPE, EF_SUNSOFT_NOISE
	};
	bool ValidCommand = false;
	int Columns = m_pDoc->GetEffColumns(Track, Channel) + 1;

	NoteData.Note = HALT;
	NoteData.Octave = 0;
	NoteData.Instrument = 0;

	for (int j = 0; j < Columns; ++j) {
		bool Clear = true;
		for (int Effect : PASS_EFFECTS) {
			if (NoteData.EffNumber[j] == Effect) {
				ValidCommand = true;
				Clear = false;
			}
		}
		if (Clear)
			NoteData.EffNumber[j] = EF_NONE;
	}

	return ValidCommand;
}

void CFamiTrackerView::PlayerTick()
{
	// CFamiTrackerView::PlayerTick(): with more than one note held, the arpeggio goes up to the
	// next of them, around; notes let go are dropped as it passes them
	if (m_iAutoArpKeyCount == 1 || !theApp.GetSettings()->Midi.bMidiArpeggio)
		return;

	int OldPtr = m_iAutoArpPtr;
	do {
		m_iAutoArpPtr = (m_iAutoArpPtr + 1) & 127;
		if (m_iAutoArpNotes[m_iAutoArpPtr] == 1) {
			m_iArpeggiate[m_iAutoArpChannel] = m_iAutoArpPtr;
			break;
		}
		else if (m_iAutoArpNotes[m_iAutoArpPtr] == 2) {
			m_iAutoArpNotes[m_iAutoArpPtr] = 0;
		}
	}
	while (m_iAutoArpPtr != OldPtr);
}

int CFamiTrackerView::GetAutoArpeggio(unsigned int Channel)
{
	// Return and reset next arpeggio note
	if (Channel >= static_cast<unsigned>(MAX_CHANNELS))
		return 0;
	int ret = m_iArpeggiate[Channel];
	m_iArpeggiate[Channel] = 0;
	return ret;
}

void CFamiTrackerView::MakeSilent()
{
	m_iAutoArpPtr = 0;
	m_iAutoArpKeyCount = 0;
	std::fill(std::begin(m_iArpeggiate), std::end(m_iArpeggiate), 0);
	std::fill(std::begin(m_iAutoArpNotes), std::end(m_iAutoArpNotes), 0);
}

void CFamiTrackerView::AutoArpNote(int MidiNote, bool Held, int Channel)
{
	if (Channel < 0 || Channel >= MAX_CHANNELS)
		return;
	MidiNote = std::clamp(MidiNote, 0, NOTE_COUNT - 1);
	if (!Held) {
		m_iAutoArpNotes[MidiNote] = 2;
		return;
	}
	m_iAutoArpNotes[MidiNote] = 1;
	m_iAutoArpPtr = MidiNote;
	m_iAutoArpChannel = Channel;
	m_iAutoArpKeyCount = static_cast<int>(std::count(std::begin(m_iAutoArpNotes), std::end(m_iAutoArpNotes), 1));
}

// ---- CVersionChecker -------------------------------------------------------------------------------
// theApp holds one while it checks for updates; the web build never does.

CVersionChecker::~CVersionChecker() noexcept {
}

// ---- constants from dialogs --------------------------------------------------------------------

// DetuneDlg.cpp
const CString CDetuneDlg::CHIP_STR[6] = {_T("NTSC"), _T("PAL"), _T("Saw"), _T("VRC7"), _T("FDS"), _T("N163")};

// SpeedDlg.cpp (declared extern in SpeedDlg.h, which this file does not include)
extern const int RATE_MIN = 16;

// ---- libsamplerate ---------------------------------------------------------------------------------
// CSoundGen resamples from the APU rate to the sound card rate. The web build renders at
// the output rate, so the ratio is always 1 and only these entry points are reached.

struct SRC_STATE_tag {
	int channels;
};

SRC_STATE *src_new(int, int channels, int *error) {
	if (error)
		*error = 0;
	return new SRC_STATE {channels};
}

SRC_STATE *src_delete(SRC_STATE *state) {
	delete state;
	return nullptr;
}

int src_reset(SRC_STATE *) {
	return 0;
}

int src_process(SRC_STATE *, SRC_DATA *data) {
	// Only reached with a ratio of 1: copy what fits
	long frames = std::min(data->input_frames, data->output_frames);
	std::copy(data->data_in, data->data_in + frames, data->data_out);
	data->input_frames_used = frames;
	data->output_frames_gen = frames;
	return 0;
}

void src_short_to_float_array(const short *in, float *out, int len) {
	for (int i = 0; i < len; ++i)
		out[i] = static_cast<float>(in[i] / (1.0 * 0x8000));
}

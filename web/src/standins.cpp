/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// Definitions the core links against whose desktop versions live in user interface or
// export sources that the web build leaves out.

#include "stdafx.h"
#include "FamiTracker.h"
#include "FamiTrackerDoc.h"
#include "PatternNote.h"
#include "portable/SoundGenUI.h"
#include "InstrumentRecorder.h"
#include "DetuneDlg.h"
#include "Chunk.h"
#include "ChunkRenderText.h"
#include "VersionChecker.h"
#include "libsamplerate/include/samplerate.h"

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

// ---- CInstrumentRecorder -------------------------------------------------------------------------
// Recording instruments from playback is an editor feature; the recorder never records.

CInstrumentRecorder::CInstrumentRecorder(CSoundGen *pSG) :
	m_pDocument(nullptr),
	m_pSoundGen(pSG),
	m_iRecordChannel(-1),
	m_iDumpCount(0),
	m_pDumpInstrument(nullptr),
	m_pDumpCache(),
	m_pSequenceCache(),
	m_stRecordSetting {15, 1, false},
	m_iRecordWaveCache(nullptr),
	m_iRecordWaveSize(0),
	m_iRecordWaveCount(0)
{
}

CInstrumentRecorder::~CInstrumentRecorder() {
}

void CInstrumentRecorder::StartRecording() {
}

void CInstrumentRecorder::StopRecording(CFamiTrackerView *) {
}

void CInstrumentRecorder::RecordInstrument(const unsigned, CFamiTrackerView *) {
}

CInstrument *CInstrumentRecorder::GetRecordInstrument(unsigned) const {
	return nullptr;
}

int CInstrumentRecorder::GetRecordChannel() const {
	return m_iRecordChannel;
}

void CInstrumentRecorder::SetRecordChannel(int Channel) {
	m_iRecordChannel = Channel;
}

stRecordSetting *CInstrumentRecorder::GetRecordSetting() const {
	return const_cast<stRecordSetting *>(&m_stRecordSetting);
}

void CInstrumentRecorder::SetRecordSetting(stRecordSetting *Setting) {
	if (Setting)
		m_stRecordSetting = *Setting;
}

void CInstrumentRecorder::ResetDumpInstrument() {
}

void CInstrumentRecorder::ResetRecordCache() {
}

void CInstrumentRecorder::ReleaseCurrent() {
}

// ---- CVersionChecker -------------------------------------------------------------------------------
// theApp holds one while it checks for updates; the web build never does.

CVersionChecker::~CVersionChecker() noexcept {
}

// ---- constants from dialogs and the NSF exporter ------------------------------------------------

// DetuneDlg.cpp
const CString CDetuneDlg::CHIP_STR[6] = {_T("NTSC"), _T("PAL"), _T("Saw"), _T("VRC7"), _T("FDS"), _T("N163")};

// SpeedDlg.cpp (declared extern in SpeedDlg.h, which this file does not include)
extern const int RATE_MIN = 16;

// ChunkRenderText.cpp
const char CChunkRenderText::LABEL_SONG_LIST[]			= "ft_song_list";
const char CChunkRenderText::LABEL_INSTRUMENT_LIST[]	= "ft_instrument_list";
const char CChunkRenderText::LABEL_SAMPLES_LIST[]		= "ft_sample_list";
const char CChunkRenderText::LABEL_SAMPLES[]			= "ft_samples";
const char CChunkRenderText::LABEL_GROOVE_LIST[]		= "ft_groove_list";
const char CChunkRenderText::LABEL_GROOVE[]				= "ft_groove_%i";
const char CChunkRenderText::LABEL_WAVETABLE[]			= "ft_wave_table";
const char CChunkRenderText::LABEL_SAMPLE[]				= "ft_sample_%i";
const char CChunkRenderText::LABEL_WAVES[]				= "ft_waves_%i";
const char CChunkRenderText::LABEL_SEQ_2A03[]			= "ft_seq_2a03_%i";
const char CChunkRenderText::LABEL_SEQ_VRC6[]			= "ft_seq_vrc6_%i";
const char CChunkRenderText::LABEL_SEQ_FDS[]			= "ft_seq_fds_%i";
const char CChunkRenderText::LABEL_SEQ_N163[]			= "ft_seq_n163_%i";
const char CChunkRenderText::LABEL_SEQ_S5B[]			= "ft_seq_s5b_%i";
const char CChunkRenderText::LABEL_INSTRUMENT[]			= "ft_inst_%i";
const char CChunkRenderText::LABEL_SONG[]				= "ft_song_%i";
const char CChunkRenderText::LABEL_SONG_FRAMES[]		= "ft_s%i_frames";
const char CChunkRenderText::LABEL_SONG_FRAME[]			= "ft_s%if%i";
const char CChunkRenderText::LABEL_PATTERN[]			= "ft_s%ip%ic%i";

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

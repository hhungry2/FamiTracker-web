/*
** Dn-FamiTracker - NES/Famicom sound tracker
** Copyright (C) 2020-2026 D.P.C.M.
** FamiTracker Copyright (C) 2005-2020 Jonathan Liss
** 0CC-FamiTracker Copyright (C) 2014-2018 HertzDevil
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
**
** This program is distributed in the hope that it will be useful,
** but WITHOUT ANY WARRANTY; without even the implied warranty of
** MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
** GNU General Public License for more details.
**
** You should have received a copy of the GNU General Public License
** along with this program. If not, see https://www.gnu.org/licenses/.
*/


#pragma once

#include "Types.h"
#include "../Common.h"
#include "../Blip_Buffer/Blip_Buffer.h"

#include <vector>		// !! !!
#include <string>		// !! !!

enum chip_level_t {
	CHIP_LEVEL_APU1,
	CHIP_LEVEL_APU2,
	CHIP_LEVEL_VRC6,
	CHIP_LEVEL_VRC7,
	CHIP_LEVEL_FDS,
	CHIP_LEVEL_MMC5,
	CHIP_LEVEL_N163,
	CHIP_LEVEL_S5B,
	CHIP_LEVEL_COUNT
};

class C2A03;
class CFDS;
class CAPU;

struct MixerConfig {
	// Global lowpass
	int LowCut = 0;
	// Global highpass
	int HighCut = 0;
	// Global higpass damping
	int HighDamp = 0;
	// Global volume
	float OverallVol = 0;

	// https://forums.nesdev.org/viewtopic.php?t=17741
	// Use survey derived default mix levels. Overrides the chip levels.
	bool UseSurveyMix = false;

	// Device lowpassing, described in integer Hz.
	int16_t FDSLowpass = 2000;
	int16_t N163Lowpass = 12000;

	// Device mixing offsets, described in centibels. too late to change to millibels.
	// range is +- 12 db.
	std::vector<int16_t> DeviceMixOffsets = {
		0,		// APU1Offset
		0,		// APU2Offset
		0,		// VRC6Offset
		0,		// VRC7Offset
		0,		// FDSOffset
		0,		// MMC5Offset
		0,		// N163Offset
		0		// S5BOffset
	};
};

struct EmulatorConfig {
	bool N163DisableMultiplexing = true;
	int UseOPLLPatchSet = 0;

	// Use external OPLL instead of VRC7
	bool UseOPLLExt = false;

	// User-defined hardware patch set for external OPLL
	std::vector<uint8_t> UseOPLLPatchBytes = {
		0, 0, 0, 0, 0, 0, 0, 0,		// patch 0 must always be 0
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0
	};

	// User-defined hardware patch names for external OPLL
	std::vector<std::string> UseOPLLPatchNames = {
		"(custom instrument)",		// patch 0 must always be named "(custom instrument)"
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		"",
		""
	};
};

class CMixer
{
public:
	CMixer(CAPU * Parent);
	~CMixer();

	void	ExternalSound(int Chip);

	void	AddValue(int ChanID, int Chip, int Value, int AbsValue, int FrameCycles);
	void	SetMixing(MixerConfig cfg) {
		m_MixerConfig = cfg;
	}
	void	SetEmulation(EmulatorConfig cfg) {
		m_EmulatorConfig = cfg;
	};
	void	RecomputeEmuMixState();		// must be called after SetMixing() and SetEmulation()

	bool	AllocateBuffer(unsigned int Size, uint32_t SampleRate, uint8_t NrChannels);
	Blip_Buffer& GetBuffer() {
		return BlipBuffer;
	}
	void	SetClockRate(uint32_t Rate);
	void	ClearBuffer();
	void FinishBuffer(int t);
	int		SamplesAvail() const;
	void	MixSamples(blip_amplitude_t *pBuffer, uint32_t Count);
	uint32_t	GetMixSampleCount(int t) const;

	void	AddSample(int ChanID, int Value);
	int		ReadBuffer(void *Buffer);

	int32_t	GetChanOutput(uint8_t Chan) const;
	void	SetChipLevel(chip_level_t Chip, double Level);
	uint32_t	ResampleDuration(uint32_t Time) const;

	int		GetMeterDecayRate() const;		// // // 050B
	void	SetMeterDecayRate(int Rate);		// // // 050B

private:
	void StoreChannelLevel(int Channel, int Value);
	void ClearChannelLevels();

	float GetAttenuation(bool UseSurveyMix) const;

private:
	// Pointer to parent/owning CAPU object.
	CAPU * m_APU;

	// Blip buffer object
	Blip_Buffer	BlipBuffer;

	int32_t		m_iChannels[CHANNELS];
	uint8_t		m_iExternalChip;
	uint32_t	m_iSampleRate;

	// channel levels for volume meter
	float		m_fChannelLevels[CHANNELS];
	// volume meter falloff rate
	uint32_t	m_iChanLevelFallOff[CHANNELS];

	int			m_iMeterDecayRate;		// // // 050B
	MixerConfig m_MixerConfig;
	EmulatorConfig m_EmulatorConfig;

	uint8_t m_VRC7PatchSelection;
	uint8_t m_VRC7PatchSet[19 * 8];
	bool m_VRC7PatchUserDefined;

	// device level gain multipliers, in linear scale
	// default level (0dB) is at 1.0
	// TODO: merge this with the one in CAPU
	double		m_ChipLevels[CHIP_LEVEL_COUNT];

	friend class CAPU;
};

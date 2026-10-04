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

#include "SoundChip.h"
#include "APU/digital-sound-antiques/emu2149.h"

class CS5B : public CSoundChip {
public:
	CS5B();
	
	// standard instance methods
	void	Reset() override;
	void	UpdateFilter(blip_eq_t eq) override;
	void	SetClockRate(uint32_t Rate) override;
	void	Write(uint16_t Address, uint8_t Value) override;
	uint8_t	Read(uint16_t Address, bool& Mapped) override;
	void	Log(uint16_t Address, uint8_t Value);
	void	Process(uint32_t Time, Blip_Buffer& Output) override;
	void	EndFrame(Blip_Buffer& Output, gsl::span<int16_t> TempBuffer) override;
	double	GetFreq(int Channel) const override;
	int		GetChannelLevel(int Channel) override;
	int		GetChannelLevelRange(int Channel) const override;
	void	UpdateMixLevel(double v, bool UseSurveyMix);

	// Report some basic information about the chip
	uint8_t GetChannelCount() const override { return 3; };						// TODO: Dynamically calculate this?
	chan_id_t GetFirstChannelID() const override { return CHANID_S5B_CH1; };	//

private:
	// This function takes the 5B channel output from 0-255 and recovers the volume level for the meter
	uint8_t output_to_level(int output) const;

	uint32_t ClocksUntilLevelChange(uint32_t Time);

	// The S5B emulation core (currently emu2149)
	PSG *m_S5B;

	// The audio buffer
	Blip_Buffer	m_BlipS5B;
	Blip_Synth<blip_good_quality> m_SynthS5B;

	uint32_t m_iTime = 0;

	// Three channels for S5B.
	ChannelLevelState<uint8_t> m_ChannelLevels[3];

	uint8_t m_cPort;
};

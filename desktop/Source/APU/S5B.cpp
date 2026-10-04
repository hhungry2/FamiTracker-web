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

#include <algorithm>
#include "APU.h"
#include "S5B.h"
#include "../RegisterState.h"

// Sunsoft 5B chip class

CS5B::CS5B() :
	m_cPort(0)
{
	// Set up the emulation core with parameters
	// clock and rate will be updated in SetClockRate()
	m_S5B = PSG_new(m_BlipS5B.clock_rate(), m_BlipS5B.clock_rate());
	// choose YM2149 mode
	PSG_setClockDivider(m_S5B, 1);
	PSG_setVolumeMode(m_S5B, 1);

	// 5B internal registers
	m_pRegisterLogger->AddRegisterRange(0x00, 0x0F);
}

void CS5B::Reset()
{
	PSG_reset(m_S5B);

	m_SynthS5B.clear();
	m_BlipS5B.clear();
}

void CS5B::UpdateFilter(blip_eq_t eq)
{
	m_SynthS5B.treble_eq(eq);
}

void CS5B::SetClockRate(uint32_t Rate)
{
	m_BlipS5B.clock_rate(Rate);
	PSG_setClock(m_S5B, Rate);
	PSG_setRate(m_S5B, Rate);
}

void CS5B::Write(uint16_t Address, uint8_t Value)
{
	// S5B has an I/O system for setting its internal registers.
	// The currently set port is m_cPort.
	switch (Address) {
	case 0xC000: m_cPort = Value & 0x0F; break;
	case 0xE000: PSG_writeReg(m_S5B, m_cPort, Value); break;
	}
}

uint8_t CS5B::Read(uint16_t Address, bool& Mapped)
{
	// The internal registers are inaccessible to reads.
	Mapped = false;
	return 0;
}

void CS5B::Log(uint16_t Address, uint8_t Value)		// // //
{
	// Despite the write-only registers, inform the register logger of their values anyway.
	switch (Address) {
	case 0xC000: m_pRegisterLogger->SetPort(Value); break;
	case 0xE000: m_pRegisterLogger->Write(Value); break;
	}
}

void CS5B::EndFrame(Blip_Buffer& Output, gsl::span<int16_t>)
{
	m_iTime = 0;
}

// This function takes the 5B channel output from 0-255 and recovers the volume level for the meter
uint8_t CS5B::output_to_level(int output) const
{
	switch (output) {
//  output --> meter level
	case 0x00: return 0x00;
	case 0x01: return 0x01;
	case 0x02: return 0x02;
	case 0x03: 
	case 0x04: return 0x03;
	case 0x05:
	case 0x06: return 0x04;
	case 0x07:
	case 0x09: return 0x05;
	case 0x0B:
	case 0x0D: return 0x06;
	case 0x0F:
	case 0x12: return 0x07;
	case 0x16:
	case 0x1A: return 0x08;
	case 0x1F:
	case 0x25: return 0x09;
	case 0x2D:
	case 0x35: return 0x0A;
	case 0x3F:
	case 0x4C: return 0x0B;
	case 0x5A:
	case 0x6A: return 0x0C;
	case 0x7F:
	case 0x97: return 0x0D;
	case 0xB4:
	case 0xD6: return 0x0E;
	case 0xFF: return 0x0F;
	}
	return 0x00;
}

// based on FT 0.5.0 algorithm
uint32_t CS5B::ClocksUntilLevelChange(uint32_t Time)
{
	uint32_t toneclocks = Time;

	for (int i = 0; i < 3; i++) {
		if (m_S5B->freq[i] > 2 && m_S5B->volume[i])
			toneclocks = m_S5B->freq[i] - m_S5B->count[i];
		Time = std::min(toneclocks, Time);
	}
	if (m_S5B->env_count < m_S5B->env_freq)
		Time = std::min(
			m_S5B->env_freq - m_S5B->env_count,
			Time
		);

	if (m_S5B->noise_count < m_S5B->noise_freq)
		Time = std::min<uint32_t>(
			m_S5B->noise_freq - m_S5B->noise_count,
			Time
		);

	return Time;
}

// Clock the emulation core and output to the buffer.
void CS5B::Process(uint32_t Time, Blip_Buffer& Output)
{
	uint32_t now = 0;

	auto get_output = [this](uint32_t dclocks, uint32_t now, Blip_Buffer& blip_buf) {
		Tick(m_S5B, dclocks);

		int32_t out = PSG_calc(m_S5B);
		m_SynthS5B.update(m_iTime + now, out, &blip_buf);

		m_ChannelLevels[0].update(output_to_level(m_S5B->ch_out[0]));
		m_ChannelLevels[1].update(output_to_level(m_S5B->ch_out[1]));
		m_ChannelLevels[2].update(output_to_level(m_S5B->ch_out[2]));
	};

	while (Time > now) {
		auto dclocks = std::min(ClocksUntilLevelChange(Time), Time - now);
		get_output(dclocks, now, Output);
		now += dclocks;
	}

	m_iTime += Time;
}


double CS5B::GetFreq(int Channel) const		// // //
{
	// Borrowed from old core's calculations.
	switch (Channel) {
	case 0: case 1: case 2:
		if (m_S5B->tmask[Channel] || m_S5B->freq[Channel] == 0) return 0.;
		return CAPU::BASE_FREQ_NTSC / 2. / m_S5B->freq[Channel] / 16.;
	case 3:
		if (m_S5B->env_freq == 0) return 0.;
		if (!m_S5B->env_continue || m_S5B->env_hold) return 0.;
		return CAPU::BASE_FREQ_NTSC / (m_S5B->env_alternate ? 64. : 32.) / m_S5B->env_freq / 16.;
		//case 4: TODO noise refresh rate
	}
	return 20.;
}

int CS5B::GetChannelLevel(int Channel)
{
	return m_ChannelLevels[Channel].getLevel();
}

int CS5B::GetChannelLevelRange(int Channel) const
{
	return 0x0F;
}

void CS5B::UpdateMixLevel(double v, bool UseSurveyMix)
{
	m_SynthS5B.volume(v, UseSurveyMix ? (255 + 255 + 255) : 1200);
}

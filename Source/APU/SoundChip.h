/*
** Dn-FamiTracker - NES/Famicom sound tracker
** Copyright (C) 2020-2025 D.P.C.M.
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

#include "Blip_Buffer/Blip_Buffer.h"

#include "gsl/span"
#include <cstdint>		// // //
#include <memory>
#include "Types.h"

class CRegisterLogger;		// // //
class Blip_Buffer;

class CSoundChip {
public:
	CSoundChip();		// // //
	virtual ~CSoundChip() = default;

	virtual void	Reset() = 0;
	virtual void UpdateFilter(blip_eq_t eq) = 0;

	/// The empty default implementation is sufficient
	/// unless your CSoundChip subclass owns its own Blip_Buffer (not just Blip_Synth).
	///
	/// tbh the proliferation of mutable state with setters is evil,
	/// I'd much rather set clock rate as a constructor parameter
	/// and tear down all sound chips when it changes.
	virtual void SetClockRate(uint32_t Rate) {}

	/// Advance the sound chip emulator.
	///
	/// - Time is the number of clock cycles to advance.
	/// - Output is where audio will be written to.
	virtual void	Process(uint32_t Time, Blip_Buffer& Output) = 0;

	/// Tell the chip that its audio is not going to be heard, as when playback runs up to
	/// a position. While skipping, Process() may take larger steps and leave out what
	/// only the sound needs, such as the exact time of each level change. The chip is in
	/// the state an exact run would have left it in; what it sounds like from then on is
	/// the same, once the filters and the Blip_Buffer's integrator have settled.
	/// Chips that do not implement it stay exact.
	void SetSkipping(bool Skip) { m_bSkipping = Skip; }

	/// End an audio frame/tick.
	/// Each subclass of CSoundChip can choose to write audio to Output
	/// on every call to Process(), or on the final call to EndFrame().
	///
	/// - Output is where audio will be written to.
	/// - TempBuffer can be overwritten freely, and the contents will be discarded
	///   after the function returns.
	virtual void	EndFrame(Blip_Buffer& Output, gsl::span<int16_t> TempBuffer) = 0;

	virtual void	Write(uint16_t Address, uint8_t Value) = 0;
	virtual uint8_t	Read(uint16_t Address, bool &Mapped) = 0;

	// TODO: unify with definitions in DetuneTable.cpp?
	virtual double	GetFreq(int Channel) const;		// // //

	/// Obtain the amplitude range seen by the specified channel
	/// since the previous call to GetChannelLevel() with the same channel.
	/// If the channel has not encountered any deltas since then, returns 0.
	///
	/// This method is called by CMixer.
	/// The return values will near-instantly drop to 0 when a note ends.
	/// CMixer may run a peak follower on the return values
	/// to make the volume meters decay gradually.
	virtual int GetChannelLevel(int Channel)
	{
		return 0;
	}

	/// The largest possible value returned by GetChannelLevel(Channel).
	/// Return 1 instead of 0 for invalid channels, to avoid division-by-0 crashes.
	virtual int GetChannelLevelRange(int Channel) const
	{
		return 1;
	}

	virtual void	Log(uint16_t Address, uint8_t Value);		// // //
	CRegisterLogger *GetRegisterLogger() const;		// // //

	/// Returns the total number of channels that this sound chip has.
	virtual uint8_t GetChannelCount() const = 0; // TODO: Dynamically calculate this?

	/// Get first channel ID
	virtual chan_id_t GetFirstChannelID() const = 0;


protected:
	std::unique_ptr<CRegisterLogger> m_pRegisterLogger;		// // //
	bool m_bSkipping = false;
};

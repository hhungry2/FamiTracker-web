/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

#include "nsf_analyzer.h"

#include "xgm/player/nsf/nsfplay.h"

#include <algorithm>
#include <map>
#include <utility>

namespace dnft {

using namespace xgm;
using nsflog::ChannelFrame;

namespace {

// NSFPlay keeps the state of its chips in protected members. A class derived from a chip
// may name them, and a pointer to such a member reads them on any instance of the chip:
// NSFPlay itself stays as it is.

struct CpuState : NES_CPU {
	// Between two calls of the play routine: the routine returned
	static bool Idle(const NES_CPU &c) { return c.*(&CpuState::breaked); }
	// The next run starts the play routine
	static bool PlayReady(const NES_CPU &c) { return c.*(&CpuState::play_ready); }
	// CPU clocks until the next frame starts (nes_cpu.cpp keeps them with 14 bits of fraction)
	static INT64 ClocksToFrame(const NES_CPU &c) { return (c.*(&CpuState::fclocks_left_in_frame)) >> 14; }
	// The functions km6502 reads and writes the bus with (NES_CPU::Reset() sets its own)
	static void SetHandlers(NES_CPU &c, ReadHandler read, WriteHandler write, void *user) {
		K6502_Context &context = c.*(&CpuState::context);
		context.ReadByte = read;
		context.WriteByte = write;
		context.user = user;
	}
};

struct ApuState : NES_APU {
	// Heard: enabled, the length counter running, a period the sweep unit does not mute
	static bool On(const NES_APU &a, int ch) {
		return (a.*(&ApuState::enable))[ch] && (a.*(&ApuState::length_counter))[ch] > 0 &&
			(a.*(&ApuState::freq))[ch] >= 8 && (a.*(&ApuState::sfreq))[ch] < 0x800;
	}
	// An envelope a write restarted starts from 15 at the frame counter's next clock: the
	// frame is heard at that, not at the level left before
	static int Volume(const NES_APU &a, int ch) {
		if ((a.*(&ApuState::envelope_disable))[ch])
			return (a.*(&ApuState::volume))[ch];
		return (a.*(&ApuState::envelope_write))[ch] ? 15 : (a.*(&ApuState::envelope_counter))[ch];
	}
	static int Duty(const NES_APU &a, int ch) { return (a.*(&ApuState::duty))[ch] & 3; }
	static int Period(const NES_APU &a, int ch) { return (a.*(&ApuState::freq))[ch]; }
};

struct DmcState : NES_DMC {
	static bool TriangleOn(const NES_DMC &d) {
		return (d.*(&DmcState::linear_counter)) > 0 && (d.*(&DmcState::length_counter))[0] > 0 &&
			(d.*(&DmcState::enable))[0] && (d.*(&DmcState::tri_freq)) >= 2;
	}
	static int TrianglePeriod(const NES_DMC &d) { return d.*(&DmcState::tri_freq); }
	static bool NoiseOn(const NES_DMC &d) {
		return (d.*(&DmcState::length_counter))[1] > 0 && (d.*(&DmcState::enable))[1];
	}
	static int NoiseVolume(const NES_DMC &d) {
		if (d.*(&DmcState::envelope_disable))
			return d.*(&DmcState::noise_volume);
		return (d.*(&DmcState::envelope_write)) ? 15 : (d.*(&DmcState::envelope_counter));
	}
	static int Reg(const NES_DMC &d, unsigned adr) { return (d.*(&DmcState::reg))[adr - 0x4008]; }
	static unsigned Remaining(const NES_DMC &d) { return d.*(&DmcState::dlength); }
	static unsigned Address(const NES_DMC &d) { return 0xC000 | ((d.*(&DmcState::adr_reg)) << 6); }
	static unsigned Length(const NES_DMC &d) { return ((d.*(&DmcState::len_reg)) << 4) + 1; }
};

struct Vrc6State : NES_VRC6 {
	static bool On(const NES_VRC6 &v, int ch) { return (v.*(&Vrc6State::enable))[ch] != 0; }
	static int Volume(const NES_VRC6 &v, int ch) { return (v.*(&Vrc6State::volume))[ch]; }
	static int Duty(const NES_VRC6 &v, int ch) { return (v.*(&Vrc6State::duty))[ch] | ((v.*(&Vrc6State::gate))[ch] ? 0x80 : 0); }
	static int Period(const NES_VRC6 &v, int ch) { return (v.*(&Vrc6State::freq))[ch]; }
};

struct Mmc5State : NES_MMC5 {
	static bool On(const NES_MMC5 &m, int ch) {
		return (m.*(&Mmc5State::enable))[ch] && (m.*(&Mmc5State::length_counter))[ch] > 0;
	}
	static int Volume(const NES_MMC5 &m, int ch) {
		if ((m.*(&Mmc5State::envelope_disable))[ch])
			return (m.*(&Mmc5State::volume))[ch];
		return (m.*(&Mmc5State::envelope_write))[ch] ? 15 : (m.*(&Mmc5State::envelope_counter))[ch];
	}
	static int Duty(const NES_MMC5 &m, int ch) { return (m.*(&Mmc5State::duty))[ch] & 3; }
	static int Period(const NES_MMC5 &m, int ch) { return (m.*(&Mmc5State::freq))[ch]; }
};

struct FdsState : NES_FDS {
	// wave[] and freq[]: 0 the modulator, 1 the wave (nes_fds.h's TMOD, TWAV); env_out[]:
	// 0 the modulation depth, 1 the volume (EMOD, EVOL)
	static bool On(const NES_FDS &f) { return !(f.*(&FdsState::wav_halt)) && (f.*(&FdsState::freq))[1] > 0; }
	static int Gain(const NES_FDS &f) { return (f.*(&FdsState::env_out))[1]; }
	static int MasterVolume(const NES_FDS &f) { return f.*(&FdsState::master_vol); }
	static int Frequency(const NES_FDS &f) { return (f.*(&FdsState::freq))[1]; }
	static int Sample(const NES_FDS &f, int i) { return (f.*(&FdsState::wave))[1][i]; }
	static bool ModHalted(const NES_FDS &f) { return f.*(&FdsState::mod_halt); }
	static int ModFrequency(const NES_FDS &f) { return (f.*(&FdsState::freq))[0]; }
	static int ModDepth(const NES_FDS &f) { return (f.*(&FdsState::env_out))[0]; }
};

struct MemState : NES_MEM {
	static UINT8 *Image(NES_MEM &m) { return m.*(&MemState::image); }
};

struct N106State : NES_N106 {
	static int Reg(const NES_N106 &n, int i) { return (n.*(&N106State::reg))[i & 0x7F] & 0xFF; }
	static int Select(const NES_N106 &n) { return n.*(&N106State::reg_select); }
	static int Channels(const NES_N106 &n) { return ((Reg(n, 0x7F) >> 4) & 7) + 1; }
	// A 4-bit sample of the RAM, the first of a byte in its low bits
	static int Sample(const NES_N106 &n, int i) {
		const int b = Reg(n, (i & 0xFF) >> 1);
		return (i & 1) ? b >> 4 : b & 0x0F;
	}
};

// Numbers the distinct tables of a kind, as they turn up
template <typename Key>
class Interned {
public:
	uint16_t Get(const Key &key, std::vector<Key> &list) {
		auto it = m_Ids.find(key);
		if (it != m_Ids.end())
			return it->second;
		if (list.size() >= nsflog::NO_REF)
			return nsflog::NO_REF;
		const uint16_t id = static_cast<uint16_t>(list.size());
		list.push_back(key);
		m_Ids.emplace(key, id);
		return id;
	}

private:
	std::map<Key, uint16_t> m_Ids;
};

// A play routine that has not returned for this many frames' worth of clocks is stuck
const int STALL_FRAMES = 8;
// CPU clocks run at a time while the play routine runs: the chips catch up after each
// run, so a write that depends on how far a chip got (a sample restarted when the last
// one ended) sees it at most this late
const int BUSY_CLOCKS = 32;
const int IDLE_CLOCKS = 4096;

} // namespace

// ---- the logger NSFPlay calls on every write and every play routine call ---------------

struct NsfAnalysis::Impl {
	// The CPU logger NSFPlay attaches in front of the bus when its LOG_CPU setting is on
	class Capture : public CPULogger {
	public:
		explicit Capture(Impl &owner) : m_Owner(owner) { }
		void Reset() override { }
		bool Write(UINT32 adr, UINT32 val, UINT32 id) override {
			m_Owner.OnWrite(adr, val & 0xFF);
			return false;
		}
		bool Read(UINT32 adr, UINT32 &val, UINT32 id) override { return false; }
		void Begin(const char *title) override { }
		void Init(UINT8 a, UINT8 x) override { }
		void Play() override { m_Owner.OnPlay(); }

	private:
		Impl &m_Owner;
	};

	// The bus the CPU uses once the init routine ran. NSFPlay's asks its devices in turn
	// until one answers, every chip before the memory, which made the CPU's reads most of
	// the analysis's time. No chip answers for the RAM nor for reads from $6000 up (the
	// program, WRAM, the FDS's RAM), so those go to the memory at once; the rest, and every
	// write but to the RAM, go to NSFPlay's bus as before.
	class FastBus : public IDevice {
	public:
		explicit FastBus(Impl &owner) : m_Owner(owner) { }
		void Reset() override { }
		bool Read(UINT32 adr, UINT32 &val, UINT32 id) override {
			NSFPlayer &p = m_Owner.player;
			if (adr < 0x2000) {
				val = MemState::Image(p.mem)[adr & 0x7FF];
				return true;
			}
			if (adr >= 0x6000 && adr < 0xFFF0) {	// NSF2's vectors live in front of the memory
				if (m_Owner.banked && p.bank.NES_BANK::Read(adr, val))
					return true;
				val = MemState::Image(p.mem)[adr];
				return true;
			}
			return p.stack.Read(adr, val, id);
		}
		bool Write(UINT32 adr, UINT32 val, UINT32 id) override {
			if (adr < 0x2000) {
				MemState::Image(m_Owner.player.mem)[adr & 0x7FF] = static_cast<UINT8>(val);
				return true;
			}
			return m_Owner.player.stack.Write(adr, val, id);
		}

		// What km6502 calls, without NES_CPU's Read() and Write() in between
		static Uword Callback ReadByte(void *user, Uword adr) {
			UINT32 val = 0;
			static_cast<FastBus *>(user)->FastBus::Read(adr, val, 0);
			return val;
		}
		static void Callback WriteByte(void *user, Uword adr, Uword val) {
			static_cast<FastBus *>(user)->FastBus::Write(adr, val, 0);
		}

	private:
		Impl &m_Owner;
	};

	NSF nsf;
	NSFPlayerConfig config;
	NSFPlayer player;
	FastBus bus { *this };
	bool banked = false;		// the NSF switches banks (NSFPlayer attaches NES_BANK)
	bool loaded = false;
	bool started = false;
	bool stuck = false;
	int maxFrames = 0;
	int frames = 0;				// frames started (calls of the play routine)
	bool pending = false;		// the frame started has not been written down yet
	INT64 clocksSincePlay = 0;
	INT64 clocksPerFrame = 0;

	nsflog::Log log;
	// where each chip's channels begin in a frame's records, -1 when the NSF lacks it
	int apuBase = 0, vrc6Base = -1, vrc7Base = -1, fdsBase = -1, mmc5Base = -1, n163Base = -1, s5bBase = -1;
	std::vector<uint8_t> events;	// flags the writes since the last record set, by channel

	// the 2A03 pulses' sweep registers ($4001, $4005)
	uint8_t sweep[2] = { };
	// what the writes since the last record were (Log::writes)
	uint32_t writeHash = 2166136261u;
	// DPCM
	uint16_t dpcmSample = nsflog::NO_REF;
	uint8_t dpcmDelta = 0;
	// VRC7 and 5B registers, kept from the writes
	uint8_t vrc7Latch = 0;
	uint8_t vrc7Reg[0x40] = { };
	uint8_t s5bLatch = 0;
	uint8_t s5bReg[0x10] = { };
	// the FDS modulation table, from the writes since the modulator was halted
	uint8_t fdsMod[32] = { };
	int fdsModWrites = 0;
	uint16_t fdsModId = nsflog::NO_REF;

	Interned<std::vector<uint8_t>> samples, fdsWaves, fdsMods, vrc7Patches;
	std::map<std::pair<uint8_t, std::vector<uint8_t>>, uint16_t> n163WaveIds;

	uint16_t N163Wave(uint8_t position, std::vector<uint8_t> samples) {
		auto key = std::make_pair(position, std::move(samples));
		auto it = n163WaveIds.find(key);
		if (it != n163WaveIds.end())
			return it->second;
		if (log.n163Waves.size() >= nsflog::NO_REF)
			return nsflog::NO_REF;
		const uint16_t id = static_cast<uint16_t>(log.n163Waves.size());
		log.n163Waves.push_back({ key.first, key.second });
		n163WaveIds.emplace(std::move(key), id);
		return id;
	}

	// The sample the DMC is about to play, as the bus reads it now
	uint16_t CaptureSample() {
		unsigned address = DmcState::Address(*player.dmc);
		const unsigned length = DmcState::Length(*player.dmc);
		std::vector<uint8_t> bytes(length);
		for (unsigned i = 0; i < length; ++i) {
			UINT32 value = 0;
			player.layer.Read(address, value);
			bytes[i] = static_cast<uint8_t>(value);
			address = ((address + 1) & 0xFFFF) | 0x8000;
		}
		return samples.Get(bytes, log.samples);
	}

	// A register of a chip the NSF has (the FDS makes $6000-$DFFF RAM, so the other chips'
	// addresses count only with them)
	bool SoundRegister(unsigned adr) const {
		return (adr >= 0x4000 && adr <= 0x4017) ||
			(fdsBase >= 0 && adr >= 0x4040 && adr <= 0x408A) ||
			(n163Base >= 0 && (adr == 0x4800 || adr == 0xF800)) ||
			(mmc5Base >= 0 && adr >= 0x5000 && adr <= 0x5015) ||
			(vrc6Base >= 0 && ((adr >= 0x9000 && adr <= 0x9003) || (adr >= 0xA000 && adr <= 0xA002) || (adr >= 0xB000 && adr <= 0xB002))) ||
			(vrc7Base >= 0 && (adr == 0x9010 || adr == 0x9030)) ||
			(s5bBase >= 0 && (adr == 0xC000 || adr == 0xE000));
	}

	void OnWrite(unsigned adr, unsigned val) {
		if (SoundRegister(adr))
			writeHash = (writeHash ^ (adr << 8 | val)) * 16777619u;
		switch (adr) {
		case 0x4001: case 0x4005:
			sweep[(adr - 0x4001) / 4] = static_cast<uint8_t>(val);
			return;
		case 0x4003: case 0x4007:
			events[apuBase + (adr - 0x4003) / 4] |= nsflog::TRIGGER;
			return;
		case 0x400B:
			events[apuBase + 2] |= nsflog::TRIGGER;
			return;
		case 0x400F:
			events[apuBase + 3] |= nsflog::TRIGGER;
			return;
		case 0x4011:
			events[apuBase + 4] |= nsflog::DELTA;
			dpcmDelta = val & 0x7F;
			return;
		case 0x4015:
			// NES_DMC starts a sample when bit 4 is written while none plays, and stops
			// the one playing when it is cleared
			if ((val & 0x10) && DmcState::Remaining(*player.dmc) == 0) {
				dpcmSample = CaptureSample();
				events[apuBase + 4] |= nsflog::TRIGGER;
			}
			else if (!(val & 0x10) && DmcState::Remaining(*player.dmc) > 0)
				events[apuBase + 4] |= nsflog::STOP;
			return;
		}
		if (vrc6Base >= 0 && (adr == 0x9002 || adr == 0xA002 || adr == 0xB002)) {
			const int ch = (adr >> 12) - 9;
			if ((val & 0x80) && !Vrc6State::On(*player.vrc6, ch))	// enabling resets the phase
				events[vrc6Base + ch] |= nsflog::TRIGGER;
			return;
		}
		if (mmc5Base >= 0 && (adr == 0x5003 || adr == 0x5007)) {
			events[mmc5Base + (adr - 0x5003) / 4] |= nsflog::TRIGGER;
			return;
		}
		if (vrc7Base >= 0 && (adr == 0x9010 || adr == 0x9030)) {
			if (adr == 0x9010) {
				vrc7Latch = val & 0x3F;
				return;
			}
			const uint8_t old = vrc7Reg[vrc7Latch];
			vrc7Reg[vrc7Latch] = static_cast<uint8_t>(val);
			if (vrc7Latch >= 0x20 && vrc7Latch < 0x26 && (val & 0x10) && !(old & 0x10))
				events[vrc7Base + vrc7Latch - 0x20] |= nsflog::TRIGGER;
			return;
		}
		if (fdsBase >= 0 && adr >= 0x4080 && adr <= 0x408A) {
			if (adr == 0x4083 && (val & 0x80))		// halting the wave resets its phase
				events[fdsBase] |= nsflog::TRIGGER;
			else if (adr == 0x4087 && (val & 0x80))
				fdsModWrites = 0;
			else if (adr == 0x4088 && FdsState::ModHalted(*player.fds)) {
				fdsMod[fdsModWrites % 32] = val & 7;
				if (++fdsModWrites % 32 == 0)
					fdsModId = fdsMods.Get(std::vector<uint8_t>(fdsMod, fdsMod + 32), log.fdsMods);
			}
			return;
		}
		if (n163Base >= 0 && adr == 0x4800) {
			// writing a channel's phase resets it
			const int reg = N106State::Select(*player.n106);
			const int r = reg & 7;
			if (reg >= 0x40 && (r == 1 || r == 3 || r == 5))
				events[n163Base + 15 - reg / 8] |= nsflog::TRIGGER;
			return;
		}
		if (s5bBase >= 0 && (adr == 0xC000 || adr == 0xE000)) {
			if (adr == 0xC000) {
				s5bLatch = val & 0x0F;
				return;
			}
			s5bReg[s5bLatch] = static_cast<uint8_t>(val);
			if (s5bLatch == 13)
				for (int i = 0; i < 3; ++i)
					events[s5bBase + i] |= nsflog::ENVELOPE;
			return;
		}
	}

	void OnPlay() {
		// a routine that never returns (NSF2's) is written down when the next one begins
		if (pending)
			Record();
		else
			Gate();
		if (frames < maxFrames) {
			++frames;
			pending = true;
		}
		clocksSincePlay = 0;
	}

	// The channels the frame counter's clocks start and stop (the length counters, the
	// triangle's linear counter, the sweep's muting) as they are at the end of the frame:
	// a write that silences one takes effect at the next clock, after the play routine
	// returned, and a note written in a frame should start in that frame's record.
	void Gate() {
		const size_t frames = log.FrameCount();
		if (!frames)
			return;
		ChannelFrame *out = &log.frames[(frames - 1) * log.channels.size()];
		auto set = [](ChannelFrame &f, bool on) {
			f.flags = static_cast<uint8_t>(on ? (f.flags | nsflog::ON) : (f.flags & ~nsflog::ON));
		};
		for (int ch = 0; ch < 2; ++ch)
			set(out[apuBase + ch], ApuState::On(*player.apu, ch));
		set(out[apuBase + 2], DmcState::TriangleOn(*player.dmc));
		out[apuBase + 2].volume = (out[apuBase + 2].flags & nsflog::ON) ? 15 : 0;
		set(out[apuBase + 3], DmcState::NoiseOn(*player.dmc));
		if (mmc5Base >= 0)
			for (int ch = 0; ch < 2; ++ch)
				set(out[mmc5Base + ch], Mmc5State::On(*player.mmc5, ch));
	}

	// One frame's records: the state the chips are in now, and what the writes did
	void Record() {
		pending = false;
		const size_t base = log.frames.size();
		log.frames.resize(base + log.channels.size(), ChannelFrame { 0, 0, 0, 0, 0, nsflog::NO_REF, nsflog::NO_REF, 0, 0 });
		ChannelFrame *out = &log.frames[base];

		const NES_APU &apu = *player.apu;
		for (int ch = 0; ch < 2; ++ch) {
			ChannelFrame &f = out[apuBase + ch];
			f.flags = ApuState::On(apu, ch) ? nsflog::ON : 0;
			f.volume = static_cast<uint8_t>(ApuState::Volume(apu, ch));
			f.timbre = static_cast<uint8_t>(ApuState::Duty(apu, ch));
			f.pitch = ApuState::Period(apu, ch);
			f.aux16a = sweep[ch];
		}
		const NES_DMC &dmc = *player.dmc;
		{
			ChannelFrame &f = out[apuBase + 2];
			const bool on = DmcState::TriangleOn(dmc);
			f.flags = on ? nsflog::ON : 0;
			f.volume = on ? 15 : 0;
			f.pitch = DmcState::TrianglePeriod(dmc);
		}
		{
			ChannelFrame &f = out[apuBase + 3];
			f.flags = DmcState::NoiseOn(dmc) ? nsflog::ON : 0;
			f.volume = static_cast<uint8_t>(DmcState::NoiseVolume(dmc));
			f.timbre = (DmcState::Reg(dmc, 0x400E) >> 7) & 1;
			f.pitch = DmcState::Reg(dmc, 0x400E) & 0x0F;
		}
		{
			ChannelFrame &f = out[apuBase + 4];
			f.flags = DmcState::Remaining(dmc) > 0 ? nsflog::ON : 0;
			f.volume = 15;
			f.pitch = DmcState::Reg(dmc, 0x4010) & 0x0F;
			f.ref = dpcmSample;
			f.ref2 = (DmcState::Reg(dmc, 0x4010) & 0x40) ? 0x80 : 0;
			f.aux8 = dpcmDelta;
		}

		if (vrc6Base >= 0) {
			const NES_VRC6 &vrc6 = *player.vrc6;
			for (int ch = 0; ch < 3; ++ch) {
				ChannelFrame &f = out[vrc6Base + ch];
				f.flags = Vrc6State::On(vrc6, ch) ? nsflog::ON : 0;
				f.volume = static_cast<uint8_t>(Vrc6State::Volume(vrc6, ch));
				f.timbre = ch < 2 ? static_cast<uint8_t>(Vrc6State::Duty(vrc6, ch)) : 0;
				f.pitch = Vrc6State::Period(vrc6, ch);
			}
		}

		if (vrc7Base >= 0) {
			const std::vector<uint8_t> custom(vrc7Reg, vrc7Reg + 8);
			for (int ch = 0; ch < 6; ++ch) {
				ChannelFrame &f = out[vrc7Base + ch];
				const uint8_t r20 = vrc7Reg[0x20 + ch];
				const uint8_t r30 = vrc7Reg[0x30 + ch];
				f.flags = ((r20 & 0x10) ? nsflog::ON : 0) | ((r20 & 0x20) ? nsflog::SUSTAIN : 0);
				f.volume = 15 - (r30 & 0x0F);
				f.timbre = r30 >> 4;
				f.pitch = ((r20 >> 1) & 7) << 9 | (r20 & 1) << 8 | vrc7Reg[0x10 + ch];
				if (f.timbre == 0)
					f.ref = vrc7Patches.Get(custom, log.vrc7Patches);
			}
		}

		if (fdsBase >= 0) {
			const NES_FDS &fds = *player.fds;
			ChannelFrame &f = out[fdsBase];
			f.flags = FdsState::On(fds) ? nsflog::ON : 0;
			f.volume = static_cast<uint8_t>(std::min(FdsState::Gain(fds), 63));
			f.aux8 = static_cast<uint8_t>(FdsState::MasterVolume(fds));
			f.pitch = FdsState::Frequency(fds);
			std::vector<uint8_t> wave(64);
			for (int i = 0; i < 64; ++i)
				wave[i] = static_cast<uint8_t>(FdsState::Sample(fds, i) & 0x3F);
			f.ref = fdsWaves.Get(wave, log.fdsWaves);
			f.ref2 = fdsModId;
			f.aux16a = static_cast<uint16_t>(FdsState::ModFrequency(fds) | (FdsState::ModHalted(fds) ? 0x8000 : 0));
			f.aux16b = static_cast<uint16_t>(std::min(FdsState::ModDepth(fds), 63));
		}

		if (mmc5Base >= 0) {
			const NES_MMC5 &mmc5 = *player.mmc5;
			for (int ch = 0; ch < 2; ++ch) {
				ChannelFrame &f = out[mmc5Base + ch];
				f.flags = Mmc5State::On(mmc5, ch) ? nsflog::ON : 0;
				f.volume = static_cast<uint8_t>(Mmc5State::Volume(mmc5, ch));
				f.timbre = static_cast<uint8_t>(Mmc5State::Duty(mmc5, ch));
				f.pitch = Mmc5State::Period(mmc5, ch);
			}
		}

		if (n163Base >= 0) {
			const NES_N106 &n163 = *player.n106;
			const int channels = N106State::Channels(n163);
			for (int ch = 0; ch < 8; ++ch) {
				ChannelFrame &f = out[n163Base + ch];
				const int reg = 0x78 - 8 * ch;
				const uint32_t freq = N106State::Reg(n163, reg) | N106State::Reg(n163, reg + 2) << 8 |
					(N106State::Reg(n163, reg + 4) & 3) << 16;
				const bool on = ch < channels && freq > 0;
				f.flags = on ? nsflog::ON : 0;
				f.volume = static_cast<uint8_t>(N106State::Reg(n163, reg + 7) & 0x0F);
				f.pitch = freq;
				if (on) {
					const int position = N106State::Reg(n163, reg + 6);
					const int length = 256 - (N106State::Reg(n163, reg + 4) & 0xFC);
					std::vector<uint8_t> wave(length);
					for (int i = 0; i < length; ++i)
						wave[i] = static_cast<uint8_t>(N106State::Sample(n163, position + i));
					f.ref = N163Wave(static_cast<uint8_t>(position), std::move(wave));
					f.aux8 = static_cast<uint8_t>(position);
					log.n163Channels = std::max<uint8_t>(log.n163Channels, static_cast<uint8_t>(channels));
				}
			}
		}

		if (s5bBase >= 0) {
			const uint16_t envelope = s5bReg[11] | s5bReg[12] << 8;
			const uint16_t shapeNoise = static_cast<uint16_t>((s5bReg[13] & 0x0F) | (s5bReg[6] & 0x1F) << 8);
			for (int ch = 0; ch < 3; ++ch) {
				ChannelFrame &f = out[s5bBase + ch];
				const bool tone = !((s5bReg[7] >> ch) & 1);
				const bool noise = !((s5bReg[7] >> (3 + ch)) & 1);
				const int level = s5bReg[8 + ch];
				const bool env = (level & 0x10) != 0;
				f.flags = ((tone || noise) && (env || (level & 0x0F))) ? nsflog::ON : 0;
				f.volume = level & 0x0F;
				f.timbre = static_cast<uint8_t>((tone ? 1 : 0) | (noise ? 2 : 0) | (env ? 4 : 0));
				f.pitch = s5bReg[2 * ch] | (s5bReg[2 * ch + 1] & 0x0F) << 8;
				f.aux16a = envelope;
				f.aux16b = shapeNoise;
			}
		}

		for (size_t i = 0; i < log.channels.size(); ++i) {
			out[i].flags |= events[i];
			events[i] = 0;
		}
		log.writes.push_back(writeHash);
		writeHash = 2166136261u;
	}
};

// ---- the analysis ---------------------------------------------------------------------

NsfAnalysis::NsfAnalysis() : m_pImpl(new Impl) {
	// The CPU logger is the analysis's own; NSFPlay attaches it when its setting is on
	delete m_pImpl->player.logcpu;
	m_pImpl->player.logcpu = new Impl::Capture(*m_pImpl);
}

NsfAnalysis::~NsfAnalysis() = default;

bool NsfAnalysis::Load(const uint8_t *data, size_t size) {
	Impl &d = *m_pImpl;
	// NSF::Load() copies what it keeps
	std::vector<uint8_t> image(data, data + size);
	if (!d.nsf.Load(image.data(), static_cast<UINT32>(image.size()))) {
		m_sError = d.nsf.LoadError();
		if (m_sError.empty())
			m_sError = "not an NSF";
		return false;
	}
	d.loaded = true;
	return true;
}

bool NsfAnalysis::Start(int song, int region, int maxFrames) {
	Impl &d = *m_pImpl;
	if (!d.loaded || d.started)
		return false;
	NSF &nsf = d.nsf;
	if (song < 0 || song >= nsf.total_songs)
		return false;

	NSFPlayerConfig &config = d.config;
	config["LOG_CPU"] = 1;			// attach the logger
	config["NSFE_PLAYLIST"] = 0;	// songs by their numbers
	config["REGION"] = region == 0 ? 4 : region == 1 ? 5 : 0;
	config["APU2_OPTION5"] = 0;		// no random noise or triangle phase at reset
	config["APU2_OPTION7"] = 0;
	d.player.SetConfig(&config);
	d.player.Load(&nsf);
	d.player.SetPlayFreq(48000);
	d.player.SetChannels(1);
	d.player.SetSong(song);

	// The channels the NSF's chips have
	nsflog::Log &log = d.log;
	auto add = [&log](nsflog::Chip chip, int count) {
		const int base = static_cast<int>(log.channels.size());
		for (int i = 0; i < count; ++i)
			log.channels.push_back({ static_cast<uint8_t>(chip), static_cast<uint8_t>(i) });
		return base;
	};
	d.apuBase = add(nsflog::APU, 5);
	if (nsf.use_vrc6) d.vrc6Base = add(nsflog::VRC6, 3);
	if (nsf.use_vrc7) d.vrc7Base = add(nsflog::VRC7, 6);
	if (nsf.use_fds) d.fdsBase = add(nsflog::FDS, 1);
	if (nsf.use_mmc5) d.mmc5Base = add(nsflog::MMC5, 2);
	if (nsf.use_n106) d.n163Base = add(nsflog::N163, 8);
	if (nsf.use_fme7) d.s5bBase = add(nsflog::S5B, 3);
	d.events.assign(log.channels.size(), 0);

	d.maxFrames = std::max(0, maxFrames);
	d.started = true;
	// Runs the init routine; the logger hears its writes
	d.player.Reset();
	// NSFPlayer::Reload() attaches the banks when any of the header's bytes is set
	d.banked = std::any_of(nsf.bankswitch, nsf.bankswitch + 8, [](UINT8 b) { return b != 0; });
	d.player.cpu.SetMemory(&d.bus);
	CpuState::SetHandlers(d.player.cpu, &Impl::FastBus::ReadByte, &Impl::FastBus::WriteByte, &d.bus);

	const int played = d.player.GetRegion(nsf.regn, nsf.regn_pref);
	log.region = static_cast<uint8_t>(played);
	log.chips = nsf.soundchip;
	log.period = played == NSFPlayer::REGION_PAL ? nsf.speed_pal : played == NSFPlayer::REGION_DENDY ? nsf.speed_dendy : nsf.speed_ntsc;
	log.song = static_cast<uint8_t>(song);
	log.songs = nsf.total_songs;
	log.title = nsf.title ? nsf.title : "";
	log.artist = nsf.artist ? nsf.artist : "";
	log.copyright = nsf.copyright ? nsf.copyright : "";
	if (song < static_cast<int>(NSFE_ENTRIES) && nsf.nsfe_entry[song].tlbl)
		log.trackTitle = nsf.nsfe_entry[song].tlbl;
	d.clocksPerFrame = static_cast<INT64>(d.player.cpu.nes_basecycles * log.period / 1000000.0);
	if (d.clocksPerFrame <= 0)
		d.clocksPerFrame = 29781;
	return true;
}

int NsfAnalysis::Run(int count) {
	Impl &d = *m_pImpl;
	if (!d.started)
		return 0;
	NSFPlayer &p = d.player;
	const int target = std::min(d.maxFrames, d.frames + std::max(0, count));
	while (!d.stuck) {
		// the frame being played is written down when its play routine returns
		if (d.pending && CpuState::Idle(p.cpu))
			d.Record();
		if (!d.pending && d.frames >= target)
			break;
		int clocks = BUSY_CLOCKS;
		if (!d.pending && !CpuState::PlayReady(p.cpu)) {
			// nothing runs until the next frame: go there at once
			const INT64 rest = CpuState::ClocksToFrame(p.cpu);
			clocks = static_cast<int>(std::clamp<INT64>(rest, 1, IDLE_CLOCKS));
		}
		const int done = p.cpu.Exec(clocks);
		// what NSFPlay's rate converter does after the CPU ran (RateConverter::ClockCPU())
		p.dmc->TickFrameSequence(done);
		if (d.mmc5Base >= 0)
			p.mmc5->TickFrameSequence(done);
		// the chips whose state depends on time; the others only keep their registers
		p.apu->Tick(done);
		p.dmc->Tick(done);
		if (d.fdsBase >= 0)
			p.fds->Tick(done);
		if (d.mmc5Base >= 0)
			p.mmc5->Tick(done);
		d.clocksSincePlay += done;
		if (d.clocksSincePlay > d.clocksPerFrame * STALL_FRAMES) {
			// no play routine began for a long time: it never returns, nor does anything
			// call it again
			if (d.pending)
				d.Record();
			d.stuck = true;
		}
	}
	return GetFrameCount();
}

bool NsfAnalysis::IsDone() const {
	const Impl &d = *m_pImpl;
	return d.started && (d.stuck || (d.frames >= d.maxFrames && !d.pending));
}

int NsfAnalysis::GetFrameCount() const {
	return static_cast<int>(m_pImpl->log.FrameCount());
}

std::vector<uint8_t> NsfAnalysis::GetLog() const {
	return nsflog::Write(m_pImpl->log);
}

// ---- NSFPlay's own playing ---------------------------------------------------------------

std::vector<int16_t> RenderNsf(const uint8_t *data, size_t size, int song, double seconds, int rate, int mask) {
	auto nsf = std::make_unique<NSF>();
	std::vector<uint8_t> image(data, data + size);
	if (!nsf->Load(image.data(), static_cast<UINT32>(image.size())) || song < 0 || song >= nsf->total_songs)
		return { };
	auto config = std::make_unique<NSFPlayerConfig>();
	(*config)["NSFE_PLAYLIST"] = 0;
	(*config)["MASK"] = mask;
	(*config)["APU2_OPTION5"] = 0;		// no random noise or triangle phase at reset
	(*config)["APU2_OPTION7"] = 0;
	(*config)["AUTO_STOP"] = 0;
	(*config)["PLAY_TIME"] = static_cast<int>(seconds * 1000) + 10000;	// no fade before the end
	auto player = std::make_unique<NSFPlayer>();
	player->SetConfig(config.get());
	player->Load(nsf.get());
	player->SetPlayFreq(rate);
	player->SetChannels(1);
	player->SetSong(song);
	player->Reset();
	std::vector<int16_t> out(static_cast<size_t>(std::max(0., seconds) * rate));
	if (!out.empty())
		player->Render(reinterpret_cast<INT16 *>(out.data()), static_cast<UINT32>(out.size()));
	player.reset();
	return out;
}

// ---- the file's header -------------------------------------------------------------------

NsfInfo ReadNsfInfo(const uint8_t *data, size_t size) {
	NsfInfo info;
	NSF nsf;
	std::vector<uint8_t> image(data, data + size);
	if (!nsf.Load(image.data(), static_cast<UINT32>(image.size()))) {
		info.error = nsf.LoadError();
		if (info.error.empty())
			info.error = "not an NSF";
		return info;
	}
	info.title = nsf.title ? nsf.title : "";
	info.artist = nsf.artist ? nsf.artist : "";
	info.copyright = nsf.copyright ? nsf.copyright : "";
	info.ripper = nsf.ripper ? nsf.ripper : "";
	info.version = nsf.version;
	info.songs = nsf.total_songs;
	info.start = std::clamp(nsf.start - 1, 0, std::max(0, info.songs - 1));
	info.chips = nsf.soundchip & 0x3F;
	info.regions = nsf.regn;
	info.preferred = std::max(0, nsf.regn_pref);
	info.nsfe = std::string(nsf.magic, 4) == "NSFE";
	info.periodNtsc = nsf.speed_ntsc;
	info.periodPal = nsf.speed_pal;
	for (int i = 0; i < info.songs && i < static_cast<int>(NSFE_ENTRIES); ++i) {
		NsfTrack track;
		track.title = nsf.nsfe_entry[i].tlbl ? nsf.nsfe_entry[i].tlbl : "";
		track.time = nsf.nsfe_entry[i].time;
		track.fade = nsf.nsfe_entry[i].fade;
		info.tracks.push_back(std::move(track));
	}
	return info;
}

} // namespace dnft

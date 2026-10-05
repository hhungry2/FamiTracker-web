// Direct decoding of the Dn-FT 2.16 export format (Issue #14).
// Source of truth: desktop/Source/{Compiler,PatternCompiler,SeqInstrument,
// InstrumentFDS,InstrumentN163,InstrumentVRC7}.cpp and drivers/asm/.
// No 6502 code is executed. A matched driver is necessary, then every pointer,
// count and compressed row is checked before the current document is replaced.
import { CELL, NOTE, NO_INSTRUMENT, HOLD_INSTRUMENT, emptyPattern } from './dnft-song.mjs';
import { MAX_NSF_TRACKS, nsfRegion } from './dnft-nsf-import.mjs';

export class NsfDriverError extends Error {
  constructor(message) { super(message); this.name = 'NsfDriverError'; }
}
const require = (condition, message) => { if (!condition) throw new NsfDriverError(message); };
const word = (bytes, at) => bytes[at] | bytes[at + 1] << 8;
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const tag = (bytes, at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
const TYPES = { 0: { chip: 0, type: 1 }, 4: { chip: 1, type: 2 }, 6: { chip: 2, type: 3 },
  7: { chip: 4, type: 4 }, 9: { chip: 16, type: 5 }, 10: { chip: 32, type: 6 } };
const TABLE_TYPES = { NTSC: 0, PAL: 1, SAW: 2, VRC7: 3, FDS: 4, N163: 5 };
const cachedProfiles = new WeakMap();

function profileBytes(profile) {
  if (!cachedProfiles.has(profile))
    cachedProfiles.set(profile, Uint8Array.from(profile.code.match(/../g), h => parseInt(h, 16)));
  return cachedProfiles.get(profile);
}

// Addresses map through the eight initial NSF banks, with the driver's $B000
// pattern window and $C000-$EFFF sample window overridden only when requested.
export function nsfDriverMemory(bytes) {
  require(bytes instanceof Uint8Array, 'invalid NSF bytes');
  let data, load, init, play, chips, songs, banks = new Uint8Array(8), opll = null;
  if (tag(bytes, 0, 5) === 'NESM\x1a') {
    require(bytes.length >= 128, 'truncated NSF header');
    require((bytes[5] === 1 || bytes[5] === 2) && !(bytes[0x7C] & 127), 'unsupported NSF execution flags');
    load = word(bytes, 8); init = word(bytes, 10); play = word(bytes, 12);
    chips = bytes[0x7B]; songs = bytes[6]; banks = bytes.slice(0x70, 0x78);
    const size = bytes[0x7D] | bytes[0x7E] << 8 | bytes[0x7F] << 16;
    require(!size || size <= bytes.length - 128, 'truncated NSF data');
    data = bytes.subarray(128, size ? 128 + size : bytes.length);
    if (bytes[5] === 2 && bytes[0x7C] & 128) {
      require(size > 0, 'missing NSF2 data length');
      for (let at = 128 + size; at < bytes.length;) {
        require(at + 8 <= bytes.length, 'truncated NSF2 metadata');
        const length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
        require(length <= bytes.length - at - 8, 'truncated NSF2 chunk');
        if (tag(bytes, at + 4, 4) === 'VRC7') opll = bytes.slice(at + 8, at + 8 + length);
        at += 8 + length;
      }
    }
  } else if (tag(bytes, 0, 4) === 'NSFE') {
    let end = false;
    const chunks = new Map();
    for (let at = 4; at < bytes.length;) {
      require(at + 8 <= bytes.length, 'truncated NSFe chunk');
      const size = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
      const name = tag(bytes, at + 4, 4);
      require(!/^[A-Z]/.test(name) || ['INFO', 'DATA', 'BANK', 'RATE', 'VRC7', 'NEND'].includes(name), 'unsupported mandatory NSFe chunk');
      require(size <= bytes.length - at - 8, 'truncated NSFe data');
      require(!chunks.has(name), 'duplicate NSFe chunk');
      chunks.set(name, bytes.subarray(at + 8, at + 8 + size));
      at += 8 + size;
      if (name === 'NEND') { require(size === 0 && at === bytes.length, 'invalid NSFe end'); end = true; break; }
    }
    const info = chunks.get('INFO');
    require(end && info?.length >= 10 && chunks.has('DATA'), 'missing NSFe header or data');
    load = word(info, 0); init = word(info, 2); play = word(info, 4); chips = info[7]; songs = info[8];
    data = chunks.get('DATA');
    if (chunks.has('BANK')) { require(chunks.get('BANK').length <= 8, 'invalid NSF banks'); banks.set(chunks.get('BANK')); }
    opll = chunks.get('VRC7');
  } else throw new NsfDriverError('not an NSF/NSFe');
  require(load >= 0x8000 && init >= 0x8000 && play === init + 3 && songs > 0 && chips <= 63, 'unsupported NSF layout');
  const banked = banks.some(b => b !== 0);
  const memory = { load, init, play, chips, songs, banks, banked, data, opll };
  memory.offset = (address, patternBank = null, sampleBank = null) => {
    require(Number.isInteger(address) && address >= 0x8000 && address <= 0xFFFF, 'music pointer outside NSF memory');
    let offset = address - load;
    if (banked) {
      let bank = banks[(address - 0x8000) >> 12];
      if (patternBank !== null && address >= 0xB000 && address < 0xC000) bank = patternBank;
      if (sampleBank !== null && address >= 0xC000 && address < 0xF000) bank = sampleBank + ((address - 0xC000) >> 12);
      offset = bank * 4096 + (address & 4095) - (load & 4095);
    }
    require(offset >= 0 && offset < data.length, 'music pointer outside NSF data');
    return offset;
  };
  memory.byte = (a, b = null) => data[memory.offset(a, b)];
  memory.word = (a, b = null) => memory.byte(a, b) | memory.byte(a + 1, b) << 8;
  memory.bytes = (a, n, b = null, sample = null) => Uint8Array.from({ length: n }, (_, i) => data[memory.offset(a + i, b, sample)]);
  return memory;
}

// Export channel order differs from the module order; DPCM comes last.
function driverChannels(chips, namco) {
  const result = [0, 1, 2, 3].map(id => ({ id, chip: 0 }));
  for (const [chip, first, count] of [[8, 8, 2], [1, 5, 3], [16, 11, namco], [4, 19, 1], [32, 26, 3], [2, 20, 6]])
    if (chips & chip) for (let i = 0; i < count; ++i) result.push({ id: first + i, chip });
  result.push({ id: 4, chip: 0 });
  return result;
}

export function identifyNsfDriver(bytes, profiles) {
  const m = nsfDriverMemory(bytes);
  require(tag(m.bytes(m.load, 6), 0, 6) === 'Dn-FT ' && m.byte(m.load + 6) === 2 && m.byte(m.load + 7) === 16,
    'unsupported driver or version (Dn-FT 2.16 required)');
  const name = ({ 0: '2A03', 1: 'VRC6', 2: 'VRC7', 4: 'FDS', 8: 'MMC5', 16: 'N163', 32: 'S5B' })[m.chips] ?? 'ALL';
  const p = profiles.find(p => p.chip === name);
  require(p, 'missing driver profile');
  const stock = profileBytes(p), expected = stock.slice(), actual = m.bytes(m.init, stock.length);
  const delta = m.init - 8;
  for (const at of p.words) {
    const value = (word(stock, at) + delta) & 65535;
    expected[at] = value & 255; expected[at + 1] = value >> 8;
  }
  for (let i = 0; i < p.addresses.length; i += 2) {
    const lo = p.addresses[i], hi = p.addresses[i + 1];
    const value = ((stock[lo] | stock[hi] << 8) + delta) & 65535;
    expected[lo] = value & 255; expected[hi] = value >> 8;
  }
  const base = word(actual, actual.length - 2);
  const flags = m.byte(base + 10), fds = p.chip === 'ALL' || !!(m.chips & 4), n163 = p.chip === 'ALL' || !!(m.chips & 16);
  const dividerAt = base + 11 + (fds ? 2 : 0);
  const namco = n163 ? m.byte(dividerAt + 4) : 0;
  require(!n163 || namco >= 1 && namco <= 8, 'invalid N163 channel count');
  require((flags & ~7) === 0 && !!(flags & 1) === m.banked, 'invalid music flags');
  if (p.channelType !== null) expected[p.channelType + 4 + namco] = 3;
  if (p.update !== null) {
    for (let i = 0; i < 6; ++i) if (!(m.chips & (1 << i))) expected.fill(0xEA, p.update + i * 3, p.update + i * 3 + 3);
    const active = new Set(driverChannels(m.chips, namco).map(c => c.id));
    driverChannels(63, 8).forEach((c, i) => { expected[p.enable + i] = Number(active.has(c.id)); });
  }
  const mask = new Uint8Array(stock.length);
  for (const table of p.tables) mask.fill(1, table.at, table.at + (table.type === 'VRC7' ? 26 : 192));
  mask.fill(1, p.vibrato, p.vibrato + 256);
  mask.fill(1, stock.length - 2);
  require(actual.every((v, i) => mask[i] || v === expected[i]), 'driver code does not match the supported Dn-FT build');
  m.base = base; m.ref = (a, b = null) => (base + m.word(a, b)) & 65535;
  return { memory: m, profile: p, actual, flags, namco: m.chips & 16 ? namco : 0,
    dividerNtsc: m.word(dividerAt), dividerPal: m.word(dividerAt + 2),
    waveTable: fds ? m.ref(base + 11) : null, name: 'Dn-FT 2.16', channels: driverChannels(m.chips, namco) };
}

export function nsfDriverInfo(bytes, profiles) {
  try { const d = identifyNsfDriver(bytes, profiles); return { supported: true, name: d.name }; }
  catch (e) { if (!(e instanceof NsfDriverError)) throw e; return { supported: false, reason: e.message }; }
}

function commandTable(chips, all) {
  const list = Array.from({ length: 39 }, (_, i) => i);
  for (const [bit, start, count] of [[2, 39, 3], [4, 42, 5], [16, 47, 1], [32, 48, 4]])
    if (all || chips & bit) for (let i = 0; i < count; ++i) list.push(start + i);
  return list;
}

// Effects with a direct inverse in PatternCompiler. Numbers are effect_t,
// independent of the chip-specific displayed letter.
const COMMAND_EFFECT = { 4: 1, 5: 1, 6: 2, 7: 3, 8: 4, 9: 5, 10: 6, 11: 16, 12: 17, 13: 6,
  14: 10, 15: 11, 16: 12, 17: 13, 18: 13, 19: 18, 20: 14, 21: 8, 22: 15, 23: 19,
  24: 20, 25: 21, 26: 22, 27: 23, 28: 24, 29: 29, 30: 36, 31: 23, 32: 37, 33: 25,
  34: 38, 35: 42, 36: 42, 37: 43, 38: 44, 39: 18, 40: 34, 41: 35,
  42: 26, 43: 27, 44: 28, 45: 40, 46: 41, 47: 39, 48: 30, 49: 31, 50: 32, 51: 33 };

class Decoder {
  constructor(driver) {
    this.driver = driver; this.m = driver.memory;
    this.commands = commandTable(this.m.chips, driver.profile.chip === 'ALL');
    this.instruments = new Map(); this.samples = new Map(); this.dpcm = new Map(); this.grooves = new Map();
    this.speedMin = 2; this.tempoMin = 255; this.bytesDecoded = 0;
    const list = this.m.ref(this.m.base), first = this.m.ref(list);
    require(first > list && (first - list) % 2 === 0 && first - list <= 512, 'invalid song table');
    this.songCount = (first - list) / 2;
  }
  groove(position) {
    if (!this.grooves.has(position)) {
      require(position > 0 && position < 256 && this.grooves.size < 32, 'invalid groove pointer');
      const at = this.m.ref(this.m.base + 8) + position, values = [];
      for (let i = 0; i < 128; ++i) {
        const entry = this.m.byte(at + i);
        if (!entry) { require(values.length > 0 && this.m.byte(at + i + 1) === position, 'invalid groove loop'); break; }
        values.push(entry);
      }
      require(values.length > 0 && values.length <= 128 && this.m.byte(at + values.length) === 0, 'invalid groove length');
      this.grooves.set(position, { index: this.grooves.size, values: Uint8Array.from(values) });
    }
    return this.grooves.get(position).index;
  }
  sequence(at) {
    const count = this.m.byte(at), loop = this.m.byte(at + 1), release = this.m.byte(at + 2), setting = this.m.byte(at + 3);
    require(count > 0 && count <= 253 && (loop === 255 || loop < count) && release <= count && setting <= 3, 'invalid sequence');
    return { address: at, items: Int8Array.from(this.m.bytes(at + 4, count), v => v > 127 ? v - 256 : v),
      loop: loop === 255 ? -1 : loop, release: release - 1, setting };
  }
  instrument(index) {
    if (this.instruments.has(index)) return;
    require(index < 64, 'invalid instrument index');
    const at = this.m.ref(this.m.ref(this.m.base + 2) + index * 2), type = TYPES[this.m.byte(at)];
    require(type && (!type.chip || this.m.chips & type.chip), 'unsupported instrument type');
    const inst = { index, ...type, sequences: [] };
    let pos = at + 1;
    if (type.type === 3) {
      inst.patch = this.m.byte(pos++) >> 4;
      inst.registers = inst.patch === 0 ? this.m.bytes(pos, 8) : new Uint8Array(8);
    } else {
      const mask = this.m.byte(pos++), count = type.type === 4 ? 3 : 5;
      require(mask < 1 << count, 'invalid instrument sequence mask');
      for (let s = 0; s < count; ++s) if (mask & 1 << s) { inst.sequences[s] = this.sequence(this.m.ref(pos)); pos += 2; }
      if (type.type === 4) {
        const packed = this.m.bytes(pos, 16); pos += 16;
        inst.modulation = Uint8Array.from({ length: 32 }, (_, i) => (packed[i >> 1] >> ((i & 1) * 3)) & 7);
        inst.delay = this.m.byte(pos++); inst.depth = this.m.byte(pos++); inst.speed = this.m.word(pos); pos += 2;
        require(inst.depth <= 63 && inst.speed <= 4095, 'invalid FDS modulation');
        inst.wave = this.m.bytes(this.driver.waveTable + this.m.byte(pos) * 64, 64);
        require(inst.wave.every(v => v < 64), 'invalid FDS wave');
      } else if (type.type === 5) {
        inst.waveSize = this.m.byte(pos++) * 2; inst.wavePos = this.m.byte(pos++);
        const wave = this.m.ref(pos); inst.waveCount = this.m.byte(wave);
        require(inst.waveSize >= 4 && inst.waveSize <= 240 && inst.waveSize % 4 === 0 && inst.waveCount > 0 && inst.waveCount <= 64,
          'invalid N163 wave dimensions');
        require(inst.waveSize + inst.wavePos <= 256 - this.driver.namco * 16, 'invalid N163 wave position');
        const packed = this.m.bytes(wave + 1, inst.waveSize * inst.waveCount / 2);
        inst.waves = Uint8Array.from({ length: inst.waveSize * inst.waveCount }, (_, i) => (packed[i >> 1] >> ((i & 1) * 4)) & 15);
      }
    }
    this.instruments.set(index, inst);
  }
  dpcmKey(index) {
    if (this.dpcm.has(index)) return;
    const list = this.m.ref(this.m.base + 4), pointers = this.m.ref(this.m.base + 6);
    require(index >= 0 && list + index * 3 + 3 <= pointers, 'DPCM note outside the assignment table');
    const at = list + index * 3;
    const pitch = this.m.byte(at), delta = this.m.byte(at + 1), pointer = this.m.byte(at + 2);
    require(pointer % 3 === 0 && (delta < 128 || delta === 255), `invalid DPCM assignment ${index}: ${pitch}/${delta}/${pointer}`);
    if (!this.samples.has(pointer)) {
      const sample = this.m.ref(this.m.base + 6) + pointer;
      const address = 0xC000 + this.m.byte(sample) * 64, size = this.m.byte(sample + 1) * 16 + 1, bank = this.m.byte(sample + 2);
      require(size <= 4081 && address + size <= 0x10000 && this.samples.size < 64, 'invalid DPCM sample');
      this.samples.set(pointer, this.m.bytes(address, size, null, bank));
    }
    this.dpcm.set(index, { index, pointer, pitch: pitch & 15, loop: !!(pitch & 64), delta: delta === 255 ? -1 : delta });
  }
  pattern(address, bank, rows, channel, tempo, end) {
    this.bytesDecoded += rows * CELL;
    require(this.bytesDecoded <= 32 * 1024 * 1024, 'decoded patterns exceed the 32 MB limit');
    const data = emptyPattern(rows);
    let pos = address, duration = 255;
    const next = () => {
      require(pos - address < rows * 64 + 64 && this.m.offset(pos, bank) < end, 'compressed pattern ends before its declared row count');
      return this.m.byte(pos++, bank);
    };
    for (let row = 0; row < rows;) {
      const cell = data.subarray(row * CELL, (row + 1) * CELL), effects = [];
      let note = null;
      for (let n = 0; n < 64; ++n) {
        const byte = next();
        if (byte < 128) { note = byte; break; }
        if (byte >= 0xF0) { cell[2] = byte & 15; continue; }
        if (byte >= 0xE0) { cell[3] = byte & 15; this.instrument(cell[3]); continue; }
        const cmd = this.commands[byte & 127];
        require(cmd !== undefined, 'unknown pattern command');
        if (cmd === 0) { const value = next(); require(!(value & 1), 'invalid instrument command'); cell[3] = value >> 1; this.instrument(cell[3]); continue; }
        if (cmd === 1) { cell[3] = HOLD_INSTRUMENT; continue; }
        if (cmd === 2) { duration = next(); continue; }
        if (cmd === 3) { duration = 255; continue; }
        let value = cmd === 10 ? 0 : cmd === 18 ? 128 : next(), effect = COMMAND_EFFECT[cmd];
        require(effect !== undefined, 'unsupported effect');
        const inverted = channel.chip === 2 || channel.chip === 4 || channel.chip === 16 || !!(this.driver.flags & 4);
        if (cmd === 4 && tempo) this.speedMin = Math.max(this.speedMin, value + 1);
        if (cmd === 5) this.tempoMin = Math.min(this.tempoMin, value);
        if (cmd === 6 || cmd === 7) value = (value - 1) & 255;
        if (cmd === 9 && value >= 128) value = 0xE0 | (value & 3);
        if ((cmd === 11 || cmd === 12) && inverted) effect = cmd === 11 ? 17 : 16;
        if (cmd === 15 || cmd === 16) value = (value >> 4) | ((value & 15) << 4);
        if (cmd === 17 && inverted) value = (256 - value) & 255;
        if (cmd === 19 && channel.chip === 32) value = (value >> 6) | ((value & 32) >> 3);
        if (cmd === 21) { effect = value & 8 ? 8 : 9; value &= 0x77; }
        if (cmd === 28 && channel.id === 4) value = (value - 1) & 255;
        if (cmd === 31) value += 128;
        if (cmd === 32) value = this.groove(value);
        if (cmd === 39) value >>= 4;
        if (cmd === 45) value = value === 128 ? 0xE0 : value ^ 64;
        if (cmd === 47 && value === 128) value = 127;
        effects.push([effect, value]);
      }
      require(note !== null && effects.length <= 4, 'invalid row or more than four effect columns');
      effects.forEach(([effect, value], i) => { cell[4 + i] = effect; cell[8 + i] = value; });
      if (note === 0x7F) cell[0] = NOTE.HALT;
      else if (note === 0x7E) cell[0] = NOTE.RELEASE;
      else if (note >= 0x70) { require(note <= 0x72, 'invalid echo note'); cell[0] = NOTE.ECHO; cell[1] = note - 0x70; }
      else if (note) {
        if (channel.id === 4) {
          try { this.dpcmKey(note - 1); } catch (e) { if (e instanceof NsfDriverError) e.message += ` (row ${row}, offset ${pos - address}, default ${duration})`; throw e; }
          cell[0] = (note - 1) % 96 % 12 + 1; cell[1] = Math.floor((note - 1) % 96 / 12); cell[3] = Math.floor((note - 1) / 96);
        }
        else { const key = channel.id === 3 ? (note - 1) & 15 : note - 1; require(key < 96, 'note outside tracker range'); cell[0] = key % 12 + 1; cell[1] = Math.floor(key / 12); }
      }
      const gap = (duration === 255 ? next() : duration) + 1;
      // With fixed-duration compression the final note keeps its full default
      // duration; the track's row count ends the pattern before it expires.
      require(row + gap <= rows || duration !== 255, `duration exceeds pattern length (row ${row}, gap ${gap}, rows ${rows})`);
      row += gap;
    }
    return data;
  }
  track(song, title) {
    const m = this.m, at = m.ref(m.ref(m.base) + song * 2);
    const frames = m.byte(at + 2) || 256, rows = m.byte(at + 3) || 256;
    const speed = m.byte(at + 4), tempo = m.byte(at + 5), groove = m.byte(at + 6), bank = m.byte(at + 7);
    require(speed > 0 || groove > 0, 'invalid initial speed');
    if (tempo && speed) this.speedMin = Math.max(this.speedMin, speed + 1);
    const result = { song, title, frames, rows, tempo, speed: groove ? this.groove(groove) : speed, groove: !!groove, patterns: [] };
    const list = m.ref(at), maps = this.driver.channels.map(() => new Map());
    result.frameList = new Uint8Array(frames * maps.length);
    for (let frame = 0; frame < frames; ++frame) {
      const order = m.ref(list + frame * 2, bank || null);
      for (const [c, channel] of this.driver.channels.entries()) {
        const address = m.ref(order + c * 2, bank || null);
        const patternBank = m.banked ? m.byte(order + maps.length * 2 + c, bank || null) : null;
        const key = `${address}:${patternBank}`;
        if (!maps[c].has(key)) {
          const pattern = maps[c].size;
          maps[c].set(key, pattern);
          result.patterns.push({ channel: c, pattern, address, bank: patternBank, frame });
        }
        result.frameList[frame * maps.length + c] = maps[c].get(key);
      }
    }
    return result;
  }
  boundaries(tracks) {
    const m = this.m;
    const offsets = [...new Set(tracks.flatMap(t => t.patterns.map(p => m.offset(p.address, p.bank))))].sort((a, b) => a - b);
    let musicEnd = m.data.length;
    if (m.banked) musicEnd = m.banks[4] * 4096 - (m.load & 4095);
    else if (m.base < m.init) musicEnd = m.offset(m.init);
    // Frame lists are also boundaries (a pattern cannot run into a later track).
    for (let song = 0; song < this.songCount; ++song) {
      const at = m.ref(m.ref(m.base) + song * 2), bank = m.byte(at + 7) || null;
      offsets.push(m.offset(m.ref(at), bank));
    }
    offsets.sort((a, b) => a - b);
    return { offsets, musicEnd };
  }
  decodeTrack(track, boundaries) {
    const m = this.m;
    for (const p of track.patterns) {
      const start = m.offset(p.address, p.bank);
      const end = Math.min(boundaries.offsets.find(offset => offset > start) ?? boundaries.musicEnd,
        m.banked ? (Math.floor(start / 4096) + 1) * 4096 : boundaries.musicEnd);
      try { p.data = this.pattern(p.address, p.bank, track.rows, this.driver.channels[p.channel], track.tempo, end); }
      catch (e) { if (e instanceof NsfDriverError) e.message += ` (song ${track.song}, frame ${p.frame}, channel ${this.driver.channels[p.channel].id})`; throw e; }
    }
  }
}

function applyInstrument(session, inst, sequences) {
  const index = session.addInstrument(inst.chip, `NSF ${inst.index.toString(16).padStart(2, '0').toUpperCase()}`);
  require(index >= 0, 'instruments exceed module capacity');
  inst.sequences.forEach((s, type) => {
    if (inst.type === 4) session.setFdsSequence(index, type, s.items, s.loop, s.release, s.setting);
    else {
      const key = `${inst.type}:${type}:${s.address}`;
      if (!sequences.has(key)) {
        const seq = session.freeSequence(inst.type, type);
        require(seq >= 0, 'sequences exceed module capacity');
        session.setSequence(inst.type, type, seq, s.items, s.loop, s.release, s.setting);
        sequences.set(key, seq);
      }
      session.setInstrumentSequence(index, type, true, sequences.get(key));
    }
  });
  if (inst.type === 3) session.setVrc7(index, inst.patch, inst.registers);
  if (inst.type === 4) { session.setFdsWave(index, inst.wave); session.setFdsModulation(index, inst.modulation); session.setFdsParams(index, inst.speed, inst.depth, inst.delay); }
  if (inst.type === 5) session.setN163(index, inst.waveSize, inst.wavePos, inst.waveCount, inst.waves);
  return index;
}

// Restore exported pitch tables using a freshly exported untuned module with the
// same chip configuration. Original tuning UI values are lost; period offsets
// preserve the resulting pitches. A second export verifies exact table recovery.
function restoreTables(session, driver, profiles) {
  const machine = session.info().pal ? 1 : 0;
  const baseline = identifyNsfDriver(session.exportNSF('nsf', machine, false).files[0].data, profiles);
  require(baseline.profile.chip === driver.profile.chip, 'unsupported export configuration');
  require(same(driver.actual.subarray(driver.profile.vibrato, driver.profile.vibrato + 256),
    baseline.actual.subarray(baseline.profile.vibrato, baseline.profile.vibrato + 256)), 'custom vibrato table is unsupported');
  const offsets = new Int16Array(6 * 96);
  for (const { at, type } of driver.profile.tables) {
    const table = TABLE_TYPES[type], count = type === 'VRC7' ? 12 : 96;
    for (let note = 0; note < count; ++note) {
      const value = bytes => type === 'VRC7' ? ((bytes[at + note] | bytes[at + note + 13] << 8) / 4) : word(bytes, at + note * 2);
      const offset = (value(driver.actual) - value(baseline.actual)) * (table <= 2 ? -1 : 1);
      require(Number.isInteger(offset) && offset >= -32768 && offset <= 32767, 'unsupported pitch table');
      offsets[table * 96 + note] = offset;
    }
  }
  session.setDetune(offsets, 0, 0);
  const check = identifyNsfDriver(session.exportNSF('nsf', machine, false).files[0].data, profiles);
  for (const { at, type } of driver.profile.tables)
    require(same(driver.actual.subarray(at, at + (type === 'VRC7' ? 26 : 192)), check.actual.subarray(at, at + (type === 'VRC7' ? 26 : 192))), 'pitch table could not be restored');
}

export async function importNsfDriver(core, bytes, info, profiles, options, sampleRate,
  { onProgress = () => {}, isCancelled = () => false, yieldControl = () => new Promise(resolve => setTimeout(resolve)) } = {}) {
  const driver = identifyNsfDriver(bytes, profiles), decoder = new Decoder(driver);
  const count = options.allSongs ? Math.min(info.songs, MAX_NSF_TRACKS) : 1;
  const first = options.allSongs ? 0 : options.song ?? info.start;
  require(info.songs === driver.memory.songs && first >= 0 && first + count <= info.songs, 'invalid song selection');
  require(first + count <= decoder.songCount, 'selected song outside the exported song table');
  const tracks = [];
  const checkpoint = async progress => { onProgress(progress); await yieldControl(); if (isCancelled()) throw new Error('cancelled'); };
  await checkpoint(0);
  for (let i = 0; i < count; ++i) {
    const song = first + i;
    tracks.push(decoder.track(song, info.tracks[song]?.title || `Song ${song + 1}`));
    await checkpoint((i + 1) / (count * 4));
  }
  const boundaries = decoder.boundaries(tracks);
  for (const [i, track] of tracks.entries()) {
    decoder.decodeTrack(track, boundaries);
    await checkpoint(0.25 + (i + 1) / (count * 4));
  }
  require(decoder.speedMin <= decoder.tempoMin, 'speed and tempo commands cannot share one split point');
  const session = core.createSession(sampleRate);
  try {
    session.setExpansion(info.chips, driver.namco);
    session.setMachine(nsfRegion(info, options.region ?? -1) === 1);
    const pal = session.info().pal, divider = pal ? driver.dividerPal : driver.dividerNtsc, hz = divider / 60;
    require(Number.isInteger(hz) && hz >= 16 && hz <= 400, 'unsupported engine speed');
    const period = pal ? info.periodPal : info.periodNtsc;
    require(period > 0 && Math.abs(1e6 / period - hz) < 0.25, 'NSF playback rate disagrees with the driver timing');
    session.setEngineSpeed(hz === (pal ? 50 : 60) ? 0 : hz);
    session.setVibratoStyle(!(driver.flags & 2)); session.setLinearPitch(!!(driver.flags & 4));
    session.setSpeedSplitPoint(Math.max(decoder.speedMin, Math.min(32, decoder.tempoMin)));
    for (const inst of session.instruments()) session.removeInstrument(inst.index);
    const instrumentMap = new Map(), sequences = new Map();
    for (const inst of decoder.instruments.values()) instrumentMap.set(inst.index, applyInstrument(session, inst, sequences));
    const sampleMap = new Map();
    for (const [pointer, data] of decoder.samples) { const index = session.setSample(-1, `NSF sample ${pointer / 3 + 1}`, data); require(index >= 0, 'samples exceed module capacity'); sampleMap.set(pointer, index + 1); }
    const dpcmInstruments = [];
    for (const [index, key] of decoder.dpcm) {
      const group = Math.floor(index / 96);
      if (dpcmInstruments[group] === undefined) { dpcmInstruments[group] = session.addInstrument(0, `NSF DPCM ${group + 1}`); require(dpcmInstruments[group] >= 0, 'DPCM assignments exceed instrument capacity'); }
      session.setDpcmKey(dpcmInstruments[group], index % 96, sampleMap.get(key.pointer), key.pitch, key.loop, key.delta);
    }
    const grooves = Array.from({ length: 32 }, () => []);
    for (const groove of decoder.grooves.values()) grooves[groove.index] = groove.values;
    session.setGrooves(grooves);
    const channels = session.info().channels;
    const channelMap = driver.channels.map(channel => channels.findIndex(c => c.id === channel.id));
    require(channelMap.every(c => c >= 0), 'unsupported channel order');
    for (const [t, track] of tracks.entries()) {
      if (t) session.addTrack();
      session.setTrackTitle(t, track.title); session.setPatternLength(t, track.rows); session.setFrameCount(t, track.frames);
      session.setTempo(t, track.tempo); session.setGrooveMode(t, track.groove); session.setSpeed(t, track.speed);
      const columns = new Array(channels.length).fill(1);
      for (const p of track.patterns) {
        const data = p.data.slice(), channel = channelMap[p.channel], dpcm = channels[channel].id === 4;
        for (let at = 0; at < data.length; at += CELL) {
          if (dpcm && data[at] >= 1 && data[at] <= 12) {
            // The exported DPCM note is an assignment index, not its original key.
            const key = data[at + 3] * 96 + data[at + 1] * 12 + data[at] - 1;
            require(decoder.dpcm.has(key), 'missing DPCM key'); data[at + 3] = dpcmInstruments[Math.floor(key / 96)];
          } else if (data[at + 3] < NO_INSTRUMENT) data[at + 3] = instrumentMap.get(data[at + 3]);
          for (let col = 0; col < 4; ++col) if (data[at + 4 + col]) columns[channel] = Math.max(columns[channel], col + 1);
        }
        session.setCells(t, channel, p.pattern, 0, data);
      }
      for (let c = 0; c < channels.length; ++c) session.setEffColumns(t, c, columns[c]);
      for (let frame = 0; frame < track.frames; ++frame)
        for (let c = 0; c < driver.channels.length; ++c) session.setFramePattern(t, frame, channelMap[c], track.frameList[frame * driver.channels.length + c]);
      await checkpoint(0.5 + (t + 1) / (count * 2 + 2));
    }
    restoreTables(session, driver, profiles);
    if (driver.memory.opll?.length) {
      require(driver.memory.opll.length === 153 && driver.memory.opll[0] === 1, 'unsupported external OPLL chunk');
      session.setOpll(true, driver.memory.opll.slice(1), Array.from({ length: 19 }, (_, i) => `NSF patch ${i}`));
    }
    session.setTitle(info.title); session.setArtist(info.artist); session.setCopyright(info.copyright);
    const limit = options.allSongs && info.songs > MAX_NSF_TRACKS ? 'trackLimit' : null;
    session.setComment(`Decoded from an NSF using ${driver.name}.\nImported ${count} of ${info.songs} songs${limit ? '; ' + limit : ''}.\n` +
      'Exported rows, orders, notes, effects and sound resources were decoded directly.\n' +
      'Instrument/sample names, unused data, original pattern numbers and row highlights are not retained in NSF.\n' +
      'Noise octaves and DPCM keys/instrument grouping were replaced with equivalent playable assignments.');
    const result = { data: session.save(), method: 'driver', driver: driver.name, totalSongs: info.songs, limit,
      songs: tracks.map((track, t) => ({ song: track.song, track: t, title: track.title,
        report: { rows: track.rows * track.frames, rate: hz, warnings: [] } })) };
    await checkpoint(1);
    return result;
  } finally { session.delete(); }
}

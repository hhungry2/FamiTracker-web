// Documented Capcom Mega Man 1/2 music bytecode. See docs/NSF_game_drivers.en.md.
// Structure is decoded directly; NSFPlay supplies hardware envelopes/counters.
// Neither a game title in the NSF header nor a matching data pattern identifies
// a driver: both complete stock engine fingerprints must match first.
import { nsfMemory, NsfDriverError, requireDriver as require } from './dnft-nsf-memory.mjs';
import { MAX_NSF_TRACKS, NsfModuleImport, inImportHeap, nsfRegion, silentSong } from './dnft-nsf-import.mjs';
import { reconstructNsf } from './dnft-nsf-reconstruct.mjs';

export const CAPCOM_DRIVERS = Object.freeze([
  { name: 'Capcom / Mega Man 1', size: 0xA60, table: 0x8A60, periods: 0x8991, hash: 'f75590a8:1d3d052d' },
  { name: 'Capcom / Mega Man 2', size: 0xA50, table: 0x8A50, periods: 0x8985, hash: '17a870b2:b1b08579' },
]);
export function capcomFingerprint(bytes) {
  let a = 2166136261, b = 0;
  for (const v of bytes) { a = Math.imul(a ^ v, 16777619) >>> 0; b = (Math.imul(b, 65599) + v) >>> 0; }
  return `${a.toString(16)}:${b.toString(16)}`;
}

export function identifyCapcomDriver(bytes) {
  const memory = nsfMemory(bytes);
  require(memory.chips === 0, 'unsupported game driver or expansion chip');
  for (const profile of CAPCOM_DRIVERS) {
    try {
      if (capcomFingerprint(memory.bytes(0x8000, profile.size)) !== profile.hash) continue;
      // Accept a bare play entry or a wrapper consisting of JMP/JSR + RTS.
      let play = memory.play;
      for (let n = 0; n < 8 && play !== 0x8000; ++n) {
        const op = memory.byte(play);
        require(op === 0x4C || (op === 0x20 && memory.byte(play + 3) === 0x60), 'unsupported Capcom play wrapper');
        play = memory.word(play + 1);
      }
      require(play === 0x8000, 'unsupported Capcom play entry');
      return { ...profile, memory };
    } catch (error) { if (!(error instanceof NsfDriverError)) throw error; }
  }
  throw new NsfDriverError('unrecognized driver code (supported: Dn-FT 2.16, stock Mega Man 1/2)');
}

// Bounded, deliberately small interpreter for NSF rip-added initialization only.
// It stops at the stock driver's queue entry, records the song ID, and permits
// ordinary RAM clears, song lookup tables and unchanged initial bank writes.
// It never executes the game driver or assumes NSF song N is driver song N.
export function capcomSongId(driver, song, region) {
  const m = driver.memory, ram = new Uint8Array(2048), stack = [], calls = [];
  let pc = m.init, a = song, x = region, y = 0, carry = 0, zero = false, negative = false, selected = null, finished = false;
  const flags = v => { v &= 255; zero = v === 0; negative = !!(v & 128); return v; };
  const read = address => address < 0x2000 ? ram[address & 2047] : m.byte(address);
  const next = () => { const v = read(pc); pc = (pc + 1) & 65535; return v; };
  const word = () => next() | next() << 8;
  const write = (address, v) => {
    if (address < 0x2000) { ram[address & 2047] = v; return; }
    if (address >= 0x5FF8 && address <= 0x5FFF && m.banked && m.banks[address - 0x5FF8] === v) return;
    if ((address === 0x4015 && v === 15) || (address === 0x4017 && v === 0x40) ||
      (address >= 0x4000 && address <= 0x4013 && v === 0)) return;
    throw new NsfDriverError(`unsupported Capcom init write $${address.toString(16)}`);
  };
  const finishCall = () => { if (!calls.length) return true; pc = calls.pop(); return false; };
  for (let steps = 0; steps < 100000; ++steps) {
    if (pc === 0x8003) {
      if (a < 0xFC) { require(selected === null, 'multiple music selections in Capcom init'); selected = a; }
      else require(a >= 0xFE && selected === null, 'external speed/fade/reset commands in Capcom init are unsupported');
      if (finishCall()) { finished = true; break; }
      continue;
    }
    require(pc < 0x8000 || pc >= 0x8000 + driver.size, 'init enters unsupported game code');
    const op = next();
    switch (op) {
      case 0xA9: a = flags(next()); break;
      case 0xA2: x = flags(next()); break;
      case 0xA0: y = flags(next()); break;
      case 0xA5: a = flags(read(next())); break;
      case 0xAD: a = flags(read(word())); break;
      case 0xBD: a = flags(read((word() + x) & 65535)); break;
      case 0xB9: a = flags(read((word() + y) & 65535)); break;
      case 0x85: write(next(), a); break;
      case 0x86: write(next(), x); break;
      case 0x84: write(next(), y); break;
      case 0x8D: write(word(), a); break;
      case 0x8E: write(word(), x); break;
      case 0x8C: write(word(), y); break;
      case 0x9D: write((word() + x) & 65535, a); break;
      case 0x99: write((word() + y) & 65535, a); break;
      case 0xAA: x = flags(a); break;
      case 0xA8: y = flags(a); break;
      case 0x8A: a = flags(x); break;
      case 0x98: a = flags(y); break;
      case 0xE8: x = flags(x + 1); break;
      case 0xCA: x = flags(x - 1); break;
      case 0xC8: y = flags(y + 1); break;
      case 0x88: y = flags(y - 1); break;
      case 0x48: require(stack.length < 256, 'Capcom init stack limit'); stack.push(a); break;
      case 0x68: require(stack.length > 0, 'Capcom init stack underflow'); a = flags(stack.pop()); break;
      case 0x18: carry = 0; break;
      case 0x38: carry = 1; break;
      case 0x69: case 0xE9: {
        const operand = next() ^ (op === 0xE9 ? 255 : 0), value = a + operand + carry;
        carry = value > 255 ? 1 : 0; a = flags(value); break;
      }
      case 0x29: a = flags(a & next()); break;
      case 0x09: a = flags(a | next()); break;
      case 0x49: a = flags(a ^ next()); break;
      case 0x0A: carry = a >> 7; a = flags(a << 1); break;
      case 0x4A: carry = a & 1; a = flags(a >> 1); break;
      case 0xC9: case 0xE0: case 0xC0: {
        const lhs = op === 0xC9 ? a : op === 0xE0 ? x : y, rhs = next();
        carry = lhs >= rhs ? 1 : 0; flags(lhs - rhs); break;
      }
      case 0xD0: case 0xF0: case 0x10: case 0x30: case 0x90: case 0xB0: {
        const offset = (next() << 24) >> 24;
        const take = op === 0xD0 ? !zero : op === 0xF0 ? zero : op === 0x10 ? !negative : op === 0x30 ? negative : op === 0x90 ? !carry : carry;
        if (take) pc = (pc + offset) & 65535;
        break;
      }
      case 0x20: { const to = word(); require(calls.length < 16, 'Capcom init call limit'); calls.push(pc); pc = to; break; }
      case 0x4C: pc = word(); break;
      case 0x60:
        if (finishCall()) { require(selected !== null, 'Capcom init does not select a song'); finished = true; }
        break;
      case 0xEA: case 0x78: case 0x58: case 0xD8: break;
      default: throw new NsfDriverError(`unsupported Capcom init opcode $${op.toString(16)}`);
    }
    if (finished) break;
  }
  require(finished && selected !== null && calls.length === 0 && stack.length === 0, 'Capcom init did not finish within its limits');
  require(ram[0xE7] === 0 && ram[0xE8] === 0 && ram[0x41] === 0 && ram[0xEA] === 0,
    'external Capcom speed/fade/pause/frame clock is unsupported');
  return selected;
}

// Decode the four independent music streams on the driver's quarter-tick clock.
// No guessed meter/pattern boundaries. A repeated complete musical state gives
// the combined channel loop; finite repeats are expanded, with strict limits.
export async function decodeCapcomSong(driver, id, { checkpoint = async () => {} } = {}) {
  const m = driver.memory;
  require(id >= 0 && id < 128, 'Capcom song ID outside the pointer table');
  const header = m.word(driver.table + id * 2);
  require((m.byte(header) & 15) !== 0, 'Capcom sound-effect stream uses playback analysis');
  const modulation = m.word(header + 9), events = [];
  const channels = Array.from({ length: 4 }, (_, index) => ({ index, pc: m.word(header + 1 + index * 2), length: 0,
    tempo: 0, base: 0, loop: 0, triplet: false, tied: 0, params: new Uint8Array(9) }));
  for (const channel of channels) if (channel.pc) m.byte(channel.pc);
  let commands = 0;
  function step(ch, tick) {
    if (!ch.pc) return;
    if (ch.length) { ch.length -= 4; if (ch.length) return; }
    const read = () => { require(++commands <= 2000000, 'Capcom command limit'); return m.byte(ch.pc++); };
    ch.triplet = false;
    let dotted = false, tie = null;
    for (let local = 0; local < 4096; ++local) {
      const address = ch.pc, b = read();
      if (b < 16) {
        require(b <= 9, `unknown Capcom command $${b.toString(16)}`);
        if (b === 9) { ch.pc = 0; return; }
        if (b === 4) {
          const count = read(), target = read() | read() << 8;
          require(count <= 127, 'invalid Capcom repeat count');
          m.byte(target);
          if (count && ch.loop === count) ch.loop = 0;
          else { if (count) ++ch.loop; ch.pc = target; }
          continue;
        }
        if (b === 6) { dotted = true; continue; }
        const value = read();
        if (b === 0) { require(value > 0, 'zero Capcom tempo is unsupported'); ch.tempo = value; }
        else if (b === 5) { require(value < 96, 'invalid Capcom base note'); ch.base = value; }
        else if (b === 8) { require(value < 32, 'invalid Capcom modulator'); m.bytes(modulation + value * 4, 4); ch.params[8] = value; }
        else { ch.params[b] = value; if (b === 7) ch.params[6] = read(); }
        continue;
      }
      if ((b & 0xF0) === 0x20) { require(tie === null, 'nested Capcom ties are unsupported'); tie = b & 7; continue; }
      if ((b & 0xF0) === 0x30) { ch.triplet = true; continue; }
      const units = (dotted ? [0, 0, 3, 6, 12, 24, 48, 96] : [0, 0, 2, 4, 8, 16, 32, 64])[b >> 5];
      const length = units * ch.tempo, note = b & 31;
      require(length > 0 && length % 4 === 0 && length <= 65535, 'unsupported Capcom note duration');
      if (note && ch.index !== 3) {
        require(ch.base + note < 96, 'Capcom note outside the pitch table');
        m.word(driver.periods + 2 * (ch.base + note));
      }
      events.push({ channel: ch.index, tick, address, note: note ? ch.index === 3 ? 15 - (note & 15) : ch.base + note : null,
        quarterTicks: length, tied: ch.tied > 0, triplet: ch.triplet });
      if (ch.tied) --ch.tied;
      if (tie !== null) ch.tied = tie;
      ch.length = length;
      return;
    }
    throw new NsfDriverError('Capcom stream has an unbounded zero-time loop');
  }
  const seen = new Map();
  for (let tick = 0; tick < 65535; ++tick) {
    const key = `${tick & 1}:` + channels.map(ch => ch.pc ? [ch.pc, ch.length, ch.tempo, ch.base, ch.loop, +ch.triplet, ch.tied, ...ch.params].join(',') : '-').join(';');
    if (seen.has(key)) return { rows: tick, loopRow: seen.get(key), events };
    seen.set(key, tick);
    for (const ch of channels) {
      const twice = ch.triplet && ((tick + 1) & 1);
      step(ch, tick); if (twice) step(ch, tick);
    }
    if (channels.every(ch => !ch.pc)) return { rows: tick + 1, loopRow: -1, events };
    if (!(tick % 256)) await checkpoint();
  }
  throw new NsfDriverError('Capcom song exceeds the 65535-frame structure limit');
}

async function analyze(nsf, bytes, song, region, frames, checkpoint) {
  require(nsf, 'game driver import requires the NSF hardware analyzer');
  const analysis = new nsf.NsfAnalysis();
  try {
    const error = inImportHeap(nsf, bytes, (at, size) => analysis.load(at, size));
    require(!error, error);
    require(analysis.start(song, region, frames), 'could not initialize Capcom NSF');
    while (!analysis.done()) { analysis.run(120); await checkpoint(Math.min(1, analysis.frames() / frames)); }
    return analysis.log();
  } finally { analysis.delete(); }
}

// Check musical loops against actual channel states. A hardware envelope may
// settle during the first pass; retain that pass as part of the intro if needed.
function verifiedStructure(log, structure) {
  if (structure.loopRow < 0) return structure;
  const view = new DataView(log.buffer, log.byteOffset, log.byteLength), channels = log[21];
  let offset = 24 + channels * 2;
  for (let i = 0; i < 4; ++i) { const n = view.getUint16(offset, true); offset += 2 + n; }
  // Stock 2A03 music has no DPCM or expansion resources.
  for (let i = 0; i < 5; ++i) { require(view.getUint16(offset, true) === 0, 'unexpected Capcom sound resource'); offset += 2; }
  const period = structure.rows - structure.loopRow;
  const matches = start => {
    let differences = 0;
    for (let f = start; f < start + period; ++f) {
      let different = false;
      for (let c = 0; c < channels; ++c) {
        const a = offset + (f * channels + c) * 16, b = a + period * channels * 16;
        const onA = !!(log[a] & 1) && log[a + 1] > 0, onB = !!(log[b] & 1) && log[b + 1] > 0;
        if (onA !== onB || (onA && (view.getUint32(a + 4, true) !== view.getUint32(b + 4, true) ||
          log[a + 2] !== log[b + 2] || Math.abs(log[a + 1] - log[b + 1]) > 2))) different = true;
      }
      if (different) ++differences;
    }
    return differences <= Math.max(1, period * 0.02);
  };
  if (matches(structure.loopRow)) return structure;
  require(structure.rows + period <= 65535 && matches(structure.rows), 'decoded Capcom loop disagrees with hardware playback');
  return { ...structure, rows: structure.rows + period, loopRow: structure.rows };
}

export async function importCapcomNsf(core, driver, bytes, info, options, sampleRate, {
  nsf, createVerificationCore, onProgress = () => {}, isCancelled = () => false,
  yieldControl = () => new Promise(resolve => setTimeout(resolve)),
} = {}) {
  const count = options.allSongs ? Math.min(info.songs, MAX_NSF_TRACKS) : 1;
  const first = options.allSongs ? 0 : options.song ?? info.start, region = nsfRegion(info, options.region ?? -1);
  require(first >= 0 && first + count <= driver.memory.songs && info.songs === driver.memory.songs, 'invalid Capcom song selection');
  const module = new NsfModuleImport(core, sampleRate, info, { sequences: true });
  let verificationCore, fallback = false, progress = 0;
  const reportProgress = value => { progress = Math.max(progress, value); onProgress(progress); };
  const check = async value => { if (value !== undefined) reportProgress(value); await yieldControl(); if (isCancelled()) throw new Error('cancelled'); };
  try {
    await check(0);
    for (let n = 0; n < count; ++n) {
      const song = first + n, title = info.tracks[song]?.title || `Song ${song + 1}`;
      let structure = null, reason = null, source = null;
      try {
        try { structure = await decodeCapcomSong(driver, capcomSongId(driver, song, region), { checkpoint: () => check() }); }
        catch (error) { if (!(error instanceof NsfDriverError)) throw error; reason = error.message; }
        const period = region === 1 ? info.periodPal : info.periodNtsc;
        require(period > 0, 'invalid Capcom playback period');
        const loopLength = structure && structure.loopRow >= 0 ? structure.rows - structure.loopRow : 0;
        const frames = structure ? structure.rows + loopLength * 2 + 2 : Math.max(1, Math.round((options.seconds ?? 300) * 1e6 / period));
        let log = await analyze(nsf, bytes, song, region, frames, p => check((n + 0.1 + p * 0.45) / count));
        if (structure) {
          try { structure = verifiedStructure(log, structure); }
          catch (error) {
            if (!(error instanceof NsfDriverError)) throw error;
            structure = null; reason = error.message;
            log = await analyze(nsf, bytes, song, region, Math.max(1, Math.round((options.seconds ?? 300) * 1e6 / period)), () => check());
          }
        }
        const settings = structure ? { patternLength: 64, trimSilence: false, loop: true, sourceRows: structure.rows, sourceLoopRow: structure.loopRow } : options;
        let importReport;
        try { source = inImportHeap(core, log, (at, size) => core.importNsf(at, size, sampleRate, settings)); importReport = source.nsfReport(); }
        catch (error) {
          const message = error instanceof WebAssembly.Exception ? core.getExceptionMessage(error).at(-1) : error.message;
          if (message !== 'the NSF made no sound') throw error;
          ({ session: source, report: importReport } = silentSong(core, log, info, song, sampleRate, settings));
        }
        source.setTrackTitle(0, title);
        let report = { ...importReport, reader: structure ? 'driver' : 'playback', reason,
          sourceEvents: structure?.events.length ?? 0 };
        if (!structure) fallback = true;
        if (structure && !report.warnings.includes('silentSong')) {
          require(createVerificationCore, 'game driver import requires reconstruction verification');
          verificationCore ??= await createVerificationCore();
          const saved = source.save(); source.delete(); source = null;
          const rebuild = sequences => reconstructNsf(core, verificationCore, saved, 0, title, sampleRate, {
            sequences, isCancelled, onProgress: p => reportProgress((n + 0.6 + p * 0.35) / count),
          });
          const openRebuilt = rebuilt => {
            const result = inImportHeap(core, rebuilt.data ?? saved, (at, size) => core.openSession(at, size, sampleRate));
            if (rebuilt.data) result.removeTrack(0);
            const used = new Set(result.patterns(0).flatMap(p => Array.from(p.data).filter((_, i) => i % 12 === 3)));
            for (const inst of result.instruments()) if (!used.has(inst.index)) result.removeInstrument(inst.index);
            return result;
          };
          let rebuilt = await rebuild(true), sequenceBudget = false;
          source = openRebuilt(rebuilt);
          // Leave room for later songs' common 2A03 instruments. Preserve all
          // songs by using verified row packing when per-note macros fill up.
          if (options.allSongs && count > 1 && source.instruments().length + (module.session?.instruments().length ?? 0) > 48) {
            source.delete(); source = null; sequenceBudget = true;
            rebuilt = await rebuild(false); source = openRebuilt(rebuilt);
          }
          report = { ...report, reconstructedRows: rebuilt.reconstruction.rows, reconstructionVerified: !!rebuilt.reconstruction.verified, sequenceBudget };
        }
        if (!module.append(source, song, report)) break;
      } finally { source?.delete(); }
      await check((n + 1) / count);
    }
    const result = module.finish();
    require(result, 'no Capcom songs could be imported');
    module.session.setComment(`Decoded from an NSF using ${driver.name}.\n` +
      'Music commands, durations and channel loops were decoded directly. NSFPlay supplied hardware sound states.\n' +
      'Automatic sequence/row reconstruction was checked against the converted track, not the original NSF audio.\n' +
      result.songs.map(s => `Song ${s.song + 1}: ${s.report.reader}; ${s.report.sourceEvents} source events` +
        (s.report.reason ? `; fallback: ${s.report.reason}` : '')).join('\n'));
    await check(1);
    return { ...result, limit: options.allSongs ? result.limit : null, data: module.session.save(),
      method: count === 1 && fallback ? 'playback' : 'driver', driver: driver.name, fallback };
  } finally { module.delete(); }
}

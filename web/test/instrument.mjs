// Checks the instrument interface of editing sessions: what each kind of instrument holds,
// the numbered sequences, the DPCM samples, and the .fti files.
//
//   node test/instrument.mjs

import createDnFT from '../dist/dnft.mjs';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.join(here, '..', '..', 'demo');

const RATE = 48000;
const CHUNK = 1024;

// The tracker's values (FamiTrackerTypes.h, APU/Types.h, Instrument.h)
const NOTE_C = 1;
const INST = { '2A03': 1, VRC6: 2, VRC7: 3, FDS: 4, N163: 5, S5B: 6 };
const CHIP = { NONE: 0, VRC6: 1, VRC7: 2, FDS: 4, MMC5: 8, N163: 16, S5B: 32 };
const SEQ_VOLUME = 0, SEQ_ARPEGGIO = 1, SEQ_PITCH = 2;

const dnft = await createDnFT();
const heap = dnft._malloc(CHUNK * 4);

const rethrow = fn => {
  try {
    return fn();
  } catch (e) {
    const message = dnft.getExceptionMessage?.(e);
    throw new Error(message ? message.at(-1) : String(e?.message ?? e));
  }
};

// Renders `ms` of audio from a session and returns the left channel.
function render(source, ms) {
  const frames = Math.round(ms * RATE / 1000);
  const out = new Int16Array(frames);
  for (let done = 0; done < frames; done += CHUNK) {
    source.render(heap, CHUNK);
    const pcm = dnft.HEAP16.subarray(heap >> 1, (heap >> 1) + CHUNK * 2);
    for (let i = 0; i < CHUNK && done + i < frames; ++i)
      out[done + i] = pcm[2 * i];
  }
  return out;
}

const energy = pcm => pcm.reduce((sum, s) => sum + s * s, 0) / pcm.length;
const equal = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);

// A session with the chips, and one instrument of the kind for each
function sessionWith(chips, namco = 8) {
  const s = dnft.createSession(RATE);
  s.setExpansion(chips, namco);
  return s;
}

// What an instrument says about itself, without the numbers of the slots it uses: the
// sequences in place of their numbers, the samples in place of theirs
const plain = value => JSON.parse(JSON.stringify(value, (key, item) => ArrayBuffer.isView(item) ? [...item] : item));
function normalized(session, index) {
  const inst = plain(session.instrument(index));
  delete inst.index;
  if (inst.sequences)
    inst.sequences = inst.sequences.map((entry, seqType) => ({
      enabled: entry.enabled,
      sequence: entry.enabled ? plain({ ...session.sequence(inst.type, seqType, entry.index) }) : null,
    }));
  if (inst.dpcm) {
    // a file keeps the pitch and the delta counter of the keys that have a sample only
    // (and keys that point at a sample the module does not have are not in a file)
    const samples = inst.dpcm.samples.map(slot => {
      if (!slot)
        return null;
      try {
        const { name, data } = session.sample(slot - 1);
        return [name, [...data]];
      } catch {
        return null;
      }
    });
    inst.dpcm.pitches = inst.dpcm.pitches.map((pitch, key) => samples[key] ? pitch : 0);
    inst.dpcm.deltas = inst.dpcm.deltas.map((delta, key) => samples[key] ? delta : -1);
    inst.dpcm.samples = samples;
  }
  return inst;
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    ++failures;
    console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ') ?? e.message}`);
  }
}

const bytes = (...values) => Uint8Array.from(values);
const ramp = (length, top) => Uint8Array.from({ length }, (_, i) => Math.floor(i * top / (length - 1)));

check('a new 2A03 instrument has no DPCM samples and its own sequences', () => {
  const s = dnft.createSession(RATE);
  const inst = s.instrument(0);
  assert.equal(inst.type, INST['2A03']);
  assert.equal(inst.sequences.length, 5);
  assert.equal(inst.dpcm.samples.length, 96);
  assert.ok(inst.dpcm.samples.every(v => v === 0));
  assert.ok(inst.dpcm.deltas.every(v => v === -1));
  assert.equal(inst.fds, undefined);
  assert.equal(s.samples().samples.length, 0);
  s.delete();
});

check('the DPCM samples of a module: added, listed, read back, renamed by replacing, removed', () => {
  const s = dnft.createSession(RATE);
  const data = bytes(...Array.from({ length: 33 }, (_, i) => (i * 37) & 255));
  const first = s.setSample(-1, 'Kick', data);
  const second = s.setSample(-1, '日本語', bytes(1, 2, 3));
  assert.deepEqual([first, second], [0, 1]);
  const list = s.samples();
  assert.deepEqual(list.samples.map(x => [x.index, x.name, x.size]), [[0, 'Kick', 33], [1, '日本語', 3]]);
  assert.equal(list.used, 36);
  assert.equal(list.capacity, 0x40000);
  assert.equal(list.maxSize, 0xFF1);
  const back = s.sample(0);
  assert.equal(back.name, 'Kick');
  assert.deepEqual([...back.data], [...data]);
  // replacing keeps the slot
  assert.equal(s.setSample(0, 'Snare', bytes(9, 9)), 0);
  assert.deepEqual(s.samples().samples.map(x => [x.index, x.name, x.size]), [[0, 'Snare', 2], [1, '日本語', 3]]);
  assert.equal(s.samples().used, 5);
  s.removeSample(0);
  assert.deepEqual(s.samples().samples.map(x => x.index), [1]);
  // the freed slot is the next one used
  assert.equal(s.setSample(-1, 'Again', bytes(5)), 0);
  assert.ok(s.isModified());
  s.delete();
});

check('samples that do not fit are refused', () => {
  const s = dnft.createSession(RATE);
  assert.throws(() => rethrow(() => s.setSample(-1, 'empty', new Uint8Array(0))), /1 to 4081/);
  assert.throws(() => rethrow(() => s.setSample(-1, 'long', new Uint8Array(0xFF2))), /1 to 4081/);
  // 64 slots of 4081 bytes would be 255 KB: the 64th one still fits, the space is 256 KB
  const big = new Uint8Array(0xFF1);
  for (let i = 0; i < 64; ++i)
    assert.equal(s.setSample(-1, `s${i}`, big), i);
  assert.throws(() => rethrow(() => s.setSample(-1, 'one more', bytes(1))), /as many DPCM samples/);
  assert.throws(() => rethrow(() => s.sample(64)), /no DPCM sample/);
  assert.throws(() => rethrow(() => s.removeSample(-1)), /no DPCM sample/);
  s.delete();
});

check('a key plays the sample assigned to it, with its pitch, loop and delta', () => {
  const s = dnft.createSession(RATE);
  const noise = Uint8Array.from({ length: 129 }, (_, i) => (i * 73 + 41) & 255);
  s.setSample(-1, 'noise', noise);
  // the DPCM channel is the fifth
  const key = 3 * 12 + 0;           // C-3
  s.noteOn(4, NOTE_C, 3, 0, 16);
  assert.ok(energy(render(s, 300)) < 1, 'plays without an assignment');
  s.noteOff(4, false);
  render(s, 100);
  s.setDpcmKey(0, key, 1, 15, false, -1);
  let inst = s.instrument(0);
  assert.equal(inst.dpcm.samples[key], 1);
  assert.equal(inst.dpcm.pitches[key], 15);
  assert.equal(inst.dpcm.deltas[key], -1);
  s.noteOn(4, NOTE_C, 3, 0, 16);
  assert.ok(energy(render(s, 300)) > 100, 'silent with an assignment');
  s.noteOff(4, false);
  render(s, 200);
  // loop, another pitch and a delta start
  s.setDpcmKey(0, key, 1, 7, true, 20);
  inst = s.instrument(0);
  assert.equal(inst.dpcm.pitches[key], 0x87);
  assert.equal(inst.dpcm.deltas[key], 20);
  s.noteOn(4, NOTE_C, 3, 0, 16);
  // a looped sample goes on for much longer than its 129 bytes take at pitch 7
  const looped = render(s, 700);
  assert.ok(energy(looped.subarray(RATE / 2)) > 100, 'the loop stopped');
  s.noteOff(4, false);
  // no sample again
  s.setDpcmKey(0, key, 0, 0, false, -1);
  assert.equal(s.instrument(0).dpcm.samples[key], 0);
  assert.throws(() => rethrow(() => s.setDpcmKey(0, 96, 1, 0, false, -1)), /no key/);
  s.delete();
});

check('a sample previews without belonging to the module', () => {
  const s = dnft.createSession(RATE);
  const noise = Uint8Array.from({ length: 257 }, (_, i) => (i * 131 + 7) & 255);
  assert.ok(energy(render(s, 200)) < 1);
  s.previewSample(noise, 0, 15, false);
  assert.ok(energy(render(s, 200)) > 100, 'silent');
  s.stopPreview();
  s.delete();
});

check('FDS instruments: wave, modulation, settings and the three sequences of their own', () => {
  const s = sessionWith(CHIP.FDS);
  const index = s.addInstrument(CHIP.FDS, 'fds');
  let inst = s.instrument(index);
  assert.equal(inst.type, INST.FDS);
  assert.equal(inst.sequences, undefined);
  assert.equal(inst.fds.wave.length, 64);
  assert.equal(inst.fds.modulation.length, 32);
  assert.equal(inst.fds.sequences.length, 3);
  const wave = ramp(64, 63);
  s.setFdsWave(index, wave);
  s.setFdsModulation(index, Uint8Array.from({ length: 32 }, (_, i) => i & 7));
  s.setFdsParams(index, 300, 20, 5);
  s.setFdsSequence(index, SEQ_VOLUME, Int8Array.of(32, 24, 16, 8), 1, 3, 0);
  s.setFdsSequence(index, SEQ_PITCH, Int8Array.of(-3, 0, 3), -1, -1, 1);
  inst = s.instrument(index);
  assert.deepEqual([...inst.fds.wave], [...wave]);
  assert.deepEqual([...inst.fds.modulation], Array.from({ length: 32 }, (_, i) => i & 7));
  assert.deepEqual([inst.fds.speed, inst.fds.depth, inst.fds.delay], [300, 20, 5]);
  assert.deepEqual([...inst.fds.sequences[SEQ_VOLUME].items], [32, 24, 16, 8]);
  assert.deepEqual([inst.fds.sequences[SEQ_VOLUME].loop, inst.fds.sequences[SEQ_VOLUME].release], [1, 3]);
  assert.deepEqual([...inst.fds.sequences[SEQ_PITCH].items], [-3, 0, 3]);
  assert.equal(inst.fds.sequences[SEQ_PITCH].setting, 1);
  assert.equal(inst.fds.sequences[SEQ_ARPEGGIO].items.length, 0);
  // values are kept in range
  s.setFdsWave(index, Uint8Array.of(200, 1));
  s.setFdsParams(index, 99999, 99, 999);
  inst = s.instrument(index);
  assert.equal(inst.fds.wave[0], 63);
  assert.equal(inst.fds.wave[2], 0);
  assert.deepEqual([inst.fds.speed, inst.fds.depth, inst.fds.delay], [4095, 63, 255]);
  assert.throws(() => rethrow(() => s.setFdsSequence(index, 3, Int8Array.of(1), -1, -1, 0)), /no FDS sequence type/);
  assert.throws(() => rethrow(() => s.setFdsWave(0, wave)), /not an FDS instrument/);
  s.delete();
});

check('editing the FDS wave changes what a note held plays', () => {
  const s = sessionWith(CHIP.FDS);
  const index = s.addInstrument(CHIP.FDS, 'fds');
  const channel = s.info().channels.findIndex(c => c.chip === CHIP.FDS);
  assert.ok(channel > 0);
  s.setFdsWave(index, Uint8Array.from({ length: 64 }, (_, i) => i < 32 ? 0 : 63));
  s.setFdsParams(index, 0, 0, 0);
  s.noteOn(channel, NOTE_C, 3, index, 16);
  render(s, 200);
  const square = render(s, 300);
  s.setFdsWave(index, Uint8Array.from({ length: 64 }, (_, i) => Math.round(31.5 + 31.5 * Math.sin(i * Math.PI / 32))));
  render(s, 100);
  const sine = render(s, 300);
  assert.ok(energy(square) > 100 && energy(sine) > 100, 'silent');
  assert.ok(!equal(square, sine), 'the wave changed nothing');
  // a square wave is louder than a sine of the same height
  assert.ok(energy(square) > energy(sine));
  s.delete();
});

check('N163 instruments: waves of a size, a position and a count', () => {
  const s = sessionWith(CHIP.N163, 4);
  const index = s.addInstrument(CHIP.N163, 'n163');
  let inst = s.instrument(index);
  assert.equal(inst.type, INST.N163);
  assert.equal(inst.sequences.length, 5);
  assert.deepEqual([inst.n163.waveSize, inst.n163.wavePos, inst.n163.waveCount], [32, 0, 1]);
  assert.equal(inst.n163.waves.length, 32);
  const waves = Uint8Array.from({ length: 16 * 3 }, (_, i) => (i * 5) & 15);
  const result = s.setN163(index, 16, 64, 3, waves);
  assert.deepEqual({ ...result }, { waveSize: 16, wavePos: 64, waveCount: 3 });
  inst = s.instrument(index);
  assert.deepEqual([...inst.n163.waves], [...waves]);
  // one wave
  s.setN163Wave(index, 1, Uint8Array.from({ length: 16 }, () => 15));
  inst = s.instrument(index);
  assert.deepEqual([...inst.n163.waves.subarray(16, 32)], Array(16).fill(15));
  assert.deepEqual([...inst.n163.waves.subarray(0, 16)], [...waves.subarray(0, 16)]);
  // sizes are multiples of 4, the position leaves room for the wave
  const odd = s.setN163(index, 30, 250, 1, new Uint8Array(30));
  assert.deepEqual({ ...odd }, { waveSize: 28, wavePos: 212, waveCount: 1 });
  assert.equal({ ...s.setN163(index, 1000, 0, 100, new Uint8Array(0)) }.waveSize, 240);
  assert.equal(s.instrument(index).n163.waveCount, 64);
  assert.throws(() => rethrow(() => s.setN163Wave(index, 64, new Uint8Array(0))), /no wave/);
  assert.throws(() => rethrow(() => s.setN163(0, 32, 0, 1, new Uint8Array(32))), /not an N163 instrument/);
  s.delete();
});

check('editing an N163 wave changes what a note held plays', () => {
  const s = sessionWith(CHIP.N163, 1);
  const index = s.addInstrument(CHIP.N163, 'n163');
  const channel = s.info().channels.findIndex(c => c.chip === CHIP.N163);
  assert.ok(channel > 0);
  s.setN163(index, 32, 0, 1, Uint8Array.from({ length: 32 }, (_, i) => i < 16 ? 0 : 15));
  s.noteOn(channel, NOTE_C, 3, index, 16);
  render(s, 200);
  const square = render(s, 300);
  s.setN163Wave(index, 0, Uint8Array.from({ length: 32 }, (_, i) => Math.round(7.5 + 7.5 * Math.sin(i * Math.PI / 16))));
  render(s, 100);
  const sine = render(s, 300);
  assert.ok(energy(square) > 100 && energy(sine) > 100, 'silent');
  assert.ok(!equal(square, sine), 'the wave changed nothing');
  assert.ok(energy(square) > energy(sine));
  s.delete();
});

check('VRC7 instruments: a patch and the registers of their own', () => {
  const s = sessionWith(CHIP.VRC7);
  const index = s.addInstrument(CHIP.VRC7, 'vrc7');
  let inst = s.instrument(index);
  assert.equal(inst.type, INST.VRC7);
  assert.equal(inst.vrc7.patch, 0);
  assert.deepEqual([...inst.vrc7.registers], [0x01, 0x21, 0x00, 0x00, 0x00, 0xF0, 0x00, 0x0F]);
  s.setVrc7(index, 5, bytes(1, 2, 3, 4, 5, 6, 7, 8));
  inst = s.instrument(index);
  assert.equal(inst.vrc7.patch, 5);
  assert.deepEqual([...inst.vrc7.registers], [1, 2, 3, 4, 5, 6, 7, 8]);
  s.setVrc7(index, 99, [300, -5, 0, 0, 0, 0, 0, 0]);
  assert.equal(s.instrument(index).vrc7.patch, 15);
  assert.equal(s.instrument(index).vrc7.registers[0], 255);
  assert.equal(s.instrument(index).vrc7.registers[1], 0);
  const patches = s.vrc7Patches();
  assert.equal(patches.patches.length, 16 * 8);
  assert.equal(patches.names.length, 16);
  assert.ok(patches.names[1].length > 0);
  // the chip's first patch is the same for every VRC7
  assert.ok([...patches.patches.subarray(8, 16)].some(v => v !== 0));
  assert.throws(() => rethrow(() => s.setVrc7(0, 1, new Uint8Array(8))), /not a VRC7/);
  s.delete();
});

check('a VRC7 patch chosen sounds different from the instrument\'s own', () => {
  const s = sessionWith(CHIP.VRC7);
  const index = s.addInstrument(CHIP.VRC7, 'vrc7');
  const channel = s.info().channels.findIndex(c => c.chip === CHIP.VRC7);
  const play = () => {
    s.noteOn(channel, NOTE_C, 3, index, 16);
    render(s, 100);
    const pcm = render(s, 300);
    s.noteOff(channel, false);
    render(s, 300);
    return pcm;
  };
  s.setVrc7(index, 0, bytes(0x01, 0x21, 0x00, 0x00, 0x00, 0xF0, 0x00, 0x0F));
  const own = play();
  s.setVrc7(index, 3, bytes(0x01, 0x21, 0x00, 0x00, 0x00, 0xF0, 0x00, 0x0F));
  const patch = play();
  assert.ok(energy(own) > 100 && energy(patch) > 100, 'silent');
  assert.ok(!equal(own, patch));
  s.delete();
});

check('numbered sequences: the next free number, and a clone in it', () => {
  const s = dnft.createSession(RATE);
  const before = s.instrument(0).sequences[SEQ_VOLUME];
  s.setSequence(INST['2A03'], SEQ_VOLUME, before.index, Int8Array.of(15, 10, 5), -1, -1, 0);
  s.setInstrumentSequence(0, SEQ_VOLUME, true, before.index);
  // the sequence in use has something in it: the next number is another
  const next = s.nextFreeSequence(0, SEQ_VOLUME);
  assert.ok(next >= 0 && next !== before.index, `next ${next}`);
  const clone = s.cloneSequence(0, SEQ_VOLUME);
  assert.equal(clone, next);
  const inst = s.instrument(0);
  assert.equal(inst.sequences[SEQ_VOLUME].index, clone);
  assert.deepEqual([...s.sequence(INST['2A03'], SEQ_VOLUME, clone).items], [15, 10, 5]);
  // the original is untouched, and the clone is its own
  assert.deepEqual([...s.sequence(INST['2A03'], SEQ_VOLUME, before.index).items], [15, 10, 5]);
  s.setSequence(INST['2A03'], SEQ_VOLUME, clone, Int8Array.of(1), -1, -1, 0);
  assert.deepEqual([...s.sequence(INST['2A03'], SEQ_VOLUME, before.index).items], [15, 10, 5]);
  // an empty sequence of the instrument may keep its number
  assert.equal(s.nextFreeSequence(0, SEQ_ARPEGGIO), s.instrument(0).sequences[SEQ_ARPEGGIO].index);
  // the FDS has none of these
  const t = sessionWith(CHIP.FDS);
  const fds = t.addInstrument(CHIP.FDS, 'fds');
  assert.throws(() => rethrow(() => t.nextFreeSequence(fds, SEQ_VOLUME)), /no numbered sequences/);
  assert.throws(() => rethrow(() => t.cloneSequence(fds, SEQ_VOLUME)), /no numbered sequences/);
  assert.throws(() => rethrow(() => t.setInstrumentSequence(fds, SEQ_VOLUME, true, 0)), /no numbered sequences/);
  t.delete();
  s.delete();
});

check('no cloning when every number of the kind is taken', () => {
  const s = dnft.createSession(RATE);
  // 128 instruments would not fit: 64 is the most, so fill 64 volume sequences and clone
  // one instrument's sequence into the 65th number
  for (let i = 0; i < 63; ++i)
    s.addInstrument(0, `i${i}`);
  const insts = s.instruments();
  assert.equal(insts.length, 64);
  insts.forEach((entry, i) => {
    const seq = s.instrument(entry.index).sequences[SEQ_VOLUME];
    s.setSequence(INST['2A03'], SEQ_VOLUME, seq.index, Int8Array.of(i + 1), -1, -1, 0);
    s.setInstrumentSequence(entry.index, SEQ_VOLUME, true, seq.index);
  });
  // 64 numbers taken of 128: a free one is left
  assert.ok(s.nextFreeSequence(0, SEQ_VOLUME) >= 0);
  s.delete();
});

// ---- .fti files ---------------------------------------------------------------------------

const text = bytes => String.fromCharCode(...bytes);

check('an .fti file: FTI2.4, the type, the name, and what the kind of instrument writes', () => {
  const s = sessionWith(CHIP.VRC7);
  const index = s.addInstrument(CHIP.VRC7, 'Bell');
  s.setVrc7(index, 0, bytes(1, 2, 3, 4, 5, 6, 7, 8));
  const file = s.saveInstrument(index);
  assert.equal(text(file.subarray(0, 6)), 'FTI2.4');
  assert.equal(file[6], INST.VRC7);
  const view = new DataView(file.buffer, file.byteOffset);
  assert.equal(view.getUint32(7, true), 4);
  assert.equal(text(file.subarray(11, 15)), 'Bell');
  // the patch (4 bytes) and 8 registers
  assert.equal(view.getUint32(15, true), 0);
  assert.deepEqual([...file.subarray(19)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(file.length, 27);
  s.delete();
});

check('every kind of instrument survives saving and loading', () => {
  const s = sessionWith(CHIP.VRC6 | CHIP.VRC7 | CHIP.FDS | CHIP.N163 | CHIP.S5B, 3);
  s.setSample(-1, 'Snare', Uint8Array.from({ length: 65 }, (_, i) => (i * 11) & 255));
  s.setSample(-1, 'Hat', Uint8Array.from({ length: 17 }, (_, i) => (i * 7) & 255));
  // the 2A03 instrument with sequences and two keys
  s.setSequence(INST['2A03'], SEQ_VOLUME, s.instrument(0).sequences[SEQ_VOLUME].index, Int8Array.of(15, 12, 9), 1, -1, 0);
  s.setInstrumentSequence(0, SEQ_VOLUME, true, s.instrument(0).sequences[SEQ_VOLUME].index);
  s.setDpcmKey(0, 36, 2, 9, true, 30);
  s.setDpcmKey(0, 37, 1, 15, false, -1);
  s.setInstrumentName(0, 'Drums');
  const fds = s.addInstrument(CHIP.FDS, 'FDS lead');
  s.setFdsWave(fds, ramp(64, 63));
  s.setFdsModulation(fds, Uint8Array.from({ length: 32 }, (_, i) => (i * 3) & 7));
  s.setFdsParams(fds, 1234, 33, 44);
  s.setFdsSequence(fds, SEQ_VOLUME, Int8Array.of(32, 20, 10), -1, 2, 0);
  s.setFdsSequence(fds, SEQ_ARPEGGIO, Int8Array.of(0, 4, 7), 0, -1, 2);
  s.setFdsSequence(fds, SEQ_PITCH, Int8Array.of(-8, 8), -1, -1, 1);
  const n163 = s.addInstrument(CHIP.N163, 'Wave');
  s.setN163(n163, 20, 100, 2, Uint8Array.from({ length: 40 }, (_, i) => (i * 3) & 15));
  s.setSequence(INST.N163, SEQ_VOLUME, s.instrument(n163).sequences[SEQ_VOLUME].index, Int8Array.of(15, 5), -1, -1, 0);
  s.setInstrumentSequence(n163, SEQ_VOLUME, true, s.instrument(n163).sequences[SEQ_VOLUME].index);
  const vrc7 = s.addInstrument(CHIP.VRC7, 'Bell');
  s.setVrc7(vrc7, 7, bytes(9, 8, 7, 6, 5, 4, 3, 2));
  const vrc6 = s.addInstrument(CHIP.VRC6, 'Saw');
  s.setSequence(INST.VRC6, SEQ_ARPEGGIO, s.instrument(vrc6).sequences[SEQ_ARPEGGIO].index, Int8Array.of(0, 12), 0, -1, 0);
  s.setInstrumentSequence(vrc6, SEQ_ARPEGGIO, true, s.instrument(vrc6).sequences[SEQ_ARPEGGIO].index);
  const s5b = s.addInstrument(CHIP.S5B, 'Beep');

  // into a session of the same kind: what the instrument says about itself is the same
  // (the sequences and samples get the numbers the target has free)
  for (const index of [0, fds, n163, vrc7, vrc6, s5b]) {
    const file = s.saveInstrument(index);
    const t = sessionWith(CHIP.VRC6 | CHIP.VRC7 | CHIP.FDS | CHIP.N163 | CHIP.S5B, 3);
    const before = t.instruments().length;
    const loaded = t.loadInstrument(file);
    assert.equal(loaded, before, 'the slot');
    assert.equal(t.instruments().length, before + 1);
    const want = normalized(s, index), got = normalized(t, loaded);
    if (index === 0) {
      // the samples came with it, and the keys point at them
      assert.deepEqual(t.samples().samples.map(x => x.name).sort(), ['Hat', 'Snare']);
    }
    assert.deepEqual(got, want, `instrument ${index}`);
    if (index === 0) {
      const key = t.instrument(loaded).dpcm;
      // key 36 played slot 2 (Hat), key 37 slot 1 (Snare)
      assert.equal(t.sample(key.samples[36] - 1).name, 'Hat');
      assert.equal(t.sample(key.samples[37] - 1).name, 'Snare');
      assert.deepEqual([...t.sample(key.samples[36] - 1).data], [...s.sample(s.instrument(0).dpcm.samples[36] - 1).data]);
    }
    t.delete();
  }
  s.delete();
});

check('a sample already in the module is not added again by loading an instrument', () => {
  const s = dnft.createSession(RATE);
  s.setSample(-1, 'Kick', Uint8Array.from({ length: 33 }, (_, i) => i * 5));
  s.setDpcmKey(0, 24, 1, 15, false, -1);
  const file = s.saveInstrument(0);
  const loaded = s.loadInstrument(file);
  assert.equal(loaded, 1);
  assert.equal(s.samples().samples.length, 1);
  assert.equal(s.instrument(loaded).dpcm.samples[24], 1);
  s.delete();
});

check('instruments load into a module that lacks the chip', () => {
  const s = sessionWith(CHIP.FDS);
  const fds = s.addInstrument(CHIP.FDS, 'FDS');
  s.setFdsParams(fds, 77, 1, 2);
  const file = s.saveInstrument(fds);
  const t = dnft.createSession(RATE);
  const loaded = t.loadInstrument(file);
  assert.equal(t.instrument(loaded).type, INST.FDS);
  assert.equal(t.instrument(loaded).fds.speed, 77);
  t.delete();
  s.delete();
});

check('files that are not instruments are refused, and leave the module as it was', () => {
  const s = dnft.createSession(RATE);
  const before = s.instruments().length;
  assert.throws(() => rethrow(() => s.loadInstrument(new Uint8Array(0))), /./);
  assert.throws(() => rethrow(() => s.loadInstrument(bytes(...'not an instrument'.split('').map(c => c.charCodeAt(0))))), /./);
  assert.throws(() => rethrow(() => s.loadInstrument(bytes(...'FTI9.9'.split('').map(c => c.charCodeAt(0)), 1))), /./);
  assert.equal(s.instruments().length, before);
  s.delete();
});

check('every cut-short or damaged .fti is refused or loads whole, never half', () => {
  const s = sessionWith(CHIP.VRC6 | CHIP.VRC7 | CHIP.FDS | CHIP.N163 | CHIP.S5B, 2);
  s.setSample(-1, 'S', Uint8Array.from({ length: 33 }, (_, i) => i));
  s.setDpcmKey(0, 12, 1, 15, false, 5);
  const files = [
    s.saveInstrument(0),
    s.saveInstrument(s.addInstrument(CHIP.FDS, 'f')),
    s.saveInstrument(s.addInstrument(CHIP.N163, 'n')),
    s.saveInstrument(s.addInstrument(CHIP.VRC7, 'v')),
    s.saveInstrument(s.addInstrument(CHIP.VRC6, 'v6')),
  ];
  let random = 12345;
  const next = () => (random = (random * 1103515245 + 12345) & 0x7fffffff);
  const t = dnft.createSession(RATE);
  let refused = 0, accepted = 0;
  const attempt = data => {
    const before = t.instruments().map(i => i.index);
    let loaded = -1;
    try {
      loaded = rethrow(() => t.loadInstrument(data));
    } catch {
      ++refused;
    }
    const after = t.instruments().map(i => i.index);
    if (loaded < 0) {
      assert.deepEqual(after, before, `a refused file left an instrument behind: ${[...data].join(',')}`);
    } else {
      ++accepted;
      assert.deepEqual(after, [...before, loaded]);
      // it can be read and saved again
      t.instrument(loaded);
      assert.ok(t.saveInstrument(loaded).length > 6);
      t.removeInstrument(loaded);
    }
  };
  for (const file of files) {
    // every prefix, then damaged bytes
    for (let length = 0; length < file.length; ++length)
      attempt(file.subarray(0, length));
    for (let n = 0; n < 150; ++n) {
      const damaged = file.slice();
      for (let k = 0; k < 1 + next() % 4; ++k)
        damaged[next() % damaged.length] = next() & 255;
      attempt(damaged);
    }
    attempt(file);
  }
  assert.ok(refused > 100, `${refused} refused`);
  assert.ok(accepted >= files.length, `${accepted} accepted`);
  // the session still works
  t.noteOn(0, NOTE_C, 4, 0, 16);
  assert.ok(energy(render(t, 200)) > 100);
  t.delete();
  s.delete();
});

const withHeap = (bytes, fn) => {
  const at = dnft._malloc(bytes.length);
  dnft.HEAPU8.set(bytes, at);
  try {
    return fn(at, bytes.length);
  } finally {
    dnft._free(at);
  }
};

check('the instruments of the demo modules read as they are, and come through .fti files unchanged', () => {
  const files = readdirSync(demoDir).filter(f => /\.(dnm|0cc|ftm)$/i.test(f)).sort();
  assert.ok(files.length > 0, 'no demo modules');
  let instruments = 0, withSamples = 0;
  for (const file of files) {
    const bytes = readFileSync(path.join(demoDir, file));
    const s = withHeap(bytes, (at, size) => rethrow(() => dnft.openSession(at, size, RATE)));
    const info = s.info();
    // a module with the chips of that one takes the instruments
    const t = sessionWith(info.chips, info.namcoChannels || 1);
    for (const { index, type } of s.instruments()) {
      const want = normalized(s, index);
      const fti = s.saveInstrument(index);
      assert.equal(String.fromCharCode(...fti.subarray(0, 6)), 'FTI2.4');
      assert.equal(fti[6], type);
      const loaded = rethrow(() => t.loadInstrument(fti));
      assert.deepEqual(normalized(t, loaded), want, `${file}: instrument ${index}`);
      // saving what was loaded gives the same file (a file names the slots of its samples,
      // which the module it is loaded into numbers as it likes)
      if (!want.dpcm || !want.dpcm.samples.some(sample => sample))
        assert.deepEqual([...t.saveInstrument(loaded)], [...fti], `${file}: instrument ${index} saved again`);
      ++instruments;
      if (want.dpcm?.samples.some(sample => sample))
        ++withSamples;
    }
    t.delete();
    s.delete();
  }
  assert.ok(instruments > 20, `${instruments} instruments`);
  console.log(`     (${instruments} instruments of ${files.length} modules, ${withSamples} of them with DPCM samples)`);
});

// A 2A03 instrument file made by hand: the keys [{note (the key: octave * 12 + semitone), sample (slot + 1), pitch, delta}] and
// the samples [{slot, name, data}] the file lists, `used` the count it gives for them
function ftiOf({ name = 'hand', keys, samples, used = samples.length }) {
  const out = [];
  const int = value => out.push(value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255);
  out.push(...'FTI2.4'.split('').map(c => c.charCodeAt(0)), INST['2A03']);
  int(name.length);
  out.push(...name.split('').map(c => c.charCodeAt(0)));
  out.push(5, 0, 0, 0, 0, 0);            // five sequences, none in use
  int(keys.length);
  for (const key of keys)
    out.push(key.note, key.sample, key.pitch ?? 15, key.delta ?? 255);
  int(used);
  for (const sample of samples) {
    int(sample.slot);
    int(sample.name.length);
    out.push(...sample.name.split('').map(c => c.charCodeAt(0)));
    int(sample.data.length);
    out.push(...sample.data);
  }
  return Uint8Array.from(out);
}

const sampleOf = (slot, name, fill) => ({ slot, name, data: Array.from({ length: 17 }, (_, i) => (fill + i) & 255) });

check('the keys at the ends of the keyboard, and at the start of an octave, come through a file', () => {
  const s = dnft.createSession(RATE);
  s.setSample(-1, 'Kick', Uint8Array.from({ length: 17 }, (_, i) => i + 1));
  const keys = [0, 1, 11, 12, 13, 47, 48, 95];
  keys.forEach((key, i) => s.setDpcmKey(0, key, 1, i, i % 2 === 1, i * 3));
  const t = dnft.createSession(RATE);
  const loaded = rethrow(() => t.loadInstrument(s.saveInstrument(0)));
  const want = s.instrument(0).dpcm, got = t.instrument(loaded).dpcm;
  assert.equal([...got.samples].filter(v => v).length, keys.length, 'the keys with a sample');
  for (const key of keys) {
    assert.equal(got.samples[key], want.samples[key], `key ${key}`);
    assert.equal(got.pitches[key], want.pitches[key], `key ${key}`);
    assert.equal(got.deltas[key], want.deltas[key], `key ${key}`);
  }
  s.delete();
  t.delete();
});

check('a key that points at a sample the module does not have is left out of the file', () => {
  const s = dnft.createSession(RATE);
  s.setSample(-1, 'Kick', Uint8Array.from({ length: 17 }, (_, i) => i + 1));
  s.setDpcmKey(0, 24, 3, 15, false, -1);        // slot 2: nothing there
  s.setDpcmKey(0, 25, 1, 9, true, 4);
  const file = s.saveInstrument(0);
  const t = dnft.createSession(RATE);
  const loaded = rethrow(() => t.loadInstrument(file));
  const keys = t.instrument(loaded).dpcm;
  assert.equal(keys.samples[24], 0);
  assert.equal(keys.samples[25], 1);
  assert.equal(keys.pitches[25], 0x89);
  assert.equal(keys.deltas[25], 4);
  assert.deepEqual(t.samples().samples.map(x => x.name), ['Kick']);
  // the module itself still has the key
  assert.equal(s.instrument(0).dpcm.samples[24], 3);
  s.delete();
  t.delete();
});

check('files of the desktop that count more samples than they list are read, the missing ones without keys', () => {
  const t = dnft.createSession(RATE);
  // the third key's sample (slot 5) is not in the list, though the count says it is
  const file = ftiOf({
    keys: [{ note: 12, sample: 1 }, { note: 13, sample: 2 }, { note: 14, sample: 6 }],
    samples: [sampleOf(0, 'a', 1), sampleOf(1, 'b', 50)], used: 3,
  });
  const loaded = rethrow(() => t.loadInstrument(file));
  const { dpcm } = t.instrument(loaded);
  assert.equal(t.sample(dpcm.samples[12] - 1).name, 'a');
  assert.equal(t.sample(dpcm.samples[13] - 1).name, 'b');
  assert.equal(dpcm.samples[14], 0);
  assert.equal(t.samples().samples.length, 2);
  // the module has another sample in slot 5 by now: the key must not play that
  const u = dnft.createSession(RATE);
  for (let i = 0; i < 6; ++i)
    u.setSample(-1, `other${i}`, bytes(i, i, i));
  const there = rethrow(() => u.loadInstrument(file));
  assert.equal(u.instrument(there).dpcm.samples[14], 0);
  t.delete();
  u.delete();
});

check('a file that ends inside a sample is refused, one that ends between samples is not', () => {
  const t = dnft.createSession(RATE);
  const file = ftiOf({ keys: [{ note: 12, sample: 1 }, { note: 13, sample: 2 }], samples: [sampleOf(0, 'first', 1), sampleOf(1, 'second', 9)] });
  const first = ftiOf({ keys: [{ note: 12, sample: 1 }, { note: 13, sample: 2 }], samples: [sampleOf(0, 'first', 1)], used: 2 });
  assert.equal(first.length < file.length, true);
  // the whole first sample and nothing of the second: the second key has no sample
  const loaded = rethrow(() => t.loadInstrument(first));
  assert.equal(t.instrument(loaded).dpcm.samples[13], 0);
  t.removeInstrument(loaded);
  // every cut inside the data of the samples is refused
  for (let length = first.length + 1; length < file.length; ++length)
    assert.throws(() => rethrow(() => t.loadInstrument(file.subarray(0, length))), /Unexpected end/, `cut at ${length} of ${file.length}`);
  assert.equal(t.instruments().length, 1);
  assert.equal(t.samples().samples.length, 1);
  t.delete();
});

check('a module with all its instruments saves and opens again with them', () => {
  const s = sessionWith(CHIP.FDS | CHIP.N163, 2);
  s.setSample(-1, 'S', Uint8Array.from({ length: 17 }, (_, i) => i * 3));
  s.setDpcmKey(0, 36, 1, 12, true, 9);
  const fds = s.addInstrument(CHIP.FDS, 'f');
  s.setFdsWave(fds, ramp(64, 63));
  s.setFdsSequence(fds, SEQ_VOLUME, Int8Array.of(30, 10), 0, -1, 0);
  const n163 = s.addInstrument(CHIP.N163, 'n');
  s.setN163(n163, 16, 32, 2, Uint8Array.from({ length: 32 }, (_, i) => i & 15));
  const file = s.save();
  const at = dnft._malloc(file.length);
  dnft.HEAPU8.set(file, at);
  const t = dnft.openSession(at, file.length, RATE);
  dnft._free(at);
  for (const index of [0, fds, n163])
    assert.deepEqual(JSON.stringify(t.instrument(index), (k, v) => ArrayBuffer.isView(v) ? [...v] : v), JSON.stringify(s.instrument(index), (k, v) => ArrayBuffer.isView(v) ? [...v] : v));
  assert.deepEqual(t.samples().samples.map(x => x.name), ['S']);
  t.delete();
  s.delete();
});

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall passed');

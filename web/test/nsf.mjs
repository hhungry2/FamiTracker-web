// Checks the NSF import: the analyzer (dist/dnft-nsf.mjs, NSFPlay) reads NSFs and writes
// down their frames, and the engine makes modules of them (importNsf()) that sound like the
// NSFs. The NSFs are the tracker's own exports of the demo modules and of modules made here
// for each expansion chip; the modules made of them are compared with the modules they came
// from, channel by channel, by their short-time spectra (the phase of a channel may differ:
// the NSF driver restarts it where the tracker's playback does not).
//
//   node test/nsf.mjs

import createDnFT from '../dist/dnft.mjs';
import { likeness } from './nsf-audio.mjs';
import createDnFTNsf from '../dist/dnft-nsf.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.join(here, '..', '..', 'demo');
const RATE = 48000;
const WAVE_RATE = 44100;

// The tracker's values (APU/Types.h, FamiTrackerTypes.h)
const SNDCHIP = { VRC6: 1, VRC7: 2, FDS: 4, MMC5: 8, N163: 16, S5B: 32 };
const EMPTY = [0, 0, 16, 64, 0, 0, 0, 0, 0, 0, 0, 0];
const HALT = 14;
const EF_JUMP = 2, EF_SKIP = 3, EF_HALT = 4;

const dnft = await createDnFT();
const nsf = await createDnFTNsf();

function inHeap(module, bytes, fn) {
  const at = module._malloc(bytes.length);
  module.HEAPU8.set(bytes, at);
  try {
    return fn(at, bytes.length);
  } finally {
    module._free(at);
  }
}
const message = e => e instanceof WebAssembly.Exception ? dnft.getExceptionMessage(e).at(-1) : e.message;
const rethrow = fn => {
  try {
    return fn();
  } catch (e) {
    throw new Error(message(e));
  }
};

const openSession = bytes => inHeap(dnft, bytes, (at, size) => rethrow(() => dnft.openSession(at, size, RATE)));
const nsfInfo = bytes => inHeap(nsf, bytes, (at, size) => nsf.nsfInfo(at, size));

// The frame log of `seconds` of the song (at 60 frames a second)
function analyze(bytes, seconds, song = 0) {
  const analysis = new nsf.NsfAnalysis();
  try {
    assert.equal(inHeap(nsf, bytes, (at, size) => analysis.load(at, size)), '');
    assert.ok(analysis.start(song, -1, Math.round(seconds * 60)));
    while (!analysis.done())
      analysis.run(600);
    return analysis.log();
  } finally {
    analysis.delete();
  }
}

const importNsf = (log, options = {}) => inHeap(dnft, log, (at, size) => rethrow(() => dnft.importNsf(at, size, RATE, options)));

// The wave export of a session, mono, with the channels of `muted` silent
function wave(session, seconds, muted = 0) {
  rethrow(() => session.beginWave(0, 0, seconds, muted, WAVE_RATE));
  const parts = [];
  let total = 0;
  for (;;) {
    const r = rethrow(() => session.renderWave(WAVE_RATE));
    parts.push(r.samples);
    total += r.samples.length;
    if (r.done)
      break;
  }
  session.endWave();
  const out = new Int16Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// Each channel alone, all the channels: the muted masks of `count` channels
const solo = (channel, count) => 2 ** count - 1 - 2 ** channel;
const energy = pcm => pcm.reduce((sum, s) => sum + s * s, 0) / Math.max(1, pcm.length);

// Each channel of a session alone: {names, waves}. A session renders only while it has the
// sound generator, which the session made last has: the original's come first.
function soloWaves(session, seconds) {
  const names = session.info().channels.map(c => c.name);
  return { names, seconds, waves: names.map((_, c) => wave(session, seconds, solo(c, names.length))) };
}

// The channels of the module made of the NSF, each alone, against the original's
// (soloWaves()): [{name, likeness}] for the channels that sound
function compareChannels(before, imported) {
  const { names, seconds, waves } = before;
  assert.deepEqual(imported.info().channels.map(c => c.name), names, 'the import has the channels of the module');
  return names.map((name, c) => {
    if (energy(waves[c]) < 1)
      return null;
    return { name, likeness: likeness(waves[c], wave(imported, seconds, solo(c, names.length))) };
  }).filter(Boolean);
}

// A module of the given chips, made with an editing session, as test/seek.mjs makes them:
// every channel plays a note every four rows, some with a vibrato or an arpeggio, each frame
// another pattern; the song loops back to its start.
function makeSession(chips, frames, emptyRows = 0) {
  const session = dnft.createSession(RATE);
  session.setExpansion(chips, 4);
  const channels = [];
  const add = (chip, count) => { for (let i = 0; i < count; ++i) channels.push(chip); };
  add(0, 5);
  for (const [chip, count] of [[SNDCHIP.VRC6, 3], [SNDCHIP.VRC7, 6], [SNDCHIP.FDS, 1], [SNDCHIP.MMC5, 2], [SNDCHIP.N163, 4], [SNDCHIP.S5B, 3]])
    if (chips & chip)
      add(chip, count);
  const instruments = {};
  const instrumentOf = chip => chip === 0 ? 0 : instruments[chip] ??= session.addInstrument(chip === SNDCHIP.MMC5 ? 0 : chip, `chip ${chip}`);
  session.setFrameCount(0, frames);
  let seed = 12345;
  const random = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) % n; };
  channels.forEach((chip, channel) => {
    if (channel === 4)
      return;
    const instrument = instrumentOf(chip);
    for (let frame = 0; frame < frames; ++frame) {
      session.setFramePattern(0, frame, channel, frame);
      const cells = new Uint8Array(64 * 12);
      for (let row = 0; row < 64; ++row)
        cells.set(EMPTY, row * 12);
      for (let row = frame ? 0 : emptyRows; row < 64; row += 4) {
        const octave = chip === SNDCHIP.VRC7 || chip === SNDCHIP.FDS ? 3 + random(2) : 2 + random(3);
        cells.set([1 + random(12), octave, 16, instrument], row * 12);
        if (random(5) === 0)
          cells.set([11], row * 12 + 4), cells.set([0x47], row * 12 + 8);     // a vibrato
        else if (random(7) === 0)
          cells.set([10], row * 12 + 4), cells.set([0x37], row * 12 + 8);     // an arpeggio
      }
      session.setCells(0, channel, frame, 0, cells);
    }
  });
  return session;
}

const exportNsf = (session, kind = 'nsf') => rethrow(() => session.exportNSF(kind, 0, false)).files[0].data;

// The cells of the import's track, row after row as the song plays: [frame][channel] patterns
function cellsOf(session) {
  const track = session.track(0);
  const channels = session.info().channels.length;
  return { track, at: (frame, channel, row) => {
    const pattern = track.frameList[frame * channels + channel];
    return Array.from(session.pattern(0, channel, pattern).subarray(row * 12, row * 12 + 12));
  } };
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.log(`not ok - ${name}\n  ${e.stack ?? e}`);
  }
}

// ---- the analyzer ------------------------------------------------------------------------------

const demos = readdirSync(demoDir).filter(name => /\.(dnm|0cc|ftm)$/i.test(name)).sort();

check('the analyzer reads the header of an NSF, an NSFe and nothing else', () => {
  const session = openSession(readFileSync(path.join(demoDir, demos[0])));
  const info = session.info();
  const header = nsfInfo(exportNsf(session));
  assert.equal(header.error, '');
  assert.equal(header.title, info.title);
  assert.equal(header.artist, info.artist);
  assert.equal(header.songs, info.tracks.length);
  assert.equal(header.chips, info.chips);
  assert.equal(header.start, 0);
  assert.equal(header.regions & 1, 1);
  assert.equal(header.nsfe, false);
  const nsfe = nsfInfo(exportNsf(session, 'nsfe'));
  assert.equal(nsfe.error, '');
  assert.equal(nsfe.nsfe, true);
  assert.equal(nsfe.songs, info.tracks.length);
  assert.equal(nsfe.tracks.length, info.tracks.length);
  assert.notEqual(nsfInfo(new TextEncoder().encode('not an NSF at all')).error, '');
  session.delete();
});

check('the frame log knows the chips, the texts and how many frames were played', () => {
  const session = makeSession(SNDCHIP.VRC6 | SNDCHIP.N163, 1);
  const log = analyze(exportNsf(session), 3);
  session.delete();
  const view = new DataView(log.buffer);
  assert.equal(new TextDecoder().decode(log.subarray(0, 8)), 'DNFTNSFL');
  assert.equal(log[11], SNDCHIP.VRC6 | SNDCHIP.N163);      // chips
  assert.equal(view.getUint32(12, true), 180);              // frames
  assert.equal(log[21], 5 + 3 + 8);                         // channels: 2A03, VRC6, N163
  assert.equal(log[20], 4);                                 // the N163's channels
});

check('a file that is not an NSF is not imported', () => {
  const analysis = new nsf.NsfAnalysis();
  assert.notEqual(inHeap(nsf, new Uint8Array(200), (at, size) => analysis.load(at, size)), '');
  analysis.delete();
  assert.throws(() => importNsf(new Uint8Array(100)), /not readable/);
});

// ---- the import of the demo modules --------------------------------------------------------------

// What the channels of each demo come to at least: the noise is noise, whose phase drifts
// apart wherever the drivers write at other moments; Pxx moves the N163's pitch 64 at a time
const NOISE_LIKENESS = 0.75;
const N163_LIKENESS = 0.93;
const LIKENESS = 0.97;

for (const name of demos) {
  check(`${name}: the import sounds like the module`, () => {
    const original = openSession(readFileSync(path.join(demoDir, name)));
    const log = analyze(exportNsf(original), 20);
    const before = soloWaves(original, 12);
    // the demos do not repeat within 20 seconds
    const imported = importNsf(log, { loop: false });
    const report = imported.nsfReport();
    assert.ok(report.rows > 0);
    assert.ok(Math.abs(report.rate - 60) < 0.1, `rate ${report.rate}`);
    assert.deepEqual(report.warnings, []);
    const info = imported.info();
    assert.equal(info.chips, original.info().chips);
    assert.equal(info.title, original.info().title);
    assert.ok(info.comment.startsWith('Imported from an NSF'));
    const results = compareChannels(before, imported);
    assert.ok(results.length > 0);
    for (const { name: channel, likeness } of results) {
      const least = channel === 'Noise' ? NOISE_LIKENESS : channel.startsWith('Namco') ? N163_LIKENESS : LIKENESS;
      assert.ok(likeness >= least, `${channel}: ${likeness.toFixed(3)} < ${least}`);
    }
    original.delete();
    imported.delete();
  });
}

check('DPCM samples come in on the keys of DPCM instruments', () => {
  const name = demos.find(n => n.includes('Trapped'));
  const original = openSession(readFileSync(path.join(demoDir, name)));
  const imported = importNsf(analyze(exportNsf(original), 20));
  original.delete();
  const samples = imported.samples().samples;
  assert.ok(samples.length > 0);
  assert.ok(samples.every(sample => sample.size > 0 && sample.size <= 4081));
  const instruments = imported.instruments();
  assert.ok(instruments.some(i => i.name.startsWith('DPCM')));
  imported.delete();
});

// ---- each chip, and loops ---------------------------------------------------------------------------

// two frames of 64 rows at speed 6
const SONG_FRAMES = 2 * 64 * 6;

for (const [chip, bits] of Object.entries({ '2A03': 0, ...SNDCHIP })) {
  check(`${chip}: the import loops where the song does and sounds like it`, () => {
    const original = makeSession(bits, 2);
    // the song is 12.8 s and its first round differs (a vibrato that stays on): played
    // for 40 s, its loop is heard twice over
    const log = analyze(exportNsf(original), 40);
    // past the jump back too
    const before = soloWaves(original, 23);
    const imported = importNsf(log);
    const report = imported.nsfReport();
    assert.ok(report.loopRow >= 0, 'a loop is found');
    assert.equal(report.rows - report.loopRow, SONG_FRAMES, 'the loop is as long as the song');
    assert.equal(report.stops, false);
    // the jump back to the loop's frame, at the song's last row
    const { track, at } = cellsOf(imported);
    const last = report.rows - 1;
    const frames = track.frameList.length / imported.info().channels.length;
    const effects = [];
    for (let c = 0; c < imported.info().channels.length; ++c) {
      const cell = at(frames - 1, c, (last - report.loopRow) % track.rows);
      for (let i = 0; i < 4; ++i)
        if (cell[4 + i])
          effects.push([cell[4 + i], cell[8 + i]]);
    }
    const loopFrame = Math.ceil(report.loopRow / track.rows);
    assert.ok(effects.some(([e, p]) => e === EF_JUMP && p === loopFrame), `B${loopFrame} at the end`);
    assert.ok(report.rows + 60 < 23 * 60, 'the waves go past the jump back');
    for (const { name, likeness } of compareChannels(before, imported))
      assert.ok(likeness >= 0.99, `${name}: ${likeness.toFixed(3)}`);
    original.delete();
    imported.delete();
  });
}

// ---- the options --------------------------------------------------------------------------------------

check('rows per pattern, no loop, and the silence at the start', () => {
  // the first 16 rows (96 frames) are silent
  const original = makeSession(0, 2, 16);
  const log = analyze(exportNsf(original), 30);
  original.delete();

  const trimmed = importNsf(log, { patternLength: 64 });
  const report = trimmed.nsfReport();
  assert.equal(trimmed.track(0).rows, 64);
  assert.ok(report.trimmed >= 90 && report.trimmed <= 100, `trimmed ${report.trimmed}`);
  // the first row sounds
  const first = cellsOf(trimmed).at(0, 0, 0);
  assert.ok(first[0] >= 1 && first[0] <= 12, 'a note on the first row');
  trimmed.delete();

  const kept = importNsf(log, { patternLength: 256, trimSilence: false, loop: false });
  const keptReport = kept.nsfReport();
  assert.equal(kept.track(0).rows, 256);
  assert.equal(keptReport.trimmed, 0);
  assert.equal(keptReport.loopRow, -1);
  assert.equal(keptReport.stops, true);
  assert.equal(keptReport.rows, 30 * 60);
  // it stops at its last row
  const { track, at } = cellsOf(kept);
  const frames = track.frameList.length / kept.info().channels.length;
  const lastRow = (keptReport.rows - 1) % 256;
  const cell = at(frames - 1, 0, lastRow);
  assert.ok([0, 1, 2, 3].some(i => cell[4 + i] === EF_HALT), 'C00 at the end');
  kept.delete();
});

check('a song played for less than its length has no loop, even where it holds a note', () => {
  // the demos do not repeat themselves; at a minute and a half the songs go on
  for (const name of demos.filter(n => /Kot|Hell or High/.test(n))) {
    const original = openSession(readFileSync(path.join(demoDir, name)));
    const log = analyze(exportNsf(original), 90);
    original.delete();
    const imported = importNsf(log);
    const report = imported.nsfReport();
    imported.delete();
    assert.equal(report.loopRow, -1, name);
    assert.equal(report.stops, true);
    assert.deepEqual(report.warnings, ['noRepeat']);
    assert.equal(report.rows, 90 * 60);
  }
});

check('a song that falls silent stops there', () => {
  // a single frame that ends with a note cut on every channel and halts
  const session = dnft.createSession(RATE);
  const cells = new Uint8Array(64 * 12);
  for (let row = 0; row < 64; ++row)
    cells.set(EMPTY, row * 12);
  cells.set([10, 3, 16, 0], 0);                 // A-3
  cells.set([HALT, 0, 16, 64], 8 * 12);         // --- on row 8
  cells.set([0, 0, 16, 64, EF_HALT, 0, 0, 0, 0, 0, 0, 0], 16 * 12);   // C00 on row 16
  session.setCells(0, 0, 0, 0, cells);
  const imported = importNsf(analyze(exportNsf(session), 10));
  session.delete();
  const report = imported.nsfReport();
  assert.equal(report.stops, true);
  assert.equal(report.loopRow, -1);
  // the note (8 rows at speed 6) and its cut, then the halt
  assert.ok(report.rows >= 48 && report.rows <= 52, `rows ${report.rows}`);
  imported.delete();
});

check('the 2A03 sweep becomes Hxy and Ixy', () => {
  const session = dnft.createSession(RATE);
  const cells = new Uint8Array(64 * 12);
  for (let row = 0; row < 64; ++row)
    cells.set(EMPTY, row * 12);
  // I24: the sweep down, period 2, shift 4; H35 up
  cells.set([10, 3, 16, 0, 9, 0, 0, 0, 0x24, 0, 0, 0], 0);
  cells.set([1, 4, 16, 0, 8, 0, 0, 0, 0x35, 0, 0, 0], 16 * 12);
  session.setCells(0, 0, 0, 0, cells);
  const original = session;
  const log = analyze(exportNsf(original), 12);
  const before = soloWaves(original, 2);
  const imported = importNsf(log);
  const { at } = cellsOf(imported);
  const effects = [];
  for (let row = 0; row < 128; ++row) {
    const cell = at(0, 0, row);
    for (let i = 0; i < 4; ++i)
      if (cell[4 + i] === 8 || cell[4 + i] === 9)
        effects.push(`${cell[4 + i] === 8 ? 'H' : 'I'}${cell[8 + i].toString(16)}`);
  }
  assert.deepEqual(effects.slice(0, 2), ['I24', 'H35']);
  for (const { name, likeness } of compareChannels(before, imported))
    assert.ok(likeness >= 0.99, `${name}: ${likeness.toFixed(3)}`);
  original.delete();
  imported.delete();
});

// ---- an NSF of another driver ------------------------------------------------------------------

// An NSF made here that leaves its sound to the hardware as old drivers do: every 64 frames
// pulse 1 with the envelope decaying and the length counter running, the triangle with its
// linear counter, the noise decaying; 32 frames later pulse 2 sweeping down with its length
// counter, and a DPCM sample after a write to the delta counter. The 6502 code is put
// together by the few instructions it needs.
function handmadeNsf() {
  const LOAD = 0xC000, CODE = 0xC040;
  const code = [], labels = {}, branches = [];
  const op = (...bytes) => code.push(...bytes);
  const lda = value => op(0xA9, value);
  const sta = address => op(0x8D, address & 0xFF, address >> 8);
  const ldaAbs = address => op(0xAD, address & 0xFF, address >> 8);
  const inc = address => op(0xEE, address & 0xFF, address >> 8);
  const and = value => op(0x29, value);
  const cmp = value => op(0xC9, value);
  const bne = label => { op(0xD0, 0); branches.push([code.length - 1, label]); };
  const rts = () => op(0x60);
  const here = label => { labels[label] = code.length; };
  const write = (address, value) => { lda(value); sta(address); };

  here('init');
  write(0x4015, 0x0F);
  write(0x0000, 0);
  rts();
  here('play');
  inc(0x0000);
  ldaAbs(0x0000); and(0x3F); bne('later');
  write(0x4000, 0x83); write(0x4001, 0x08); write(0x4002, 0xFD); write(0x4003, 0x20);   // A-3, envelope, length 40
  write(0x4008, 0x30); write(0x400A, 0x9C); write(0x400B, 0x09);                        // linear counter 48
  write(0x400C, 0x02); write(0x400E, 0x06); write(0x400F, 0x20);                        // noise, envelope
  here('later');
  ldaAbs(0x0000); and(0x3F); cmp(0x20); bne('done');
  write(0x4004, 0x9C); write(0x4005, 0xA3); write(0x4006, 0x80); write(0x4007, 0xF9);   // volume 12, sweep down, length 30
  write(0x4011, 0x40); write(0x4010, 0x0F); write(0x4012, 0x00); write(0x4013, 0x01); write(0x4015, 0x1F);
  here('done');
  rts();
  for (const [at, label] of branches)
    code[at] = (labels[label] - (at + 1)) & 0xFF;

  const body = new Uint8Array(CODE - LOAD + code.length);
  for (let i = 0; i < 17; ++i)
    body[i] = i & 1 ? 0x00 : 0xFF;            // the DPCM sample, at $C000
  body.set(code, CODE - LOAD);
  const header = new Uint8Array(0x80);
  const word = (at, value) => { header[at] = value & 0xFF; header[at + 1] = value >> 8; };
  header.set([0x4E, 0x45, 0x53, 0x4D, 0x1A, 1, 1, 1]);   // NESM, version 1, 1 song, from song 1
  word(0x08, LOAD);
  word(0x0A, CODE + labels.init);
  word(0x0C, CODE + labels.play);
  header.set(new TextEncoder().encode('Hardware'), 0x0E);
  header.set(new TextEncoder().encode('test'), 0x2E);
  word(0x6E, 16639);
  word(0x78, 19997);
  const file = new Uint8Array(0x80 + body.length);
  file.set(header);
  file.set(body, 0x80);
  return file;
}

check('an NSF that leaves envelopes, lengths, the linear counter and the sweep to the hardware', () => {
  const bytes = handmadeNsf();
  const info = nsfInfo(bytes);
  assert.equal(info.title, 'Hardware');
  assert.equal(info.artist, 'test');
  assert.equal(info.periodNtsc, 16639);
  // the silence before the first notes kept, so that it lines up with NSFPlay's
  const imported = importNsf(analyze(bytes, 20), { trimSilence: false, patternLength: 64 });
  const report = imported.nsfReport();
  assert.equal(report.rows - report.loopRow, 64, 'it repeats every 64 frames');
  assert.ok(Math.abs(report.rate - 60.1) < 0.01, `rate ${report.rate}`);

  // the rows of the second frame (the loop): pulse 2's note at row 15 with I23, cut by its
  // length counter; the notes at row 47; pulse 1 and the noise decaying
  const { at } = cellsOf(imported);
  const fx = cell => [0, 1, 2, 3].filter(i => cell[4 + i]).map(i => [cell[4 + i], cell[8 + i]]);
  const pulse2 = at(1, 1, 15);
  assert.equal(pulse2[2], 12, 'pulse 2 at volume 12');
  assert.ok(fx(pulse2).some(([e, p]) => e === 9 && p === 0x23), 'I23');
  assert.equal(at(1, 1, 29)[0], HALT, 'pulse 2 cut where its length counter runs out');
  const dpcm = at(1, 4, 15);
  assert.ok(dpcm[0] >= 1 && dpcm[0] <= 12, 'a DPCM note');
  assert.ok(fx(dpcm).some(([e, p]) => e === 15 && p === 0x40), 'Z40');
  const pulse1 = at(1, 0, 47);
  assert.equal(pulse1[2], 15, 'the envelope starts at 15');
  assert.deepEqual([48, 49, 50, 51].map(r => at(1, 0, r)[2]), [16, 14, 13, 12], 'and decays a step a frame');
  assert.equal(at(1, 2, 59)[0], HALT, 'the triangle cut where its linear counter runs out');

  // each channel against NSFPlay's own playing, from the first sound on
  const seconds = 6;
  const render = mask => inHeap(nsf, bytes, (at, size) => nsf.nsfRender(at, size, 0, seconds, WAVE_RATE, mask));
  const firstSound = pcm => pcm.findIndex(v => Math.abs(v) > 200);
  const lag = firstSound(wave(imported, seconds)) - firstSound(render(0));
  assert.ok(lag >= 0 && lag < WAVE_RATE / 5, `lag ${lag}`);
  const least = { 0: 0.95, 1: 0.88, 2: 0.95, 3: 0.6, 4: 0.85 };
  for (let c = 0; c < 5; ++c) {
    const ours = wave(imported, seconds, solo(c, 5)).subarray(lag);
    const theirs = render(0x1F & ~(1 << c));
    const value = likeness(theirs, ours);
    assert.ok(value >= least[c], `channel ${c}: ${value.toFixed(3)} < ${least[c]}`);
  }
  imported.delete();
});

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log('all passed');

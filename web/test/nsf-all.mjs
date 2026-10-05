// node web/test/nsf-all.mjs
// Batch tracks must sound exactly like individual NSF imports after save/reopen.
import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import createDnFT from '../dist/dnft.mjs';
import createNsf from '../dist/dnft-nsf.mjs';
import { importAllNsfSongs, NsfModuleBatch, inImportHeap } from '../html/dnft-nsf-import.mjs';
import { emptyPattern } from '../html/dnft-song.mjs';
import { planNsfReconstruction, applyNsfReconstruction } from '../html/dnft-nsf-reconstruct.mjs';

const RATE = 48000;
const core = await createDnFT();
const staging = await createDnFT();
const nsf = await createNsf();
const options = { seconds: 4, patternLength: 64, loop: true, trimSilence: true };
const open = bytes => inImportHeap(core, bytes, (at, size) => core.openSession(at, size, RATE));
const noWait = async () => {};
const report = { rows: 16, rate: 60, loopRow: 0, warnings: [] };

function wave(session, track, seconds = 6, muted = 0) {
  session.beginWave(track, 0, seconds, muted, 44100);
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const output = session.renderWave(44100);
      parts.push(output.samples);
      size += output.samples.length;
      if (output.done) break;
    }
  } finally { session.endWave(); }
  const pcm = new Int16Array(size);
  let at = 0;
  for (const part of parts) { pcm.set(part, at); at += part.length; }
  return pcm;
}

function individual(bytes, song) {
  const analysis = new nsf.NsfAnalysis();
  try {
    assert.equal(inImportHeap(nsf, bytes, (at, size) => analysis.load(at, size)), '');
    assert.ok(analysis.start(song, -1, Math.round(options.seconds * 1e6 / 16639)));
    while (!analysis.done()) analysis.run(600);
    return inImportHeap(core, analysis.log(), (at, size) => core.importNsf(at, size, RATE, options));
  } finally { analysis.delete(); }
}

function fixture(chip, kind = 'nsfe') {
  const session = core.createSession(RATE);
  try {
    session.setExpansion(chip, 4);
    session.setTitle('All songs');
    const instrument = chip ? session.addInstrument(chip === 8 ? 0 : chip, 'First') : 0;
    const second = session.addInstrument(chip === 8 ? 0 : chip, 'Second');
    if (chip === 4) {
      session.setFdsWave(instrument, Uint8Array.from({ length: 64 }, (_, i) => i));
      session.setFdsWave(second, Uint8Array.from({ length: 64 }, (_, i) => i < 32 ? 0 : 63));
    }
    if (chip === 2) {
      session.setVrc7(instrument, 2, new Uint8Array(8));
      session.setVrc7(second, 0, Uint8Array.of(3, 0x21, 0x1A, 7, 0xF3, 0xF2, 0xA4, 0x45));
    }
    if (chip === 16) {
      session.setN163(instrument, 32, 0, 2, Uint8Array.from({ length: 64 }, (_, i) => i & 15));
      session.setN163(second, 32, 0, 2, Uint8Array.from({ length: 64 }, (_, i) => (i >> 1) & 15));
    }
    const sampleA = session.setSample(-1, 'Same name', Uint8Array.from({ length: 17 }, (_, i) => i & 1 ? 0 : 255));
    const sampleB = session.setSample(-1, 'Same name', Uint8Array.from({ length: 17 }, (_, i) => i & 1 ? 255 : 0));
    session.setDpcmKey(0, 48, sampleA + 1, 15, false, 32);
    session.setDpcmKey(0, 49, sampleB + 1, 14, true, 64);
    for (let t = 0; t < 3; ++t) {
      if (t) session.addTrack();
      session.setTrackTitle(t, ['Intro', 'Rhythm', 'Return'][t]);
      session.setPatternLength(t, 16);
      for (let c = 0; c < session.info().channels.length; ++c) {
        const cells = emptyPattern(16);
        for (let r = 0; r < 16; r += 4) {
          const key = c === 4 ? 1 + ((r / 4 + t) & 1) : 1 + (r + t * 3) % 12;
          const inst = c > 4 ? (t === 1 ? second : instrument) : 0;
          cells.set([key, 4, 12, inst], r * 12);
        }
        if (c === 0) { cells[15 * 12 + 4] = 2; cells[15 * 12 + 8] = 0; }
        session.setCells(t, c, 0, 0, cells);
      }
    }
    return session.exportNSF(kind, 0, false).files[0].data;
  } finally { session.delete(); }
}

// Minimal NSF with any number of songs. Init saves the subsong in RAM; play
// gives each a different pulse pitch, except the optional silent second song.
function manySongs(count, silent = false) {
  const code = [0x85, 0x00, 0x60]; // init: STA $00; RTS
  const play = code.length;
  const op = (...bytes) => code.push(...bytes);
  const write = (address, value) => op(0xA9, value, 0x8D, address & 255, address >> 8);
  if (silent) op(0xA5, 0, 0xC9, 1, 0xD0, 1, 0x60);
  write(0x4015, 1); write(0x4000, 0xBF); write(0x4001, 8);
  op(0xA5, 0, 0x69, 0x40, 0x8D, 2, 0x40); // LDA song; ADC #$40; STA $4002
  write(0x4003, 1); op(0x60);
  const bytes = new Uint8Array(128 + code.length);
  bytes.set([0x4E, 0x45, 0x53, 0x4D, 0x1A, 1, count, 1]);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 0x8000, true);
  view.setUint16(10, 0x8000, true);
  view.setUint16(12, 0x8000 + play, true);
  view.setUint16(0x6E, 16639, true);
  view.setUint16(0x78, 19997, true);
  bytes.set(code, 128);
  return bytes;
}

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) {
    failures++;
    const message = error instanceof WebAssembly.Exception ? core.getExceptionMessage(error).at(-1) : error.stack;
    console.error(`not ok - ${name}\n${message}`);
  }
}

for (const chip of [0, 1, 2, 4, 8, 16, 32]) {
  await check(`chip ${chip}: all 3 named NSFe songs retain per-channel PCM, loops and shared resources`, async () => {
    const bytes = fixture(chip);
    const before = [];
    let singleInstrumentCount = 0;
    for (let t = 0; t < 3; ++t) {
      const single = individual(bytes, t);
      try {
        const count = single.info().channels.length;
        singleInstrumentCount += single.instruments().length;
        before.push({ track: single.track(0), report: single.nsfReport(),
          pcm: wave(single, 0), channels: Array.from({ length: count }, (_, c) => wave(single, 0, 2, 2 ** count - 1 - 2 ** c)) });
      } finally { single.delete(); }
    }
    const progress = [];
    const parts = await importAllNsfSongs(staging, nsf, bytes, options, RATE, { onProgress: v => progress.push(v), yieldControl: noWait });
    assert.equal(parts.length, 1);
    assert.deepEqual(parts[0].songs.map(s => s.song), [0, 1, 2]);
    assert.deepEqual(parts[0].songs.map(s => s.report), before.map(s => s.report));
    assert.equal(progress.at(-1), 1);
    assert.ok(progress.every((p, i) => p >= 0 && p <= 1 && (!i || p >= progress[i - 1])));
    const merged = open(parts[0].data);
    try {
      assert.deepEqual(merged.info().tracks, ['Intro', 'Rhythm', 'Return']);
      assert.ok(merged.instruments().length < singleInstrumentCount, 'identical instruments are shared');
      assert.equal(merged.samples().samples.length, 2, 'different sample content with identical names survives');
      assert.ok(merged.info().comment.startsWith('Imported from an NSF:'));
      for (let t = 0; t < 3; ++t) {
        assert.equal(merged.track(t).frames, before[t].track.frames);
        assert.equal(merged.track(t).rows, before[t].track.rows);
        assert.deepEqual(wave(merged, t), before[t].pcm, `song ${t + 1}: 6s PCM past loop`);
        for (let c = 0; c < before[t].channels.length; ++c)
          assert.deepEqual(wave(merged, t, 2, 2 ** before[t].channels.length - 1 - 2 ** c), before[t].channels[c], `song ${t + 1}, channel ${c}`);
      }
      const plan = planNsfReconstruction(merged, 1);
      const result = applyNsfReconstruction(merged, plan, 'Reconstructed');
      if (result.track !== null) assert.deepEqual(wave(merged, result.track), before[1].pcm);
    } finally { merged.delete(); }
    if (chip === 0 && process.env.NSF_ALL_FIXTURE) writeFileSync(process.env.NSF_ALL_FIXTURE, bytes);
  });
}

await check('65 NSF songs are partitioned into 64 + 1 tracks in original order', async () => {
  const parts = await importAllNsfSongs(staging, nsf, manySongs(65), { ...options, seconds: 0.2 }, RATE, { yieldControl: noWait });
  assert.deepEqual(parts.map(p => p.songs.length), [64, 1]);
  assert.deepEqual(parts.flatMap(p => p.songs.map(s => s.song)), Array.from({ length: 65 }, (_, i) => i));
  for (const part of parts) {
    const session = open(part.data);
    assert.equal(session.info().tracks.length, part.songs.length);
    assert.equal(session.instruments().length, 1);
    session.delete();
  }
});

await check('silent songs keep their place and a warning instead of disappearing', async () => {
  const parts = await importAllNsfSongs(staging, nsf, manySongs(3, true), { ...options, seconds: 0.2 }, RATE, { yieldControl: noWait });
  assert.equal(parts[0].songs.length, 3);
  assert.deepEqual(parts[0].songs[1].report.warnings, ['silentSong']);
  const session = open(parts[0].data);
  assert.ok(wave(session, 1, 1).every(value => value === 0));
  assert.ok(wave(session, 2, 1).some(value => value !== 0));
  session.delete();
});

await check('cancellation after a converted song and invalid input leave the active session usable', async () => {
  const current = core.createSession(RATE);
  current.setTitle('Keep me');
  const saved = current.save();
  let cancel = false;
  let boundaries = 0;
  await assert.rejects(importAllNsfSongs(staging, nsf, manySongs(3), { ...options, seconds: 0.2 }, RATE, {
    onProgress: v => { if (v >= 1 / 3 && ++boundaries === 2) cancel = true; }, isCancelled: () => cancel, yieldControl: noWait,
  }), /^Error: cancelled$/);
  let imports = 0;
  const failingCore = new Proxy(staging, { get(target, key) {
    if (key === 'importNsf') return (...args) => {
      if (++imports === 2) throw new Error('conversion failed');
      return target.importNsf(...args);
    };
    return target[key];
  } });
  await assert.rejects(importAllNsfSongs(failingCore, nsf, manySongs(3), { ...options, seconds: 0.2 }, RATE,
    { yieldControl: noWait }), /Song 2: conversion failed/);
  await assert.rejects(importAllNsfSongs(staging, nsf, new Uint8Array(200), options, RATE));
  assert.deepEqual(current.save(), saved);
  assert.equal(current.info().title, 'Keep me');
  wave(current, 0, 0.1); // still owns the main engine's audio generator
  current.delete();
});

for (const limit of ['instruments', 'sampleSlots', 'sampleSpace', 'configuration']) {
  await check(`${limit}: split before exceeding module capacity or changing pitch settings`, () => {
    const batch = new NsfModuleBatch(staging, RATE, { title: 'Limits', artist: '', songs: 2 });
    try {
      for (let song = 0; song < 2; ++song) {
        const source = staging.createSession(RATE);
        try {
          source.setTrackTitle(0, `Part ${song}`);
          if (limit === 'instruments') {
            source.removeInstrument(0);
            source.setExpansion(4, 0);
            for (let i = 0; i < 40; ++i) {
              const inst = source.addInstrument(4, `FDS ${i}`);
              const data = new Uint8Array(64);
              data[0] = i; data[1] = song;
              source.setFdsWave(inst, data);
            }
          } else if (limit === 'configuration') {
            source.setExpansion(16, song ? 8 : 1);
          } else {
            for (let i = 0; i < 40; ++i) {
              const data = new Uint8Array(limit === 'sampleSlots' ? 17 : 4081);
              data[0] = i; data[1] = song;
              source.setSample(-1, 'Same name', data);
            }
          }
          const cells = emptyPattern(16);
          cells.set([1, 4, 12, 0]);
          source.setCells(0, limit === 'instruments' ? 5 : 0, 0, 0, cells);
          batch.append(source, song, report);
        } finally { source.delete(); }
      }
      batch.finishPart();
      assert.equal(batch.parts.length, 2);
      assert.deepEqual(batch.parts.map(p => p.songs[0].song), [0, 1]);
      for (const part of batch.parts) {
        const session = open(part.data);
        assert.equal(session.info().tracks.length, 1);
        assert.ok(session.instruments().length <= 64);
        assert.ok(session.samples().samples.length <= 64);
        assert.ok(session.samples().used <= session.samples().capacity);
        session.delete();
      }
    } finally { batch.delete(); }
  });
}

process.exitCode = failures ? 1 : 0;

// Reconstruct existing NSF-imported tracks, preserving every event tick and PCM.
// node web/test/nsf-reconstruct.mjs

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import createDnFT from '../dist/dnft.mjs';
import createNsf from '../dist/dnft-nsf.mjs';
import { planNsfReconstruction, applyNsfReconstruction } from '../html/dnft-nsf-reconstruct.mjs';
import { CELL, emptyPattern } from '../html/dnft-song.mjs';

const dnft = await createDnFT(), nsf = await createNsf();
const RATE = 48000, WAVE_RATE = 44100;
const SPEED = 1, JUMP = 2, SKIP = 3, HALT = 4;
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    ++failures;
    console.log(`not ok - ${name}\n  ${error instanceof WebAssembly.Exception ? dnft.getExceptionMessage(error).at(-1) : error.stack}`);
  }
};
function inHeap(module, bytes, fn) {
  const at = module._malloc(bytes.length);
  module.HEAPU8.set(bytes, at);
  try { return fn(at, bytes.length); } finally { module._free(at); }
}
const open = bytes => inHeap(dnft, bytes, (at, size) => dnft.openSession(at, size, RATE));
function importedFrom(source, frames, options = {}) {
  const bytes = source.exportNSF('nsf', 0, false).files[0].data;
  const analysis = new nsf.NsfAnalysis();
  try {
    assert.equal(inHeap(nsf, bytes, (at, size) => analysis.load(at, size)), '');
    assert.ok(analysis.start(0, -1, frames));
    while (!analysis.done()) analysis.run(600);
    return inHeap(dnft, analysis.log(), (at, size) => dnft.importNsf(at, size, RATE, options));
  } finally {
    analysis.delete();
  }
}
function wave(session, track, seconds, muted = 0) {
  session.beginWave(track, 0, seconds, muted, WAVE_RATE);
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const part = session.renderWave(WAVE_RATE);
      parts.push(part.samples);
      length += part.samples.length;
      if (part.done) break;
    }
  } finally {
    session.endWave();
  }
  const samples = new Int16Array(length);
  let at = 0;
  for (const part of parts) { samples.set(part, at); at += part.length; }
  return samples;
}
function assertPcm(session, track, seconds, muted = 0) {
  const before = wave(session, 0, seconds, muted), after = wave(session, track, seconds, muted);
  assert.equal(after.length, before.length, 'duration');
  assert.ok(after.every((sample, at) => sample === before[at]), 'PCM samples must be identical');
}
function retainOriginal(session, fn) {
  const track = session.track(0), patterns = session.patterns(0), instruments = session.instruments();
  const result = fn();
  assert.deepEqual(session.track(0), track, 'the original track is retained');
  assert.deepEqual(session.patterns(0), patterns, 'the original patterns are retained');
  assert.deepEqual(session.instruments(), instruments, 'instruments are retained');
  return result;
}

// Planning edge cases with deliberately full effect columns and terminal boundaries.
function fakeSession({ length = 64, frames = 1, channels = 1, populate = () => {} } = {}) {
  const data = Array.from({ length: channels }, () => Array.from({ length: frames }, () => emptyPattern(length)));
  populate(data);
  return {
    info: () => ({ comment: 'Imported from an NSF: test', pal: false, speedSplitPoint: 32,
      channels: Array.from({ length: channels }, () => ({})) }),
    track: () => ({ speed: 1, tempo: 150, groove: false, title: 'test', frames, rows: length,
      effColumns: Array(channels).fill(4), frameList: Uint8Array.from({ length: frames * channels }, (_, at) => Math.floor(at / channels)) }),
    pattern: (_, c, p) => data[c][p],
  };
}
const put = (pattern, row, values) => pattern.set(values, row * CELL);
function assertTicks(plan) {
  let tick = 0;
  for (const row of plan.frames.flat()) {
    assert.equal(row.tick, tick);
    assert.ok(row.duration >= 1 && row.duration < 32);
    tick += row.duration;
  }
  assert.equal(tick, plan.beforeRows);
}

check('long holds are split below the speed/tempo boundary and retain their duration', () => {
  const s = fakeSession({ length: 128, populate: data => {
    put(data[0][0], 0, [1, 3, 15, 0]);
    put(data[0][0], 127, [0, 0, 16, 64, HALT, 0, 0, 0, 0]);
  } });
  const plan = planNsfReconstruction(s, 0);
  assert.ok(plan.rows < 10);
  assertTicks(plan);
});

check('a full effect row gets its speed restored on the preceding empty tick', () => {
  const full = [1, 3, 15, 0, 13, 18, 8, 9, 128, 0, 0, 0];
  const s = fakeSession({ populate: data => {
    put(data[0][0], 0, full);
    put(data[0][0], 42, full);
    put(data[0][0], 63, [0, 0, 16, 64, HALT, 0, 0, 0, 0]);
  } });
  const plan = planNsfReconstruction(s, 0), rows = plan.frames.flat();
  assertTicks(plan);
  assert.deepEqual(rows.find(row => row.tick === 42).cells[0], Uint8Array.from(full));
  const restore = rows.find(row => row.tick === 41);
  assert.equal(restore.duration, 1);
  assert.equal(restore.cells[0][4], SPEED);
  assert.equal(restore.cells[0][8], 1);
});

check('intro and loop are repacked separately, with D00 and a relocated Bxx', () => {
  const s = fakeSession({ frames: 2, populate: data => {
    put(data[0][0], 0, [1, 3, 15, 0]);
    put(data[0][0], 10, [0, 0, 16, 64, SKIP, 0, 0, 0, 0]);
    put(data[0][1], 0, [5, 3, 15, 0]);
    put(data[0][1], 63, [0, 0, 16, 64, JUMP, 0, 0, 0, 1]);
  } });
  const plan = planNsfReconstruction(s, 0);
  assert.equal(plan.frames.length, 2);
  assert.equal(plan.beforeRows, 75);
  assert.ok(plan.frames[0].at(-1).cells[0].includes(SKIP));
  const last = plan.frames[1].at(-1).cells[0];
  assert.equal(last[8 + last.subarray(4, 8).indexOf(JUMP)], 1);
  assertTicks(plan);
});

check('speed 1, imported origin, and supported effects are required before any change', () => {
  const s = fakeSession({ populate: data => put(data[0][0], 1, [0, 0, 16, 64, SPEED, 0, 0, 0, 6]) });
  assert.throws(() => planNsfReconstruction(s, 0), /nsfReconstructUnsupported/);
  const normal = fakeSession();
  normal.info = () => ({ comment: '', pal: false });
  assert.throws(() => planNsfReconstruction(normal, 0), /nsfReconstructUnsupported/);
});

check('natural wrap without an end command retains its last tick and resets loop speed', () => {
  const s = fakeSession({ populate: data => put(data[0][0], 0, [1, 3, 15, 0]) });
  const plan = planNsfReconstruction(s, 0), rows = plan.frames.flat();
  assertTicks(plan);
  assert.equal(rows.at(-1).duration, 1);
  assert.equal(rows[0].cells[0][4], SPEED);
  const last = rows.at(-1).cells[0];
  assert.equal(last[8 + last.subarray(4, 8).indexOf(JUMP)], 0);
});

check('no reduction does not add a track', () => {
  const s = dnft.createSession(RATE);
  try {
    s.setComment('Imported from an NSF: dense', false);
    s.setSpeed(0, 1);
    const data = emptyPattern(64);
    for (let row = 0; row < 64; ++row) put(data, row, [1, 3, row % 16, 0]);
    put(data, 63, [1, 3, 15, 0, HALT, 0, 0, 0, 0]);
    s.setCells(0, 0, 0, 0, data);
    const plan = planNsfReconstruction(s, 0);
    assert.equal(plan.removedRows, 0);
    assert.equal(applyNsfReconstruction(s, plan, 'new').track, null);
    assert.equal(s.info().tracks.length, 1);
  } finally { s.delete(); }
});

const demoDir = new URL('../../demo/', import.meta.url);
for (const name of readdirSync(demoDir).filter(name => name.endsWith('.dnm')).sort()) {
  check(`${name}: the full 20 seconds and each channel retain identical PCM`, () => {
    const original = open(readFileSync(new URL(name, demoDir)));
    let s;
    try {
      s = importedFrom(original, 1200, { loop: false });
      const plan = planNsfReconstruction(s, 0);
      assertTicks(plan);
      const result = retainOriginal(s, () => applyNsfReconstruction(s, plan, 'reconstructed'));
      assert.ok(result.removedRows > 0);
      assertPcm(s, result.track, 20);
      const count = s.info().channels.length;
      for (let c = 0; c < count; ++c)
        assertPcm(s, result.track, 5, 2 ** count - 1 - 2 ** c);
      // Opening the saved result must retain both tracks and their timing.
      const reopened = open(s.save());
      try {
        assert.equal(reopened.info().tracks.length, 2);
        assertPcm(reopened, result.track, 2);
      } finally { reopened.delete(); }
      console.log(`  ${result.beforeRows} -> ${result.rows} rows (${result.removedRows} removed)`);
    } finally { s?.delete(); original.delete(); }
  });
}

for (const [name, chips] of Object.entries({ '2A03': 0, VRC6: 1, VRC7: 2, FDS: 4, MMC5: 8, N163: 16, S5B: 32 })) {
  check(`${name}: notes, silence and repeated loop passes keep identical PCM`, () => {
    const source = dnft.createSession(RATE);
    let s;
    try {
      source.setExpansion(chips, 1);
      source.setPatternLength(0, 16);
      const inst = chips ? source.addInstrument(chips === 8 ? 0 : chips, name) : 0;
      const c = chips ? 5 : 0;
      const data = emptyPattern(16);
      put(data, 0, [1, 3, 15, inst]);
      put(data, 3, [0, 0, 8, 64]);
      put(data, 6, [14, 0, 16, 64]);
      put(data, 8, [5, 3, 15, inst]);
      put(data, 14, [14, 0, 16, 64]);
      put(data, 15, [0, 0, 16, 64, JUMP, 0, 0, 0, 0]);
      source.setCells(0, c, 0, 0, data);
      s = importedFrom(source, 600);
      assert.ok(s.nsfReport().loopRow >= 0);
      const plan = planNsfReconstruction(s, 0);
      assertTicks(plan);
      const result = retainOriginal(s, () => applyNsfReconstruction(s, plan, 'reconstructed'));
      assert.ok(result.removedRows > 0);
      assertPcm(s, result.track, 6);
    } finally { s?.delete(); source.delete(); }
  });
}

for (const [name, pal, engineSpeed] of [['PAL', true, 0], ['custom 73 Hz', false, 73]]) {
  check(`${name}: row durations retain the original tick rate`, () => {
    const source = dnft.createSession(RATE);
    let s;
    try {
      source.setMachine(pal);
      source.setEngineSpeed(engineSpeed);
      source.setPatternLength(0, 16);
      const data = emptyPattern(16);
      put(data, 0, [1, 3, 15, 0]);
      put(data, 8, [5, 3, 8, 0]);
      put(data, 15, [0, 0, 16, 64, JUMP, 0, 0, 0, 0]);
      source.setCells(0, 0, 0, 0, data);
      s = importedFrom(source, 600);
      const plan = planNsfReconstruction(s, 0);
      assertTicks(plan);
      const result = applyNsfReconstruction(s, plan, 'reconstructed');
      assert.ok(result.removedRows > 0);
      assertPcm(s, result.track, 6);
    } finally { s?.delete(); source.delete(); }
  });
}

if (failures) process.exit(1);
console.log('all passed');

// Real-WASM checks for inferred NSF envelopes and atomic PCM verification.
// node web/test/nsf-reconstruct-sequences.mjs
import { strict as assert } from 'node:assert';
import createDnFT from '../dist/dnft.mjs';
import * as reconstruction from '../html/dnft-nsf-reconstruct.mjs';
import { CELL, CHIP, INST, NOTE, emptyPattern } from '../html/dnft-song.mjs';
import { highlightAt, highlightState } from '../html/dnft-pattern-edit.mjs';

const { planNsfReconstruction: plan, applyNsfReconstruction: apply } = reconstruction;
const RATE = 48000, WAVE_RATE = 44100;
const JUMP = 2, HALT = 4, PITCH = 13;
const core = await createDnFT(), verificationCore = await createDnFT();
let failures = 0;
const plain = value => JSON.parse(JSON.stringify(value, (_, v) => ArrayBuffer.isView(v) ? [...v] : v));
const put = (pattern, row, cell) => pattern.set(cell, row * CELL);

async function check(name, test) {
  try {
    await test();
    console.log(`ok - ${name}`);
  } catch (error) {
    ++failures;
    console.log(`not ok - ${name}\n  ${error instanceof WebAssembly.Exception
      ? core.getExceptionMessage(error).at(-1) : error.stack}`);
  }
}
function open(bytes, engine = core) {
  const at = engine._malloc(bytes.length);
  try {
    engine.HEAPU8.set(bytes, at);
    return engine.openSession(at, bytes.length, RATE);
  } finally { engine._free(at); }
}
function wave(session, track, seconds = 3, muted = 0) {
  session.beginWave(track, 0, seconds, muted, WAVE_RATE);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = session.renderWave(4096);
      chunks.push(part.samples);
      size += part.samples.length;
      if (part.done) break;
    }
  } finally { session.endWave(); }
  const result = new Int16Array(size);
  let at = 0;
  for (const part of chunks) { result.set(part, at); at += part.length; }
  return result;
}
function assertPcm(session, track, seconds = 3, muted = 0) {
  const original = wave(session, 0, seconds, muted), rebuilt = wave(session, track, seconds, muted);
  assert.equal(rebuilt.length, original.length, 'PCM duration');
  const mismatch = rebuilt.findIndex((value, at) => value !== original[at]);
  assert.equal(mismatch, -1, `PCM mismatch at sample ${mismatch}`);
}
function assertProgress(progress) {
  assert.ok(progress.length > 0);
  progress.forEach((value, at) => {
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, 'progress range');
    if (at) assert.ok(value >= progress[at - 1], 'progress never moves backwards');
  });
  assert.equal(progress.at(-1), 1, 'successful verification reaches completion');
}
function assertUnhighlighted(session, index) {
  const track = session.track(index);
  for (const frame of new Set([0, Math.floor(track.frames / 2), track.frames - 1]))
    for (const row of new Set([0, Math.floor(track.rows / 2), track.rows - 1])) {
      const highlight = highlightAt(track.bookmarks, track.highlight, frame, row);
      assert.deepEqual([highlight.first, highlight.second], [0, 0], 'saved variable-duration rows have no beat grid');
      assert.equal(highlightState(highlight, row), 0, `no highlight at frame ${frame}, row ${row}`);
    }
}
function originalSnapshot(s) {
  return plain({ track: s.track(0), patterns: s.patterns(0),
    instruments: s.instruments().map(({ index }) => s.instrument(index)) });
}
function assertRetained(s, before) {
  assert.deepEqual(plain(s.track(0)), before.track, 'source track is retained');
  assert.deepEqual(plain(s.patterns(0)), before.patterns, 'source patterns are retained');
  for (const instrument of before.instruments)
    assert.deepEqual(plain(s.instrument(instrument.index)), instrument, 'source instruments are retained');
}

// A fresh conventional NSF-import shape: one video frame per row, no macros.
// Each note has a changing envelope followed by a hold; two identical notes
// should reuse one newly created instrument rather than consume two slots.
function fixture({ chip = CHIP.NONE, pitch = true, loop = true, twoChannels = false, channel: requestedChannel } = {}) {
  const s = core.createSession(RATE);
  s.setExpansion(chip, 1);
  s.setComment('Imported from an NSF: envelope fixture', false);
  s.setSpeed(0, 1);
  s.setPatternLength(0, 64);
  const channel = requestedChannel ?? (chip ? 5 : 0);
  const instrument = chip && chip !== CHIP.MMC5 ? s.addInstrument(chip, 'source') : 0;
  const data = emptyPattern(64);
  const envelope = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4];
  const offsets = [128, 129, 130, 129, 128, 127, 126, 127, 128, 129, 128, 128];
  for (const start of [0, 24]) {
    for (let t = 0; t < envelope.length; ++t) {
      const cell = [t ? 0 : NOTE.C, t ? 0 : 3, envelope[t], t ? 64 : instrument,
        pitch ? PITCH : 0, 0, 0, 0, pitch ? offsets[t] : 0, 0, 0, 0];
      put(data, start + t, cell);
    }
    put(data, start + 20, [NOTE.HALT, 0, 16, 64]);
  }
  put(data, 63, [0, 0, 16, 64, loop ? JUMP : HALT, 0, 0, 0, 0, 0, 0, 0]);
  s.setCells(0, channel, 0, 0, data);
  if (twoChannels) {
    const second = emptyPattern(64);
    for (const start of [4, 28]) {
      for (let t = 0; t < 10; ++t)
        put(second, start + t, [t ? 0 : 8, t ? 0 : 3, 15 - t, t ? 64 : 0]);
      put(second, start + 18, [NOTE.HALT, 0, 16, 64]);
    }
    s.setCells(0, 1, 0, 0, second);
  }
  return { session: s, channel, instrument };
}

await check('volume and Pxx become shared macros, retaining the original and exact PCM', () => {
  const { session: s } = fixture({ twoChannels: true });
  try {
    const original = originalSnapshot(s), basic = plan(s, 0, { sequences: false });
    const result = apply(s, plan(s, 0, { sequences: true }), 'envelopes');
    assert.ok(result.instruments > 0, 'new instruments');
    assert.ok(result.sequences >= 2, 'volume and pitch sequences');
    assert.ok(result.rows < basic.rows, 'macros remove the dense event rows');
    assert.ok(result.instruments <= 2, 'identical envelopes reuse their instruments');
    assertRetained(s, original);
    assertPcm(s, result.track, 4);
    const count = s.info().channels.length, all = 2 ** count - 1;
    assertPcm(s, result.track, 4, all - 1);
    assertPcm(s, result.track, 4, all - 2);
    const reloaded = open(s.save());
    try {
      assert.equal(reloaded.info().tracks.length, 2);
      assertRetained(reloaded, original);
      assertUnhighlighted(reloaded, result.track);
      assertPcm(reloaded, result.track, 4);
    } finally { reloaded.delete(); }
  } finally { s.delete(); }
});

for (const [name, chip, pitch] of [
  ['MMC5', CHIP.MMC5, true], ['VRC6', CHIP.VRC6, true],
  ['N163', CHIP.N163, false], ['S5B', CHIP.S5B, true],
]) {
  await check(`${name}: supported channel envelopes preserve several loop passes`, () => {
    const { session: s, channel } = fixture({ chip, pitch });
    try {
      const basic = plan(s, 0, { sequences: false });
      const result = apply(s, plan(s, 0, { sequences: true }), 'envelopes');
      assert.ok(result.instruments > 0);
      assert.ok(result.rows < basic.rows);
      assertPcm(s, result.track, 4);
      assertPcm(s, result.track, 4, 2 ** s.info().channels.length - 1 - 2 ** channel);
    } finally { s.delete(); }
  });
}

for (const [name, channel, pitch] of [['triangle pitch', 2, true], ['noise volume', 3, false]]) {
  await check(`2A03 ${name}: inferred envelopes retain exact channel PCM`, () => {
    const { session: s } = fixture({ channel, pitch });
    try {
      const result = apply(s, plan(s, 0, { sequences: true }), 'envelopes');
      assert.ok(result.instruments > 0);
      assertPcm(s, result.track, 4);
      assertPcm(s, result.track, 4, 31 - 2 ** channel);
    } finally { s.delete(); }
  });
}

for (const [name, chip, channel] of [
  ['DPCM', CHIP.NONE, 4], ['FDS', CHIP.FDS, 5], ['VRC7', CHIP.VRC7, 5],
]) {
  await check(`${name}: excluded instruments retain their event rows`, () => {
    const { session: s } = fixture({ chip, channel, pitch: false });
    try {
      const basic = plan(s, 0, { sequences: false });
      const result = apply(s, plan(s, 0, { sequences: true }), 'basic');
      assert.equal(result.instruments, 0);
      assert.equal(result.rows, basic.rows);
      assertPcm(s, result.track, 3);
    } finally { s.delete(); }
  });
}

await check('held instruments and instrument changes during a note are not inferred', () => {
  for (const held of [false, true]) {
    const { session: s } = fixture({ pitch: false });
    try {
      const data = s.pattern(0, 0, 0), other = s.addInstrument(0, 'other');
      for (const start of [0, 24]) {
        if (held) data[start * CELL + 3] = 255;
        else data[(start + 6) * CELL + 3] = other;
      }
      s.setCells(0, 0, 0, 0, data);
      const basic = plan(s, 0, { sequences: false });
      const inferred = plan(s, 0, { sequences: true });
      assert.equal(inferred.instruments.length, 0);
      assert.equal(inferred.rows, basic.rows);
    } finally { s.delete(); }
  }
});

await check('notes longer than the macro capacity keep their dense data', () => {
  const s = core.createSession(RATE);
  try {
    s.setComment('Imported from an NSF: long envelope', false);
    s.setSpeed(0, 1);
    s.setPatternLength(0, 256);
    const data = emptyPattern(256);
    for (let row = 0; row < 255; ++row)
      put(data, row, [row ? 0 : NOTE.C, row ? 0 : 3, 1 + row % 15, row ? 64 : 0]);
    put(data, 255, [NOTE.HALT, 0, 16, 64, HALT, 0, 0, 0, 0]);
    s.setCells(0, 0, 0, 0, data);
    const basic = plan(s, 0, { sequences: false }), inferred = plan(s, 0, { sequences: true });
    assert.equal(inferred.instruments.length, 0);
    assert.equal(inferred.rows, basic.rows);
  } finally { s.delete(); }
});

await check('a note continuing over the loop boundary keeps its original instrument and events', () => {
  const { session: s, instrument } = fixture();
  try {
    const data = s.pattern(0, 0, 0);
    data.set(emptyPattern(1), 44 * CELL); // The second note now crosses B00.
    s.setCells(0, 0, 0, 0, data);
    const inferred = plan(s, 0, { sequences: true });
    assert.equal(inferred.instruments.length, 1, 'only the first, bounded note can be inferred');
    const rows = inferred.frames.flat();
    assert.equal(rows.find(row => row.tick === 24).cells[0][3], instrument);
    assert.equal(rows.find(row => row.tick === 25).cells[0][2], 14);
    const result = apply(s, inferred, 'partial');
    assertPcm(s, result.track, 4);
  } finally { s.delete(); }
});

await check('existing enabled macros are left as basic timing-only reconstruction', () => {
  const { session: s, instrument } = fixture({ pitch: false });
  try {
    s.setSequence(INST['2A03'], 0, 0, Int8Array.of(15, 8, 4), 2, -1, 0);
    s.setInstrumentSequence(instrument, 0, true, 0);
    const basic = plan(s, 0, { sequences: false }), result = apply(s, plan(s, 0, { sequences: true }), 'basic');
    assert.equal(result.instruments, 0);
    assert.equal(result.rows, basic.rows);
    assertPcm(s, result.track, 3);
  } finally { s.delete(); }
});

await check('a full instrument table skips macro creation without modifying resources', () => {
  const { session: s } = fixture();
  try {
    for (let i = 1; i < 64; ++i) assert.ok(s.addInstrument(0, `occupied ${i}`) >= 0);
    const before = originalSnapshot(s), basic = plan(s, 0, { sequences: false });
    const result = apply(s, plan(s, 0, { sequences: true }), 'basic');
    assert.equal(result.instruments, 0);
    assert.equal(result.rows, basic.rows);
    assert.equal(s.instruments().length, 64);
    assertRetained(s, before);
    assertPcm(s, result.track, 3);
  } finally { s.delete(); }
});

await check('a full sequence pool preserves every occupied sequence and uses basic packing', () => {
  const { session: s } = fixture({ pitch: false });
  try {
    for (let i = 0; i < 128; ++i)
      s.setSequence(INST['2A03'], 0, i, Int8Array.of(1 + i % 15), -1, -1, 0);
    const before = Array.from({ length: 128 }, (_, i) => plain(s.sequence(INST['2A03'], 0, i)));
    const basic = plan(s, 0, { sequences: false }), result = apply(s, plan(s, 0, { sequences: true }), 'basic');
    assert.equal(result.instruments, 0);
    assert.equal(result.rows, basic.rows);
    for (let i = 0; i < 128; ++i) assert.deepEqual(plain(s.sequence(INST['2A03'], 0, i)), before[i]);
    assertPcm(s, result.track, 3);
  } finally { s.delete(); }
});

await check('P00 and linear pitch retain Pxx while still inferring safe volume sequences', () => {
  for (const linear of [false, true]) {
    const { session: s } = fixture();
    try {
      if (linear) s.setLinearPitch(true);
      else {
        const cells = s.pattern(0, 0, 0);
        for (const start of [0, 24]) cells[(start + 5) * CELL + 8] = 0;
        s.setCells(0, 0, 0, 0, cells);
      }
      const inferred = plan(s, 0, { sequences: true });
      assert.ok(inferred.instruments.length > 0);
      assert.ok(inferred.instruments.every(inst => inst.sequences.every(seq => seq.kind === 0)), 'only volume inferred');
      const row = inferred.frames.flat().find(row => row.tick === 5).cells[0];
      assert.equal(row[4], PITCH);
      assert.equal(row[8], linear ? 127 : 0, 'source pitch effect is preserved');
      const result = apply(s, inferred, 'safe volume');
      assertPcm(s, result.track, 3);
    } finally { s.delete(); }
  }
});

await check('phase resets and hardware sweeps exclude pitch inference and preserve exact PCM', () => {
  for (const effect of [42, 8, 9]) {
    const { session: s } = fixture();
    try {
      const cells = s.pattern(0, 0, 0);
      for (const start of [0, 24]) {
        cells[(start + 3) * CELL + 5] = effect;
        cells[(start + 3) * CELL + 9] = effect === 42 ? 0 : 0x11;
      }
      s.setEffColumns(0, 0, 2);
      s.setCells(0, 0, 0, 0, cells);
      const inferred = plan(s, 0, { sequences: true });
      assert.ok(inferred.instruments.length > 0);
      assert.ok(inferred.instruments.every(inst => inst.sequences.every(seq => seq.kind === 0)), 'safe volume remains available');
      const result = apply(s, inferred, 'safe volume');
      assertPcm(s, result.track, 3);
    } finally { s.delete(); }
  }
});

await check('an apply failure rolls back added tracks, instruments and prior empty sequence metadata', () => {
  const { session: s } = fixture();
  try {
    s.setSequence(INST['2A03'], 2, 0, new Int8Array(), -1, -1, 1);
    const before = originalSnapshot(s), prior = plain(s.sequence(INST['2A03'], 2, 0));
    assert.equal(prior.setting, 1, 'empty sequence starts with nondefault metadata');
    const inferred = plan(s, 0, { sequences: true });
    let written = false;
    const failing = new Proxy(s, {
      get(target, name) {
        if (name === 'setTrackTitle') return () => {
          written = target.sequence(INST['2A03'], 2, 0).items.length > 0;
          throw new Error('injected track write failure');
        };
        const value = target[name];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    assert.throws(() => apply(failing, inferred, 'must roll back'), /injected track write failure/);
    assert.equal(written, true, 'failure occurs after the new sequences were written');
    assert.equal(s.info().tracks.length, 1);
    assert.equal(s.instruments().length, before.instruments.length);
    assert.deepEqual(plain(s.sequence(INST['2A03'], 2, 0)), prior, 'items and setting are restored');
    assertRetained(s, before);
  } finally { s.delete(); }
});

await check('atomic reconstruction verifies saved output and leaves its input bytes intact', async () => {
  const { session: s } = fixture();
  try {
    const bytes = s.save(), before = bytes.slice(), progress = [];
    const result = await reconstruction.reconstructNsf(core, verificationCore, bytes, 0, 'verified', RATE,
      { onProgress: value => progress.push(value), yieldControl: async () => {} });
    assert.deepEqual(bytes, before);
    assert.ok(result.data?.length > 0);
    assert.equal(result.reconstruction.verified, true);
    assert.equal(result.reconstruction.fallback, false);
    assert.ok(result.reconstruction.instruments > 0);
    assertProgress(progress);
    const reloaded = open(result.data);
    try {
      assertUnhighlighted(reloaded, result.reconstruction.track);
      assertPcm(reloaded, result.reconstruction.track, 4);
    } finally { reloaded.delete(); }
  } finally { s.delete(); }
});

await check('a mismatching macro candidate is discarded and basic reconstruction is verified', async () => {
  const { session: s } = fixture();
  let injections = 0, opened = 0;
  const candidateCore = Object.assign(Object.create(verificationCore), {
    openSession(...args) {
      const session = verificationCore.openSession(...args);
      const attempt = ++opened;
      let injected = false;
      return new Proxy(session, {
        get(target, name) {
          if (name === 'renderWave') return (...renderArgs) => {
            const part = target.renderWave(...renderArgs);
            if (attempt <= 2 && !injected && part.samples.length) {
              injected = true;
              ++injections;
              const samples = part.samples.slice();
              samples[0] ^= 1;
              return { ...part, samples };
            }
            return part;
          };
          const value = target[name];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });
  try {
    const progress = [];
    const result = await reconstruction.reconstructNsf(core, candidateCore, s.save(), 0, 'fallback', RATE,
      { onProgress: value => progress.push(value), yieldControl: async () => {} });
    assert.equal(injections, 2, 'both inferred candidates must be rendered and rejected');
    assert.ok(result.data?.length > 0);
    assert.equal(result.reconstruction.fallback, true);
    assert.equal(result.reconstruction.verified, true);
    assert.equal(result.reconstruction.instruments, 0);
    assertProgress(progress);
    const reloaded = open(result.data);
    try {
      assertUnhighlighted(reloaded, result.reconstruction.track);
      assertPcm(reloaded, result.reconstruction.track, 4);
    } finally { reloaded.delete(); }
  } finally { s.delete(); }
});

await check('cancellation before or during verification publishes nothing and frees both engines', async () => {
  const { session: s } = fixture();
  try {
    const bytes = s.save(), before = bytes.slice();
    for (const cancelAfter of [0, 8]) {
      let checks = 0;
      await assert.rejects(() => reconstruction.reconstructNsf(core, verificationCore, bytes, 0, 'cancelled', RATE,
        { isCancelled: () => ++checks > cancelAfter, yieldControl: async () => {} }), /cancelled/);
    }
    assert.deepEqual(bytes, before);
    assert.equal(s.info().tracks.length, 1);
    const retry = await reconstruction.reconstructNsf(core, verificationCore, bytes, 0, 'retry', RATE);
    assert.equal(retry.reconstruction.verified, true, 'both engines remain usable after cancellation');
  } finally { s.delete(); }
});

await check('64 tracks cannot be extended and the original document remains unchanged', async () => {
  const { session: s } = fixture();
  try {
    for (let i = 1; i < 64; ++i) s.addTrack();
    const before = originalSnapshot(s), bytes = s.save();
    await assert.rejects(() => reconstruction.reconstructNsf(core, verificationCore, bytes, 0, 'too many', RATE,
      { yieldControl: async () => {} }));
    assert.equal(s.info().tracks.length, 64);
    assertRetained(s, before);
  } finally { s.delete(); }
});

await check('a dense already irreducible track returns no replacement data', async () => {
  const s = core.createSession(RATE);
  try {
    s.setComment('Imported from an NSF: irreducible notes', false);
    s.setSpeed(0, 1);
    const cells = emptyPattern(64);
    for (let row = 0; row < 64; ++row) put(cells, row, [1 + row % 12, 3, 15, 0]);
    cells[63 * CELL + 4] = HALT;
    s.setCells(0, 0, 0, 0, cells);
    const result = await reconstruction.reconstructNsf(core, verificationCore, s.save(), 0, 'unchanged', RATE,
      { yieldControl: async () => {} });
    assert.equal(result.data, null);
    assert.equal(result.reconstruction.track, null);
    assert.equal(s.info().tracks.length, 1);
  } finally { s.delete(); }
});

if (failures) process.exit(1);
console.log('all passed');

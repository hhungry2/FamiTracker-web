// node web/test/nsf-driver.mjs
// Direct decoding must preserve tracker rows and resources, not expand playback
// frames. Compare the result after save/reopen with its original module.
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import createDnFT from '../dist/dnft.mjs';
import createNsf from '../dist/dnft-nsf.mjs';
import profiles from '../dist/dnft-nsf-drivers.mjs';
import { identifyNsfDriver, nsfDriverInfo, importNsfDriver, NsfDriverError } from '../html/dnft-nsf-driver-import.mjs';
import { inImportHeap } from '../html/dnft-nsf-import.mjs';
import { emptyPattern, CELL } from '../html/dnft-song.mjs';
import { likeness } from './nsf-audio.mjs';

const RATE = 48000, core = await createDnFT(), staging = await createDnFT(), nsf = await createNsf();
const options = { allSongs: true, region: -1 };
const noWait = async () => {};
const info = bytes => inImportHeap(nsf, bytes, (at, size) => nsf.nsfInfo(at, size));
const open = bytes => inImportHeap(core, bytes, (at, size) => core.openSession(at, size, RATE));
const direct = (bytes, opts = options, hooks = {}) => importNsfDriver(staging, bytes, info(bytes), profiles, opts, RATE, { yieldControl: noWait, ...hooks });
function wave(s, t = 0, seconds = 4, muted = 0) {
  s.beginWave(t, 0, seconds, muted, 44100);
  const parts = []; let count = 0;
  try { for (;;) { const out = s.renderWave(44100); parts.push(out.samples); count += out.samples.length; assert.ok(count < (seconds + 2) * 44100, 'wave export must finish at the requested time'); if (out.done) break; } }
  finally { s.endWave(); }
  const result = new Int16Array(count); let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}
function assertPcm(a, b, label = 'PCM') {
  assert.equal(a.length, b.length, `${label}: sample count`);
  const at = a.findIndex((v, i) => v !== b[i]);
  assert.equal(at, -1, `${label}: first differing sample ${at}`);
}
function fixture(chips, { pal = false, hz = 0, groove = false, linear = false, old = false, banked = false } = {}) {
  const s = core.createSession(RATE);
  s.setExpansion(chips, 4); s.setMachine(pal); s.setEngineSpeed(hz); s.setLinearPitch(linear); s.setVibratoStyle(!old);
  s.setTitle('Direct decoder'); s.setArtist('test'); s.setCopyright('2026');
  const channels = s.info().channels;
  const instruments = new Map([[0, 0]]);
  for (const chip of [1, 2, 4, 16, 32]) if (chips & chip) instruments.set(chip, s.addInstrument(chip, 'Sound'));
  for (const [chip, index] of instruments) {
    if ([0, 1, 16, 32].includes(chip)) {
      const type = s.instrument(index).type;
      s.setSequence(type, 0, 3, Int8Array.of(15, 12, 10, 8, 6), 2, 3, 0);
      s.setInstrumentSequence(index, 0, true, 3);
      s.setSequence(type, 1, 7, Int8Array.of(0, 4, 7), 0, -1, 0);
      s.setInstrumentSequence(index, 1, true, 7);
      s.setSequence(type, 2, 5, Int8Array.of(0, 1, -1), 0, -1, 0);
      s.setInstrumentSequence(index, 2, true, 5);
    }
    if (chip === 2) s.setVrc7(index, 0, Uint8Array.of(3, 0x21, 0x1A, 7, 0xF3, 0xF2, 0xA4, 0x45));
    if (chip === 4) {
      s.setFdsWave(index, Uint8Array.from({ length: 64 }, (_, i) => i));
      s.setFdsModulation(index, Uint8Array.from({ length: 32 }, (_, i) => i % 8));
      s.setFdsParams(index, 400, 8, 3);
      s.setFdsSequence(index, 0, Int8Array.of(31, 24, 16, 8), 1, 2, 0);
    }
    if (chip === 16) s.setN163(index, 32, 0, 2, Uint8Array.from({ length: 64 }, (_, i) => (i >> 1) & 15));
  }
  const sample = s.setSample(-1, 'Sample', Uint8Array.from({ length: 17 }, (_, i) => i & 1 ? 0 : 255));
  s.setDpcmKey(0, 48, sample + 1, 15, false, 32);
  s.setDpcmKey(0, 49, sample + 1, 14, true, 64);
  if (banked) for (let i = 0; i < 5; ++i) {
    const sample = s.setSample(-1, `Long ${i}`, Uint8Array.from({ length: 4081 }, (_, j) => (j + i) & 255));
    s.setDpcmKey(0, 50 + i, sample + 1, 15 - i, false, -1);
  }
  if (groove) s.setGrooves([[6, 5, 6, 7], [3, 4]]);
  for (let t = 0; t < 2; ++t) {
    if (t) s.addTrack();
    s.setTrackTitle(t, ['First', 'Second'][t]); s.setPatternLength(t, 32); s.setFrameCount(t, 3);
    if (groove) { s.setGrooveMode(t, true); s.setSpeed(t, 0); }
    for (const [c, channel] of channels.entries()) {
      const data = emptyPattern(32), instrument = instruments.get(channel.chip) ?? 0;
      for (let row = 0; row < 32; row += 4) {
        const key = channel.id === 4 ? row / 4 % (banked ? 7 : 2) : (row / 4 + t) % 12;
        data.set([key + 1, 4, 12, instrument], row * CELL);
      }
      if (channel.id !== 4) { data[12 * CELL] = 13; data[12 * CELL + 3] = 64; data[28 * CELL] = 14; data[28 * CELL + 3] = 64; }
      if (c === 0) {
        s.setEffColumns(t, c, 2);
        data[8 * CELL + 4] = groove ? 37 : 1; data[8 * CELL + 8] = groove ? 1 : 5;
        data[16 * CELL + 4] = 1; data[16 * CELL + 8] = 160;
        data[20 * CELL + 4] = 11; data[20 * CELL + 8] = 0x34;
        data[24 * CELL + 4] = 11; data[24 * CELL + 8] = 0;
        data[31 * CELL + 4] = 2; data[31 * CELL + 8] = 0;
      }
      s.setCells(t, c, 9, 0, data);
      for (let f = 0; f < 3; ++f) s.setFramePattern(t, f, c, 9);
    }
  }
  const saved = s.save();
  const bytes = s.exportNSF('nsfe', pal ? 1 : 0, false).files[0].data;
  s.delete();
  const original = open(saved), before = [wave(original, 0), wave(original, 1)];
  original.delete();
  return { bytes, saved, before, channels };
}
let failures = 0;
async function check(name, fn) {
  if (process.env.NSF_DRIVER_ONLY && !name.includes(process.env.NSF_DRIVER_ONLY)) return;
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { ++failures; console.error(`not ok - ${name}\n${e instanceof WebAssembly.Exception ? staging.getExceptionMessage(e).at(-1) + '\n' + e.stack : e.stack}`); }
}

for (const chips of [0, 1, 2, 4, 8, 16, 32, 9, 63]) await check(`chips ${chips}: rows, orders, macros, waves, DPCM and per-track PCM`, async () => {
  const f = fixture(chips);
  assert.deepEqual(nsfDriverInfo(f.bytes, profiles), { supported: true, name: 'Dn-FT 2.16' });
  const result = await direct(f.bytes), s = open(result.data);
  assert.deepEqual(s.info().tracks, ['First', 'Second']);
  assert.equal(s.track(0).rows, 32); assert.equal(s.track(0).frames, 3); assert.equal(s.track(0).speed, 6);
  const melodic = s.pattern(0, 0, s.track(0).frameList[0]);
  assert.equal(melodic[4 * CELL], 2); assert.equal(melodic[12 * CELL], 13); assert.equal(melodic[31 * CELL + 4], 2);
  assert.equal(s.samples().samples.length, 1); assert.equal(s.info().comment.startsWith('Decoded from an NSF'), true);
  for (let t = 0; t < 2; ++t) assertPcm(wave(s, t), f.before[t], `track ${t + 1} PCM`);
  s.delete();
  if (chips === 0 && process.env.NSF_DRIVER_FIXTURE) writeFileSync(process.env.NSF_DRIVER_FIXTURE, f.bytes);
});
for (const [name, opts] of [['PAL', { pal: true }], ['73 Hz', { hz: 73 }], ['grooves', { groove: true }], ['linear pitch', { linear: true }], ['old vibrato', { old: true }], ['sample banks', { banked: true }]])
  await check(name, async () => {
    const f = fixture(0, opts);
    const result = await direct(f.bytes), s = open(result.data);
    assert.equal(identifyNsfDriver(f.bytes, profiles).memory.banked, !!opts.banked);
    assertPcm(wave(s), f.before[0]); s.delete();
  });

await check('NSF2, external OPLL and detuned frequency tables survive decoding', async () => {
  const f = fixture(63), source = open(f.saved);
  const offsets = new Int16Array(6 * 96);
  for (let table = 0; table < 6; ++table) offsets[table * 96 + (table === 3 ? 0 : 48)] = 2;
  source.setDetune(offsets, 0, 13);
  const opll = source.opll();
  opll.patches.set([1, 0x21, 0, 0, 0xF0, 0xF0, 0x0F, 0x0F], 8);
  source.setOpll(true, opll.patches, opll.names);
  const instrument = source.instruments().find(i => i.type === 3).index;
  source.setVrc7(instrument, 1, new Uint8Array(8));
  const bytes = source.exportNSF('nsf2', 0, false).files[0].data, saved = source.save(); source.delete();
  const original = open(saved), before = wave(original); original.delete();
  const result = await direct(bytes), decoded = open(result.data);
  try {
    assert.equal(decoded.opll().external, true);
    assert.deepEqual(decoded.opll().patches, opll.patches);
    assertPcm(wave(decoded), before);
  } finally { decoded.delete(); }
});

for (const name of readdirSync(new URL('../../demo/', import.meta.url)).filter(n => /\.(dnm|0cc|ftm)$/i.test(n)).sort())
  await check(`demo ${name}: decode consistent data or reject ambiguous streams`, async () => {
    const source = open(readFileSync(new URL(`../../demo/${name}`, import.meta.url)));
    const track = source.track(0), bytes = source.exportNSF('nsfe', 0, false).files[0].data;
    const before = wave(source, 0, 12); source.delete();
    // Some streams in these exports do not cover the declared row count.
    // Never read the following pattern as additional notes.
    if (!name.includes("Wavetable That Doesn't Wanna Be")) {
      await assert.rejects(direct(bytes, { allSongs: false, song: 0, region: -1 }), e => e instanceof NsfDriverError);
      return;
    }
    const result = await direct(bytes, { allSongs: false, song: 0, region: -1 }), decoded = open(result.data);
    try {
      assert.equal(decoded.track(0).rows, track.rows); assert.equal(decoded.track(0).frames, track.frames);
      assertPcm(wave(decoded, 0, 12), before);
    } finally { decoded.delete(); }
  });

await check('single-song selection retains the selected title and resources', async () => {
  const f = fixture(63), result = await direct(f.bytes, { allSongs: false, song: 1, region: -1 });
  const s = open(result.data);
  try { assert.deepEqual(s.info().tracks, ['Second']); assertPcm(wave(s), f.before[1]); }
  finally { s.delete(); }
});

await check('64-track limit, including an NSF header advertising a 65th song', async () => {
  const s = core.createSession(RATE);
  for (let t = 0; t < 64; ++t) {
    if (t) s.addTrack();
    s.setPatternLength(t, 1); s.setTrackTitle(t, `Song ${t + 1}`);
    s.setCells(t, 0, 0, 0, Uint8Array.of(t % 12 + 1, 4, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0));
  }
  const bytes = s.exportNSF('nsf', 0, false).files[0].data; s.delete();
  bytes[6] = 65;
  const result = await direct(bytes);
  assert.equal(result.songs.length, 64); assert.equal(result.totalSongs, 65); assert.equal(result.limit, 'trackLimit');
  assert.ok(!('files' in result) && !('parts' in result));
  const restored = open(result.data);
  try { assert.equal(restored.info().tracks.length, 64); assert.equal(restored.track(63).rows, 1); }
  finally { restored.delete(); }
});

await check('unknown drivers, modified code and malformed pointers are rejected safely', async () => {
  const f = fixture(0), s = open(f.saved), bytes = s.exportNSF('nsf', 0, false).files[0].data; s.delete();
  const driver = identifyNsfDriver(bytes, profiles), m = driver.memory;
  const changed = bytes.slice(); changed[128 + m.offset(m.init + 8)] ^= 1;
  assert.equal(nsfDriverInfo(changed, profiles).supported, false);
  await assert.rejects(direct(changed), e => e instanceof NsfDriverError);
  const old = bytes.slice(); old[128 + 7] = 15;
  assert.equal(nsfDriverInfo(old, profiles).supported, false);
  const broken = bytes.slice();
  broken[128 + m.offset(m.base)] = 0xFF; broken[128 + m.offset(m.base) + 1] = 0xFF;
  await assert.rejects(direct(broken), e => e instanceof NsfDriverError);
  await assert.rejects(direct(bytes.subarray(0, 150)), e => e instanceof NsfDriverError || /header|data/.test(e.message));
});

await check('cancellation and failed decoding preserve the current editable/playable module', async () => {
  const f = fixture(1), current = open(f.saved), saved = current.save();
  try {
    for (const at of [0, 0.5, 1]) {
      let cancel = false;
      await assert.rejects(direct(f.bytes, options, { onProgress: p => { if (p >= at) cancel = true; }, isCancelled: () => cancel }), /^Error: cancelled$/);
      const after = current.save(); assert.ok(saved.length === after.length && saved.every((v, i) => after[i] === v));
      assertPcm(wave(current), f.before[0]);
    }
  } finally { current.delete(); }
});

await check('each 2A03 channel: direct NSF playback, playback import and driver decoding agree', async () => {
  const f = fixture(0), result = await direct(f.bytes), decoded = open(result.data);
  const seconds = 3, solo = c => 31 - 2 ** c;
  const decodedPcm = f.channels.map((_, c) => wave(decoded, 0, seconds, solo(c))); decoded.delete();
  const analysis = new nsf.NsfAnalysis();
  let log;
  try {
    assert.equal(inImportHeap(nsf, f.bytes, (at, size) => analysis.load(at, size)), '');
    assert.ok(analysis.start(0, 0, 240));
    while (!analysis.done()) analysis.run(600);
    log = analysis.log();
  } finally { analysis.delete(); }
  const played = inImportHeap(core, log, (at, size) => core.importNsf(at, size, RATE, { patternLength: 64, loop: false, trimSilence: false }));
  try {
    const firstSound = pcm => pcm.findIndex(v => Math.abs(v) > 200);
    const rawPulse = inImportHeap(nsf, f.bytes, (at, size) => nsf.nsfRender(at, size, 0, seconds, 44100, solo(0)));
    const directLag = firstSound(decodedPcm[0]) - firstSound(rawPulse);
    const playedLag = firstSound(wave(played, 0, seconds, solo(0))) - firstSound(rawPulse);
    assert.ok(directLag >= 0 && directLag < 44100 / 5 && playedLag >= 0 && playedLag < 44100 / 5);
    for (let c = 0; c < f.channels.length; ++c) {
      const raw = inImportHeap(nsf, f.bytes, (at, size) => nsf.nsfRender(at, size, 0, seconds, 44100, solo(c)));
      const directScore = likeness(raw, decodedPcm[c].subarray(directLag)), playedScore = likeness(raw, wave(played, 0, seconds, solo(c)).subarray(playedLag));
      const least = c === 3 ? 0.75 : c === 4 ? 0.85 : 0.95;
      console.log(`  ${f.channels[c].name}: NSF/decoded ${directScore.toFixed(3)}, NSF/played ${playedScore.toFixed(3)}`);
      assert.ok(directScore >= least, `${f.channels[c].name}: direct NSF / decoded ${directScore.toFixed(3)}`);
      assert.ok(playedScore >= least, `${f.channels[c].name}: direct NSF / playback import ${playedScore.toFixed(3)}`);
    }
  } finally { played.delete(); }
});

await check('editor worker routes direct decoding, fallback and cancellation without replacing the current module', async () => {
  const f = fixture(0);
  let id = 0, outcome, cancelAt = null;
  globalThis.self = {
    postMessage(message) {
      if (message.type === 'progress' && cancelAt !== null && message.value >= cancelAt)
        void self.onmessage({ data: { type: 'cancel', id: message.id } });
      if (message.type === 'result' || message.type === 'error') outcome = message;
    },
  };
  const invoke = async (method, ...args) => {
    outcome = null;
    await self.onmessage({ data: { type: 'call', id: ++id, method, args } });
    assert.ok(outcome, `${method} must return a result`);
    if (outcome.type === 'error') throw new Error(outcome.reason);
    return outcome.value;
  };
  try {
    await import('../dist/dnft-session-engine.mjs');
    const header = await invoke('nsfInfo', f.bytes);
    assert.equal(header.driver.supported, true);
    const opts = { ...options, method: 'driver', seconds: 1, patternLength: 64, loop: false, trimSilence: false };
    const decoded = await invoke('importNsf', f.bytes, opts, RATE);
    assert.equal(decoded.nsfReader.method, 'driver');
    assert.deepEqual(decoded.info.tracks, ['First', 'Second']);
    assert.equal(decoded.tracks[0].track.rows, 32);
    const saved = await invoke('save');
    cancelAt = 0.5;
    await assert.rejects(invoke('importNsf', f.bytes, opts, RATE), /^Error: cancelled$/);
    cancelAt = null;
    assert.deepEqual(await invoke('save'), saved);
    const broken = f.bytes.slice();
    const m = identifyNsfDriver(f.bytes, profiles).memory;
    broken[m.data.byteOffset + 6] ^= 1; // Identity only; playback code remains intact.
    const fallback = await invoke('importNsf', broken, opts, RATE);
    assert.equal(fallback.nsfReader.method, 'playback'); assert.equal(fallback.nsfReader.fallback, true);
    assert.equal(fallback.batch.songs.length, 2); assert.equal(fallback.tracks[0].track.speed, 1);
    const single = await invoke('importNsf', broken, { ...opts, allSongs: false, song: 1 }, RATE);
    assert.equal(single.nsfReader.fallback, true); assert.ok(single.report);
    const playback = await invoke('importNsf', f.bytes, { ...opts, method: 'playback', allSongs: false, song: 0 }, RATE);
    assert.equal(playback.nsfReader.fallback, false); assert.equal(playback.nsfReader.method, 'playback');
  } finally { delete globalThis.self; }
});

process.exitCode = failures ? 1 : 0;

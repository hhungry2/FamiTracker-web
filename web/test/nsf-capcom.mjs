// node web/test/build-capcom-reference.mjs && node web/test/nsf-capcom.mjs
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import createDnFT from '../dist/dnft.mjs';
import createNsf from '../dist/dnft-nsf.mjs';
import profiles from '../dist/dnft-nsf-drivers.mjs';
import { identifyCapcomDriver, capcomSongId, decodeCapcomSong } from '../html/dnft-nsf-capcom.mjs';
import { importNsfDriver, nsfDriverInfo, NsfDriverError } from '../html/dnft-nsf-driver-import.mjs';
import { inImportHeap } from '../html/dnft-nsf-import.mjs';
import { likeness } from './nsf-audio.mjs';

const core = await createDnFT(), other = await createDnFT(), nsf = await createNsf(), RATE = 48000;
const info = b => inImportHeap(nsf, b, (a, n) => nsf.nsfInfo(a, n));
const open = b => inImportHeap(core, b, (a, n) => core.openSession(a, n, RATE));
const direct = (b, options = {}, hooks = {}) => importNsfDriver(core, b, info(b), profiles,
  { allSongs: true, seconds: 1, loop: false, trimSilence: false, ...options }, RATE,
  { nsf, createVerificationCore: async () => other, yieldControl: async () => {}, ...hooks });
const fixture = game => new Uint8Array(readFileSync(new URL(`../build/capcom-reference/${game}.nsf`, import.meta.url)));
const alter = (b, address, data) => { b.set(data, 128 + address - 0x8000); return b; };
function wave(s, track, seconds, muted = 0) {
  s.beginWave(track, 0, seconds, muted, 44100);
  const parts = []; let length = 0;
  try { for (;;) { const r = s.renderWave(44100); parts.push(r.samples); length += r.samples.length; if (r.done) break; } }
  finally { s.endWave(); }
  const pcm = new Int16Array(length); let at = 0;
  for (const part of parts) { pcm.set(part, at); at += part.length; }
  return pcm;
}
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { ++failures; console.error(`not ok - ${name}\n${e instanceof WebAssembly.Exception ? core.getExceptionMessage(e).at(-1) : e.stack}`); }
}
function nsfe(b) {
  const chunk = (name, data) => { const out = Buffer.alloc(8 + data.length); out.writeUInt32LE(data.length); out.write(name, 4); out.set(data, 8); return out; };
  const header = Buffer.alloc(10); header.set(b.subarray(8, 14)); header[6] = b[0x7A]; header[7] = b[0x7B]; header[8] = b[6]; header[9] = b[7] - 1;
  return new Uint8Array(Buffer.concat([Buffer.from('NSFE'), chunk('INFO', header), chunk('DATA', b.subarray(128)), chunk('NEND', Buffer.alloc(0))]));
}

for (const game of ['mm1', 'mm2']) {
  const bytes = fixture(game);
  await check(`${game}: complete stock code, independent init/play, NSF/NSFe/NSF2 and initial banks`, async () => {
    const version2 = bytes.slice(); version2[5] = 2;
    const banked = bytes.slice(); banked.set([0, 1, 2, 3, 0, 1, 2, 3], 0x70);
    for (const b of [bytes, nsfe(bytes), version2, banked]) {
      const d = identifyCapcomDriver(b);
      assert.equal(d.name, `Capcom / Mega Man ${game.at(-1)}`);
      assert.equal(nsfDriverInfo(b, profiles).supported, true);
      assert.equal(capcomSongId(d, 0, 0), 1); assert.equal(capcomSongId(d, 1, 1), 0);
    }
    const unknown = bytes.slice(); unknown[128 + 30] ^= 1;
    assert.equal(nsfDriverInfo(unknown, profiles).supported, false);
    assert.throws(() => identifyCapcomDriver(unknown), NsfDriverError);
    const extra = bytes.slice(); extra[0x7B] = 1;
    assert.throws(() => identifyCapcomDriver(extra), NsfDriverError);
  });
  await check(`${game}: explicit duration, dotted notes, triplets, ties, finite repeats and asynchronous channel loops`, async () => {
    const d = identifyCapcomDriver(bytes), stopped = await decodeCapcomSong(d, 1), loop = await decodeCapcomSong(d, 0);
    assert.equal(stopped.rows, 55); assert.equal(stopped.loopRow, -1);
    assert.deepEqual(stopped.events.map(e => [e.tick, e.note, e.quarterTicks]), [[0, 36, 48], [12, 40, 72], [30, 43, 48], [42, null, 48]]);
    assert.equal(loop.loopRow, 1); assert.equal(loop.rows, 1297);
    assert.ok(loop.events.some(e => e.triplet)); assert.ok(loop.events.some(e => e.tied));
    assert.ok(loop.events.some(e => e.quarterTicks === 72));
    assert.deepEqual(new Set(loop.events.map(e => e.channel)), new Set([0, 1, 2, 3]));
    await assert.rejects(decodeCapcomSong(d, 2), /sound-effect/);
  });
  await check(`${game}: all songs, per-song SFX fallback, automatic verified reconstruction, save/reopen and macro merging`, async () => {
    const result = await direct(bytes), s = open(result.data);
    try {
      assert.equal(s.info().tracks.length, 3); assert.equal(result.fallback, true);
      assert.deepEqual(result.songs.map(s => s.report.reader), ['driver', 'driver', 'playback']);
      assert.equal(result.songs[0].report.reconstructionVerified, true);
      assert.equal(result.songs[0].report.reconstructedRows, 8);
      assert.ok(result.songs[1].report.reconstructedRows < result.songs[1].report.rows);
      assert.match(s.info().comment, /sound-effect stream/);
      const reopened = inImportHeap(other, s.save(), (a, n) => other.openSession(a, n, RATE));
      try { assert.deepEqual(wave(reopened, 1, 3), wave(s, 1, 3)); } finally { reopened.delete(); }
      // A standalone import and a batch must sound identical after sequences are
      // deduplicated/remapped; compare beyond the combined loop boundary too.
      assert.ok(s.bookmarks(1).some(b => b.persist && b.highlight[0] === 0));
      const batchPcm = wave(s, 1, 46);
      const solo = await direct(bytes, { allSongs: false, song: 1 }), single = open(solo.data);
      try { assert.deepEqual(batchPcm, wave(single, 0, 46)); } finally { single.delete(); }
    } finally { s.delete(); }
  });
  await check(`${game}: original NSF and rebuilt module agree per channel`, async () => {
    const result = await direct(bytes, { allSongs: false, song: 1 }), s = open(result.data);
    try {
      for (let c = 0; c < 4; ++c) {
        const mute = 31 - 2 ** c;
        const raw = inImportHeap(nsf, bytes, (a, n) => nsf.nsfRender(a, n, 1, 5, 44100, mute));
        const pcm = wave(s, 0, 5, mute);
        const first = p => p.findIndex(v => Math.abs(v) > 150);
        const lag = first(pcm) - first(raw);
        assert.ok(Math.abs(lag) < 4410, `channel ${c}: start lag ${lag}`);
        const score = likeness(lag >= 0 ? raw : raw.subarray(-lag), lag >= 0 ? pcm.subarray(lag) : pcm);
        console.log(`  ${game} channel ${c}: ${score.toFixed(3)}`);
        assert.ok(score >= (c === 3 ? 0.72 : 0.90), `channel ${c}: spectrum ${score}`);
      }
    } finally { s.delete(); }
  });
}

await check('corrupt pointers/commands, non-finishing init and zero-time loops are bounded', async () => {
  const bytes = fixture('mm2'), d = identifyCapcomDriver(bytes), header = d.memory.word(d.table + 2);
  const start = d.memory.word(header + 1);
  for (const patch of [[10], [4, 0, start & 255, start >> 8], [4, 128, start & 255, start >> 8], [0, 1, 0x41]]) {
    const bad = identifyCapcomDriver(alter(bytes.slice(), start, patch));
    await assert.rejects(decodeCapcomSong(bad, 1), NsfDriverError);
  }
  assert.throws(() => capcomSongId(identifyCapcomDriver(alter(bytes.slice(), 0xBF00, [0x4C, 0, 0xBF])), 0, 0), NsfDriverError);
  assert.throws(() => capcomSongId(identifyCapcomDriver(alter(bytes.slice(), 0xBF00, [0xA9, 1, 0x8D, 0, 0x80])), 0, 0), /init write/);
  const pointer = alter(bytes.slice(), header + 1, [255, 255]);
  await assert.rejects(decodeCapcomSong(identifyCapcomDriver(pointer), 1), NsfDriverError);
});

await check('init helpers can return before selecting the music', async () => {
  const bytes = fixture('mm2');
  // Clear scratch RAM in a subroutine, restore the incoming song, then call the
  // unchanged rip initialization. The helper RTS precedes the music selection.
  bytes[10] = 0xD0; bytes[11] = 0xBE;
  alter(bytes, 0xBED0, [0x48, 0x20, 0xE0, 0xBE, 0x68, 0x4C, 0, 0xBF]);
  alter(bytes, 0xBEE0, [0xA9, 0, 0x85, 0x42, 0x60]);
  const d = identifyCapcomDriver(bytes);
  assert.equal(capcomSongId(d, 0, 0), 1);
  assert.equal(capcomSongId(d, 1, 0), 0);
});

await check('64 tracks, no split/ZIP, and cancellation leave the current module unchanged', async () => {
  const bytes = fixture('mm2'); bytes[6] = 65;
  // Use the finite synthetic song for every NSF song, with proper APU setup.
  alter(bytes, 0xBF00, [0xA9, 15, 0x8D, 0x15, 0x40, 0xA9, 1, 0x4C, 3, 0x80]);
  const result = await direct(bytes), s = open(result.data);
  try { assert.equal(s.info().tracks.length, 64); assert.equal(result.limit, 'trackLimit'); assert.ok(!result.files && !result.parts); }
  finally { s.delete(); }
  const current = core.createSession(RATE), saved = current.save();
  try {
    for (const point of [0, 0.3, 0.8, 1]) {
      let cancel = false;
      await assert.rejects(direct(fixture('mm2'), {}, { onProgress: p => { if (p >= point) cancel = true; }, isCancelled: () => cancel }), /^Error: cancelled$/);
      assert.deepEqual(current.save(), saved);
    }
  } finally { current.delete(); }
});

await check('decoded boundaries reject invalid ranges and unsupported init falls back per song', async () => {
  const bytes = fixture('mm2'), analysis = new nsf.NsfAnalysis();
  let log;
  try {
    assert.equal(inImportHeap(nsf, bytes, (a, n) => analysis.load(a, n)), '');
    assert.ok(analysis.start(0, 0, 120)); while (!analysis.done()) analysis.run(120);
    log = analysis.log();
  } finally { analysis.delete(); }
  for (const settings of [{ sourceRows: 121 }, { sourceRows: 55, sourceLoopRow: 55 }, { sourceRows: -1 }]) {
    let message;
    try { inImportHeap(core, log, (a, n) => core.importNsf(a, n, RATE, settings)).delete(); }
    catch (e) { message = e instanceof WebAssembly.Exception ? core.getExceptionMessage(e).at(-1) : e.message; }
    assert.match(message, /invalid decoded NSF song boundaries/);
  }
  bytes[10] = 0xF0; bytes[11] = 0xBE;
  alter(bytes, 0xBEF0, [0xB8, 0x4C, 0, 0xBF]); // CLV is harmless to playback but outside our init decoder.
  const result = await direct(bytes, { allSongs: false, song: 0 });
  assert.equal(result.method, 'playback'); assert.equal(result.fallback, true);
  assert.match(result.songs[0].report.reason, /init opcode/);
});

await check('production worker reports game identity, mixed fallback and cancellation transactionally', async () => {
  let id = 0, outcome, cancel = false;
  globalThis.self = { postMessage(message) {
    if (message.type === 'progress' && cancel && message.value >= 0.3)
      void self.onmessage({ data: { type: 'cancel', id: message.id } });
    if (message.type === 'result' || message.type === 'error') outcome = message;
  } };
  const invoke = async (method, ...args) => {
    outcome = null; await self.onmessage({ data: { type: 'call', id: ++id, method, args } });
    assert.ok(outcome);
    if (outcome.type === 'error') throw new Error(outcome.reason);
    return outcome.value;
  };
  try {
    await import('../dist/dnft-session-engine.mjs');
    const bytes = fixture('mm2'), header = await invoke('nsfInfo', bytes);
    assert.equal(header.driver.name, 'Capcom / Mega Man 2');
    const options = { method: 'driver', allSongs: true, seconds: 1, loop: false, trimSilence: false };
    const result = await invoke('importNsf', bytes, options, RATE);
    assert.equal(result.nsfReader.method, 'driver'); assert.equal(result.nsfReader.fallback, true);
    assert.deepEqual(result.batch.songs.map(s => s.report.reader), ['driver', 'driver', 'playback']);
    const saved = await invoke('save'); cancel = true;
    await assert.rejects(invoke('importNsf', bytes, options, RATE), /^Error: cancelled$/);
    assert.deepEqual(await invoke('save'), saved);
  } finally { delete globalThis.self; }
});

process.exitCode = failures ? 1 : 0;

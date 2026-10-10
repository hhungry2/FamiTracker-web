// MIDI parsing, conversion, real-engine playback/save, and worker/UI transactions.
// node web/test/midi.mjs
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import createDnFT from '../dist/dnft.mjs';
import { parseMidi, convertMidi, importMidi, midiInfo } from '../html/dnft-midi-import.mjs';
import { FileMenu } from '../html/dnft-files.mjs';
import { DnFTEditor } from '../html/dnft-editor.mjs';
import { STRINGS } from '../html/dnft-editor-strings.mjs';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { ++failures; console.log(`not ok - ${name}\n${e instanceof WebAssembly.Exception ? dnft.getExceptionMessage(e) : e.stack}`); }
}
const enc = new TextEncoder();
const u16 = n => [n >> 8 & 255, n & 255];
const u32 = n => [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255];
const vlq = n => { const b = [n & 127]; while (n = Math.floor(n / 128)) b.unshift(n & 127 | 128); return b; };
const chunk = (name, bytes) => [...enc.encode(name), ...u32(bytes.length), ...bytes];
const meta = (kind, bytes) => [255, kind, ...vlq(bytes.length), ...bytes];
const tempo = n => meta(0x51, [n >> 16 & 255, n >> 8 & 255, n & 255]);
const midi = (tracks, { format = tracks.length > 1 ? 1 : 0, division = 480 } = {}) => Uint8Array.from([
  ...chunk('MThd', [...u16(format), ...u16(tracks.length), ...u16(division)]),
  ...tracks.flatMap(events => chunk('MTrk', [...events.flatMap(([delta, ...data]) => [...vlq(delta), ...data]), 0, 255, 47, 0])),
]);
const simple = midi([[ [0, 144, 60, 127], [480, 128, 60, 0] ]]);
const dnft = await createDnFT();
const RATE = 44100;
const imported = (bytes = simple, options = {}) => importMidi(dnft, bytes, options, RATE);
const cell = (session, channel, row, pattern = 0) => {
  const data = session.patterns(0).find(p => p.channel === channel && p.pattern === pattern)?.data;
  return data?.slice(row * 12, row * 12 + 12);
};
const noteCells = s => s.patterns(0).flatMap(p => Array.from({ length: p.data.length / 12 }, (_, row) =>
  ({ channel: p.channel, row, pattern: p.pattern, data: p.data.slice(row * 12, row * 12 + 12) })))
  .filter(c => c.data[0] > 0 && c.data[0] < 13);
function inHeap(bytes, fn) {
  const at = dnft._malloc(bytes.length);
  try { dnft.HEAPU8.set(bytes, at); return fn(at, bytes.length); }
  finally { dnft._free(at); }
}
function wave(s) {
  s.beginWave(0, 1, 0, 0, RATE);
  const parts = [];
  try {
    for (let i = 0; i < 1000; ++i) {
      const r = s.renderWave(4096); parts.push(...r.samples);
      if (r.done) return Int16Array.from(parts);
    }
    throw new Error('song did not stop');
  } finally { s.endWave(); }
}
function playbackDuration(s) {
  const heap = dnft._malloc(1024 * 4), rows = [];
  try {
    s.play(0, dnft.PLAY_SONG, 0, 0);
    for (let i = 0; i < 500 && s.state().playing; ++i) {
      s.render(heap, 1024); rows.push(...s.takeRowEvents());
    }
    const stop = rows.find(e => e.frame < 0);
    assert.ok(stop, 'song did not halt');
    // The halt row itself has a normal row duration. Its notes have already cut
    // when that row begins, so compare the last row's start to the MIDI gate.
    return (rows.at(-2).at - rows[0].at) / RATE;
  } finally { dnft._free(heap); }
}

await check('format 0 running status, velocity zero note-off and default tempo', () => {
  const bytes = midi([[[0, 144, 60, 100], [120, 64, 80], [120, 60, 0], [120, 64, 0]]]);
  const p = parseMidi(bytes);
  assert.deepEqual(p.notes.map(n => [n.key, n.start, n.end]), [[60, 0, 240], [64, 120, 360]]);
  assert.deepEqual(p.tempos, [{ tick: 0, tempo: 500000 }]);
  assert.deepEqual(midiInfo(bytes), { title: '', tracks: 1, notes: 2 });
});

await check('format 1 merges tempo and notes, retaining UTF-8 title and copyright', () => {
  const bytes = midi([
    [[0, ...meta(3, enc.encode('テスト "MIDI"'))], [0, ...meta(2, enc.encode('作者'))], [0, ...tempo(600000)], [480, ...tempo(400000)]],
    [[0, 144, 60, 127], [480, 128, 60, 0], [0, 144, 64, 127], [480, 128, 64, 0]],
  ]);
  const { session: s } = imported(bytes);
  assert.equal(s.info().title, 'テスト "MIDI"');
  assert.equal(s.info().copyright, '作者');
  assert.equal(s.track(0).tempo, 100);
  assert.deepEqual([...cell(s, 4, 8).slice(4, 6)], [1, 1]);
  assert.deepEqual([...cell(s, 4, 8).slice(8, 10)], [3, 150]);
  const duration = playbackDuration(s);
  assert.ok(Math.abs(duration - 1) < 0.04, `duration: ${duration}`);
  s.delete();
});

await check('sustain, all notes off and reset controllers give finite note lengths', () => {
  const p = parseMidi(midi([[
    [0, 176, 64, 127], [0, 144, 60, 100], [120, 128, 60, 0], [120, 176, 64, 0],
    [0, 144, 64, 100], [120, 176, 123, 0],
    [0, 176, 64, 127], [0, 144, 67, 100], [120, 128, 67, 0], [120, 176, 121, 0],
  ]]));
  assert.deepEqual(p.notes.map(n => n.end), [240, 360, 600]);
  assert.equal(p.unclosed, 0);
});

await check('overlapping notes of the same pitch have independent note-offs', () => {
  const p = parseMidi(midi([[[0, 144, 60, 100], [120, 144, 60, 90], [120, 128, 60, 0], [120, 128, 60, 0]]]));
  assert.deepEqual(p.notes.map(n => [n.start, n.end]), [[0, 240], [120, 360]]);
});

await check('channel volume and expression affect attacks and held notes, including zero', () => {
  const { session: s } = imported(midi([[
    [0, 176, 7, 127], [0, 144, 60, 127], [120, 176, 11, 64], [120, 176, 7, 0], [240, 128, 60, 0],
  ]]));
  assert.equal(cell(s, 0, 0)[2], 15);
  assert.equal(cell(s, 0, 2)[2], 8);
  assert.equal(cell(s, 0, 4)[2], 0);
  s.delete();
});

await check('six melodic voices and noise drums use valid instruments and render audio', () => {
  const bytes = midi([[
    ...[48, 60, 64, 67, 72, 76].map(key => [0, 144, key, 127]), [0, 153, 38, 127],
    ...[48, 60, 64, 67, 72, 76].map((key, i) => [i ? 0 : 480, 128, key, 0]), [0, 137, 38, 0],
  ]]);
  const { session: s, report } = imported(bytes);
  assert.equal(report.notes, 7); assert.equal(report.dropped, 0);
  assert.equal(new Set(noteCells(s).map(c => c.channel)).size, 7);
  assert.ok(noteCells(s).filter(c => c.channel >= 5).every(c => s.instruments().find(i => i.index === c.data[3]).type === 2));
  const pcm = wave(s);
  assert.ok(pcm.some(v => Math.abs(v) > 100), 'silent import');
  s.delete();
  const base = imported(bytes, { chips: 0 });
  assert.equal(base.session.info().channels.length, 5);
  assert.equal(base.report.notes, 4); assert.equal(base.report.dropped, 3);
  base.session.delete();
});

await check('note-offs at a new attack do not cut the replacement note', () => {
  const { session: s } = imported(midi([[[0, 144, 60, 127], [480, 128, 60, 0], [0, 144, 64, 127], [480, 128, 64, 0]]]));
  assert.equal(cell(s, 0, 8)[0], 5); // E, replacing the preceding cut
  assert.equal(cell(s, 0, 16)[0], 14);
  s.delete();
});

await check('transposition, out-of-range notes and minimum one-row gates', () => {
  const bytes = midi([[[0, 144, 12, 100], [1, 128, 12, 0], [0, 144, 60, 100], [1, 128, 60, 0]]] );
  const normal = imported(bytes);
  assert.equal(normal.report.outOfRange, 1); assert.equal(normal.report.notes, 1); normal.session.delete();
  const shifted = imported(bytes, { transpose: 12 });
  assert.equal(shifted.report.notes, 2); assert.equal(shifted.report.outOfRange, 0);
  assert.ok(noteCells(shifted.session).some(c => c.data[1] === 0)); shifted.session.delete();
  assert.throws(() => convertMidi(simple, { transpose: 0.5 }), /midiOptions/);
  assert.throws(() => convertMidi(midi([[[0, 144, 0, 100], [1, 128, 0, 0]]])), /midiNoPlayableNotes/);
});

await check('pattern boundaries, beat highlights and last-row halt survive saving', () => {
  const bytes = midi([[[0, 144, 60, 127], [480 * 9, 128, 60, 0]]] );
  const { session: s, report } = imported(bytes);
  assert.equal(report.frames, 2); assert.equal(report.rows, 73);
  assert.equal(s.track(0).bookmarks[0].highlight[0], 8);
  assert.equal(cell(s, 0, 8, 1)[0], 14);
  assert.equal(cell(s, 4, 8, 1)[4], 4);
  const data = s.save(), patterns = s.patterns(0), pcm = wave(s);
  s.delete();
  const reopened = inHeap(data, (at, size) => dnft.openSession(at, size, RATE));
  assert.deepEqual(reopened.patterns(0), patterns);
  assert.deepEqual(wave(reopened), pcm);
  reopened.delete();
});

await check('all grid sizes and slow/fast tempo changes remain importable', () => {
  for (const resolution of [4, 8, 12, 16]) {
    const { session: s, report } = imported(simple, { resolution });
    assert.equal(report.rows, resolution + 1);
    const duration = playbackDuration(s);
    assert.ok(Math.abs(duration - 0.5) < 0.04, `resolution ${resolution}: ${duration} seconds`);
    s.delete();
  }
  const bytes = midi([[[0, ...tempo(4000000)], [0, 144, 60, 127], [480, ...tempo(100000)], [480, 128, 60, 0]]] );
  const { session: s } = imported(bytes);
  assert.ok(s.track(0).tempo >= 32 && s.track(0).tempo <= 255);
  const changes = cell(s, 4, 8);
  assert.ok(changes[8] > 0 && changes[8] < 32); assert.ok(changes[9] >= 32);
  s.delete();
});

await check('tempo events collapsing onto the same row retain the last tempo', () => {
  const bytes = midi([[[0, 144, 60, 100], [1, ...tempo(1000000)], [1, ...tempo(500000)], [478, 128, 60, 0]]] );
  const { session: s } = imported(bytes);
  assert.equal(cell(s, 4, 0)[9], 120); s.delete();
});

await check('program changes beyond 64 instrument slots use valid fallback instruments', () => {
  const events = [];
  for (let program = 0; program < 128; ++program)
    events.push([0, 192, program], [0, 144, 60, 100], [120, 128, 60, 0]);
  const { session: s, report } = imported(midi([events]));
  assert.equal(s.instruments().length, 64); assert.ok(report.instruments > 0);
  assert.ok(noteCells(s).every(c => s.instruments().some(i => i.index === c.data[3])));
  s.delete();
});

await check('unclosed notes and unsupported performance messages are reported', () => {
  const bytes = midi([[[0, 144, 60, 127], [120, 224, 1, 64], [0, 176, 1, 100], [120, 240, 2, 1, 247]]] );
  const p = parseMidi(bytes); assert.equal(p.unclosed, 1); assert.equal(p.ignored, 3); assert.equal(p.notes[0].end, 240);
});

await check('format 2, SMPTE, empty songs, huge songs and malformed data fail explicitly', () => {
  assert.throws(() => parseMidi(midi([[]], { format: 2 })), /midiFormat/);
  assert.throws(() => parseMidi(midi([[]], { division: 0xE728 })), /midiTiming/);
  assert.throws(() => parseMidi(midi([[]])), /midiNoNotes/);
  assert.throws(() => convertMidi(midi([[[0, 144, 60, 100], [480 * 8192, 128, 60, 0]]])), /midiTooLong/);
  assert.throws(() => parseMidi(new Uint8Array(16 * 1024 * 1024 + 1)), /midiTooLarge/);
  for (let end = 0; end < simple.length; ++end) assert.throws(() => parseMidi(simple.slice(0, end)), /midiInvalid/);
  assert.throws(() => parseMidi(midi([[[0, 60, 100]]])), /midiInvalid/);
  assert.throws(() => parseMidi(midi([[[0, 144, 60, 255]]])), /midiInvalid/);
  assert.throws(() => parseMidi(midi([[[0, ...meta(0x51, [0, 0, 0])]]])), /midiInvalid/);
  const overlong = Uint8Array.from([...simple.slice(0, 22), 255, 255, 255, 255, 0, ...simple.slice(23)]);
  overlong.set(u32(overlong.length - 22), 18);
  assert.throws(() => parseMidi(overlong), /midiInvalid/);
});

// Exercise the production dispatcher against the real wasm module in Node.
const previousSelf = globalThis.self;
const pending = new Map(); let nextId = 1;
globalThis.self = { postMessage(message) {
  const task = pending.get(message.id); if (!task) return;
  pending.delete(message.id);
  if (message.type === 'result') task.resolve(message.value); else task.reject(new Error(message.reason));
} };
const engineUrl = new URL('../html/dnft-session-engine.mjs', import.meta.url);
const engineSource = readFileSync(engineUrl, 'utf8').replace(/from '(\.\/[^']+)'/g, (_, specifier) =>
  `from '${new URL(['./dnft.mjs', './dnft-nsf-drivers.mjs'].includes(specifier) ? `../dist/${specifier.slice(2)}` : specifier, engineUrl).href}'`);
await import(`data:text/javascript;base64,${Buffer.from(engineSource).toString('base64')}`);
const dispatch = globalThis.self.onmessage;
const call = (method, ...args) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject });
  dispatch({ data: { type: 'call', id, method, args } }).catch(reject);
});

await check('worker imports MIDI and preserves the current unsaved module after failures', async () => {
  assert.equal((await call('midiInfo', simple)).notes, 1);
  assert.equal((await call('importMidi', simple, {}, RATE)).midiReport.notes, 1);
  await call('setTitle', 'unsaved MIDI test');
  const before = await call('saveSnapshot');
  await assert.rejects(call('importMidi', simple.slice(0, 20), {}, RATE), /midiInvalid/);
  await assert.rejects(call('importMidi', simple, { resolution: 0 }, RATE), /midiOptions/);
  assert.deepEqual(await call('saveSnapshot'), before); assert.equal(await call('isModified'), true);
});

await check('Open dispatches .mid and .midi files to the MIDI dialog', async () => {
  const files = [], editor = { files: { importMidi: file => files.push(file.name) } };
  await DnFTEditor.prototype.openFile.call(editor, { name: 'test.MID' });
  await DnFTEditor.prototype.openFile.call(editor, { name: 'test.midi' });
  assert.deepEqual(files, ['test.MID', 'test.midi']);
});

await check('UI failure keeps the dialog and song; success marks imports dirty and reports warnings in every language', async () => {
  for (const strings of Object.values(STRINGS)) {
    const messages = [], nodes = new Map(['chips', 'resolution', 'transpose', 'start', 'close'].map(role =>
      [role, { value: { chips: '1', resolution: '8', transpose: '0' }[role], checkValidity: () => true }]));
    let closed = 0, set = 0, saved = 0;
    const editor = { strings, dirty: false, fileName: 'old', stopPlaying() {}, renderToolbar() {},
      message: (...args) => messages.push(args), setSong: () => ++set, saveToBrowser: () => ++saved,
      session: { sampleRate: RATE, call } };
    const menu = Object.create(FileMenu.prototype);
    Object.assign(menu, { editor, midiFile: { name: 'test.mid', bytes: simple.slice(0, 20) }, midiImportDialog: {
      querySelector: selector => nodes.get(selector.match(/data-role="([^"]+)"/)[1]),
      querySelectorAll: () => [...nodes.values()], close() { ++closed; },
    } });
    await menu.startMidiImport();
    assert.equal(set, 0); assert.equal(closed, 0); assert.equal(editor.fileName, 'old');
    assert.deepEqual(messages.pop(), [strings.midiImportFailed + strings.midiInvalid, true]);
    assert.ok([...nodes.values()].every(n => !n.disabled));
    menu.midiFile.bytes = midi([[[0, 144, 60, 100], [480, 224, 1, 64]]] );
    await menu.startMidiImport();
    assert.equal(set, 1); assert.equal(saved, 1); assert.equal(closed, 1); assert.equal(editor.dirty, true);
    assert.equal(editor.fileName, 'test');
    const [message, warning] = messages.pop(); assert.equal(warning, true);
    assert.ok(message.includes(strings.midiWarnings.ignored.replace('{n}', 1)));
    assert.ok(message.includes(strings.midiWarnings.unclosed.replace('{n}', 1)));
  }
});
globalThis.self = previousSelf;
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;

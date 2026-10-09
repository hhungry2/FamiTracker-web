// Worker transaction and UI checks for asynchronous NSF reconstruction.
// node web/test/nsf-reconstruct-worker.mjs

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import createDnFT from '../dist/dnft.mjs';
import { reconstructNsf } from '../html/dnft-nsf-reconstruct.mjs';
import { SongMenu } from '../html/dnft-song-menu.mjs';
import { STRINGS } from '../html/dnft-editor-strings.mjs';
import { CELL, emptyPattern } from '../html/dnft-song.mjs';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { ++failures; console.log(`not ok - ${name}\n  ${error.stack}`); }
}

const RATE = 48000;
const fixtureCore = await createDnFT();
const fixture = fixtureCore.createSession(RATE);
fixture.setComment('Imported from an NSF: worker test', false);
fixture.setSpeed(0, 1);
const pattern = emptyPattern(64);
pattern.set([1, 3, 15, 0], 0);
for (const [row, volume] of [[4, 12], [8, 9], [12, 6]]) pattern[row * CELL + 2] = volume;
pattern.set([14, 0, 16, 64], 20 * CELL);
pattern.set([0, 0, 16, 64, 4, 0, 0, 0, 0], 63 * CELL);
fixture.setCells(0, 0, 0, 0, pattern);
const bytes = fixture.save();
fixture.delete();

// Run the production worker dispatcher in Node. Only the reconstruction dependency
// is wrapped to pause work or inject a failure at the asynchronous boundary; normal
// work still runs the real reconstruction and independent wasm engines.
const pending = new Map();
let nextId = 1, mode = 'real', release = null;
const previousSelf = globalThis.self;
const hook = '__dnftReconstructionWorkerTest';
globalThis[hook] = async (...args) => {
  if (mode === 'hold') {
    const hooks = args[6];
    const wait = new Promise(resolve => { release = resolve; });
    hooks.onProgress(0.2);
    await wait;
    if (hooks.isCancelled()) throw new Error('cancelled');
  }
  if (mode === 'mismatch') throw new Error('nsfReconstructMismatch');
  if (mode === 'failure') throw new Error('deliberate staging failure');
  return reconstructNsf(...args);
};
globalThis.self = {
  postMessage(message) {
    const task = pending.get(message.id);
    if (!task) return;
    if (message.type === 'progress') {
      task.progress.push(message.value);
      task.onProgress?.(message.value);
    } else {
      pending.delete(message.id);
      if (message.type === 'result') task.resolve(message.value);
      else task.reject(new Error(message.reason));
    }
  },
};
const engineUrl = new URL('../html/dnft-session-engine.mjs', import.meta.url);
let engineSource = readFileSync(engineUrl, 'utf8').replace(/from '(\.\/[^']+)'/g, (_, specifier) =>
  `from '${new URL(['./dnft.mjs', './dnft-nsf-drivers.mjs'].includes(specifier)
    ? `../dist/${specifier.slice(2)}` : specifier, engineUrl).href}'`);
engineSource = engineSource.replace(/import \{ reconstructNsf \} from '[^']+';/,
  `const reconstructNsf = (...args) => globalThis.${hook}(...args);`);
await import(`data:text/javascript;base64,${Buffer.from(engineSource).toString('base64')}`);
const dispatch = globalThis.self.onmessage;

function task(method, args = [], onProgress = null) {
  const id = nextId++, progress = [];
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, progress, onProgress });
    Promise.resolve(dispatch({ data: { type: 'call', id, method, args } })).catch(reject);
  });
  return { promise, progress, cancel: () => dispatch({ data: { type: 'cancel', id } }) };
}
const call = (method, ...args) => task(method, args).promise;
const start = onProgress => task('reconstructNsf', [0, 'reconstructed', RATE], onProgress);
const reset = async () => {
  mode = 'real';
  await call('open', bytes, RATE);
  await call('setTitle', 'unsaved worker test');
  assert.equal(await call('isModified'), true);
};
function held() {
  mode = 'hold';
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  return { running: start(() => entered()), started };
}

try {
  await check('worker reports progress and commits a verified track and instruments', async () => {
    await reset();
    const running = start(), result = await running.promise;
    assert.equal(result.reconstruction.verified, true);
    assert.equal(result.reconstruction.track, 1);
    assert.equal(result.info.tracks.length, 2);
    assert.ok(result.reconstruction.rows < result.reconstruction.beforeRows);
    assert.deepEqual(result.instruments, await call('instruments'));
    assert.equal(running.progress[0], 0);
    assert.equal(running.progress.at(-1), 1);
    assert.ok(running.progress.some(value => value > 0 && value < 1));
  });

  await check('cancellation keeps the existing session unchanged and releases the busy guard', async () => {
    await reset();
    const before = await call('saveSnapshot');
    const { running, started } = held();
    await started;
    await running.cancel();
    release();
    await assert.rejects(running.promise, /cancelled/);
    assert.deepEqual(await call('saveSnapshot'), before);
    assert.equal(await call('isModified'), true, 'cancellation keeps the unsaved state');
    mode = 'real';
    assert.equal((await start().promise).info.tracks.length, 2);
  });

  await check('a second reconstruction is rejected while ordinary worker calls remain responsive', async () => {
    await reset();
    const { running, started } = held();
    await started;
    assert.equal((await call('info')).tracks.length, 1);
    await assert.rejects(start().promise, /nsfReconstructBusy/);
    await running.cancel();
    release();
    await assert.rejects(running.promise, /cancelled/);
    assert.equal(await call('isModified'), true, 'busy rejection and cancellation keep the unsaved state');
  });

  await check('edits made during reconstruction are preserved instead of overwritten', async () => {
    await reset();
    const { running, started } = held();
    await started;
    await call('setTitle', 'edited during reconstruction');
    const edited = await call('saveSnapshot');
    release();
    await assert.rejects(running.promise, /nsfReconstructChanged/);
    assert.deepEqual(await call('saveSnapshot'), edited);
    assert.equal(await call('isModified'), true, 'concurrent edits keep the unsaved state');
  });

  await check('a replacement document is preserved while earlier reconstruction finishes', async () => {
    await reset();
    const { running, started } = held();
    await started;
    await call('create', RATE);
    const replacement = await call('saveSnapshot');
    release();
    await assert.rejects(running.promise, /nsfReconstructChanged/);
    assert.deepEqual(await call('saveSnapshot'), replacement);
  });

  await check('successful reconstruction preserves every original track highlight and clears the new grid', async () => {
    await reset();
    await call('addTrack');
    await call('setHighlight', 0, 3, 12);
    await call('setHighlight', 1, 5, 20);
    const result = await start().promise;
    assert.equal(result.reconstruction.track, 2);
    assert.deepEqual((await call('track', 0)).highlight, [3, 12]);
    assert.deepEqual((await call('track', 1)).highlight, [5, 20]);
    assert.deepEqual(result.track.track.highlight, [0, 0]);
    assert.ok(result.track.track.bookmarks.some(mark => mark.frame === 0 && mark.row === 0 &&
      mark.highlight[0] === 0 && mark.highlight[1] === 0 && mark.persist));
  });

  await check('highlight-only edits during reconstruction survive the byte commit', async () => {
    await reset();
    await call('addTrack');
    const before = await call('saveSnapshot');
    const { running, started } = held();
    await started;
    await call('setHighlight', 0, 7, 28);
    await call('setHighlight', 1, 9, 36);
    // These settings are absent from the legacy file serialization, so the normal
    // byte guard cannot detect the edits; commit must copy their current values.
    assert.deepEqual(await call('saveSnapshot'), before);
    release();
    const result = await running.promise;
    assert.equal(result.reconstruction.track, 2);
    assert.deepEqual((await call('track', 0)).highlight, [7, 28]);
    assert.deepEqual((await call('track', 1)).highlight, [9, 36]);
    assert.deepEqual(result.track.track.highlight, [0, 0]);
  });

  for (const [failureMode, reason] of [['mismatch', /nsfReconstructMismatch/], ['failure', /deliberate staging failure/]])
    await check(`${failureMode} preserves the original document`, async () => {
      await reset();
      const before = await call('saveSnapshot');
      mode = failureMode;
      await assert.rejects(start().promise, reason);
      assert.deepEqual(await call('saveSnapshot'), before);
      assert.equal(await call('isModified'), true, `${failureMode} keeps the unsaved state`);
    });
} finally {
  globalThis.self = previousSelf;
  delete globalThis[hook];
}

function ui(resultOrError) {
  const events = new Map(), buttonEvents = new Map();
  const nodes = new Map([['.dnft-dialog-title', {}], ['progress', {}], ['.dnft-progress span', {}],
    ['[data-role="cancel"]', { addEventListener: (type, fn) => buttonEvents.set(type, fn) }]]);
  const dialog = {
    open: false, querySelector: selector => nodes.get(selector),
    addEventListener: (type, fn) => events.set(type, fn),
    showModal() { this.open = true; }, close() { this.open = false; },
  };
  const messages = [], sent = [], tracks = [], restored = [];
  const originalTrack = {};
  let cancelCount = 0;
  const editor = {
    strings: STRINGS.en, track: 0, tr: { title: 'original' }, muted: [true, false, true, false, false],
    trackerMenu: { options: { averageBpm: true, decay: 1 } },
    files: { dialog: () => dialog },
    song: { info: { tracks: ['original'] }, instruments: [], setTrackData: (...args) => tracks.push(args), tracks: [originalTrack] },
    stopPlaying() {}, message: (...args) => messages.push(args), selectTrack: async () => {}, edited() {},
    setMuted: value => restored.push(value),
    session: {
      sampleRate: RATE, clearRows() {}, clearLevels() {}, send: (...args) => sent.push(args),
      task(method, args, onProgress) {
        assert.equal(method, 'reconstructNsf');
        assert.equal(args[2], RATE);
        onProgress(0.5);
        const promise = typeof resultOrError === 'function' ? resultOrError() :
          resultOrError instanceof Error ? Promise.reject(resultOrError) : Promise.resolve(resultOrError);
        return { promise, cancel: () => { ++cancelCount; } };
      },
    },
  };
  const menu = Object.create(SongMenu.prototype);
  menu.editor = editor;
  menu.buildReconstructionDialog();
  return { menu, editor, dialog, events, buttonEvents, messages, sent, tracks, restored, originalTrack,
    cancelCount: () => cancelCount };
}

await check('UI restores mute, average BPM and meter decay and explains verified fallback', async () => {
  const result = { info: { tracks: ['original', 'reconstructed'] }, instruments: [{ index: 0 }, { index: 1 }],
    track: {}, reconstruction: { track: 1, beforeRows: 64, rows: 6, instruments: 1, verified: true, fallback: true } };
  const page = ui(result);
  await page.menu.reconstructNsf();
  assert.equal(page.dialog.open, false);
  assert.deepEqual(page.restored, [page.editor.muted]);
  assert.deepEqual(page.sent, [['setAverageBpm', true], ['setMeterDecayRate', 1]]);
  assert.equal(page.editor.song.tracks[0], page.originalTrack);
  assert.equal(page.editor.song.instruments, result.instruments);
  assert.deepEqual(page.tracks, [[1, result.track]]);
  assert.ok(page.messages.at(-1)[0].includes(STRINGS.en.nsfReconstructVerified));
  assert.ok(page.messages.at(-1)[0].includes(STRINGS.en.nsfReconstructFallback));
});

await check('Cancel and Escape cancel the active UI task and leave the document intact', async () => {
  let rejectTask;
  const page = ui(() => new Promise((_, reject) => { rejectTask = reject; }));
  const run = page.menu.reconstructNsf();
  assert.equal(page.dialog.open, true);
  page.buttonEvents.get('click')();
  let prevented = false;
  page.events.get('cancel')({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(page.cancelCount(), 2);
  rejectTask(new Error('cancelled'));
  await run;
  assert.equal(page.dialog.open, false);
  assert.equal(page.messages.at(-1)[0], STRINGS.en.nsfReconstructCancelled);
  assert.equal(page.tracks.length, 0);
  assert.equal(page.editor.song.tracks[0], page.originalTrack);
});

await check('UI translates playback mismatch and retains the existing tracks', async () => {
  const page = ui(new Error('nsfReconstructMismatch'));
  await page.menu.reconstructNsf();
  assert.equal(page.messages.at(-1)[0], STRINGS.en.nsfReconstructFailed + STRINGS.en.nsfReconstructMismatch);
  assert.equal(page.messages.at(-1)[1], true);
  assert.equal(page.tracks.length, 0);
  assert.equal(page.editor.song.tracks[0], page.originalTrack);
  for (const language of ['ja', 'en']) assert.ok(STRINGS[language].nsfReconstructMismatch);
});

if (failures) process.exit(1);
console.log('all passed');

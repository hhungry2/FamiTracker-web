// Dn-FamiTracker web port - editor worker.
//
// Owns the wasm module and the editing session (a module open for editing, see
// src/session.h), and renders whenever the audio worklet asks, so the output never
// stops: the song while it plays, the notes played by hand at any time. Chunks go to the
// worklet directly over the MessagePort the page hands over.
//
// Messages from the page:
//   {type: 'engine'} + port                 the worklet's end of the audio channel
//   {type: 'call', id, method, args}        -> {type: 'result', id, value} | {type: 'error', id, reason}
//   {type: 'cancel', id}                    calls off a call that takes a while (exportWave, importNsf)
// Methods: 'create' (sampleRate) and 'open' (bytes, sampleRate) start a session and
// return snapshot(); 'importText' (bytes, sampleRate) too, for a text export, with the
// importer's `warning`; 'importNsf' (bytes, options, sampleRate) too, for an NSF, which it
// plays with the NSF analyzer (dnft-nsf.mjs) first, sending {type: 'progress', id, value}
// on the way, with the import's `report` (see importNsf()); 'nsfInfo' (bytes) reads an
// NSF's header; 'snapshot', 'trackData' (track); 'play' takes a number for the
// playback besides the session's arguments; 'beginImport' (bytes) reads a module to
// import from; 'exportWave' (options, see exportWave()) renders wave files, sending
// {type: 'progress', id, value} on the way; 'registerView' (requests) reads the registers
// and pitches of chips in one go (see registerView()); everything else is a method of the
// session
// (src/session_bindings.cpp).
// Besides: {type: 'rows', events: [{at, frame, row, play}]} for the rows the player read,
// `at` in frames of the output since the worklet started, `play` the number of the
// playback they belong to (frame -1: playback stopped); {type: 'levels', events: [{at,
// levels}]} for the volume meters of the channels (a Uint8Array of 0-15 for each), `at`
// in the same frames, after every tick that changed one.

import createDnFT from './dnft.mjs';

const CHUNK = 1024;   // frames per render; the page tells the worklet the same

let dnft = null;
let heap = 0;
let session = null;
let worklet = null;
let streamFrames = 0;   // frames sent to the worklet
let sessionStart = 0;   // where the session's output begins in the stream
let playback = 0;       // the number the page gave the last play

const ready = createDnFT().then(module => {
  dnft = module;
  heap = dnft._malloc(CHUNK * 4);
});

function reason(e) {
  const parts = dnft?.getExceptionMessage && e instanceof WebAssembly.Exception ? dnft.getExceptionMessage(e) : null;
  return parts ? parts[parts.length - 1] : String(e?.message ?? e);
}

function renderChunk(generation) {
  let pcm;
  if (session) {
    session.render(heap, CHUNK);
    pcm = dnft.HEAP16.slice(heap >> 1, (heap >> 1) + CHUNK * 2);
  } else {
    pcm = new Int16Array(CHUNK * 2);
  }
  worklet.postMessage({ type: 'pcm', buffer: pcm.buffer, last: false, generation }, [pcm.buffer]);
  streamFrames += CHUNK;
  postRows();
}

function postRows() {
  const events = session?.takeRowEvents() ?? [];
  if (events.length)
    self.postMessage({ type: 'rows', events: events.map(e => ({ at: sessionStart + e.at, frame: e.frame, row: e.row, play: playback })) });
  const levels = session?.takeLevelEvents() ?? [];
  if (levels.length)
    self.postMessage({ type: 'levels', events: levels.map(e => ({ at: sessionStart + e.at, levels: e.levels })) });
}

// The register view's data in one call: for each request {chip, addresses, frequencies}
// the registers' values and ages (two bytes each, session.registers()) and the pitches of
// the chip's first `frequencies` channels; the FDS's modulator counter too
function registerView(requests) {
  return requests.map(({ chip, addresses, frequencies }) => ({
    chip,
    registers: session.registers(chip, addresses),
    frequencies: frequencies ? session.channelFrequencies(chip, frequencies) : [],
    ...(chip === 4 ? { modCounter: session.fdsModCounter() } : {}),
  }));
}

function trackData(track) {
  return { track: session.track(track), patterns: session.patterns(track) };
}

function snapshot() {
  return {
    info: session.info(),
    instruments: session.instruments(),
    effects: dnft.effects(),
    tracks: [trackData(0)],
    modified: session.isModified(),
  };
}

function begin(next) {
  session?.delete();
  session = next;
  sessionStart = streamFrames;
  return snapshot();
}

// Calls fn(at, size) with the bytes in the wasm heap
function inHeap(bytes, fn) {
  const at = dnft._malloc(bytes.length);
  dnft.HEAPU8.set(bytes, at);
  try {
    return fn(at, bytes.length);
  } finally {
    dnft._free(at);
  }
}

// A 16-bit PCM wave file of mono samples, as the desktop's export writes it
function waveFile(parts, length, rate) {
  const bytes = new Uint8Array(44 + length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at, text) => [...text].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
  tag(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, length * 2, true);
  let at = 44;
  for (const part of parts) {
    for (let i = 0; i < part.length; ++i, at += 2)
      view.setInt16(at, part[i], true);
  }
  return bytes;
}

const cancelled = new Set();   // ids of calls the page called off
const WORK_SLICE_MS = 50;      // rendering between looks at the messages

// File > Create WAV: {track, passes (0: for `seconds`), seconds, rate, muted (bit n: channel
// n), separate: [channel]} -> [{channel, data}], the file with the channels not muted
// (channel -1), then one with each channel of `separate` alone, as the desktop's
// "separate channel export" writes them.
async function exportWave(id, { track, passes, seconds, rate, muted = 0, separate = [] }) {
  const all = 2 ** session.info().channels.length - 1;
  const renders = [{ channel: -1, muted }, ...separate.map(channel => ({ channel, muted: all - 2 ** channel }))];
  const files = [];
  try {
    for (const [index, render] of renders.entries()) {
      session.beginWave(track, passes, seconds, render.muted, rate);
      const parts = [];
      let length = 0;
      for (let done = false; !done;) {
        const started = performance.now();
        let progress = 0;
        while (!done && performance.now() - started < WORK_SLICE_MS) {
          const out = session.renderWave(rate / 10);
          parts.push(out.samples);
          length += out.samples.length;
          done = out.done;
          progress = out.progress;
        }
        self.postMessage({ type: 'progress', id, value: (index + progress) / renders.length });
        // the worklet and the page get their turn
        await new Promise(resolve => setTimeout(resolve));
        if (cancelled.has(id))
          throw new Error('cancelled');
      }
      session.endWave();
      files.push({ channel: render.channel, data: waveFile(parts, length, rate) });
    }
  } finally {
    session.endWave();
    cancelled.delete(id);
  }
  return files;
}

// ---- NSF import ----------------------------------------------------------------------------

// The NSF analyzer (dnft-nsf.mjs: NSFPlay and what writes down the frames), loaded the first
// time an NSF is looked at
let nsfReady = null;
const nsfAnalyzer = () => nsfReady ??= import('./dnft-nsf.mjs').then(module => module.default());

function inNsfHeap(nsf, bytes, fn) {
  const at = nsf._malloc(bytes.length);
  nsf.HEAPU8.set(bytes, at);
  try {
    return fn(at, bytes.length);
  } finally {
    nsf._free(at);
  }
}

// What the file's header tells: {error, title, artist, copyright, songs, start, chips,
// regions, preferred, periodNtsc, periodPal, tracks: [{title, time, fade}]...}
async function nsfInfo(bytes) {
  const nsf = await nsfAnalyzer();
  return inNsfHeap(nsf, bytes, (at, size) => nsf.nsfInfo(at, size));
}

const NSF_RUN_FRAMES = 60;   // frames played between looks at the clock

// Import NSF: plays the song for at most `seconds` and makes a module of it (the session's
// importNsf()). options: {song (from 0), region (-1 the file's, 0 NTSC, 1 PAL), seconds,
// patternLength, loop, trimSilence}. Returns snapshot() with report (the session's
// nsfReport()); sends {type: 'progress', id, value} while the song plays.
async function importNsf(id, bytes, options, sampleRate) {
  const nsf = await nsfAnalyzer();
  const analysis = new nsf.NsfAnalysis();
  let log;
  try {
    const info = inNsfHeap(nsf, bytes, (at, size) => nsf.nsfInfo(at, size));
    const error = inNsfHeap(nsf, bytes, (at, size) => analysis.load(at, size));
    if (error)
      throw new Error(error);
    const region = options.region ?? -1;
    const pal = region === 1 || (region < 0 && info.preferred !== 0);
    const frames = Math.max(1, Math.round((options.seconds ?? 300) * 1e6 / ((pal ? info.periodPal : info.periodNtsc) || 16639)));
    if (!analysis.start(options.song ?? info.start, region, frames))
      throw new Error(`no song ${(options.song ?? 0) + 1}`);
    while (!analysis.done()) {
      const started = performance.now();
      while (!analysis.done() && performance.now() - started < WORK_SLICE_MS)
        analysis.run(NSF_RUN_FRAMES);
      self.postMessage({ type: 'progress', id, value: Math.min(1, analysis.frames() / frames) });
      // the worklet and the page get their turn
      await new Promise(resolve => setTimeout(resolve));
      if (cancelled.has(id))
        throw new Error('cancelled');
    }
    log = analysis.log();
  } finally {
    analysis.delete();
    cancelled.delete(id);
  }
  // a module that cannot be made leaves the one open as it is
  const snapshot = inHeap(log, (at, size) => begin(dnft.importNsf(at, size, sampleRate, options)));
  return { ...snapshot, report: session.nsfReport() };
}

function call(method, args, id) {
  switch (method) {
    case 'create':
      return begin(dnft.createSession(args[0]));
    case 'open':
      return inHeap(args[0], (at, size) => begin(dnft.openSession(at, size, args[1])));
    case 'importText': {
      const snapshot = inHeap(args[0], (at, size) => begin(dnft.importText(at, size, args[1])));
      return { ...snapshot, warning: session.takeWarning() };
    }
    case 'nsfInfo':
      return nsfInfo(args[0]);
    case 'importNsf':
      return importNsf(id, args[0], args[1], args[2]);
  }
  if (!session)
    throw new Error('no module is open');
  switch (method) {
    case 'snapshot':
      return snapshot();
    case 'trackData':
      return trackData(args[0]);
    case 'effects':
      return dnft.effects();
    case 'play':
      // rows rendered before belong to the previous playback
      postRows();
      playback = args[4] ?? playback + 1;
      return session.play(args[0], args[1], args[2], args[3]);
    case 'registerView':
      return registerView(args[0]);
    case 'beginImport':
      return inHeap(args[0], (at, size) => session.beginImport(at, size));
    case 'exportWave':
      return exportWave(id, args[0]);
  }
  if (typeof session[method] !== 'function' || HANDLE_METHODS.has(method))
    throw new Error(`no method ${method}`);
  return session[method](...args);
}

// what embind adds to every object, which the page has no business calling
const HANDLE_METHODS = new Set(['delete', 'clone', 'deleteLater', 'isDeleted', 'isAliasOf']);

// The buffers of the files a result holds, handed over instead of copied
function transferables(value) {
  if (value instanceof Uint8Array)
    return [value.buffer];
  const files = Array.isArray(value) ? value : value?.files;
  return Array.isArray(files) ? files.filter(f => f?.data instanceof Uint8Array).map(f => f.data.buffer) : [];
}

self.onmessage = async event => {
  const message = event.data;
  await ready;
  if (message.type === 'engine') {
    worklet = event.ports[0];
    worklet.onmessage = e => {
      if (e.data.type === 'need')
        renderChunk(e.data.generation);
    };
  } else if (message.type === 'call') {
    try {
      const value = await call(message.method, message.args ?? [], message.id);
      self.postMessage({ type: 'result', id: message.id, value }, transferables(value));
    } catch (e) {
      self.postMessage({ type: 'error', id: message.id, reason: reason(e) });
    }
  } else if (message.type === 'cancel') {
    cancelled.add(message.id);
  }
};

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
// Methods: 'create' (sampleRate) and 'open' (bytes, sampleRate) start a session and
// return snapshot(); 'snapshot', 'trackData' (track); 'play' takes a number for the
// playback besides the session's arguments; everything else is a method of the session
// (src/session_bindings.cpp).
// Besides: {type: 'rows', events: [{at, frame, row, play}]} for the rows the player read,
// `at` in frames of the output since the worklet started, `play` the number of the
// playback they belong to (frame -1: playback stopped).

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

function call(method, args) {
  switch (method) {
    case 'create':
      return begin(dnft.createSession(args[0]));
    case 'open': {
      const bytes = args[0];
      const at = dnft._malloc(bytes.length);
      dnft.HEAPU8.set(bytes, at);
      try {
        return begin(dnft.openSession(at, bytes.length, args[1]));
      } finally {
        dnft._free(at);
      }
    }
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
  }
  if (typeof session[method] !== 'function' || HANDLE_METHODS.has(method))
    throw new Error(`no method ${method}`);
  return session[method](...args);
}

// what embind adds to every object, which the page has no business calling
const HANDLE_METHODS = new Set(['delete', 'clone', 'deleteLater', 'isDeleted', 'isAliasOf']);

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
      const value = call(message.method, message.args ?? []);
      const transfer = value instanceof Uint8Array ? [value.buffer] : [];
      self.postMessage({ type: 'result', id: message.id, value }, transfer);
    } catch (e) {
      self.postMessage({ type: 'error', id: message.id, reason: reason(e) });
    }
  }
};

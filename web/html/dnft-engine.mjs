// Dn-FamiTracker web port - engine worker.
//
// Owns the wasm module and renders when the audio worklet asks for more. Chunks go to
// the worklet directly over the MessagePort the page hands over; the page only hears
// about results, state and load.
//
// Messages from the page (the same as the ZXTune web build's engine worker):
//   {type: 'engine'} + port   the worklet's end of the audio channel
//   {type: 'open', bytes, subpath, sampleRate, generation}  -> 'opened' {meta} | 'failed'
//   {type: 'detect', bytes}   -> 'detected' {tracks} | 'failed'
//   {type: 'seek', ms, generation}
//   {type: 'property', name, value}   integer player property, kept for later tracks
//   {type: 'stop', generation}
//   {type: 'plugins'}         -> 'plugins' {plugins}
// Besides, while playing: 'state' {state} after every chunk, 'load' {ms, budgetMs}.

import createDnFT from './dnft.mjs';

const CHUNK = 4096;   // frames per render call

let dnft = null;
let heap = 0;
let player = null;
let worklet = null;
let generation = 0;
let ended = false;
let rate = 48000;
let renderMs = 0;
let rendered = 0;
const properties = new Map();

const ready = createDnFT().then(module => {
  dnft = module;
  heap = dnft._malloc(CHUNK * 4);
});

function reason(e) {
  const parts = dnft?.getExceptionMessage ? dnft.getExceptionMessage(e) : null;
  return parts ? parts[parts.length - 1] : String(e);
}

function withHeap(bytes, fn) {
  const at = dnft._malloc(bytes.length);
  dnft.HEAPU8.set(bytes, at);
  try {
    return fn(at, bytes.length);
  } finally {
    dnft._free(at);
  }
}

function release() {
  player?.delete();
  player = null;
}

function describe(track) {
  const property = name => track.getProperty(name, '');
  return {
    type: property('Type'),
    title: property('Title'),
    author: property('Author'),
    copyright: property('Copyright'),
    comment: property('Comment'),
    program: property('Program'),
    computer: property('Computer'),
    chips: property('Chips'),
    frameRate: Number(property('FrameRate')),
    track: Number(property('Track')),
    tracks: Number(property('Tracks')),
    trackTitle: property('TrackTitle'),
    channels: track.getChannels(),
    durationMs: track.getDuration(),
    loopMs: track.getLoopDuration(),
  };
}

function renderChunk(wanted) {
  if (!player || ended || wanted !== generation)
    return;
  const started = performance.now();
  const more = player.render(heap, CHUNK);
  const spent = performance.now() - started;
  renderMs = renderMs ? renderMs * 0.85 + spent * 0.15 : spent;
  // slice() copies out of the heap into a buffer that can be transferred
  const pcm = dnft.HEAP16.slice(heap >> 1, (heap >> 1) + CHUNK * 2);
  if (!more)
    ended = true;
  worklet.postMessage({ type: 'pcm', buffer: pcm.buffer, last: !more, generation: wanted }, [pcm.buffer]);
  self.postMessage({ type: 'state', state: player.state(), generation: wanted });
  if (++rendered % 4 === 0)
    self.postMessage({ type: 'load', ms: renderMs, budgetMs: (CHUNK / rate) * 1000 });
}

self.onmessage = async event => {
  const message = event.data;
  await ready;

  switch (message.type) {
    case 'engine':
      worklet = event.ports[0];
      worklet.onmessage = e => {
        if (e.data.type === 'need')
          renderChunk(e.data.generation);
      };
      break;

    case 'open':
      release();
      ended = false;
      generation = message.generation;
      rate = message.sampleRate;
      renderMs = 0;
      try {
        const track = withHeap(message.bytes, (at, size) => dnft.load(at, size, message.subpath ?? ''));
        const meta = describe(track);
        player = track.createPlayer(rate);
        track.delete();
        for (const [name, value] of properties)
          player.setIntProperty(name, value);
        self.postMessage({ type: 'opened', meta, generation });
      } catch (e) {
        self.postMessage({ type: 'failed', reason: reason(e) });
      }
      break;

    case 'detect':
      try {
        const { tracks } = withHeap(message.bytes, (at, size) => dnft.detect(at, size));
        self.postMessage({ type: 'detected', tracks: Array.from({ length: tracks.length }, (_, i) => ({ ...tracks[i] })) });
      } catch (e) {
        self.postMessage({ type: 'failed', reason: reason(e) });
      }
      break;

    case 'seek':
      if (player) {
        generation = message.generation;
        ended = false;
        player.seek(message.ms);
      }
      break;

    case 'property':
      properties.set(message.name, message.value);
      player?.setIntProperty(message.name, message.value);
      break;

    case 'stop':
      generation = message.generation;
      ended = true;
      release();
      break;

    case 'plugins': {
      const list = dnft.plugins();
      self.postMessage({ type: 'plugins', plugins: Array.from({ length: list.length }, (_, i) => ({ ...list[i] })) });
      break;
    }
  }
};

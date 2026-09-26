// Dn-FamiTracker web port - page side.
//
// Wires the engine worker and the audio worklet to each other, then stays out of the
// audio path. The interface matches the ZXTune web build's ZXTunePlayer, plus the
// tracker state the worker reports while rendering.
//
//   const player = await DnFTPlayer.create({ base: '.' });
//   const meta = await player.open(bytes);   // {title, author, durationMs, channels, ...}
//   player.play();

const DEFAULT_BUFFER_SECONDS = 0.4;

// The engine reports errors by throwing, so the build uses wasm exception handling;
// WebAssembly.Exception shipped with it (Chrome 95, Firefox 100, Safari 15.2).
export function unsupportedReason() {
  if (typeof WebAssembly !== 'object')
    return 'this browser has no WebAssembly';
  if (typeof WebAssembly.Exception !== 'function')
    return 'this browser is missing WebAssembly exception handling (needs Chrome 95, Firefox 100 or Safari 15.2)';
  if (typeof AudioWorkletNode !== 'function')
    return 'this browser has no AudioWorklet';
  return null;
}

export class DnFTPlayer {
  static async create({ base = '.', bufferSeconds = DEFAULT_BUFFER_SECONDS, context = null } = {}) {
    const reason = unsupportedReason();
    if (reason)
      throw new Error(reason);
    const audio = context ?? new AudioContext();
    await audio.audioWorklet.addModule(`${base}/dnft-processor.js`);
    return new DnFTPlayer(audio, base, bufferSeconds);
  }

  constructor(context, base, bufferSeconds) {
    this.context = context;
    this.generation = 0;
    this.startMs = 0;        // where the current generation started playing from
    this.positionMs = 0;
    this.duration = 0;
    this.states = [];        // tracker states rendered ahead of the audible position
    this.onposition = null;  // (ms)
    this.onstate = null;     // (state) as the audio reaches it
    this.onended = null;
    this.onload = null;      // ({ms, budgetMs}) render cost per chunk

    this.node = new AudioWorkletNode(context, 'dnft', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { bufferSeconds },
    });
    this.output = context.createGain();
    this.node.connect(this.output);
    this.output.connect(context.destination);

    this.worker = new Worker(`${base}/dnft-engine.mjs`, { type: 'module' });
    const channel = new MessageChannel();
    this.node.port.postMessage({ type: 'engine' }, [channel.port1]);
    this.worker.postMessage({ type: 'engine' }, [channel.port2]);

    this.node.port.onmessage = event => this.onWorklet(event.data);
    this.worker.addEventListener('message', event => this.onWorker(event.data));
  }

  onWorklet(message) {
    if (message.type === 'played') {
      this.positionMs = this.startMs + (message.frames / this.context.sampleRate) * 1000;
      this.onposition?.(Math.min(this.positionMs, this.duration || this.positionMs));
      // hand out the newest state the audio has reached
      let state = null;
      while (this.states.length && this.states[0].timeMs <= this.positionMs)
        state = this.states.shift();
      if (state)
        this.onstate?.(state);
    } else if (message.type === 'ended') {
      this.onended?.();
    }
  }

  onWorker(message) {
    if (message.type === 'load')
      this.onload?.(message);
    else if (message.type === 'state' && message.generation === this.generation)
      this.states.push(message.state);
  }

  // Resolves with the next reply of that type; rejects on 'failed'.
  reply(type) {
    return new Promise((resolve, reject) => {
      const listener = event => {
        const message = event.data;
        if (message.type === type || message.type === 'failed') {
          this.worker.removeEventListener('message', listener);
          if (message.type === 'failed')
            reject(new Error(message.reason));
          else
            resolve(message);
        }
      };
      this.worker.addEventListener('message', listener);
    });
  }

  // A new generation makes the worklet drop whatever was rendered before.
  restart(fromMs) {
    this.startMs = fromMs;
    this.positionMs = fromMs;
    this.states = [];
    this.node.port.postMessage({ type: 'reset', generation: ++this.generation });
    return this.generation;
  }

  // The bytes are copied to the worker; the page keeps its own.
  async detect(bytes) {
    this.worker.postMessage({ type: 'detect', bytes });
    return (await this.reply('detected')).tracks;
  }

  async open(bytes, subpath = '') {
    const generation = this.restart(0);
    this.worker.postMessage({ type: 'open', bytes, subpath, sampleRate: this.context.sampleRate, generation });
    const { meta } = await this.reply('opened');
    this.duration = meta.durationMs;
    return meta;
  }

  seek(ms) {
    const generation = this.restart(ms);
    this.worker.postMessage({ type: 'seek', ms: Math.round(ms), generation });
  }

  async plugins() {
    this.worker.postMessage({ type: 'plugins' });
    return (await this.reply('plugins')).plugins;
  }

  // 'zxtune.core.channels_mask' (bit n mutes channel n), 'zxtune.sound.loop' (0/1).
  // Kept for the tracks opened later.
  setIntProperty(name, value) {
    this.worker.postMessage({ type: 'property', name, value });
  }

  set volume(value) {
    this.output.gain.value = value;
  }

  play() {
    return this.context.resume();
  }

  pause() {
    return this.context.suspend();
  }

  get playing() {
    return this.context.state === 'running';
  }

  stop() {
    this.worker.postMessage({ type: 'stop', generation: ++this.generation });
    this.node.port.postMessage({ type: 'reset', generation: this.generation });
    this.startMs = 0;
    this.positionMs = 0;
    this.duration = 0;
    this.states = [];
  }
}

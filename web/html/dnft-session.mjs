// Dn-FamiTracker web port - page side of an editing session.
//
// Wires the editor worker (dnft-session-engine.mjs) to the audio worklet with small
// buffers, so that notes played by hand are heard within a tenth of a second, and keeps
// track of which row the audio has reached.
//
//   const session = await DnFTSession.create({ base: '.' });
//   const song = await session.call('create', session.sampleRate);
//   session.send('setCells', 0, 0, 0, 0, cells);
//   session.play(0, PLAY.CURSOR, 0, 0);
//   requestAnimationFrame(() => session.poll());   // -> {frame, row} playing, or null
//   session.ended                                  // true once the song stopped by itself
//   session.levels                                 // the channels' volume meters now (0-15)
//   session.analyser                               // an AnalyserNode on the output

import { unsupportedReason } from './dnft-player.mjs';

export { unsupportedReason };

// Session.PlayMode (src/session.h)
export const PLAY = { SONG: 0, FRAME: 1, CURSOR: 2, PATTERN: 3 };

const CHUNK_FRAMES = 1024;      // what the worker renders per request
const BUFFER_SECONDS = 0.06;    // queued ahead of the worklet
const REPORT_SECONDS = 0.05;

export class DnFTSession {
  static async create({ base = '.', context = null, bufferSeconds = BUFFER_SECONDS } = {}) {
    const reason = unsupportedReason();
    if (reason)
      throw new Error(reason);
    const audio = context ?? new AudioContext({ latencyHint: 'interactive' });
    await audio.audioWorklet.addModule(`${base}/dnft-processor.js`);
    return new DnFTSession(audio, base, bufferSeconds);
  }

  constructor(context, base, bufferSeconds) {
    this.context = context;
    this.sampleRate = context.sampleRate;
    this.pending = new Map();     // call id -> {resolve, reject}
    this.nextId = 1;
    this.rows = [];               // row events not reached by the audio yet
    this.levelEvents = [];        // the same for the volume meters
    this.levels = null;           // the meters the audio heard now has: a Uint8Array, 0-15 for each channel
    this.playing = null;          // {frame, row} the audio is at, or null
    this.playback = 0;            // the number of the last play()
    this.ended = false;           // the audio reached where that playback stopped
    this.reported = { frames: 0, time: 0 };
    this.onerror = null;          // (message) for calls sent without waiting
    this.onplayed = null;         // () after each position report of the worklet

    this.node = new AudioWorkletNode(context, 'dnft', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { bufferSeconds, chunkFrames: CHUNK_FRAMES, reportSeconds: REPORT_SECONDS },
    });
    this.output = context.createGain();
    this.node.connect(this.output);
    this.output.connect(context.destination);
    // what the oscilloscope and the spectrum of the editor look at
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.7;
    this.output.connect(this.analyser);

    this.worker = new Worker(`${base}/dnft-session-engine.mjs`, { type: 'module' });
    const channel = new MessageChannel();
    this.node.port.postMessage({ type: 'engine' }, [channel.port1]);
    this.worker.postMessage({ type: 'engine' }, [channel.port2]);

    this.node.port.onmessage = event => {
      if (event.data.type === 'played') {
        this.reported = { frames: event.data.frames, time: event.data.time };
        // also while the page is hidden and draws nothing
        this.poll();
        this.onplayed?.();
      }
    };
    this.worker.onmessage = event => this.onWorker(event.data);
  }

  onWorker(message) {
    if (message.type === 'rows') {
      this.rows.push(...message.events);
    } else if (message.type === 'levels') {
      this.levelEvents.push(...message.events);
    } else if (message.type === 'progress') {
      this.pending.get(message.id)?.onprogress?.(message.value);
    } else if (message.type === 'result' || message.type === 'error') {
      const call = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.type === 'result')
        call?.resolve(message.value);
      else if (call)
        call.reject(new Error(message.reason));
    }
  }

  // Resolves with what the method returns (see dnft-session-engine.mjs).
  call(method, ...args) {
    return this.task(method, args).promise;
  }

  // A call that reports its progress (0 to 1) as it goes, and can be called off:
  // {promise, cancel()}. A call called off fails with 'cancelled'.
  task(method, args, onprogress = null) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onprogress });
      this.worker.postMessage({ type: 'call', id, method, args });
    });
    return { promise, cancel: () => this.worker.postMessage({ type: 'cancel', id }) };
  }

  // For changes whose result nobody waits for; failures go to onerror.
  send(method, ...args) {
    this.call(method, ...args).catch(e => this.onerror ? this.onerror(e.message) : console.error(e));
  }

  // Starts playback (PLAY.*); `ended` tells when it stops by itself.
  play(track, mode, frame, row) {
    this.ended = false;
    this.send('play', track, mode, frame, row, ++this.playback);
  }

  stop() {
    this.send('stop');
  }

  // The output frame the listener hears now
  audibleFrame() {
    const context = this.context;
    let now = context.currentTime - (context.outputLatency || context.baseLatency || 0);
    const stamp = context.getOutputTimestamp?.();
    if (stamp?.performanceTime > 0)
      now = stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000;
    if (!this.reported.time)
      return 0;
    return Math.max(0, this.reported.frames + (now - this.reported.time) * this.sampleRate);
  }

  // Where the audio heard now is: {frame, row} while the song plays, null otherwise.
  poll() {
    const at = this.audibleFrame();
    while (this.levelEvents.length && this.levelEvents[0].at <= at)
      this.levels = this.levelEvents.shift().levels;
    while (this.rows.length && this.rows[0].at <= at) {
      const e = this.rows.shift();
      this.playing = e.frame < 0 ? null : { frame: e.frame, row: e.row };
      if (e.frame < 0 && e.play === this.playback)
        this.ended = true;
    }
    return this.playing;
  }

  // Forgets rows reported for what will not be heard as the song (a stop, a new song).
  clearRows() {
    this.rows = [];
    this.playing = null;
  }

  // For a new module: the meters of the old one
  clearLevels() {
    this.levelEvents = [];
    this.levels = null;
  }

  resume() {
    return this.context.resume();
  }

  set volume(value) {
    this.output.gain.value = value;
  }
}

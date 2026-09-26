// Dn-FamiTracker web port - audio thread.
//
// Plays the int16 stereo chunks the engine worker renders. The worker is reached over
// a MessagePort of its own, so a busy page cannot delay the audio, and buffers are
// transferred rather than shared, which keeps SharedArrayBuffer (and the COOP/COEP
// headers it needs) out of the picture.
//
// Messages follow the ZXTune web build, so either engine can feed this processor:
//   from the page:   {type: 'engine'} + port to the worker, {type: 'reset', generation}
//   to the worker:   {type: 'need', generation}
//   from the worker: {type: 'pcm', buffer, last, generation}
//   to the page:     {type: 'played', frames, time}, {type: 'ended', frames}
// `time` is the context time at which the last of the frames played leaves the worklet.
//
// processorOptions: bufferSeconds (0.4) of audio kept queued, chunkFrames (4096) the
// worker renders per request, reportSeconds (0.1) between position updates. The editor
// asks for small buffers, so that notes played by hand are heard soon.

const MAX_REQUESTS = 8;           // chunks asked for and not delivered yet

class DnFTProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = options.processorOptions ?? {};
    this.bufferFrames = (settings.bufferSeconds ?? 0.4) * sampleRate;
    this.chunkFrames = settings.chunkFrames ?? 4096;
    this.reportFrames = (settings.reportSeconds ?? 0.1) * sampleRate;
    this.worker = null;
    this.generation = 0;
    this.reset();
    this.port.onmessage = event => this.onPage(event);
  }

  // A seek or a new track makes everything queued stale.
  reset() {
    this.chunks = [];
    this.queuedFrames = 0;
    this.requests = 0;
    this.playedFrames = 0;
    this.reportedFrames = 0;
    this.last = false;
    this.endReported = false;
  }

  onPage(event) {
    const message = event.data;
    if (message.type === 'engine') {
      this.worker = event.ports[0];
      this.worker.onmessage = e => this.onWorker(e.data);
    } else if (message.type === 'reset') {
      this.generation = message.generation;
      this.reset();
    }
  }

  onWorker(message) {
    if (message.type !== 'pcm' || message.generation !== this.generation)
      return;
    this.requests = Math.max(0, this.requests - 1);
    const samples = new Int16Array(message.buffer);
    this.chunks.push({ samples, at: 0 });
    this.queuedFrames += samples.length / 2;
    if (message.last)
      this.last = true;
  }

  request() {
    if (!this.worker || this.last)
      return;
    while (this.requests < MAX_REQUESTS && this.queuedFrames + this.requests * this.chunkFrames < this.bufferFrames) {
      ++this.requests;
      this.worker.postMessage({ type: 'need', generation: this.generation });
    }
  }

  process(inputs, outputs) {
    const [left, right = left] = outputs[0];
    let written = 0;
    while (written < left.length && this.chunks.length) {
      const chunk = this.chunks[0];
      const frames = Math.min(chunk.samples.length / 2 - chunk.at, left.length - written);
      for (let i = 0; i < frames; ++i) {
        const at = 2 * (chunk.at + i);
        left[written + i] = chunk.samples[at] / 32768;
        right[written + i] = chunk.samples[at + 1] / 32768;
      }
      chunk.at += frames;
      written += frames;
      this.queuedFrames -= frames;
      if (chunk.at * 2 === chunk.samples.length)
        this.chunks.shift();
    }
    left.fill(0, written);
    if (right !== left)
      right.fill(0, written);
    this.playedFrames += written;

    this.request();

    if (this.playedFrames - this.reportedFrames >= this.reportFrames) {
      this.reportedFrames = this.playedFrames;
      this.port.postMessage({ type: 'played', frames: this.playedFrames, time: currentTime + left.length / sampleRate });
    }
    if (this.last && this.queuedFrames === 0 && !this.endReported) {
      this.endReported = true;
      this.port.postMessage({ type: 'ended', frames: this.playedFrames });
    }
    return true;
  }
}

registerProcessor('dnft', DnFTProcessor);

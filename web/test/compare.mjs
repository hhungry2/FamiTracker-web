// Compares the wasm build's output with a wave file exported by the desktop tracker.
//
//   node test/compare.mjs <module> <exported.wav> [--track=N]
//
// Export from Dn-FamiTracker with File > Create WAV..., "Play the song 1 time(s)",
// and default sound settings (Sound: sample rate and filters; Mixer: chip levels). The
// desktop export starts after five silent ticks, the web build does not: the tool looks
// for the offset that lines both up, then reports how far apart they are.

import createDnFT from '../dist/dnft.mjs';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const options = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')));
const [moduleFile, waveFile] = args.filter(a => !a.startsWith('--'));
if (!moduleFile || !waveFile) {
  console.error('usage: node test/compare.mjs <module> <exported.wav> [--track=N]');
  process.exit(2);
}

// The first channel of a 16-bit PCM wave file
function readWave(file) {
  const b = readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE')
    throw new Error(`${file} is not a wave file`);
  let format = null;
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString('latin1', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      format = { tag: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!format || format.tag !== 1 || format.bits !== 16)
        throw new Error(`${file}: only 16-bit PCM is supported`);
      const frames = Math.floor(size / 2 / format.channels);
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; ++i)
        samples[i] = b.readInt16LE(body + 2 * i * format.channels);
      return { rate: format.rate, samples };
    }
    at = body + size + (size & 1);
  }
  throw new Error(`${file} has no audio data`);
}

const reference = readWave(waveFile);
const RATE = reference.rate;
const CHUNK = 4096;

const dnft = await createDnFT();
const bytes = readFileSync(moduleFile);
const at = dnft._malloc(bytes.length);
dnft.HEAPU8.set(bytes, at);
const track = dnft.load(at, bytes.length, options.track ? `#${options.track}` : '');
dnft._free(at);
const player = track.createPlayer(RATE);
track.delete();

const heap = dnft._malloc(CHUNK * 4);
const parts = [];
for (let more = true; more;) {
  more = player.render(heap, CHUNK);
  const pcm = dnft.HEAP16.subarray(heap >> 1, (heap >> 1) + CHUNK * 2);
  const mono = new Int16Array(CHUNK);
  for (let i = 0; i < CHUNK; ++i)
    mono[i] = pcm[2 * i];
  parts.push(mono);
}
player.delete();
const ours = new Int16Array(parts.length * CHUNK);
parts.forEach((p, i) => ours.set(p, i * CHUNK));

// The reference starts later by the export's lead-in: find the shift that matches best
// over a window a second into the song.
const WINDOW = Math.min(RATE * 2, ours.length - RATE);
function mismatch(shift) {
  let differ = 0;
  for (let i = RATE; i < RATE + WINDOW; ++i)
    if (reference.samples[i + shift] !== ours[i])
      ++differ;
  return differ;
}
let best = { shift: 0, differ: Infinity };
for (let shift = 0; shift <= RATE / 5; ++shift) {
  const differ = mismatch(shift);
  if (differ < best.differ)
    best = { shift, differ };
  if (differ === 0)
    break;
}

const length = Math.min(ours.length, reference.samples.length - best.shift);
let identical = 0;
let maxDiff = 0;
let sumSq = 0;
let firstDiff = -1;
for (let i = 0; i < length; ++i) {
  const d = reference.samples[i + best.shift] - ours[i];
  if (d === 0)
    ++identical;
  else if (firstDiff < 0)
    firstDiff = i;
  maxDiff = Math.max(maxDiff, Math.abs(d));
  sumSq += d * d;
}
const seconds = n => `${(n / RATE).toFixed(3)}s`;
console.log(`reference ${seconds(reference.samples.length)} at ${RATE} Hz, web build ${seconds(ours.length)}`);
console.log(`aligned with the reference ${best.shift} samples (${seconds(best.shift)}) later`);
console.log(`compared ${seconds(length)}: ${(identical / length * 100).toFixed(3)}% of samples identical, max difference ${maxDiff}, rms ${Math.sqrt(sumSq / length).toFixed(2)}`);
if (firstDiff >= 0)
  console.log(`first difference at ${seconds(firstDiff)} (sample ${firstDiff})`);

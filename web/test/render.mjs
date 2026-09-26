// Renders a module to a wave file with the wasm build and reports what it found.
//
//   node test/render.mjs <module> [out.wav] [--seconds=N] [--track=N] [--rate=48000] [--loop]
//
// Without --seconds the track plays until it ends (one pass, or until it halts).

import createDnFT from '../dist/dnft.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const options = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
  const [key, value = 'true'] = a.slice(2).split('=');
  return [key, value];
}));
const [file, out] = args.filter(a => !a.startsWith('--'));
if (!file) {
  console.error('usage: node test/render.mjs <module> [out.wav] [--seconds=N] [--track=N] [--rate=48000] [--loop]');
  process.exit(2);
}

const rate = Number(options.rate ?? 48000);
const CHUNK = 4096;

const dnft = await createDnFT();

function load(bytes, subpath) {
  const at = dnft._malloc(bytes.length);
  dnft.HEAPU8.set(bytes, at);
  try {
    return dnft.load(at, bytes.length, subpath);
  } catch (e) {
    throw new Error(dnft.getExceptionMessage(e).at(-1));
  } finally {
    dnft._free(at);
  }
}

const bytes = readFileSync(file);
const subpath = options.track ? `#${options.track}` : '';
const started = performance.now();
const track = load(bytes, subpath);
const loadMs = performance.now() - started;

const property = name => track.getProperty(name, '');
console.log(`${file}`);
for (const name of ['Type', 'Program', 'Title', 'Author', 'Copyright', 'Chips', 'Channels', 'FrameRate', 'Computer', 'Tracks', 'Track'])
  console.log(`  ${name.padEnd(10)} ${property(name)}`);
console.log(`  Duration   ${(track.getDuration() / 1000).toFixed(2)}s (loop ${(track.getLoopDuration() / 1000).toFixed(2)}s), loaded in ${loadMs.toFixed(1)}ms`);

const player = track.createPlayer(rate);
track.delete();
if (options.loop)
  player.setIntProperty('zxtune.sound.loop', 1);

const limit = options.seconds ? Number(options.seconds) * rate : Infinity;
const heap = dnft._malloc(CHUNK * 4);
const chunks = [];
let frames = 0;
let renderMs = 0;
let more = true;
while (more && frames < limit) {
  const t = performance.now();
  more = player.render(heap, CHUNK);
  renderMs += performance.now() - t;
  const take = Math.min(CHUNK, limit - frames);
  chunks.push(dnft.HEAP16.slice(heap >> 1, (heap >> 1) + take * 2));
  frames += take;
}
dnft._free(heap);

const state = player.state();
console.log(`  Rendered   ${(frames / rate).toFixed(2)}s in ${renderMs.toFixed(0)}ms (${((frames / rate) * 1000 / renderMs).toFixed(0)}x realtime), ended=${!more}`);
console.log(`  State      ${JSON.stringify(state)}`);

// level of the left channel (the output is mono duplicated to both sides)
let peak = 0;
let sum = 0;
for (const c of chunks)
  for (let i = 0; i < c.length; i += 2) {
    peak = Math.max(peak, Math.abs(c[i]));
    sum += c[i] * c[i];
  }
const rms = Math.sqrt(sum / Math.max(1, frames));
console.log(`  Level      peak ${peak} rms ${rms.toFixed(1)}`);
player.delete();

if (out) {
  const data = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);        // PCM
  header.writeUInt16LE(2, 22);        // stereo
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(out, Buffer.concat([header, data]));
  console.log(`  Wrote      ${out}`);
}

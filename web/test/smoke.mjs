// Checks the javascript interface against the demo modules.
//
//   node test/smoke.mjs

import createDnFT from '../dist/dnft.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.join(here, '..', '..', 'demo');
const RATE = 48000;
const CHUNK = 4096;

const dnft = await createDnFT();
const heap = dnft._malloc(CHUNK * 4);

function withHeap(bytes, fn) {
  const at = dnft._malloc(bytes.length);
  dnft.HEAPU8.set(bytes, at);
  try {
    return fn(at, bytes.length);
  } finally {
    dnft._free(at);
  }
}

function load(bytes, subpath = '') {
  return withHeap(bytes, (at, size) => {
    try {
      return dnft.load(at, size, subpath);
    } catch (e) {
      throw new Error(dnft.getExceptionMessage(e).at(-1));
    }
  });
}

// Renders `ms` of audio and returns the left channel.
function render(player, ms) {
  const frames = Math.round(ms * RATE / 1000);
  const out = new Int16Array(frames);
  for (let done = 0; done < frames; done += CHUNK) {
    player.render(heap, CHUNK);
    const pcm = dnft.HEAP16.subarray(heap >> 1, (heap >> 1) + CHUNK * 2);
    for (let i = 0; i < CHUNK && done + i < frames; ++i)
      out[done + i] = pcm[2 * i];
  }
  return out;
}

const energy = pcm => pcm.reduce((sum, s) => sum + s * s, 0) / pcm.length;
const equal = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    ++failures;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

const files = readdirSync(demoDir).filter(f => /\.(dnm|0cc|ftm)$/i.test(f)).sort();
assert.ok(files.length > 0, 'no demo modules');

check('plugins() reports the engine', () => {
  const plugins = dnft.plugins();
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].id, 'DNFT');
});

check('garbage is refused with a message', () => {
  assert.throws(() => load(new Uint8Array(1000).fill(0x55)), /.+/);
  assert.equal(withHeap(new Uint8Array(1000), (at, size) => dnft.detect(at, size)).tracks.length, 0);
});

check('a truncated module is refused', () => {
  const bytes = readFileSync(path.join(demoDir, files[0]));
  assert.throws(() => load(bytes.subarray(0, bytes.length >> 1)));
});

for (const file of files) {
  const bytes = readFileSync(path.join(demoDir, file));

  check(`${file}: detect() lists its tracks`, () => {
    const { tracks } = withHeap(bytes, (at, size) => dnft.detect(at, size));
    assert.ok(tracks.length >= 1);
    for (const t of tracks) {
      assert.ok(t.title.length > 0);
      assert.ok(t.durationMs > 10000);
    }
  });

  check(`${file}: plays, and plays the same twice`, () => {
    const track = load(bytes);
    const a = render(track.createPlayer(RATE), 3000);
    const b = render(track.createPlayer(RATE), 3000);
    track.delete();
    assert.ok(energy(a) > 1000, 'silent');
    assert.ok(equal(a, b), 'two renders differ');
  });

  check(`${file}: seeking lands where playing would`, () => {
    const track = load(bytes);
    const straight = render(track.createPlayer(RATE), 7000).subarray(5 * RATE);
    const player = track.createPlayer(RATE);
    player.seek(5000);
    assert.equal(player.getPosition(), 5000);
    const sought = render(player, 2000);
    track.delete();
    assert.ok(equal(straight, sought), 'audio after seek differs');
  });

  check(`${file}: muting every channel silences it`, () => {
    const track = load(bytes);
    const player = track.createPlayer(RATE);
    player.setIntProperty('zxtune.core.channels_mask', 0xFFFFFFFF);
    const pcm = render(player, 3000);
    track.delete();
    // the DC offset settles through the high-pass filter; nothing else should sound
    assert.ok(energy(pcm.subarray(RATE)) < 10, `energy ${energy(pcm.subarray(RATE))}`);
  });
}

check('the last player created is the one that plays', () => {
  const first = load(readFileSync(path.join(demoDir, files[0])));
  const second = load(readFileSync(path.join(demoDir, files[1 % files.length])));
  const p1 = first.createPlayer(RATE);
  const p2 = second.createPlayer(RATE);
  assert.ok(energy(render(p2, 2000)) > 1000);
  assert.equal(p1.render(heap, CHUNK), false);
  first.delete();
  second.delete();
});

check('looping keeps playing past the end, unless the track halts', () => {
  for (const file of files) {
    const track = load(readFileSync(path.join(demoDir, file)));
    const duration = track.getDuration();
    const loops = track.getLoopDuration() > 0;
    const player = track.createPlayer(RATE);
    player.setIntProperty('zxtune.sound.loop', 1);
    player.seek(duration + 1000);
    const more = player.render(heap, CHUNK);
    track.delete();
    assert.equal(more, loops, file);
  }
});

dnft._free(heap);
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

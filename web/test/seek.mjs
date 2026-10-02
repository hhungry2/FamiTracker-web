// Checks seeking: the audio after a seek is the audio of playing up to there, bit for bit,
// and getting there is much faster than playing.
//
//   node test/seek.mjs

import createDnFT from '../dist/dnft.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.join(here, '..', '..', 'demo');
const RATE = 48000;
const CHUNK = 4096;

// The tracker's values (APU/Types.h)
const SNDCHIP = { VRC6: 1, VRC7: 2, FDS: 4, MMC5: 8, N163: 16, S5B: 32 };
const EMPTY = [0, 0, 16, 64, 0, 0, 0, 0, 0, 0, 0, 0];

const dnft = await createDnFT();
const heap = dnft._malloc(CHUNK * 4);

function load(bytes) {
  const at = dnft._malloc(bytes.length);
  dnft.HEAPU8.set(bytes, at);
  try {
    return dnft.load(at, bytes.length, '');
  } catch (e) {
    throw new Error(dnft.getExceptionMessage(e).at(-1));
  } finally {
    dnft._free(at);
  }
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

function maxDifference(a, b) {
  assert.equal(a.length, b.length);
  let max = 0;
  for (let i = 0; i < a.length; ++i)
    max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

const energy = pcm => pcm.reduce((sum, s) => sum + s * s, 0) / pcm.length;

// The audio from `at` seconds on, played straight from the start
function straight(track, at, ms) {
  const player = track.createPlayer(RATE);
  const pcm = render(player, at * 1000 + ms);
  return pcm.subarray(Math.round(at * RATE));
}

// A module of the given chips, made with an editing session: every channel plays a note
// every four rows, each frame another pattern. 2A03 DPCM is left out (it needs samples).
function makeModule(chips, frames) {
  const session = dnft.createSession(RATE);
  session.setExpansion(chips, 4);
  const channels = [];
  const add = (chip, count) => { for (let i = 0; i < count; ++i) channels.push(chip); };
  add(0, 5);
  for (const [chip, count] of [[SNDCHIP.VRC6, 3], [SNDCHIP.VRC7, 6], [SNDCHIP.FDS, 1], [SNDCHIP.MMC5, 2], [SNDCHIP.N163, 4], [SNDCHIP.S5B, 3]])
    if (chips & chip)
      add(chip, count);

  const instruments = {};
  const instrumentOf = chip => chip === 0 ? 0 : instruments[chip] ??= session.addInstrument(chip === SNDCHIP.MMC5 ? 0 : chip, `chip ${chip}`);
  session.setFrameCount(0, frames);
  let seed = 12345;
  const random = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) % n; };
  channels.forEach((chip, channel) => {
    if (channel === 4)
      return;
    const instrument = instrumentOf(chip);
    for (let frame = 0; frame < frames; ++frame) {
      session.setFramePattern(0, frame, channel, frame);
      const cells = new Uint8Array(64 * 12);
      for (let row = 0; row < 64; ++row)
        cells.set(EMPTY, row * 12);
      for (let row = 0; row < 64; row += 4) {
        const octave = chip === SNDCHIP.VRC7 || chip === SNDCHIP.FDS ? 3 + random(2) : 2 + random(3);
        cells.set([1 + random(12), octave, 16, instrument], row * 12);
        if (random(5) === 0)
          cells.set([11], row * 12 + 4), cells.set([0x47], row * 12 + 8);     // a vibrato
        else if (random(7) === 0)
          cells.set([10], row * 12 + 4), cells.set([0x37], row * 12 + 8);     // an arpeggio
      }
      session.setCells(0, channel, frame, 0, cells);
    }
  });
  const bytes = session.save();
  session.delete();
  return bytes;
}

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

// The modules are what the players play: several places, the first of them within the
// exact stretch the seek ends with, the last far in (past the 28 s at which Hellpath's N163
// used to be gone: #10).
for (const file of files) {
  check(`${file}: the audio after a seek is that of playing`, () => {
    const track = load(readFileSync(path.join(demoDir, file)));
    const places = [0.2, 7.3, 41.7];
    for (const at of places) {
      const player = track.createPlayer(RATE);
      player.seek(Math.round(at * 1000));
      assert.equal(player.getPosition(), Math.round(at * 1000));
      const sought = render(player, 1500);
      const difference = maxDifference(straight(track, at, 1500), sought);
      assert.equal(difference, 0, `${at} s: differs by up to ${difference}`);
    }
    track.delete();
  });
}

// One module of each chip, and one of them all: the chips are emulated differently, and
// so are they skipped
const chipSets = [
  ['VRC6', SNDCHIP.VRC6], ['VRC7', SNDCHIP.VRC7], ['FDS', SNDCHIP.FDS], ['MMC5', SNDCHIP.MMC5],
  ['N163', SNDCHIP.N163], ['5B', SNDCHIP.S5B],
  ['every chip', SNDCHIP.VRC6 | SNDCHIP.VRC7 | SNDCHIP.FDS | SNDCHIP.MMC5 | SNDCHIP.N163 | SNDCHIP.S5B],
];
for (const [name, chips] of chipSets) {
  check(`a module with ${name}: the audio after a seek is that of playing`, () => {
    const track = load(makeModule(chips, 4));
    assert.ok(energy(straight(track, 1, 1000)) > 1000, 'silent');
    for (const at of [0.35, 3.1, 19.7]) {
      const player = track.createPlayer(RATE);
      player.seek(Math.round(at * 1000));
      const sought = render(player, 1000);
      const difference = maxDifference(straight(track, at, 1000), sought);
      assert.equal(difference, 0, `${at} s: differs by up to ${difference}`);
    }
    track.delete();
  });
}

// #10: with no bass removal the Namco 163's own Blip_Buffer added up the rounding of its steps
// until the output clipped, and Hellpath's N163 was gone at 28 s (Kot's at 63 s)
check('the Namco 163 sounds on through a long play, with the 2A03 muted', () => {
  for (const file of files.filter(f => /Hellpath|Wavetable/.test(f))) {
    const track = load(readFileSync(path.join(demoDir, file)));
    const player = track.createPlayer(RATE);
    player.setIntProperty('zxtune.core.channels_mask', 0x1F);
    const pcm = render(player, 70000);
    const late = (from, to) => Math.sqrt(energy(pcm.subarray(from * RATE, to * RATE)));
    assert.ok(late(60, 69) > late(2, 11) / 4, `${file}: ${late(60, 69)} at 60 s, ${late(2, 11)} at 2 s`);
    assert.ok(late(30, 39) > 100, `${file}: ${late(30, 39)} at 30 s`);
    track.delete();
  }
});

check('a seek goes on from where the player is, and starts over when the position is behind', () => {
  const track = load(readFileSync(path.join(demoDir, files[0])));
  const direct = track.createPlayer(RATE);
  direct.seek(12000);
  const want = render(direct, 1000);

  // forward from a position that was seeked to, and from one that was played to
  const forward = track.createPlayer(RATE);
  forward.seek(5000);
  forward.seek(12000);
  assert.equal(forward.getPosition(), 12000);
  assert.ok(maxDifference(want, render(forward, 1000)) === 0, 'forward differs');

  const played = track.createPlayer(RATE);
  render(played, 3000);
  played.seek(12000);
  assert.ok(maxDifference(want, render(played, 1000)) === 0, 'forward from playing differs');

  // backward, and to where it is
  const back = track.createPlayer(RATE);
  back.seek(20000);
  back.seek(12000);
  assert.equal(back.getPosition(), 12000);
  assert.ok(maxDifference(want, render(back, 1000)) === 0, 'backward differs');
  const rendered = back.getPosition();
  back.seek(rendered);
  assert.equal(back.getPosition(), rendered);
  back.seek(0);
  assert.equal(back.getPosition(), 0);
  track.delete();
});

check('a seek inside what was rendered ahead, and past what is left of the track', () => {
  const track = load(readFileSync(path.join(demoDir, files[0])));
  const want = straight(track, 0.01, 500);
  const player = track.createPlayer(RATE);
  // the engine renders a tick at a time (800 frames at 60 ticks a second), so the
  // first tick is still being handed out, and 10 ms are in it
  player.render(heap, 100);
  player.seek(10);
  assert.equal(player.getPosition(), 10);
  assert.ok(maxDifference(want, render(player, 500)) === 0, 'differs');

  const duration = track.getDuration();
  player.seek(duration + 5000);
  assert.ok(player.getPosition() <= duration + 500, `${player.getPosition()} ms after the end`);
  assert.equal(player.render(heap, CHUNK), false);
  // and from the end back into the track
  player.seek(2000);
  assert.equal(player.getPosition(), 2000);
  assert.ok(energy(render(player, 500)) > 100, 'silent after starting over');
  track.delete();
});

check('a seek past the end of a looping track goes on playing', () => {
  for (const file of files) {
    const track = load(readFileSync(path.join(demoDir, file)));
    if (track.getLoopDuration() === 0) {
      track.delete();
      continue;
    }
    const player = track.createPlayer(RATE);
    player.setIntProperty('zxtune.sound.loop', 1);
    player.seek(track.getDuration() + 3000);
    assert.equal(player.render(heap, CHUNK), true, file);
    assert.ok(player.getPosition() > track.getDuration(), `${file}: ${player.getPosition()} ms`);
    track.delete();
  }
});

check('muted channels stay muted through a seek', () => {
  const track = load(readFileSync(path.join(demoDir, files[0])));
  const player = track.createPlayer(RATE);
  player.setIntProperty('zxtune.core.channels_mask', 0xFFFFFFFF);
  player.seek(10000);
  const pcm = render(player, 2000);
  assert.ok(energy(pcm.subarray(RATE)) < 10, `energy ${energy(pcm.subarray(RATE))}`);
  track.delete();
});

// Skipping is the point: a seek that is not several times faster than playing is not one
check('getting to a position is several times faster than playing to it', () => {
  const track = load(readFileSync(path.join(demoDir, files[0])));
  const played = track.createPlayer(RATE);
  render(played, 500);       // warms the engine up
  const start = performance.now();
  render(track.createPlayer(RATE), 30000);
  const playing = performance.now() - start;

  const player = track.createPlayer(RATE);
  const seekStart = performance.now();
  player.seek(30000);
  const seeking = performance.now() - seekStart;
  assert.ok(seeking * 3 < playing, `playing takes ${playing.toFixed(0)} ms, seeking ${seeking.toFixed(0)} ms`);
  track.delete();
});

dnft._free(heap);
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

// Checks the parts of the instrument editor's page code that work on numbers, without a
// page: what is done to the bytes of a DPCM sample, wave files as samples, the waves of
// the presets, and the texts the wave editors read.
//
//   node test/dpcm.mjs

import { strict as assert } from 'node:assert';
import {
  fitSample, expandSample, deleteBlocks, tiltBlocks, reverseBits, decodeWave, convertToDpcm,
} from '../html/dnft-dpcm.mjs';
import {
  FDS_PRESETS, N163_PRESETS, modulationSine, readIntegers, parsePatchText, patchText,
} from '../html/dnft-instrument-panels.mjs';
import { formatSequence, parseSequence } from '../html/dnft-instrument-editor.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    ++failures;
    console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ') ?? e.message}`);
  }
}

const MAX = 0xFF1;

check('a .dmc file is padded to 16n + 1 bytes with 0xAA, and cut at 4081', () => {
  for (const size of [0, 1, 2, 15, 16, 17, 33, 100, 4080, 4081]) {
    const { data, clipped } = fitSample(new Uint8Array(size).fill(7), MAX);
    assert.equal(data.length % 16, 1, `size ${size} -> ${data.length}`);
    assert.ok(data.length >= Math.max(size, 1) && data.length <= MAX);
    assert.equal(clipped, false);
    assert.ok(data.subarray(0, size).every(b => b === 7));
    assert.ok(data.subarray(size).every(b => b === 0xAA));
  }
  const long = fitSample(new Uint8Array(6000).fill(1), MAX);
  assert.equal(long.data.length, MAX);
  assert.equal(long.clipped, true);
  // the desktop's numbers: 100 -> 113
  assert.equal(fitSample(new Uint8Array(100), MAX).data.length, 113);
});

check('the wave of a sample follows the delta counter, two steps a bit, low bit first', () => {
  const up = expandSample(Uint8Array.of(0xFF), 0);
  assert.deepEqual([...up], [2, 4, 6, 8, 10, 12, 14, 16]);
  const down = expandSample(Uint8Array.of(0x00), 64);
  assert.deepEqual([...down], [62, 60, 58, 56, 54, 52, 50, 48]);
  // the low bit is first
  assert.deepEqual([...expandSample(Uint8Array.of(0x01), 64)], [66, 64, 62, 60, 58, 56, 54, 52]);
  // the counter stops at both ends
  const top = expandSample(new Uint8Array(20).fill(0xFF), 64);
  assert.equal(top.at(-1), 126);
  assert.ok(top.every(v => v <= 126));
  const bottom = expandSample(new Uint8Array(20), 0);
  assert.ok(bottom.every(v => v === 0));
  // from 64, 0x55 wobbles by one step
  assert.deepEqual([...expandSample(Uint8Array.of(0x55), 64)], [66, 64, 66, 64, 66, 64, 66, 64]);
});

check('deleting blocks takes 16 bytes each, and the end leaves 16n + 1', () => {
  const data = Uint8Array.from({ length: 65 }, (_, i) => i);
  const middle = deleteBlocks(data, 1, 3);
  assert.equal(middle.length, 33);
  assert.deepEqual([...middle.subarray(0, 17)], [...data.subarray(0, 17)].map((v, i) => i < 16 ? v : data[48]));
  assert.equal(middle[16], 48);
  assert.equal(middle.at(-1), 64);
  // to the end: the last byte stays
  const tail = deleteBlocks(data, 2, 4);
  assert.equal(tail.length, 33);
  assert.equal(tail.at(-1), 64);
  assert.deepEqual([...tail.subarray(0, 32)], [...data.subarray(0, 32)]);
  // nothing selected
  assert.equal(deleteBlocks(data, 2, 2), data);
});

check('tilt clears a bit at regular steps, and only within the blocks', () => {
  const data = new Uint8Array(65).fill(0xFF);
  const out = tiltBlocks(data, 1, 3, () => 0);
  assert.deepEqual([...out.subarray(0, 16)], Array(16).fill(0xFF));
  assert.deepEqual([...out.subarray(48)], Array(17).fill(0xFF));
  const zeros = [...out.subarray(16, 48)].reduce((n, b) => n + 8 - b.toString(2).split('1').length + 1, 0);
  // 32 bytes = 256 bits, a step every floor(32 * 8 / 10) = 25 bits
  assert.equal(zeros, Math.floor(256 / 25));
  // the input is not touched
  assert.ok(data.every(b => b === 0xFF));
});

check('bit reverse turns every byte round, and twice is the same', () => {
  const data = Uint8Array.from({ length: 256 }, (_, i) => i);
  const once = reverseBits(data);
  assert.equal(once[1], 0x80);
  assert.equal(once[0x80], 0x01);
  assert.equal(once[0xF0], 0x0F);
  assert.equal(once[0xA5], 0xA5);
  assert.deepEqual([...reverseBits(once)], [...data]);
});

// ---- wave files ----------------------------------------------------------------------------

// A wave file with the samples of the channels one after the other, `kind` 1 PCM, 3 float
function wave({ rate = 44100, channels = 1, bits = 16, kind = 1, frames, extensible = false, extra = [] }) {
  const width = bits >> 3;
  const data = new Uint8Array(frames.length * channels * width);
  const view = new DataView(data.buffer);
  frames.forEach((frame, i) => {
    for (let c = 0; c < channels; ++c) {
      const value = Array.isArray(frame) ? frame[c] : frame;
      const at = (i * channels + c) * width;
      if (kind === 3)
        bits === 32 ? view.setFloat32(at, value, true) : view.setFloat64(at, value, true);
      else if (bits === 8)
        data[at] = value + 128;
      else if (bits === 16)
        view.setInt16(at, value, true);
      else if (bits === 24) {
        const v = value & 0xFFFFFF;
        data[at] = v & 255; data[at + 1] = (v >> 8) & 255; data[at + 2] = (v >> 16) & 255;
      } else
        view.setInt32(at, value, true);
    }
  });
  const chunks = [];
  const chunk = (id, body) => {
    const out = new Uint8Array(8 + body.length + (body.length & 1));
    out.set([...id].map(c => c.charCodeAt(0)));
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    chunks.push(out);
  };
  const fmt = new Uint8Array(extensible ? 40 : 16);
  const f = new DataView(fmt.buffer);
  f.setUint16(0, extensible ? 0xFFFE : kind, true);
  f.setUint16(2, channels, true);
  f.setUint32(4, rate, true);
  f.setUint32(8, rate * channels * width, true);
  f.setUint16(12, channels * width, true);
  f.setUint16(14, bits, true);
  if (extensible) {
    f.setUint16(16, 22, true);
    f.setUint16(18, bits, true);
    f.setUint16(24, kind, true);
  }
  for (const [id, body] of extra)
    chunk(id, body);
  chunk('fmt ', fmt);
  chunk('data', data);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const file = new Uint8Array(12 + total);
  file.set([...'RIFF'].map(c => c.charCodeAt(0)));
  new DataView(file.buffer).setUint32(4, 4 + total, true);
  file.set([...'WAVE'].map(c => c.charCodeAt(0)), 8);
  let at = 12;
  for (const c of chunks) { file.set(c, at); at += c.length; }
  return file;
}

check('wave files: 8, 16, 24 and 32 bits, and floats, all in the range of 16 bits', () => {
  const a = decodeWave(wave({ bits: 8, frames: [0, 64, -64, -128] }));
  assert.deepEqual([...a.samples], [0, 64 * 256, -64 * 256, -128 * 256]);
  assert.equal(a.rate, 44100);
  const b = decodeWave(wave({ bits: 16, frames: [0, 1000, -1000, 32767, -32768] }));
  assert.deepEqual([...b.samples], [0, 1000, -1000, 32767, -32768]);
  const c = decodeWave(wave({ bits: 24, frames: [0, 256000, -256000, 8388607] }));
  assert.deepEqual([...c.samples], [0, 1000, -1000, 8388607 / 256]);
  const d = decodeWave(wave({ bits: 32, frames: [0, 65536000, -65536000] }));
  assert.deepEqual([...d.samples], [0, 1000, -1000]);
  const e = decodeWave(wave({ bits: 32, kind: 3, frames: [0, 0.5, -0.25] }));
  assert.deepEqual([...e.samples], [0, 16384, -8192]);
  assert.equal(e.float, true);
  const g = decodeWave(wave({ bits: 64, kind: 3, frames: [0.5, -1] }));
  assert.deepEqual([...g.samples], [16384, -32768]);
});

check('wave files: channels are averaged, chunks are found wherever they are', () => {
  const stereo = decodeWave(wave({ channels: 2, frames: [[100, 300], [-200, 0], [1000, 1002]] }));
  assert.deepEqual([...stereo.samples], [200, -100, 1001]);
  assert.equal(stereo.channels, 2);
  // an odd chunk before, whose padding byte counts
  const extra = decodeWave(wave({ frames: [5, 6], extra: [['LIST', Uint8Array.of(1, 2, 3)], ['junk', new Uint8Array(4)]] }));
  assert.deepEqual([...extra.samples], [5, 6]);
  // WAVE_FORMAT_EXTENSIBLE
  const ext = decodeWave(wave({ frames: [7, 8], extensible: true }));
  assert.deepEqual([...ext.samples], [7, 8]);
  const extFloat = decodeWave(wave({ bits: 32, kind: 3, frames: [0.5], extensible: true }));
  assert.deepEqual([...extFloat.samples], [16384]);
});

check('wave files that cannot be read are refused with the code format', () => {
  const refuse = bytes => assert.throws(() => decodeWave(bytes), e => e.code === 'format');
  refuse(new Uint8Array(0));
  refuse(new Uint8Array(20));
  refuse(Uint8Array.from('RIFF....WAVE'.split('').map(c => c.charCodeAt(0))));
  // 16-bit floating point is not a thing: the kind of the format chunk says 3
  const half = wave({ bits: 16, frames: [0] });
  new DataView(half.buffer).setUint16(12 + 8, 3, true);
  refuse(half);
  const good = wave({ frames: [1, 2, 3] });
  const noData = good.slice(0, 12 + 8 + 16);
  refuse(noData);
  // a data chunk that says more than the file has: what is there is read
  const cut = wave({ frames: [1, 2, 3, 4] }).slice(0, -3);
  assert.deepEqual([...decodeWave(cut).samples], [1, 2]);
});

// ---- from a wave to a sample ---------------------------------------------------------------

const RATE = 44100;
const sine = (hz, seconds, amplitude = 20000, rate = RATE) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / rate));

// The pitch's rate (Hz) of the DMC at the NTSC clock
const DMC_PERIODS = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
const dmcRate = pitch => 1789773 / DMC_PERIODS[pitch];

// The counter's level after every bit of the sample (the wave the DPCM plays, from the middle)
const played = data => expandSample(data, 64);

check('a sample made of a sine follows it, as many bits as the rate makes of the time', () => {
  for (const pitch of [15, 12, 9, 4]) {
    // slow enough for the counter, which moves a step a bit, to follow
    const hz = dmcRate(pitch) / 400;
    const { data, clipped } = convertToDpcm(sine(hz, 0.25), RATE, pitch, 0, MAX);
    assert.equal(data.length % 16, 1);
    assert.equal(clipped, false);
    // 0.25 s at the pitch's rate, in whole bytes (and the padding after)
    const bits = Math.floor(0.25 * dmcRate(pitch));
    assert.ok(Math.abs(data.length * 8 - bits) < 8 * 17, `pitch ${pitch}: ${data.length * 8} bits for ${bits}`);
    // the wave the counter draws is the sine, around the middle of the counter
    const wave = played(data);
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
    for (let i = 64; i < bits - 64; ++i) {
      const x = Math.sin(2 * Math.PI * hz * i / dmcRate(pitch)), y = wave[i];
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; ++n;
    }
    const correlation = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    assert.ok(correlation > 0.98, `pitch ${pitch}: correlation ${correlation.toFixed(3)}`);
    const swing = Math.max(...wave.subarray(64, bits - 64)) - Math.min(...wave.subarray(64, bits - 64));
    // 20000 / 1024 steps up and down, of two levels each
    assert.ok(Math.abs(swing - 2 * 2 * 20000 / 1024) < 6, `pitch ${pitch}: swing ${swing}`);
  }
});

check('the amplitude of the sample follows the gain, 6 dB about twice', () => {
  const swing = data => {
    const w = played(data);
    return Math.max(...w) - Math.min(...w);
  };
  const quiet = swing(convertToDpcm(sine(200, 0.25, 6000), RATE, 15, 0, MAX).data);
  const loud = swing(convertToDpcm(sine(200, 0.25, 6000), RATE, 15, 6, MAX).data);
  const louder = swing(convertToDpcm(sine(200, 0.25, 6000), RATE, 15, 12, MAX).data);
  assert.ok(quiet >= 8 && loud > quiet && louder > loud, `${quiet} ${loud} ${louder}`);
  assert.ok(Math.abs(loud / quiet - 2) < 0.35, `${loud / quiet}`);
  // a wave beyond what the counter can draw is cut at its ends
  const clipping = swing(convertToDpcm(sine(200, 0.25, 32000), RATE, 15, 12, MAX).data);
  assert.ok(clipping <= 126);
});

check('silence makes bits that go up and down, which leave the level where it is', () => {
  const { data } = convertToDpcm(new Float32Array(2000), RATE, 15, 0, MAX);
  assert.ok(data.length > 1);
  assert.ok(data.every(b => b === 0x55), 'not all 0x55');
});

check('a wave that is too long is cut where the sample is longest', () => {
  const { data, clipped } = convertToDpcm(sine(100, 3), RATE, 15, 0, MAX);
  assert.equal(data.length, MAX);
  assert.equal(clipped, true);
  // 4081 bytes of bits at 33.1 kHz are 0.98 s
  const short = convertToDpcm(sine(100, 0.5), RATE, 4, 0, MAX);
  assert.ok(short.data.length < MAX && !short.clipped);
});

check('other rates and no samples', () => {
  const low = convertToDpcm(sine(100, 0.5, 20000, 8000), 8000, 15, 0, MAX);
  assert.equal(low.data.length % 16, 1);
  assert.ok(low.data.length > 100);
  // more rate than the file has is fine too
  const up = convertToDpcm(sine(100, 0.5, 20000, 48000), 48000, 0, 0, MAX);
  assert.equal(up.data.length % 16, 1);
  // nothing: one byte, as the desktop's loop makes
  const none = convertToDpcm(new Float32Array(0), RATE, 15, 0, MAX);
  assert.equal(none.data.length, 1);
  assert.equal(none.data[0], 0x55);
});

// ---- waves of the presets and texts ---------------------------------------------------------------

check('the FDS presets are the desktop\'s', () => {
  const sineWave = FDS_PRESETS.sine();
  assert.equal(sineWave.length, 64);
  // (sin(angle) + 1) * 31.5 + 0.5, with the phase of 0.049087375 and single precision
  assert.deepEqual([...sineWave.subarray(0, 4)], [33, 36, 39, 42]);
  assert.equal(Math.max(...sineWave), 63);
  assert.equal(Math.min(...sineWave), 0);
  assert.equal(FDS_PRESETS.triangle()[31], 62);
  assert.equal(FDS_PRESETS.triangle()[32], 62);
  assert.equal(FDS_PRESETS.triangle()[0], 0);
  assert.equal(FDS_PRESETS.triangle()[63], 0);
  assert.deepEqual([...FDS_PRESETS.sawtooth().subarray(0, 3)], [0, 1, 2]);
  assert.equal(FDS_PRESETS.sawtooth()[63], 63);
  assert.deepEqual([...FDS_PRESETS.pulse50().subarray(30, 34)], [0, 0, 63, 63]);
  assert.deepEqual([...FDS_PRESETS.pulse25().subarray(14, 18)], [0, 0, 63, 63]);
});

check('the N163 presets are the desktop\'s: -1 to 1, times 7.5 plus 8, cut down', () => {
  const s16 = N163_PRESETS.sine(16);
  assert.deepEqual([...s16], [8, 10, 13, 14, 15, 14, 13, 10, 7, 5, 2, 1, 0, 1, 2, 5]);
  const saw = N163_PRESETS.sawtooth(16);
  assert.equal(saw[0], 0);
  assert.equal(saw[15], 15);
  assert.equal(saw[8], Math.trunc((-1 + 2 * 8 / 15) * 7.5 + 8));
  const tri = N163_PRESETS.triangle(16);
  assert.equal(tri[0], 0);
  assert.equal(tri[7], 15);
  assert.equal(tri[8], 15);
  assert.equal(tri[15], 0);
  const pulse = N163_PRESETS.pulse(32, 0.25);
  assert.deepEqual([...pulse], [...Array(24).fill(0), ...Array(8).fill(15)]);
  assert.deepEqual([...N163_PRESETS.pulse(32, 0.5)], [...Array(16).fill(0), ...Array(16).fill(15)]);
});

check('the FDS modulation preset is the desktop\'s sine', () => {
  assert.equal([...modulationSine()].join(''), '47777770001111114111111000777777');
});

check('texts of numbers, as the desktop reads them', () => {
  assert.deepEqual(readIntegers('1 2  3\n4', 10), [1, 2, 3, 4]);
  assert.deepEqual(readIntegers('1 2 x 3', 10), [1, 2]);
  assert.deepEqual(readIntegers('1 2 3 4 5', 3), [1, 2, 3]);
  assert.deepEqual(readIntegers('-3 +4', 10), [-3, 4]);
  assert.deepEqual(readIntegers('', 10), []);
  assert.deepEqual(parsePatchText('$01 $21 $0D 0x0E 240 $f0 15 ; 15 99'), [1, 0x21, 0x0D, 0x0E, 240, 0xF0, 15, 15]);
  assert.deepEqual(parsePatchText('$01 $zz $03'), [1]);
  assert.deepEqual(parsePatchText('300 -1'), [255]);
  assert.equal(patchText(Uint8Array.of(1, 0x21, 0xFF)), '$01 $21 $FF');
});

check('sequences as text, and back', () => {
  const seq = { items: [15, 12, 9, 6], loop: 1, release: 3 };
  assert.equal(formatSequence(seq), '15 | 12 9 / 6');
  assert.deepEqual(parseSequence('15 | 12 9 / 6', [0, 15]), seq);
  // values are kept in range, and marks past the end are dropped
  assert.deepEqual(parseSequence('99 -5 |', [0, 15]), { items: [15, 0], loop: -1, release: -1 });
  assert.equal(parseSequence('1 x', [0, 15]), null);
  assert.deepEqual(parseSequence('0 4 8', [-96, 96]).items, [0, 4, 8]);
});

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall passed');

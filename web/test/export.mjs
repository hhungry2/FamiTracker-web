// Checks the exports and imports of editing sessions: text, JSON, rows, the NSF export
// dialog's kinds, the wave export, the text import and the import of another module.
//
//   node test/export.mjs

import createDnFT from '../dist/dnft.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.join(here, '..', '..', 'demo');
const RATE = 48000;
const WAVE_RATE = 44100;
const CHUNK = 4096;

// The tracker's values (FamiTrackerTypes.h)
const NOTE_C = 1, NOTE_E = 5, NOTE_G = 8;
const NONE = 0, MAX_VOLUME = 16, NO_INSTRUMENT = 64, EF_NONE = 0, EF_HALT = 4;
const CELL = 12;

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

const message = e => e instanceof WebAssembly.Exception ? dnft.getExceptionMessage(e).at(-1) : e.message;
const rethrow = fn => {
  try {
    return fn();
  } catch (e) {
    throw new Error(message(e));
  }
};
const openSession = bytes => withHeap(bytes, (at, size) => rethrow(() => dnft.openSession(at, size, RATE)));
const importText = bytes => withHeap(bytes, (at, size) => rethrow(() => dnft.importText(at, size, RATE)));
const load = (bytes, subpath = '') => withHeap(bytes, (at, size) => rethrow(() => dnft.load(at, size, subpath)));
const text = bytes => new TextDecoder('latin1').decode(bytes);
const equal = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);
const energy = pcm => pcm.reduce((sum, s) => sum + s * s, 0) / Math.max(1, pcm.length);
const cell = (note, octave, instrument = 0) => [note, octave, MAX_VOLUME, instrument, 0, 0, 0, 0, 0, 0, 0, 0];

// The wave export of a session, whole: mono samples
function wave(session, track, passes, seconds = 0, muted = 0, rate = WAVE_RATE) {
  rethrow(() => session.beginWave(track, passes, seconds, muted, rate));
  const parts = [];
  let total = 0;
  for (;;) {
    const r = rethrow(() => session.renderWave(rate));
    parts.push(r.samples);
    total += r.samples.length;
    if (r.done) {
      assert.equal(r.progress, 1);
      break;
    }
  }
  session.endWave();
  const out = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// A player's render of a track until it ends: mono samples
function play(bytes, track, rate = WAVE_RATE) {
  const t = load(bytes, `#${track + 1}`);
  const player = t.createPlayer(rate);
  t.delete();
  const parts = [];
  for (let more = true; more;) {
    more = player.render(heap, CHUNK);
    const pcm = dnft.HEAP16.subarray(heap >> 1, (heap >> 1) + CHUNK * 2);
    parts.push(Int16Array.from({ length: CHUNK }, (_, i) => pcm[2 * i]));
  }
  player.delete();
  const out = new Int16Array(parts.length * CHUNK);
  parts.forEach((p, i) => out.set(p, i * CHUNK));
  return out;
}

function renderSession(session, frames) {
  const out = new Int16Array(frames);
  for (let done = 0; done < frames; done += CHUNK) {
    session.render(heap, CHUNK);
    const pcm = dnft.HEAP16.subarray(heap >> 1, (heap >> 1) + CHUNK * 2);
    for (let i = 0; i < CHUNK && done + i < frames; ++i)
      out[done + i] = pcm[2 * i];
  }
  return out;
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
const modules = Object.fromEntries(files.map(f => [f, readFileSync(path.join(demoDir, f))]));

// A small 2A03 module: what the NES and PRG exports take
function smallSession() {
  const s = dnft.createSession(RATE);
  s.setTitle('Export test');
  s.setArtist('FamiTracker-web');
  s.setCopyright('2026');
  const rows = [];
  for (let r = 0; r < 64; ++r)
    rows.push(...(r % 8 === 0 ? cell([NOTE_C, NOTE_E, NOTE_G][(r / 8) % 3], 4) : [NONE, 0, MAX_VOLUME, NO_INSTRUMENT, 0, 0, 0, 0, 0, 0, 0, 0]));
  s.setCells(0, 0, 0, 0, new Uint8Array(rows));
  s.setCells(0, 2, 0, 0, new Uint8Array(cell(NOTE_C, 3)));
  return s;
}

// ---- text, JSON, rows ------------------------------------------------------------------------

for (const file of files) {
  check(`${file}: the text export reads back as the same module`, () => {
    const s = openSession(modules[file]);
    const channels = s.info().channels;
    const sound = wave(s, 0, 0, 20);
    const exported = rethrow(() => s.exportText());
    s.delete();
    assert.match(text(exported.subarray(0, 40)), /^# Dn-FamiTracker text export/);
    // written in text mode, as on the desktop
    assert.ok(text(exported).includes('\r\n') && !/[^\r]\n/.test(text(exported)), 'lines do not end in CR LF');
    const imported = importText(exported);
    assert.equal(imported.takeWarning(), '');
    assert.deepEqual(imported.info().channels, channels);
    assert.ok(equal(rethrow(() => imported.exportText()), exported), 'exporting the import again differs');
    // and plays the same
    assert.ok(equal(wave(imported, 0, 0, 20), sound), 'the import sounds different');
    imported.delete();
  });
}

check('the text export leaves the module as it is', () => {
  const bytes = modules[files[0]];
  const s = openSession(bytes);
  const before = s.save();
  s.exportText();
  s.exportJSON();
  s.exportRows();
  s.exportNSF('nsf', 0, false);
  assert.ok(equal(s.save(), before));
  s.delete();
});

check('a file that is not a text export is refused, and says where', () => {
  assert.throws(() => importText(new TextEncoder().encode('# comment\nNOTACOMMAND 1 2 3\n')), /line 2/);
});

check('the rows export has a line for each cell with something in it', () => {
  const s = openSession(modules[files[0]]);
  const csv = text(rethrow(() => s.exportRows())).split('\r\n');
  assert.equal(csv[0], 'ID,TRACK,CHANNEL,PATTERN,ROW,NOTE,OCTAVE,INST,VOLUME,FX1,FX1PARAM,FX2,FX2PARAM,FX3,FX3PARAM,FX4,FX4PARAM');
  assert.equal(csv.at(-1), '');
  // the same cells, read from the patterns
  const expected = [];
  const info = s.info();
  for (let t = 0; t < info.tracks.length; ++t) {
    const patterns = s.patterns(t).sort((a, b) => a.channel - b.channel || a.pattern - b.pattern);
    for (const { channel, pattern, data } of patterns)
      for (let r = 0; r < data.length / CELL; ++r) {
        const c = data.subarray(r * CELL, r * CELL + CELL);
        if (c[0] === NONE && c[2] === MAX_VOLUME && c[3] === NO_INSTRUMENT && [4, 5, 6, 7].every(i => c[i] === EF_NONE))
          continue;
        expected.push([expected.length, t, channel, pattern, r, c[0], c[1], c[3], c[2], c[4], c[8], c[5], c[9], c[6], c[10], c[7], c[11]].join(','));
      }
  }
  assert.deepEqual(csv.slice(1, -1), expected);
  s.delete();
});

check('the JSON export describes the module', () => {
  const s = openSession(modules[files[0]]);
  const info = s.info();
  const json = JSON.parse(new TextDecoder().decode(rethrow(() => s.exportJSON())));
  assert.equal(json.metadata.title, info.title);
  assert.equal(json.metadata.artist, info.artist);
  assert.equal(json.songs.length, info.tracks.length);
  s.delete();
});

// ---- NSF and friends -------------------------------------------------------------------------

const u16 = (b, at) => b[at] | b[at + 1] << 8;
const cstr = (b, at, n) => text(b.subarray(at, at + n)).replace(/\0.*$/s, '');

check('NSF: the header tells the songs, the titles and the chips', () => {
  for (const file of files) {
    const s = openSession(modules[file]);
    const info = s.info();
    const r = rethrow(() => s.exportNSF('nsf', 0, false));
    assert.equal(r.files.length, 1, `${file}: ${r.log}`);
    const nsf = r.files[0].data;
    assert.equal(r.files[0].name, 'music.nsf');
    assert.equal(text(nsf.subarray(0, 5)), 'NESM\x1a');
    assert.equal(nsf[5], 1);                    // version
    assert.equal(nsf[6], info.tracks.length);   // songs
    assert.equal(cstr(nsf, 0x0e, 32), info.title.slice(0, 31));
    assert.equal(nsf[0x7b], info.chips);        // expansion chips
    assert.match(r.log, /Done, total file size: \d+ bytes/);
    s.delete();
  }
});

check('NSFe and NSF2 have their own headers', () => {
  const s = openSession(modules[files[0]]);
  const nsfe = rethrow(() => s.exportNSF('nsfe', 0, false)).files[0];
  assert.equal(nsfe.name, 'music.nsfe');
  assert.equal(text(nsfe.data.subarray(0, 4)), 'NSFE');
  assert.ok(text(nsfe.data).includes('NEND'));
  const nsf2 = rethrow(() => s.exportNSF('nsf2', 0, false)).files[0];
  assert.equal(nsf2.name, 'music.nsf');
  assert.equal(text(nsf2.data.subarray(0, 5)), 'NESM\x1a');
  assert.equal(nsf2.data[5], 2);
  s.delete();
});

check('PAL and dual NSF set the region flags', () => {
  const s = smallSession();
  const flags = machine => s.exportNSF('nsf', machine, false).files[0].data[0x7a] & 3;
  assert.equal(flags(0), 0);
  assert.equal(flags(1), 1);
  assert.equal(flags(2), 2);
  s.delete();
});

check('NES and PRG images are 32 kB of program', () => {
  const s = smallSession();
  const nes = rethrow(() => s.exportNSF('nes', 0, false));
  assert.equal(nes.files.length, 1, nes.log);
  assert.equal(text(nes.files[0].data.subarray(0, 4)), 'NES\x1a');
  assert.equal(nes.files[0].data.length, 16 + 0x8000);
  const prg = rethrow(() => s.exportNSF('prg', 0, false));
  assert.equal(prg.files[0].data.length, 0x8000);
  // the same program behind the header
  assert.ok(equal(nes.files[0].data.subarray(16), prg.files[0].data));
  s.delete();
});

check('NES export refuses expansion chips, and says so', () => {
  const file = files.find(f => openSession(modules[f]).info().chips);
  const s = openSession(modules[file]);
  const r = rethrow(() => s.exportNSF('nes', 0, false));
  assert.equal(r.files.length, 0);
  assert.match(r.messages, /not supported/);
  s.delete();
});

check('BIN writes the music and the samples, with the extra files when asked', () => {
  const s = smallSession();
  const plain = rethrow(() => s.exportNSF('bin', 0, false));
  assert.deepEqual(plain.files.map(f => f.name), ['music.bin', 'samples.bin']);
  const extra = rethrow(() => s.exportNSF('bin', 0, true));
  assert.deepEqual(extra.files.map(f => f.name).sort(),
    ['enable_ext.s', 'music.bin', 'nsf.cfg', 'nsf_header.s', 'nsf_stub.s', 'periods.s', 'samples.bin', 'update_ext.s', 'vibrato.s']);
  assert.ok(equal(extra.files[0].data, plain.files[0].data));
  s.delete();
});

check('ASM writes the music as source, with the extra files when asked', () => {
  const s = smallSession();
  const plain = rethrow(() => s.exportNSF('asm', 0, false));
  assert.deepEqual(plain.files.map(f => f.name), ['music.asm']);
  assert.match(text(plain.files[0].data), /ft_song_list:/);
  const extra = rethrow(() => s.exportNSF('asm', 0, true));
  assert.equal(extra.files[0].name, 'music.asm');
  const stub = extra.files.find(f => f.name === 'nsf_stub.s');
  assert.match(text(stub.data), /\.include "music\.asm"/);
  s.delete();
});

check('an unknown kind is refused', () => {
  const s = smallSession();
  assert.throws(() => rethrow(() => s.exportNSF('xyz', 0, false)), /no export format/);
  s.delete();
});

// ---- wave --------------------------------------------------------------------------------------

for (const file of files.slice(0, 2)) {
  check(`${file}: the wave export is the player's audio, with five silent ticks before and after`, () => {
    const s = openSession(modules[file]);
    const exported = wave(s, 0, 1);
    assert.ok(equal(wave(s, 0, 1), exported), 'a second export differs');
    // the player plays one pass too, without the ticks around it, and ends in the
    // silence of its last chunk
    const played = play(modules[file], 0);
    const tick = WAVE_RATE / s.info().frameRate;
    let lead = -1;
    for (let shift = Math.floor(4 * tick); shift <= Math.ceil(6 * tick) && lead < 0; ++shift)
      if (equal(exported.subarray(shift, shift + played.length - CHUNK), played.subarray(0, played.length - CHUNK)))
        lead = shift;
    assert.ok(lead >= 0, 'the audio differs from the player\'s');
    assert.ok(energy(exported.subarray(0, lead)) < 1, 'the lead-in is not silent');
    const tail = exported.length - lead - (played.length - CHUNK);
    assert.ok(tail > 0 && tail < CHUNK + 6 * tick, `${tail} samples after the song`);
    s.delete();
  });
}

check('the wave export plays for the time asked, silent channels muted', () => {
  const s = openSession(modules[files[0]]);
  const info = s.info();
  const tick = WAVE_RATE / info.frameRate;
  const timed = wave(s, 0, 0, 3);
  // three seconds of ticks, and the five before and after
  assert.ok(Math.abs(timed.length - (3 * info.frameRate + 11) * tick) <= 2 * tick, `length ${timed.length}`);
  const all = 2 ** info.channels.length - 1;
  assert.ok(energy(wave(s, 0, 0, 3, all)) < 1, 'muting every channel leaves sound');
  // at another rate
  const at48 = wave(s, 0, 0, 3, 0, 48000);
  assert.ok(Math.abs(at48.length / 48000 - timed.length / WAVE_RATE) < 0.02);
  s.delete();
});

check('the session is silent while it exports, and plays again after', () => {
  const s = dnft.createSession(RATE);
  s.beginWave(0, 1, 0, 0, WAVE_RATE);
  s.noteOn(0, NOTE_C, 4, 0, 16);
  assert.ok(energy(renderSession(s, 4800)) < 1, 'the session sounds during the export');
  s.renderWave(1000);
  s.endWave();
  s.noteOn(0, NOTE_C, 4, 0, 16);
  assert.ok(energy(renderSession(s, 9600)) > 1000, 'no sound after the export');
  // an export left halfway is abandoned
  s.beginWave(0, 1, 0, 0, WAVE_RATE);
  s.renderWave(1000);
  s.endWave();
  assert.throws(() => rethrow(() => s.renderWave(1000)), /interrupted/);
  s.delete();
});

check('a song that halts ends the export of a longer time', () => {
  const s = dnft.createSession(RATE);
  s.setCells(0, 0, 0, 0, new Uint8Array(cell(NOTE_C, 4)));
  s.setCells(0, 0, 0, 4, new Uint8Array([NONE, 0, MAX_VOLUME, NO_INSTRUMENT, EF_HALT, 0, 0, 0, 0, 0, 0, 0]));
  const out = wave(s, 0, 0, 60);
  assert.ok(out.length < WAVE_RATE * 2, `rendered ${out.length / WAVE_RATE} s`);
  s.delete();
});

// ---- module import -------------------------------------------------------------------------------

check('importing a module adds its tracks, which play as they did there', () => {
  // two 2A03 modules
  const [target, source] = files.filter(f => !openSession(modules[f]).info().chips);
  const sourceSession = openSession(modules[source]);
  const sourceInfo = sourceSession.info();
  const sourceInstruments = sourceSession.instruments().length;
  const sourceSound = wave(sourceSession, 0, 0, 10);
  sourceSession.delete();

  const s = openSession(modules[target]);
  const before = s.info();
  const instrumentsBefore = s.instruments().length;
  const description = withHeap(modules[source], (at, size) => rethrow(() => s.beginImport(at, size)));
  assert.deepEqual(description.tracks, sourceInfo.tracks);
  assert.equal(description.instruments, sourceInstruments);
  const result = rethrow(() => s.finishImport(description.tracks.map(() => true), true, true, false));
  assert.equal(result.imported, true, result.messages);
  assert.equal(s.info().tracks.length, before.tracks.length + description.tracks.length);
  assert.equal(s.instruments().length, instrumentsBefore + description.instruments);
  // what the module's settings do stays the same
  if (['engineSpeed', 'newVibrato', 'linearPitch', 'speedSplitPoint'].every(k => before[k] === sourceInfo[k]))
    assert.ok(equal(wave(s, before.tracks.length, 0, 10), sourceSound), 'the imported track sounds different');
  s.delete();
});

check('importing a module with other chips gives both the chips of either', () => {
  const target = files.find(f => !openSession(modules[f]).info().chips);
  const source = files.find(f => openSession(modules[f]).info().chips);
  const s = openSession(modules[target]);
  const description = withHeap(modules[source], (at, size) => s.beginImport(at, size));
  const result = s.finishImport([true], false, false, false);
  assert.equal(result.imported, true, result.messages);
  assert.equal(s.info().chips, description.chips);
  s.delete();
});

check('an import can be called off', () => {
  const s = openSession(modules[files[0]]);
  const before = s.save();
  withHeap(modules[files[1]], (at, size) => s.beginImport(at, size));
  s.cancelImport();
  assert.throws(() => rethrow(() => s.finishImport([true], true, true, false)), /no module/);
  assert.ok(equal(s.save(), before));
  s.delete();
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exitCode = failures ? 1 : 0;

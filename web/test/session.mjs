// Checks editing sessions: the document interface, playback of what was edited, notes
// played by hand, and saving.
//
//   node test/session.mjs

import createDnFT from '../dist/dnft.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.join(here, '..', '..', 'demo');
const RATE = 48000;
const CHUNK = 1024;

// The tracker's values (FamiTrackerTypes.h, APU/Types.h, Instrument.h)
const NOTE_C = 1, NOTE_E = 5, NOTE_G = 8, HALT = 14;
const EF_JUMP = 2, EF_HALT = 4;
const INST_2A03 = 1;
const SEQ_VOLUME = 0;
const SNDCHIP_VRC6 = 1, SNDCHIP_VRC7 = 2;
const EMPTY = [0, 0, 16, 64, 0, 0, 0, 0, 0, 0, 0, 0];

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

const rethrow = fn => {
  try {
    return fn();
  } catch (e) {
    throw new Error(dnft.getExceptionMessage(e).at(-1));
  }
};
const openSession = bytes => withHeap(bytes, (at, size) => rethrow(() => dnft.openSession(at, size, RATE)));
const load = bytes => withHeap(bytes, (at, size) => rethrow(() => dnft.load(at, size, '')));

// Renders `ms` of audio from a session or a player and returns the left channel.
function render(source, ms) {
  const frames = Math.round(ms * RATE / 1000);
  const out = new Int16Array(frames);
  for (let done = 0; done < frames; done += CHUNK) {
    source.render(heap, CHUNK);
    const pcm = dnft.HEAP16.subarray(heap >> 1, (heap >> 1) + CHUNK * 2);
    for (let i = 0; i < CHUNK && done + i < frames; ++i)
      out[done + i] = pcm[2 * i];
  }
  return out;
}

const energy = pcm => pcm.reduce((sum, s) => sum + s * s, 0) / pcm.length;
const equal = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);
const cell = (note, octave, instrument = 0, effects = []) => {
  const c = [note, octave, 16, instrument, 0, 0, 0, 0, 0, 0, 0, 0];
  effects.forEach(([number, param], i) => { c[4 + i] = number; c[8 + i] = param; });
  return c;
};

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

check('a new module is the one the desktop tracker makes', () => {
  const s = dnft.createSession(RATE);
  const info = s.info();
  assert.deepEqual(info.channels.map(c => c.shortName), ['PU1', 'PU2', 'TRI', 'NOI', 'DMC']);
  assert.deepEqual(info.tracks, ['New song']);
  assert.equal(info.chips, 0);
  assert.equal(info.pal, false);
  const t = s.track(0);
  assert.equal(t.frames, 1);
  assert.equal(t.rows, 64);
  assert.equal(t.speed, 6);
  assert.equal(t.tempo, 150);
  assert.deepEqual([...t.effColumns], [1, 1, 1, 1, 1]);
  assert.deepEqual([...t.frameList], [0, 0, 0, 0, 0]);
  assert.deepEqual(s.instruments().map(i => [i.index, i.type]), [[0, INST_2A03]]);
  assert.deepEqual([...s.pattern(0, 0, 0).subarray(0, 12)], EMPTY);
  assert.equal(s.patterns(0).length, 0);
  s.delete();
});

check('it is silent until a note is played by hand, which a cut stops', () => {
  const s = dnft.createSession(RATE);
  assert.ok(energy(render(s, 500)) < 1, 'idle output sounds');
  s.noteOn(0, NOTE_C, 4, 0, 16);
  assert.ok(energy(render(s, 300)) > 1000, 'the note is silent');
  s.noteOff(0, false);
  const after = render(s, 1000);
  assert.ok(energy(after.subarray(RATE / 2)) < 10, `still sounds: ${energy(after.subarray(RATE / 2))}`);
  s.delete();
});

check('edited patterns play, and each row is reported where its audio begins', () => {
  const s = dnft.createSession(RATE);
  s.setCells(0, 0, 0, 0, new Uint8Array([...cell(NOTE_C, 4), ...EMPTY, ...EMPTY, ...EMPTY, ...cell(NOTE_E, 4)]));
  s.setCells(0, 1, 0, 8, new Uint8Array(cell(NOTE_G, 3)));
  assert.deepEqual([...s.pattern(0, 0, 0).subarray(48, 60)], cell(NOTE_E, 4));
  assert.deepEqual(s.patterns(0).map(p => [p.channel, p.pattern]), [[0, 0], [1, 0]]);
  assert.ok(s.isModified());

  s.play(0, dnft.PLAY_SONG, 0, 0);
  assert.equal(s.state().playing, true);
  const pcm = render(s, 1000);
  assert.ok(energy(pcm) > 1000, 'silent');
  const rows = s.takeRowEvents();
  assert.ok(rows.length >= 9, `${rows.length} rows`);
  rows.forEach((e, i) => {
    assert.equal(e.frame, 0);
    assert.equal(e.row, i);
  });
  assert.equal(rows[0].at, 0);
  // speed 6 at 60 ticks a second: a row every 0.1 s
  const spacing = (rows[8].at - rows[0].at) / 8;
  assert.ok(Math.abs(spacing - RATE / 10) < RATE / 200, `rows every ${spacing} frames`);
  s.delete();
});

check('play modes start where they should, and stopping is reported', () => {
  const s = dnft.createSession(RATE);
  s.setFrameCount(0, 3);
  s.play(0, dnft.PLAY_CURSOR, 1, 10);
  render(s, 50);
  assert.deepEqual(s.takeRowEvents().map(e => [e.frame, e.row]), [[1, 10]]);
  s.play(0, dnft.PLAY_FRAME, 2, 10);
  render(s, 50);
  assert.deepEqual(s.takeRowEvents().map(e => [e.frame, e.row]), [[2, 0]]);

  s.setPatternLength(0, 4);
  s.play(0, dnft.PLAY_PATTERN, 1, 0);
  render(s, 1000);
  const looped = s.takeRowEvents().map(e => [e.frame, e.row]);
  assert.deepEqual(looped.slice(0, 6), [[1, 0], [1, 1], [1, 2], [1, 3], [1, 0], [1, 1]]);

  const before = s.position();
  s.stop();
  assert.equal(s.state().playing, false);
  const stopped = s.takeRowEvents();
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].frame, -1);
  // after what was rendered already, which is less than a tick
  assert.ok(stopped[0].at >= before && stopped[0].at < before + RATE / 60, `${stopped[0].at} after ${before}`);
  s.delete();
});

check('a Cxx row halts playback, and the halt is reported', () => {
  const s = dnft.createSession(RATE);
  s.setCells(0, 0, 0, 0, new Uint8Array(cell(NOTE_C, 4)));
  s.setCells(0, 0, 0, 3, new Uint8Array(cell(0, 0, 64, [[EF_HALT, 0]])));
  s.play(0, dnft.PLAY_SONG, 0, 0);
  render(s, 1000);
  const events = s.takeRowEvents();
  assert.deepEqual(events.map(e => [e.frame, e.row]), [[0, 0], [0, 1], [0, 2], [0, 3], [-1, -1]]);
  // the Cxx row lasts as long as the others
  assert.ok(Math.abs(events[4].at - events[3].at - RATE / 10) < RATE / 60, `${events[4].at - events[3].at}`);
  assert.equal(s.state().playing, false);
  s.delete();
});

check('an instrument volume sequence shapes the note', () => {
  const s = dnft.createSession(RATE);
  const lead = s.addInstrument(0, 'Lead');
  assert.equal(lead, 1);
  const index = s.freeSequence(INST_2A03, SEQ_VOLUME);
  assert.ok(index >= 0);
  s.setSequence(INST_2A03, SEQ_VOLUME, index, new Int8Array([15, 12, 8, 4, 0]), -1, -1, 0);
  s.setInstrumentSequence(lead, SEQ_VOLUME, true, index);
  assert.deepEqual(s.instrument(lead).sequences[SEQ_VOLUME], { enabled: true, index });
  const seq = s.sequence(INST_2A03, SEQ_VOLUME, index);
  assert.deepEqual([...seq.items], [15, 12, 8, 4, 0]);
  assert.equal(seq.loop, -1);
  // the desktop names new instruments with an empty string (CFamiTrackerDoc::NEW_INST_NAME)
  assert.deepEqual(s.instruments().map(i => i.name), ['', 'Lead']);

  s.noteOn(0, NOTE_C, 4, lead, 16);
  const decayed = render(s, 400);
  s.noteOn(0, NOTE_C, 4, 0, 16);
  const held = render(s, 400);
  const tail = pcm => energy(pcm.subarray(RATE / 5));
  assert.ok(tail(decayed) < tail(held) / 100, `decayed ${tail(decayed)}, held ${tail(held)}`);
  s.delete();
});

check('muting cuts what a channel plays', () => {
  const s = dnft.createSession(RATE);
  s.noteOn(0, NOTE_C, 4, 0, 16);
  render(s, 200);
  s.setMutedChannels(1);
  const pcm = render(s, 1000);
  assert.ok(energy(pcm.subarray(RATE / 2)) < 10);
  s.delete();
});

check('frames: insert, duplicate, clone, move, remove', () => {
  const s = dnft.createSession(RATE);
  const frames = () => {
    const t = s.track(0);
    return Array.from({ length: t.frames }, (_, f) => [...t.frameList.subarray(f * 5, f * 5 + 5)]);
  };
  s.setCells(0, 0, 0, 0, new Uint8Array(cell(NOTE_C, 4)));
  assert.ok(s.insertFrame(0, 1));
  assert.deepEqual(frames(), [[0, 0, 0, 0, 0], [1, 1, 1, 1, 1]]);
  assert.ok(s.duplicateFrame(0, 0));
  assert.deepEqual(frames(), [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [1, 1, 1, 1, 1]]);
  assert.ok(s.cloneFrame(0, 0));
  const cloned = frames()[1];
  assert.equal(frames().length, 4);
  assert.notEqual(cloned[0], 0);
  assert.deepEqual([...s.pattern(0, 0, cloned[0]).subarray(0, 12)], cell(NOTE_C, 4));
  assert.ok(s.moveFrame(0, 3, true));
  assert.deepEqual(frames()[2], [1, 1, 1, 1, 1]);
  assert.ok(s.removeFrame(0, 2));
  assert.equal(frames().length, 3);
  s.setFramePattern(0, 2, 4, 7);
  assert.equal(frames()[2][4], 7);
  assert.equal(s.moveFrame(0, 0, true), false);
  // what undoing a frame operation does: the whole list back
  s.setFrameList(0, 2, new Uint8Array([3, 3, 3, 3, 3, 4, 4, 4, 4, 4]));
  assert.deepEqual(frames(), [[3, 3, 3, 3, 3], [4, 4, 4, 4, 4]]);
  assert.throws(() => rethrow(() => s.setFramePattern(0, 9, 0, 0)), /no frame 9/);
  assert.throws(() => rethrow(() => s.pattern(0, 5, 0)), /no channel 5/);
  s.delete();
});

check('bookmarks: kept with the frames, saved, and never where the track does not reach', () => {
  const s = dnft.createSession(RATE);
  s.setFrameCount(0, 4);
  const mark = (frame, row, name = 'B', highlight = [-1, -1], persist = false) => ({ frame, row, name, highlight, persist });
  s.setBookmarks(0, [mark(1, 4, 'イントロ', [3, -1], true), mark(3, 60), mark(9, 0), mark(0, 64)]);
  // the last two are past the track
  assert.deepEqual(s.bookmarks(0), [mark(1, 4, 'イントロ', [3, -1], true), mark(3, 60)]);
  assert.deepEqual(s.track(0).bookmarks, s.bookmarks(0));
  // they move with the frames
  s.insertFrame(0, 0);
  assert.deepEqual(s.bookmarks(0).map(m => [m.frame, m.row]), [[2, 4], [4, 60]]);
  s.moveFrame(0, 2, true);
  assert.deepEqual(s.bookmarks(0).map(m => [m.frame, m.row]), [[1, 4], [4, 60]]);
  // fewer rows: the desktop keeps the one on row 60, and then cannot open the file
  s.setPatternLength(0, 32);
  assert.deepEqual(s.bookmarks(0).map(m => [m.frame, m.row]), [[1, 4]]);
  const bytes = s.save();
  const t = openSession(bytes);
  assert.deepEqual(t.bookmarks(0), [mark(1, 4, 'イントロ', [3, -1], true)]);
  assert.match(new TextDecoder().decode(t.exportText()), /BOOKMARK 01 04 +3 +-1 +1 "/);
  t.delete();
  // Clear Patterns leaves one frame, and its bookmarks
  s.setBookmarks(0, [mark(0, 2), mark(1, 4)]);
  s.clearPatterns(0);
  assert.deepEqual(s.bookmarks(0).map(m => [m.frame, m.row]), [[0, 2]]);
  assert.throws(() => rethrow(() => s.bookmarks(3)), /no track 3/);
  s.delete();
});

check('swap channels: patterns, frames and effect columns', () => {
  const s = dnft.createSession(RATE);
  s.insertFrame(0, 1);
  s.setCells(0, 0, 0, 0, new Uint8Array(cell(NOTE_C, 4)));
  s.setCells(0, 1, 1, 0, new Uint8Array(cell(NOTE_E, 3)));
  s.setFramePattern(0, 0, 1, 1);
  s.setEffColumns(0, 1, 3);
  s.swapChannels(0, 0, 1);
  const t = s.track(0);
  assert.deepEqual([...t.frameList.subarray(0, 2)], [1, 0]);
  assert.deepEqual(t.effColumns.slice(0, 2), [3, 1]);
  assert.deepEqual([...s.pattern(0, 1, 0).subarray(0, 12)], cell(NOTE_C, 4));
  assert.deepEqual([...s.pattern(0, 0, 1).subarray(0, 12)], cell(NOTE_E, 3));
  // twice is as it was
  s.swapChannels(0, 0, 1);
  assert.deepEqual([...s.track(0).frameList.subarray(0, 2)], [0, 1]);
  assert.deepEqual([...s.pattern(0, 0, 0).subarray(0, 12)], cell(NOTE_C, 4));
  assert.throws(() => rethrow(() => s.swapChannels(0, 0, 5)), /no channel 5/);
  s.delete();
});

check('the frame editor: frames inserted and deleted with their bookmarks, blocks of patterns', () => {
  const s = dnft.createSession(RATE);
  const list = () => [...s.track(0).frameList];
  s.setFrameCount(0, 3);
  s.setFramePatterns(0, 0, 0, 5, new Uint8Array(Array.from({ length: 15 }, (_, i) => i + 1)));
  // what is past the frames or the channels is left out
  s.setFramePatterns(0, 2, 3, 3, new Uint8Array([20, 21, 22, 23, 24, 25]));
  assert.deepEqual(list(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 20, 21]);
  const mark = { frame: 1, row: 0, name: 'B', highlight: [-1, -1], persist: false };
  s.setBookmarks(0, [mark]);
  // frames of pattern 0, the bookmark moves down with the frame
  assert.ok(s.insertFrames(0, 1, 2));
  assert.deepEqual(list(), [1, 2, 3, 4, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 7, 8, 9, 10, 11, 12, 13, 20, 21]);
  assert.deepEqual(s.bookmarks(0).map(m => m.frame), [3]);
  assert.ok(s.insertFrames(0, 5, 1));
  assert.equal(s.track(0).frames, 6);
  assert.equal(s.insertFrames(0, 0, 251), false);
  assert.equal(s.track(0).frames, 6);
  assert.throws(() => rethrow(() => s.insertFrames(0, 7, 1)), /no frame 7/);
  assert.equal(s.deleteFrames(0, 1, 2), 2);
  assert.deepEqual(list(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 20, 21, 0, 0, 0, 0, 0]);
  assert.deepEqual(s.bookmarks(0).map(m => m.frame), [1]);
  // the bookmark goes with its frame, and one frame is always left: the last
  assert.equal(s.deleteFrames(0, 0, 10), 3);
  assert.deepEqual(list(), [0, 0, 0, 0, 0]);
  assert.deepEqual(s.bookmarks(0), []);
  s.delete();
});

check('the frame editor: clone patterns, one copy for each, and none without a free pattern', () => {
  const s = dnft.createSession(RATE);
  s.setFrameCount(0, 3);
  // PU1 plays 0, 0, 1 and PU2 plays 2 in the three frames
  s.setFramePatterns(0, 0, 0, 2, new Uint8Array([0, 2, 0, 2, 1, 2]));
  s.setCells(0, 0, 0, 0, new Uint8Array(cell(NOTE_C, 4)));
  s.setCells(0, 0, 1, 0, new Uint8Array(cell(NOTE_E, 4)));
  s.setCells(0, 1, 2, 0, new Uint8Array(cell(NOTE_G, 3)));
  assert.equal(s.clonePatterns(0, 2, 0, 1, 0), 0);
  const t = s.track(0);
  assert.deepEqual([0, 1, 2].map(f => [...t.frameList.subarray(f * 5, f * 5 + 2)]), [[2, 0], [2, 0], [3, 0]]);
  assert.deepEqual([...s.pattern(0, 0, 2).subarray(0, 12)], cell(NOTE_C, 4));
  assert.deepEqual([...s.pattern(0, 0, 3).subarray(0, 12)], cell(NOTE_E, 4));
  assert.deepEqual([...s.pattern(0, 1, 0).subarray(0, 12)], cell(NOTE_G, 3));
  // the originals stay
  assert.deepEqual([...s.pattern(0, 0, 0).subarray(0, 12)], cell(NOTE_C, 4));
  // every pattern of the triangle used: its frames keep theirs
  for (let p = 0; p < 256; ++p)
    s.setCells(0, 2, p, 0, new Uint8Array(cell(NOTE_C, 3)));
  assert.equal(s.clonePatterns(0, 0, 2, 1, 2), 1);
  assert.deepEqual([0, 1, 2].map(f => [...s.track(0).frameList.subarray(f * 5 + 1, f * 5 + 3)]), [[1, 0], [1, 0], [1, 0]]);
  s.delete();
});

check('Song > Transpose Song: every pattern and row, not noise, DPCM or what is excluded', () => {
  const NOTE_D = 3, NOTE_B = 12, NONE = 64;
  const s = dnft.createSession(RATE);
  s.setPatternLength(0, 16);
  s.setCells(0, 0, 0, 0, new Uint8Array([
    ...cell(NOTE_C, 4, 0), ...cell(NOTE_E, 4, 1), ...cell(NOTE_B, 7, 0), ...cell(HALT, 0, NONE), ...cell(NOTE_C, 4, NONE),
  ]));
  // a pattern no frame plays, and a row past the pattern length
  s.setCells(0, 0, 9, 0, new Uint8Array(cell(NOTE_D, 3)));
  s.setCells(0, 0, 0, 20, new Uint8Array(cell(NOTE_G, 2)));
  s.setCells(0, 3, 0, 0, new Uint8Array(cell(NOTE_C, 4)));
  s.setCells(0, 4, 0, 0, new Uint8Array(cell(NOTE_C, 4)));
  const used = () => s.patterns(0).map(p => `${p.channel}:${p.pattern}`);
  const before = used();
  const rows = (channel, pattern, count) => Array.from({ length: count }, (_, r) => [...s.pattern(0, channel, pattern).subarray(r * 12, r * 12 + 4)]);
  const original = rows(0, 0, 5);
  assert.equal(s.transposeSong(0, false, 0, new Uint8Array()).length, 0);
  const changes = s.transposeSong(0, false, 2, new Uint8Array([1]));
  // B-7 cannot go up, instrument 01 is excluded, the note cut is no note
  assert.equal(changes.length, 4 * 8);
  assert.deepEqual(rows(0, 0, 5), [[NOTE_D, 4, 16, 0], [NOTE_E, 4, 16, 1], [NOTE_B, 7, 16, 0], [HALT, 0, 16, NONE], [NOTE_D, 4, 16, NONE]]);
  assert.deepEqual(rows(0, 9, 1), [[NOTE_E, 3, 16, 0]]);
  assert.deepEqual(rows(3, 0, 1), [[NOTE_C, 4, 16, 0]]);
  assert.deepEqual(rows(4, 0, 1), [[NOTE_C, 4, 16, 0]]);
  // no empty pattern was touched
  assert.deepEqual(used(), before);
  s.setPatternLength(0, 64);
  assert.deepEqual([...s.pattern(0, 0, 0).subarray(20 * 12, 20 * 12 + 2)], [10, 2]);
  // undo and redo
  s.setNotes(changes, false);
  assert.deepEqual(rows(0, 0, 5), original);
  assert.deepEqual([...s.pattern(0, 0, 0).subarray(20 * 12, 20 * 12 + 2)], [NOTE_G, 2]);
  s.setNotes(changes, true);
  assert.deepEqual(rows(0, 9, 1), [[NOTE_E, 3, 16, 0]]);
  // down to C-0 and no lower, in every track
  s.addTrack();
  s.setCells(1, 1, 0, 0, new Uint8Array(cell(NOTE_E, 1)));
  assert.equal(s.transposeSong(1, true, -24, new Uint8Array()).length, 7 * 8);
  assert.deepEqual([...s.pattern(1, 1, 0).subarray(0, 2)], [NOTE_C, 0]);
  assert.deepEqual(rows(0, 0, 1), [[NOTE_D, 2, 16, 0]]);
  s.delete();
  // with no notes to move, the module is as it was
  const fresh = dnft.createSession(RATE);
  assert.equal(fresh.isModified(), false);
  assert.equal(fresh.transposeSong(0, true, 5, new Uint8Array()).length, 0);
  assert.equal(fresh.isModified(), false);
  fresh.delete();
});

check('the volume meters: after each tick that changes one, and the decay rate', () => {
  const s = dnft.createSession(RATE);
  s.noteOn(0, 10, 4, 0, 16);
  render(s, 100);
  const events = s.takeLevelEvents();
  assert.ok(events.length >= 2, `${events.length} events`);
  // 15 channels' worth of nothing, then the note: 15 on the first pulse channel
  assert.deepEqual([...events.at(-1).levels], [15, 0, 0, 0, 0]);
  assert.ok(events.every((e, i) => i === 0 || e.at > events[i - 1].at), 'in order');
  assert.deepEqual(s.takeLevelEvents(), []);
  // a cut brings it down by the decay, slowly or quickly
  const decay = rate => {
    const t = dnft.createSession(RATE);
    t.setMeterDecayRate(rate);
    t.noteOn(0, 10, 4, 0, 16);
    render(t, 50);
    t.takeLevelEvents();
    t.noteOff(0, false);
    render(t, 1500);
    const levels = t.takeLevelEvents().map(e => e.levels[0]);
    t.delete();
    return levels;
  };
  // slowly: a bar a tick; quickly: at once
  const slow = decay(0), fast = decay(1);
  assert.equal(s.meterDecayRate(), 0);
  assert.ok(slow.length >= 10 && slow.every((v, i) => i === 0 || v === slow[i - 1] - 1), `${slow}`);
  assert.deepEqual(fast, [0]);
  assert.equal(slow.at(-1), 0);
  s.setMeterDecayRate(1);
  assert.equal(s.meterDecayRate(), 1);
  s.delete();
});

check('Tracker > Play Row plays the row with its effects, and Kill Sound silences everything', () => {
  const s = dnft.createSession(RATE);
  s.setCells(0, 0, 0, 3, new Uint8Array(cell(NOTE_C, 4)));
  s.setCells(0, 1, 0, 3, new Uint8Array(cell(NOTE_E, 4)));
  // an arpeggio on the second channel: the note changes as the ticks go
  s.setCells(0, 2, 0, 3, new Uint8Array(cell(NOTE_G, 3, 0, [[10, 0x47]])));
  s.playRow(0, 0, 3);
  render(s, 150);
  const levels = s.takeLevelEvents().at(-1).levels;
  assert.deepEqual([...levels].map(l => l > 0), [true, true, true, false, false]);
  assert.ok(!s.state().playing, 'the player does not run for a row');
  // the meters fall in their own time
  const silent = () => [...s.takeLevelEvents().at(-1).levels].every(l => l === 0);
  s.killSound();
  render(s, 1500);
  assert.ok(silent(), 'killed');
  // muted channels are left out
  s.setMutedChannels(2);
  s.playRow(0, 0, 3);
  render(s, 150);
  assert.deepEqual([...s.takeLevelEvents().at(-1).levels].map(l => l > 0), [true, false, true, false, false]);
  // what is out of range plays nothing
  s.killSound();
  render(s, 1500);
  s.takeLevelEvents();
  s.playRow(0, 5, 3);
  s.playRow(0, 0, 99);
  render(s, 100);
  assert.deepEqual(s.takeLevelEvents(), []);
  // Kill Sound stops the player too
  s.play(0, 0, 0, 0);
  render(s, 50);
  assert.ok(s.state().playing);
  s.killSound();
  assert.ok(!s.state().playing);
  s.delete();
});

check('a queued frame is where the player goes when the frame it plays is done', () => {
  const s = dnft.createSession(RATE);
  s.setPatternLength(0, 8);
  assert.ok(s.insertFrames(0, 1, 3));
  const frames = () => {
    const seen = [];
    for (const e of s.takeRowEvents())
      if (e.frame >= 0 && seen.at(-1) !== e.frame)
        seen.push(e.frame);
    return seen;
  };
  // a row is 6 ticks: 8 rows of a frame are 0.8 s
  s.play(0, 0, 0, 0);
  render(s, 3500);
  assert.deepEqual(frames(), [0, 1, 2, 3, 0], 'on its own, the frames in order');
  // queued: from frame 0 to 3, then on from there
  s.play(0, 0, 0, 0);
  assert.equal(s.queueFrame(), -1, 'starting drops what was queued');
  s.setQueueFrame(3);
  assert.equal(s.queueFrame(), 3);
  render(s, 2500);
  assert.deepEqual(frames(), [0, 3, 0, 1], 'frame 3 follows frame 0, then the song wraps');
  assert.equal(s.queueFrame(), -1, 'it was taken');
  // a frame the track does not have, and none while it does not play
  s.setQueueFrame(9);
  assert.equal(s.queueFrame(), -1);
  s.setQueueFrame(2);
  s.stop();
  assert.equal(s.queueFrame(), -1, 'stopping drops it');
  s.setQueueFrame(2);
  assert.equal(s.queueFrame(), -1, 'nothing to queue on when stopped');
  // the same frame again: the frame repeats
  s.play(0, 2, 2, 0);  // from the cursor
  s.setQueueFrame(2);
  render(s, 2200);
  const events = s.takeRowEvents();
  assert.equal(events.filter(e => e.frame === 2 && e.row === 0).length, 2, 'frame 2 starts twice');
  assert.deepEqual([...new Set(events.filter(e => e.frame >= 0).map(e => e.frame))], [2, 3]);
  s.delete();
});

check('the speed / tempo split point, the fixed tempo and Recall channel state', () => {
  const s = dnft.createSession(RATE);
  // Ctrl+Shift+S: 32, or 21 as old modules had it
  assert.equal(s.info().speedSplitPoint, 32);
  s.setSpeedSplitPoint(21);
  assert.equal(s.info().speedSplitPoint, 21);
  s.setSpeedSplitPoint(1);
  assert.equal(s.info().speedSplitPoint, 2, 'brought into the range');
  s.setSpeedSplitPoint(32);
  // the fixed tempo (0): the speed may then go up to 255; with a tempo it stops below the split point
  s.setSpeed(0, 100);
  assert.equal(s.track(0).speed, 31);
  s.setTempo(0, 0);
  assert.equal(s.track(0).tempo, 0);
  s.setSpeed(0, 100);
  assert.equal(s.track(0).speed, 100);
  s.setTempo(0, 150);
  assert.equal(s.track(0).tempo, 150);
  s.setSpeed(0, 6);
  // Recall channel state: what the channel has at the row (CSoundGen::RecallChannelState())
  s.setCells(0, 0, 0, 2, new Uint8Array(cell(NOTE_C, 4, 0, [[11, 0x47]])));
  s.setCells(0, 0, 0, 4, new Uint8Array(cell(0, 0, 64, [[1, 0x06]])));
  assert.equal(s.recallChannelState(0, 0, 0, 1), 'Inst.: None        Vol.: F        Active effects: None');
  assert.equal(s.recallChannelState(0, 0, 0, 10), 'Inst.: 00        Vol.: F        Active effects: 447        Speed: 6');
  assert.equal(s.recallChannelState(0, 99, 0, 0), '', 'no such channel');
  assert.equal(s.recallChannelState(5, 0, 0, 0), '', 'no such track');
  // and while it plays, what the channel plays now
  s.play(0, 0, 0, 0);
  render(s, 400);
  assert.equal(s.recallChannelState(0, 0, 0, 0), 'Inst.: 00        Vol.: F        Active effects: 447');
  s.delete();
});

check('the N163 setting is the desktop\'s "disable multiplexing"', () => {
  const s = dnft.createSession(RATE);
  const settings = s.soundSettings();
  assert.equal(settings.disableN163Multiplexing, true, 'multiplexing is off by default, as the desktop has it');
  assert.equal('n163Multiplexing' in settings, false);
  try {
    s.setSoundSettings({ disableN163Multiplexing: false });
    assert.equal(s.soundSettings().disableN163Multiplexing, false);
  } finally {
    s.setSoundSettings({ disableN163Multiplexing: true });
  }
  s.delete();
});

check('the register state and pitches of the chips', () => {
  const s = dnft.createSession(RATE);
  s.noteOn(0, 10, 4, 0, 16);
  render(s, 100);
  // the first pulse channel: duty 0, constant volume 15, period $07E
  const regs = s.registers(0, [0x4000, 0x4002, 0x4003, 0x4015, 0x9999, -1]);
  assert.equal(regs.length, 12);
  assert.equal(regs[0], 0x3F);
  assert.equal(regs[2], 0x7E);
  assert.equal(regs[4], 0x08);
  assert.deepEqual([...regs.subarray(8)], [0, 0, 0, 0], 'no such register, and a negative address');
  // a register written a moment ago is fresh, one that was not is not
  assert.ok((regs[1] & 15) < 15, `written ${regs[1] & 15} ticks ago`);
  const hz = s.channelFrequencies(0, 5);
  assert.ok(hz[0] > 870 && hz[0] < 890 && hz[1] === 0, `${hz}`);
  // a chip the module does not have gives nothing
  assert.deepEqual([...s.registers(16, [0, 1])], [0, 0, 0, 0]);
  assert.deepEqual(s.channelFrequencies(16, 2), []);
  s.setExpansion(16, 2);
  s.noteOn(5, 10, 3, 0, 16);
  render(s, 100);
  assert.ok(s.channelFrequencies(16, 8).some(f => f > 0));
  assert.ok(s.registers(16, [0x78]).length === 2);
  s.setExpansion(4, 1);
  assert.equal(typeof s.fdsModCounter(), 'number');
  s.delete();
});

check('Tracker > Record To Instrument: a playback becomes instruments, and the settings reset', () => {
  const s = dnft.createSession(RATE);
  s.setCells(0, 0, 0, 0, new Uint8Array(cell(NOTE_C, 4)));
  assert.deepEqual({ ...s.recorder() }, { channel: -1, interval: 252, count: 1, reset: true });
  // the DPCM cannot be recorded, a channel is chosen and taken back
  assert.equal(s.setRecordChannel(4), 'unsupported');
  assert.equal(s.setRecordChannel(0), '');
  assert.equal(s.recorder().channel, 0);
  assert.equal(s.setRecordChannel(0), '');
  assert.equal(s.recorder().channel, -1);
  assert.equal(s.setRecordChannel(0), '');
  s.setRecorderSettings(30, 2, true);
  assert.deepEqual({ ...s.recorder() }, { channel: 0, interval: 30, count: 2, reset: true });
  const instruments = s.instruments().length;
  s.play(0, 0, 0, 0);
  render(s, 1200);
  s.stop();
  render(s, 100);
  const slots = s.takeRecordedInstruments();
  assert.equal(slots.length, 2);
  assert.equal(s.instruments().length, instruments + 2);
  assert.deepEqual(s.takeRecordedInstruments(), []);
  // the first pulse channel plays C-4 at full volume: 30 steps of each sequence
  const volume = s.sequence(1, 0, s.instrument(slots[0]).sequences[0].index);
  assert.equal(volume.items.length, 30);
  assert.ok(volume.items.every(v => v === 15), `${volume.items}`);
  const arpeggio = s.sequence(1, 1, s.instrument(slots[0]).sequences[1].index);
  assert.ok(arpeggio.items.every(v => v === 48), 'fixed arpeggio on C-4');
  assert.equal(s.instrument(slots[0]).name, 'from Pulse 1');
  // the recording ended with the playback, and the settings went back
  assert.deepEqual({ ...s.recorder() }, { channel: -1, interval: 252, count: 1, reset: true });
  // out of range settings are brought in, and kept when asked to
  s.setRecorderSettings(0, 99, false);
  assert.deepEqual({ ...s.recorder() }, { channel: -1, interval: 1, count: 64, reset: false });
  s.setRecorderSettings(252, 1, true);
  s.delete();
});

check('the sound settings of the Configuration: kept, in range, and heard', () => {
  const s = dnft.createSession(RATE);
  const original = { ...s.soundSettings() };
  assert.equal(original.bassFilter, 30);
  assert.equal(original.trebleFilter, 12000);
  assert.equal(original.volume, 100);
  assert.equal(original.levels.length, 8);
  const heard = () => {
    const t = dnft.createSession(RATE);
    t.setCells(0, 0, 0, 0, new Uint8Array(cell(NOTE_C, 2)));
    t.play(0, 0, 0, 0);
    const pcm = render(t, 1500);
    t.delete();
    return pcm;
  };
  const before = heard();
  try {
    s.setSoundSettings({ bassFilter: 99999, volume: 50, levels: [-5, 999, 0, 0] });
    const changed = s.soundSettings();
    assert.equal(changed.bassFilter, 4000, 'brought into the range');
    assert.equal(changed.volume, 50);
    assert.deepEqual([...changed.levels].slice(0, 4), [-5, 120, 0, 0]);
    assert.equal(changed.trebleFilter, 12000, 'what was not given stays');
    // a bass filter at 4000 Hz takes a note of 65 Hz away
    assert.ok(energy(heard()) < energy(before) * 0.05, `${energy(heard())} against ${energy(before)}`);
    // half the volume is less than half the level (the engine's own scale)
    s.setSoundSettings({ bassFilter: 30, levels: [0, 0, 0, 0, 0, 0, 0, 0] });
    const quieter = heard();
    assert.ok(energy(quieter) < energy(before) * 0.5 && energy(quieter) > energy(before) * 0.05, `${energy(quieter)} against ${energy(before)}`);
    s.setSoundSettings({ volume: 100 });
    assert.ok(equal(heard(), before), 'back to the defaults, the same sound');
    s.setSoundSettings({ disableN163Multiplexing: false, vrc7Patch: 99, fdsLowpass: -4 });
    assert.deepEqual([s.soundSettings().disableN163Multiplexing, s.soundSettings().vrc7Patch, s.soundSettings().fdsLowpass], [false, 8, 0]);
  } finally {
    // they belong to the engine, not to the session
    s.setSoundSettings({ bassFilter: 30, trebleFilter: 12000, trebleDamping: 24, volume: 100, disableN163Multiplexing: true,
      vrc7Patch: 0, fdsLowpass: 2000, n163Lowpass: 12000, levels: [0, 0, 0, 0, 0, 0, 0, 0] });
  }
  s.delete();
});

check('the BPM of the player: the tempo, and the average of what was played', () => {
  const s = dnft.createSession(RATE);
  assert.equal(s.state().bpm, 150);
  s.setSpeed(0, 3);
  s.setTempo(0, 120);
  s.setCells(0, 0, 0, 2, new Uint8Array(cell(0, 0, 64, [[1, 8]])));     // F08: speed 8 from the third row on
  s.play(0, 0, 0, 0);
  render(s, 100);
  // speed 3 and tempo 120: 120 * 6 / 3 = 240
  assert.equal(s.state().bpm, 240);
  render(s, 900);
  assert.equal(s.state().bpm, 90);
  s.setAverageBpm(true);
  render(s, 50);
  const average = s.state().bpm;
  assert.ok(average > 90 && average < 240, `${average}`);
  s.setAverageBpm(false);
  s.delete();
});

check('song settings', () => {
  const s = dnft.createSession(RATE);
  s.setTitle('チップチューン ラボ の テスト曲です');
  s.setArtist('ZXTUNE LAB');
  s.setSpeed(0, 3);
  s.setTempo(0, 180);
  s.setPatternLength(0, 32);
  s.setEffColumns(0, 1, 3);
  s.setHighlight(0, 8, 32);
  const info = s.info();
  // 31 bytes at most, in code page 932 as the desktop keeps Japanese, cut where a
  // character ends
  assert.equal(info.title, 'チップチューン ラボ の テスト曲');
  assert.equal(info.artist, 'ZXTUNE LAB');
  const t = s.track(0);
  assert.deepEqual([t.speed, t.tempo, t.rows, t.effColumns[1], ...t.highlight], [3, 180, 32, 3, 8, 32]);
  assert.equal(s.pattern(0, 0, 0).length, 32 * 12);
  s.setTempo(0, 5);
  assert.equal(s.track(0).tempo, 32);
  s.delete();
});

check('module properties: comment, track title, engine speed, vibrato, pitch mode', () => {
  const s = dnft.createSession(RATE);
  s.setComment('Line one\nLine two\r\nLine three', true);
  s.setTrackTitle(0, 'Opening');
  s.setEngineSpeed(120);
  s.setVibratoStyle(false);
  s.setLinearPitch(true);
  const expect = info => {
    assert.equal(info.comment, 'Line one\nLine two\nLine three');
    assert.equal(info.showComment, true);
    assert.deepEqual(info.tracks, ['Opening']);
    assert.deepEqual([info.engineSpeed, info.frameRate, info.newVibrato, info.linearPitch], [120, 120, false, true]);
  };
  expect(s.info());
  const bytes = rethrow(() => s.save());
  s.delete();
  // the desktop's comment box breaks lines with CR LF
  assert.ok(new TextDecoder('latin1').decode(bytes).includes('Line one\r\nLine two\r\nLine three'));

  const again = openSession(bytes);
  expect(again.info());
  again.setEngineSpeed(0);
  assert.deepEqual([again.info().engineSpeed, again.info().frameRate], [0, 60]);
  again.setEngineSpeed(1000);
  assert.equal(again.info().engineSpeed, 400);
  again.delete();
});

check('the engine speed sets how fast instruments run', () => {
  const heard = hz => {
    const s = dnft.createSession(RATE);
    s.setEngineSpeed(hz);
    const blip = s.addInstrument(0, 'Blip');
    const index = s.freeSequence(INST_2A03, SEQ_VOLUME);
    s.setSequence(INST_2A03, SEQ_VOLUME, index, new Int8Array([...new Array(30).fill(15), 0]), -1, -1, 0);
    s.setInstrumentSequence(blip, SEQ_VOLUME, true, index);
    s.noteOn(0, NOTE_C, 4, blip, 16);
    const pcm = render(s, 500);
    s.delete();
    // 30 ticks: half a second at 60 Hz, a quarter at 120 Hz
    return energy(pcm.subarray(RATE * 0.3, RATE * 0.45));
  };
  assert.ok(heard(0) > 1000, 'silent at 60 Hz');
  assert.ok(heard(120) < 10, 'still sounds at 120 Hz');
});

check('a deep clone copies the sequences, a clone shares them', () => {
  const s = dnft.createSession(RATE);
  const index = s.freeSequence(INST_2A03, SEQ_VOLUME);
  s.setSequence(INST_2A03, SEQ_VOLUME, index, new Int8Array([15, 10, 5]), -1, -1, 0);
  s.setInstrumentSequence(0, SEQ_VOLUME, true, index);
  const shallow = s.cloneInstrument(0);
  const deep = s.deepCloneInstrument(0);
  assert.deepEqual(s.instrument(shallow).sequences[SEQ_VOLUME], { enabled: true, index });
  const copy = s.instrument(deep).sequences[SEQ_VOLUME];
  assert.equal(copy.enabled, true);
  assert.notEqual(copy.index, index);
  assert.deepEqual([...s.sequence(INST_2A03, SEQ_VOLUME, copy.index).items], [15, 10, 5]);
  s.delete();
});

check('an expansion chip adds its channels and keeps the patterns', () => {
  const s = dnft.createSession(RATE);
  s.setCells(0, 2, 0, 0, new Uint8Array(cell(NOTE_C, 3)));
  s.setExpansion(SNDCHIP_VRC6, 0);
  const info = s.info();
  assert.equal(info.chips, SNDCHIP_VRC6);
  assert.deepEqual(info.channels.map(c => c.shortName), ['PU1', 'PU2', 'TRI', 'NOI', 'DMC', 'V1', 'V2', 'SAW']);
  assert.deepEqual([...s.pattern(0, 2, 0).subarray(0, 12)], cell(NOTE_C, 3));
  s.noteOn(7, NOTE_C, 3, s.addInstrument(SNDCHIP_VRC6, 'Saw'), 16);
  assert.ok(energy(render(s, 300)) > 1000, 'the sawtooth is silent');
  s.delete();
});

check('the Song menu: populate unique patterns, estimate the length, clear patterns', () => {
  const s = dnft.createSession(RATE);
  s.setHighlight(0, 8, 32);
  s.setCells(0, 0, 0, 0, new Uint8Array(cell(NOTE_C, 4)));
  assert.ok(s.duplicateFrame(0, 0));
  s.populateUniquePatterns(0);
  const t = s.track(0);
  // each frame plays patterns of its own, copies of what it played
  assert.deepEqual([...t.frameList], [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  assert.deepEqual([...s.pattern(0, 0, 1).subarray(0, 12)], cell(NOTE_C, 4));
  assert.deepEqual(t.highlight, [8, 32]);

  // rows of 6 ticks at 60 Hz: a frame of 64 rows takes 6.4 s. The second frame jumps to
  // itself, so the first is the intro.
  s.setCells(0, 0, 1, 63, new Uint8Array(cell(0, 0, 64, [[EF_JUMP, 1]])));
  const length = s.songLength(0);
  assert.ok(Math.abs(length.intro - 6.4) < 0.01 && Math.abs(length.loop - 6.4) < 0.01, JSON.stringify(length));
  assert.equal(length.frameRate, 60);

  s.clearPatterns(0);
  assert.equal(s.track(0).frames, 1);
  assert.deepEqual(s.patterns(0), []);
  s.delete();
});

check('Module > Cleanup removes what nothing uses', () => {
  const s = dnft.createSession(RATE);
  s.setCells(0, 0, 0, 0, new Uint8Array(cell(NOTE_C, 4, 0)));
  const unused = s.addInstrument(0, 'Unused');
  // a pattern no frame plays
  s.setCells(0, 1, 5, 0, new Uint8Array(cell(NOTE_E, 4, 0)));
  assert.deepEqual(s.instruments().map(i => i.index), [0, unused]);
  s.removeUnusedInstruments();
  assert.deepEqual(s.instruments().map(i => i.index), [0]);
  assert.deepEqual(s.patterns(0).map(p => [p.channel, p.pattern]), [[0, 0], [1, 5]]);
  s.removeUnusedPatterns();
  assert.deepEqual(s.patterns(0).map(p => [p.channel, p.pattern]), [[0, 0]]);
  s.removeUnusedSamples();
  assert.deepEqual(s.instruments().map(i => i.index), [0]);
  s.delete();
});

check('tracks change places', () => {
  const s = dnft.createSession(RATE);
  s.addTrack();
  s.setTrackTitle(0, 'First');
  s.setTrackTitle(1, 'Second');
  s.setSpeed(1, 3);
  assert.equal(s.moveTrack(1, true), true);
  assert.deepEqual(s.info().tracks, ['Second', 'First']);
  assert.equal(s.track(0).speed, 3);
  assert.equal(s.moveTrack(0, true), false);
  assert.equal(s.moveTrack(1, false), false);
  assert.equal(s.moveTrack(0, false), true);
  assert.deepEqual(s.info().tracks, ['First', 'Second']);
  s.delete();
});

check('grooves: rows take the groove\'s ticks, and a groove that goes gives its tracks speed 6', () => {
  const s = dnft.createSession(RATE);
  assert.deepEqual(s.grooves(), new Array(32).fill(null));
  s.setGrooves([Uint8Array.of(4, 2)]);
  assert.deepEqual(s.grooves().map(g => g && [...g]), [[4, 2], ...new Array(31).fill(null)]);
  s.setGrooveMode(0, true);
  s.setSpeed(0, 0);
  assert.deepEqual([s.track(0).groove, s.track(0).speed], [true, 0]);
  // 4 and 2 ticks in turn, of about 800 frames at 60 Hz
  s.play(0, dnft.PLAY_SONG, 0, 0);
  render(s, 1000);
  const rows = s.takeRowEvents();
  assert.deepEqual(rows.slice(1, 7).map((e, i) => Math.round((e.at - rows[i].at) / (RATE / 60))), [4, 2, 4, 2, 4, 2]);
  s.stop();
  // 255 bytes of grooves at most: an entry each, and two more a groove
  assert.throws(() => rethrow(() => s.setGrooves([new Uint8Array(128).fill(6), new Uint8Array(126).fill(6)])), /255/);
  const bytes = rethrow(() => s.save());
  s.setGrooves([]);
  assert.deepEqual([s.track(0).groove, s.track(0).speed], [false, 6]);
  s.setGrooveMode(0, true);
  s.setSpeed(0, 40);
  assert.equal(s.track(0).speed, 31);
  s.setGrooveMode(0, false);
  assert.deepEqual([s.track(0).groove, s.track(0).speed], [false, 31]);
  s.delete();

  const again = openSession(bytes);
  assert.deepEqual([...again.grooves()[0]], [4, 2]);
  assert.deepEqual([again.track(0).groove, again.track(0).speed], [true, 0]);
  again.delete();
});

check('detune: the tables and the tuning change the pitch, and are saved', () => {
  const s = dnft.createSession(RATE);
  const d = s.detune();
  assert.equal(d.offsets.length, 6 * 96);
  assert.ok(d.offsets.every(v => v === 0));
  assert.deepEqual([d.semitone, d.cent], [0, 0]);
  const crossings = () => {
    s.noteOn(0, NOTE_C, 4, 0, 16);
    const pcm = render(s, 500).subarray(RATE / 10);
    let n = 0;
    for (let i = 1; i < pcm.length; ++i)
      if ((pcm[i - 1] < 0) !== (pcm[i] < 0))
        ++n;
    return n;
  };
  const before = crossings();
  // an octave up
  s.setDetune(new Int16Array(6 * 96), 12, 0);
  const after = crossings();
  assert.ok(Math.abs(after / before - 2) < 0.03, `${before} -> ${after}`);

  const offsets = new Int16Array(6 * 96);
  offsets[48] = 5;              // NTSC, C-4
  offsets[5 * 96 + 50] = -3;    // N163, D-4
  s.setDetune(offsets, 40, -300);
  const got = s.detune();
  assert.deepEqual([got.offsets[48], got.offsets[5 * 96 + 50], got.semitone, got.cent], [5, -3, 12, -100]);
  const again = openSession(rethrow(() => s.save()));
  const loaded = again.detune();
  assert.deepEqual([loaded.offsets[48], loaded.offsets[5 * 96 + 50], loaded.semitone, loaded.cent], [5, -3, 12, -100]);
  again.delete();
  s.delete();
});

check('mixing: the level of each device, and hardware-based mixing', () => {
  const s = dnft.createSession(RATE);
  assert.deepEqual(s.mixing(), { levels: [0, 0, 0, 0, 0, 0, 0, 0], hardwareMixing: false });
  const heard = () => {
    s.noteOn(0, NOTE_C, 4, 0, 16);
    return energy(render(s, 300).subarray(RATE / 10));
  };
  const loud = heard();
  // 12 dB less: a sixteenth of the energy
  s.setMixing([-120, 0, 0, 0, 0, 0, 0, 0], false);
  const quiet = heard();
  assert.ok(quiet / loud > 0.04 && quiet / loud < 0.1, `${loud} -> ${quiet}`);
  s.setMixing([500, -500, 0, 0, 0, 0, 0, 0], true);
  assert.deepEqual(s.mixing(), { levels: [120, -120, 0, 0, 0, 0, 0, 0], hardwareMixing: true });
  const again = openSession(rethrow(() => s.save()));
  assert.deepEqual(again.mixing(), { levels: [120, -120, 0, 0, 0, 0, 0, 0], hardwareMixing: true });
  again.delete();
  s.delete();
});

check('VRC7 patches: the module\'s own with an external OPLL, the default set without', () => {
  const s = dnft.createSession(RATE);
  s.setExpansion(SNDCHIP_VRC7, 0);
  const defaults = s.opll();
  assert.equal(defaults.external, false);
  assert.equal(defaults.patches.length, 19 * 8);
  assert.ok(defaults.patches.subarray(0, 8).every(b => b === 0));
  assert.ok(defaults.patches.subarray(8).some(b => b !== 0));
  assert.equal(defaults.names.length, 19);

  const patches = Uint8Array.from(defaults.patches);
  patches.set([0x01, 0x21, 0x00, 0x00, 0xF0, 0xF0, 0x0F, 0x0F], 8);
  const names = [...defaults.names];
  names[1] = 'ベル';
  s.setOpll(true, patches, names);
  const own = s.opll();
  assert.equal(own.external, true);
  assert.deepEqual([...own.patches], [...patches]);
  assert.equal(own.names[1], 'ベル');
  s.noteOn(5, NOTE_C, 4, s.addInstrument(SNDCHIP_VRC7, 'FM'), 16);
  assert.ok(energy(render(s, 300)) > 100, 'the VRC7 is silent');

  const again = openSession(rethrow(() => s.save()));
  assert.deepEqual([...again.opll().patches], [...patches]);
  assert.equal(again.opll().names[1], 'ベル');
  again.setOpll(false, patches, names);
  assert.deepEqual(again.opll(), defaults);
  again.delete();
  s.delete();
});

check('what is saved loads back, in the player too', () => {
  const s = dnft.createSession(RATE);
  s.setTitle('Saved');
  s.setCells(0, 0, 0, 0, new Uint8Array([...cell(NOTE_C, 4), ...cell(NOTE_E, 4)]));
  const bytes = rethrow(() => s.save());
  assert.equal(s.isModified(), false);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 21)), 'Dn-FamiTracker Module');
  s.delete();

  const again = openSession(bytes);
  assert.equal(again.info().title, 'Saved');
  assert.equal(again.info().type, 'DNM');
  assert.deepEqual([...again.pattern(0, 0, 0).subarray(0, 24)], [...cell(NOTE_C, 4), ...cell(NOTE_E, 4)]);
  again.delete();

  const track = load(bytes);
  assert.ok(energy(render(track.createPlayer(RATE), 1000)) > 1000);
  track.delete();
});

for (const file of files) {
  check(`${file}: saving changes nothing`, () => {
    const original = readFileSync(path.join(demoDir, file));
    const s = openSession(original);
    const tracks = s.info().tracks.length;
    const before = Array.from({ length: tracks }, (_, t) => [s.track(t), s.patterns(t)]);
    const saved = rethrow(() => s.save());
    s.delete();

    const reopened = openSession(saved);
    for (let t = 0; t < tracks; ++t) {
      const [track, patterns] = before[t];
      assert.deepEqual(reopened.track(t), track);
      assert.deepEqual(reopened.patterns(t), patterns);
    }
    reopened.delete();

    const a = load(original), b = load(saved);
    assert.ok(equal(render(a.createPlayer(RATE), 5000), render(b.createPlayer(RATE), 5000)), 'renders differ');
    a.delete();
    b.delete();
  });
}

check('the last session made is the one that sounds', () => {
  const first = dnft.createSession(RATE);
  const second = dnft.createSession(RATE);
  first.noteOn(0, NOTE_C, 4, 0, 16);
  assert.ok(energy(render(first, 300)) === 0);
  second.noteOn(0, NOTE_C, 4, 0, 16);
  assert.ok(energy(render(second, 300)) > 1000);
  first.delete();
  second.delete();
});

check('effect letters by chip', () => {
  const { letters, defaults, byChip } = dnft.effects();
  assert.equal(letters[EF_HALT], 'C');
  assert.equal(defaults[13], 0x80);    // Pxx starts in the middle
  assert.equal(defaults[EF_HALT], 0);
  assert.equal(byChip[0].F, 1);
  assert.equal(byChip[0].C, EF_HALT);
  assert.equal(byChip[4].H, 26);    // FDS modulation depth, where the 2A03 has sweep up
  assert.equal(byChip[0].H, 8);
});

dnft._free(heap);
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

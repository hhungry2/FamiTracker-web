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

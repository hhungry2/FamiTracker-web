// Checks the pattern editor's page code that works on cells, without a page: the
// selections, what Paste and Paste Special write, the Pattern menu, the values scrolled,
// transposition, Copy As, Find / Replace and the bookmarks, against what the desktop's
// code does (worked out by hand from CPatternEditor, CPatternAction, CFindDlg).
//
//   node test/pattern.mjs

import { strict as assert } from 'node:assert';
import {
  FIELD, PASTE, PASTE_AT, normalizeSelection, cursorSelection, selectionLength, repeatsRows, copyCells, clearCells, paste,
  insertRows, deleteRows, interpolate, reverse, replaceInstrument, stretch, parseStretchMap, stretchTest, invertStretchMap,
  scrollValues, transpose, volumeSequence, cellText, selectionText, selectionMml, findTerm, replaceTerm, matchesTerm,
  replaceCell, searchOrder, QueryError, nextBookmark, previousBookmark, highlightAt, highlightState, bookmarkPlace, fieldsOf, moveCells,
} from '../html/dnft-pattern-edit.mjs';
import { CELL, EMPTY_CELL } from '../html/dnft-song.mjs';

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

// The tracker's values (FamiTrackerTypes.h)
const C = 1, D = 3, E = 5, G = 8, B = 12, RELEASE = 13, HALT = 14, ECHO = 15;
const EF_SPEED = 1, EF_ARPEGGIO = 10, EF_VOLUME_SLIDE = 22, EF_PITCH = 13;
const LETTERS = ['', 'F', 'B', 'D', 'C', 'E', '3', '', 'H', 'I', '0', '4', '7', 'P', 'G', 'Z', '1', '2', 'V', 'Y', 'Q', 'R', 'A',
  'S', 'X', 'M', 'H', 'I', 'J', 'W', 'H', 'I', 'J', 'W', 'H', 'I', 'L', 'O', 'T', 'Z', 'E', 'J', '=', 'K', 'N'];

// A cell: note, octave, instrument, volume, [[effect, parameter]]
function cell(note = 0, octave = 0, instrument = 64, volume = 16, effects = []) {
  const c = Uint8Array.of(note, octave, volume, instrument, 0, 0, 0, 0, 0, 0, 0, 0);
  effects.forEach(([number, param], i) => { c[4 + i] = number; c[8 + i] = param; });
  return c;
}

// A track of `frames` frames of `rows` rows; frameList[frame][channel] is the pattern
function makeTrack({ rows = 8, frames = 2, channels = 3, effColumns = null, frameList = null, ids = null, chips = null }) {
  const patterns = new Map();
  const list = frameList ?? Array.from({ length: frames }, (_, f) => Array.from({ length: channels }, () => f));
  const track = {
    rows, frames, channels,
    effColumns: effColumns ?? new Array(channels).fill(1),
    ids: ids ?? Array.from({ length: channels }, (_, c) => c),
    chips: chips ?? new Array(channels).fill(0),
    pattern: (frame, channel) => list[frame][channel],
    data(channel, pattern) {
      const key = `${channel}:${pattern}`;
      if (!patterns.has(key)) {
        const data = new Uint8Array(rows * CELL);
        for (let r = 0; r < rows; ++r)
          data.set(EMPTY_CELL, r * CELL);
        patterns.set(key, data);
      }
      return patterns.get(key);
    },
    cell(frame, channel, row) {
      return track.data(channel, list[frame][channel]).subarray(row * CELL, row * CELL + CELL);
    },
    put(frame, channel, row, value) {
      track.data(channel, list[frame][channel]).set(value, row * CELL);
    },
    apply(writes) {
      for (const w of writes)
        track.data(w.channel, w.pattern).set(w.cell, w.row * CELL);
    },
    text(frame, channel, row) {
      return cellText(track.cell(frame, channel, row), 4, false, LETTERS);
    },
  };
  return track;
}

const at = (frame, row, channel, column) => ({ frame, row, channel, column });
const sel = (a, b) => normalizeSelection(a, b);

// ---- selections -------------------------------------------------------------------------------

check('a selection is put in order, and its columns widened to whole fields', () => {
  const s = sel(at(1, 2, 2, 5), at(0, 6, 0, 2));
  assert.deepEqual(s.start, { frame: 0, row: 6, channel: 0, column: 1 });
  assert.deepEqual(s.end, { frame: 1, row: 2, channel: 2, column: 6 });
  assert.equal(selectionLength(s, 8), 5);
  // one channel: the columns in order
  const t = sel(at(0, 0, 1, 11), at(0, 3, 1, 3));
  assert.deepEqual([t.start.column, t.end.column], [3, 12]);
  assert.deepEqual(fieldsOf(t, 1), [2, 5]);
  // between the first and last channels, all seven fields
  assert.deepEqual(fieldsOf(s, 1), [0, 6]);
  assert.deepEqual(cursorSelection(at(0, 0, 0, 8)).start.column, 7);
});

check('rows played twice in a selection are seen', () => {
  const track = makeTrack({ frames: 3, frameList: [[0, 0, 0], [0, 1, 1], [2, 2, 2]] });
  // channel 0 plays pattern 0 in frames 0 and 1
  assert.equal(repeatsRows(track, sel(at(0, 4, 0, 0), at(1, 2, 0, 0))), false);
  assert.equal(repeatsRows(track, sel(at(0, 4, 0, 0), at(1, 4, 0, 0))), true);
  assert.equal(repeatsRows(track, sel(at(0, 4, 1, 0), at(1, 6, 2, 0))), false);
});

// ---- copy, paste --------------------------------------------------------------------------------

check('copy takes whole cells, and the fields the selection starts and ends at', () => {
  const track = makeTrack({});
  track.put(0, 0, 1, cell(C, 4, 1, 12, [[EF_SPEED, 6]]));
  const clip = copyCells(track, sel(at(0, 1, 0, 3), at(0, 2, 1, 0)), null);
  assert.equal(clip.channels, 2);
  assert.equal(clip.rows, 2);
  assert.equal(clip.startField, FIELD.VOLUME);
  assert.equal(clip.endField, FIELD.NOTE);
  assert.deepEqual([...clip.cells[0].subarray(0, CELL)], [...cell(C, 4, 1, 12, [[EF_SPEED, 6]])]);
  // nothing selected: the cell at the cursor, all of it
  const one = copyCells(track, null, at(0, 1, 0, 5));
  assert.deepEqual([one.channels, one.rows, one.startField, one.endField], [1, 1, 0, 6]);
});

check('paste writes the clip\'s fields, from the cursor, and selects what it pasted', () => {
  const track = makeTrack({});
  track.put(0, 0, 0, cell(C, 3, 0, 10, [[EF_SPEED, 3]]));
  track.put(0, 1, 0, cell(E, 3, 2, 9));
  const clip = copyCells(track, sel(at(0, 0, 0, 3), at(0, 0, 1, 1)), null);
  track.put(0, 1, 4, cell(G, 5, 7, 7, [[EF_PITCH, 0x80]]));
  track.put(0, 2, 4, cell(G, 5, 7, 7));
  const { writes, target, repeated } = paste(track, clip, { cursor: at(0, 4, 1, 0) });
  track.apply(writes);
  // into channel 1: the volume and the first effect (G-5's note and instrument stay)
  assert.equal(track.text(0, 1, 4), 'G-5 07 A F03 ... ... ...');
  // channel 2: the note and instrument of E-3
  assert.equal(track.text(0, 2, 4), 'E-3 02 7 ... ... ... ...');
  assert.equal(repeated, false);
  assert.deepEqual(target, { start: at(0, 4, 1, 3), end: at(0, 4, 2, 2) });
});

check('mix fills only empty fields; overwrite leaves fields the clip has nothing in', () => {
  const track = makeTrack({ effColumns: [2, 1, 1] });
  track.put(0, 0, 0, cell(C, 3, 0, 16, [[EF_SPEED, 3]]));
  const clip = copyCells(track, null, at(0, 0, 0, 0));
  track.put(0, 0, 2, cell(D, 2, 64, 5, [[0, 0], [EF_PITCH, 0x70]]));
  track.apply(paste(track, clip, { mode: PASTE.MIX, cursor: at(0, 2, 0, 0) }).writes);
  assert.equal(track.text(0, 0, 2), 'D-2 00 5 F03 P70 ... ...');
  track.put(0, 0, 3, cell(D, 2, 64, 5, [[0, 0], [EF_PITCH, 0x70]]));
  track.apply(paste(track, clip, { mode: PASTE.OVERWRITE, cursor: at(0, 3, 0, 0) }).writes);
  assert.equal(track.text(0, 0, 3), 'C-3 00 5 F03 P70 ... ...');
  track.put(0, 0, 4, cell(D, 2, 64, 5, [[0, 0], [EF_PITCH, 0x70]]));
  track.apply(paste(track, clip, { cursor: at(0, 4, 0, 0) }).writes);
  assert.equal(track.text(0, 0, 4), 'C-3 00 . F03 ... ... ...');
});

check('a paste stops at the end of the frame, unless it overflows into the next', () => {
  const track = makeTrack({ rows: 4, frames: 3 });
  for (let r = 0; r < 4; ++r)
    track.put(0, 0, r, cell(C + r, 3, 1));
  const clip = copyCells(track, sel(at(0, 0, 0, 0), at(0, 3, 0, 6)), null);
  const short = paste(track, clip, { cursor: at(1, 2, 0, 0) });
  assert.equal(short.writes.length, 2);
  assert.deepEqual(short.target.end, at(1, 3, 0, 6));
  const long = paste(track, clip, { cursor: at(1, 2, 0, 0), overflow: true });
  track.apply(long.writes);
  assert.equal(long.writes.length, 4);
  assert.equal(track.text(2, 0, 1), 'D#3 01 . ... ... ... ...');
  assert.deepEqual(long.target.end, at(2, 1, 0, 6));
  // and not past the last frame
  assert.equal(paste(track, clip, { cursor: at(2, 2, 0, 0), overflow: true }).writes.length, 2);
});

check('insert moves the rows below down within the frame', () => {
  const track = makeTrack({ rows: 6, frames: 1 });
  for (let r = 0; r < 6; ++r)
    track.put(0, 0, r, cell(C + r, 2, 3, r));
  const clip = { channels: 1, rows: 2, startField: 0, endField: 0, cells: [Uint8Array.of(...cell(B, 4), ...cell(B, 5))] };
  const { writes, target } = paste(track, clip, { mode: PASTE.INSERT, cursor: at(0, 1, 0, 0) });
  track.apply(writes);
  // only the note column moved: instruments and volumes stay on their rows
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(r => track.text(0, 0, r).slice(0, 8)),
    ['C-2 03 0', 'B-4 03 1', 'B-5 03 2', 'C#2 03 3', 'D-2 03 4', 'D#2 03 5']);
  assert.deepEqual(target, { start: at(0, 1, 0, 0), end: at(0, 2, 0, 0) });
});

check('fill repeats the clip over the selection', () => {
  const track = makeTrack({ rows: 8, frames: 1 });
  const clip = { channels: 1, rows: 2, startField: 2, endField: 2, cells: [Uint8Array.of(...cell(0, 0, 64, 3), ...cell(0, 0, 64, 9))] };
  const selection = sel(at(0, 1, 0, 0), at(0, 5, 1, 3));
  const { writes, target } = paste(track, clip, { at: PASTE_AT.FILL, cursor: at(0, 0, 0, 0), selection });
  track.apply(writes);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(r => track.text(0, 0, r)[7] + track.text(0, 1, r)[7]),
    ['..', '33', '99', '33', '99', '33', '..']);
  assert.deepEqual(target, { start: at(0, 1, 0, 3), end: at(0, 5, 1, 3) });
});

check('an effect column alone goes to the effect column at the cursor', () => {
  const track = makeTrack({ effColumns: [3, 1, 1] });
  track.put(0, 0, 0, cell(0, 0, 64, 16, [[EF_SPEED, 6], [EF_PITCH, 0x81]]));
  const clip = copyCells(track, sel(at(0, 0, 0, 7), at(0, 0, 0, 9)), null);   // fx2
  const { writes, target } = paste(track, clip, { cursor: at(0, 3, 0, 10) });  // at fx3
  track.apply(writes);
  assert.equal(track.text(0, 0, 3), '... .. . ... ... P81 ...');
  assert.deepEqual([target.start.column, target.end.column], [10, 12]);
  // from the note column: into fx1
  track.apply(paste(track, clip, { cursor: at(0, 4, 0, 0) }).writes);
  assert.equal(track.text(0, 0, 4), '... .. . P81 ... ... ...');
  // past the columns the channel shows: not written
  assert.equal(paste(track, copyCells(track, sel(at(0, 0, 0, 4), at(0, 0, 0, 12)), null), { cursor: at(0, 0, 1, 4) })
    .writes.every(w => w.cell[5] === 0), true);
});

check('a paste over rows a channel plays twice is told', () => {
  const track = makeTrack({ rows: 4, frames: 2, frameList: [[0, 0, 0], [0, 1, 1]] });
  const clip = { channels: 1, rows: 6, startField: 0, endField: 6, cells: [new Uint8Array(6 * CELL)] };
  assert.equal(paste(track, clip, { cursor: at(0, 1, 1, 0), overflow: true }).repeated, false);
  assert.equal(paste(track, clip, { cursor: at(0, 1, 0, 0), overflow: true }).repeated, true);
});

check('delete clears the selected fields; insert and backspace move the rows of the selection', () => {
  const track = makeTrack({ rows: 5, frames: 1 });
  for (let r = 0; r < 5; ++r) {
    track.put(0, 0, r, cell(C + r, 3, r, r));
    track.put(0, 1, r, cell(C + r, 4, r, r));
  }
  const selection = sel(at(0, 1, 0, 3), at(0, 2, 1, 0));
  const cleared = makeTrack({ rows: 5, frames: 1 });
  for (let r = 0; r < 5; ++r) {
    cleared.put(0, 0, r, track.cell(0, 0, r));
    cleared.put(0, 1, r, track.cell(0, 1, r));
  }
  cleared.apply(clearCells(cleared, selection));
  assert.equal(cleared.text(0, 0, 1), 'C#3 01 . ... ... ... ...');
  assert.equal(cleared.text(0, 1, 2), '... 02 2 ... ... ... ...');
  assert.equal(cleared.text(0, 0, 3), 'D#3 03 3 ... ... ... ...');

  const inserted = makeTrack({ rows: 5, frames: 1 });
  for (let r = 0; r < 5; ++r)
    inserted.put(0, 0, r, track.cell(0, 0, r));
  inserted.apply(insertRows(inserted, sel(at(0, 1, 0, 0), at(0, 2, 0, 0))));
  assert.deepEqual([0, 1, 2, 3, 4].map(r => inserted.text(0, 0, r).slice(0, 3)), ['C-3', '...', 'C#3', 'D-3', 'D#3']);
  const deleted = makeTrack({ rows: 5, frames: 1 });
  for (let r = 0; r < 5; ++r)
    deleted.put(0, 0, r, track.cell(0, 0, r));
  deleted.apply(deleteRows(deleted, sel(at(0, 1, 0, 0), at(0, 2, 0, 3))));
  assert.deepEqual([0, 1, 2, 3, 4].map(r => deleted.text(0, 0, r).slice(0, 8)),
    ['C-3 00 0', 'D#3 03 3', 'E-3 04 4', '... .. .', '... .. .']);
});

// ---- the Pattern menu --------------------------------------------------------------------------

check('interpolate goes from the top to the bottom value of each field', () => {
  const track = makeTrack({ rows: 16, frames: 1, effColumns: [2, 1, 1] });
  track.put(0, 0, 0, cell(C, 3, 0, 15, [[EF_ARPEGGIO, 0x00], [EF_SPEED, 1]]));
  track.put(0, 0, 7, cell(G, 3, 7, 1, [[EF_ARPEGGIO, 0x47], [EF_PITCH, 0x80]]));
  track.put(0, 0, 3, cell(0, 0, 64, 16, [[0, 0], [EF_SPEED, 9]]));
  track.apply(interpolate(track, sel(at(0, 0, 0, 0), at(0, 7, 0, 9))));
  assert.deepEqual([...Array(8).keys()].map(r => track.text(0, 0, r).slice(0, 16)), [
    'C-3 00 F 000 F01', 'C#3 01 D 001 ...', 'D-3 02 B 012 ...', 'D#3 03 9 013 F09',
    'E-3 04 7 024 ...', 'F-3 05 5 025 ...', 'F#3 06 3 036 ...', 'G-3 07 1 047 P80']);
});

check('reverse turns the rows of the selected fields over', () => {
  const track = makeTrack({ rows: 4, frames: 1 });
  for (let r = 0; r < 4; ++r) {
    track.put(0, 0, r, cell(C + r, 3, r, r));
    track.put(0, 1, r, cell(C + r, 4, r, r));
  }
  track.apply(reverse(track, sel(at(0, 0, 0, 3), at(0, 3, 1, 1))));
  assert.deepEqual([0, 1, 2, 3].map(r => track.text(0, 0, r).slice(0, 8) + ' ' + track.text(0, 1, r).slice(0, 8)), [
    'C-3 00 3 D#4 03 0', 'C#3 01 2 D-4 02 1', 'D-3 02 1 C#4 01 2', 'D#3 03 0 C-4 00 3']);
});

check('replace instrument takes the instrument columns of the selection', () => {
  const track = makeTrack({ rows: 2, frames: 1 });
  for (let c = 0; c < 3; ++c) {
    track.put(0, c, 0, cell(C, 3, 1));
    track.put(0, c, 1, cell(HALT, 0, 64));
  }
  track.put(0, 1, 1, cell(0, 0, 0xFF));
  track.apply(replaceInstrument(track, sel(at(0, 0, 0, 3), at(0, 1, 2, 2)), 9));
  assert.deepEqual([0, 1, 2].map(c => track.text(0, c, 0).slice(4, 6)), ['01', '09', '09']);
  assert.equal(track.text(0, 1, 1).slice(4, 6), '&&');
  assert.equal(track.text(0, 2, 1).slice(4, 6), '..');
});

check('stretch spreads the rows out by its map; expand and shrink', () => {
  const make = () => {
    const track = makeTrack({ rows: 8, frames: 1 });
    for (let r = 0; r < 8; ++r)
      track.put(0, 0, r, cell(C + r, 3));
    return track;
  };
  const notes = track => [...Array(8).keys()].map(r => track.text(0, 0, r).slice(0, 3)).join(' ');
  const all = sel(at(0, 0, 0, 0), at(0, 7, 0, 6));
  const expanded = make();
  expanded.apply(stretch(expanded, all, [1, 0]));
  assert.equal(notes(expanded), 'C-3 ... C#3 ... D-3 ... D#3 ...');
  const shrunk = make();
  shrunk.apply(stretch(shrunk, all, [2]));
  assert.equal(notes(shrunk), 'C-3 D-3 E-3 F#3 ... ... ... ...');
  const odd = make();
  odd.apply(stretch(odd, all, [1, 2]));
  assert.equal(notes(odd), 'C-3 C#3 D#3 E-3 F#3 G-3 ... ...');
  assert.deepEqual(parseStretchMap('1 0'), [1, 0]);
  assert.equal(parseStretchMap('0 1'), null);
  assert.equal(parseStretchMap('1,2'), null);
  assert.equal(parseStretchMap(''), null);
  assert.deepEqual(stretchTest([1, 0]).slice(0, 6), [0, -1, 1, -1, 2, -1]);
  assert.deepEqual(stretchTest([2]).slice(0, 9), [0, 2, 4, 6, 8, 10, 12, 14, -1]);
  assert.deepEqual(invertStretchMap([1, 0]), [2]);
  assert.deepEqual(invertStretchMap([2]), [1, 0]);
  assert.deepEqual(invertStretchMap([3, 0, 0, 1]), [3, 0, 0, 1]);
});

check('values scroll by one or sixteen, and stop at the ends', () => {
  const track = makeTrack({ rows: 2, frames: 1, effColumns: [2, 1, 1] });
  track.put(0, 0, 0, cell(C, 3, 5, 15, [[EF_SPEED, 6], [EF_ARPEGGIO, 0x47]]));
  track.put(0, 0, 1, cell(C, 3, 0xFF, 16, [[EF_VOLUME_SLIDE, 0xFF]]));
  const all = sel(at(0, 0, 0, 0), at(0, 1, 0, 9));
  const up = makeTrack({ rows: 2, frames: 1, effColumns: [2, 1, 1] });
  up.put(0, 0, 0, track.cell(0, 0, 0));
  up.put(0, 0, 1, track.cell(0, 0, 1));
  up.apply(scrollValues(up, all, at(0, 0, 0, 0), 1));
  assert.equal(up.text(0, 0, 0).slice(0, 16), 'C-3 06 F F07 048');
  assert.equal(up.text(0, 0, 1).slice(0, 12), 'C-3 && . AFF');
  up.apply(scrollValues(up, all, at(0, 0, 0, 0), -16));
  assert.equal(up.text(0, 0, 0).slice(0, 16), 'C-3 00 0 F00 038');
  // at the cursor: its field only, and the digit of a two-digit effect
  const one = makeTrack({ rows: 1, frames: 1, effColumns: [2, 1, 1] });
  one.put(0, 0, 0, cell(C, 3, 5, 15, [[EF_SPEED, 6], [EF_ARPEGGIO, 0x47]]));
  one.apply(scrollValues(one, null, at(0, 0, 0, 8), 1));
  assert.equal(one.text(0, 0, 0).slice(0, 16), 'C-3 05 F F06 057');
  one.apply(scrollValues(one, null, at(0, 0, 0, 9), 1));
  assert.equal(one.text(0, 0, 0).slice(0, 16), 'C-3 05 F F06 058');
  one.apply(scrollValues(one, null, at(0, 0, 0, 3), -2));
  assert.equal(one.text(0, 0, 0).slice(0, 16), 'C-3 05 D F06 058');
  // wrapping around, if asked
  one.apply(scrollValues(one, null, at(0, 0, 0, 1), -6, true));
  assert.equal(one.text(0, 0, 0).slice(4, 6), '3F');
});

check('transpose moves notes, at the cursor only in the note column', () => {
  const track = makeTrack({ rows: 3, frames: 1 });
  track.put(0, 0, 0, cell(C, 3, 1));
  track.put(0, 0, 1, cell(B, 7, 1));
  track.put(0, 0, 2, cell(ECHO, 1));
  track.put(0, 1, 0, cell(RELEASE, 0));
  track.apply(transpose(track, sel(at(0, 0, 0, 0), at(0, 2, 1, 6)), at(0, 0, 0, 0), 1));
  assert.deepEqual([0, 1, 2].map(r => track.text(0, 0, r).slice(0, 3)), ['C#3', 'B-7', '^-1']);
  assert.equal(track.text(0, 1, 0).slice(0, 3), '===');
  track.apply(transpose(track, null, at(0, 2, 0, 0), 1));
  assert.equal(track.text(0, 0, 2).slice(0, 3), '^-2');
  assert.equal(transpose(track, null, at(0, 0, 0, 1), 12).length, 0);
  track.apply(transpose(track, null, at(0, 0, 0, 0), -12));
  assert.equal(track.text(0, 0, 0).slice(0, 3), 'C#2');
  // a selection starting after the note column leaves that channel's notes
  assert.equal(transpose(track, sel(at(0, 0, 0, 1), at(0, 0, 0, 3)), at(0, 0, 0, 0), 1).length, 0);
});

// ---- Copy As --------------------------------------------------------------------------------

check('copy as volume sequence', () => {
  const track = makeTrack({ rows: 8, frames: 1 });
  track.put(0, 0, 1, cell(0, 0, 64, 8));
  track.put(0, 0, 4, cell(0, 0, 64, 4));
  assert.equal(volumeSequence(track, sel(at(0, 2, 0, 0), at(0, 5, 0, 0))), '8 8 4 4 ');
  assert.equal(volumeSequence(track, sel(at(0, 0, 0, 0), at(0, 1, 0, 0))), '15 8 ');
});

check('copy as plain text', () => {
  const track = makeTrack({ rows: 4, frames: 1, effColumns: [2, 1, 1], ids: [0, 1, 3] });
  track.put(0, 0, 0, cell(C, 4, 1, 15, [[EF_SPEED, 6], [EF_PITCH, 0x81]]));
  track.put(0, 2, 0, cell(D + 1, 0, 0, 16));
  const text = selectionText(track, sel(at(0, 0, 0, 3), at(0, 1, 2, 3)), ['Pulse 1', 'Pulse 2', 'Noise'], LETTERS);
  assert.equal(text, [
    '     # : Pulse 1      fx2 : Pulse 2      : Noise',
    'ROW 00 :        F F06 P81 : ... .. . ... : 3-# 00 .',
    'ROW 01 :        . ... ... : ... .. . ... : ... .. .',
    '',
  ].join('\n'));
});

check('copy as PPMCK MML', () => {
  const track = makeTrack({ rows: 8, frames: 2, channels: 2, ids: [0, 5], chips: [0, 1] });
  track.put(0, 0, 0, cell(C, 4, 0));
  track.put(0, 0, 4, cell(E, 4, 0, 10));
  track.put(0, 1, 2, cell(D, 3, 0));
  track.put(0, 1, 6, cell(HALT, 0));
  track.put(1, 0, 0, cell(G, 5, 0));
  assert.equal(selectionMml(track, sel(at(0, 0, 0, 0), at(1, 7, 1, 0)), [0, 1]),
    'A\to4c4v10e4>g2\nM\tr8o3d4r2^8\n');
});

// ---- Find / Replace ---------------------------------------------------------------------------

const opts = { noise: false, effects: 2 };
const query = fields => findTerm(fields, LETTERS);
const throwsCode = (fn, code) => assert.throws(fn, e => e instanceof QueryError && e.code === code);

check('find: notes with and without octaves, ranges, cuts, wildcards', () => {
  assert.equal(matchesTerm(query({ note: ['C-4'] }), cell(C, 4), opts), true);
  assert.equal(matchesTerm(query({ note: ['C-4'] }), cell(C, 3), opts), false);
  assert.equal(matchesTerm(query({ note: ['C'] }), cell(C, 6), opts), true);
  assert.equal(matchesTerm(query({ note: ['Db3'] }), cell(C + 1, 3), opts), true);
  assert.equal(matchesTerm(query({ note: ['B#3'] }), cell(C, 4), opts), true);
  assert.equal(matchesTerm(query({ note: ['C-3', 'E-3'] }), cell(D, 3), opts), true);
  assert.equal(matchesTerm(query({ note: ['E-3', 'C-3'] }), cell(G, 3), opts), false);
  assert.equal(matchesTerm(query({ note: ['---'] }), cell(HALT, 0), opts), true);
  assert.equal(matchesTerm(query({ note: ['.'] }), cell(RELEASE, 0), opts), true);
  assert.equal(matchesTerm(query({ note: ['.'] }), cell(), opts), false);
  assert.equal(matchesTerm(query({ note: [''] }), cell(), opts), true);
  assert.equal(matchesTerm(query({ note: ['49'] }), cell(C + 1, 4), opts), true);
  assert.equal(matchesTerm(query({ note: ['^1'] }), cell(ECHO, 1), opts), true);
  // a melodic note is not looked for in the noise channel, nor a noise one elsewhere
  assert.equal(matchesTerm(query({ note: ['C-4'] }), cell(C, 4), { ...opts, noise: true }), false);
  // noise notes are entered as 16-31, the period plus 16
  assert.equal(matchesTerm(query({ note: ['3-#'] }), cell(G, 1), { ...opts, noise: true }), true);
  assert.equal(matchesTerm(query({ note: ['3-#'] }), cell(G, 1), opts), false);
  throwsCode(() => query({ note: ['C-9'] }), 'octaveRange');
  throwsCode(() => query({ note: ['B#7'] }), 'octaveOver');
  throwsCode(() => query({ note: ['C', 'D-3'] }), 'rangeWildcard');
  throwsCode(() => query({ note: ['---', 'C-3'] }), 'rangeWildcard');
  throwsCode(() => query({ note: ['C-3', '---'] }), 'rangeCut');
  throwsCode(() => query({ note: ['X'] }), 'noteUnknown');
  throwsCode(() => query({ note: ['^5'] }), 'echoRange');
  throwsCode(() => query({}), 'findEmpty');
});

check('find: instruments, volumes, effects, the effect column, negation', () => {
  assert.equal(matchesTerm(query({ inst: ['.'] }), cell(C, 3, 0x20), opts), true);
  assert.equal(matchesTerm(query({ inst: ['.'] }), cell(C, 3, 64), opts), false);
  assert.equal(matchesTerm(query({ inst: [''] }), cell(C, 3, 64), opts), true);
  assert.equal(matchesTerm(query({ inst: ['&&'] }), cell(0, 0, 0xFF), opts), true);
  assert.equal(matchesTerm(query({ inst: ['02', '05'] }), cell(0, 0, 4), opts), true);
  assert.equal(matchesTerm(query({ vol: ['A'] }), cell(0, 0, 64, 10), opts), true);
  throwsCode(() => query({ inst: ['40'] }), 'instrumentRange');
  const speed = query({ effect: 'F' });
  assert.equal(matchesTerm(speed, cell(0, 0, 64, 16, [[0, 0], [EF_SPEED, 3]]), opts), true);
  assert.equal(matchesTerm(speed, cell(0, 0, 64, 16, [[0, 0], [EF_SPEED, 3]]), { ...opts, column: 0 }), false);
  assert.equal(matchesTerm(speed, cell(0, 0, 64, 16, [[0, 0], [EF_SPEED, 3]]), { ...opts, column: 1 }), true);
  // a column past the channel's looks in its last
  assert.equal(matchesTerm(speed, cell(0, 0, 64, 16, [[0, 0], [EF_SPEED, 3]]), { ...opts, column: 3 }), true);
  assert.equal(matchesTerm(query({ effect: 'F06' }), cell(0, 0, 64, 16, [[EF_SPEED, 3]]), opts), false);
  assert.equal(matchesTerm(query({ effect: '.06' }), cell(0, 0, 64, 16, [[EF_PITCH, 6]]), opts), true);
  assert.equal(matchesTerm(query({ effect: '' }), cell(0, 0, 64, 16), { ...opts, column: 0 }), true);
  assert.equal(matchesTerm(speed, cell(C, 3), { ...opts, negate: true }), true);
  throwsCode(() => query({ effect: 'F0' }), 'effectShort');
  throwsCode(() => query({ effect: 'U' }), 'effectUnknown');
});

check('replace: what the replacement sets, and what it may not hold', () => {
  const find = query({ effect: 'F' });
  const replacement = replaceTerm({ inst: '02', effect: 'F08' }, LETTERS, false);
  const out = replaceCell(cell(C, 3, 1, 16, [[EF_PITCH, 0x80], [EF_SPEED, 3]]), find, replacement, { effects: 2, effectOf: () => EF_SPEED });
  assert.equal(cellText(out, 2, false, LETTERS), 'C-3 02 . P80 F08');
  // removing what was there: the note alone stays
  const note = replaceTerm({ note: 'G-2' }, LETTERS, true);
  assert.equal(cellText(replaceCell(cell(C, 3, 1, 9), query({ note: ['C-3'] }), note, { effects: 1, removeOriginal: true, effectOf: () => 0 }), 1, false, LETTERS),
    'G-2 .. . ...');
  // a note cut has no octave
  assert.equal(replaceTerm({ note: '---' }, LETTERS, false).octave, 0);
  throwsCode(() => replaceTerm({ inst: '.' }, LETTERS, false), 'replaceWildcard');
  throwsCode(() => replaceTerm({ note: 'C' }, LETTERS, true), 'removeNoOctave');
  throwsCode(() => replaceTerm({ effect: 'F' }, LETTERS, true), 'removeNoParameter');
  throwsCode(() => replaceTerm({}, LETTERS, false), 'replaceEmpty');
});

check('the search goes across the channels, or down them', () => {
  const area = sel(at(0, 1, 0, 0), at(0, 2, 1, 0));
  assert.deepEqual([...searchOrder(area, 8, false)].map(p => `${p.row}${p.channel}`), ['10', '11', '20', '21']);
  assert.deepEqual([...searchOrder(area, 8, true)].map(p => `${p.row}${p.channel}`), ['10', '20', '11', '21']);
});

// ---- bookmarks ---------------------------------------------------------------------------------

check('the next and previous bookmark wrap around, the one at the cursor last', () => {
  const list = [{ frame: 2, row: 0 }, { frame: 0, row: 8 }, { frame: 1, row: 4 }];
  assert.deepEqual(nextBookmark(list, 0, 8), { frame: 1, row: 4 });
  assert.deepEqual(nextBookmark(list, 2, 3), { frame: 0, row: 8 });
  assert.deepEqual(previousBookmark(list, 1, 4), { frame: 0, row: 8 });
  assert.deepEqual(previousBookmark(list, 0, 2), { frame: 2, row: 0 });
  assert.deepEqual(nextBookmark([{ frame: 1, row: 1 }], 1, 1), { frame: 1, row: 1 });
  assert.equal(nextBookmark([], 0, 0), null);
});

check('bookmarks set the row highlight from their row on', () => {
  const list = [
    { frame: 1, row: 2, highlight: [3, -1], persist: false },
    { frame: 2, row: 5, highlight: [-1, 6], persist: true },
  ];
  const base = [4, 16];
  assert.deepEqual(highlightAt(list, base, 0, 7), { first: 4, second: 16, offset: 0 });
  assert.deepEqual(highlightAt(list, base, 1, 8), { first: 3, second: 16, offset: 2 });
  assert.equal(highlightState(highlightAt(list, base, 1, 8), 8), 1);
  // in a later frame, only "persist" holds; the count still starts at the bookmark's row
  assert.deepEqual(highlightAt(list, base, 3, 0), { first: 4, second: 6, offset: 5 });
  // before the bookmark's row, in its frame: unsigned arithmetic, as the desktop's
  assert.equal(highlightState({ first: 3, second: 0, offset: 5 }, 2), (2 - 5 + 2 ** 32) % 3 === 0 ? 1 : 0);
  assert.equal(highlightState({ first: 4, second: 16, offset: 0 }, 16), 2);
  assert.deepEqual(bookmarkPlace(5, 70, 4, 64), { frame: 2, row: 6 });
});

// ---- dragging a selection ---------------------------------------------------------------------

check('a dragged selection moves: cleared where it was, put where it is dropped', () => {
  const track = makeTrack({});
  track.put(0, 0, 1, cell(C, 4, 1, 15, [[EF_SPEED, 6]]));
  track.put(0, 0, 2, cell(E, 4, 2, 9));
  const drop = moveCells(track, sel(at(0, 1, 0, 0), at(0, 2, 0, 6)), at(0, 5, 1, 0));
  assert.deepEqual(drop.target, { start: at(0, 5, 1, 0), end: at(0, 6, 1, 6) });
  track.apply(drop.writes);
  assert.equal(track.text(0, 0, 1), cellText(EMPTY_CELL, 4, false, LETTERS));
  assert.equal(track.text(0, 0, 2), cellText(EMPTY_CELL, 4, false, LETTERS));
  assert.deepEqual([...track.cell(0, 1, 5)], [...cell(C, 4, 1, 15, [[EF_SPEED, 6]])]);
  assert.deepEqual([...track.cell(0, 1, 6)], [...cell(E, 4, 2, 9)]);
});

check('Ctrl copies, and Shift copies on top of what is there', () => {
  const track = makeTrack({});
  track.put(0, 0, 0, cell(C, 4, 1, 15));
  track.put(0, 1, 3, cell(0, 0, 64, 7, [[EF_SPEED, 3]]));
  const s = sel(at(0, 0, 0, 0), at(0, 0, 0, 6));
  // a copy leaves the source
  const copy = moveCells(track, s, at(0, 3, 1, 0), { copy: true });
  const plain = makeTrack({});
  plain.put(0, 0, 0, cell(C, 4, 1, 15));
  plain.put(0, 1, 3, cell(0, 0, 64, 7, [[EF_SPEED, 3]]));
  plain.apply(copy.writes);
  assert.deepEqual([...plain.cell(0, 0, 0)], [...cell(C, 4, 1, 15)]);
  // the drop replaces the cell, including its fields that were empty
  assert.deepEqual([...plain.cell(0, 1, 3)], [...cell(C, 4, 1, 15)]);
  // mixed: the volume and the effect the target had stay
  const mix = moveCells(track, s, at(0, 3, 1, 0), { copy: true, mix: true });
  track.apply(mix.writes);
  assert.deepEqual([...track.cell(0, 1, 3)], [...cell(C, 4, 1, 7, [[EF_SPEED, 3]])]);
  // Shift without Ctrl is still a move
  const moved = moveCells(makeTrack({}), s, at(0, 3, 1, 0), { mix: true });
  assert.equal(moved.writes.length, 2);
});

check('a drop where the selection is changes nothing; one that overlaps it moves the rows', () => {
  const track = makeTrack({});
  track.put(0, 0, 1, cell(C, 4, 1, 15));
  track.put(0, 0, 2, cell(E, 4, 2, 9));
  const s = sel(at(0, 1, 0, 0), at(0, 2, 0, 6));
  assert.equal(moveCells(track, s, at(0, 1, 0, 0)), null);
  track.apply(moveCells(track, s, at(0, 2, 0, 0)).writes);
  assert.equal(track.text(0, 0, 1), cellText(EMPTY_CELL, 4, false, LETTERS));
  assert.deepEqual([...track.cell(0, 0, 2)], [...cell(C, 4, 1, 15)]);
  assert.deepEqual([...track.cell(0, 0, 3)], [...cell(E, 4, 2, 9)]);
});

check('an effect column of one channel can be dropped on another effect column', () => {
  const track = makeTrack({ effColumns: [3, 3, 3] });
  track.put(0, 0, 0, cell(C, 4, 1, 15, [[EF_SPEED, 6], [EF_ARPEGGIO, 0x37]]));
  // the first effect column alone
  const s = sel(at(0, 0, 0, 4), at(0, 0, 0, 6));
  assert.equal(s.start.column, 4);
  // dropped on the second one, in the same row
  const drop = moveCells(track, s, at(0, 0, 0, 7));
  assert.deepEqual(drop.target, { start: at(0, 0, 0, 7), end: at(0, 0, 0, 9) });
  track.apply(drop.writes);
  const c = track.cell(0, 0, 0);
  assert.equal(c[4], 0, 'the first effect is gone');
  assert.deepEqual([c[5], c[9]], [EF_SPEED, 6], 'and is in the second');
  // dropped outside the effect columns it goes to the first one
  const back = moveCells(track, sel(at(0, 0, 0, 7), at(0, 0, 0, 9)), at(0, 0, 0, 0));
  assert.equal(back.target.start.column, 4);
});

check('a drop at the end of the frame stops there, and goes on into the next frame with overflow', () => {
  const track = makeTrack({});
  for (let r = 0; r < 3; ++r)
    track.put(0, 0, r, cell(C + r, 4, 1, 15));
  const s = sel(at(0, 0, 0, 0), at(0, 2, 0, 6));
  const stopped = moveCells(track, s, at(0, 6, 1, 0));
  assert.deepEqual(stopped.writes.filter(w => w.channel === 1).map(w => w.row).sort(), [6, 7]);
  const through = moveCells(track, s, at(0, 6, 1, 0), { overflow: true });
  assert.deepEqual(through.writes.filter(w => w.channel === 1).map(w => [w.pattern, w.row]).sort(), [[0, 6], [0, 7], [1, 0]]);
  assert.deepEqual(through.target.end, { frame: 1, row: 0, channel: 1, column: 6 });
});

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall passed');

// Dn-FamiTracker web port - what the pattern editor's commands do to the cells.
//
// The desktop tracker's Edit and Pattern menus (CPatternEditor, CPatternAction, CFindDlg,
// CStretchDlg, CBookmarkCollection) worked out on the page's copy of a track, without a
// page: what a paste writes, Interpolate, Reverse, Replace Instrument, Stretch, the values
// scrolled, transposition, the texts of Copy As, the queries of Find / Replace, and the
// order and row highlights of bookmarks. The editor (dnft-editor.mjs) applies what these
// return.
//
// A place is {frame, row, channel, column}, the column one of the cursor's
// (dnft-pattern-view.mjs); cells are the 12 bytes of dnft-song.mjs. A track is read through
//   {rows, frames, channels, effColumns: [1-4], ids: [channel id], chips: [chip],
//    cell(frame, channel, row), pattern(frame, channel)}
// and the edits return the cells they write as [{channel, pattern, row, cell}]: a pattern
// two frames play is written once.

import { CELL, NOTE, MAX_VOLUME, NO_INSTRUMENT, HOLD_INSTRUMENT, MAX_INSTRUMENTS, OCTAVES, EMPTY_CELL, CHANNEL_ID } from './dnft-song.mjs';

// A cell's fields, the desktop's column_t: the note (with its octave), the instrument, the
// volume and the four effects (number and parameter)
export const FIELD = { NOTE: 0, INSTRUMENT: 1, VOLUME: 2, EFFECT: 3 };
export const LAST_FIELD = 6;
const FIRST_COLUMN = [0, 1, 3, 4, 7, 10, 13];
const LAST_COLUMN = [0, 2, 3, 6, 9, 12, 15];

export const fieldOfColumn = column => column === 0 ? 0 : column <= 2 ? 1 : column === 3 ? 2 : 3 + Math.floor((column - 4) / 3);
export const firstColumn = field => FIRST_COLUMN[field];
export const lastColumn = field => LAST_COLUMN[field];
// The last field of a channel that shows 1-4 effect columns
export const shownField = effColumns => 2 + effColumns;

// FamiTrackerTypes.h
const NOTE_RANGE = 12;
const NOTE_COUNT = OCTAVES * NOTE_RANGE;
const ECHO_BUFFER_LENGTH = 3;
const EF = {
  NONE: 0, SWEEPUP: 8, SWEEPDOWN: 9, ARPEGGIO: 10, VIBRATO: 11, TREMOLO: 12, SLIDE_UP: 20, SLIDE_DOWN: 21,
  VOLUME_SLIDE: 22, DELAYED_VOLUME: 25, TRANSPOSE: 38, TARGET_VOLUME_SLIDE: 44, COUNT: 45,
};
// Effects whose parameter is two digits of their own: Interpolate takes them apart
const TWO_PARAM = new Set([EF.SWEEPUP, EF.SWEEPDOWN, EF.SLIDE_UP, EF.SLIDE_DOWN, EF.ARPEGGIO, EF.VIBRATO, EF.TREMOLO,
  EF.VOLUME_SLIDE, EF.DELAYED_VOLUME, EF.TRANSPOSE]);
// ...and the values scrolled at the cursor change the digit it is on
const NIBBLE_PARAM = new Set([...TWO_PARAM, EF.TARGET_VOLUME_SLIDE]);

const midiNote = (octave, note) => octave * NOTE_RANGE + note - 1;
const isNote = note => note >= NOTE.C && note <= NOTE.B;

// ---- fields ---------------------------------------------------------------------------------

// Paste modes (paste_mode_t) and where a paste goes (paste_pos_t)
export const PASTE = { DEFAULT: 0, MIX: 1, OVERWRITE: 2, INSERT: 3 };
export const PASTE_AT = { CURSOR: 0, SELECTION: 1, FILL: 2 };

function hasField(cell, field) {
  switch (field) {
    case 0: return cell[0] !== NOTE.NONE;
    case 1: return cell[3] !== NO_INSTRUMENT;
    case 2: return cell[2] !== MAX_VOLUME;
    default: return cell[field + 1] !== EF.NONE;
  }
}

function copyField(from, to, field) {
  switch (field) {
    case 0: to[0] = from[0]; to[1] = from[1]; break;
    case 1: to[3] = from[3]; break;
    case 2: to[2] = from[2]; break;
    default: to[field + 1] = from[field + 1]; to[field + 5] = from[field + 5];
  }
}

// The fields first..last of `source` into `target` (CopyNoteSection()): Mix keeps what the
// target has, Overwrite keeps it where the source has nothing. (The desktop's copies a
// whole cell, whatever the mode, when the range is all seven fields; and swaps a range
// given backwards, which can write fields a paste did not ask for. Neither is done here.)
export function copyFields(target, source, first, last, mode = PASTE.DEFAULT) {
  for (let field = first; field <= last; ++field) {
    if (mode === PASTE.MIX && hasField(target, field))
      continue;
    if ((mode === PASTE.MIX || mode === PASTE.OVERWRITE) && !hasField(source, field))
      continue;
    copyField(source, target, field);
  }
}

// ---- selections -----------------------------------------------------------------------------

// The desktop's CSelection, normalized: {start, end} places, the start first in the song,
// the channels in order, and the columns widened to the whole fields they are in
export function normalizeSelection(a, b) {
  const [first, last] = a.frame < b.frame || (a.frame === b.frame && a.row <= b.row) ? [a, b] : [b, a];
  let start, end;
  if (a.channel === b.channel)
    [start, end] = [{ channel: a.channel, column: Math.min(a.column, b.column) }, { channel: a.channel, column: Math.max(a.column, b.column) }];
  else
    [start, end] = a.channel < b.channel ? [a, b] : [b, a];
  return {
    start: { frame: first.frame, row: first.row, channel: start.channel, column: firstColumn(fieldOfColumn(start.column)) },
    end: { frame: last.frame, row: last.row, channel: end.channel, column: lastColumn(fieldOfColumn(end.column)) },
  };
}

// The cell at a place, as a selection of it
export const cursorSelection = place => normalizeSelection(place, place);

// How many rows a selection covers, for patterns of `rows` rows
export const selectionLength = (sel, rows) => (sel.end.frame - sel.start.frame) * rows + sel.end.row - sel.start.row + 1;

// The frame and row `i` rows into a selection
export function rowAt(sel, rows, i) {
  const at = sel.start.frame * rows + sel.start.row + i;
  return { frame: Math.floor(at / rows), row: at % rows };
}

export const inRows = (sel, frame, row) =>
  (frame > sel.start.frame || (frame === sel.start.frame && row >= sel.start.row)) &&
  (frame < sel.end.frame || (frame === sel.end.frame && row <= sel.end.row));

// CSelection::IsColumnSelected()
export const fieldSelected = (sel, channel, field) =>
  (channel > sel.start.channel || (channel === sel.start.channel && field >= fieldOfColumn(sel.start.column))) &&
  (channel < sel.end.channel || (channel === sel.end.channel && field <= fieldOfColumn(sel.end.column)));

// [first, last] field of a channel in the selection: all seven between its first and last
// channels, as the desktop's edits take them (effect columns not shown included)
export const fieldsOf = (sel, channel) => [
  channel === sel.start.channel ? fieldOfColumn(sel.start.column) : 0,
  channel === sel.end.channel ? fieldOfColumn(sel.end.column) : LAST_FIELD,
];

// Whether a channel plays the same row of a pattern twice within the selection (the
// desktop's SEL_REPEATED_ROW), which the edits that move rows around refuse
export function repeatsRows(track, sel) {
  for (let c = sel.start.channel; c <= sel.end.channel; ++c) {
    const seen = new Map();   // pattern -> [first row, last row]
    for (let f = sel.start.frame; f <= sel.end.frame; ++f) {
      const pattern = track.pattern(f, c);
      const begin = f === sel.start.frame ? sel.start.row : 0;
      const end = f === sel.end.frame ? sel.end.row : track.rows - 1;
      const range = seen.get(pattern);
      if (range && begin <= range[1] && end >= range[0])
        return true;
      seen.set(pattern, range ? [Math.min(range[0], begin), Math.max(range[1], end)] : [begin, end]);
    }
  }
  return false;
}

// What an edit writes: cells by pattern and row, read through while it works
class Writes {
  constructor(track) {
    this.track = track;
    this.cells = new Map();
  }

  key(frame, channel, row) {
    return `${channel}:${this.track.pattern(frame, channel)}:${row}`;
  }

  // The cell as the edit has it so far (a copy to change and set())
  get(frame, channel, row) {
    return Uint8Array.from(this.cells.get(this.key(frame, channel, row))?.cell ?? this.track.cell(frame, channel, row));
  }

  set(frame, channel, row, cell) {
    this.cells.set(this.key(frame, channel, row), { channel, pattern: this.track.pattern(frame, channel), row, cell });
  }

  list() {
    return [...this.cells.values()];
  }
}

// The cells of a selection as they are, [row][channel - first channel]
function readRows(track, sel) {
  const length = selectionLength(sel, track.rows);
  return Array.from({ length }, (_, i) => {
    const { frame, row } = rowAt(sel, track.rows, i);
    return Array.from({ length: sel.end.channel - sel.start.channel + 1 }, (_, c) => Uint8Array.from(track.cell(frame, sel.start.channel + c, row)));
  });
}

// ---- copy, cut, delete, paste ------------------------------------------------------------------

// Edit > Copy (CPatternEditor::Copy()): whole cells of the selection, with the fields its
// first and last channels begin and end at; without a selection, the cell at the cursor:
// {channels, rows, startField, endField, cells: [Uint8Array(rows * 12) per channel]}
export function copyCells(track, sel, cursor) {
  if (!sel)
    return { channels: 1, rows: 1, startField: 0, endField: LAST_FIELD, cells: [Uint8Array.from(track.cell(cursor.frame, cursor.channel, cursor.row))] };
  const rows = readRows(track, sel);
  const channels = sel.end.channel - sel.start.channel + 1;
  const cells = Array.from({ length: channels }, (_, c) => {
    const data = new Uint8Array(rows.length * CELL);
    rows.forEach((row, r) => data.set(row[c], r * CELL));
    return data;
  });
  return { channels, rows: rows.length, startField: fieldOfColumn(sel.start.column), endField: fieldOfColumn(sel.end.column), cells };
}

// Edit > Delete with a selection (CPatternAction::DeleteSelection())
export function clearCells(track, sel) {
  const writes = new Writes(track);
  for (let i = 0, length = selectionLength(sel, track.rows); i < length; ++i) {
    const { frame, row } = rowAt(sel, track.rows, i);
    for (let c = sel.start.channel; c <= sel.end.channel; ++c) {
      const cell = writes.get(frame, c, row);
      const [first, last] = fieldsOf(sel, c);
      copyFields(cell, EMPTY_CELL, first, last);
      writes.set(frame, c, row, cell);
    }
  }
  return writes.list();
}

// Edit > Paste and Paste Special (CPatternAction::SetTargetSelection(),
// CPatternEditor::Paste()): {writes, target, repeated}: the cells written, the selection
// the desktop shows on what was pasted, and whether that area plays a row twice (the
// desktop asks first then). Pastes stop at the end of the frame, unless `overflow` (the
// desktop's "Overflow paste mode") lets them go on into the next frames, to the end of the
// track. Insert moves the rows below down, within the frame. An effect column alone goes
// to the effect column of the cursor.
export function paste(track, clip, { mode = PASTE.DEFAULT, at = PASTE_AT.CURSOR, cursor, selection = null, overflow = false }) {
  if (!selection)
    at = PASTE_AT.CURSOR;
  const L = track.rows;
  const atSel = at !== PASTE_AT.CURSOR;
  const origin = atSel ? selection.start : cursor;
  const f = origin.frame, r = origin.row, c = origin.channel;
  const fill = at === PASTE_AT.FILL;
  const channels = fill ? selection.end.channel - selection.start.channel + 1 : clip.channels;
  const rows = fill ? selectionLength(selection, L) : clip.rows;
  const { startField, endField } = clip;
  const lastChannel = Math.min(c + channels, track.channels) - 1;

  // the area pasted on
  const start = { frame: f, row: r, channel: c, column: firstColumn(startField) };
  let end;
  if (mode === PASTE.INSERT) {
    end = { frame: f, row: L - 1 };
  } else {
    const last = f * L + r + clip.rows - 1;
    end = { frame: Math.floor(last / L), row: last % L };
  }
  if (fill) {
    end = { frame: selection.end.frame, row: selection.end.row, channel: selection.end.channel };
    end.column = lastColumn((end.channel - c + 1) % clip.channels ? shownField(track.effColumns[end.channel]) : endField);
  } else {
    end.channel = c + clip.channels - 1;
    end.column = lastColumn(endField);
  }
  if (!overflow && end.frame > f)
    end = { ...end, frame: f, row: L - 1 };
  if (end.frame >= track.frames)
    end = { ...end, frame: track.frames - 1, row: L - 1 };
  const EFFECT_COLUMN = firstColumn(FIELD.EFFECT);
  let shift = 3 * (fieldOfColumn(cursor.column) - startField);
  if (EFFECT_COLUMN - start.column > shift)
    shift = EFFECT_COLUMN - start.column;
  if (start.channel === end.channel && start.column >= EFFECT_COLUMN && end.column >= EFFECT_COLUMN) {
    start.column += shift;
    end.column = Math.min(lastColumn(LAST_FIELD), end.column + shift);
  }
  if (end.channel >= track.channels)
    end.channel = track.channels - 1;
  end.column = Math.min(end.column, lastColumn(shownField(track.effColumns[end.channel])));
  // what the paste changes (an insert, all the rows to the end of the frame), and what it
  // leaves selected
  const repeated = repeatsRows(track, { start, end });
  const target = { start, end: mode === PASTE.INSERT ? { ...end, row: Math.min(start.row + rows, L) - 1 } : end };

  const writes = new Writes(track);
  if (mode === PASTE.INSERT) {
    for (let i = c; i <= lastChannel; ++i) {
      const first = i === c ? startField : 0;
      const last = Math.min(i === c + channels - 1 ? endField : LAST_FIELD, shownField(track.effColumns[i]));
      for (let front = L - 1, back = L - 1 - rows; back >= r; --front, --back) {
        const cell = writes.get(f, i, front);
        copyFields(cell, writes.get(f, i, back), first, last);
        writes.set(f, i, front, cell);
      }
    }
  }

  const stop = at => at % L === 0 && (!overflow || mode === PASTE.INSERT) || at >= track.frames * L;
  if (channels === 1 && startField >= FIELD.EFFECT) {
    // effect columns of one channel: into the one at the cursor
    const destination = Math.max(fieldOfColumn(atSel ? target.start.column : cursor.column), FIELD.EFFECT);
    for (let j = 0, at = f * L + r; j < rows; ++j) {
      const frame = Math.floor(at / L), row = at % L;
      const cell = writes.get(frame, c, row);
      const source = clip.cells[0].subarray((j % clip.rows) * CELL, (j % clip.rows + 1) * CELL);
      for (let e = startField - FIELD.EFFECT; e <= endField - FIELD.EFFECT; ++e) {
        const to = e - startField + destination;
        if (to >= track.effColumns[c])
          break;
        if (mode === PASTE.MIX && cell[4 + to] !== EF.NONE)
          continue;
        if ((mode === PASTE.MIX || mode === PASTE.OVERWRITE) && source[4 + e] === EF.NONE)
          continue;
        cell[4 + to] = source[4 + e];
        cell[8 + to] = source[8 + e];
      }
      writes.set(frame, c, row, cell);
      if (stop(++at))
        break;
    }
    return { writes: writes.list(), target, repeated };
  }

  for (let j = 0, at = f * L + r; j < rows; ++j) {
    const frame = Math.floor(at / L), row = at % L;
    for (let i = c; i <= lastChannel; ++i) {
      const from = (i - c) % clip.channels;
      const last = Math.min(i === c + channels - 1 ? endField : LAST_FIELD, shownField(track.effColumns[i]));
      const cell = writes.get(frame, i, row);
      const source = clip.cells[from].subarray((j % clip.rows) * CELL, (j % clip.rows + 1) * CELL);
      copyFields(cell, source, from === 0 ? startField : 0, last, mode);
      writes.set(frame, i, row, cell);
    }
    if (stop(++at))
      break;
  }
  return { writes: writes.list(), target, repeated };
}

// Dragging a selection and dropping it (CPatternEditor::PerformDrop(), CPActionDragAndDrop):
// the cells of `sel` go with their top left corner at `to` ({frame, row, channel, column}; the
// column matters only to the effect columns of one channel, which can go into another one).
// Moving clears them first; `copy` (Ctrl) leaves them, and `mix` (Shift, with a copy) keeps
// what the target has. {writes, target, repeated} as paste() has them, with the target as the
// selection that shows what was dropped; null for a drop where the selection already is.
export function moveCells(track, sel, to, { copy = false, mix = false, overflow = false } = {}) {
  const clip = copyCells(track, sel, sel.start);
  let column = firstColumn(clip.startField);
  if (clip.channels === 1 && clip.startField >= FIELD.EFFECT) {
    const field = to.column == null ? -1 : fieldOfColumn(to.column);
    column = firstColumn(Math.max(field, FIELD.EFFECT));
  }
  if (to.frame === sel.start.frame && to.row === sel.start.row && to.channel === sel.start.channel && column === sel.start.column)
    return null;
  const key = (channel, pattern, row) => `${channel}:${pattern}:${row}`;
  const cleared = copy ? [] : clearCells(track, sel);
  const left = new Map(cleared.map(w => [key(w.channel, w.pattern, w.row), w.cell]));
  // the paste sees the cells as the move has left them
  const seen = {
    ...track,
    cell: (frame, channel, row) => left.get(key(channel, track.pattern(frame, channel), row)) ?? track.cell(frame, channel, row),
  };
  const { writes, target, repeated } = paste(seen, clip, {
    mode: copy && mix ? PASTE.MIX : PASTE.DEFAULT, at: PASTE_AT.CURSOR, overflow,
    cursor: { frame: to.frame, row: to.row, channel: to.channel, column },
  });
  const all = new Map(cleared.map(w => [key(w.channel, w.pattern, w.row), w]));
  for (const w of writes)
    all.set(key(w.channel, w.pattern, w.row), w);
  return { writes: [...all.values()], target, repeated };
}

// Insert with a selection (CPActionInsertAtSel): a row of nothing at the top of the
// selection's columns; what is below moves down, as far as the end of the selection's last
// frame
export function insertRows(track, sel) {
  const L = track.rows;
  const area = { start: sel.start, end: { ...sel.end, row: L - 1 } };
  const rows = readRows(track, area);
  const writes = new Writes(track);
  rows.forEach((_, i) => {
    const { frame, row } = rowAt(area, L, i);
    for (let c = area.start.channel; c <= area.end.channel; ++c) {
      const cell = writes.get(frame, c, row);
      const [first, last] = fieldsOf(area, c);
      copyFields(cell, i ? rows[i - 1][c - area.start.channel] : EMPTY_CELL, first, last);
      writes.set(frame, c, row, cell);
    }
  });
  return writes.list();
}

// Backspace with a selection (CPActionDeleteAtSel): the selection's rows go, in its
// columns, and what follows within its last frame moves up
export function deleteRows(track, sel) {
  const L = track.rows;
  const area = { start: sel.start, end: { ...sel.end, row: L - 1 } };
  const rows = readRows(track, area);
  const gone = selectionLength(sel, L);
  const writes = new Writes(track);
  rows.forEach((_, i) => {
    const { frame, row } = rowAt(area, L, i);
    for (let c = area.start.channel; c <= area.end.channel; ++c) {
      const cell = writes.get(frame, c, row);
      const [first, last] = fieldsOf(area, c);
      copyFields(cell, i + gone < rows.length ? rows[i + gone][c - area.start.channel] : EMPTY_CELL, first, last);
      writes.set(frame, c, row, cell);
    }
  });
  return writes.list();
}

// ---- the Pattern menu ---------------------------------------------------------------------------

// Pattern > Interpolate (CPActionInterpolate): each field shown, from the value at the top
// of the selection to the one at the bottom, where both have one (notes, instruments,
// volumes, the parameters of the same effect)
export function interpolate(track, sel) {
  const L = track.rows;
  const size = selectionLength(sel, L);
  const writes = new Writes(track);
  const top = rowAt(sel, L, 0), bottom = rowAt(sel, L, size - 1);
  for (let c = sel.start.channel; c <= sel.end.channel; ++c) {
    for (let field = 0; field <= shownField(track.effColumns[c]); ++field) {
      if (!fieldSelected(sel, c, field))
        continue;
      const from = track.cell(top.frame, c, top.row), to = track.cell(bottom.frame, c, bottom.row);
      let startLo, endLo, startHi = 0, endHi = 0, effect = EF.NONE;
      if (field === FIELD.NOTE) {
        if (!isNote(from[0]) || !isNote(to[0]))
          continue;
        startLo = midiNote(from[1], from[0]);
        endLo = midiNote(to[1], to[0]);
      } else if (field === FIELD.INSTRUMENT) {
        if (from[3] >= MAX_INSTRUMENTS || to[3] >= MAX_INSTRUMENTS)
          continue;
        startLo = from[3];
        endLo = to[3];
      } else if (field === FIELD.VOLUME) {
        if (from[2] === MAX_VOLUME || to[2] === MAX_VOLUME)
          continue;
        startLo = from[2];
        endLo = to[2];
      } else {
        const e = field - FIELD.EFFECT;
        if (from[4 + e] === EF.NONE || from[4 + e] !== to[4 + e])
          continue;
        effect = from[4 + e];
        startLo = from[8 + e];
        endLo = to[8 + e];
        if (TWO_PARAM.has(effect)) {
          startHi = Math.floor(startLo / 16);
          startLo %= 16;
          endHi = Math.floor(endLo / 16);
          endLo %= 16;
        }
      }
      // as the desktop adds them up, in doubles
      const deltaHi = (endHi - startHi) / (size - 1);
      const deltaLo = (endLo - startLo) / (size - 1);
      for (let i = 1; i < size - 1; ++i) {
        startLo += deltaLo;
        startHi += deltaHi;
        const { frame, row } = rowAt(sel, L, i);
        const cell = writes.get(frame, c, row);
        const value = Math.trunc(startLo);
        if (field === FIELD.NOTE) {
          cell[0] = value % NOTE_RANGE + 1;
          cell[1] = Math.floor(value / NOTE_RANGE);
        } else if (field === FIELD.INSTRUMENT) {
          cell[3] = value;
        } else if (field === FIELD.VOLUME) {
          cell[2] = value;
        } else {
          cell[4 + field - FIELD.EFFECT] = effect;
          cell[8 + field - FIELD.EFFECT] = (value + (Math.trunc(startHi) << 4)) & 0xFF;
        }
        writes.set(frame, c, row, cell);
      }
    }
  }
  return writes.list();
}

// Pattern > Reverse (CPActionReverse): the rows of the selection in the other order, in
// its columns
export function reverse(track, sel) {
  const rows = readRows(track, sel);
  const writes = new Writes(track);
  for (let a = 0, b = rows.length - 1; a < b; ++a, --b) {
    const pa = rowAt(sel, track.rows, a), pb = rowAt(sel, track.rows, b);
    for (let c = sel.start.channel; c <= sel.end.channel; ++c) {
      const [first, last] = fieldsOf(sel, c);
      const top = Uint8Array.from(rows[a][c - sel.start.channel]);
      const bottom = Uint8Array.from(rows[b][c - sel.start.channel]);
      copyFields(top, rows[b][c - sel.start.channel], first, last);
      copyFields(bottom, rows[a][c - sel.start.channel], first, last);
      writes.set(pa.frame, c, pa.row, top);
      writes.set(pb.frame, c, pb.row, bottom);
    }
  }
  return writes.list();
}

// Pattern > Replace Instrument (CPActionReplaceInst): every instrument in the selection's
// instrument columns becomes `instrument` (&& stays)
export function replaceInstrument(track, sel, instrument) {
  const writes = new Writes(track);
  const first = sel.start.channel + (fieldSelected(sel, sel.start.channel, FIELD.INSTRUMENT) ? 0 : 1);
  const last = sel.end.channel - (fieldSelected(sel, sel.end.channel, FIELD.INSTRUMENT) ? 0 : 1);
  for (let i = 0, length = selectionLength(sel, track.rows); i < length; ++i) {
    const { frame, row } = rowAt(sel, track.rows, i);
    for (let c = first; c <= last; ++c) {
      const cell = writes.get(frame, c, row);
      if (cell[3] !== NO_INSTRUMENT && cell[3] !== HOLD_INSTRUMENT && cell[3] !== instrument) {
        cell[3] = instrument;
        writes.set(frame, c, row, cell);
      }
    }
  }
  return writes.list();
}

// Pattern > Expand, Shrink and Stretch (CPActionStretch): the rows of the selection
// spread out by a map that says, row by row and over again, how many rows on the next
// one comes from (0: an empty row). Expand is [1, 0], Shrink [2].
export function stretch(track, sel, map) {
  const rows = readRows(track, sel);
  const writes = new Writes(track);
  let pos = 0, offset = 0;
  rows.forEach((_, t) => {
    const { frame, row } = rowAt(sel, track.rows, t);
    for (let c = sel.start.channel; c <= sel.end.channel; ++c) {
      const source = offset < rows.length && map[pos] > 0 ? rows[offset][c - sel.start.channel] : EMPTY_CELL;
      const cell = writes.get(frame, c, row);
      const [first, last] = fieldsOf(sel, c);
      copyFields(cell, source, first, last);
      writes.set(frame, c, row, cell);
    }
    offset += map[pos++];
    pos %= map.length;
  });
  return writes.list();
}

// The Stretch dialog's map: numbers 0 and up with spaces between, the first not 0; null
// when it is not one (CStretchDlg::UpdateStretch())
export function parseStretchMap(text) {
  if (!/^[0-9 ]*$/.test(text))
    return null;
  const map = text.split(' ').filter(Boolean).map(Number);
  return map.length && map[0] !== 0 ? map : null;
}

// What the first 16 rows become: the row of the selection each one takes, or -1 for an
// empty row (CStretchDlg::UpdateTest())
export function stretchTest(map, length = 16) {
  const out = [];
  for (let i = 0, count = 0, pos = 0; i < length; ++i) {
    out.push(count < length && map[pos] !== 0 ? count : -1);
    count += map[pos];
    if (++pos === map.length)
      pos = 0;
  }
  return out;
}

// The map that undoes one (CStretchDlg::OnBnClickedButtonStretchInvert())
export function invertStretchMap(map) {
  const out = [];
  for (let pos = 0; pos < map.length;) {
    const x = map[pos++];
    let y = 0;
    while (pos < map.length && map[pos] === 0) {
      ++pos;
      ++y;
    }
    out.push(y + 1);
    for (let i = 0; i < x - 1; ++i)
      out.push(0);
  }
  return out;
}

// Shift+F1-F4 (CPActionScrollValues): the instruments, volumes and effect parameters of
// the selection, or of the field at the cursor, by `amount`; at the cursor, the effects
// whose parameter is two digits change by the digit it is on. `wrap`: the desktop's "Wrap
// pattern values" (off), which wraps around instead of stopping at the ends.
export function scrollValues(track, sel, cursor, amount, wrap = false) {
  const singular = !sel;
  const area = sel ?? cursorSelection(cursor);
  const writes = new Writes(track);
  const step = (value, limit) => {
    const v = value + amount;
    return wrap ? ((v % limit) + limit) % limit : Math.max(0, Math.min(limit - 1, v));
  };
  const [startField, endField] = [fieldOfColumn(area.start.column), fieldOfColumn(area.end.column)];
  for (let i = 0, length = selectionLength(area, track.rows); i < length; ++i) {
    const { frame, row } = rowAt(area, track.rows, i);
    for (let c = area.start.channel; c <= area.end.channel; ++c) {
      // as the cell was, if two frames play the same pattern
      const cell = Uint8Array.from(track.cell(frame, c, row));
      for (let field = FIELD.INSTRUMENT; field <= LAST_FIELD; ++field) {
        if ((c === area.start.channel && field < startField) || (c === area.end.channel && field > endField))
          continue;
        if (field === FIELD.INSTRUMENT) {
          if (cell[3] !== NO_INSTRUMENT && cell[3] !== HOLD_INSTRUMENT)
            cell[3] = step(cell[3], MAX_INSTRUMENTS);
        } else if (field === FIELD.VOLUME) {
          if (cell[2] !== MAX_VOLUME)
            cell[2] = step(cell[2], MAX_VOLUME);
        } else {
          const e = field - FIELD.EFFECT;
          if (cell[4 + e] === EF.NONE)
            continue;
          if (singular && NIBBLE_PARAM.has(cell[4 + e])) {
            // the cursor on the high digit, or anywhere else
            let hi = cell[8 + e] >> 4, lo = cell[8 + e] & 15;
            if (cursor.column % 3 === 2)
              hi = step(hi, 16);
            else
              lo = step(lo, 16);
            cell[8 + e] = hi << 4 | lo;
          } else {
            cell[8 + e] = step(cell[8 + e], 256);
          }
        }
      }
      writes.set(frame, c, row, cell);
    }
  }
  return writes.list();
}

// Pattern > Transpose (CPActionTranspose): the notes of the selection, or the one at the
// cursor when it is in the note column, by `semitones`; at the cursor, an echo note (^n)
// reaches one row further or nearer
export function transpose(track, sel, cursor, semitones) {
  const singular = !sel;
  const area = sel ?? cursorSelection(cursor);
  const writes = new Writes(track);
  for (let i = 0, length = selectionLength(area, track.rows); i < length; ++i) {
    const { frame, row } = rowAt(area, track.rows, i);
    for (let c = area.start.channel; c <= area.end.channel; ++c) {
      if (!fieldSelected(area, c, FIELD.NOTE))
        continue;
      const cell = Uint8Array.from(track.cell(frame, c, row));
      if (cell[0] === NOTE.ECHO) {
        if (!singular)
          continue;
        cell[1] = Math.max(0, Math.min(ECHO_BUFFER_LENGTH, cell[1] + Math.sign(semitones)));
      } else if (isNote(cell[0])) {
        const value = Math.max(0, Math.min(NOTE_COUNT - 1, midiNote(cell[1], cell[0]) + semitones));
        cell[0] = value % NOTE_RANGE + 1;
        cell[1] = Math.floor(value / NOTE_RANGE);
      } else {
        continue;
      }
      writes.set(frame, c, row, cell);
    }
  }
  return writes.list();
}

// ---- Copy As -----------------------------------------------------------------------------------

// Edit > Copy As > Volume Sequence (CPatternEditor::GetVolumeColumn()): the volume each
// row of the selection's first channel plays at, as a volume sequence's text ("15 15 12 ").
// It starts from the last volume set before the selection (the desktop's looks at the same
// row of the frames before), else 15.
export function volumeSequence(track, sel) {
  const L = track.rows;
  const channel = sel.start.channel;
  let volume = MAX_VOLUME - 1;
  for (let at = sel.start.frame * L + sel.start.row - 1; at >= 0; --at) {
    const v = track.cell(Math.floor(at / L), channel, at % L)[2];
    if (v !== MAX_VOLUME) {
      volume = v;
      break;
    }
  }
  let text = '';
  for (let i = 0, length = selectionLength(sel, L); i < length; ++i) {
    const { frame, row } = rowAt(sel, L, i);
    const v = track.cell(frame, channel, row)[2];
    if (v !== MAX_VOLUME)
      volume = v;
    text += `${volume} `;
  }
  return text;
}

const hex = (value, digits) => value.toString(16).toUpperCase().padStart(digits, '0');
const TEXT_NOTE = ['...', 'C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-', '===', '---', '^-'];

// A cell as the text export writes it (CTextExport::ExportCellText())
export function cellText(cell, effects, noise, letters) {
  let s = cell[0] <= NOTE.ECHO ? TEXT_NOTE[cell[0]] : '...';
  if (isNote(cell[0]) || cell[0] === NOTE.ECHO)
    s = noise ? `${hex((cell[0] - 1 + cell[1] * NOTE_RANGE) & 15, 1)}-#` : s + cell[1];
  s += cell[3] === NO_INSTRUMENT ? ' ..' : cell[3] === HOLD_INSTRUMENT ? ' &&' : ` ${hex(cell[3], 2)}`;
  s += cell[2] === MAX_VOLUME ? ' .' : ` ${hex(cell[2] & 15, 1)}`;
  for (let e = 0; e < effects; ++e)
    s += cell[4 + e] ? ` ${letters[cell[4 + e]] || '?'}${hex(cell[8 + e], 2)}` : ' ...';
  return s;
}

// Edit > Copy As > Plain Text (CPatternEditor::GetSelectionAsText()): a header with the
// channels and the selection's rows in the text export's form, the columns left of the
// selection blanked and those right of it cut off. names: the channels' names; letters:
// the effect letters by number.
export function selectionText(track, sel, names, letters) {
  const L = track.rows;
  const length = selectionLength(sel, L);
  let digits = 0;
  for (let size = length - 1; ; size >>= 4) {
    ++digits;
    if (!(size >> 4))
      break;
  }
  digits = Math.max(2, digits);
  const startField = fieldOfColumn(sel.start.column), endField = fieldOfColumn(sel.end.column);
  let header = `${' '.repeat(digits + 3)}# `;
  for (let c = sel.start.channel; c <= sel.end.channel; ++c) {
    header += `: ${names[c].padEnd(13)}`;
    let columns = track.effColumns[c] - 1;
    if (c === sel.end.channel)
      columns = Math.min(columns, Math.max(0, endField - 3));
    for (let j = 0; j < columns; ++j)
      header += `fx${j + 2} `;
  }
  const lines = [header.trimEnd()];
  const POSITION = [0, 4, 7, 9, 13, 17, 21], WIDTH = [3, 2, 1, 3, 3, 3, 3];
  for (let i = 0; i < length; ++i) {
    const { frame, row } = rowAt(sel, L, i);
    let line = `ROW ${hex(i, digits)}`;
    for (let c = sel.start.channel; c <= sel.end.channel; ++c) {
      let text = cellText(track.cell(frame, c, row), track.effColumns[c], track.ids[c] === CHANNEL_ID.NOISE, letters);
      if (c === sel.start.channel)
        for (let f = 0; f < startField; ++f)
          text = text.slice(0, POSITION[f]) + ' '.repeat(WIDTH[f]) + text.slice(POSITION[f] + WIDTH[f]);
      if (c === sel.end.channel && endField < LAST_FIELD)
        text = text.slice(0, POSITION[endField + 1] - 1);
      line += ` : ${text}`;
    }
    lines.push(line);
  }
  return lines.join('\n') + '\n';
}

// The letter PPMCK names a channel by (CPatternEditor::GetSelectionAsPPMCK())
const PPMCK_CHANNEL = { 0: ['A', 0], 1: ['M', 5], 2: ['G', 19], 4: ['F', 18], 8: ['a', 8], 16: ['P', 11], 32: ['X', 25] };

// Edit > Copy As > PPMCK MML Data: a line of MML for each channel of the selection, a
// sixteenth note a row. (The desktop's starts with an "r" of no length, which MML reads as a
// rest of the default length, when the selection starts on a note; that one is left out.)
export function selectionMml(track, sel, chips) {
  const L = track.rows;
  const length = selectionLength(sel, L);
  const lines = [];
  for (let c = sel.start.channel; c <= sel.end.channel; ++c) {
    const [letter, base] = PPMCK_CHANNEL[chips[c]] ?? ['A', 0];
    let text = `${String.fromCharCode(letter.charCodeAt(0) + track.ids[c] - base)}\t`;
    let octave = -1, len = -1, first = true;
    let current = { note: NOTE.HALT, octave: 0, volume: MAX_VOLUME };
    const echo = Array.from({ length: ECHO_BUFFER_LENGTH + 1 }, () => ({ note: NOTE.NONE, octave: 0, volume: MAX_VOLUME }));
    for (let i = 0; i < length; ++i) {
      ++len;
      const { frame, row } = rowAt(sel, L, i);
      const cell = track.cell(frame, c, row);
      const dump = cell[0] !== NOTE.NONE || cell[2] !== MAX_VOLUME;
      const fin = i === length - 1;
      if (!dump && !fin) {
        first = false;
        continue;
      }
      const push = current.note !== NOTE.NONE && current.note !== NOTE.RELEASE;
      if (current.volume !== MAX_VOLUME)
        text += `v${current.volume}`;
      if (current.note === NOTE.ECHO)
        current = { ...current, ...echo[current.octave], volume: current.volume };
      if (push) {
        echo.pop();
        echo.unshift({ ...current });
      }
      if (!first) {
        switch (current.note) {
          case NOTE.NONE: text += 'w'; break;
          case NOTE.RELEASE: text += 'k'; break;
          case NOTE.HALT: text += 'r'; break;
          default:
            if (octave === -1) {
              octave = current.octave;
              text += `o${octave}`;
            } else {
              for (; octave < current.octave; ++octave)
                text += '>';
              for (; octave > current.octave; --octave)
                text += '<';
            }
            text += String.fromCharCode(Math.floor((current.note * 7 + 18) / 12) % 7 + 97);
            if ((current.note * 7 + 6) % 12 >= 7)
              text += '#';
        }
        if (fin)
          ++len;
        for (; len >= 32; len -= 16)
          text += '1^';
        for (let l = 16; l;) {
          if (!(len & l)) {
            l >>= 1;
            continue;
          }
          text += 16 / l;
          do {
            len -= l;
            l >>= 1;
            if (len & l)
              text += '.';
          } while (len & l);
          if (len)
            text += '^';
        }
      } else if (fin) {
        // a selection of one row
        ++len;
      }
      current = { note: cell[0], octave: cell[1], volume: cell[2] };
      first = false;
    }
    lines.push(text);
  }
  return lines.join('\n') + '\n';
}

// ---- Find / Replace -------------------------------------------------------------------------

// What a query cannot be: thrown with a code the editor has a text for, and its values
export class QueryError extends Error {
  constructor(code, ...values) {
    super(code);
    this.code = code;
    this.values = values;
  }
}

// CharRange: a value or a range of them, either way round
class Range {
  constructor(min = 0, max = 255) {
    this.min = min;
    this.max = max;
  }

  set(value, half = false) {
    if (!half)
      this.min = value;
    this.max = value;
  }

  match(value) {
    return (value >= this.min && value <= this.max) || (value >= this.max && value <= this.min);
  }

  get single() {
    return this.min === this.max;
  }
}

// The terms' fields (WC_*): which of them a query says something about
const WC = { NOTE: 0, OCT: 1, INST: 2, VOL: 3, EFF: 4, PARAM: 5 };

function newTerm() {
  return {
    note: new Range(), oct: new Range(), inst: new Range(0, MAX_INSTRUMENTS), vol: new Range(0, MAX_VOLUME),
    effects: new Array(EF.COUNT).fill(false), param: new Range(), definite: new Array(6).fill(false), noise: false,
  };
}

const NOTE_LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NOTE_OFFSET = [1, 3, 5, 6, 8, 10, 12];
const NOTE_SIGNS = ['b', '-', '#'];
const parseHex = text => {
  const value = parseInt(text, 16);
  return Number.isNaN(value) ? 0 : value;
};

// A note query (CFindDlg::ParseNote()): C-4, C#4, Db4 (or a note letter alone, any octave),
// a number of notes from C-0, --- (cut), === (release), ^n (echo), x-# (noise), . (any);
// `half`: the second field of a range
function parseNote(term, text, half) {
  if (!half)
    term.definite[WC.NOTE] = term.definite[WC.OCT] = false;
  if (!text) {
    if (!half) {
      term.definite[WC.NOTE] = term.definite[WC.OCT] = true;
      term.note.set(NOTE.NONE);
      term.oct.set(0);
    }
    return;
  }
  if (half && (!term.note.single || !term.oct.single))
    throw new QueryError('rangeWildcard');
  if (text === '-' || text === '---') {
    if (half)
      throw new QueryError('rangeCut');
    term.definite[WC.NOTE] = term.definite[WC.OCT] = true;
    term.note.set(NOTE.HALT);
    term.oct = new Range(0, 7);
    return;
  }
  if (text === '=' || text === '===') {
    if (half)
      throw new QueryError('rangeRelease');
    term.definite[WC.NOTE] = term.definite[WC.OCT] = true;
    term.note.set(NOTE.RELEASE);
    term.oct = new Range(0, 7);
    return;
  }
  if (text === '.') {
    if (half)
      throw new QueryError('rangeWildcard');
    term.definite[WC.NOTE] = true;
    term.note = new Range(NOTE.NONE + 1, NOTE.ECHO);
    return;
  }
  if (text[0] === '^') {
    if (half && !term.definite[WC.OCT])
      throw new QueryError('rangeWildcard');
    term.definite[WC.NOTE] = term.definite[WC.OCT] = true;
    term.note.set(NOTE.ECHO);
    let rest = text.slice(1);
    if (rest) {
      if (rest[0] === '-')
        rest = rest.slice(1);
      const value = parseInt(rest, 10) || 0;
      if (value > ECHO_BUFFER_LENGTH)
        throw new QueryError('echoRange', rest, ECHO_BUFFER_LENGTH);
      term.oct.set(value, half);
    } else {
      term.oct = new Range(0, ECHO_BUFFER_LENGTH);
    }
    return;
  }
  if (text.slice(1, 3) !== '-#') {
    const letter = NOTE_LETTERS.indexOf(text[0].toUpperCase());
    if (letter >= 0) {
      term.definite[WC.NOTE] = true;
      let note = NOTE_OFFSET[letter];
      let octave = 0;
      let rest = text;
      const sign = NOTE_SIGNS.indexOf(text[1]);
      if (sign >= 0) {
        note += sign - 1;
        rest = rest.slice(1);
      }
      rest = rest.slice(1);
      if (rest) {
        term.definite[WC.OCT] = true;
        if (!/^[0-9]+$/.test(rest))
          throw new QueryError('octaveUnknown');
        octave = parseInt(rest, 10);
        if (octave >= OCTAVES)
          throw new QueryError('octaveRange', rest, OCTAVES - 1);
        term.oct.set(octave, half);
      } else if (half) {
        throw new QueryError('rangeWildcard');
      }
      for (; note > NOTE_RANGE; note -= NOTE_RANGE)
        if (term.definite[WC.OCT])
          term.oct.set(++octave, half);
      for (; note < NOTE.C; note += NOTE_RANGE)
        if (term.definite[WC.OCT])
          term.oct.set(--octave, half);
      term.note.set(note, half);
      if (term.definite[WC.OCT] && (octave >= OCTAVES || octave < 0))
        throw new QueryError('octaveOver', rest);
      return;
    }
  }
  if (text.length === 3 && text.slice(1) === '-#') {
    term.definite[WC.NOTE] = term.definite[WC.OCT] = true;
    if (text[0] === '.') {
      term.note = new Range(1, 4);
      term.oct = new Range(0, 1);
    } else {
      const value = parseHex(text[0]);
      term.note.set(value % NOTE_RANGE + 1, half);
      term.oct.set(Math.floor(value / NOTE_RANGE), half);
    }
    term.noise = true;
    return;
  }
  if (/^[0-9]+$/.test(text)) {
    const value = parseInt(text, 10);
    if (value >= NOTE_COUNT)
      throw new QueryError('noteValueRange', text, NOTE_COUNT - 1);
    term.definite[WC.NOTE] = term.definite[WC.OCT] = true;
    term.note.set(value % NOTE_RANGE + 1, half);
    term.oct.set(Math.floor(value / NOTE_RANGE), half);
    return;
  }
  throw new QueryError('noteUnknown');
}

// An instrument (hex, && for hold, . for any; nothing: no instrument)
function parseInstrument(term, text, half) {
  term.definite[WC.INST] = true;
  if (!text) {
    if (!half)
      term.inst.set(NO_INSTRUMENT);
    return;
  }
  if (half && !term.inst.single)
    throw new QueryError('rangeWildcard');
  if (text === '.') {
    if (half)
      throw new QueryError('rangeWildcard');
    term.inst = new Range(0, MAX_INSTRUMENTS - 1);
  } else if (text === '&&') {
    if (half)
      throw new QueryError('rangeHold');
    term.inst.set(HOLD_INSTRUMENT);
  } else {
    const value = parseHex(text) & 0xFF;
    if (value >= MAX_INSTRUMENTS)
      throw new QueryError('instrumentRange', text, hex(MAX_INSTRUMENTS - 1, 1));
    term.inst.set(value, half);
  }
}

// A volume (hex, . for any; nothing: no volume)
function parseVolume(term, text, half) {
  term.definite[WC.VOL] = true;
  if (!text) {
    if (!half)
      term.vol.set(MAX_VOLUME);
    return;
  }
  if (half && !term.vol.single)
    throw new QueryError('rangeWildcard');
  if (text === '.') {
    if (half)
      throw new QueryError('rangeWildcard');
    term.vol = new Range(0, MAX_VOLUME - 1);
  } else {
    const value = parseHex(text) & 0xFF;
    if (value >= MAX_VOLUME)
      throw new QueryError('volumeRange', text, hex(MAX_VOLUME - 1, 1));
    term.vol.set(value, half);
  }
}

// An effect: its letter and maybe its parameter (F06, F), . for any, nothing for none.
// (The desktop's does not see that a letter is no effect, and looks for the parameter
// alone then.)
function parseEffect(term, text, letters) {
  if (text.length === 2)
    throw new QueryError('effectShort', text[0]);
  if (!text) {
    term.definite[WC.EFF] = term.definite[WC.PARAM] = true;
    term.effects[EF.NONE] = true;
    term.param.set(0);
  } else if (text === '.') {
    term.definite[WC.EFF] = true;
    term.effects.fill(true, 1);
  } else if (text[0] !== '.') {
    for (let i = 1; i < EF.COUNT; ++i)
      if (letters[i] === text[0]) {
        term.definite[WC.EFF] = true;
        term.effects[i] = true;
      }
    if (!term.definite[WC.EFF])
      throw new QueryError('effectUnknown', text[0]);
  }
  if (text.length > 1) {
    term.definite[WC.PARAM] = true;
    term.param.set(parseHex(text.slice(-2)) & 0xFF);
  }
}

const anything = term => term.definite.some(Boolean);

// The query of the Find fields (CFindDlg::GetFindTerm()): fields {note: [from, to], inst:
// [from, to], vol: [from, to], effect: text}, each there when it is ticked; letters: the
// effect letters by number
export function findTerm(fields, letters) {
  const term = newTerm();
  const range = (parse, [from = '', to = '']) => {
    parse(term, from, false);
    parse(term, to, !!from);
  };
  if (fields.note) {
    range(parseNote, fields.note);
    const echoAndNote = (term.note.min === NOTE.ECHO && isNote(term.note.max)) || (term.note.max === NOTE.ECHO && isNote(term.note.min));
    if (echoAndNote && term.definite[WC.OCT])
      throw new QueryError('echoAndNotes');
  }
  if (fields.inst)
    range(parseInstrument, fields.inst);
  if (fields.vol)
    range(parseVolume, fields.vol);
  if (fields.effect !== undefined)
    parseEffect(term, fields.effect, letters);
  if (!anything(term))
    throw new QueryError('findEmpty');
  return term;
}

// The replacement (CFindDlg::GetReplaceTerm()): fields {note, inst, vol, effect} as texts;
// `removeOriginal`: what is found is cleared before the replacement goes in
export function replaceTerm(fields, letters, removeOriginal) {
  const term = newTerm();
  if (fields.note !== undefined)
    parseNote(term, fields.note, false);
  if (fields.inst !== undefined)
    parseInstrument(term, fields.inst, false);
  if (fields.vol !== undefined)
    parseVolume(term, fields.vol, false);
  if (fields.effect !== undefined)
    parseEffect(term, fields.effect, letters);
  if (!anything(term))
    throw new QueryError('replaceEmpty');
  if ((term.note.min === NOTE.HALT || term.note.min === NOTE.RELEASE) && term.note.single)
    term.oct = new Range(0, 0);
  const d = term.definite;
  if ((d[WC.NOTE] && !term.note.single) || (d[WC.OCT] && !term.oct.single) || (d[WC.INST] && !term.inst.single) ||
      (d[WC.VOL] && !term.vol.single) || (d[WC.PARAM] && !term.param.single))
    throw new QueryError('replaceWildcard');
  if (removeOriginal) {
    if (d[WC.NOTE] && !d[WC.OCT])
      throw new QueryError('removeNoOctave');
    if (d[WC.EFF] && !d[WC.PARAM])
      throw new QueryError('removeNoParameter');
  }
  return {
    note: term.note.min, octave: term.oct.min, inst: term.inst.min, vol: term.vol.min,
    effect: Math.max(0, term.effects.indexOf(true)), param: term.param.min, definite: [...term.definite], noise: term.noise,
  };
}

// Whether a cell is what the query looks for (CFindDlg::CompareFields()): `effects` the
// channel's effect columns (1-4), `column` the effect column looked in (0-3, 4: all of
// them), `negate`: the cells that are not
export function matchesTerm(term, cell, { noise, effects, column = 4, negate = false }) {
  const effCount = effects - 1;
  if (column > effCount && column !== 4)
    column = effCount;
  const melodic = isNote(term.note.min) && isNote(term.note.max) && term.definite[WC.OCT];
  if (term.definite[WC.NOTE]) {
    if (term.noise) {
      if (!noise && melodic)
        return false;
      if (!isNote(term.note.min) || !isNote(term.note.max)) {
        if (!term.note.match(cell[0]))
          return negate;
      } else {
        const value = midiNote(cell[1], cell[0]) % 16;
        const low = midiNote(term.oct.min, term.note.min) % 16, high = midiNote(term.oct.max, term.note.max) % 16;
        if ((value < low && value < high) || (value > low && value > high))
          return negate;
      }
    } else {
      if (noise && melodic)
        return false;
      if (melodic) {
        if (!isNote(cell[0]))
          return negate;
        const value = midiNote(cell[1], cell[0]);
        const low = midiNote(term.oct.min, term.note.min), high = midiNote(term.oct.max, term.note.max);
        if ((value < low && value < high) || (value > low && value > high))
          return negate;
      } else {
        if (!term.note.match(cell[0]))
          return negate;
        if (term.definite[WC.OCT] && !term.oct.match(cell[1]))
          return negate;
      }
    }
  }
  if (term.definite[WC.INST] && !term.inst.match(cell[3]))
    return negate;
  if (term.definite[WC.VOL] && !term.vol.match(cell[2]))
    return negate;
  const limit = Math.min(3, effCount, column);
  let effect = false;
  for (let i = column % 4; i <= limit; ++i)
    if ((!term.definite[WC.EFF] || term.effects[cell[4 + i]]) && (!term.definite[WC.PARAM] || term.param.match(cell[8 + i])))
      effect = true;
  return effect ? !negate : negate;
}

// The cell that replaces one found (CFindDlg::Replace()): `effectOf(letter)` the effect a
// letter is on the channel's chip
export function replaceCell(cell, term, replacement, { effects, column = 4, removeOriginal = false, effectOf }) {
  const out = removeOriginal ? Uint8Array.from(EMPTY_CELL) : Uint8Array.from(cell);
  const d = replacement.definite;
  if (d[WC.NOTE])
    out[0] = replacement.note;
  if (d[WC.OCT])
    out[1] = replacement.octave;
  if (d[WC.INST])
    out[3] = replacement.inst;
  if (d[WC.VOL])
    out[2] = replacement.vol;
  if (d[WC.EFF] || d[WC.PARAM]) {
    const columns = [];
    if (column < 4)
      columns.push(column);
    else
      for (let i = 0; i < effects; ++i)
        if ((!term.definite[WC.EFF] || term.effects[out[4 + i]]) && (!term.definite[WC.PARAM] || term.param.match(out[8 + i])))
          columns.push(i);
    if (d[WC.EFF]) {
      const effect = effectOf(replacement.effect);
      for (const i of columns)
        out[4 + i] = effect;
    }
    if (d[WC.PARAM])
      for (const i of columns)
        out[8 + i] = replacement.param;
  }
  return out;
}

// The cells of a search's area in the order it goes through them (CFindCursor):
// row by row across the channels, or channel by channel down the rows (`vertical`);
// area: a normalized selection (columns do not count)
export function* searchOrder(area, rows, vertical) {
  const length = selectionLength(area, rows);
  if (vertical) {
    for (let c = area.start.channel; c <= area.end.channel; ++c)
      for (let i = 0; i < length; ++i)
        yield { ...rowAt(area, rows, i), channel: c };
  } else {
    for (let i = 0; i < length; ++i)
      for (let c = area.start.channel; c <= area.end.channel; ++c)
        yield { ...rowAt(area, rows, i), channel: c };
  }
}

// ---- bookmarks ---------------------------------------------------------------------------------

// How far back `b` is from `a` in the song, the desktop's way (CBookmark::Distance()): rows
// as if every pattern had 256, wrapping around
const ALL_ROWS = 256 * 256;
const distance = (a, b) => ((((a.frame - b.frame) * 256 + a.row - b.row) % ALL_ROWS) + ALL_ROWS) % ALL_ROWS;

// The bookmark after a place, or before it, wrapping around; the one at the place itself
// comes last (CBookmarkCollection::FindNext(), FindPrevious())
export function nextBookmark(list, frame, row) {
  return nearest(list, mark => (distance(mark, { frame, row }) - 1) >>> 0);
}

export function previousBookmark(list, frame, row) {
  return nearest(list, mark => (distance({ frame, row }, mark) - 1) >>> 0);
}

function nearest(list, measure) {
  let best = null, bestDistance = 0;
  for (const mark of list) {
    const d = measure(mark);
    if (!best || d < bestDistance) {
      best = mark;
      bestDistance = d;
    }
  }
  return best;
}

export const bookmarkAt = (list, frame, row) => list.find(mark => mark.frame === frame && mark.row === row) ?? null;

// The row highlight at a place (CFamiTrackerDoc::GetHighlightAt()): from the nearest
// bookmark at or before it, the beat and bar it sets (in its frame, or on with "persist"),
// counted from its row; `highlight`: the track's [beat, bar]
export function highlightAt(list, highlight, frame, row) {
  const out = { first: highlight[0], second: highlight[1], offset: 0 };
  if (list.length) {
    const here = { frame, row };
    let min = distance(here, { frame: 0, row: 0 });
    for (const mark of list) {
      const d = distance(here, mark);
      if (d <= min) {
        min = d;
        if (mark.highlight[0] !== -1 && (mark.persist || mark.frame === frame))
          out.first = mark.highlight[0];
        if (mark.highlight[1] !== -1 && (mark.persist || mark.frame === frame))
          out.second = mark.highlight[1];
        out.offset = mark.row;
      }
    }
  }
  return out;
}

// 2 for a bar row, 1 for a beat, 0 for the rest (GetHighlightState(), with its unsigned
// arithmetic)
export function highlightState(hl, row) {
  const at = (row - hl.offset) >>> 0;
  if (hl.second > 0 && at % hl.second === 0)
    return 2;
  if (hl.first > 0 && at % hl.first === 0)
    return 1;
  return 0;
}

// What the Bookmark Manager makes of a frame and row typed in: the frame within the
// track, and a row past the end of its frame in the frames after (CBookmarkDlg::MakeBookmark())
export function bookmarkPlace(frame, row, frames, rows) {
  frame %= frames;
  while (row >= rows) {
    row -= rows;
    if (++frame >= frames)
      frame = 0;
  }
  return { frame, row };
}

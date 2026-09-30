// Dn-FamiTracker web port - the editor's copy of the module.
//
// The module itself lives in the worker; the page keeps what it shows (the song's
// settings, the frame lists and the patterns of the tracks it opened) and changes both
// together, so drawing never waits for the worker. Cells are the 12 bytes the session
// uses (src/session_bindings.cpp).

export const CELL = 12;

// FamiTrackerTypes.h
export const NOTE = { NONE: 0, C: 1, B: 12, RELEASE: 13, HALT: 14, ECHO: 15 };
export const MAX_VOLUME = 16;
export const NO_INSTRUMENT = 64;
export const HOLD_INSTRUMENT = 0xFF;
export const MAX_INSTRUMENTS = 64;
export const MAX_FRAMES = 256;
export const MAX_PATTERNS = 256;
export const MAX_ROWS = 256;
export const EFFECT_COLUMNS = 4;
export const OCTAVES = 8;

// APU/Types.h
export const CHIP = { NONE: 0, VRC6: 1, VRC7: 2, FDS: 4, MMC5: 8, N163: 16, S5B: 32 };
export const CHANNEL_ID = { NOISE: 3, DPCM: 4 };
// Instrument.h
export const INST = { NONE: 0, '2A03': 1, VRC6: 2, VRC7: 3, FDS: 4, N163: 5, S5B: 6 };
// Instruments with volume, arpeggio, pitch, hi-pitch and duty sequences (numbered ones, the
// module's; the FDS's are its own)
export const SEQUENCE_INSTRUMENTS = new Set([INST['2A03'], INST.VRC6, INST.N163, INST.S5B]);
// The chip whose channels play an instrument of the kind
export const INSTRUMENT_CHIP = {
  [INST['2A03']]: CHIP.NONE, [INST.VRC6]: CHIP.VRC6, [INST.VRC7]: CHIP.VRC7,
  [INST.FDS]: CHIP.FDS, [INST.N163]: CHIP.N163, [INST.S5B]: CHIP.S5B,
};

// The desktop's note keys, by the key's place on the keyboard: [semitone, octave offset]
export const NOTE_KEYS = {
  KeyZ: [0, 0], KeyS: [1, 0], KeyX: [2, 0], KeyD: [3, 0], KeyC: [4, 0], KeyV: [5, 0], KeyG: [6, 0],
  KeyB: [7, 0], KeyH: [8, 0], KeyN: [9, 0], KeyJ: [10, 0], KeyM: [11, 0],
  Comma: [0, 1], KeyL: [1, 1], Period: [2, 1], Semicolon: [3, 1], Slash: [4, 1],
  KeyQ: [0, 1], Digit2: [1, 1], KeyW: [2, 1], Digit3: [3, 1], KeyE: [4, 1], KeyR: [5, 1], Digit5: [6, 1],
  KeyT: [7, 1], Digit6: [8, 1], KeyY: [9, 1], Digit7: [10, 1], KeyU: [11, 1],
  KeyI: [0, 2], Digit9: [1, 2], KeyO: [2, 2], Digit0: [3, 2], KeyP: [4, 2],
  BracketLeft: [5, 2], Equal: [6, 2], BracketRight: [7, 2],
};

export const EMPTY_CELL = Uint8Array.of(NOTE.NONE, 0, MAX_VOLUME, NO_INSTRUMENT, 0, 0, 0, 0, 0, 0, 0, 0);

export function emptyPattern(rows) {
  const data = new Uint8Array(rows * CELL);
  for (let r = 0; r < rows; ++r)
    data.set(EMPTY_CELL, r * CELL);
  return data;
}

export function isEmptyCell(cell) {
  return cell[0] === NOTE.NONE && cell[2] === MAX_VOLUME && cell[3] === NO_INSTRUMENT &&
    !cell[4] && !cell[5] && !cell[6] && !cell[7];
}

export class Song {
  constructor(snapshot) {
    this.info = snapshot.info;
    this.instruments = snapshot.instruments;
    this.effects = snapshot.effects;
    this.modified = snapshot.modified;
    this.tracks = [];
    snapshot.tracks.forEach((data, t) => this.setTrackData(t, data));
  }

  get channels() {
    return this.info.channels;
  }

  // What the worker's trackData() returned
  setTrackData(t, { track, patterns }) {
    const map = new Map();
    for (const p of patterns)
      map.set(p.channel * MAX_PATTERNS + p.pattern, p.data);
    this.tracks[t] = { ...track, patterns: map };
  }

  track(t) {
    return this.tracks[t];
  }

  patternAt(t, frame, channel) {
    const track = this.tracks[t];
    return track.frameList[frame * this.channels.length + channel];
  }

  // A pattern's cells, or null while it is empty
  patternData(t, channel, pattern) {
    return this.tracks[t].patterns.get(channel * MAX_PATTERNS + pattern) ?? null;
  }

  // A pattern's cells, made (empty) to be written to
  writablePattern(t, channel, pattern) {
    const track = this.tracks[t];
    const key = channel * MAX_PATTERNS + pattern;
    let data = track.patterns.get(key);
    if (!data) {
      data = emptyPattern(track.rows);
      track.patterns.set(key, data);
    }
    return data;
  }

  // The cell (a view into the pattern, or the empty cell) at a place in the song
  cell(t, frame, channel, row) {
    const data = this.patternData(t, channel, this.patternAt(t, frame, channel));
    return data ? data.subarray(row * CELL, row * CELL + CELL) : EMPTY_CELL;
  }

  // Cells of rows [row, row + count) of a pattern, copied
  readCells(t, channel, pattern, row, count) {
    const data = this.patternData(t, channel, pattern);
    if (!data)
      return emptyPattern(count);
    const out = new Uint8Array(count * CELL);
    out.set(data.subarray(row * CELL, (row + count) * CELL));
    return out;
  }

  writeCells(t, channel, pattern, row, cells) {
    this.writablePattern(t, channel, pattern).set(cells, row * CELL);
  }

  instrument(index) {
    return this.instruments.find(i => i.index === index) ?? null;
  }
}

// Undo and redo of actions: {undo(), redo(), label}. An action is done when it is
// recorded.
export class History {
  constructor(limit = 500) {
    this.limit = limit;
    this.done = [];
    this.undone = [];
  }

  record(action) {
    this.done.push(action);
    if (this.done.length > this.limit)
      this.done.shift();
    this.undone = [];
  }

  undo() {
    const action = this.done.pop();
    if (!action)
      return null;
    action.undo();
    this.undone.push(action);
    return action;
  }

  redo() {
    const action = this.undone.pop();
    if (!action)
      return null;
    action.redo();
    this.done.push(action);
    return action;
  }

  clear() {
    this.done = [];
    this.undone = [];
  }
}

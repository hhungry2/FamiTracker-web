// Rebuild a frame-per-row NSF import as a separate track. No sound changes are
// discarded: empty time after an event becomes its row duration (Fxx). The original
// track and all instruments stay available. This first pass does not infer macros.

import { CELL, NOTE, MAX_ROWS, MAX_FRAMES, EFFECT_COLUMNS, emptyPattern, isEmptyCell } from './dnft-song.mjs';

const SPEED = 1, JUMP = 2, SKIP = 3, HALT = 4;
// Only effects produced by nsf_import.cpp. Edited timing, delayed notes, echoes and
// grooves need a different analysis; accepting them would make empty rows unsafe.
const IMPORT_EFFECTS = new Set([JUMP, SKIP, HALT, 8, 9, 13, 15, 18, 26, 27, 28, 30, 31, 32, 33, 42]);
const fail = () => { throw new Error('nsfReconstructUnsupported'); };
const emptyRow = cells => cells.every(isEmptyCell);
const hasRoom = cells => cells.some(cell => Array.from(cell.subarray(4, 8)).includes(0));

function addEffect(cells, effect, param) {
  // Prefer the channel needing the fewest displayed effect columns.
  const choices = cells.map((cell, channel) => ({ channel, column: cell.subarray(4, 8).indexOf(0) }))
    .filter(place => place.column >= 0).sort((a, b) => a.column - b.column || a.channel - b.channel);
  if (!choices.length)
    fail();
  const { channel, column } = choices[0];
  cells[channel][4 + column] = effect;
  cells[channel][8 + column] = param;
}

function removeEffect(cells, effect) {
  for (const cell of cells)
    for (let e = 0; e < EFFECT_COLUMNS; ++e)
      if (cell[4 + e] === effect)
        cell[4 + e] = cell[8 + e] = 0;
}

function setEffect(cells, effect, param) {
  for (const cell of cells)
    for (let e = 0; e < EFFECT_COLUMNS; ++e)
      if (cell[4 + e] === effect) {
        cell[8 + e] = param;
        return;
      }
  addEffect(cells, effect, param);
}

// Flatten only the flow emitted by the NSF importer: linear frames, an optional
// D00 before the loop, then one backward Bxx or C00. Stop before unplayed padding.
function readTimeline(session, trackIndex, track, channels) {
  const rows = [], starts = new Map(), skips = [];
  const patterns = new Map();
  let loopRow = -1, stops = false, ended = false;
  for (let f = 0; f < track.frames && !ended; ++f) {
    starts.set(f, rows.length);
    for (let r = 0; r < track.rows; ++r) {
      const cells = channels.map((_, c) => {
        const p = track.frameList[f * channels.length + c];
        const key = c * MAX_FRAMES + p;
        if (!patterns.has(key))
          patterns.set(key, session.pattern(trackIndex, c, p));
        return Uint8Array.from(patterns.get(key).subarray(r * CELL, (r + 1) * CELL));
      });
      let control = null;
      for (let c = 0; c < cells.length; ++c) {
        const cell = cells[c];
        if (cell[0] > NOTE.HALT)
          fail();
        for (let e = 0; e < EFFECT_COLUMNS; ++e) {
          const effect = cell[4 + e], param = cell[8 + e];
          if (effect && (e >= track.effColumns[c] || !IMPORT_EFFECTS.has(effect)))
            fail();
          if (effect >= JUMP && effect <= HALT) {
            if (control)
              fail();
            control = { effect, param };
          }
        }
      }
      rows.push(cells);
      if (!control)
        continue;
      if (control.effect === SKIP) {
        if (control.param !== 0)
          fail();
        skips.push(rows.length);
        break;
      }
      if (control.effect === JUMP) {
        if (!starts.has(control.param))
          fail();
        loopRow = starts.get(control.param);
      } else {
        stops = true;
      }
      ended = true;
      break;
    }
  }
  // A full track with no end command naturally wraps to frame 0.
  if (!ended)
    loopRow = 0;
  if (skips.length && (skips.length !== 1 || skips[0] !== loopRow))
    fail();
  return { rows, loopRow, stops };
}

export function planNsfReconstruction(session, trackIndex) {
  const info = session.info(), track = session.track(trackIndex);
  if (!info.comment.startsWith('Imported from an NSF:') || track.speed !== 1 || track.groove ||
      (track.tempo !== 0 && track.tempo !== (info.pal ? 125 : 150)))
    fail();
  const timeline = readTimeline(session, trackIndex, track, info.channels);
  const maxDuration = Math.max(1, Math.min(255, info.speedSplitPoint - 1));
  const packed = [];
  let speed = 1, loopRow = -1;
  const sections = timeline.loopRow > 0
    ? [[0, timeline.loopRow], [timeline.loopRow, timeline.rows.length]]
    : [[0, timeline.rows.length]];
  for (const [from, to] of sections) {
    if (from === timeline.loopRow)
      loopRow = packed.length;
    for (let at = from; at < to;) {
      const cells = timeline.rows[at].map(cell => Uint8Array.from(cell));
      let duration = 1;
      while (duration < maxDuration && at + duration < to && emptyRow(timeline.rows[at + duration]))
        ++duration;
      if (!hasRoom(cells) && duration !== speed)
        duration = 1;
      // Restore speed on a blank tick before an event with all effect slots full.
      if (duration > 1 && at + duration < timeline.rows.length && !hasRoom(timeline.rows[at + duration]))
        --duration;
      // The first loop row must also set its duration on later passes, whose incoming
      // speed is the terminal row's 1 rather than the intro's last duration.
      if (duration !== speed || (at === timeline.loopRow && hasRoom(cells))) {
        addEffect(cells, SPEED, duration);
        speed = duration;
      }
      packed.push({ cells, duration, tick: at });
      at += duration;
    }
  }
  if (timeline.loopRow === 0)
    loopRow = 0;
  // End commands occupy a tick of their own, so loop entry always inherits speed 1.
  // Keep the terminal row separate even when there is no explicit end command.
  if (loopRow >= 0 && packed.at(-1).duration !== 1) {
    const last = packed.at(-1);
    --last.duration;
    setEffect(last.cells, SPEED, last.duration);
    const cells = info.channels.map(() => emptyPattern(1));
    addEffect(cells, SPEED, 1);
    packed.push({ cells, duration: 1, tick: timeline.rows.length - 1 });
  }
  const countFor = length => Math.ceil((loopRow > 0 ? loopRow : 0) / length) +
    Math.ceil((packed.length - Math.max(loopRow, 0)) / length);
  let length = Math.max(64, track.rows);
  while (countFor(length) > MAX_FRAMES && length < MAX_ROWS)
    length = Math.min(length * 2, MAX_ROWS);
  if (countFor(length) > MAX_FRAMES)
    fail();
  const introFrames = loopRow > 0 ? Math.ceil(loopRow / length) : 0;
  if (loopRow > 0) {
    if (loopRow % length)
      setEffect(packed[loopRow - 1].cells, SKIP, 0);
    else
      removeEffect(packed[loopRow - 1].cells, SKIP);
  }
  if (loopRow >= 0)
    setEffect(packed.at(-1).cells, JUMP, introFrames);
  else if (timeline.stops)
    setEffect(packed.at(-1).cells, HALT, 0);
  const frames = [];
  for (const [from, to] of loopRow > 0 ? [[0, loopRow], [loopRow, packed.length]] : [[0, packed.length]])
    for (let at = from; at < to; at += length)
      frames.push(packed.slice(at, Math.min(at + length, to)));
  return {
    sourceTrack: trackIndex, sourceTitle: track.title, tempo: track.tempo, length, frames,
    beforeRows: timeline.rows.length, rows: packed.length, ticks: timeline.rows.length,
    removedRows: timeline.rows.length - packed.length,
  };
}

// Only add a track; none of the existing tracks or instruments are rewritten.
export function applyNsfReconstruction(session, plan, title) {
  if (!plan.removedRows)
    return { beforeRows: plan.beforeRows, rows: plan.rows, removedRows: 0, track: null };
  const track = session.addTrack();
  try {
    return writeTrack(session, plan, title, track);
  } catch (error) {
    session.removeTrack(track);
    throw error;
  }
}

function writeTrack(session, plan, title, track) {
  session.setTrackTitle(track, title);
  session.setTempo(track, plan.tempo);
  session.setSpeed(track, 1);
  session.setPatternLength(track, plan.length);
  session.setFrameCount(track, plan.frames.length);
  // Rows have varying durations; regular row highlights would imply a false beat grid.
  session.setHighlight(track, 0, 0);
  const channels = session.info().channels.length;
  for (let c = 0; c < channels; ++c) {
    const patterns = new Map();
    let effects = 1;
    for (let f = 0; f < plan.frames.length; ++f) {
      const data = emptyPattern(plan.length);
      plan.frames[f].forEach(({ cells }, r) => {
        data.set(cells[c], r * CELL);
        for (let e = 0; e < EFFECT_COLUMNS; ++e)
          if (cells[c][4 + e])
            effects = Math.max(effects, e + 1);
      });
      const key = String.fromCharCode(...data);
      if (!patterns.has(key)) {
        const p = patterns.size;
        session.setCells(track, c, p, 0, data);
        patterns.set(key, p);
      }
      session.setFramePattern(track, f, c, patterns.get(key));
    }
    session.setEffColumns(track, c, effects);
  }
  return { beforeRows: plan.beforeRows, rows: plan.rows, removedRows: plan.removedRows, track };
}

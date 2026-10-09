// Rebuild a frame-per-row NSF import as a separate track. No sound changes are
// discarded: empty time after an event becomes its row duration (Fxx). The original
// track and instruments stay available. Sequence candidates are built in isolation
// and accepted only after comparing their complete playback with the imported track.

import { CELL, NOTE, MAX_ROWS, MAX_FRAMES, EFFECT_COLUMNS, emptyPattern, isEmptyCell } from './dnft-song.mjs';

const SPEED = 1, JUMP = 2, SKIP = 3, HALT = 4;
const PITCH = 13, NO_INSTRUMENT = 64, MAX_SEQUENCE_ITEMS = 252;
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

// Only move volume/Pxx from a normal attack to its next normal attack or note cut.
// Held notes, releases, instrument changes and loop-crossing notes keep their rows.
// The importer writes differences, so restore its persistent column/Pxx values at
// the following boundary even when the source row did not explicitly write them.
function inferSequences(session, timeline, info, { pitch = true } = {}) {
  const instruments = [], changedChannels = new Set(), variants = new Map();
  if (typeof session.instrument !== 'function') return { instruments, changedChannels: [] };
  const original = session.instruments(), occupied = new Set(original.map(i => i.index));
  const freeInstruments = Array.from({ length: 64 }, (_, i) => i).filter(i => !occupied.has(i));
  const sources = new Map(), pools = new Map(), sequences = new Map();
  const sourceInstrument = index => {
    if (!sources.has(index)) sources.set(index, session.instrument(index));
    return sources.get(index);
  };
  const pool = (type, kind) => {
    const key = `${type}:${kind}`;
    if (!pools.has(key)) {
      const used = new Set();
      for (const inst of original.filter(i => i.type === type)) {
        const seq = sourceInstrument(inst.index).sequences?.[kind];
        if (seq?.enabled) used.add(seq.index);
      }
      // Preserve disabled/unused sequence data as well as enabled sequences.
      pools.set(key, Array.from({ length: 128 }, (_, i) => i)
        .filter(i => !used.has(i) && session.sequence(type, kind, i).items.length === 0));
    }
    return pools.get(key);
  };
  const trim = values => {
    while (values.length > 1 && values.at(-1) === values.at(-2)) values.pop();
    return values.length <= MAX_SEQUENCE_ITEMS ? values : null;
  };
  const allocate = (source, volume, fine) => {
    const key = `${source.index}|${volume?.join(',') ?? ''}|${fine?.join(',') ?? ''}`;
    if (variants.has(key)) return variants.get(key);
    if (!freeInstruments.length) return null;
    const specs = [[0, volume, 0], [2, fine, 1]].filter(([, values]) => values);
    for (const [kind, values] of specs) {
      const seqKey = `${source.type}:${kind}:${values.join(',')}`;
      if (!sequences.has(seqKey) && !pool(source.type, kind).length) return null;
    }
    const descriptor = { source: source.index, index: freeInstruments.shift(), sequences: [] };
    for (const [kind, values, setting] of specs) {
      const seqKey = `${source.type}:${kind}:${values.join(',')}`;
      if (!sequences.has(seqKey)) sequences.set(seqKey, {
        type: source.type, kind, index: pool(source.type, kind).shift(),
        items: Int8Array.from(values), setting,
      });
      descriptor.sequences.push(sequences.get(seqKey));
    }
    instruments.push(descriptor); variants.set(key, descriptor);
    return descriptor;
  };
  for (const [c, channel] of info.channels.entries()) {
    if (channel.id === 4 || ![0, 1, 8, 16, 32].includes(channel.chip)) continue;
    const volumeAt = [], pitchAt = [];
    let volume = 15, fine = 128;
    for (const row of timeline.rows) {
      const cell = row[c];
      if (cell[2] < 16) volume = cell[2];
      for (let e = 0; e < EFFECT_COLUMNS; ++e) if (cell[4 + e] === PITCH) fine = cell[8 + e];
      volumeAt.push(volume); pitchAt.push(fine);
    }
    const sections = timeline.loopRow > 0
      ? [[0, timeline.loopRow], [timeline.loopRow, timeline.rows.length]] : [[0, timeline.rows.length]];
    // Inspect all candidates before editing this channel's cells.
    const candidates = [];
    for (const [from, to] of sections) {
      for (let at = from; at < to; ++at) {
        const first = timeline.rows[at][c];
        if (first[0] < NOTE.C || first[0] > NOTE.B || first[3] >= NO_INSTRUMENT) continue;
        const source = sourceInstrument(first[3]);
        if (![1, 2, 5, 6].includes(source.type) || source.sequences?.some(s => s.enabled)) continue;
        let end = at + 1;
        while (end < to && timeline.rows[end][c][0] === NOTE.NONE && timeline.rows[end][c][3] === NO_INSTRUMENT) ++end;
        if (end >= to) continue;
        const last = timeline.rows[end][c];
        if (last[0] !== NOTE.HALT && !(last[0] >= NOTE.C && last[0] <= NOTE.B && last[3] < NO_INSTRUMENT)) continue;
        const cells = timeline.rows.slice(at, end).map(row => row[c]);
        const volumeWrites = cells.slice(1).filter(cell => cell[2] < 16).length;
        const fineWrites = cells.slice(1).reduce((n, cell) => n + Array.from(cell.subarray(4, 8)).filter(e => e === PITCH).length, 0);
        const volumes = volumeWrites && channel.id !== 2 ? trim(volumeAt.slice(at, end)) : null;
        const periodPitch = pitch && !info.linearPitch && channel.chip !== 16 && channel.id !== 3;
        let pitches = periodPitch && fineWrites ? trim(pitchAt.slice(at, end).map(p => 128 - p)) : null;
        if (pitches?.some(p => p < -128 || p > 127)) pitches = null;
        if (!volumes && !pitches) continue;
        // Sweeps modify the period, and phase resets write it before the macro
        // updates. Preserve Pxx in those spans; volume can still be inferred.
        if (pitches && cells.some(cell => cell.subarray(4, 8).some(e => e === 8 || e === 9 || e === 42))) pitches = null;
        if (!volumes && !pitches) continue;
        const descriptor = allocate(source, volumes, pitches);
        if (descriptor) candidates.push({ at, end, descriptor, volume: !!volumes, pitch: !!pitches });
      }
    }
    for (const span of candidates) {
      const start = timeline.rows[span.at][c], end = timeline.rows[span.end][c];
      start[3] = span.descriptor.index;
      for (let at = span.at; at < span.end; ++at) {
        const cell = timeline.rows[at][c];
        if (span.volume) cell[2] = 16;
        if (span.pitch) removeEffect([cell], PITCH);
      }
      if (span.volume) { start[2] = 15; end[2] = volumeAt[span.end]; }
      if (span.pitch) {
        // No room for P80/restoration: keep this candidate unchanged by retrying
        // the basic reconstruction if the effect columns cannot accommodate it.
        setEffect([start], PITCH, 128); setEffect([end], PITCH, pitchAt[span.end]);
      }
      changedChannels.add(c);
    }
  }
  return { instruments, changedChannels: [...changedChannels] };
}

export function planNsfReconstruction(session, trackIndex, { sequences = false, pitch = true } = {}) {
  const info = session.info(), track = session.track(trackIndex);
  if (!info.comment.startsWith('Imported from an NSF:') || track.speed !== 1 || track.groove ||
      (track.tempo !== 0 && track.tempo !== (info.pal ? 125 : 150)))
    fail();
  const timeline = readTimeline(session, trackIndex, track, info.channels);
  const macros = sequences ? inferSequences(session, timeline, info, { pitch })
    : { instruments: [], changedChannels: [] };
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
    instruments: macros.instruments, changedChannels: macros.changedChannels,
  };
}

// Only add a track; none of the existing tracks or instruments are rewritten.
export function applyNsfReconstruction(session, plan, title) {
  const descriptors = plan.instruments ?? [];
  if (!plan.removedRows && !descriptors.length)
    return { beforeRows: plan.beforeRows, rows: plan.rows, removedRows: 0, track: null, instruments: 0, sequences: 0 };
  if (session.info().tracks?.length >= 64) throw new Error('nsfReconstructFull');
  const track = session.addTrack();
  const added = [], written = new Map();
  try {
    for (const descriptor of descriptors) {
      const index = session.cloneInstrument(descriptor.source);
      if (index < 0) fail();
      added.push(index);
      if (index !== descriptor.index) fail();
      session.setInstrumentName(index, `NSF ${index.toString(16).padStart(2, '0').toUpperCase()} sequence`);
      for (const seq of descriptor.sequences) {
        const key = `${seq.type}:${seq.kind}:${seq.index}`;
        if (!written.has(key)) {
          written.set(key, { ...seq, previous: session.sequence(seq.type, seq.kind, seq.index) });
          session.setSequence(seq.type, seq.kind, seq.index, seq.items, -1, -1, seq.setting);
        }
        session.setInstrumentSequence(index, seq.kind, true, seq.index);
      }
    }
    return { ...writeTrack(session, plan, title, track), instruments: added.length, sequences: written.size };
  } catch (error) {
    session.removeTrack(track);
    for (const index of added) session.removeInstrument(index);
    for (const seq of written.values()) {
      const { items, loop, release, setting } = seq.previous;
      session.setSequence(seq.type, seq.kind, seq.index, items, loop, release, setting);
    }
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
  // The legacy .dnm header saves only global highlights. A persistent bookmark
  // keeps this track's variable-duration grid unhighlighted after reopening too.
  session.setBookmarks(track, [{ frame: 0, row: 0, name: title, highlight: [0, 0], persist: true }]);
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

function inCore(core, fn) {
  try { return fn(); }
  catch (error) {
    // A wasm exception's pointer belongs to this instance, not the editor's core.
    if (error instanceof WebAssembly.Exception)
      throw new Error(core.getExceptionMessage(error).at(-1));
    throw error;
  }
}

function openCopy(core, bytes, sampleRate) {
  return inCore(core, () => {
    const at = core._malloc(bytes.length);
    core.HEAPU8.set(bytes, at);
    try { return core.openSession(at, bytes.length, sampleRate); }
    finally { core._free(at); }
  });
}

// Two independent sound generators stream samples side by side. No long PCM
// recordings are retained in memory, and the editor's live session is untouched.
async function samePlayback(core, source, otherCore, candidate, sourceTrack, result, seconds, channels, hooks) {
  const all = 2 ** source.info().channels.length - 1;
  const masks = [0, ...channels.map(c => all - 2 ** c)];
  let yielded = performance.now();
  for (const [index, mask] of masks.entries()) {
    try {
      inCore(core, () => source.beginWave(sourceTrack, 0, seconds, mask, 44100));
      inCore(otherCore, () => candidate.beginWave(result.track, 0, seconds, mask, 44100));
      for (;;) {
        if (hooks.isCancelled()) throw new Error('cancelled');
        const a = inCore(core, () => source.renderWave(4410));
        const b = inCore(otherCore, () => candidate.renderWave(4410));
        if (a.done !== b.done || a.samples.length !== b.samples.length) return false;
        for (let i = 0; i < a.samples.length; ++i) if (a.samples[i] !== b.samples[i]) return false;
        hooks.onProgress((index + a.progress) / masks.length);
        if (a.done) break;
        if (performance.now() - yielded >= 50) {
          await new Promise(resolve => setTimeout(resolve, 0));
          yielded = performance.now();
        }
      }
    } finally {
      inCore(core, () => source.endWave());
      inCore(otherCore, () => candidate.endWave());
    }
  }
  return true;
}

// Public worker operation: infer exact per-tick macros, pack rows, and validate
// the full intro and two loop passes before returning any replacement bytes.
// If a chip's update semantics differ, retry volume only, then the basic packer.
export async function reconstructNsf(core, verificationCore, bytes, sourceTrack, title, sampleRate,
  { onProgress = () => {}, isCancelled = () => false } = {}) {
  if (core === verificationCore) throw new Error('nsfReconstructUnsupported');
  let source = null, candidate = null;
  let progress = 0;
  const reportProgress = value => { progress = Math.max(progress, value); onProgress(progress); };
  const checkCancelled = () => { if (isCancelled()) throw new Error('cancelled'); };
  try {
    checkCancelled(); reportProgress(0);
    source = openCopy(core, bytes, sampleRate);
    if (source.info().tracks.length >= 64) throw new Error('nsfReconstructFull');
    // Reject edited/non-imported flow before asking the player for its duration.
    const basicPlan = inCore(core, () => planNsfReconstruction(source, sourceTrack));
    const length = inCore(core, () => source.songLength(sourceTrack));
    const seconds = Math.ceil(length.intro + 2 * length.loop + 1);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 99 * 60)
      throw new Error('nsfReconstructUnsupported');
    const attempts = [{ sequences: true }, { sequences: true, pitch: false }, { sequences: false }];
    for (const [attempt, options] of attempts.entries()) {
      checkCancelled();
      candidate?.delete();
      candidate = openCopy(verificationCore, bytes, sampleRate);
      let plan, reconstruction;
      try {
        plan = options.sequences
          ? inCore(verificationCore, () => planNsfReconstruction(candidate, sourceTrack, options)) : basicPlan;
        reconstruction = inCore(verificationCore, () => applyNsfReconstruction(candidate, plan, title));
      }
      catch (error) {
        if (options.sequences && error.message === 'nsfReconstructUnsupported') continue;
        throw error;
      }
      reconstruction.fallback = attempt > 0;
      reconstruction.verified = false;
      if (reconstruction.track === null) return { data: null, reconstruction };
      const matches = await samePlayback(core, source, verificationCore, candidate, sourceTrack, reconstruction,
        seconds, plan.changedChannels, { isCancelled, onProgress: value => reportProgress(0.05 + value * 0.9) });
      if (!matches) continue;
      checkCancelled();
      reconstruction.verified = true;
      const data = inCore(verificationCore, () => candidate.save());
      reportProgress(1);
      return { data, reconstruction };
    }
    throw new Error('nsfReconstructMismatch');
  } finally {
    candidate?.delete(); source?.delete();
  }
}

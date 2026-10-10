// Standard MIDI Files (SMF 0/1, PPQN) -> the tracker's text import. No synthesizer or
// sound bank is needed. All parsing/conversion happens before replacing the session.
// Format: https://midi.org/standard-midi-files-specification
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS = 200000;
const MAX_NOTES = 50000;
const MAX_ROWS = 256 * 256;
const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
const fail = code => { throw new Error(code); };
const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
const quote = text => `"${text.slice(0, 200).replace(/[\u0000-\u001f\u007f]/g, ' ').replaceAll('"', '""')}"`;

class Reader {
  constructor(bytes) { this.bytes = bytes; this.at = 0; this.end = bytes.length; }
  need(n) { if (n < 0 || n > this.end - this.at) fail('midiInvalid'); }
  u8() { this.need(1); return this.bytes[this.at++]; }
  u16() { return this.u8() * 256 + this.u8(); }
  u32() { return this.u16() * 65536 + this.u16(); }
  data() { const n = this.u8(); if (n > 127) fail('midiInvalid'); return n; }
  tag() { return String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8()); }
  vlq() {
    let n = 0;
    for (let i = 0; i < 4; ++i) {
      const b = this.u8(); n = n * 128 + (b & 127);
      if (!(b & 128)) return n;
    }
    fail('midiInvalid');
  }
  take(n) { this.need(n); const data = this.bytes.subarray(this.at, this.at + n); this.at += n; return data; }
}

function decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\0', '').slice(0, 200); }
  catch { return new TextDecoder('windows-1252').decode(bytes).replaceAll('\0', '').slice(0, 200); }
}

export function parseMidi(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('midiInvalid');
  if (bytes.length > MAX_BYTES) fail('midiTooLarge');
  const r = new Reader(bytes);
  if (r.tag() !== 'MThd') fail('midiInvalid');
  const headerLength = r.u32();
  if (headerLength < 6) fail('midiInvalid');
  r.need(headerLength);
  const format = r.u16(), trackCount = r.u16(), division = r.u16();
  if (format > 1) fail('midiFormat');
  if (!trackCount || (format === 0 && trackCount !== 1)) fail('midiInvalid');
  if (!division || division & 0x8000) fail('midiTiming');
  if (trackCount > 1024) fail('midiTooLarge');
  r.take(headerLength - 6);
  const events = [], names = [];
  let copyright = '', endTick = 0, eventCount = 0;
  for (let track = 0; track < trackCount;) {
    const tag = r.tag(), size = r.u32();
    r.need(size);
    if (tag !== 'MTrk') { r.take(size); continue; }
    const end = r.at + size;
    r.end = end;
    let tick = 0, running = 0, order = 0;
    while (r.at < end) {
      if (++eventCount > MAX_EVENTS) fail('midiTooLarge');
      tick += r.vlq();
      let status = r.u8();
      if (status < 128) {
        if (!running) fail('midiInvalid');
        --r.at; status = running;
      }
      if (status === 0xFF) {
        running = 0;
        const type = r.u8(), data = r.take(r.vlq());
        if (type === 0x2F) {
          if (data.length) fail('midiInvalid');
          r.at = end; break;
        }
        if (type === 0x51) {
          if (data.length !== 3) fail('midiInvalid');
          const tempo = data[0] * 65536 + data[1] * 256 + data[2];
          if (!tempo) fail('midiInvalid');
          events.push({ tick, track, order: order++, type: 'tempo', tempo });
        } else if (type === 3 && !names[track]) names[track] = decode(data);
        else if (type === 2 && !copyright) copyright = decode(data);
      } else if (status === 0xF0 || status === 0xF7) {
        running = 0; r.take(r.vlq());
        events.push({ tick, track, order: order++, type: 'ignored' });
      } else {
        if (status >= 0xF0) fail('midiInvalid');
        running = status;
        const type = status >> 4, channel = status & 15;
        const a = r.data(), b = type === 12 || type === 13 ? 0 : r.data();
        events.push({ tick, track, order: order++, type, channel, a, b });
      }
    }
    endTick = Math.max(endTick, tick);
    r.end = bytes.length;
    ++track;
  }
  events.sort((a, b) => a.tick - b.tick || a.track - b.track || a.order - b.order);
  const channels = Array.from({ length: 16 }, () => ({ program: 0, volume: 100, expression: 127,
    sustain: false, active: new Set(), keys: new Map() }));
  const notes = [], tempos = [{ tick: 0, tempo: 500000 }];
  let ignored = 0, unclosed = 0, activeCount = 0, levelCount = 0;
  const volume = (state, velocity) => Math.round(15 * velocity / 127 * state.volume / 127 * state.expression / 127);
  const finish = (state, note, tick) => {
    note.end = tick;
    if (state.active.delete(note)) --activeCount;
  };
  for (const e of events) {
    if (e.type === 'tempo') {
      if (tempos.at(-1).tick === e.tick) tempos.pop();
      tempos.push({ tick: e.tick, tempo: e.tempo }); continue;
    }
    if (e.type === 'ignored') { ++ignored; continue; }
    const state = channels[e.channel];
    if (e.type === 9 && e.b) {
      if (notes.length >= MAX_NOTES || ++activeCount > 1024) fail('midiTooLarge');
      const note = { id: notes.length, start: e.tick, end: null, key: e.a, velocity: e.b,
        channel: e.channel, program: state.program, track: e.track, released: false,
        levels: [{ tick: e.tick, volume: volume(state, e.b) }] };
      notes.push(note); state.active.add(note);
      if (!state.keys.has(e.a)) state.keys.set(e.a, { notes: [], head: 0 });
      state.keys.get(e.a).notes.push(note);
    } else if (e.type === 8 || e.type === 9) {
      const queue = state.keys.get(e.a);
      if (queue && queue.head < queue.notes.length) {
        const note = queue.notes[queue.head++];
        if (queue.head === queue.notes.length) state.keys.delete(e.a);
        note.released = true;
        if (!state.sustain) finish(state, note, e.tick);
      }
    } else if (e.type === 12) state.program = e.a;
    else if (e.type === 11) {
      if (e.a === 64) {
        state.sustain = e.b >= 64;
        if (!state.sustain) for (const note of state.active) if (note.released) finish(state, note, e.tick);
      } else if (e.a === 7 || e.a === 11 || e.a === 121) {
        if (e.a === 7) state.volume = e.b;
        if (e.a === 11 || e.a === 121) state.expression = e.a === 121 ? 127 : e.b;
        if (e.a === 121) {
          state.sustain = false;
          for (const note of state.active) if (note.released) finish(state, note, e.tick);
        }
        for (const note of state.active) {
          const v = volume(state, note.velocity);
          if (note.levels.at(-1).volume !== v) {
            if (++levelCount > MAX_EVENTS) fail('midiTooLarge');
            note.levels.push({ tick: e.tick, volume: v });
          }
        }
      } else if (e.a === 120 || e.a === 123) {
        for (const note of state.active) {
          note.released = true;
          if (e.a === 120 || !state.sustain) finish(state, note, e.tick);
        }
        state.keys.clear();
      } else ++ignored;
    } else if (e.type !== 14 || e.a !== 0 || e.b !== 64) ++ignored;
  }
  for (const state of channels) for (const note of state.active) { finish(state, note, endTick); ++unclosed; }
  if (!notes.length) fail('midiNoNotes');
  return { format, division, trackCount, title: names.find(Boolean) ?? '', copyright,
    notes, tempos, ignored, unclosed };
}

export function midiInfo(bytes) {
  const midi = parseMidi(bytes);
  return { title: midi.title, tracks: midi.trackCount, notes: midi.notes.length };
}

// Keep a beat grid. Fxx sets tempo (>=32) and speed (<32). Slow/fast tempi use
// another speed; the unused DPCM channel carries both effects on the same row.
function trackerTempo(microseconds, resolution) {
  const bpm = 60000000 / microseconds;
  const preferred = Math.max(1, Math.round(24 / resolution));
  let speed = preferred, tempo = Math.round(bpm * resolution * speed / 24);
  if (tempo < 32 || tempo > 255 || tempo > 150 * speed) {
    let error = Infinity;
    for (let s = 1; s < 32; ++s) {
      const t = Math.max(32, Math.min(255, 150 * s, Math.round(bpm * resolution * s / 24)));
      const diff = Math.abs(2.5 * s / t - microseconds / 1000000 / resolution);
      if (diff < error) { error = diff; speed = s; tempo = t; }
    }
  }
  return { speed, tempo, adjusted: Math.abs(tempo * 24 / (speed * resolution) / bpm - 1) > 0.005 };
}

export function convertMidi(bytes, options = {}) {
  const { resolution = 8, chips = 1, transpose = 0, title = '' } = options;
  if (![4, 8, 12, 16].includes(resolution) || ![0, 1].includes(chips) ||
      !Number.isInteger(transpose) || Math.abs(transpose) > 48) fail('midiOptions');
  const midi = parseMidi(bytes);
  const channels = chips ? 8 : 5;
  const patternLength = 64;
  const toRow = tick => Math.round(tick * resolution / midi.division);
  const report = { notes: 0, dropped: 0, outOfRange: 0, tempo: 0,
    ignored: midi.ignored, unclosed: midi.unclosed, instruments: 0 };
  const grid = new Map();
  const cell = (row, channel) => {
    if (row >= MAX_ROWS) fail('midiTooLong');
    if (!grid.has(row)) grid.set(row, Array.from({ length: channels }, () => ({ note: '...', instrument: '..', volume: '.', effects: [] })));
    return grid.get(row)[channel];
  };
  const instruments = [], instrumentMap = new Map();
  const instrument = (program, vrc6, drum) => {
    const kind = vrc6 ? 'INSTVRC6' : 'INST2A03';
    const key = `${kind}:${drum ? 'drum' : program}`;
    if (instrumentMap.has(key)) return instrumentMap.get(key);
    if (instruments.length === 64) {
      ++report.instruments;
      return instruments.findIndex(i => i.kind === kind && !i.drum);
    }
    const index = instruments.length;
    instruments.push({ kind, program, drum }); instrumentMap.set(key, index);
    return index;
  };
  // Reserve fallbacks before all 64 slots can be filled, including the noise envelope.
  instrument(0, false, false);
  if (chips) instrument(0, true, false);
  instrument(0, false, true);
  const voices = Array.from({ length: channels }, () => ({ end: -1, source: -1 }));
  const notes = midi.notes.map(note => ({ ...note, row: toRow(note.start), endRow: Math.max(toRow(note.start) + 1, toRow(note.end)) }))
    .sort((a, b) => a.row - b.row || a.start - b.start || a.id - b.id);
  let lastRow = 0;
  for (const note of notes) {
    // Check the duration even for dropped/out-of-range notes: never wrap patterns.
    if (note.endRow >= MAX_ROWS) fail('midiTooLong');
    const drum = note.channel === 9;
    const pitch = note.key + transpose - 24;
    if (!drum && (pitch < 0 || pitch >= 96)) { ++report.outOfRange; continue; }
    const bass = note.program >= 32 && note.program < 40 || note.key + transpose < 48;
    const order = drum ? [3] : bass ? [2, 0, 1, ...(chips ? [7, 5, 6] : [])] : [0, 1, ...(chips ? [5, 6] : []), 2, ...(chips ? [7] : [])];
    const free = order.filter(channel => voices[channel].end <= note.row);
    const channel = free.find(channel => voices[channel].source === note.channel) ?? free[0];
    if (channel === undefined) { ++report.dropped; continue; }
    const vrc6 = channel >= 5;
    const c = cell(note.row, channel);
    const noise = [35, 36].includes(note.key) ? 0 : [42, 44, 46].includes(note.key) ? 14 : 8;
    c.note = drum ? `${noise.toString(16).toUpperCase()}-#` : `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12)}`;
    c.instrument = hex(instrument(note.program, vrc6, drum));
    // Duty effects also initialize reused voices; the VRC6 saw's volume uses 0..F.
    if (!drum && channel !== 2 && channel !== 7) c.effects[0] = `V0${note.program >= 80 && note.program < 88 ? 0 : note.program >= 24 && note.program < 40 ? 1 : 2}`;
    for (const level of note.levels) {
      const row = Math.max(note.row, toRow(level.tick));
      if (row < note.endRow) cell(row, channel).volume = level.volume.toString(16).toUpperCase();
    }
    cell(note.endRow, channel).note = '---';
    voices[channel] = { end: note.endRow, source: note.channel };
    lastRow = Math.max(lastRow, note.endRow);
    ++report.notes;
  }
  if (!report.notes) fail('midiNoPlayableNotes');
  const initial = trackerTempo(midi.tempos[0].tempo, resolution);
  let previous = initial;
  for (const event of midi.tempos) {
    const row = toRow(event.tick);
    if (row > lastRow) break;
    const current = trackerTempo(event.tempo, resolution);
    if (current.adjusted) ++report.tempo;
    if (current.speed !== previous.speed || current.tempo !== previous.tempo) {
      // Channel 4 is unused DPCM: global effects cannot collide with notes/duty.
      cell(row, 4).effects = [`F${hex(current.speed)}`, `F${hex(current.tempo)}`];
    }
    previous = current;
  }
  cell(lastRow, 4).effects.push('C00');
  const frames = Math.floor(lastRow / patternLength) + 1;
  const songTitle = midi.title || title || 'MIDI';
  const lines = ['# MIDI import', `TITLE ${quote(songTitle)}`, `COPYRIGHT ${quote(midi.copyright)}`,
    'MACHINE 0', 'FRAMERATE 0', `EXPANSION ${chips}`, 'VIBRATO 1', 'SPLIT 32',
    // A short noise envelope gives drums an attack even when their MIDI note is held.
    'MACRO 0 0 -1 -1 0 : 15 12 8 4 0', 'MACRO 4 0 -1 -1 0 : 0'];
  instruments.forEach((i, index) => lines.push(`${i.kind} ${index} ${i.drum ? '0' : '-1'} -1 -1 -1 ${i.drum ? '0' : '-1'} ${quote(i.drum ? 'MIDI drums' : `MIDI ${String(i.program + 1).padStart(3, '0')}`)}`));
  lines.push(`TRACK ${patternLength} ${initial.speed} ${initial.tempo} ${quote(songTitle)}`,
    `COLUMNS : ${Array.from({ length: channels }, (_, c) => c === 4 ? 3 : 1).join(' ')}`);
  lines.push(`BOOKMARK 00 00 ${resolution} ${resolution * 4} 1 "MIDI"`);
  for (let frame = 0; frame < frames; ++frame)
    lines.push(`ORDER ${hex(frame)} : ${Array(channels).fill(hex(frame)).join(' ')}`);
  for (let frame = 0; frame < frames; ++frame) {
    lines.push(`PATTERN ${hex(frame)}`);
    for (let row = 0; row < patternLength; ++row) {
      const cells = grid.get(frame * patternLength + row);
      if (!cells) continue;
      lines.push(`ROW ${hex(row)} : ${cells.map((c, channel) => `${c.note} ${c.instrument} ${c.volume} ${Array.from({ length: channel === 4 ? 3 : 1 }, (_, i) => c.effects[i] ?? '...').join(' ')}`).join(' : ')}`);
    }
  }
  return { text: new TextEncoder().encode(lines.join('\n') + '\n'), report: { ...report, rows: lastRow + 1, frames } };
}

export function importMidi(dnft, bytes, options, sampleRate) {
  const converted = convertMidi(bytes, options);
  const at = dnft._malloc(converted.text.length);
  try {
    dnft.HEAPU8.set(converted.text, at);
    const session = dnft.importText(at, converted.text.length, sampleRate);
    return { session, report: converted.report };
  } finally { dnft._free(at); }
}

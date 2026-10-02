// Dn-FamiTracker web port - the pattern editor's grid.
//
// Drawn on a canvas, the way the desktop tracker draws it: the cursor row stays in the
// middle, the rows of the frames before and after show dimmed above and below, and the
// row highlights come from the track. Channel headers (name, mute, effect columns) are
// elements above the canvas that scroll sideways with it. Colours and the font come
// from the CSS custom properties of the editor (dnft-editor.css).
//
// The view only draws and reports where things are; the editor (dnft-editor.mjs) owns
// the state it reads: song, track, cursor, selection, editMode, play, muted. Bookmarked
// rows have their numbers marked, and may set the row highlight from their row on; the row
// marker (Tracker > Set Row Marker) is a bar on its row number. The headers have the
// channels' volume meters (dnft-displays.mjs), and the compact view (View > Compact View)
// shows only the notes, in narrow channels.

import { CELL, NOTE, MAX_VOLUME, NO_INSTRUMENT, HOLD_INSTRUMENT, CHANNEL_ID } from './dnft-song.mjs';
import { inRows, highlightAt, highlightState, bookmarkAt } from './dnft-pattern-edit.mjs';

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
const FLAT_NAMES = ['C-', 'Db', 'D-', 'Eb', 'E-', 'F-', 'Gb', 'G-', 'Ab', 'A-', 'Bb', 'B-'];
let displayFlats = false;

// Configuration > General > flats: Db and Eb for C# and D#
export function setDisplayFlats(on) {
  displayFlats = on;
}
const HEX = '0123456789ABCDEF';
const hex2 = value => HEX[value >> 4 & 15] + HEX[value & 15];

// A channel's cursor columns: 0 note, 1-2 the instrument digits, 3 volume, then for each
// effect column its letter and the two digits of its parameter.
export function columnCount(effColumns) {
  return 4 + 3 * effColumns;
}

// Where a column is in a channel: [first character, characters]
export function columnPlace(column) {
  if (column === 0) return [0, 3];
  if (column <= 2) return [3 + column, 1];
  if (column === 3) return [7, 1];
  const effect = Math.floor((column - 4) / 3);
  return [9 + 4 * effect + (column - 4) % 3, 1];
}

export function columnKind(column) {
  if (column === 0) return 'note';
  if (column <= 2) return 'instrument';
  if (column === 3) return 'volume';
  return (column - 4) % 3 === 0 ? 'effect' : 'param';
}

const channelChars = effColumns => 8 + 4 * effColumns;

export function noteText(note, octave, channelId) {
  switch (note) {
    case NOTE.NONE: return null;
    case NOTE.HALT: return '---';
    case NOTE.RELEASE: return '===';
    case NOTE.ECHO: return `^-${octave}`;
  }
  // the noise channel plays 16 periods: its notes show as their period
  if (channelId === CHANNEL_ID.NOISE)
    return `${HEX[(octave * 12 + note - 1) & 15]}-#`;
  return (displayFlats ? FLAT_NAMES : NOTE_NAMES)[note - 1] + octave;
}

export class PatternView {
  constructor(root, editor) {
    this.editor = editor;
    this.root = root;
    root.classList.add('dnft-pv');

    this.scroller = document.createElement('div');
    this.scroller.className = 'dnft-pv-scroller';
    this.header = document.createElement('div');
    this.header.className = 'dnft-pv-header';
    this.body = document.createElement('div');
    this.body.className = 'dnft-pv-body';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'dnft-pv-canvas';
    this.body.append(this.canvas);
    this.scroller.append(this.header, this.body);
    root.append(this.scroller);

    this.ctx = this.canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.channels = [];      // {x, width, effColumns} in content pixels, after the gutter
    this.gutter = 0;
    this.pending = false;

    this.scroller.addEventListener('scroll', () => this.invalidate());
    new ResizeObserver(() => this.resize()).observe(this.body);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.refreshStyle());
    new MutationObserver(() => this.refreshStyle()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    document.fonts?.addEventListener?.('loadingdone', () => this.refreshStyle());
    this.refreshStyle();
  }

  // Colours and font from the stylesheet (again when the theme or the fonts change)
  refreshStyle() {
    const style = getComputedStyle(this.root);
    const v = name => style.getPropertyValue(name).trim();
    this.colors = {
      bg: v('--dnft-pe-bg'), bar: v('--dnft-pe-bar'), beat: v('--dnft-pe-beat'),
      text: v('--dnft-pe-note'), instrument: v('--dnft-pe-instrument'), volume: v('--dnft-pe-volume'),
      effect: v('--dnft-pe-effect'), dim: v('--dnft-pe-dim'), rowNumber: v('--dnft-pe-row-number'),
      cursorRow: v('--dnft-pe-cursor-row'), editRow: v('--dnft-pe-edit-row'), playRow: v('--dnft-pe-play-row'),
      cursor: v('--dnft-pe-cursor'), selection: v('--dnft-pe-selection'), separator: v('--dnft-pe-separator'),
      bookmark: v('--dnft-pe-bookmark'), marker: v('--dnft-pe-marker') || v('--dnft-pe-cursor'),
    };
    const size = parseFloat(style.fontSize) || 13;
    this.font = `${size}px ${style.fontFamily}`;
    this.ctx.font = this.font;
    this.charWidth = Math.ceil(this.ctx.measureText('0').width * 4) / 4;
    this.rowHeight = Math.round(size * (parseFloat(style.getPropertyValue('--dnft-pe-row')) || 1.45));
    this.layout();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.width = this.scroller.clientWidth;
    this.height = this.body.clientHeight;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.dpr = dpr;
    this.invalidate();
  }

  // Channel places and headers, after the song, the track or its effect columns change
  layout() {
    const { song, track } = this.editor;
    if (!song)
      return;
    const cw = this.charWidth;
    this.gutter = Math.round(cw * 3.5);
    let x = 0;
    const effColumns = song.track(track).effColumns;
    const compact = this.editor.compact;
    this.channels = song.channels.map((channel, i) => {
      const width = Math.round(((compact ? 3 : channelChars(effColumns[i])) + 1) * cw);
      const place = { x, width, effColumns: effColumns[i] };
      x += width + 1;
      return place;
    });
    this.contentWidth = x;
    this.body.style.width = `${this.gutter + x}px`;
    this.buildHeader();
    this.invalidate();
  }

  buildHeader() {
    const { song, muted } = this.editor;
    const t = this.editor.strings;
    const corner = document.createElement('div');
    corner.className = 'dnft-pv-corner';
    corner.style.width = `${this.gutter}px`;
    const compact = this.editor.compact;
    const meters = [];
    this.header.replaceChildren(corner, ...song.channels.map((channel, i) => {
      const cell = document.createElement('div');
      cell.className = 'dnft-pv-channel';
      cell.classList.toggle('is-muted', muted[i]);
      cell.classList.toggle('is-recording', this.recording === i);
      cell.style.width = `${this.channels[i].width + 1}px`;
      cell.dataset.channel = i;

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'dnft-pv-channel-name';
      name.textContent = compact ? channel.shortName : channel.name;
      name.title = t.muteHint;
      name.setAttribute('aria-pressed', String(!muted[i]));
      name.addEventListener('click', e => this.editor.toggleMute(i, e.altKey || e.shiftKey));
      name.addEventListener('contextmenu', e => { e.preventDefault(); this.editor.toggleMute(i, true); });

      const columns = document.createElement('span');
      columns.className = 'dnft-pv-channel-columns';
      const less = document.createElement('button');
      less.type = 'button';
      less.textContent = '−';
      less.title = t.fewerEffects;
      less.disabled = this.channels[i].effColumns <= 1;
      less.addEventListener('click', () => this.editor.setEffColumns(i, this.channels[i].effColumns - 1));
      const more = document.createElement('button');
      more.type = 'button';
      more.textContent = '+';
      more.title = t.moreEffects;
      more.disabled = this.channels[i].effColumns >= 4;
      more.addEventListener('click', () => this.editor.setEffColumns(i, this.channels[i].effColumns + 1));
      columns.append(less, more);

      const meter = document.createElement('canvas');
      meter.className = 'dnft-pv-meter';
      meter.width = Math.max(15, this.channels[i].width - 8);
      meter.height = 5;
      meters.push(meter);

      cell.append(name, columns, meter);
      return cell;
    }));
    this.editor.displays?.meters.attach(meters);
  }

  // The channel being recorded (Tracker > Record To Instrument), or null
  markRecording(channel) {
    this.recording = channel;
    this.header.querySelectorAll('.dnft-pv-channel').forEach((cell, i) => cell.classList.toggle('is-recording', i === channel));
  }

  invalidate() {
    if (this.pending)
      return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  // Lines of the canvas and the line of the cursor
  get lines() {
    return Math.max(1, Math.floor(this.height / this.rowHeight));
  }

  get middle() {
    return Math.floor((this.lines - 1) / 2);
  }

  // The place `delta` rows away in the song, or null past its ends
  offset(frame, row, delta) {
    const { song, track } = this.editor;
    const { rows, frames } = song.track(track);
    const at = frame * rows + row + delta;
    if (at < 0 || at >= frames * rows)
      return null;
    return { frame: Math.floor(at / rows), row: at % rows };
  }

  draw() {
    const { song, track, cursor, selection, editMode, play, muted, marker } = this.editor;
    const { ctx, colors: c, charWidth: cw, rowHeight: rh } = this;
    if (!song || !this.width || !this.height)
      return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = this.font;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, this.width, this.height);

    const tr = song.track(track);
    const bookmarks = tr.bookmarks;
    const scroll = this.scroller.scrollLeft;
    const left = this.gutter - scroll;
    const lines = this.lines;
    const middle = this.middle;
    const channels = song.channels;

    // the channels in view
    const first = Math.max(0, this.channels.findIndex(ch => left + ch.x + ch.width > this.gutter));
    let last = this.channels.length - 1;
    while (last > first && left + this.channels[last].x > this.width)
      --last;

    const places = [];
    for (let line = 0; line < lines; ++line)
      places.push(this.offset(cursor.frame, cursor.row, line - middle));

    // row backgrounds: highlights, the cursor row, the row playing
    places.forEach((place, line) => {
      if (!place)
        return;
      const y = line * rh;
      const layers = [];
      const highlight = highlightState(highlightAt(bookmarks, tr.highlight, place.frame, place.row), place.row);
      if (highlight === 2)
        layers.push(c.bar);
      else if (highlight === 1)
        layers.push(c.beat);
      if (line === middle)
        layers.push(editMode ? c.editRow : c.cursorRow);
      if (play && play.frame === place.frame && play.row === place.row)
        layers.push(c.playRow);
      for (const layer of layers) {
        ctx.fillStyle = layer;
        ctx.fillRect(0, y, this.width, rh);
      }
    });

    // the channels, clipped where the row numbers are
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.gutter, 0, this.width - this.gutter, this.height);
    ctx.clip();
    places.forEach((place, line) => {
      if (!place)
        return;
      const y = line * rh + rh / 2 + 1;
      const own = place.frame === cursor.frame;
      for (let ch = first; ch <= last; ++ch) {
        ctx.globalAlpha = (own ? 1 : 0.4) * (muted[ch] ? 0.45 : 1);
        this.drawCell(song.cell(track, place.frame, ch, place.row), left + this.channels[ch].x + cw * 0.5, y,
          this.channels[ch].effColumns, channels[ch].id);
      }
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.separator;
    for (let ch = first; ch <= last; ++ch)
      ctx.fillRect(Math.round(left + this.channels[ch].x + this.channels[ch].width), 0, 1, this.height);
    ctx.restore();

    // row numbers, on a mark where there is a bookmark
    places.forEach((place, line) => {
      if (!place)
        return;
      ctx.globalAlpha = place.frame === cursor.frame ? 1 : 0.4;
      if (bookmarkAt(bookmarks, place.frame, place.row)) {
        ctx.fillStyle = c.bookmark;
        ctx.fillRect(1, line * rh + 1, this.gutter - 3, rh - 2);
      }
      if (marker && marker.frame === place.frame && marker.row === place.row) {
        const bar = ctx.createLinearGradient(0, 0, this.gutter, 0);
        bar.addColorStop(0, c.marker);
        bar.addColorStop(1, c.bg);
        ctx.fillStyle = bar;
        ctx.fillRect(1, line * rh + 1, this.gutter - 3, rh - 2);
      }
      ctx.fillStyle = c.rowNumber;
      ctx.fillText(this.editor.rowLabel(place.row), cw * 0.5, line * rh + rh / 2 + 1);
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.separator;
    ctx.fillRect(this.gutter - 1, 0, 1, this.height);

    // selection (which may go on into other frames), then the cursor
    if (selection) {
      const x1 = Math.max(this.gutter, this.columnX(selection.start.channel, selection.start.column)[0]);
      const [x2, w2] = this.columnX(selection.end.channel, selection.end.column);
      ctx.fillStyle = c.selection;
      if (x2 + w2 > x1)
        places.forEach((place, line) => {
          if (place && inRows(selection, place.frame, place.row))
            ctx.fillRect(x1, line * rh, x2 + w2 - x1, rh);
        });
    }
    const [cx, cwidth] = this.columnX(cursor.channel, cursor.column);
    if (cx + cwidth > this.gutter) {
      ctx.fillStyle = c.cursor;
      ctx.fillRect(Math.max(cx, this.gutter), middle * rh, cwidth - Math.max(0, this.gutter - cx), rh);
      // the character under the cursor again, on top
      const cell = song.cell(track, cursor.frame, cursor.channel, cursor.row);
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(cx, this.gutter), middle * rh, cwidth, rh);
      ctx.clip();
      ctx.globalAlpha = 1;
      this.drawCell(cell, left + this.channels[cursor.channel].x + cw * 0.5, middle * rh + rh / 2 + 1,
        this.channels[cursor.channel].effColumns, channels[cursor.channel].id, c.bg);
      ctx.restore();
    }
  }

  // One cell's text; `ink` draws all of it in one colour (over the cursor)
  drawCell(cell, x, y, effColumns, channelId, ink = null) {
    const { ctx, colors: c, charWidth: cw } = this;
    const dots = (count, at) => {
      ctx.fillStyle = ink ?? c.dim;
      ctx.fillText('·'.repeat(count), x + at * cw, y);
    };
    const note = noteText(cell[0], cell[1], channelId);
    if (note) {
      ctx.fillStyle = ink ?? c.text;
      ctx.fillText(note, x, y);
    } else {
      dots(3, 0);
    }
    if (this.editor.compact)
      return;
    if (cell[3] === NO_INSTRUMENT)
      dots(2, 4);
    else {
      ctx.fillStyle = ink ?? c.instrument;
      ctx.fillText(cell[3] === HOLD_INSTRUMENT ? '&&' : hex2(cell[3]), x + 4 * cw, y);
    }
    if (cell[2] === MAX_VOLUME)
      dots(1, 7);
    else {
      ctx.fillStyle = ink ?? c.volume;
      ctx.fillText(HEX[cell[2] & 15], x + 7 * cw, y);
    }
    const letters = this.editor.song.effects.letters;
    for (let e = 0; e < effColumns; ++e) {
      const at = 9 + 4 * e;
      if (!cell[4 + e])
        dots(3, at);
      else {
        ctx.fillStyle = ink ?? c.effect;
        ctx.fillText((letters[cell[4 + e]] || '?') + hex2(cell[8 + e]), x + at * cw, y);
      }
    }
  }

  // [x, width] of a column on the canvas
  columnX(channel, column) {
    const cw = this.charWidth;
    const [at, chars] = columnPlace(this.editor.compact ? 0 : column);
    const x = this.gutter - this.scroller.scrollLeft + this.channels[channel].x + cw * 0.5 + at * cw;
    return [x, chars * cw];
  }

  // The place under a point of the canvas: {frame, row, channel, column}, or null; the
  // channel and column are null over the row numbers and past the channels. `clamp`: the
  // nearest cell for a point anywhere (a drag): the first or last line shown, row of the
  // track, channel.
  hit(clientX, clientY, { clamp = false } = {}) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const { cursor, song, track } = this.editor;
    let line = Math.floor(y / this.rowHeight);
    if (clamp)
      line = Math.max(0, Math.min(this.lines - 1, line));
    let place = this.offset(cursor.frame, cursor.row, line - this.middle);
    if (!place && clamp) {
      const { rows, frames } = song.track(track);
      place = line < this.middle ? { frame: 0, row: 0 } : { frame: frames - 1, row: rows - 1 };
    }
    if (clamp) {
      const content = x - this.gutter + this.scroller.scrollLeft;
      if (content < 0)
        return { ...place, channel: 0, column: 0 };
      const last = this.channels.length - 1;
      if (content >= this.channels[last].x + this.channels[last].width)
        return { ...place, channel: last, column: this.editor.columns(last) - 1 };
    }
    if (!place || x < this.gutter)
      return place ? { ...place, channel: null, column: null } : null;
    const content = x - this.gutter + this.scroller.scrollLeft;
    const channel = this.channels.findIndex(ch => content >= ch.x && content < ch.x + ch.width + 1);
    if (channel < 0)
      return { ...place, channel: null, column: null };
    const chars = (content - this.channels[channel].x) / this.charWidth - 0.5;
    const columns = this.editor.columns(channel);
    let column = 0;
    for (let i = columns - 1; i >= 0; --i)
      if (chars >= columnPlace(i)[0] - (i === 0 ? 1 : 0.5)) {
        column = i;
        break;
      }
    return { ...place, channel, column };
  }

  // Scrolls sideways to show the channel
  reveal(channel) {
    const ch = this.channels[channel];
    if (!ch)
      return;
    const view = this.width - this.gutter;
    const scroll = this.scroller.scrollLeft;
    if (ch.x < scroll)
      this.scroller.scrollLeft = ch.x;
    else if (ch.x + ch.width > scroll + view)
      this.scroller.scrollLeft = Math.min(ch.x, ch.x + ch.width - view);
  }
}

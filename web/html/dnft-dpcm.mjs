// Dn-FamiTracker web port - the DPCM samples of the 2A03: the panel of the instrument editor
// that says which sample each key plays, the samples of the module, and the sample editor.
//
// The samples belong to the module, not to an instrument: an instrument's keys point at
// them by number (0 for none, else the slot + 1). A sample is the bytes the DPCM channel
// reads: one bit per step of its delta counter, low bit first, 16n + 1 bytes long as the
// hardware wants (at most 4081).

import { NOTE } from './dnft-song.mjs';
import { build, colors, fitCanvas } from './dnft-instrument-panels.mjs';

const KEYS = 96;
const NOTES = 12;
const OCTAVES = 8;
const PAD_BYTE = 0xAA;
const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
// The DMC's periods at the NTSC CPU clock (nes_dmc.cpp), which give each pitch its rate
const DMC_PERIODS = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
const CPU_CLOCK = 1789773;
const DEFAULT_PITCH = 15;

const pad2 = value => String(value).padStart(2, '0');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rateOf = pitch => CPU_CLOCK / DMC_PERIODS[clamp(pitch, 0, 15)];
const rateText = pitch => `${(rateOf(pitch) / 1000).toFixed(1)} kHz`;
const keyName = key => `${NOTE_NAMES[key % NOTES]}${Math.floor(key / NOTES)}`;
const safeName = name => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim();

// ---- what is done to the bytes of a sample --------------------------------------------------

// A .dmc file as a sample: at most `maxSize` bytes, and 16n + 1 of them, the rest 0xAA
// (CInstrumentEditorDPCM::LoadSample())
export function fitSample(bytes, maxSize) {
  const size = Math.min(bytes.length, maxSize);
  const padded = (size & 0xF) !== 1 ? size + 0x10 - ((size + 0x0F) & 0x0F) : size;
  const out = new Uint8Array(padded).fill(PAD_BYTE);
  out.set(bytes.subarray(0, size));
  return { data: out, clipped: bytes.length > maxSize };
}

// The level the delta counter is at after each bit: 0-127 by steps of 2
// (CSampleEditorView::ExpandSample()). `start` is where the counter starts, 0 or 64.
export function expandSample(data, start) {
  const levels = new Uint8Array(data.length * 8);
  let counter = start;
  for (let i = 0; i < levels.length; ++i) {
    if (data[i >> 3] & (1 << (i & 7))) {
      if (counter < 126)
        counter += 2;
    } else if (counter > 1) {
      counter -= 2;
    }
    levels[i] = counter;
  }
  return levels;
}

// Takes the blocks (16 bytes each) from `first` up to `last` out (CSampleEditorDlg::OnBnClickedDelete())
export function deleteBlocks(data, first, last) {
  const start = first * 16;
  let end = last * 16;
  if (end >= data.length)
    end = data.length - 1;
  if (start >= end)
    return data;
  const out = new Uint8Array(data.length - (end - start));
  out.set(data.subarray(0, start));
  out.set(data.subarray(end), start);
  return out;
}

// "Tilt": a bit of the blocks is cleared at regular steps, which pulls the level down
// (CSampleEditorDlg::OnBnClickedTilt()); `random` gives where the steps begin
export function tiltBlocks(data, first, last, random = Math.random) {
  const out = data.slice();
  const start = first * 16;
  const end = Math.min(last * 16, out.length);
  const diff = end - start;
  const step = Math.floor(diff * 8 / 10);
  if (step < 1)
    return out;
  let counter = Math.floor(random() * step);
  for (let i = start; i < end; ++i)
    for (let j = 0; j < 8; ++j)
      if (++counter === step) {
        out[i] &= 0xFF ^ (1 << j);
        counter = 0;
      }
  return out;
}

// The bits of every byte the other way round (CSampleEditorDlg::OnBnClickedBitReverse())
export function reverseBits(data) {
  return data.map(byte => {
    let out = 0;
    for (let i = 0; i < 8; ++i)
      if (byte & (1 << i))
        out |= 0x80 >> i;
    return out;
  });
}

// ---- wave files as samples ----------------------------------------------------------------------

const DMC_BIAS = 32;        // where the delta counter is taken to start: half of its 6 bits
const PAD_STEP = 0x55;      // bits that go up and down: the level stays where it is

// A wave file's sound as mono samples in the range of 16 bits (the channels averaged): PCM of
// 8, 16, 24 or 32 bits, or floating point. Throws an Error with `code` 'format' when it is
// no wave file, or a kind the tracker does not read (CPCMImport::OpenWaveFile()).
export function decodeWave(bytes) {
  const invalid = () => Object.assign(new Error('not a supported wave file'), { code: 'format' });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = at => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
    throw invalid();
  let format = null, data = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = tag(at), size = view.getUint32(at + 4, true), body = at + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.length) {
      format = {
        tag: view.getUint16(body, true), channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true),
      };
      // WAVE_FORMAT_EXTENSIBLE: the kind is the first two bytes of the sub-format
      if (format.tag === 0xFFFE && size >= 26 && body + 26 <= bytes.length)
        format.tag = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = { start: body, length: Math.min(size, bytes.length - body) };
    }
    at = body + size + (size & 1);
  }
  if (!format || !data || !format.channels || !format.rate)
    throw invalid();
  const { tag: kind, channels, bits } = format;
  const width = bits >> 3;
  const supported = (kind === 1 && [8, 16, 24, 32].includes(bits)) || (kind === 3 && (bits === 32 || bits === 64));
  if (!supported)
    throw invalid();
  const frames = Math.floor(data.length / (channels * width));
  const read = at => {
    switch (kind === 3 ? -bits : bits) {
      case 8: return (bytes[at] - 128) * 256;
      case 16: return view.getInt16(at, true);
      case 24: return (view.getInt8(at + 2) * 65536 + view.getUint16(at, true)) / 256;
      case 32: return view.getInt32(at, true) / 65536;
      case -32: return view.getFloat32(at, true) * 32768;
      default: return view.getFloat64(at, true) * 32768;
    }
  };
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; ++i) {
    let sum = 0;
    for (let c = 0; c < channels; ++c)
      sum += read(data.start + (i * channels + c) * width);
    samples[i] = sum / channels;
  }
  return { rate: format.rate, channels, bits, float: kind === 3, samples };
}

// The samples (16 bit range, at `rate`) as a DPCM sample of the pitch 0-15's rate: filtered
// down to it with a windowed sinc, `gainDb` louder, then turned into steps of the delta
// counter, one bit each, that follow the wave (CPCMImport::ConvertFile()). At most `maxSize`
// bytes, 16n + 1 of them. `clipped` tells that the wave was longer.
export function convertToDpcm(samples, rate, pitch, gainDb, maxSize) {
  const factor = rateOf(pitch) / rate;            // output samples for an input sample
  const gain = 10 ** (gainDb / 20);
  const cutoff = 0.9 * Math.min(1, factor);       // of the input's rate, so that nothing folds back
  const half = 16 / cutoff;                       // input samples on each side that the filter reads
  const count = Math.min(Math.floor(samples.length * factor), maxSize * 8);
  const out = [];
  let counter = DMC_BIAS, byte = 0, bits = 0;
  for (let n = 0; n < count; ++n) {
    const at = n / factor;
    let sum = 0;
    for (let k = Math.ceil(at - half), last = Math.floor(at + half); k <= last; ++k) {
      if (k < 0 || k >= samples.length)
        continue;
      const u = at - k;
      const x = Math.PI * cutoff * u;
      const window = 0.42 + 0.5 * Math.cos(Math.PI * u / half) + 0.08 * Math.cos(2 * Math.PI * u / half);
      sum += samples[k] * (u === 0 ? cutoff : cutoff * Math.sin(x) / x) * window;
    }
    // the filter rings; the tracker holds the wave to what 16 bits and a little more allow
    const value = clamp(sum, -65535, 65535);
    const level = Math.trunc(value * gain / 1024) + DMC_BIAS;
    byte >>= 1;
    if (level >= counter) {
      counter = Math.min(63, counter + 1);
      byte |= 0x80;
    } else {
      counter = Math.max(0, counter - 1);
    }
    if (++bits === 8) {
      out.push(byte);
      bits = 0;
    }
  }
  // 16n + 1 bytes, as the hardware reads
  while (out.length < maxSize && (out.length & 0x0F) !== 1)
    out.push(PAD_STEP);
  return { data: Uint8Array.from(out), clipped: Math.floor(samples.length * factor) > maxSize * 8 };
}

// ---- the sample editor ----------------------------------------------------------------------

const BLOCK_BITS = 128;      // a step of the selection: 16 bytes

// A dialog to look at a sample as the wave its bits make, and to cut, tilt and turn it
// round. edit(name, data) resolves with {name, data} when OK is pressed, with null otherwise.
class SampleEditor {
  constructor(panel) {
    this.panel = panel;
    this.owner = panel.owner;      // the instrument editor
    const t = this.owner.strings;
    const dialog = this.dialog = build(`
      <dialog class="dnft-dialog dnft-sample-dialog">
        <form method="dialog" class="dnft-dialog-head">
          <strong class="dnft-dialog-title"></strong>
          <span class="dnft-dialog-tools">
            <button type="button" class="dnft-button dnft-button--primary" data-role="ok" data-t="ok"></button>
            <button type="submit" class="dnft-button" value="cancel" data-t="cancel"></button>
          </span>
        </form>
        <div class="dnft-sample-body">
          <div class="dnft-sample-tools">
            <button type="button" class="dnft-button" data-role="play" data-title="sampleEditPlayHint"></button>
            <label class="dnft-field dnft-field--inline"><span data-t="dpcmPitch"></span><select data-role="pitch"></select></label>
            <label class="dnft-check"><input type="checkbox" data-role="center"> <span data-t="sampleEditCenter"></span></label>
            <button type="button" class="dnft-button" data-role="delete" data-t="sampleEditDelete" data-title="sampleEditDeleteHint"></button>
            <button type="button" class="dnft-button" data-role="tilt" data-t="sampleEditTilt" data-title="sampleEditTiltHint"></button>
            <button type="button" class="dnft-button" data-role="reverse" data-t="sampleEditReverse" data-title="sampleEditReverseHint"></button>
          </div>
          <canvas class="dnft-sample-canvas" tabindex="0"></canvas>
          <div class="dnft-sample-view">
            <label class="dnft-field dnft-field--inline dnft-sample-zoom"><span data-role="zoom-label"></span><input type="range" min="0" max="20" value="0" data-role="zoom"></label>
            <input type="range" min="0" max="1000" value="0" class="dnft-sample-scroll" data-role="scroll" aria-label="scroll">
          </div>
          <p class="dnft-sample-status" data-role="status"></p>
          <p class="dnft-hint" data-t="sampleEditHint"></p>
        </div>
      </dialog>`, t);
    this.owner.editor.root.append(dialog);
    const $ = role => dialog.querySelector(`[data-role="${role}"]`);
    this.canvas = dialog.querySelector('canvas');
    this.pitchSelect = $('pitch');
    this.center = $('center');
    this.zoom = $('zoom');
    this.scroll = $('scroll');
    this.status = $('status');
    this.title = dialog.querySelector('.dnft-dialog-title');
    this.playButton = $('play');
    this.playButton.textContent = `▶ ${t.sampleEditPlay}`;
    this.pitchSelect.append(...Array.from({ length: 16 }, (_, i) => new Option(`${i} (${rateText(i)})`, i)));
    this.pitchSelect.value = DEFAULT_PITCH;
    this.base = document.createElement('canvas');   // the wave, drawn again only when it or the view changes

    this.data = new Uint8Array(0);
    this.levels = new Uint8Array(0);
    this.selection = null;      // [first, last) in blocks
    this.startOffset = 0;       // where a preview starts, in steps of 64 bytes
    this.viewStart = 0;         // in bits
    this.viewBits = 0;
    this.playing = null;        // {began, from, rate}
    this.dragging = null;
    this.resolve = null;

    $('ok').addEventListener('click', () => this.finish(true));
    // (a close event that comes after the dialog was opened again is not the end of this use)
    dialog.addEventListener('close', () => {
      if (!dialog.open)
        this.finish(false);
    });
    dialog.addEventListener('keydown', e => this.onKey(e));
    this.playButton.addEventListener('click', () => this.play());
    $('delete').addEventListener('click', () => this.deleteSelection());
    $('tilt').addEventListener('click', () => this.tilt());
    $('reverse').addEventListener('click', () => this.setData(reverseBits(this.data)));
    this.center.addEventListener('change', () => this.setData(this.data));
    this.zoom.addEventListener('input', () => this.setZoom());
    this.scroll.addEventListener('input', () => this.setScroll());
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', () => { this.dragging = null; });
    new ResizeObserver(() => this.drawAll()).observe(canvas);
  }

  // Opens the editor on a copy of the sample
  edit(name, data) {
    this.name = name;
    const t = this.owner.strings;
    this.title.textContent = `${t.sampleEditTitle} [${name}]`;
    this.zoom.value = 0;
    this.selection = null;
    this.startOffset = 0;
    this.center.checked = false;
    this.dirty = false;
    this.setData(Uint8Array.from(data), { keep: false });
    return new Promise(resolve => {
      this.resolve = resolve;
      this.dialog.showModal();
      this.setZoom();
    });
  }

  finish(ok) {
    if (!this.resolve)
      return;
    const resolve = this.resolve;
    this.resolve = null;
    this.stop();
    if (this.dialog.open)
      this.dialog.close();
    resolve(ok ? { name: this.name, data: this.data, changed: this.dirty } : null);
  }

  // The bytes are new: the wave is worked out again, the selection and the start are gone
  setData(data, { keep = true } = {}) {
    if (keep && data !== this.data)
      this.dirty = true;
    this.data = data;
    this.levels = expandSample(data, this.center.checked ? 64 : 0);
    this.selection = null;
    this.startOffset = Math.min(this.startOffset, Math.floor(data.length / 64));
    this.stop();
    this.setZoom();
    this.showButtons();
  }

  showButtons() {
    const selected = !!this.selection;
    this.dialog.querySelector('[data-role="delete"]').disabled = !selected;
    this.dialog.querySelector('[data-role="tilt"]').disabled = !selected;
  }

  // The part of the wave in view: `zoom` 0 is all of it, 20 is a hundredth
  setZoom() {
    const bits = this.levels.length;
    const factor = 1 - Number(this.zoom.value) / 20;
    const fraction = (1 - 0.01) * factor * factor + 0.01;
    const middle = this.viewStart + this.viewBits / 2;
    this.viewBits = Math.max(1, Math.min(bits, Math.round(bits * fraction)));
    this.viewStart = clamp(Math.round(middle - this.viewBits / 2), 0, Math.max(0, bits - this.viewBits));
    this.dialog.querySelector('[data-role="zoom-label"]').textContent = `${this.owner.strings.sampleEditZoom} (${(bits / this.viewBits).toFixed(2)}x)`;
    this.scroll.disabled = this.viewBits >= bits;
    this.scroll.value = bits > this.viewBits ? Math.round(this.viewStart / (bits - this.viewBits) * 1000) : 0;
    this.drawAll();
    this.showStatus();
  }

  setScroll() {
    const bits = this.levels.length;
    this.viewStart = Math.round((bits - this.viewBits) * Number(this.scroll.value) / 1000);
    this.drawAll();
  }

  showStatus(bit = null) {
    const t = this.owner.strings;
    const size = this.data.length;
    const pitch = Number(this.pitchSelect.value);
    const parts = [
      `${t.sampleEditSize}: ${size} B`,
      `${(size * 8 / rateOf(pitch)).toFixed(2)} s`,
      `${t.sampleEditEnd}: ${size ? this.levels[this.levels.length - 1] : 0}`,
    ];
    if (bit !== null)
      parts.unshift(`${t.sampleEditPosition}: 0x${Math.floor(bit / 512).toString(16).toUpperCase().padStart(2, '0')} / ${Math.floor(bit / 8)}`);
    this.status.textContent = parts.join('  ·  ');
  }

  // ---- drawing ---------------------------------------------------------------------------------

  drawAll() {
    this.drawWave();
    this.paint();
  }

  // The wave, with the guides of every block of 16 bytes, on the canvas behind the cursors
  drawWave() {
    const { canvas } = this;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height)
      return;
    const dpr = window.devicePixelRatio || 1;
    this.base.width = Math.round(width * dpr);
    this.base.height = Math.round(height * dpr);
    const ctx = this.base.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const color = colors(canvas);
    ctx.fillStyle = color('pe-bg');
    ctx.fillRect(0, 0, width, height);
    const bits = this.levels.length;
    if (!bits) {
      ctx.fillStyle = color('pe-row-number');
      ctx.fillText(this.owner.strings.sampleEditEmpty, 10, 20);
      return;
    }
    const step = this.viewBits / width;   // bits per pixel
    // block guides, when they are not too close
    if (BLOCK_BITS / step >= 4) {
      for (let block = Math.ceil(this.viewStart / BLOCK_BITS); block * BLOCK_BITS < this.viewStart + this.viewBits; ++block) {
        ctx.fillStyle = block % 4 === 0 ? color('pe-bar') : color('pe-beat');
        ctx.fillRect(Math.round((block * BLOCK_BITS - this.viewStart) / step), 0, 1, height);
      }
    }
    ctx.fillStyle = color('pe-separator');
    ctx.fillRect(0, Math.round(height / 2), width, 1);
    const y = level => height - 1 - level / 127 * (height - 2);
    ctx.strokeStyle = color('accent');
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (step <= 1) {
      // a step for every bit
      let at = Math.floor(this.viewStart);
      ctx.moveTo(0, y(this.levels[at]));
      for (let i = at; i < Math.min(bits, this.viewStart + this.viewBits + 1); ++i) {
        const x = (i - this.viewStart) / step;
        ctx.lineTo(x, y(this.levels[i]));
        ctx.lineTo(x + 1 / step, y(this.levels[i]));
      }
    } else {
      // the lowest and highest level of the bits behind each pixel
      for (let x = 0; x < width; ++x) {
        const from = Math.floor(this.viewStart + x * step);
        const to = Math.min(bits, Math.max(from + 1, Math.floor(this.viewStart + (x + 1) * step)));
        let low = 127, high = 0;
        for (let i = from; i < to; ++i) {
          if (this.levels[i] < low) low = this.levels[i];
          if (this.levels[i] > high) high = this.levels[i];
        }
        ctx.moveTo(x + 0.5, y(low));
        ctx.lineTo(x + 0.5, y(high));
      }
    }
    ctx.stroke();
  }

  // The wave with the selection, the start and the position being played
  paint() {
    const { canvas } = this;
    const fit = fitCanvas(canvas);
    if (!fit)
      return;
    const { ctx, width, height } = fit;
    const color = colors(canvas);
    ctx.drawImage(this.base, 0, 0, width, height);
    const step = this.viewBits / width;
    const at = bit => (bit - this.viewStart) / step;
    if (this.selection) {
      ctx.fillStyle = color('pe-selection');
      const from = at(this.selection[0] * BLOCK_BITS), to = at(this.selection[1] * BLOCK_BITS);
      ctx.fillRect(from, 0, to - from, height);
    }
    const line = (bit, css, dashed) => {
      const x = Math.round(at(bit)) + 0.5;
      if (x < 0 || x > width)
        return;
      ctx.strokeStyle = color(css);
      ctx.lineWidth = 1;
      ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    line(this.startOffset * 512, 'pe-instrument', true);
    if (this.playing) {
      const bit = this.playingBit();
      if (bit !== null)
        line(bit, 'pe-effect', false);
    }
  }

  // ---- the mouse and the keys --------------------------------------------------------------------

  bitAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    return this.viewStart + (e.clientX - rect.left) / rect.width * this.viewBits;
  }

  blockAt(e) {
    const blocks = Math.ceil(this.data.length / 16);
    return clamp(Math.round(this.bitAt(e) / BLOCK_BITS), 0, blocks);
  }

  down(e) {
    if (e.button !== 0 || !this.data.length)
      return;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus({ preventScroll: true });
    this.dragging = { block: this.blockAt(e), x: e.clientX, moved: false };
  }

  move(e) {
    this.showStatus(clamp(this.bitAt(e), 0, this.levels.length));
    if (!this.dragging)
      return;
    if (Math.abs(e.clientX - this.dragging.x) > 3)
      this.dragging.moved = true;
    if (!this.dragging.moved)
      return;
    const block = this.blockAt(e);
    const [first, last] = [Math.min(block, this.dragging.block), Math.max(block, this.dragging.block)];
    this.selection = first < last ? [first, last] : null;
    this.showButtons();
    this.paint();
  }

  up(e) {
    const drag = this.dragging;
    this.dragging = null;
    if (!drag || drag.moved)
      return;
    // a click sets where a preview starts, in steps of 64 bytes
    this.selection = null;
    this.startOffset = clamp(Math.floor(this.bitAt(e) / 512), 0, Math.floor(this.data.length / 64));
    this.showButtons();
    this.paint();
  }

  onKey(e) {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.altKey)
      return;
    // the sliders and the pitch box keep their arrow keys
    if (e.code.startsWith('Arrow') && e.target.matches('input[type=range], select'))
      return;
    const last = Math.floor(this.data.length / 64);
    const command = {
      Delete: () => this.deleteSelection(),
      Home: () => { this.startOffset = 0; },
      End: () => { this.startOffset = last; },
      ArrowLeft: () => { this.startOffset = Math.max(0, this.startOffset - 1); },
      ArrowRight: () => { this.startOffset = Math.min(last, this.startOffset + 1); },
      KeyP: () => this.play(),
    }[e.code];
    if (!command)
      return;
    e.preventDefault();
    command();
    this.paint();
  }

  // ---- what is done to the sample ----------------------------------------------------------------

  deleteSelection() {
    if (!this.selection)
      return;
    this.owner.editor.session.send('stopPreview');
    const [first, last] = this.selection;
    this.setData(deleteBlocks(this.data, first, last));
  }

  tilt() {
    if (!this.selection)
      return;
    const [first, last] = this.selection;
    const keep = this.selection;
    this.setData(tiltBlocks(this.data, first, last));
    this.selection = keep;
    this.showButtons();
    this.paint();
  }

  // ---- playing ---------------------------------------------------------------------------------

  play() {
    if (!this.data.length)
      return;
    const pitch = Number(this.pitchSelect.value);
    this.owner.editor.session.resume();
    this.owner.editor.session.send('previewSample', this.data.slice(), this.startOffset, pitch, this.center.checked);
    this.playing = { began: performance.now(), from: this.startOffset * 512, rate: rateOf(pitch) };
    const tick = () => {
      if (!this.playing)
        return;
      this.paint();
      if (this.playingBit() === null)
        this.playing = null;
      else
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Where the DPCM is, estimated from the time since it started: null when the sample is over
  playingBit() {
    const { began, from, rate } = this.playing;
    const bit = from + (performance.now() - began) / 1000 * rate;
    return bit < this.levels.length ? bit : null;
  }

  stop() {
    if (this.playing)
      this.owner.editor.session.send('stopPreview');
    this.playing = null;
  }
}

// ---- importing a wave file -------------------------------------------------------------------------

// A dialog to make a sample of a wave file: the pitch it is turned down to, and the gain.
// open(file) resolves with {name, data} when it is taken, with null otherwise.
class WaveImport {
  constructor(panel) {
    this.panel = panel;
    this.owner = panel.owner;
    const t = this.owner.strings;
    const dialog = this.dialog = build(`
      <dialog class="dnft-dialog dnft-dialog--narrow dnft-wave-import">
        <form method="dialog" class="dnft-dialog-head">
          <strong class="dnft-dialog-title" data-t="waveImportTitle"></strong>
          <span class="dnft-dialog-tools">
            <button type="button" class="dnft-button dnft-button--primary" data-role="ok" data-t="waveImportAdd"></button>
            <button type="submit" class="dnft-button" value="cancel" data-t="cancel"></button>
          </span>
        </form>
        <div class="dnft-dialog-body">
          <p class="dnft-hint" data-role="info"></p>
          <label class="dnft-field"><span data-role="pitch-label"></span><input type="range" min="0" max="15" value="15" data-role="pitch"></label>
          <label class="dnft-field"><span data-role="gain-label"></span><input type="range" min="-12" max="12" value="0" data-role="gain"></label>
          <p class="dnft-hint" data-role="result"></p>
          <div><button type="button" class="dnft-button" data-role="play"></button></div>
        </div>
      </dialog>`, t);
    this.owner.editor.root.append(dialog);
    const $ = role => dialog.querySelector(`[data-role="${role}"]`);
    this.info = $('info');
    this.pitch = $('pitch');
    this.gain = $('gain');
    this.result = $('result');
    this.okButton = $('ok');
    this.playButton = $('play');
    this.playButton.textContent = `▶ ${t.waveImportPlay}`;
    this.resolve = null;
    this.timer = 0;
    this.converted = null;
    for (const input of [this.pitch, this.gain])
      input.addEventListener('input', () => this.schedule());
    this.playButton.addEventListener('click', () => this.play());
    this.okButton.addEventListener('click', () => this.finish(true));
    dialog.addEventListener('close', () => {
      if (!dialog.open)
        this.finish(false);
    });
    dialog.addEventListener('keydown', e => e.stopPropagation());
  }

  // Reads the file and asks what to make of it
  async open(file) {
    const t = this.owner.strings;
    let wave;
    try {
      wave = decodeWave(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      this.owner.editor.message(`${file.name}: ${e.code === 'format' ? t.waveImportInvalid : e.message}`, true);
      return null;
    }
    this.wave = wave;
    this.name = file.name.replace(/\.wav$/i, '');
    const layout = wave.channels === 1 ? t.waveImportMono : wave.channels === 2 ? t.waveImportStereo : t.waveImportChannels.replace('%1', wave.channels);
    this.info.textContent = `${file.name} — ${t.waveImportInfo.replace('%1', wave.rate).replace('%2', wave.float ? `${wave.bits} float` : wave.bits).replace('%3', layout)}`;
    this.pitch.value = DEFAULT_PITCH;
    this.gain.value = 0;
    this.convert();
    return new Promise(resolve => {
      this.resolve = resolve;
      this.dialog.showModal();
    });
  }

  schedule() {
    this.showLabels();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.convert(), 40);
  }

  showLabels() {
    const t = this.owner.strings;
    const pitch = Number(this.pitch.value), gain = Number(this.gain.value);
    this.dialog.querySelector('[data-role="pitch-label"]').textContent = `${t.waveImportPitch} ${pitch} (${rateText(pitch)})`;
    this.dialog.querySelector('[data-role="gain-label"]').textContent = `${t.waveImportGain} ${gain > 0 ? '+' : ''}${gain} dB`;
  }

  convert() {
    clearTimeout(this.timer);
    const t = this.owner.strings;
    this.showLabels();
    const pitch = Number(this.pitch.value), gain = Number(this.gain.value);
    this.converted = convertToDpcm(this.wave.samples, this.wave.rate, pitch, gain, this.panel.maxSampleSize);
    const { data, clipped } = this.converted;
    this.result.textContent = t.waveImportResult.replace('%1', data.length).replace('%2', (data.length * 8 / rateOf(pitch)).toFixed(2)) +
      (clipped ? t.waveImportClipped.replace('%1', this.panel.maxSampleSize) : '');
    this.result.classList.toggle('is-error', clipped);
  }

  play() {
    if (!this.converted)
      return;
    this.convert();
    this.owner.editor.session.resume();
    // the samples are meant to start from the middle of the counter
    this.owner.editor.session.send('previewSample', this.converted.data.slice(), 0, Number(this.pitch.value), true);
  }

  finish(ok) {
    if (!this.resolve)
      return;
    clearTimeout(this.timer);
    this.convert();
    const resolve = this.resolve;
    this.resolve = null;
    this.owner.editor.session.send('stopPreview');
    const result = ok ? { name: this.name, data: this.converted.data } : null;
    if (this.dialog.open)
      this.dialog.close();
    resolve(result);
  }
}

// ---- the panel ----------------------------------------------------------------------------------

export class DpcmPanel {
  constructor(owner) {
    this.owner = owner;
    const t = owner.strings;
    this.root = build(`
      <div class="dnft-inst-panel dnft-dpcm">
        <section class="dnft-inst-section dnft-dpcm-keys">
          <h4 data-t="dpcmAssigned"></h4>
          <div class="dnft-octaves" role="tablist" data-role="octaves"></div>
          <table class="dnft-dpcm-table">
            <thead><tr>
              <th data-t="dpcmKey"></th><th data-t="dpcmSample"></th><th data-t="dpcmPitch"></th>
              <th data-t="dpcmLoop"></th><th data-t="dpcmDelta" data-title="dpcmDeltaHint"></th>
            </tr></thead>
            <tbody data-role="keys"></tbody>
          </table>
        </section>
        <section class="dnft-inst-section dnft-dpcm-library">
          <h4 data-t="dpcmLoaded"></h4>
          <ul class="dnft-sample-list" data-role="samples"></ul>
          <p class="dnft-hint" data-role="space"></p>
          <div class="dnft-dpcm-actions">
            <button type="button" class="dnft-button" data-role="load" data-t="dpcmLoad" data-title="dpcmLoadHint"></button>
            <button type="button" class="dnft-button" data-role="import" data-t="dpcmImport" data-title="dpcmImportHint"></button>
            <label class="dnft-field dnft-field--inline"><span data-t="dpcmPreviewPitch"></span><select data-role="preview-pitch"></select></label>
          </div>
          <input type="file" accept=".dmc" multiple hidden data-role="file">
          <input type="file" accept=".wav,audio/wav,audio/x-wav" hidden data-role="wave-file">
        </section>
      </div>`, t);
    const $ = role => this.root.querySelector(`[data-role="${role}"]`);
    this.octaveBar = $('octaves');
    this.keyBody = $('keys');
    this.sampleList = $('samples');
    this.space = $('space');
    this.file = $('file');
    this.previewPitch = $('preview-pitch');
    this.previewPitch.append(...Array.from({ length: 16 }, (_, i) => new Option(`${i} (${rateText(i)})`, i)));
    this.previewPitch.value = DEFAULT_PITCH;
    this.octave = 3;
    this.keys = { samples: new Uint8Array(KEYS), pitches: new Uint8Array(KEYS), deltas: new Int8Array(KEYS).fill(-1) };
    this.library = { samples: [], used: 0, capacity: 0x40000, maxSize: 0xFF1, slots: 64 };
    this.cache = new Map();       // sample slot -> {name, data}
    this.sampleEditor = null;     // made when it is first needed
    this.waveImport = null;
    this.heldKey = null;

    this.octaveBar.append(...Array.from({ length: OCTAVES }, (_, octave) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.role = 'tab';
      button.className = 'dnft-tab';
      button.textContent = octave;
      button.addEventListener('click', () => this.setOctave(octave));
      return button;
    }));
    $('load').addEventListener('click', () => this.file.click());
    this.waveFile = $('wave-file');
    $('import').addEventListener('click', () => this.waveFile.click());
    this.waveFile.addEventListener('change', () => {
      const file = this.waveFile.files[0];
      this.waveFile.value = '';
      if (file)
        this.importWave(file);
    });
    this.file.addEventListener('change', () => {
      const files = [...this.file.files];
      this.file.value = '';
      if (files.length)
        this.loadFiles(files);
    });
    this.keyBody.addEventListener('change', e => this.keyChanged(e));
    this.keyBody.addEventListener('pointerdown', e => this.keyDown(e));
    const release = () => this.keyUp();
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    this.sampleList.addEventListener('click', e => this.sampleClicked(e));
    this.sampleList.addEventListener('change', e => this.sampleRenamed(e));
  }

  get title() {
    return 'DPCM';
  }

  get maxSampleSize() {
    return this.library.maxSize;
  }

  get session() {
    return this.owner.editor.session;
  }

  async load(instrument) {
    const { dpcm } = instrument;
    // the samples may have changed since (Module > Cleanup, an instrument file)
    this.cache.clear();
    this.keys = { samples: Uint8Array.from(dpcm.samples), pitches: Uint8Array.from(dpcm.pitches), deltas: Int8Array.from(dpcm.deltas) };
    await this.refreshLibrary();
    // the octave with the first key assigned, as the desktop scrolls to octave 3
    const assigned = this.keys.samples.findIndex(sample => sample);
    if (assigned >= 0)
      this.octave = Math.floor(assigned / NOTES);
    this.renderOctaves();
    this.renderKeys();
  }

  activate() {
    this.renderOctaves();
  }

  async refreshLibrary() {
    this.library = await this.session.call('samples');
    this.renderSamples();
  }

  // ---- the keys -------------------------------------------------------------------------------------

  setOctave(octave) {
    this.octave = clamp(octave, 0, OCTAVES - 1);
    this.renderOctaves();
    this.renderKeys();
  }

  // The octave buttons, with a mark where a key has a sample
  renderOctaves() {
    [...this.octaveBar.children].forEach((button, octave) => {
      button.classList.toggle('is-active', octave === this.octave);
      button.setAttribute('aria-selected', String(octave === this.octave));
      let used = false;
      for (let note = 0; note < NOTES; ++note)
        used ||= this.keys.samples[octave * NOTES + note] > 0;
      button.classList.toggle('is-used', used);
    });
  }

  sampleLabel(slot) {
    const sample = this.library.samples.find(s => s.index === slot);
    return `${pad2(slot)} - ${sample ? sample.name : this.owner.strings.dpcmMissing}`;
  }

  renderKeys() {
    this.keyBody.replaceChildren(...Array.from({ length: NOTES }, (_, note) => this.buildRow(this.octave * NOTES + note)));
  }

  buildRow(key) {
    const t = this.owner.strings;
    const row = document.createElement('tr');
    row.dataset.key = key;
    row.innerHTML = `
      <td class="dnft-dpcm-keyname"><button type="button" class="dnft-icon-button" data-role="audition">▶</button><span></span></td>
      <td><select data-field="sample"></select></td>
      <td><select data-field="pitch"></select></td>
      <td class="dnft-dpcm-loop"><label class="dnft-check"><input type="checkbox" data-field="loop"><span class="dnft-dpcm-loop-label"></span></label></td>
      <td><input type="number" min="0" max="127" step="1" data-field="delta"></td>`;
    row.querySelector('.dnft-dpcm-keyname span').textContent = keyName(key);
    row.querySelector('[data-role="audition"]').title = t.dpcmAudition;
    row.querySelector('.dnft-dpcm-loop-label').textContent = t.dpcmLoop;
    const hints = { sample: t.dpcmSample, pitch: t.dpcmPitch, loop: t.dpcmLoop, delta: t.dpcmDeltaHint };
    for (const [field, hint] of Object.entries(hints)) {
      const control = row.querySelector(`[data-field="${field}"]`);
      control.title = hint;
      control.setAttribute('aria-label', `${keyName(key)} ${hint}`);
    }
    row.querySelector('[data-field="delta"]').placeholder = t.dpcmDeltaOff;
    const select = row.querySelector('[data-field="sample"]');
    select.append(new Option(t.dpcmNone, 0));
    const sample = this.keys.samples[key];
    // a key can point at a sample the module does not have (the desktop shows "n/a")
    if (sample > 0 && !this.library.samples.some(entry => entry.index === sample - 1))
      select.append(new Option(this.sampleLabel(sample - 1), sample));
    for (const entry of this.library.samples)
      select.append(new Option(this.sampleLabel(entry.index), entry.index + 1));
    row.querySelector('[data-field="pitch"]').append(...Array.from({ length: 16 }, (_, i) => new Option(`${i} (${rateText(i)})`, i)));
    this.refreshRow(row);
    return row;
  }

  // The controls of a key show what the key has
  refreshRow(row) {
    const key = Number(row.dataset.key);
    const sample = this.keys.samples[key];
    const pitch = this.keys.pitches[key];
    const delta = this.keys.deltas[key];
    row.classList.toggle('is-assigned', sample > 0);
    row.querySelector('[data-field="sample"]').value = sample;
    row.querySelector('[data-field="pitch"]').value = pitch & 0x0F;
    row.querySelector('[data-field="loop"]').checked = (pitch & 0x80) !== 0;
    row.querySelector('[data-field="delta"]').value = delta < 0 ? '' : delta;
    for (const control of row.querySelectorAll('[data-field]:not([data-field="sample"])'))
      control.disabled = sample === 0;
  }

  keyChanged(e) {
    const row = e.target.closest('tr');
    const field = e.target.dataset.field;
    if (!row || !field)
      return;
    const key = Number(row.dataset.key);
    const keys = this.keys;
    if (field === 'sample') {
      const sample = Number(e.target.value);
      // a key that gets its first sample plays it at the pitch the desktop's pitch box holds
      if (sample && !keys.samples[key]) {
        keys.pitches[key] = DEFAULT_PITCH;
        keys.deltas[key] = -1;
      }
      keys.samples[key] = sample;
    } else if (field === 'pitch') {
      keys.pitches[key] = (keys.pitches[key] & 0x80) | Number(e.target.value);
    } else if (field === 'loop') {
      keys.pitches[key] = (keys.pitches[key] & 0x0F) | (e.target.checked ? 0x80 : 0);
    } else if (field === 'delta') {
      keys.deltas[key] = e.target.value === '' ? -1 : clamp(Math.round(Number(e.target.value)) || 0, 0, 127);
    }
    this.sendKey(key);
    this.refreshRow(row);
    this.renderOctaves();
  }

  sendKey(key) {
    const { samples, pitches, deltas } = this.keys;
    this.owner.change('setDpcmKey', key, samples[key], pitches[key] & 0x0F, (pitches[key] & 0x80) !== 0, deltas[key]);
  }

  // The button of a key plays it on the DPCM channel, for as long as it is held
  keyDown(e) {
    const button = e.target.closest('[data-role="audition"]');
    if (!button)
      return;
    e.preventDefault();
    const key = Number(button.closest('tr').dataset.key);
    this.keyUp();
    const channel = this.owner.noteOn(NOTE.C + key % NOTES, Math.floor(key / NOTES), this.owner.auditionChannel());
    if (channel < 0)
      return;
    this.heldKey = { channel, button };
    button.classList.add('is-down');
  }

  keyUp() {
    if (!this.heldKey)
      return;
    this.owner.noteOff(this.heldKey.channel);
    this.heldKey.button.classList.remove('is-down');
    this.heldKey = null;
  }

  // ---- the samples of the module ------------------------------------------------------------------------

  renderSamples() {
    const t = this.owner.strings;
    const { samples, used, capacity } = this.library;
    this.sampleList.replaceChildren(...samples.map(sample => {
      const item = document.createElement('li');
      item.className = 'dnft-sample';
      item.dataset.slot = sample.index;
      item.innerHTML = `
        <span class="dnft-sample-index"></span>
        <input type="text" class="dnft-sample-name" maxlength="255" spellcheck="false" data-field="name">
        <span class="dnft-sample-size"></span>
        <button type="button" class="dnft-icon-button" data-op="play"></button>
        <button type="button" class="dnft-icon-button" data-op="edit"></button>
        <button type="button" class="dnft-icon-button" data-op="save"></button>
        <button type="button" class="dnft-icon-button" data-op="remove"></button>`;
      item.querySelector('.dnft-sample-index').textContent = pad2(sample.index);
      item.querySelector('input').value = sample.name;
      item.querySelector('.dnft-sample-size').textContent = `${sample.size} B`;
      const set = (op, text, hint) => {
        const button = item.querySelector(`[data-op="${op}"]`);
        button.textContent = text;
        button.title = hint;
        button.setAttribute('aria-label', hint);
      };
      set('play', '▶', t.dpcmPreview);
      set('edit', '✎', t.dpcmEdit);
      set('save', '⤓', t.dpcmSave);
      set('remove', '✕', t.dpcmRemove);
      return item;
    }));
    if (!samples.length) {
      const empty = document.createElement('li');
      empty.className = 'dnft-sample-empty';
      empty.textContent = t.dpcmNoSamples;
      this.sampleList.append(empty);
    }
    const kb = bytes => (bytes / 1024).toFixed(1);
    this.space.textContent = t.dpcmSpace.replace('%1', kb(used)).replace('%2', kb(capacity - used)).replace('%3', kb(capacity));
  }

  // A sample's bytes, from the engine (kept until the sample changes)
  async sampleData(slot) {
    if (!this.cache.has(slot))
      this.cache.set(slot, await this.session.call('sample', slot));
    return this.cache.get(slot);
  }

  async sampleClicked(e) {
    const button = e.target.closest('[data-op]');
    if (!button)
      return;
    const slot = Number(button.closest('li').dataset.slot);
    const t = this.owner.strings;
    try {
      switch (button.dataset.op) {
        case 'play': {
          const { data } = await this.sampleData(slot);
          this.session.resume();
          this.session.send('previewSample', data.slice(), 0, Number(this.previewPitch.value), false);
          break;
        }
        case 'edit':
          await this.editSample(slot);
          break;
        case 'save': {
          const { name, data } = await this.sampleData(slot);
          const file = `${safeName(name) || t.dpcmSampleFile}`.replace(/(\.dmc)?$/i, '.dmc');
          this.owner.editor.files.download(file, new Blob([data], { type: 'application/octet-stream' }));
          break;
        }
        case 'remove': {
          if (!confirm(t.dpcmConfirmRemove))
            return;
          await this.session.call('removeSample', slot);
          this.cache.delete(slot);
          this.owner.editor.changedInstruments();
          await this.refreshLibrary();
          this.renderKeys();
          this.renderOctaves();
          break;
        }
      }
    } catch (error) {
      this.owner.editor.message(t.failed + error.message, true);
    }
  }

  async sampleRenamed(e) {
    if (e.target.dataset.field !== 'name')
      return;
    const slot = Number(e.target.closest('li').dataset.slot);
    try {
      const { data } = await this.sampleData(slot);
      await this.session.call('setSample', slot, e.target.value, data);
      this.cache.delete(slot);
      this.owner.editor.changedInstruments();
      await this.refreshLibrary();
      this.renderKeys();
    } catch (error) {
      this.owner.editor.message(this.owner.strings.failed + error.message, true);
    }
  }

  async editSample(slot) {
    const sample = await this.sampleData(slot);
    this.sampleEditor ??= new SampleEditor(this);
    const result = await this.sampleEditor.edit(sample.name, sample.data);
    if (!result || !result.changed)
      return;
    await this.session.call('setSample', slot, result.name, result.data);
    this.cache.delete(slot);
    this.owner.editor.changedInstruments();
    await this.refreshLibrary();
  }

  // A wave file, converted as the dialog asks, becomes a sample of the module
  async importWave(file) {
    const t = this.owner.strings;
    this.waveImport ??= new WaveImport(this);
    const result = await this.waveImport.open(file);
    if (!result)
      return;
    try {
      await this.session.call('setSample', -1, result.name, result.data);
    } catch (error) {
      this.owner.editor.message(`${file.name}: ${error.message}`, true);
      return;
    }
    this.owner.editor.changedInstruments();
    this.owner.editor.message(t.waveImported + result.name);
    await this.refreshLibrary();
    this.renderKeys();
  }

  // .dmc files become samples of the module
  async loadFiles(files) {
    const t = this.owner.strings;
    const { maxSize } = this.library;
    let added = 0, clipped = false;
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const fitted = fitSample(bytes, maxSize);
        clipped ||= fitted.clipped;
        await this.session.call('setSample', -1, file.name.replace(/\.dmc$/i, ''), fitted.data);
        ++added;
      } catch (error) {
        this.owner.editor.message(`${file.name}: ${error.message}`, true);
        break;
      }
    }
    if (added) {
      this.owner.editor.changedInstruments();
      this.owner.editor.message(t.dpcmFilesLoaded.replace('%1', added) + (clipped ? t.dpcmClipped : ''), clipped);
    }
    await this.refreshLibrary();
    this.renderKeys();
  }
}

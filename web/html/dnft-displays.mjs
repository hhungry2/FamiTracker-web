// Dn-FamiTracker web port - what the editor shows of the sound as it plays: the volume
// meters of the channels (in their headers), the oscilloscope and the spectrum, and the
// register state (View > Register State). They read what the engine reports (the session:
// levels, analyser, registerView(), src/session_bindings.cpp) and draw it, the way the
// desktop's pattern editor and control panel do (CPatternEditor::DrawMeters(),
// DrawRegisters(), CVisualizerWnd).
//
//   const displays = new Displays(editor);   // the editor calls displays.tick() every frame
//   displays.meters.attach(canvases);        // the pattern view's header, one canvas per channel

import { CHIP } from './dnft-song.mjs';

const METER_STEPS = 15;
const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
const hex = (value, digits = 2) => value.toString(16).toUpperCase().padStart(digits, '0');

// ---- the volume meters ---------------------------------------------------------------

// Fifteen bars in the header of each channel, green going to yellow as they rise
export class Meters {
  constructor(editor) {
    this.editor = editor;
    this.canvases = [];
    this.shown = [];
  }

  attach(canvases) {
    this.canvases = canvases;
    this.shown = canvases.map(() => -1);
    this.colors = null;
    this.paint(this.editor.session?.levels);
  }

  // The bar colours: (from the desktop's COL_LIGHT, which goes towards yellow as the level rises)
  palette() {
    const style = getComputedStyle(this.editor.root);
    this.off = style.getPropertyValue('--dnft-pe-dim').trim() || '#3a3f4d';
    this.colors = Array.from({ length: METER_STEPS }, (_, i) => {
      const mix = (100 - i * i / 3) / 100;
      const r = Math.round(0x40 * mix + 0xF0 * (1 - mix));
      const g = Math.round(0xF0 * mix + 0xF0 * (1 - mix));
      const b = Math.round(0x20 * mix);
      return `rgb(${r}, ${g}, ${b})`;
    });
  }

  paint(levels) {
    if (!this.colors)
      this.palette();
    this.canvases.forEach((canvas, channel) => {
      const level = Math.min(METER_STEPS, levels?.[channel] ?? 0);
      if (level === this.shown[channel])
        return;
      this.shown[channel] = level;
      const ctx = canvas.getContext('2d');
      const { width, height } = canvas;
      const bar = width / METER_STEPS;
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < METER_STEPS; ++i) {
        ctx.fillStyle = i < level ? this.colors[i] : this.off;
        ctx.fillRect(Math.round(i * bar), 0, Math.max(1, Math.round(bar) - 1), height);
      }
    });
  }

  tick() {
    if (this.canvases.length)
      this.paint(this.editor.session.levels);
  }
}

// ---- the oscilloscope and the spectrum ----------------------------------------------------

// A canvas that shows what the output sounds like: 'scope', 'spectrum' or 'off'
export class Visualizer {
  constructor(editor, canvas) {
    this.editor = editor;
    this.canvas = canvas;
    this.mode = 'off';
    this.wave = null;
    this.bins = null;
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setMode(mode) {
    this.mode = mode;
    this.canvas.hidden = mode === 'off';
    this.resize();
    this.draw();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(this.canvas.clientWidth * dpr), height = Math.round(this.canvas.clientHeight * dpr);
    if (width && height && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  tick() {
    if (this.mode !== 'off' && !document.hidden)
      this.draw();
  }

  draw() {
    const analyser = this.editor.session?.analyser;
    const { canvas } = this;
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    if (!analyser || !width || !height)
      return;
    const style = getComputedStyle(canvas);
    ctx.fillStyle = style.getPropertyValue('--dnft-pe-bg').trim() || '#101218';
    ctx.fillRect(0, 0, width, height);
    const color = style.getPropertyValue('--dnft-pe-instrument').trim() || '#86e0b3';
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 0.8);
    if (this.mode === 'scope')
      this.drawScope(ctx, analyser, width, height);
    else
      this.drawSpectrum(ctx, analyser, width, height);
  }

  // The signal from a rising zero crossing, so that a steady note stands still
  drawScope(ctx, analyser, width, height) {
    this.wave ??= new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(this.wave);
    const wave = this.wave;
    let start = 0;
    for (let i = 1; i < wave.length / 2; ++i)
      if (wave[i - 1] <= 0 && wave[i] > 0) {
        start = i;
        break;
      }
    const points = Math.min(wave.length - start, 512);
    ctx.beginPath();
    for (let i = 0; i < points; ++i) {
      const x = i / (points - 1) * width;
      const y = height / 2 - Math.max(-1, Math.min(1, wave[start + i] * 1.5)) * height / 2 * 0.9;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }

  // Bars from 40 Hz to 16 kHz, a note's width apart
  drawSpectrum(ctx, analyser, width, height) {
    this.bins ??= new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(this.bins);
    const rate = analyser.context.sampleRate;
    const bars = Math.max(8, Math.floor(width / (3 * (window.devicePixelRatio || 1))));
    const low = Math.log(40), high = Math.log(16000);
    for (let i = 0; i < bars; ++i) {
      const from = Math.exp(low + (high - low) * i / bars), to = Math.exp(low + (high - low) * (i + 1) / bars);
      const first = Math.max(0, Math.floor(from / rate * 2 * this.bins.length)), last = Math.max(first, Math.ceil(to / rate * 2 * this.bins.length) - 1);
      let top = 0;
      for (let b = first; b <= last && b < this.bins.length; ++b)
        top = Math.max(top, this.bins[b]);
      const h = top / 255 * height;
      ctx.fillRect(Math.round(i * width / bars), height - h, Math.max(1, Math.floor(width / bars) - 1), h);
    }
  }
}

// ---- the register state ---------------------------------------------------------------------

// The colour of a register that was written `since` ticks ago, a new value `fresh` ticks ago
// (CPatternEditor::DrawRegisters()): from the colours of a fresh write to a grey
const DECAY_COLOR = [
  0xFFFF80, 0xE6F993, 0xCCF3A6, 0xB3ECB9, 0x99E6CC, 0x80E0E0, 0x80D9E3, 0x80D3E6,
  0x80CCE9, 0x80C6EC, 0x80C0F0, 0x80B9F3, 0x80B3F6, 0x80ACF9, 0x80A6FC, 0x80A0FF,
].map(bgr => [bgr & 0xFF, (bgr >> 8) & 0xFF, (bgr >> 16) & 0xFF]);
const STALE = [0xC0, 0xC0, 0xC0];
const HEADING = '#afafff';
const DIM_TEXT = '#808080';
const DECAY_TICKS = 15;

export const registerColor = age => {
  const since = age & 15, fresh = age >> 4;
  const w = since / DECAY_TICKS;
  const c = DECAY_COLOR[fresh].map((v, i) => Math.round(STALE[i] * w + v * (1 - w)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
};

export const noteOfFrequency = freq => 45 + 12 * Math.log2(freq / 440);
const noteName = note => NOTE_NAMES[((note % 12) + 12) % 12] + (Math.floor(note / 12) + 1);

// "pitch = $0FE ( 440.00Hz A-4  +00)": the period register, the pitch it makes, the nearest
// note and how many cents off it
export function pitchText(digits, period, freq, label = 'pitch', width = 7) {
  if (!freq)
    return `${label} = $${hex(period, digits)} (${'0.00'.padStart(width)}Hz ---   +00)`;
  const note = noteOfFrequency(freq);
  const rounded = note >= 0 ? Math.floor(note + 0.5) : Math.ceil(note - 0.5);
  const cents = Math.trunc((note - rounded) * 100);
  return `${label} = $${hex(period, digits)} (${freq.toFixed(2).padStart(width)}Hz ${noteName(rounded).padEnd(4)} ${(cents < 0 ? '-' : '+') + String(Math.abs(cents)).padStart(2, '0')})`;
}

// The noise and DPCM channels: a rate, or (the noise with its mode bit on) a pitch
function longPitchText(digits, register, freq, rate) {
  if (rate)
    return `rate  = $${hex(register, digits)} (${freq.toFixed(2).padStart(9)}Hz         )`;
  return pitchText(digits, register, freq, 'pitch', 9);
}

// What the register view keeps for each chip: the addresses it reads, and how many pitches
export const CHIP_VIEWS = [
  { chip: CHIP.NONE, name: '2A03', addresses: range(0x4000, 0x4014), frequencies: 5 },
  { chip: CHIP.VRC6, name: 'VRC6', addresses: [0x9000, 0x9001, 0x9002, 0xA000, 0xA001, 0xA002, 0xB000, 0xB001, 0xB002], frequencies: 3 },
  { chip: CHIP.MMC5, name: 'MMC5', addresses: range(0x5000, 0x5008), frequencies: 2 },
  { chip: CHIP.N163, name: 'N163', addresses: range(0x00, 0x80), frequencies: 8 },
  { chip: CHIP.FDS, name: 'FDS', addresses: range(0x4040, 0x408C), frequencies: 2 },
  { chip: CHIP.VRC7, name: 'VRC7', addresses: [...range(0x00, 0x08), ...range(0x10, 0x16), ...range(0x20, 0x26), ...range(0x30, 0x36)], frequencies: 6 },
  { chip: CHIP.S5B, name: '5B', addresses: range(0x00, 0x0E), frequencies: 4 },
];

function range(from, to) {
  return Array.from({ length: to - from }, (_, i) => from + i);
}

const LINE = 14;
const PITCH_WIDTH = 4;       // the pixels of a note in the bars at the end

export class RegisterView {
  constructor(editor, root) {
    this.editor = editor;
    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.pending = false;
    this.data = null;
    this.visible = false;
  }

  setVisible(visible) {
    this.visible = visible;
    this.root.hidden = !visible;
    if (visible)
      this.tick(true);
  }

  // Asks the engine for the registers about twenty times a second
  tick(force = false) {
    if (!this.visible || this.pending || document.hidden || !this.editor.song)
      return;
    const now = performance.now();
    if (!force && now - (this.last ?? 0) < 50)
      return;
    this.last = now;
    const chips = this.editor.song.info.chips;
    const requests = CHIP_VIEWS.filter(v => v.chip === CHIP.NONE || (chips & v.chip)).map(({ chip, addresses, frequencies }) => ({ chip, addresses, frequencies }));
    const song = this.editor.song;
    this.pending = true;
    this.editor.session.call('registerView', requests).then(data => {
      this.pending = false;
      if (this.editor.song === song)
        this.draw(data);
    }, () => { this.pending = false; });
  }

  draw(data) {
    const canvas = this.canvas;
    const lines = this.describe(data);
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(canvas.clientWidth, 1);
    const height = lines.reduce((sum, line) => sum + line.height, 8);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const style = getComputedStyle(this.root);
    ctx.fillStyle = style.getPropertyValue('--dnft-pe-bg').trim() || '#101218';
    ctx.fillRect(0, 0, width, height);
    ctx.font = `12px ${style.getPropertyValue('--dnft-mono').trim() || 'monospace'}`;
    ctx.textBaseline = 'middle';
    const char = ctx.measureText('0').width;
    let y = 4;
    for (const line of lines) {
      line.draw(ctx, 8, y, char, width);
      y += line.height;
    }
  }

  // The lines of the display, from what the engine sent for each chip
  describe(data) {
    const lines = [];
    const bars = [];
    const text = (string, color = DIM_TEXT) => ({ height: LINE, draw: (ctx, x, y) => { ctx.fillStyle = color; ctx.fillText(string, x, y + LINE / 2); } });
    for (const entry of data) {
      const view = CHIP_VIEWS.find(v => v.chip === entry.chip);
      const at = new Map(view.addresses.map((address, i) => [address, i]));
      const value = address => entry.registers[2 * at.get(address)];
      const age = address => entry.registers[2 * at.get(address) + 1];
      const freq = i => entry.frequencies[i] ?? 0;
      lines.push(text(`${view.name} registers`, HEADING));
      // a row of registers, and what it says
      const row = (label, first, count, info = '', infoAt = 190, addressOf = i => first + i) => lines.push({
        height: LINE,
        draw: (ctx, x, y, char) => {
          ctx.fillStyle = HEADING;
          ctx.fillText(label, x, y + LINE / 2);
          for (let i = 0; i < count; ++i) {
            const address = addressOf(i);
            ctx.fillStyle = registerColor(age(address));
            ctx.fillText(` $${hex(value(address))}`, x + char * (label.length + 4 * i), y + LINE / 2);
          }
          if (info) {
            ctx.fillStyle = DIM_TEXT;
            ctx.fillText(info, x + infoAt, y + LINE / 2);
          }
        },
      });
      const bar = (note, volume, tint = [1, 1, 1]) => bars.push({ note, volume, tint });
      const pitched = (hz, volume, tint) => {
        const note = hz ? noteOfFrequency(hz) : NaN;
        if (hz && volume && note >= -12 && note <= 96)
          bar(note, volume, tint);
        else
          bar(null, 0);
      };
      switch (entry.chip) {
        case CHIP.NONE:
          for (let i = 0; i < 5; ++i) {
            const base = 0x4000 + i * 4;
            const r = j => value(base + j);
            let info, volume = 0;
            if (i < 2) {
              const period = r(2) | ((r(3) & 7) << 8);
              const vol = r(0) & 0x10 ? r(0) & 0x0F : 21;
              info = `${pitchText(3, period, freq(i))}, vol = ${String(vol).padStart(2, '0')}, duty = ${r(0) >> 6}`;
              volume = vol / 15;
            } else if (i === 2) {
              info = pitchText(3, r(2) | ((r(3) & 7) << 8), freq(2));
              volume = r(0) ? 1 : 0;
            } else if (i === 3) {
              const vol = r(0) & 0x10 ? r(0) & 0x0F : 21;
              info = `${longPitchText(1, r(2) & 0x0F, freq(3), !(r(2) >> 7))}, vol = ${String(vol).padStart(2, '0')}, mode = ${r(2) >> 7}`;
              volume = vol / 15;
            } else {
              info = `${longPitchText(1, r(0) & 0x0F, freq(4), true)}, ${r(0) & 0x40 ? 'loop,' : 'once,'} size = ${((r(3) << 4) | 1)} byte${r(3) ? 's' : ''}`;
              volume = 0;
            }
            row(`$${hex(base, 4)}:`, base, 4, info);
            if (i < 3) pitched(freq(i), Math.min(1, volume));
            else if (i === 3) {
              if (r(2) >> 7) pitched(freq(3), Math.min(1, volume), [0.5, 0, 1]);
              else bar(volume ? (108 / 15) * (15 - (r(2) & 0x0F)) - 12 : null, Math.min(1, volume));
            } else bar(null, 0);
          }
          break;
        case CHIP.VRC6:
          for (let i = 0; i < 3; ++i) {
            const base = 0x9000 + i * 0x1000;
            const period = value(base + 1) | ((value(base + 2) & 15) << 8);
            const vol = value(base) & (i === 2 ? 0x3F : 0x0F);
            let info = `${pitchText(3, period, freq(i))}, vol = ${String(vol).padStart(2, '0')}`;
            if (i !== 2) info += `, duty = ${(value(base) >> 4) & 7}`;
            row(`$${hex(base, 4)}:`, base, 3, info);
            pitched(freq(i), vol / (i === 2 ? 0x3F : 0x0F));
          }
          break;
        case CHIP.MMC5:
          for (let i = 0; i < 2; ++i) {
            const base = 0x5000 + i * 4;
            const period = value(base + 2) | ((value(base + 3) & 7) << 8);
            const vol = value(base) & 0x10 ? value(base) & 0x0F : 21;
            row(`$${hex(base, 4)}:`, base, 4, `${pitchText(3, period, freq(i))}, vol = ${String(vol).padStart(2, '0')}, duty = ${value(base) >> 6}`);
            pitched(freq(i), Math.min(1, vol / 15));
          }
          break;
        case CHIP.N163: {
          const channels = this.editor.song.info.namcoChannels;
          const length = 0x80 - 8 * channels;
          lines.push({
            height: 22,
            draw: (ctx, x, y, char) => {
              const left = x + 300;
              ctx.fillStyle = '#000';
              ctx.fillRect(left, y, 2 * length, 18);
              for (let i = 0; i < length; ++i) {
                ctx.fillStyle = registerColor(age(i));
                const hi = (value(i) >> 4) & 15, lo = value(i) & 15;
                ctx.fillRect(left + 2 * i, y + 17 - lo, 1, lo);
                ctx.fillRect(left + 2 * i + 1, y + 17 - hi, 1, hi);
              }
            },
          });
          const sound = [];
          for (let i = 0; i < 16; ++i) {
            const base = i * 8;
            const period = value(base) | (value(base + 2) << 8) | ((value(base + 4) & 3) << 16);
            const vol = value(base + 7) & 0x0F;
            const used = i >= 16 - channels;
            row(`$${hex(base)}:`, base, 8, used ? `${pitchText(5, period, freq(15 - i))}, vol = ${String(vol).padStart(2, '0')}` : '', 300);
            if (used) sound[15 - i] = [freq(15 - i), vol / 15];
          }
          for (let i = 0; i < channels; ++i)
            pitched(sound[i][0], sound[i][1]);
          break;
        }
        case CHIP.FDS: {
          lines.push({
            height: 36,
            draw: (ctx, x, y) => {
              const left = x + 300;
              ctx.fillStyle = '#000';
              ctx.fillRect(left, y + 2, 64, 33);
              for (let i = 0; i < 64; ++i) {
                const v = value(0x4040 + i);
                ctx.fillStyle = registerColor(age(0x4040 + i));
                ctx.fillRect(left + i, y + 2 + (0x3F - v) / 2, 1, v / 2 + 1);
              }
            },
          });
          const period = value(0x4082) | ((value(0x4083) & 15) << 8);
          const vol = value(0x4080) & 0x3F;
          const modPeriod = value(0x4086) | ((value(0x4087) & 15) << 8);
          const depth = value(0x4084) & 0x3F;
          for (let i = 0; i < 8; ++i)
            row(`$${hex(0x4040 + i * 8, 4)}:`, 0x4040 + i * 8, 8);
          row('$4080:', 0x4080, 4, `${pitchText(3, period, freq(0))}, vol   = ${String(vol).padStart(2, '0')}`);
          row('$4084:', 0x4084, 4, `${pitchText(3, modPeriod, freq(1), 'mod  ')}, depth = ${String(depth).padStart(2, '0')}, counter = ${String((entry.modCounter ?? 0) & 0x7F).padStart(2, '0')}`);
          row('$4088:', 0x4088, 4);
          if (freq(0) && vol) {
            if (depth) {
              bar(noteOfFrequency(freq(1)), Math.min(1, vol / 0x1F), [1, 0.5, 0]);
              bar(noteOfFrequency(freq(0)), Math.min(1, vol / 0x1F), [0, 0.5, 1]);
            } else {
              bar(noteOfFrequency(freq(0)), Math.min(1, vol / 0x1F));
            }
          } else bar(null, 0);
          break;
        }
        case CHIP.VRC7:
          row('$00:', 0x00, 8);
          for (let i = 0; i < 6; ++i) {
            const period = value(0x10 + i) | ((value(0x20 + i) & 1) << 8);
            const vol = 0x0F - (value(0x30 + i) & 0x0F);
            row(`$x${i.toString(16).toUpperCase()}:`, 0, 3, `${pitchText(3, period, freq(i))}, vol = ${String(vol).padStart(2, '0')}, patch = $${(value(0x30 + i) >> 4).toString(16).toUpperCase()}`, 190, j => i + ((j + 1) << 4));
            const volume = Math.pow(10, (vol + 1) * 3 / 20) / 251.18864315095801;
            pitched(freq(i), volume);
          }
          break;
        case CHIP.S5B: {
          const noise = value(0x06) & 0x1F;
          for (let i = 0; i < 4; ++i) {
            const period = value(i * 2) | ((value(i * 2 + 1) & 15) << 8);
            const vol = value(8 + i) & 0x0F;
            const tone = !(value(7) & (1 << i)), noiseOn = !(value(7) & (8 << i)), envelope = !!(value(8 + i) & 0x10);
            const info = i < 3
              ? `${pitchText(3, period, freq(i))}, vol = ${String(vol).padStart(2, '0')}, mode = ${tone ? 'T' : '-'}${noiseOn ? 'N' : '-'}${envelope ? 'E' : '-'}`
              : `period = $${hex(noise)}`;
            row(`$${hex(i * 2)}:`, i * 2, 2, info);
            if (i < 3) {
              const level = envelope ? 1 : Math.pow(10, (vol + 1) * 3 / 20) / 251.18864315095801;
              if ((vol || envelope) && freq(i)) pitched(freq(i), level, noiseOn || envelope ? [0, 1, 1] : [1, 1, 1]);
              else bar(null, 0);
            }
          }
          row('$08:', 8, 3);
          row('$0B:', 0x0B, 3, `${pitchText(4, value(0x0B) | (value(0x0C) << 8), freq(3), 'period')}, shape = $${(value(0x0D) & 15).toString(16).toUpperCase()}`);
          break;
        }
      }
      lines.push(text(''));
    }
    // the pitches and volumes of every channel, a note to a few pixels
    lines.push({
      height: LINE * (bars.length || 1) + 6,
      draw: (ctx, x, y) => {
        const left = x + 20;
        bars.forEach((b, i) => {
          const top = y + 3 + i * LINE;
          ctx.fillStyle = '#303030';
          ctx.fillRect(left - 1, top - 1, 108 * PITCH_WIDTH + 2, LINE - 3);
          ctx.fillStyle = '#000';
          ctx.fillRect(left, top, 108 * PITCH_WIDTH, LINE - 5);
          for (let o = 0; o < 10; ++o) {
            ctx.fillStyle = o === 4 ? '#808080' : '#303030';
            ctx.fillRect(left + o * 12 * PITCH_WIDTH, top + 3, 1, 1);
          }
          if (b.note !== null && b.volume) {
            const gray = Math.round(Math.max(0, Math.min(1, b.volume) ** (1 / 2.2)) * 255);
            ctx.fillStyle = `rgb(${gray * b.tint[0]}, ${gray * b.tint[1]}, ${gray * b.tint[2]})`;
            ctx.fillRect(left + (b.note + 12) * PITCH_WIDTH, top, PITCH_WIDTH - 1, LINE - 5);
          }
        });
      },
    });
    return lines;
  }
}

// ---- all of them --------------------------------------------------------------------------

export class Displays {
  constructor(editor) {
    this.editor = editor;
    this.meters = new Meters(editor);
    this.visualizer = new Visualizer(editor, editor.els.visualizer);
    this.registers = new RegisterView(editor, editor.els.registers);
  }

  tick() {
    this.meters.tick();
    this.visualizer.tick();
    this.registers.tick();
  }
}

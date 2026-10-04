// Dn-FamiTracker web port - the panels of the instrument editor besides the sequences and
// the DPCM: the FDS's wave and modulation, the N163's waves, the VRC7's patch.
//
// Each panel is made once and shows one instrument at a time: load(instrument) with what
// the session's instrument() returns. Changes go to the session at once through the
// editor dialog (`owner`, see dnft-instrument-editor.mjs), so a note held while drawing
// changes as it plays.

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const f32 = Math.fround;

// An element from markup; `data-t` gives an element its text and `data-title` its hint
export function build(html, t) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const root = template.content.firstElementChild;
  translate(root, t);
  return root;
}

export function translate(root, t) {
  root.querySelectorAll('[data-t]').forEach(el => { el.textContent = t[el.dataset.t]; });
  root.querySelectorAll('[data-title]').forEach(el => { el.title = t[el.dataset.title]; });
  if (root.dataset?.t)
    root.textContent = t[root.dataset.t];
}

// What a canvas is drawn in: the editor's colors, by name without the prefix
export function colors(element) {
  const style = getComputedStyle(element);
  return name => style.getPropertyValue(`--dnft-${name}`).trim();
}

// A canvas of the size it is shown at, and its 2D context scaled to CSS pixels
export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height)
    return null;
  // setting the size clears the canvas and takes new memory: only when it is not the size
  if (canvas.width !== Math.round(width * dpr))
    canvas.width = Math.round(width * dpr);
  if (canvas.height !== Math.round(height * dpr))
    canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

// ---- waves the desktop's presets make -------------------------------------------------------

// FDS: 64 steps of 0-63 (CInstrumentEditorFDS)
export const FDS_PRESETS = {
  sine: () => Uint8Array.from({ length: 64 }, (_, i) => {
    const angle = f32(f32(f32(f32(i * f32(3.141592)) * 2) / 64) + f32(0.049087375));
    return Math.trunc(f32(f32(f32(f32(Math.sin(angle)) + 1) * 31.5) + 0.5));
  }),
  triangle: () => Uint8Array.from({ length: 64 }, (_, i) => i < 32 ? i << 1 : (63 - i) << 1),
  sawtooth: () => Uint8Array.from({ length: 64 }, (_, i) => i),
  pulse50: () => Uint8Array.from({ length: 64 }, (_, i) => i < 32 ? 0 : 63),
  pulse25: () => Uint8Array.from({ length: 64 }, (_, i) => i < 16 ? 0 : 63),
};

// N163: `size` steps of 0-15 (CInstrumentEditorN163Wave::GenerateWaves(): the generators
// make -1 to 1, which becomes 0-15 by truncation)
const toLevel = value => clamp(Math.trunc(f32(f32(f32(value) * 7.5) + 8)), 0, 15);
export const N163_PRESETS = {
  sine: size => Uint8Array.from({ length: size }, (_, i) => toLevel(Math.sin(f32(f32(f32(6.28318531) * i) / size)))),
  triangle: size => {
    const half = size >> 1;
    return Uint8Array.from({ length: size }, (_, i) => toLevel(i < half ?
      f32(-1 + f32(f32(2 * i) / (half - 1))) :
      f32(1 - f32(f32(2 * (i - half)) / (half - 1)))));
  },
  sawtooth: size => Uint8Array.from({ length: size }, (_, i) => toLevel(f32(-1 + f32(f32(2 * i) / (size - 1))))),
  pulse: (size, width) => Uint8Array.from({ length: size }, (_, i) => toLevel(i >= f32(size - f32(width * size)) ? 1 : -1)),
};

// The preset of the FDS's modulation table (CInstrumentEditorFDS::OnModPresetSine())
export function modulationSine() {
  const table = new Uint8Array(32);
  table[0] = table[16] = 4;
  for (let i = 1; i <= 6; ++i) {
    table[i] = 7;
    table[16 - i] = 1;
    table[16 + i] = 1;
    table[32 - i] = 7;
  }
  return table;
}

// ---- reading and writing waves as text -------------------------------------------------------

// The values of a text, as far as the desktop's istream reads them (integers, up to the
// first thing that is not one)
export function readIntegers(text, limit) {
  const values = [];
  for (const token of text.trim().split(/\s+/)) {
    if (values.length >= limit || !/^[+-]?\d+$/.test(token))
      break;
    values.push(Number.parseInt(token, 10));
  }
  return values;
}

// ---- the wave editor: a canvas to draw on ---------------------------------------------------

// `levels` values 0 to levels - 1 over `length` cells. Dragging draws (a line from where
// the last move was, so a fast stroke leaves no gaps); dragging with Shift held draws a
// straight line from where it began. Ctrl with an arrow moves the wave sideways or turns it
// over, as the desktop's editor does.
export class WaveEditor {
  constructor(canvas, { levels, mode, onchange, label }) {
    this.canvas = canvas;
    this.levels = levels;
    this.mode = mode;                 // 'lines' or 'steps'
    this.onchange = onchange;
    this.values = new Uint8Array(0);
    this.length = 0;
    this.last = null;
    this.origin = null;
    this.base = null;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    if (label)
      canvas.setAttribute('aria-label', label);
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    const end = () => { this.last = this.origin = this.base = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('keydown', e => this.key(e));
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  // The values are drawn on and changed in place
  set(values, length = values.length) {
    this.values = values;
    this.length = length;
    this.draw();
  }

  setMode(mode) {
    this.mode = mode;
    this.draw();
  }

  changed() {
    this.draw();
    this.onchange?.();
  }

  cell(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      index: clamp(Math.floor((e.clientX - rect.left) / rect.width * this.length), 0, this.length - 1),
      level: clamp(this.levels - 1 - Math.floor((e.clientY - rect.top) / rect.height * this.levels), 0, this.levels - 1),
    };
  }

  // The cells between two points, on the line joining them
  stroke(from, to) {
    const [a, b] = from.index <= to.index ? [from, to] : [to, from];
    const span = b.index - a.index;
    for (let x = a.index; x <= b.index; ++x)
      this.values[x] = span ? Math.round(a.level + (b.level - a.level) * (x - a.index) / span) : b.level;
  }

  down(e) {
    if (e.button !== 0 || !this.length)
      return;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus({ preventScroll: true });
    const cell = this.cell(e);
    if (e.shiftKey) {
      this.origin = cell;
      this.base = this.values.slice();
    }
    this.last = cell;
    this.stroke(cell, cell);
    this.changed();
  }

  move(e) {
    if (!this.last)
      return;
    const cell = this.cell(e);
    if (this.base) {
      this.values.set(this.base);
      this.stroke(this.origin, cell);
    } else {
      this.stroke(this.last, cell);
    }
    this.last = cell;
    this.changed();
  }

  key(e) {
    if (!(e.ctrlKey || e.metaKey))
      return;
    const command = { ArrowLeft: () => this.shift(1), ArrowRight: () => this.shift(-1), ArrowDown: () => this.invert() }[e.key];
    if (command) {
      e.preventDefault();
      command();
    }
  }

  // The wave moved by `steps` to the left (the end wraps round to the start)
  shift(steps) {
    const { values, length } = this;
    if (!length)
      return;
    const copy = values.slice(0, length);
    for (let i = 0; i < length; ++i)
      values[i] = copy[(((i + steps) % length) + length) % length];
    this.changed();
  }

  invert() {
    for (let i = 0; i < this.length; ++i)
      this.values[i] = this.levels - 1 - this.values[i];
    this.changed();
  }

  draw() {
    const fit = fitCanvas(this.canvas);
    if (!fit)
      return;
    const { ctx, width, height } = fit;
    const color = colors(this.canvas);
    ctx.fillStyle = color('pe-bg');
    ctx.fillRect(0, 0, width, height);
    if (!this.length)
      return;
    const cw = width / this.length, ch = height / this.levels;
    // the guides: a line at every quarter of the height, and the value the middle is at
    ctx.fillStyle = color('pe-separator');
    for (let i = 1; i < 4; ++i)
      ctx.fillRect(0, Math.round(height * i / 4), width, 1);
    ctx.fillStyle = color('pe-beat');
    const guide = this.length >= 32 ? 8 : 4;
    for (let x = guide; x < this.length; x += guide)
      ctx.fillRect(Math.round(x * cw), 0, 1, height);
    ctx.fillStyle = color('accent');
    ctx.strokeStyle = color('accent');
    if (this.mode === 'lines') {
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < this.length; ++i) {
        const x = (i + 0.5) * cw, y = height - (this.values[i] + 0.5) * ch;
        if (i)
          ctx.lineTo(x, y);
        else
          ctx.moveTo(x, y);
      }
      ctx.stroke();
    } else {
      for (let i = 0; i < this.length; ++i)
        ctx.fillRect(i * cw + (cw > 3 ? 0.5 : 0), height - (this.values[i] + 1) * ch, Math.max(1, cw - (cw > 3 ? 1 : 0)), Math.max(1, ch - (ch > 3 ? 1 : 0)));
    }
  }
}

// ---- the FDS's modulation table: 32 steps of 8 kinds -----------------------------------------

// The value each row stands for, from the top: +4, +2, +1, 0, -1, -2, -4 and the reset
const MOD_ROWS = [3, 2, 1, 0, 7, 6, 5, 4];
const MOD_LABELS = ['+4', '+2', '+1', '0', '−1', '−2', '−4', 'R'];
const MOD_MARGIN = 28;

export class ModulationEditor {
  constructor(canvas, { onchange, label }) {
    this.canvas = canvas;
    this.onchange = onchange;
    this.values = new Uint8Array(32);
    this.drawing = false;
    canvas.setAttribute('role', 'img');
    if (label)
      canvas.setAttribute('aria-label', label);
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0)
        return;
      canvas.setPointerCapture(e.pointerId);
      this.drawing = true;
      this.edit(e);
    });
    canvas.addEventListener('pointermove', e => {
      if (this.drawing)
        this.edit(e);
    });
    const end = () => { this.drawing = false; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  set(values) {
    this.values = values;
    this.draw();
  }

  edit(e) {
    const rect = this.canvas.getBoundingClientRect();
    const column = clamp(Math.floor((e.clientX - rect.left - MOD_MARGIN) / (rect.width - MOD_MARGIN) * 32), 0, 31);
    const row = clamp(Math.floor((e.clientY - rect.top) / rect.height * 8), 0, 7);
    this.values[column] = MOD_ROWS[row];
    this.draw();
    this.onchange?.();
  }

  draw() {
    const fit = fitCanvas(this.canvas);
    if (!fit)
      return;
    const { ctx, width, height } = fit;
    const color = colors(this.canvas);
    ctx.fillStyle = color('pe-bg');
    ctx.fillRect(0, 0, width, height);
    const cw = (width - MOD_MARGIN) / 32, ch = height / 8;
    ctx.font = `10px ${getComputedStyle(this.canvas).fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let row = 0; row < 8; ++row) {
      ctx.fillStyle = color('pe-row-number');
      ctx.fillText(MOD_LABELS[row], MOD_MARGIN - 6, (row + 0.5) * ch);
      for (let column = 0; column < 32; ++column) {
        const value = MOD_ROWS[row];
        const on = this.values[column] === value;
        ctx.fillStyle = on ? color(value === 4 ? 'error' : value === 0 ? 'pe-volume' : 'pe-instrument') : color('pe-beat');
        ctx.fillRect(MOD_MARGIN + column * cw + 1, row * ch + 1, Math.max(1, cw - 2), Math.max(1, ch - 2));
      }
    }
  }
}

// ---- a wave editor with what belongs to it: presets, tools, the wave as text ------------------

// options: t (the strings), levels, mode, presets [[name, string key, () => values]],
// text: {format(): string, apply(text)}; onchange() after the wave was changed by hand
export class WaveBox {
  constructor({ t, levels, mode, presets, text, onchange, label }) {
    this.t = t;
    this.text = text;
    this.root = build(`
      <div class="dnft-wavebox">
        <canvas class="dnft-wave-canvas"></canvas>
        <div class="dnft-wave-tools">
          <span class="dnft-wave-presets"></span>
          <span class="dnft-wave-ops">
            <button type="button" class="dnft-button" data-op="left" data-t="wedLeft" data-title="wedLeftHint"></button>
            <button type="button" class="dnft-button" data-op="right" data-t="wedRight" data-title="wedRightHint"></button>
            <button type="button" class="dnft-button" data-op="invert" data-t="wedInvert" data-title="wedInvertHint"></button>
            <button type="button" class="dnft-button dnft-toggle" data-op="mode" data-t="wedSteps" data-title="wedStepsHint"></button>
          </span>
        </div>
        <div class="dnft-wave-text">
          <input type="text" spellcheck="false" autocomplete="off">
          <button type="button" class="dnft-button" data-op="copy" data-t="wedCopy"></button>
          <button type="button" class="dnft-button" data-op="paste" data-t="wedPaste"></button>
        </div>
      </div>`, t);
    const $ = selector => this.root.querySelector(selector);
    this.input = $('input');
    this.editor = new WaveEditor($('canvas'), {
      levels, mode, label,
      onchange: () => {
        this.showText();
        onchange?.();
      },
    });
    for (const [name, key, make] of presets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dnft-button';
      button.dataset.preset = name;
      button.textContent = t[key];
      button.addEventListener('click', () => {
        this.editor.values.set(make(this.editor.length));
        this.editor.changed();
      });
      $('.dnft-wave-presets').append(button);
    }
    const modeButton = $('[data-op="mode"]');
    const showMode = () => {
      modeButton.classList.toggle('is-on', this.editor.mode === 'steps');
      modeButton.setAttribute('aria-pressed', String(this.editor.mode === 'steps'));
    };
    showMode();
    modeButton.addEventListener('click', () => {
      this.editor.setMode(this.editor.mode === 'steps' ? 'lines' : 'steps');
      showMode();
    });
    $('[data-op="left"]').addEventListener('click', () => this.editor.shift(1));
    $('[data-op="right"]').addEventListener('click', () => this.editor.shift(-1));
    $('[data-op="invert"]').addEventListener('click', () => this.editor.invert());
    const apply = () => {
      this.text.apply(this.input.value);
      this.showText();
    };
    this.input.addEventListener('change', apply);
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        apply();
      }
    });
    $('[data-op="copy"]').addEventListener('click', () => this.copy());
    $('[data-op="paste"]').addEventListener('click', () => this.paste());
  }

  // The values are drawn on and changed in place
  set(values, length) {
    this.editor.set(values, length);
    this.showText();
  }

  showText() {
    this.input.value = this.text.format();
  }

  async copy() {
    try {
      await navigator.clipboard.writeText(this.text.format());
    } catch {
      this.input.select();
    }
  }

  async paste() {
    try {
      this.text.apply(await navigator.clipboard.readText());
      this.showText();
    } catch {
      // the browser does not let the page read the clipboard: the text box takes a paste
      this.input.focus();
      this.input.select();
    }
  }
}

// ---- FDS ---------------------------------------------------------------------------------------

export class FdsPanel {
  constructor(owner) {
    this.owner = owner;
    const t = owner.strings;
    this.root = build(`
      <div class="dnft-inst-panel dnft-fds">
        <section class="dnft-inst-section">
          <h4 data-t="fdsWave"></h4>
          <div data-role="wave"></div>
        </section>
        <section class="dnft-inst-section">
          <h4 data-t="fdsModulation"></h4>
          <canvas class="dnft-mod-canvas" data-role="mod"></canvas>
          <div class="dnft-wave-tools">
            <span class="dnft-wave-presets">
              <button type="button" class="dnft-button" data-op="flat" data-t="wedFlat"></button>
              <button type="button" class="dnft-button" data-op="sine" data-t="wedSine"></button>
            </span>
          </div>
          <div class="dnft-wave-text">
            <input type="text" spellcheck="false" autocomplete="off" data-role="mod-text">
            <button type="button" class="dnft-button" data-op="copy" data-t="wedCopy"></button>
            <button type="button" class="dnft-button" data-op="paste" data-t="wedPaste"></button>
          </div>
          <div class="dnft-fds-params">
            <label class="dnft-field"><span data-t="fdsRate"></span><input type="number" min="0" max="4095" data-role="speed"></label>
            <label class="dnft-field"><span data-t="fdsDepth"></span><input type="number" min="0" max="63" data-role="depth"></label>
            <label class="dnft-field"><span data-t="fdsDelay"></span><input type="number" min="0" max="255" data-role="delay"></label>
          </div>
        </section>
      </div>`, t);
    const $ = role => this.root.querySelector(`[data-role="${role}"]`);
    this.waveBox = new WaveBox({
      t, levels: 64, mode: 'lines', label: t.fdsWave,
      presets: [
        ['sine', 'wedSine', FDS_PRESETS.sine], ['triangle', 'wedTriangle', FDS_PRESETS.triangle],
        ['sawtooth', 'wedSawtooth', FDS_PRESETS.sawtooth], ['pulse50', 'wedPulse50', FDS_PRESETS.pulse50],
        ['pulse25', 'wedPulse25', FDS_PRESETS.pulse25],
      ],
      text: {
        format: () => Array.from(this.wave).join(' '),
        // CInstrumentEditorFDS::ParseWaveString(): what the text has, 0-63, from the start
        apply: text => {
          readIntegers(text, 64).forEach((value, i) => { this.wave[i] = clamp(value, 0, 63); });
          this.waveBox.editor.changed();
        },
      },
      onchange: () => this.sendWave(),
    });
    $('wave').append(this.waveBox.root);

    this.mod = new ModulationEditor($('mod'), { label: t.fdsModulation, onchange: () => this.changedModulation() });
    const modText = $('mod-text');
    modText.addEventListener('change', () => {
      readIntegers(modText.value, 32).forEach((value, i) => { this.modulation[i] = clamp(value, 0, 7); });
      this.mod.draw();
      this.changedModulation();
    });
    this.root.querySelector('[data-op="flat"]').addEventListener('click', () => {
      this.modulation.fill(0);
      this.mod.draw();
      this.changedModulation();
    });
    this.root.querySelector('[data-op="sine"]').addEventListener('click', () => {
      this.modulation.set(modulationSine());
      this.mod.draw();
      this.changedModulation();
    });
    this.root.querySelector('.dnft-fds-params').closest('section').querySelector('[data-op="copy"]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(modText.value);
      } catch {
        modText.select();
      }
    });
    this.root.querySelector('.dnft-fds-params').closest('section').querySelector('[data-op="paste"]').addEventListener('click', async () => {
      try {
        modText.value = await navigator.clipboard.readText();
        modText.dispatchEvent(new Event('change'));
      } catch {
        modText.focus();
        modText.select();
      }
    });
    this.params = { speed: $('speed'), depth: $('depth'), delay: $('delay') };
    for (const input of Object.values(this.params))
      input.addEventListener('change', () => this.changedParams());
    this.modText = modText;
    this.wave = new Uint8Array(64);
    this.modulation = new Uint8Array(32);
  }

  get title() {
    return this.owner.strings.instPanelFds;
  }

  load(instrument) {
    const { fds } = instrument;
    this.wave = Uint8Array.from(fds.wave);
    this.modulation = Uint8Array.from(fds.modulation);
    this.params.speed.value = fds.speed;
    this.params.depth.value = fds.depth;
    this.params.delay.value = fds.delay;
    this.waveBox.set(this.wave, 64);
    this.mod.set(this.modulation);
    this.showModulation();
  }

  activate() {
    this.waveBox.editor.draw();
    this.mod.draw();
  }

  showModulation() {
    this.modText.value = Array.from(this.modulation).join(' ');
  }

  sendWave() {
    this.owner.queue('fds-wave', () => this.owner.change('setFdsWave', this.wave.slice()));
  }

  changedModulation() {
    this.showModulation();
    this.owner.queue('fds-mod', () => this.owner.change('setFdsModulation', this.modulation.slice()));
  }

  changedParams() {
    const value = (input, max) => clamp(Math.round(Number(input.value) || 0), 0, max);
    const { speed, depth, delay } = this.params;
    speed.value = value(speed, 4095);
    depth.value = value(depth, 63);
    delay.value = value(delay, 255);
    this.owner.change('setFdsParams', Number(speed.value), Number(depth.value), Number(delay.value));
  }
}

// ---- N163 -------------------------------------------------------------------------------------

const N163_MAX_SIZE = 240;
const N163_MAX_WAVES = 64;

export class N163Panel {
  constructor(owner) {
    this.owner = owner;
    const t = owner.strings;
    this.root = build(`
      <div class="dnft-inst-panel dnft-n163">
        <aside class="dnft-n163-list">
          <ul class="dnft-n163-waves" role="listbox" data-role="list"></ul>
          <div class="dnft-wave-tools">
            <button type="button" class="dnft-button" data-op="add" data-t="n163Add" data-title="n163AddHint"></button>
            <button type="button" class="dnft-button" data-op="remove" data-t="n163Remove" data-title="n163RemoveHint"></button>
          </div>
        </aside>
        <section class="dnft-inst-section">
          <div class="dnft-n163-params">
            <label class="dnft-field dnft-field--inline"><span data-t="n163Size"></span><select data-role="size"></select></label>
            <label class="dnft-field dnft-field--inline"><span data-t="n163Position"></span><input type="number" min="0" max="255" list="" data-role="position"></label>
            <datalist data-role="positions"></datalist>
          </div>
          <div data-role="wave"></div>
          <p class="dnft-hint" data-role="info"></p>
        </section>
      </div>`, t);
    const $ = role => this.root.querySelector(`[data-role="${role}"]`);
    this.list = $('list');
    this.sizeSelect = $('size');
    this.position = $('position');
    this.positions = $('positions');
    this.info = $('info');
    this.positions.id = `dnft-n163-positions-${Math.random().toString(36).slice(2)}`;
    this.position.setAttribute('list', this.positions.id);
    this.waveBox = new WaveBox({
      t, levels: 16, mode: 'steps', label: t.n163Waves,
      presets: [
        ['sine', 'wedSine', size => N163_PRESETS.sine(size)], ['triangle', 'wedTriangle', size => N163_PRESETS.triangle(size)],
        ['sawtooth', 'wedSawtooth', size => N163_PRESETS.sawtooth(size)],
        ['pulse50', 'wedPulse50', size => N163_PRESETS.pulse(size, 0.5)], ['pulse25', 'wedPulse25', size => N163_PRESETS.pulse(size, 0.25)],
      ],
      text: {
        format: () => this.current ? Array.from(this.current.subarray(0, this.size)).join(' ') : '',
        apply: text => this.applyText(text),
        copy: () => this.copyText(),
      },
      onchange: () => this.wavesChanged(),
    });
    // copying and pasting take all the waves, as the desktop's buttons do
    this.waveBox.copy = async () => {
      try {
        await navigator.clipboard.writeText(this.allText());
      } catch {
        this.waveBox.input.value = this.allText();
        this.waveBox.input.select();
      }
    };
    this.waveBox.paste = async () => {
      try {
        this.pasteAll(await navigator.clipboard.readText());
      } catch {
        this.waveBox.input.focus();
        this.waveBox.input.select();
      }
    };
    $('wave').append(this.waveBox.root);
    this.sizeSelect.addEventListener('change', () => this.setSize(Number(this.sizeSelect.value)));
    this.position.addEventListener('change', () => this.setPosition(Number(this.position.value)));
    this.list.addEventListener('click', e => {
      const item = e.target.closest('[data-wave]');
      if (item)
        this.select(Number(item.dataset.wave));
    });
    this.root.querySelector('[data-op="add"]').addEventListener('click', () => this.addWave());
    this.root.querySelector('[data-op="remove"]').addEventListener('click', () => this.removeWave());
    this.size = 32;
    this.pos = 0;
    this.waves = [];      // Uint8Array(240) each: the part past the size is kept while the size changes
    this.selected = 0;
  }

  get title() {
    return this.owner.strings.instPanelN163;
  }

  get current() {
    return this.waves[this.selected];
  }

  // The steps an instrument's waves can take: what the chip's RAM leaves after its channels
  get available() {
    const channels = this.owner.editor.song?.info.namcoChannels || 0;
    return Math.min(N163_MAX_SIZE, 256 - 16 * channels);
  }

  load(instrument) {
    const { n163 } = instrument;
    this.size = n163.waveSize;
    this.pos = n163.wavePos;
    this.waves = Array.from({ length: n163.waveCount }, (_, i) => {
      const wave = new Uint8Array(N163_MAX_SIZE);
      wave.set(n163.waves.subarray(i * this.size, (i + 1) * this.size));
      return wave;
    });
    this.selected = 0;
    this.showAll();
  }

  activate() {
    this.waveBox.editor.draw();
    this.drawThumbnails();
  }

  showAll() {
    const available = this.available;
    const sizes = [];
    for (let size = 4; size <= available; size += 4)
      sizes.push(size);
    if (!sizes.includes(this.size))
      sizes.push(this.size);
    this.sizeSelect.replaceChildren(...sizes.map(size => new Option(size, size)));
    this.sizeSelect.value = this.size;
    this.position.value = this.pos;
    const options = [];
    for (let at = 0; at <= available - this.size; at += this.size)
      options.push(new Option(at));
    this.positions.replaceChildren(...options);
    this.info.textContent = this.owner.strings.n163Info.replace('%1', Math.ceil(this.size * this.waves.length / 2)).replace('%2', available);
    this.showList();
    this.select(Math.min(this.selected, this.waves.length - 1));
    const t = this.owner.strings;
    this.root.querySelector('[data-op="add"]').disabled = this.waves.length >= N163_MAX_WAVES;
    this.root.querySelector('[data-op="remove"]').disabled = this.waves.length <= 1;
    this.root.querySelector('[data-op="add"]').title = t.n163AddHint;
  }

  showList() {
    this.list.replaceChildren(...this.waves.map((_, i) => {
      const item = document.createElement('li');
      item.className = 'dnft-n163-wave';
      item.dataset.wave = i;
      item.role = 'option';
      item.innerHTML = '<canvas width="96" height="24"></canvas><span></span>';
      item.querySelector('span').textContent = i.toString(16).toUpperCase();
      return item;
    }));
    this.drawThumbnails();
  }

  drawThumbnails() {
    const items = this.list.children;
    for (let i = 0; i < items.length; ++i)
      this.drawThumbnail(items[i].querySelector('canvas'), this.waves[i]);
  }

  drawThumbnail(canvas, wave) {
    if (!canvas || !wave)
      return;
    const ctx = canvas.getContext('2d');
    const color = colors(canvas);
    ctx.fillStyle = color('pe-bg');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color('accent');
    const cw = canvas.width / this.size;
    for (let i = 0; i < this.size; ++i) {
      const y = canvas.height - (wave[i] + 1) / 16 * canvas.height;
      ctx.fillRect(i * cw, y, Math.max(1, cw), Math.max(1.5, canvas.height / 16));
    }
  }

  select(index) {
    this.selected = index;
    [...this.list.children].forEach((item, i) => {
      item.classList.toggle('is-current', i === index);
      item.setAttribute('aria-selected', String(i === index));
    });
    this.waveBox.set(this.current, this.size);
  }

  // The waves as the session takes them: one after the other
  packed() {
    const out = new Uint8Array(this.size * this.waves.length);
    this.waves.forEach((wave, i) => out.set(wave.subarray(0, this.size), i * this.size));
    return out;
  }

  wavesChanged() {
    this.drawThumbnail(this.list.children[this.selected]?.querySelector('canvas'), this.current);
    const wave = this.selected;
    this.owner.queue(`n163-wave-${wave}`, () => {
      if (wave < this.waves.length)
        this.owner.change('setN163Wave', wave, this.waves[wave].slice(0, this.size));
    });
  }

  // The sizes, positions and count go with the waves; what the session made of them is what shows
  async structureChanged() {
    // the waves drawn are in the engine before it takes the whole
    this.owner.flush();
    const result = await this.owner.request('setN163', this.size, this.pos, this.waves.length, this.packed());
    this.owner.editor.changedInstruments();
    this.size = result.waveSize;
    this.pos = result.wavePos;
    this.showAll();
  }

  setSize(size) {
    this.size = clamp(size & ~3, 4, this.available);
    this.structureChanged();
  }

  setPosition(pos) {
    this.pos = clamp(Math.round(pos) || 0, 0, 255);
    this.structureChanged();
  }

  addWave() {
    if (this.waves.length >= N163_MAX_WAVES)
      return;
    // after the wave selected, empty (CInstrumentN163::InsertNewWave())
    this.waves.splice(this.selected + 1, 0, new Uint8Array(N163_MAX_SIZE));
    this.selected += 1;
    this.structureChanged();
  }

  removeWave() {
    if (this.waves.length <= 1)
      return;
    this.waves.splice(this.selected, 1);
    this.selected = Math.min(this.selected, this.waves.length - 1);
    this.structureChanged();
  }

  // What CInstrumentEditorN163Wave::ParseString() does with a wave's text: the values that
  // are steps (0-15) go in, and the size becomes what the text has, a multiple of 4
  parse(text, wave) {
    const values = readIntegers(text, this.available);
    values.forEach((value, i) => {
      if (value >= 0 && value <= 15)
        wave[i] = value;
    });
    this.size = clamp(values.length & ~3, 4, this.available);
  }

  applyText(text) {
    this.parse(text, this.current);
    this.structureChanged();
  }

  allText() {
    return this.waves.map(wave => `${Array.from(wave.subarray(0, this.size)).join(' ')} ;\n`).join('');
  }

  // What the paste button does: the waves are the ones the text has, split by ;
  pasteAll(text) {
    const parts = text.split(';').filter(part => part.trim());
    if (!parts.length)
      return;
    this.waves = [];
    for (const part of parts.slice(0, N163_MAX_WAVES)) {
      const wave = new Uint8Array(N163_MAX_SIZE);
      this.parse(part, wave);
      this.waves.push(wave);
    }
    this.selected = 0;
    this.structureChanged();
  }
}

// ---- VRC7 --------------------------------------------------------------------------------------

// The fields of the 8 registers of a patch, each: [register, mask, shift, label key]
const VRC7_FIELDS = {
  modulator: [
    ['am', 0, 0x80, 7], ['vib', 0, 0x40, 6], ['eg', 0, 0x20, 5], ['ksr', 0, 0x10, 4],
    ['mul', 0, 0x0F, 0, 15], ['ksl', 2, 0xC0, 6, 3],
    ['ar', 4, 0xF0, 4, 15], ['dr', 4, 0x0F, 0, 15], ['sl', 6, 0xF0, 4, 15], ['rr', 6, 0x0F, 0, 15],
    ['dm', 3, 0x08, 3],
  ],
  carrier: [
    ['am', 1, 0x80, 7], ['vib', 1, 0x40, 6], ['eg', 1, 0x20, 5], ['ksr', 1, 0x10, 4],
    ['mul', 1, 0x0F, 0, 15], ['ksl', 3, 0xC0, 6, 3],
    ['ar', 5, 0xF0, 4, 15], ['dr', 5, 0x0F, 0, 15], ['sl', 7, 0xF0, 4, 15], ['rr', 7, 0x0F, 0, 15],
    ['dc', 3, 0x10, 4],
  ],
};
const VRC7_NAMES = {
  am: 'AM', vib: 'VIB', eg: 'EG', ksr: 'KSR', mul: 'MUL', ksl: 'KSL', ar: 'AR', dr: 'DR', sl: 'SL', rr: 'RR',
  dm: 'DM', dc: 'DC',
};

const hex2 = value => value.toString(16).toUpperCase().padStart(2, '0');
export const patchText = registers => Array.from(registers, value => `$${hex2(value)}`).join(' ');

// The bytes a text of numbers holds ($ for hexadecimal), the first 8
export function parsePatchText(text) {
  const values = [];
  for (const token of text.trim().split(/[\s,;]+/)) {
    if (values.length >= 8)
      break;
    const value = /^\$[0-9a-f]+$/i.test(token) ? Number.parseInt(token.slice(1), 16) :
      /^0x[0-9a-f]+$/i.test(token) ? Number.parseInt(token.slice(2), 16) :
      /^\d+$/.test(token) ? Number.parseInt(token, 10) : NaN;
    if (Number.isNaN(value))
      break;
    values.push(clamp(value, 0, 255));
  }
  return values;
}

export class Vrc7Panel {
  constructor(owner) {
    this.owner = owner;
    const t = owner.strings;
    this.root = build(`
      <div class="dnft-inst-panel dnft-vrc7">
        <div class="dnft-vrc7-head">
          <label class="dnft-field dnft-field--inline"><span data-t="vrc7Patch"></span><select data-role="patch"></select></label>
          <span class="dnft-wave-text">
            <input type="text" spellcheck="false" autocomplete="off" data-role="text" data-title="vrc7TextHint">
            <button type="button" class="dnft-button" data-op="copy" data-t="wedCopy"></button>
            <button type="button" class="dnft-button" data-op="paste" data-t="wedPaste"></button>
          </span>
        </div>
        <div class="dnft-vrc7-operators">
          <fieldset class="dnft-fieldset" data-op-group="modulator"><legend data-t="vrc7Modulator"></legend></fieldset>
          <fieldset class="dnft-fieldset" data-op-group="carrier"><legend data-t="vrc7Carrier"></legend></fieldset>
        </div>
        <div class="dnft-vrc7-common">
          <fieldset class="dnft-fieldset dnft-vrc7-fieldset-common"><legend data-t="vrc7Common"></legend></fieldset>
        </div>
        <p class="dnft-hint" data-t="vrc7Hint"></p>
      </div>`, t);
    const $ = role => this.root.querySelector(`[data-role="${role}"]`);
    this.patchSelect = $('patch');
    this.text = $('text');
    this.controls = [];       // {read(registers), write(registers, value), input}
    for (const group of ['modulator', 'carrier']) {
      const box = this.root.querySelector(`[data-op-group="${group}"]`);
      for (const [name, register, mask, shift, max] of VRC7_FIELDS[group])
        box.append(this.control(VRC7_NAMES[name], register, mask, shift, max, name === 'dm' || name === 'dc' ? t.vrc7Distortion : ''));
    }
    const common = this.root.querySelector('.dnft-vrc7-fieldset-common');
    // TL is the modulator's output level, FB the feedback (stored the other way round)
    common.append(this.control('TL', 2, 0x3F, 0, 63, t.vrc7TotalLevel));
    common.append(this.control('FB', 3, 0x07, 0, 7, t.vrc7Feedback, true));
    this.patchSelect.addEventListener('change', () => this.setPatch(Number(this.patchSelect.value)));
    this.text.addEventListener('change', () => this.applyText(this.text.value));
    this.text.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.applyText(this.text.value);
      }
    });
    this.root.querySelector('[data-op="copy"]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(this.text.value);
      } catch {
        this.text.select();
      }
    });
    this.root.querySelector('[data-op="paste"]').addEventListener('click', async () => {
      try {
        this.applyText(await navigator.clipboard.readText());
      } catch {
        this.text.focus();
        this.text.select();
      }
    });
    this.patch = 0;
    this.registers = new Uint8Array(8);
    this.builtin = new Uint8Array(16 * 8);
    this.names = [];
  }

  get title() {
    return this.owner.strings.instPanelVrc7;
  }

  // A check box (no `max`) or a slider for the bits `mask` of a register
  control(name, register, mask, shift, max, hint = '', reversed = false) {
    const wrap = document.createElement('label');
    wrap.className = max === undefined ? 'dnft-check dnft-vrc7-control' : 'dnft-vrc7-control';
    const input = document.createElement('input');
    const label = document.createElement('span');
    label.textContent = name;
    if (hint)
      wrap.title = hint;
    let output = null;
    if (max === undefined) {
      input.type = 'checkbox';
      wrap.append(input, label);
    } else {
      input.type = 'range';
      input.min = 0;
      input.max = max;
      output = document.createElement('output');
      wrap.append(label, input, output);
    }
    const control = {
      input, output,
      read: registers => {
        const raw = (registers[register] & mask) >> shift;
        return reversed ? max - raw : raw;
      },
      write: (registers, value) => {
        const raw = reversed ? max - value : value;
        registers[register] = (registers[register] & ~mask) | ((raw << shift) & mask);
      },
    };
    input.addEventListener('input', () => {
      const registers = this.registers.slice();
      control.write(registers, max === undefined ? (input.checked ? 1 : 0) : Number(input.value));
      this.setRegisters(registers);
    });
    this.controls.push(control);
    return wrap;
  }

  // The patches to choose from are the module's (the chip's, or its own with an external OPLL)
  async load(instrument) {
    const { patches, names } = await this.owner.editor.session.call('vrc7Patches');
    this.patch = instrument.vrc7.patch;
    this.registers = Uint8Array.from(instrument.vrc7.registers);
    this.builtin = patches;
    this.names = names;
    this.patchSelect.replaceChildren(...names.map((name, i) => new Option(`${this.owner.strings.vrc7PatchLabel} #${i}${name ? ` - ${name}` : ''}`, i)));
    this.show();
  }

  // The registers of the patch the instrument plays
  get shown() {
    return this.patch === 0 ? this.registers : this.builtin.subarray(this.patch * 8, this.patch * 8 + 8);
  }

  // `force`: the text shows the registers even while it has the keyboard
  show(force = false) {
    this.patchSelect.value = this.patch;
    const registers = this.shown;
    for (const control of this.controls) {
      const value = control.read(registers);
      if (control.output) {
        control.input.value = value;
        control.output.textContent = value;
      } else {
        control.input.checked = value !== 0;
      }
      control.input.disabled = this.patch !== 0;
    }
    if (force || document.activeElement !== this.text)
      this.text.value = patchText(registers);
  }

  setRegisters(registers) {
    this.registers = registers;
    this.show();
    this.send();
  }

  setPatch(patch) {
    this.patch = clamp(patch, 0, 15);
    this.show();
    this.send();
  }

  // A text of registers goes to the instrument's own patch, which then plays
  applyText(text) {
    const values = parsePatchText(text);
    if (values.length) {
      const registers = this.registers.slice();
      values.forEach((value, i) => { registers[i] = value; });
      this.registers = registers;
      this.patch = 0;
    }
    this.show(true);
    if (values.length)
      this.send();
  }

  send() {
    this.owner.queue('vrc7', () => this.owner.change('setVrc7', this.patch, this.registers.slice()));
  }
}

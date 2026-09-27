// Dn-FamiTracker web port - the instrument editor.
//
// A dialog for the instruments made of sequences (2A03, VRC6, N163, 5B): the five
// sequences as bars to draw with the mouse, and as the desktop tracker's text form
// ("15 12 | 10 8 / 4 0": what follows | loops, what follows / plays on release). A
// change goes to the engine at once, so a note held while drawing changes as it plays.
// Sequences are shared by number between instruments, as on the desktop.

import { INST, SEQUENCE_INSTRUMENTS } from './dnft-song.mjs';

const SEQ_COUNT = 5;
const MAX_ITEMS = 252;       // MAX_SEQUENCE_ITEMS
const MAX_SEQUENCES = 128;
const SETTING_COUNT = [2, 4, 2, 1, 1];   // SEQ_SETTING_COUNT (release build)

// Values a sequence may hold: [min, max], and the part the graph shows
function limits(instType, seqType, setting) {
  switch (seqType) {
    case 0: return setting === 1 ? [0, 63] : [0, 15];
    case 1: return setting === 1 ? [0, 95] : [-96, 96];
    case 2: case 3: return [-128, 127];
    default:
      return instType === INST.VRC6 ? [0, 7] : instType === INST.N163 ? [0, 63] : instType === INST.S5B ? [0, 255] : [0, 3];
  }
}

function view(instType, seqType, setting) {
  switch (seqType) {
    case 1: return setting === 1 ? [0, 95] : [-24, 24];
    case 2: case 3: return [-32, 32];
    case 4: return instType === INST.S5B ? [0, 31] : limits(instType, seqType, setting);
    default: return limits(instType, seqType, setting);
  }
}

// The desktop's text form of a sequence
export function formatSequence({ items, loop, release }) {
  const parts = [];
  for (let i = 0; i < items.length; ++i) {
    if (i === loop) parts.push('|');
    if (i === release) parts.push('/');
    parts.push(String(items[i]));
  }
  return parts.join(' ');
}

export function parseSequence(text, [min, max]) {
  const items = [];
  let loop = -1, release = -1;
  for (const token of text.trim().split(/[\s,]+/).filter(Boolean)) {
    if (token === '|')
      loop = items.length;
    else if (token === '/')
      release = items.length;
    else {
      const value = Number.parseInt(token, 10);
      if (Number.isNaN(value))
        return null;
      if (items.length < MAX_ITEMS)
        items.push(Math.max(min, Math.min(max, value)));
    }
  }
  if (loop >= items.length) loop = -1;
  if (release >= items.length) release = -1;
  return { items, loop, release };
}

export class InstrumentEditor {
  constructor(editor) {
    this.editor = editor;
    this.index = null;
    this.instrument = null;
    this.seqType = 0;
    this.sequence = null;    // {items: [], loop, release, setting}
    this.pendingSend = false;
    this.build();
  }

  get strings() {
    return this.editor.strings;
  }

  build() {
    const t = this.strings;
    const dialog = this.dialog = document.createElement('dialog');
    dialog.className = 'dnft-dialog dnft-instrument-dialog';
    dialog.innerHTML = `
      <form method="dialog" class="dnft-dialog-head">
        <strong class="dnft-dialog-title"></strong>
        <button type="submit" class="dnft-button" value="close"></button>
      </form>
      <label class="dnft-field dnft-instrument-name"><span></span><input type="text" maxlength="60" spellcheck="false"></label>
      <p class="dnft-instrument-note" hidden></p>
      <div class="dnft-sequences">
        <div class="dnft-tabs" role="tablist"></div>
        <div class="dnft-sequence">
          <div class="dnft-sequence-bar">
            <label class="dnft-check"><input type="checkbox" data-role="enabled"> <span></span></label>
            <label class="dnft-field dnft-field--inline"><span></span><input type="number" min="0" max="${MAX_SEQUENCES - 1}" data-role="index"></label>
            <label class="dnft-field dnft-field--inline"><span></span><input type="number" min="0" max="${MAX_ITEMS}" data-role="length"></label>
            <select data-role="setting"></select>
          </div>
          <canvas class="dnft-sequence-graph" height="160"></canvas>
          <input type="text" class="dnft-sequence-mml" spellcheck="false" autocomplete="off" data-role="mml">
          <p class="dnft-hint"></p>
        </div>
      </div>`;
    const $ = selector => dialog.querySelector(selector);
    $('.dnft-dialog-head button').textContent = t.close;
    $('.dnft-instrument-name span').textContent = t.name;
    this.nameInput = $('.dnft-instrument-name input');
    this.note = $('.dnft-instrument-note');
    this.sequencesBox = $('.dnft-sequences');
    this.tabs = $('.dnft-tabs');
    this.enabled = $('[data-role=enabled]');
    this.enabled.nextElementSibling.textContent = t.enabled;
    this.indexInput = $('[data-role=index]');
    this.indexInput.previousElementSibling.textContent = t.sequence;
    this.lengthInput = $('[data-role=length]');
    this.lengthInput.previousElementSibling.textContent = t.length;
    this.settingSelect = $('[data-role=setting]');
    this.graph = $('.dnft-sequence-graph');
    this.mml = $('[data-role=mml]');
    $('.dnft-hint').textContent = t.mmlHint;

    this.nameInput.addEventListener('change', () => this.rename());
    this.enabled.addEventListener('change', () => this.setUse(this.enabled.checked, this.sequenceIndex));
    this.indexInput.addEventListener('change', () => {
      const index = Math.max(0, Math.min(MAX_SEQUENCES - 1, Number(this.indexInput.value) || 0));
      this.setUse(this.enabledNow, index);
    });
    this.lengthInput.addEventListener('change', () => {
      const length = Math.max(0, Math.min(MAX_ITEMS, Number(this.lengthInput.value) || 0));
      const items = this.sequence.items.slice(0, length);
      while (items.length < length)
        items.push(items.length ? items[items.length - 1] : 0);
      this.update({ ...this.sequence, items });
    });
    this.settingSelect.addEventListener('change', () => {
      const setting = Number(this.settingSelect.value);
      const [min, max] = limits(this.instrument.type, this.seqType, setting);
      this.update({ ...this.sequence, setting, items: this.sequence.items.map(v => Math.max(min, Math.min(max, v))) });
    });
    this.mml.addEventListener('change', () => this.applyText());
    this.mml.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.applyText();
      }
    });
    // keys typed here are not notes
    dialog.addEventListener('keydown', e => e.stopPropagation());

    this.graph.addEventListener('pointerdown', e => {
      if (!this.sequence || !this.sequence.items.length)
        return;
      this.graph.setPointerCapture(e.pointerId);
      this.drawing = true;
      this.drawAt(e);
    });
    this.graph.addEventListener('pointermove', e => {
      if (this.drawing)
        this.drawAt(e);
    });
    const end = () => { this.drawing = false; };
    this.graph.addEventListener('pointerup', end);
    this.graph.addEventListener('pointercancel', end);
    new ResizeObserver(() => this.drawGraph()).observe(this.graph);
    this.editor.root.append(dialog);
  }

  get sequenceIndex() {
    return this.instrument.sequences[this.seqType].index;
  }

  get enabledNow() {
    return this.instrument.sequences[this.seqType].enabled;
  }

  async open(index) {
    this.index = index;
    await this.load();
    if (!this.dialog.open)
      this.dialog.showModal();
  }

  close() {
    if (this.dialog.open)
      this.dialog.close();
  }

  async load() {
    const t = this.strings;
    this.instrument = await this.editor.session.call('instrument', this.index);
    const hex = this.index.toString(16).toUpperCase().padStart(2, '0');
    this.dialog.querySelector('.dnft-dialog-title').textContent = `${t.instrumentEditor} ${hex}`;
    this.nameInput.value = this.instrument.name;
    const sequences = SEQUENCE_INSTRUMENTS.has(this.instrument.type) && this.instrument.sequences;
    this.sequencesBox.hidden = !sequences;
    this.note.hidden = !!sequences;
    this.note.textContent = t.noSequences;
    if (!sequences)
      return;
    const names = t.sequenceNames[this.instrument.type] ?? t.sequenceNames[INST['2A03']];
    this.tabs.replaceChildren(...names.map((name, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.role = 'tab';
      tab.className = 'dnft-tab';
      tab.textContent = name;
      tab.addEventListener('click', () => this.selectSequence(i));
      return tab;
    }));
    await this.selectSequence(this.seqType);
  }

  async selectSequence(seqType) {
    this.seqType = seqType;
    [...this.tabs.children].forEach((tab, i) => {
      tab.classList.toggle('is-active', i === seqType);
      tab.setAttribute('aria-selected', String(i === seqType));
      tab.classList.toggle('is-used', this.instrument.sequences[i].enabled);
    });
    const data = await this.editor.session.call('sequence', this.instrument.type, seqType, this.sequenceIndex);
    this.sequence = { items: [...data.items], loop: data.loop, release: data.release, setting: data.setting };
    this.show();
  }

  show() {
    const t = this.strings;
    this.enabled.checked = this.enabledNow;
    this.indexInput.value = this.sequenceIndex;
    this.lengthInput.value = this.sequence.items.length;
    const settings = t.settings[this.seqType] ?? [];
    // the 64-step volume is the sawtooth's
    const count = this.seqType === 0 && this.instrument.type !== INST.VRC6 ? 1 : SETTING_COUNT[this.seqType];
    this.settingSelect.hidden = count < 2;
    this.settingSelect.replaceChildren(...settings.slice(0, count).map((name, i) => new Option(name, i)));
    this.settingSelect.value = this.sequence.setting;
    this.mml.value = formatSequence(this.sequence);
    this.drawGraph();
  }

  // Sends the sequence to the engine, and shows it
  update(sequence) {
    this.sequence = sequence;
    this.show();
    this.send();
  }

  send() {
    // at most once a frame while drawing
    if (this.pendingSend)
      return;
    this.pendingSend = true;
    requestAnimationFrame(() => {
      this.pendingSend = false;
      const { items, loop, release, setting } = this.sequence;
      this.editor.session.send('setSequence', this.instrument.type, this.seqType, this.sequenceIndex,
        Int8Array.from(items), loop, release, setting);
      this.editor.changedInstruments();
    });
  }

  applyText() {
    const parsed = parseSequence(this.mml.value, limits(this.instrument.type, this.seqType, this.sequence.setting));
    if (!parsed) {
      this.mml.value = formatSequence(this.sequence);
      return;
    }
    this.update({ ...parsed, setting: this.sequence.setting });
    // a sequence with values is one the instrument means to use
    if (parsed.items.length && !this.enabledNow)
      this.setUse(true, this.sequenceIndex);
  }

  async setUse(enabled, index) {
    await this.editor.session.call('setInstrumentSequence', this.index, this.seqType, enabled, index);
    this.instrument.sequences[this.seqType] = { enabled, index };
    this.editor.changedInstruments();
    await this.selectSequence(this.seqType);
  }

  async rename() {
    await this.editor.session.call('setInstrumentName', this.index, this.nameInput.value);
    await this.editor.refreshInstruments();
  }

  drawAt(event) {
    const rect = this.graph.getBoundingClientRect();
    const count = this.sequence.items.length;
    const index = Math.floor((event.clientX - rect.left) / rect.width * count);
    if (index < 0 || index >= count)
      return;
    const [low, high] = view(this.instrument.type, this.seqType, this.sequence.setting);
    const [min, max] = limits(this.instrument.type, this.seqType, this.sequence.setting);
    const fraction = 1 - (event.clientY - rect.top) / rect.height;
    const value = Math.max(min, Math.min(max, Math.round(low + fraction * (high - low))));
    if (this.sequence.items[index] === value)
      return;
    const items = [...this.sequence.items];
    items[index] = value;
    this.sequence = { ...this.sequence, items };
    this.mml.value = formatSequence(this.sequence);
    this.drawGraph();
    this.send();
  }

  drawGraph() {
    const canvas = this.graph;
    if (!this.sequence || !canvas.isConnected)
      return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height)
      return;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const style = getComputedStyle(this.dialog);
    const color = name => style.getPropertyValue(name).trim();
    ctx.fillStyle = color('--dnft-pe-bg');
    ctx.fillRect(0, 0, width, height);

    const { items, loop, release } = this.sequence;
    const [low, high] = view(this.instrument.type, this.seqType, this.sequence.setting);
    const y = value => height - (Math.max(low, Math.min(high, value)) - low) / (high - low) * height;
    const zero = y(Math.max(low, Math.min(high, 0)));
    ctx.fillStyle = color('--dnft-pe-separator');
    ctx.fillRect(0, Math.round(zero), width, 1);
    if (!items.length)
      return;
    const bar = width / items.length;
    ctx.fillStyle = color('--dnft-accent');
    items.forEach((value, i) => {
      const top = Math.min(y(value), zero), bottom = Math.max(y(value), zero);
      ctx.fillRect(i * bar + 1, top, Math.max(1, bar - 2), Math.max(2, bottom - top));
    });
    ctx.font = `11px ${style.fontFamily}`;
    ctx.textBaseline = 'top';
    const mark = (at, label, css) => {
      if (at < 0) return;
      ctx.fillStyle = color(css);
      ctx.fillRect(Math.round(at * bar), 0, 2, height);
      ctx.fillText(label, at * bar + 4, 2);
    };
    mark(loop, '|', '--dnft-pe-effect');
    mark(release, '/', '--dnft-pe-instrument');
  }
}

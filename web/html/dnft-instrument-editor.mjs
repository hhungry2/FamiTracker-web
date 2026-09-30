// Dn-FamiTracker web port - the instrument editor.
//
// A dialog with the panels the desktop tracker's instrument editor has for each kind of
// instrument: the sequences (2A03, VRC6, N163, 5B: five sequences as bars to draw with
// the mouse, and as the desktop's text form "15 12 | 10 8 / 4 0": what follows | loops, what
// follows / plays on release; the FDS has three of its own), the DPCM samples of the 2A03,
// the FDS's wave and modulation, the N163's waves and the VRC7's patch. A change goes to the
// engine at once, so a note held while drawing changes as it plays: the keyboard and the
// keys below the panels play the instrument being edited.
// Numbered sequences are shared between instruments, as on the desktop.

import { INST, SEQUENCE_INSTRUMENTS, INSTRUMENT_CHIP, NOTE_KEYS, CHIP, CHANNEL_ID, NOTE, MAX_VOLUME, OCTAVES } from './dnft-song.mjs';
import { build, colors, fitCanvas, FdsPanel, N163Panel, Vrc7Panel } from './dnft-instrument-panels.mjs';
import { DpcmPanel } from './dnft-dpcm.mjs';

const SEQ_COUNT = 5;
const MAX_ITEMS = 252;       // MAX_SEQUENCE_ITEMS
const MAX_SEQUENCES = 128;
const SETTING_COUNT = [2, 4, 2, 1, 1];   // SEQ_SETTING_COUNT (release build)
const FDS_SEQUENCES = 3;

const CHIP_NAMES = { [INST['2A03']]: '2A03', [INST.VRC6]: 'VRC6', [INST.VRC7]: 'VRC7', [INST.FDS]: 'FDS', [INST.N163]: 'N163', [INST.S5B]: '5B' };

// Values a sequence may hold: [min, max], and the part the graph shows
function limits(instType, seqType, setting) {
  switch (seqType) {
    case 0: return instType === INST.FDS ? [0, 32] : setting === 1 ? [0, 63] : [0, 15];
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

// ---- the sequences ------------------------------------------------------------------------------

class SequencePanel {
  constructor(owner) {
    this.owner = owner;
    this.instrument = null;
    this.seqType = 0;
    this.sequence = null;    // {items: [], loop, release, setting}
    this.root = build(`
      <div class="dnft-inst-panel dnft-sequences">
        <div class="dnft-tabs" role="tablist"></div>
        <div class="dnft-sequence">
          <div class="dnft-sequence-bar">
            <label class="dnft-check" data-slot><input type="checkbox" data-role="enabled"> <span data-t="enabled"></span></label>
            <label class="dnft-field dnft-field--inline" data-slot><span data-t="sequence"></span><input type="number" min="0" max="${MAX_SEQUENCES - 1}" data-role="index"></label>
            <button type="button" class="dnft-button" data-role="next-free" data-slot data-t="sequenceNextFree" data-title="sequenceNextFreeHint"></button>
            <button type="button" class="dnft-button" data-role="clone" data-slot data-t="sequenceClone" data-title="sequenceCloneHint"></button>
            <label class="dnft-field dnft-field--inline"><span data-t="length"></span><input type="number" min="0" max="${MAX_ITEMS}" data-role="length"></label>
            <select data-role="setting"></select>
          </div>
          <canvas class="dnft-sequence-graph" height="160"></canvas>
          <input type="text" class="dnft-sequence-mml" spellcheck="false" autocomplete="off" data-role="mml">
          <p class="dnft-hint" data-t="mmlHint"></p>
        </div>
      </div>`, owner.strings);
    const $ = selector => this.root.querySelector(selector);
    this.tabs = $('.dnft-tabs');
    this.enabled = $('[data-role=enabled]');
    this.indexInput = $('[data-role=index]');
    this.lengthInput = $('[data-role=length]');
    this.settingSelect = $('[data-role=setting]');
    this.graph = $('.dnft-sequence-graph');
    this.mml = $('[data-role=mml]');
    this.slotControls = this.root.querySelectorAll('[data-slot]');

    this.enabled.addEventListener('change', () => this.setUse(this.enabled.checked, this.sequenceIndex));
    this.indexInput.addEventListener('change', () => {
      const index = Math.max(0, Math.min(MAX_SEQUENCES - 1, Number(this.indexInput.value) || 0));
      this.setUse(this.enabledNow, index);
    });
    $('[data-role=next-free]').addEventListener('click', () => this.nextFree());
    $('[data-role=clone]').addEventListener('click', () => this.clone());
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
    // right-click: the desktop's menu with Clone sequence, on the list of sequences and the graph
    this.root.addEventListener('contextmenu', e => {
      if (this.fds || !e.target.closest('.dnft-tabs, .dnft-sequence-graph'))
        return;
      e.preventDefault();
      const tab = e.target.closest('.dnft-tab');
      const show = () => this.owner.contextMenu([
        { label: this.owner.strings.sequenceCloneMenu, disabled: !this.sequence.items.length, run: () => this.clone() },
      ], e.clientX, e.clientY);
      // the menu is about the sequence it was opened on
      if (tab && this.tabs.children[this.seqType] !== tab)
        this.selectSequence([...this.tabs.children].indexOf(tab)).then(show);
      else
        show();
    });

    this.graph.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !this.sequence || !this.sequence.items.length)
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
  }

  get title() {
    return this.owner.strings.instPanelSequences;
  }

  get fds() {
    return this.instrument?.type === INST.FDS;
  }

  get sequenceIndex() {
    return this.instrument.sequences[this.seqType].index;
  }

  get enabledNow() {
    return this.instrument.sequences[this.seqType].enabled;
  }

  async load(instrument) {
    const t = this.owner.strings;
    this.instrument = instrument;
    const names = t.sequenceNames[instrument.type] ?? t.sequenceNames[INST['2A03']];
    // the FDS keeps its sequences in the instrument: no numbers to choose
    for (const el of this.slotControls)
      el.hidden = this.fds;
    if (this.seqType >= names.length)
      this.seqType = 0;
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

  activate() {
    this.drawGraph();
  }

  // Whether the sequence of a kind has values in it, which the tab shows
  used(seqType) {
    if (this.fds)
      return this.instrument.fds.sequences[seqType].items.length > 0;
    return this.instrument.sequences[seqType].enabled;
  }

  async selectSequence(seqType) {
    this.seqType = seqType;
    // the sequence is read from the engine: what was drawn has to be there
    this.owner.flush();
    [...this.tabs.children].forEach((tab, i) => {
      tab.classList.toggle('is-active', i === seqType);
      tab.setAttribute('aria-selected', String(i === seqType));
      tab.classList.toggle('is-used', this.used(i));
    });
    // the sequence the instrument uses, as the engine has it
    const data = this.fds ? this.instrument.fds.sequences[seqType] :
      await this.owner.editor.session.call('sequence', this.instrument.type, seqType, this.sequenceIndex);
    this.sequence = { items: [...data.items], loop: data.loop, release: data.release, setting: data.setting };
    this.show();
  }

  show() {
    const t = this.owner.strings;
    if (!this.fds) {
      this.enabled.checked = this.enabledNow;
      this.indexInput.value = this.sequenceIndex;
    }
    this.lengthInput.value = this.sequence.items.length;
    const settings = t.settings[this.seqType] ?? [];
    // the 64-step volume is the sawtooth's
    const count = this.seqType === 0 && this.instrument.type !== INST.VRC6 ? 1 : SETTING_COUNT[this.seqType];
    this.settingSelect.hidden = count < 2;
    this.settingSelect.replaceChildren(...settings.slice(0, count).map((name, i) => new Option(name, i)));
    this.settingSelect.value = Math.min(this.sequence.setting, count - 1);
    this.mml.value = formatSequence(this.sequence);
    this.drawGraph();
    const empty = !this.sequence.items.length;
    this.root.querySelector('[data-role=clone]').disabled = empty;
  }

  // Sends the sequence to the engine, and shows it
  update(sequence) {
    this.sequence = sequence;
    if (this.fds)
      this.instrument.fds.sequences[this.seqType] = { ...sequence, items: [...sequence.items] };
    this.show();
    this.send();
  }

  send() {
    // at most once a frame while drawing
    this.owner.queue('sequence', () => {
      const { items, loop, release, setting } = this.sequence;
      if (this.fds)
        this.owner.change('setFdsSequence', this.seqType, Int8Array.from(items), loop, release, setting);
      else
        this.owner.editor.session.send('setSequence', this.instrument.type, this.seqType, this.sequenceIndex,
          Int8Array.from(items), loop, release, setting);
      this.owner.editor.changedInstruments();
      this.tabs.children[this.seqType]?.classList.toggle('is-used', this.used(this.seqType));
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
    if (!this.fds && parsed.items.length && !this.enabledNow)
      this.setUse(true, this.sequenceIndex);
  }

  async setUse(enabled, index) {
    // what was drawn goes first
    this.owner.flush();
    await this.owner.editor.session.call('setInstrumentSequence', this.owner.index, this.seqType, enabled, index);
    this.instrument.sequences[this.seqType] = { enabled, index };
    this.owner.editor.changedInstruments();
    await this.selectSequence(this.seqType);
  }

  // "Select next empty slot": the instrument takes the lowest number that has nothing in it
  // and no other instrument uses
  async nextFree() {
    const t = this.owner.strings;
    // whether the sequence has anything in it is for the engine to see
    this.owner.flush();
    const free = await this.owner.request('nextFreeSequence', this.seqType);
    if (free < 0) {
      this.owner.editor.message(t.sequenceNoFree, true);
      return;
    }
    await this.setUse(this.enabledNow, free);
  }

  // "Clone sequence": the sequence is copied into the next empty number, which the
  // instrument takes
  async clone() {
    const t = this.owner.strings;
    if (this.fds || !this.sequence.items.length)
      return;
    this.owner.flush();
    const free = await this.owner.request('cloneSequence', this.seqType);
    if (free < 0) {
      this.owner.editor.message(t.sequenceNoFree, true);
      return;
    }
    this.instrument.sequences[this.seqType] = { enabled: this.enabledNow, index: free };
    this.owner.editor.changedInstruments();
    await this.selectSequence(this.seqType);
    this.owner.editor.message(t.sequenceCloned.replace('%1', free));
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
    if (this.fds)
      this.instrument.fds.sequences[this.seqType] = { ...this.sequence, items: [...items] };
    this.mml.value = formatSequence(this.sequence);
    this.drawGraph();
    this.send();
  }

  drawGraph() {
    const canvas = this.graph;
    if (!this.sequence || !canvas.isConnected)
      return;
    const fit = fitCanvas(canvas);
    if (!fit)
      return;
    const { ctx, width, height } = fit;
    const color = colors(canvas);
    ctx.fillStyle = color('pe-bg');
    ctx.fillRect(0, 0, width, height);

    const { items, loop, release } = this.sequence;
    const [low, high] = view(this.instrument.type, this.seqType, this.sequence.setting);
    const y = value => height - (Math.max(low, Math.min(high, value)) - low) / (high - low) * height;
    const zero = y(Math.max(low, Math.min(high, 0)));
    ctx.fillStyle = color('pe-separator');
    ctx.fillRect(0, Math.round(zero), width, 1);
    if (!items.length)
      return;
    const bar = width / items.length;
    ctx.fillStyle = color('accent');
    items.forEach((value, i) => {
      const top = Math.min(y(value), zero), bottom = Math.max(y(value), zero);
      ctx.fillRect(i * bar + 1, top, Math.max(1, bar - 2), Math.max(2, bottom - top));
    });
    ctx.font = `11px ${getComputedStyle(canvas).fontFamily}`;
    ctx.textBaseline = 'top';
    const mark = (at, label, css) => {
      if (at < 0) return;
      ctx.fillStyle = color(css);
      ctx.fillRect(Math.round(at * bar), 0, 2, height);
      ctx.fillText(label, at * bar + 4, 2);
    };
    mark(loop, '|', 'pe-effect');
    mark(release, '/', 'pe-instrument');
  }
}

// ---- the dialog ---------------------------------------------------------------------------------

export class InstrumentEditor {
  constructor(editor) {
    this.editor = editor;
    this.index = null;
    this.instrument = null;
    this.panels = [];        // the panels of the instrument shown
    this.active = null;
    this.pending = new Map();
    this.timer = 0;
    this.pianoHeld = null;
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
        <span class="dnft-dialog-tools">
          <button type="button" class="dnft-button" data-role="save-fti"></button>
          <button type="submit" class="dnft-button" value="close"></button>
        </span>
      </form>
      <label class="dnft-field dnft-instrument-name"><span></span><input type="text" maxlength="60" spellcheck="false"></label>
      <div class="dnft-tabs dnft-panel-tabs" role="tablist"></div>
      <div class="dnft-instrument-body"></div>
      <div class="dnft-audition">
        <div class="dnft-piano" aria-hidden="true"></div>
        <p class="dnft-hint dnft-audition-hint"></p>
      </div>`;
    const $ = selector => dialog.querySelector(selector);
    $('.dnft-dialog-head button[type=submit]').textContent = t.close;
    this.saveButton = $('[data-role=save-fti]');
    this.saveButton.textContent = t.instSaveFti;
    this.saveButton.title = t.instSaveFtiHint;
    $('.dnft-instrument-name span').textContent = t.name;
    this.nameInput = $('.dnft-instrument-name input');
    this.tabs = $('.dnft-panel-tabs');
    this.body = $('.dnft-instrument-body');
    this.piano = $('.dnft-piano');
    this.auditionHint = $('.dnft-audition-hint');
    this.auditionHint.textContent = t.instAuditionHint;

    // the panels are made once, and show the instrument the dialog is opened on
    this.sequences = new SequencePanel(this);
    this.dpcm = new DpcmPanel(this);
    this.fdsPanel = new FdsPanel(this);
    this.n163 = new N163Panel(this);
    this.vrc7 = new Vrc7Panel(this);
    this.body.append(this.sequences.root, this.dpcm.root, this.fdsPanel.root, this.n163.root, this.vrc7.root);
    for (const panel of [this.sequences, this.dpcm, this.fdsPanel, this.n163, this.vrc7])
      panel.root.hidden = true;

    this.nameInput.addEventListener('change', () => this.rename());
    this.saveButton.addEventListener('click', () => this.saveFile());
    dialog.addEventListener('keydown', e => this.onKeyDown(e));
    dialog.addEventListener('close', () => {
      if (!dialog.open)
        this.onClose();
    });
    // a click outside the menu closes it
    dialog.addEventListener('pointerdown', e => {
      if (!e.target.closest('.dnft-context-menu'))
        this.closeMenu();
    });
    this.buildPiano();
    this.editor.root.append(dialog);
  }

  // ---- talking to the engine ---------------------------------------------------------------

  // A call about the instrument (its number goes first)
  request(method, ...args) {
    return this.editor.session.call(method, this.index, ...args);
  }

  // A change of the instrument, made at once and not waited for
  change(method, ...args) {
    this.editor.session.send(method, this.index, ...args);
    this.editor.changedInstruments();
  }

  // Runs `fn` once in the next 16 ms however often it is queued before then: an edit that is
  // made a hundred times a second goes to the engine at the screen's rate (a timer, not
  // an animation frame, so that it goes on in a tab that is not shown)
  queue(key, fn) {
    this.pending.set(key, fn);
    if (this.timer)
      return;
    this.timer = setTimeout(() => {
      this.timer = 0;
      this.flush();
    }, 16);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    const jobs = [...this.pending.values()];
    this.pending.clear();
    for (const job of jobs)
      job();
  }

  // ---- opening and closing -------------------------------------------------------------------

  async open(index) {
    this.index = index;
    if (!(await this.load()))
      return;
    if (!this.dialog.open)
      this.dialog.showModal();
    this.active?.activate?.();
  }

  close() {
    if (this.dialog.open)
      this.dialog.close();
  }

  onClose() {
    this.flush();
    this.closeMenu();
    this.releaseNotes();
    this.editor.session.send('stopPreview');
    this.editor.releaseHeldNotes();
    this.editor.renderInstruments();
  }

  // The panels an instrument of the kind has, in the order of the desktop's tabs
  panelsFor(instrument) {
    switch (instrument.type) {
      case INST['2A03']: return [this.sequences, this.dpcm];
      case INST.FDS: return [this.fdsPanel, this.sequences];
      case INST.N163: return [this.sequences, this.n163];
      case INST.VRC7: return [this.vrc7];
      default: return [this.sequences];
    }
  }

  async load() {
    const t = this.strings;
    try {
      this.instrument = await this.editor.session.call('instrument', this.index);
    } catch (e) {
      this.editor.message(t.failed + e.message, true);
      this.close();
      return false;
    }
    const { instrument } = this;
    const hex = this.index.toString(16).toUpperCase().padStart(2, '0');
    this.dialog.querySelector('.dnft-dialog-title').textContent = `${t.instrumentEditor} ${hex} (${CHIP_NAMES[instrument.type] ?? '?'})`;
    this.nameInput.value = instrument.name;
    this.panels = this.panelsFor(instrument);
    const all = [this.sequences, this.dpcm, this.fdsPanel, this.n163, this.vrc7];
    for (const panel of all)
      panel.root.hidden = true;
    await Promise.all(this.panels.map(panel => panel.load(instrument)));
    // the tabs of the panels, when there are several
    this.tabs.hidden = this.panels.length < 2;
    this.tabs.replaceChildren(...this.panels.map((panel, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.role = 'tab';
      tab.className = 'dnft-tab';
      tab.textContent = panel.title;
      tab.addEventListener('click', () => this.show(i));
      return tab;
    }));
    // as the desktop does: the DPCM first when the cursor is on the DPCM channel or the
    // instrument has samples
    let first = 0;
    if (instrument.type === INST['2A03'] && (this.cursorOnDpcm() || instrument.dpcm.samples.some(sample => sample)))
      first = 1;
    this.show(first);
    this.buildPiano();
    this.showAuditionState();
    return true;
  }

  show(index) {
    this.active = this.panels[index];
    this.panels.forEach((panel, i) => {
      panel.root.hidden = i !== index;
      this.tabs.children[i]?.classList.toggle('is-active', i === index);
      this.tabs.children[i]?.setAttribute('aria-selected', String(i === index));
    });
    this.active.activate?.();
    this.showAuditionState();
  }

  cursorOnDpcm() {
    const channel = this.editor.song.channels[this.editor.cursor.channel];
    return !!channel && channel.chip === CHIP.NONE && channel.id === CHANNEL_ID.DPCM;
  }

  async rename() {
    await this.editor.session.call('setInstrumentName', this.index, this.nameInput.value);
    this.editor.changedInstruments();
    await this.editor.refreshInstruments();
  }

  // Saves the instrument as an .fti file
  async saveFile() {
    this.flush();
    await this.editor.saveInstrumentFile(this.index);
  }

  // ---- a menu on the right button ------------------------------------------------------------

  // items: [{label, disabled, run}]
  contextMenu(items, x, y) {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'dnft-context-menu';
    menu.role = 'menu';
    for (const item of items) {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.role = 'menuitem';
      entry.className = 'dnft-menu-item';
      entry.textContent = item.label;
      entry.disabled = !!item.disabled;
      entry.addEventListener('click', () => {
        this.closeMenu();
        item.run();
      });
      menu.append(entry);
    }
    menu.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        this.closeMenu();
      }
    });
    this.dialog.append(menu);
    // inside the window
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height - 4))}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
    this.menu = menu;
  }

  closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  // ---- playing the instrument ------------------------------------------------------------------

  // The channel that plays the instrument: the cursor's when it is of the chip, otherwise
  // the chip's first. The 2A03's DPCM has its own channel (SwitchOnNote() of the desktop's
  // editor picks the same); -1 when the song has none.
  auditionChannel() {
    const channels = this.editor.song.channels;
    const current = this.editor.cursor.channel;
    if (this.instrument.type === INST['2A03']) {
      if (this.active === this.dpcm)
        return channels.findIndex(c => c.chip === CHIP.NONE && c.id === CHANNEL_ID.DPCM);
      const c = channels[current];
      if (c && c.chip === CHIP.NONE && c.id !== CHANNEL_ID.DPCM)
        return current;
      return channels.findIndex(c => c.chip === CHIP.NONE && c.id === 0);
    }
    const chip = INSTRUMENT_CHIP[this.instrument.type];
    if (channels[current]?.chip === chip)
      return current;
    return channels.findIndex(c => c.chip === chip);
  }

  showAuditionState() {
    if (!this.instrument)
      return;
    const t = this.strings;
    const playable = this.auditionChannel() >= 0;
    this.auditionHint.textContent = playable ? t.instAuditionHint : t.instNoChannel;
    this.auditionHint.classList.toggle('is-error', !playable);
  }

  // Plays a note of the instrument on `channel` (the default: where the instrument plays)
  noteOn(note, octave, channel = this.auditionChannel()) {
    if (channel < 0) {
      this.editor.message(this.strings.instNoChannel, true);
      return -1;
    }
    this.editor.session.resume();
    this.editor.session.send('noteOn', channel, note, octave, this.index, MAX_VOLUME);
    return channel;
  }

  noteOff(channel) {
    this.editor.session.send('noteOff', channel, false);
  }

  releaseNotes() {
    if (this.pianoHeld) {
      this.noteOff(this.pianoHeld.channel);
      this.pianoHeld.key.classList.remove('is-down');
      this.pianoHeld = null;
    }
  }

  onKeyDown(e) {
    // keys typed here are not the pattern's
    e.stopPropagation();
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.key === 'Escape')
      return;
    // text and numbers being typed are not notes
    if (e.target.matches('input:not([type=checkbox]):not([type=range]), textarea, select'))
      return;
    const key = NOTE_KEYS[e.code];
    if (!key)
      return;
    e.preventDefault();
    const octave = Math.min(OCTAVES - 1, this.editor.octave + key[1]);
    const channel = this.noteOn(NOTE.C + key[0], octave);
    if (channel >= 0)
      this.editor.held.set(e.code, channel);
  }

  buildPiano() {
    const piano = this.piano;
    piano.replaceChildren();
    const black = new Set([1, 3, 6, 8, 10]);
    for (let octave = 0; octave < 2; ++octave)
      for (let semitone = 0; semitone < 12; ++semitone) {
        const key = document.createElement('button');
        key.type = 'button';
        key.tabIndex = -1;
        key.className = black.has(semitone) ? 'dnft-piano-key is-black' : 'dnft-piano-key';
        key.dataset.semitone = semitone;
        key.dataset.octave = octave;
        if (semitone === 0)
          key.dataset.label = `C${this.editor.octave + octave}`;
        piano.append(key);
      }
    if (this.pianoBound)
      return;
    this.pianoBound = true;
    const pianoKey = e => e.target.closest('.dnft-piano-key');
    const press = key => {
      this.releaseNotes();
      const octave = Math.min(OCTAVES - 1, this.editor.octave + Number(key.dataset.octave));
      const channel = this.noteOn(NOTE.C + Number(key.dataset.semitone), octave);
      if (channel < 0)
        return;
      key.classList.add('is-down');
      this.pianoHeld = { key, channel };
    };
    piano.addEventListener('pointerdown', e => {
      const key = pianoKey(e);
      if (!key)
        return;
      e.preventDefault();
      if (key.hasPointerCapture?.(e.pointerId))
        key.releasePointerCapture(e.pointerId);
      press(key);
    });
    piano.addEventListener('pointerover', e => {
      const key = pianoKey(e);
      if (key && this.pianoHeld && key !== this.pianoHeld.key && e.buttons)
        press(key);
    });
    const release = () => this.releaseNotes();
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  }
}

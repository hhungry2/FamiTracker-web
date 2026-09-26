// Dn-FamiTracker web port - the editor.
//
// A tracker in the page, on the tracker's own engine: the module and its sound live in
// a worker (dnft-session-engine.mjs); this is what the desktop tracker's window does.
// Keys follow the desktop's defaults: the Z and Q rows of the keyboard enter notes, 1 a
// note cut, \ a release, hex digits the other columns; Space toggles editing, Enter plays
// the frame or stops, F5-F8 play from the start, loop the pattern, play from the cursor
// and stop. Edits of the patterns, the frames and the song's settings can be undone.
// The module is kept in the browser (localStorage) as it changes.
//
//   import { DnFTEditor } from './dnft-editor.mjs';
//   const editor = await DnFTEditor.create(element, { base: '.', lang: 'ja' });

import { DnFTSession, PLAY, unsupportedReason } from './dnft-session.mjs';
import {
  Song, History, CELL, NOTE, MAX_VOLUME, NO_INSTRUMENT, HOLD_INSTRUMENT, MAX_INSTRUMENTS, MAX_FRAMES,
  MAX_PATTERNS, MAX_ROWS, OCTAVES, CHIP, CHANNEL_ID, EMPTY_CELL,
} from './dnft-song.mjs';
import { PatternView, columnCount, columnKind } from './dnft-pattern-view.mjs';
import { InstrumentEditor } from './dnft-instrument-editor.mjs';
import { STRINGS } from './dnft-editor-strings.mjs';

const AUTOSAVE_KEY = 'dnft-editor.autosave';
const AUTOSAVE_DELAY = 1500;
const PAGE_ROWS = 16;

// The desktop's note keys, by the key's place on the keyboard: [semitone, octave offset]
const NOTE_KEYS = {
  KeyZ: [0, 0], KeyS: [1, 0], KeyX: [2, 0], KeyD: [3, 0], KeyC: [4, 0], KeyV: [5, 0], KeyG: [6, 0],
  KeyB: [7, 0], KeyH: [8, 0], KeyN: [9, 0], KeyJ: [10, 0], KeyM: [11, 0],
  Comma: [0, 1], KeyL: [1, 1], Period: [2, 1], Semicolon: [3, 1], Slash: [4, 1],
  KeyQ: [0, 1], Digit2: [1, 1], KeyW: [2, 1], Digit3: [3, 1], KeyE: [4, 1], KeyR: [5, 1], Digit5: [6, 1],
  KeyT: [7, 1], Digit6: [8, 1], KeyY: [9, 1], Digit7: [10, 1], KeyU: [11, 1],
  KeyI: [0, 2], Digit9: [1, 2], KeyO: [2, 2], Digit0: [3, 2], KeyP: [4, 2],
  BracketLeft: [5, 2], Equal: [6, 2], BracketRight: [7, 2],
};

const CHIPS = [['VRC6', CHIP.VRC6], ['VRC7', CHIP.VRC7], ['FDS', CHIP.FDS], ['MMC5', CHIP.MMC5], ['N163', CHIP.N163], ['5B', CHIP.S5B]];

const hex2 = value => value.toString(16).toUpperCase().padStart(2, '0');
const samePlace = (a, b) => a === b || (a && b && a.frame === b.frame && a.row === b.row);

function hexOfKey(event) {
  const code = event.code;
  if (/^(Digit|Numpad)[0-9]$/.test(code))
    return Number(code.at(-1));
  if (/^Key[A-F]$/.test(code))
    return 10 + code.charCodeAt(3) - 65;
  return -1;
}

// A cell's fields: 0 note (with its octave), 1 instrument, 2 volume, 3-6 the effects
const fieldOfColumn = column => column === 0 ? 0 : column <= 2 ? 1 : column === 3 ? 2 : 3 + Math.floor((column - 4) / 3);

function copyField(from, to, field) {
  if (field === 0) { to[0] = from[0]; to[1] = from[1]; }
  else if (field === 1) to[3] = from[3];
  else if (field === 2) to[2] = from[2];
  else { to[4 + field - 3] = from[4 + field - 3]; to[8 + field - 3] = from[8 + field - 3]; }
}

function clearField(cell, field) {
  copyField(EMPTY_CELL, cell, field);
}

function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}

export class DnFTEditor {
  static async create(container, options = {}) {
    const editor = new DnFTEditor(container, options);
    await editor.start();
    return editor;
  }

  // base: where the engine files are; lang: 'ja' or 'en'; autosave: keep the module in
  // localStorage; source: the link to the source code; demos: the URL of a JSON list of
  // modules next to it, offered to open
  constructor(container, {
    base = '.',
    lang = navigator.language?.startsWith('ja') ? 'ja' : 'en',
    autosave = true,
    source = 'https://github.com/hhungry2/Dn-FamiTracker-web',
    demos = null,
  } = {}) {
    this.base = base;
    this.strings = STRINGS[lang] ?? STRINGS.en;
    this.autosave = autosave;
    this.source = source;
    this.demos = demos;

    this.session = null;
    this.song = null;
    this.track = 0;
    this.cursor = { frame: 0, row: 0, channel: 0, column: 0 };
    this.selection = null;      // {frame, rowStart, rowEnd, channelStart, columnStart, channelEnd, columnEnd}
    this.anchor = null;         // where a selection being made started
    this.editMode = true;
    this.follow = true;
    this.playing = false;
    this.play = null;           // {frame, row} heard now while the song plays
    this.muted = [];
    this.octave = 3;
    this.step = 1;
    this.instrument = 0;
    this.history = new History();
    this.clipboard = null;
    this.held = new Map();      // note keys held: code -> channel
    this.dirty = false;         // changed since last saved to a file
    this.fileName = null;
    this.frameDigits = '';

    this.build(container);
  }

  // ---- building -------------------------------------------------------------------------

  build(container) {
    const t = this.strings;
    const root = this.root = document.createElement('div');
    root.className = 'dnft-editor';
    root.innerHTML = `
      <div class="dnft-toolbar" role="toolbar">
        <div class="dnft-group">
          <button type="button" class="dnft-button" data-action="new"></button>
          <button type="button" class="dnft-button" data-action="open"></button>
          <button type="button" class="dnft-button" data-action="save"><span></span><i class="dnft-dirty" hidden></i></button>
          <input type="file" class="dnft-file" accept=".dnm,.0cc,.ftm" hidden>
          <select class="dnft-demos" hidden></select>
        </div>
        <div class="dnft-group">
          <button type="button" class="dnft-button dnft-button--primary" data-action="play"></button>
          <button type="button" class="dnft-button" data-action="play-song"></button>
          <button type="button" class="dnft-button" data-action="play-pattern"></button>
          <button type="button" class="dnft-button" data-action="play-cursor"></button>
          <button type="button" class="dnft-button" data-action="stop"></button>
        </div>
        <div class="dnft-group">
          <span class="dnft-spin" data-spin="octave"><span class="dnft-label"></span><button type="button" data-action="octave-down">−</button><output></output><button type="button" data-action="octave-up">+</button></span>
          <span class="dnft-spin" data-spin="step"><span class="dnft-label"></span><button type="button" data-action="step-down">−</button><output></output><button type="button" data-action="step-up">+</button></span>
          <label class="dnft-field dnft-field--inline"><span class="dnft-label"></span><select data-role="instrument"></select></label>
        </div>
        <div class="dnft-group">
          <button type="button" class="dnft-button dnft-toggle" data-action="edit"></button>
          <button type="button" class="dnft-button dnft-toggle" data-action="follow"></button>
          <button type="button" class="dnft-button" data-action="undo"></button>
          <button type="button" class="dnft-button" data-action="redo"></button>
        </div>
        <label class="dnft-group dnft-volume"><span class="dnft-label"></span><input type="range" min="0" max="1" step="0.01" value="0.8" data-role="volume"></label>
      </div>
      <div class="dnft-main">
        <aside class="dnft-side">
          <details class="dnft-panel" open>
            <summary data-text="song"></summary>
            <div class="dnft-panel-body dnft-song">
              <label class="dnft-field"><span data-text="title"></span><input type="text" data-song="title" spellcheck="false"></label>
              <label class="dnft-field"><span data-text="artist"></span><input type="text" data-song="artist" spellcheck="false"></label>
              <label class="dnft-field"><span data-text="copyright"></span><input type="text" data-song="copyright" spellcheck="false"></label>
              <div class="dnft-field dnft-track">
                <span data-text="track"></span>
                <select data-role="track"></select>
                <button type="button" class="dnft-icon-button" data-action="add-track">+</button>
                <button type="button" class="dnft-icon-button" data-action="remove-track">−</button>
              </div>
              <div class="dnft-grid">
                <label class="dnft-field"><span data-text="speed"></span><input type="number" data-setting="speed" min="1" max="255"></label>
                <label class="dnft-field"><span data-text="tempo"></span><input type="number" data-setting="tempo" min="32" max="255"></label>
                <label class="dnft-field"><span data-text="rows"></span><input type="number" data-setting="rows" min="1" max="${MAX_ROWS}"></label>
                <label class="dnft-field"><span data-text="frames"></span><input type="number" data-setting="frames" min="1" max="${MAX_FRAMES}"></label>
                <label class="dnft-field"><span data-text="highlight"></span><span class="dnft-pair"><input type="number" data-setting="beat" min="0" max="${MAX_ROWS}"><input type="number" data-setting="bar" min="0" max="${MAX_ROWS}"></span></label>
              </div>
            </div>
          </details>
          <details class="dnft-panel">
            <summary data-text="module"></summary>
            <div class="dnft-panel-body">
              <div class="dnft-field"><span data-text="chips"></span><div class="dnft-chips"></div></div>
              <label class="dnft-field dnft-field--inline"><span data-text="n163Channels"></span><input type="number" data-role="n163" min="1" max="8" value="1"></label>
              <label class="dnft-field dnft-field--inline"><span data-text="machine"></span><select data-role="machine"><option value="0">NTSC</option><option value="1">PAL</option></select></label>
            </div>
          </details>
          <section class="dnft-panel dnft-frames-panel">
            <header class="dnft-panel-head"><span data-text="frameList"></span>
              <span class="dnft-panel-tools">
                <button type="button" class="dnft-icon-button" data-action="insert-frame"></button>
                <button type="button" class="dnft-icon-button" data-action="duplicate-frame"></button>
                <button type="button" class="dnft-icon-button" data-action="clone-frame"></button>
                <button type="button" class="dnft-icon-button" data-action="remove-frame"></button>
                <button type="button" class="dnft-icon-button" data-action="frame-up">↑</button>
                <button type="button" class="dnft-icon-button" data-action="frame-down">↓</button>
                <button type="button" class="dnft-icon-button" data-action="pattern-down">−</button>
                <button type="button" class="dnft-icon-button" data-action="pattern-up">+</button>
              </span>
            </header>
            <div class="dnft-frame-list" tabindex="0"></div>
          </section>
          <section class="dnft-panel dnft-instruments-panel">
            <header class="dnft-panel-head"><span data-text="instruments"></span>
              <span class="dnft-panel-tools">
                <button type="button" class="dnft-icon-button" data-action="add-instrument"></button>
                <button type="button" class="dnft-icon-button" data-action="clone-instrument"></button>
                <button type="button" class="dnft-icon-button" data-action="remove-instrument"></button>
                <button type="button" class="dnft-icon-button" data-action="edit-instrument"></button>
              </span>
            </header>
            <ul class="dnft-instrument-list" role="listbox"></ul>
          </section>
        </aside>
        <div class="dnft-pattern"></div>
      </div>
      <div class="dnft-keys">
        <div class="dnft-piano" aria-hidden="true"></div>
        <div class="dnft-key-actions">
          <button type="button" class="dnft-button" data-action="note-cut"></button>
          <button type="button" class="dnft-button" data-action="note-release"></button>
          <button type="button" class="dnft-button" data-action="clear"></button>
          <button type="button" class="dnft-button" data-action="insert-row"></button>
          <button type="button" class="dnft-button" data-action="delete-row"></button>
        </div>
      </div>
      <div class="dnft-status">
        <span class="dnft-position"></span>
        <span class="dnft-message" role="status"></span>
        <span class="dnft-source"></span>
      </div>
      <div class="dnft-drop" hidden></div>
      <div class="dnft-loading"></div>`;
    container.append(root);

    const $ = selector => root.querySelector(selector);
    const label = (action, text, hint) => {
      const button = root.querySelector(`[data-action="${action}"]`);
      (button.querySelector('span') ?? button).textContent = text;
      if (hint) button.title = hint;
    };
    label('new', t.newSong, t.newHint);
    label('open', t.open, t.openHint);
    label('save', t.save, t.saveHint);
    label('play', `▶ ${t.play}`, t.playHint);
    label('play-song', t.playSong, t.playSongHint);
    label('play-pattern', t.playPattern, t.playPatternHint);
    label('play-cursor', t.playCursor, t.playCursorHint);
    label('stop', `■ ${t.stop}`, t.stopHint);
    label('edit', t.edit, t.editHint);
    label('follow', t.follow, t.followHint);
    label('undo', '↶', t.undoHint);
    label('redo', '↷', t.redoHint);
    label('insert-frame', '＋', t.insertFrameHint);
    label('duplicate-frame', '⧉', t.duplicateFrameHint);
    label('clone-frame', '⎘', t.cloneFrameHint);
    label('remove-frame', '✕', t.removeFrameHint);
    root.querySelector('[data-action="frame-up"]').title = t.moveUp;
    root.querySelector('[data-action="frame-down"]').title = t.moveDown;
    root.querySelector('[data-action="pattern-down"]').title = t.patternDown;
    root.querySelector('[data-action="pattern-up"]').title = t.patternUp;
    label('add-instrument', '＋', t.addInstrumentHint);
    label('clone-instrument', '⧉', t.cloneInstrument);
    label('remove-instrument', '✕', t.removeInstrument);
    label('edit-instrument', '✎', t.editInstrument);
    label('add-track', '+', t.addTrack);
    label('remove-track', '−', t.removeTrack);
    label('note-cut', '---', t.noteCutHint);
    label('note-release', '===', t.noteReleaseHint);
    label('clear', t.clearField, t.clearFieldHint);
    label('insert-row', t.insertRow, t.insertRowHint);
    label('delete-row', t.deleteRow, t.deleteRowHint);
    $('[data-spin="octave"] .dnft-label').textContent = t.octave;
    $('[data-spin="octave"]').title = t.octaveHint;
    $('[data-spin="step"] .dnft-label').textContent = t.step;
    $('[data-spin="step"]').title = t.stepHint;
    $('[data-role="instrument"]').previousElementSibling.textContent = t.instrument;
    $('.dnft-volume .dnft-label').textContent = t.volume;
    root.querySelectorAll('[data-text]').forEach(el => { el.textContent = t[el.dataset.text]; });
    $('[data-setting="speed"]').title = t.speedHint;
    $('[data-setting="rows"]').title = t.rowsHint;
    $('[data-setting="beat"]').title = t.highlightHint;
    $('[data-setting="bar"]').title = t.highlightHint;
    $('.dnft-drop').textContent = t.dropHere;
    $('.dnft-loading').textContent = t.loading;
    const source = $('.dnft-source');
    source.append(t.source);
    const link = document.createElement('a');
    link.href = this.source;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = this.source.replace(/^https:\/\//, '');
    source.append(link);

    $('.dnft-chips').append(...CHIPS.map(([name, bit]) => {
      const box = document.createElement('label');
      box.className = 'dnft-check';
      box.innerHTML = `<input type="checkbox" value="${bit}"> <span>${name}</span>`;
      return box;
    }));

    this.els = {
      toolbar: $('.dnft-toolbar'), file: $('.dnft-file'), dirty: $('.dnft-dirty'),
      octave: $('[data-spin="octave"] output'), step: $('[data-spin="step"] output'),
      instrument: $('[data-role="instrument"]'), volume: $('[data-role="volume"]'),
      track: $('[data-role="track"]'), n163: $('[data-role="n163"]'), machine: $('[data-role="machine"]'),
      chips: $('.dnft-chips'), frames: $('.dnft-frame-list'), instruments: $('.dnft-instrument-list'),
      pattern: $('.dnft-pattern'), piano: $('.dnft-piano'), position: $('.dnft-position'),
      message: $('.dnft-message'), drop: $('.dnft-drop'), loading: $('.dnft-loading'),
    };

    this.view = new PatternView(this.els.pattern, this);
    this.view.scroller.setAttribute('aria-label', t.pattern);
    this.instrumentEditor = new InstrumentEditor(this);
    this.buildPiano();
    this.wire();
    if (this.demos)
      this.listDemos($('.dnft-demos'));
  }

  // Modules listed in a JSON file (["name.dnm", ...]) next to it, to open from a menu
  async listDemos(select) {
    let names;
    try {
      const response = await fetch(this.demos);
      names = response.ok ? await response.json() : [];
    } catch {
      names = [];
    }
    if (!names.length)
      return;
    const base = new URL(this.demos, location.href);
    select.append(new Option(this.strings.demos, ''), ...names.map(name => new Option(name.replace(/\.(dnm|0cc|ftm)$/i, ''), name)));
    select.hidden = false;
    select.addEventListener('change', async () => {
      const name = select.value;
      select.value = '';
      if (!name)
        return;
      const response = await fetch(new URL(encodeURIComponent(name), base));
      this.openFile(new File([await response.arrayBuffer()], name));
    });
  }

  buildPiano() {
    const piano = this.els.piano;
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
          key.dataset.label = `C${this.octave + octave}`;
        piano.append(key);
      }
  }

  wire() {
    const { root, els } = this;
    // buttons keep the keyboard on the pattern
    root.addEventListener('mousedown', e => {
      if (e.target.closest('button') && !e.target.closest('dialog'))
        e.preventDefault();
    });
    root.addEventListener('click', e => {
      const button = e.target.closest('[data-action]');
      if (button && !button.disabled && root.contains(button) && !button.closest('dialog'))
        this.action(button.dataset.action, e);
    });
    root.addEventListener('pointerdown', () => this.session?.resume(), { capture: true });
    root.addEventListener('keydown', e => this.onKeyDown(e));
    root.addEventListener('keyup', e => this.onKeyUp(e));
    window.addEventListener('blur', () => this.releaseHeldNotes());

    els.file.addEventListener('change', () => {
      const file = els.file.files[0];
      els.file.value = '';
      if (file)
        this.openFile(file);
    });
    root.addEventListener('dragover', e => {
      if (![...e.dataTransfer.types].includes('Files'))
        return;
      e.preventDefault();
      els.drop.hidden = false;
    });
    root.addEventListener('dragleave', e => {
      if (!root.contains(e.relatedTarget))
        els.drop.hidden = true;
    });
    root.addEventListener('drop', e => {
      e.preventDefault();
      els.drop.hidden = true;
      const file = e.dataTransfer.files[0];
      if (file)
        this.openFile(file);
    });

    els.instrument.addEventListener('change', () => this.selectInstrument(Number(els.instrument.value)));
    els.volume.addEventListener('input', () => {
      if (this.session)
        this.session.volume = Number(els.volume.value);
    });
    els.track.addEventListener('change', () => this.selectTrack(Number(els.track.value)));
    root.querySelectorAll('[data-song]').forEach(input => {
      input.addEventListener('change', () => this.setSongText(input.dataset.song, input.value));
    });
    root.querySelectorAll('[data-setting]').forEach(input => {
      input.addEventListener('change', () => this.setSetting(input.dataset.setting, Number(input.value)));
    });
    els.chips.addEventListener('change', () => this.setExpansion());
    els.n163.addEventListener('change', () => this.setExpansion());
    els.machine.addEventListener('change', () => this.setMachine(els.machine.value === '1'));

    // the pattern
    const scroller = this.view.scroller;
    scroller.tabIndex = 0;
    scroller.addEventListener('pointerdown', e => this.onGridPointerDown(e));
    scroller.addEventListener('pointermove', e => this.onGridPointerMove(e));
    scroller.addEventListener('pointerup', () => { this.dragging = false; });
    scroller.addEventListener('pointercancel', () => { this.dragging = false; });
    scroller.addEventListener('wheel', e => this.onGridWheel(e), { passive: false });

    // the frames
    els.frames.addEventListener('click', e => {
      const cell = e.target.closest('[data-frame]');
      if (!cell)
        return;
      const channel = cell.dataset.channel !== undefined ? Number(cell.dataset.channel) : this.cursor.channel;
      this.setCursor({ ...this.cursor, frame: Number(cell.dataset.frame), channel, column: channel === this.cursor.channel ? this.cursor.column : 0 });
    });
    els.frames.addEventListener('keydown', e => this.onFrameKey(e));

    // the instruments
    els.instruments.addEventListener('click', e => {
      const item = e.target.closest('[data-instrument]');
      if (item)
        this.selectInstrument(Number(item.dataset.instrument));
    });
    els.instruments.addEventListener('dblclick', e => {
      const item = e.target.closest('[data-instrument]');
      if (item)
        this.instrumentEditor.open(Number(item.dataset.instrument));
    });

    // the piano: press a key, slide to others
    const pianoKey = e => e.target.closest('.dnft-piano-key');
    els.piano.addEventListener('pointerdown', e => {
      const key = pianoKey(e);
      if (!key)
        return;
      e.preventDefault();
      // touch keeps the pointer on the first key otherwise
      if (key.hasPointerCapture?.(e.pointerId))
        key.releasePointerCapture(e.pointerId);
      this.pianoNote(key, true);
    });
    els.piano.addEventListener('pointerover', e => {
      const key = pianoKey(e);
      if (key && this.pianoHeld && key !== this.pianoHeld.key && e.buttons)
        this.pianoNote(key, true);
    });
    const release = () => {
      if (this.pianoHeld)
        this.pianoNote(null, false);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  }

  // ---- starting, opening, saving ------------------------------------------------------

  async start() {
    const reason = unsupportedReason();
    if (reason) {
      this.els.loading.textContent = this.strings.unsupported + reason;
      return;
    }
    try {
      this.session = await DnFTSession.create({ base: this.base });
      this.session.volume = Number(this.els.volume.value);
      this.session.onerror = message => this.message(this.strings.failed + message, true);
      let snapshot = null;
      const saved = this.readAutosave();
      if (saved) {
        try {
          snapshot = await this.session.call('open', saved.bytes, this.session.sampleRate);
          this.fileName = saved.name;
          this.dirty = saved.dirty;
        } catch {
          snapshot = null;
        }
      }
      const restored = !!snapshot;
      snapshot ??= await this.session.call('create', this.session.sampleRate);
      this.setSong(snapshot);
      if (restored)
        this.message(this.strings.restored);
      this.els.loading.hidden = true;
      this.session.onplayed = () => this.tick();
      this.loop();
    } catch (e) {
      this.els.loading.textContent = this.strings.failed + e.message;
      throw e;
    }
  }

  setSong(snapshot) {
    this.stopPlaying();
    this.session.clearRows();
    this.song = new Song(snapshot);
    this.track = 0;
    this.cursor = { frame: 0, row: 0, channel: 0, column: 0 };
    this.selection = this.anchor = null;
    this.muted = this.song.channels.map(() => false);
    this.instrument = this.song.instruments[0]?.index ?? 0;
    this.history.clear();
    this.renderAll();
  }

  renderAll() {
    this.view.layout();
    this.renderSongPanel();
    this.renderFrames();
    this.renderInstruments();
    this.renderToolbar();
    this.updateStatus();
  }

  async newSong() {
    if (this.dirty && !confirm(this.strings.confirmNew))
      return;
    this.setSong(await this.session.call('create', this.session.sampleRate));
    this.fileName = null;
    this.dirty = false;
    this.message(this.strings.created);
    this.saveToBrowser();
  }

  async openFile(file) {
    if (this.dirty && !confirm(this.strings.confirmOpen))
      return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      this.setSong(await this.session.call('open', bytes, this.session.sampleRate));
    } catch (e) {
      this.message(this.strings.notModule + e.message, true);
      return;
    }
    this.fileName = file.name.replace(/\.(dnm|0cc|ftm)$/i, '');
    this.dirty = false;
    this.message(this.strings.opened + file.name);
    this.saveToBrowser();
    this.renderToolbar();
  }

  async saveFile() {
    let bytes;
    try {
      bytes = await this.session.call('save');
    } catch (e) {
      this.message(this.strings.failed + e.message, true);
      return;
    }
    const base = (this.fileName || this.song.info.title || 'untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'untitled';
    const name = `${base}.dnm`;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    this.fileName = base;
    this.dirty = false;
    this.renderToolbar();
    this.message(this.strings.saved + name);
    this.writeAutosave(bytes);
  }

  // ---- keeping the module in the browser ------------------------------------------------

  readAutosave() {
    if (!this.autosave)
      return null;
    try {
      const saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY));
      return saved?.data ? { bytes: fromBase64(saved.data), name: saved.name ?? null, dirty: !!saved.dirty } : null;
    } catch {
      return null;
    }
  }

  writeAutosave(bytes) {
    if (!this.autosave)
      return;
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ data: toBase64(bytes), name: this.fileName, dirty: this.dirty, time: Date.now() }));
    } catch {
      // full or blocked: the module stays in the page
    }
  }

  saveToBrowser() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    if (this.autosave && this.session)
      this.session.call('save').then(bytes => this.writeAutosave(bytes), () => {});
  }

  scheduleAutosave() {
    if (!this.autosave)
      return;
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => this.saveToBrowser(), AUTOSAVE_DELAY);
  }

  // ---- the frame loop -------------------------------------------------------------------

  loop() {
    const frame = () => {
      this.tick();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // Follows the audio: the row heard, the end of the song
  tick() {
    const play = this.session.poll();
    if (this.session.ended) {
      this.session.ended = false;
      this.stopPlaying();
    }
    if (samePlace(play, this.play))
      return;
    this.play = play;
    if (play && this.playing && this.follow && !this.dragging) {
      const frameChanged = play.frame !== this.cursor.frame;
      this.cursor.frame = play.frame;
      this.cursor.row = play.row;
      if (frameChanged)
        this.renderFrames();
    }
    this.view.invalidate();
    this.updateStatus();
  }

  // ---- state shortcuts ------------------------------------------------------------------

  get tr() {
    return this.song.track(this.track);
  }

  get channelCount() {
    return this.song.channels.length;
  }

  columns(channel) {
    return columnCount(this.tr.effColumns[channel]);
  }

  patternOf(frame, channel) {
    return this.song.patternAt(this.track, frame, channel);
  }

  // ---- cursor and selection -----------------------------------------------------------

  setCursor(place, { extend = false } = {}) {
    const tr = this.tr;
    const before = this.cursor;
    const cursor = {
      frame: Math.max(0, Math.min(tr.frames - 1, place.frame)),
      row: Math.max(0, Math.min(tr.rows - 1, place.row)),
      channel: Math.max(0, Math.min(this.channelCount - 1, place.channel)),
      column: 0,
    };
    cursor.column = Math.max(0, Math.min(this.columns(cursor.channel) - 1, place.column));
    if (extend) {
      this.anchor ??= { ...before };
      if (cursor.frame !== this.anchor.frame) {
        // selections stay in one frame
        cursor.frame = this.anchor.frame;
        cursor.row = place.frame < this.anchor.frame ? 0 : tr.rows - 1;
      }
      this.selection = this.makeSelection(this.anchor, cursor);
    } else {
      this.anchor = null;
      this.selection = null;
    }
    const frameChanged = cursor.frame !== before.frame;
    this.cursor = cursor;
    this.view.reveal(cursor.channel);
    this.view.invalidate();
    if (frameChanged || cursor.channel !== before.channel)
      this.renderFrames();
    this.updateStatus();
  }

  makeSelection(a, b) {
    const first = a.channel < b.channel || (a.channel === b.channel && a.column <= b.column) ? a : b;
    const last = first === a ? b : a;
    return {
      frame: a.frame,
      rowStart: Math.min(a.row, b.row),
      rowEnd: Math.max(a.row, b.row),
      channelStart: first.channel,
      columnStart: first.column,
      channelEnd: last.channel,
      columnEnd: last.column,
    };
  }

  moveRows(delta, extend = false) {
    const { rows, frames } = this.tr;
    let at = this.cursor.frame * rows + this.cursor.row + delta;
    if (!extend)
      at = ((at % (frames * rows)) + frames * rows) % (frames * rows);
    this.setCursor({ ...this.cursor, frame: Math.floor(at / rows), row: ((at % rows) + rows) % rows }, { extend });
  }

  moveColumn(delta, extend = false) {
    let { channel, column } = this.cursor;
    column += delta;
    if (column < 0) {
      channel = (channel + this.channelCount - 1) % this.channelCount;
      column = this.columns(channel) - 1;
    } else if (column >= this.columns(channel)) {
      channel = (channel + 1) % this.channelCount;
      column = 0;
    }
    this.setCursor({ ...this.cursor, channel, column }, { extend });
  }

  moveChannel(delta) {
    const channel = (this.cursor.channel + delta + this.channelCount) % this.channelCount;
    this.setCursor({ ...this.cursor, channel, column: 0 });
  }

  stepDown() {
    if (this.step > 0 && !(this.playing && this.follow))
      this.moveRows(this.step);
  }

  // ---- playback -------------------------------------------------------------------------

  startPlaying(mode) {
    this.session.resume();
    this.releaseHeldNotes();
    this.session.play(this.track, mode, this.cursor.frame, this.cursor.row);
    this.playing = true;
    this.renderToolbar();
  }

  stopPlaying() {
    if (this.playing)
      this.session?.stop();
    this.playing = false;
    this.renderToolbar();
    this.updateStatus();
  }

  togglePlay() {
    if (this.playing)
      this.stopPlaying();
    else
      this.startPlaying(PLAY.FRAME);
  }

  // ---- notes played by hand --------------------------------------------------------------

  // Whether keys play what they enter: not while editing along the song without
  // following it (CFamiTrackerView::TriggerMIDINote())
  previews() {
    return !(this.playing && this.editMode && !this.follow);
  }

  noteOn(channel, note, octave) {
    this.session.resume();
    this.session.send('noteOn', channel, note, octave, this.instrument, MAX_VOLUME);
  }

  noteOff(channel) {
    this.session.send('noteOff', channel, false);
  }

  releaseHeldNotes() {
    for (const channel of this.held.values())
      this.noteOff(channel);
    this.held.clear();
  }

  pianoNote(key, down) {
    if (this.pianoHeld) {
      this.noteOff(this.pianoHeld.channel);
      this.pianoHeld.key.classList.remove('is-down');
      this.pianoHeld = null;
    }
    if (!down || !key)
      return;
    const semitone = Number(key.dataset.semitone);
    const octave = Math.min(OCTAVES - 1, this.octave + Number(key.dataset.octave));
    const channel = this.cursor.channel;
    key.classList.add('is-down');
    this.pianoHeld = { key, channel };
    if (this.previews())
      this.noteOn(channel, NOTE.C + semitone, octave);
    if (this.editMode && this.cursor.column === 0)
      this.enterNote(NOTE.C + semitone, octave);
  }

  // ---- editing ----------------------------------------------------------------------------

  record(action) {
    this.history.record(action);
    this.edited();
  }

  edited() {
    this.dirty = true;
    this.scheduleAutosave();
    this.view.invalidate();
    this.renderToolbar();
  }

  undo() {
    if (this.history.undo())
      this.edited();
  }

  redo() {
    if (this.history.redo())
      this.edited();
  }

  writeCells(track, channel, pattern, row, cells) {
    this.song.writeCells(track, channel, pattern, row, cells);
    this.session.send('setCells', track, channel, pattern, row, cells);
  }

  // Changes cells as one action: [{channel, pattern, row, cells}], in the current track
  change(changes, cursorAfter = null) {
    if (!changes.length)
      return;
    const track = this.track;
    const before = { ...this.cursor };
    const old = changes.map(c => this.song.readCells(track, c.channel, c.pattern, c.row, c.cells.length / CELL));
    const apply = values => changes.forEach((c, i) => this.writeCells(track, c.channel, c.pattern, c.row, values[i]));
    const fresh = changes.map(c => c.cells);
    apply(fresh);
    const after = cursorAfter ?? { ...this.cursor };
    this.record({
      undo: () => { this.showTrack(track); apply(old); this.setCursor(before); },
      redo: () => { this.showTrack(track); apply(fresh); this.setCursor(after); },
    });
  }

  cellHere() {
    const { frame, row, channel } = this.cursor;
    return Uint8Array.from(this.song.cell(this.track, frame, channel, row));
  }

  changeHere(cell) {
    const { frame, row, channel } = this.cursor;
    this.change([{ channel, pattern: this.patternOf(frame, channel), row, cells: cell }]);
  }

  enterNote(note, octave) {
    const cell = this.cellHere();
    cell[0] = note;
    if (note === NOTE.HALT || note === NOTE.RELEASE) {
      cell[1] = 0;
    } else {
      cell[1] = octave;
      // the noise channel plays 16 periods (CFamiTrackerView::InsertNote())
      if (this.song.channels[this.cursor.channel].id === CHANNEL_ID.NOISE) {
        const midi = ((octave * 12 + note - 1) % 16) + 16;
        cell[1] = Math.floor(midi / 12);
        cell[0] = midi % 12 + 1;
      }
      if (cell[3] !== HOLD_INSTRUMENT)
        cell[3] = this.instrument;
    }
    this.changeHere(cell);
    this.stepDown();
  }

  enterHex(value) {
    const { column } = this.cursor;
    const cell = this.cellHere();
    const kind = columnKind(column);
    if (kind === 'instrument') {
      const base = cell[3] === NO_INSTRUMENT || cell[3] === HOLD_INSTRUMENT ? 0 : cell[3];
      cell[3] = Math.min(MAX_INSTRUMENTS - 1, column === 1 ? (base & 0x0F) | value << 4 : (base & 0xF0) | value);
      this.selectInstrument(cell[3], { quiet: true });
    } else if (kind === 'volume') {
      cell[2] = value;
    } else if (kind === 'param') {
      const effect = Math.floor((column - 4) / 3);
      if (!cell[4 + effect])
        return false;
      const high = (column - 4) % 3 === 1;
      cell[8 + effect] = high ? (cell[8 + effect] & 0x0F) | value << 4 : (cell[8 + effect] & 0xF0) | value;
    } else {
      return false;
    }
    this.changeHere(cell);
    this.stepDown();
    return true;
  }

  enterEffect(letter) {
    const chip = this.song.channels[this.cursor.channel].chip;
    const { byChip, defaults } = this.song.effects;
    const effect = (byChip[chip] ?? byChip[0])[letter];
    if (!effect)
      return false;
    const index = Math.floor((this.cursor.column - 4) / 3);
    const cell = this.cellHere();
    const previous = cell[4 + index];
    cell[4 + index] = effect;
    if (!previous || defaults[effect])
      cell[8 + index] = defaults[effect];
    this.changeHere(cell);
    this.stepDown();
    return true;
  }

  enterHold() {
    const cell = this.cellHere();
    cell[3] = HOLD_INSTRUMENT;
    this.changeHere(cell);
    this.stepDown();
  }

  // Delete: the field at the cursor (CFamiTrackerDoc::ClearRowField()), or the selection
  clear({ pullUp = false } = {}) {
    if (this.selection) {
      this.clearSelection();
      return;
    }
    const { frame, row, channel, column } = this.cursor;
    const pattern = this.patternOf(frame, channel);
    const field = fieldOfColumn(column);
    if (pullUp) {
      const rows = this.tr.rows;
      const cells = this.song.readCells(this.track, channel, pattern, row, rows - row);
      cells.copyWithin(0, CELL);
      cells.set(EMPTY_CELL, (rows - row - 1) * CELL);
      this.change([{ channel, pattern, row, cells }]);
      return;
    }
    const cell = this.cellHere();
    clearField(cell, field);
    if (field === 0) {
      // clearing a note clears its instrument and volume too
      clearField(cell, 1);
      clearField(cell, 2);
    }
    this.changeHere(cell);
    this.stepDown();
  }

  // Insert: an empty row at the cursor, the rows below move down
  insertRow() {
    const { frame, row } = this.cursor;
    const rows = this.tr.rows;
    const channels = this.selection ? range(this.selection.channelStart, this.selection.channelEnd) : [this.cursor.channel];
    this.change(channels.map(channel => {
      const pattern = this.patternOf(frame, channel);
      const cells = this.song.readCells(this.track, channel, pattern, row, rows - row);
      cells.copyWithin(CELL, 0, (rows - row - 1) * CELL);
      cells.set(EMPTY_CELL, 0);
      return { channel, pattern, row, cells };
    }));
  }

  // Backspace: the row above the cursor goes, the rows below move up
  deleteRowAbove() {
    const { frame, row, channel } = this.cursor;
    if (row === 0)
      return;
    const rows = this.tr.rows;
    const pattern = this.patternOf(frame, channel);
    const cells = this.song.readCells(this.track, channel, pattern, row - 1, rows - row + 1);
    cells.copyWithin(0, CELL);
    cells.set(EMPTY_CELL, (rows - row) * CELL);
    this.change([{ channel, pattern, row: row - 1, cells }], { ...this.cursor, row: row - 1 });
    this.setCursor({ ...this.cursor, row: row - 1 });
  }

  // What each channel of the selection covers: [{channel, first field, last field}]
  selectionFields() {
    const s = this.selection;
    return range(s.channelStart, s.channelEnd).map(channel => ({
      channel,
      first: channel === s.channelStart ? fieldOfColumn(s.columnStart) : 0,
      last: channel === s.channelEnd ? fieldOfColumn(s.columnEnd) : fieldOfColumn(this.columns(channel) - 1),
    }));
  }

  clearSelection() {
    const s = this.selection;
    const count = s.rowEnd - s.rowStart + 1;
    this.change(this.selectionFields().map(({ channel, first, last }) => {
      const pattern = this.patternOf(s.frame, channel);
      const cells = this.song.readCells(this.track, channel, pattern, s.rowStart, count);
      for (let r = 0; r < count; ++r)
        for (let f = first; f <= last; ++f)
          clearField(cells.subarray(r * CELL, r * CELL + CELL), f);
      return { channel, pattern, row: s.rowStart, cells };
    }));
  }

  copy() {
    if (!this.selection)
      return false;
    const s = this.selection;
    const count = s.rowEnd - s.rowStart + 1;
    this.clipboard = {
      rows: count,
      channels: this.selectionFields().map(({ channel, first, last }) => ({
        first, last,
        cells: this.song.readCells(this.track, channel, this.patternOf(s.frame, channel), s.rowStart, count),
      })),
    };
    return true;
  }

  cut() {
    if (this.copy())
      this.clearSelection();
  }

  paste() {
    const clip = this.clipboard;
    if (!clip)
      return;
    const { frame, row } = this.cursor;
    const rows = Math.min(clip.rows, this.tr.rows - row);
    const changes = [];
    clip.channels.forEach((source, i) => {
      const channel = this.cursor.channel + i;
      if (channel >= this.channelCount)
        return;
      const pattern = this.patternOf(frame, channel);
      const cells = this.song.readCells(this.track, channel, pattern, row, rows);
      const lastField = fieldOfColumn(this.columns(channel) - 1);
      for (let r = 0; r < rows; ++r)
        for (let f = source.first; f <= Math.min(source.last, lastField); ++f)
          copyField(source.cells.subarray(r * CELL, r * CELL + CELL), cells.subarray(r * CELL, r * CELL + CELL), f);
      changes.push({ channel, pattern, row, cells });
    });
    this.change(changes);
  }

  selectAll() {
    const { frame, channel } = this.cursor;
    const whole = this.selection && this.selection.rowStart === 0 && this.selection.rowEnd === this.tr.rows - 1 &&
      this.selection.channelStart === channel && this.selection.channelEnd === channel;
    const first = whole ? 0 : channel, last = whole ? this.channelCount - 1 : channel;
    this.anchor = { frame, row: 0, channel: first, column: 0 };
    this.selection = this.makeSelection(this.anchor, { frame, row: this.tr.rows - 1, channel: last, column: this.columns(last) - 1 });
    this.view.invalidate();
  }

  // Ctrl+Up/Down: the notes at the cursor or in the selection, a semitone (or an octave)
  transpose(semitones) {
    const shift = cell => {
      if (cell[0] < NOTE.C || cell[0] > NOTE.B)
        return;
      const midi = Math.max(0, Math.min(OCTAVES * 12 - 1, cell[1] * 12 + cell[0] - 1 + semitones));
      cell[1] = Math.floor(midi / 12);
      cell[0] = midi % 12 + 1;
    };
    if (!this.selection) {
      const cell = this.cellHere();
      shift(cell);
      this.changeHere(cell);
      return;
    }
    const changes = [];
    const s = this.selection;
    const count = s.rowEnd - s.rowStart + 1;
    for (const { channel, first } of this.selectionFields()) {
      if (first > 0)
        continue;
      const pattern = this.patternOf(s.frame, channel);
      const data = this.song.readCells(this.track, channel, pattern, s.rowStart, count);
      for (let r = 0; r < count; ++r)
        shift(data.subarray(r * CELL, r * CELL + CELL));
      changes.push({ channel, pattern, row: s.rowStart, cells: data });
    }
    this.change(changes);
  }

  // ---- frames -------------------------------------------------------------------------

  async reloadTrack(track = this.track) {
    this.song.setTrackData(track, await this.session.call('trackData', track));
  }

  // The frame list as it is, to go back to
  frameState() {
    const tr = this.tr;
    return { frames: tr.frames, list: Uint8Array.from(tr.frameList.subarray(0, tr.frames * this.channelCount)) };
  }

  async restoreFrames(track, state, clear = []) {
    this.session.send('setFrameList', track, state.frames, state.list);
    for (const { channel, pattern } of clear)
      this.session.send('setCells', track, channel, pattern, 0, new Uint8Array(this.song.track(track).rows * CELL).map((_, i) => EMPTY_CELL[i % CELL]));
    await this.reloadTrack(track);
  }

  async frameOp(op) {
    const track = this.track;
    const frame = this.cursor.frame;
    const before = this.frameState();
    const patternsBefore = new Set(this.tr.patterns.keys());
    const call = {
      insert: ['insertFrame', track, frame + 1],
      duplicate: ['duplicateFrame', track, frame],
      clone: ['cloneFrame', track, frame],
      remove: ['removeFrame', track, frame],
      up: ['moveFrame', track, frame, true],
      down: ['moveFrame', track, frame, false],
    }[op];
    if (!await this.session.call(...call))
      return;
    await this.reloadTrack(track);
    const after = this.frameState();
    const created = [...this.tr.patterns.keys()].filter(key => !patternsBefore.has(key))
      .map(key => ({ channel: Math.floor(key / MAX_PATTERNS), pattern: key % MAX_PATTERNS }));
    const target = { insert: frame + 1, duplicate: frame + 1, clone: frame + 1, remove: Math.min(frame, after.frames - 1), up: frame - 1, down: frame + 1 }[op];
    const cursorBefore = { ...this.cursor };
    const cursorAfter = { ...this.cursor, frame: target };
    this.record({
      undo: async () => { this.showTrack(track); await this.restoreFrames(track, before, created); this.afterFrames(cursorBefore); },
      redo: async () => { this.showTrack(track); await this.session.call(...call); await this.reloadTrack(track); this.afterFrames(cursorAfter); },
    });
    this.afterFrames(cursorAfter);
  }

  afterFrames(cursor) {
    this.renderSongPanel();
    this.setCursor(cursor);
    this.renderFrames();
    this.view.invalidate();
  }

  setFramePattern(frame, channel, pattern) {
    pattern = Math.max(0, Math.min(MAX_PATTERNS - 1, pattern));
    const track = this.track;
    const old = this.patternOf(frame, channel);
    if (old === pattern)
      return;
    const set = value => {
      this.song.track(track).frameList[frame * this.channelCount + channel] = value;
      this.session.send('setFramePattern', track, frame, channel, value);
      this.renderFrames();
      this.view.invalidate();
    };
    // the page has every pattern with something in it (Song.setTrackData())
    set(pattern);
    this.record({ undo: () => { this.showTrack(track); set(old); }, redo: () => { this.showTrack(track); set(pattern); } });
  }

  // ---- song settings ------------------------------------------------------------------

  async setSongText(field, value) {
    const method = { title: 'setTitle', artist: 'setArtist', copyright: 'setCopyright' }[field];
    await this.session.call(method, value);
    this.song.info = await this.session.call('info');
    this.renderSongPanel();
    this.edited();
  }

  // speed, tempo, rows, frames, beat, bar: undoable
  async setSetting(name, value) {
    const track = this.track;
    const tr = this.tr;
    const current = { speed: tr.speed, tempo: tr.tempo, rows: tr.rows, frames: tr.frames, beat: tr.highlight[0], bar: tr.highlight[1] };
    if (!Number.isFinite(value) || value === current[name]) {
      this.renderSongPanel();
      return;
    }
    const apply = async v => {
      switch (name) {
        case 'speed': await this.session.call('setSpeed', track, v); break;
        case 'tempo': await this.session.call('setTempo', track, v); break;
        case 'rows': await this.session.call('setPatternLength', track, v); break;
        case 'frames': await this.session.call('setFrameCount', track, v); break;
        case 'beat': await this.session.call('setHighlight', track, v, current.bar); break;
        case 'bar': await this.session.call('setHighlight', track, current.beat, v); break;
      }
      await this.reloadTrack(track);
      this.showTrack(track);
      this.renderSongPanel();
      this.setCursor(this.cursor);
      this.renderFrames();
      this.view.invalidate();
    };
    await apply(value);
    const applied = { speed: this.tr.speed, tempo: this.tr.tempo, rows: this.tr.rows, frames: this.tr.frames, beat: this.tr.highlight[0], bar: this.tr.highlight[1] }[name];
    this.record({ undo: () => apply(current[name]), redo: () => apply(applied) });
  }

  async setEffColumns(channel, count) {
    count = Math.max(1, Math.min(4, count));
    const track = this.track;
    const old = this.tr.effColumns[channel];
    const apply = async value => {
      await this.session.call('setEffColumns', track, channel, value);
      this.song.track(track).effColumns[channel] = value;
      this.showTrack(track);
      this.view.layout();
      this.setCursor(this.cursor);
    };
    await apply(count);
    this.record({ undo: () => apply(old), redo: () => apply(count) });
  }

  async setExpansion() {
    const t = this.strings;
    const chips = [...this.els.chips.querySelectorAll('input:checked')].reduce((mask, box) => mask | Number(box.value), 0);
    const n163 = chips & CHIP.N163 ? Math.max(1, Math.min(8, Number(this.els.n163.value) || 1)) : 0;
    const info = this.song.info;
    const gone = info.chips & ~chips;
    const fewerN163 = (chips & CHIP.N163) && (info.chips & CHIP.N163) && n163 < info.namcoChannels;
    if (gone || fewerN163) {
      const names = CHIPS.filter(([, bit]) => (gone & bit) || (bit === CHIP.N163 && fewerN163)).map(([name]) => name).join(' ');
      if (!confirm(t.confirmChips + names)) {
        this.renderSongPanel();
        return;
      }
    }
    this.stopPlaying();
    await this.session.call('setExpansion', chips, n163);
    await this.reloadSong();
    this.history.clear();
    this.edited();
  }

  async setMachine(pal) {
    this.stopPlaying();
    await this.session.call('setMachine', pal);
    this.song.info = await this.session.call('info');
    this.renderSongPanel();
    this.edited();
  }

  // After what changes the channels: everything again
  async reloadSong() {
    const snapshot = await this.session.call('snapshot');
    const track = Math.min(this.track, snapshot.info.tracks.length - 1);
    const cursor = this.cursor;
    this.song = new Song({ ...snapshot, tracks: [] });
    for (let t = 0; t < snapshot.info.tracks.length; ++t)
      if (t === track)
        this.song.setTrackData(t, await this.session.call('trackData', t));
    this.track = track;
    this.muted = this.song.channels.map(() => false);
    this.session.send('setMutedChannels', 0);
    this.cursor = { ...cursor, channel: Math.min(cursor.channel, this.channelCount - 1) };
    this.renderAll();
    this.setCursor(this.cursor);
  }

  // ---- tracks ---------------------------------------------------------------------------

  // Shows a track whose data is loaded (for undo)
  showTrack(track) {
    if (track === this.track)
      return;
    this.track = track;
    this.renderAll();
  }

  async selectTrack(track) {
    this.stopPlaying();
    if (!this.song.track(track))
      await this.reloadTrack(track);
    this.track = track;
    this.cursor = { frame: 0, row: 0, channel: this.cursor.channel, column: 0 };
    this.selection = this.anchor = null;
    this.renderAll();
  }

  async addTrack() {
    const track = await this.session.call('addTrack');
    this.song.info = await this.session.call('info');
    await this.reloadTrack(track);
    await this.selectTrack(track);
    this.edited();
  }

  async removeTrack() {
    if (this.song.info.tracks.length < 2)
      return;
    this.stopPlaying();
    await this.session.call('removeTrack', this.track);
    this.song.tracks.splice(this.track, 1);
    this.song.info = await this.session.call('info');
    this.history.clear();
    await this.selectTrack(Math.min(this.track, this.song.info.tracks.length - 1));
    this.edited();
  }

  // ---- channels ---------------------------------------------------------------------------

  toggleMute(channel, solo) {
    if (solo) {
      const alone = this.muted.every((m, i) => m === (i !== channel));
      this.muted = this.muted.map((_, i) => alone ? false : i !== channel);
    } else {
      this.muted[channel] = !this.muted[channel];
    }
    this.session.send('setMutedChannels', this.muted.reduce((mask, m, i) => m ? mask + 2 ** i : mask, 0));
    this.view.buildHeader();
    this.view.invalidate();
  }

  // ---- instruments --------------------------------------------------------------------------

  selectInstrument(index, { quiet = false } = {}) {
    this.instrument = index;
    this.renderInstruments();
    if (!quiet)
      this.view.scroller.focus({ preventScroll: true });
  }

  async refreshInstruments() {
    this.song.instruments = await this.session.call('instruments');
    this.renderInstruments();
  }

  // An instrument's sequences changed: that is a change of the module
  changedInstruments() {
    this.dirty = true;
    this.scheduleAutosave();
    this.renderToolbar();
  }

  chipOfCursor() {
    const chip = this.song.channels[this.cursor.channel].chip;
    return chip === CHIP.MMC5 ? CHIP.NONE : chip;
  }

  async addInstrument() {
    const index = await this.session.call('addInstrument', this.chipOfCursor(), '');
    if (index < 0)
      return;
    await this.refreshInstruments();
    this.selectInstrument(index);
    this.changedInstruments();
    this.instrumentEditor.open(index);
  }

  async cloneInstrument() {
    const index = await this.session.call('cloneInstrument', this.instrument).catch(() => -1);
    if (index < 0)
      return;
    await this.refreshInstruments();
    this.selectInstrument(index);
    this.changedInstruments();
  }

  async removeInstrument() {
    if (!this.song.instrument(this.instrument) || !confirm(this.strings.confirmRemoveInstrument))
      return;
    await this.session.call('removeInstrument', this.instrument);
    await this.refreshInstruments();
    this.selectInstrument(this.song.instruments[0]?.index ?? 0);
    this.changedInstruments();
  }

  // ---- actions and keys ---------------------------------------------------------------------

  action(name, event) {
    switch (name) {
      case 'new': return this.newSong();
      case 'open': return this.els.file.click();
      case 'save': return this.saveFile();
      case 'play': return this.togglePlay();
      case 'play-song': return this.startPlaying(PLAY.SONG);
      case 'play-pattern': return this.startPlaying(PLAY.PATTERN);
      case 'play-cursor': return this.startPlaying(PLAY.CURSOR);
      case 'stop': return this.stopPlaying();
      case 'octave-down': return this.setOctave(this.octave - 1);
      case 'octave-up': return this.setOctave(this.octave + 1);
      case 'step-down': return this.setStep(this.step - 1);
      case 'step-up': return this.setStep(this.step + 1);
      case 'edit': return this.setEditMode(!this.editMode);
      case 'follow': this.follow = !this.follow; return this.renderToolbar();
      case 'undo': return this.undo();
      case 'redo': return this.redo();
      case 'add-track': return this.addTrack();
      case 'remove-track': return this.removeTrack();
      case 'insert-frame': return this.frameOp('insert');
      case 'duplicate-frame': return this.frameOp('duplicate');
      case 'clone-frame': return this.frameOp('clone');
      case 'remove-frame': return this.frameOp('remove');
      case 'frame-up': return this.frameOp('up');
      case 'frame-down': return this.frameOp('down');
      case 'pattern-down': return this.setFramePattern(this.cursor.frame, this.cursor.channel, this.patternOf(this.cursor.frame, this.cursor.channel) - 1);
      case 'pattern-up': return this.setFramePattern(this.cursor.frame, this.cursor.channel, this.patternOf(this.cursor.frame, this.cursor.channel) + 1);
      case 'add-instrument': return this.addInstrument();
      case 'clone-instrument': return this.cloneInstrument();
      case 'remove-instrument': return this.removeInstrument();
      case 'edit-instrument': return this.song.instrument(this.instrument) && this.instrumentEditor.open(this.instrument);
      case 'note-cut': return this.editMode && this.enterNote(NOTE.HALT, 0);
      case 'note-release': return this.editMode && this.enterNote(NOTE.RELEASE, 0);
      case 'clear': return this.editMode && this.clear();
      case 'insert-row': return this.editMode && this.insertRow();
      case 'delete-row': return this.editMode && this.deleteRowAbove();
    }
  }

  setOctave(octave) {
    this.octave = Math.max(0, Math.min(OCTAVES - 1, octave));
    this.buildPiano();
    this.renderToolbar();
  }

  setStep(step) {
    this.step = Math.max(0, Math.min(MAX_ROWS - 1, step));
    this.renderToolbar();
  }

  setEditMode(on) {
    this.editMode = on;
    this.renderToolbar();
    this.view.invalidate();
    this.updateStatus();
  }

  onKeyDown(e) {
    if (!this.song)
      return;
    const typing = e.target.matches('input, select, textarea') || e.target.closest('dialog');
    const ctrl = e.ctrlKey || e.metaKey;
    // what works anywhere in the editor
    const global = {
      F5: () => this.startPlaying(PLAY.SONG),
      F6: () => this.startPlaying(PLAY.PATTERN),
      F7: () => this.startPlaying(PLAY.CURSOR),
      F8: () => this.stopPlaying(),
    }[e.code];
    if (global && !e.altKey) {
      e.preventDefault();
      global();
      return;
    }
    if (ctrl && e.code === 'KeyS') {
      e.preventDefault();
      this.saveFile();
      return;
    }
    if (typing)
      return;
    if (e.target === this.view.scroller || e.target === this.root)
      this.onPatternKey(e);
  }

  onKeyUp(e) {
    const channel = this.held.get(e.code);
    if (channel !== undefined) {
      this.held.delete(e.code);
      this.noteOff(channel);
    }
  }

  onPatternKey(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    const { column } = this.cursor;

    if (ctrl) {
      const command = {
        KeyZ: () => shift ? this.redo() : this.undo(),
        KeyY: () => this.redo(),
        KeyC: () => this.copy(),
        KeyX: () => this.editMode && this.cut(),
        KeyV: () => this.editMode && this.paste(),
        KeyA: () => this.selectAll(),
        ArrowLeft: () => this.setCursor({ ...this.cursor, frame: this.cursor.frame - 1 }),
        ArrowRight: () => this.setCursor({ ...this.cursor, frame: this.cursor.frame + 1 }),
        ArrowUp: () => this.editMode && this.transpose(shift ? 12 : 1),
        ArrowDown: () => this.editMode && this.transpose(shift ? -12 : -1),
      }[e.code];
      if (command) {
        done();
        command();
      }
      return;
    }

    switch (e.code) {
      case 'ArrowUp': done(); return this.moveRows(-1, shift);
      case 'ArrowDown': done(); return this.moveRows(1, shift);
      case 'ArrowLeft': done(); return this.moveColumn(-1, shift);
      case 'ArrowRight': done(); return this.moveColumn(1, shift);
      case 'PageUp': done(); return this.moveRows(-PAGE_ROWS, shift);
      case 'PageDown': done(); return this.moveRows(PAGE_ROWS, shift);
      case 'Home': done(); return this.setCursor({ ...this.cursor, row: 0 }, { extend: shift });
      case 'End': done(); return this.setCursor({ ...this.cursor, row: this.tr.rows - 1 }, { extend: shift });
      case 'Tab': done(); return this.moveChannel(shift ? -1 : 1);
      case 'Space': done(); return this.setEditMode(!this.editMode);
      case 'Enter': case 'NumpadEnter': done(); return this.togglePlay();
      case 'Escape': done(); this.selection = this.anchor = null; return this.view.invalidate();
      case 'NumpadDivide': done(); return this.setOctave(this.octave - 1);
      case 'NumpadMultiply': done(); return this.setOctave(this.octave + 1);
    }
    if (!this.editMode && !(column === 0 && NOTE_KEYS[e.code]))
      return;
    switch (e.code) {
      case 'Delete': done(); return this.clear({ pullUp: shift });
      case 'Insert': done(); return this.insertRow();
      case 'Backspace': done(); return this.deleteRowAbove();
    }

    if (column === 0) {
      if (e.code === 'Digit1') {
        done();
        if (this.editMode) this.enterNote(NOTE.HALT, 0);
        return;
      }
      if (e.code === 'Backslash' || e.code === 'IntlYen' || e.code === 'IntlRo') {
        done();
        if (this.editMode) this.enterNote(NOTE.RELEASE, 0);
        return;
      }
      const key = NOTE_KEYS[e.code];
      if (!key || e.altKey)
        return;
      done();
      const note = NOTE.C + key[0];
      const octave = Math.min(OCTAVES - 1, this.octave + key[1]);
      if (!e.repeat && this.previews()) {
        const channel = this.cursor.channel;
        this.noteOn(channel, note, octave);
        this.held.set(e.code, channel);
      }
      if (this.editMode)
        this.enterNote(note, octave);
      return;
    }

    const kind = columnKind(column);
    if (kind === 'effect') {
      const letter = /^Key[A-Z]$/.test(e.code) ? e.code.at(-1) : /^(Digit|Numpad)[0-9]$/.test(e.code) ? e.code.at(-1) : e.key?.length === 1 ? e.key.toUpperCase() : '';
      if (letter && this.enterEffect(letter))
        done();
      return;
    }
    if (kind === 'instrument' && e.code === 'KeyH') {
      done();
      return this.enterHold();
    }
    const value = hexOfKey(e);
    if (value >= 0 && this.enterHex(value))
      done();
  }

  onFrameKey(e) {
    const { frame, channel } = this.cursor;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    const move = (df, dc) => {
      this.frameDigits = '';
      this.setCursor({ ...this.cursor, frame: frame + df, channel: Math.max(0, Math.min(this.channelCount - 1, channel + dc)), column: 0 });
    };
    switch (e.code) {
      case 'ArrowUp': done(); return move(-1, 0);
      case 'ArrowDown': done(); return move(1, 0);
      case 'ArrowLeft': done(); return move(0, -1);
      case 'ArrowRight': done(); return move(0, 1);
      case 'Insert': done(); return this.frameOp('insert');
      case 'Delete': done(); return this.frameOp('remove');
      case 'NumpadAdd': done(); return this.setFramePattern(frame, channel, this.patternOf(frame, channel) + 1);
      case 'NumpadSubtract': case 'Minus': done(); return this.setFramePattern(frame, channel, this.patternOf(frame, channel) - 1);
      case 'Equal': if (e.shiftKey) { done(); return this.setFramePattern(frame, channel, this.patternOf(frame, channel) + 1); } break;
      case 'Enter': done(); return this.view.scroller.focus();
    }
    const value = hexOfKey(e);
    if (value >= 0 && !e.ctrlKey && !e.metaKey) {
      done();
      this.frameDigits = (this.frameDigits + value.toString(16)).slice(-2);
      this.setFramePattern(frame, channel, parseInt(this.frameDigits, 16));
      if (this.frameDigits.length === 2)
        this.frameDigits = '';
    }
  }

  // ---- the pattern with the mouse ------------------------------------------------------------

  onGridPointerDown(e) {
    if (e.target !== this.view.canvas || e.button !== 0)
      return;
    const place = this.view.hit(e.clientX, e.clientY);
    this.view.scroller.focus({ preventScroll: true });
    if (!place)
      return;
    const target = {
      frame: place.frame, row: place.row,
      channel: place.channel ?? this.cursor.channel,
      column: place.column ?? this.cursor.column,
    };
    this.setCursor(target, { extend: e.shiftKey });
    this.dragging = true;
    this.view.scroller.setPointerCapture(e.pointerId);
  }

  onGridPointerMove(e) {
    if (!this.dragging)
      return;
    const place = this.view.hit(e.clientX, e.clientY);
    if (!place || place.channel === null)
      return;
    if (place.frame === this.cursor.frame && place.row === this.cursor.row && place.channel === this.cursor.channel && place.column === this.cursor.column)
      return;
    this.anchor ??= { ...this.cursor };
    this.setCursor({ frame: this.anchor.frame, row: place.frame === this.anchor.frame ? place.row : this.cursor.row, channel: place.channel, column: place.column }, { extend: true });
  }

  onGridWheel(e) {
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))
      return;
    e.preventDefault();
    this.wheel = (this.wheel ?? 0) + (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY);
    const rows = Math.trunc(this.wheel / 32);
    if (rows) {
      this.wheel -= rows * 32;
      this.moveRows(rows);
    }
  }

  // ---- showing the state ------------------------------------------------------------------

  renderToolbar() {
    const { els, root } = this;
    els.octave.textContent = this.octave;
    els.step.textContent = this.step;
    els.dirty.hidden = !this.dirty;
    const pressed = (action, on) => {
      const button = root.querySelector(`[data-action="${action}"]`);
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    };
    pressed('edit', this.editMode);
    pressed('follow', this.follow);
    pressed('play', this.playing);
    root.classList.toggle('is-editing', this.editMode);
    root.classList.toggle('is-playing', this.playing);
    root.querySelector('[data-action="undo"]').disabled = !this.history.done.length;
    root.querySelector('[data-action="redo"]').disabled = !this.history.undone.length;
  }

  renderSongPanel() {
    const { song, root, els } = this;
    const info = song.info;
    const tr = this.tr;
    for (const input of root.querySelectorAll('[data-song]'))
      if (document.activeElement !== input)
        input.value = info[input.dataset.song];
    const values = { speed: tr.speed, tempo: tr.tempo, rows: tr.rows, frames: tr.frames, beat: tr.highlight[0], bar: tr.highlight[1] };
    for (const input of root.querySelectorAll('[data-setting]'))
      input.value = values[input.dataset.setting];
    root.querySelector('[data-setting="speed"]').max = tr.groove ? 31 : tr.tempo ? info.speedSplitPoint - 1 : 255;
    root.querySelector('[data-setting="tempo"]').min = info.speedSplitPoint;
    els.track.replaceChildren(...info.tracks.map((title, i) => new Option(`${hex2(i + 1)} ${title}`, i)));
    els.track.value = this.track;
    root.querySelector('[data-action="remove-track"]').disabled = info.tracks.length < 2;
    for (const box of els.chips.querySelectorAll('input'))
      box.checked = (info.chips & Number(box.value)) !== 0;
    els.n163.value = info.namcoChannels || 1;
    els.n163.disabled = !(info.chips & CHIP.N163);
    els.machine.value = info.pal ? '1' : '0';
    els.machine.disabled = info.chips !== 0;
  }

  renderFrames() {
    const { els } = this;
    const tr = this.tr;
    const channels = this.channelCount;
    const { frame: current, channel: currentChannel } = this.cursor;
    const rows = [];
    for (let f = 0; f < tr.frames; ++f) {
      const row = document.createElement('div');
      row.className = 'dnft-frame-row';
      row.classList.toggle('is-current', f === current);
      row.classList.toggle('is-playing', !!this.play && this.play.frame === f);
      const number = document.createElement('span');
      number.className = 'dnft-frame-number';
      number.dataset.frame = f;
      number.textContent = hex2(f);
      row.append(number);
      for (let c = 0; c < channels; ++c) {
        const cell = document.createElement('span');
        cell.className = 'dnft-frame-pattern';
        cell.classList.toggle('is-channel', f === current && c === currentChannel);
        cell.dataset.frame = f;
        cell.dataset.channel = c;
        cell.textContent = hex2(tr.frameList[f * channels + c]);
        row.append(cell);
      }
      rows.push(row);
    }
    els.frames.replaceChildren(...rows);
    // keep the current frame in view, without scrolling the page
    const row = rows[current];
    if (row) {
      const top = row.offsetTop - els.frames.offsetTop, bottom = top + row.offsetHeight;
      if (top < els.frames.scrollTop)
        els.frames.scrollTop = top;
      else if (bottom > els.frames.scrollTop + els.frames.clientHeight)
        els.frames.scrollTop = bottom - els.frames.clientHeight;
    }
    const tools = this.root.querySelector('.dnft-frames-panel');
    tools.querySelector('[data-action="remove-frame"]').disabled = tr.frames < 2;
    tools.querySelector('[data-action="frame-up"]').disabled = current === 0;
    tools.querySelector('[data-action="frame-down"]').disabled = current >= tr.frames - 1;
    for (const action of ['insert-frame', 'duplicate-frame', 'clone-frame'])
      tools.querySelector(`[data-action="${action}"]`).disabled = tr.frames >= MAX_FRAMES;
  }

  renderInstruments() {
    const { els, song } = this;
    const t = this.strings;
    const label = i => `${hex2(i.index)} ${i.name || t.noInstrument}`;
    els.instruments.replaceChildren(...song.instruments.map(i => {
      const item = document.createElement('li');
      item.className = 'dnft-instrument';
      item.classList.toggle('is-current', i.index === this.instrument);
      item.dataset.instrument = i.index;
      item.role = 'option';
      item.setAttribute('aria-selected', String(i.index === this.instrument));
      item.textContent = label(i);
      return item;
    }));
    const options = song.instruments.map(i => new Option(label(i), i.index));
    if (!song.instrument(this.instrument))
      options.unshift(new Option(`${hex2(this.instrument)} —`, this.instrument));
    els.instrument.replaceChildren(...options);
    els.instrument.value = this.instrument;
    const panel = this.root.querySelector('.dnft-instruments-panel');
    const exists = !!song.instrument(this.instrument);
    panel.querySelector('[data-action="remove-instrument"]').disabled = !exists;
    panel.querySelector('[data-action="clone-instrument"]').disabled = !exists || song.instruments.length >= MAX_INSTRUMENTS;
    panel.querySelector('[data-action="edit-instrument"]').disabled = !exists;
    panel.querySelector('[data-action="add-instrument"]').disabled = song.instruments.length >= MAX_INSTRUMENTS;
  }

  updateStatus() {
    if (!this.song)
      return;
    const t = this.strings;
    const tr = this.tr;
    const { frame, row, channel } = this.cursor;
    const parts = [
      `${t.statusFrame} ${hex2(frame)}/${hex2(tr.frames - 1)}`,
      `${t.statusRow} ${hex2(row)}`,
      this.song.channels[channel].name,
    ];
    if (this.playing && this.play)
      parts.push(`${t.playing} ${hex2(this.play.frame)}:${hex2(this.play.row)}`);
    else if (this.editMode)
      parts.push(t.editing);
    this.els.position.textContent = parts.join('  ·  ');
  }

  message(text, error = false) {
    const el = this.els.message;
    el.textContent = text;
    el.classList.toggle('is-error', error);
    clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => { el.textContent = ''; }, error ? 10000 : 5000);
  }
}

function range(first, last) {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

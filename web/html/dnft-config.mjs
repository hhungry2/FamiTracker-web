// Dn-FamiTracker web port - the editor's Configuration (File > Configuration on the desktop),
// kept in the browser: General (how the cursor moves and how rows and notes are named),
// Appearance (the pattern's colours and font), Keys (the shortcuts, dnft-keymap.mjs), Sound
// (the bass and treble filters, the volume, the FDS, N163 and VRC7 emulation) and Mixer (the
// level of each sound device). The sound settings are the engine's; the rest the page's.
//
//   const config = new Config(editor);   // adds the Settings button after the Recent menu
//   config.get('wrapFrames');            // what the editor asks for

import { Keymap, COMMANDS, GROUPS, comboOf, formatCombo } from './dnft-keymap.mjs';
import { setDisplayFlats } from './dnft-pattern-view.mjs';

const STORAGE_KEY = 'dnft-editor.config';

// A copy of the values that its changes do not reach
const copyValues = values => ({ ...values, colors: { ...values.colors }, noteKeys: structuredClone(values.noteKeys) });

export const DEFAULTS = {
  rowHex: true,           // row numbers in hexadecimal, or decimal
  flats: false,           // Db, Eb... for C#, D#...
  wrapCursor: true,       // the cursor goes round the channels (and the rows of a frame)
  wrapFrames: true,       // the rows go on across the frames
  pageStep: 16,           // PageUp and PageDown
  noStepMove: false,      // Up and Down by a row, not the edit step
  wrapPatternValue: false, // Shift+F1-F4 take a value round the ends of its range
  keyRepeat: true,        // a note, digit or letter key held down goes on entering what it enters
  // how entering works (EDIT_STYLES): 'ft2', 'mpt' (ModPlug), 'it' or 'ft2jp' (FT2 on a JP106 keyboard, which
  // the key places already are)
  editStyle: 'ft2',
  // the keys that do more than type, by the places of the keys (CSettings Keys: Note cut, Note release,
  // Clear field, Repeat, Echo buffer)
  // MIDI (CSettings Midi): the input to use ('' for all), whether MIDI channel n plays the module's channel n,
  // whether a key's velocity is the volume entered
  midiInput: '',
  midiChannelMap: false,
  midiArpeggio: false,     // Auto arpeggiate chords: the notes held by hand take turns, a tick each
  midiVelocity: false,
  noteKeys: { cut: ['Digit1'], release: ['Backslash', 'IntlYen', 'IntlRo'], clear: ['Minus'], repeat: [], echo: [] },
  fontFamily: '',         // the pattern's font ('' is the editor's own)
  fontSize: 13,           // pixels
  rowHeight: 145,         // a row's height, as a percentage of the font size
  colors: {},             // the pattern's colours that are not the editor's: {property: '#rrggbb'}
};

// The colours of the pattern, with the custom property each is (dnft-editor.css); `alpha`: one
// that is drawn over others, with the opacity it keeps
export const COLORS = [
  ['background', '--dnft-pe-bg'], ['text', '--dnft-pe-note'], ['instrument', '--dnft-pe-instrument'],
  ['volume', '--dnft-pe-volume'], ['effect', '--dnft-pe-effect'], ['dim', '--dnft-pe-dim'],
  ['highlight', '--dnft-pe-beat'], ['highlight2', '--dnft-pe-bar'], ['rowNumber', '--dnft-pe-row-number'],
  ['cursor', '--dnft-pe-cursor'], ['cursorRow', '--dnft-pe-cursor-row'], ['editRow', '--dnft-pe-edit-row'],
  ['playRow', '--dnft-pe-play-row', 0.3], ['selection', '--dnft-pe-selection', 0.3], ['bookmark', '--dnft-pe-bookmark'],
  ['separator', '--dnft-pe-separator'], ['header', '--dnft-pe-header'], ['headerText', '--dnft-pe-header-text'],
];

// The desktop's theme file (CConfigAppearance::ExportSettings(), ImportSettings()): lines of "name : value",
// the colours as 0xBBGGRR. The editor has no colour of its own for the highlighted text and the channel
// header's corner: it writes the text's and the header's, and does not read them.
const THEME_COLORS = [
  ['Background', '--dnft-pe-bg'], ['Highlighted background', '--dnft-pe-beat'], ['Highlighted background 2', '--dnft-pe-bar'],
  ['Pattern text', '--dnft-pe-note'], ['Highlighted pattern text', '--dnft-pe-note', false], ['Highlighted pattern text 2', '--dnft-pe-note', false],
  ['Instrument column', '--dnft-pe-instrument'], ['Volume column', '--dnft-pe-volume'], ['Effect number column', '--dnft-pe-effect'],
  ['Selection', '--dnft-pe-selection'], ['Cursor', '--dnft-pe-cursor'], ['Current row (normal mode)', '--dnft-pe-cursor-row'],
  ['Current row (edit mode)', '--dnft-pe-edit-row'], ['Current row (playing)', '--dnft-pe-play-row'],
  ['Channel header background', '--dnft-pe-header'], ['Channel header corner', '--dnft-pe-header', false], ['Channel header text', '--dnft-pe-header-text'],
];
const SETTING_SEPARATOR = ' : ';

const bgr = hex => {
  const value = parseInt(hex.slice(1), 16);
  return `0x${(((value & 0xFF) << 16) | (value & 0xFF00) | (value >> 16)).toString(16).toUpperCase().padStart(6, '0')}`;
};
const rgb = bgrText => {
  const value = parseInt(bgrText, 16);
  return '#' + (((value & 0xFF) << 16) | (value & 0xFF00) | ((value >> 16) & 0xFF)).toString(16).padStart(6, '0');
};

// The text of a theme: `colors` by custom property ('#rrggbb'), and the look (flats, font, size, row height)
export function exportTheme(colors, { flats = false, fontFamily = '', fontSize = 13, rowHeight = 145 } = {}) {
  return [
    '# FamiTracker appearance',
    ...THEME_COLORS.map(([name, property]) => `${name}${SETTING_SEPARATOR}${bgr(colors[property] ?? '#000000')}`),
    `Pattern colors${SETTING_SEPARATOR}1`,
    `Flags${SETTING_SEPARATOR}${flats ? 1 : 0}`,
    `Font${SETTING_SEPARATOR}${fontFamily || 'Courier New'}`,
    `Font size${SETTING_SEPARATOR}${fontSize}`,
    `Font percent${SETTING_SEPARATOR}${rowHeight}`,
    `Channel header font${SETTING_SEPARATOR}${fontFamily || 'Tahoma'}`,
    `Channel header font size${SETTING_SEPARATOR}${Math.max(8, fontSize - 1)}`,
    '',
  ].join('\n');
}

// What a theme file sets: {colors: {property: '#rrggbb'}, flats, fontFamily, fontSize, rowHeight}, with what it does
// not have left out; null when no line of it is a setting
export function importTheme(text) {
  const result = { colors: {} };
  let any = false;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^#].*?)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match)
      continue;
    const [, key, value] = match;
    const number = /^\d+$/.test(value) ? Number(value) : null;
    const color = THEME_COLORS.find(([name, , read]) => name.toLowerCase() === key.toLowerCase() && read !== false);
    if (color) {
      const hex = /^0x([0-9a-f]{1,6})$/i.exec(value);
      if (hex) {
        result.colors[color[1]] = rgb(hex[1]);
        any = true;
      }
    } else if (/^flags$/i.test(key) && number !== null) {
      result.flats = number !== 0;
      any = true;
    } else if (/^font$/i.test(key)) {
      result.fontFamily = value;
      any = true;
    } else if (/^font size$/i.test(key) && number) {
      result.fontSize = Math.max(8, Math.min(32, number));
      any = true;
    } else if (/^font percent$/i.test(key) && number) {
      result.rowHeight = Math.max(100, Math.min(250, number));
      any = true;
    }
  }
  return any ? result : null;
}

const PRESETS = {
  light: {
    '--dnft-pe-bg': '#ffffff', '--dnft-pe-note': '#1b1f2a', '--dnft-pe-instrument': '#0b7a45', '--dnft-pe-volume': '#1f5fb8',
    '--dnft-pe-effect': '#b3550f', '--dnft-pe-dim': '#b8bdc9', '--dnft-pe-beat': '#f1f4fa', '--dnft-pe-bar': '#e2e8f4',
    '--dnft-pe-row-number': '#6b7280', '--dnft-pe-cursor': '#2d3b66', '--dnft-pe-cursor-row': '#dfe6f5', '--dnft-pe-edit-row': '#f6d4da',
    '--dnft-pe-play-row': '#468cff', '--dnft-pe-selection': '#4678e6', '--dnft-pe-bookmark': '#f2c879',
    '--dnft-pe-separator': '#d5d9e2', '--dnft-pe-header': '#eef1f7', '--dnft-pe-header-text': '#28303f',
  },
  contrast: {
    '--dnft-pe-bg': '#000000', '--dnft-pe-note': '#ffffff', '--dnft-pe-instrument': '#00ff90', '--dnft-pe-volume': '#5cc8ff',
    '--dnft-pe-effect': '#ffb000', '--dnft-pe-dim': '#555555', '--dnft-pe-beat': '#101010', '--dnft-pe-bar': '#1e1e1e',
    '--dnft-pe-row-number': '#bbbbbb', '--dnft-pe-cursor': '#ffffff', '--dnft-pe-cursor-row': '#20344f', '--dnft-pe-edit-row': '#4f1f2c',
    '--dnft-pe-play-row': '#00c8ff', '--dnft-pe-selection': '#00a0ff', '--dnft-pe-bookmark': '#805500',
    '--dnft-pe-separator': '#444444', '--dnft-pe-header': '#111111', '--dnft-pe-header-text': '#ffffff',
  },
};

// The sound settings the dialog sets, by the engine's names (session.soundSettings()), with
// the slider's range (the desktop's Sound, Emulation and Mixer pages)
const SOUND = [
  ['bassFilter', 16, 4000], ['trebleFilter', 20, 20000], ['trebleDamping', 0, 90], ['volume', 0, 100],
  ['fdsLowpass', 0, 8000], ['n163Lowpass', 0, 12000],
];
const DEVICES = ['APU1', 'APU2', 'VRC6', 'VRC7', 'FDS', 'MMC5', 'N163', '5B'];
const MAX_LEVEL = 120;
const VRC7_PATCHES = 9;
// Keys a page cannot get
const RESERVED = new Set(['C+KeyW', 'CS+KeyW', 'C+KeyT', 'CS+KeyT', 'C+KeyN', 'CS+KeyN', 'C+Tab', 'CS+Tab', 'A+F4', 'C+F4', 'C+KeyQ', 'CS+KeyQ']);

const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 'rgb(1, 2, 3)' or '#abc' as '#010203'
function toHex(color) {
  const probe = document.createElement('span');
  probe.style.color = color;
  document.body.append(probe);
  const [r, g, b] = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
  probe.remove();
  return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${n >> 8 & 255}, ${n & 255}, ${alpha})`;
}

export class Config {
  constructor(editor) {
    this.editor = editor;
    this.values = copyValues({ ...DEFAULTS, ...this.read() });
    // what is kept may lack a role, or hold something else
    for (const role of Object.keys(DEFAULTS.noteKeys))
      if (!Array.isArray(this.values.noteKeys[role]))
        this.values.noteKeys[role] = [...DEFAULTS.noteKeys[role]];
    this.sound = this.values.sound ?? null;   // what was set, to put back in the engine
    // what the setting was called until the dialog said "emulate" for it: it is CSettings'
    // bNamcoMixing, which disables the multiplexing when it is on
    if (this.sound && 'n163Multiplexing' in this.sound) {
      this.sound.disableN163Multiplexing = this.sound.n163Multiplexing;
      delete this.sound.n163Multiplexing;
    }
    this.build();
    this.applyLook();
  }

  get strings() {
    return this.editor.strings;
  }

  get(name) {
    return this.values[name];
  }

  // ---- what is kept ------------------------------------------------------------------------

  read() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.values, sound: this.sound }));
    } catch {
      // blocked: it lasts as long as the page
    }
  }

  // Sound settings changed from outside the dialog (Ctrl+Shift+M): in the engine, and kept
  async setSound(values) {
    await this.editor.session.call('setSoundSettings', values);
    this.sound = { ...(this.sound ?? {}), ...values };
    this.save();
  }

  // The sound settings go to the engine once, with the first module (it keeps them for the
  // rest)
  async applySound() {
    if (this.sound && Object.keys(this.sound).length)
      await this.editor.session.call('setSoundSettings', this.sound);
    this.editor.session.send('setAutoArpeggio', !!this.get('midiArpeggio'));
  }

  // ---- what the settings do to the page ---------------------------------------------------------

  // The pattern's look: colours, font, row height; and the names of rows and notes
  applyLook() {
    const { root } = this.editor;
    const v = this.values;
    for (const [, property] of COLORS)
      root.style.removeProperty(property);
    for (const [key, property, alpha] of COLORS)
      if (v.colors[property])
        root.style.setProperty(property, alpha ? rgba(v.colors[property], alpha) : v.colors[property]);
    root.style.setProperty('--dnft-pe-size', `${v.fontSize}px`);
    root.style.setProperty('--dnft-pe-row', String(v.rowHeight / 100));
    if (v.fontFamily)
      root.style.setProperty('--dnft-mono', `${v.fontFamily}, ui-monospace, Consolas, monospace`);
    else
      root.style.removeProperty('--dnft-mono');
    setDisplayFlats(v.flats);
    this.editor.view?.refreshStyle();
    if (this.editor.song) {
      this.editor.renderFrames();
      this.editor.view.invalidate();
    }
  }

  // ---- the dialog ----------------------------------------------------------------------------

  build() {
    const t = this.strings;
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'dnft-button', textContent: t.configuration, title: t.configurationHint });
    this.editor.recent.wrap.after(button);
    button.addEventListener('click', () => this.open());
    this.button = button;
    const d = this.dialog = this.editor.files.dialog('dnft-config-dialog', `
      <div class="dnft-tabs" role="tablist" data-role="tabs"></div>
      <div data-role="panels"></div>`, `
      <button type="button" class="dnft-button" data-role="defaults" data-t="configDefaults"></button>
      <span class="dnft-spacer"></span>
      <button type="button" class="dnft-button dnft-button--primary" data-role="ok" data-t="ok"></button>
      <button type="button" class="dnft-button" data-role="cancel" data-t="cancel"></button>`);
    d.classList.remove('dnft-dialog--narrow');
    d.classList.add('dnft-dialog--wide');
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    this.tabs = [
      ['general', t.configGeneral, () => this.buildGeneral()],
      ['appearance', t.configAppearance, () => this.buildAppearance()],
      ['keys', t.configKeys, () => this.buildKeys()],
      ['midi', t.configMidi, () => this.buildMidi()],
      ['sound', t.configSound, () => this.buildSound()],
      ['mixer', t.configMixer, () => this.buildMixer()],
    ];
    for (const [name, label, make] of this.tabs) {
      const tab = Object.assign(document.createElement('button'), { type: 'button', className: 'dnft-tab', textContent: label });
      tab.setAttribute('role', 'tab');
      tab.dataset.tab = name;
      tab.addEventListener('click', () => this.showTab(name));
      $('tabs').append(tab);
      const panel = document.createElement('section');
      panel.className = 'dnft-tab-panel';
      panel.dataset.panel = name;
      panel.hidden = true;
      $('panels').append(panel);
      make.panel = panel;
    }
    $('ok').addEventListener('click', () => this.commit());
    $('cancel').addEventListener('click', () => {
      this.abandon();
      d.close();
    });
    $('defaults').addEventListener('click', () => this.resetTab());
    // Escape: the same
    d.addEventListener('cancel', () => this.abandon());
    d.addEventListener('close', () => {
      this.abandon();
      this.editor.view.scroller.focus({ preventScroll: true });
    });
  }

  // A look that was tried and not kept goes back
  abandon() {
    if (this.committed)
      return;
    this.committed = true;
    this.values = this.original;
    this.applyLook();
  }

  async open() {
    const d = this.dialog;
    d.querySelector('.dnft-dialog-title').textContent = this.strings.configTitle;
    // each tab starts from what is in force now
    this.committed = false;
    this.original = copyValues(this.values);
    this.draft = copyValues(this.values);
    this.draftKeys = new Keymap(false);
    this.draftKeys.overrides = structuredClone(this.editor.keymap.overrides);
    this.draftKeys.rebuild();
    this.soundDraft = null;
    this.engine = this.editor.session ? await this.editor.session.call('soundSettings') : null;
    for (const [, , make] of this.tabs)
      make();
    this.showTab(this.tab ?? 'general');
    d.showModal();
  }

  showTab(name) {
    this.tab = name;
    for (const tab of this.dialog.querySelectorAll('.dnft-tab'))
      tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const panel of this.dialog.querySelectorAll('.dnft-tab-panel'))
      panel.hidden = panel.dataset.panel !== name;
  }

  panel(name) {
    return this.dialog.querySelector(`[data-panel="${name}"]`);
  }

  // ---- General ----------------------------------------------------------------------------------

  buildGeneral() {
    const t = this.strings;
    const panel = this.panel('general');
    const check = (name, label, hint) => `<label class="dnft-check" title="${escape(hint)}"><input type="checkbox" data-general="${name}"> <span>${escape(label)}</span></label>`;
    panel.innerHTML = `
      <div class="dnft-config-list">
        ${check('rowHex', t.configRowHex, t.configRowHexHint)}
        ${check('flats', t.configFlats, t.configFlatsHint)}
        ${check('wrapCursor', t.configWrapCursor, t.configWrapCursorHint)}
        ${check('wrapFrames', t.configWrapFrames, t.configWrapFramesHint)}
        ${check('noStepMove', t.configNoStepMove, t.configNoStepMoveHint)}
        ${check('wrapPatternValue', t.configWrapValues, t.configWrapValuesHint)}
        ${check('keyRepeat', t.configKeyRepeat, t.configKeyRepeatHint)}
        <label class="dnft-field dnft-field--inline"><span>${escape(t.configPageStep)}</span><input type="number" min="1" max="256" step="1" data-general="pageStep"></label>
        <label class="dnft-field dnft-field--inline" title="${escape(t.configEditStyleHint)}"><span>${escape(t.configEditStyle)}</span>
          <select data-general="editStyle">${['ft2', 'mpt', 'it', 'ft2jp'].map(style => `<option value="${style}">${escape(t.configEditStyles[style])}</option>`).join('')}</select></label>
      </div>
      <fieldset class="dnft-fieldset dnft-note-keys">
        <legend>${escape(t.configNoteKeys)}</legend>
        ${Object.keys(DEFAULTS.noteKeys).map(role => `
          <div class="dnft-field dnft-field--inline" data-notekey="${role}" title="${escape(t.configNoteKeyHints[role])}">
            <span>${escape(t.configNoteKeyNames[role])}</span>
            <span class="dnft-key-chips"></span>
            <button type="button" class="dnft-button" data-add>${escape(t.configKeyAdd)}</button>
            <button type="button" class="dnft-button" data-reset>${escape(t.configKeyReset)}</button>
          </div>`).join('')}
        <p class="dnft-hint" data-role="notekey-message">${escape(t.configNoteKeysNote)}</p>
      </fieldset>`;
    this.wireNoteKeys(panel);
    for (const input of panel.querySelectorAll('[data-general]')) {
      const name = input.dataset.general;
      if (input.type === 'checkbox')
        input.checked = this.draft[name];
      else
        input.value = this.draft[name];
      input.addEventListener('input', () => {
        if (input.tagName === 'SELECT')
          this.draft[name] = input.value;
        else
          this.draft[name] = input.type === 'checkbox' ? input.checked : Math.max(1, Math.min(256, Math.round(Number(input.value)) || 1));
      });
    }
  }

  // The five keys that do more than type: each shown as the keys it has, with a button that takes the
  // next key press (by its place; no modifiers) and one that gives the defaults back
  wireNoteKeys(panel) {
    const t = this.strings;
    const message = text => { panel.querySelector('[data-role="notekey-message"]').textContent = text; };
    const show = row => {
      const role = row.dataset.notekey;
      row.querySelector('.dnft-key-chips').innerHTML = this.draft.noteKeys[role]
        .map(code => `<span class="dnft-key-chip"><kbd>${escape(formatCombo(code))}</kbd><button type="button" data-remove="${escape(code)}" title="${escape(t.configKeyRemove)}">×</button></span>`).join('');
      row.querySelector('[data-reset]').disabled = JSON.stringify(this.draft.noteKeys[role]) === JSON.stringify(DEFAULTS.noteKeys[role]);
    };
    for (const row of panel.querySelectorAll('[data-notekey]')) {
      const role = row.dataset.notekey;
      show(row);
      row.querySelector('.dnft-key-chips').addEventListener('click', e => {
        const remove = e.target.closest('[data-remove]');
        if (!remove)
          return;
        this.draft.noteKeys[role] = this.draft.noteKeys[role].filter(code => code !== remove.dataset.remove);
        show(row);
      });
      row.querySelector('[data-reset]').addEventListener('click', () => {
        this.draft.noteKeys[role] = [...DEFAULTS.noteKeys[role]];
        show(row);
        message('');
      });
      row.querySelector('[data-add]').addEventListener('click', () => {
        const d = this.dialog;
        message(t.configKeyPress);
        const finish = () => d.removeEventListener('keydown', onKey, true);
        const onKey = e => {
          if (!comboOf(e))
            return;
          e.preventDefault();
          e.stopPropagation();
          if (e.code === 'Escape') {
            finish();
            message('');
            return;
          }
          if (e.ctrlKey || e.altKey || e.metaKey) {
            message(t.configNoteKeyPlain);
            return;
          }
          finish();
          // a key does one thing: the role that had it loses it
          for (const other of Object.keys(this.draft.noteKeys))
            this.draft.noteKeys[other] = this.draft.noteKeys[other].filter(code => code !== e.code);
          this.draft.noteKeys[role].push(e.code);
          for (const each of panel.querySelectorAll('[data-notekey]'))
            show(each);
          message('');
        };
        d.addEventListener('keydown', onKey, true);
      });
    }
  }

  // ---- MIDI ---------------------------------------------------------------------------------------------

  buildMidi() {
    const t = this.strings;
    const panel = this.panel('midi');
    const inputs = this.editor.patternMenu.midiInputs();
    const check = (name, label, hint) => `<label class="dnft-check" title="${escape(hint)}"><input type="checkbox" data-general="${name}"> <span>${escape(label)}</span></label>`;
    panel.innerHTML = `
      <div class="dnft-config-list">
        <label class="dnft-field dnft-field--inline"><span>${escape(t.configMidiInput)}</span>
          <select data-general="midiInput"><option value="">${escape(t.configMidiAll)}</option>${inputs.map(input => `<option value="${escape(input.id)}">${escape(input.name)}</option>`).join('')}</select></label>
        ${check('midiChannelMap', t.configMidiChannelMap, t.configMidiChannelMapHint)}
        ${check('midiArpeggio', t.configMidiArpeggio, t.configMidiArpeggioHint)}
        ${check('midiVelocity', t.configMidiVelocity, t.configMidiVelocityHint)}
      </div>
      <p class="dnft-hint">${escape(inputs.length ? t.configMidiNote : t.configMidiOff + ' ' + t.configMidiNote)}</p>`;
    for (const input of panel.querySelectorAll('[data-general]')) {
      const name = input.dataset.general;
      if (input.type === 'checkbox')
        input.checked = this.draft[name];
      else
        input.value = this.draft[name];
      input.addEventListener('input', () => {
        this.draft[name] = input.type === 'checkbox' ? input.checked : input.value;
      });
    }
  }

  // ---- Appearance ---------------------------------------------------------------------------------

  buildAppearance() {
    const t = this.strings;
    const panel = this.panel('appearance');
    const style = getComputedStyle(this.editor.root);
    const swatches = COLORS.map(([key, property, alpha]) => {
      const current = this.draft.colors[property] ?? toHex(this.editor.root.style.getPropertyValue(property) || style.getPropertyValue(property).trim() || '#000');
      return `<label class="dnft-swatch"><input type="color" data-color="${property}" value="${current}"><span>${escape(t.configColors[key])}</span></label>`;
    }).join('');
    const fonts = ['', 'Consolas', 'Menlo', 'Monaco', 'Cascadia Mono', 'JetBrains Mono', 'Courier New', 'MS Gothic', 'Noto Sans Mono']
      .map(name => `<option value="${escape(name)}"></option>`).join('');
    panel.innerHTML = `
      <fieldset class="dnft-fieldset">
        <legend>${escape(t.configPresets)}</legend>
        <div class="dnft-config-presets">
          <button type="button" class="dnft-button" data-preset="default">${escape(t.presetDefault)}</button>
          <button type="button" class="dnft-button" data-preset="light">${escape(t.presetLight)}</button>
          <button type="button" class="dnft-button" data-preset="contrast">${escape(t.presetContrast)}</button>
        </div>
      </fieldset>
      <fieldset class="dnft-fieldset">
        <legend>${escape(t.configTheme)}</legend>
        <div class="dnft-config-presets">
          <button type="button" class="dnft-button" data-theme="save" title="${escape(t.configThemeSaveHint)}">${escape(t.configThemeSave)}</button>
          <button type="button" class="dnft-button" data-theme="load" title="${escape(t.configThemeLoadHint)}">${escape(t.configThemeLoad)}</button>
          <input type="file" accept=".txt,text/plain" hidden data-role="theme-file">
        </div>
      </fieldset>
      <fieldset class="dnft-fieldset">
        <legend>${escape(t.configColor)}</legend>
        <div class="dnft-swatches">${swatches}</div>
      </fieldset>
      <fieldset class="dnft-fieldset">
        <legend>${escape(t.configFont)}</legend>
        <div class="dnft-config-list">
          <label class="dnft-field"><span>${escape(t.configFontFamily)}</span><input type="text" list="dnft-fonts" data-look="fontFamily" spellcheck="false" placeholder="${escape(t.configFontDefault)}"></label>
          <datalist id="dnft-fonts">${fonts}</datalist>
          <label class="dnft-field dnft-field--inline"><span>${escape(t.configFontSize)}</span><input type="number" min="8" max="32" step="1" data-look="fontSize"></label>
          <label class="dnft-field dnft-field--inline"><span>${escape(t.configRowHeight)}</span><input type="number" min="100" max="250" step="5" data-look="rowHeight"></label>
        </div>
        <p class="dnft-hint">${escape(t.configAppearanceNote)}</p>
      </fieldset>`;
    // the dialog shows the change as it is made, and Cancel puts it back
    const preview = () => {
      this.values = copyValues(this.draft);
      this.applyLook();
    };
    for (const input of panel.querySelectorAll('[data-look]')) {
      input.value = this.draft[input.dataset.look];
      input.addEventListener('input', () => {
        const name = input.dataset.look;
        this.draft[name] = input.type === 'number' ? Number(input.value) || DEFAULTS[name] : input.value.trim();
        preview();
      });
    }
    for (const input of panel.querySelectorAll('[data-color]'))
      input.addEventListener('input', () => {
        this.draft.colors[input.dataset.color] = input.value;
        preview();
      });
    for (const preset of panel.querySelectorAll('[data-preset]'))
      preset.addEventListener('click', () => {
        this.draft.colors = preset.dataset.preset === 'default' ? {} : { ...PRESETS[preset.dataset.preset] };
        preview();
        this.buildAppearance();
      });
    // the theme as a file, as the desktop's Save and Load buttons have it
    const file = panel.querySelector('[data-role="theme-file"]');
    panel.querySelector('[data-theme="save"]').addEventListener('click', () => {
      const colors = {};
      for (const [, property] of THEME_COLORS)
        colors[property] = this.draft.colors[property] ?? toHex(this.editor.root.style.getPropertyValue(property) || style.getPropertyValue(property).trim() || '#000');
      const text = exportTheme(colors, this.draft);
      this.editor.files.download('Theme.txt', new Blob([text], { type: 'text/plain' }));
    });
    panel.querySelector('[data-theme="load"]').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const chosen = file.files[0];
      file.value = '';
      if (!chosen)
        return;
      const theme = importTheme(await chosen.text());
      if (!theme) {
        this.editor.message(t.configThemeBad, true);
        return;
      }
      const { colors, ...look } = theme;
      Object.assign(this.draft.colors, colors);
      Object.assign(this.draft, look);
      preview();
      this.buildAppearance();
      this.editor.message(t.configThemeLoaded);
    });
  }

  // ---- Keys -----------------------------------------------------------------------------------------

  buildKeys() {
    const t = this.strings;
    const panel = this.panel('keys');
    const keymap = this.draftKeys;
    const rows = GROUPS.map(group => {
      const commands = COMMANDS.filter(command => command.group === group && !command.hidden);
      return `<tr class="dnft-keys-group"><th colspan="3">${escape(t.commandGroups[group])}</th></tr>${commands.map(command => `
        <tr data-command="${command.id}">
          <td>${escape(t.commandNames[command.id] ?? command.id)}</td>
          <td class="dnft-key-chips">${keymap.keysOf(command.id).map(key => `<span class="dnft-key-chip"><kbd>${escape(formatCombo(key))}</kbd><button type="button" data-remove="${escape(key)}" title="${escape(t.configKeyRemove)}">×</button></span>`).join('')}</td>
          <td class="dnft-key-tools"><button type="button" class="dnft-button" data-add>${escape(t.configKeyAdd)}</button><button type="button" class="dnft-button" data-reset ${keymap.isDefault(command.id) ? 'disabled' : ''}>${escape(t.configKeyReset)}</button></td>
        </tr>`).join('')}`;
    }).join('');
    panel.innerHTML = `
      <p class="dnft-hint">${escape(t.configKeysNote)}</p>
      <div class="dnft-keys-wrap"><table class="dnft-help-table dnft-keys-table"><tbody>${rows}</tbody></table></div>
      <p class="dnft-hint" data-role="key-message" role="status"></p>`;
    // the panel is built again with every change; its handler is set once
    if (panel.dataset.wired)
      return;
    panel.dataset.wired = '1';
    panel.addEventListener('click', e => {
      const row = e.target.closest('[data-command]');
      if (!row)
        return;
      const id = row.dataset.command;
      const remove = e.target.closest('[data-remove]');
      if (remove) {
        this.draftKeys.setKeys(id, this.draftKeys.keysOf(id).filter(key => key !== remove.dataset.remove));
        this.buildKeys();
      } else if (e.target.closest('[data-reset]')) {
        this.draftKeys.reset(id);
        this.buildKeys();
      } else if (e.target.closest('[data-add]')) {
        this.captureKey(row, id, text => { panel.querySelector('[data-role="key-message"]').textContent = text; });
      }
    });
  }

  // Waits for the key to give a command
  captureKey(row, id, message) {
    const t = this.strings;
    const d = this.dialog;
    const keymap = this.draftKeys;
    const chips = row.querySelector('.dnft-key-chips');
    chips.classList.add('is-capturing');
    message(t.configKeyPress);
    const finish = () => {
      d.removeEventListener('keydown', onKey, true);
      chips.classList.remove('is-capturing');
    };
    const onKey = e => {
      const combo = comboOf(e);
      if (!combo)
        return;
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        finish();
        message('');
        return;
      }
      if (RESERVED.has(combo)) {
        message(t.configKeyReserved.replace('{key}', formatCombo(combo)));
        return;
      }
      finish();
      const owner = keymap.owner(combo, id);
      keymap.setKeys(id, [...keymap.keysOf(id).filter(key => key !== combo), combo]);
      this.buildKeys();
      this.panel('keys').querySelector('[data-role="key-message"]').textContent = owner
        ? t.configKeyTaken.replace('{key}', formatCombo(combo)).replace('{command}', t.commandNames[owner.id] ?? owner.id)
        : '';
    };
    d.addEventListener('keydown', onKey, true);
  }

  // ---- Sound and Mixer -----------------------------------------------------------------------------------

  // The slider, and the number that says the same
  slider(name, label, min, max, unit = '', step = 1) {
    return `<div class="dnft-slider-row"><label for="dnft-sound-${name}">${escape(label)}</label>
      <input type="range" id="dnft-sound-${name}" min="${min}" max="${max}" step="${step}" data-sound="${name}">
      <input type="number" min="${min}" max="${max}" step="${step}" data-sound="${name}" aria-label="${escape(label)}"><span>${unit}</span></div>`;
  }

  // What the sound pages show: the draft, or what the engine has
  current() {
    return this.soundDraft ?? this.engine;
  }

  // Tying each pair of a slider and a number to the draft of the engine's settings
  wireSliders(panel) {
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    for (const input of panel.querySelectorAll('input[data-sound]')) {
      const name = input.dataset.sound;
      input.addEventListener('input', () => {
        const value = clamp(Number(input.value) || 0, Number(input.min), Number(input.max));
        this.setSoundValue(name, input.dataset.index !== undefined ? Number(input.dataset.index) : null, value);
        for (const other of panel.querySelectorAll(`input[data-sound="${name}"]${input.dataset.index !== undefined ? `[data-index="${input.dataset.index}"]` : ''}`))
          if (other !== input)
            other.value = value;
      });
    }
  }

  setSoundValue(name, index, value) {
    this.soundDraft ??= JSON.parse(JSON.stringify(this.engine ?? {}));
    if (index === null)
      this.soundDraft[name] = value;
    else
      this.soundDraft.levels[index] = value;
  }

  buildSound() {
    const t = this.strings;
    const panel = this.panel('sound');
    const engine = this.current();
    if (!engine) {
      panel.textContent = t.configNoEngine;
      return;
    }
    panel.innerHTML = `
      <fieldset class="dnft-fieldset">
        <legend>${escape(t.configFilters)}</legend>
        ${this.slider('bassFilter', t.configBass, 16, 4000, 'Hz')}
        ${this.slider('trebleFilter', t.configTreble, 20, 20000, 'Hz')}
        ${this.slider('trebleDamping', t.configDamping, 0, 90, 'dB')}
        ${this.slider('volume', t.configVolume, 0, 100, '%')}
      </fieldset>
      <fieldset class="dnft-fieldset">
        <legend>${escape(t.configEmulation)}</legend>
        ${this.slider('fdsLowpass', t.configFdsLowpass, 0, 8000, 'Hz')}
        ${this.slider('n163Lowpass', t.configN163Lowpass, 0, 12000, 'Hz')}
        <label class="dnft-check"><input type="checkbox" data-engine="disableN163Multiplexing"> <span>${escape(t.configDisableN163Multiplexing)}</span></label>
        <label class="dnft-field"><span>${escape(t.configVrc7Patch)}</span><select data-engine="vrc7Patch">${t.vrc7PatchSets.slice(0, VRC7_PATCHES).map((name, i) => `<option value="${i}">${escape(name)}</option>`).join('')}</select></label>
      </fieldset>
      <p class="dnft-hint">${escape(t.configSoundNote)}</p>`;
    for (const [name] of SOUND)
      for (const input of panel.querySelectorAll(`input[data-sound="${name}"]`))
        input.value = engine[name];
    this.wireSliders(panel);
    for (const input of panel.querySelectorAll('[data-engine]')) {
      const name = input.dataset.engine;
      if (input.type === 'checkbox')
        input.checked = engine[name];
      else
        input.value = engine[name];
      input.addEventListener('input', () => this.setSoundValue(name, null, input.type === 'checkbox' ? input.checked : Number(input.value)));
    }
  }

  buildMixer() {
    const t = this.strings;
    const panel = this.panel('mixer');
    const engine = this.current();
    if (!engine) {
      panel.textContent = t.configNoEngine;
      return;
    }
    panel.innerHTML = `
      <fieldset class="dnft-fieldset">
        <legend>${escape(t.configLevels)}</legend>
        ${DEVICES.map((name, i) => `<div class="dnft-slider-row"><label>${escape(name)}</label>
          <input type="range" min="${-MAX_LEVEL}" max="${MAX_LEVEL}" step="1" data-sound="levels" data-index="${i}">
          <input type="number" min="${-MAX_LEVEL}" max="${MAX_LEVEL}" step="1" data-sound="levels" data-index="${i}" aria-label="${escape(name)}"><span>× 0.1 dB</span></div>`).join('')}
      </fieldset>
      <p class="dnft-hint">${escape(t.configMixerNote)}</p>`;
    engine.levels.forEach((level, i) => {
      for (const input of panel.querySelectorAll(`input[data-index="${i}"]`))
        input.value = level;
    });
    this.wireSliders(panel);
  }

  // ---- OK and the defaults -----------------------------------------------------------------------------

  async commit() {
    const editor = this.editor;
    this.committed = true;
    this.values = copyValues(this.draft);
    editor.keymap.overrides = this.draftKeys.overrides;
    editor.keymap.tidy();
    this.applyLook();
    editor.applyConfig();
    editor.patternMenu.listenMidi();
    editor.session?.send('setAutoArpeggio', !!this.values.midiArpeggio);
    if (this.soundDraft) {
      const changed = {};
      for (const key of Object.keys(this.soundDraft))
        if (JSON.stringify(this.soundDraft[key]) !== JSON.stringify(this.engine[key]))
          changed[key] = this.soundDraft[key];
      if (Object.keys(changed).length) {
        editor.stopPlaying();
        await editor.session.call('setSoundSettings', changed);
        this.sound = { ...(this.sound ?? {}), ...changed };
        editor.message(this.strings.configSoundApplied);
      }
    }
    this.save();
    this.dialog.close();
  }

  // The tab's settings back to the defaults (nothing is kept until OK)
  async resetTab() {
    switch (this.tab) {
      case 'general':
        for (const name of ['rowHex', 'flats', 'wrapCursor', 'wrapFrames', 'pageStep', 'noStepMove', 'wrapPatternValue', 'keyRepeat', 'editStyle'])
          this.draft[name] = DEFAULTS[name];
        this.draft.noteKeys = structuredClone(DEFAULTS.noteKeys);
        this.buildGeneral();
        break;
      case 'appearance':
        Object.assign(this.draft, { colors: {}, fontFamily: DEFAULTS.fontFamily, fontSize: DEFAULTS.fontSize, rowHeight: DEFAULTS.rowHeight });
        this.values = { ...this.draft, colors: {} };
        this.applyLook();
        this.buildAppearance();
        break;
      case 'midi':
        for (const name of ['midiInput', 'midiChannelMap', 'midiVelocity', 'midiArpeggio'])
          this.draft[name] = DEFAULTS[name];
        this.buildMidi();
        break;
      case 'keys':
        this.draftKeys.overrides = {};
        this.draftKeys.rebuild();
        this.buildKeys();
        break;
      case 'sound':
      case 'mixer':
        // the desktop's defaults (CSettings::DefaultSettings())
        if (this.engine)
          this.soundDraft = { ...this.engine, bassFilter: 30, trebleFilter: 12000, trebleDamping: 24, volume: 100, fdsLowpass: 2000, n163Lowpass: 12000,
            disableN163Multiplexing: true, vrc7Patch: 0, levels: this.engine.levels.map(() => 0) };
        this.buildSound();
        this.buildMixer();
        break;
    }
  }
}

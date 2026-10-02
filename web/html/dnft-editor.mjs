// Dn-FamiTracker web port - the editor.
//
// A tracker in the page, on the tracker's own engine: the module and its sound live in
// a worker (dnft-session-engine.mjs); this is what the desktop tracker's window does.
// Keys follow the desktop's defaults: the Z and Q rows of the keyboard enter notes, 1 a
// note cut, \ a release, hex digits the other columns; Space toggles editing, Enter plays
// the frame or stops, F5-F8 play from the start, loop the pattern, play from the cursor
// and stop; the rest of the desktop's shortcuts are in KEYS. Edits of the patterns, the
// frames, the bookmarks and the song's settings can be undone. The module is kept in the
// browser (localStorage) as it changes.
//
//   import { DnFTEditor } from './dnft-editor.mjs';
//   const editor = await DnFTEditor.create(element, { base: '.', lang: 'ja' });

import { DnFTSession, PLAY, unsupportedReason } from './dnft-session.mjs';
import {
  Song, History, CELL, NOTE, MAX_VOLUME, NO_INSTRUMENT, HOLD_INSTRUMENT, MAX_INSTRUMENTS, MAX_FRAMES,
  MAX_PATTERNS, MAX_ROWS, OCTAVES, CHIP, CHANNEL_ID, EMPTY_CELL, NOTE_KEYS, INSTRUMENT_CHIP,
} from './dnft-song.mjs';
import { PatternView, columnCount, columnKind } from './dnft-pattern-view.mjs';
import * as edit from './dnft-pattern-edit.mjs';
import { PASTE, PASTE_AT, fieldOfColumn, normalizeSelection } from './dnft-pattern-edit.mjs';
import { InstrumentEditor } from './dnft-instrument-editor.mjs';
import { FileMenu } from './dnft-files.mjs';
import { PatternMenu } from './dnft-pattern-menu.mjs';
import { SongMenu } from './dnft-song-menu.mjs';
import { STRINGS } from './dnft-editor-strings.mjs';

const AUTOSAVE_KEY = 'dnft-editor.autosave';
const AUTOSAVE_DELAY = 1500;
const PAGE_ROWS = 16;
// Engine ticks per second a module may ask for (CSpeedDlg)
const ENGINE_RATE_MIN = 16;
const ENGINE_RATE_MAX = 400;
// Characters of a comment, well within what a module file holds (session_bindings.cpp)
const COMMENT_MAX = 20000;

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

// The note of a key, octave * 12 + semitone (FamiTrackerTypes.h MIDI_NOTE())
const midiNote = (note, octave) => octave * 12 + note - 1;

// The desktop's shortcuts that are not typing (CAccelerator::DEFAULT_TABLE, and what its
// pattern editor does with Alt), by modifiers (C Ctrl or Cmd, A Alt, S Shift) and the
// key's code. Ctrl+F4 closes the browser's tab in most browsers: Ctrl+Shift+Up/Down
// transpose by octaves too, as before.
const KEYS = {
  'C+KeyZ': e => e.undo(), 'CS+KeyZ': e => e.redo(), 'C+KeyY': e => e.redo(),
  'C+KeyC': e => e.copy(), 'C+KeyX': e => e.cut(), 'C+KeyV': e => e.paste(), 'C+KeyM': e => e.paste(PASTE.MIX),
  'C+KeyA': e => e.selectAll(),
  'C+ArrowLeft': e => e.setCursor({ ...e.cursor, frame: e.cursor.frame - 1 }),
  'C+ArrowRight': e => e.setCursor({ ...e.cursor, frame: e.cursor.frame + 1 }),
  'C+ArrowUp': e => e.stepInstrument(-1), 'C+ArrowDown': e => e.stepInstrument(1),
  'CS+ArrowUp': e => e.transpose(12), 'CS+ArrowDown': e => e.transpose(-12),
  'C+F1': e => e.transpose(-1), 'C+F2': e => e.transpose(1), 'C+F3': e => e.transpose(-12), 'C+F4': e => e.transpose(12),
  'S+F1': e => e.scrollValues(-1), 'S+F2': e => e.scrollValues(1), 'S+F3': e => e.scrollValues(-16), 'S+F4': e => e.scrollValues(16),
  'C+KeyG': e => e.interpolate(), 'C+KeyR': e => e.reverse(), 'A+KeyS': e => e.replaceInstrument(),
  'C+KeyK': e => e.toggleBookmark(), 'C+PageDown': e => e.gotoBookmark(1), 'C+PageUp': e => e.gotoBookmark(-1),
  'C+KeyF': e => e.patternMenu.toggleFind(), 'A+KeyG': e => e.patternMenu.openGoto(),
  'A+KeyB': e => e.setBlock(true), 'A+KeyE': e => e.setBlock(false),
  'A+KeyT': e => e.setMask('instrument'), 'A+KeyV': e => e.setMask('volume'),
  'A+ArrowUp': e => e.moveRows(-1), 'A+ArrowDown': e => e.moveRows(1),
  'AS+ArrowUp': e => e.moveRows(-1, true), 'AS+ArrowDown': e => e.moveRows(1, true),
  'A+ArrowLeft': e => e.moveChannelKeepingColumn(-1), 'A+ArrowRight': e => e.moveChannelKeepingColumn(1),
  'AS+ArrowLeft': e => e.moveChannelKeepingColumn(-1, true), 'AS+ArrowRight': e => e.moveChannelKeepingColumn(1, true),
  'C+KeyI': e => e.action('edit-instrument'), 'C+KeyD': e => e.frameOp('duplicate'), 'A+KeyD': e => e.songMenu.clonePattern(),
  'C+NumpadAdd': e => e.setStep(e.step + 1), 'C+NumpadSubtract': e => e.setStep(e.step - 1),
  'A+F9': e => e.toggleMute(e.cursor.channel, false), 'A+F10': e => e.toggleMute(e.cursor.channel, true),
};
for (let digit = 0; digit < 10; ++digit)
  KEYS[`A+Numpad${digit}`] = e => e.setStep(digit);

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
    source = 'https://github.com/hhungry2/FamiTracker-web',
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
    this.selection = null;      // normalized {start, end} places (dnft-pattern-edit.mjs), or null
    this.selStart = null;       // the place the selection was started at, and its other end
    this.selEnd = null;
    this.block = false;         // made with Alt+B / Alt+E: moving the cursor keeps it
    this.editMode = true;
    this.follow = true;
    this.playing = false;
    this.play = null;           // {frame, row} heard now while the song plays
    this.muted = [];
    this.octave = 3;
    this.step = 1;
    this.instrument = 0;
    this.history = new History();
    this.clipboard = null;      // copyCells() (dnft-pattern-edit.mjs)
    this.pastePos = PASTE_AT.CURSOR;   // Edit > Paste Special: where Paste goes
    this.overflowPaste = false;        // the desktop's "Overflow paste mode"
    this.maskInstrument = false;       // Edit > Instrument Mask: notes entered keep the cell's
    this.maskVolume = true;            // Edit > Volume Mask: off, notes get the last volume
    this.lastVolume = MAX_VOLUME;      // typed last, or picked up from a row
    // Edit > Split Keyboard: notes up to `note` (octave * 12 + semitone, -1: off) are
    // moved by `transpose` and get `instrument` (NO_INSTRUMENT: the one in use); outside
    // the edit mode they play on the channel with the id `channel` (-1: the cursor's)
    this.split = { note: -1, channel: -1, instrument: NO_INSTRUMENT, transpose: 0 };
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
          <input type="file" class="dnft-instrument-file" accept=".fti" multiple hidden>
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
              <label class="dnft-field"><span data-text="comment"></span><button type="button" class="dnft-button dnft-comment-button" data-action="comment"></button></label>
              <div class="dnft-field dnft-track">
                <span data-text="track"></span>
                <select data-role="track"></select>
                <button type="button" class="dnft-icon-button" data-action="add-track">+</button>
                <button type="button" class="dnft-icon-button" data-action="remove-track">−</button>
                <button type="button" class="dnft-icon-button" data-action="track-up">↑</button>
                <button type="button" class="dnft-icon-button" data-action="track-down">↓</button>
              </div>
              <label class="dnft-field"><span data-text="trackTitle"></span><input type="text" data-role="track-title" spellcheck="false"></label>
              <div class="dnft-grid">
                <div class="dnft-field">
                  <span class="dnft-field-head"><span data-text="speed"></span><label class="dnft-check dnft-mini-check"><input type="checkbox" data-role="groove-mode"> <span data-text="grooveMode"></span></label></span>
                  <input type="number" data-setting="speed" min="1" max="255">
                </div>
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
              <div class="dnft-field"><span data-text="engineSpeed"></span>
                <span class="dnft-pair dnft-engine-speed">
                  <select data-role="engine-mode"><option value="0" data-text="engineDefault"></option><option value="1" data-text="engineCustom"></option></select>
                  <input type="number" data-role="engine-rate" min="${ENGINE_RATE_MIN}" max="${ENGINE_RATE_MAX}"><span>Hz</span>
                </span>
              </div>
              <label class="dnft-field"><span data-text="vibrato"></span><select data-role="vibrato"><option value="1" data-text="vibratoNew"></option><option value="0" data-text="vibratoOld"></option></select></label>
              <label class="dnft-field"><span data-text="pitchMode"></span><select data-role="linear-pitch"><option value="0" data-text="pitchPeriod"></option><option value="1" data-text="pitchLinear"></option></select></label>
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
                <button type="button" class="dnft-icon-button" data-action="deep-clone-instrument"></button>
                <button type="button" class="dnft-icon-button" data-action="remove-instrument"></button>
                <button type="button" class="dnft-icon-button" data-action="edit-instrument"></button>
                <button type="button" class="dnft-icon-button" data-action="load-instrument"></button>
                <button type="button" class="dnft-icon-button" data-action="save-instrument"></button>
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
      <div class="dnft-loading"></div>
      <dialog class="dnft-dialog dnft-comment-dialog">
        <form method="dialog" class="dnft-dialog-head">
          <strong class="dnft-dialog-title" data-text="comment"></strong>
          <button type="submit" class="dnft-button" data-text="close"></button>
        </form>
        <div class="dnft-comment-body">
          <textarea class="dnft-comment-text" spellcheck="false" maxlength="${COMMENT_MAX}"></textarea>
          <label class="dnft-check"><input type="checkbox" data-role="show-comment"> <span data-text="showComment"></span></label>
        </div>
      </dialog>`;
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
    label('clone-instrument', '⧉', t.cloneInstrumentHint);
    label('deep-clone-instrument', '⎘', t.deepCloneInstrumentHint);
    label('remove-instrument', '✕', t.removeInstrument);
    label('edit-instrument', '✎', t.editInstrument);
    label('load-instrument', '⤓', t.loadInstrumentHint);
    label('save-instrument', '⤒', t.saveInstrumentHint);
    label('add-track', '+', t.addTrack);
    label('remove-track', '−', t.removeTrack);
    label('track-up', '↑', t.trackUp);
    label('track-down', '↓', t.trackDown);
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
    $('[data-setting="speed"]').setAttribute('aria-label', t.speed);
    $('[data-role="groove-mode"]').closest('label').title = t.grooveModeHint;
    $('[data-setting="rows"]').title = t.rowsHint;
    $('[data-setting="beat"]').title = t.highlightHint;
    $('[data-setting="bar"]').title = t.highlightHint;
    $('[data-action="comment"]').title = t.commentHint;
    $('.dnft-engine-speed').title = t.engineSpeedHint;
    $('[data-role="engine-mode"]').setAttribute('aria-label', t.engineSpeed);
    $('[data-role="engine-rate"]').setAttribute('aria-label', `${t.engineSpeed} (Hz)`);
    $('[data-role="vibrato"]').title = t.vibratoHint;
    $('[data-role="linear-pitch"]').title = t.pitchModeHint;
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
      toolbar: $('.dnft-toolbar'), file: $('.dnft-file'), instrumentFile: $('.dnft-instrument-file'), dirty: $('.dnft-dirty'),
      octave: $('[data-spin="octave"] output'), step: $('[data-spin="step"] output'),
      instrument: $('[data-role="instrument"]'), volume: $('[data-role="volume"]'),
      track: $('[data-role="track"]'), trackTitle: $('[data-role="track-title"]'), grooveMode: $('[data-role="groove-mode"]'),
      n163: $('[data-role="n163"]'), machine: $('[data-role="machine"]'),
      engineMode: $('[data-role="engine-mode"]'), engineRate: $('[data-role="engine-rate"]'),
      vibrato: $('[data-role="vibrato"]'), linearPitch: $('[data-role="linear-pitch"]'),
      comment: $('[data-action="comment"]'), commentDialog: $('.dnft-comment-dialog'),
      commentText: $('.dnft-comment-text'), showComment: $('[data-role="show-comment"]'),
      chips: $('.dnft-chips'), frames: $('.dnft-frame-list'), instruments: $('.dnft-instrument-list'),
      pattern: $('.dnft-pattern'), piano: $('.dnft-piano'), position: $('.dnft-position'),
      message: $('.dnft-message'), drop: $('.dnft-drop'), loading: $('.dnft-loading'),
    };

    this.view = new PatternView(this.els.pattern, this);
    this.view.scroller.setAttribute('aria-label', t.pattern);
    this.instrumentEditor = new InstrumentEditor(this);
    this.files = new FileMenu(this);
    this.patternMenu = new PatternMenu(this);
    this.songMenu = new SongMenu(this);
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
    els.instrumentFile.addEventListener('change', () => {
      const files = [...els.instrumentFile.files];
      els.instrumentFile.value = '';
      if (files.length)
        this.loadInstruments(files);
    });
    root.addEventListener('drop', e => {
      e.preventDefault();
      els.drop.hidden = true;
      const files = [...e.dataTransfer.files];
      // instrument files are added to the module; anything else is a module to open
      if (files.length && files.every(file => /\.fti$/i.test(file.name)))
        this.loadInstruments(files);
      else if (files[0])
        this.openFile(files[0]);
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
    els.trackTitle.addEventListener('change', () => this.setTrackTitle(els.trackTitle.value));
    els.grooveMode.addEventListener('change', () => this.setGrooveMode(els.grooveMode.checked));
    els.engineMode.addEventListener('change', async () => {
      const custom = els.engineMode.value === '1';
      // a custom speed starts from the one playing now, as the desktop's dialog does
      await this.setEngineSpeed(custom ? this.song.info.frameRate : 0);
      if (custom)
        els.engineRate.select();
    });
    els.engineRate.addEventListener('change', () => this.setEngineSpeed(Number(els.engineRate.value)));
    els.vibrato.addEventListener('change', () => this.setVibratoStyle(els.vibrato.value === '1'));
    els.linearPitch.addEventListener('change', () => this.setLinearPitch(els.linearPitch.value === '1'));
    els.commentText.addEventListener('change', () => this.saveComment());
    els.showComment.addEventListener('change', () => this.saveComment());
    els.commentDialog.addEventListener('close', () => this.saveComment());

    // the pattern
    const scroller = this.view.scroller;
    scroller.tabIndex = 0;
    scroller.addEventListener('pointerdown', e => this.onGridPointerDown(e));
    scroller.addEventListener('pointermove', e => this.onGridPointerMove(e));
    scroller.addEventListener('pointerup', () => this.endDrag(true));
    scroller.addEventListener('pointercancel', () => this.endDrag());
    scroller.addEventListener('dblclick', e => this.onGridDoubleClick(e));
    scroller.addEventListener('contextmenu', e => this.onGridContextMenu(e));
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
    // what it holds was the previous song's (saveComment())
    if (this.els.commentDialog.open)
      this.els.commentDialog.close();
    this.song = new Song(snapshot);
    this.track = 0;
    this.cursor = { frame: 0, row: 0, channel: 0, column: 0 };
    this.deselect();
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
    this.patternMenu.refresh();
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
    // a text export (File > Import Text)
    if (/\.txt$/i.test(file.name))
      return this.files.importText(file);
    if (/\.fti$/i.test(file.name))
      return this.loadInstruments([file]);
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
    // as the desktop does for a module that asks for it
    if (this.song.info.showComment && this.song.info.comment)
      this.openComment();
  }

  // The name the module's files get, without an extension
  fileBase() {
    return (this.fileName || this.song.info.title || 'untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'untitled';
  }

  async saveFile() {
    // Ctrl+S while the comment is being written
    if (this.els.commentDialog.open)
      this.saveComment();
    let bytes;
    try {
      bytes = await this.session.call('save');
    } catch (e) {
      this.message(this.strings.failed + e.message, true);
      return;
    }
    const base = this.fileBase();
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

  // Moves the cursor, within the track. `extend` (Shift): the selection goes from where it
  // was started, or from where the cursor was, to the cursor; `keep`: the selection stays
  // as it is. Otherwise it goes, unless it was made with Alt+B / Alt+E.
  setCursor(place, { extend = false, keep = false } = {}) {
    const before = this.cursor;
    const cursor = this.clampPlace(place);
    this.cursor = cursor;
    if (extend)
      this.select(this.selection ? this.selStart : before, cursor, this.block);
    else if (!keep && !this.block)
      this.deselect();
    this.view.reveal(cursor.channel);
    this.view.invalidate();
    if (cursor.frame !== before.frame || cursor.channel !== before.channel)
      this.renderFrames();
    this.updateStatus();
  }

  clampPlace(place) {
    const tr = this.tr;
    const channel = Math.max(0, Math.min(this.channelCount - 1, place.channel));
    return {
      frame: Math.max(0, Math.min(tr.frames - 1, place.frame)),
      row: Math.max(0, Math.min(tr.rows - 1, place.row)),
      channel,
      column: Math.max(0, Math.min(this.columns(channel) - 1, place.column)),
    };
  }

  // The selection from one place to another, which may be in other frames
  select(start, end, block = false) {
    this.selStart = this.clampPlace(start);
    this.selEnd = this.clampPlace(end);
    this.selection = normalizeSelection(this.selStart, this.selEnd);
    this.block = block;
    this.view.invalidate();
  }

  deselect() {
    this.selection = this.selStart = this.selEnd = null;
    this.block = false;
    this.view?.invalidate();
  }

  // The cursor and the selection, as undo puts them back
  editState() {
    return { cursor: { ...this.cursor }, selStart: this.selStart, selEnd: this.selEnd, block: this.block };
  }

  restoreEditState(state) {
    this.setCursor(state.cursor, { keep: true });
    if (state.selStart)
      this.select(state.selStart, state.selEnd, state.block);
    else
      this.deselect();
  }

  // Alt+B / Alt+E: the start or the end of the selection at the cursor
  // (CPatternEditor::SetBlockStart(), SetBlockEnd()); the selection then stays as the cursor
  // moves, until Escape or another selection
  setBlock(start) {
    if (!this.selection)
      this.select(this.cursor, this.cursor, true);
    else if (start)
      this.select(this.cursor, this.selEnd, true);
    else
      this.select(this.selStart, this.cursor, true);
  }

  // Rows up or down, wrapping around the song; a selection stops at its ends
  moveRows(delta, extend = false) {
    const { rows, frames } = this.tr;
    const total = rows * frames;
    let at = this.cursor.frame * rows + this.cursor.row + delta;
    at = extend ? Math.max(0, Math.min(total - 1, at)) : ((at % total) + total) % total;
    this.setCursor({ ...this.cursor, frame: Math.floor(at / rows), row: at % rows }, { extend });
  }

  // Up and Down go by the edit step, as the desktop's do unless its "No step moving" is on;
  // Alt+Up and Alt+Down by one row
  moveByStep(direction, extend = false) {
    this.moveRows(direction * Math.max(1, this.step), extend);
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

  // Tab and Shift+Tab: the next or previous channel's note column, no selection
  moveChannel(delta) {
    const channel = (this.cursor.channel + delta + this.channelCount) % this.channelCount;
    this.deselect();
    this.setCursor({ ...this.cursor, channel, column: 0 });
  }

  // Alt+Left and Alt+Right: the channel next to it, in the same column as far as it has one
  moveChannelKeepingColumn(delta, extend = false) {
    const channel = (this.cursor.channel + delta + this.channelCount) % this.channelCount;
    this.setCursor({ ...this.cursor, channel, column: Math.min(this.cursor.column, this.columns(channel) - 1) }, { extend });
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

  // Whether the split keyboard takes a note (octave * 12 + semitone) on a channel
  // (CFamiTrackerView::IsSplitEnabled()): not on the noise channel
  splitTakes(midi, channel) {
    return this.split.note >= 0 && midi <= this.split.note && this.song.channels[channel]?.id !== CHANNEL_ID.NOISE;
  }

  // Plays a note by hand (CFamiTrackerView::PlayNote()). Outside the edit mode the split
  // keyboard may send it to its channel; returns the channel that plays it, for noteOff().
  noteOn(channel, note, octave) {
    let midi = midiNote(note, octave);
    let instrument = this.instrument;
    if (!this.editMode && this.split.channel >= 0 && this.split.note >= 0 && midi <= this.split.note) {
      const index = this.song.channels.findIndex(c => c.id === this.split.channel);
      if (index >= 0)
        channel = index;
    }
    if (this.splitTakes(midi, channel)) {
      midi = Math.max(0, Math.min(OCTAVES * 12 - 1, midi + this.split.transpose));
      if (this.split.instrument !== NO_INSTRUMENT)
        instrument = this.split.instrument;
    }
    this.session.resume();
    this.session.send('noteOn', channel, midi % 12 + 1, Math.floor(midi / 12), instrument, MAX_VOLUME);
    return channel;
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
    let channel = this.cursor.channel;
    key.classList.add('is-down');
    if (this.previews())
      channel = this.noteOn(channel, NOTE.C + semitone, octave);
    this.pianoHeld = { key, channel };
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

  // Changes cells as one action: [{channel, pattern, row, cells}], in the current track.
  // Undo puts the cells back with the cursor and selection there were, redo with those
  // `after` (an editState()), or as they are once the cells are written. False when there
  // is nothing to change.
  change(changes, after = null) {
    if (!changes.length)
      return false;
    const track = this.track;
    const before = this.editState();
    const old = changes.map(c => this.song.readCells(track, c.channel, c.pattern, c.row, c.cells.length / CELL));
    const apply = values => changes.forEach((c, i) => this.writeCells(track, c.channel, c.pattern, c.row, values[i]));
    const fresh = changes.map(c => c.cells);
    apply(fresh);
    const state = after ?? this.editState();
    this.record({
      undo: () => { this.showTrack(track); apply(old); this.restoreEditState(before); },
      redo: () => { this.showTrack(track); apply(fresh); this.restoreEditState(state); },
    });
    return true;
  }

  // What an edit of dnft-pattern-edit.mjs writes ([{channel, pattern, row, cell}]), as one
  // action; the rows next to each other go together
  applyWrites(writes, after = null) {
    const sorted = [...writes].sort((a, b) => a.channel - b.channel || a.pattern - b.pattern || a.row - b.row);
    const runs = [];
    for (const w of sorted) {
      const run = runs.at(-1);
      if (run && run.channel === w.channel && run.pattern === w.pattern && run.row + run.cells.length === w.row)
        run.cells.push(w.cell);
      else
        runs.push({ channel: w.channel, pattern: w.pattern, row: w.row, cells: [w.cell] });
    }
    return this.change(runs.map(run => {
      const cells = new Uint8Array(run.cells.length * CELL);
      run.cells.forEach((cell, i) => cells.set(cell, i * CELL));
      return { channel: run.channel, pattern: run.pattern, row: run.row, cells };
    }), after);
  }

  // The current track as dnft-pattern-edit.mjs reads it
  trackView() {
    const { song, track } = this;
    const tr = this.tr;
    return {
      rows: tr.rows, frames: tr.frames, channels: song.channels.length, effColumns: tr.effColumns,
      ids: song.channels.map(c => c.id), chips: song.channels.map(c => c.chip),
      cell: (frame, channel, row) => song.cell(track, frame, channel, row),
      pattern: (frame, channel) => song.patternAt(track, frame, channel),
    };
  }

  // The cursor somewhere and no selection, as an action leaves them
  static stateAt(cursor) {
    return { cursor: { ...cursor }, selStart: null, selEnd: null, block: false };
  }

  // Whether the edits are on (the desktop does nothing otherwise; this says so)
  canEdit() {
    if (!this.editMode)
      this.message(this.strings.editModeOff);
    return this.editMode;
  }

  cellHere() {
    const { frame, row, channel } = this.cursor;
    return Uint8Array.from(this.song.cell(this.track, frame, channel, row));
  }

  changeHere(cell) {
    const { frame, row, channel } = this.cursor;
    this.change([{ channel, pattern: this.patternOf(frame, channel), row, cells: cell }]);
  }

  // A note at the cursor (CFamiTrackerView::InsertNote()), with the instrument in use
  // unless the instrument mask is on, and the last volume when the volume mask is off;
  // the split keyboard moves the notes it takes, and may give them its instrument.
  // `step`: a step down after it.
  enterNote(note, octave, step = true) {
    const cell = this.cellHere();
    const channel = this.cursor.channel;
    cell[0] = note;
    if (note === NOTE.HALT || note === NOTE.RELEASE) {
      cell[1] = 0;
    } else {
      cell[1] = octave;
      if (!this.maskInstrument && cell[3] !== HOLD_INSTRUMENT)
        cell[3] = this.instrument;
      if (!this.maskVolume)
        cell[2] = this.lastVolume;
      if (this.song.channels[channel].id === CHANNEL_ID.NOISE) {
        // the noise channel plays 16 periods
        const midi = (midiNote(note, octave) % 16) + 16;
        cell[1] = Math.floor(midi / 12);
        cell[0] = midi % 12 + 1;
      } else if (this.splitTakes(midiNote(note, octave), channel)) {
        const midi = Math.max(0, Math.min(OCTAVES * 12 - 1, midiNote(note, octave) + this.split.transpose));
        cell[1] = Math.floor(midi / 12);
        cell[0] = midi % 12 + 1;
        if (this.split.instrument !== NO_INSTRUMENT)
          cell[3] = this.split.instrument;
      }
    }
    this.changeHere(cell);
    if (step)
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
      cell[2] = this.lastVolume = value;
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

  // The desktop's "clear field" key (-): the field at the cursor and a step down; with
  // Ctrl, the whole cell (CFamiTrackerView::HandleKeyboardInput())
  clearKey(whole) {
    const cell = this.cellHere();
    const { column } = this.cursor;
    const effect = Math.floor((column - 4) / 3);
    if (whole) {
      cell.set(EMPTY_CELL);
    } else {
      switch (columnKind(column)) {
        case 'note': cell[0] = NOTE.NONE; cell[1] = 0; break;
        case 'instrument': cell[3] = NO_INSTRUMENT; break;
        case 'volume': cell[2] = this.lastVolume = MAX_VOLUME; break;
        case 'effect': cell[4 + effect] = 0; cell[8 + effect] = 0; break;
        case 'param': cell[8 + effect] = 0; break;
      }
    }
    this.changeHere(cell);
    this.stepDown();
  }

  // Delete: the selection's fields, or the field at the cursor and a step down; with Shift,
  // the cursor's row goes and the rows below move up (CFamiTrackerView::OnKeyDelete())
  clear({ pullUp = false } = {}) {
    if (this.selection) {
      this.applyWrites(edit.clearCells(this.trackView(), this.selection));
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
      // clearing a note clears its instrument and volume too (CFamiTrackerDoc::ClearRowField())
      clearField(cell, 1);
      clearField(cell, 2);
    }
    this.changeHere(cell);
    this.stepDown();
  }

  // Insert: an empty row at the cursor, the rows of its channel below move down; with a
  // selection, at its top, in its columns, down to the end of its last frame
  // (CPActionInsertRow, CPActionInsertAtSel)
  insertRow() {
    if (this.selection) {
      this.applyWrites(edit.insertRows(this.trackView(), this.selection));
      return;
    }
    const { frame, row, channel } = this.cursor;
    const rows = this.tr.rows;
    const pattern = this.patternOf(frame, channel);
    const cells = this.song.readCells(this.track, channel, pattern, row, rows - row);
    cells.copyWithin(CELL, 0, (rows - row - 1) * CELL);
    cells.set(EMPTY_CELL, 0);
    this.change([{ channel, pattern, row, cells }]);
  }

  // Backspace: the row above the cursor goes, the rows below move up; with a selection, its
  // rows go (CPActionDeleteRow, CPActionDeleteAtSel)
  deleteRowAbove() {
    if (this.selection) {
      const after = DnFTEditor.stateAt(this.cursor);
      if (this.applyWrites(edit.deleteRows(this.trackView(), this.selection), after))
        this.restoreEditState(after);
      return;
    }
    const { frame, row, channel } = this.cursor;
    if (row === 0)
      return;
    const rows = this.tr.rows;
    const pattern = this.patternOf(frame, channel);
    const cells = this.song.readCells(this.track, channel, pattern, row - 1, rows - row + 1);
    cells.copyWithin(0, CELL);
    cells.set(EMPTY_CELL, (rows - row) * CELL);
    this.change([{ channel, pattern, row: row - 1, cells }], DnFTEditor.stateAt({ ...this.cursor, row: row - 1 }));
    this.setCursor({ ...this.cursor, row: row - 1 });
  }

  // ---- the clipboard ----------------------------------------------------------------------

  // Edit > Copy: the selection, or the cell at the cursor
  copy() {
    this.clipboard = edit.copyCells(this.trackView(), this.selection, this.cursor);
    this.patternMenu.refresh();
  }

  // Edit > Cut: a copy, then what Delete clears (the field at the cursor, without a selection)
  cut() {
    if (!this.canEdit())
      return;
    this.copy();
    this.applyWrites(edit.clearCells(this.trackView(), this.selection ?? edit.cursorSelection(this.cursor)));
  }

  // Edit > Paste and Paste Special: `mode` is PASTE.*, and where it goes Paste Special's
  // choice (at the cursor, at the selection, or filling the selection). What was pasted is
  // selected after it.
  paste(mode = PASTE.DEFAULT) {
    if (!this.canEdit() || !this.clipboard)
      return;
    const { writes, target, repeated } = edit.paste(this.trackView(), this.clipboard, {
      mode, at: this.pastePos, cursor: this.cursor, selection: this.selection, overflow: this.overflowPaste,
    });
    if (repeated && !confirm(this.strings.confirmPasteRepeated))
      return;
    const after = { cursor: { ...this.cursor }, selStart: target.start, selEnd: target.end, block: false };
    if (this.applyWrites(writes, after))
      this.restoreEditState(after);
  }

  // ---- selections ------------------------------------------------------------------------

  // Ctrl+A: the cursor's channel in this frame, and when it is selected, every channel
  // (CPatternEditor::SelectAll())
  selectAll() {
    const { frame, channel } = this.cursor;
    const s = this.selection;
    const whole = s && s.start.channel === channel && s.end.channel === channel && s.start.frame === frame &&
      s.end.frame === frame && s.start.row === 0 && s.end.row === this.tr.rows - 1 && s.start.column === 0 &&
      s.end.column === this.columns(channel) - 1;
    this.selectScope('frame', whole ? 'all' : 'channel');
  }

  // Edit > Select (CPatternEditor::SetSelection()): rows 'row' (the cursor's), 'frame' or
  // 'track', across channels 'column' (the cursor's column), 'channel' or 'all'
  selectScope(rows, channels) {
    const tr = this.tr;
    const start = { ...this.cursor }, end = { ...this.cursor };
    if (rows === 'track') {
      start.frame = 0;
      end.frame = tr.frames - 1;
    }
    if (rows !== 'row') {
      start.row = 0;
      end.row = tr.rows - 1;
    }
    if (channels === 'all') {
      start.channel = 0;
      end.channel = this.channelCount - 1;
    }
    if (channels !== 'column') {
      start.column = 0;
      end.column = this.columns(end.channel) - 1;
    }
    this.select(start, end);
  }

  // ---- the Pattern menu -------------------------------------------------------------------

  // The selection, for the edits that move rows around: refused without one, and where a
  // channel plays a row twice (CPatternAction::ValidateSelection())
  rowSelection() {
    if (!this.selection)
      this.message(this.strings.needSelection, true);
    else if (edit.repeatsRows(this.trackView(), this.selection))
      this.message(this.strings.repeatedRows, true);
    else
      return this.selection;
    return null;
  }

  // Pattern > Transpose: the notes of the selection, or the one at the cursor
  transpose(semitones) {
    if (this.canEdit())
      this.applyWrites(edit.transpose(this.trackView(), this.selection, this.cursor, semitones));
  }

  // Shift+F1-F4: the values of the selection, or the field at the cursor, by `amount`
  scrollValues(amount) {
    if (this.canEdit())
      this.applyWrites(edit.scrollValues(this.trackView(), this.selection, this.cursor, amount));
  }

  interpolate() {
    const sel = this.canEdit() && this.rowSelection();
    if (sel)
      this.applyWrites(edit.interpolate(this.trackView(), sel));
  }

  reverse() {
    const sel = this.canEdit() && this.rowSelection();
    if (sel)
      this.applyWrites(edit.reverse(this.trackView(), sel));
  }

  // Pattern > Expand ([1, 0]), Shrink ([2]) and Stretch
  stretch(map) {
    const sel = this.canEdit() && this.rowSelection();
    if (sel)
      this.applyWrites(edit.stretch(this.trackView(), sel, map));
  }

  // Pattern > Replace Instrument: the instrument in use, in the selection
  replaceInstrument() {
    if (!this.canEdit())
      return;
    if (!this.selection) {
      this.message(this.strings.needSelection, true);
      return;
    }
    this.applyWrites(edit.replaceInstrument(this.trackView(), this.selection, this.instrument));
  }

  // Pick Up Row (the pattern's right-click menu): the instrument at the cursor becomes the
  // one in use, its volume the one notes get with the volume mask off
  // (CFamiTrackerView::OnPickupRow())
  pickUpRow() {
    const cell = this.cellHere();
    this.lastVolume = cell[2];
    if (cell[3] < MAX_INSTRUMENTS)
      this.selectInstrument(cell[3], { quiet: true });
    const t = this.strings;
    this.message(t.pickedUp.replace('%1', cell[3] < MAX_INSTRUMENTS ? hex2(cell[3]) : '—')
      .replace('%2', cell[2] < MAX_VOLUME ? cell[2].toString(16).toUpperCase() : '—'));
  }

  // Edit > Instrument Mask and Volume Mask (Alt+T, Alt+V)
  setMask(which) {
    const t = this.strings;
    if (which === 'instrument')
      this.maskInstrument = !this.maskInstrument;
    else
      this.maskVolume = !this.maskVolume;
    const on = which === 'instrument' ? this.maskInstrument : this.maskVolume;
    this.message((which === 'instrument' ? t.instrumentMask : t.volumeMask) + (on ? t.maskOn : t.maskOff));
  }

  // Ctrl+Up / Ctrl+Down: the instrument before or after the one in use, in the list
  stepInstrument(delta) {
    const list = this.song.instruments;
    const at = list.findIndex(i => i.index === this.instrument);
    const next = at >= 0 ? list[at + delta] :
      delta > 0 ? list.find(i => i.index > this.instrument) : list.findLast(i => i.index < this.instrument);
    if (next)
      this.selectInstrument(next.index, { quiet: true });
  }

  // ---- bookmarks ----------------------------------------------------------------------------

  // The track's bookmarks in place of those it has, as one action (the desktop cannot undo
  // them)
  setBookmarks(list) {
    const track = this.track;
    const old = this.tr.bookmarks;
    const apply = value => {
      this.showTrack(track);
      this.song.track(track).bookmarks = value;
      this.session.send('setBookmarks', track, value);
      this.bookmarksChanged();
    };
    apply(list);
    this.record({ undo: () => apply(old), redo: () => apply(list) });
  }

  bookmarksChanged() {
    this.view.invalidate();
    this.renderFrames();
    this.patternMenu.refresh();
  }

  // Ctrl+K: a bookmark on the cursor's row, or none (CFamiTrackerView::OnBookmarksToggle())
  toggleBookmark() {
    if ((this.playing && this.follow) || !this.canEdit())
      return;
    const { frame, row } = this.cursor;
    const list = this.tr.bookmarks;
    if (edit.bookmarkAt(list, frame, row))
      this.setBookmarks(list.filter(mark => mark.frame !== frame || mark.row !== row));
    else
      this.setBookmarks([...list, { frame, row, name: this.strings.bookmarkName.replace('%1', list.length + 1), highlight: [-1, -1], persist: false }]);
  }

  // Ctrl+PageDown / Ctrl+PageUp: the next or the previous bookmark, round the track
  gotoBookmark(direction) {
    if (this.playing && this.follow)
      return;
    const t = this.strings;
    const { frame, row } = this.cursor;
    const list = this.tr.bookmarks;
    const mark = direction > 0 ? edit.nextBookmark(list, frame, row) : edit.previousBookmark(list, frame, row);
    if (!mark) {
      this.message(t.noBookmarks);
      return;
    }
    this.setCursor({ ...this.cursor, frame: mark.frame, row: mark.row }, { keep: true });
    const highlight = value => value === -1 ? t.bookmarkNone : value;
    this.message(t.movedToBookmark.replace('%1', mark.name).replace('%2', highlight(mark.highlight[0])).replace('%3', highlight(mark.highlight[1])));
  }

  async restoreBookmarks(track, list) {
    this.session.send('setBookmarks', track, list);
    await this.reloadTrack(track);
    this.bookmarksChanged();
  }

  // ---- frames -------------------------------------------------------------------------

  async reloadTrack(track = this.track) {
    this.song.setTrackData(track, await this.session.call('trackData', track));
  }

  // The frame list as it is, and the bookmarks, which move with the frames, to go back to
  frameState() {
    const tr = this.tr;
    return { frames: tr.frames, list: Uint8Array.from(tr.frameList.subarray(0, tr.frames * this.channelCount)), bookmarks: tr.bookmarks };
  }

  async restoreFrames(track, state, clear = []) {
    this.session.send('setFrameList', track, state.frames, state.list);
    this.session.send('setBookmarks', track, state.bookmarks);
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
    this.patternMenu.refresh();
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

  // After a change of the module's properties: what the page shows of them
  async reloadInfo() {
    this.song.info = await this.session.call('info');
    this.renderSongPanel();
    this.edited();
  }

  async setSongText(field, value) {
    const method = { title: 'setTitle', artist: 'setArtist', copyright: 'setCopyright' }[field];
    await this.session.call(method, value);
    await this.reloadInfo();
  }

  async setTrackTitle(title) {
    if (title === this.song.info.tracks[this.track])
      return;
    await this.session.call('setTrackTitle', this.track, title);
    await this.reloadInfo();
  }

  // Module > Comments
  openComment() {
    const { els } = this;
    this.commentSong = this.song;
    els.commentText.value = this.song.info.comment;
    els.showComment.checked = this.song.info.showComment;
    if (!els.commentDialog.open)
      els.commentDialog.showModal();
    els.commentText.focus();
  }

  // What the comment box holds, to the module: as it is typed away from, and on closing
  saveComment() {
    const { els } = this;
    if (this.commentSong !== this.song)
      return;
    const text = els.commentText.value, show = els.showComment.checked;
    const info = this.song.info;
    if (text === info.comment && show === info.showComment)
      return;
    this.song.info = { ...info, comment: text, showComment: show };
    this.session.send('setComment', text, show);
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
    // fewer rows or frames take the bookmarks on them along; undo brings them back
    const bookmarks = tr.bookmarks;
    await apply(value);
    const applied = { speed: this.tr.speed, tempo: this.tr.tempo, rows: this.tr.rows, frames: this.tr.frames, beat: this.tr.highlight[0], bar: this.tr.highlight[1] }[name];
    this.record({
      undo: async () => {
        await apply(current[name]);
        if (name === 'rows' || name === 'frames')
          await this.restoreBookmarks(track, bookmarks);
      },
      redo: () => apply(applied),
    });
  }

  // The control panel's Speed / Groove button: the speed is then a groove's number. The
  // speed goes into the range of the other kind; undoing brings it back.
  async setGrooveMode(on) {
    const track = this.track;
    const before = { groove: this.tr.groove, speed: this.tr.speed };
    if (before.groove === on)
      return;
    const apply = async ({ groove, speed }) => {
      await this.session.call('setGrooveMode', track, groove);
      if (speed !== undefined)
        await this.session.call('setSpeed', track, speed);
      await this.reloadTrack(track);
      this.showTrack(track);
      this.renderSongPanel();
    };
    await apply({ groove: on });
    const after = { groove: on, speed: this.song.track(track).speed };
    this.record({ undo: () => apply(before), redo: () => apply(after) });
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
    await this.reloadInfo();
  }

  // The properties below reset the sound generator (session_bindings.cpp), which stops
  // what plays

  // Engine ticks per second, 0 for the machine's (Module > Engine Speed)
  async setEngineSpeed(hz) {
    const speed = hz ? Math.max(ENGINE_RATE_MIN, Math.min(ENGINE_RATE_MAX, Math.round(hz))) : 0;
    if (!Number.isFinite(speed) || speed === this.song.info.engineSpeed) {
      this.renderSongPanel();
      return;
    }
    this.stopPlaying();
    await this.session.call('setEngineSpeed', speed);
    await this.reloadInfo();
  }

  async setVibratoStyle(newStyle) {
    if (newStyle === this.song.info.newVibrato)
      return;
    this.stopPlaying();
    await this.session.call('setVibratoStyle', newStyle);
    await this.reloadInfo();
  }

  async setLinearPitch(linear) {
    if (linear === this.song.info.linearPitch)
      return;
    this.stopPlaying();
    await this.session.call('setLinearPitch', linear);
    await this.reloadInfo();
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
    this.deselect();
    this.renderAll();
    this.setCursor(this.cursor);
  }

  // ---- tracks ---------------------------------------------------------------------------

  // Shows a track whose data is loaded (for undo)
  showTrack(track) {
    if (track === this.track)
      return;
    this.track = track;
    this.deselect();
    this.renderAll();
  }

  async selectTrack(track) {
    this.stopPlaying();
    if (!this.song.track(track))
      await this.reloadTrack(track);
    this.track = track;
    this.cursor = { frame: 0, row: 0, channel: this.cursor.channel, column: 0 };
    this.deselect();
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

  // Module properties > Move up / Move down, with the track shown
  async moveTrack(up) {
    const track = this.track;
    const other = up ? track - 1 : track + 1;
    this.stopPlaying();
    if (!await this.session.call('moveTrack', track, up))
      return;
    const tracks = this.song.tracks;
    [tracks[track], tracks[other]] = [tracks[other], tracks[track]];
    this.song.info = await this.session.call('info');
    this.track = other;
    // what can be undone knows the tracks by number
    this.history.clear();
    this.renderAll();
    this.edited();
  }

  // After what changes tracks besides the one shown: the page reads its copies of them
  // again (undo may show any of them)
  async reloadTracks() {
    this.song.info = await this.session.call('info');
    const count = this.song.info.tracks.length;
    const loaded = this.song.tracks.map((data, t) => data && t < count ? t : -1).filter(t => t >= 0);
    this.song.tracks = [];
    for (const t of new Set([this.track, ...loaded]))
      await this.reloadTrack(t);
    this.renderAll();
    this.setCursor(this.cursor);
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

  // Pattern > Swap Channels: two channels give each other their patterns, the patterns
  // their frames play and their effect columns, in the track or in every track. Undone by
  // swapping them again (the desktop's cannot be undone).
  async swapChannels(first, second, allTracks) {
    const t = this.strings;
    if (first === second)
      return;
    const track = this.track;
    const tracks = allTracks ? this.song.info.tracks.map((_, i) => i) : [track];
    const apply = async () => {
      this.stopPlaying();
      for (const i of tracks)
        await this.session.call('swapChannels', i, first, second);
      // the page's copies of the tracks, read again
      for (const i of tracks)
        if (this.song.track(i))
          await this.reloadTrack(i);
      this.track = track;
      this.deselect();
      this.renderAll();
      this.setCursor(this.cursor);
    };
    await apply();
    this.record({ undo: apply, redo: apply });
    this.message(t.swapped.replace('%1', this.song.channels[first].name).replace('%2', this.song.channels[second].name));
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

  // deep: with copies of the sequences, not sharing them
  async cloneInstrument({ deep = false } = {}) {
    const index = await this.session.call(deep ? 'deepCloneInstrument' : 'cloneInstrument', this.instrument).catch(() => -1);
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

  // Instrument files (.fti) become instruments of the module, each in the next free number
  // (with the DPCM samples they carry); the last one is the instrument in use
  async loadInstruments(files) {
    const t = this.strings;
    const chips = this.song.info.chips;
    let last = -1, count = 0, missingChip = null, failure = null;
    for (const file of files) {
      try {
        const index = await this.session.call('loadInstrument', new Uint8Array(await file.arrayBuffer()));
        last = index;
        ++count;
        const info = await this.session.call('instrument', index);
        const chip = INSTRUMENT_CHIP[info.type];
        if (chip && !(chips & chip))
          missingChip = CHIPS.find(([, bit]) => bit === chip)?.[0] ?? null;
      } catch (e) {
        // the ones before it stay
        failure = `${file.name}: ${e.message}`;
        break;
      }
    }
    let done = '';
    if (last >= 0) {
      await this.refreshInstruments();
      this.selectInstrument(last, { quiet: true });
      this.changedInstruments();
      const named = count === 1 ? files[0].name : t.instrumentsLoaded.replace('%1', count);
      done = t.instrumentLoaded + named + (missingChip ? t.instrumentChipMissing.replace('%1', missingChip) : '');
    }
    if (failure)
      this.message(done ? `${done} — ${failure}` : failure, true);
    else
      this.message(done, !!missingChip);
  }

  // The instrument as an .fti file
  async saveInstrumentFile(index = this.instrument) {
    const t = this.strings;
    const info = this.song.instrument(index);
    if (!info)
      return;
    try {
      const bytes = await this.session.call('saveInstrument', index);
      const name = `${info.name.replace(/[\/:*?"<>|\u0000-\u001f]/g, ' ').trim() || t.instrumentFileName}.fti`;
      this.files.download(name, new Blob([bytes], { type: 'application/octet-stream' }));
      this.message(t.saved + name);
    } catch (e) {
      this.message(t.failed + e.message, true);
    }
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
      case 'comment': return this.openComment();
      case 'add-track': return this.addTrack();
      case 'remove-track': return this.removeTrack();
      case 'track-up': return this.moveTrack(true);
      case 'track-down': return this.moveTrack(false);
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
      case 'deep-clone-instrument': return this.cloneInstrument({ deep: true });
      case 'remove-instrument': return this.removeInstrument();
      case 'edit-instrument': return this.song.instrument(this.instrument) && this.instrumentEditor.open(this.instrument);
      case 'load-instrument': return this.els.instrumentFile.click();
      case 'save-instrument': return this.saveInstrumentFile();
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

    const modifiers = (ctrl ? 'C' : '') + (e.altKey ? 'A' : '') + (shift ? 'S' : '');
    const command = modifiers && KEYS[`${modifiers}+${e.code}`];
    if (command) {
      done();
      command(this);
      return;
    }
    if (ctrl || e.altKey) {
      // Ctrl and the clear field key: the whole cell
      if (ctrl && !e.altKey && e.code === 'Minus' && this.editMode) {
        done();
        this.clearKey(true);
      }
      return;
    }

    switch (e.code) {
      case 'ArrowUp': done(); return this.moveByStep(-1, shift);
      case 'ArrowDown': done(); return this.moveByStep(1, shift);
      case 'ArrowLeft': done(); return this.moveColumn(-1, shift);
      case 'ArrowRight': done(); return this.moveColumn(1, shift);
      case 'PageUp': done(); return this.moveRows(-PAGE_ROWS, shift);
      case 'PageDown': done(); return this.moveRows(PAGE_ROWS, shift);
      case 'Home': done(); return this.setCursor({ ...this.cursor, row: 0 }, { extend: shift });
      case 'End': done(); return this.setCursor({ ...this.cursor, row: this.tr.rows - 1 }, { extend: shift });
      case 'Tab': done(); return this.moveChannel(shift ? -1 : 1);
      case 'Space': done(); return this.setEditMode(!this.editMode);
      case 'Enter': case 'NumpadEnter': done(); return this.togglePlay();
      case 'Escape': done(); return this.deselect();
      case 'NumpadDivide': done(); return this.setOctave(this.octave - 1);
      case 'NumpadMultiply': done(); return this.setOctave(this.octave + 1);
      // the desktop's Increase pattern / Decrease pattern
      case 'NumpadAdd': done(); return this.action('pattern-up');
      case 'NumpadSubtract': done(); return this.action('pattern-down');
    }
    // the numeric keypad in the note column picks an instrument (CFamiTrackerView::OnKeyDown())
    if (column === 0 && /^Numpad[0-9]$/.test(e.code)) {
      done();
      return this.selectInstrument(Number(e.code.at(-1)), { quiet: true });
    }
    if (!this.editMode && !(column === 0 && NOTE_KEYS[e.code]))
      return;
    switch (e.code) {
      case 'Delete': done(); return this.clear({ pullUp: shift });
      case 'Insert': done(); return this.insertRow();
      case 'Backspace': done(); return this.deleteRowAbove();
      case 'Minus': done(); return this.clearKey(false);
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
      if (!key)
        return;
      done();
      const note = NOTE.C + key[0];
      const octave = Math.min(OCTAVES - 1, this.octave + key[1]);
      if (!e.repeat && this.previews())
        this.held.set(e.code, this.noteOn(this.cursor.channel, note, octave));
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

  // As the desktop's: a click puts the cursor on the cell (once the button is let go), a
  // drag from it selects and leaves the cursor where it was; near the top or bottom the
  // rows scroll (CPatternEditor::AutoScroll()). On the row numbers, a click goes to the row
  // and a drag selects whole rows. Shift extends the selection to the cell.
  onGridPointerDown(e) {
    if (e.target !== this.view.canvas || e.button !== 0)
      return;
    const place = this.view.hit(e.clientX, e.clientY);
    this.view.scroller.focus({ preventScroll: true });
    if (!place)
      return;
    if (place.channel === null) {
      this.deselect();
      this.drag = { rows: true, start: { frame: place.frame, row: place.row, channel: 0, column: 0 }, click: { ...this.cursor, frame: place.frame, row: place.row } };
    } else if (e.shiftKey) {
      this.select(this.selection ? this.selStart : this.cursor, place, this.block);
      this.drag = { start: this.selStart, moved: true };
    } else {
      this.deselect();
      this.drag = { start: place, click: place };
    }
    this.drag.pointer = { x: e.clientX, y: e.clientY };
    this.dragging = true;
    this.view.scroller.setPointerCapture(e.pointerId);
  }

  onGridPointerMove(e) {
    if (!this.drag)
      return;
    this.drag.pointer = { x: e.clientX, y: e.clientY };
    this.dragTo();
    this.autoScroll();
  }

  // The selection from where the drag started to the cell under the pointer
  dragTo() {
    const { drag } = this;
    const place = this.view.hit(drag.pointer.x, drag.pointer.y, { clamp: true });
    if (!place)
      return;
    if (drag.rows) {
      const last = this.channelCount - 1;
      if (drag.moved || place.frame !== drag.start.frame || place.row !== drag.start.row) {
        drag.moved = true;
        this.select(drag.start, { frame: place.frame, row: place.row, channel: last, column: this.columns(last) - 1 });
      }
      return;
    }
    const start = drag.start;
    if (!drag.moved && place.frame === start.frame && place.row === start.row && place.channel === start.channel && place.column === start.column)
      return;
    drag.moved = true;
    this.select(start, place);
  }

  // While the pointer is at the top or bottom line, or past them, the rows scroll by
  autoScroll() {
    const { drag } = this;
    const rect = this.view.canvas.getBoundingClientRect();
    const line = this.view.rowHeight;
    drag.direction = drag.pointer.y < rect.top + line ? -1 : drag.pointer.y > rect.bottom - line ? 1 : 0;
    if (!drag.direction || drag.timer)
      return;
    drag.timer = setInterval(() => {
      if (this.drag !== drag || !drag.direction) {
        clearInterval(drag.timer);
        drag.timer = null;
        return;
      }
      const { rows, frames } = this.tr;
      const at = this.cursor.frame * rows + this.cursor.row + drag.direction;
      if (at < 0 || at >= rows * frames)
        return;
      this.setCursor({ ...this.cursor, frame: Math.floor(at / rows), row: at % rows }, { keep: true });
      this.dragTo();
    }, 40);
  }

  // The button let go (`click`: a click without a drag moves the cursor), or the drag
  // called off
  endDrag(click = false) {
    const drag = this.drag;
    if (drag?.timer)
      clearInterval(drag.timer);
    this.drag = null;
    this.dragging = false;
    if (click && drag?.click && !drag.moved)
      this.setCursor(drag.click);
  }

  // A double click selects the channel in the frame; on the row numbers, the frame
  // (CPatternEditor::OnMouseDblClk())
  onGridDoubleClick(e) {
    if (e.target !== this.view.canvas || e.shiftKey)
      return;
    const place = this.view.hit(e.clientX, e.clientY);
    if (place)
      this.selectScope('frame', place.channel === null ? 'all' : 'channel');
  }

  // The right button: the cursor goes to the cell, the selection stays, and the desktop's
  // menu opens (IDR_PATTERN_POPUP)
  onGridContextMenu(e) {
    if (e.target !== this.view.canvas)
      return;
    e.preventDefault();
    this.endDrag();
    const place = this.view.hit(e.clientX, e.clientY);
    if (place && place.channel !== null)
      this.setCursor(place, { keep: true });
    this.patternMenu.openContextMenu(e.clientX, e.clientY);
  }

  // The wheel moves the rows; with Ctrl it transposes, with Shift (editing) it changes the
  // values, with both it goes from frame to frame (CFamiTrackerView::OnMouseWheel())
  onGridWheel(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
    const delta = vertical ? e.deltaY : e.deltaX;
    if (ctrl || (e.shiftKey && this.editMode)) {
      // a notch at a time: the small steps of a touchpad (and its pinch) are left alone
      if (e.deltaMode === 0 && Math.abs(delta) < 50)
        return;
      e.preventDefault();
      const direction = delta < 0 ? 1 : -1;
      if (ctrl && e.shiftKey)
        this.setCursor({ ...this.cursor, frame: this.cursor.frame - direction });
      else if (ctrl)
        this.editMode && this.transpose(direction);
      else
        this.scrollValues(direction);
      return;
    }
    if (e.shiftKey || !vertical)
      return;
    e.preventDefault();
    this.wheel = (this.wheel ?? 0) + (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY);
    const rows = Math.trunc(this.wheel / 32);
    if (rows) {
      this.wheel -= rows * 32;
      // as the desktop's, the wheel keeps the selection
      const { rows: length, frames } = this.tr;
      const total = length * frames;
      const at = (((this.cursor.frame * length + this.cursor.row + rows) % total) + total) % total;
      this.setCursor({ ...this.cursor, frame: Math.floor(at / length), row: at % length }, { keep: true });
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
    const speed = root.querySelector('[data-setting="speed"]');
    speed.min = tr.groove ? 0 : 1;
    speed.max = tr.groove ? 31 : tr.tempo ? info.speedSplitPoint - 1 : 255;
    speed.title = tr.groove ? this.strings.grooveModeHint : this.strings.speedHint;
    els.grooveMode.checked = tr.groove;
    root.querySelector('[data-setting="tempo"]').min = info.speedSplitPoint;
    const commentLine = info.comment.split('\n').find(line => line.trim()) ?? '';
    els.comment.textContent = commentLine || this.strings.noComment;
    els.comment.classList.toggle('is-empty', !commentLine);
    els.track.replaceChildren(...info.tracks.map((title, i) => new Option(`${hex2(i + 1)} ${title}`, i)));
    els.track.value = this.track;
    if (document.activeElement !== els.trackTitle)
      els.trackTitle.value = info.tracks[this.track] ?? '';
    root.querySelector('[data-action="remove-track"]').disabled = info.tracks.length < 2;
    root.querySelector('[data-action="track-up"]').disabled = this.track === 0;
    root.querySelector('[data-action="track-down"]').disabled = this.track >= info.tracks.length - 1;
    for (const box of els.chips.querySelectorAll('input'))
      box.checked = (info.chips & Number(box.value)) !== 0;
    els.n163.value = info.namcoChannels || 1;
    els.n163.disabled = !(info.chips & CHIP.N163);
    els.machine.value = info.pal ? '1' : '0';
    els.machine.disabled = info.chips !== 0;
    els.engineMode.value = info.engineSpeed ? '1' : '0';
    els.engineRate.value = info.frameRate;
    els.engineRate.disabled = !info.engineSpeed;
    els.vibrato.value = info.newVibrato ? '1' : '0';
    els.linearPitch.value = info.linearPitch ? '1' : '0';
  }

  renderFrames() {
    const { els } = this;
    const tr = this.tr;
    const channels = this.channelCount;
    const { frame: current, channel: currentChannel } = this.cursor;
    const marked = new Set(tr.bookmarks.map(mark => mark.frame));
    const rows = [];
    for (let f = 0; f < tr.frames; ++f) {
      const row = document.createElement('div');
      row.className = 'dnft-frame-row';
      row.classList.toggle('is-current', f === current);
      row.classList.toggle('is-playing', !!this.play && this.play.frame === f);
      row.classList.toggle('is-bookmarked', marked.has(f));
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
    for (const action of ['clone-instrument', 'deep-clone-instrument'])
      panel.querySelector(`[data-action="${action}"]`).disabled = !exists || song.instruments.length >= MAX_INSTRUMENTS;
    panel.querySelector('[data-action="edit-instrument"]').disabled = !exists;
    panel.querySelector('[data-action="save-instrument"]').disabled = !exists;
    panel.querySelector('[data-action="load-instrument"]').disabled = song.instruments.length >= MAX_INSTRUMENTS;
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

// Dn-FamiTracker web port - the editor's shortcuts, as the desktop tracker's accelerator
// table (CAccelerator::DEFAULT_TABLE) has them: each command has the keys it is set to by
// default, which Configuration > Keys changes and the browser keeps. A key is written as its
// modifiers (C Ctrl or Cmd, A Alt, S Shift, in that order) and the code of the key (the
// key's place on the keyboard, whatever the layout): 'C+KeyZ', 'CS+ArrowUp', 'F5'.
//
//   const keymap = new Keymap();
//   keymap.lookup(event)?.run(editor);
//
// Ctrl+F4, Ctrl+W, Ctrl+T and some others never reach a page: the browser keeps them.

import { PLAY } from './dnft-session.mjs';
import { PASTE } from './dnft-pattern-edit.mjs';

const STORAGE_KEY = 'dnft-editor.keys';

// `global`: works wherever in the editor the keyboard is, in the text fields too; `hidden`:
// not offered for changing. `group` is how the commands are listed.
export const COMMANDS = [
  { id: 'open', group: 'file', keys: ['C+KeyO'], global: true, run: e => e.action('open') },
  { id: 'exportNsf', group: 'file', keys: ['C+KeyE'], global: true, run: e => e.files.exportNsf() },
  { id: 'exportWave', group: 'file', keys: ['CS+KeyE'], global: true, run: e => e.files.exportWave() },
  { id: 'moduleProperties', group: 'file', keys: ['C+KeyP'], global: true, run: e => e.openModuleProperties() },
  { id: 'toggleSpeedSplit', group: 'file', keys: ['CS+KeyS'], global: true, run: e => e.toggleSpeedSplit() },
  { id: 'toggleN163Multiplexing', group: 'file', keys: ['CS+KeyM'], global: true, run: e => e.toggleN163Multiplexing() },
  { id: 'toggleControlPanel', group: 'file', keys: [], run: e => e.trackerMenu.setOption('side', !e.trackerMenu.options.side) },
  { id: 'effectTable', group: 'file', keys: [], run: e => e.trackerMenu.help.openEffects() },

  { id: 'playSong', group: 'play', keys: ['F5'], global: true, run: e => e.startPlaying(PLAY.SONG) },
  { id: 'playPattern', group: 'play', keys: ['F6'], global: true, run: e => e.startPlaying(PLAY.PATTERN) },
  { id: 'playCursor', group: 'play', keys: ['F7'], global: true, run: e => e.startPlaying(PLAY.CURSOR) },
  { id: 'playMarker', group: 'play', keys: ['C+F7'], global: true, run: e => e.trackerMenu.playMarker() },
  { id: 'stop', group: 'play', keys: ['F8'], global: true, run: e => e.stopPlaying() },
  { id: 'playRow', group: 'play', keys: ['C+Enter', 'C+NumpadEnter'], run: e => e.trackerMenu.playRow() },
  { id: 'setMarker', group: 'play', keys: ['C+KeyB'], run: e => e.trackerMenu.setMarker() },
  { id: 'killSound', group: 'play', keys: ['F12'], global: true, run: e => e.trackerMenu.killSound() },
  { id: 'toggleChannel', group: 'play', keys: ['A+F9'], run: e => e.toggleMute(e.cursor.channel, false) },
  { id: 'soloChannel', group: 'play', keys: ['A+F10'], run: e => e.toggleMute(e.cursor.channel, true) },
  { id: 'toggleChip', group: 'play', keys: ['CA+F9'], run: e => e.trackerMenu.toggleChip(e.cursor.channel, false) },
  { id: 'soloChip', group: 'play', keys: ['CA+F10'], run: e => e.trackerMenu.toggleChip(e.cursor.channel, true) },

  { id: 'undo', group: 'edit', keys: ['C+KeyZ', 'A+Backspace'], run: e => e.undo() },
  { id: 'redo', group: 'edit', keys: ['C+KeyY', 'CS+KeyZ'], run: e => e.redo() },
  { id: 'copy', group: 'edit', keys: ['C+KeyC', 'C+Insert'], run: e => e.copy() },
  { id: 'cut', group: 'edit', keys: ['C+KeyX'], run: e => e.cut() },
  { id: 'paste', group: 'edit', keys: ['C+KeyV', 'S+Insert'], run: e => e.paste() },
  { id: 'pasteMix', group: 'edit', keys: ['C+KeyM'], run: e => e.paste(PASTE.MIX) },
  { id: 'pasteOverwrite', group: 'edit', keys: [], run: e => e.activeEditor === 'frames' ? e.frameEditor.paste('overwrite') : e.paste(PASTE.OVERWRITE) },
  { id: 'pasteInsert', group: 'edit', keys: [], run: e => e.paste(PASTE.INSERT) },
  { id: 'pickUpRow', group: 'edit', keys: [], run: e => e.pickUpRow() },
  { id: 'expand', group: 'edit', keys: [], run: e => e.stretch([1, 0]) },
  { id: 'shrink', group: 'edit', keys: [], run: e => e.stretch([2]) },
  { id: 'stretch', group: 'edit', keys: [], run: e => e.patternMenu.openStretch() },
  { id: 'selectAll', group: 'edit', keys: ['C+KeyA'], run: e => e.selectAll() },
  { id: 'selectRow', group: 'edit', keys: [], run: e => e.selectScope('row', 'all') },
  { id: 'selectColumn', group: 'edit', keys: [], run: e => e.selectScope('frame', 'column') },
  { id: 'selectPattern', group: 'edit', keys: [], run: e => e.activeEditor === 'frames' ? e.frameEditor.selectScope('pattern') : e.selectScope('frame', 'channel') },
  { id: 'selectFrame', group: 'edit', keys: [], run: e => e.activeEditor === 'frames' ? e.frameEditor.selectScope('frame') : e.selectScope('frame', 'all') },
  { id: 'selectChannel', group: 'edit', keys: [], run: e => e.activeEditor === 'frames' ? e.frameEditor.selectScope('channel') : e.selectScope('track', 'channel') },
  { id: 'selectTrack', group: 'edit', keys: [], run: e => e.activeEditor === 'frames' ? e.frameEditor.selectScope('track') : e.selectScope('track', 'all') },
  { id: 'selectOther', group: 'edit', keys: [], run: e => e.frameEditor.selectInOtherEditor() },
  { id: 'blockStart', group: 'edit', keys: ['A+KeyB'], run: e => e.setBlock(true) },
  { id: 'blockEnd', group: 'edit', keys: ['A+KeyE'], run: e => e.setBlock(false) },
  { id: 'interpolate', group: 'edit', keys: ['C+KeyG'], run: e => e.interpolate() },
  { id: 'reverse', group: 'edit', keys: ['C+KeyR'], run: e => e.reverse() },
  { id: 'replaceInstrument', group: 'edit', keys: ['A+KeyS'], run: e => e.replaceInstrument() },
  { id: 'transposeDown', group: 'edit', keys: ['C+F1'], run: e => e.transpose(-1) },
  { id: 'transposeUp', group: 'edit', keys: ['C+F2'], run: e => e.transpose(1) },
  { id: 'transposeOctaveDown', group: 'edit', keys: ['C+F3', 'CS+ArrowDown'], run: e => e.transpose(-12) },
  { id: 'transposeOctaveUp', group: 'edit', keys: ['C+F4', 'CS+ArrowUp'], run: e => e.transpose(12) },
  { id: 'valuesDown', group: 'edit', keys: ['S+F1'], run: e => e.scrollValues(-1) },
  { id: 'valuesUp', group: 'edit', keys: ['S+F2'], run: e => e.scrollValues(1) },
  { id: 'valuesCoarseDown', group: 'edit', keys: ['S+F3'], run: e => e.scrollValues(-16) },
  { id: 'valuesCoarseUp', group: 'edit', keys: ['S+F4'], run: e => e.scrollValues(16) },
  { id: 'maskInstrument', group: 'edit', keys: ['A+KeyT'], run: e => e.setMask('instrument') },
  { id: 'maskVolume', group: 'edit', keys: ['A+KeyV'], run: e => e.setMask('volume') },

  { id: 'prevFrame', group: 'move', keys: ['C+ArrowLeft'], run: e => e.setCursor({ ...e.cursor, frame: e.cursor.frame - 1 }) },
  { id: 'nextFrame', group: 'move', keys: ['C+ArrowRight'], run: e => e.setCursor({ ...e.cursor, frame: e.cursor.frame + 1 }) },
  { id: 'stepUp', group: 'move', keys: ['A+ArrowUp'], run: e => e.moveRows(-1) },
  { id: 'stepDown', group: 'move', keys: ['A+ArrowDown'], run: e => e.moveRows(1) },
  { id: 'channelLeft', group: 'move', keys: ['A+ArrowLeft'], run: e => e.moveChannelKeepingColumn(-1) },
  { id: 'channelRight', group: 'move', keys: ['A+ArrowRight'], run: e => e.moveChannelKeepingColumn(1) },
  { id: 'stepUpExtend', group: 'move', keys: ['AS+ArrowUp'], hidden: true, run: e => e.moveRows(-1, true) },
  { id: 'stepDownExtend', group: 'move', keys: ['AS+ArrowDown'], hidden: true, run: e => e.moveRows(1, true) },
  { id: 'channelLeftExtend', group: 'move', keys: ['AS+ArrowLeft'], hidden: true, run: e => e.moveChannelKeepingColumn(-1, true) },
  { id: 'channelRightExtend', group: 'move', keys: ['AS+ArrowRight'], hidden: true, run: e => e.moveChannelKeepingColumn(1, true) },
  { id: 'toggleBookmark', group: 'move', keys: ['C+KeyK'], run: e => e.toggleBookmark() },
  { id: 'nextBookmark', group: 'move', keys: ['C+PageDown'], run: e => e.gotoBookmark(1) },
  { id: 'prevBookmark', group: 'move', keys: ['C+PageUp'], run: e => e.gotoBookmark(-1) },
  { id: 'toggleFind', group: 'move', keys: ['C+KeyF'], run: e => e.patternMenu.toggleFind() },
  { id: 'findNext', group: 'move', keys: [], run: e => e.patternMenu.findFromMenu(1) },
  { id: 'findPrevious', group: 'move', keys: [], run: e => e.patternMenu.findFromMenu(-1) },
  { id: 'focusPattern', group: 'move', keys: ['F2'], global: true, run: e => e.focusPatternEditor() },
  { id: 'focusFrames', group: 'move', keys: ['F3'], global: true, run: e => e.focusFrameEditor() },
  { id: 'follow', group: 'move', keys: ['ScrollLock'], global: true, run: e => e.action('follow') },
  { id: 'nextSong', group: 'move', keys: [], run: e => e.stepTrack(1) },
  { id: 'prevSong', group: 'move', keys: [], run: e => e.stepTrack(-1) },
  { id: 'goto', group: 'move', keys: ['A+KeyG'], run: e => e.patternMenu.openGoto() },

  { id: 'prevInstrument', group: 'song', keys: ['C+ArrowUp'], run: e => e.stepInstrument(-1) },
  { id: 'nextInstrument', group: 'song', keys: ['C+ArrowDown'], run: e => e.stepInstrument(1) },
  { id: 'editInstrument', group: 'song', keys: ['C+KeyI'], run: e => e.action('edit-instrument') },
  { id: 'duplicateFrame', group: 'song', keys: ['C+KeyD'], run: e => e.frameOp('duplicate') },
  { id: 'clonePattern', group: 'song', keys: ['A+KeyD'], run: e => e.songMenu.clonePattern() },
  { id: 'stepIncrease', group: 'song', keys: ['C+NumpadAdd'], run: e => e.setStep(e.step + 1) },
  { id: 'stepDecrease', group: 'song', keys: ['C+NumpadSubtract'], run: e => e.setStep(e.step - 1) },
  { id: 'insertFrame', group: 'song', keys: [], run: e => e.frameOp('insert') },
  { id: 'removeFrame', group: 'song', keys: [], run: e => e.frameOp('remove') },
  { id: 'cloneFrame', group: 'song', keys: [], run: e => e.frameOp('clone') },
  { id: 'recallChannelState', group: 'song', keys: [], run: e => e.recallChannelState() },
  { id: 'compact', group: 'song', keys: [], run: e => e.trackerMenu.setOption('compact', !e.trackerMenu.options.compact) },
  { id: 'help', group: 'song', keys: ['F1'], global: true, run: e => e.trackerMenu.help.openTopics() },

  // Alt and the numeric keypad set the edit step
  ...Array.from({ length: 10 }, (_, digit) => ({ id: `step${digit}`, group: 'song', keys: [`A+Numpad${digit}`], hidden: true, run: e => e.setStep(digit) })),
];

export const GROUPS = ['file', 'play', 'edit', 'move', 'song'];

// The modifiers and the key of a keyboard event, or null for a modifier alone
export function comboOf(event) {
  if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(event.code) || !event.code)
    return null;
  const modifiers = (event.ctrlKey || event.metaKey ? 'C' : '') + (event.altKey ? 'A' : '') + (event.shiftKey ? 'S' : '');
  return modifiers ? `${modifiers}+${event.code}` : event.code;
}

const KEY_NAMES = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PageUp: 'PgUp', PageDown: 'PgDn', Delete: 'Del',
  Insert: 'Ins', Backspace: 'Backspace', Escape: 'Esc', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Num Enter',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .',
  Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backquote: '`',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', IntlYen: '¥', IntlRo: 'ろ',
};

// 'CS+ArrowUp' as people write it: 'Ctrl+Shift+↑'
export function formatCombo(combo) {
  const at = combo.indexOf('+');
  const plus = at > 0 && at < combo.length - 1;
  const modifiers = plus ? combo.slice(0, at) : '';
  const code = plus ? combo.slice(at + 1) : combo;
  const key = KEY_NAMES[code] ?? code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad(\d)$/, 'Num $1');
  return [modifiers.includes('C') && 'Ctrl', modifiers.includes('A') && 'Alt', modifiers.includes('S') && 'Shift', key].filter(Boolean).join('+');
}

export class Keymap {
  constructor(storage = true) {
    this.storage = storage;
    this.overrides = this.read();
    this.rebuild();
  }

  read() {
    if (!this.storage)
      return {};
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  save() {
    if (!this.storage)
      return;
    try {
      if (Object.keys(this.overrides).length)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.overrides));
      else
        localStorage.removeItem(STORAGE_KEY);
    } catch {
      // blocked: they last as long as the page
    }
  }

  rebuild() {
    this.map = new Map();
    for (const command of COMMANDS)
      for (const key of this.keysOf(command.id))
        this.map.set(key, command);
  }

  // The command a keyboard event is for, or undefined
  lookup(event) {
    const combo = comboOf(event);
    return combo ? this.map.get(combo) : undefined;
  }

  keysOf(id) {
    return this.overrides[id] ?? COMMANDS.find(command => command.id === id)?.keys ?? [];
  }

  isDefault(id) {
    return !(id in this.overrides);
  }

  // Sets the keys of a command; the other commands that had one of them lose it
  setKeys(id, keys) {
    for (const key of keys)
      for (const other of COMMANDS)
        if (other.id !== id && this.keysOf(other.id).includes(key))
          this.overrides[other.id] = this.keysOf(other.id).filter(k => k !== key);
    this.overrides[id] = keys;
    this.tidy();
  }

  reset(id) {
    delete this.overrides[id];
    this.rebuild();
    this.save();
  }

  resetAll() {
    this.overrides = {};
    this.rebuild();
    this.save();
  }

  // Overrides that say what the defaults do are left out
  tidy() {
    for (const command of COMMANDS) {
      const own = this.overrides[command.id];
      if (own && own.length === command.keys.length && own.every(key => command.keys.includes(key)))
        delete this.overrides[command.id];
    }
    this.rebuild();
    this.save();
  }

  // Which command has the key now, apart from `except`
  owner(combo, except = null) {
    return COMMANDS.find(command => command.id !== except && this.keysOf(command.id).includes(combo)) ?? null;
  }
}

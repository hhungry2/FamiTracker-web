// Dn-FamiTracker web port - the editor's Edit and Pattern menus: what the desktop
// tracker's have besides Undo, Redo and its pattern editor's keys (Paste Special, Copy As,
// Select with In Other Editor, Find / Replace, Go To, Bookmarks with the Module menu's
// Bookmark Manager, Instrument Mask, Volume Mask, Split Keyboard, Enable MIDI; Interpolate,
// Reverse, Replace Instrument, Expand, Shrink, Stretch, Transpose, Swap Channels), the
// pattern's right-click menu with Pick Up Row, and notes from MIDI keyboards (Web MIDI).
// The edits themselves are the editor's (dnft-editor.mjs) and dnft-pattern-edit.mjs's;
// while the frame list has the keyboard, the clipboard and Select are its own
// (dnft-frame-editor.mjs), as on the desktop.
//
//   const menus = new PatternMenu(editor);   // adds its menus after the Export menu

import {
  PASTE, PASTE_AT, QueryError, findTerm, replaceTerm, matchesTerm, replaceCell, searchOrder, normalizeSelection,
  cursorSelection, clearCells, volumeSequence, selectionText, selectionMml, cellText, parseStretchMap, stretchTest,
  invertStretchMap, bookmarkPlace,
} from './dnft-pattern-edit.mjs';
import { CHANNEL_ID, MAX_ROWS, NO_INSTRUMENT, OCTAVES } from './dnft-song.mjs';

const MIDI_KEY = 'dnft-editor.midi';
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// CSplitKeyboardDlg::MAX_TRANSPOSE
const MAX_TRANSPOSE = 24;
// The Find dialog's "look in" (CFindDlg::PrepareCursor()) and the effect column, 4: all
const AREAS = ['track', 'channel', 'frame', 'pattern', 'selection'];
const ALL_COLUMNS = 4;

const hex2 = value => value.toString(16).toUpperCase().padStart(2, '0');
const parseHex = text => /^[0-9a-f]+$/i.test(text.trim()) ? parseInt(text, 16) : NaN;
const samePlace = (a, b) => a && b && a.frame === b.frame && a.row === b.row && a.channel === b.channel;

export class PatternMenu {
  constructor(editor) {
    this.editor = editor;
    this.lastFound = null;     // {track, frame, row, channel} the search went to last
    this.findResults = [];
    this.midi = { enabled: false, access: null, held: new Map() };
    this.build();
    this.restoreMidi();
  }

  get strings() {
    return this.editor.strings;
  }

  // ---- building ------------------------------------------------------------------------

  build() {
    const t = this.strings;
    const editor = this.editor;
    const files = editor.files;
    // with the frame list in use, the clipboard and the selections are its
    // (CMainFrame::OnEditCopy() and the others)
    const inFrames = () => editor.activeEditor === 'frames';
    const frameEditor = () => editor.frameEditor;
    const noClip = () => !editor.clipboard;
    const noClipHere = () => inFrames() ? !frameEditor().clipboard : !editor.clipboard;
    const item = {
      undo: { label: t.undoItem, shortcut: 'Ctrl+Z', run: () => editor.undo(), disabled: () => !editor.history.done.length },
      redo: { label: t.redoItem, shortcut: 'Ctrl+Y', run: () => editor.redo(), disabled: () => !editor.history.undone.length },
      cut: { label: t.cutItem, shortcut: 'Ctrl+X', run: () => inFrames() ? frameEditor().cut() : editor.cut() },
      copy: { label: t.copyItem, shortcut: 'Ctrl+C', run: () => inFrames() ? frameEditor().copy() : editor.copy() },
      paste: { label: t.pasteItem, shortcut: 'Ctrl+V', run: () => inFrames() ? frameEditor().paste() : editor.paste(), disabled: noClipHere },
      delete: { label: t.deleteItem, shortcut: 'Del', run: () => inFrames() ? frameEditor().delete() : this.deleteSelection() },
      selectAll: { label: t.selectAll, shortcut: 'Ctrl+A', run: () => inFrames() ? frameEditor().selectScope('track') : editor.selectAll() },
      interpolate: { label: t.interpolate, hint: t.interpolateHint, shortcut: 'Ctrl+G', run: () => editor.interpolate() },
      reverse: { label: t.reverse, hint: t.reverseHint, shortcut: 'Ctrl+R', run: () => editor.reverse() },
      replaceInstrument: { label: t.replaceInstrument, hint: t.replaceInstrumentHint, shortcut: 'Alt+S', run: () => editor.replaceInstrument() },
      expand: { label: t.expand, hint: t.expandHint, run: () => editor.stretch([1, 0]) },
      shrink: { label: t.shrink, hint: t.shrinkHint, run: () => editor.stretch([2]) },
      stretch: { label: t.stretchItem, hint: t.stretchHint, run: () => this.openStretch() },
      transpose: {
        label: t.transposeMenu, items: [
          { label: t.decreaseNote, shortcut: 'Ctrl+F1', run: () => editor.transpose(-1) },
          { label: t.increaseNote, shortcut: 'Ctrl+F2', run: () => editor.transpose(1) },
          { label: t.decreaseOctave, shortcut: 'Ctrl+F3 / Ctrl+Shift+↓', run: () => editor.transpose(-12) },
          { label: t.increaseOctave, shortcut: 'Ctrl+F4 / Ctrl+Shift+↑', run: () => editor.transpose(12) },
        ],
      },
    };
    const editMenu = files.menu(t.editMenu, t.editMenuHint, [
      item.undo, item.redo, null, item.cut, item.copy, item.paste,
      {
        label: t.pasteSpecial, items: [
          { label: t.pasteMix, hint: t.pasteMixHint, shortcut: 'Ctrl+M', run: () => editor.paste(PASTE.MIX), disabled: noClip },
          { label: t.pasteOverwrite, hint: t.pasteOverwriteHint, run: () => inFrames() ? frameEditor().paste('overwrite') : editor.paste(PASTE.OVERWRITE), disabled: noClipHere },
          { label: t.pasteInsert, hint: t.pasteInsertHint, run: () => editor.paste(PASTE.INSERT), disabled: noClip },
          null,
          { label: t.pasteAtCursor, hint: t.pasteAtCursorHint, radio: true, checked: () => editor.pastePos === PASTE_AT.CURSOR, run: () => this.setPastePos(PASTE_AT.CURSOR) },
          { label: t.pasteAtSelection, hint: t.pasteAtSelectionHint, radio: true, checked: () => editor.pastePos === PASTE_AT.SELECTION, run: () => this.setPastePos(PASTE_AT.SELECTION) },
          { label: t.pasteFill, hint: t.pasteFillHint, radio: true, checked: () => editor.pastePos === PASTE_AT.FILL, run: () => this.setPastePos(PASTE_AT.FILL) },
          null,
          { label: t.overflowPaste, hint: t.overflowPasteHint, checked: () => editor.overflowPaste, run: () => { editor.overflowPaste = !editor.overflowPaste; } },
        ],
      },
      item.delete,
      null,
      {
        label: t.copyAs, items: [
          { label: t.copyAsVolume, hint: t.copyAsVolumeHint, run: () => this.copyAs('volume') },
          { label: t.copyAsText, hint: t.copyAsTextHint, run: () => this.copyAs('text'), disabled: () => !editor.selection },
          { label: t.copyAsMml, hint: t.copyAsMmlHint, run: () => this.copyAs('mml') },
        ],
      },
      null,
      {
        label: t.selectMenu, items: [
          item.selectAll,
          { label: t.selectNone, shortcut: 'Esc', run: () => inFrames() ? frameEditor().deselect() : editor.deselect() },
          null,
          { label: t.selectRow, hint: t.selectRowHint, run: () => editor.selectScope('row', 'all'), disabled: inFrames },
          { label: t.selectColumn, hint: t.selectColumnHint, run: () => editor.selectScope('frame', 'column'), disabled: inFrames },
          null,
          { label: t.selectPattern, hint: t.selectPatternHint, run: () => inFrames() ? frameEditor().selectScope('pattern') : editor.selectScope('frame', 'channel') },
          { label: t.selectFrame, hint: t.selectFrameHint, run: () => inFrames() ? frameEditor().selectScope('frame') : editor.selectScope('frame', 'all') },
          { label: t.selectChannel, hint: t.selectChannelHint, run: () => inFrames() ? frameEditor().selectScope('channel') : editor.selectScope('track', 'channel') },
          { label: t.selectTrack, hint: t.selectTrackHint, run: () => inFrames() ? frameEditor().selectScope('track') : editor.selectScope('track', 'all') },
          null,
          { label: t.selectOther, hint: t.selectOtherHint, run: () => frameEditor().selectInOtherEditor() },
        ],
      },
      null,
      {
        label: t.findMenu, items: [
          { label: t.findToggle, shortcut: 'Ctrl+F', run: () => this.toggleFind() },
          null,
          { label: t.findNext, run: () => this.findFromMenu(1) },
          { label: t.findPrevious, run: () => this.findFromMenu(-1) },
        ],
      },
      { label: t.gotoItem, shortcut: 'Alt+G', run: () => this.openGoto() },
      {
        label: t.bookmarksMenu, items: [
          { label: t.bookmarkToggle, shortcut: 'Ctrl+K', run: () => editor.toggleBookmark() },
          { label: t.bookmarkNext, shortcut: 'Ctrl+PgDn', run: () => editor.gotoBookmark(1) },
          { label: t.bookmarkPrevious, shortcut: 'Ctrl+PgUp', run: () => editor.gotoBookmark(-1) },
          null,
          { label: t.bookmarkManager, run: () => this.openBookmarks() },
        ],
      },
      null,
      { label: t.instrumentMask, hint: t.instrumentMaskHint, shortcut: 'Alt+T', checked: () => editor.maskInstrument, run: () => editor.setMask('instrument') },
      { label: t.volumeMask, hint: t.volumeMaskHint, shortcut: 'Alt+V', checked: () => editor.maskVolume, run: () => editor.setMask('volume') },
      { label: t.splitKeyboard, hint: t.splitKeyboardHint, run: () => this.openSplit() },
      null,
      { label: t.midiInput, hint: t.midiInputHint, checked: () => this.midi.enabled, run: () => this.toggleMidi() },
    ]);
    const patternMenu = files.menu(t.patternMenu, t.patternMenuHint, [
      item.interpolate, item.reverse, item.replaceInstrument, null,
      item.expand, item.shrink, item.stretch, null,
      item.transpose,
      {
        label: t.valuesMenu, items: [
          { label: t.decreaseValues, shortcut: 'Shift+F1', run: () => editor.scrollValues(-1) },
          { label: t.increaseValues, shortcut: 'Shift+F2', run: () => editor.scrollValues(1) },
          { label: t.coarseDecrease, shortcut: 'Shift+F3', run: () => editor.scrollValues(-16) },
          { label: t.coarseIncrease, shortcut: 'Shift+F4', run: () => editor.scrollValues(16) },
        ],
      },
      null,
      { label: t.swapChannels, hint: t.swapChannelsHint, run: () => this.openSwap() },
    ]);
    const menus = editor.root.querySelectorAll('.dnft-toolbar .dnft-menu-wrap');
    menus[menus.length - 1].after(editMenu, patternMenu);

    // the right button on the pattern (IDR_PATTERN_POPUP)
    this.contextItems = [
      item.undo, item.redo, null, item.cut, item.copy, item.paste, item.delete, item.selectAll, null,
      {
        label: t.patternMenu, items: [
          item.interpolate, item.reverse, item.replaceInstrument, null, item.expand, item.shrink, item.stretch, null, item.transpose,
        ],
      },
      null,
      { label: t.pickUpRow, hint: t.pickUpRowHint, run: () => editor.pickUpRow() },
      null,
      { label: t.toggleChannel, shortcut: 'Alt+F9', run: () => editor.toggleMute(editor.cursor.channel, false) },
      { label: t.soloChannel, shortcut: 'Alt+F10', run: () => editor.toggleMute(editor.cursor.channel, true) },
    ];

    this.buildStretchDialog();
    this.buildSwapDialog();
    this.buildGotoDialog();
    this.buildSplitDialog();
    this.buildFindDialog();
    this.buildBookmarkDialog();
  }

  openContextMenu(x, y) {
    this.editor.files.contextMenu(this.contextItems, x, y);
  }

  // After the song, the track or its bookmarks change: the windows that stay open
  refresh() {
    const editor = this.editor;
    if (this.song !== editor.song) {
      // what Find found was in another song
      this.song = editor.song;
      this.lastFound = null;
      this.findResults = [];
      this.findDialog?.querySelector('[data-role="results"]')?.replaceChildren();
      this.findDialog?.querySelector('[data-role="results"]')?.setAttribute('hidden', '');
      this.findDialog?.querySelector('[data-role="count"]')?.setAttribute('hidden', '');
    }
    if (this.bookmarkDialog?.open)
      this.showBookmarks();
  }

  setPastePos(at) {
    this.editor.pastePos = at;
  }

  // Edit > Delete: the selection, or the field at the cursor
  deleteSelection() {
    const editor = this.editor;
    if (editor.canEdit())
      editor.applyWrites(clearCells(editor.trackView(), editor.selection ?? cursorSelection(editor.cursor)));
  }

  // A dialog in the editor's look (FileMenu.dialog()); `floating`: one that stays open
  // beside the pattern, and moves by its title
  dialog(className, body, buttons, floating = false) {
    const d = this.editor.files.dialog(className, body, buttons);
    if (floating) {
      d.classList.add('dnft-dialog--float');
      const head = d.querySelector('.dnft-dialog-head');
      head.append(Object.assign(document.createElement('button'), { type: 'button', className: 'dnft-icon-button dnft-dialog-close', textContent: '✕', title: this.strings.close }));
      head.querySelector('.dnft-dialog-close').addEventListener('click', () => d.close());
      head.addEventListener('pointerdown', e => {
        if (e.target.closest('button'))
          return;
        const rect = d.getBoundingClientRect();
        const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
        head.setPointerCapture(e.pointerId);
        const move = m => {
          d.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, m.clientX - dx))}px`;
          d.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, m.clientY - dy))}px`;
          d.style.right = 'auto';
        };
        head.addEventListener('pointermove', move);
        head.addEventListener('pointerup', () => head.removeEventListener('pointermove', move), { once: true });
      });
      // Escape in it goes back to the pattern (a dialog that is not modal gets no cancel
      // event for it in every browser)
      d.addEventListener('cancel', e => {
        e.preventDefault();
        d.close();
      });
      d.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          e.preventDefault();
          d.close();
        }
      });
      d.addEventListener('close', () => this.editor.view.scroller.focus({ preventScroll: true }));
    }
    return d;
  }

  // The channels of the song, as options
  channelOptions(select, extra = []) {
    select.replaceChildren(...extra, ...this.editor.song.channels.map((channel, i) => new Option(channel.name, i)));
  }

  // ---- Copy As ---------------------------------------------------------------------------

  async copyAs(kind) {
    const t = this.strings;
    const editor = this.editor;
    const track = editor.trackView();
    const area = editor.selection ?? cursorSelection(editor.cursor);
    let text;
    if (kind === 'volume')
      text = volumeSequence(track, area);
    else if (kind === 'text')
      text = selectionText(track, editor.selection, editor.song.channels.map(c => c.name), editor.song.effects.letters);
    else
      text = selectionMml(track, area, track.chips);
    if (await copyText(text))
      editor.message(t.copiedAs);
    else
      editor.message(t.copyFailed, true);
  }

  // ---- Stretch ---------------------------------------------------------------------------

  buildStretchDialog() {
    const d = this.stretchDialog = this.dialog('dnft-stretch-dialog', `
      <label class="dnft-field"><span data-t="stretchMap"></span><input type="text" data-role="map" spellcheck="false" autocomplete="off"></label>
      <p class="dnft-hint" data-t="stretchMapHint"></p>
      <p class="dnft-stretch-test" data-role="test"></p>
      <div class="dnft-choices">
        <button type="button" class="dnft-button" data-role="expand" data-t="expand"></button>
        <button type="button" class="dnft-button" data-role="shrink" data-t="shrink"></button>
        <button type="button" class="dnft-button" data-role="reset" data-t="stretchReset"></button>
        <button type="button" class="dnft-button" data-role="invert" data-t="stretchInvert"></button>
      </div>`, `
      <button type="button" class="dnft-button dnft-button--primary" data-role="ok" data-t="ok"></button>
      <button type="button" class="dnft-button" data-role="cancel" data-t="cancel"></button>`);
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    const set = text => {
      $('map').value = text;
      this.showStretch();
    };
    $('map').addEventListener('input', () => this.showStretch());
    $('map').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !$('ok').disabled) {
        e.preventDefault();
        $('ok').click();
      }
    });
    $('expand').addEventListener('click', () => set('1 0'));
    $('shrink').addEventListener('click', () => set('2'));
    $('reset').addEventListener('click', () => set('1'));
    $('invert').addEventListener('click', () => {
      const map = parseStretchMap($('map').value);
      if (map)
        set(invertStretchMap(map).join(' '));
    });
    $('ok').addEventListener('click', () => {
      const map = parseStretchMap($('map').value);
      d.close();
      if (map)
        this.editor.stretch(map);
    });
    $('cancel').addEventListener('click', () => d.close());
  }

  openStretch() {
    const d = this.stretchDialog;
    d.querySelector('.dnft-dialog-title').textContent = this.strings.stretchTitle;
    d.querySelector('[data-role="map"]').value = '1';
    this.showStretch();
    d.showModal();
    d.querySelector('[data-role="map"]').select();
  }

  // Which row of the selection each of the first rows takes (CStretchDlg::UpdateTest())
  showStretch() {
    const t = this.strings;
    const d = this.stretchDialog;
    const map = parseStretchMap(d.querySelector('[data-role="map"]').value);
    d.querySelector('[data-role="test"]').textContent = map ? `${t.stretchTest} ${stretchTest(map).map(r => r < 0 ? '-' : r).join(' ')}` : t.stretchInvalid;
    d.querySelector('[data-role="test"]').classList.toggle('is-error', !map);
    d.querySelector('[data-role="ok"]').disabled = !map;
    d.querySelector('[data-role="invert"]').disabled = !map;
  }

  // ---- Swap Channels ---------------------------------------------------------------------

  buildSwapDialog() {
    const d = this.swapDialog = this.dialog('dnft-swap-dialog', `
      <div class="dnft-grid">
        <label class="dnft-field"><span data-t="swapFirst"></span><select data-role="first"></select></label>
        <label class="dnft-field"><span data-t="swapSecond"></span><select data-role="second"></select></label>
      </div>
      <label class="dnft-check"><input type="checkbox" data-role="all"> <span data-t="swapAllTracks"></span></label>`, `
      <button type="button" class="dnft-button dnft-button--primary" data-role="ok" data-t="ok"></button>
      <button type="button" class="dnft-button" data-role="cancel" data-t="cancel"></button>`);
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    const check = () => { $('ok').disabled = $('first').value === $('second').value; };
    $('first').addEventListener('change', check);
    $('second').addEventListener('change', check);
    $('ok').addEventListener('click', () => {
      d.close();
      this.editor.swapChannels(Number($('first').value), Number($('second').value), $('all').checked);
    });
    $('cancel').addEventListener('click', () => d.close());
    this.checkSwap = check;
  }

  openSwap() {
    const d = this.swapDialog;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    d.querySelector('.dnft-dialog-title').textContent = this.strings.swapTitle;
    this.channelOptions($('first'));
    this.channelOptions($('second'));
    $('first').value = 0;
    $('second').value = Math.min(1, this.editor.channelCount - 1);
    $('all').checked = false;
    this.checkSwap();
    d.showModal();
  }

  // ---- Go To -------------------------------------------------------------------------------

  buildGotoDialog() {
    const d = this.gotoDialog = this.dialog('dnft-goto-dialog', `
      <div class="dnft-grid">
        <label class="dnft-field"><span data-t="gotoFrame"></span><input type="text" data-role="frame" maxlength="2" spellcheck="false" autocomplete="off"></label>
        <label class="dnft-field"><span data-t="gotoRow"></span><input type="text" data-role="row" maxlength="2" spellcheck="false" autocomplete="off"></label>
        <label class="dnft-field"><span data-t="gotoChannel"></span><select data-role="channel"></select></label>
      </div>
      <p class="dnft-hint" data-t="gotoHint"></p>`, `
      <button type="button" class="dnft-button dnft-button--primary" data-role="ok" data-t="ok"></button>
      <button type="button" class="dnft-button" data-role="cancel" data-t="cancel"></button>`);
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    const read = () => ({ frame: parseHex($('frame').value), row: parseHex($('row').value), channel: Number($('channel').value) });
    const check = () => {
      const { frame, row } = read();
      const tr = this.editor.tr;
      $('ok').disabled = !(frame >= 0 && frame < tr.frames && row >= 0 && row < tr.rows);
    };
    for (const role of ['frame', 'row']) {
      $(role).addEventListener('input', check);
      $(role).addEventListener('keydown', e => {
        if (e.key === 'Enter' && !$('ok').disabled) {
          e.preventDefault();
          $('ok').click();
        }
      });
    }
    $('ok').addEventListener('click', () => {
      const { frame, row, channel } = read();
      d.close();
      const editor = this.editor;
      editor.setCursor({ frame, row, channel, column: channel === editor.cursor.channel ? editor.cursor.column : 0 }, { keep: true });
    });
    $('cancel').addEventListener('click', () => d.close());
    this.checkGoto = check;
  }

  // Edit > Go To: a frame, row (as the editor shows them, in hexadecimal) and channel
  openGoto() {
    const d = this.gotoDialog;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    const { frame, row, channel } = this.editor.cursor;
    d.querySelector('.dnft-dialog-title').textContent = this.strings.gotoTitle;
    $('frame').value = hex2(frame);
    $('row').value = hex2(row);
    this.channelOptions($('channel'));
    $('channel').value = channel;
    this.checkGoto();
    d.showModal();
    $('frame').select();
  }

  // ---- Split Keyboard ------------------------------------------------------------------------

  buildSplitDialog() {
    const t = this.strings;
    const d = this.splitDialog = this.dialog('dnft-split-dialog', `
      <label class="dnft-check"><input type="checkbox" data-role="enable"> <span data-t="splitEnable"></span></label>
      <div class="dnft-grid">
        <div class="dnft-field"><span data-t="splitPoint"></span><span class="dnft-pair"><select data-role="note"></select><select data-role="octave"></select></span></div>
        <label class="dnft-field"><span data-t="splitChannel"></span><select data-role="channel"></select></label>
        <label class="dnft-field"><span data-t="splitInstrument"></span><select data-role="instrument"></select></label>
        <label class="dnft-field"><span data-t="splitTranspose"></span><select data-role="transpose"></select></label>
      </div>
      <p class="dnft-hint" data-t="splitHint"></p>`, `
      <button type="button" class="dnft-button dnft-button--primary" data-role="ok" data-t="ok"></button>
      <button type="button" class="dnft-button" data-role="cancel" data-t="cancel"></button>`);
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    $('note').append(...NOTE_NAMES.map((name, i) => new Option(name, i)));
    $('octave').append(...Array.from({ length: OCTAVES }, (_, i) => new Option(i, i)));
    $('transpose').append(...Array.from({ length: 2 * MAX_TRANSPOSE + 1 }, (_, i) => new Option(`${i > MAX_TRANSPOSE ? '+' : ''}${i - MAX_TRANSPOSE}`, i - MAX_TRANSPOSE)));
    $('note').setAttribute('aria-label', t.splitPoint);
    $('octave').setAttribute('aria-label', t.splitOctave);
    const enable = () => {
      for (const role of ['note', 'octave', 'channel', 'instrument', 'transpose'])
        $(role).disabled = !$('enable').checked;
    };
    $('enable').addEventListener('change', enable);
    $('ok').addEventListener('click', () => {
      const editor = this.editor;
      editor.split = $('enable').checked ? {
        note: Number($('octave').value) * 12 + Number($('note').value),
        channel: Number($('channel').value),
        instrument: Number($('instrument').value),
        transpose: Number($('transpose').value),
      } : { note: -1, channel: -1, instrument: NO_INSTRUMENT, transpose: 0 };
      d.close();
    });
    $('cancel').addEventListener('click', () => d.close());
    this.enableSplit = enable;
  }

  // Edit > Split Keyboard: the notes up to a key are moved, may get an instrument of their
  // own, and outside the edit mode play on a channel of their own
  openSplit() {
    const t = this.strings;
    const d = this.splitDialog;
    const editor = this.editor;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    const split = editor.split;
    d.querySelector('.dnft-dialog-title').textContent = t.splitTitle;
    $('enable').checked = split.note >= 0;
    $('note').value = split.note >= 0 ? split.note % 12 : 0;
    $('octave').value = split.note >= 0 ? Math.floor(split.note / 12) : 3;
    $('channel').replaceChildren(new Option(t.splitKeep, -1), ...editor.song.channels.map(c => new Option(c.name, c.id)));
    $('channel').value = editor.song.channels.some(c => c.id === split.channel) ? split.channel : -1;
    $('instrument').replaceChildren(new Option(t.splitKeep, NO_INSTRUMENT),
      ...editor.song.instruments.map(i => new Option(`${hex2(i.index)} ${i.name}`, i.index)));
    $('instrument').value = editor.song.instrument(split.instrument) ? split.instrument : NO_INSTRUMENT;
    $('transpose').value = split.transpose;
    this.enableSplit();
    d.showModal();
  }

  // ---- Find / Replace -------------------------------------------------------------------------

  buildFindDialog() {
    const t = this.strings;
    const field = (role, size) => `<input type="text" data-role="${role}" maxlength="${size}" spellcheck="false" autocomplete="off">`;
    const d = this.findDialog = this.dialog('dnft-find-dialog', `
      <div class="dnft-find-grid">
        <span></span><span data-t="findNote"></span><span data-t="findInstrument"></span><span data-t="findVolume"></span><span data-t="findEffect"></span>
        <span class="dnft-find-head" data-t="findWhat"></span>
        <span class="dnft-find-cell"><input type="checkbox" data-role="use-note">${field('note-from', 3)}${field('note-to', 3)}</span>
        <span class="dnft-find-cell"><input type="checkbox" data-role="use-inst">${field('inst-from', 2)}${field('inst-to', 2)}</span>
        <span class="dnft-find-cell"><input type="checkbox" data-role="use-vol">${field('vol-from', 1)}${field('vol-to', 1)}</span>
        <span class="dnft-find-cell"><input type="checkbox" data-role="use-effect">${field('effect', 3)}</span>
        <span class="dnft-find-head" data-t="replaceWith"></span>
        <span class="dnft-find-cell"><input type="checkbox" data-role="use-replace-note">${field('replace-note', 3)}</span>
        <span class="dnft-find-cell"><input type="checkbox" data-role="use-replace-inst">${field('replace-inst', 2)}</span>
        <span class="dnft-find-cell"><input type="checkbox" data-role="use-replace-vol">${field('replace-vol', 1)}</span>
        <span class="dnft-find-cell"><input type="checkbox" data-role="use-replace-effect">${field('replace-effect', 3)}</span>
      </div>
      <p class="dnft-hint" data-t="findHint"></p>
      <div class="dnft-choices">
        <label class="dnft-check"><span data-t="findIn"></span><select data-role="area"></select></label>
        <label class="dnft-check"><span data-t="findColumn"></span><select data-role="column"></select></label>
      </div>
      <div class="dnft-choices">
        <label class="dnft-check"><input type="checkbox" data-role="vertical"> <span data-t="findVertical"></span></label>
        <label class="dnft-check"><input type="checkbox" data-role="remove"> <span data-t="findRemove"></span></label>
        <label class="dnft-check"><input type="checkbox" data-role="negate"> <span data-t="findNegate"></span></label>
      </div>
      <div class="dnft-find-buttons">
        <button type="button" class="dnft-button" data-role="next" data-t="findNext"></button>
        <button type="button" class="dnft-button" data-role="previous" data-t="findPrevious"></button>
        <button type="button" class="dnft-button" data-role="all" data-t="findAll"></button>
        <button type="button" class="dnft-button" data-role="replace" data-t="replaceNext"></button>
        <button type="button" class="dnft-button" data-role="replace-previous" data-t="replacePrevious"></button>
        <button type="button" class="dnft-button" data-role="replace-all" data-t="replaceAll"></button>
      </div>
      <p class="dnft-find-count" data-role="count" hidden></p>
      <div class="dnft-find-results" data-role="results" hidden></div>`, '', true);
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    d.querySelector('.dnft-dialog-foot').remove();
    $('area').append(...t.findAreas.map((name, i) => new Option(name, i)));
    $('column').append(...['fx1', 'fx2', 'fx3', 'fx4', t.findAllColumns].map((name, i) => new Option(name, i)));
    $('column').value = ALL_COLUMNS;
    for (const [role, hint] of [['note-from', t.findNoteHint], ['note-to', t.findToHint], ['inst-from', t.findInstrumentHint],
      ['inst-to', t.findToHint], ['vol-from', t.findVolumeHint], ['vol-to', t.findToHint], ['effect', t.findEffectHint],
      ['replace-note', t.findNoteHint], ['replace-inst', t.findInstrumentHint], ['replace-vol', t.findVolumeHint], ['replace-effect', t.findEffectHint]])
      $(role).title = hint;
    $('note-from').placeholder = $('inst-from').placeholder = $('vol-from').placeholder = t.findFrom;
    $('note-to').placeholder = $('inst-to').placeholder = $('vol-to').placeholder = t.findTo;
    // a field typed in is ticked; a ticked field is used even when empty (it then looks
    // for nothing in that column)
    d.addEventListener('input', e => {
      const input = e.target.closest('input[type="text"]');
      if (!input)
        return;
      const box = input.parentElement.querySelector('input[type="checkbox"]');
      if (input.value)
        box.checked = true;
      this.lastFound = null;
    });
    d.addEventListener('change', () => { this.lastFound = null; });
    // fields: hex digits and the note texts in capitals, as the desktop's
    d.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('input[type="text"]')) {
        e.preventDefault();
        this.findNext(1);
      }
    });
    $('next').addEventListener('click', () => this.findNext(1));
    $('previous').addEventListener('click', () => this.findNext(-1));
    $('all').addEventListener('click', () => this.findAll());
    $('replace').addEventListener('click', () => this.replaceNext(1));
    $('replace-previous').addEventListener('click', () => this.replaceNext(-1));
    $('replace-all').addEventListener('click', () => this.replaceAll());
    $('results').addEventListener('click', e => {
      const row = e.target.closest('[data-result]');
      if (row)
        this.goTo(this.findResults[Number(row.dataset.result)]);
    });
  }

  // Ctrl+F: the Find / Replace window, open or closed
  toggleFind() {
    const d = this.findDialog;
    if (d.open) {
      d.close();
      return;
    }
    d.querySelector('.dnft-dialog-title').textContent = this.strings.findTitle;
    d.show();
    d.querySelector('[data-role="note-from"]').focus();
  }

  // Edit > Find / Replace > Find Next and Find Previous: what the window asks for, or the
  // window, when nothing is asked yet
  findFromMenu(direction) {
    if (!this.findDialog.querySelector('[data-role^="use-"]:not([data-role^="use-replace"]):checked'))
      this.toggleFind();
    else
      this.findNext(direction);
  }

  // What the fields ask for: {term, replacement, column, negate, remove, vertical, area},
  // or null after saying what is wrong with them
  readFind(withReplace) {
    const t = this.strings;
    const d = this.findDialog;
    const editor = this.editor;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    const on = role => $(role).checked;
    const value = role => $(role).value.trim().toUpperCase();
    const note = role => {
      // a flat is a small b after the note letter (Db4), as the desktop reads it
      const text = $(role).value.trim();
      return text.length > 1 && text[1] === 'b' ? text[0].toUpperCase() + text.slice(1) : text.toUpperCase();
    };
    const letters = editor.song.effects.letters;
    const area = AREAS[Number($('area').value)];
    try {
      if (area === 'selection' && !editor.selection)
        throw new QueryError('noSelection');
      const fields = {};
      if (on('use-note'))
        fields.note = [note('note-from'), note('note-to')];
      if (on('use-inst'))
        fields.inst = [value('inst-from'), value('inst-to')];
      if (on('use-vol'))
        fields.vol = [value('vol-from'), value('vol-to')];
      if (on('use-effect'))
        fields.effect = value('effect');
      const term = findTerm(fields, letters);
      let replacement = null;
      if (withReplace) {
        const replace = {};
        if (on('use-replace-note'))
          replace.note = note('replace-note');
        if (on('use-replace-inst'))
          replace.inst = value('replace-inst');
        if (on('use-replace-vol'))
          replace.vol = value('replace-vol');
        if (on('use-replace-effect'))
          replace.effect = value('replace-effect');
        replacement = replaceTerm(replace, letters, on('remove'));
      }
      return {
        term, replacement, area, column: Number($('column').value), negate: on('negate'), remove: on('remove'),
        vertical: on('vertical'),
      };
    } catch (e) {
      if (!(e instanceof QueryError))
        throw e;
      let text = t.queryErrors[e.code] ?? e.code;
      e.values.forEach((v, i) => { text = text.replace(`%${i + 1}`, v); });
      editor.message(text, true);
      return null;
    }
  }

  // Where a search looks: the track, the cursor's channel, its frame, its pattern (the
  // channel in the frame), or the selection
  searchArea(area) {
    const editor = this.editor;
    const { frame, channel } = editor.cursor;
    const tr = editor.tr;
    if (area === 'selection')
      return editor.selection;
    const all = area === 'track' || area === 'frame';
    const track = area === 'track' || area === 'channel';
    return normalizeSelection(
      { frame: track ? 0 : frame, row: 0, channel: all ? 0 : channel, column: 0 },
      { frame: track ? tr.frames - 1 : frame, row: tr.rows - 1, channel: all ? editor.channelCount - 1 : channel, column: 0 });
  }

  matches(query, track, place) {
    return matchesTerm(query.term, track.cell(place.frame, place.channel, place.row), {
      noise: track.ids[place.channel] === CHANNEL_ID.NOISE, effects: track.effColumns[place.channel],
      column: query.column, negate: query.negate,
    });
  }

  // Find Next and Find Previous: from the cursor round the area, across the channels or
  // down them; the cell found last is passed over
  findNext(direction, query = this.readFind(false), quiet = false) {
    const t = this.strings;
    const editor = this.editor;
    if (!query)
      return null;
    const track = editor.trackView();
    const order = [...searchOrder(this.searchArea(query.area), track.rows, query.vertical)];
    if (direction < 0)
      order.reverse();
    const cursor = editor.cursor;
    let begin = order.findIndex(place => samePlace(place, cursor));
    if (begin < 0)
      begin = 0;
    else if (this.lastFound?.track === editor.track && samePlace(this.lastFound, cursor))
      ++begin;
    for (let i = 0; i < order.length; ++i) {
      const place = order[(begin + i) % order.length];
      if (this.matches(query, track, place)) {
        this.goTo(place);
        return place;
      }
    }
    this.lastFound = null;
    if (!quiet)
      editor.message(t.findNone);
    return null;
  }

  goTo(place) {
    const editor = this.editor;
    if (!place)
      return;
    const column = place.channel === editor.cursor.channel ? editor.cursor.column : 0;
    editor.setCursor({ ...place, column }, { keep: true });
    this.lastFound = { ...place, track: editor.track };
  }

  // Find All: the cells found, in a list to go to them by
  findAll() {
    const t = this.strings;
    const editor = this.editor;
    const query = this.readFind(false);
    if (!query)
      return;
    const track = editor.trackView();
    this.findResults = [...searchOrder(this.searchArea(query.area), track.rows, query.vertical)].filter(place => this.matches(query, track, place));
    const d = this.findDialog;
    const letters = editor.song.effects.letters;
    const count = d.querySelector('[data-role="count"]');
    count.hidden = false;
    count.textContent = t.findCount.replace('%1', this.findResults.length);
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const text of ['#', t.findResultChannel, t.findResultPattern, t.findResultFrame, t.findResultRow, t.findNote, t.findInstrument, t.findVolume, 'fx1', 'fx2', 'fx3', 'fx4'])
      head.append(Object.assign(document.createElement('th'), { textContent: text }));
    const body = table.createTBody();
    this.findResults.forEach((place, i) => {
      const row = body.insertRow();
      row.dataset.result = i;
      const text = cellText(track.cell(place.frame, place.channel, place.row), 4, track.ids[place.channel] === CHANNEL_ID.NOISE, letters).split(' ');
      for (const value of [i + 1, editor.song.channels[place.channel].name, hex2(track.pattern(place.frame, place.channel)), hex2(place.frame), hex2(place.row), ...text])
        row.insertCell().textContent = /^\.+$/.test(value) ? '' : value;
    });
    const results = d.querySelector('[data-role="results"]');
    results.replaceChildren(table);
    results.hidden = !this.findResults.length;
  }

  // Replace Next and Replace Previous: the cell found last is replaced when the cursor is
  // still on it, and the search goes on (CFindDlg::OnBnClickedButtonReplaceNext())
  replaceNext(direction) {
    const editor = this.editor;
    const query = this.readFind(true);
    if (!query || !this.canReplace())
      return;
    const track = editor.trackView();
    const cursor = editor.cursor;
    if (this.lastFound?.track === editor.track && samePlace(this.lastFound, cursor) && this.matches(query, track, cursor))
      editor.applyWrites([this.replacement(query, track, cursor)]);
    this.findNext(direction, query, true);
  }

  // Replace All, as one action
  replaceAll() {
    const t = this.strings;
    const editor = this.editor;
    const query = this.readFind(true);
    if (!query || !this.canReplace())
      return;
    const track = editor.trackView();
    const writes = [...searchOrder(this.searchArea(query.area), track.rows, query.vertical)]
      .filter(place => this.matches(query, track, place)).map(place => this.replacement(query, track, place));
    editor.applyWrites(writes);
    editor.message(t.replacedCount.replace('%1', writes.length));
  }

  canReplace() {
    const editor = this.editor;
    if (!editor.editMode) {
      editor.message(this.strings.findEditOff, true);
      return false;
    }
    return !(editor.playing && editor.follow);
  }

  replacement(query, track, place) {
    const { effects } = this.editor.song;
    const chip = this.editor.song.channels[place.channel].chip;
    const effectOf = effect => (effects.byChip[chip] ?? effects.byChip[0])[effects.letters[effect]] ?? 0;
    const cell = replaceCell(track.cell(place.frame, place.channel, place.row), query.term, query.replacement, {
      effects: track.effColumns[place.channel], column: query.column, removeOriginal: query.remove, effectOf,
    });
    return { channel: place.channel, pattern: track.pattern(place.frame, place.channel), row: place.row, cell };
  }

  // ---- the Bookmark Manager -----------------------------------------------------------------

  buildBookmarkDialog() {
    const t = this.strings;
    const d = this.bookmarkDialog = this.dialog('dnft-bookmark-dialog', `
      <div class="dnft-bookmarks">
        <div class="dnft-bookmark-list" role="listbox" tabindex="0" data-role="list"></div>
        <div class="dnft-bookmark-edit">
          <label class="dnft-field"><span data-t="bookmarkNameLabel"></span><input type="text" data-role="name" spellcheck="false"></label>
          <div class="dnft-grid">
            <label class="dnft-field"><span data-t="gotoFrame"></span><input type="text" data-role="frame" maxlength="2" spellcheck="false" autocomplete="off"></label>
            <label class="dnft-field"><span data-t="gotoRow"></span><input type="text" data-role="row" maxlength="2" spellcheck="false" autocomplete="off"></label>
          </div>
          <label class="dnft-check"><input type="checkbox" data-role="beat-on"> <span data-t="bookmarkBeat"></span><input type="number" data-role="beat" min="0" max="${MAX_ROWS}"></label>
          <label class="dnft-check"><input type="checkbox" data-role="bar-on"> <span data-t="bookmarkBar"></span><input type="number" data-role="bar" min="0" max="${MAX_ROWS}"></label>
          <label class="dnft-check"><input type="checkbox" data-role="persist"> <span data-t="bookmarkPersist"></span></label>
          <div class="dnft-choices">
            <button type="button" class="dnft-button" data-role="add" data-t="bookmarkAdd"></button>
            <button type="button" class="dnft-button" data-role="update" data-t="bookmarkUpdate"></button>
            <button type="button" class="dnft-button" data-role="remove" data-t="bookmarkRemove"></button>
          </div>
          <div class="dnft-choices">
            <button type="button" class="dnft-button" data-role="up" data-t="moveUp"></button>
            <button type="button" class="dnft-button" data-role="down" data-t="moveDown"></button>
            <button type="button" class="dnft-button" data-role="sort-position" data-t="bookmarkSortPosition"></button>
            <button type="button" class="dnft-button" data-role="sort-name" data-t="bookmarkSortName"></button>
            <button type="button" class="dnft-button" data-role="clear" data-t="bookmarkClearAll"></button>
          </div>
        </div>
      </div>
      <p class="dnft-hint" data-t="bookmarkHint"></p>`, '', true);
    d.querySelector('.dnft-dialog-foot').remove();
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    $('persist').closest('label').title = t.bookmarkPersistHint;
    for (const role of ['beat', 'bar'])
      $(`${role}-on`).addEventListener('change', () => { $(role).disabled = !$(`${role}-on`).checked; });
    $('list').addEventListener('click', e => {
      const item = e.target.closest('[data-bookmark]');
      if (item)
        this.selectBookmark(Number(item.dataset.bookmark));
    });
    $('list').addEventListener('dblclick', e => {
      const item = e.target.closest('[data-bookmark]');
      const mark = item && this.editor.tr.bookmarks[Number(item.dataset.bookmark)];
      if (mark) {
        this.editor.setCursor({ ...this.editor.cursor, frame: mark.frame, row: mark.row }, { keep: true });
        this.editor.view.scroller.focus({ preventScroll: true });
      }
    });
    $('list').addEventListener('keydown', e => {
      const ctrl = e.ctrlKey || e.metaKey;
      const count = this.editor.tr.bookmarks.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (ctrl)
          this.moveBookmark(e.key === 'ArrowUp' ? -1 : 1);
        else if (count)
          this.selectBookmark(Math.max(0, Math.min(count - 1, this.bookmarkIndex + (e.key === 'ArrowUp' ? -1 : 1))));
      } else if (e.key === 'Insert') {
        this.addBookmark();
      } else if (e.key === 'Delete') {
        this.removeBookmark();
      } else {
        return;
      }
      e.preventDefault();
    });
    $('add').addEventListener('click', () => this.addBookmark());
    $('update').addEventListener('click', () => this.updateBookmark());
    $('remove').addEventListener('click', () => this.removeBookmark());
    $('up').addEventListener('click', () => this.moveBookmark(-1));
    $('down').addEventListener('click', () => this.moveBookmark(1));
    $('clear').addEventListener('click', () => {
      if (this.editor.tr.bookmarks.length)
        this.changeBookmarks([], -1);
    });
    const sort = compare => {
      const list = this.editor.tr.bookmarks;
      const mark = list[this.bookmarkIndex];
      const sorted = [...list].sort(compare);
      if (sorted.some((m, i) => m !== list[i]))
        this.changeBookmarks(sorted, sorted.indexOf(mark));
    };
    $('sort-position').addEventListener('click', () => sort((a, b) => a.frame - b.frame || a.row - b.row));
    $('sort-name').addEventListener('click', () => sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    d.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('input')) {
        e.preventDefault();
        this.updateBookmark();
      }
    });
    this.bookmarkIndex = -1;
  }

  // Module > Bookmark Manager: the track's bookmarks, their names, places and the row
  // highlight they set
  openBookmarks() {
    const d = this.bookmarkDialog;
    d.querySelector('.dnft-dialog-title').textContent = this.strings.bookmarkManager;
    this.bookmarkIndex = -1;
    this.showBookmarks();
    this.fillBookmark(null);
    if (!d.open)
      d.show();
    d.querySelector('[data-role="list"]').focus();
  }

  showBookmarks() {
    const t = this.strings;
    const d = this.bookmarkDialog;
    const list = this.editor.tr.bookmarks;
    if (this.bookmarkIndex >= list.length)
      this.bookmarkIndex = list.length - 1;
    d.querySelector('.dnft-dialog-title').textContent = `${t.bookmarkManager} — ${t.track} ${hex2(this.editor.track + 1)}`;
    d.querySelector('[data-role="list"]').replaceChildren(...list.map((mark, i) => {
      const item = document.createElement('div');
      item.className = 'dnft-bookmark-item';
      item.role = 'option';
      item.dataset.bookmark = i;
      item.textContent = `${mark.name || t.bookmarkUnnamed} (${hex2(mark.frame)},${hex2(mark.row)})`;
      item.classList.toggle('is-current', i === this.bookmarkIndex);
      item.setAttribute('aria-selected', String(i === this.bookmarkIndex));
      return item;
    }));
    const selected = this.bookmarkIndex >= 0;
    for (const role of ['update', 'remove', 'up', 'down'])
      d.querySelector(`[data-role="${role}"]`).disabled = !selected;
  }

  selectBookmark(index) {
    this.bookmarkIndex = index;
    this.showBookmarks();
    this.fillBookmark(this.editor.tr.bookmarks[index] ?? null);
  }

  // The fields, for a bookmark or for a new one at the cursor (CBookmarkDlg::OnLbnSelchangeListBookmarks())
  fillBookmark(mark) {
    const d = this.bookmarkDialog;
    const editor = this.editor;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    const highlight = editor.tr.highlight;
    $('name').value = mark ? mark.name : this.strings.bookmarkName.replace('%1', editor.tr.bookmarks.length + 1);
    $('frame').value = hex2(mark ? mark.frame : editor.cursor.frame);
    $('row').value = hex2(mark ? mark.row : editor.cursor.row);
    ['beat', 'bar'].forEach((role, i) => {
      const value = mark ? mark.highlight[i] : -1;
      $(`${role}-on`).checked = value !== -1;
      $(role).value = value !== -1 ? value : highlight[i];
      $(role).disabled = value === -1;
    });
    $('persist').checked = !!mark?.persist;
  }

  // The bookmark the fields make (CBookmarkDlg::MakeBookmark()), or null
  readBookmark() {
    const d = this.bookmarkDialog;
    const tr = this.editor.tr;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    const frame = parseHex($('frame').value), row = parseHex($('row').value);
    if (!(frame >= 0) || !(row >= 0)) {
      this.editor.message(this.strings.bookmarkBadPlace, true);
      return null;
    }
    const level = role => $(`${role}-on`).checked ? Math.max(0, Math.min(MAX_ROWS, Math.round(Number($(role).value) || 0))) : -1;
    return {
      ...bookmarkPlace(frame, row, tr.frames, tr.rows),
      name: $('name').value,
      highlight: [level('beat'), level('bar')],
      persist: $('persist').checked,
    };
  }

  changeBookmarks(list, select) {
    this.bookmarkIndex = select;
    this.editor.setBookmarks(list);
    this.showBookmarks();
  }

  addBookmark() {
    const mark = this.readBookmark();
    if (mark) {
      const list = [...this.editor.tr.bookmarks, mark];
      this.changeBookmarks(list, list.length - 1);
    }
  }

  updateBookmark() {
    const list = this.editor.tr.bookmarks;
    const mark = this.bookmarkIndex >= 0 && this.readBookmark();
    if (mark)
      this.changeBookmarks(list.map((m, i) => i === this.bookmarkIndex ? mark : m), this.bookmarkIndex);
  }

  removeBookmark() {
    const list = this.editor.tr.bookmarks;
    const at = this.bookmarkIndex;
    if (at < 0)
      return;
    this.changeBookmarks(list.filter((_, i) => i !== at), Math.min(at, list.length - 2));
    this.fillBookmark(this.editor.tr.bookmarks[this.bookmarkIndex] ?? null);
  }

  moveBookmark(delta) {
    const list = [...this.editor.tr.bookmarks];
    const at = this.bookmarkIndex, to = at + delta;
    if (at < 0 || to < 0 || to >= list.length)
      return;
    [list[at], list[to]] = [list[to], list[at]];
    this.changeBookmarks(list, to);
  }

  // ---- MIDI -----------------------------------------------------------------------------

  // Edit > Enable MIDI: notes from the MIDI keyboards there are, as the keyboard's
  toggleMidi() {
    if (this.midi.enabled)
      this.stopMidi();
    else
      this.startMidi(false);
  }

  async startMidi(quiet) {
    const t = this.strings;
    const editor = this.editor;
    if (!navigator.requestMIDIAccess) {
      if (!quiet)
        editor.message(t.midiUnsupported, true);
      return;
    }
    let access;
    try {
      access = await navigator.requestMIDIAccess();
    } catch {
      if (!quiet)
        editor.message(t.midiDenied, true);
      return;
    }
    this.midi.access = access;
    this.midi.enabled = true;
    this.listenMidi();
    access.onstatechange = () => this.listenMidi();
    try {
      localStorage.setItem(MIDI_KEY, '1');
    } catch {
      // the setting is only for the next visit
    }
    if (!quiet) {
      const names = [...access.inputs.values()].map(input => input.name).join(', ');
      editor.message(names ? t.midiOn + names : t.midiNoDevices);
    }
  }

  // The input the Configuration chose, or all of them
  listenMidi() {
    const access = this.midi.access;
    if (!access)
      return;
    const chosen = this.editor.config.get('midiInput');
    const inputs = [...access.inputs.values()];
    const use = inputs.some(input => input.id === chosen) ? inputs.filter(input => input.id === chosen) : inputs;
    for (const input of inputs)
      input.onmidimessage = use.includes(input) ? e => this.onMidiMessage(e.data) : null;
  }

  // The inputs there are, for the Configuration: [{id, name}]
  midiInputs() {
    return this.midi.access ? [...this.midi.access.inputs.values()].map(({ id, name }) => ({ id, name })) : [];
  }

  stopMidi() {
    const access = this.midi.access;
    if (access) {
      for (const input of access.inputs.values())
        input.onmidimessage = null;
      access.onstatechange = null;
    }
    this.midi = { enabled: false, access: null, held: new Map() };
    try {
      localStorage.removeItem(MIDI_KEY);
    } catch {
      // nothing kept
    }
    this.editor.message(this.strings.midiOff);
  }

  // MIDI was on last time: on again, if the browser does not have to ask
  async restoreMidi() {
    try {
      if (localStorage.getItem(MIDI_KEY) !== '1' || !navigator.permissions)
        return;
      const status = await navigator.permissions.query({ name: 'midi' });
      if (status.state === 'granted')
        this.startMidi(true);
    } catch {
      // as off
    }
  }

  // (CFamiTrackerView::TranslateMidiMessage()) note on and off; a note on of velocity 0 is
  // a note off
  onMidiMessage(data) {
    const [status, key, velocity] = data;
    const type = status & 0xF0;
    const editor = this.editor;
    if (!editor.song)
      return;
    // Map MIDI channels to NES channels: channel n plays on the module's channel n, as far as it goes
    const channel = editor.config.get('midiChannelMap') ? Math.min(status & 0x0F, editor.channelCount - 1) : editor.cursor.channel;
    if (type === 0x90 && velocity > 0)
      this.midiNoteOn(key, velocity, channel);
    else if (type === 0x80 || type === 0x90)
      this.midiNoteOff(key, channel);
  }

  // A key of a MIDI keyboard, two octaves down, in the cursor's channel: played, and entered
  // in the edit mode (CFamiTrackerView::TriggerMIDINote())
  midiNoteOn(key, velocity, channel = this.editor.cursor.channel) {
    const t = this.strings;
    const editor = this.editor;
    const midi = key - 24;
    if (midi < 0)
      return;
    const value = Math.min(midi, OCTAVES * 12 - 1);
    const note = value % 12 + 1, octave = Math.floor(value / 12);
    // Record velocities: the volume is the velocity's eighth, as the desktop's note does (a velocity
    // of 127 leaves the volume as it was)
    const volume = editor.config.get('midiVelocity') && velocity + 1 < 128 ? Math.floor((velocity + 1) / 8) : null;
    if (editor.previews())
      this.midi.held.set(`${channel}:${key}`, editor.noteOn(channel, note, octave, editor.config.get('midiVelocity') ? Math.floor(velocity / 8) : undefined));
    if (editor.editMode)
      editor.enterNote(note, octave, editor.cursor.column === 0, volume, channel);
    // with the auto arpeggio on, the status line has its notes (noteOn())
    if (!editor.config.get('midiArpeggio'))
      editor.message(t.midiNote.replace('%1', NOTE_NAMES[note - 1]).replace('%2', octave).replace('%3', velocity));
  }

  midiNoteOff(key, mapped = this.editor.cursor.channel) {
    const held = `${mapped}:${key}`;
    const voice = this.midi.held.get(held);
    if (voice !== undefined) {
      this.midi.held.delete(held);
      this.editor.noteOff(voice);
    }
  }
}

// The text to the clipboard: true when it got there
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // without the clipboard API (or its permission): the old way
    const area = Object.assign(document.createElement('textarea'), { value: text });
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let done = false;
    try {
      done = document.execCommand('copy');
    } catch {
      done = false;
    }
    area.remove();
    return done;
  }
}

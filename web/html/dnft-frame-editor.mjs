// Dn-FamiTracker web port - the frame list as the desktop's frame editor (CFrameEditor):
// a selection of frames and channels, made by dragging over the list (from the frame
// numbers, whole frames) or with Shift and the arrows; the frames' clipboard (Cut, Copy,
// Paste, Paste & Overwrite, Paste & Duplicate, Delete) and the list's right-button menu
// (IDR_FRAME_POPUP); pattern numbers typed or stepped over the selection; and Select > In
// Other Editor, which makes a selection of the pattern one of the frames, and back. The
// engine changes the frames (src/session_bindings.cpp: insertFrames, deleteFrames,
// setFramePatterns, clonePatterns), and every change can be undone.
//
//   const frames = new FrameEditor(editor);   // takes over the editor's frame list
//   frames.render();
//
// The functions that only work on numbers are exported for test/frames.mjs.

import { MAX_FRAMES, MAX_PATTERNS } from './dnft-song.mjs';

// PageUp and PageDown go this many frames (CFrameEditor::OnKeyDown())
const PAGE_FRAMES = 4;
// How often the list scrolls while a drag is past its top or bottom
const SCROLL_INTERVAL = 40;

const hex2 = value => value.toString(16).toUpperCase().padStart(2, '0');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// ---- selections and the clipboard, in numbers ---------------------------------------

// A selection of the frame list (CFrameSelection): from one {frame, channel} to another,
// normalized so that `start` has the first frame and channel and `end` the last
export function normalizeFrames(a, b) {
  return {
    start: { frame: Math.min(a.frame, b.frame), channel: Math.min(a.channel, b.channel) },
    end: { frame: Math.max(a.frame, b.frame), channel: Math.max(a.channel, b.channel) },
  };
}

export const inFrames = (sel, frame, channel) => !!sel &&
  frame >= sel.start.frame && frame <= sel.end.frame && channel >= sel.start.channel && channel <= sel.end.channel;

// Frames in every channel (CFrameEditor::CopyFrame(), and what is used without a selection)
export const wholeFrames = (first, last, channels) => normalizeFrames({ frame: first, channel: 0 }, { frame: last, channel: channels - 1 });

// The patterns of a selection as the clipboard keeps them (CFrameClipData): `channels`
// for each of `frames` frames, the first of them channel `firstChannel`
export function copyFrames(frameList, channelCount, sel) {
  const frames = sel.end.frame - sel.start.frame + 1;
  const channels = sel.end.channel - sel.start.channel + 1;
  const patterns = new Uint8Array(frames * channels);
  for (let f = 0; f < frames; ++f)
    for (let c = 0; c < channels; ++c)
      patterns[f * channels + c] = frameList[(sel.start.frame + f) * channelCount + sel.start.channel + c];
  return { frames, channels, firstChannel: sel.start.channel, patterns };
}

// Where a paste at `frame` puts the clipboard, which it then selects: frames from there,
// only those the track has for Paste & Overwrite (`overwrite`), in the clipboard's own
// channels (CFActionPaste, CFActionPasteOverwrite); null when none of them are there
export function pasteSelection(clip, frame, frameCount, channelCount, overwrite) {
  if (clip.firstChannel >= channelCount)
    return null;
  const last = overwrite ? Math.min(frameCount - 1, frame + clip.frames - 1) : frame + clip.frames - 1;
  if (last < frame)
    return null;
  return normalizeFrames(
    { frame, channel: clip.firstChannel },
    { frame: last, channel: Math.min(channelCount - 1, clip.firstChannel + clip.channels - 1) });
}

// The part of the clipboard that a selection made by pasteSelection() holds
export function cropClip(clip, sel) {
  const frames = sel.end.frame - sel.start.frame + 1;
  const channels = sel.end.channel - sel.start.channel + 1;
  const patterns = new Uint8Array(frames * channels);
  for (let f = 0; f < frames; ++f)
    patterns.set(clip.patterns.subarray(f * clip.channels, f * clip.channels + channels), f * channels);
  return patterns;
}

// The frames Delete takes out: those of the selection, in every channel, but never all
// of them, the last one stays (CFActionDeleteSel); null when the track has one frame
export function deletion(sel, frameCount) {
  const frame = sel.start.frame;
  let count = sel.end.frame - frame + 1;
  if (count >= frameCount) {
    if (frameCount < 2)
      return null;
    count = frameCount - 1;
  }
  return { frame, count };
}

// The patterns of a selection stepped by `delta`, within 00 to FF (CFActionChangePattern)
export function steppedPatterns(frameList, channelCount, sel, delta) {
  return copyFrames(frameList, channelCount, sel).patterns.map(p => clamp(p + delta, 0, MAX_PATTERNS - 1));
}

// Select > In Other Editor (CMainFrame::OnEditSelectother()): the frames and channels of a
// selection of the pattern, and the whole patterns of a selection of the frames, `columns`
// being how many columns a channel has
export const framesOfSelection = sel => normalizeFrames(
  { frame: sel.start.frame, channel: sel.start.channel }, { frame: sel.end.frame, channel: sel.end.channel });

export const patternsOfFrames = (sel, rows, columns) => ({
  start: { frame: sel.start.frame, row: 0, channel: sel.start.channel, column: 0 },
  end: { frame: sel.end.frame, row: rows - 1, channel: sel.end.channel, column: columns(sel.end.channel) - 1 },
});

// The keys of the frame list (CFrameEditor::OnKeyDown() and its accelerators,
// IDR_FRAMEWND); the editor's other shortcuts work there too
const FRAME_KEYS = {
  'C+KeyC': f => f.copy(), 'C+Insert': f => f.copy(), 'C+KeyX': f => f.cut(),
  'C+KeyV': f => f.paste(), 'S+Insert': f => f.paste(),
  '+Delete': f => f.delete(), '+Insert': f => f.editor.frameOp('insert'),
  'C+ArrowUp': f => f.editor.frameOp('up'), 'C+ArrowDown': f => f.editor.frameOp('down'),
  'C+KeyA': f => f.selectScope('track'), '+Escape': f => f.deselect(),
  '+Enter': f => f.toPattern(), '+NumpadEnter': f => f.toPattern(),
  '+NumpadAdd': f => f.stepPatterns(1), 'S+Equal': f => f.stepPatterns(1),
  '+NumpadSubtract': f => f.stepPatterns(-1), '+Minus': f => f.stepPatterns(-1),
};

export class FrameEditor {
  constructor(editor) {
    this.editor = editor;
    this.list = editor.els.frames;
    this.sel = null;          // {start, end, from, to, song, track}: normalized, and as it was made
    this.clipboard = null;    // copyFrames(), as Copy or Cut left it
    this.digits = '';         // the digits of a pattern number being typed
    this.typing = Promise.resolve();   // the digits typed, one after the other
    this.pastEnd = false;     // the cursor on the row after the last frame
    this.drag = null;
    const list = this.list;
    list.addEventListener('pointerdown', e => this.onPointerDown(e));
    list.addEventListener('pointermove', e => this.onPointerMove(e));
    list.addEventListener('pointerup', () => this.endDrag(true));
    list.addEventListener('pointercancel', () => this.endDrag(false));
    list.addEventListener('contextmenu', e => this.onContextMenu(e));
    list.addEventListener('keydown', e => this.onKey(e));
  }

  get strings() {
    return this.editor.strings;
  }

  // The keyboard to the frame list, or to the pattern
  focus() {
    this.editor.activeEditor = 'frames';
    this.list.focus({ preventScroll: true });
  }

  toPattern() {
    this.editor.activeEditor = 'pattern';
    this.editor.view.scroller.focus({ preventScroll: true });
  }

  // The cursor on the row after the last frame (when the track can have one more), where
  // Paste adds frames at the end and a pattern number typed adds a frame
  // (CFrameEditor::m_bLastRow); any move of the cursor leaves it (DnFTEditor.setCursor())
  get atEnd() {
    const editor = this.editor;
    return this.pastEnd && editor.cursor.frame === editor.tr.frames - 1 && editor.tr.frames < MAX_FRAMES;
  }

  // The frame Paste puts frames in at (CFrameEditor::GetEditFrame())
  get editFrame() {
    return this.editor.cursor.frame + (this.atEnd ? 1 : 0);
  }

  // The cursor to a pattern of the list (channel null: the cursor's channel), or to the
  // row after the last frame
  goTo(place) {
    const editor = this.editor;
    const last = editor.tr.frames - 1;
    const channel = place.channel ?? editor.cursor.channel;
    editor.setCursor({ ...editor.cursor, frame: Math.min(place.frame, last), channel, column: channel === editor.cursor.channel ? editor.cursor.column : 0 });
    if (place.frame > last && last + 1 < MAX_FRAMES) {
      this.pastEnd = true;
      this.render();
    }
  }

  // ---- the selection --------------------------------------------------------------------

  // The selection, while the song and track it was made in are shown, within the frames
  // there are now
  get selection() {
    const s = this.sel;
    const editor = this.editor;
    if (!s || s.song !== editor.song || s.track !== editor.track)
      return null;
    const frames = editor.tr.frames, channels = editor.channelCount;
    if (s.start.frame >= frames || s.start.channel >= channels)
      return null;
    return {
      start: s.start,
      end: { frame: Math.min(s.end.frame, frames - 1), channel: Math.min(s.end.channel, channels - 1) },
    };
  }

  // From where the selection was started to where it goes now
  select(from, to) {
    const editor = this.editor;
    this.sel = { ...normalizeFrames(from, to), from: { ...from }, to: { ...to }, song: editor.song, track: editor.track };
    this.renderSelection();
  }

  deselect() {
    if (!this.sel)
      return;
    this.sel = null;
    this.renderSelection();
  }

  // As undo puts it back
  state() {
    return this.sel && { from: this.sel.from, to: this.sel.to, track: this.sel.track };
  }

  restore(state) {
    if (state && state.track === this.editor.track)
      this.select(state.from, state.to);
    else
      this.deselect();
  }

  // Edit > Select, with the frame list in use (CFrameEditor::OnEditSelect*()): 'pattern'
  // (the cursor's), 'frame', 'channel' or 'track'
  selectScope(scope) {
    const editor = this.editor;
    const { frame, channel } = editor.cursor;
    const last = { frame: editor.tr.frames - 1, channel: editor.channelCount - 1 };
    const [from, to] = {
      pattern: [{ frame, channel }, { frame, channel }],
      frame: [{ frame, channel: 0 }, { frame, channel: last.channel }],
      channel: [{ frame: 0, channel }, { frame: last.frame, channel }],
      track: [{ frame: 0, channel: 0 }, last],
    }[scope];
    this.select(from, to);
  }

  // Edit > Select > In Other Editor (CMainFrame::OnEditSelectother()): the selection of the
  // pattern becomes one of its frames and channels here, and this one becomes the whole
  // patterns of its frames there; the other editor then takes the keyboard
  selectInOtherEditor() {
    const editor = this.editor;
    if (editor.activeEditor === 'frames') {
      const sel = this.selection;
      this.deselect();
      if (sel) {
        const place = patternsOfFrames(sel, editor.tr.rows, channel => editor.columns(channel));
        editor.select(place.start, place.end);
      } else {
        editor.deselect();
      }
      this.toPattern();
    } else {
      const sel = editor.selection;
      editor.deselect();
      if (sel) {
        const frames = framesOfSelection(sel);
        this.select(frames.start, frames.end);
      } else {
        this.deselect();
      }
      this.focus();
    }
  }

  // ---- the clipboard ----------------------------------------------------------------------

  // The selection, or the cursor's frame in every channel
  get range() {
    const editor = this.editor;
    return this.selection ?? wholeFrames(editor.cursor.frame, editor.cursor.frame, editor.channelCount);
  }

  // Copy (CFrameEditor::OnEditCopy())
  copy() {
    const editor = this.editor;
    this.clipboard = copyFrames(editor.tr.frameList, editor.channelCount, this.range);
  }

  // Cut: Copy, then Delete
  async cut() {
    this.copy();
    await this.delete();
  }

  // Delete: the frames of the selection, or the cursor's (CFActionDeleteSel)
  async delete() {
    const editor = this.editor;
    const track = editor.track;
    const range = deletion(this.range, editor.tr.frames);
    if (!range) {
      editor.message(this.strings.lastFrameStays, true);
      return;
    }
    await editor.changeFrames(() => editor.session.call('deleteFrames', track, range.frame, range.count), () => {
      this.deselect();
      editor.setCursor({ ...editor.cursor, frame: Math.min(range.frame, editor.tr.frames - 1) });
    });
  }

  // Paste ('insert': the frames go in before the cursor's), Paste & Overwrite ('overwrite':
  // over the cursor's frame and those after it) and Paste & Duplicate ('duplicate': in
  // they go, with copies of their patterns); what was pasted is then selected
  // (CFActionPaste, CFActionPasteOverwrite)
  async paste(mode = 'insert') {
    const editor = this.editor;
    const t = this.strings;
    const clip = this.clipboard;
    if (!clip)
      return;
    const track = editor.track;
    const frame = this.editFrame;
    const frames = editor.tr.frames;
    const overwrite = mode === 'overwrite';
    // after the last frame there is nothing to overwrite
    if (overwrite && frame >= frames)
      return;
    if (!overwrite && frames + clip.frames > MAX_FRAMES) {
      editor.message(t.tooManyFrames.replace('{n}', MAX_FRAMES), true);
      return;
    }
    const target = pasteSelection(clip, frame, frames, editor.channelCount, overwrite);
    if (!target) {
      editor.message(t.noClipChannels, true);
      return;
    }
    if (overwrite) {
      this.setBlock(target, cropClip(clip, target), () => this.select(target.start, target.end));
      return;
    }
    let uncopied = 0;
    const run = async () => {
      if (!await editor.session.call('insertFrames', track, frame, clip.frames))
        return false;
      await editor.session.call('setFramePatterns', track, frame, target.start.channel, target.end.channel - target.start.channel + 1, cropClip(clip, target));
      if (mode === 'duplicate')
        uncopied = await editor.session.call('clonePatterns', track, target.start.frame, target.end.frame, target.start.channel, target.end.channel);
    };
    const after = () => {
      editor.setCursor({ ...editor.cursor, frame });
      this.select(target.start, target.end);
    };
    if (await editor.changeFrames(run, after) && uncopied)
      editor.message(t.uncopiedPatterns.replace('{n}', uncopied), true);
  }

  // Clone Patterns with frames selected: each pattern they play copied to a free number
  // (CFActionClonePatterns)
  async clonePatterns() {
    const editor = this.editor;
    const sel = this.selection;
    const track = editor.track;
    let uncopied = 0;
    const run = async () => {
      uncopied = await editor.session.call('clonePatterns', track, sel.start.frame, sel.end.frame, sel.start.channel, sel.end.channel);
    };
    if (await editor.changeFrames(run) && uncopied)
      editor.message(this.strings.uncopiedPatterns.replace('{n}', uncopied), true);
  }

  // ---- pattern numbers ----------------------------------------------------------------------

  // Patterns of a block of the frame list (`sel`, which `patterns` fills row by row) set in
  // the page's copy and the module, undoably; `after` places the selection
  setBlock(sel, patterns, after = null) {
    const editor = this.editor;
    const track = editor.track;
    const channels = editor.channelCount;
    const width = sel.end.channel - sel.start.channel + 1;
    const old = copyFrames(editor.tr.frameList, channels, sel).patterns;
    if (old.every((p, i) => p === patterns[i])) {
      after?.();
      return;
    }
    const apply = values => {
      editor.showTrack(track);
      const list = editor.song.track(track).frameList;
      values.forEach((p, i) => { list[(sel.start.frame + Math.floor(i / width)) * channels + sel.start.channel + i % width] = p; });
      editor.session.send('setFramePatterns', track, sel.start.frame, sel.start.channel, width, values);
      editor.renderFrames();
      editor.view.invalidate();
    };
    const before = editor.frameEditState();
    apply(patterns);
    after?.();
    const state = editor.frameEditState();
    editor.record({
      undo: () => { apply(old); editor.restoreFrameEditState(before); },
      redo: () => { apply(patterns); editor.restoreFrameEditState(state); },
    });
  }

  // + and -: the pattern at the cursor, or every one of the selection, one up or down
  // (CFActionChangePattern)
  stepPatterns(delta) {
    const editor = this.editor;
    this.digits = '';
    const sel = this.selection;
    if (!sel) {
      const { frame, channel } = editor.cursor;
      editor.setFramePattern(frame, channel, editor.patternOf(frame, channel) + delta);
      return;
    }
    this.setBlock(sel, steppedPatterns(editor.tr.frameList, editor.channelCount, sel, delta));
  }

  // A hex digit typed: the pattern number at the cursor, or of every pattern of the
  // selection, from its last two digits (CFActionSetPattern); after the last frame, a frame
  // is added with it (CFActionFrameCount)
  async typeDigit(value) {
    const editor = this.editor;
    if (this.atEnd) {
      const track = editor.track;
      const frame = editor.tr.frames, channel = editor.cursor.channel;
      this.digits = value.toString(16);
      await editor.changeFrames(async () => {
        if (!await editor.session.call('insertFrames', track, frame, 1))
          return false;
        await editor.session.call('setFramePatterns', track, frame, channel, 1, Uint8Array.of(value));
      }, () => editor.setCursor({ ...editor.cursor, frame }));
      return;
    }
    this.digits = (this.digits + value.toString(16)).slice(-2);
    const pattern = parseInt(this.digits, 16);
    if (this.digits.length === 2)
      this.digits = '';
    const sel = this.selection;
    if (!sel) {
      editor.setFramePattern(editor.cursor.frame, editor.cursor.channel, pattern);
      return;
    }
    const size = (sel.end.frame - sel.start.frame + 1) * (sel.end.channel - sel.start.channel + 1);
    this.setBlock(sel, new Uint8Array(size).fill(pattern));
  }

  // ---- the keyboard ---------------------------------------------------------------------

  onKey(e) {
    const editor = this.editor;
    if (!editor.song || e.target !== this.list)
      return;
    editor.activeEditor = 'frames';
    const ctrl = e.ctrlKey || e.metaKey;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    const modifiers = (ctrl ? 'C' : '') + (e.altKey ? 'A' : '') + (e.shiftKey ? 'S' : '');
    const command = FRAME_KEYS[`${modifiers}+${e.code}`];
    if (command) {
      done();
      command(this);
      return;
    }
    const step = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
      PageUp: [-PAGE_FRAMES, 0], PageDown: [PAGE_FRAMES, 0], Home: [-MAX_FRAMES, 0], End: [MAX_FRAMES, 0],
    }[e.code];
    if (step && !ctrl && !e.altKey) {
      done();
      this.move(step[0], step[1], e.shiftKey);
      return;
    }
    if (ctrl || e.altKey)
      return;
    const value = hexDigit(e.code);
    if (value >= 0) {
      done();
      this.typing = this.typing.then(() => this.typeDigit(value));
    }
  }

  // The cursor to another frame or channel, down to the row after the last frame; with
  // Shift, the selection goes along (CFrameEditor::OnKeyDown())
  move(frames, channels, extend) {
    const editor = this.editor;
    const { frame, channel } = editor.cursor;
    const count = editor.tr.frames;
    const last = !extend && count < MAX_FRAMES ? count : count - 1;
    const target = clamp(frame + (this.atEnd ? 1 : 0) + frames, 0, last);
    const to = { frame: Math.min(target, count - 1), channel: clamp(channel + channels, 0, editor.channelCount - 1) };
    this.digits = '';
    if (extend)
      this.select(this.sel && this.selection ? this.sel.from : { frame, channel }, to);
    else
      this.deselect();
    this.goTo({ frame: target, channel: to.channel });
  }

  // ---- the mouse --------------------------------------------------------------------------

  // The frame and channel at a point of the list (channel null: the frame numbers); a
  // point outside it counts as on its nearest edge
  hit(x, y) {
    const rows = this.list.children;
    if (!rows.length)
      return null;
    const box = this.list.getBoundingClientRect();
    x = clamp(x, box.left + 1, box.right - 2);
    y = clamp(y, box.top + 1, box.bottom - 2);
    const first = rows[0].getBoundingClientRect();
    const row = rows[clamp(Math.floor((y - first.top) / (first.height || 1)), 0, rows.length - 1)];
    const frame = Number(row.dataset.index);
    const cells = row.querySelectorAll('.dnft-frame-pattern');
    if (!cells.length || x < cells[0].getBoundingClientRect().left)
      return { frame, channel: null };
    for (const cell of cells)
      if (x < cell.getBoundingClientRect().right)
        return { frame, channel: Number(cell.dataset.channel) };
    return { frame, channel: cells.length - 1 };
  }

  // As the desktop's: a click puts the cursor on the pattern (once the button is let go), a
  // drag selects, from the frame numbers whole frames; Shift extends the selection
  onPointerDown(e) {
    const editor = this.editor;
    if (e.button !== 0 || !editor.song)
      return;
    const place = this.hit(e.clientX, e.clientY);
    if (!place)
      return;
    e.preventDefault();
    this.focus();
    this.digits = '';
    const last = editor.channelCount - 1;
    const frame = Math.min(place.frame, editor.tr.frames - 1);
    if (e.shiftKey) {
      const from = this.sel && this.selection ? this.sel.from : { frame: editor.cursor.frame, channel: place.channel === null ? 0 : editor.cursor.channel };
      this.select(from, { frame, channel: place.channel ?? last });
      this.drag = { from, whole: place.channel === null, moved: true };
    } else {
      this.drag = { from: { frame, channel: place.channel ?? 0 }, whole: place.channel === null, click: place };
    }
    this.drag.pointer = { x: e.clientX, y: e.clientY };
    this.list.setPointerCapture(e.pointerId);
  }

  onPointerMove(e) {
    if (!this.drag)
      return;
    this.drag.pointer = { x: e.clientX, y: e.clientY };
    this.dragTo();
    this.autoScroll();
  }

  // The selection from where the drag started to the pattern under the pointer
  dragTo() {
    const { drag } = this;
    const place = this.hit(drag.pointer.x, drag.pointer.y);
    if (!place)
      return;
    place.frame = Math.min(place.frame, this.editor.tr.frames - 1);
    if (!drag.moved && place.frame === drag.from.frame && (drag.whole ? place.channel === null : place.channel === drag.from.channel))
      return;
    drag.moved = true;
    if (drag.whole)
      this.select({ frame: drag.from.frame, channel: 0 }, { frame: place.frame, channel: this.editor.channelCount - 1 });
    else
      this.select(drag.from, { frame: place.frame, channel: place.channel ?? 0 });
  }

  // Past the top or the bottom of the list the cursor goes on a frame at a time, and the
  // list with it (CFrameEditor::AutoScroll())
  autoScroll() {
    const { drag } = this;
    const box = this.list.getBoundingClientRect();
    drag.direction = drag.pointer.y < box.top ? -1 : drag.pointer.y > box.bottom ? 1 : 0;
    if (!drag.direction || drag.timer)
      return;
    drag.timer = setInterval(() => {
      const editor = this.editor;
      if (this.drag !== drag || !drag.direction) {
        clearInterval(drag.timer);
        drag.timer = null;
        return;
      }
      const frame = editor.cursor.frame + drag.direction;
      if (frame < 0 || frame >= editor.tr.frames)
        return;
      editor.setCursor({ ...editor.cursor, frame }, { keep: true });
      this.dragTo();
    }, SCROLL_INTERVAL);
  }

  // The button let go (`click`: without a drag, the cursor goes to the pattern), or the
  // drag called off
  endDrag(click) {
    const drag = this.drag;
    if (!drag)
      return;
    clearInterval(drag.timer);
    this.drag = null;
    if (!click || drag.moved || !drag.click)
      return;
    this.deselect();
    this.goTo(drag.click);
  }

  // The right button: the frame menu (IDR_FRAME_POPUP), for the pattern under the pointer
  // (the cursor goes there unless it is in the selection)
  onContextMenu(e) {
    const editor = this.editor;
    e.preventDefault();
    if (!editor.song)
      return;
    this.focus();
    const place = this.hit(e.clientX, e.clientY);
    if (place && !inFrames(this.selection, place.frame, place.channel ?? editor.cursor.channel)) {
      this.deselect();
      this.goTo(place);
    }
    editor.files.contextMenu(this.menuItems(), e.clientX, e.clientY, () => this.focus());
  }

  menuItems() {
    const t = this.strings;
    const editor = this.editor;
    const noClip = () => !this.clipboard;
    const full = () => editor.tr.frames >= MAX_FRAMES;
    return [
      { label: t.frameInsert, hint: t.insertFrameHint, shortcut: 'Insert', run: () => editor.frameOp('insert'), disabled: full },
      { label: t.frameRemove, hint: t.removeFrameHint, run: () => editor.frameOp('remove'), disabled: () => editor.tr.frames < 2 },
      { label: t.frameDuplicate, hint: t.duplicateFrameHint, shortcut: 'Ctrl+D', run: () => editor.frameOp('duplicate'), disabled: full },
      { label: t.clonePattern, hint: t.clonePatternHint, shortcut: 'Alt+D', run: () => editor.songMenu.clonePattern() },
      { label: t.frameClone, hint: t.cloneFrameHint, run: () => editor.frameOp('clone'), disabled: full },
      null,
      { label: t.frameMoveUp, shortcut: 'Ctrl+↑', run: () => editor.frameOp('up'), disabled: () => editor.cursor.frame === 0 },
      { label: t.frameMoveDown, shortcut: 'Ctrl+↓', run: () => editor.frameOp('down'), disabled: () => editor.cursor.frame >= editor.tr.frames - 1 },
      null,
      { label: t.cutItem, hint: t.frameCutHint, shortcut: 'Ctrl+X', run: () => this.cut() },
      { label: t.copyItem, hint: t.frameCopyHint, shortcut: 'Ctrl+C', run: () => this.copy() },
      { label: t.pasteItem, hint: t.framePasteHint, shortcut: 'Ctrl+V', run: () => this.paste(), disabled: noClip },
      { label: t.framePasteOverwrite, hint: t.framePasteOverwriteHint, run: () => this.paste('overwrite'), disabled: noClip },
      { label: t.framePasteDuplicate, hint: t.framePasteDuplicateHint, run: () => this.paste('duplicate'), disabled: noClip },
      { label: t.deleteItem, hint: t.frameDeleteHint, shortcut: 'Del', run: () => this.delete(), disabled: () => editor.tr.frames < 2 },
    ];
  }

  // ---- drawing ----------------------------------------------------------------------------

  // The frame list: a row for each frame, its number and the pattern of each channel, and
  // one after the last frame (CFrameEditor::DrawFrameEditor())
  render() {
    const editor = this.editor;
    const tr = editor.tr;
    const channels = editor.channelCount;
    const current = this.atEnd ? tr.frames : editor.cursor.frame;
    const currentChannel = editor.cursor.channel;
    const marked = new Set(tr.bookmarks.map(mark => mark.frame));
    const sel = this.selection;
    const rows = [];
    for (let f = 0; f < tr.frames; ++f) {
      const row = document.createElement('div');
      row.className = 'dnft-frame-row';
      row.dataset.index = f;
      row.classList.toggle('is-current', f === current);
      row.classList.toggle('is-playing', !!editor.play && editor.play.frame === f);
      row.classList.toggle('is-bookmarked', marked.has(f));
      row.classList.toggle('is-marker', editor.marker?.frame === f);
      const number = document.createElement('span');
      number.className = 'dnft-frame-number';
      number.textContent = editor.frameLabel(f);
      row.append(number);
      for (let c = 0; c < channels; ++c) {
        const cell = document.createElement('span');
        cell.className = 'dnft-frame-pattern';
        cell.classList.toggle('is-channel', f === current && c === currentChannel);
        cell.classList.toggle('is-selected', inFrames(sel, f, c));
        cell.dataset.channel = c;
        cell.textContent = hex2(tr.frameList[f * channels + c]);
        row.append(cell);
      }
      rows.push(row);
    }
    if (tr.frames < MAX_FRAMES) {
      const row = document.createElement('div');
      row.className = 'dnft-frame-row is-end';
      row.dataset.index = tr.frames;
      row.classList.toggle('is-current', current === tr.frames);
      const number = document.createElement('span');
      number.className = 'dnft-frame-number';
      number.textContent = '>>';
      row.append(number);
      for (let c = 0; c < channels; ++c) {
        const cell = document.createElement('span');
        cell.className = 'dnft-frame-pattern';
        cell.classList.toggle('is-channel', current === tr.frames && c === currentChannel);
        cell.dataset.channel = c;
        cell.textContent = '--';
        row.append(cell);
      }
      rows.push(row);
    }
    this.list.replaceChildren(...rows);
    // the current frame in view, without scrolling the page
    const row = rows[current];
    if (row) {
      const list = this.list;
      const top = row.offsetTop - list.offsetTop, bottom = top + row.offsetHeight;
      if (top < list.scrollTop)
        list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight)
        list.scrollTop = bottom - list.clientHeight;
    }
  }

  // Only the marks of the selection, as it is dragged
  renderSelection() {
    const sel = this.selection;
    for (const row of this.list.children) {
      const frame = Number(row.dataset.index);
      for (const cell of row.querySelectorAll('.dnft-frame-pattern'))
        cell.classList.toggle('is-selected', inFrames(sel, frame, Number(cell.dataset.channel)));
    }
  }
}

function hexDigit(code) {
  if (/^(Digit|Numpad)[0-9]$/.test(code))
    return Number(code.at(-1));
  if (/^Key[A-F]$/.test(code))
    return 10 + code.charCodeAt(3) - 65;
  return -1;
}

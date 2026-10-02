// Dn-FamiTracker web port - the editor's Song and Module menus: what the desktop
// tracker's Song menu does to the patterns and frames of a track (Clone Patterns, Merge
// Duplicated Patterns, Populate Unique Patterns, Clear Patterns, Estimate Song Length),
// and the settings of its Module menu and module properties that the side panel does
// not show (Detune Settings, Groove Settings, the device mix offsets, the VRC7's
// patches), with Module > Cleanup; its Bookmark Manager is dnft-pattern-menu.mjs's. The
// engine does the work (src/session_bindings.cpp); what the desktop lets undo can be
// undone here too.
//
//   const menus = new SongMenu(editor);   // adds its menus after the Import and Export menus

import { CELL, CHIP, EMPTY_CELL, MAX_PATTERNS, emptyPattern, isEmptyCell } from './dnft-song.mjs';

const EF_SPEED = 1;
// Grooves (FamiTrackerTypes.h, Groove.h): how many, how long, and the room a module has
const MAX_GROOVE = 32;
const MAX_GROOVE_SIZE = 128;
const MAX_GROOVE_BYTES = 255;
const DEFAULT_SPEED = 6;
// The detune tables: NTSC and PAL 2A03, VRC6 sawtooth, VRC7, FDS, N163, 96 notes each;
// the VRC7's uses the first octave's for all (CDetuneDlg)
const DETUNE_CHIPS = 6;
const NOTE_RANGE = 12;
const NOTES = 8 * NOTE_RANGE;
const VRC7_TABLE = 3;
const MAX_DETUNE = 255;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// The devices of the mix offsets and the chip each needs, and how far they go: 12 dB in
// tenths (CModulePropertiesDlg)
const MIX_CHIPS = [0, 0, CHIP.VRC6, CHIP.VRC7, CHIP.FDS, CHIP.MMC5, CHIP.N163, CHIP.S5B];
const MAX_LEVEL = 120;
const OPLL_PATCHES = 19;

const hex2 = value => value.toString(16).toUpperCase().padStart(2, '0');
const pad2 = value => String(value).padStart(2, '0');
const isEmptyPattern = data => !data || Array.from({ length: data.length / CELL }).every((_, r) => isEmptyCell(data.subarray(r * CELL, r * CELL + CELL)));
// What tells patterns apart: their cells, or nothing for an empty one
const patternKey = data => isEmptyPattern(data) ? '' : String.fromCharCode(...data);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// A byte as the desktop's fields take it: $hex, 0xhex or decimal
function parseByte(token) {
  const value = /^\$/.test(token) ? parseInt(token.slice(1), 16) : /^0x/i.test(token) ? parseInt(token.slice(2), 16) : parseInt(token, 10);
  return Number.isNaN(value) ? null : clamp(value, 0, 255);
}

export class SongMenu {
  constructor(editor) {
    this.editor = editor;
    this.build();
  }

  get strings() {
    return this.editor.strings;
  }

  get session() {
    return this.editor.session;
  }

  // ---- building ------------------------------------------------------------------------

  build() {
    const t = this.strings;
    const files = this.editor.files;   // the toolbar's menus and dialogs
    const songMenu = files.menu(t.songMenu, t.songMenuHint, [
      { label: t.clonePattern, hint: t.clonePatternHint, run: () => this.clonePattern() },
      { label: t.mergePatterns, hint: t.mergePatternsHint, run: () => this.mergeDuplicatedPatterns() },
      { label: t.populatePatterns, hint: t.populatePatternsHint, run: () => this.populateUniquePatterns() },
      { label: t.clearPatterns, hint: t.clearPatternsHint, run: () => this.clearPatterns() },
      null,
      { label: t.songLength, hint: t.songLengthHint, run: () => this.estimateLength() },
    ]);
    const moduleMenu = files.menu(t.moduleMenu, t.moduleMenuHint, [
      { label: t.detuneSettings, hint: t.detuneSettingsHint, run: () => this.openDetune() },
      { label: t.grooveSettings, hint: t.grooveSettingsHint, run: () => this.openGrooves() },
      { label: t.mixerSettings, hint: t.mixerSettingsHint, run: () => this.openMixer() },
      { label: t.opllSettings, hint: t.opllSettingsHint, run: () => this.openOpll() },
      { label: t.bookmarkManager, hint: t.bookmarkManagerHint, run: () => this.editor.patternMenu.openBookmarks() },
      null,
      { label: t.removeUnusedInstruments, hint: t.removeUnusedInstrumentsHint, run: () => this.removeUnused('Instruments') },
      { label: t.removeUnusedPatterns, hint: t.removeUnusedPatternsHint, run: () => this.removeUnused('Patterns') },
      { label: t.removeUnusedSamples, hint: t.removeUnusedSamplesHint, run: () => this.removeUnused('Samples') },
    ]);
    const menus = this.editor.root.querySelectorAll('.dnft-toolbar .dnft-menu-wrap');
    menus[menus.length - 1].after(songMenu, moduleMenu);

    this.csvInput = files.fileInput('.csv,text/csv', file => this.importDetune(file));
    this.editor.root.append(this.csvInput);
    this.buildDetuneDialog();
    this.buildGrooveDialog();
    this.buildMixerDialog();
    this.buildOpllDialog();
  }

  // ---- the Song menu ---------------------------------------------------------------------

  // Song > Clone Patterns: the pattern at the cursor, copied to the channel's first free
  // number, which the frame then plays (CFActionClonePatterns)
  async clonePattern() {
    const t = this.strings;
    const editor = this.editor;
    const track = editor.track;
    const { frame, channel } = editor.cursor;
    const old = editor.patternOf(frame, channel);
    const data = editor.song.patternData(track, channel, old);
    if (isEmptyPattern(data)) {
      editor.message(t.emptyPattern);
      return;
    }
    const fresh = await this.session.call('freePattern', track, channel);
    if (fresh < 0) {
      editor.message(t.noFreePattern, true);
      return;
    }
    const cells = Uint8Array.from(data);
    const set = (pattern, contents) => {
      editor.showTrack(track);
      const rows = editor.song.track(track).rows;
      editor.writeCells(track, channel, fresh, 0, contents.subarray(0, rows * CELL));
      editor.song.track(track).frameList[frame * editor.channelCount + channel] = pattern;
      this.session.send('setFramePattern', track, frame, channel, pattern);
      editor.renderFrames();
      editor.view.invalidate();
    };
    set(fresh, cells);
    editor.record({
      undo: () => set(old, emptyPattern(editor.song.track(track).rows)),
      redo: () => set(fresh, cells),
    });
    editor.message(t.clonedPattern.replace('{from}', hex2(old)).replace('{to}', hex2(fresh)));
  }

  // Song > Merge Duplicated Patterns: each pattern a frame plays gives way to the lowest
  // numbered one with the same rows, an empty one to the lowest empty one
  // (CFActionMergeDuplicated)
  async mergeDuplicatedPatterns() {
    const t = this.strings;
    const editor = this.editor;
    const track = editor.track;
    const tr = editor.tr;
    const channels = editor.channelCount;
    const before = editor.frameState();
    const list = Uint8Array.from(before.list);
    let merged = 0;
    for (let c = 0; c < channels; ++c) {
      const lowest = new Map();
      const keys = Array.from({ length: MAX_PATTERNS }, (_, p) => patternKey(editor.song.patternData(track, c, p)));
      keys.forEach((key, p) => {
        if (!lowest.has(key))
          lowest.set(key, p);
      });
      for (let f = 0; f < tr.frames; ++f) {
        const at = f * channels + c;
        const into = lowest.get(keys[list[at]]);
        if (into !== list[at]) {
          list[at] = into;
          ++merged;
        }
      }
    }
    if (!merged) {
      editor.message(t.noDuplicates);
      return;
    }
    const after = { frames: before.frames, list };
    const apply = async state => {
      editor.showTrack(track);
      await editor.restoreFrames(track, state);
      editor.afterFrames(editor.cursor);
    };
    await apply(after);
    editor.record({ undo: () => apply(before), redo: () => apply(after) });
    editor.message(t.mergedPatterns.replace('{n}', merged));
  }

  // Song > Populate Unique Patterns and Clear Patterns, which the desktop cannot undo
  async populateUniquePatterns() {
    if (confirm(this.strings.confirmPopulatePatterns))
      await this.changeTrack('populateUniquePatterns', this.strings.populatedPatterns);
  }

  async clearPatterns() {
    if (confirm(this.strings.confirmClearPatterns))
      await this.changeTrack('clearPatterns', this.strings.clearedPatterns);
  }

  async changeTrack(method, done) {
    const editor = this.editor;
    const track = editor.track;
    await this.session.call(method, track);
    await editor.reloadTrack(track);
    editor.history.clear();
    editor.afterFrames(editor.cursor);
    editor.edited();
    editor.message(done);
  }

  // Song > Estimate Song Length, as the desktop's message box has it
  async estimateLength() {
    const t = this.strings;
    const { intro, loop, frameRate } = await this.session.call('songLength', this.editor.track);
    // CMainFrame::OnModuleEstimateSongLength()
    const time = seconds => `${Math.floor(Math.floor(seconds + 0.5 / 6000) / 60)}:${pad2(Math.floor(seconds + 0.005) % 60)}.${pad2(Math.floor(seconds * 100 + 0.5) % 100)}`;
    const ticks = seconds => Math.floor(seconds * frameRate + 0.5);
    this.editor.message(t.songLengthResult.replace('{intro}', time(intro)).replace('{introTicks}', ticks(intro))
      .replace('{loop}', time(loop)).replace('{loopTicks}', ticks(loop)));
  }

  // ---- Module > Cleanup ------------------------------------------------------------------

  // kind: Instruments, Patterns or Samples. Removing patterns and samples cannot be undone
  // on the desktop, nor what was done before.
  async removeUnused(kind) {
    const t = this.strings;
    const editor = this.editor;
    if (!confirm(t[`confirmRemoveUnused${kind}`]))
      return;
    // the instrument being edited might go (CMainFrame::OnEditRemoveUnusedInstruments())
    if (kind !== 'Patterns')
      editor.instrumentEditor.close();
    await this.session.call(`removeUnused${kind}`);
    if (kind === 'Patterns' || kind === 'Samples') {
      editor.history.clear();
      await editor.reloadTracks();
    }
    await editor.refreshInstruments();
    if (!editor.song.instrument(editor.instrument))
      editor.selectInstrument(editor.song.instruments[0]?.index ?? 0, { quiet: true });
    editor.edited();
    editor.message(t.removedUnused);
  }

  // ---- Module > Detune Settings ----------------------------------------------------------

  buildDetuneDialog() {
    const t = this.strings;
    const d = this.detuneDialog = this.editor.files.dialog('dnft-detune-dialog', `
      <label class="dnft-field dnft-field--inline"><span data-t="detuneChip"></span><select data-role="chip"></select></label>
      <fieldset class="dnft-fieldset">
        <legend data-t="detuneOffsets"></legend>
        <div class="dnft-detune-grid" data-role="grid"></div>
        <p class="dnft-hint" data-t="detuneHint"></p>
        <div class="dnft-choices">
          <button type="button" class="dnft-button" data-role="reset" data-t="detuneReset"></button>
          <button type="button" class="dnft-button" data-role="import" data-t="detuneImport"></button>
          <button type="button" class="dnft-button" data-role="export" data-t="detuneExport"></button>
        </div>
      </fieldset>
      <fieldset class="dnft-fieldset">
        <legend data-t="detuneTuning"></legend>
        <div class="dnft-choices">
          <label class="dnft-check"><span data-t="detuneSemitone"></span><input type="number" data-role="semitone" min="-12" max="12" step="1"></label>
          <label class="dnft-check"><span data-t="detuneCent"></span><input type="number" data-role="cent" min="-100" max="100" step="1"></label>
        </div>
      </fieldset>`, `
      <button type="button" class="dnft-button dnft-button--primary" data-role="ok" data-t="ok"></button>
      <button type="button" class="dnft-button" data-role="cancel" data-t="cancel"></button>`);
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    $('chip').append(...t.detuneChips.map((name, i) => new Option(name, i)));
    $('chip').addEventListener('change', () => this.showDetuneTable());
    // an offset typed in: VRC7 notes have one for all octaves
    $('grid').addEventListener('change', e => {
      const input = e.target.closest('input[data-note]');
      if (!input)
        return;
      const chip = Number($('chip').value);
      const value = clamp(Math.round(Number(input.value) || 0), -MAX_DETUNE, MAX_DETUNE);
      const note = Number(input.dataset.note);
      const notes = chip === VRC7_TABLE ? Array.from({ length: NOTES / NOTE_RANGE }, (_, o) => o * NOTE_RANGE + note % NOTE_RANGE) : [note];
      for (const n of notes)
        this.detune.offsets[chip * NOTES + n] = value;
      input.value = value;
    });
    $('reset').addEventListener('click', () => {
      const chip = Number($('chip').value);
      this.detune.offsets.fill(0, chip * NOTES, (chip + 1) * NOTES);
      this.showDetuneTable();
    });
    $('import').addEventListener('click', () => this.csvInput.click());
    $('export').addEventListener('click', () => this.exportDetune());
    for (const [role, max] of [['semitone', NOTE_RANGE], ['cent', 100]])
      $(role).addEventListener('change', () => {
        this.detune[role] = clamp(Math.round(Number($(role).value) || 0), -max, max);
        $(role).value = this.detune[role];
      });
    $('ok').addEventListener('click', () => this.applyDetune());
    $('cancel').addEventListener('click', () => d.close());
  }

  async openDetune() {
    const d = this.detuneDialog;
    const detune = await this.session.call('detune');
    this.detune = { offsets: Int16Array.from(detune.offsets), semitone: detune.semitone, cent: detune.cent };
    d.querySelector('.dnft-dialog-title').textContent = this.strings.detuneTitle;
    d.querySelector('[data-role="semitone"]').value = detune.semitone;
    d.querySelector('[data-role="cent"]').value = detune.cent;
    this.showDetuneTable();
    d.showModal();
  }

  // The offsets of the chip chosen: octaves by notes, or one row for the VRC7
  showDetuneTable() {
    const t = this.strings;
    const d = this.detuneDialog;
    const chip = Number(d.querySelector('[data-role="chip"]').value);
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    head.append(document.createElement('th'), ...NOTE_NAMES.map(name => Object.assign(document.createElement('th'), { textContent: name })));
    const body = table.createTBody();
    const octaves = chip === VRC7_TABLE ? [null] : Array.from({ length: NOTES / NOTE_RANGE }, (_, o) => o);
    for (const octave of octaves) {
      const row = body.insertRow();
      row.append(Object.assign(document.createElement('th'), { textContent: octave === null ? t.detuneAllOctaves : octave }));
      for (let n = 0; n < NOTE_RANGE; ++n) {
        const note = (octave ?? 0) * NOTE_RANGE + n;
        const input = document.createElement('input');
        input.type = 'number';
        input.min = -MAX_DETUNE;
        input.max = MAX_DETUNE;
        input.step = 1;
        input.dataset.note = note;
        input.value = this.detune.offsets[chip * NOTES + note];
        input.setAttribute('aria-label', `${NOTE_NAMES[n]}${octave ?? ''}`);
        row.insertCell().append(input);
      }
    }
    d.querySelector('[data-role="grid"]').replaceChildren(table);
  }

  async applyDetune() {
    const editor = this.editor;
    const { offsets, semitone, cent } = this.detune;
    await this.session.call('setDetune', offsets, semitone, cent);
    this.detuneDialog.close();
    editor.edited();
    editor.message(this.strings.detuneApplied);
  }

  // The desktop's CSV of the detune tables: a line for each chip, its number and then its
  // 96 offsets (CDetuneDlg::OnBnClickedButtonExport())
  exportDetune() {
    const lines = Array.from({ length: DETUNE_CHIPS }, (_, chip) =>
      [chip, ...this.detune.offsets.subarray(chip * NOTES, (chip + 1) * NOTES)].join(',') + '\n');
    this.editor.files.download(`${this.editor.fileBase()}.csv`, new Blob(lines, { type: 'text/csv' }));
  }

  async importDetune(file) {
    const offsets = Int16Array.from(this.detune.offsets);
    let read = 0;
    for (const line of (await file.text()).split(/\r?\n/)) {
      const values = line.split(',').map(v => parseInt(v, 10));
      if (values.length < 2 || values.some(Number.isNaN) || values[0] < 0 || values[0] >= DETUNE_CHIPS)
        continue;
      values.slice(1, NOTES + 1).forEach((value, note) => {
        offsets[values[0] * NOTES + note] = clamp(value, -MAX_DETUNE, MAX_DETUNE);
      });
      ++read;
    }
    if (!read) {
      this.editor.message(this.strings.detuneBadCsv, true);
      return;
    }
    this.detune.offsets = offsets;
    this.showDetuneTable();
  }

  // ---- Module > Groove Settings ----------------------------------------------------------

  buildGrooveDialog() {
    const d = this.grooveDialog = this.editor.files.dialog('dnft-groove-dialog', `
      <div class="dnft-groove">
        <div class="dnft-field"><span data-t="grooveList"></span><div class="dnft-groove-list" role="listbox" data-role="list"></div></div>
        <div class="dnft-groove-edit">
          <label class="dnft-field"><span data-t="grooveEntries"></span><input type="text" data-role="entries" spellcheck="false" autocomplete="off"></label>
          <p class="dnft-hint" data-t="grooveEntriesHint"></p>
          <p class="dnft-groove-info" data-role="info"></p>
          <div class="dnft-choices">
            <button type="button" class="dnft-button" data-role="up" data-t="grooveUp"></button>
            <button type="button" class="dnft-button" data-role="down" data-t="grooveDown"></button>
            <button type="button" class="dnft-button" data-role="clear" data-t="grooveClear"></button>
            <button type="button" class="dnft-button" data-role="clear-all" data-t="grooveClearAll"></button>
          </div>
          <div class="dnft-choices">
            <button type="button" class="dnft-button" data-role="expand" data-t="grooveExpand"></button>
            <button type="button" class="dnft-button" data-role="shrink" data-t="grooveShrink"></button>
          </div>
          <div class="dnft-choices" data-role="generate-row">
            <input type="number" data-role="numerator" min="1" max="${MAX_GROOVE_SIZE * 255}" value="12"><span data-t="grooveNumerator"></span>
            <input type="number" data-role="denominator" min="1" max="${MAX_GROOVE_SIZE}" value="2"><span data-t="grooveDenominator"></span>
            <button type="button" class="dnft-button" data-role="generate" data-t="grooveGenerate"></button>
          </div>
          <div class="dnft-choices" data-role="pad-row">
            <input type="number" data-role="pad-amount" min="1" max="254" value="1">
            <button type="button" class="dnft-button" data-role="pad" data-t="groovePad"></button>
            <button type="button" class="dnft-button" data-role="copy" data-t="grooveCopy"></button>
          </div>
        </div>
      </div>`, `
      <button type="button" class="dnft-button dnft-button--primary" data-role="ok" data-t="ok"></button>
      <button type="button" class="dnft-button" data-role="apply" data-t="apply"></button>
      <button type="button" class="dnft-button" data-role="cancel" data-t="cancel"></button>`);
    const t = this.strings;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    for (const [role, hint] of [['expand', t.grooveExpandHint], ['shrink', t.grooveShrinkHint], ['generate', t.grooveGenerateHint], ['pad', t.groovePadHint], ['copy', t.grooveCopyHint]])
      $(role).title = hint;
    $('list').addEventListener('click', e => {
      const item = e.target.closest('[data-groove]');
      if (item)
        this.selectGroove(Number(item.dataset.groove));
    });
    $('entries').addEventListener('change', () => this.setGrooveText($('entries').value));
    $('entries').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.setGrooveText($('entries').value);
      }
    });
    const move = delta => {
      const i = this.grooveIndex, j = i + delta;
      if (j < 0 || j >= MAX_GROOVE)
        return;
      [this.grooves[i], this.grooves[j]] = [this.grooves[j], this.grooves[i]];
      this.selectGroove(j);
    };
    $('up').addEventListener('click', () => move(-1));
    $('down').addEventListener('click', () => move(1));
    $('clear').addEventListener('click', () => this.setGroove([]));
    $('clear-all').addEventListener('click', () => {
      this.grooves = this.grooves.map(() => []);
      this.selectGroove(this.grooveIndex);
    });
    $('expand').addEventListener('click', () => this.setGroove(this.expandGroove(this.groove)));
    $('shrink').addEventListener('click', () => this.setGroove(this.shrinkGroove(this.groove)));
    $('generate').addEventListener('click', () => this.setGroove(this.generateGroove(Number($('numerator').value), Number($('denominator').value))));
    $('pad').addEventListener('click', () => this.setGroove(this.padGroove(this.groove, Number($('pad-amount').value))));
    $('copy').addEventListener('click', () => this.copyGroove());
    $('ok').addEventListener('click', async () => {
      if (await this.applyGrooves())
        d.close();
    });
    $('apply').addEventListener('click', () => this.applyGrooves());
    $('cancel').addEventListener('click', () => d.close());
  }

  get groove() {
    return this.grooves[this.grooveIndex];
  }

  async openGrooves() {
    const d = this.grooveDialog;
    const grooves = await this.session.call('grooves');
    this.grooves = grooves.map(entries => entries ? [...entries] : []);
    d.querySelector('.dnft-dialog-title').textContent = this.strings.grooveTitle;
    // the track's groove, if it plays one
    const tr = this.editor.tr;
    this.selectGroove(tr.groove ? clamp(tr.speed, 0, MAX_GROOVE - 1) : 0);
    d.showModal();
  }

  selectGroove(index) {
    this.grooveIndex = index;
    this.showGrooves();
  }

  setGroove(entries) {
    // what a tool cannot do leaves the groove as it is (CGrooveDlg)
    if (entries)
      this.grooves[this.grooveIndex] = entries;
    this.showGrooves();
  }

  // CGrooveDlg::ParseGrooveField(): numbers 1-255, 128 at most
  setGrooveText(text) {
    const entries = text.split(/[\s,]+/).map(token => parseInt(token, 10)).filter(value => !Number.isNaN(value))
      .slice(0, MAX_GROOVE_SIZE).map(value => clamp(value, 1, 255));
    this.setGroove(entries);
  }

  // Every row in two, the odd tick to the first (CGrooveDlg::OnBnClickedButtonGrooveExpand())
  expandGroove(entries) {
    if (!entries.length || entries.length > MAX_GROOVE_SIZE / 2 || entries.some(e => e < 2))
      return null;
    return entries.flatMap(e => [Math.ceil(e / 2), Math.floor(e / 2)]);
  }

  // Every two rows in one; not past 255 ticks
  shrinkGroove(entries) {
    if (!entries.length || entries.length % 2)
      return null;
    const joined = Array.from({ length: entries.length / 2 }, (_, i) => entries[2 * i] + entries[2 * i + 1]);
    return joined.some(e => e > 255) ? null : joined;
  }

  // `rows` rows that take `ticks` ticks in all, as evenly as they can
  // (CGrooveDlg::OnBnClickedButtonGrooveGenerate())
  generateGroove(ticks, rows) {
    if (!(rows >= 1 && rows <= MAX_GROOVE_SIZE && ticks >= rows && ticks <= rows * 255))
      return null;
    const entries = new Array(rows);
    for (let i = 0; i < ticks * rows; i += ticks)
      entries[rows - i / ticks - 1] = Math.floor((i + ticks) / rows) - Math.floor(i / rows);
    return entries;
  }

  // A row of `amount` ticks after each, taken from it (CGrooveDlg::OnBnClickedButtonGroovePad())
  padGroove(entries, amount) {
    if (!entries.length || entries.length > MAX_GROOVE_SIZE / 2 || !(amount >= 1) || entries.some(e => e <= amount))
      return null;
    return entries.flatMap(e => [e - amount, amount]);
  }

  // The groove as Fxx effects in the first effect column, for the pattern's paste: one
  // where the speed changes (CGrooveDlg::OnBnClickedButtonGrooveCopyFxx())
  copyGroove() {
    const entries = this.groove;
    if (!entries.length)
      return;
    const cells = new Uint8Array(entries.length * CELL);
    entries.forEach((speed, i) => {
      const cell = cells.subarray(i * CELL, i * CELL + CELL);
      cell.set(EMPTY_CELL);
      if (!i || speed !== entries[i - 1]) {
        cell[4] = EF_SPEED;
        cell[8] = speed;
      }
    });
    // the first effect column alone (dnft-pattern-edit.mjs copyCells())
    this.editor.clipboard = { channels: 1, rows: entries.length, startField: 3, endField: 3, cells: [cells] };
    this.editor.patternMenu.refresh();
    this.editor.message(this.strings.grooveCopied);
  }

  grooveBytes() {
    return this.grooves.reduce((total, entries) => total + (entries.length ? entries.length + 2 : 0), 0);
  }

  showGrooves() {
    const t = this.strings;
    const d = this.grooveDialog;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    $('list').replaceChildren(...this.grooves.map((entries, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.role = 'option';
      item.className = 'dnft-groove-item';
      item.dataset.groove = i;
      item.textContent = `${hex2(i)}${entries.length ? ' *' : ''}`;
      item.classList.toggle('is-current', i === this.grooveIndex);
      item.setAttribute('aria-selected', String(i === this.grooveIndex));
      return item;
    }));
    const entries = this.groove;
    $('entries').value = entries.join(' ');
    const average = entries.length ? entries.reduce((a, b) => a + b, 0) / entries.length : DEFAULT_SPEED;
    const total = this.grooveBytes();
    $('info').textContent = [
      t.grooveAverage.replace('{n}', average.toFixed(3)),
      t.grooveSize.replace('{n}', entries.length ? entries.length + 2 : 0),
      t.grooveTotal.replace('{n}', total),
    ].join('  ·  ');
    $('info').classList.toggle('is-error', total > MAX_GROOVE_BYTES);
    $('ok').disabled = $('apply').disabled = total > MAX_GROOVE_BYTES;
    $('up').disabled = this.grooveIndex === 0;
    $('down').disabled = this.grooveIndex === MAX_GROOVE - 1;
    $('copy').disabled = !entries.length;
  }

  async applyGrooves() {
    const t = this.strings;
    const editor = this.editor;
    if (this.grooveBytes() > MAX_GROOVE_BYTES) {
      editor.message(t.grooveTooLarge, true);
      return false;
    }
    await this.session.call('setGrooves', this.grooves.map(entries => entries.length ? Uint8Array.from(entries) : null));
    // tracks that played a groove that went have speed 6 now
    await editor.reloadTracks();
    editor.edited();
    editor.message(t.grooveApplied);
    return true;
  }

  // ---- the device mix offsets ------------------------------------------------------------

  buildMixerDialog() {
    const d = this.mixerDialog = this.editor.files.dialog('dnft-mixer-dialog', `
      <fieldset class="dnft-fieldset">
        <legend data-t="mixerLevels"></legend>
        <div class="dnft-mixer" data-role="levels"></div>
      </fieldset>
      <label class="dnft-check"><input type="checkbox" data-role="hardware"> <span data-t="mixerHardware"></span></label>
      <p class="dnft-hint" data-t="stopsPlayback"></p>`, `
      <button type="button" class="dnft-button dnft-button--primary" data-role="ok" data-t="ok"></button>
      <button type="button" class="dnft-button" data-role="cancel" data-t="cancel"></button>`);
    const t = this.strings;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    $('levels').append(...t.mixerDevices.map((name, i) => {
      const row = document.createElement('label');
      row.className = 'dnft-mixer-row';
      row.innerHTML = `<span></span><input type="range" min="${-MAX_LEVEL}" max="${MAX_LEVEL}" step="1" data-device="${i}"><input type="number" min="${-MAX_LEVEL / 10}" max="${MAX_LEVEL / 10}" step="0.1" data-device="${i}"><span>dB</span>`;
      row.querySelector('span').textContent = name;
      row.querySelector('input[type="number"]').setAttribute('aria-label', `${name} (dB)`);
      return row;
    }));
    // the slider and the number show the same tenths of a dB
    $('levels').addEventListener('input', e => {
      const input = e.target.closest('input[data-device]');
      if (!input)
        return;
      const tenths = input.type === 'range' ? Number(input.value) : Math.round((Number(input.value) || 0) * 10);
      this.showLevel(Number(input.dataset.device), clamp(tenths, -MAX_LEVEL, MAX_LEVEL), input);
    });
    $('ok').addEventListener('click', () => this.applyMixer());
    $('cancel').addEventListener('click', () => d.close());
  }

  // except: the input being typed in, left as it is
  showLevel(device, tenths, except = null) {
    for (const input of this.mixerDialog.querySelectorAll(`input[data-device="${device}"]`))
      if (input !== except)
        input.value = input.type === 'range' ? tenths : (tenths / 10).toFixed(1);
  }

  async openMixer() {
    const d = this.mixerDialog;
    const { levels, hardwareMixing } = await this.session.call('mixing');
    const chips = this.editor.song.info.chips;
    d.querySelector('.dnft-dialog-title').textContent = this.strings.mixerTitle;
    levels.forEach((tenths, device) => {
      // the chips the module does not have are at 0, as in the module properties
      const present = !MIX_CHIPS[device] || (chips & MIX_CHIPS[device]) !== 0;
      d.querySelectorAll(`input[data-device="${device}"]`).forEach(input => { input.disabled = !present; });
      this.showLevel(device, present ? tenths : 0);
    });
    d.querySelector('[data-role="hardware"]').checked = hardwareMixing;
    d.showModal();
  }

  async applyMixer() {
    const d = this.mixerDialog;
    const editor = this.editor;
    const levels = MIX_CHIPS.map((_, device) => Number(d.querySelector(`input[type="range"][data-device="${device}"]`).value));
    editor.stopPlaying();
    await this.session.call('setMixing', levels, d.querySelector('[data-role="hardware"]').checked);
    d.close();
    editor.edited();
    editor.message(this.strings.mixerApplied);
  }

  // ---- the VRC7's patches ----------------------------------------------------------------

  buildOpllDialog() {
    const d = this.opllDialog = this.editor.files.dialog('dnft-opll-dialog', `
      <label class="dnft-check"><input type="checkbox" data-role="external"> <span data-t="opllExternal"></span></label>
      <p class="dnft-hint" data-role="note"></p>
      <div class="dnft-opll" data-role="patches"></div>
      <p class="dnft-hint" data-t="stopsPlayback"></p>`, `
      <button type="button" class="dnft-button dnft-button--primary" data-role="ok" data-t="ok"></button>
      <button type="button" class="dnft-button" data-role="cancel" data-t="cancel"></button>`);
    const t = this.strings;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    $('external').closest('label').title = t.opllExternalHint;
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    head.append(...[t.opllPatch, t.opllRegisters, t.opllName].map(text => Object.assign(document.createElement('th'), { textContent: text })));
    const body = table.createTBody();
    for (let i = 0; i < OPLL_PATCHES; ++i) {
      const row = body.insertRow();
      row.append(Object.assign(document.createElement('th'), { textContent: hex2(i) }));
      const bytes = document.createElement('input');
      bytes.type = 'text';
      bytes.spellcheck = false;
      bytes.dataset.patch = i;
      bytes.dataset.field = 'bytes';
      bytes.setAttribute('aria-label', `${t.opllPatch} ${hex2(i)} ${t.opllRegisters}`);
      const name = document.createElement('input');
      name.type = 'text';
      name.spellcheck = false;
      name.dataset.patch = i;
      name.dataset.field = 'name';
      name.setAttribute('aria-label', `${t.opllPatch} ${hex2(i)} ${t.opllName}`);
      row.insertCell().append(bytes);
      row.insertCell().append(name);
    }
    $('patches').append(table);
    // the registers typed, as the desktop reads them: the bytes given, the rest as they were
    $('patches').addEventListener('change', e => {
      const input = e.target.closest('input[data-field="bytes"]');
      if (!input)
        return;
      const patch = Number(input.dataset.patch);
      input.value.trim().split(/\s+/).filter(Boolean).slice(0, 8).forEach((token, i) => {
        const value = parseByte(token);
        if (value !== null)
          this.opll.patches[patch * 8 + i] = value;
      });
      this.showOpllPatch(patch);
    });
    $('patches').addEventListener('input', e => {
      const input = e.target.closest('input[data-field="name"]');
      if (input)
        this.opll.names[Number(input.dataset.patch)] = input.value;
    });
    $('external').addEventListener('change', () => this.showOpll());
    $('ok').addEventListener('click', () => this.applyOpll());
    $('cancel').addEventListener('click', () => d.close());
  }

  async openOpll() {
    const d = this.opllDialog;
    const opll = await this.session.call('opll');
    this.opll = { patches: Uint8Array.from(opll.patches), names: [...opll.names] };
    d.querySelector('.dnft-dialog-title').textContent = this.strings.opllTitle;
    d.querySelector('[data-role="external"]').checked = opll.external;
    for (let i = 0; i < OPLL_PATCHES; ++i)
      this.showOpllPatch(i);
    this.showOpll();
    d.showModal();
  }

  showOpllPatch(patch) {
    const d = this.opllDialog;
    d.querySelector(`input[data-patch="${patch}"][data-field="bytes"]`).value =
      [...this.opll.patches.subarray(patch * 8, patch * 8 + 8)].map(b => `$${hex2(b)}`).join(' ');
    d.querySelector(`input[data-patch="${patch}"][data-field="name"]`).value = this.opll.names[patch];
  }

  // Patches 1-18 can be changed when the module has the VRC7 and its own patches; patch 0
  // is each instrument's own
  showOpll() {
    const d = this.opllDialog;
    const vrc7 = (this.editor.song.info.chips & CHIP.VRC7) !== 0;
    const external = d.querySelector('[data-role="external"]');
    external.disabled = !vrc7;
    const editable = vrc7 && external.checked;
    for (const input of d.querySelectorAll('input[data-patch]'))
      input.disabled = !editable || input.dataset.patch === '0';
    const note = d.querySelector('[data-role="note"]');
    note.textContent = this.strings.opllNeedsVrc7;
    note.hidden = vrc7;
  }

  async applyOpll() {
    const d = this.opllDialog;
    const editor = this.editor;
    // without the VRC7 the box cannot be changed, and keeps what the module had
    const external = d.querySelector('[data-role="external"]').checked;
    editor.stopPlaying();
    await this.session.call('setOpll', external, this.opll.patches, this.opll.names);
    d.close();
    editor.edited();
    editor.message(this.strings.opllApplied);
  }
}

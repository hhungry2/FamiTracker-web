// Dn-FamiTracker web port - the editor's Tracker, View and Help menus: what the desktop
// tracker's have besides the file, edit and song commands. Tracker: the ways to play (from
// the row marker, one row), the marker, muting and soloing chips, Switch To Track
// Instrument, Record To Instrument with its settings, Kill Sound. View: follow mode, compact
// view, the meters' decay rate, the average BPM, the register state, the oscilloscope and
// the spectrum, where the frame list is and whether the side panels show. Help: the keys, the
// effect table and what the editor is (dnft-help.mjs). The choices of the View menu are kept
// in the browser.
//
//   const menus = new TrackerMenu(editor);   // adds its menus after the Module menu

import { PLAY } from './dnft-session.mjs';
import { NOTE, MAX_INSTRUMENTS } from './dnft-song.mjs';
import { Help } from './dnft-help.mjs';

const VIEW_KEY = 'dnft-editor.view';
const DEFAULT_VIEW = {
  compact: false,           // only the notes, in narrow channels
  averageBpm: false,        // the BPM shown while playing is the average of the song so far
  registers: false,         // the register state beside the pattern
  visualizer: 'scope',      // 'off', 'scope' or 'spectrum'
  decay: 0,                 // the meters' decay: 0 slow, 1 fast
  framesTop: false,         // the frame list above the pattern, not in the side panel
  side: true,               // the side panels
};
// How often the recorder is asked what it made, and the BPM
const POLL_MS = 300;
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 252;

export class TrackerMenu {
  constructor(editor) {
    this.editor = editor;
    this.help = new Help(editor);
    // on a phone the side panels start closed: the pattern needs the room
    const stored = this.readOptions();
    const phone = matchMedia('(max-width: 640px)').matches;
    this.options = { ...DEFAULT_VIEW, ...(phone && !('side' in stored) ? { side: false } : {}), ...stored };
    this.switchToInstrument = false;   // Tracker > Switch To Track Instrument
    this.recording = null;             // the channel being recorded (Record To Instrument), or null
    this.bpm = 0;
    this.timer = null;
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
    const editor = this.editor;
    const files = editor.files;
    const view = (option, label, hint, shortcut) => ({
      label, hint, shortcut, checked: () => this.options[option], run: () => this.setOption(option, !this.options[option]),
    });
    const radio = (option, value, label, hint) => ({
      label, hint, radio: true, checked: () => this.options[option] === value, run: () => this.setOption(option, value),
    });
    const channelMuted = () => !editor.song;
    const trackerMenu = files.menu(t.trackerMenu, t.trackerMenuHint, [
      { label: t.play, hint: t.playHint, shortcut: 'Enter', run: () => editor.togglePlay() },
      { label: t.playPattern, hint: t.playPatternHint, shortcut: 'F6', run: () => editor.startPlaying(PLAY.PATTERN) },
      { label: t.playSong, hint: t.playSongHint, shortcut: 'F5', run: () => editor.startPlaying(PLAY.SONG) },
      { label: t.playCursor, hint: t.playCursorHint, shortcut: 'F7', run: () => editor.startPlaying(PLAY.CURSOR) },
      { label: t.playMarker, hint: t.playMarkerHint, shortcut: 'Ctrl+F7', run: () => this.playMarker(), disabled: () => !this.markerValid() },
      { label: t.stop, hint: t.stopHint, shortcut: 'F8', run: () => editor.stopPlaying() },
      null,
      { label: t.edit, hint: t.editHint, shortcut: 'Space', checked: () => editor.editMode, run: () => editor.setEditMode(!editor.editMode) },
      { label: t.setMarker, hint: t.setMarkerHint, shortcut: 'Ctrl+B', run: () => this.setMarker() },
      { label: t.playRow, hint: t.playRowHint, shortcut: 'Ctrl+Enter', run: () => this.playRow() },
      null,
      { label: t.toggleChannel, shortcut: 'Alt+F9', run: () => editor.toggleMute(editor.cursor.channel, false), disabled: channelMuted },
      { label: t.soloChannel, shortcut: 'Alt+F10', run: () => editor.toggleMute(editor.cursor.channel, true), disabled: channelMuted },
      { label: t.toggleChip, hint: t.toggleChipHint, shortcut: 'Ctrl+Alt+F9', run: () => this.toggleChip(editor.cursor.channel, false), disabled: channelMuted },
      { label: t.soloChip, hint: t.soloChipHint, shortcut: 'Ctrl+Alt+F10', run: () => this.toggleChip(editor.cursor.channel, true), disabled: channelMuted },
      null,
      { label: t.switchToTrackInstrument, hint: t.switchToTrackInstrumentHint, checked: () => this.switchToInstrument, run: () => this.toggleSwitchToInstrument() },
      { label: t.recordToInstrument, hint: t.recordToInstrumentHint, checked: () => this.recording !== null, run: () => this.recordToInstrument(), disabled: () => editor.playing },
      { label: t.recorderSettings, hint: t.recorderSettingsHint, run: () => this.openRecorderSettings(), disabled: () => editor.playing },
      null,
      { label: t.killSound, hint: t.killSoundHint, shortcut: 'F12', run: () => this.killSound() },
    ]);
    const viewMenu = files.menu(t.viewMenu, t.viewMenuHint, [
      { label: t.follow, hint: t.followHint, checked: () => editor.follow, run: () => editor.action('follow') },
      view('compact', t.compactView, t.compactViewHint),
      {
        label: t.meterDecay, hint: t.meterDecayHint, items: [
          radio('decay', 0, t.decaySlow),
          radio('decay', 1, t.decayFast),
        ],
      },
      null,
      view('averageBpm', t.averageBpm, t.averageBpmHint),
      view('registers', t.registerState, t.registerStateHint),
      {
        label: t.visualizer, hint: t.visualizerHint, items: [
          radio('visualizer', 'off', t.visualizerOff),
          radio('visualizer', 'scope', t.visualizerScope),
          radio('visualizer', 'spectrum', t.visualizerSpectrum),
        ],
      },
      null,
      {
        label: t.framePosition, hint: t.framePositionHint, items: [
          { label: t.framePositionSide, radio: true, checked: () => !this.options.framesTop, run: () => this.setOption('framesTop', false) },
          { label: t.framePositionTop, radio: true, checked: () => this.options.framesTop, run: () => this.setOption('framesTop', true) },
        ],
      },
      view('side', t.sidePanels, t.sidePanelsHint),
    ]);
    const helpMenu = files.menu(t.helpMenu, t.helpMenuHint, [
      { label: t.helpTopics, hint: t.helpTopicsHint, shortcut: 'F1', run: () => this.help.openTopics() },
      { label: t.effectTable, hint: t.effectTableHint, run: () => this.help.openEffects() },
      null,
      { label: t.aboutItem, hint: t.aboutItemHint, run: () => this.help.openAbout() },
    ]);
    const menus = editor.root.querySelectorAll('.dnft-toolbar .dnft-menu-wrap');
    menus[menus.length - 1].after(trackerMenu, viewMenu, helpMenu);
    this.buildRecorderDialog();
    editor.els.visualizer.addEventListener('click', () => this.setOption('visualizer', this.options.visualizer === 'scope' ? 'spectrum' : 'scope'));
    editor.els.registers.querySelector('[data-role="close-registers"]').addEventListener('click', () => this.setOption('registers', false));
  }

  // ---- the choices of the View menu -----------------------------------------------------------

  readOptions() {
    try {
      return JSON.parse(localStorage.getItem(VIEW_KEY)) ?? {};
    } catch {
      return {};
    }
  }

  writeOptions() {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(this.options));
    } catch {
      // blocked: they last as long as the page
    }
  }

  setOption(name, value) {
    this.options[name] = value;
    this.writeOptions();
    this.applyOption(name);
    this.editor.files.closeMenus();
  }

  // Puts all of them in force (as the page starts)
  applyOptions() {
    for (const name of Object.keys(DEFAULT_VIEW))
      this.applyOption(name);
  }

  applyOption(name) {
    const editor = this.editor;
    const value = this.options[name];
    switch (name) {
      case 'compact':
        editor.compact = value;
        editor.root.classList.toggle('is-compact', value);
        if (editor.song) {
          // only the notes have the cursor now (or all the columns again)
          editor.deselect();
          editor.setCursor(editor.cursor, { keep: true });
          editor.view.layout();
        }
        break;
      case 'averageBpm':
        this.session?.send('setAverageBpm', value);
        editor.updateStatus();
        break;
      case 'registers':
        editor.displays.registers.setVisible(value);
        break;
      case 'visualizer':
        editor.displays.visualizer.setMode(value);
        break;
      case 'decay':
        this.session?.send('setMeterDecayRate', value);
        break;
      case 'framesTop':
        this.placeFrames(value);
        break;
      case 'side':
        editor.root.classList.toggle('is-side-hidden', !value);
        editor.view.invalidate();
        editor.renderToolbar?.();
        break;
    }
  }

  // The frame list in the side panel, or above the pattern
  placeFrames(top) {
    const root = this.editor.root;
    const panel = root.querySelector('.dnft-frames-panel');
    const slot = root.querySelector('.dnft-frames-slot');
    const side = root.querySelector('.dnft-side');
    if (top) {
      slot.append(panel);
    } else {
      side.insertBefore(panel, root.querySelector('.dnft-instruments-panel'));
    }
    slot.hidden = !top;
    root.classList.toggle('is-frames-top', top);
    this.editor.view.invalidate();
  }

  // After a module opens (a new session object has the engine's defaults)
  onSong() {
    // the engine keeps the sound settings from here on
    if (!this.soundApplied) {
      this.soundApplied = true;
      this.editor.config.applySound();
    }
    this.switchToInstrument = false;
    this.recording = null;
    this.editor.view.recording = null;
    this.marker = null;
    this.session.send('setAverageBpm', this.options.averageBpm);
    this.session.send('setMeterDecayRate', this.options.decay);
    this.session.clearLevels();
    this.editor.displays.meters.shown = [];
  }

  // ---- the row marker -------------------------------------------------------------------------

  get marker() {
    return this.editor.marker;
  }

  set marker(value) {
    this.editor.marker = value;
  }

  // Whether the marker is a row of the track shown (CFamiTrackerView::IsMarkerValid())
  markerValid() {
    const marker = this.marker;
    const tr = this.editor.song && this.editor.tr;
    return !!marker && !!tr && marker.frame < tr.frames && marker.row < tr.rows;
  }

  // Tracker > Set Row Marker: the row at the cursor, or none when it already is the marker
  setMarker() {
    const { frame, row } = this.editor.cursor;
    const marker = this.marker;
    if (marker && marker.frame === frame && marker.row === row) {
      this.marker = null;
      this.editor.message(this.strings.markerCleared);
    } else {
      this.marker = { frame, row };
      this.editor.message(this.strings.markerSet);
    }
    this.editor.renderFrames();
    this.editor.view.invalidate();
  }

  playMarker() {
    if (!this.markerValid()) {
      this.editor.message(this.strings.noMarker, true);
      return;
    }
    this.editor.startPlaying(PLAY.CURSOR, this.marker);
  }

  // ---- playing and silencing ------------------------------------------------------------------------

  // Tracker > Play Row: the notes of the row at the cursor, with their effects, and the
  // cursor goes down a row (CFamiTrackerView::OnTrackerPlayrow())
  playRow() {
    const editor = this.editor;
    editor.session.resume();
    editor.session.send('playRow', editor.track, editor.cursor.frame, editor.cursor.row);
    editor.moveRows(1);
  }

  // Tracker > Kill Sound: stops the player and everything that sounds (F12)
  killSound() {
    const editor = this.editor;
    editor.stopPlaying();
    editor.releaseHeldNotes();
    editor.session.send('stopPreview');
    editor.session.send('killSound');
    editor.session.clearLevels();
    editor.message(this.strings.soundKilled);
  }

  // Tracker > Toggle Chip and Solo Chip (CFamiTrackerView::ToggleChip(), SoloChip()): every
  // channel of the chip of the cursor's channel
  toggleChip(channel, solo) {
    const editor = this.editor;
    const channels = editor.song.channels;
    const chip = channels[channel].chip;
    const same = i => channels[i].chip === chip;
    let muted = editor.muted.slice();
    if (solo) {
      const alone = muted.every((m, i) => m === !same(i));
      muted = muted.map((_, i) => alone ? false : !same(i));
    } else if (muted.some((m, i) => same(i) && !m)) {
      muted = muted.map((m, i) => same(i) ? true : m);
    } else {
      muted = muted.map((m, i) => same(i) ? false : m);
    }
    editor.setMuted(muted);
  }

  // Tracker > Switch To Track Instrument: while the song plays, the instrument the cursor's
  // channel plays is the one selected (CFamiTrackerView::PlayerPlayNote())
  toggleSwitchToInstrument() {
    this.switchToInstrument = !this.switchToInstrument;
  }

  // The right button on a channel's name (IDR_PATTERN_HEADER_POPUP)
  openHeaderMenu(channel, x, y) {
    const editor = this.editor;
    const t = editor.strings;
    const files = editor.files;
    files.contextMenu([
      { label: t.toggleChannel, run: () => editor.toggleMute(channel, false) },
      { label: t.soloChannel, run: () => editor.toggleMute(channel, true) },
      { label: t.toggleChip, hint: t.toggleChipHint, run: () => this.toggleChip(channel, false) },
      { label: t.soloChip, hint: t.soloChipHint, run: () => this.toggleChip(channel, true) },
      { label: t.unmuteAll, run: () => editor.setMuted(editor.muted.map(() => false)), disabled: () => !editor.muted.some(Boolean) },
      null,
      {
        label: t.meterDecay, hint: t.meterDecayHint, items: [
          { label: t.decaySlow, radio: true, checked: () => this.options.decay === 0, run: () => this.setOption('decay', 0) },
          { label: t.decayFast, radio: true, checked: () => this.options.decay === 1, run: () => this.setOption('decay', 1) },
        ],
      },
      null,
      {
        label: t.recordToInstrument, hint: t.recordToInstrumentHint, checked: () => this.recording === channel,
        run: () => { editor.setCursor({ ...editor.cursor, channel }); this.recordToInstrument(); }, disabled: () => editor.playing,
      },
      { label: t.recorderSettings, hint: t.recorderSettingsHint, run: () => this.openRecorderSettings(), disabled: () => editor.playing },
    ], x, y);
  }

  // The row playing now, to the editor's tick
  onPlayRow(play) {
    if (!this.switchToInstrument || !play || !this.editor.playing)
      return;
    const editor = this.editor;
    const cell = editor.song.cell(editor.track, play.frame, editor.cursor.channel, play.row);
    if (cell[0] >= NOTE.C && cell[0] <= NOTE.B && cell[3] < MAX_INSTRUMENTS && editor.song.instrument(cell[3]) && cell[3] !== editor.instrument)
      editor.selectInstrument(cell[3], { quiet: true });
  }

  // ---- BPM -----------------------------------------------------------------------------------------

  // While the song plays: the engine's BPM (CSoundGen::GetCurrentBPM()), a few times a second
  startPolling() {
    if (this.timer)
      return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stopPolling() {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.recording)
      this.bpm = 0;
  }

  async poll() {
    const editor = this.editor;
    if (!editor.session)
      return;
    if (editor.playing) {
      const state = await editor.session.call('state');
      this.bpm = state.bpm;
      editor.updateStatus();
    }
    if (this.recording !== null)
      await this.pollRecorder();
    if (!editor.playing && this.recording === null)
      this.stopPolling();
  }

  // ---- Record To Instrument --------------------------------------------------------------------------

  // Tracker > Record To Instrument: the cursor's channel is the one the next playback
  // records, as instruments, until it stops; again to take it back
  async recordToInstrument() {
    const editor = this.editor;
    const t = this.strings;
    const channel = editor.cursor.channel;
    const error = await editor.session.call('setRecordChannel', channel);
    if (error) {
      editor.message(t[`record${error[0].toUpperCase()}${error.slice(1)}`], true);
      return;
    }
    const state = await editor.session.call('recorder');
    this.recording = state.channel === -1 ? null : state.channel;
    if (this.recording !== null) {
      // it has to be heard to be recorded
      if (editor.muted[channel])
        editor.toggleMute(channel, false);
      editor.message(t.recordOn.replace('{channel}', editor.song.channels[channel].name).replace('{n}', state.count));
      this.startPolling();
    } else {
      editor.message(t.recordOff);
    }
    editor.view.markRecording(this.recording);
  }

  // The instruments the recorder made since last asked, and whether it is done
  async pollRecorder() {
    const editor = this.editor;
    const slots = await editor.session.call('takeRecordedInstruments');
    if (slots.length) {
      await editor.refreshInstruments();
      editor.selectInstrument(slots[slots.length - 1], { quiet: true });
      editor.changedInstruments();
      editor.message(this.strings.recorded.replace('{n}', slots.length));
    }
    const state = await editor.session.call('recorder');
    if (state.channel === -1) {
      this.recording = null;
      editor.view.markRecording(null);
    }
  }

  buildRecorderDialog() {
    const d = this.recorderDialog = this.editor.files.dialog('dnft-recorder-dialog', `
      <label class="dnft-field"><span data-t="recorderInterval"></span><input type="number" data-role="interval" min="${MIN_INTERVAL}" max="${MAX_INTERVAL}" step="1"></label>
      <label class="dnft-field"><span data-t="recorderCount"></span><input type="number" data-role="count" min="1" max="${MAX_INSTRUMENTS}" step="1"></label>
      <label class="dnft-check"><input type="checkbox" data-role="reset"> <span data-t="recorderReset"></span></label>
      <p class="dnft-hint" data-t="recorderNote"></p>`, `
      <button type="button" class="dnft-button dnft-button--primary" data-role="ok" data-t="ok"></button>
      <button type="button" class="dnft-button" data-role="cancel" data-t="cancel"></button>`);
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    $('ok').addEventListener('click', async () => {
      const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.round(Number(value) || min)));
      await this.editor.session.call('setRecorderSettings', clamp($('interval').value, MIN_INTERVAL, MAX_INTERVAL),
        clamp($('count').value, 1, MAX_INSTRUMENTS), $('reset').checked);
      d.close();
    });
    $('cancel').addEventListener('click', () => d.close());
  }

  // Tracker > Recorder Settings: how many ticks of the channel each instrument takes, how
  // many instruments, and whether those go back to their defaults afterwards
  async openRecorderSettings() {
    const d = this.recorderDialog;
    const state = await this.editor.session.call('recorder');
    d.querySelector('.dnft-dialog-title').textContent = this.strings.recorderTitle;
    d.querySelector('[data-role="interval"]').value = state.interval;
    d.querySelector('[data-role="count"]').value = state.count;
    d.querySelector('[data-role="reset"]').checked = state.reset;
    d.showModal();
    d.querySelector('[data-role="interval"]').select();
  }
}

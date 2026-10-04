// Dn-FamiTracker web port - the editor's files besides the module: what the desktop
// tracker's File menu exports (Create WAV, the NSF export dialog's NSF, NSFe, NSF2, NES,
// BIN, PRG and ASM, Export Text, Export JSON, Export Rows) and imports (Import Text, and
// the tracks and instruments of another module, from the module properties). The engine
// does the work (src/export.h, src/session.h); this is the menus, the dialogs and the
// downloads. Exports that write several files download them as one zip file.
//
//   const files = new FileMenu(editor);   // adds its menus to the editor's toolbar

import { zip } from './dnft-zip.mjs';

// the desktop's sound settings offer these; 44100 is its default
const WAVE_RATES = [11025, 22050, 44100, 48000, 96000];
const DEFAULT_WAVE_RATE = 44100;
const MAX_PASSES = 99;
const MAX_SECONDS = 99 * 60;
// CExportDialog's kinds, in its order, and the extensions of their files
const NSF_TYPES = ['nsf', 'nsfe', 'nsf2', 'nes', 'bin', 'prg', 'asm'];
const EXTENSIONS = { nsf: 'nsf', nsfe: 'nsfe', nsf2: 'nsf', nes: 'nes', bin: 'bin', prg: 'prg', asm: 'asm' };
const CHIP_NAMES = [['VRC6', 1], ['VRC7', 2], ['FDS', 4], ['MMC5', 8], ['N163', 16], ['5B', 32]];
const N163 = 16;

const pad2 = n => String(n).padStart(2, '0');
// what a file name may hold
const safeName = name => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();

// "mm:ss" (or seconds) as the desktop's dialog reads it, within its limits
function parseTime(text) {
  const match = /^\s*(\d+)\s*(?::\s*(\d+))?\s*$/.exec(text);
  if (!match)
    return null;
  const seconds = match[2] === undefined ? Number(match[1]) : Number(match[1]) * 60 + Number(match[2]) % 60;
  return Math.max(1, Math.min(MAX_SECONDS, seconds));
}

const formatTime = seconds => `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;

let dialogs = 0;   // for names that must be unique in the page

export class FileMenu {
  constructor(editor) {
    this.editor = editor;
    this.nsfType = NSF_TYPES[0];   // the desktop dialog keeps the last kind
    this.waveTask = null;          // the wave export running
    this.importName = null;        // the file of the module import
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
    const save = editor.root.querySelector('[data-action="save"]');

    this.textInput = this.fileInput('.txt', file => this.importText(file));
    this.moduleInput = this.fileInput('.dnm,.0cc,.ftm', file => this.importModule(file));
    const importMenu = this.menu(t.importMenu, t.importMenuHint, [
      { label: t.importText, hint: t.importTextHint, run: () => this.textInput.click() },
      { label: t.importModule, hint: t.importModuleHint, run: () => this.moduleInput.click() },
    ]);
    const exportMenu = this.menu(t.exportMenu, t.exportMenuHint, [
      { label: t.exportWave, hint: t.exportWaveHint, run: () => this.openWave() },
      { label: t.exportNsf, hint: t.exportNsfHint, run: () => this.openNsf() },
      null,
      { label: t.exportText, hint: t.exportTextHint, run: () => this.exportFile('exportText', 'txt', 'text/plain') },
      { label: t.exportJson, hint: t.exportJsonHint, run: () => this.exportFile('exportJSON', 'json', 'application/json') },
      { label: t.exportRows, hint: t.exportRowsHint, run: () => this.exportFile('exportRows', 'csv', 'text/csv') },
    ]);
    save.after(importMenu, exportMenu, this.textInput, this.moduleInput);

    // menus close on a click elsewhere
    document.addEventListener('pointerdown', e => {
      if (!e.target.closest?.('.dnft-menu-wrap, .dnft-context-menu'))
        this.closeMenus();
    }, true);
    // and Escape closes them, wherever the keyboard is
    document.addEventListener('keydown', e => {
      const open = this.context || editor.root.querySelector('.dnft-menu-wrap > .dnft-menu:not([hidden])');
      if (e.key === 'Escape' && open && !e.target.closest?.('.dnft-menu')) {
        e.preventDefault();
        e.stopPropagation();
        this.closeMenus();
      }
    }, true);

    this.buildWaveDialog();
    this.buildNsfDialog();
    this.buildImportDialog();
  }

  fileInput(accept, open) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;
    input.addEventListener('change', () => {
      const file = input.files[0];
      input.value = '';
      if (file)
        open(file);
    });
    return input;
  }

  // A button with a list of commands under it. Items: {label, hint, shortcut, run,
  // checked() (a check mark, or with `radio` a dot), disabled(), items (a submenu, which
  // opens under its entry)}; null items are separators. `items` may be a function that gives
  // them, which is called each time the menu opens.
  menu(label, hint, items) {
    const wrap = document.createElement('div');
    wrap.className = 'dnft-menu-wrap';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dnft-button';
    button.textContent = `${label} ▾`;
    button.title = hint;
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const entries = () => typeof items === 'function' ? items() : items;
    let list = this.menuList(entries(), () => button.focus());
    list.hidden = true;
    button.addEventListener('click', () => {
      const open = list.hidden;
      this.closeMenus();
      if (!open)
        return;
      if (typeof items === 'function') {
        const fresh = this.menuList(entries(), () => button.focus());
        fresh.hidden = true;
        list.replaceWith(fresh);
        list = fresh;
      }
      this.refreshMenu(list);
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      // opened from the keyboard: the keyboard goes into the list
      if (document.activeElement === button)
        list.querySelector('.dnft-menu-item:not(:disabled)')?.focus();
    });
    wrap.append(button, list);
    return wrap;
  }

  // The list of a menu's entries (see menu()); `escape`: what Escape does after closing it
  menuList(items, escape) {
    const list = document.createElement('div');
    list.className = 'dnft-menu';
    list.role = 'menu';
    const fill = (parent, entries) => {
      for (const item of entries) {
        if (!item) {
          parent.append(Object.assign(document.createElement('div'), { className: 'dnft-menu-separator', role: 'separator' }));
          continue;
        }
        const entry = document.createElement('button');
        entry.type = 'button';
        entry.className = 'dnft-menu-item';
        entry.role = item.checked ? (item.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem';
        entry.title = item.hint ?? '';
        entry.menuItem = item;
        const text = document.createElement('span');
        text.className = 'dnft-menu-label';
        text.textContent = item.label;
        entry.append(text);
        if (item.shortcut)
          entry.append(Object.assign(document.createElement('span'), { className: 'dnft-menu-shortcut', textContent: item.shortcut }));
        parent.append(entry);
        if (item.items) {
          const sub = document.createElement('div');
          sub.className = 'dnft-submenu';
          sub.role = 'menu';
          sub.hidden = true;
          entry.classList.add('has-submenu');
          entry.setAttribute('aria-haspopup', 'menu');
          entry.setAttribute('aria-expanded', 'false');
          entry.addEventListener('click', () => this.toggleSubmenu(entry, sub.hidden));
          fill(sub, item.items);
          parent.append(sub);
        } else {
          entry.addEventListener('click', () => {
            this.closeMenus();
            item.run();
            this.editor.focusEditor();
          });
        }
      }
    };
    fill(list, items);
    list.addEventListener('keydown', e => {
      const entries = [...list.querySelectorAll('.dnft-menu-item')].filter(entry => !entry.closest('[hidden]') && !entry.disabled);
      const at = entries.indexOf(document.activeElement);
      const entry = document.activeElement;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        entries[(at + (e.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length]?.focus();
      } else if (e.key === 'ArrowRight' && entry?.classList.contains('has-submenu')) {
        this.toggleSubmenu(entry, true);
        entry.nextElementSibling.querySelector('.dnft-menu-item:not(:disabled)')?.focus();
      } else if (e.key === 'ArrowLeft' && entry?.closest('.dnft-submenu')) {
        const trigger = entry.closest('.dnft-submenu').previousElementSibling;
        this.toggleSubmenu(trigger, false);
        trigger.focus();
      } else if (e.key === 'Escape') {
        this.closeMenus();
        escape?.();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    });
    return list;
  }

  toggleSubmenu(entry, open) {
    entry.nextElementSibling.hidden = !open;
    entry.setAttribute('aria-expanded', String(open));
  }

  // The marks and the commands that can run, as they are now
  refreshMenu(list) {
    for (const entry of list.querySelectorAll('.dnft-menu-item')) {
      const item = entry.menuItem;
      if (item?.checked) {
        const on = !!item.checked();
        entry.setAttribute('aria-checked', String(on));
        entry.classList.toggle('is-checked', on);
      }
      if (item?.disabled)
        entry.disabled = !!item.disabled();
    }
    for (const sub of list.querySelectorAll('.dnft-submenu'))
      this.toggleSubmenu(sub.previousElementSibling, false);
  }

  // A menu of `items` (as menu() has them) at a point of the window, as the right button
  // opens one; `escape`: where the keyboard goes when Escape closes it
  contextMenu(items, x, y, escape = () => this.editor.view.scroller.focus()) {
    this.closeMenus();
    const list = this.menuList(items, escape);
    list.classList.add('dnft-context-menu');
    this.refreshMenu(list);
    this.editor.root.append(list);
    const place = () => {
      const { width, height } = list.getBoundingClientRect();
      list.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width - 4))}px`;
      list.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height - 4))}px`;
    };
    place();
    // a submenu opening makes it longer
    new ResizeObserver(place).observe(list);
    list.querySelector('.dnft-menu-item:not(:disabled)')?.focus({ preventScroll: true });
    this.context = list;
  }

  closeMenus() {
    for (const wrap of this.editor.root.querySelectorAll('.dnft-menu-wrap')) {
      wrap.querySelector('.dnft-menu').hidden = true;
      wrap.querySelector('button').setAttribute('aria-expanded', 'false');
    }
    this.context?.remove();
    this.context = null;
  }

  // A dialog of the editor's look: title, body, buttons
  dialog(className, body, buttons) {
    const dialog = document.createElement('dialog');
    dialog.className = `dnft-dialog dnft-dialog--narrow ${className}`;
    dialog.innerHTML = `
      <div class="dnft-dialog-head"><strong class="dnft-dialog-title"></strong></div>
      <div class="dnft-dialog-body">${body}</div>
      <div class="dnft-dialog-foot">${buttons}</div>`;
    const t = this.strings;
    dialog.querySelectorAll('[data-t]').forEach(el => { el.textContent = t[el.dataset.t]; });
    // keys typed here are not notes, and do not play
    dialog.addEventListener('keydown', e => e.stopPropagation());
    this.editor.root.append(dialog);
    return dialog;
  }

  // ---- downloads -----------------------------------------------------------------------

  download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // One file as it is, several in a zip file named after the first
  downloadFiles(files, single, archive) {
    if (files.length === 1)
      this.download(single, new Blob([files[0].data], { type: 'application/octet-stream' }));
    else
      this.download(archive, zip(files));
  }

  // ---- text, JSON, rows ----------------------------------------------------------------

  async exportFile(method, extension, type) {
    const t = this.strings;
    // the exports read a copy of the module, which resets the sound as it loads
    this.editor.stopPlaying();
    try {
      const bytes = await this.session.call(method);
      const name = `${this.editor.fileBase()}.${extension}`;
      this.download(name, new Blob([bytes], { type }));
      this.editor.message(t.exported + name);
    } catch (e) {
      this.editor.message(t.exportFailed + e.message, true);
    }
  }

  // File > Import Text: the module in the file takes the place of the one open
  async importText(file) {
    const t = this.strings;
    const editor = this.editor;
    if (editor.dirty && !confirm(t.confirmOpen))
      return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let snapshot;
    try {
      snapshot = await this.session.call('importText', bytes, this.session.sampleRate);
    } catch (e) {
      editor.message(t.textImportFailed + e.message, true);
      return;
    }
    editor.setSong(snapshot);
    editor.fileName = file.name.replace(/\.txt$/i, '');
    // not saved as a module yet
    editor.dirty = true;
    editor.renderToolbar();
    editor.message(t.textImported + file.name + (snapshot.warning ? ` — ${snapshot.warning}` : ''), !!snapshot.warning);
    editor.saveToBrowser();
  }

  // ---- wave ------------------------------------------------------------------------------

  buildWaveDialog() {
    const t = this.strings;
    const group = `dnft-wave-length-${++dialogs}`;
    const d = this.waveDialog = this.dialog('dnft-wave-dialog', `
      <label class="dnft-field"><span data-t="waveTrack"></span><select data-role="track"></select></label>
      <fieldset class="dnft-fieldset">
        <legend data-t="waveLength"></legend>
        <label class="dnft-check"><input type="radio" name="${group}" value="passes" checked>
          <span data-t="wavePassesBefore"></span><input type="number" data-role="passes" min="1" max="${MAX_PASSES}" value="1"><span data-t="wavePassesAfter"></span></label>
        <label class="dnft-check"><input type="radio" name="${group}" value="time">
          <span data-t="waveTimeBefore"></span><input type="text" data-role="time" value="01:00" inputmode="numeric" spellcheck="false"><span data-t="waveTimeAfter"></span></label>
      </fieldset>
      <fieldset class="dnft-fieldset">
        <legend data-t="waveChannels"></legend>
        <div class="dnft-channel-list" data-role="channels"></div>
        <label class="dnft-check"><input type="checkbox" data-role="separate"> <span data-t="waveSeparate"></span></label>
      </fieldset>
      <label class="dnft-field dnft-field--inline"><span data-t="waveRate"></span><select data-role="rate"></select></label>
      <div class="dnft-progress" data-role="progress" hidden><progress max="1" value="0"></progress><span></span></div>`, `
      <button type="button" class="dnft-button dnft-button--primary" data-role="start" data-t="waveStart"></button>
      <button type="button" class="dnft-button" data-role="close"></button>`);
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    $('rate').append(...WAVE_RATES.map(rate => new Option(`${rate} Hz`, rate)));
    $('rate').value = DEFAULT_WAVE_RATE;
    $('separate').closest('label').title = t.waveSeparateHint;
    // typing a length picks its way of counting, as in the desktop's dialog
    const choose = value => { d.querySelector(`input[value="${value}"]`).checked = true; };
    $('passes').addEventListener('input', () => choose('passes'));
    $('time').addEventListener('input', () => choose('time'));
    $('time').addEventListener('change', () => {
      const seconds = parseTime($('time').value);
      $('time').value = formatTime(seconds ?? 60);
    });
    $('start').addEventListener('click', () => this.exportWave());
    $('close').addEventListener('click', () => {
      if (this.waveTask)
        this.waveTask.cancel();
      else
        d.close();
    });
    d.addEventListener('cancel', e => {
      // Escape calls a running export off rather than hiding it
      if (this.waveTask) {
        e.preventDefault();
        this.waveTask.cancel();
      }
    });
  }

  openWave() {
    const d = this.waveDialog;
    const t = this.strings;
    const editor = this.editor;
    const info = editor.song.info;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    d.querySelector('.dnft-dialog-title').textContent = t.waveTitle;
    $('track').replaceChildren(...info.tracks.map((title, i) => new Option(`#${pad2(i + 1)} ${title}`, i)));
    $('track').value = editor.track;
    // every channel ticked, as in the desktop's dialog
    $('channels').replaceChildren(...info.channels.map((channel, i) => {
      const label = document.createElement('label');
      label.className = 'dnft-check';
      label.innerHTML = `<input type="checkbox" value="${i}" checked> <span></span>`;
      label.querySelector('span').textContent = channel.name;
      return label;
    }));
    this.showWaveProgress(null);
    $('close').textContent = t.close;
    d.showModal();
  }

  showWaveProgress(value, label = '') {
    const d = this.waveDialog;
    const box = d.querySelector('[data-role="progress"]');
    box.hidden = value === null;
    box.querySelector('progress').value = value ?? 0;
    box.querySelector('span').textContent = label;
    const running = value !== null;
    d.querySelectorAll('.dnft-dialog-body input, .dnft-dialog-body select').forEach(el => { el.disabled = running; });
    d.querySelector('[data-role="start"]').disabled = running;
    d.querySelector('[data-role="close"]').textContent = running ? this.strings.cancel : this.strings.close;
  }

  async exportWave() {
    const d = this.waveDialog;
    const t = this.strings;
    const editor = this.editor;
    const info = editor.song.info;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    const track = Number($('track').value);
    const byTime = d.querySelector('input[value="time"]').checked;
    const passes = byTime ? 0 : Math.max(1, Math.min(MAX_PASSES, Math.round(Number($('passes').value) || 1)));
    const seconds = byTime ? parseTime($('time').value) ?? 60 : 0;
    const rate = Number($('rate').value);
    const ticked = [...$('channels').querySelectorAll('input')].filter(box => box.checked).map(box => Number(box.value));
    if (!ticked.length) {
      editor.message(t.waveNoChannels, true);
      return;
    }
    const muted = info.channels.reduce((mask, _, i) => ticked.includes(i) ? mask : mask + 2 ** i, 0);
    const separate = $('separate').checked ? ticked : [];

    // CCreateWaveDlg::OnBnClickedBegin(): the module's name, and the track's when there
    // are several; the files of the channels alone next to it
    let base = editor.fileBase();
    if (info.tracks.length > 1)
      base += ` - Track ${pad2(track + 1)} (${safeName(info.tracks[track])})`;
    const names = separate.map(c => `${pad2(c + 1)} - ${safeName(info.channels[c].name)}.wav`);

    editor.stopPlaying();
    const files = 1 + separate.length;
    const label = value => {
      const index = Math.min(files - 1, Math.floor(value * files));
      const which = files > 1 ? `${index + 1}/${files} ${index ? info.channels[separate[index - 1]].name : t.waveMix} · ` : '';
      return `${which}${Math.floor(value * 100)}%`;
    };
    this.showWaveProgress(0, label(0));
    this.waveTask = this.session.task('exportWave', [{ track, passes, seconds, rate, muted, separate }],
      value => this.showWaveProgress(value, label(value)));
    try {
      const rendered = await this.waveTask.promise;
      const out = rendered.map(file => ({ name: file.channel < 0 ? `${base}.wav` : names[separate.indexOf(file.channel)], data: file.data }));
      this.downloadFiles(out, `${base}.wav`, `${base}.zip`);
      editor.message(t.exported + (out.length > 1 ? `${base}.zip` : `${base}.wav`));
      d.close();
    } catch (e) {
      if (e.message === 'cancelled')
        editor.message(t.waveCancelled);
      else
        editor.message(t.exportFailed + e.message, true);
    } finally {
      this.waveTask = null;
      this.showWaveProgress(null);
    }
  }

  // ---- NSF and the other kinds of the NSF export dialog --------------------------------

  buildNsfDialog() {
    const t = this.strings;
    const group = `dnft-nsf-machine-${++dialogs}`;
    const d = this.nsfDialog = this.dialog('dnft-nsf-dialog', `
      <fieldset class="dnft-fieldset">
        <legend data-t="nsfInfo"></legend>
        <label class="dnft-field"><span data-t="title"></span><input type="text" data-song="title" spellcheck="false"></label>
        <label class="dnft-field"><span data-t="artist"></span><input type="text" data-song="artist" spellcheck="false"></label>
        <label class="dnft-field"><span data-t="copyright"></span><input type="text" data-song="copyright" spellcheck="false"></label>
        <div class="dnft-choices">
          <label class="dnft-check"><input type="radio" name="${group}" value="0"> NTSC</label>
          <label class="dnft-check"><input type="radio" name="${group}" value="1"> PAL</label>
          <label class="dnft-check"><input type="radio" name="${group}" value="2"> <span data-t="nsfDual"></span></label>
          <label class="dnft-check"><input type="checkbox" data-role="extra"> <span data-t="nsfExtra"></span></label>
        </div>
      </fieldset>
      <label class="dnft-field"><span data-t="nsfType"></span><select data-role="type"></select></label>
      <p class="dnft-hint" data-role="about"></p>
      <pre class="dnft-log" data-role="log" aria-live="polite"></pre>`, `
      <button type="button" class="dnft-button dnft-button--primary" data-role="export" data-t="nsfExport"></button>
      <button type="button" class="dnft-button" data-role="close" data-t="close"></button>`);
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    $('type').append(...NSF_TYPES.map(type => new Option(t.nsfTypes[type], type)));
    $('extra').closest('label').title = t.nsfExtraHint;
    $('type').addEventListener('change', () => {
      this.nsfType = $('type').value;
      this.updateNsfOptions();
    });
    $('export').addEventListener('click', () => this.exportNsf());
    $('close').addEventListener('click', () => d.close());
  }

  updateNsfOptions() {
    const d = this.nsfDialog;
    const type = this.nsfType;
    // CExportDialog: the extra data is for BIN and ASM; NES and PRG know NTSC and PAL
    d.querySelector('[data-role="extra"]').disabled = type !== 'bin' && type !== 'asm';
    const dual = d.querySelector('input[type="radio"][value="2"]');
    dual.disabled = type === 'nes' || type === 'prg';
    if (dual.disabled && dual.checked)
      d.querySelector('input[type="radio"][value="0"]').checked = true;
    d.querySelector('[data-role="about"]').textContent = this.strings.nsfAbout[type] ?? '';
  }

  openNsf() {
    const d = this.nsfDialog;
    const t = this.strings;
    const info = this.editor.song.info;
    d.querySelector('.dnft-dialog-title').textContent = t.nsfTitle;
    for (const input of d.querySelectorAll('[data-song]'))
      input.value = info[input.dataset.song];
    d.querySelector(`input[type="radio"][value="${info.pal ? 1 : 0}"]`).checked = true;
    d.querySelector('[data-role="type"]').value = this.nsfType;
    d.querySelector('[data-role="log"]').textContent = '';
    this.updateNsfOptions();
    d.showModal();
  }

  async exportNsf() {
    const d = this.nsfDialog;
    const t = this.strings;
    const editor = this.editor;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    const type = this.nsfType;
    const machine = Number(d.querySelector('input[type="radio"]:checked')?.value ?? 0);
    const extra = !$('extra').disabled && $('extra').checked;
    const button = $('export');
    button.disabled = true;
    editor.stopPlaying();
    try {
      // CExportDialog::CreateNSF(): the names in the dialog go into the module
      for (const input of d.querySelectorAll('[data-song]'))
        if (input.value !== editor.song.info[input.dataset.song])
          await editor.setSongText(input.dataset.song, input.value);
      const result = await this.session.call('exportNSF', type, machine, extra);
      const log = [result.messages, result.log].filter(Boolean).join('\n').replace(/\r\n/g, '\n');
      $('log').textContent = log;
      $('log').scrollTop = $('log').scrollHeight;
      if (!result.files.length) {
        editor.message(t.exportFailed + (result.messages || t.nsfFailed), true);
        return;
      }
      const base = editor.fileBase();
      const single = `${base}.${EXTENSIONS[type]}`;
      this.downloadFiles(result.files, single, `${base}.zip`);
      editor.message(t.exported + (result.files.length > 1 ? `${base}.zip` : single));
    } catch (e) {
      editor.message(t.exportFailed + e.message, true);
    } finally {
      button.disabled = false;
    }
  }

  // ---- module import -------------------------------------------------------------------

  buildImportDialog() {
    const d = this.importDialog = this.dialog('dnft-import-dialog', `
      <fieldset class="dnft-fieldset">
        <legend data-t="importTracks"></legend>
        <div class="dnft-channel-list" data-role="tracks"></div>
      </fieldset>
      <fieldset class="dnft-fieldset">
        <legend data-t="importOptions"></legend>
        <label class="dnft-check"><input type="checkbox" data-role="instruments" checked> <span data-t="importInstruments"></span></label>
        <label class="dnft-check"><input type="checkbox" data-role="grooves" checked> <span data-t="importGrooves"></span></label>
        <label class="dnft-check"><input type="checkbox" data-role="detune"> <span data-t="importDetune"></span></label>
      </fieldset>
      <p class="dnft-hint" data-role="chips"></p>`, `
      <button type="button" class="dnft-button dnft-button--primary" data-role="ok" data-t="importOk"></button>
      <button type="button" class="dnft-button" data-role="cancel" data-t="cancel"></button>`);
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    $('ok').addEventListener('click', () => this.finishImport());
    $('cancel').addEventListener('click', () => d.close());
    // closed without importing, Escape included
    d.addEventListener('close', () => {
      if (this.importName !== null) {
        this.importName = null;
        this.session.send('cancelImport');
      }
    });
  }

  async importModule(file) {
    const t = this.strings;
    const editor = this.editor;
    const d = this.importDialog;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    editor.stopPlaying();
    let description;
    try {
      description = await this.session.call('beginImport', new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      editor.message(t.notModule + e.message, true);
      return;
    }
    this.importName = file.name;
    d.querySelector('.dnft-dialog-title').textContent = `${t.importTitle}: ${file.name}`;
    $('tracks').replaceChildren(...description.tracks.map((title, i) => {
      const label = document.createElement('label');
      label.className = 'dnft-check';
      label.innerHTML = '<input type="checkbox" checked> <span></span>';
      label.querySelector('span').textContent = `#${pad2(i + 1)} ${title}`;
      return label;
    }));
    // CModuleImportDlg::LoadFile(): the module gets the chips of the other one too
    const info = editor.song.info;
    const added = CHIP_NAMES.filter(([, bit]) => (description.chips & bit) && !(info.chips & bit)).map(([name]) => name);
    const n163 = (description.chips & N163) && description.namcoChannels > info.namcoChannels ? description.namcoChannels : 0;
    const notes = [];
    if (added.length)
      notes.push(t.importChips + added.join(' '));
    if (n163)
      notes.push(t.importN163.replace('{n}', n163));
    $('chips').textContent = notes.join(' ');
    $('chips').hidden = !notes.length;
    d.showModal();
  }

  async finishImport() {
    const t = this.strings;
    const editor = this.editor;
    const d = this.importDialog;
    const $ = role => d.querySelector(`[data-role="${role}"]`);
    const tracks = [...$('tracks').querySelectorAll('input')].map(box => box.checked);
    const name = this.importName;
    // the import is made: closing must not call it off
    this.importName = null;
    d.close();
    const before = editor.song.info.tracks.length;
    let result;
    try {
      result = await this.session.call('finishImport', tracks, $('instruments').checked, $('grooves').checked, $('detune').checked);
    } catch (e) {
      editor.message(t.importFailed + e.message, true);
      return;
    }
    // new tracks, instruments, maybe channels: everything again, and nothing to undo
    await editor.reloadSong();
    editor.history.clear();
    editor.edited();
    const count = tracks.filter(Boolean).length;
    if (editor.song.info.tracks.length > before)
      await editor.selectTrack(before);
    if (result.imported)
      editor.message(t.imported.replace('{name}', name).replace('{n}', count));
    else
      editor.message(t.importFailed + (result.messages || name), true);
  }
}

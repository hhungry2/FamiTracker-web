// Dn-FamiTracker web port - File > Recent Files: the modules opened or saved last, kept in
// the browser (IndexedDB) with their bytes, since a page has no way to open a file by its
// path. A menu next to Save lists them, newest first, and opens one again; Clear forgets
// them.
//
//   const recent = new RecentFiles(editor);   // adds its menu after the Save button
//   recent.add('song.dnm', bytes);            // after a module is opened or saved

const DATABASE = 'dnft-editor';
const STORE = 'recent';
// Like the desktop's list of four, with room for more: modules are not large
const MAX_FILES = 9;
const MAX_BYTES = 8 * 1024 * 1024;

export class RecentFiles {
  constructor(editor) {
    this.editor = editor;
    this.files = [];            // {name, bytes, time}, newest first
    this.db = null;
    this.build();
    this.load();
  }

  get strings() {
    return this.editor.strings;
  }

  build() {
    const t = this.strings;
    const wrap = this.wrap = this.editor.files.menu(t.recentFiles, t.recentFilesHint, () => this.items());
    this.editor.root.querySelector('[data-action="save"]').after(wrap);
  }

  // What the menu offers now
  items() {
    const t = this.strings;
    if (!this.files.length)
      return [{ label: t.noRecentFiles, disabled: () => true, run: () => {} }];
    return [
      ...this.files.map(file => ({
        label: file.name,
        hint: `${new Date(file.time).toLocaleString(this.editor.lang)}  ·  ${Math.max(1, Math.round(file.bytes.length / 1024))} KB`,
        run: () => this.editor.openFile(new File([file.bytes], file.name)),
      })),
      null,
      { label: t.clearRecentFiles, run: () => this.clear() },
    ];
  }

  // ---- the browser's store ------------------------------------------------------------------

  open() {
    return this.db ??= new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error('no IndexedDB'));
        return;
      }
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'name' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async transaction(mode, work) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const result = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(result?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async load() {
    try {
      const all = await this.transaction('readonly', store => store.getAll());
      this.files = this.sort(all ?? []);
    } catch {
      // no store: the list lives as long as the page
    }
  }

  sort(files) {
    return files.sort((a, b) => b.time - a.time).slice(0, MAX_FILES);
  }

  // A module opened or saved moves to the top of the list
  async add(name, bytes) {
    if (bytes.length > MAX_BYTES)
      return;
    const entry = { name, bytes: Uint8Array.from(bytes), time: Date.now() };
    const before = this.files;
    this.files = this.sort([entry, ...before.filter(file => file.name !== name)]);
    const dropped = before.filter(file => !this.files.includes(file) && file.name !== name);
    try {
      await this.transaction('readwrite', store => {
        store.put(entry);
        for (const file of dropped)
          store.delete(file.name);
      });
    } catch {
      // the list stays in the page
    }
  }

  async clear() {
    this.files = [];
    try {
      await this.transaction('readwrite', store => store.clear());
    } catch {
      // nothing was kept
    }
  }
}

// Static catalogs and actual NSF UI messages in every supported editor language.
// node web/test/i18n.mjs
import { strict as assert } from 'node:assert';
import { STRINGS, LANGUAGES, resolveLanguage } from '../html/dnft-editor-strings.mjs';
import { SongMenu } from '../html/dnft-song-menu.mjs';
import { FileMenu } from '../html/dnft-files.mjs';

const languages = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'ko', 'es', 'pt-BR', 'fr', 'de', 'ru'];
const flatten = (value, path = '', result = {}) => {
  for (const [key, text] of Object.entries(value)) {
    const name = path ? `${path}.${key}` : key;
    if (typeof text === 'string') result[name] = text;
    else flatten(text, name, result);
  }
  return result;
};
const tokens = text => (text.match(/\{[^{}]+\}|%\d+/g) ?? []).sort();
assert.deepEqual(Object.keys(LANGUAGES), languages);
assert.deepEqual(Object.keys(STRINGS).sort(), [...languages].sort());
const reference = flatten(STRINGS.en);
for (const language of languages) {
  const texts = flatten(STRINGS[language]);
  assert.deepEqual(Object.keys(texts).sort(), Object.keys(reference).sort(), `${language}: missing/extra text`);
  for (const [key, text] of Object.entries(texts)) {
    // Japanese deliberately omits prefixes that are expressed by a suffix.
    if (!['ja', 'en'].includes(language) && reference[key].trim()) {
      assert.ok(text.trim(), `${language}: ${key} is empty`);
    }
    assert.deepEqual(tokens(text), tokens(reference[key]), `${language}: ${key} changed substitution tokens`);
    if (!['ja', 'en'].includes(language)) {
      assert.equal(text.match(/^\s*/)[0], reference[key].match(/^\s*/)[0], `${language}: ${key} leading spacing`);
      assert.equal(text.match(/\s*$/)[0], reference[key].match(/\s*$/)[0], `${language}: ${key} trailing spacing`);
    }
    assert.ok(!/93\d{4}|ZXQ|QXZ|▁|�/.test(text), `${language}: ${key} contains a draft token`);
  }
  console.log(`ok - ${language}: ${Object.keys(texts).length} strings and substitution tokens`);
}

for (const [input, expected] of [
  ['JA-jp', 'ja'], ['EN-us', 'en'], ['zh', 'zh-Hans'], ['zh-CN', 'zh-Hans'], ['zh-SG', 'zh-Hans'],
  ['zh_TW', 'zh-Hant'], ['zh-HK', 'zh-Hant'], ['zh-MO', 'zh-Hant'], ['zh-Hans-TW', 'zh-Hans'],
  ['zh-Hant-CN', 'zh-Hant'], ['KO-kr', 'ko'], ['es-MX', 'es'], ['pt-PT', 'pt-BR'],
  ['pt-BR', 'pt-BR'], ['fr-CA', 'fr'], ['de-AT', 'de'], ['ru-RU', 'ru'],
  [['it-IT', 'de-DE', 'en'], 'de'], [undefined, 'en'], ['constructor', 'en'], ['', 'en'],
]) assert.equal(resolveLanguage(input), expected, JSON.stringify(input));
console.log('ok - browser preferences, region/script aliases and unsupported languages');

for (const language of languages) {
  const strings = STRINGS[language];
  const messages = [];
  const dialog = { showModal() {}, close() {}, querySelector: () => ({}) };
  const editor = {
    strings, track: 0, tr: { title: 'source' }, song: { info: { tracks: ['source'] } },
    stopPlaying() {}, message: (...args) => messages.push(args),
    session: { sampleRate: 44100, task: () => ({ promise: Promise.reject(new Error('nsfReconstructMismatch')) }) },
  };
  const menu = Object.create(SongMenu.prototype);
  Object.assign(menu, { editor, reconstructionDialog: dialog });
  await menu.reconstructNsf();
  assert.deepEqual(messages.pop(), [strings.nsfReconstructFailed + strings.nsfReconstructMismatch, true]);
  editor.song.info.tracks = Array(64).fill('source');
  await menu.reconstructNsf();
  assert.deepEqual(messages.pop(), [strings.nsfReconstructFull, true]);

  const nodes = new Map(['song', 'method', 'regions', 'time', 'rows', 'loop', 'trim'].map(role =>
    [role, { value: { song: 'all', method: 'driver', rows: '128' }[role], hidden: true, checked: true }]));
  const files = Object.create(FileMenu.prototype);
  const snapshot = { nsfReader: { fallback: true }, batch: {
    songs: [{ song: 0, report: { warnings: ['silentSong'] } }], totalSongs: 65, limit: 'trackLimit',
  } };
  Object.assign(editor, { dirty: false, setSong() {}, renderToolbar() {}, saveToBrowser() {},
    session: { sampleRate: 44100, task: () => ({ promise: Promise.resolve(snapshot) }) } });
  Object.assign(files, { editor, nsfFile: { name: 'test.nsf', bytes: new Uint8Array(), info: { songs: 65 } },
    nsfImportDialog: { querySelector: selector => nodes.get(selector.match(/data-role="([^"]+)"/)[1]), close() {} },
    nsfSeconds: () => 20, showNsfImportProgress() {} });
  await files.startNsfImport();
  const message = messages.pop()[0];
  for (const text of [strings.nsfImportedAll.replace('{n}', 1).replace('{total}', 65),
    strings.nsfImportDriverFallback, strings.nsfImportWarnings.trackLimit, strings.nsfImportWarnings.silentSong]) {
    assert.ok(message.includes(text), `${language}: missing NSF result/warning`);
  }
  console.log(`ok - ${language}: reconstruction errors and all-song import fallback/capacity warnings`);
}
console.log('all passed');

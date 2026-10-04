// Checks how modules' texts are read and written: the code pages of the desktop tracker
// (Windows-1252 and 932, Shift_JIS) and UTF-8 (src/text_encoding.h).
//
//   node test/text.mjs

import createDnFT from '../dist/dnft.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.join(here, '..', '..', 'demo');
const RATE = 48000;

const dnft = await createDnFT();

function withHeap(bytes, fn) {
  const at = dnft._malloc(bytes.length);
  dnft.HEAPU8.set(bytes, at);
  try {
    return fn(at, bytes.length);
  } finally {
    dnft._free(at);
  }
}

const message = e => e instanceof WebAssembly.Exception ? dnft.getExceptionMessage(e).at(-1) : e.message;
const rethrow = fn => {
  try {
    return fn();
  } catch (e) {
    throw new Error(message(e));
  }
};
const openSession = bytes => withHeap(bytes, (at, size) => rethrow(() => dnft.openSession(at, size, RATE)));
const load = bytes => withHeap(bytes, (at, size) => rethrow(() => dnft.load(at, size, '')));
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ');
const utf8 = text => new TextEncoder().encode(text);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    ++failures;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

// ---- the code pages, independently of the engine ----------------------------------------------

// Code page 932 by way of the Encoding Standard's decoder: the first code of each
// character, NEC's copies of IBM's characters (0xED-0xEE) left out, as Windows writes
const cp932 = (() => {
  const codes = new Map();
  const decoder = new TextDecoder('shift_jis', { fatal: true });
  for (let lead = 0x81; lead <= 0xFC; ++lead) {
    if ((lead > 0x9F && lead < 0xE0) || lead === 0xED || lead === 0xEE)
      continue;
    for (let trail = 0x40; trail <= 0xFC; ++trail) {
      if (trail === 0x7F)
        continue;
      try {
        const text = decoder.decode(Uint8Array.of(lead, trail));
        if ([...text].length === 1 && !codes.has(text))
          codes.set(text, [lead, trail]);
      } catch {}
    }
  }
  return text => Uint8Array.from([...text].flatMap(ch => {
    const c = ch.codePointAt(0);
    if (c < 0x80)
      return [c];
    if (c >= 0xFF61 && c <= 0xFF9F)
      return [0xA1 + c - 0xFF61];
    if (!codes.has(ch))
      throw new Error(`${ch} is not in code page 932`);
    return codes.get(ch);
  }));
})();

const CP1252_80 = '€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0\0‘’“”•–—˜™š›œ\0žŸ';
const cp1252 = text => Uint8Array.from([...text].map(ch => {
  const c = ch.codePointAt(0);
  if (c < 0x80 || (c >= 0xA0 && c <= 0xFF))
    return c;
  const at = CP1252_80.indexOf(ch);
  if (ch === '\0' || at < 0)
    throw new Error(`${ch} is not in Windows-1252`);
  return 0x80 + at;
}));

const decode = bytes => rethrow(() => dnft.decodeText(bytes));
const encode = (text, max = 1000) => rethrow(() => dnft.encodeText(text, max));

// ---- reading ----------------------------------------------------------------------------------

const JAPANESE = [
  'テスト曲', 'ボス戦', 'エンディング', 'ロックマン2', 'ステージ1 BGM', 'FC版テーマ', 'FC版', '音楽', '東京', '日本',
  '夢', '天地', '曲', 'さくら', 'ﾌｧﾐｺﾝ', 'ｼｮｳﾀ', 'ＦＣ音源', '①②③', '★☆♪', 'ドラクエ3～序曲', '㈱ナムコ', '髙橋',
  'Ⅰ', 'ファミコン（ＦＣ）用の曲です。\r\n二行目：テスト', 'VRC6 ノコギリ波',
];
const WESTERN = [
  'Pokémon', 'Don’t Stop', 'It’s', 'Rock’n’Roll', 'Café', 'Über', '© 2020 Someone', 'Déjà vu', 'Ñandú', 'Smørrebrød',
  'Mégaman', 'Château', 'Æon Flux', 'Crème brûlée', 'naïve', 'Façade', 'Hello…', '“Quoted”', 'Intro – Part 1',
  'Mario™', 'Ça va', 'Élan', 'L’amour', '½ step', '£5', '90°', 'Zoë', 'Señor', 'Björk – Jóga',
];

check('code page 932 reads as Japanese', () => {
  for (const text of JAPANESE)
    assert.equal(decode(cp932(text)), text, hex(cp932(text)));
});

check('Windows-1252 reads as Western text', () => {
  for (const text of WESTERN)
    assert.equal(decode(cp1252(text)), text, hex(cp1252(text)));
});

check('UTF-8 reads as it is', () => {
  for (const text of [...JAPANESE, ...WESTERN, 'ASCII only', '', '🎵 emoji'])
    assert.equal(decode(utf8(text)), text);
});

check('a character cut off at the end is left out', () => {
  const bytes = cp932('テスト');
  assert.equal(decode(Uint8Array.of(...bytes, 0x83)), 'テスト');
});

check('bytes that are text in neither code page still read', () => {
  const text = decode(Uint8Array.of(0x41, 0x81, 0x20, 0x42));
  assert.ok(text.startsWith('A') && text.endsWith('B') && text.includes('�'), JSON.stringify(text));
});

// ---- writing ----------------------------------------------------------------------------------

check('Japanese is written in code page 932', () => {
  for (const text of JAPANESE)
    assert.equal(hex(encode(text)), hex(cp932(text)), text);
});

check('Western text is written in Windows-1252', () => {
  for (const text of WESTERN)
    assert.equal(hex(encode(text)), hex(cp1252(text)), text);
});

check('text no code page holds is written in UTF-8', () => {
  for (const text of ['Café テスト', '🎵 music', 'Ōkami', '음악'])
    assert.equal(hex(encode(text)), hex(utf8(text)), text);
  // code page 932 has Greek and Cyrillic
  for (const text of ['Ωmega テスト', 'Привет'])
    assert.equal(hex(encode(text)), hex(cp932(text)), text);
});

check('text a code page would read back otherwise is written so that it does not', () => {
  // in Windows-1252, these bytes read as the kanji 天地
  const text = '“V’n';
  assert.equal(decode(cp1252(text)), '天地');
  assert.notEqual(hex(encode(text)), hex(cp1252(text)));
  assert.equal(decode(encode(text)), text);
});

check('what is written reads back the same', () => {
  for (const text of [...JAPANESE, ...WESTERN, 'Café テスト', '¥100', '×÷±°', 'SFC版BGM', 'A×B', '™Mario', '’n Sync'])
    assert.equal(decode(encode(text)), text, text);
});

check('the limit cuts where a character ends', () => {
  assert.equal(decode(encode('テスト', 5)), 'テス');
  assert.equal(hex(encode('テスト', 5)), hex(cp932('テス')));
  assert.equal(decode(encode('あいうえおかきくけこさしすせそたちつてと', 31)), 'あいうえおかきくけこさしすせそ');
  assert.equal(decode(encode('Café テスト', 8)), 'Café ');
  assert.equal(decode(encode('Pokémon', 4)), 'Poké');
  assert.equal(encode('ASCII text', 5).length, 5);
});

// ---- modules ----------------------------------------------------------------------------------

const files = readdirSync(demoDir).filter(f => /\.(dnm|0cc|ftm)$/i.test(f)).sort();
const demo = readFileSync(path.join(demoDir, files[0]));

// A module as the desktop tracker saves it on Japanese Windows: the INFO block's texts in
// code page 932 (or other bytes)
function withInfo(bytes, title, artist, copyright) {
  const copy = Uint8Array.from(bytes);
  const at = new TextDecoder('latin1').decode(copy).indexOf('INFO\0') + 24;
  assert.ok(at > 24, 'no INFO block');
  copy.fill(0, at, at + 96);
  copy.set(title, at);
  copy.set(artist, at + 32);
  copy.set(copyright, at + 64);
  return copy;
}

check('players and sessions read the desktop\'s texts', () => {
  const bytes = withInfo(demo, cp932('テスト曲'), cp932('ﾌｧﾐｺﾝ'), cp1252('© 2020 Pokémon'));
  const track = load(bytes);
  assert.equal(track.getProperty('Title', ''), 'テスト曲');
  assert.equal(track.getProperty('Author', ''), 'ﾌｧﾐｺﾝ');
  assert.equal(track.getProperty('Copyright', ''), '© 2020 Pokémon');
  track.delete();
  const s = openSession(bytes);
  const info = s.info();
  assert.deepEqual([info.title, info.artist, info.copyright], ['テスト曲', 'ﾌｧﾐｺﾝ', '© 2020 Pokémon']);
  s.delete();
});

check('sessions write texts as the desktop does, and read them back', () => {
  const s = dnft.createSession(RATE);
  s.setTitle('テスト曲');
  s.setArtist('Pokémon');
  s.setCopyright('Café テスト');
  s.setComment('一行目\n二行目 – Déjà vu', false);
  s.setTrackTitle(0, 'ボス戦');
  s.setInstrumentName(0, 'ノコギリ波');
  const saved = s.save();
  s.delete();

  const at = new TextDecoder('latin1').decode(saved).indexOf('INFO\0') + 24;
  assert.equal(hex(saved.subarray(at, at + 8)), hex(cp932('テスト曲')));
  assert.equal(hex(saved.subarray(at + 32, at + 39)), hex(cp1252('Pokémon')));
  assert.equal(hex(saved.subarray(at + 64, at + 64 + 15)), hex(utf8('Café テスト')));

  const again = openSession(saved);
  const info = again.info();
  assert.equal(info.title, 'テスト曲');
  assert.equal(info.artist, 'Pokémon');
  assert.equal(info.copyright, 'Café テスト');
  assert.equal(info.comment, '一行目\n二行目 – Déjà vu');
  assert.equal(info.tracks[0], 'ボス戦');
  assert.equal(again.instruments()[0].name, 'ノコギリ波');
  again.delete();
});

check('the JSON export has the texts in UTF-8', () => {
  const s = openSession(withInfo(demo, cp932('テスト曲'), cp1252('Pokémon'), utf8('©')));
  s.setComment('日本語のコメント', false);
  const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rethrow(() => s.exportJSON())));
  assert.equal(json.metadata.title, 'テスト曲');
  assert.equal(json.metadata.artist, 'Pokémon');
  assert.equal(json.metadata.copyright, '©');
  assert.equal(json.metadata.comment, '日本語のコメント');
  s.delete();
});

check('the NSF header has the title as the desktop writes it', () => {
  const s = dnft.createSession(RATE);
  s.setTitle('テスト曲');
  const r = rethrow(() => s.exportNSF('nsf', 0, false));
  assert.equal(r.files.length, 1, r.log);
  assert.equal(hex(r.files[0].data.subarray(0x0E, 0x0E + 8)), hex(cp932('テスト曲')));
  s.delete();
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exitCode = failures ? 1 : 0;

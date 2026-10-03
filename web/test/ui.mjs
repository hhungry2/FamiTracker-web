// Checks what the editor's Tracker, View and Configuration need that works on numbers and
// tables, without a page: the key table and what a keyboard event gives, the register
// view's text for what the engine reports of the chips, and the effect table's data.
//
//   node test/ui.mjs

import createDnFT from '../dist/dnft.mjs';
import { strict as assert } from 'node:assert';
import { COMMANDS, GROUPS, Keymap, comboOf, formatCombo } from '../html/dnft-keymap.mjs';
import { RegisterView, CHIP_VIEWS, pitchText, noteOfFrequency, registerColor } from '../html/dnft-displays.mjs';
import { STRINGS } from '../html/dnft-editor-strings.mjs';
import { effectHintKey } from '../html/dnft-effect-hints.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    ++failures;
    console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ') ?? e.message}`);
  }
}

const event = (code, { ctrl = false, alt = false, shift = false, meta = false } = {}) => ({ code, ctrlKey: ctrl, altKey: alt, shiftKey: shift, metaKey: meta });

check('a keyboard event is its modifiers and the key\'s place', () => {
  assert.equal(comboOf(event('KeyZ', { ctrl: true })), 'C+KeyZ');
  assert.equal(comboOf(event('KeyZ', { meta: true })), 'C+KeyZ');
  assert.equal(comboOf(event('ArrowUp', { ctrl: true, shift: true })), 'CS+ArrowUp');
  assert.equal(comboOf(event('F9', { ctrl: true, alt: true })), 'CA+F9');
  assert.equal(comboOf(event('F5')), 'F5');
  assert.equal(comboOf(event('ShiftLeft', { shift: true })), null);
  assert.equal(comboOf(event('ControlRight', { ctrl: true })), null);
  assert.equal(formatCombo('C+KeyZ'), 'Ctrl+Z');
  assert.equal(formatCombo('CS+ArrowUp'), 'Ctrl+Shift+↑');
  assert.equal(formatCombo('CA+F9'), 'Ctrl+Alt+F9');
  assert.equal(formatCombo('F12'), 'F12');
  assert.equal(formatCombo('A+Numpad3'), 'Alt+Num 3');
  assert.equal(formatCombo('C+NumpadAdd'), 'Ctrl+Num +');
  assert.equal(formatCombo('A+Digit1'), 'Alt+1');
});

check('the key table is the desktop\'s: no key for two commands, every command named', () => {
  const owners = new Map();
  for (const command of COMMANDS)
    for (const key of command.keys) {
      assert.ok(!owners.has(key), `${key} is ${owners.get(key)} and ${command.id}`);
      owners.set(key, command.id);
    }
  for (const lang of ['ja', 'en'])
    for (const command of COMMANDS.filter(c => !c.hidden))
      assert.ok(STRINGS[lang].commandNames[command.id], `${lang}: ${command.id} has no name`);
  assert.deepEqual([...new Set(COMMANDS.map(c => c.group))].sort(), [...GROUPS].sort());
  const keymap = new Keymap(false);
  assert.equal(keymap.lookup(event('F5')).id, 'playSong');
  assert.equal(keymap.lookup(event('KeyY', { ctrl: true })).id, 'redo');
  assert.equal(keymap.lookup(event('KeyZ', { ctrl: true, shift: true })).id, 'redo');
  assert.equal(keymap.lookup(event('ArrowUp', { ctrl: true })).id, 'prevInstrument');
  assert.equal(keymap.lookup(event('F12')).id, 'killSound');
  assert.equal(keymap.lookup(event('KeyB', { ctrl: true })).id, 'setMarker');
  assert.equal(keymap.lookup(event('F7', { ctrl: true })).id, 'playMarker');
  assert.equal(keymap.lookup(event('Numpad4', { alt: true })).id, 'step4');
  assert.equal(keymap.lookup(event('KeyQ')), undefined);
  // what works wherever the keyboard is
  assert.deepEqual(COMMANDS.filter(c => c.global).map(c => c.id).sort(), ['help', 'killSound', 'playCursor', 'playMarker', 'playPattern', 'playSong', 'stop']);
});

check('a command gets another key, takes it from the one that had it, and goes back', () => {
  const keymap = new Keymap(false);
  keymap.setKeys('playRow', [...keymap.keysOf('playRow'), 'F12']);
  assert.equal(keymap.lookup(event('F12')).id, 'playRow');
  assert.deepEqual(keymap.keysOf('killSound'), []);
  assert.equal(keymap.owner('F12', 'playRow'), null);
  assert.equal(keymap.owner('F12').id, 'playRow');
  assert.ok(!keymap.isDefault('killSound'));
  keymap.reset('playRow');
  keymap.reset('killSound');
  assert.equal(keymap.lookup(event('F12')).id, 'killSound');
  // a command set to its own defaults is no change
  keymap.setKeys('undo', ['C+KeyZ']);
  assert.ok(keymap.isDefault('undo'));
  keymap.setKeys('stop', ['F8', 'KeyX']);
  keymap.resetAll();
  assert.equal(keymap.lookup(event('KeyX')), undefined);
});

// ---- the register view -------------------------------------------------------------------

const RATE = 48000, CHUNK = 1024;
const dnft = await createDnFT();
const heap = dnft._malloc(CHUNK * 4);

check('pitches are named as the desktop\'s register view names them', () => {
  assert.equal(noteOfFrequency(440), 45);
  // 440 Hz is A-4 here, as in the desktop's view (the pattern's A-4 is an octave higher)
  assert.equal(pitchText(3, 0x0FE, 440), 'pitch = $0FE ( 440.00Hz A-4  +00)');
  assert.equal(pitchText(3, 0x07E, 880.79), 'pitch = $07E ( 880.79Hz A-5  +01)');
  assert.equal(pitchText(3, 0, 0), 'pitch = $000 (   0.00Hz ---   +00)');
  assert.equal(pitchText(1, 5, 8000, 'rate  ', 9), 'rate   = $5 (  8000.00Hz B-8  +21)');
  // a write that has just been made is its colour, an old one grey
  assert.notEqual(registerColor(0x00), registerColor(0x0F));
  assert.equal(registerColor(0x0F), 'rgb(192, 192, 192)');
});

check('the register view shows what a chip plays: its registers, pitch and volume', () => {
  const session = dnft.createSession(RATE);
  session.noteOn(0, 10, 4, 0, 16);       // A-4 on the first pulse channel
  for (let i = 0; i < 4; ++i)
    session.render(heap, CHUNK);
  const requests = [CHIP_VIEWS[0]].map(({ chip, addresses, frequencies }) => ({ chip, addresses, frequencies }));
  const data = requests.map(({ chip, addresses, frequencies }) => ({
    chip, registers: session.registers(chip, addresses), frequencies: session.channelFrequencies(chip, frequencies),
  }));
  const fake = { song: { info: { namcoChannels: 1 } } };
  const view = new RegisterView(fake, { querySelector: () => ({}) });
  const lines = view.describe(data);
  assert.ok(lines.length > 6);
  // A-4 of the pattern on the first pulse channel: period $07E, about 880 Hz
  assert.ok(data[0].frequencies[0] > 870 && data[0].frequencies[0] < 890, `${data[0].frequencies[0]}`);
  const recorded = [];
  const ctx = { fillText: text => recorded.push(text), fillRect() {}, set fillStyle(_) {}, measureText: () => ({ width: 7 }) };
  for (const line of lines)
    line.draw(ctx, 0, 0, 7, 600);
  const text = recorded.join('|');
  assert.match(text, /2A03 registers/);
  assert.match(text, /\$4000:/);
  assert.match(text, /pitch = \$07E \(\s*88\d\.\d\dHz A-5/);
  assert.match(text, /vol = 15, duty = 0/);
  assert.match(text, /size = 1 byte/);
  session.delete();
});

check('the register view draws every chip of a module that plays them all', () => {
  const session = dnft.createSession(RATE);
  const CHIPS = 1 | 2 | 4 | 8 | 16 | 32;
  session.setExpansion(CHIPS, 3);
  const info = session.info();
  // a note on every channel
  info.channels.forEach((channel, i) => {
    if (channel.id !== 4)
      session.noteOn(i, 1 + i % 12, 3, 0, 16);
  });
  for (let i = 0; i < 6; ++i)
    session.render(heap, CHUNK);
  const data = CHIP_VIEWS.map(({ chip, addresses, frequencies }) => ({
    chip, registers: session.registers(chip, addresses), frequencies: session.channelFrequencies(chip, frequencies),
    ...(chip === 4 ? { modCounter: session.fdsModCounter() } : {}),
  }));
  const view = new RegisterView({ song: { info: { namcoChannels: info.namcoChannels } } }, { querySelector: () => ({}) });
  const lines = view.describe(data);
  const recorded = [];
  const ctx = { fillText: text => recorded.push(text), fillRect() {}, set fillStyle(_) {}, createLinearGradient: () => ({ addColorStop() {} }) };
  for (const line of lines)
    line.draw(ctx, 0, 0, 7, 700);
  const text = recorded.join('|');
  for (const name of ['2A03', 'VRC6', 'MMC5', 'N163', 'FDS', 'VRC7', '5B'])
    assert.match(text, new RegExp(`${name} registers`));
  assert.match(text, /\$9000:/);
  assert.match(text, /patch = \$/);
  assert.match(text, /mode = [T-][N-][E-]/);
  assert.match(text, /counter = \d\d/);
  session.delete();
});

check('the effect table has what the page needs: letters, names and the chips that take each', () => {
  const effects = dnft.effects();
  for (const lang of ['ja', 'en']) {
    const info = STRINGS[lang].effectInfo;
    for (const id of effects.letters.keys())
      if (effects.letters[id])
        assert.ok(info[id] || id === 7, `${lang}: effect ${id} (${effects.letters[id]}) has no text`);
    for (const id of Object.keys(info))
      assert.equal(info[id].length, 2, `${lang}: ${id}`);
  }
  // each chip takes a letter for each of the effects it can play
  assert.equal(effects.byChip[0]['F'], 1);
  assert.equal(effects.byChip[4]['E'], 40);
  assert.equal(effects.byChip[32]['W'], 33);
});

check('the hint of every effect has a text in both languages', () => {
  const seen = new Set();
  // every effect, with the parameters and places that make the hint differ
  for (let effect = 1; effect <= 44; ++effect)
    for (const param of [0, 0x10, 0x40, 0x80, 0xE0])
      for (const [chip, channel] of [[0, 0], [0, 2], [2, 6], [16, 8], [4, 9]]) {
        const key = effectHintKey(effect, param, { chip, channel, splitPoint: 32 });
        assert.ok(key, `effect ${effect}`);
        seen.add(key);
        for (const lang of ['ja', 'en']) {
          const text = STRINGS[lang].effectHints[key];
          assert.ok(text, `${lang}: ${key}`);
        }
      }
  // no text without an effect that has it
  for (const lang of ['ja', 'en'])
    for (const key of Object.keys(STRINGS[lang].effectHints))
      assert.ok(seen.has(key) || key === 'undefined', `${lang}: ${key} is never given`);
  assert.equal(effectHintKey(45, 0), 'undefined');
  assert.equal(effectHintKey(0, 0), '');
});

check('the hint depends on the parameter, the chip and the channel as the desktop\'s does', () => {
  const key = (effect, param, where = {}) => effectHintKey(effect, param, where);
  assert.equal(key(1, 31), 'speedSpeed');
  assert.equal(key(1, 32), 'speedTempo');
  assert.equal(key(1, 21, { splitPoint: 21 }), 'speedTempo', 'the module\'s own split point');
  assert.equal(key(5, 0xDF), 'lengthIndex');
  assert.equal(key(5, 0xE0), 'lengthMode');
  assert.equal(key(18, 0, { chip: 16 }), 'dutyN163');
  assert.equal(key(18, 0, { chip: 2 }), 'dutyVrc7');
  assert.equal(key(18, 0, { chip: 1 }), 'duty');
  assert.equal(key(23, 0x80, { channel: 2 }), 'cutTriangle');
  assert.equal(key(23, 0x80, { channel: 0 }), 'noteCut');
  assert.equal(key(23, 0x7F, { channel: 2 }), 'noteCut');
  assert.equal(key(24, 5, { channel: 2 }), 'retriggerTriangle');
  assert.equal(key(24, 0, { channel: 2 }), 'retriggerTriangleOff');
  assert.equal(key(24, 0, { channel: 4 }), 'retriggerDpcm');
  assert.equal(key(26, 0x7F), 'fdsModDepth');
  assert.equal(key(26, 0x80), 'fdsModRatio');
  assert.equal(key(27, 0x0F), 'fdsModRateHi');
  assert.equal(key(27, 0x10), 'fdsAutoMod');
  assert.equal(key(30, 0x0F), 'envShape');
  assert.equal(key(30, 0x10), 'envAuto');
  assert.equal(key(38, 0x7F), 'transposeUp');
  assert.equal(key(38, 0x80), 'transposeDown');
  assert.equal(key(40, 0x3F), 'fdsVolumeAttack');
  assert.equal(key(40, 0x40), 'fdsVolumeDecay');
  // the English texts are the desktop's
  assert.equal(STRINGS.en.effectHints.speedSpeed, 'Fxx - Set speed to XX, cancels groove. If xx>=10, tempo must be fixed.');
  assert.equal(STRINGS.en.effectHints.harmonic, 'Kxx - Multiply frequency by XX; does not affect Ixy Auto FDS modulation');
});

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall passed');

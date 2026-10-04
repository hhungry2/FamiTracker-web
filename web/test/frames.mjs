// Checks the frame editor's page code that works on numbers, without a page: its
// selections, what Copy keeps, where Paste, Paste & Overwrite and Delete go, the pattern
// numbers stepped, and Select > In Other Editor, against what the desktop's code does
// (CFrameEditor, CFrameAction, CMainFrame::OnEditSelectother()). What the engine does with
// them is session.mjs's.
//
//   node test/frames.mjs

import { strict as assert } from 'node:assert';
import {
  normalizeFrames, inFrames, wholeFrames, copyFrames, pasteSelection, cropClip, deletion, steppedPatterns,
  framesOfSelection, patternsOfFrames,
} from '../html/dnft-frame-editor.mjs';

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

// Four frames of five channels: frame f plays pattern 0x10 * f + channel
const CHANNELS = 5;
const LIST = Uint8Array.from({ length: 4 * CHANNELS }, (_, i) => 0x10 * Math.floor(i / CHANNELS) + i % CHANNELS);
const sel = (f0, c0, f1, c1) => normalizeFrames({ frame: f0, channel: c0 }, { frame: f1, channel: c1 });

check('selections are normalized, whatever way they were made', () => {
  assert.deepEqual(sel(3, 4, 1, 2), { start: { frame: 1, channel: 2 }, end: { frame: 3, channel: 4 } });
  assert.deepEqual(sel(1, 4, 3, 2), sel(3, 2, 1, 4));
  const s = sel(1, 1, 2, 3);
  assert.ok(inFrames(s, 1, 1) && inFrames(s, 2, 3) && !inFrames(s, 0, 1) && !inFrames(s, 1, 4) && !inFrames(null, 1, 1));
  assert.deepEqual(wholeFrames(2, 2, CHANNELS), sel(2, 0, 2, 4));
});

check('Copy keeps the patterns of the selection, and its first channel', () => {
  assert.deepEqual(copyFrames(LIST, CHANNELS, sel(2, 3, 1, 1)), {
    frames: 2, channels: 3, firstChannel: 1, patterns: Uint8Array.of(0x11, 0x12, 0x13, 0x21, 0x22, 0x23),
  });
  // without a selection: the cursor's frame in every channel (CFrameEditor::CopyFrame())
  assert.deepEqual([...copyFrames(LIST, CHANNELS, wholeFrames(3, 3, CHANNELS)).patterns], [0x30, 0x31, 0x32, 0x33, 0x34]);
});

check('Paste goes in at the cursor\'s frame, Paste & Overwrite only over the frames there are', () => {
  const clip = copyFrames(LIST, CHANNELS, sel(0, 1, 2, 2));
  // inserted: three new frames from frame 3, in the clipboard's channels
  assert.deepEqual(pasteSelection(clip, 3, 4, CHANNELS, false), sel(3, 1, 5, 2));
  // over frames 3 and on: only frame 3 is there (CFActionPasteOverwrite::SaveState())
  const over = pasteSelection(clip, 3, 4, CHANNELS, true);
  assert.deepEqual(over, sel(3, 1, 3, 2));
  assert.deepEqual([...cropClip(clip, over)], [0x01, 0x02]);
  // a module with fewer channels takes those it has
  const wide = copyFrames(LIST, CHANNELS, sel(0, 2, 1, 4));
  const narrow = pasteSelection(wide, 0, 4, 4, true);
  assert.deepEqual(narrow, sel(0, 2, 1, 3));
  assert.deepEqual([...cropClip(wide, narrow)], [0x02, 0x03, 0x12, 0x13]);
  assert.equal(pasteSelection(copyFrames(LIST, CHANNELS, sel(0, 4, 0, 4)), 0, 4, 3, false), null);
});

check('Delete takes the selected frames in every channel, but never the last one', () => {
  assert.deepEqual(deletion(sel(1, 2, 2, 2), 4), { frame: 1, count: 2 });
  // all of them: the last stays (CFActionDeleteSel::SaveState())
  assert.deepEqual(deletion(sel(0, 0, 3, 4), 4), { frame: 0, count: 3 });
  assert.equal(deletion(sel(0, 0, 0, 4), 1), null);
});

check('+ and - step every pattern of the selection, within 00 to FF', () => {
  const list = Uint8Array.of(0x00, 0x7F, 0xFF, 0x01, 0x02, 0x03);
  assert.deepEqual([...steppedPatterns(list, 3, sel(0, 0, 1, 2), 1)], [0x01, 0x80, 0xFF, 0x02, 0x03, 0x04]);
  assert.deepEqual([...steppedPatterns(list, 3, sel(0, 0, 0, 2), -1)], [0x00, 0x7E, 0xFE]);
});

check('Select > In Other Editor: frames and channels from the pattern, whole patterns from the frames', () => {
  const pattern = { start: { frame: 1, row: 5, channel: 3, column: 2 }, end: { frame: 2, row: 9, channel: 1, column: 0 } };
  assert.deepEqual(framesOfSelection(pattern), sel(1, 3, 2, 1));
  const columns = channel => [4, 7, 4, 4, 10][channel];
  assert.deepEqual(patternsOfFrames(sel(1, 1, 2, 4), 64, columns), {
    start: { frame: 1, row: 0, channel: 1, column: 0 },
    end: { frame: 2, row: 63, channel: 4, column: 9 },
  });
});

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall passed');

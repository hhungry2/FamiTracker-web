// Conventional NSF imports from the five bundled demos, then verified rebuilds.
// node web/test/nsf-reconstruct-demos.mjs
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import createDnFT from '../dist/dnft.mjs';
import createNsf from '../dist/dnft-nsf.mjs';
import { planNsfReconstruction, reconstructNsf } from '../html/dnft-nsf-reconstruct.mjs';
import { highlightAt, highlightState } from '../html/dnft-pattern-edit.mjs';

const RATE = 48000, FRAMES = 1200, WAVE_RATE = 44100;
const core = await createDnFT(), verificationCore = await createDnFT(), nsf = await createNsf();
const demoDir = new URL('../../demo/', import.meta.url);
const plain = value => JSON.parse(JSON.stringify(value, (_, v) => ArrayBuffer.isView(v) ? [...v] : v));
let failures = 0;

function inHeap(engine, bytes, fn) {
  const at = engine._malloc(bytes.length);
  try {
    engine.HEAPU8.set(bytes, at);
    return fn(at, bytes.length);
  } finally { engine._free(at); }
}
const open = bytes => inHeap(core, bytes, (at, size) => core.openSession(at, size, RATE));
function conventionalImport(source) {
  const bytes = source.exportNSF('nsf', 0, false).files[0].data;
  const analysis = new nsf.NsfAnalysis();
  try {
    assert.equal(inHeap(nsf, bytes, (at, size) => analysis.load(at, size)), '');
    assert.ok(analysis.start(0, -1, FRAMES));
    while (!analysis.done()) analysis.run(600);
    return inHeap(core, analysis.log(), (at, size) => core.importNsf(at, size, RATE, { loop: true }));
  } finally { analysis.delete(); }
}
function wave(session, track, seconds = 20) {
  session.beginWave(track, 0, seconds, 0, WAVE_RATE);
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const part = session.renderWave(44100);
      parts.push(part.samples);
      length += part.samples.length;
      if (part.done) break;
    }
  } finally { session.endWave(); }
  const result = new Int16Array(length);
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}

for (const name of readdirSync(demoDir).filter(name => name.endsWith('.dnm')).sort()) {
  let original, imported, reopened;
  try {
    original = open(readFileSync(new URL(name, demoDir)));
    imported = conventionalImport(original);
    const beforeTrack = plain(imported.track(0)), beforePatterns = plain(imported.patterns(0));
    const beforeInstruments = imported.instruments().map(({ index }) => plain(imported.instrument(index)));
    const bytes = imported.save(), sourceCopy = bytes.slice();
    const basic = planNsfReconstruction(imported, 0, { sequences: false });
    const enhanced = planNsfReconstruction(imported, 0, { sequences: true });
    const { data, reconstruction: result } = await reconstructNsf(core, verificationCore, bytes, 0, 'reconstructed', RATE);
    assert.deepEqual(bytes, sourceCopy, 'input bytes remain intact');
    assert.ok(data?.length > 0, 'a reduced result is returned');
    assert.equal(result.verified, true, 'the complete timeline and changed channels passed PCM comparison');
    assert.ok(result.rows <= basic.rows, 'safe enhancement does not increase the basic packed row count');
    assert.ok(result.removedRows > 0);
    reopened = open(data);
    assert.equal(reopened.info().tracks.length, 2);
    const rebuiltTrack = reopened.track(result.track);
    for (const frame of new Set([0, Math.floor(rebuiltTrack.frames / 2), rebuiltTrack.frames - 1]))
      for (const row of new Set([0, Math.floor(rebuiltTrack.rows / 2), rebuiltTrack.rows - 1])) {
        const highlight = highlightAt(rebuiltTrack.bookmarks, rebuiltTrack.highlight, frame, row);
        assert.deepEqual([highlight.first, highlight.second], [0, 0], 'persistent bookmark hides the beat grid after saving');
        assert.equal(highlightState(highlight, row), 0, `no reconstructed highlight at ${frame}:${row}`);
      }
    assert.deepEqual(plain(reopened.track(0)), beforeTrack, 'original imported track survives saving');
    assert.deepEqual(plain(reopened.patterns(0)), beforePatterns, 'original patterns survive saving');
    for (const inst of beforeInstruments)
      assert.deepEqual(plain(reopened.instrument(inst.index)), inst, 'original instruments survive saving');
    const before = wave(reopened, 0), after = wave(reopened, result.track);
    assert.equal(after.length, before.length);
    const mismatch = after.findIndex((value, at) => value !== before[at]);
    assert.equal(mismatch, -1, `saved result PCM mismatch at sample ${mismatch}`);
    console.log(`ok - ${name}`);
    console.log(`  ${JSON.stringify({ before: result.beforeRows, basic: basic.rows,
      enhanced: enhanced.rows, actual: result.rows, instruments: result.instruments,
      sequences: result.sequences, fallback: result.fallback, verified: result.verified,
      loopRow: imported.nsfReport().loopRow })}`);
  } catch (error) {
    ++failures;
    console.log(`not ok - ${name}\n  ${error instanceof WebAssembly.Exception
      ? core.getExceptionMessage(error).at(-1) : error.stack}`);
  } finally {
    reopened?.delete(); imported?.delete(); original?.delete();
  }
}

if (failures) process.exit(1);
console.log('all passed');

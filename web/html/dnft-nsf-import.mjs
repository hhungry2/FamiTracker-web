// All-songs NSF import. The caller supplies a separate editor engine: analysis,
// merging and saving never replace the module the user is editing until complete.
import { CELL, MAX_INSTRUMENTS, INSTRUMENT_CHIP, emptyPattern } from './dnft-song.mjs';

export const MAX_NSF_TRACKS = 64;
const json = value => JSON.stringify(value, (_, v) => ArrayBuffer.isView(v) ? [...v] : v);
const bytesKey = bytes => String.fromCharCode(...bytes);
const pause = () => new Promise(resolve => setTimeout(resolve));

export function inImportHeap(core, bytes, fn) {
  const at = core._malloc(bytes.length);
  try {
    core.HEAPU8.set(bytes, at);
    return fn(at, bytes.length);
  } finally {
    core._free(at);
  }
}

function errorMessage(core, error) {
  return error instanceof WebAssembly.Exception ? core.getExceptionMessage(error).at(-1) : error.message;
}

function resources(session) {
  const samples = new Map(session.samples().samples.map(({ index }) => {
    const sample = session.sample(index);
    return [index, { ...sample, key: bytesKey(sample.data) }];
  }));
  const instruments = session.instruments().map(({ index }) => {
    const instrument = session.instrument(index);
    // Numbered sequences are disabled in NSF imports. Do not accidentally merge
    // edited modules with enabled macros: this helper only accepts fresh imports.
    if (instrument.sequences?.some(s => s.enabled))
      throw new Error('NSF import unexpectedly contains instrument sequences');
    const { index: ignoredIndex, name: ignoredName, ...sound } = instrument;
    if (sound.sequences)
      sound.sequences = sound.sequences.map(() => false);
    if (sound.dpcm) {
      const { samples: keys, pitches, deltas } = sound.dpcm;
      sound.dpcm = [...keys].map((sample, key) => sample
        ? [samples.get(sample - 1).key, pitches[key], deltas[key]] : null);
    }
    return { instrument, key: json(sound) };
  });
  return { samples, instruments };
}

// Channel count (especially N163), region and tick rate affect the sound of every
// track in a module. Stop before merging a different configuration.
function configuration(session) {
  const info = session.info();
  return json([info.chips, info.namcoChannels, info.pal, info.engineSpeed,
    info.newVibrato, info.linearPitch, info.speedSplitPoint]);
}

function copyInstrument(target, instrument, samples) {
  const index = target.addInstrument(INSTRUMENT_CHIP[instrument.type], instrument.name);
  if (index < 0)
    throw new Error('no free instrument slot');
  instrument.sequences?.forEach((_, type) => target.setInstrumentSequence(index, type, false, 0));
  if (instrument.dpcm) {
    const { samples: keys, pitches, deltas } = instrument.dpcm;
    keys.forEach((sample, key) => target.setDpcmKey(index, key,
      sample ? samples.get(sample - 1) + 1 : 0, pitches[key] & 15, !!(pitches[key] & 128), deltas[key]));
  }
  if (instrument.fds) {
    const fds = instrument.fds;
    target.setFdsWave(index, fds.wave);
    target.setFdsModulation(index, fds.modulation);
    target.setFdsParams(index, fds.speed, fds.depth, fds.delay);
    fds.sequences.forEach((s, type) => target.setFdsSequence(index, type, s.items, s.loop, s.release, s.setting));
  }
  if (instrument.n163) {
    const n = instrument.n163;
    target.setN163(index, n.waveSize, n.wavePos, n.waveCount, n.waves);
  }
  if (instrument.vrc7)
    target.setVrc7(index, instrument.vrc7.patch, instrument.vrc7.registers);
  return index;
}

function copyTrack(target, source, instruments) {
  const track = target.addTrack();
  const data = source.track(0);
  target.setTrackTitle(track, data.title);
  target.setTempo(track, data.tempo);
  target.setSpeed(track, data.speed);
  target.setPatternLength(track, data.rows);
  target.setFrameCount(track, data.frames);
  target.setHighlight(track, ...data.highlight);
  const channels = data.effColumns.length;
  data.effColumns.forEach((columns, channel) => target.setEffColumns(track, channel, columns));
  for (let frame = 0; frame < data.frames; ++frame)
    for (let channel = 0; channel < channels; ++channel)
      target.setFramePattern(track, frame, channel, data.frameList[frame * channels + channel]);
  // Copy only populated patterns. ImportTrack materializes all 256 patterns of
  // every channel, which makes large batches needlessly expensive.
  for (const { channel, pattern, data } of source.patterns(0)) {
    const cells = data.slice();
    for (let at = 3; at < cells.length; at += CELL)
      if (cells[at] < MAX_INSTRUMENTS) {
        if (!instruments.has(cells[at]))
          throw new Error('NSF pattern refers to a missing instrument');
        cells[at] = instruments.get(cells[at]);
      }
    target.setCells(track, channel, pattern, 0, cells);
  }
  return track;
}

// Make one module, checking capacity before copying each song.
export class NsfModuleImport {
  constructor(core, sampleRate, info) {
    this.core = core;
    this.sampleRate = sampleRate;
    this.info = info;
    this.session = null;
    this.songs = [];
    this.limit = null;
  }

  append(source, song, report) {
    if (this.limit)
      return false;
    if (this.songs.length >= MAX_NSF_TRACKS) {
      this.limit = 'trackLimit';
      return false;
    }
    const resource = resources(source);
    const config = configuration(source);
    const extraSamples = new Map([...resource.samples.values()]
      .filter(s => !this.samples?.has(s.key)).map(s => [s.key, s]));
    const extraInstruments = new Set(resource.instruments.filter(i => !this.instruments?.has(i.key)).map(i => i.key));
    const sampleInfo = this.session?.samples();
    if (this.session) {
      this.limit = [
        [config !== this.config, 'configurationLimit'],
        [this.session.instruments().length + extraInstruments.size > MAX_INSTRUMENTS, 'instrumentLimit'],
        [sampleInfo.used + [...extraSamples.values()].reduce((sum, s) => sum + s.data.length, 0) > sampleInfo.capacity, 'sampleSpaceLimit'],
        [sampleInfo.samples.length + extraSamples.size > sampleInfo.slots, 'sampleLimit'],
      ].find(([reached]) => reached)?.[1] ?? null;
      if (this.limit)
        return false;
    }
    let track = 0;
    if (!this.session) {
      this.session = inImportHeap(this.core, source.save(), (at, size) => this.core.openSession(at, size, this.sampleRate));
      this.config = config;
      this.samples = new Map([...resource.samples.values()].map(s => [s.key, s.index]));
      this.instruments = new Map(resource.instruments.map(i => [i.key, i.instrument.index]));
    } else {
      const sampleMap = new Map();
      for (const [index, sample] of resource.samples) {
        if (!this.samples.has(sample.key))
          this.samples.set(sample.key, this.session.setSample(-1, sample.name, sample.data));
        sampleMap.set(index, this.samples.get(sample.key));
      }
      const instrumentMap = new Map();
      for (const { instrument, key } of resource.instruments) {
        if (!this.instruments.has(key))
          this.instruments.set(key, copyInstrument(this.session, instrument, sampleMap));
        instrumentMap.set(instrument.index, this.instruments.get(key));
      }
      track = copyTrack(this.session, source, instrumentMap);
    }
    this.songs.push({ song, track, title: source.track(0).title, report });
    return true;
  }

  finish() {
    if (!this.session)
      return;
    const origin = `Imported from an NSF: ${this.info.title}${this.info.artist ? ' by ' + this.info.artist : ''}`;
    const songs = this.songs.map(s => `Track ${s.track + 1}: Song ${s.song + 1} of ${this.info.songs}` +
      ` (${s.title}), ${s.report.rows} rows at ${s.report.rate.toFixed(2)} Hz, loop row ${s.report.loopRow}` +
      (s.report.warnings.length ? `; ${s.report.warnings.join(', ')}` : ''));
    const limit = this.limit ?? (this.info.songs > MAX_NSF_TRACKS ? 'trackLimit' : null);
    const count = `Imported ${this.songs.length} of ${this.info.songs} songs${limit ? `; ${limit}` : ''}.`;
    this.session.setComment([origin, 'All-songs import. A row is a frame.', count, ...songs].join('\r\n'), false);
    return { data: this.session.save(), songs: this.songs, totalSongs: this.info.songs, limit };
  }

  delete() {
    this.session?.delete();
    this.session = null;
  }
}

// Keep silent song numbers in the track list, with a visible warning. The log
// header gives the same playback configuration the C++ importer would use.
function silentSong(core, log, info, song, sampleRate, options) {
  const session = core.createSession(sampleRate);
  try {
    const pal = log[10] === 1;
    const period = new DataView(log.buffer, log.byteOffset, log.byteLength).getUint32(16, true);
    const rate = period ? 1e6 / period : pal ? 50 : 60;
    const custom = Math.abs(rate - (pal ? 50 : 60)) >= 1;
    session.setExpansion(log[11], log[20]);
    session.setMachine(pal);
    session.setEngineSpeed(custom ? Math.max(16, Math.min(400, Math.round(rate))) : 0);
    session.setTitle(info.title);
    session.setArtist(info.artist);
    session.setCopyright(info.copyright);
    session.setTrackTitle(0, info.tracks[song]?.title || `Song ${song + 1}`);
    session.setTempo(0, custom ? 0 : pal ? 125 : 150);
    session.setSpeed(0, 1);
    session.setPatternLength(0, options.patternLength ?? 64);
    for (const { index } of session.instruments())
      session.removeInstrument(index);
    const cells = emptyPattern(1);
    cells[4] = 4; // C00
    session.setCells(0, 0, 0, 0, cells);
    return { session, report: { rows: 1, loopRow: -1, stops: true, trimmed: 0, rate, warnings: ['silentSong'] } };
  } catch (error) {
    session.delete();
    throw error;
  }
}

export async function importAllNsfSongs(core, nsf, bytes, options, sampleRate, {
  onProgress = () => {}, isCancelled = () => false, yieldControl = pause,
} = {}) {
  const checkCancelled = () => { if (isCancelled()) throw new Error('cancelled'); };
  const info = inImportHeap(nsf, bytes, (at, size) => nsf.nsfInfo(at, size));
  if (info.error)
    throw new Error(info.error);
  const module = new NsfModuleImport(core, sampleRate, info);
  const count = Math.min(info.songs, MAX_NSF_TRACKS);
  let analysis = null;
  let song = 0;
  try {
    checkCancelled();
    const region = options.region ?? -1;
    const pal = region === 1 || (region < 0 && info.preferred !== 0);
    const frames = Math.max(1, Math.round((options.seconds ?? 300) * 1e6 /
      ((pal ? info.periodPal : info.periodNtsc) || 16639)));
    for (; song < count; ++song) {
      checkCancelled();
      // An analyzer can start only once. Give each subsong a fresh CPU/chip state.
      analysis = new nsf.NsfAnalysis();
      const error = inImportHeap(nsf, bytes, (at, size) => analysis.load(at, size));
      if (error)
        throw new Error(error);
      if (!analysis.start(song, region, frames))
        throw new Error('could not start the song');
      while (!analysis.done()) {
        const started = performance.now();
        do { analysis.run(60); } while (!analysis.done() && performance.now() - started < 50);
        onProgress((song + Math.min(1, analysis.frames() / frames)) / count);
        await yieldControl();
        checkCancelled();
      }
      const log = analysis.log();
      analysis.delete();
      analysis = null;
      let source;
      let report;
      try {
        try {
          source = inImportHeap(core, log, (at, size) => core.importNsf(at, size, sampleRate, options));
          report = source.nsfReport();
        } catch (error) {
          if (errorMessage(core, error) !== 'the NSF made no sound')
            throw error;
          ({ session: source, report } = silentSong(core, log, info, song, sampleRate, options));
        }
        if (!module.append(source, song, report))
          break;
      } finally {
        source?.delete();
      }
      onProgress((song + 1) / count);
      await yieldControl();
      checkCancelled();
    }
    const result = module.finish();
    onProgress(1);
    await yieldControl();
    checkCancelled();
    return result;
  } catch (error) {
    const message = errorMessage(core, error);
    throw new Error(message === 'cancelled' ? message : `Song ${Math.min(song + 1, info.songs)}: ${message}`);
  } finally {
    analysis?.delete();
    module.delete();
  }
}

FamiTracker-web
===============

The playback engine of Dn-FamiTracker compiled to WebAssembly: the tracker's own module
loader, sound driver and chip emulation, taken unchanged from `Source/`, with a small
layer that stands in for MFC and Windows. It plays `.dnm`, `.0cc` and `.ftm` modules,
rendering them the way the desktop tracker's WAV export does.

The javascript interface follows the one of the [ZXTune web build](https://github.com/hhungry2/zxtune-web/tree/web/apps/zxtune-web),
so a page can drive either engine the same way.

What is tested and what is not is listed in the [top-level README](../README.md).

Building
--------

Needs [emsdk](https://emscripten.org/docs/getting_started/downloads.html) (tested with
6.0.9), GNU make and python3.

```sh
source <emsdk>/emsdk_env.sh
make -C web -j$(nproc)          # dist/dnft.mjs, dist/dnft.wasm
make -C web site                # plus the demo page and the demo modules in dist/
python3 -m http.server -d web/dist
```

`make debug=1` builds without optimizations and with assertions.

Javascript interface
--------------------

```js
import createDnFT from './dnft.mjs';

const dnft = await createDnFT();

// the module has to be in the wasm heap first
const at = dnft._malloc(bytes.length);
dnft.HEAPU8.set(bytes, at);
const track = dnft.load(at, bytes.length, '');   // '#2' selects the second track
dnft._free(at);

track.getDuration();            // ms, one pass up to where the track loops or halts
track.getLoopDuration();        // ms of the looped part, 0 when the track halts
track.getProperty('Title', ''); // also Author, Copyright, Comment, Type (DNM/FTM),
                                // Program, Computer, Chips, Channels, FrameRate,
                                // Tracks, Track, TrackTitle
track.getChannels();            // [{name, shortName, chip}] in pattern order

const player = track.createPlayer(48000);
track.delete();

const buffer = dnft._malloc(4096 * 4);
player.render(buffer, 4096);    // 4096 frames of interleaved int16 stereo;
                                // false once the track is over
player.getPosition();           // ms
player.seek(30000);
player.state();                 // where the engine is: {track, position (frame),
                                //  pattern (of the first channel), line (row),
                                //  tempo (ticks per row, FamiTracker's speed),
                                //  ftTempo (FamiTracker's tempo), channels, timeMs}
player.setIntProperty('zxtune.core.channels_mask', 0b101);  // bit n mutes channel n
player.setIntProperty('zxtune.sound.loop', 1);               // play past the loop point
player.delete();

dnft.detect(at, size);          // {tracks: [{subpath, type, title, author, program,
                                //  durationMs}], pictures: []}, empty when not a module
```

`load` throws on content it cannot read; `dnft.getExceptionMessage(e)` gives the
loader's message.

One player plays at a time: the core is built around a single sound generator, so
creating a player silences the previous one.

For a page, `html/` has the three pieces the ZXTune site runs its engine with,
rewritten for this one: a worker that owns the wasm module (`dnft-engine.mjs`), an audio
worklet that plays what it renders (`dnft-processor.js`) and the class that wires them
(`dnft-player.mjs`). They exchange the same messages as ZXTune's, so the worklets are
interchangeable. `index.html` is a demo page built on them.

### Editing sessions

A session is a module open for editing, with the sound generator playing it. Unlike a
player it renders without end, as the desktop tracker's audio runs while it is open: the
song while it plays, the notes played by hand at any time.

```js
const session = dnft.createSession(48000);   // the desktop's new module: 2A03, one
                                             // instrument, one frame of 64 rows
// or dnft.openSession(at, size, 48000) for a .dnm, .0cc or .ftm file in the heap

session.render(buffer, 1024);        // interleaved int16 stereo, never ends
session.play(track, dnft.PLAY_CURSOR, frame, row);  // or PLAY_SONG, PLAY_FRAME, PLAY_PATTERN
session.stop();
session.takeRowEvents();             // [{at, frame, row}]: the rows read since the last
                                     //  call, `at` in output frames; frame -1 where it stopped
session.state();                     // {playing, track, frame, row, speed, tempo, timeMs}
session.noteOn(channel, note, octave, instrument, volume);  // note 1-12, volume 16: none
session.noteOff(channel, release);
session.setMutedChannels(mask);
const bytes = session.save();        // Uint8Array of a .dnm file
```

The document is read and changed through the tracker's own functions:

| | |
| --- | --- |
| module | `info()` (title, chips, channels, tracks...), `setTitle`, `setArtist`, `setCopyright`, `setComment`, `setExpansion(chips, n163Channels)`, `setMachine(pal)`, `setEngineSpeed`, `setVibratoStyle`, `setLinearPitch` |
| tracks | `track(t)` (frames, rows, speed, tempo, highlight, effColumns, frameList), `addTrack`, `removeTrack`, `setTrackTitle`, `setPatternLength`, `setFrameCount`, `setSpeed`, `setTempo`, `setHighlight`, `setEffColumns` |
| patterns | `pattern(t, channel, pattern)`, `patterns(t)` (every one with something in it), `setCells(t, channel, pattern, row, cells)` |
| frames | `setFramePattern`, `setFrameList`, `insertFrame`, `removeFrame`, `duplicateFrame`, `cloneFrame`, `moveFrame`, `freePattern` |
| instruments | `instruments()`, `instrument(i)`, `addInstrument(chip, name)`, `removeInstrument`, `cloneInstrument`, `deepCloneInstrument`, `setInstrumentName`, `setInstrumentSequence(i, type, enabled, index)`, `sequence(instType, type, index)`, `setSequence(...)`, `freeSequence` |

A pattern cell is 12 bytes, the fields of the tracker's `stChanNote`: note, octave, volume,
instrument, four effect numbers, four effect parameters. `dnft.effects()` gives the
effect letters, the parameter an effect starts with, and which letter means which effect
on each chip. Indices are checked, and what is out of range throws.

As with players, one session drives the sound generator at a time.

### The editor

`editor.html` is a tracker on these sessions, built from:

- `dnft-session-engine.mjs`: the worker that owns the session and renders for the worklet
  in chunks of 1024 frames, with 60 ms queued, so that notes played by hand are heard
  soon; `dnft-session.mjs`: its page side, which also follows which row the audio has
  reached (from the worklet's position reports and `getOutputTimestamp()`)
- `dnft-editor.mjs`: the editor; `dnft-pattern-view.mjs`: the pattern grid (a canvas);
  `dnft-song.mjs`: the page's copy of the module and the undo history;
  `dnft-instrument-editor.mjs`: the sequence editor; `dnft-editor-strings.mjs`: its texts
  (Japanese and English); `dnft-editor.css`: its look, in custom properties a page can
  redefine

```js
import { DnFTEditor } from './dnft-editor.mjs';
const editor = await DnFTEditor.create(element, { base: '.', lang: 'ja' });
```

Keys follow the desktop's defaults: the Z and Q rows of the keyboard enter notes (by the
key's place, whatever the layout), 1 a note cut, \ a release, hex digits the other
columns; Space toggles editing, Enter plays the frame or stops, F5/F6/F7/F8 play the song,
loop the pattern, play from the cursor, stop; Delete, Insert and Backspace clear, insert
and pull up; Shift with the arrows selects, Ctrl+C/X/V copy, cut and paste, Ctrl+Z/Y undo
and redo, Ctrl+Up/Down transpose. Edits of patterns, frames and song settings can be
undone; instruments, as on the desktop, cannot. The module is kept in the browser's
localStorage as it changes and comes back when the page is opened again.

How it works
------------

The core (`Source/`) is an MFC application. The build compiles the part of it that
loads and plays modules (see `CORE_SOURCES` in the Makefile) as it is, against:

- `compat/`: the MFC and Win32 declarations the core uses. `CString` and `CFile` are
  real implementations (files live in memory, and so do the temporary file and the
  move of the desktop's save); window classes are empty shells.
- `src/portable/SoundGenUI.h`: stand-ins for the view, visualizer, main frame, audio
  output and MIDI classes `SoundGen.cpp` talks to.
- `src/app.cpp`, `src/standins.cpp`: `theApp` and the other definitions the core links
  against whose desktop versions live in user interface code.
- `src/soundgen_host.cpp`: runs `CSoundGen` without its audio thread. The host makes the
  calls that thread would make (start-up, messages, one `OnIdle()` per engine tick) and
  takes the audio the way the WAV export does.
- `src/engine.cpp`, `src/bindings.cpp`: modules, players and their javascript interface.
- `src/session.cpp`, `src/session_bindings.cpp`: editing sessions and theirs. A session
  keeps the host rendering with the player stopped (`CSoundGenHost::BeginStream()`),
  which is how the desktop's audio thread runs, and plays notes by hand the way the
  desktop's note preview does.

Every start of playback gets a new APU, so a track sounds the same however often it is
played: some chip state survives a reset (the N163 keeps its channel registers in its
wave RAM), which on the desktop is hidden by the five silent ticks the export starts
with.

### Changes to Source/

Small and meant to be harmless for the desktop build:

| File | Change | Why |
| --- | --- | --- |
| `FamiTracker.h`, `SoundGen.h`, `TrackerChannel.h` | `enum ... : int` on `play_mode_t` and `note_prio_t` | forward-declared enums need a fixed type outside MSVC |
| `ColorScheme.h` | named the two unnamed structs | static members are not allowed in unnamed classes |
| `PatternNote.cpp`, `FamiTrackerDoc.cpp` | `.GetString()` on a `CString` passed to a printf-style function | only MSVC can pass a `CString` through varargs |
| `APU/Mixer.h` | `Blip_Buffer.h` spelled as the file is named | case-sensitive file systems |
| `SoundGen.h` | `friend class CSoundGenHost` under `DNFT_PORTABLE` | the host drives the private audio thread functions |
| `SoundGen.cpp` | user interface includes replaced under `DNFT_PORTABLE` | see `src/portable/SoundGenUI.h` |

Testing
-------

```sh
node web/test/smoke.mjs                          # interface checks on demo/
node web/test/session.mjs                        # editing sessions, saving demo/ unchanged
node web/test/render.mjs <module> [out.wav]      # render and report
node web/test/compare.mjs <module> <export.wav>  # against the desktop WAV export
```

For `compare.mjs`, export with File > Create WAV..., "Play the song 1 time(s)", with
default sound and mixer settings. Since both render through the same code path, the
output is expected to match sample for sample; no export has been compared yet.

Windows and the drives WSL mounts ignore the case of file names, a Linux checkout does
not: `python3 web/tools/check_include_case.py` finds includes that only build on the
former.

License
-------

Dn-FamiTracker, and this port with it, is free software under the GNU General Public
License v3 or later (see `../LICENSE.md` for the libraries it includes). Whoever serves
the wasm build to browsers distributes it and has to offer its source.

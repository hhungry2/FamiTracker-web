FamiTracker-web
===============

The playback engine of Dn-FamiTracker compiled to WebAssembly: the tracker's own module
loader, sound driver and chip emulation, taken unchanged from `Source/`, with a small
layer that stands in for MFC and Windows. It plays `.dnm`, `.0cc` and `.ftm` modules,
rendering them the way the desktop tracker's WAV export does, and edits them, with the
desktop's exports (WAV, NSF and the other kinds of its NSF export, text, JSON, rows) and
imports (text, the tracks and instruments of another module).

The javascript interface follows the one of the [ZXTune web build](https://github.com/hhungry2/zxtune-web/tree/web/apps/zxtune-web),
so a page can drive either engine the same way.

What is tested and what is not is listed in the [top-level README](../README.md).

Building
--------

Needs [emsdk](https://emscripten.org/docs/getting_started/downloads.html) (tested with
6.0.9), GNU make, python3, and `ca65` and `ld65` from [cc65](https://cc65.github.io) for
the NSF drivers the NSF export puts around the music. The build assembles them from
`Source/drivers/asm` with the desktop build's script, as `Source/drivers/build.cmd` does.

```sh
source <emsdk>/emsdk_env.sh
make -C web -j$(nproc)          # dist/dnft.mjs, dist/dnft.wasm
make -C web site                # plus the demo page and the demo modules in dist/
python3 -m http.server -d web/dist
```

`make debug=1` builds without optimizations and with assertions. `CA65` and `LD65` name
other commands for cc65's tools. Where there is no C compiler besides emsdk's, cc65 can
be built with emcc to run under node (the desktop build's CI uses cc65 at commit
`2f4e2a34c32c679e4325652e461acce7f615a22e`):

```sh
web/tools/build_cc65.sh ~/cc65  # ~/cc65: cc65's source
make -C web CA65="node $HOME/cc65/bin/ca65" LD65="node $HOME/cc65/bin/ld65"
```

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
| module | `info()` (title, chips, channels, tracks, comment, engineSpeed...), `setTitle`, `setArtist`, `setCopyright`, `setComment(text, showOnOpen)`, `setExpansion(chips, n163Channels)`, `setMachine(pal)`, `setEngineSpeed(hz)` (0: the machine's), `setVibratoStyle(newStyle)`, `setLinearPitch(enable)` |
| tracks | `track(t)` (frames, rows, speed, tempo, highlight, effColumns, frameList), `addTrack`, `removeTrack`, `setTrackTitle`, `setPatternLength`, `setFrameCount`, `setSpeed`, `setTempo`, `setHighlight`, `setEffColumns` |
| patterns | `pattern(t, channel, pattern)`, `patterns(t)` (every one with something in it), `setCells(t, channel, pattern, row, cells)` |
| frames | `setFramePattern`, `setFrameList`, `insertFrame`, `removeFrame`, `duplicateFrame`, `cloneFrame`, `moveFrame`, `freePattern` |
| instruments | `instruments()`, `instrument(i)`, `addInstrument(chip, name)`, `removeInstrument`, `cloneInstrument`, `deepCloneInstrument`, `setInstrumentName`, `setInstrumentSequence(i, type, enabled, index)`, `sequence(instType, type, index)`, `setSequence(...)`, `freeSequence` |

A pattern cell is 12 bytes, the fields of the tracker's `stChanNote`: note, octave, volume,
instrument, four effect numbers, four effect parameters. `dnft.effects()` gives the
effect letters, the parameter an effect starts with, and which letter means which effect
on each chip. Indices are checked, and what is out of range throws.

A comment comes with `\n` line breaks and is kept with the CR LF of the desktop's comment
box. Changing the machine, the engine speed, the vibrato style or the pitch mode resets
the sound generator, which stops playback.

Texts (the title, the comment, the names of tracks and instruments) are kept the way the
desktop tracker keeps them: as bytes of the ANSI code page of its Windows, which for the
modules around is Windows-1252 or code page 932 (Shift_JIS). Players and sessions read
UTF-8 as it is, and otherwise the reading of the two that looks more like text in its
language. Sessions write a text in Windows-1252, else in code page 932, when it fits and
reads back the same, so the desktop shows it; in UTF-8 otherwise. `dnft.decodeText(bytes)`
and `dnft.encodeText(text, maxBytes)` read and write other bytes that way. The JSON export
has the texts in UTF-8.

The desktop's File menu besides saving, run by the tracker's own exporters and importers:

```js
session.exportText();                // Uint8Array: File > Export Text
session.exportJSON();                // File > Export JSON
session.exportRows();                // File > Export Rows: a CSV table of the cells in use
session.exportNSF('nsf', 0, false);  // File > Create NSF: {files: [{name, data}], log,
                                     //  messages}, files empty when it failed. The kind:
                                     //  'nsf', 'nsfe', 'nsf2', 'nes', 'bin', 'prg', 'asm';
                                     //  0 NTSC, 1 PAL, 2 both; the extra data of BIN and ASM
session.beginWave(track, passes, seconds, muted, 44100);  // File > Create WAV: `passes`
                                     //  times through the song, or `seconds` when it is 0
session.renderWave(44100);           // about that many samples more: {samples (mono
                                     //  Int16Array), done, progress (0 to 1)}
session.endWave();                   // after the export, or to abandon it
session.beginImport(at, size);       // module properties > Import file: a module in the
                                     //  heap, {tracks: [title], instruments, grooves, chips...}
session.finishImport(tracks, instruments, grooves, detune);  // {imported, messages}
                                     //  (or cancelImport()); tracks: a flag for each
const imported = dnft.importText(at, size, 48000);  // File > Import Text: a new session
imported.takeWarning();              // what the importer said about a file it still read
```

The wave export renders as the desktop's does: five silent ticks, the track, five more
ticks, mono 16-bit, with the channels of `muted` silent; a song that halts before the
time asked ends it. Meanwhile the session's own output is silent. The other exports run
on a copy of the module, the one a save writes read back (saving clears the modified
flag), so the one being edited stays as it is: the NSF compiler and the JSON export fill
in every pattern they read. The NSF export takes the period and vibrato tables from the
sound generator, so its session has to be the one playing. The module import gives both
modules the expansion chips of either, as on the desktop, and stops playback.

As with players, one session drives the sound generator at a time.

### The editor

`editor.html` is a tracker on these sessions, built from:

- `dnft-session-engine.mjs`: the worker that owns the session and renders for the worklet
  in chunks of 1024 frames, with 60 ms queued, so that notes played by hand are heard
  soon; `dnft-session.mjs`: its page side, which also follows which row the audio has
  reached (from the worklet's position reports and `getOutputTimestamp()`)
- `dnft-editor.mjs`: the editor; `dnft-pattern-view.mjs`: the pattern grid (a canvas);
  `dnft-song.mjs`: the page's copy of the module and the undo history;
  `dnft-instrument-editor.mjs`: the sequence editor; `dnft-files.mjs`: the Import and
  Export menus and their dialogs; `dnft-zip.mjs`: zip files, for exports that write
  several files; `dnft-editor-strings.mjs`: its texts (Japanese and English);
  `dnft-editor.css`: its look, in custom properties a page can redefine

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

The Import and Export menus next to Save hold what the desktop's File menu does besides
New, Open and Save, with the options of its dialogs: Create WAV (with the sample rate,
the progress and a cancel; the worker renders it in slices so the page and the audio
keep going), the NSF export dialog, Export Text, JSON and Rows, Import Text (also by
dropping a `.txt` file), and the import of another module's tracks and instruments from
the module properties. What they write is downloaded; several files come in a zip file.

How it works
------------

The core (`Source/`) is an MFC application. The build compiles the part of it that
loads, plays and exports modules (see `CORE_SOURCES` in the Makefile) as it is, against:

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
  desktop's note preview does. Its wave export is the desktop's
  (`CSoundGenHost::BeginExport()`), the text and module imports its document's.
- `src/export.cpp`: the other exports, by the desktop's `CCompiler`, `CTextExport` and
  `CJsonExport` on a copy of the module; the rows export writes the lines of
  `CTextExport::ExportRows()` without reading the empty patterns, which fills them in,
  and the JSON export writes the texts as UTF-8 (the desktop's fails on texts that are
  not UTF-8 already).
- `src/text_encoding.cpp`: the texts of modules, in the code pages of the desktop's
  Windows or UTF-8. `src/cp932_table.inc`, code page 932, is made by
  `tools/gen_cp932.mjs` from the Encoding Standard's Shift_JIS decoder (node's or a
  browser's `TextDecoder`).
- The NSF drivers `Source/Driver.h` includes are generated by the build (`CA65`, `LD65`).

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
| `Chunk.h`, `Compiler.h` | `enum chunk_type_t : int` | forward-declared enums need a fixed type outside MSVC |
| `Compiler.cpp`, `TextExporter.cpp` | a `CString` returned by value kept in a variable, not pointed into | MFC's `CString` shares its text with the one it copies, which keeps it alive; other strings do not |
| `TextExporter.h`, `TextExporter.cpp`, `ChunkRenderText.cpp` | `const` references to temporaries; `.GetString()` where a `CString` becomes a `std::string` | only MSVC binds temporaries to non-const references and makes that conversion |
| `ChunkRenderText.cpp` | the NSF stub includes the exported file only when there is one | the BIN export with extra data writes the stub without one, and crashed (the desktop too) |
| `TextExporter.cpp` | the text import reads a bookmark's highlight of -1 | the text export writes -1 for a bookmark that keeps the highlight, which the import refused (the desktop too) |

Testing
-------

```sh
node web/test/smoke.mjs                          # interface checks on demo/
node web/test/session.mjs                        # editing sessions, saving demo/ unchanged
node web/test/export.mjs                         # the exports and imports of sessions
node web/test/text.mjs                           # module texts: code pages and UTF-8
node web/test/render.mjs <module> [out.wav]      # render and report
node web/test/compare.mjs <module> <export.wav>  # against the desktop WAV export
```

For `compare.mjs`, export with File > Create WAV..., "Play the song 1 time(s)", with
default sound and mixer settings. Since both render through the same code path, the
output is expected to match sample for sample; no export has been compared yet. The
web build's own wave export (`beginWave()`, the editor's Create WAV) has the desktop's
silent ticks too, so its files can be compared with the desktop's as they are.

Windows and the drives WSL mounts ignore the case of file names, a Linux checkout does
not: `python3 web/tools/check_include_case.py` finds includes that only build on the
former.

License
-------

Dn-FamiTracker, and this port with it, is free software under the GNU General Public
License v3 or later (see `../LICENSE.md` for the libraries it includes). Whoever serves
the wasm build to browsers distributes it and has to offer its source.

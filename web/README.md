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
player.seek(30000);             // plays up to there without the audio: from where the
                                //  player is when that is before, else from the start
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
session.state();                     // {playing, track, frame, row, speed, tempo, timeMs, bpm}
session.noteOn(channel, note, octave, instrument, volume);  // note 1-12, volume 16: none
session.noteOff(channel, release);
session.setMutedChannels(mask);
session.playRow(track, frame, row);  // the row's notes with their effects (Tracker > Play Row)
session.killSound();                 // stops the player and silences the chips (Kill Sound)
session.takeLevelEvents();           // [{at, levels}]: the channels' volume meters, 0-15
const bytes = session.save();        // Uint8Array of a .dnm file
```

The document is read and changed through the tracker's own functions:

| | |
| --- | --- |
| module | `info()` (title, chips, channels, tracks, comment, engineSpeed...), `setTitle`, `setArtist`, `setCopyright`, `setComment(text, showOnOpen)`, `setExpansion(chips, n163Channels)`, `setMachine(pal)`, `setEngineSpeed(hz)` (0: the machine's), `setVibratoStyle(newStyle)`, `setLinearPitch(enable)`, `detune()`, `setDetune(offsets, semitone, cent)` (Detune Settings), `grooves()`, `setGrooves(list)` (Groove Settings), `mixing()`, `setMixing(levels, hardwareMixing)` (the device mix offsets), `opll()`, `setOpll(external, patches, names)` (the VRC7's patches), `removeUnusedInstruments`, `removeUnusedPatterns`, `removeUnusedSamples` (Cleanup) |
| tracks | `track(t)` (frames, rows, speed, tempo, highlight, effColumns, frameList, bookmarks), `addTrack`, `removeTrack`, `setTrackTitle`, `setPatternLength`, `setFrameCount`, `setSpeed`, `setTempo`, `setHighlight`, `setEffColumns`, `setGrooveMode(t, groove)`, `moveTrack(t, up)`, `songLength(t)` (intro and loop, in seconds), `bookmarks(t)` and `setBookmarks(t, list)` (frame, row, name, highlight, persist), `swapChannels(t, a, b)` (Swap Channels) |
| patterns | `pattern(t, channel, pattern)`, `patterns(t)` (every one with something in it), `setCells(t, channel, pattern, row, cells)`, `clearPatterns(t)`, `populateUniquePatterns(t)`, `transposeSong(t, all, semitones, excluded)` (Transpose Song: returns what changed) and `setNotes(changes, after)` (to undo and redo it) |
| frames | `setFramePattern`, `setFrameList`, `insertFrame`, `removeFrame`, `duplicateFrame`, `cloneFrame`, `moveFrame`, `freePattern`; for the frame editor's clipboard, `insertFrames(t, frame, count)`, `deleteFrames(t, frame, count)` (never the last frame), `setFramePatterns(t, frame, channel, channels, list)` (a block of the frame list) and `clonePatterns(t, frame0, frame1, channel0, channel1)` (each pattern the block plays, to a free number) |
| instruments | `instruments()`, `instrument(i)` (also the DPCM keys, the FDS's wave, modulation and sequences, the N163's waves, the VRC7's patch and registers, by the kind), `addInstrument(chip, name)`, `removeInstrument`, `cloneInstrument`, `deepCloneInstrument`, `setInstrumentName`, `setInstrumentSequence(i, type, enabled, index)`, `sequence(instType, type, index)`, `setSequence(...)`, `freeSequence`, `nextFreeSequence(i, type)` ("Select next empty slot"), `cloneSequence(i, type)` ("Clone sequence"), `saveInstrument(i)` and `loadInstrument(bytes)` (.fti files) |
| instrument settings | `setDpcmKey(i, key, sample, pitch, loop, delta)`, `setFdsWave`, `setFdsModulation`, `setFdsParams(i, speed, depth, delay)`, `setFdsSequence(i, type, items, loop, release, setting)`, `setN163(i, size, pos, count, waves)`, `setN163Wave(i, wave, samples)`, `setVrc7(i, patch, registers)`, `vrc7Patches()` |
| DPCM samples | `samples()`, `sample(slot)`, `setSample(slot or -1, name, bytes)`, `removeSample(slot)`, `previewSample(bytes, offset, pitch, deltaStart)`, `stopPreview()` |
| playing and showing | `takeLevelEvents()`, `setMeterDecayRate(0 slow, 1 fast)`, `meterDecayRate()`, `setAverageBpm(on)` (whether `state().bpm` is the average of the song so far), `registers(chip, addresses)` (a register's value and age, two bytes each), `channelFrequencies(chip, count)`, `fdsModCounter()` |
| recording | `recorder()` (the channel and the settings), `setRecordChannel(channel)` (Record To Instrument: "unsupported", "instruments", "sequences" or ""), `setRecorderSettings(interval, count, reset)`, `takeRecordedInstruments()` (the slots made since the last call) |
| sound | `soundSettings()` and `setSoundSettings(values)`: the Configuration's Sound, Mixer and Emulation pages (bass and treble filters, damping, volume, the FDS and N163 lowpass, the N163's multiplexing, the VRC7's set of patches, the level of each device in tenths of a dB). They are the engine's, for every module, until changed; changing them stops playback |

The meters' levels come with the tick that changed one, at the output frame its audio begins at
(the editor draws a level when the audio has reached it); the register view asks for the registers
of the module's chips about twenty times a second. A recording (Record To Instrument) is the
desktop's `CInstrumentRecorder` on the chip registers: while a channel is armed, a playback reads
its registers every tick and makes instruments of `interval` ticks each, `count` of them; it ends
with the playback or when they are made.

A pattern cell is 12 bytes, the fields of the tracker's `stChanNote`: note, octave, volume,
instrument, four effect numbers, four effect parameters. `dnft.effects()` gives the
effect letters, the parameter an effect starts with, and which letter means which effect
on each chip. Indices are checked, and what is out of range throws.

A track's bookmarks are kept in its order (the Bookmark Manager's): each has a frame, a
row, a name and the row highlight it sets from its row on, `[beat, bar]` (-1: the track's),
in its frame or, with `persist`, in the frames after too. They move with the frames as the
desktop moves them. The desktop leaves bookmarks past the end of a track that gets fewer
rows, or loses its frames to Clear Patterns, and then cannot open the file it saves;
sessions drop those, and `setBookmarks()` ignores them.

A comment comes with `\n` line breaks and is kept with the CR LF of the desktop's comment
box. Changing the machine, the engine speed, the vibrato style, the pitch mode, the
device mix offsets or the VRC7's patches resets the sound generator, which stops
playback; the detune tables and the grooves change what plays as it goes.

The detune tables come as one `Int16Array` of 6 × 96 period offsets, by chip (NTSC and
PAL 2A03, VRC6 sawtooth, VRC7, FDS, N163) and note (octave × 12 + note); higher values
sound higher, and the VRC7's first octave counts for all. Grooves come as 32 entries, the
ticks of each row (`Uint8Array`) or null; a module has room for 255 bytes of them (the
entries, and two more a groove), and a track whose groove goes gets speed 6 back, as on
the desktop. The mix offsets are tenths of a dB, -12 to 12 dB, for the 2A03's pulse
channels, its other channels, VRC6, VRC7, FDS, MMC5, N163 and 5B. `opll()` gives the
module's own VRC7 patches when it has an external OPLL, the default set otherwise.

`instrument(i)` says what an instrument of the kind holds besides its name. The 2A03's
`dpcm` has, for each of the 96 keys (octave × 12 + semitone), the sample it plays (0: none,
else the slot + 1), the pitch 0-15 (0x80 added for looping) and the delta counter it starts
at (-1: as it is). The samples are the module's, not the instrument's: `samples()` lists
the slots in use, at most 64 and 256 KB, each up to 4081 bytes. `setSample()` puts a
sample in a slot, or in the first free one for -1, and throws when there is no room. The
FDS keeps three sequences (volume 0-32, arpeggio, pitch) in the instrument, where the
others use numbered ones that instruments share. The N163's `waves` are `waveCount` waves
of `waveSize` steps (a multiple of 4, up to 240), 0-15 each, one after the other, at
`wavePos`. The VRC7's `patch` is 0 for its own `registers` (8 bytes), 1-15 for the chip's.
An `.fti` file is what the desktop's Save Instrument writes (FTI2.4, with the DPCM samples
of a 2A03 instrument). `loadInstrument()` puts one in the first free slot, and adds the
samples that the module does not have yet; a file that is cut short or damaged is refused
and leaves the module as it was. `previewSample()` plays bytes that need not be in the
module, from the 64 byte step `offset`. An edited FDS or N163 wave changes what a note
held plays; the other settings are read when a note starts.

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
  `dnft-pattern-edit.mjs`: what the pattern editor's commands do to the cells (paste
  modes, Interpolate, Find / Replace, bookmarks...), as numbers;
  `dnft-pattern-menu.mjs`: the Edit and Pattern menus, their dialogs, the pattern's
  right-click menu and MIDI input; `dnft-frame-editor.mjs`: the frame list as the
  desktop's frame editor (its selection, clipboard and right-click menu);
  `dnft-tracker-menu.mjs`: the Tracker, View and Help menus (the row marker, Play Row, Kill Sound,
  chip mute and solo, Switch To Track Instrument, Record To Instrument, the View menu's choices);
  `dnft-displays.mjs`: the volume meters, the oscilloscope and spectrum, the register state;
  `dnft-keymap.mjs`: the shortcuts as a table that Configuration changes; `dnft-config.mjs`: the
  Configuration dialog; `dnft-help.mjs`: Help Topics, the effect table, About; `dnft-recent.mjs`:
  the recent files;
  `dnft-instrument-editor.mjs`: the instrument editor's dialog and the sequences;
  `dnft-instrument-panels.mjs`: its wave editors and the FDS, N163 and VRC7 panels;
  `dnft-dpcm.mjs`: the DPCM panel, the sample editor and the import of WAV files;
  `dnft-files.mjs`: the Import and
  Export menus and their dialogs; `dnft-song-menu.mjs`: the Song and Module menus and
  their dialogs; `dnft-zip.mjs`: zip files, for exports that write several files;
  `dnft-editor-strings.mjs`: its texts (Japanese and English); `dnft-editor.css`: its
  look, in custom properties a page can redefine

```js
import { DnFTEditor } from './dnft-editor.mjs';
const editor = await DnFTEditor.create(element, { base: '.', lang: 'ja' });
```

Keys follow the desktop's defaults, as the table in `dnft-keymap.mjs` has them (Configuration >
Keys changes them; Help > Help Topics lists them as they are set): the Z and Q rows of the keyboard enter notes (by the
key's place, whatever the layout), 1 a note cut, \ a release, - clears a field (Ctrl+-
the cell), hex digits the other columns; Space toggles editing, Enter plays the frame or
stops, F5/F6/F7/F8 play the song, loop the pattern, play from the cursor, stop; Up and
Down go by the edit step, Alt+Up/Down by one row, Alt+Left/Right to the next channel in
the same column; Delete, Insert and Backspace clear, insert and pull up (with a
selection: its fields, a row at its top, its rows); Shift with the arrows selects, also
on into the frames before and after, Alt+B and Alt+E set the start and end of a
selection that stays as the cursor moves; Ctrl+C/X/V copy, cut and paste, Ctrl+M pastes
mixed, Ctrl+Z/Y undo and redo; Ctrl+F1/F2/F3/F4 transpose by a semitone and an octave
(Ctrl+F4 closes the tab in most browsers: Ctrl+Shift+Up/Down transpose by octaves too),
Shift+F1/F2/F3/F4 change the values by 1 and 16; Ctrl+Up/Down pick the instrument before
or after; Ctrl+G interpolates, Ctrl+R reverses, Alt+S replaces the instrument; Ctrl+K,
Ctrl+PageDown and Ctrl+PageUp toggle a bookmark and go to the next and previous one;
Ctrl+F opens Find / Replace, Alt+G Go To; Alt+T and Alt+V toggle the instrument and
volume masks; the numeric keypad picks an instrument in the note column, and with Alt
the edit step; Ctrl+ the keypad's + and - change the step, + and - alone the frame's
pattern (with frames selected in the frame list, theirs). With the mouse, a click puts the cursor on a cell and a drag selects (the rows
scroll at the top and bottom), on the row numbers whole rows; a double click selects the
channel in the frame (on the row numbers, the frame); the wheel with Ctrl transposes,
with Shift changes the values, with both goes from frame to frame. Edits of patterns,
frames, bookmarks and song settings can be undone, and put the cursor and the selection
back; instruments, as on the desktop, cannot. The module is kept in the browser's
localStorage as it changes and comes back when the page is opened again.

The Edit and Pattern menus after Export have what the desktop's do. Paste Special mixes
(fills only empty fields), overwrites (keeps fields the copy has nothing in) or inserts
(moves the rows below down), at the cursor, at the selection or filling it; a paste
stops at the end of the frame unless "paste past the end of the frame" (the desktop's
Overflow paste mode) is on, selects what it pasted, and asks first when the area plays a
row of a pattern twice. Copy As copies a channel's volumes as a volume sequence, the
selection as plain text (the text export's form) or as PPMCK MML (a row a sixteenth
note). Select takes the cursor's row, column, pattern, frame, channel (all frames) or
the track; In Other Editor makes a selection of the pattern one of its frames and
channels in the frame list, and a selection of the frame list one of their whole
patterns, and goes there. Interpolate, Reverse and Stretch (with Expand and Shrink) refuse selections
where a channel plays a row twice, as the desktop's do. Find / Replace is a window that
stays open: notes (C-4, C#4, Db4, a letter alone for any octave, ---, ===, ^1, noise
periods as 3-#, `.` for anything), instruments, volumes and effects, each as a value or a
range, in the track, the cursor's channel, frame or pattern, or the selection, across the
channels or down them, negated or not; Find All lists what it finds, to go to; Replace
All is one action. Go To takes a frame and row (in hexadecimal) and a channel. Bookmarks
mark their rows' numbers and their frames in the frame list, and the Bookmark Manager
(also in the Module menu) names them, moves them, sorts them, and sets the row
highlight they start; unlike the desktop's, their changes can be undone. Swap Channels
swaps two channels in the track or in every track. The instrument mask keeps the
instrument column as notes are entered, the volume mask off writes the volume typed last;
Pick Up Row (on the pattern's right-click menu) takes the instrument and volume at the
cursor for the notes entered next. Split Keyboard moves the notes up to a split point by
up to two octaves, may give them an instrument of their own, and outside the edit mode
plays them on a channel of their own. Enable MIDI takes notes from MIDI keyboards (Web
MIDI) into the cursor's channel, two octaves down, as the desktop does; it is on again on
the next visit when the browser does not have to ask. Dragging a selection to move it (in
the pattern or in the frame list) is not done.

The frame list works as the desktop's frame editor. A drag selects frames and channels
(from the frame numbers, whole frames; past the top or the bottom, the cursor and the
list go on), Shift with a click or with the arrows extends the selection, Escape drops it.
Copy (Ctrl+C) keeps the selected pattern numbers, or the cursor's frame; Paste (Ctrl+V)
inserts them before the cursor's frame, Paste & Overwrite writes them over the frames from
there on, Paste & Duplicate inserts them with copies of their patterns at free numbers;
Cut and Delete (Del) remove the selected frames, or the cursor's, never the last one. A
pattern number typed, and + and -, change every pattern of the selection, Clone Patterns
(Alt+D) copies each of them; Ctrl+Up/Down move the frame, Insert adds one, Enter goes to
the pattern. The row after the last frame (`>>`) takes the cursor, as the desktop's does:
Paste there adds the frames at the end, and a pattern number typed there adds a frame. The
right button opens the desktop's frame menu. While the frame list has the keyboard, the
Edit menu's clipboard and Select commands (and Paste Special's Overwrite) are its own, as
on the desktop; every change can be undone.

The instrument editor (double-click an instrument, or its edit button) has the panels
of the desktop's, by the kind of instrument. The sequences (2A03, VRC6, N163, 5B) are bars
to draw with the mouse and the desktop's text form (`15 12 | 10 8 / 4 0`: what follows `|`
loops, what follows `/` plays on release); the number of a sequence is chosen with
"Select next empty slot" (the lowest number nothing uses and that has nothing in it), and
"Clone sequence" (the button, or the right button on the list of sequences or the graph)
copies the sequence into the next empty number, which the instrument then uses. The FDS has a
wave (64 steps of 0-63) and a modulation table (32 steps of 8 kinds) to draw, with the
desktop's presets and its rate, depth and delay, and three sequences of its own. The
N163 has its waves in a list (add, remove, up to 64) with the size and position, presets
made as the desktop makes them, and the waves as text, which is also how they are copied
and pasted. The VRC7 chooses one of the chip's 15 patches or edits the 8 registers of its
own, with sliders or as text. The 2A03's DPCM panel says, by octave, which sample each key
plays, at which pitch, looping or not, and from which delta counter; the samples of the
module are listed with their names, sizes and the space they take, and are loaded from
`.dmc` files, made of WAV files (a dialog with the pitch to convert to and the gain; as the
desktop's Import does, a windowed sinc brings the wave down to that rate and the delta counter
is made to follow it), saved as `.dmc` files, and
edited in the sample editor: the wave a sample's bits draw, a selection by 16 bytes to
delete or tilt, bit reverse, and a preview from where the dashed line is, at a pitch, from
the middle of the delta counter or not. The Z-M and Q-U rows of the keyboard, and the keys
below the panels, play the instrument being edited on its chip's channel (the DPCM channel
in the DPCM panel). Every change is made at once, so a note held while drawing changes as it
plays. Instruments can be loaded from `.fti` files (the button in the instrument list, or by
dropping the files anywhere on the editor; several at a time) and saved as `.fti` files
(the button in the list, or in the editor's title bar).

The Import and Export menus next to Save hold what the desktop's File menu does besides
New, Open and Save, with the options of its dialogs: Create WAV (with the sample rate,
the progress and a cancel; the worker renders it in slices so the page and the audio
keep going), the NSF export dialog, Export Text, JSON and Rows, Import Text (also by
dropping a `.txt` file), and the import of another module's tracks and instruments from
the module properties. What they write is downloaded; several files come in a zip file.

The Song menu after them does what the desktop's does to the track: Clone Patterns (the
pattern at the cursor, or each of the frames selected), Merge Duplicated Patterns,
Populate Unique Patterns, Clear Patterns, Transpose Song and Estimate Song Length.
Transpose Song moves the notes of the track, or of all tracks, by semitones, in every
pattern and every row as the desktop's does, but not in the noise and DPCM channels nor
the notes of the instruments ticked to be left out. Clone Patterns, Merge Duplicated
Patterns and Transpose Song can be undone (the desktop's Transpose Song clears what can
be undone, and its Reverse and Clear All change only the boxes, not what is left out);
Populate Unique Patterns and Clear Patterns, as on the desktop, cannot, nor what was done
before them. Populate Unique Patterns keeps the track's row highlight, which the
desktop's leaves behind. The Module menu opens Detune Settings
(with the desktop's CSV files of the tables), Groove Settings (with its tools, and a
copy as Fxx effects to paste), the device mix offsets with hardware-based mixing, the
VRC7's patches (external OPLL) of the module properties and the Bookmark Manager, and runs
Module > Cleanup.
The song panel moves tracks up and down, and switches the speed of a track to grooves.

The Tracker menu has the ways to play (from the row marker, one row, with Play Row) and the
row marker itself (Ctrl+B puts it on the cursor's row, a bar on the row number and on the
frame's number), muting and soloing the chips of the cursor's channel as well as the
channel, Switch To Track Instrument (while the song plays, the instrument the cursor's channel
plays is the one selected), Record To Instrument and its settings, and Kill Sound (F12,
which a browser may keep for its tools: the menu has it too). Record To Instrument arms the
cursor's channel; the next playback reads its registers tick by tick into the volume,
arpeggio, pitch and duty sequences of new instruments (the FDS's and the N163's waves too),
which join the module as it goes, and the header of the channel shows that it is armed.
The DPCM and VRC7 cannot be recorded, as on the desktop.

The View menu holds the follow mode, the compact view (only the notes, in narrow channels, and
the cursor has only the note column), the meters' decay rate (every channel's header has
its fifteen volume bars), the average BPM (the status line shows the BPM of the playing song,
or its average so far), the register state (a panel beside the pattern with the registers of
every chip of the module, coloured by how long ago they were written or changed, the pitch
each channel sounds at, and where each channel's note is), the oscilloscope and the
spectrum (beside the toolbar; a click switches), where the frame list is (in the side
panel, or above the pattern) and whether the side panels show. What is chosen there is kept
in the browser. On a phone the file buttons and the menus are a strip that scrolls
sideways, a menu opens as a sheet at the bottom of the window, and the side panels start
closed (the button with three bars opens them).

The button after Recent opens the Configuration, which the desktop's has as File >
Configuration: General (hexadecimal or decimal rows, flats, whether the cursor wraps round
the channels and across the frames, the step of PageUp and PageDown, whether Up and Down go by
the step, whether Shift+F1-F4 wrap a value), Appearance (the colours of the pattern, three
presets, the font, its size and the height of a row; changes show as they are made),
Keys (every shortcut can be given other keys, which a key that another command had takes
away; a few that a browser keeps cannot be chosen), Sound (the bass and treble filters,
the damping and the volume, the FDS and N163 lowpass filters, the N163's multiplexer, the
set of VRC7 patches) and Mixer (the level of each device). The sound settings are the
engine's, and are put back with the first module the page opens. The Recent menu has the
modules last opened or saved, with their bytes, in the browser's IndexedDB. Help has the
keys as they are set now, the effect table (the effects the chips take, with what each
does) and what the editor is made of.

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

### Seeking

The core has no way to jump to a position, so `Player.seek()` plays up to it and keeps
none of the audio: from where the player is when that is before the position, from the
start otherwise. So that this is not as slow as playing, the chips skip most of the way
(`CSoundChip::SetSkipping()`, set through `CSoundGenHost::SetSkipping()`). While nobody
listens, the 2A03, VRC6 and MMC5 count their clocks in long steps instead of following
every change of level (the 2A03 stops only where its frame sequencer acts on the
channels), the N163 works out the turns of its channels at once, and the VRC7 goes on
without resampling its samples. They end in the state exact steps leave them in. The
last 300 ms before the position are played exactly, so that the filters (the integrator
of the Blip_Buffer above all) settle: the audio from the position on is the audio of
playing to it, sample for sample.

A seek to nine tenths of a demo module takes 0.3 to 1.1 s now (1.5 to 6.8 s before), and
0.1 to 0.3 s in a 100 s module with VRC6, MMC5, N163 or FDS. The VRC7 and the Sunsoft 5B
are emulated sample by sample and clock by clock, which only the leaving out of what
nobody uses (the resampling, the outputs) speeds up: a seek to the end of a 100 s module
takes 2 to 3 s with either. The FDS is not skipped, and does not need to be.

The Namco 163 needed a change of its own for that to hold (FamiTracker-web#10). Its
own Blip_Buffer kept no bass removal, so the rounding of the steps it is given (one
every 15 clocks, by `Blip_Synth::update()`) added up in playing: the level of Hellpath's
N163 drifted into clipping and its channels were gone at 28 s, Kot's at 63 s, while a
seek, which skips most of those steps, started without that error and landed on another
sound. The buffer removes bass below 16 Hz now (`CN163::UpdateFilter()`), which keeps the
level near zero: the N163 plays on, and a seek to any position gives the audio of playing
to it, bit for bit, as with the other chips (`test/seek.mjs`). The FDS and the VRC7 have
buffers of the same kind; 300 s of a module of each did not drift, and they are as they
were.

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
| `APU/SoundChip.h`, `APU/APU.h`, `APU/APU.cpp` | `SetSkipping()` on the chips and the APU, off by default | a chip that is told nobody listens can take shortcuts (see Seeking) |
| `APU/2A03.cpp`, `nsfplay/.../nes_dmc.cpp`, `nes_dmc.h` | while skipping, steps as long as the frame sequencer allows (`NES_DMC::ClocksUntilFrameSequence()`, the part of `ClocksUntilLevelChange()` that is not about the level) | the counters count clocks the same in long steps |
| `APU/VRC6.cpp`, `APU/MMC5.cpp` | while skipping, one step for all the time of a call | as above |
| `APU/N163.cpp` | the dedicated Blip_Buffer removes bass below 16 Hz (`bass_freq(16)`, was 0) | with none, the rounding of its steps added up until the output clipped (#10) |
| `APU/N163.cpp`, `mesen/Namco163Audio.h` | while skipping, `Namco163Audio::SkipAudio()` moves the channels one update for every 15 clocks at once; `UpdateChannel()` takes a number of updates | what `ClockAudio()` does for each clock, without the output of each |
| `APU/VRC7.cpp`, `digital-sound-antiques/emu2413.c`, `emu2413.h` | while skipping, `OPLL_calcSkip()` for `OPLL_calc()`: the chip and its rate converter go on, the sum of the resampling and the volumes are left out | the samples are not used |
| `digital-sound-antiques/emu2149.c` | `update_output()` split into `update_state()` and the outputs of the channels; `Tick()` only moves the state | the outputs of the calls before the last one are not used: the 5B plays twice as fast, sample for sample the same |
| `Instrument.cpp` | `CInstrumentFile::ReadInt()` and `ReadChar()` raise a `CModuleException` when the file ends inside the value (they returned what the variable held) | a cut-short `.fti` was read with whatever the variable held, a sample count included |
| `SeqInstrument.cpp` | `pSeq` starts at null in every round of `LoadFile()` | a damaged `.fti` made the handler delete the sequence of the round before, which the instrument manager owns (a double free) |
| `Instrument2A03.cpp` | `SaveFile()` leaves out the keys whose sample the module does not have; `LoadFile()` checks the size of a sample against the module's DPCM space before taking memory, refuses a name or sample that the file ends inside, reads on when the file lists fewer samples than it counts, and gives a key whose sample the file does not carry none | the file counted the samples of such keys but did not list them (Hellpath's DPCM instrument is one), so it could not be read back; a damaged size asked for gigabytes; a cut-short sample was read with what the memory held; a key kept the number of whichever sample the module has there |
| `InstrumentRecorder.cpp` | the view's header only under `#ifndef DNFT_PORTABLE` (the stand-in of `portable/SoundGenUI.h` otherwise), and `Instrument.h` before `InstrumentManager.h` | the recorder builds in the web build (Record To Instrument), and `InstrumentManager.h` refers to an enum that `Instrument.h` defines |
| `FamiTrackerDoc.h` | `m_pCurrentDocument` starts at null | it was never set for a document that is not reading a file, and the range check of an `.fti` file that fails calls through it (a crash on the desktop too) |

None of them but the N163's bass removal changes the audio of playing: the first 20 to 30
seconds of every demo module without the N163, and of a module of each of the other
chips, are the same as before, sample for sample. The N163's differs below 16 Hz, and no
longer loses its level.

Testing
-------

```sh
node web/test/smoke.mjs                          # interface checks on demo/
node web/test/session.mjs                        # editing sessions, saving demo/ unchanged
node web/test/export.mjs                         # the exports and imports of sessions
node web/test/text.mjs                           # module texts: code pages and UTF-8
node web/test/seek.mjs                           # seeking: the audio, and the speed
node web/test/instrument.mjs                     # instruments: DPCM samples, FDS, N163, VRC7, .fti files
node web/test/dpcm.mjs                           # the editor's page code that works on numbers
node web/test/pattern.mjs                        # the pattern editor's commands, on cells
node web/test/frames.mjs                         # the frame editor's selections and clipboard
node web/test/ui.mjs                             # the key table, the register view's texts, the effect table
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

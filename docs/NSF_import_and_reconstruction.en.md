# NSF import and reconstruction

English | [日本語](NSF_import_and_reconstruction.ja.md)

Updated: 2026-10-10. This guide covers the FamiTracker-web browser editor.

Importing NSF/NSFe files into editable tracker data and reconstructing an import are **extensions added by this web project**. They are separate from the original Dn-FamiTracker's NSF exporter.

## Getting started

1. Open the [GitHub Pages editor](https://hhungry2.github.io/FamiTracker-web/editor.html?lang=en) or the [zxtune.com editor](https://zxtune.com/create/famitracker).
2. Choose a `.nsf` or `.nsfe` file with Open, Import > Open an NSF, or drag and drop.
3. Select a reading method. Start with Playback analysis; try Driver decoding for supported Dn-FT 2.16 or Mega Man 1–2 engines.
4. All songs is selected by default. Select one song instead if needed, then open the file.
5. Select a track created by playback analysis and choose Song > Reconstruct NSF import.
6. Compare the original and added tracks, then use the usual Save action to save one `.dnm` file.

NSF import opens a new module. Save any work in the current module first. Reconstruction adds a separate track to the current module.

## The two reading methods and reconstruction

| Aspect | Playback analysis | Driver decoding | Reconstruction after import |
| --- | --- | --- | --- |
| Input | NSF/NSFe playback | Music data stored by a supported driver | A speed 1 track created by playback analysis |
| Processing | Play with NSFPlay and record chip states | Verify the driver code and decode rows, notes and commands | Infer volume/pitch sequences and combine unchanged rows |
| Meaning of a row | One chip playback frame; about 60 rows/second at standard NTSC rate | Dn-FT: exported row; Mega Man: automatically rebuilt row | Duration set by Fxx; rows can last different amounts of time |
| Readability | Fine changes occupy many rows | Decoded data can be closer to the original tracker structure | Fewer entries and rows; no beat or bar inference |
| Coverage | Formats and chips handled by NSFPlay and the converter | Dn-FT 2.16; stock Mega Man 1–2 music with hardware analysis | Playback imports retaining a supported structure |
| Failure | Show an error and retain the current module | Switch to playback analysis and report the fallback | Retain the original data if verification fails |

An NSF contains a playback program and music data, generally not the complete composition project. No method guarantees recovery of all original input, instrument names or unused data. The result is a vertical tracker pattern, rather than a conversion to staff notation or a piano roll.

## Playback analysis settings

| Setting | Behavior and selection |
| --- | --- |
| Song | All songs imports the first 64 songs at most, one track per song. You can select any single song, including song 65 onward. |
| Region | Choose NTSC or PAL when the file supports both. Driver decoding also respects the selected region. |
| Play it for up to | Analysis limit for each song, normally five minutes. NSFe timing metadata can increase it to allow at least two passes. The UI limit is 18 minutes. Loop detection needs enough playback to observe repetition. |
| Rows per pattern | Groups rows into patterns of 64, 128 or 256 rows. This does not reduce the total row count. Longer patterns are selected automatically when too many order frames would be needed. |
| Find where it repeats and loop there | Detect repetition and jump back with Bxx. Tracks without a detected loop, or which fall silent, stop with C00. |
| Leave out the silence at the start | Trim initial silence. |

All-song import shares identical instruments and DPCM samples. It stops before a song that would exceed 64 instruments, 64 samples or 256 KB of sample data, or requires incompatible global playback settings. The result reports the number imported and the reason. Songs silent within the analysis interval remain as stopped tracks with a warning. Save the result as one module using the normal Save action; there is no split-file or ZIP save workflow.

Playback analysis does not guarantee sample-for-sample equality with direct NSF playback. Fidelity of the import and equality before/after reconstruction are separate checks.

## Driver decoding coverage

The decoder verifies the **Dn-FT 2.16** driver code used by this repository's exporter. This is the driver's identification version, not the application's version. Supported NSF/NSFe/NSF2 data can supply patterns, orders, speed/tempo, supported effects, sequences, waves, VRC7 patches and DPCM assignments. Chips include 2A03, VRC6, VRC7, FDS, MMC5, N163, S5B and multichip configurations. The editor's file picker accepts `.nsf` and `.nsfe` extensions.

Direct decoding uses the exported structure, ignoring the playback-analysis duration, pattern-length, loop-detection and silence-trimming settings. All songs remains the default, with a 64-track maximum.

The stock US **Mega Man 1 and 2** engines also support music-structure decoding combined with NSFPlay hardware analysis and automatic reconstruction. Their music durations and loops come from decoded commands; sound states come from NSFPlay. Unsupported songs, including SFX, fall back individually. All songs still produces one module with at most 64 tracks. See [game coverage, rip constraints and validation](NSF_game_drivers.en.md).

Unknown drivers, other versions, modified code, inconsistent compressed streams and unsupported data fall back to playback analysis. Playback analysis does not need to identify the driver, but does not guarantee complete reproduction of arbitrary game NSFs.

Of the five included demo exports, one currently decodes directly; four fall back because of compressed-stream consistency checks. See the [driver scope and verification notes in Japanese](NSF_driver_decoding.md) and [Issue #14](https://github.com/hhungry2/FamiTracker-web/issues/14).

## What reconstruction does

Reconstruction processes the selected track:

1. Move suitable per-tick volume changes and Pxx pitch corrections into sequences on new instruments.
2. Reuse identical sequences, instruments and patterns.
3. Combine unchanged intervals and set each retained row's duration with Fxx.
4. Render the original and candidate in separate engines, adding the candidate as a separate track only after verification succeeds.

The original track, instruments and samples remain, so at least one track slot must be free within the 64-track limit. An unedited playback import saved as `.dnm` can also be reconstructed after reopening. This processes one selected track, rather than every track in a batch.

| Chip | Infer volume sequences | Infer Pxx pitch sequences |
| --- | --- | --- |
| 2A03 pulse | Yes | Yes |
| 2A03 triangle | Keep existing entries | Yes |
| 2A03 noise | Yes | Keep existing entries |
| MMC5, VRC6, S5B | Yes | Yes |
| N163 | Yes | Keep existing entries |
| DPCM, FDS, VRC7 | Keep existing entries | Keep existing entries |

Unconverted sections can still benefit from row packing. Instruments with enabled sequences, held notes using &&, releases, mid-note instrument changes, notes crossing loop boundaries, sequences longer than 252 items and insufficient free slots retain their entries. Pitch inference is period-based; linear pitch, hardware sweeps and phase resets are excluded from pitch conversion.

Tracks with changed speeds, grooves, unsupported effects or complex branches are rejected. If neither sequences nor row packing improve the track, no track is added. Rows can have different durations, so fixed beat/bar highlights are disabled on the reconstructed track, with a persistent start bookmark retaining that display after reopening. Reducing rows does not identify the composer's original meter, input rows or instrument structure.

## Playback verification

Two independent engines render the original and candidate as 44.1 kHz PCM and compare samples. Checks cover the full mix and each channel whose sequences changed. The interval includes the intro, two loop passes and one second for renderer boundaries; stopped tracks use the captured track length plus the boundary allowance.

If volume-plus-pitch reconstruction differs, the process retries volume sequences only, then empty-row packing only. If all candidates differ, nothing is applied. **The reference is the track already imported by playback analysis, not direct NSF playback or the composer's source project.**

You can cancel the operation. Failure, cancellation, or detecting edits/a replaced document during processing preserves the original data or the newer edits. Progress includes playback comparisons before applying a result.

## Verified examples and saving

Each of five demo modules was exported to NSF, imported through playback analysis over approximately 20 seconds (1,200 frames), then reconstructed. Saved/reopened PCM matched for all five. These results do not imply the same reduction for arbitrary files.

| Demo | Imported rows | Reconstructed rows |
| --- | ---: | ---: |
| Trapped Within a Memory | 1,200 | 1,001 |
| Hellpath | 1,200 | 887 |
| The Wavetable That Doesn't Wanna Be | 1,200 | 928 |
| GOAted Ambition | 1,200 | 846 |
| Hell or High Water | 1,200 | 643 |
| Total | 6,000 | 4,305 |

The saved `.dnm` includes the original track, reconstructed track and added instruments. Use Save to keep a local file in addition to browser autosave.

## Interface languages

The whole editor supports Japanese, English, Simplified Chinese, Traditional Chinese, Korean, Spanish, Brazilian Portuguese, French, German and Russian. On GitHub Pages, use a query such as `editor.html?lang=en`; otherwise the browser language is used. On zxtune.com, the site's selected language also applies to the editor. Note names, effect codes and file-provided song titles are not translated.

## Implementation and verification references

- [Detailed method comparison and reconstruction limits (Japanese)](NSF_import_method_comparison.md)
- [Driver decoding (Japanese)](NSF_driver_decoding.md)
- [Build, API and tests](../web/README.md)
- [Playback analysis](../web/src/nsf_import.cpp), [all-song import](../web/html/dnft-nsf-import.mjs), [driver decoding](../web/html/dnft-nsf-driver-import.mjs), [reconstruction](../web/html/dnft-nsf-reconstruct.mjs)
- [Sequence reconstruction tests](../web/test/nsf-reconstruct-sequences.mjs), [real NSF demo tests](../web/test/nsf-reconstruct-demos.mjs), [worker/UI tests](../web/test/nsf-reconstruct-worker.mjs)

# Commercial-game NSF driver import

English | [日本語](NSF_game_drivers.ja.md)

Updated: 2026-10-10. The first implementation for [Issue #21](https://github.com/hhungry2/FamiTracker-web/issues/21) supports the documented Capcom Mega Man 1 and 2 engines.

## Coverage

| Game | Verified program | Content |
| --- | --- | --- |
| Mega Man / Rockman 1 | Stock US sound engine at $8000 | 16 music entries |
| Mega Man II / Rockman 2 | Stock US sound engine at $8000 | 24 music entries |

Identification checks the full engine length and two different 32-bit fingerprints, including its frequency table. It does not trust the NSF title. The actual code must match; support is not guaranteed for every regional release, modified engine or rip arrangement.

References: [Bisqwit's analysis](https://www.bisqwit.iki.fi/jutut/megamansource/), [Mega Man 1 disassembly](https://github.com/lsmmega/mm1/tree/b606a84840aea70f1298ddd9cf832bda69d99d27), and [Mega Man 2 disassembly](https://github.com/lsmmega/mm2/tree/8e378590488ce589c526f0d24ad4dee60afd14a3). The latter repositories identify their US base ROMs in their READMEs.

NSF, NSFe and NSF2 containers and initial bank mappings are shared infrastructure. Dn-FT-specific rules such as `play = init + 3` and its pattern bank windows do not apply to these game readers. The stock play entry and simple JMP or JSR/RTS wrappers are accepted.

NSF song numbers need not equal internal engine IDs. A bounded interpreter handles initialization RAM clears, simple arithmetic, song lookup tables, branches and subroutines, recording the ID passed to $8003. Unsupported instructions, changed banks, external speed/fade/pause controls and other unrecognized initialization behavior use fallback.

## Reading process

1. Identify the engine and resolve the song ID through its initialization wrapper.
2. Read the music header and four independent channel pointers.
3. Decode notes, rests, durations, tempo, dotted notes, triplets, ties, finite repeats and infinite loops. Validate volume, duty, pitch and modulator commands too.
4. Advance each channel on the engine's quarter-frame clock and find a repeated combined musical state.
5. Run NSFPlay for the decoded length to capture actual APU sound states, then check that the decoded loop agrees with those states. A first pass with unsettled sound state can be retained as part of the intro.
6. Supply explicit end/loop positions to the shared tracker converter and reconstruct automatically. Changed sequences and packed rows are accepted only after their PCM matches the converted track.

**The game reader combines direct structure decoding with hardware playback analysis.** APU behavior such as triangle length counters and volume envelopes comes from NSFPlay. This differs from the Dn-FT reader, which directly restores exported sound resources as well as rows.

Original authoring patterns, meter, bars, instrument names and unused data are not recovered. Rebuilt rows use variable Fxx durations, with regular beat/bar highlights disabled.

## All songs and fallback

Choose Driver decoding in the normal NSF import dialog. All songs remains the default: one track per song, the first 64 songs at most, saved in one module. Single-song selection also works. There is no split-file or ZIP-save workflow.

Mixed music/SFX files decode their music and use existing playback analysis for SFX. Unsupported initialization, corrupt pointers, unknown commands, limits and loops inconsistent with hardware playback also fall back per song. The UI identifies affected song numbers; saved module comments retain reasons. An unrecognized engine falls back for the whole file.

Decoded music uses its own structure instead of analysis-duration or pattern-length settings to decide where it ends. Fallback songs use the normal analysis settings. To keep later songs within instrument capacity, batches switch to PCM-verified row packing when generated macros would consume too many instrument slots. Some songs cannot be compressed and keep their original converted rows.

Limits are 65,535 decoded frames, two million commands, 4,096 commands without advancing time, and 100,000 initialization instructions with 16 nested subroutines. An incomplete decode is never accepted at a limit. Failure and cancellation preserve the current document.

## Validation

Locally assembled music collections from the public disassemblies were used to check complete music structures, loops against playback, and batch import. Game music data and binaries were not added to this repository.

| Collection | Songs | Converted rows | Rebuilt rows |
| --- | ---: | ---: | ---: |
| Mega Man 1 US music | 16/16 | 26,236 | 17,230 |
| Mega Man 2 US music | 24/24 | 50,682 | 34,118 |

PCM comparisons passed for 37 changed songs; three retained their converted tracks because reconstruction offered no reduction. These results do not guarantee support for every existing rip.

CI assembles **only the stock sound engines** from pinned public source commits and adds newly authored test notes. It does not distribute game melodies or ROM fixtures.

```sh
node web/test/build-capcom-reference.mjs  # requires ca65/ld65 and network access
node web/test/nsf-capcom.mjs
```

Tests cover reordered song IDs, four channels, timing commands, NSF/NSFe/NSF2 and initial banks, SFX fallback, 64 tracks, corruption, unbounded loops, cancellation, sequence merging, saving and reopening. Batch and single-song PCM are compared beyond a loop boundary.

For five seconds of synthetic test notes, spectra of original NSF and rebuilt playback scored 0.991 for pulse 1, 0.993 for pulse 2, 0.981 for triangle and 0.797–0.799 for noise, for both engines. Start offsets must be below 0.1 seconds. These are similarity checks across emulators, phases and update timing, not sample equality with the original NSF. Exact reconstruction PCM checks use the converted tracker data as their reference.

## Remaining work

Direct SFX decoding, fully direct conversion of sound commands to sequences, modified engine code, dynamic bank switching and additional games/engines remain future work. [Issue #21](https://github.com/hhungry2/FamiTracker-web/issues/21) stays open.

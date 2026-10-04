NSFPlay
=======

The part of [NSFPlay](https://github.com/bbbradsmith/nsfplay) the NSF import plays NSFs
with (see "NSF import" in `../../README.md`): the library sources NSFPlay's own build for
Linux and macOS compiles (`contrib/Makefile`) and the headers they include, from commit
`6af5406e3325b5507bea1ae1a57c77d5efe5c7f3` (2025-02-04), as they are, Shift_JIS comments
and all. `web/Makefile` builds them with the analyzer (`src/nsf_analyzer.cpp`) into
`dist/dnft-nsf.mjs`.

NSFPlay is maintained by Brad Smith, a fork of NSFPlay/NSFPlug by Brezza (Mitsutaka
Okazaki). Its terms are in `readme.txt`: the code may be reused without restriction, and
no warranty or liability is implied.

One change, marked "FamiTracker-web" where it is: `CPULogger::Begin()`, `Init()` and
`Play()` (`xgm/devices/Misc/log_cpu.h`) are virtual, so that the analyzer's own logger
hears every call of the play routine. Everything else the analyzer needs it reads through
the chips' protected members, which leaves NSFPlay as it is.

To take a newer NSFPlay, copy the same files from its repository (the sources listed in
`NSFPLAY_CPP_SOURCES` and `NSFPLAY_C_SOURCES` in `web/Makefile`, and what they include) and
make the change above again.

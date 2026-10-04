# Dn-FamiTracker web build: the tracker core compiled to WebAssembly.
#
# Needs an activated emsdk (emcc/em++ on PATH), python3, and ca65 and ld65 from cc65
# for the NSF drivers (CA65 and LD65 name other commands for them):
#   source <emsdk>/emsdk_env.sh
#   make -C web -j$(nproc)
#
# Results: dist/dnft.mjs and dist/dnft.wasm. `make debug=1` builds unoptimized with
# assertions on.

ROOT := ..
DESKTOP := $(ROOT)/desktop
SRC := $(DESKTOP)/Source

ifdef debug
BUILD := build/debug
else
BUILD := build/release
endif
DIST := dist

CXX := em++
CC := emcc

# The part of desktop/Source/ that loads, plays and exports modules. Everything else there is
# user interface code.
CORE_SOURCES := \
	FamiTrackerDoc DocumentFile SimpleFile ModuleException \
	PatternData PatternNote Groove Bookmark BookmarkCollection BookmarkManager \
	Instrument Instrument2A03 InstrumentVRC6 InstrumentVRC7 InstrumentFDS InstrumentN163 InstrumentS5B \
	InstrumentFactory InstrumentManager SeqInstrument Sequence SequenceCollection SequenceManager OldSequence \
	DSample DSampleManager DetuneTable FamiTrackerTypes ChannelMap ChannelFactory TrackerChannel Settings \
	SoundGen ChannelHandler ChannelState Channels2A03 ChannelsVRC6 ChannelsVRC7 ChannelsFDS ChannelsMMC5 \
	ChannelsN163 ChannelsS5B InstHandlerDPCM InstHandlerVRC7 SeqInstHandler SeqInstHandler2A03Pulse \
	SeqInstHandlerFDS SeqInstHandlerN163 SeqInstHandlerS5B SeqInstHandlerSawtooth NoteQueue RegisterState \
	InstrumentRecorder \
	Chunk utils/ftmath \
	APU/APU APU/Mixer APU/SoundChip APU/2A03 APU/MMC5 APU/VRC6 APU/VRC7 APU/FDS APU/N163 APU/S5B \
	APU/nsfplay/xgm/devices/Sound/nes_apu APU/nsfplay/xgm/devices/Sound/nes_dmc \
	APU/nsfplay/xgm/devices/Sound/nes_mmc5 APU/nsfplay/xgm/devices/Sound/nes_vrc6 \
	Blip_Buffer/Blip_Buffer \
	Compiler PatternCompiler ChunkRenderText ChunkRenderBinary TextExporter JsonExporter

CORE_C_SOURCES := \
	APU/digital-sound-antiques/emu2149 APU/digital-sound-antiques/emu2413

# The port itself: compatibility layer, stand-ins for the user interface, the player,
# the editing session, the exports and their javascript bindings.
WEB_SOURCES := dnft_compat app standins soundgen_host engine bindings session export session_bindings text_encoding nsf_import

CORE_OBJECTS := \
	$(addprefix $(BUILD)/core/,$(addsuffix .o,$(CORE_SOURCES))) \
	$(addprefix $(BUILD)/core/,$(addsuffix .c.o,$(CORE_C_SOURCES)))
OBJECTS := $(CORE_OBJECTS) $(addprefix $(BUILD)/web/,$(addsuffix .o,$(WEB_SOURCES)))

DEFINES := -DDNFT_PORTABLE
# compat/ goes first: it answers <afx.h>, <windows.h> and friends. desktop/ and
# desktop/Source/ match the include directories of the desktop project; generated/
# has what the build makes, such as the NSF drivers that Source/Driver.h includes.
INCLUDES := -Icompat -Isrc -I$(DESKTOP) -I$(SRC) -I$(SRC)/APU -I$(BUILD)/generated

ifdef debug
OPT := -O0 -g -DDNFT_DEBUG
else
OPT := -O2 -g0
endif

# The core reports load errors by throwing, hence wasm exceptions. It is written for
# MSVC: __declspec needs the Microsoft extensions, and MSVC only parses a template body
# when it is instantiated, which some headers rely on.
COMMON_FLAGS := $(OPT) -fwasm-exceptions -fms-extensions -fdeclspec $(DEFINES) $(INCLUDES) -MMD -MP
CXXFLAGS := -std=c++17 -fdelayed-template-parsing $(COMMON_FLAGS)
CFLAGS := $(COMMON_FLAGS)
# Upstream sources are compiled as they are; their warnings are not ours to fix here.
# MSVC declares its CRT extensions in the standard headers, so some sources use them
# without any Windows include: msvc_crt.h stands in for that.
CORE_WARNINGS := -w -Wno-invalid-constexpr
CORE_CXX_INCLUDES := -include msvc_crt.h
# upstream headers use override inconsistently; json.hpp predates C++23 literal syntax
WEB_WARNINGS := -Wall -Wno-unused-private-field -Wno-inconsistent-missing-override -Wno-deprecated-literal-operator

LDFLAGS := $(OPT) -fwasm-exceptions -lembind \
	-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createDnFT \
	-sENVIRONMENT=web,worker,node -sFILESYSTEM=0 \
	-sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1MB \
	-sEXPORTED_FUNCTIONS=_malloc,_free \
	-sEXPORTED_RUNTIME_METHODS=HEAP16,HEAPU8,getExceptionMessage

TARGET := $(DIST)/dnft.mjs

# The first half of the NSF import (src/nsf_analyzer.cpp): NSFPlay plays the NSF, and the
# state of its chips is written down frame by frame; the engine turns that into a module
# (src/nsf_import.cpp). The engine compiles changed copies of some of NSFPlay's chips
# (desktop/Source/APU/nsfplay), which would clash with NSFPlay's own, so this is a module
# of its own, which the editor loads when it imports an NSF.
NSFPLAY := third_party/nsfplay
NSFPLAY_CPP_SOURCES := \
	xgm/devices/Audio/MedianFilter xgm/devices/Audio/echo xgm/devices/Audio/filter xgm/devices/Audio/rconv \
	xgm/devices/CPU/nes_cpu \
	xgm/devices/Memory/nes_bank xgm/devices/Memory/nes_mem xgm/devices/Memory/nsf2_vectors xgm/devices/Memory/ram64k \
	xgm/devices/Misc/detect xgm/devices/Misc/log_cpu xgm/devices/Misc/nes_detect xgm/devices/Misc/nsf2_irq \
	xgm/devices/Sound/nes_apu xgm/devices/Sound/nes_dmc xgm/devices/Sound/nes_fds xgm/devices/Sound/nes_fme7 \
	xgm/devices/Sound/nes_mmc5 xgm/devices/Sound/nes_n106 xgm/devices/Sound/nes_vrc6 xgm/devices/Sound/nes_vrc7 \
	xgm/player/nsf/nsf xgm/player/nsf/nsfconfig xgm/player/nsf/nsfplay xgm/player/nsf/pls/ppls \
	xgm/player/nsf/pls/sstream xgm/fileutil vcm/group vcm/value
NSFPLAY_C_SOURCES := xgm/devices/Sound/legacy/emu2149 xgm/devices/Sound/legacy/emu2212 xgm/devices/Sound/legacy/emu2413
NSF_SOURCES := nsf_analyzer nsf_bindings
NSF_OBJECTS := \
	$(addprefix $(BUILD)/nsfplay/,$(addsuffix .o,$(NSFPLAY_CPP_SOURCES))) \
	$(addprefix $(BUILD)/nsfplay/,$(addsuffix .c.o,$(NSFPLAY_C_SOURCES))) \
	$(addprefix $(BUILD)/nsf/,$(addsuffix .o,$(NSF_SOURCES)))
NSF_TARGET := $(DIST)/dnft-nsf.mjs
# as NSFPlay's own build for Linux and macOS (its contrib/Makefile)
NSFPLAY_FLAGS := $(OPT) $(if $(debug),,-DNDEBUG) -I$(NSFPLAY) -MMD -MP
NSF_LDFLAGS := $(OPT) -lembind \
	-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createDnFTNsf \
	-sENVIRONMENT=web,worker,node -sFILESYSTEM=0 \
	-sALLOW_MEMORY_GROWTH=1 \
	-sEXPORTED_FUNCTIONS=_malloc,_free \
	-sEXPORTED_RUNTIME_METHODS=HEAPU8

.PHONY: all core site clean
all: $(TARGET) $(NSF_TARGET)
core: $(CORE_OBJECTS)

# The demo page next to the engine, with the demo modules: serve dist/ over http
# (module scripts do not load from file://), e.g. python3 -m http.server -d dist
HTML := $(wildcard html/*)
site: $(TARGET) $(NSF_TARGET) $(HTML)
	cp $(HTML) $(DIST)/
	mkdir -p $(DIST)/demo
	for f in $(ROOT)/demo/*.dnm $(ROOT)/demo/*.0cc $(ROOT)/demo/*.ftm; do 		if [ -e "$$f" ]; then cp "$$f" $(DIST)/demo/; fi; 	done
	python3 -c 'import json, os, sys; print(json.dumps(sorted(f for f in os.listdir(sys.argv[1]) if f.lower().endswith((".dnm", ".0cc", ".ftm")))))' $(DIST)/demo > $(DIST)/demo/index.json

$(TARGET): $(OBJECTS)
	@mkdir -p $(dir $@)
	$(CXX) $(LDFLAGS) -o $@ $^

$(BUILD)/core/%.o: $(SRC)/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $(CORE_WARNINGS) $(CORE_CXX_INCLUDES) -c $< -o $@

$(BUILD)/core/%.c.o: $(SRC)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(CORE_WARNINGS) -c $< -o $@

$(BUILD)/web/%.o: src/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $(WEB_WARNINGS) -c $< -o $@

$(NSF_TARGET): $(NSF_OBJECTS)
	@mkdir -p $(dir $@)
	$(CXX) $(NSF_LDFLAGS) -o $@ $^

# NSFPlay is compiled as it is (third_party/nsfplay/README.md)
$(BUILD)/nsfplay/%.o: $(NSFPLAY)/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) -std=c++17 $(NSFPLAY_FLAGS) -w -c $< -o $@

$(BUILD)/nsfplay/%.c.o: $(NSFPLAY)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(NSFPLAY_FLAGS) -w -c $< -o $@

$(BUILD)/nsf/%.o: src/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) -std=c++17 $(NSFPLAY_FLAGS) -Isrc $(WEB_WARNINGS) -c $< -o $@

# Message texts come from the string tables of the desktop resource script
$(BUILD)/generated/strings.inc: $(DESKTOP)/Dn-FamiTracker.rc $(DESKTOP)/resource.h tools/rc_strings.py
	@mkdir -p $(dir $@)
	python3 tools/rc_strings.py $(DESKTOP)/Dn-FamiTracker.rc $(DESKTOP)/resource.h > $@

$(BUILD)/web/dnft_compat.o: $(BUILD)/generated/strings.inc

# The NSF drivers, which the NSF export puts around the music: assembled from
# desktop/Source/drivers/asm by the script the desktop build runs (Source/drivers/build.cmd),
# which calls ca65 and ld65. A build of cc65 made with emcc runs under node:
#   make CA65="node <cc65>/bin/ca65" LD65="node <cc65>/bin/ld65"   (see tools/build_cc65.sh)
# The script calls the tools by those names: commands by the names that run CA65 and
# LD65, by their full paths, go first on its PATH.
CA65 ?= ca65
LD65 ?= ld65
PYTHON ?= python3
DRIVER_ASM := $(wildcard $(SRC)/drivers/asm/*.s $(SRC)/drivers/asm/*.mac)
DRIVER_SCRIPT := $(SRC)/drivers/asm/build/build_engine.py
DRIVERS_BUILT := $(BUILD)/generated/drivers/.built

$(DRIVERS_BUILT): $(DRIVER_ASM) $(DRIVER_SCRIPT)
	@for tool in '$(CA65)' '$(LD65)'; do $$tool --version >/dev/null 2>&1 || { echo "The NSF drivers need ca65 and ld65 from cc65 (https://cc65.github.io); set CA65 and LD65 to run them from elsewhere." >&2; exit 1; }; done
	rm -rf $(BUILD)/drivers $(dir $@)
	mkdir -p $(BUILD)/drivers/asm/build $(BUILD)/drivers/bin $(dir $@)
	cp $(DRIVER_ASM) $(BUILD)/drivers/asm/
	cp $(DRIVER_SCRIPT) $(BUILD)/drivers/asm/build/
	printf '#!/bin/sh\nexec %s %s "$$@"\n' "$$(command -v $(firstword $(CA65)))" '$(wordlist 2,$(words $(CA65)),$(CA65))' > $(BUILD)/drivers/bin/ca65
	printf '#!/bin/sh\nexec %s %s "$$@"\n' "$$(command -v $(firstword $(LD65)))" '$(wordlist 2,$(words $(LD65)),$(LD65))' > $(BUILD)/drivers/bin/ld65
	chmod +x $(BUILD)/drivers/bin/ca65 $(BUILD)/drivers/bin/ld65
	cd $(BUILD)/drivers/asm/build && PATH="$(abspath $(BUILD)/drivers/bin):$$PATH" $(PYTHON) build_engine.py
	cp $(BUILD)/drivers/asm/build/drivers/*.h $(dir $@)
	touch $@

$(BUILD)/core/Compiler.o: $(DRIVERS_BUILT)

clean:
	rm -rf build $(DIST)

-include $(OBJECTS:.o=.d) $(NSF_OBJECTS:.o=.d)

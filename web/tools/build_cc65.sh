#!/bin/sh
# Builds ca65 and ld65, the assembler and linker of cc65 the NSF drivers are made with,
# using emcc, for machines with emsdk but no C compiler of their own. They run under
# node:
#   tools/build_cc65.sh <cc65 source directory>
#   make -C web CA65="node <cc65>/bin/ca65" LD65="node <cc65>/bin/ld65"
# cc65 is at https://github.com/cc65/cc65; the desktop build's CI uses commit
# 2f4e2a34c32c679e4325652e461acce7f615a22e.

set -e
dir=${1:?usage: build_cc65.sh <cc65 source directory>}
# NODERAWFS: the files named on the command line are the host's
make -C "$dir/src" ca65 ld65 CC=emcc AR=emar \
	LDFLAGS="-sNODERAWFS=1 -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1 -sENVIRONMENT=node -sSTACK_SIZE=1MB"

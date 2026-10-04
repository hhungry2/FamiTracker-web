#!/usr/bin/env python3
"""Reports #include lines whose file name case differs from the file on disk.

usage: check_include_case.py   (from anywhere; paths are relative to this file)

Windows and the Windows drives WSL mounts ignore case; a checkout on a Linux file system
does not, and the build fails there on such includes. Follows the includes of every
source the Makefile compiles, with the Makefile's include directories.
"""

import os
import re
import sys

WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(WEB)
DESKTOP = os.path.join(ROOT, 'desktop')
SRC = os.path.join(DESKTOP, 'Source')
INCLUDE_DIRS = [os.path.join(WEB, 'compat'), os.path.join(WEB, 'src'), DESKTOP, SRC, os.path.join(SRC, 'APU')]
INCLUDE = re.compile(r'\s*#\s*include\s*([<"])([^>"]+)[>"]')


def exact(path):
    """True if the path exists with this exact case, False if only in another case."""
    path = os.path.normpath(path)
    drive, rest = os.path.splitdrive(path)
    current = drive + os.sep
    for part in rest.strip(os.sep).split(os.sep):
        try:
            names = os.listdir(current)
        except OSError:
            return None
        if part not in names:
            return False if part.lower() in (n.lower() for n in names) else None
        current = os.path.join(current, part)
    return True


def make_list(variable):
    lines = open(os.path.join(WEB, 'Makefile'), encoding='utf-8').read().split('\n')
    i = next(k for k, line in enumerate(lines) if line.startswith(variable + ' :='))
    items = []
    line = lines[i].split(':=', 1)[1]
    while True:
        continued = line.rstrip().endswith('\\')
        items += line.rstrip().rstrip('\\').split()
        if not continued:
            return items
        i += 1
        line = lines[i]


def main():
    pending = [os.path.join(SRC, name + '.cpp') for name in make_list('CORE_SOURCES')]
    pending += [os.path.join(SRC, name + '.c') for name in make_list('CORE_C_SOURCES')]
    pending += [os.path.join(WEB, 'src', name + '.cpp') for name in make_list('WEB_SOURCES')]
    seen = set()
    problems = set()
    while pending:
        path = os.path.normpath(pending.pop())
        if path in seen or not os.path.exists(path):
            continue
        seen.add(path)
        for line in open(path, encoding='latin-1'):
            match = INCLUDE.match(line)
            if not match:
                continue
            quote, name = match.groups()
            directories = ([os.path.dirname(path)] if quote == '"' else []) + INCLUDE_DIRS
            for directory in directories:
                candidate = os.path.join(directory, name)
                found = exact(candidate)
                if found is None:
                    continue
                if found is False:
                    problems.add((os.path.relpath(path, ROOT), name))
                pending.append(candidate)
                break
    for source, name in sorted(problems):
        print(f'{source}: #include "{name}" differs in case from the file on disk')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())

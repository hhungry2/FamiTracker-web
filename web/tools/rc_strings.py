#!/usr/bin/env python3
"""Extracts the STRINGTABLE entries of a resource script as C++ initializers.

usage: rc_strings.py Dn-FamiTracker.rc resource.h > strings.inc

Each entry becomes `{ID, "text"},`. IDs stay symbolic, so the including file resolves
them through resource.h exactly as the resource compiler does. Entries keyed by MFC's
own IDs (menu prompts from afxres.h) are left out, apart from the application title.
"""

import re
import sys

ENTRY = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*)?(".*")?\s*$')


def rc_to_c(literal):
    # RC doubles quotes inside strings; C escapes them. Backslash escapes are shared.
    body = literal[1:-1].replace('""', '\\"')
    return '"' + body + '"'


KEEP_MFC_IDS = {'AFX_IDS_APP_TITLE'}


def defined_ids(header):
    with open(header, encoding='latin-1') as f:
        return set(re.findall(r'^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)', f.read(), re.M))


def main(path, header):
    known = defined_ids(header) | KEEP_MFC_IDS
    with open(path, encoding='latin-1') as f:
        lines = f.read().splitlines()
    out = []
    in_table = False
    depth = 0
    pending = None
    for line in lines:
        stripped = line.strip()
        if not in_table:
            if stripped == 'STRINGTABLE':
                in_table = True
                depth = 0
            continue
        if stripped in ('BEGIN', '{'):
            depth += 1
            continue
        if stripped in ('END', '}'):
            depth -= 1
            if depth <= 0:
                in_table = False
            continue
        if depth <= 0 or not stripped:
            continue
        if pending and stripped.startswith('"'):
            out.append((pending, rc_to_c(stripped)))
            pending = None
            continue
        m = ENTRY.match(line)
        if not m:
            continue
        name, text = m.groups()
        if text is None:
            pending = name
        else:
            out.append((name, rc_to_c(text)))
    for name, text in out:
        if name in known:
            print('{%s, %s},' % (name, text))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])

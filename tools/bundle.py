#!/usr/bin/env python3
"""Build dist/JobTracker.gs - every src/*.gs concatenated, in load order.

An install updated by hand pastes one file instead of six, which is the whole
point: the people running this are not necessarily going to fork a repository,
and nobody else can deploy for them. Editing a bound script requires edit access
to its container, and anyone with that can read the script's properties - where
the API key lives. So the manual path is the only path for them, and it should
be one paste.

Apps Script evaluates project files alphabetically, so concatenating them in that
same order behaves identically to the six separate files. That is also the order
test/run_tests.py loads them in, so the bundle is covered by the same tests.

  uv run python tools/bundle.py            # rewrite dist/JobTracker.gs
  uv run python tools/bundle.py --check    # exit 1 if it is out of date
"""
import glob
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'dist', 'JobTracker.gs')

HEADER = """/**
 * JobTracker.gs - GENERATED FILE, DO NOT EDIT.
 *
 * Every src/*.gs from the job-tracker repository, concatenated in the order
 * Apps Script evaluates them (alphabetical). Paste this one file into the
 * editor in place of the separate files; it behaves identically.
 *
 * Rebuild with: uv run python tools/bundle.py
 * Edit the sources in src/, never this file - it is overwritten.
 */

"""


def sources():
    return sorted(glob.glob(os.path.join(ROOT, 'src', '*.gs')))


def build():
    """The bundle's exact contents, as a string. Deterministic: no timestamps
    and no commit id, so the committed file only changes when src/ does."""
    parts = []
    for path in sources():
        name = os.path.basename(path)
        rule = '=' * max(3, 70 - len(name))
        with open(path, encoding='utf-8') as fh:
            body = fh.read().rstrip('\n')
        parts.append('// %s %s\n\n%s\n' % (name, rule, body))
    return HEADER + '\n'.join(parts)


def main():
    want = build()
    check = '--check' in sys.argv
    have = None
    if os.path.exists(OUT):
        with open(OUT, encoding='utf-8') as fh:
            have = fh.read()

    if have == want:
        if not check:
            print('dist/JobTracker.gs is already current.')
        return 0

    if check:
        print('dist/JobTracker.gs %s - run: uv run python tools/bundle.py'
              % ('is out of date' if have is not None else 'is missing'))
        return 1

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write(want)
    print('wrote dist/JobTracker.gs (%d lines from %d sources)'
          % (want.count('\n') + 1, len(sources())))
    return 0


if __name__ == '__main__':
    sys.exit(main())

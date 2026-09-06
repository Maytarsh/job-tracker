# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Google Apps Script project — no build, no package manager, no local runtime for `src/`.
`@README.md` covers setup, the Sheet layout, and tuning; this file covers only what is
easy to get wrong while editing.

## Load order is alphabetical, and it bites

Apps Script evaluates project files in **alphabetical order**, not dependency order, so
`Claude.gs` runs before `Config.gs`. Anything built in a top-level `var` from Config's
globals (`CONFIG`, `CATEGORIES`, `MARKETS`, `TABS`, `*_HEADERS`) is `undefined` at load
time, and `JSON.stringify` drops undefined keys silently — this already shipped an API
schema with no `enum` constraints once.

- Build request schemas and anything else derived from Config **lazily, inside a
  function** (see `triageSchema_()` and `companyTool_()` in `src/Claude.gs`).
- `test/run_tests.py` loads `src/*.gs` alphabetically on purpose. Do not "fix" it into
  dependency order — that would hide this entire class of bug.

## Conventions

- A trailing underscore (`upsertApplication_`) marks a private function. Apps Script
  hides those from the editor's Run dropdown, so **only** the intended entry points
  lack one: `setup`, `onOpen`, `pollInbox`, `runBackfill`, `markStale`,
  `menuReEnrichSelected`, `menuReplaySelected`, `menuRescanSkipped`.
- ES5-flavoured V8: `var`, `function`, string concatenation. Match it.
- Everything reaching the Sheet originates in an email, so it is untrusted. Route it
  through `safeCell_()` (formula-injection prefix, control-char strip, length cap), and
  model free text additionally through `sanitizeProfile_()` / `looksDegenerate_()`.
- New Config knobs go in `src/Config.gs`, not inline.

## Deploying

Deployment is **manual copy-paste** into the Apps Script editor, one editor file per
`src/*.gs`. After changing files, say which ones need re-pasting.

- Re-pasting `src/Config.gs` reverts the user's settings to defaults — `DRY_RUN` back to
  `true` most notably. Call this out whenever `Config.gs` changes.
- Changing `POLL_MINUTES` requires re-running `setup()`, which recreates both triggers
  and clears the trigger's failure-notification setting.
- Adding an OAuth scope means `src/appsscript.json` must be re-pasted too, and the user
  re-authorizes.

## Testing

```bash
uv run python test/run_tests.py    # logic suite; needs Firefox present
uv run python tools/probe.py       # two REAL billed API calls
```

Python dependencies are managed with **uv** and committed (`pyproject.toml`, `uv.lock`).
Run the local tooling through `uv run`, not bare `python3`, and add any new dependency
with `uv add` so the lockfile stays in sync.

Ask before running either. `probe.py` costs money and needs `ANTHROPIC_API_KEY` in the
environment; it is only worth running when a request payload shape changed. It restates
the triage schema standalone, and `run_tests.py` fails if that copy drifts from
`src/Claude.gs` — update both together.

Only pure logic is testable locally. Anything touching Gmail, Sheets, or the API is
exercised in the Apps Script editor.

## Git

Branch and open a PR with `gh`; do not commit to `main`. Commit subjects are imperative
sentence-case describing the behaviour change, no type prefix — e.g. "Stop the backfill
re-queueing itself forever".

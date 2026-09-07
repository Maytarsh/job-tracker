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
  `menuReEnrichSelected`, `menuReplaySelected`, `menuRescanSkipped`,
  `menuEnrichMissing`, `menuCoverage`.
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

## A message must never be silently dropped

The failure this codebase is most prone to is losing mail quietly: the sheet looks
complete, and nothing anywhere says otherwise. Three rules hold the line.

- **The cursor may not pass anything unhandled.** `pollInbox` only advances
  `LAST_RUN_EPOCH` past a window with no failures in it, and rewinds to just before
  the oldest failure otherwise. A message that errors gets no `_Processed` row so it
  will be retried — advancing past it puts it outside every future window, in neither
  log, gone with no trace but a line in an execution log.
- **Stop before the 6-minute kill, not at it.** Everything is buffered in memory and
  written once by `flushBook_`, so a killed execution loses the whole run *and* the
  backfill's continuation trigger — the backfill then stops part-way and looks
  finished. `CONFIG.RUN_BUDGET_SECONDS` is the guard; anything slow added to the
  per-message path has to be checked against it.
- **Only the poll looks forward; only the backfill looks back.** A window that was
  never swept is indistinguishable from a window with no job mail in it. `menuCoverage`
  is what tells them apart — it reports the oldest message either log has examined.

## Spending

`callAnthropic_()` is the only place a request leaves the script, so the daily ceiling
is enforced there rather than at the call sites — a new menu item or self-healing pass
cannot spend past it by forgetting to ask. Every response is priced from its own
`usage` into `SPEND_USD`, which rolls over at UTC midnight.

The cost of a call is dominated by what the server tools drag into the conversation,
not by the prompt. A `web_fetch` without `max_content_tokens` puts a whole page in
context, where it is re-sent as input on every following turn of the tool loop — that
alone took one company's research from cents to dollars. Cap anything that can pull
unbounded content in, and check the `enriched …` log line, which prints tokens,
searches, fetches and the running daily total.

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

Branch and open a PR with `gh`; do not commit to `main`. Cut the branch **before the
first edit**, not at commit time — `.claude/hooks/require-branch.sh` refuses Write and
Edit on this repo's files while HEAD is the default branch, because the rule as prose
was read as being about commits alone. `git checkout -b <name>` carries uncommitted
work across, so being stopped costs nothing.

Commit subjects are imperative sentence-case describing the behaviour change, no type
prefix — e.g. "Stop the backfill re-queueing itself forever".

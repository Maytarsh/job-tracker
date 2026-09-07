# Job Application Tracker

Watches Gmail for job-application mail and maintains a Google Sheet of every company
you've applied to — what they do, what stage each application is at, and whether it's
still alive. Runs unattended in Google Apps Script; no server, nothing to install.

```
Time trigger (30 min) ─▶ pollInbox()
   collect  →  prefilter  →  triage (Haiku)  →  enrich (Opus + web search/fetch)  →  upsert
Daily trigger ────────▶ markStale()   Open + silent 30 days → Ghosted
```

## Layout

| | |
|---|---|
| `src/` | **Everything that goes into Apps Script.** Paste each file into the editor. |
| `tools/probe.py` | Validates both API payload shapes against the live API. Local only. |
| `test/` | Logic suite, run in headless Firefox. Local only. |

Only `src/` reaches Google. If you use [clasp](https://github.com/google/clasp), point
`rootDir` at `src`.

## Setup

1. **Create the Sheet.** New Google Sheet → **Extensions → Apps Script**. It must be
   created from inside the spreadsheet — a standalone project from script.google.com
   isn't bound to a Sheet and `setup()` will fail on `getActive()`.
2. **Add the files.** Create one editor file per `.gs` in `src/` and paste its contents.
   Project Settings → tick *Show `appsscript.json`*, then paste that too (it declares
   the OAuth scopes). Delete the default `Code.gs` stub. Naming the project something
   recognizable is worth it — the authorization dialog uses that name.
3. **Add your API key.** Project Settings (⚙️) → Script Properties → *Add script
   property*: `ANTHROPIC_API_KEY` = your key from console.anthropic.com → *Save*.
   It lives only there — never in the Sheet, so sharing the Sheet never leaks it.
4. **Run `setup()`.** Creates the four tabs, the formatting, and both triggers.
   - **Save first** (`Ctrl+S`). Until you do, the toolbar says *No functions* and Run
     is greyed out — the editor only re-scans on save. This looks exactly like a
     missing function and is the most common stumble.
   - Choose **`setup`** in the dropdown, then **▷ Run**. Only these seven appear:
     `setup`, `onOpen`, `pollInbox`, `runBackfill`, `markStale`, `menuReEnrichSelected`,
     `menuReplaySelected`. Everything else ends in `_`, Apps Script's private-function
     convention, and is hidden on purpose.
   - Authorize: *Review permissions* → your account → **"Google hasn't verified this
     app"** → **Advanced** → **Go to … (unsafe)** → **Allow**. Expected for any
     unpublished personal script.
   - Confirm in the ⏰ **Triggers** panel: `pollInbox` (30 min) and `markStale` (daily).
5. **Reload the spreadsheet.** The **Job Tracker** menu appears to the right of *Help*,
   a few seconds after load. If it doesn't show up, ignore it — every menu item is just
   a function you can run from the editor dropdown instead.
6. **Turn on failure alerts.** ⏰ Triggers → ⋮ on `pollInbox` → *Edit trigger* → bottom of
   the dialog → **Failure notification settings** → *Notify me immediately* → Save.

   Set once and it stays — editing code, re-pasting files, and normal trigger firings
   never disturb it. The one thing that clears it is **re-running `setup()`**, which
   deletes and recreates both triggers; the setting belongs to the trigger, not the
   code, and `ScriptApp.newTrigger()` has no API for it. So if you ever change
   `POLL_MINUTES` or rebuild the project, set it again afterwards.

   Worth doing, because the dangerous failure here is the quiet one: an expired API key
   months from now, with you assuming it's still tracking.

After setup the Sheet has `Applications` and `Companies`, plus `_Processed` and
`_Skipped` **hidden by design** (☰ *All sheets* at the bottom-left, or View → Hidden
sheets). Google's default `Sheet1` is still there and can be deleted; `setup()` won't
touch a sheet it didn't create.

## First run

`CONFIG.DRY_RUN` starts `true` — classify and log, write nothing.

1. **Run `runBackfill`** (menu, or the editor dropdown). Reads the last 30 days.
   This is separate from the 30-minute trigger, which only ever looks at the last
   half hour — the two `30`s in the config are unrelated.
2. Read the execution log. The last line is the run's stats:
   ```
   runBackfill: {"seen":120,"skipped":95,"triaged":25,"written":0,"errors":0,"hitLimit":true}
   ```
   - `errors` high, with `401` in the log → bad API key. A 401 isn't retried, so a
     wrong key fails fast and costs nothing.
   - `hitLimit: true` → more than `MAX_MESSAGES_PER_RUN` matched, so it **re-queues
     itself every ~60 seconds** until the window drains. Watch the **Executions** panel
     rather than clicking Run again.
3. Check the audit tabs:
   - **`_Skipped`** — dropped by the prefilter before costing anything. **This is the
     one that matters:** anything real in here is an application being silently lost.
     Add a pattern to `KEYWORD_PATTERNS` or a domain to `ATS_DOMAINS` in `Config.gs`.
   - **`_Processed`** — everything that reached the model. The `Evidence` column shows
     the phrase it based its call on, which is how you tell a misread from a genuinely
     ambiguous email.
4. Set `DRY_RUN = false` in `Config.gs` and run `runBackfill` again.

A dry run is a rehearsal, so its `_Processed` rows are marked `dry-run` and do **not**
count as handled — otherwise flipping the flag would leave every message already
"processed" and the real run would write nothing while reporting success. The first
run with `DRY_RUN = false` clears those rehearsal rows first and logs how many.

The 30-minute trigger keeps it current from then on.

## The Sheet

**`Applications`** — the point of the whole thing.

| Column | Filled by |
|---|---|
| Company, Role, Source / ATS, Job link, Location | extracted from the email |
| Market, Description | researched once per company, with real web search |
| Status | `Open` until a rejection arrives, then `Closed` |
| Stage | Applied → Screening → Interview → Offer → Rejected → Ghosted |
| Date applied, Last update | from the emails |
| Days quiet | formula, rewritten across every row each run; blank once closed |
| Email link | back to the original Gmail thread |
| Confidence | `low` = worth checking. Also set when a row match had to be guessed |
| **Notes** | **yours — the automation never reads or writes this column** |

Rows are kept sorted by **Last update**, newest first, so whatever an email just
touched is directly under the header. The sort runs at the end of every write, over
the whole table, so it also tidies rows that run never looked at — sorting the sheet
by hand is never needed, and any manual reordering is undone on the next run.

**`Companies`** caches one researched profile per company, so Opus is called once per
company ever. The Location from the email is passed into that research: a small
company's name on its own is often ambiguous, and the hiring location is usually what
separates it from the unrelated businesses sharing the name.

## Re-testing on real emails

No need to send yourself test mail — replay the ones you already have:

- **Job Tracker → Replay selected `_Processed` rows.** Deletes those rows and re-runs
  the backfill, so those real emails flow through the pipeline again. This is how you
  re-test a misclassified email against a tuned prompt.
- **Holdout.** Set `BACKFILL_HOLDOUT_DAYS = 3` before backfilling to leave the last few
  days untouched, then let the trigger pick them up on its own — exercising the
  incremental window, the dedupe set, and the trigger together on real mail.
- **Job Tracker → Coverage report** says how far back the tool has actually looked,
  how many rows are still missing a Market, and which companies were classified as
  applications but never made it into the table. Check it after a backfill: a window
  that was never swept looks exactly like a window with no job mail in it.
- **Job Tracker → Fill in missing company profiles** researches rows whose Market is
  blank because a run ran out of time. The poll does this on its own with whatever
  budget is left over; this is the impatient version.
- **Job Tracker → Re-research selected companies** re-runs enrichment for the selected
  rows if a Market or Description came out wrong. `MAX_ENRICH_PER_RUN` caps how many
  companies one click researches; past the cap it stops and says so, leaving the
  remaining rows untouched rather than blanking them.

Skipped mail is recorded by message ID, so a backfill window actually drains — without
that, every chunk re-collects the same non-job mail and the continuation trigger
re-queues itself forever. Reconsidering it after widening the prefilter is therefore an
explicit action: **Job Tracker → Rescan skipped mail**, then run the backfill again.

## Tuning

Everything lives in `src/Config.gs`:

| Setting | Default | |
|---|---|---|
| `DRY_RUN` | `true` | flip after the first clean backfill |
| `POLL_MINUTES` | 30 | how often the trigger runs; re-run `setup()` after changing |
| `BACKFILL_DAYS` | 30 | how far back history goes |
| `STALE_DAYS` | 30 | when an Open row becomes Ghosted |
| `MAX_MESSAGES_PER_RUN` | 50 | chunk size; backfill re-queues itself past this |
| `MAX_ENRICH_PER_RUN` | 15 | ceiling on Opus calls per execution |
| `MAX_BACKFILL_CHUNKS` | 40 | hard stop on backfill self-requeueing |

The prefilter is deliberately over-inclusive: a missed confirmation is a lost row,
while a false positive costs a fraction of a cent at triage.

`Config.gs` is the one file that holds *your* settings rather than just code, so
re-pasting it reverts everything above to the defaults — `DRY_RUN` back to `true` most
notably. Re-check it after any update.

Note that `DRY_RUN` does not make a run free. Triage is called on every candidate email
either way; the flag only skips the sheet write and the company enrichment that follows
it. Rehearsing and then running for real pays for triage twice, so it is worth doing
only when you have changed something that affects classification — the prefilter
patterns or the triage prompt — and want to see the new output before it reaches
`Applications`.

## Cost

Enrichment takes about 90 seconds per company, so a run does at most
`MAX_ENRICH_PER_RUN` of them and stops researching entirely once it is within
`ENRICH_RESERVE_SECONDS` of its budget. Rows left with a blank Market are filled in by
later polls. This is deliberate: an execution killed at Apps Script's 6-minute ceiling
loses everything it had buffered, including the backfill's continuation trigger.

Triage is `claude-haiku-4-5` per candidate email; enrichment is `claude-sonnet-5` with
web search and web fetch, once per company — roughly $0.17 a company, most of it the
search results being re-sent on each turn of the tool loop.

`CONFIG.DAILY_BUDGET_USD` is the backstop: every response is priced from its own usage
into a daily total, and `callAnthropic_()` refuses to send anything once the day is over
budget. Any model named in Config needs an entry in `PRICE_PER_MTOK`, or its calls are
priced at zero and the ceiling never sees them. Expect a few dollars for the initial backfill (mostly
one-time enrichment), then pennies per day. `tools/probe.py` prints real numbers.

## Development

Python dependencies are managed with [uv](https://docs.astral.sh/uv/) and committed, so
there is nothing to install by hand — `uv run` builds the environment from `uv.lock` on
first use.

```bash
uv run python tools/probe.py [Company] [Location]   # one real triage + one real enrich
uv run python test/run_tests.py          # logic suite (needs Firefox)
```

Run `probe.py` before porting any API change — it validates the payload shapes outside
the Apps Script editor, where iteration is slow. It restates the triage schema so it
can run standalone; the test suite fails if that copy drifts from `src/Claude.gs`.

`run_tests.py` loads `src/*.gs` **alphabetically**, which is the order Apps Script
itself evaluates project files in — not dependency order. That matters: `Claude.gs`
loads before `Config.gs`, so anything built at load time from Config's variables gets
`undefined`, and `JSON.stringify` drops undefined keys without error. That silently
shipped an API schema with no `enum` constraints once. Both request schemas are now
built lazily inside functions, and there are regression tests for it. **Keep the test
harness in alphabetical order** — sorting it by dependency would hide the whole class
of bug.

## Untrusted input

Every value in the Sheet originates in an email, or in a model's reading of one, so all
of it is treated as attacker-influenceable:

- **Formula injection.** Sheets evaluates a cell starting with `=`, `+`, `-` or `@`, so
  a crafted company name could run `HYPERLINK`/`IMPORTXML` in your spreadsheet.
  `safeCell_()` prefixes an apostrophe to force those to stay text, strips control
  characters, and caps length.
- **Prompt injection.** The company name, location and job URL passed to the enrichment
  call were extracted from an email. They are fenced in markers and the model is told the content
  is untrusted data to look up, not instructions to follow.
- **Degenerate output.** `strict: true` guarantees the *shape* of the enrichment result,
  never the sanity of its free text. `sanitizeProfile_()` rejects descriptions
  containing markup or tool-call fragments, and falls back to `Unknown` plus an
  actionable placeholder rather than writing garbage into a column you read daily.
  An off-vocabulary Market falls back the same way, keeping the column filterable.

## Limits

Well inside the free Apps Script quotas (20k URL fetches/day, 90 min runtime/day).
Gmail access is read-only — the script never sends, labels, or deletes anything.
Recruiter outreach and job-board mail are classified but deliberately kept out of
`Applications`; they're visible in `_Processed` if you want them.

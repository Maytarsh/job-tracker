# Job Application Tracker

Watches Gmail for job-application mail and maintains a Google Sheet of every company
you've applied to — what they do, what stage each application is at, and whether it's
still alive. Runs unattended in Google Apps Script; nothing to install, no server.

```
Time trigger (30 min) ─▶ pollInbox()
   collect  →  prefilter  →  triage (Haiku)  →  enrich (Opus + web search)  →  upsert
Daily trigger ────────▶ markStale()   Open + silent 30 days → Ghosted
```

## Setup

1. **Create the Sheet.** New Google Sheet → Extensions → Apps Script.
2. **Add the files.** In the editor, create one file per `.gs` here and paste its
   contents. Project Settings → tick *Show `appsscript.json`*, then paste that too
   (it declares the OAuth scopes).
3. **Add your API key.** Project Settings → Script Properties → Add:
   `ANTHROPIC_API_KEY` = your key from console.anthropic.com.
   It lives only there — never in the Sheet, so sharing the Sheet never leaks it.
4. **Run `setup()`.** Pick it from the function dropdown and Run. Google will ask you
   to authorize Gmail (read-only), Sheets, external requests, and triggers. This
   creates the four tabs, the formatting, and both triggers.
5. **Reload the Sheet.** A **Job Tracker** menu appears.

## First run

`CONFIG.DRY_RUN` starts `true` — classify and log, write nothing.

1. **Job Tracker → Backfill history.** Reads the last 30 days.
2. Check the two hidden audit tabs (right-click the tab bar → unhide):
   - **`_Skipped`** — dropped by the prefilter before costing anything. Any real
     confirmation in here is a miss: add a pattern to `KEYWORD_PATTERNS` or a domain
     to `ATS_DOMAINS` in `Config.gs`.
   - **`_Processed`** — everything that reached the model, with the `Evidence` column
     showing the phrase it decided on. That column is how you tell a misread from a
     genuinely ambiguous email.
3. Set `DRY_RUN = false` in `Config.gs`, then **Backfill history** again.

From then on the 30-minute trigger keeps it current.

## The Sheet

**`Applications`** — the point of the whole thing.

| Column | Filled by |
|---|---|
| Company, Role, Source / ATS, Job link, Location | extracted from the email |
| Market, Description | researched once per company, with real web search |
| Status | `Open` until a rejection arrives, then `Closed` |
| Stage | Applied → Screening → Interview → Offer → Rejected → Ghosted |
| Date applied, Last update | from the emails |
| Days quiet | formula; blank once closed |
| Email link | back to the original Gmail thread |
| Confidence | `low` = worth checking. Also set when a row match had to be guessed |
| **Notes** | **yours — the automation never reads or writes this column** |

**`Companies`** caches one researched profile per company, so Opus is called once per
company ever. **`_Processed`** and **`_Skipped`** are the audit trail, hidden by default.

## Re-testing on real emails

No need to send yourself test mail — replay the ones you already have:

- **Job Tracker → Replay selected `_Processed` rows.** Deletes those rows and re-runs the
  backfill, so those real emails flow through the whole pipeline again. This is how you
  re-test a misclassified email against a tuned prompt.
- **Holdout.** Set `BACKFILL_HOLDOUT_DAYS = 3` before backfilling to leave the last few
  days untouched, then let the trigger pick them up on its own — that exercises the
  incremental path, the dedupe set, and the trigger together on real mail.
- **Job Tracker → Re-research selected companies** re-runs enrichment for the selected
  rows if a Market or Description came out wrong.

## Tuning

Everything lives in `Config.gs`:

| Setting | Default | |
|---|---|---|
| `DRY_RUN` | `true` | flip after the first clean backfill |
| `POLL_MINUTES` | 30 | re-run `setup()` after changing |
| `STALE_DAYS` | 30 | when an Open row becomes Ghosted |
| `BACKFILL_DAYS` | 30 | how far back history goes |
| `MAX_MESSAGES_PER_RUN` | 50 | chunk size; backfill re-queues itself past this |
| `MAX_ENRICH_PER_RUN` | 15 | ceiling on Opus calls per execution |

The prefilter is deliberately over-inclusive: a missed confirmation is a lost row,
while a false positive costs a fraction of a cent at triage.

## Cost

Triage is `claude-haiku-4-5` on each candidate email; enrichment is `claude-opus-5`
with web search, once per company. Expect a few dollars for the initial backfill
(mostly one-time enrichment) and pennies per day after. `probe.py` prints the real
per-call numbers.

## Development

- `python3 probe.py [Company]` — sends one real triage and one real enrichment request,
  printing the parsed result, token usage and projected cost. Run this first: it
  validates both payload shapes outside the Apps Script editor, where iteration is slow.
- `python3 test/run_tests.py` — runs `test/logic_tests.js` against the `.gs` sources in
  headless Firefox with the Google services stubbed, covering normalization,
  prefiltering, body cleaning, stage transitions and the upsert/matching rules.
  Needs `pip install selenium` and Firefox.

## Limits

Well inside the free Apps Script quotas (20k URL fetches/day, 90 min runtime/day).
Gmail access is read-only — the script never sends, labels, or deletes anything.
Inbound recruiter outreach and job-board mail are classified but deliberately kept out
of `Applications`; they're visible in `_Processed` if you want them.

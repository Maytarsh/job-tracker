/**
 * Sheet.gs — all spreadsheet state.
 *
 * Everything is loaded once, mutated in memory, and flushed in batched writes.
 * Per-cell writes are the usual reason an Apps Script run hits the 6-minute cap.
 */

// Applications column indices (0-based, must match APP_HEADERS).
var A_COMPANY = 0, A_ROLE = 1, A_MARKET = 2, A_DESC = 3, A_STATUS = 4,
    A_STAGE = 5, A_APPLIED = 6, A_UPDATED = 7, A_QUIET = 8, A_ATS = 9,
    A_JOB_URL = 10, A_LOCATION = 11, A_EMAIL = 12, A_CONF = 13, A_NOTES = 14,
    A_ACCOUNT = 15;

// Stage ordering, so an out-of-order email can never move a row backwards.
var STAGE_RANK = { 'Applied': 1, 'Screening': 2, 'Interview': 3, 'Offer': 4 };

/**
 * Neutralise a value before it reaches a cell.
 *
 * Every string we write originates in an email or a model's reading of one, so
 * it is untrusted. Two concrete hazards:
 *  - Sheets evaluates a cell beginning = + - @ as a formula, so a crafted
 *    company name could execute HYPERLINK/IMPORTXML in the sheet. A leading
 *    apostrophe forces it to stay text.
 *  - Degenerate model output (markup fragments, runaway length) otherwise
 *    lands verbatim in a column you read every day.
 */
function safeCell_(value, maxLen) {
  if (value === '' || value === null || value === undefined) return '';
  if (value instanceof Date || typeof value === 'number') return value;

  var text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return '';

  var cap = maxLen || 500;
  if (text.length > cap) text = text.substring(0, cap - 1) + '…';
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return text;
}

/** Markup fragments and tool-call scaffolding leaking out of a bad generation. */
function looksDegenerate_(text) {
  if (!text) return false;
  return /<\/?[a-z_:]+[^>]*>|parameter name=|antml|\bfunction_calls\b/i.test(text);
}

/** Free text from the model, or nothing. Every string field goes through this. */
function cleanField_(value) {
  var text = String(value || '');
  return looksDegenerate_(text) ? '' : text;
}

/**
 * A schema guarantees the shape of the enrichment result, never the sanity of
 * its free text. Drop anything that came back malformed rather than writing it.
 *
 * Every string field, not a chosen few: hq_location, employee_range and
 * founded_year were once passed through raw on the assumption that a short,
 * factual-sounding field could not come back as scaffolding. One did —
 * "</p…" landed in Founded, truncated to ten characters by safeCell_ and
 * looking for all the world like a parsing quirk. A schema constrains shape,
 * never content, so nothing the model writes is exempt from this.
 */
function sanitizeProfile_(profile) {
  if (!profile) return null;

  var market = String(profile.market || '');
  if (MARKETS.indexOf(market) === -1) market = 'Unknown';

  var description = String(profile.description || '');
  if (looksDegenerate_(description) || description.length < 10) {
    market = 'Unknown';
    description = 'Enrichment returned unusable output — re-run from the menu.';
  }

  return {
    market: market,
    sub_market: cleanField_(profile.sub_market),
    description: description,
    website: cleanField_(profile.website),
    hq_location: cleanField_(profile.hq_location),
    employee_range: cleanField_(profile.employee_range),
    founded_year: cleanField_(profile.founded_year)
  };
}

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error('Missing tab "' + name + '". Run setup() first.');
  return sheet;
}

/**
 * Returned by withBookLock_ when the lock was already held. A sentinel object
 * rather than null, which several of these entry points return on their own.
 */
var LOCK_BUSY = { lockBusy: true };

/**
 * Serialise everything that reads the book and writes it back.
 *
 * openBook_ loads the whole table into memory and flushBook_ writes it out
 * again, appending at getLastRow() + 1. Two mailboxes polling the same
 * spreadsheet at the same moment therefore read the same table and the second
 * flush writes its stale copy over the first one's rows and its appends over
 * the first one's appends — rows that existed a second ago, gone, with both
 * executions logging success. One script-wide lock held across the whole
 * read-modify-write is the only thing that prevents it.
 *
 * tryLock(0), not waitLock: RUN_BUDGET_SECONDS is measured against the
 * 6-minute kill, and queueing spends exactly the budget the run needs to
 * finish and flush. Giving up costs nothing as long as the caller leaves its
 * cursor alone — the window stays unswept and the next poll sweeps it — which
 * is why the bail-out happens out here, before any cursor is touched.
 */
function withBookLock_(what, fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log(what + ': another run holds the lock, skipping this one. ' +
               'No cursor moved, so the window is swept by the next run.');
    return LOCK_BUSY;
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Load the whole workbook state into one object. */
function openBook_() {
  var appSheet = getSheet_(TABS.APPLICATIONS);
  var last = appSheet.getLastRow();
  var rows = last > 1
    ? appSheet.getRange(2, 1, last - 1, APP_HEADERS.length).getValues()
    : [];

  return {
    appSheet: appSheet,
    rows: rows,
    dirty: {},
    appended: [],
    companies: loadCompanyCache_(),
    newCompanies: [],
    processed: [],
    skipped: [],
    enrichCount: 0
  };
}

/**
 * One flush per run: changed rows, then every append, then the reorder and the
 * derived column.
 *
 * The per-row assignment below is not redundant with refreshQuietColumn_: getValues()
 * returns a formula cell's computed *value*, so a row loaded from the sheet carries
 * the number 0.32, and writing it back unchanged would replace the formula with it.
 *
 * This has to stay the last thing a run writes to Applications. The sort moves
 * rows about, so every index in book.rows and book.dirty points somewhere else
 * afterwards — a second flush in the same run would write rows over each other.
 */
function flushBook_(book) {
  var width = APP_HEADERS.length;

  Object.keys(book.dirty).forEach(function (i) {
    var idx = Number(i);
    var row = book.rows[idx];
    row[A_QUIET] = quietFormula_(idx + 2);
    book.appSheet.getRange(idx + 2, 1, 1, width).setValues([row]);
  });

  if (book.appended.length) {
    var startRow = book.appSheet.getLastRow() + 1;
    for (var n = 0; n < book.appended.length; n++) {
      book.appended[n][A_QUIET] = quietFormula_(startRow + n);
    }
    book.appSheet.getRange(startRow, 1, book.appended.length, width)
      .setValues(book.appended);
  }

  // Sort first, then rewrite the formulas. Sorting drags the Days quiet cells
  // along with their rows and re-points their row references on the way, which
  // does not matter only because refreshQuietColumn_ writes that column out
  // wholesale immediately after.
  sortByLastUpdate_(book.appSheet);
  refreshQuietColumn_(book.appSheet);
  appendRows_(TABS.COMPANIES, book.newCompanies);
  appendRows_(TABS.PROCESSED, book.processed);
  appendRows_(TABS.SKIPPED, book.skipped);
}

function appendRows_(tabName, rows) {
  if (!rows || !rows.length) return;
  var sheet = getSheet_(tabName);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length)
    .setValues(rows);
}

/**
 * Newest activity first, so anything an email just touched is at the top.
 *
 * Done as a sort of the whole table rather than by moving the rows that changed:
 * one batched call instead of one per row, and it reaches rows this run never
 * loaded — so the ordering also settles the existing sheet on the first run,
 * with no migration to write and nothing to remember to remove afterwards.
 *
 * Rows with an empty Last update sink to the bottom, which is where Sheets puts
 * blanks in a descending sort and where a row nothing has happened to belongs.
 */
function sortByLastUpdate_(sheet) {
  var last = sheet.getLastRow();
  if (last < 3) return;  // header plus at most one row: nothing to reorder
  sheet.getRange(2, 1, last - 1, APP_HEADERS.length)
    .sort({ column: A_UPDATED + 1, ascending: false });
}

/**
 * Rewrite Days quiet across every row, not just the ones being written.
 *
 * The column is derived state the automation owns outright — nothing a person types
 * there survives a flush anyway — so writing it wholesale costs one batched call and
 * means a change to quietFormula_ reaches every existing row on the next run, rather
 * than waiting for an email to touch each one individually.
 */
function refreshQuietColumn_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return;

  var formulas = [];
  for (var row = 2; row <= last; row++) formulas.push([quietFormula_(row)]);
  sheet.getRange(2, A_QUIET + 1, formulas.length, 1).setValues(formulas);
}

/**
 * Blank while Closed or undated, so the column only shows what's actually waiting.
 *
 * INT() around the timestamp because Last update carries the email's time of day
 * while TODAY() is midnight — subtracting them directly renders 0.3251041 instead
 * of a day count.
 */
function quietFormula_(rowNumber) {
  return '=IF(OR($E' + rowNumber + '="Closed",$H' + rowNumber + '=""),"",' +
         'TODAY()-INT($H' + rowNumber + '))';
}

/**
 * Strip legal suffixes and punctuation so "Wiz, Inc." and "Wiz" are one company.
 *
 * The domain suffix goes too: an ATS mails as "Sedric.ai" while a recruiter
 * writes "Sedric", and without this those are two keys, so findRow_ never
 * merges them and the company gets two rows. It has to run before punctuation
 * is flattened — the trailing dot is the only thing that tells a domain from a
 * word, and "Cato Networks" must stay distinct from "Cato".
 */
function normalizeCompany_(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\.(ai|io|com|co|net|org|dev|app|xyz)$/, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(inc|ltd|limited|llc|corp|corporation|gmbh|bv|sa|ag|plc|technologies|technology|software|systems|solutions|labs|israel|group|holdings)\b/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

function normalizeRole_(role) {
  return String(role || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---------------------------------------------------------------- companies

function loadCompanyCache_() {
  var sheet = getSheet_(TABS.COMPANIES);
  var last = sheet.getLastRow();
  var cache = {};
  if (last < 2) return cache;

  var values = sheet.getRange(2, 1, last - 1, COMPANY_HEADERS.length).getValues();
  values.forEach(function (r) {
    if (r[0]) cache[r[0]] = { market: r[2], sub_market: r[3], description: r[4] };
  });
  return cache;
}

/**
 * Look the company up in the cache; research it only if it's genuinely new.
 * Failures are cached as Unknown too — one bad lookup shouldn't re-bill the
 * enrichment model on every subsequent email from that company.
 */
function companyProfile_(book, companyName, hintUrl, locationHint) {
  var key = normalizeCompany_(companyName);
  if (!key) return { market: '', description: '' };
  if (book.companies[key]) return book.companies[key];
  if (book.enrichCount >= CONFIG.MAX_ENRICH_PER_RUN) {
    return { market: '', description: '' };  // picked up on a later run
  }
  if (!enrichBudgetLeft_(book)) {
    return { market: '', description: '' };  // ditto — see fillMissingProfiles_
  }

  var profile;
  try {
    book.enrichCount++;
    profile = sanitizeProfile_(enrichCompany_(companyName, hintUrl, locationHint));
  } catch (err) {
    Logger.log('enrich failed for ' + companyName + ': ' + err);
    profile = null;
  }
  if (!profile) {
    profile = {
      market: 'Unknown', sub_market: '', description: 'Enrichment failed — re-run from the menu.',
      website: '', hq_location: '', employee_range: '', founded_year: ''
    };
  }

  book.companies[key] = profile;
  book.newCompanies.push([
    key, safeCell_(companyName, 120), safeCell_(profile.market, 40),
    safeCell_(profile.sub_market, 120), safeCell_(profile.description, 600),
    safeCell_(profile.website, 200), safeCell_(profile.hq_location, 120),
    safeCell_(profile.employee_range, 40), safeCell_(profile.founded_year, 10),
    new Date()
  ]);
  return profile;
}

/**
 * Is there time to start another? Research takes roughly a minute and a half —
 * search, fetch, and a model that thinks — so starting one near the end of the
 * budget is how a run gets killed with its whole buffer still in memory.
 */
function enrichBudgetLeft_(book) {
  if (!book.deadline) return true;
  return Date.now() < book.deadline - CONFIG.ENRICH_RESERVE_SECONDS * 1000;
}

/**
 * Spend whatever budget is left on rows whose Market never got filled in.
 *
 * A run under time pressure writes the row and leaves the profile blank. Before
 * this existed, that blank was only ever filled if another email from the same
 * company happened to arrive later — so a one-off application stayed blank
 * forever. Now every poll picks up where the last one ran out, and the sheet
 * completes itself over a few cycles without anyone doing anything.
 */
function fillMissingProfiles_(book) {
  if (CONFIG.DRY_RUN) return 0;

  var targets = [];
  book.rows.forEach(function (row, i) {
    if (!row[A_MARKET] && row[A_COMPANY]) targets.push({ row: row, index: i });
  });
  book.appended.forEach(function (row) {
    // Appended rows flush as inserts, so they are mutated but never marked dirty.
    if (!row[A_MARKET] && row[A_COMPANY]) targets.push({ row: row, index: -1 });
  });

  var filled = 0;
  for (var t = 0; t < targets.length; t++) {
    if (!enrichBudgetLeft_(book)) break;
    var row = targets[t].row;
    var profile = companyProfile_(book, row[A_COMPANY], row[A_JOB_URL], row[A_LOCATION]);
    if (!profile.market && !profile.description) break;  // hit the cap or the clock
    row[A_MARKET] = safeCell_(profile.market, 40);
    row[A_DESC] = safeCell_(profile.description, 600);
    if (targets[t].index >= 0) book.dirty[targets[t].index] = true;
    filled++;
  }

  if (filled) Logger.log('filled ' + filled + ' missing company profile(s)');
  return filled;
}

// ------------------------------------------------------------------- upsert

/**
 * Locate the row this email belongs to.
 *
 * An exact role match always wins. Falling back to "the company's open row" is
 * only safe when the email doesn't name a role (rejections often don't) — doing
 * it for a confirmation that names a *different* role would merge two genuinely
 * separate applications into one.
 *
 * "The company's open row" means the most recently updated one, compared by
 * date rather than taken as the last one seen: the sheet is sorted newest-first
 * now, so position on it says the opposite of what it used to.
 *
 * Returns {list, i, exact} where list is 'rows' (already on the sheet) or
 * 'appended' (created earlier in this same run); those flush differently, so a
 * row created and then updated within one run must not be written twice.
 */
function findRow_(book, companyKey, role, allowFallback) {
  var roleKey = normalizeRole_(role);
  var open = null;
  var openUpdated = -1;
  var lists = ['rows', 'appended'];

  for (var l = 0; l < lists.length; l++) {
    var list = book[lists[l]];
    for (var i = 0; i < list.length; i++) {
      if (normalizeCompany_(list[i][A_COMPANY]) !== companyKey) continue;
      if (roleKey && normalizeRole_(list[i][A_ROLE]) === roleKey) {
        return { list: lists[l], i: i, exact: true };
      }
      if (!roleKey && !list[i][A_ROLE]) {
        return { list: lists[l], i: i, exact: true };
      }
      if (list[i][A_STATUS] === 'Open' && rowUpdatedTime_(list[i]) >= openUpdated) {
        open = { list: lists[l], i: i, exact: false };
        openUpdated = rowUpdatedTime_(list[i]);
      }
    }
  }
  return allowFallback ? open : null;  // most recent open row, or nothing
}

/** Last update as a comparable number, 0 when it is missing or unreadable. */
function rowUpdatedTime_(row) {
  var value = row[A_UPDATED];
  if (!value) return 0;
  var time = (value instanceof Date ? value : new Date(value)).getTime();
  return isNaN(time) ? 0 : time;
}

function stageFromTriage_(triage) {
  if (triage.category === 'rejection') return 'Rejected';
  if (triage.category === 'offer') return 'Offer';
  if (triage.category === 'application_confirmation') return 'Applied';
  if (triage.stage_hint === 'screening') return 'Screening';
  if (triage.stage_hint === 'offer') return 'Offer';
  return 'Interview';
}

/** Highest stage wins, so a late-arriving confirmation can't undo an interview. */
function mergeStage_(current, incoming) {
  if (incoming === 'Rejected') return 'Rejected';
  if (current === 'Rejected') return 'Rejected';
  var a = STAGE_RANK[current] || 0;
  var b = STAGE_RANK[incoming] || 0;
  return b > a ? incoming : (current || incoming);
}

/**
 * Apply one triaged email to the Applications tab.
 * Returns a short description of what happened, for the _Processed log.
 */
function upsertApplication_(book, triage, msg) {
  var companyKey = normalizeCompany_(triage.company);
  if (!companyKey) return 'skipped: no company';

  var stage = stageFromTriage_(triage);
  var closed = (triage.category === 'rejection');
  // A confirmation naming a new role is a new application, never a merge.
  var allowFallback = !normalizeRole_(triage.role) ||
                      triage.category !== 'application_confirmation';
  var hit = findRow_(book, companyKey, triage.role, allowFallback);

  if (hit) {
    var row = book[hit.list][hit.i];
    row[A_STAGE] = mergeStage_(row[A_STAGE], stage);
    row[A_STATUS] = closed ? 'Closed' : row[A_STATUS];
    row[A_UPDATED] = msg.date;
    if (!row[A_ROLE] && triage.role) row[A_ROLE] = safeCell_(triage.role, 200);
    if (!row[A_APPLIED] && triage.category === 'application_confirmation') {
      row[A_APPLIED] = msg.date;
    }
    if (!row[A_JOB_URL] && triage.job_url) row[A_JOB_URL] = safeCell_(triage.job_url, 500);
    if (!row[A_LOCATION] && triage.location) row[A_LOCATION] = safeCell_(triage.location, 120);
    if (!row[A_ATS] && triage.source_ats) row[A_ATS] = safeCell_(triage.source_ats, 60);
    if (!row[A_MARKET]) {
      var refreshed = companyProfile_(book, triage.company, triage.job_url, triage.location);
      row[A_MARKET] = safeCell_(refreshed.market, 40);
      row[A_DESC] = safeCell_(refreshed.description, 600);
    }
    row[A_EMAIL] = threadUrl_(msg.threadId);
    // The mailbox that last moved this row, matching Email link beside it. Not
    // a list of every account that ever touched it: the column exists so a row
    // can be traced back to the inbox it came from, and the link only ever
    // points at one of them.
    row[A_ACCOUNT] = safeCell_(mailboxEmail_(), 120);
    // A guessed row match is worth auditing even if the extraction was clean.
    row[A_CONF] = hit.exact ? triage.confidence : 'low';
    // Rows in `appended` have not been written yet — they flush as inserts,
    // so marking them dirty would write them a second time.
    if (hit.list === 'rows') book.dirty[hit.i] = true;
    return 'updated ' + row[A_COMPANY] + ' -> ' + row[A_STAGE] + '/' + row[A_STATUS];
  }

  var profile = companyProfile_(book, triage.company, triage.job_url, triage.location);
  var fresh = new Array(APP_HEADERS.length).fill('');
  fresh[A_COMPANY] = safeCell_(triage.company, 120);
  fresh[A_ROLE] = safeCell_(triage.role, 200);
  fresh[A_MARKET] = safeCell_(profile.market, 40);
  fresh[A_DESC] = safeCell_(profile.description, 600);
  fresh[A_STATUS] = closed ? 'Closed' : 'Open';
  fresh[A_STAGE] = stage;
  fresh[A_APPLIED] = (triage.category === 'application_confirmation') ? msg.date : '';
  fresh[A_UPDATED] = msg.date;
  fresh[A_ATS] = safeCell_(triage.source_ats, 60);
  fresh[A_JOB_URL] = safeCell_(triage.job_url, 500);
  fresh[A_LOCATION] = safeCell_(triage.location, 120);
  fresh[A_EMAIL] = threadUrl_(msg.threadId);
  fresh[A_CONF] = triage.confidence;
  fresh[A_ACCOUNT] = safeCell_(mailboxEmail_(), 120);
  // findRow_ searches `appended` too, so a second email for the same company
  // later in this run updates this row instead of creating a duplicate.
  book.appended.push(fresh);
  return 'created ' + triage.company + ' / ' + (triage.role || '(no role)');
}

/**
 * Every message already examined — triaged *or* skipped by the prefilter.
 *
 * Skipped messages must be recorded too. If they aren't, each backfill chunk
 * re-collects the same non-job mail, never drains the window, and re-queues
 * itself forever. Reconsidering skipped mail after a prefilter change is an
 * explicit action instead: Job Tracker -> Rescan skipped mail.
 *
 * Dry-run rows are excluded: a rehearsal must not consume the messages it only
 * pretended to handle, or flipping DRY_RUN off would leave nothing to do.
 */
function loadProcessedIds_() {
  var seen = {};

  var processed = getSheet_(TABS.PROCESSED);
  var lastP = processed.getLastRow();
  if (lastP > 1) {
    processed.getRange(2, 1, lastP - 1, PROCESSED_HEADERS.length).getValues()
      .forEach(function (r) {
        if (r[0] && !isRetryable_(r[P_ACTION])) seen[r[0]] = true;
      });
  }

  var skipped = getSheet_(TABS.SKIPPED);
  var lastS = skipped.getLastRow();
  if (lastS > 1) {
    skipped.getRange(2, 1, lastS - 1, 1).getValues().forEach(function (r) {
      if (r[0]) seen[r[0]] = true;
    });
  }
  return seen;
}

/**
 * Actions that mean the message was not actually dealt with.
 *
 * A rehearsal pretended to handle it. A row whose upsert threw was classified —
 * and billed — but never reached the sheet, and used to count as done anyway,
 * so the only trace of the loss was one line in an execution log nobody reads.
 * Both get another attempt; the failed row stays in the log as a record.
 *
 * "failed:" is deliberately not in here. That marks a message whose response
 * could not be parsed, which will happen again on every retry — reconsidering
 * it forever would stop the window draining. The coverage report counts those
 * instead, so they are visible rather than silently retried or silently gone.
 */
function isRetryable_(action) {
  var text = String(action || '');
  return text === DRY_RUN_ACTION || text.indexOf('error:') === 0;
}

/** Forget skipped mail so a widened prefilter can reconsider it. */
function clearSkipped_() {
  var sheet = getSheet_(TABS.SKIPPED);
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  sheet.getRange(2, 1, last - 1, SKIPPED_HEADERS.length).clearContent();
  return last - 1;
}

/**
 * Drop rehearsal rows once we start writing for real, so _Processed stays a
 * true record of what was acted on and repeated dry runs can't pile up.
 */
function purgeDryRunRows_() {
  var sheet = getSheet_(TABS.PROCESSED);
  var last = sheet.getLastRow();
  if (last < 2) return 0;

  var width = PROCESSED_HEADERS.length;
  var values = sheet.getRange(2, 1, last - 1, width).getValues();
  var keep = values.filter(function (r) { return r[P_ACTION] !== DRY_RUN_ACTION; });
  if (keep.length === values.length) return 0;

  sheet.getRange(2, 1, values.length, width).clearContent();
  if (keep.length) sheet.getRange(2, 1, keep.length, width).setValues(keep);
  return values.length - keep.length;
}

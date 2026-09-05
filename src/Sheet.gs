/**
 * Sheet.gs — all spreadsheet state.
 *
 * Everything is loaded once, mutated in memory, and flushed in batched writes.
 * Per-cell writes are the usual reason an Apps Script run hits the 6-minute cap.
 */

// Applications column indices (0-based, must match APP_HEADERS).
var A_COMPANY = 0, A_ROLE = 1, A_MARKET = 2, A_DESC = 3, A_STATUS = 4,
    A_STAGE = 5, A_APPLIED = 6, A_UPDATED = 7, A_QUIET = 8, A_ATS = 9,
    A_JOB_URL = 10, A_LOCATION = 11, A_EMAIL = 12, A_CONF = 13, A_NOTES = 14;

// Stage ordering, so an out-of-order email can never move a row backwards.
var STAGE_RANK = { 'Applied': 1, 'Screening': 2, 'Interview': 3, 'Offer': 4 };

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error('Missing tab "' + name + '". Run setup() first.');
  return sheet;
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

/** One flush per run: changed rows, then every append. */
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

/** Blank while Closed or undated, so the column only shows what's actually waiting. */
function quietFormula_(rowNumber) {
  return '=IF(OR($E' + rowNumber + '="Closed",$H' + rowNumber + '=""),"",' +
         'TODAY()-$H' + rowNumber + ')';
}

/** Strip legal suffixes and punctuation so "Wiz, Inc." and "Wiz" are one company. */
function normalizeCompany_(name) {
  return String(name || '')
    .toLowerCase()
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
 * Failures are cached as Unknown too — one bad lookup shouldn't re-bill Opus
 * on every subsequent email from that company.
 */
function companyProfile_(book, companyName, hintUrl) {
  var key = normalizeCompany_(companyName);
  if (!key) return { market: '', description: '' };
  if (book.companies[key]) return book.companies[key];
  if (book.enrichCount >= CONFIG.MAX_ENRICH_PER_RUN) {
    return { market: '', description: '' };  // picked up on a later run
  }

  var profile;
  try {
    book.enrichCount++;
    profile = enrichCompany_(companyName, hintUrl);
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
    key, companyName, profile.market, profile.sub_market, profile.description,
    profile.website, profile.hq_location, profile.employee_range,
    profile.founded_year, new Date()
  ]);
  return profile;
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
 * Returns {list, i, exact} where list is 'rows' (already on the sheet) or
 * 'appended' (created earlier in this same run); those flush differently, so a
 * row created and then updated within one run must not be written twice.
 */
function findRow_(book, companyKey, role, allowFallback) {
  var roleKey = normalizeRole_(role);
  var open = null;
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
      if (list[i][A_STATUS] === 'Open') {
        open = { list: lists[l], i: i, exact: false };
      }
    }
  }
  return allowFallback ? open : null;  // most recent open row, or nothing
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
    if (!row[A_ROLE] && triage.role) row[A_ROLE] = triage.role;
    if (!row[A_APPLIED] && triage.category === 'application_confirmation') {
      row[A_APPLIED] = msg.date;
    }
    if (!row[A_JOB_URL] && triage.job_url) row[A_JOB_URL] = triage.job_url;
    if (!row[A_LOCATION] && triage.location) row[A_LOCATION] = triage.location;
    if (!row[A_ATS] && triage.source_ats) row[A_ATS] = triage.source_ats;
    if (!row[A_MARKET]) {
      var refreshed = companyProfile_(book, triage.company, triage.job_url);
      row[A_MARKET] = refreshed.market;
      row[A_DESC] = refreshed.description;
    }
    row[A_EMAIL] = threadUrl_(msg.threadId);
    // A guessed row match is worth auditing even if the extraction was clean.
    row[A_CONF] = hit.exact ? triage.confidence : 'low';
    // Rows in `appended` have not been written yet — they flush as inserts,
    // so marking them dirty would write them a second time.
    if (hit.list === 'rows') book.dirty[hit.i] = true;
    return 'updated ' + row[A_COMPANY] + ' -> ' + row[A_STAGE] + '/' + row[A_STATUS];
  }

  var profile = companyProfile_(book, triage.company, triage.job_url);
  var fresh = new Array(APP_HEADERS.length).fill('');
  fresh[A_COMPANY] = triage.company;
  fresh[A_ROLE] = triage.role;
  fresh[A_MARKET] = profile.market;
  fresh[A_DESC] = profile.description;
  fresh[A_STATUS] = closed ? 'Closed' : 'Open';
  fresh[A_STAGE] = stage;
  fresh[A_APPLIED] = (triage.category === 'application_confirmation') ? msg.date : '';
  fresh[A_UPDATED] = msg.date;
  fresh[A_ATS] = triage.source_ats;
  fresh[A_JOB_URL] = triage.job_url;
  fresh[A_LOCATION] = triage.location;
  fresh[A_EMAIL] = threadUrl_(msg.threadId);
  fresh[A_CONF] = triage.confidence;
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
        if (r[0] && r[P_ACTION] !== DRY_RUN_ACTION) seen[r[0]] = true;
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

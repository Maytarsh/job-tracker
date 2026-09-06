/**
 * Setup.gs — run setup() once. Creates the tabs, formatting and triggers.
 * Safe to re-run: it never touches existing data.
 */

function setup() {
  var ss = SpreadsheetApp.getActive();

  ensureTab_(ss, TABS.APPLICATIONS, APP_HEADERS);
  ensureTab_(ss, TABS.COMPANIES, COMPANY_HEADERS);
  ensureTab_(ss, TABS.PROCESSED, PROCESSED_HEADERS);
  ensureTab_(ss, TABS.SKIPPED, SKIPPED_HEADERS);

  formatApplications_(ss.getSheetByName(TABS.APPLICATIONS));
  ss.getSheetByName(TABS.PROCESSED).hideSheet();
  ss.getSheetByName(TABS.SKIPPED).hideSheet();

  installTriggers_();

  var hasKey = !!PropertiesService.getScriptProperties()
    .getProperty('ANTHROPIC_API_KEY');
  var msg = 'Tabs and triggers are ready.\n\n' +
    (hasKey ? '✓ ANTHROPIC_API_KEY is set.'
            : '✗ ANTHROPIC_API_KEY is NOT set — Project Settings → Script Properties.') +
    '\n\nDRY_RUN is currently ' + CONFIG.DRY_RUN + '.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Job Tracker', msg, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { /* no UI when run from the editor */ }
}

function ensureTab_(ss, name, headers) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

function formatApplications_(sheet) {
  sheet.setColumnWidth(A_COMPANY + 1, 160);
  sheet.setColumnWidth(A_ROLE + 1, 220);
  sheet.setColumnWidth(A_MARKET + 1, 130);
  sheet.setColumnWidth(A_DESC + 1, 420);
  sheet.setColumnWidth(A_NOTES + 1, 260);
  sheet.getRange(2, A_DESC + 1, sheet.getMaxRows() - 1, 1).setWrap(true);

  var lastRow = sheet.getMaxRows();
  var statusRange = sheet.getRange(2, A_STATUS + 1, lastRow - 1, 1);
  var stageRange = sheet.getRange(2, A_STAGE + 1, lastRow - 1, 1);
  var marketRange = sheet.getRange(2, A_MARKET + 1, lastRow - 1, 1);

  statusRange.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Open', 'Closed'], true).setAllowInvalid(false).build());
  stageRange.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(
      ['Applied', 'Screening', 'Interview', 'Offer', 'Rejected', 'Ghosted'], true)
    .setAllowInvalid(false).build());
  marketRange.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(MARKETS, true).setAllowInvalid(true).build());

  var all = sheet.getRange(2, 1, lastRow - 1, APP_HEADERS.length);
  sheet.setConditionalFormatRules([
    // Closed applications fade into the background.
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$E2="Closed"')
      .setBackground('#f1f3f4').setFontColor('#80868b')
      .setRanges([all]).build(),
    // Quiet for three weeks and still open — worth a nudge.
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($E2="Open",$I2>21)')
      .setBackground('#fef7e0')
      .setRanges([all]).build(),
    // Low-confidence extractions, for auditing.
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('low')
      .setFontColor('#c5221f').setBold(true)
      .setRanges([sheet.getRange(2, A_CONF + 1, lastRow - 1, 1)]).build()
  ]);
}

function installTriggers_() {
  var wanted = { pollInbox: true, markStale: true };
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (wanted[t.getHandlerFunction()]) ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('pollInbox').timeBased()
    .everyMinutes(CONFIG.POLL_MINUTES).create();
  ScriptApp.newTrigger('markStale').timeBased()
    .everyDays(1).atHour(7).create();
}

// ------------------------------------------------------------------- menu

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Job Tracker')
    .addItem('Check mail now', 'pollInbox')
    .addItem('Backfill history', 'runBackfill')
    .addSeparator()
    .addItem('Coverage report', 'menuCoverage')
    .addSeparator()
    .addItem('Flag ghosted rows', 'markStale')
    .addItem('Rescan skipped mail', 'menuRescanSkipped')
    .addItem('Re-research selected companies', 'menuReEnrichSelected')
    .addItem('Fill in missing company profiles', 'menuEnrichMissing')
    .addSeparator()
    .addItem('Replay selected _Processed rows', 'menuReplaySelected')
    .addItem('Run setup', 'setup')
    .addToUi();
}

/** Drop cached profiles for the selected Applications rows and research again. */
function menuReEnrichSelected() {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== TABS.APPLICATIONS) {
    return toast_('Select rows on the Applications tab first.');
  }

  var sel = sheet.getActiveRange();
  var book = openBook_();
  var companySheet = getSheet_(TABS.COMPANIES);
  var cacheRows = companySheet.getLastRow() > 1
    ? companySheet.getRange(2, 1, companySheet.getLastRow() - 1, 1).getValues()
    : [];
  var done = 0;
  var capped = false;

  for (var r = sel.getRow(); r < sel.getRow() + sel.getNumRows(); r++) {
    var idx = r - 2;
    if (idx < 0 || idx >= book.rows.length) continue;
    var name = book.rows[idx][A_COMPANY];
    var key = normalizeCompany_(name);
    if (!key) continue;

    for (var c = cacheRows.length - 1; c >= 0; c--) {
      if (cacheRows[c][0] === key) {
        companySheet.deleteRow(c + 2);
        cacheRows.splice(c, 1);
      }
    }
    delete book.companies[key];

    var profile = companyProfile_(
      book, name, book.rows[idx][A_JOB_URL], book.rows[idx][A_LOCATION]);

    // An empty profile means MAX_ENRICH_PER_RUN was reached, not that the
    // research came back blank. The poll can absorb that — it only fills an
    // empty Market — but here it would overwrite a Market and Description that
    // are already on the row, so stop rather than erase them.
    if (!profile.market && !profile.description) {
      capped = true;
      Logger.log('re-research stopped after ' + done +
                 ' row(s): MAX_ENRICH_PER_RUN reached');
      break;
    }

    // Same treatment as every other write: the description is model free text.
    book.rows[idx][A_MARKET] = safeCell_(profile.market, 40);
    book.rows[idx][A_DESC] = safeCell_(profile.description, 600);
    book.dirty[idx] = true;
    done++;
    Logger.log('re-researched ' + name + ' -> ' + profile.market);
  }

  flushBook_(book);
  Logger.log('menuReEnrichSelected: ' + done + ' row(s) re-researched');
  toast_('Re-researched ' + done + ' company row(s).' +
         (capped ? ' Hit the per-run cap — select the rest and run again.' : ''));
}

/**
 * Delete the selected _Processed rows so their emails flow through the whole
 * pipeline again on the next run. The way to re-test a real email against a
 * tuned prompt without sending anything.
 */
function menuReplaySelected() {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== TABS.PROCESSED) {
    return toast_('Select rows on the _Processed tab first (Job Tracker → unhide it).');
  }
  var sel = sheet.getActiveRange();
  var count = sel.getNumRows();
  sheet.deleteRows(sel.getRow(), count);
  // Backfill, not pollInbox: the incremental window only reaches back
  // POLL_MINUTES, which would not re-fetch an older email.
  toast_('Cleared ' + count + ' row(s) — replaying over the backfill window…');
  runBackfill();
  toast_('Replay complete. Check _Processed for the new rows.');
}

/**
 * How far back the tool has actually looked, and what it classified but never
 * wrote down.
 *
 * The sheet cannot show you what it never saw. A window that was never swept
 * looks exactly like a window with no job mail in it, which is how a month of
 * applications went missing while everything on screen looked healthy. This is
 * the one screen that can tell you the difference, so check it after a backfill
 * rather than trusting a full-looking table.
 */
function menuCoverage() {
  var oldest = oldestExaminedDate_();
  var book = openBook_();
  var missing = unwrittenCompanies_(book);
  var blanks = 0;
  book.rows.forEach(function (row) {
    if (row[A_COMPANY] && !row[A_MARKET]) blanks++;
  });

  var unclassified = countUnclassified_();
  var lines = [
    oldest
      ? 'Mail examined back to: ' + oldest.toDateString()
      : 'No mail examined yet — run Backfill history.',
    'Application rows: ' + book.rows.length,
    'Rows still missing a Market: ' + blanks +
      (blanks ? ' (Fill in missing company profiles)' : '')
  ];

  if (unclassified) {
    lines.push('Messages that could not be classified: ' + unclassified +
               ' (see _Processed, Action starts with "failed:")');
  }

  if (missing.length) {
    lines.push('');
    lines.push('Classified as applications but not in the table (' +
               missing.length + '): ' + missing.slice(0, 10).join(', ') +
               (missing.length > 10 ? ', …' : ''));
  }

  lines.push('');
  lines.push('Anything older than the first date above has never been looked at. ' +
             'Backfill history is the only thing that reaches it — the 30-minute ' +
             'poll only ever looks forward.');

  var msg = lines.join('\n');
  Logger.log(msg);
  try {
    SpreadsheetApp.getUi().alert('Coverage', msg, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { /* no UI when run from the editor */ }
  return msg;
}

/** Messages examined but never classified — a bad response, not a missed email. */
function countUnclassified_() {
  var sheet = getSheet_(TABS.PROCESSED);
  var last = sheet.getLastRow();
  if (last < 2) return 0;

  var count = 0;
  sheet.getRange(2, P_ACTION + 1, last - 1, 1).getValues().forEach(function (r) {
    if (String(r[0]).indexOf('failed:') === 0) count++;
  });
  return count;
}

/** The earliest message either log has a record of examining. */
function oldestExaminedDate_() {
  var oldest = null;
  [TABS.PROCESSED, TABS.SKIPPED].forEach(function (tab) {
    var sheet = getSheet_(tab);
    var last = sheet.getLastRow();
    if (last < 2) return;
    sheet.getRange(2, 2, last - 1, 1).getValues().forEach(function (r) {
      if (!r[0]) return;
      var date = new Date(r[0]);
      if (isNaN(date.getTime())) return;
      if (!oldest || date < oldest) oldest = date;
    });
  });
  return oldest;
}

/**
 * Companies that triage called a real application but that have no row. Every
 * one is either a bug or a message whose upsert failed, and both are invisible
 * without asking.
 */
function unwrittenCompanies_(book) {
  var sheet = getSheet_(TABS.PROCESSED);
  var last = sheet.getLastRow();
  if (last < 2) return [];

  var present = {};
  book.rows.forEach(function (row) {
    var key = normalizeCompany_(row[A_COMPANY]);
    if (key) present[key] = true;
  });

  var missing = {};
  sheet.getRange(2, 1, last - 1, PROCESSED_HEADERS.length).getValues()
    .forEach(function (r) {
      if (!WRITE_CATEGORIES[r[4]]) return;
      if (String(r[P_ACTION]) === DRY_RUN_ACTION) return;
      var key = normalizeCompany_(r[5]);
      if (key && !present[key]) missing[key] = r[5];
    });

  return Object.keys(missing).map(function (key) { return missing[key]; });
}

/** Research every row whose Market is still blank, within one run's budget. */
function menuEnrichMissing() {
  var book = openBook_();
  book.deadline = Date.now() + CONFIG.RUN_BUDGET_SECONDS * 1000;
  var filled = fillMissingProfiles_(book);
  flushBook_(book);

  var remaining = 0;
  book.rows.forEach(function (row) {
    if (row[A_COMPANY] && !row[A_MARKET]) remaining++;
  });
  toast_(filled
    ? 'Filled ' + filled + ' profile(s)' +
      (remaining ? '; ' + remaining + ' left — run again.' : '.')
    : 'Nothing to fill in.');
}

/** Clear _Skipped so a widened prefilter reconsiders that mail. */
function menuRescanSkipped() {
  var cleared = clearSkipped_();
  toast_('Cleared ' + cleared + ' skipped row(s). Run Backfill history to reconsider them.');
}

function toast_(message) {
  SpreadsheetApp.getActive().toast(message, 'Job Tracker', 8);
}

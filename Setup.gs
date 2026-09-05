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
    .addItem('Flag ghosted rows', 'markStale')
    .addItem('Re-research selected companies', 'menuReEnrichSelected')
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

    var profile = companyProfile_(book, name, book.rows[idx][A_JOB_URL]);
    book.rows[idx][A_MARKET] = profile.market;
    book.rows[idx][A_DESC] = profile.description;
    book.dirty[idx] = true;
    done++;
  }

  flushBook_(book);
  toast_('Re-researched ' + done + ' company row(s).');
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

function toast_(message) {
  SpreadsheetApp.getActive().toast(message, 'Job Tracker', 8);
}

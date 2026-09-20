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
  // Which mailbox this just wired up, because setup() is how a second account
  // joins: it is run once from each, and the triggers it installs belong to
  // whoever ran it. Seeing the wrong address here means the wrong Google
  // account is signed in, which is otherwise invisible until mail goes missing.
  var msg = 'Tabs and triggers are ready for ' +
    (mailboxEmail_() || 'this account') + '.\n\n' +
    (hasKey ? '✓ ANTHROPIC_API_KEY is set.'
            : '✗ ANTHROPIC_API_KEY is NOT set — Project Settings → Script Properties.') +
    '\n\nDRY_RUN is currently ' + CONFIG.DRY_RUN + '.' +
    '\n\nThis account has swept no mail until you run Backfill history from it.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Job Tracker', msg, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { /* no UI when run from the editor */ }
}

/**
 * Create the tab if it is missing, and keep its header row matching *_HEADERS.
 *
 * Rewriting the header whenever it has drifted, not only when the tab is brand
 * new: a column appended to a *_HEADERS list after the sheet already existed
 * would otherwise stay an unlabelled blank that re-running setup() could never
 * repair. Every index into these rows is positional anyway, so the labels are
 * the automation's to own.
 */
function ensureTab_(ss, name, headers) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);

  var short = headers.length - sheet.getMaxColumns();
  if (short > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), short);

  var current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var drifted = headers.some(function (label, i) { return current[i] !== label; });
  if (drifted) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

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

  // Days quiet is a count, not a date. Subtracting two dates leaves Sheets
  // formatting the result as one, so 22 days renders as 22/01/1900 — the right
  // number wearing the wrong clothes. Pin the format to a plain integer.
  sheet.getRange(2, A_QUIET + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('0');

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

/**
 * Every menu action below that writes the sheet takes the same lock the poll
 * does. A click landing while a trigger is mid-run would otherwise read the
 * table the run is about to replace, and flush its stale copy over the top.
 */
function busyToast_() {
  toast_('Another run is using the sheet right now — try again in a minute.');
}

/** Drop cached profiles for the selected Applications rows and research again. */
function menuReEnrichSelected() {
  if (withBookLock_('menuReEnrichSelected', menuReEnrichSelected_) === LOCK_BUSY) {
    busyToast_();
  }
}

function menuReEnrichSelected_() {
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
  var first = sel.getRow();
  var count = sel.getNumRows();

  // The delete and the re-sweep go under one lock, and the sweep calls the
  // unlocked core: between the two the messages belong to nobody, and this
  // same lock is not re-entrant.
  var replayed = withBookLock_('menuReplaySelected', function () {
    sheet.deleteRows(first, count);
    // Backfill, not pollInbox: the incremental window only reaches back
    // POLL_MINUTES, which would not re-fetch an older email.
    toast_('Cleared ' + count + ' row(s) — replaying over the backfill window…');
    resetBackfillCursor_();
    return runBackfill_();
  });

  if (replayed === LOCK_BUSY) return busyToast_();
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
  var swept = oldestExaminedByAccount_();
  var accounts = Object.keys(swept).sort();
  var me = mailboxEmail_();
  var book = openBook_();
  var missing = unwrittenCompanies_(book);
  var blanks = 0;
  book.rows.forEach(function (row) {
    if (row[A_COMPANY] && !row[A_MARKET]) blanks++;
  });

  var unclassified = countUnclassified_();
  var lines = [];

  if (!accounts.length) {
    lines.push('No mail examined yet — run Backfill history.');
  } else {
    accounts.forEach(function (who) {
      lines.push('Mail examined back to, ' + (who || 'unidentified account') +
                 ': ' + swept[who].toDateString());
    });
  }

  // The question this report exists to answer, asked per mailbox now. A second
  // account nobody ever backfilled contributes no rows and no log lines, which
  // is indistinguishable from an account that simply gets no job mail — and
  // the total above would be quietly carried by the other one.
  if (sweptNothing_(accounts, me)) {
    lines.push('⚠ ' + me + ' has examined nothing. Run Backfill history while ' +
               'signed in as this account.');
  }

  lines.push('This account (' + (me || 'unidentified') + ') polls from: ' +
             pollCursorDescription_());
  lines.push('Spent today: $' + spendToday_().toFixed(2) +
             ' of $' + CONFIG.DAILY_BUDGET_USD.toFixed(2) +
             ' (one ceiling, shared by every account)');
  lines.push('Application rows: ' + book.rows.length);
  lines.push('Rows still missing a Market: ' + blanks +
             (blanks ? ' (Fill in missing company profiles)' : ''));

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
  lines.push('Anything older than the dates above has never been looked at. ' +
             'Backfill history is the only thing that reaches it — the ' +
             CONFIG.POLL_MINUTES + '-minute poll only ever looks forward. Both ' +
             'only ever sweep the mailbox they are run from, so each account ' +
             'needs its own backfill.');

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

/**
 * The earliest message each mailbox has a record of examining, from both logs.
 *
 * Keyed by account rather than reduced to one date: with two mailboxes writing
 * one sheet, a single overall figure is the *better* swept of the two, and it
 * would report a thoroughly-backfilled account as though it covered mail the
 * other account has never looked at.
 *
 * Rows written before the Account column existed have no account on them; they
 * group under '' and print as an unidentified account rather than being
 * dropped, because they are still evidence that something was examined.
 */
function oldestExaminedByAccount_() {
  var oldest = {};
  var logs = [
    { tab: TABS.PROCESSED, width: PROCESSED_HEADERS.length, account: P_ACCOUNT },
    { tab: TABS.SKIPPED, width: SKIPPED_HEADERS.length, account: S_ACCOUNT }
  ];

  logs.forEach(function (log) {
    var sheet = getSheet_(log.tab);
    var last = sheet.getLastRow();
    if (last < 2) return;
    sheet.getRange(2, 1, last - 1, log.width).getValues().forEach(function (r) {
      if (!r[1]) return;
      var date = new Date(r[1]);
      if (isNaN(date.getTime())) return;
      var who = String(r[log.account] || '');
      if (!oldest[who] || date < oldest[who]) oldest[who] = date;
    });
  });
  return oldest;
}

/**
 * Should the report warn that the account running it has swept nothing?
 *
 * Only once some *other* account is on record. Every row written before the
 * Account column existed is unattributed, so on the first run after that change
 * a mailbox backfilled for months looks identical to one that has never run.
 * Crying wolf there is not a harmless false alarm: this is the one warning on
 * this screen worth reacting to, and it only works if it is never noise.
 */
function sweptNothing_(accounts, me) {
  if (!me) return false;
  var identified = accounts.filter(function (who) { return !!who; });
  return identified.length > 0 && identified.indexOf(me) === -1;
}

/** Where this mailbox's incremental poll will pick up from next. */
function pollCursorDescription_() {
  var epoch = Number(cursorStore_().getProperty(PROP_LAST_RUN));
  if (!epoch) {
    return 'nothing recorded yet — the next poll looks back ' +
           CONFIG.POLL_MINUTES + ' minutes';
  }
  return new Date(epoch * 1000).toString();
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
  if (withBookLock_('menuEnrichMissing', menuEnrichMissing_) === LOCK_BUSY) {
    busyToast_();
  }
}

function menuEnrichMissing_() {
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
  if (withBookLock_('menuRescanSkipped', menuRescanSkipped_) === LOCK_BUSY) {
    busyToast_();
  }
}

function menuRescanSkipped_() {
  var cleared = clearSkipped_();
  toast_('Cleared ' + cleared + ' skipped row(s). Run Backfill history to reconsider them.');
}

function toast_(message) {
  SpreadsheetApp.getActive().toast(message, 'Job Tracker', 8);
}

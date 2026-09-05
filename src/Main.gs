/**
 * Main.gs — the entry points. pollInbox() and markStale() run on triggers;
 * the rest are driven from the Job Tracker menu.
 */

var PROP_LAST_RUN = 'LAST_RUN_EPOCH';
var BACKFILL_TRIGGER = 'runBackfill';

/** Trigger entry point: everything since the last successful run. */
function pollInbox() {
  var props = PropertiesService.getScriptProperties();
  var now = Math.floor(Date.now() / 1000);
  var lastRun = Number(props.getProperty(PROP_LAST_RUN)) ||
                (now - CONFIG.POLL_MINUTES * 60);

  var after = lastRun - CONFIG.OVERLAP_MINUTES * 60;
  var result = processWindow_(after, 0, CONFIG.MAX_MESSAGES_PER_RUN);

  props.setProperty(PROP_LAST_RUN, String(now));
  Logger.log('pollInbox: ' + JSON.stringify(result));
  return result;
}

/**
 * One-time history pass. Chunked: each execution handles at most
 * MAX_MESSAGES_PER_RUN messages and re-queues itself until the window drains,
 * so a large backfill can't hit the 6-minute execution cap.
 */
function runBackfill() {
  clearBackfillTriggers_();

  var now = Math.floor(Date.now() / 1000);
  var after = now - CONFIG.BACKFILL_DAYS * 86400;
  var before = CONFIG.BACKFILL_HOLDOUT_DAYS
    ? now - CONFIG.BACKFILL_HOLDOUT_DAYS * 86400
    : 0;

  var result = processWindow_(after, before, CONFIG.MAX_MESSAGES_PER_RUN);
  Logger.log('runBackfill: ' + JSON.stringify(result));

  if (result.hitLimit) {
    ScriptApp.newTrigger(BACKFILL_TRIGGER).timeBased().after(60 * 1000).create();
    Logger.log('backfill continues in ~1 minute');
  } else {
    // Backfill reached the present; hand the baton to the incremental poll.
    PropertiesService.getScriptProperties()
      .setProperty(PROP_LAST_RUN, String(before || now));
    Logger.log('backfill complete');
  }
  return result;
}

/** The pipeline: collect -> prefilter -> triage -> upsert -> flush. */
function processWindow_(afterEpoch, beforeEpoch, limit) {
  // First real run after a rehearsal: clear the dry-run rows so their messages
  // are reconsidered instead of being skipped as already handled.
  if (!CONFIG.DRY_RUN) {
    var purged = purgeDryRunRows_();
    if (purged) Logger.log('cleared ' + purged + ' dry-run row(s) before writing');
  }

  var processedIds = loadProcessedIds_();
  var messages = collectMessages_(afterEpoch, beforeEpoch, processedIds, limit);

  var book = openBook_();
  var stats = { seen: messages.length, skipped: 0, triaged: 0, written: 0, errors: 0 };

  messages.forEach(function (msg) {
    if (!isCandidate_(msg)) {
      stats.skipped++;
      book.skipped.push([msg.date, msg.from, msg.subject]);
      // Not logged to _Processed: it never cost anything, and leaving it out
      // means a prefilter fix lets it be reconsidered on the next run.
      return;
    }

    var triage;
    try {
      triage = triageMessage_(msg);
      stats.triaged++;
    } catch (err) {
      stats.errors++;
      Logger.log('triage failed for ' + msg.id + ': ' + err);
      return;  // no _Processed row, so it retries next run
    }

    var action;
    if (CONFIG.DRY_RUN) {
      action = DRY_RUN_ACTION;
    } else if (WRITE_CATEGORIES[triage.category]) {
      try {
        action = upsertApplication_(book, triage, msg);
        stats.written++;
      } catch (err) {
        stats.errors++;
        action = 'error: ' + err;
      }
    } else {
      action = 'ignored (' + triage.category + ')';
    }

    book.processed.push([
      msg.id, msg.date, msg.from, msg.subject, triage.category,
      triage.company, triage.role, triage.confidence, triage.evidence, action
    ]);
  });

  flushBook_(book);
  stats.hitLimit = (messages.length >= limit);
  return stats;
}

/** Only these categories reach the Applications tab. */
var WRITE_CATEGORIES = {
  application_confirmation: true,
  rejection: true,
  interview_or_next_step: true,
  offer: true
};

/** Daily: Open rows that have gone quiet become Ghosted. Status stays Open. */
function markStale() {
  var book = openBook_();
  var cutoff = new Date(Date.now() - CONFIG.STALE_DAYS * 86400 * 1000);
  var flagged = 0;

  book.rows.forEach(function (row, i) {
    if (row[A_STATUS] !== 'Open') return;
    if (row[A_STAGE] !== 'Applied' && row[A_STAGE] !== 'Screening') return;
    if (!row[A_UPDATED] || new Date(row[A_UPDATED]) > cutoff) return;
    row[A_STAGE] = 'Ghosted';
    book.dirty[i] = true;
    flagged++;
  });

  flushBook_(book);
  Logger.log('markStale: ' + flagged + ' row(s) flagged');
  return flagged;
}

function clearBackfillTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === BACKFILL_TRIGGER) ScriptApp.deleteTrigger(t);
  });
}

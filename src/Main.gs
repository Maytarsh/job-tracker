/**
 * Main.gs — the entry points. pollInbox() and markStale() run on triggers;
 * the rest are driven from the Job Tracker menu.
 */

var PROP_LAST_RUN = 'LAST_RUN_EPOCH';
var BACKFILL_TRIGGER = 'runBackfill';
var PROP_BACKFILL_CHUNKS = 'BACKFILL_CHUNKS';
var PROP_BACKFILL_BEFORE = 'BACKFILL_BEFORE_EPOCH';

/** Trigger entry point: everything since the last successful run. */
function pollInbox() {
  var props = PropertiesService.getScriptProperties();
  var now = Math.floor(Date.now() / 1000);
  var lastRun = Number(props.getProperty(PROP_LAST_RUN)) ||
                (now - CONFIG.POLL_MINUTES * 60);

  var after = lastRun - CONFIG.OVERLAP_MINUTES * 60;
  var result = processWindow_(after, 0, CONFIG.MAX_MESSAGES_PER_RUN);

  // Only advance past a window we actually drained. Gmail returns newest-first,
  // so a capped run leaves the *oldest* messages unhandled — moving the cursor
  // to now would drop them permanently.
  //
  // A failure is the same hazard and used to be missed entirely: a message
  // whose triage threw gets no _Processed row so that it will be retried, but
  // if the cursor moved to now the next window started after it and no run
  // ever looked at it again. It was in neither log, so nothing reported it.
  // Rewind to just before the oldest failure instead, so successes still make
  // progress and the failures stay inside the window.
  if (result.oldestErrorEpoch) {
    props.setProperty(PROP_LAST_RUN, String(result.oldestErrorEpoch - 1));
  } else if (!result.hitLimit && !result.outOfTime) {
    props.setProperty(PROP_LAST_RUN, String(now));
  }
  Logger.log('pollInbox: ' + JSON.stringify(result));
  return result;
}

/**
 * One-time history pass. Chunked: each execution handles at most
 * MAX_MESSAGES_PER_RUN messages and re-queues itself until the window drains,
 * so a large backfill can't hit the 6-minute execution cap.
 */
function runBackfill(event) {
  clearBackfillTriggers_();
  var props = PropertiesService.getScriptProperties();

  // A time-based trigger passes an event object; a menu click or an editor run
  // does not. So a continuation resumes where the last chunk stopped, while
  // starting it by hand always sweeps the window again from the newest end.
  if (!event) {
    props.deleteProperty(PROP_BACKFILL_BEFORE);
    props.deleteProperty(PROP_BACKFILL_CHUNKS);
  }

  // A chunk counter, not just a drained-window check. The window draining is
  // what *should* end the backfill; this is the backstop for when it doesn't,
  // so a bug can never leave a 60-second trigger running against the mailbox
  // indefinitely.
  var chunk = Number(props.getProperty(PROP_BACKFILL_CHUNKS)) || 0;
  if (chunk >= CONFIG.MAX_BACKFILL_CHUNKS) {
    props.deleteProperty(PROP_BACKFILL_CHUNKS);
    props.deleteProperty(PROP_BACKFILL_BEFORE);
    Logger.log('backfill stopped after ' + chunk + ' chunks (MAX_BACKFILL_CHUNKS). ' +
               'Re-run to continue if the window is genuinely that large.');
    return { stopped: 'chunk limit' };
  }
  props.setProperty(PROP_BACKFILL_CHUNKS, String(chunk + 1));

  var now = Math.floor(Date.now() / 1000);
  var after = now - CONFIG.BACKFILL_DAYS * 86400;
  var holdout = CONFIG.BACKFILL_HOLDOUT_DAYS
    ? now - CONFIG.BACKFILL_HOLDOUT_DAYS * 86400
    : 0;

  // Each chunk searches only what is older than the last one reached. Without
  // this the Gmail search restarts at the newest thread every time and re-reads
  // everything already processed before finding anything new, so the work per
  // chunk grows with the window and a deep backfill stalls — and a stalled
  // chunk that dies takes its continuation trigger with it, ending the backfill
  // silently, part-way through, looking exactly like a completed one.
  var before = Number(props.getProperty(PROP_BACKFILL_BEFORE)) || holdout;

  var result = processWindow_(after, before, CONFIG.MAX_MESSAGES_PER_RUN);
  Logger.log('runBackfill: ' + JSON.stringify(result));

  // +1 so messages sharing the oldest timestamp are re-collected rather than
  // stepped over; the processed-ID set drops the ones already handled.
  if (result.oldestEpoch) {
    props.setProperty(PROP_BACKFILL_BEFORE, String(result.oldestEpoch + 1));
  }

  if (result.hitLimit || result.outOfTime) {
    ScriptApp.newTrigger(BACKFILL_TRIGGER).timeBased().after(60 * 1000).create();
    Logger.log('backfill continues in ~1 minute (chunk ' + (chunk + 1) + ')');
  } else {
    // Backfill reached the far end; hand the baton to the incremental poll.
    props.setProperty(PROP_LAST_RUN, String(holdout || now));
    props.deleteProperty(PROP_BACKFILL_CHUNKS);
    props.deleteProperty(PROP_BACKFILL_BEFORE);
    Logger.log('backfill complete');
  }
  return result;
}

/** The pipeline: collect -> prefilter -> triage -> upsert -> flush. */
function processWindow_(afterEpoch, beforeEpoch, limit) {
  var deadline = Date.now() + CONFIG.RUN_BUDGET_SECONDS * 1000;

  // First real run after a rehearsal: clear the dry-run rows so their messages
  // are reconsidered instead of being skipped as already handled.
  if (!CONFIG.DRY_RUN) {
    var purged = purgeDryRunRows_();
    if (purged) Logger.log('cleared ' + purged + ' dry-run row(s) before writing');
  }

  var processedIds = loadProcessedIds_();
  var messages = collectMessages_(afterEpoch, beforeEpoch, processedIds, limit);

  var book = openBook_();
  book.deadline = deadline;
  var stats = {
    seen: messages.length, skipped: 0, triaged: 0, written: 0, errors: 0,
    // The oldest message this run actually handled — the backfill's cursor.
    oldestEpoch: 0,
    // The oldest one it failed on, which the poll must not step over.
    oldestErrorEpoch: 0,
    outOfTime: false
  };

  for (var m = 0; m < messages.length; m++) {
    var msg = messages[m];

    // Stop short of the 6-minute kill rather than being cut off by it. An
    // execution that dies loses everything buffered here, and the messages it
    // already paid to triage are triaged again on the next run.
    if (Date.now() > deadline) {
      stats.outOfTime = true;
      Logger.log('out of time after ' + m + ' of ' + messages.length + ' message(s)');
      break;
    }

    var epoch = Math.floor(msg.date.getTime() / 1000);
    if (!stats.oldestEpoch || epoch < stats.oldestEpoch) stats.oldestEpoch = epoch;

    if (!isCandidate_(msg)) {
      stats.skipped++;
      // Recorded by ID, so the window actually drains. Reconsidering these
      // after a prefilter change is an explicit action: Rescan skipped mail.
      book.skipped.push([msg.id, msg.date, msg.from, msg.subject]);
      continue;
    }

    var triage;
    try {
      triage = triageMessage_(msg);
      stats.triaged++;
    } catch (err) {
      stats.errors++;
      if (!stats.oldestErrorEpoch || epoch < stats.oldestErrorEpoch) {
        stats.oldestErrorEpoch = epoch;
      }
      Logger.log('triage failed for ' + msg.id + ': ' + err);
      continue;  // no _Processed row, so it retries next run
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
        if (!stats.oldestErrorEpoch || epoch < stats.oldestErrorEpoch) {
          stats.oldestErrorEpoch = epoch;
        }
        action = 'error: ' + err;
      }
    } else {
      action = 'ignored (' + triage.category + ')';
    }

    book.processed.push([
      msg.id, msg.date, msg.from, msg.subject, triage.category,
      triage.company, triage.role, triage.confidence, triage.evidence, action
    ]);
  }

  // Whatever budget is left goes on profiles the run had to leave blank.
  fillMissingProfiles_(book);
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

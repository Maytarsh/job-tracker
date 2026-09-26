/**
 * Main.gs — the entry points. pollInbox() and markStale() run on triggers;
 * the rest are driven from the Job Tracker menu.
 */

var PROP_LAST_RUN = 'LAST_RUN_EPOCH';
var BACKFILL_TRIGGER = 'runBackfill';
var PROP_BACKFILL_CHUNKS = 'BACKFILL_CHUNKS';
var PROP_BACKFILL_BEFORE = 'BACKFILL_BEFORE_EPOCH';
var PROP_CURSOR_ADOPTED = 'CURSOR_ADOPTED_AT';
var CURSOR_KEYS = [PROP_LAST_RUN, PROP_BACKFILL_CHUNKS, PROP_BACKFILL_BEFORE];

/**
 * Where this mailbox keeps its place in the mail.
 *
 * User Properties, not Script Properties. Two Gmail accounts can run this one
 * bound script against one spreadsheet, each on its own trigger, and every
 * Script Property is shared between them — so a single LAST_RUN_EPOCH means
 * whichever account polls second finds the cursor already at now and looks
 * back only OVERLAP_MINUTES. Everything its mailbox received before that has
 * no _Processed row and is behind the cursor: outside every future window, in
 * neither log, gone, with a full-looking sheet and nothing to say so. User
 * Properties are scoped to the account whose trigger is running, so the two
 * mailboxes cannot tread on each other's place.
 *
 * ANTHROPIC_API_KEY and SPEND_USD stay script-wide on purpose: one key, and
 * one daily ceiling covering both accounts rather than two that each spend it.
 */
function cursorStore_() {
  var user = PropertiesService.getUserProperties();
  if (!user.getProperty(PROP_CURSOR_ADOPTED)) {
    // Adopt the single-account cursor from Script Properties, once. An install
    // that predates per-account cursors keeps its place there; starting empty
    // instead would leave its first poll with no cursor at all, so it would
    // default to a POLL_MINUTES window and step straight over everything that
    // arrived since the last real run. A second mailbox adopting the same
    // value is harmless: it only reaches further back than it needs to, and
    // collectMessages_ drops whatever is already in either log.
    var script = PropertiesService.getScriptProperties();
    for (var i = 0; i < CURSOR_KEYS.length; i++) {
      var value = script.getProperty(CURSOR_KEYS[i]);
      if (value !== null && user.getProperty(CURSOR_KEYS[i]) === null) {
        user.setProperty(CURSOR_KEYS[i], value);
      }
    }
    user.setProperty(PROP_CURSOR_ADOPTED, String(Date.now()));
  }
  return user;
}

/** Trigger entry point: everything since the last successful run. */
function pollInbox() {
  return withBookLock_('pollInbox', pollInbox_);
}

function pollInbox_() {
  var props = cursorStore_();
  var now = Math.floor(Date.now() / 1000);
  var lastRun = Number(props.getProperty(PROP_LAST_RUN)) ||
                (now - CONFIG.POLL_MINUTES * 60);

  var after = lastRun - CONFIG.OVERLAP_MINUTES * 60;
  var result = processWindow_(after, 0, CONFIG.MAX_MESSAGES_PER_RUN);

  // Only advance past a window we actually drained. Gmail returns newest-first,
  // so a capped run leaves the *oldest* messages unhandled — moving the cursor
  // to now would drop them permanently.
  //
  // A failure is the same hazard: a message whose triage threw gets no
  // _Processed row so that it will be retried, but if the cursor moved to now
  // the next window would start after it and no run would look at it again.
  // It would be in neither log, so nothing would report it.
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
  // A time-based trigger passes an event object; a menu click or an editor run
  // does not. So a continuation resumes where the last chunk stopped, while
  // starting it by hand always sweeps the window again from the newest end.
  //
  // Out here rather than inside the lock so that a start the lock defers still
  // restarts, instead of quietly resuming a half-finished earlier sweep.
  if (!event) resetBackfillCursor_();

  var result = withBookLock_(BACKFILL_TRIGGER, runBackfill_);

  // A chunk that could not take the lock must not simply end. It is the only
  // thing carrying the backfill forward, so an execution that stops without
  // queueing the next one leaves a part-swept window looking exactly like a
  // finished one. Hand the baton to a fresh trigger and try again in a minute.
  if (result === LOCK_BUSY) {
    clearBackfillTriggers_();
    ScriptApp.newTrigger(BACKFILL_TRIGGER).timeBased().after(60 * 1000).create();
    Logger.log('backfill deferred by a minute: another run holds the lock');
  }
  return result;
}

/** Forget where the last sweep reached, so the next one starts at the top. */
function resetBackfillCursor_() {
  var props = cursorStore_();
  props.deleteProperty(PROP_BACKFILL_BEFORE);
  props.deleteProperty(PROP_BACKFILL_CHUNKS);
}

function runBackfill_() {
  clearBackfillTriggers_();
  var props = cursorStore_();

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

  // The cursor may not pass a message this chunk failed on — the same rule the
  // poll follows. An outage mid-backfill would otherwise walk the window down
  // while handling none of it, and every message it stepped over would be in
  // neither log and behind the cursor. Rewinding to the oldest failure costs a
  // re-scan of what was already done, which the processed-ID set discards.
  //
  // +1 because the window excludes `before` itself, and the message at that
  // exact second still needs collecting.
  var cursor = result.oldestErrorEpoch || result.oldestEpoch;
  if (cursor) props.setProperty(PROP_BACKFILL_BEFORE, String(cursor + 1));

  if (result.aborted) {
    // No continuation trigger: retrying every minute against a dead API is
    // pointless. Restarting by hand sweeps the window from the newest end
    // again, which is cheap — collectMessages_ drops anything already in
    // _Processed or _Skipped before a single call is made, so a restart costs
    // Gmail reads and picks up exactly where this stopped.
    Logger.log('backfill paused: ' + result.aborted +
               '\nFix that, then run Backfill history again — mail already ' +
               'handled is skipped, so it carries on from here.');
    return result;
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

/**
 * The pipeline: collect -> prefilter -> triage -> upsert -> flush, and only
 * then research. The flush sits between the two halves on purpose — see
 * enrichPass_.
 */
function processWindow_(afterEpoch, beforeEpoch, limit) {
  // Anchored here, before the Gmail read, because the kill is measured from the
  // start of the execution and collecting a wide window is not free.
  var clock = startClock_({});

  // First real run after a rehearsal: clear the dry-run rows so their messages
  // are reconsidered instead of being skipped as already handled.
  if (!CONFIG.DRY_RUN) {
    var purged = purgeDryRunRows_();
    if (purged) Logger.log('cleared ' + purged + ' dry-run row(s) before writing');
  }

  var processedIds = loadProcessedIds_();
  var messages = collectMessages_(afterEpoch, beforeEpoch, processedIds, limit);

  var book = openBook_();
  book.deadline = clock.deadline;
  book.hardDeadline = clock.hardDeadline;
  var stats = {
    seen: messages.length, skipped: 0, triaged: 0, written: 0, errors: 0,
    enriched: 0,
    // The oldest message this run actually handled — the backfill's cursor.
    oldestEpoch: 0,
    // The oldest one it failed on, which the poll must not step over.
    oldestErrorEpoch: 0,
    outOfTime: false,
    aborted: '',
    unclassified: 0
  };

  // An outage fails every call, not one. Stopping on the third in a row keeps a
  // dead API from burning through the whole window in a few seconds.
  var consecutiveFailures = 0;

  for (var m = 0; m < messages.length; m++) {
    var msg = messages[m];

    // Stop short of the 6-minute kill rather than being cut off by it. An
    // execution that dies loses everything buffered here, and the messages it
    // already paid to triage are triaged again on the next run.
    //
    // Whether *this* call can finish, not whether the budget has run out: a
    // triage that retries a 429 four times takes minutes, and finding that out
    // by being killed costs the whole buffer.
    if (!triageBudgetLeft_(book)) {
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
      book.skipped.push([msg.id, msg.date, msg.from, msg.subject, mailboxEmail_()]);
      continue;
    }

    var triage;
    try {
      triage = triageMessage_(msg);
      stats.triaged++;
      consecutiveFailures = 0;
    } catch (err) {
      stats.errors++;

      // A response that cannot be parsed will not parse next time either.
      // Holding the cursor for it would stop the backfill dead, so record it
      // and move on — dropped loudly, and counted by the coverage report,
      // rather than retried forever or lost without trace.
      if (err && err.permanent) {
        stats.unclassified++;
        consecutiveFailures = 0;
        book.processed.push([
          msg.id, msg.date, msg.from, msg.subject, '', '', '', '', '',
          'failed: ' + String(err.message).substring(0, 200), mailboxEmail_()
        ]);
        Logger.log('could not classify ' + msg.id + ': ' + err.message);
        continue;
      }

      consecutiveFailures++;
      if (!stats.oldestErrorEpoch || epoch < stats.oldestErrorEpoch) {
        stats.oldestErrorEpoch = epoch;
      }
      Logger.log('triage failed for ' + msg.id + ': ' + err);
      if (consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
        stats.aborted = String(err).substring(0, 200);
        Logger.log('stopping this run: ' + consecutiveFailures +
                   ' API failures in a row. Nothing is lost — the messages have ' +
                   'no _Processed row, so they are picked up again once the ' +
                   'API works.');
        break;
      }
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
      triage.company, triage.role, triage.confidence, triage.evidence, action,
      mailboxEmail_()
    ]);
  }

  // Every classification this run paid for reaches the sheet before a single
  // research call is made. Research is the slowest thing here and the likeliest
  // to overrun; run first, an overrun would take the triage down with it —
  // billed, killed, unrecorded, and repeated in half an hour.
  flushBook_(book);
  stats.enriched = enrichPass_(clock);
  stats.hitLimit = (messages.length >= limit);
  return stats;
}

/**
 * Whatever budget is left goes on profiles the run had to leave blank.
 *
 * Its own pass over its own copy of the book, for two reasons. It runs after
 * the flush, so an overrunning research call cannot destroy work that is
 * already done. And it has to re-read the sheet either way: flushBook_ sorts
 * Applications, so every index in the book above now points at a different row.
 */
function enrichPass_(clock) {
  if (CONFIG.DRY_RUN) return 0;
  // Asked before re-reading the sheet: with no room for even one call there is
  // nothing this pass could do with the answer.
  if (!enrichBudgetLeft_(clock)) {
    Logger.log('no time for research this run; blanks are left for the next one');
    return 0;
  }

  var book = openBook_();
  book.deadline = clock.deadline;
  book.hardDeadline = clock.hardDeadline;
  book.mayResearch = true;

  var filled = fillMissingProfiles_(book);
  if (filled) flushBook_(book);
  return filled;
}

/** Only these categories reach the Applications tab. */
var WRITE_CATEGORIES = {
  application_confirmation: true,
  rejection: true,
  interview_or_next_step: true,
  offer: true
};

/**
 * Daily: Open rows that have gone quiet become Ghosted. Status stays Open.
 *
 * Both accounts install this trigger and it reads no mail, so the two runs do
 * the identical job. One of them losing the lock to the other costs nothing.
 */
function markStale() {
  return withBookLock_('markStale', markStale_);
}

function markStale_() {
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

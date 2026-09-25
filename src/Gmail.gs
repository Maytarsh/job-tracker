/**
 * Gmail.gs — pulling candidate messages out of the mailbox.
 */

/**
 * Messages in [afterEpoch, beforeEpoch) that we have not already processed.
 * Gmail matches at thread level, so every message is re-checked by its own date.
 */
function collectMessages_(afterEpoch, beforeEpoch, processedIds, limit) {
  var query = 'after:' + afterEpoch + ' -in:chats -in:drafts -from:me';
  if (beforeEpoch) query += ' before:' + beforeEpoch;

  var out = [];
  var start = 0;
  var PAGE = 100;

  // Every GmailApp method below may count against the account's daily Gmail
  // quota, which every script and add-on on the account shares. Counted so the
  // log shows what one run costs; the cost scales with every message in every
  // thread the window touches, not with the messages it keeps.
  var calls = 0, threadCount = 0, walked = 0;

  while (out.length < limit) {
    var threads = GmailApp.search(query, start, PAGE);
    calls++;
    if (!threads.length) break;
    threadCount += threads.length;

    for (var t = 0; t < threads.length && out.length < limit; t++) {
      var messages = threads[t].getMessages();
      calls++;
      for (var m = 0; m < messages.length && out.length < limit; m++) {
        var msg = messages[m];
        var id = msg.getId();
        calls++;
        walked++;
        if (processedIds[id]) continue;

        var epoch = Math.floor(msg.getDate().getTime() / 1000);
        calls++;
        if (epoch < afterEpoch) continue;
        if (beforeEpoch && epoch >= beforeEpoch) continue;

        out.push({
          id: id,
          threadId: threads[t].getId(),
          date: msg.getDate(),
          from: msg.getFrom(),
          subject: msg.getSubject() || '',
          body: cleanBody_(msg.getPlainBody())
        });
        calls += 5;  // thread getId, getDate, getFrom, getSubject, getPlainBody
      }
    }
    start += PAGE;
  }
  Logger.log('gmail: ' + calls + ' call(s) over ' + threadCount + ' thread(s), ' +
             walked + ' message(s) walked, ' + out.length + ' kept');
  return out;
}

/**
 * Strip quoted replies, signatures-by-separator and boilerplate whitespace, then
 * truncate. Keeps triage cost flat no matter how long the email is.
 */
function cleanBody_(raw) {
  if (!raw) return '';
  var text = String(raw);

  var cutMarkers = [
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\nOn .{0,120}\bwrote:\s*\n/,
    /\n_{10,}\n/,
    /\nFrom:.{0,80}\nSent:/i
  ];
  for (var i = 0; i < cutMarkers.length; i++) {
    var hit = text.search(cutMarkers[i]);
    if (hit > 0) text = text.substring(0, hit);
  }

  text = text
    .split('\n')
    .filter(function (line) { return !/^\s*>/.test(line); })
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.length > CONFIG.MAX_BODY_CHARS) {
    text = text.substring(0, CONFIG.MAX_BODY_CHARS) + '\n[truncated]';
  }
  return text;
}

/** Recall-first gate: known ATS sender, or any job-ish phrasing anywhere. */
function isCandidate_(msg) {
  var from = (msg.from || '').toLowerCase();
  for (var i = 0; i < ATS_DOMAINS.length; i++) {
    if (from.indexOf(ATS_DOMAINS[i]) !== -1) return true;
  }

  var haystack = msg.subject + '\n' + msg.body;
  for (var k = 0; k < KEYWORD_PATTERNS.length; k++) {
    if (KEYWORD_PATTERNS[k].test(haystack)) return true;
  }
  return false;
}

/**
 * Which mailbox this execution is reading.
 *
 * Resolved lazily and memoised, never in a top-level var: Session is a service
 * call, and the file it would sit in is evaluated before the one that needs it.
 *
 * Empty is a valid answer — a container-bound script can run in contexts where
 * the address is not disclosed — so every caller has to cope with '' rather
 * than assume an identity. It is only ever a label and a link prefix; nothing
 * routes mail or picks a cursor by it.
 */
var MAILBOX_EMAIL_ = null;
function mailboxEmail_() {
  if (MAILBOX_EMAIL_ === null) {
    try {
      MAILBOX_EMAIL_ = Session.getEffectiveUser().getEmail() || '';
    } catch (err) {
      Logger.log('could not resolve the mailbox address: ' + err);
      MAILBOX_EMAIL_ = '';
    }
  }
  return MAILBOX_EMAIL_;
}

/**
 * Clickable link back to the source thread.
 *
 * Addressed by mailbox rather than by /u/0, which means "whichever account you
 * happen to be signed into first". With two accounts writing one sheet, half
 * the Email links would open the wrong mailbox and land on nothing.
 */
function threadUrl_(threadId) {
  var mailbox = mailboxEmail_();
  return 'https://mail.google.com/mail/u/' +
         (mailbox ? encodeURIComponent(mailbox) : '0') + '/#all/' + threadId;
}

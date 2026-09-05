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

  while (out.length < limit) {
    var threads = GmailApp.search(query, start, PAGE);
    if (!threads.length) break;

    for (var t = 0; t < threads.length && out.length < limit; t++) {
      var messages = threads[t].getMessages();
      for (var m = 0; m < messages.length && out.length < limit; m++) {
        var msg = messages[m];
        var id = msg.getId();
        if (processedIds[id]) continue;

        var epoch = Math.floor(msg.getDate().getTime() / 1000);
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
      }
    }
    start += PAGE;
  }
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

/** Clickable link back to the source thread. */
function threadUrl_(threadId) {
  return 'https://mail.google.com/mail/u/0/#all/' + threadId;
}

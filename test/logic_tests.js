/**
 * Pure-logic tests. Loaded alongside the .gs sources in a real JS engine, with
 * the Apps Script services stubbed. Covers the parts that decide what lands in
 * the sheet — normalization, prefiltering, body cleaning, stage merging, and
 * the upsert/matching rules.
 */
var results = [];
function t(name, fn) {
  try { fn(); results.push({ name: name, pass: true }); }
  catch (e) { results.push({ name: name, pass: false, err: String(e.message || e) }); }
}
function eq(actual, expected, what) {
  var a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((what || '') + ' expected ' + b + ' got ' + a);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected truthy'); }

// ---------------------------------------------------------- normalization
t('company normalization folds legal suffixes', function () {
  eq(normalizeCompany_('Wiz, Inc.'), normalizeCompany_('Wiz'));
  eq(normalizeCompany_('Acme Technologies Ltd'), normalizeCompany_('Acme'));
  eq(normalizeCompany_('Check Point Software Technologies'), 'checkpoint');
});
t('company normalization folds the domain suffix', function () {
  eq(normalizeCompany_('Sedric.ai'), normalizeCompany_('Sedric'));
  eq(normalizeCompany_('Monday.com'), normalizeCompany_('monday'));
  eq(normalizeCompany_(' Sedric.ai '), normalizeCompany_('Sedric'));
});
t('company normalization keeps distinct companies distinct', function () {
  ok(normalizeCompany_('Wiz') !== normalizeCompany_('Wix'), 'Wiz vs Wix');
  ok(normalizeCompany_('Cato Networks') !== normalizeCompany_('Cato'), 'Networks is meaningful');
  // The trailing dot is what licenses the strip, so a bare word is left alone
  // rather than guessing that every company ending in "ai" is a domain.
  ok(normalizeCompany_('Sedric AI') !== normalizeCompany_('Sedric'), 'no dot, no strip');
});
t('role normalization ignores punctuation and case', function () {
  eq(normalizeRole_('Senior Security Researcher'), normalizeRole_('senior  security-researcher'));
});

// ------------------------------------------------------------- prefilter
t('prefilter accepts a Greenhouse confirmation', function () {
  ok(isCandidate_({ from: 'no-reply@us.greenhouse-mail.io', subject: 'Thanks!', body: 'hi' }));
});
t('prefilter accepts a plain-domain rejection by wording', function () {
  ok(isCandidate_({
    from: 'careers@somestartup.com', subject: 'Update on your application',
    body: 'Unfortunately we are not moving forward.'
  }));
});
t('prefilter drops unrelated personal mail', function () {
  ok(!isCandidate_({
    from: 'mum@gmail.com', subject: 'dinner sunday?',
    body: 'are you free at 7, bring the dog'
  }), 'personal mail should be skipped');
});

// ---------------------------------------------------------- body cleaning
t('body cleaning strips quoted replies and truncates', function () {
  var cleaned = cleanBody_('Real content here.\n\nOn Tue, Sep 2 someone wrote:\n> old junk\n> more junk');
  ok(cleaned.indexOf('old junk') === -1, 'quoted text removed');
  ok(cleaned.indexOf('Real content') === 0, 'kept the real body');
  var big = cleanBody_(new Array(9000).join('x'));
  ok(big.length <= CONFIG.MAX_BODY_CHARS + 20, 'truncated to cap');
});

// ------------------------------------------------------------ stage rules
t('stage never moves backwards', function () {
  eq(mergeStage_('Interview', 'Applied'), 'Interview');
  eq(mergeStage_('Applied', 'Interview'), 'Interview');
  eq(mergeStage_('Screening', 'Offer'), 'Offer');
});
t('rejection is terminal in both directions', function () {
  eq(mergeStage_('Interview', 'Rejected'), 'Rejected');
  eq(mergeStage_('Rejected', 'Interview'), 'Rejected');
});
t('stage derives from category then hint', function () {
  eq(stageFromTriage_({ category: 'application_confirmation', stage_hint: 'none' }), 'Applied');
  eq(stageFromTriage_({ category: 'rejection', stage_hint: 'none' }), 'Rejected');
  eq(stageFromTriage_({ category: 'interview_or_next_step', stage_hint: 'screening' }), 'Screening');
  eq(stageFromTriage_({ category: 'offer', stage_hint: 'none' }), 'Offer');
});

// ---------------------------------------------------------------- upsert
function fakeBook() {
  return { rows: [], appended: [], dirty: {}, companies: {}, newCompanies: [],
           processed: [], skipped: [], enrichCount: 99,  // enrichCount caps API calls
           // openBook_ defaults this off so the triage loop cannot research;
           // these tests are the research paths, which switch it on.
           mayResearch: true };
}
function msgAt(dayOffset) {
  return { threadId: 'T1', date: new Date(2026, 7, 1 + (dayOffset || 0)) };
}
var CONFIRM = {
  category: 'application_confirmation', company: 'Wiz', role: 'Security Researcher',
  location: 'Tel Aviv', job_url: 'https://x/1', source_ats: 'Greenhouse',
  stage_hint: 'none', confidence: 'high', evidence: 'received your application'
};

t('a confirmation creates one Open/Applied row', function () {
  var b = fakeBook();
  upsertApplication_(b, CONFIRM, msgAt(0));
  eq(b.appended.length, 1, 'one row appended');
  eq(b.appended[0][A_STATUS], 'Open');
  eq(b.appended[0][A_STAGE], 'Applied');
  eq(b.appended[0][A_COMPANY], 'Wiz');
});

t('a later rejection closes the same row, not a new one', function () {
  var b = fakeBook();
  upsertApplication_(b, CONFIRM, msgAt(0));
  var rej = JSON.parse(JSON.stringify(CONFIRM));
  rej.category = 'rejection';
  upsertApplication_(b, rej, msgAt(10));
  eq(b.appended.length, 1, 'still one row');
  eq(b.appended[0][A_STATUS], 'Closed');
  eq(b.appended[0][A_STAGE], 'Rejected');
  eq(Object.keys(b.dirty).length, 0, 'row created this run must not also be marked dirty');
});

t('a rejection against an existing sheet row marks it dirty', function () {
  var b = fakeBook();
  var existing = new Array(APP_HEADERS.length).fill('');
  existing[A_COMPANY] = 'Wiz, Inc.';
  existing[A_ROLE] = 'Security Researcher';
  existing[A_STATUS] = 'Open';
  existing[A_STAGE] = 'Applied';
  existing[A_MARKET] = 'Cybersecurity';
  b.rows.push(existing);

  var rej = JSON.parse(JSON.stringify(CONFIRM));
  rej.category = 'rejection';
  upsertApplication_(b, rej, msgAt(5));
  eq(b.appended.length, 0, 'no duplicate row');
  eq(b.rows[0][A_STATUS], 'Closed');
  eq(b.dirty[0], true, 'existing row flagged for write-back');
});

t('a different role at the same company is a separate application', function () {
  var b = fakeBook();
  upsertApplication_(b, CONFIRM, msgAt(0));
  var other = JSON.parse(JSON.stringify(CONFIRM));
  other.role = 'Backend Engineer';
  upsertApplication_(b, other, msgAt(1));
  eq(b.appended.length, 2, 'two roles, two rows');
});

t('an interview email advances the stage but keeps it Open', function () {
  var b = fakeBook();
  upsertApplication_(b, CONFIRM, msgAt(0));
  var inv = JSON.parse(JSON.stringify(CONFIRM));
  inv.category = 'interview_or_next_step';
  inv.stage_hint = 'interview';
  upsertApplication_(b, inv, msgAt(3));
  eq(b.appended.length, 1);
  eq(b.appended[0][A_STAGE], 'Interview');
  eq(b.appended[0][A_STATUS], 'Open');
});

t('a rejection with no prior application still lands as a Closed row', function () {
  var b = fakeBook();
  var rej = JSON.parse(JSON.stringify(CONFIRM));
  rej.category = 'rejection';
  rej.company = 'GhostCo';
  upsertApplication_(b, rej, msgAt(0));
  eq(b.appended.length, 1, 'orphan rejection is visible, not dropped');
  eq(b.appended[0][A_STATUS], 'Closed');
  eq(b.appended[0][A_APPLIED], '', 'no applied date invented');
});

t('an email with no company name is refused', function () {
  var b = fakeBook();
  var bad = JSON.parse(JSON.stringify(CONFIRM));
  bad.company = '';
  eq(upsertApplication_(b, bad, msgAt(0)), 'skipped: no company');
  eq(b.appended.length, 0);
});

t('the quiet-days formula is blank for closed rows', function () {
  ok(quietFormula_(5).indexOf('$E5="Closed"') !== -1, 'guards on status');
  ok(quietFormula_(5).indexOf('TODAY()-INT($H5)') !== -1, 'counts from last update');
});

t('every row gets the current quiet formula, not just the written ones', function () {
  // Otherwise a fix to quietFormula_ only reaches a row when an email next
  // touches it, and the rest of the sheet keeps the old formula indefinitely.
  var written = null;
  var sheet = {
    getLastRow: function () { return 4; },
    getRange: function (row, col, numRows, numCols) {
      written = { row: row, col: col, numRows: numRows, numCols: numCols };
      return { setValues: function (values) { written.values = values; } };
    }
  };
  refreshQuietColumn_(sheet);
  eq(written.col, A_QUIET + 1, 'targets the Days quiet column');
  eq(written.row, 2, 'starts below the header');
  eq(written.numRows, 3, 'covers every data row');
  eq(written.values[0][0], quietFormula_(2));
  eq(written.values[2][0], quietFormula_(4), 'each row gets its own row number');
});

t('refreshing an empty sheet writes nothing', function () {
  var touched = false;
  refreshQuietColumn_({
    getLastRow: function () { return 1; },
    getRange: function () { touched = true; return { setValues: function () {} }; }
  });
  ok(!touched, 'a header-only sheet is left alone');
});

// ------------------------------------------------------------- row ordering
function orderingSheet(dataRows) {
  var calls = [];
  return {
    calls: calls,
    getLastRow: function () { return dataRows + 1; },
    getRange: function (row, col, numRows, numCols) {
      return {
        setValues: function () {
          calls.push({ op: 'setValues', row: row, col: col, numRows: numRows, numCols: numCols });
        },
        sort: function (spec) {
          calls.push({ op: 'sort', row: row, col: col, numRows: numRows,
                       numCols: numCols, by: spec.column, ascending: spec.ascending });
        }
      };
    }
  };
}

t('the table is sorted by Last update, newest first', function () {
  var sheet = orderingSheet(3);
  sortByLastUpdate_(sheet);
  eq(sheet.calls.length, 1, 'one batched sort, not a move per row');
  var call = sheet.calls[0];
  eq(call.op, 'sort');
  eq(call.by, A_UPDATED + 1, 'sorts on Last update');
  eq(call.ascending, false, 'newest first');
  eq(call.row, 2, 'leaves the header where it is');
  eq(call.numRows, 3, 'covers every data row, including ones this run never loaded');
  eq(call.numCols, APP_HEADERS.length, 'moves whole rows, not one column');
});

t('a table with nothing to reorder is left alone', function () {
  var single = orderingSheet(1);
  sortByLastUpdate_(single);
  var empty = orderingSheet(0);
  sortByLastUpdate_(empty);
  eq(single.calls.length, 0, 'one row cannot be out of order');
  eq(empty.calls.length, 0, 'nor can none');
});

t('the flush sorts before it rewrites the quiet formulas', function () {
  // The other way round and every formula would be rewritten for the row it
  // used to be on, then dragged somewhere else by the sort.
  var sheet = orderingSheet(3);
  flushBook_({ appSheet: sheet, rows: [], dirty: {}, appended: [],
               newCompanies: [], processed: [], skipped: [] });
  var ops = sheet.calls.map(function (c) { return c.op; });
  eq(ops, ['sort', 'setValues'], 'sort, then the derived column');
  eq(sheet.calls[1].col, A_QUIET + 1, 'the write after the sort is Days quiet');
});

t('a role-less email updates the most recently updated open row, wherever it sits',
  function () {
    function openRow(role, updated) {
      var r = new Array(APP_HEADERS.length).fill('');
      r[A_COMPANY] = 'Wiz';
      r[A_ROLE] = role;
      r[A_STATUS] = 'Open';
      r[A_STAGE] = 'Applied';
      r[A_MARKET] = 'Cybersecurity';
      r[A_UPDATED] = updated;
      return r;
    }
    var rej = JSON.parse(JSON.stringify(CONFIRM));
    rej.category = 'rejection';
    rej.role = '';  // rejections often name no role, which is what allows the fallback

    // Newest-first is how the sheet is kept now; oldest-first is how it used to
    // be. The fallback compares dates, so neither order changes which row wins.
    [['recent', 'old'], ['old', 'recent']].forEach(function (order) {
      var b = fakeBook();
      order.forEach(function (which) {
        b.rows.push(which === 'recent'
          ? openRow('Newer Role', new Date(2026, 7, 20))
          : openRow('Older Role', new Date(2026, 7, 1)));
      });
      upsertApplication_(b, rej, msgAt(25));
      eq(b.appended.length, 0, 'no duplicate row');
      var closed = b.rows.filter(function (r) { return r[A_STATUS] === 'Closed'; });
      eq(closed.length, 1, 'exactly one row closed');
      eq(closed[0][A_ROLE], 'Newer Role', 'closed the most recently updated one');
    });
  });

t('the quiet-days formula counts whole days', function () {
  // Last update is a timestamp, TODAY() is midnight; without INT() the column
  // renders a fraction like 0.3251041 instead of a day count.
  ok(quietFormula_(5).indexOf('INT($H5)') !== -1, 'the timestamp is floored');
});

// ------------------------------------------- role-matching regression tests
t('a role-less rejection still finds the open row', function () {
  var b = fakeBook();
  upsertApplication_(b, CONFIRM, msgAt(0));
  var rej = JSON.parse(JSON.stringify(CONFIRM));
  rej.category = 'rejection';
  rej.role = '';                      // rejections often omit the role
  upsertApplication_(b, rej, msgAt(9));
  eq(b.appended.length, 1, 'matched the open row rather than creating one');
  eq(b.appended[0][A_STATUS], 'Closed');
});

t('a fallback match is downgraded to low confidence', function () {
  var b = fakeBook();
  var existing = new Array(APP_HEADERS.length).fill('');
  existing[A_COMPANY] = 'Wiz';
  existing[A_ROLE] = 'Security Researcher';
  existing[A_STATUS] = 'Open';
  existing[A_STAGE] = 'Applied';
  existing[A_MARKET] = 'Cybersecurity';
  b.rows.push(existing);

  var rej = JSON.parse(JSON.stringify(CONFIRM));
  rej.category = 'rejection';
  rej.role = 'Researcher, Security';  // same job, different wording
  rej.confidence = 'high';
  upsertApplication_(b, rej, msgAt(4));
  eq(b.rows[0][A_STATUS], 'Closed');
  eq(b.rows[0][A_CONF], 'low', 'guessed match flagged for review');
});

t('an exact role match keeps the extraction confidence', function () {
  var b = fakeBook();
  upsertApplication_(b, CONFIRM, msgAt(0));
  var inv = JSON.parse(JSON.stringify(CONFIRM));
  inv.category = 'interview_or_next_step';
  inv.stage_hint = 'interview';
  inv.confidence = 'high';
  upsertApplication_(b, inv, msgAt(2));
  eq(b.appended[0][A_CONF], 'high');
});

// ------------------------------------------------- load-order regression
// Apps Script evaluates files alphabetically, so Claude.gs loads before
// Config.gs. Anything built at load time from Config's vars gets undefined,
// and JSON.stringify drops undefined keys silently - shipping a schema with
// no constraints and no error. Both schemas are built lazily to avoid this.
t('triage schema carries its enums after an alphabetical load', function () {
  var schema = triageSchema_();
  ok(schema.properties.category.enum, 'category enum present');
  eq(schema.properties.category.enum.length, CATEGORIES.length);
  ok(schema.properties.confidence.enum.indexOf('low') !== -1, 'confidence enum present');
  ok(JSON.stringify(schema).indexOf('application_confirmation') !== -1,
     'enum survives serialization');
});

t('company tool carries the market vocabulary', function () {
  var tool = companyTool_();
  ok(tool.input_schema.properties.market.enum, 'market enum present');
  eq(tool.input_schema.properties.market.enum.length, MARKETS.length);
  ok(tool.strict === true, 'strict tool use stays on');
});

t('no schema is built at load time', function () {
  // If either is ever hoisted back to a top-level var, this fails.
  ok(typeof triageSchema_ === 'function', 'triage schema is a function');
  ok(typeof companyTool_ === 'function', 'company tool is a function');
});

// ------------------------------------------------ dry-run / dedupe contract
// A dry run is a rehearsal. If its message IDs counted as processed, flipping
// DRY_RUN to false would leave every message already "done" and the real run
// would write nothing while reporting success.
function skippedRow(id) {
  var r = new Array(SKIPPED_HEADERS.length).fill('');
  r[0] = id;
  return r;
}
function withTabs(processedRows, skippedRows, fn) {
  var sheets = {};
  sheets[TABS.PROCESSED] = fakeSheet(PROCESSED_HEADERS, processedRows);
  sheets[TABS.SKIPPED] = fakeSheet(SKIPPED_HEADERS, skippedRows);
  var original = getSheet_;
  getSheet_ = function (name) { return sheets[name]; };
  try { return fn(sheets); } finally { getSheet_ = original; }
}
function fakeSheet(headers, rows) {
  var data = [headers].concat(rows);
  return {
    getLastRow: function () { return data.length; },
    getRange: function (r, c, n, w) {
      return {
        getValues: function () {
          return data.slice(r - 1, r - 1 + n).map(function (row) { return row.slice(c - 1, c - 1 + w); });
        },
        clearContent: function () { data = [headers]; },
        setValues: function (v) { data = [headers].concat(v); }
      };
    },
    _data: function () { return data; }
  };
}
function processedRow(id, action) {
  var r = new Array(PROCESSED_HEADERS.length).fill('');
  r[0] = id;
  r[P_ACTION] = action;
  return r;
}

t('dry-run rows are not treated as already processed', function () {
  withTabs([processedRow('m1', 'dry-run'), processedRow('m2', 'dry-run')], [],
    function () {
      eq(Object.keys(loadProcessedIds_()).length, 0,
         'a rehearsal must not consume the messages');
    });
});

t('real rows are treated as already processed', function () {
  withTabs([processedRow('m1', 'created Wiz / Researcher'),
            processedRow('m2', 'ignored (not_related)')], [],
    function () {
      var seen = loadProcessedIds_();
      ok(seen['m1'] && seen['m2'], 'genuinely handled messages are skipped');
    });
});

t('purging drops only the rehearsal rows', function () {
  withTabs([processedRow('m1', 'dry-run'),
            processedRow('m2', 'created Wiz / Researcher'),
            processedRow('m3', 'dry-run')], [],
    function (sheets) {
      eq(purgeDryRunRows_(), 2, 'two rehearsal rows removed');
      var left = sheets[TABS.PROCESSED]._data().slice(1);
      eq(left.length, 1);
      eq(left[0][0], 'm2', 'the real row survives');
    });
});

t('purging is a no-op when there is nothing to purge', function () {
  withTabs([processedRow('m1', 'created Wiz / Researcher')], [], function () {
    eq(purgeDryRunRows_(), 0);
  });
});


// -------------------------------------- backfill termination (runaway guard)
// Skipped messages must be recorded, or every backfill chunk re-collects the
// same non-job mail, hitLimit never clears, and the 60-second continuation
// trigger re-queues itself forever.
t('skipped messages count as seen, so the window drains', function () {
  withTabs([], [skippedRow('m1'), skippedRow('m2')], function () {
    var seen = loadProcessedIds_();
    ok(seen['m1'] && seen['m2'], 'skipped mail is not re-collected next chunk');
  });
});

t('processed and skipped IDs are merged', function () {
  withTabs([processedRow('p1', 'created Wiz / Researcher')], [skippedRow('s1')],
    function () {
      var seen = loadProcessedIds_();
      ok(seen['p1'], 'triaged message seen');
      ok(seen['s1'], 'skipped message seen');
      eq(Object.keys(seen).length, 2);
    });
});

t('a rehearsal still consumes nothing, even alongside skipped mail', function () {
  withTabs([processedRow('p1', 'dry-run')], [skippedRow('s1')], function () {
    var seen = loadProcessedIds_();
    ok(!seen['p1'], 'dry-run row ignored');
    ok(seen['s1'], 'skipped row still counts - it cost nothing to decide');
  });
});

t('rescanning clears skipped mail for reconsideration', function () {
  withTabs([], [skippedRow('s1'), skippedRow('s2')], function (sheets) {
    eq(clearSkipped_(), 2);
    eq(sheets[TABS.SKIPPED]._data().length, 1, 'header row only');
    eq(Object.keys(loadProcessedIds_()).length, 0, 'now eligible again');
  });
});

t('a skipped row carries the message ID first', function () {
  eq(SKIPPED_HEADERS[0], 'Message ID');
  eq(SKIPPED_HEADERS.length, 5);
});


// ---------------------------------------------- untrusted input into cells
// Everything written to the sheet came from an email or a model reading one,
// so all of it is attacker-influenceable.
t('formula injection is neutralised', function () {
  eq(safeCell_('=HYPERLINK("http://evil","click")').charAt(0), "'");
  eq(safeCell_('+1234').charAt(0), "'");
  eq(safeCell_('-cmd').charAt(0), "'");
  eq(safeCell_('@import').charAt(0), "'");
  eq(safeCell_('Wiz'), 'Wiz', 'ordinary names are untouched');
});

t('control characters and runaway length are trimmed', function () {
  var withCtrl = 'Acme' + String.fromCharCode(1) + ' Corp';
  eq(safeCell_(withCtrl), 'Acme  Corp');
  var long = safeCell_(new Array(900).join('x'), 100);
  ok(long.length <= 100, 'capped');
  eq(long.charAt(long.length - 1), '…', 'marked as truncated');
});

t('dates and numbers pass through unchanged', function () {
  var d = new Date(2026, 0, 1);
  ok(safeCell_(d) === d, 'Date object preserved for the date columns');
  eq(safeCell_(42), 42);
  eq(safeCell_(''), '');
});

t('degenerate model output is recognised', function () {
  var frag = '<' + '/parameter>' + '<parameter name="website">';
  ok(looksDegenerate_(frag), 'tool-call scaffolding');
  ok(looksDegenerate_('<' + 'div>hello<' + '/div>'), 'markup');
  ok(!looksDegenerate_('Algorio builds scheduling software for clinics.'), 'real prose');
});

t('a malformed profile is replaced rather than written', function () {
  var bad = sanitizeProfile_({
    market: 'Cybersecurity',
    description: '<' + '/parameter>' + '<parameter name="website">',
    sub_market: '', website: '', hq_location: '', employee_range: '', founded_year: ''
  });
  eq(bad.market, 'Unknown', 'a market is not claimed on unusable output');
  ok(bad.description.indexOf('re-run from the menu') !== -1, 'actionable placeholder');
  ok(!looksDegenerate_(bad.description), 'garbage never reaches the cell');
});

t('an off-vocabulary market falls back to Unknown', function () {
  var p = sanitizeProfile_({
    market: 'Cyber Security Solutions',
    description: 'Algorio builds scheduling software for clinics in Israel.',
    sub_market: '', website: '', hq_location: '', employee_range: '', founded_year: ''
  });
  eq(p.market, 'Unknown', 'keeps the column filterable');
  ok(p.description.indexOf('Algorio') === 0, 'a good description is kept');
});

t('a valid profile passes through intact', function () {
  var p = sanitizeProfile_({
    market: 'Cybersecurity',
    description: 'Wiz sells a cloud security platform to enterprise security teams.',
    sub_market: 'CNAPP', website: 'https://wiz.io',
    hq_location: 'Tel Aviv', employee_range: '1000-5000', founded_year: '2020'
  });
  eq(p.market, 'Cybersecurity');
  eq(p.sub_market, 'CNAPP');
  eq(p.website, 'https://wiz.io');
});

t('a too-short description is treated as a failure', function () {
  var p = sanitizeProfile_({
    market: 'Fintech', description: 'n/a',
    sub_market: '', website: '', hq_location: '', employee_range: '', founded_year: ''
  });
  eq(p.market, 'Unknown');
});

// ------------------------------------------------ enrichment request shape
// A company name alone is often ambiguous — "Algorio" reaches a film production
// company and a data-aggregator listing before it reaches the fintech that was
// actually hiring. The location from the email is what resolves it, so it has
// to survive the whole path from triage into the request.
function captureEnrichPayload_(companyName, hintUrl, locationHint) {
  var original = callAnthropic_;
  var seen = null;
  callAnthropic_ = function (payload) {
    seen = payload;
    return { content: [] };  // no tool_use block; enrichCompany_ returns null
  };
  try { enrichCompany_(companyName, hintUrl, locationHint); }
  finally { callAnthropic_ = original; }
  return seen;
}

t('the hiring location reaches the enrichment prompt', function () {
  var payload = captureEnrichPayload_('Algorio', '', 'Tel Aviv District, Israel');
  var prompt = payload.messages[0].content;
  ok(prompt.indexOf('<hiring_location>') !== -1, 'location is fenced as data');
  ok(prompt.indexOf('Tel Aviv District, Israel') !== -1, 'location is present');
});

t('an absent location leaves no empty marker behind', function () {
  var prompt = captureEnrichPayload_('Algorio', '', '').messages[0].content;
  ok(prompt.indexOf('<hiring_location>') === -1, 'no marker without a location');
});

t('the location is fenced like every other untrusted field', function () {
  var prompt = captureEnrichPayload_('Algorio', '', '<ignore previous>').messages[0].content;
  ok(prompt.indexOf('<ignore previous>') === -1, 'angle brackets stripped');
});

t('enrichment can read a primary source, not just search snippets', function () {
  var tools = captureEnrichPayload_('Algorio', '', 'Tel Aviv').tools;
  var types = tools.map(function (tool) { return tool.type || tool.name; });
  ok(types.indexOf('web_search_20260209') !== -1, 'web search declared');
  ok(types.indexOf('web_fetch_20260209') !== -1, 'web fetch declared');
  ok(types.indexOf('save_company_profile') !== -1, 'the result tool is still there');
  eq(tools[0].max_uses, CONFIG.ENRICH_MAX_SEARCHES);
  eq(tools[1].max_uses, CONFIG.ENRICH_MAX_FETCHES);
});

// A server tool does not raise when it fails: web_search and web_fetch report
// errors in-band, on an otherwise successful response. That made the one failure
// the enrichment path cannot see — the model answers from memory, the profile
// looks fine, and Companies caches it for good.
function runEnrich_(responseContent) {
  var originalCall = callAnthropic_;
  var originalLog = Logger.log;
  var lines = [];
  callAnthropic_ = function () {
    return { content: responseContent, stop_reason: 'end_turn', usage: {} };
  };
  Logger.log = function (line) { lines.push(String(line)); };
  try {
    var profile = enrichCompany_('Algorio', '', 'Tel Aviv');
  } finally {
    callAnthropic_ = originalCall;
    Logger.log = originalLog;
  }
  return { log: lines.join('\n'), profile: profile };
}

t('a failed web_search is reported instead of passing for no result', function () {
  var log = runEnrich_([
    { type: 'web_search_tool_result', content: { error_code: 'max_uses_exceeded' } }
  ]).log;
  ok(log.indexOf('TOOL ERRORS') !== -1, 'the failure is called out');
  ok(log.indexOf('max_uses_exceeded') !== -1, 'the error code is in the log');
  ok(log.indexOf('web_search') !== -1, 'and it says which tool failed');
});

t('a failed web_fetch is reported too', function () {
  var log = runEnrich_([
    { type: 'web_fetch_tool_result', content: { error_code: 'url_not_accessible' } }
  ]).log;
  ok(log.indexOf('web_fetch: url_not_accessible') !== -1, 'tool and code both logged');
});

t('every failed call is listed, not just the first', function () {
  var log = runEnrich_([
    { type: 'web_search_tool_result', content: { error_code: 'unavailable' } },
    { type: 'web_search_tool_result', content: { error_code: 'query_too_long' } }
  ]).log;
  ok(log.indexOf('unavailable') !== -1 && log.indexOf('query_too_long') !== -1,
     'both codes survive');
});

t('a turn whose tools all worked reports nothing', function () {
  var log = runEnrich_([
    { type: 'web_search_tool_result',
      content: [{ type: 'web_search_result', title: 'Algorio', url: 'https://algor.io' }] },
    { type: 'web_fetch_tool_result',
      content: { type: 'web_fetch_result', document: { type: 'document' } } },
    { type: 'text', text: 'Algorio builds trading infrastructure.' }
  ]).log;
  ok(log.indexOf('TOOL ERRORS') === -1, 'a clean turn stays quiet');
  ok(log.indexOf('enriched Algorio') !== -1, 'the usual line is still written');
});

t('a tool error does not cost a profile the model still produced', function () {
  var run = runEnrich_([
    { type: 'web_search_tool_result', content: { error_code: 'unavailable' } },
    { type: 'tool_use', name: 'save_company_profile',
      input: { market: 'Fintech', description: 'Algorio builds trading infrastructure.' } }
  ]);
  eq(run.profile.market, 'Fintech');
  ok(run.log.indexOf('unavailable') !== -1, 'and the failure is still on the record');
});

t('companyProfile_ hands the location to the research call', function () {
  var original = enrichCompany_;
  var seen = null;
  enrichCompany_ = function (name, url, location) {
    seen = { name: name, url: url, location: location };
    return {
      market: 'Fintech', sub_market: 'algorithmic trading infrastructure',
      description: 'Algorio builds algorithmic trading infrastructure for trading firms.',
      website: 'https://algor.io', hq_location: 'Tel Aviv',
      employee_range: '', founded_year: ''
    };
  };
  var book = { companies: {}, newCompanies: [], enrichCount: 0, mayResearch: true };
  try {
    var profile = companyProfile_(book, 'Algorio', 'https://example.com/job', 'Tel Aviv');
    eq(seen.location, 'Tel Aviv');
    eq(profile.market, 'Fintech');
  } finally { enrichCompany_ = original; }
});

// ------------------------------------------------- loss-prevention contract
// Every path here exists because a message can be examined, paid for, and then
// silently dropped — which is how a month of applications went missing while
// the sheet looked complete.

t('a failed upsert is retried rather than counted as done', function () {
  withTabs([processedRow('m1', 'error: Exception: boom')], [], function () {
    eq(Object.keys(loadProcessedIds_()).length, 0,
       'a message whose write threw must be reconsidered');
  });
});

t('a successful action still counts as done', function () {
  withTabs([processedRow('m1', 'created Wiz / Backend Engineer'),
            processedRow('m2', 'ignored (job_alert_or_marketing)')], [], function () {
    eq(Object.keys(loadProcessedIds_()).length, 2, 'real outcomes are final');
  });
});

t('dry-run and error rows are both retryable, nothing else is', function () {
  ok(isRetryable_('dry-run'), 'rehearsal');
  ok(isRetryable_('error: Exception: boom'), 'failed write');
  ok(!isRetryable_('created Wiz / Backend Engineer'), 'a created row is done');
  ok(!isRetryable_('ignored (not_related)'), 'a deliberate skip is done');
  ok(!isRetryable_(''), 'an empty action is not a licence to reprocess');
});

t('research is refused when the run is nearly out of time', function () {
  var book = fakeBook();
  book.enrichCount = 0;               // the cap is not what should stop this
  book.deadline = Date.now() + 1000;  // less than ENRICH_RESERVE_SECONDS left
  ok(!enrichBudgetLeft_(book), 'no time to start a 90-second call');

  var called = false;
  var original = enrichCompany_;
  enrichCompany_ = function () { called = true; return null; };
  try {
    var profile = companyProfile_(book, 'Algorio', '', 'Tel Aviv');
    eq(profile.market, '', 'left blank for a later run');
    ok(!called, 'the API was never called');
  } finally { enrichCompany_ = original; }
});

t('a run with time to spare still researches', function () {
  var book = startClock_(fakeBook());
  ok(enrichBudgetLeft_(book), 'a fresh run has room for a company');
  ok(triageBudgetLeft_(book), 'and certainly for an email');
});

t('a book with no deadline is unrestricted', function () {
  ok(enrichBudgetLeft_(fakeBook()), 'menu-driven calls are not time-boxed by accident');
});

// ------------------------------------------------------ the run budget
// Two users' pollInbox triggers died at the 6-minute ceiling every half hour,
// each kill discarding a whole run's worth of paid-for triage. The guard was
// asking the wrong question: "is there time left?" rather than "can this call
// finish and still leave room to write?".

t('a call that cannot finish is refused even with budget left on the clock', function () {
  var book = fakeBook();
  var now = Date.now();
  // The shape that killed those runs: inside the soft budget, but the call
  // would not be back before the execution is destroyed.
  book.deadline = now + (CONFIG.ENRICH_MAX_SECONDS + 30) * 1000;
  book.hardDeadline = now + (CONFIG.ENRICH_MAX_SECONDS - 30) * 1000;
  ok(!enrichBudgetLeft_(book), 'the kill is what the reserve is measured against');
});

t('the reserves leave room for the flush', function () {
  // Whatever the knobs are tuned to, the worst case of one call of each kind
  // has to land before the kill with the flush still ahead of it.
  var headroom = CONFIG.HARD_LIMIT_SECONDS - CONFIG.FLUSH_RESERVE_SECONDS;
  ok(CONFIG.ENRICH_MAX_SECONDS < headroom, 'a company fits');
  ok(CONFIG.TRIAGE_MAX_SECONDS < headroom, 'an email fits');
  ok(CONFIG.FLUSH_RESERVE_SECONDS > 0, 'the flush is never the thing that is cut');
});

t('the message loop stops before a triage it has no room for', function () {
  var book = fakeBook();
  var now = Date.now();
  book.deadline = now + (CONFIG.TRIAGE_MAX_SECONDS + 60) * 1000;
  book.hardDeadline = now + (CONFIG.TRIAGE_MAX_SECONDS - 10) * 1000;
  ok(!triageBudgetLeft_(book), 'a retrying triage can run for minutes too');
});

t('the triage loop never researches, whatever the clock says', function () {
  // The loop's work is only safe once it is flushed, so research belongs to the
  // pass that runs after the flush. openBook_ hands out books with it off.
  var book = startClock_(fakeBook());
  book.enrichCount = 0;
  book.mayResearch = false;
  var called = false;
  var original = enrichCompany_;
  enrichCompany_ = function () { called = true; return null; };
  try {
    var profile = companyProfile_(book, 'Algorio', '', 'Tel Aviv');
    ok(!called, 'no research during the loop');
    eq(profile.market, '', 'the row is left blank for the research pass');
    eq(book.newCompanies.length, 0, 'and nothing is cached from a call never made');
  } finally { enrichCompany_ = original; }
});

t('a failed enrichment is not retried four times over', function () {
  // Each retry re-runs the searches and the fetch, so four attempts cost four
  // calls and four times the wall clock — the whole execution, for one company.
  var attempts = 0;
  var originalFetch = UrlFetchApp;
  UrlFetchApp = {
    fetch: function () {
      attempts++;
      return {
        getResponseCode: function () { return 529; },
        getContentText: function () { return '{"type":"overloaded_error"}'; }
      };
    }
  };
  try {
    withProps({ ANTHROPIC_API_KEY: 'test-key' }, function () {
      try {
        callAnthropic_({ model: CONFIG.ENRICH_MODEL }, CONFIG.ENRICH_MAX_ATTEMPTS);
      } catch (e) { /* expected: it gives up */ }
    });
    eq(attempts, CONFIG.ENRICH_MAX_ATTEMPTS, 'one tool loop, not four');
    ok(CONFIG.ENRICH_MAX_ATTEMPTS < CONFIG.API_MAX_ATTEMPTS,
       'triage is cheap to repeat; enrichment is not');
  } finally { UrlFetchApp = originalFetch; }
});

t('triage keeps the retries it is cheap enough to deserve', function () {
  var attempts = 0;
  var originalFetch = UrlFetchApp;
  UrlFetchApp = {
    fetch: function () {
      attempts++;
      return {
        getResponseCode: function () { return 500; },
        getContentText: function () { return '{}'; }
      };
    }
  };
  try {
    withProps({ ANTHROPIC_API_KEY: 'test-key' }, function () {
      try { callAnthropic_({ model: CONFIG.TRIAGE_MODEL }); }
      catch (e) { /* expected */ }
    });
    eq(attempts, CONFIG.API_MAX_ATTEMPTS, 'the default still applies to triage');
  } finally { UrlFetchApp = originalFetch; }
});

// fillMissingProfiles_ spends money, so it is a no-op during a rehearsal. These
// exercise the real path.
function whileWriting(fn) {
  var was = CONFIG.DRY_RUN;
  CONFIG.DRY_RUN = false;
  try { return fn(); } finally { CONFIG.DRY_RUN = was; }
}

t('a rehearsal never pays for research', function () {
  var book = fakeBook();
  book.enrichCount = 0;
  book.rows = [['Algorio', 'Backend', '', '', 'Open', 'Applied',
                '', '', '', '', '', 'Tel Aviv', '', '', '']];
  var called = false;
  var original = enrichCompany_;
  enrichCompany_ = function () { called = true; return null; };
  try {
    CONFIG.DRY_RUN = true;
    eq(fillMissingProfiles_(book), 0, 'nothing filled');
    ok(!called, 'no API call during a dry run');
  } finally { enrichCompany_ = original; }
});

t('leftover budget fills in rows whose Market never got written', function () {
  var book = fakeBook();
  book.enrichCount = 0;
  book.rows = [
    ['Algorio', 'Backend', '', '', 'Open', 'Applied', '', '', '', '', '', 'Tel Aviv', '', '', ''],
    ['Wiz', 'Security', 'Cybersecurity', 'desc', 'Open', 'Applied', '', '', '', '', '', '', '', '', '']
  ];
  var asked = [];
  var original = enrichCompany_;
  enrichCompany_ = function (name, url, location) {
    asked.push({ name: name, location: location });
    return {
      market: 'Fintech', sub_market: '', description: 'Algorio builds trading infrastructure.',
      website: '', hq_location: '', employee_range: '', founded_year: ''
    };
  };
  try {
    eq(whileWriting(function () { return fillMissingProfiles_(book); }), 1,
       'only the blank row is researched');
    eq(asked.length, 1);
    eq(asked[0].name, 'Algorio');
    eq(asked[0].location, 'Tel Aviv', 'the row carries its own location hint');
    eq(book.rows[0][A_MARKET], 'Fintech');
    ok(book.dirty[0], 'the filled row is queued for writing');
    ok(!book.dirty[1], 'the complete row is left alone');
  } finally { enrichCompany_ = original; }
});

t('filling in stops at the per-run cap instead of blanking rows', function () {
  var book = fakeBook();
  book.enrichCount = 0;
  book.rows = [];
  for (var i = 0; i < CONFIG.MAX_ENRICH_PER_RUN + 2; i++) {
    book.rows.push(['Co' + i, 'Role', '', '', 'Open', 'Applied',
                    '', '', '', '', '', '', '', '', '']);
  }
  var original = enrichCompany_;
  enrichCompany_ = function () {
    return {
      market: 'Other', sub_market: '', description: 'A company that does things.',
      website: '', hq_location: '', employee_range: '', founded_year: ''
    };
  };
  try {
    eq(whileWriting(function () { return fillMissingProfiles_(book); }),
       CONFIG.MAX_ENRICH_PER_RUN, 'stops at the cap');
    eq(book.rows[CONFIG.MAX_ENRICH_PER_RUN][A_MARKET], '',
       'rows past the cap are left blank, not overwritten');
  } finally { enrichCompany_ = original; }
});

t('what research did not reach is said out loud, and only then', function () {
  // A blank Market looks the same whether the research failed, was capped, or
  // was never attempted — so the run has to say which.
  function fillAndLog(rowCount) {
    var book = fakeBook();
    book.enrichCount = 0;
    book.rows = [];
    for (var i = 0; i < rowCount; i++) {
      book.rows.push(['Co' + i, 'Role', '', '', 'Open', 'Applied',
                      '', '', '', '', '', '', '', '', '']);
    }
    var lines = [];
    var originalLog = Logger.log;
    var original = enrichCompany_;
    Logger.log = function (line) { lines.push(String(line)); };
    enrichCompany_ = function () {
      return { market: 'Other', sub_market: '', description: 'A company that does things.',
               website: '', hq_location: '', employee_range: '', founded_year: '' };
    };
    try { whileWriting(function () { fillMissingProfiles_(book); }); }
    finally { Logger.log = originalLog; enrichCompany_ = original; }
    return lines.join('\n');
  }

  var left = fillAndLog(CONFIG.MAX_ENRICH_PER_RUN + 2);
  ok(left.indexOf('research stopped with 2 row(s)') !== -1,
     'the leftovers are counted: ' + left);

  var none = fillAndLog(CONFIG.MAX_ENRICH_PER_RUN);
  ok(none.indexOf('research stopped') === -1,
     'a pass that reached every row stays quiet: ' + none);
});

t('no profile field is exempt from the degeneracy check', function () {
  // Founded came back as tool-call scaffolding once, truncated to ten
  // characters by safeCell_ and looking like a parsing quirk in the sheet.
  var junk = '</antml:parameter>';
  var p = sanitizeProfile_({
    market: 'Fintech',
    description: 'Algorio builds algorithmic trading infrastructure for trading firms.',
    sub_market: junk, website: junk,
    hq_location: junk, employee_range: junk, founded_year: junk
  });
  eq(p.founded_year, '', 'founded_year is screened');
  eq(p.hq_location, '', 'hq_location is screened');
  eq(p.employee_range, '', 'employee_range is screened');
  eq(p.sub_market, '');
  eq(p.website, '');
  eq(p.market, 'Fintech', 'a clean description still stands');
});

t('clean short fields survive the check', function () {
  var p = sanitizeProfile_({
    market: 'Fintech',
    description: 'Algorio builds algorithmic trading infrastructure for trading firms.',
    sub_market: 'algorithmic trading', website: 'https://algor.io',
    hq_location: 'Tel Aviv District, Israel', employee_range: '1-10',
    founded_year: '2024'
  });
  eq(p.founded_year, '2024');
  eq(p.hq_location, 'Tel Aviv District, Israel');
  eq(p.employee_range, '1-10');
});

// -------------------------------------- transient vs permanent API failures
// A dead API is worth retrying forever. A response that cannot be parsed is
// not: holding the cursor for it stops the backfill dead, because every chunk
// rewinds to the same message and never gets past it.

t('an unparseable response is marked permanent', function () {
  var err = permanentError_('triage response was not valid JSON');
  ok(err.permanent === true, 'tagged for the caller');
  ok(err instanceof Error, 'still a real Error');
});

t('a plain API failure is not permanent, so it keeps its retry', function () {
  ok(!(new Error('Anthropic API 400: credit balance too low')).permanent,
     'an outage must not be written off as unclassifiable');
});

t('a message that could not be classified is not reconsidered forever', function () {
  ok(!isRetryable_('failed: triage response was truncated at max_tokens'),
     'retrying it would pin the cursor and stall the window');
  ok(isRetryable_('error: Exception: sheet write failed'),
     'a transient write failure still gets another attempt');
});

// ------------------------------------------------------------ spend ceiling
// An uncapped web_fetch put a whole page into the conversation, where it was
// re-sent as input on every following turn. One company reached dollars. The
// ceiling is the backstop for whatever the next such mistake turns out to be.
function withProps(store, fn) {
  var original = PropertiesService;
  PropertiesService = {
    getScriptProperties: function () {
      return {
        getProperty: function (k) { return k in store ? store[k] : null; },
        setProperty: function (k, v) { store[k] = String(v); },
        deleteProperty: function (k) { delete store[k]; }
      };
    }
  };
  try { return fn(); } finally { PropertiesService = original; }
}

t('a response is priced from its own usage', function () {
  var store = {};
  withProps(store, function () {
    var cost = recordSpend_('claude-opus-5', {
      input_tokens: 200000, output_tokens: 1000,
      server_tool_use: { web_search_requests: 3 }
    });
    // 200k in at $5/MTok = $1.00, 1k out at $25/MTok = $0.025, 3 searches = $0.03
    ok(Math.abs(cost - 1.055) < 0.001, 'got ' + cost);
    ok(Math.abs(spendToday_() - 1.055) < 0.001, 'added to the running total');
  });
});

t('cached input is counted, not billed as free', function () {
  withProps({}, function () {
    var cost = recordSpend_('claude-haiku-4-5', {
      input_tokens: 1000, cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 1000, output_tokens: 0
    });
    ok(Math.abs(cost - 0.003) < 0.0001, 'the ceiling errs high, got ' + cost);
  });
});

t('spend rolls over to zero on a new day', function () {
  var store = { SPEND_DAY: '2020-01-01', SPEND_USD: '99' };
  withProps(store, function () {
    eq(spendToday_(), 0, 'yesterday does not count against today');
    eq(store.SPEND_USD, '0');
  });
});

t('no request leaves the script once the day is over budget', function () {
  var store = {
    SPEND_DAY: new Date().toISOString().substring(0, 10),
    SPEND_USD: String(CONFIG.DAILY_BUDGET_USD)
  };
  var fetched = false;
  var originalFetch = UrlFetchApp;
  UrlFetchApp = { fetch: function () { fetched = true; throw new Error('should not run'); } };
  try {
    withProps(store, function () {
      var threw = '';
      try { callAnthropic_({ model: 'claude-opus-5' }); }
      catch (e) { threw = String(e.message); }
      ok(threw.indexOf('daily budget reached') !== -1, 'refused: ' + threw);
      ok(!fetched, 'the request was never sent');
    });
  } finally { UrlFetchApp = originalFetch; }
});

t('an unpriced model cannot silently escape the ledger', function () {
  withProps({}, function () {
    eq(recordSpend_('some-future-model', { input_tokens: 1e6 }), 0);
    ok(CONFIG.PRICE_PER_MTOK[CONFIG.TRIAGE_MODEL], 'triage model is priced');
    ok(CONFIG.PRICE_PER_MTOK[CONFIG.ENRICH_MODEL], 'enrich model is priced');
  });
});

t('a fetched page is capped before it enters the conversation', function () {
  var tools = captureEnrichPayload_('Algorio', '', 'Tel Aviv').tools;
  var fetch = tools.filter(function (x) { return x.type === 'web_fetch_20260209'; })[0];
  ok(fetch, 'web fetch is declared');
  eq(fetch.max_content_tokens, CONFIG.ENRICH_MAX_FETCH_TOKENS);
  ok(fetch.max_content_tokens > 0, 'an uncapped fetch is what caused this');
});


// -------------------------------------------- two mailboxes, one spreadsheet
// Both accounts run this same bound script against this same sheet, each on
// its own trigger and reading its own Gmail. Everything below is what stops
// them from treading on each other — and the failure in every case is the
// quiet one: mail nothing ever looks at again, or rows written over.

function withMailbox(address, fn) {
  var savedResolved = MAILBOX_EMAIL_;
  var savedStub = MAILBOX_STUB_;
  MAILBOX_EMAIL_ = null;   // drop the memo so the stub is consulted again
  MAILBOX_STUB_ = address;
  try { return fn(); } finally {
    MAILBOX_EMAIL_ = savedResolved;
    MAILBOX_STUB_ = savedStub;
  }
}

function withStores(scriptSeed, userSeed, fn) {
  var original = PropertiesService;
  var script = fakeStore_(scriptSeed);
  var user = fakeStore_(userSeed);
  PropertiesService = {
    getScriptProperties: function () { return script; },
    getUserProperties: function () { return user; }
  };
  try { return fn(script, user); } finally { PropertiesService = original; }
}

t('every log row has a column for the mailbox that wrote it', function () {
  eq(APP_HEADERS[A_ACCOUNT], 'Account');
  eq(PROCESSED_HEADERS[P_ACCOUNT], 'Account');
  eq(SKIPPED_HEADERS[S_ACCOUNT], 'Account');
  // Appended, never inserted: every other index is positional, and so are the
  // $-references in quietFormula_ and the conditional formats.
  eq(A_ACCOUNT, APP_HEADERS.length - 1);
});

t('an email link addresses the mailbox the mail is in', function () {
  withMailbox('second@gmail.com', function () {
    // /u/0 means "whichever account you signed into first", so with two
    // mailboxes half the Email links would open the wrong one and find nothing.
    eq(threadUrl_('abc123'),
       'https://mail.google.com/mail/u/second%40gmail.com/#all/abc123');
  });
});

t('an unidentified mailbox still produces a usable link', function () {
  withMailbox('', function () {
    eq(threadUrl_('abc123'), 'https://mail.google.com/mail/u/0/#all/abc123');
  });
});

t('a mailbox adopts the old shared cursor exactly once', function () {
  withStores({ LAST_RUN_EPOCH: '1000' }, {}, function (script, user) {
    // Starting empty would leave the first poll after this change defaulting to
    // a POLL_MINUTES window, stepping over everything since the last real run.
    eq(cursorStore_().getProperty(PROP_LAST_RUN), '1000', 'adopted');
    cursorStore_().setProperty(PROP_LAST_RUN, '5000');
    script._data.LAST_RUN_EPOCH = '9999';
    eq(cursorStore_().getProperty(PROP_LAST_RUN), '5000',
       'and keeps its own place afterwards');
    eq(script._data.LAST_RUN_EPOCH, '9999', 'the script-wide value is left alone');
  });
});

t('one mailbox moving its cursor cannot move the other one', function () {
  var shared = { LAST_RUN_EPOCH: '1000' };
  withStores(shared, {}, function () { cursorStore_().setProperty(PROP_LAST_RUN, '8000'); });
  // The second account: same script properties, its own user properties.
  withStores(shared, {}, function () {
    eq(cursorStore_().getProperty(PROP_LAST_RUN), '1000',
       'the second mailbox must not inherit where the first one got to');
  });
});

t('a run that cannot take the lock does nothing at all', function () {
  LOCK_HELD_ = true;
  try {
    var ran = false;
    var out = withBookLock_('test', function () { ran = true; return 'wrote'; });
    ok(!ran, 'the body never runs, so no cursor moves and nothing is flushed');
    ok(out === LOCK_BUSY, 'and the caller can tell the difference from a result');
  } finally { LOCK_HELD_ = false; }
});

t('the lock is released even when the run throws', function () {
  try {
    withBookLock_('test', function () { throw new Error('boom'); });
  } catch (e) { /* expected */ }
  var ran = false;
  withBookLock_('test', function () { ran = true; });
  ok(ran, 'a stuck lock would freeze both accounts out for good');
});

t('coverage is reported per mailbox, not merged into one date', function () {
  function logRow(headers, accountIndex, id, date, account) {
    var r = new Array(headers.length).fill('');
    r[0] = id;
    r[1] = date;
    r[accountIndex] = account;
    return r;
  }
  withTabs(
    [logRow(PROCESSED_HEADERS, P_ACCOUNT, 'p1', '2026-01-10', 'first@gmail.com'),
     logRow(PROCESSED_HEADERS, P_ACCOUNT, 'p2', '2026-06-01', 'second@gmail.com')],
    [logRow(SKIPPED_HEADERS, S_ACCOUNT, 's1', '2026-02-20', 'second@gmail.com'),
     logRow(SKIPPED_HEADERS, S_ACCOUNT, 's2', '2026-03-01', '')],
    function () {
      var swept = oldestExaminedByAccount_();
      eq(swept['first@gmail.com'].toDateString(), new Date('2026-01-10').toDateString());
      // Merged, this would read January and imply the second mailbox was swept
      // back that far too. It was not: it has never seen anything before March.
      eq(swept['second@gmail.com'].toDateString(), new Date('2026-02-20').toDateString(),
         'the earlier date belongs to the other account');
      ok(swept[''], 'rows written before the column existed still count');
    });
});

t('setup repairs a header row a new column has outgrown', function () {
  // Adding Account to *_HEADERS is only half the job: an existing sheet keeps
  // the header row it was created with, and setup() used to write headers only
  // into a brand-new tab, so the column would stay an unlabelled blank forever.
  var stale = APP_HEADERS.slice(0, APP_HEADERS.length - 1).concat(['']);
  var written = null;
  function fakeTab(header) {
    return {
      getMaxColumns: function () { return 26; },
      insertColumnsAfter: function () { throw new Error('26 columns is plenty'); },
      setFrozenRows: function () {},
      getRange: function (r, c, n, w) {
        return {
          getValues: function () { return [header.slice(c - 1, c - 1 + w)]; },
          setValues: function (v) { written = v[0]; },
          setFontWeight: function () { return this; }
        };
      }
    };
  }
  function ss(sheet) { return { getSheetByName: function () { return sheet; } }; }

  ensureTab_(ss(fakeTab(stale)), TABS.APPLICATIONS, APP_HEADERS);
  eq(written, APP_HEADERS, 'the drifted header is rewritten in full');

  written = null;
  ensureTab_(ss(fakeTab(APP_HEADERS.slice())), TABS.APPLICATIONS, APP_HEADERS);
  eq(written, null, 'a header that already matches is left alone');
});

t('the never-swept warning fires for a silent mailbox', function () {
  ok(sweptNothing_(['first@gmail.com'], 'second@gmail.com'),
     'the second account has examined nothing and must be told so');
  ok(!sweptNothing_(['first@gmail.com', 'second@gmail.com'], 'second@gmail.com'),
     'an account on record is not warned about');
});

t('the warning stays quiet when nothing can be attributed yet', function () {
  // Immediately after the Account column is added every existing row is blank,
  // so a mailbox backfilled for months looks exactly like one that never ran.
  // A warning here would be noise, and this is the one warning worth reading.
  ok(!sweptNothing_([''], 'first@gmail.com'), 'unattributed history proves nothing');
  ok(!sweptNothing_([], 'first@gmail.com'), 'an empty sheet is not a silent mailbox');
  ok(!sweptNothing_(['first@gmail.com'], ''), 'and an unidentifiable account cannot be judged');
});

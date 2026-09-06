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
t('company normalization keeps distinct companies distinct', function () {
  ok(normalizeCompany_('Wiz') !== normalizeCompany_('Wix'), 'Wiz vs Wix');
  ok(normalizeCompany_('Cato Networks') !== normalizeCompany_('Cato'), 'Networks is meaningful');
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
           processed: [], skipped: [], enrichCount: 99 };  // enrichCount caps API calls
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
  eq(SKIPPED_HEADERS.length, 4);
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
  var book = { companies: {}, newCompanies: [], enrichCount: 0 };
  try {
    var profile = companyProfile_(book, 'Algorio', 'https://example.com/job', 'Tel Aviv');
    eq(seen.location, 'Tel Aviv');
    eq(profile.market, 'Fintech');
  } finally { enrichCompany_ = original; }
});

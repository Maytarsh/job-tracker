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
  ok(quietFormula_(5).indexOf('TODAY()-$H5') !== -1, 'counts from last update');
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
function fakeProcessedSheet(rows) {
  var data = [PROCESSED_HEADERS].concat(rows);
  return {
    getLastRow: function () { return data.length; },
    getRange: function (r, c, n, w) {
      return {
        getValues: function () { return data.slice(r - 1, r - 1 + n); },
        clearContent: function () { data = [PROCESSED_HEADERS]; },
        setValues: function (v) { data = [PROCESSED_HEADERS].concat(v); }
      };
    },
    _data: function () { return data; }
  };
}
function withProcessedSheet(rows, fn) {
  var sheet = fakeProcessedSheet(rows);
  var original = getSheet_;
  getSheet_ = function () { return sheet; };
  try { return fn(sheet); } finally { getSheet_ = original; }
}
function processedRow(id, action) {
  var r = new Array(PROCESSED_HEADERS.length).fill('');
  r[0] = id;
  r[P_ACTION] = action;
  return r;
}

t('dry-run rows are not treated as already processed', function () {
  withProcessedSheet([processedRow('m1', 'dry-run'), processedRow('m2', 'dry-run')],
    function () {
      eq(Object.keys(loadProcessedIds_()).length, 0,
         'a rehearsal must not consume the messages');
    });
});

t('real rows are treated as already processed', function () {
  withProcessedSheet([processedRow('m1', 'created Wiz / Researcher'),
                      processedRow('m2', 'ignored (not_related)')],
    function () {
      var seen = loadProcessedIds_();
      ok(seen['m1'] && seen['m2'], 'genuinely handled messages are skipped');
    });
});

t('purging drops only the rehearsal rows', function () {
  withProcessedSheet([processedRow('m1', 'dry-run'),
                      processedRow('m2', 'created Wiz / Researcher'),
                      processedRow('m3', 'dry-run')],
    function (sheet) {
      eq(purgeDryRunRows_(), 2, 'two rehearsal rows removed');
      var left = sheet._data().slice(1);
      eq(left.length, 1);
      eq(left[0][0], 'm2', 'the real row survives');
    });
});

t('purging is a no-op when there is nothing to purge', function () {
  withProcessedSheet([processedRow('m1', 'created Wiz / Researcher')], function () {
    eq(purgeDryRunRows_(), 0);
  });
});

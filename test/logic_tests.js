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

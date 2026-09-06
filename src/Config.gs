/**
 * Config.gs — every knob lives here. Nothing below this file needs editing
 * for normal tuning.
 */

var CONFIG = {
  // Write to the Applications tab? false = classify and log only.
  // Leave true for the first backfill, then flip it.
  DRY_RUN: true,

  TRIAGE_MODEL: 'claude-haiku-4-5',
  ENRICH_MODEL: 'claude-opus-5',

  POLL_MINUTES: 30,      // how often pollInbox() runs
  OVERLAP_MINUTES: 10,   // re-scan window, so a message landing mid-run isn't skipped
  STALE_DAYS: 30,        // Open + silent this long -> Stage = Ghosted

  BACKFILL_DAYS: 30,     // how far back runBackfill() reaches
  BACKFILL_HOLDOUT_DAYS: 0, // leave the last N days for the live poll to pick up

  MAX_MESSAGES_PER_RUN: 50, // chunk size; keeps executions under the 6-minute cap
  MAX_BODY_CHARS: 4000,     // truncation before the email is sent to the API

  MAX_ENRICH_PER_RUN: 3,    // cap Opus calls per execution (cost guard)
  ENRICH_MAX_SEARCHES: 6,   // web_search calls the research model may make per company
  ENRICH_MAX_FETCHES: 3,    // pages it may open to read a company's own site
  MAX_BACKFILL_CHUNKS: 40,  // hard stop on self-requeueing, whatever goes wrong

  // Apps Script kills an execution at 6 minutes and everything buffered in
  // memory dies with it — the _Processed rows, the new Applications rows, and
  // the backfill's continuation trigger. Stop early and flush instead.
  RUN_BUDGET_SECONDS: 240,
  ENRICH_RESERVE_SECONDS: 120, // don't start research without this much left

  // Give up on a run once the API has failed this many times in a row. An
  // expired key or an empty credit balance fails every call, and grinding on
  // through the window wastes the run and risks stepping over the mail.
  MAX_CONSECUTIVE_FAILURES: 3,

  API_URL: 'https://api.anthropic.com/v1/messages',
  API_VERSION: '2023-06-01',
  API_MAX_ATTEMPTS: 4
};

var TABS = {
  APPLICATIONS: 'Applications',
  COMPANIES: 'Companies',
  PROCESSED: '_Processed',
  SKIPPED: '_Skipped'
};

var APP_HEADERS = [
  'Company', 'Role', 'Market', 'Description', 'Status', 'Stage',
  'Date applied', 'Last update', 'Days quiet', 'Source / ATS',
  'Job link', 'Location', 'Email link', 'Confidence', 'Notes'
];

var COMPANY_HEADERS = [
  'Company key', 'Company', 'Market', 'Sub-market', 'Description',
  'Website', 'HQ', 'Size', 'Founded', 'Enriched at'
];

var PROCESSED_HEADERS = [
  'Message ID', 'Date', 'From', 'Subject', 'Category',
  'Company', 'Role', 'Confidence', 'Evidence', 'Action'
];

var SKIPPED_HEADERS = ['Message ID', 'Date', 'From', 'Subject'];

// _Processed column index + marker for rehearsal rows, which never count as done.
var P_ACTION = 9;
var DRY_RUN_ACTION = 'dry-run';

/** Controlled vocabulary for the Market column. */
var MARKETS = [
  'Cybersecurity', 'Networking', 'Storage', 'Cloud/Infra', 'Data/AI',
  'Fintech', 'Healthtech', 'Devtools', 'Semiconductors', 'Gaming',
  'E-commerce', 'Other', 'Unknown'
];

var CATEGORIES = [
  'application_confirmation', 'rejection', 'interview_or_next_step',
  'offer', 'recruiter_outreach', 'job_alert_or_marketing', 'not_related'
];

/**
 * Prefilter — recall-first on purpose. A missed confirmation is a lost row;
 * a false positive costs a fraction of a cent at triage. When something real
 * shows up in _Skipped, add its pattern here.
 */
var ATS_DOMAINS = [
  'greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'hire.lever.co',
  'myworkday.com', 'myworkdayjobs.com', 'workday.com',
  'ashbyhq.com', 'comeet.co', 'comeet.com', 'smartrecruiters.com',
  'workable.com', 'jobvite.com', 'icims.com', 'taleo.net', 'oracle.com',
  'bamboohr.com', 'teamtailor.com', 'breezy.hr', 'recruitee.com',
  'personio.de', 'pinpointhq.com', 'gem.com', 'rippling.com',
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'hired.com',
  'jazzhr.com', 'applytojob.com', 'successfactors.com', 'eightfold.ai'
];

var KEYWORD_PATTERNS = [
  /thank(s| you)? for (applying|your application|your interest)/i,
  /appl(ication|ied|ying) (has been |was )?(received|submitted)/i,
  /we('ve| have) received your (application|resume|cv)/i,
  /your application (for|to|has|was)/i,
  /received your application/i,
  /application (status|update|confirmation)/i,
  /not (be )?(moving|proceeding) forward/i,
  /(other|another) candidate/i,
  /we (regret|are unable|won't be)/i,
  /unfortunately/i,
  /decided not to (move|proceed|continue)/i,
  /(interview|screening call|phone screen|next steps?) (with|invitation|scheduled)/i,
  /(job|position|role|opening|vacancy|candidacy)/i
];

/**
 * Claude.gs — the two API calls.
 *
 * Triage runs on every candidate email, so it is cheap: Haiku, no thinking,
 * a cached system prompt, and structured outputs so the response parses
 * deterministically instead of being scraped out of prose.
 *
 * Enrichment runs once per company, ever, so it is accurate: Opus with the
 * web_search server tool. Its result comes back through a strict tool call
 * rather than output_config.format, because web search attaches citations to
 * text blocks and the API rejects citations alongside output_config.format.
 */

function apiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Apps Script editor -> Project Settings -> ' +
      'Script Properties -> add ANTHROPIC_API_KEY.'
    );
  }
  return key;
}

/** POST to the Messages API, retrying 429s and 5xxs with exponential backoff. */
function callAnthropic_(payload) {
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey_(),
      'anthropic-version': CONFIG.API_VERSION
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var lastBody = '';
  for (var attempt = 1; attempt <= CONFIG.API_MAX_ATTEMPTS; attempt++) {
    var res = UrlFetchApp.fetch(CONFIG.API_URL, options);
    var code = res.getResponseCode();
    lastBody = res.getContentText();

    if (code === 200) return JSON.parse(lastBody);

    var retryable = (code === 429 || code === 408 || code >= 500);
    if (!retryable || attempt === CONFIG.API_MAX_ATTEMPTS) {
      throw new Error('Anthropic API ' + code + ': ' + lastBody.substring(0, 500));
    }
    Utilities.sleep(Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500));
  }
  throw new Error('Anthropic API retries exhausted: ' + lastBody.substring(0, 500));
}

var TRIAGE_SYSTEM =
  'You classify a single email from a job seeker\'s inbox and extract structured facts.\n\n' +
  'Categories:\n' +
  '- application_confirmation: an employer or their ATS acknowledges receiving an application ' +
  'the job seeker submitted.\n' +
  '- rejection: the employer declines to move forward.\n' +
  '- interview_or_next_step: an invitation to a screening call, interview, assessment, or ' +
  'any request to schedule one.\n' +
  '- offer: an offer of employment.\n' +
  '- recruiter_outreach: a recruiter approaching the job seeker about a role they did NOT ' +
  'apply to.\n' +
  '- job_alert_or_marketing: job boards, newsletters, "jobs you may like", employer branding.\n' +
  '- not_related: everything else.\n\n' +
  'The distinction that matters most: application_confirmation means the job seeker applied ' +
  'first. If the company reached out cold, it is recruiter_outreach.\n\n' +
  'Fill every field. Use "" for anything the email does not state — never invent a company, ' +
  'role, location, or URL. "company" is the hiring employer, not the ATS vendor: an email from ' +
  'Greenhouse on behalf of Wiz has company "Wiz" and source_ats "Greenhouse". "evidence" must ' +
  'be a short phrase quoted verbatim from the email that justifies the category. Set confidence ' +
  'to low when the email is ambiguous or the company had to be inferred.';

var TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    company: { type: 'string' },
    role: { type: 'string' },
    location: { type: 'string' },
    job_url: { type: 'string' },
    source_ats: { type: 'string' },
    stage_hint: {
      type: 'string',
      enum: ['none', 'screening', 'interview', 'offer'],
      description: 'For interview_or_next_step/offer: which stage the email implies.'
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    evidence: { type: 'string' }
  },
  required: [
    'category', 'company', 'role', 'location', 'job_url',
    'source_ats', 'stage_hint', 'confidence', 'evidence'
  ],
  additionalProperties: false
};

/** Classify one email. Returns the parsed schema object. */
function triageMessage_(msg) {
  var res = callAnthropic_({
    model: CONFIG.TRIAGE_MODEL,
    max_tokens: 1024,
    system: [{
      type: 'text',
      text: TRIAGE_SYSTEM,
      cache_control: { type: 'ephemeral' }
    }],
    messages: [{
      role: 'user',
      content:
        'From: ' + msg.from + '\n' +
        'Date: ' + msg.date + '\n' +
        'Subject: ' + msg.subject + '\n\n' +
        msg.body
    }],
    output_config: { format: { type: 'json_schema', schema: TRIAGE_SCHEMA } }
  });

  var block = firstOfType_(res.content, 'text');
  if (!block) throw new Error('triage returned no text block');
  return JSON.parse(block.text);
}

var COMPANY_TOOL = {
  name: 'save_company_profile',
  description: 'Record the researched profile for one company.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      market: { type: 'string', enum: MARKETS },
      sub_market: { type: 'string' },
      description: { type: 'string' },
      website: { type: 'string' },
      hq_location: { type: 'string' },
      employee_range: { type: 'string' },
      founded_year: { type: 'string' }
    },
    required: [
      'market', 'sub_market', 'description', 'website',
      'hq_location', 'employee_range', 'founded_year'
    ],
    additionalProperties: false
  }
};

var ENRICH_SYSTEM =
  'You research one company and record its profile. Search the web to confirm what the ' +
  'company actually builds — do not answer from memory. Then call save_company_profile ' +
  'exactly once.\n\n' +
  '"market" must come from the enum; pick the one the company primarily sells into. ' +
  '"sub_market" is a short free-text refinement (e.g. "cloud security posture management"). ' +
  '"description" is 1-2 sentences naming the product and who buys it — no marketing language. ' +
  'If you cannot confidently identify the company, set market to "Unknown", say so in ' +
  'description, and leave the other fields as "". Never guess.';

/** Research one company. Returns the tool input, or null if the model never called it. */
function enrichCompany_(companyName, hintUrl) {
  var prompt = 'Company: ' + companyName + '\n' +
    'Context: seen as the employer in a job application email.\n' +
    (hintUrl ? 'A job posting URL from that email: ' + hintUrl + '\n' : '') +
    'Research it and record the profile.';

  var res = callAnthropic_({
    model: CONFIG.ENRICH_MODEL,
    max_tokens: 4096,
    system: ENRICH_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    tools: [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 4 },
      COMPANY_TOOL
    ],
    tool_choice: { type: 'auto' }
  });

  var content = res.content || [];
  for (var i = content.length - 1; i >= 0; i--) {
    if (content[i].type === 'tool_use' && content[i].name === 'save_company_profile') {
      return content[i].input;
    }
  }
  return null;
}

function firstOfType_(blocks, type) {
  for (var i = 0; i < (blocks || []).length; i++) {
    if (blocks[i].type === type) return blocks[i];
  }
  return null;
}

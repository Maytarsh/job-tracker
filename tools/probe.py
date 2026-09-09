#!/usr/bin/env python3
"""Pre-flight: prove both Claude request shapes work before porting them to Apps Script.

Sends two real requests with ANTHROPIC_API_KEY from the environment:
  1. Triage   - claude-haiku-4-5 + output_config.format (json_schema)
  2. Enrich   - claude-sonnet-5 + web_search/web_fetch server tools + strict tool use

Stdlib only, deliberately - do not reach for `requests` here. Two properties depend
on it: the payloads mirror exactly what UrlFetchApp sends from Apps Script, which has
no package ecosystem to borrow from, and the probe stays runnable straight from a
checkout when the API is the thing under suspicion. It is the one file in the repo
with no dependency to install, and worth keeping that way.

Standalone means every value here restates one in src/, and a restatement rots
silently: a probe sending a payload production no longer sends proves nothing about
production. check_probe_drift() in test/run_tests.py fails if any of the mirrors
below, either schema, or either payload's key set drifts from src/. Change one side,
change the other.
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.anthropic.com/v1/messages"
KEY = os.environ.get("ANTHROPIC_API_KEY")

# --- mirrors of src/Config.gs (drift-checked; see the module docstring) --------
API_VERSION = "2023-06-01"
TRIAGE_MODEL = "claude-haiku-4-5"
ENRICH_MODEL = "claude-sonnet-5"
# Both max_tokens are literals in src/Claude.gs, not Config knobs. Triage needs
# 2048 because a LinkedIn job link's tracking parameters overran 1024 and the
# truncation surfaced as an unterminated-JSON SyntaxError.
TRIAGE_MAX_TOKENS = 2048
ENRICH_MAX_TOKENS = 8192
WEB_SEARCH_TYPE = "web_search_20260209"
WEB_FETCH_TYPE = "web_fetch_20260209"
ENRICH_MAX_SEARCHES = 3
ENRICH_MAX_FETCHES = 1
ENRICH_MAX_FETCH_TOKENS = 6000
PRICE_PER_MTOK = {
    "claude-haiku-4-5": {"input": 1, "output": 5},
    "claude-sonnet-5": {"input": 2, "output": 10},
    "claude-opus-5": {"input": 5, "output": 25},
}
PRICE_PER_SEARCH = 0.01

SAMPLE_EMAIL = """From: no-reply@us.greenhouse-mail.io
Subject: Thanks for applying to Wiz!

Hi Maytar,

Thanks for your interest in Wiz. We've received your application for the
Senior Security Researcher position (Tel Aviv, Hybrid) and our recruiting
team is reviewing it now.

You can check the status of your application here:
https://job-boards.greenhouse.io/wiz/jobs/4512339

The Wiz Recruiting Team
"""

TRIAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "category": {
            "type": "string",
            "enum": [
                "application_confirmation", "rejection", "interview_or_next_step",
                "offer", "recruiter_outreach", "job_alert_or_marketing", "not_related",
            ],
        },
        "company": {"type": "string"},
        "role": {"type": "string"},
        "location": {"type": "string"},
        "job_url": {"type": "string"},
        "source_ats": {"type": "string"},
        "stage_hint": {"type": "string", "enum": ["none", "screening", "interview", "offer"]},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "evidence": {"type": "string"},
    },
    "required": [
        "category", "company", "role", "location", "job_url",
        "source_ats", "stage_hint", "confidence", "evidence",
    ],
    "additionalProperties": False,
}

COMPANY_TOOL = {
    "name": "save_company_profile",
    "description": "Record the researched profile for one company.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "properties": {
            "market": {
                "type": "string",
                "enum": [
                    "Cybersecurity", "Networking", "Storage", "Cloud/Infra", "Data/AI",
                    "Fintech", "Healthtech", "Devtools", "Semiconductors", "Gaming",
                    "E-commerce", "Other", "Unknown",
                ],
            },
            "sub_market": {"type": "string"},
            "description": {"type": "string"},
            "website": {"type": "string"},
            "hq_location": {"type": "string"},
            "employee_range": {"type": "string"},
            "founded_year": {"type": "string"},
        },
        "required": [
            "market", "sub_market", "description",
            "website", "hq_location", "employee_range", "founded_year",
        ],
        "additionalProperties": False,
    },
}


def call(payload):
    req = urllib.request.Request(
        API,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-api-key": KEY,
            "anthropic-version": API_VERSION,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"\n!! HTTP {e.code}\n{body}\n", file=sys.stderr)
        raise


def price(model, usage):
    """Token cost of one response, priced exactly as recordSpend_() prices it."""
    p = PRICE_PER_MTOK[model]
    return (usage["input_tokens"] * p["input"]
            + usage["output_tokens"] * p["output"]) / 1e6


def probe_triage():
    print("=" * 70)
    print("PROBE 1 — triage: " + TRIAGE_MODEL + " + output_config.format")
    print("=" * 70)
    res = call({
        "model": TRIAGE_MODEL,
        "max_tokens": TRIAGE_MAX_TOKENS,
        "system": [{
            "type": "text",
            "text": (
                "You classify a single email from a job seeker's inbox and extract "
                "structured facts about it. Decide which category the email belongs to, "
                "then fill every field. Use \"\" for anything the email does not state — "
                "never guess a company, role, or URL that is not present. 'evidence' must "
                "be a short phrase quoted verbatim from the email that justifies the category."
            ),
            "cache_control": {"type": "ephemeral"},
        }],
        "messages": [{"role": "user", "content": SAMPLE_EMAIL}],
        "output_config": {"format": {"type": "json_schema", "schema": TRIAGE_SCHEMA}},
    })
    text = next(b["text"] for b in res["content"] if b["type"] == "text")
    print(json.dumps(json.loads(text), indent=2))
    u = res["usage"]
    print(f"\nusage: in={u['input_tokens']} out={u['output_tokens']} "
          f"cache_write={u.get('cache_creation_input_tokens', 0)} "
          f"cache_read={u.get('cache_read_input_tokens', 0)}")
    return u


def probe_enrich(company="Wiz", location=""):
    print("\n" + "=" * 70)
    print("PROBE 2 — enrich: " + ENRICH_MODEL
          + " + web_search/web_fetch + strict tool use")
    print("=" * 70)
    res = call({
        "model": ENRICH_MODEL,
        "max_tokens": ENRICH_MAX_TOKENS,
        "system": (
            "You research one company and record its profile. Search the web to confirm "
            "what the company actually builds — do not rely on memory. Then call "
            "save_company_profile exactly once. A company name on its own is often "
            "ambiguous, so search it together with the hiring location and the likely "
            "domains, and fetch the company's own site when a result looks right — a "
            "primary source outranks any aggregator listing. Only if that genuinely "
            "fails, set market to \"Unknown\" and say so in description rather than "
            "guessing. Keep description to 1-2 sentences naming the product and who buys it."
        ),
        "messages": [{
            "role": "user",
            "content": (
                f"Company: {company}\n"
                + (f"Hiring location: {location}\n" if location else "")
                + "Context: seen as the sender of a job application confirmation email.\n"
                "Research it and record the profile."
            ),
        }],
        "tools": [
            {"type": WEB_SEARCH_TYPE, "name": "web_search",
             "max_uses": ENRICH_MAX_SEARCHES},
            # max_content_tokens is not optional here. Without it the whole page
            # enters the conversation and is re-sent as input on every following
            # turn, and the probe stops measuring what production costs.
            {"type": WEB_FETCH_TYPE, "name": "web_fetch",
             "max_uses": ENRICH_MAX_FETCHES,
             "max_content_tokens": ENRICH_MAX_FETCH_TOKENS},
            COMPANY_TOOL,
        ],
        "tool_choice": {"type": "auto"},
    })
    print(f"stop_reason: {res['stop_reason']}")
    print("block types:", [b["type"] for b in res["content"]])
    calls = [b for b in res["content"] if b["type"] == "tool_use"
             and b["name"] == "save_company_profile"]
    if not calls:
        print("\n!! no save_company_profile call — fallback path would be needed")
        print(json.dumps(res["content"], indent=2)[:2000])
        return None
    print("\n" + json.dumps(calls[-1]["input"], indent=2))
    u = res["usage"]
    print(f"\nusage: in={u['input_tokens']} out={u['output_tokens']} "
          f"web_search={u.get('server_tool_use', {}).get('web_search_requests', 0)} "
          f"web_fetch={u.get('server_tool_use', {}).get('web_fetch_requests', 0)}")
    return u


if __name__ == "__main__":
    if not KEY:
        sys.exit("ANTHROPIC_API_KEY is not set")
    t = probe_triage()
    # Second argument is the hiring location, the hint that disambiguates a name
    # like "Algorio" from the unrelated businesses sharing it.
    e = probe_enrich(
        sys.argv[1] if len(sys.argv) > 1 else "Wiz",
        sys.argv[2] if len(sys.argv) > 2 else "",
    )
    if t and e:
        tri = price(TRIAGE_MODEL, t)
        # web_search bills per search on top of tokens. Omitting it under-reported
        # what a company costs, against a DAILY_BUDGET_USD that does count it.
        searches = e.get("server_tool_use", {}).get("web_search_requests", 0)
        enr = price(ENRICH_MODEL, e) + searches * PRICE_PER_SEARCH
        print("\n" + "=" * 70)
        print(f"cost/email   (triage) : ${tri:.5f}")
        print(f"cost/company (enrich) : ${enr:.5f}  ({searches} search(es))")
        print(f"est. 150 emails + 40 companies: ${tri * 150 + enr * 40:.2f}")

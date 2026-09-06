#!/usr/bin/env python3
"""Pre-flight: prove both Claude request shapes work before porting them to Apps Script.

Sends two real requests with ANTHROPIC_API_KEY from the environment:
  1. Triage   - claude-haiku-4-5 + output_config.format (json_schema)
  2. Enrich   - claude-opus-5 + web_search server tool + strict tool use

Stdlib only, deliberately - do not reach for `requests` here. Two properties depend
on it: the payloads mirror exactly what UrlFetchApp sends from Apps Script, which has
no package ecosystem to borrow from, and the probe stays runnable straight from a
checkout when the API is the thing under suspicion. It is the one file in the repo
with no dependency to install, and worth keeping that way.
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.anthropic.com/v1/messages"
KEY = os.environ.get("ANTHROPIC_API_KEY")

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
            "anthropic-version": "2023-06-01",
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


def probe_triage():
    print("=" * 70)
    print("PROBE 1 — triage: claude-haiku-4-5 + output_config.format")
    print("=" * 70)
    res = call({
        "model": "claude-haiku-4-5",
        "max_tokens": 1024,
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


def probe_enrich(company="Wiz"):
    print("\n" + "=" * 70)
    print("PROBE 2 — enrich: claude-opus-5 + web_search + strict tool use")
    print("=" * 70)
    res = call({
        "model": "claude-opus-5",
        "max_tokens": 4096,
        "system": (
            "You research one company and record its profile. Search the web to confirm "
            "what the company actually builds — do not rely on memory. Then call "
            "save_company_profile exactly once. If you cannot confidently identify the "
            "company, set market to \"Unknown\" and say so in description rather than "
            "guessing. Keep description to 1-2 sentences naming the product and who buys it."
        ),
        "messages": [{
            "role": "user",
            "content": (
                f"Company: {company}\n"
                "Context: seen as the sender of a job application confirmation email.\n"
                "Research it and record the profile."
            ),
        }],
        "tools": [
            {"type": "web_search_20260209", "name": "web_search", "max_uses": 4},
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
          f"web_search={u.get('server_tool_use', {}).get('web_search_requests', 0)}")
    return u


if __name__ == "__main__":
    if not KEY:
        sys.exit("ANTHROPIC_API_KEY is not set")
    t = probe_triage()
    e = probe_enrich(sys.argv[1] if len(sys.argv) > 1 else "Wiz")
    if t and e:
        # haiku 4.5: $1/$5 per MTok ; opus 5: $5/$25 per MTok
        tri = (t["input_tokens"] * 1 + t["output_tokens"] * 5) / 1e6
        enr = (e["input_tokens"] * 5 + e["output_tokens"] * 25) / 1e6
        print("\n" + "=" * 70)
        print(f"cost/email   (triage) : ${tri:.5f}")
        print(f"cost/company (enrich) : ${enr:.5f}")
        print(f"est. 150 emails + 40 companies: ${tri * 150 + enr * 40:.2f}")

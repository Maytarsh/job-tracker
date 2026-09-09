---
name: probe
description: Validate the Anthropic request payload shapes against the live API by running tools/probe.py. Makes two real, billed API calls. User-invoked only.
disable-model-invocation: true
---

Run `tools/probe.py` (via `uv run`) to prove both request shapes work before they are ported into
Apps Script, where iteration is slow.

**This costs real money** — one `claude-haiku-4-5` triage call and one `claude-sonnet-5`
enrichment call with web search. Only worth running when a request payload shape
changed: the triage schema, the enrichment tool definition, models, headers, or the
system prompts in `src/Claude.gs`.

Steps:

1. Check `ANTHROPIC_API_KEY` is set in the environment. If not, stop and tell the user
   to export it — do not read it from the Sheet or from Script Properties, it only
   lives in the Apps Script project settings.
2. If `$ARGUMENTS` names a company, pass it through: `uv run python tools/probe.py $ARGUMENTS`.
   Otherwise run `uv run python tools/probe.py`.
3. Report the outcome plainly: whether each call returned 200, the parsed result, and
   the token/cost numbers it prints.
4. If the triage schema in `probe.py` and `src/Claude.gs` have diverged, say so — the
   drift check in `test/run_tests.py` guards this, and both copies must be updated
   together.

If the run fails, quote the actual error rather than summarizing it. A 401 means a bad
key and is not retried.

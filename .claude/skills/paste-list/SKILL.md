---
name: paste-list
description: List which src/*.gs files changed and must be re-pasted into the Apps Script editor, with the warnings that apply to each. Use after editing src/ or when the user asks what to deploy.
---

Deployment here is manual copy-paste into the Apps Script editor, so the user needs to
know exactly which editor files to replace.

1. Determine the changed files. Compare against the ref in `$ARGUMENTS` if given,
   otherwise use uncommitted changes plus anything ahead of `origin/main`:

   ```bash
   git status --porcelain -- src/
   git diff --name-only origin/main...HEAD -- src/
   ```

2. List each changed `src/` file as the editor file to replace. `src/appsscript.json`
   is only visible after Project Settings → *Show `appsscript.json`*.

3. Add the warnings that apply:
   - **`Config.gs` changed** — re-pasting it replaces the user's own settings with
     whatever is in the file, `DRY_RUN` included. Say which way `DRY_RUN` will end up
     (read it from the file, do not assume) and tell them to re-apply anything they had
     set differently.
   - **`POLL_MINUTES` changed** — `setup()` must be re-run to rebuild the triggers, and
     that clears the trigger's *Notify me immediately* failure-notification setting, so
     it has to be set again afterwards (⏰ Triggers → ⋮ on `pollInbox` → Edit trigger).
   - **`appsscript.json` changed** — if `oauthScopes` gained an entry, the user will be
     asked to re-authorize on the next run.
   - **New non-private function added** (no trailing underscore) — it will appear in the
     editor's Run dropdown. Confirm that was intended.

4. Do not run anything or commit. This skill only reports.

#!/usr/bin/env bash
# Enforces CLAUDE.md's "Branch and open a PR with `gh`; do not commit to `main`."
#
# Blocks Write/Edit on files inside this repo while HEAD is the default branch.
# `git checkout -b <name>` carries uncommitted work across, so being stopped here
# costs nothing: branch, then repeat the edit.
set -u

project="${CLAUDE_PROJECT_DIR:-$PWD}"

file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -n "$file" ] || exit 0

root=$(git -C "$project" rev-parse --show-toplevel 2>/dev/null) || exit 0
# Only this repo's files. Memory, the scratchpad and other checkouts are not ours
# to police, and blocking them would wedge work that has nothing to do with the rule.
case "$file" in
  "$root"/*) ;;
  *) exit 0 ;;
esac

# Detached HEAD (a rebase, a bisect) has no branch to be wrong about.
branch=$(git -C "$root" symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0

# The branch to protect is whatever origin calls default, so a repo that uses
# master is covered without editing this file.
protected=$(git -C "$root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
protected=${protected#origin/}
[ -n "$protected" ] || protected=main
[ "$branch" = "$protected" ] || exit 0

reason="Refusing to edit ${file#$root/} while on $branch.

CLAUDE.md: branch and open a PR; do not work on $branch. Run
    git checkout -b <name>
and make the edit again — a checkout carries uncommitted work with it, so
nothing already changed is lost."

jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'

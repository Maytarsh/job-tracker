#!/usr/bin/env bash
# Apps Script evaluates project files alphabetically, not in dependency order.
# A top-level `var` in a file that sorts before Config.gs reads CONFIG/CATEGORIES/
# MARKETS/TABS/*_HEADERS as undefined, and JSON.stringify drops undefined keys
# without complaint. Build anything derived from Config lazily, inside a function.
set -u

file=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
[ -n "$file" ] || exit 0
case "$file" in
  */src/*.gs) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0

# Only files evaluated before Config.gs can see its globals as undefined.
base=$(basename "$file")
[ "$(printf '%s\nConfig.gs\n' "$base" | sort | head -1)" = "$base" ] || exit 0
[ "$base" = "Config.gs" ] && exit 0

hits=$(awk '
  { line = $0 }
  depth == 0 && line ~ /^var[ \t]/ { in_var = 1; buf = ""; start = NR }
  in_var { buf = buf " " line }
  {
    n = gsub(/[{([]/, "&", line); m = gsub(/[})\]]/, "&", line)
    depth += n - m
  }
  in_var && depth <= 0 && line ~ /;[ \t]*$/ {
    if ((buf " ") ~ /[^A-Za-z0-9_$](CONFIG|CATEGORIES|MARKETS|TABS|APP_HEADERS|COMPANY_HEADERS|PROCESSED_HEADERS|SKIPPED_HEADERS)[^A-Za-z0-9_$]/) {
      match(buf, /var[ \t]+[A-Za-z_$][A-Za-z0-9_$]*/)
      print "    line " start ": " substr(buf, RSTART, RLENGTH)
    }
    in_var = 0; buf = ""
  }
' "$file")

[ -n "$hits" ] || exit 0

msg="Load-order risk in $base (evaluated before Config.gs):
$hits
These read Config.gs globals at load time, where they are still undefined.
Build them lazily inside a function, as triageSchema_() and companyTool_() do."

jq -n --arg m "$msg" '{
  systemMessage: $m,
  hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: $m }
}'

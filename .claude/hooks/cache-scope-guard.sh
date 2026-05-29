#!/usr/bin/env bash
# PostToolUse hook: diff-aware CACHE_SCOPE_V3 reminder.
#
# The #1 post-deploy footgun: editing app/api/gemini-roof/route.ts (V3 response
# shape / pipeline / pricing) WITHOUT bumping CACHE_SCOPE_V3 → real customers
# keep getting the stale cached result for 30 days. The existing prewrite
# advisory just nags on every route.ts touch; this one is smarter — it only
# warns when route.ts actually changed AND the diff does NOT touch the
# CACHE_SCOPE_V3 line. Advisory only (exit 0); never blocks.

INPUT=$(cat)
FILE=$(echo "$INPUT" | python3 -c "import sys,json
try: d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))
except: print('')" 2>/dev/null)

# Only care about the V3 route.
case "$FILE" in
  */app/api/gemini-roof/route.ts|app/api/gemini-roof/route.ts) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-/Users/voxaris/nolands-estimator}" || exit 0

# Working-tree diff for the route vs HEAD.
DIFF=$(git diff -- app/api/gemini-roof/route.ts 2>/dev/null)
[ -z "$DIFF" ] && exit 0   # no uncommitted change → nothing to warn about

# If the route changed but no +/- line mentions CACHE_SCOPE_V3, remind.
if ! echo "$DIFF" | grep -qE '^[+-].*CACHE_SCOPE_V3'; then
  echo "[cache-scope-guard] route.ts changed but CACHE_SCOPE_V3 was NOT bumped." >&2
  echo "  If you changed the V3 response shape / pipeline / pricing, bump it" >&2
  echo "  (grep 'const CACHE_SCOPE_V3') or run the /bump-cache-scope skill —" >&2
  echo "  otherwise customers get stale cached results for 30 days." >&2
fi

exit 0

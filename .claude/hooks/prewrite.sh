#!/usr/bin/env bash
# PreToolUse hook: gate Write|Edit|MultiEdit on dangerous targets.
#
# Reads tool input from stdin as JSON, exits 2 to BLOCK with reason
# echoed to stderr (Claude sees it and picks a different path).
# Exits 0 to allow with optional advisory on stderr.

INPUT=$(cat)
FILE=$(echo "$INPUT" | python3 -c "import sys,json
try: d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))
except: print('')" 2>/dev/null)

[ -z "$FILE" ] && exit 0

# Hard-block any write to env / credential files.
case "$FILE" in
  *.env|*.env.*|*/.env*|*credentials*|*secrets*|*/private_keys/*|*.pem|*.p12|*.key)
    echo "[prewrite] BLOCKED: refusing to write to potential secret file: $FILE" >&2
    echo "[prewrite] If this is intentional, edit the file manually outside Claude." >&2
    exit 2
    ;;
esac

# CACHE_SCOPE_V3 sentinel — gemini-roof V3 route changes need the
# scope bumped or stale CDN responses leak the old shape.
case "$FILE" in
  */app/api/gemini-roof/route.ts)
    echo "[prewrite] REMINDER: bump CACHE_SCOPE_V3 in /app/api/gemini-roof/route.ts if the V3 response shape changed." >&2
    ;;
esac

# Migration safety — new migration files must use `supabase migration new`,
# not be hand-written. Block direct writes to migrations/.
case "$FILE" in
  */migrations/0*.sql)
    if [ ! -f "$FILE" ]; then
      echo "[prewrite] BLOCKED: new migration files must be created via 'supabase migration new <name>'." >&2
      echo "[prewrite] Editing an existing migration file is OK; creating one inline is not." >&2
      exit 2
    fi
    ;;
esac

exit 0

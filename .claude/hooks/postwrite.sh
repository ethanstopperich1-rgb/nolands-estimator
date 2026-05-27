#!/usr/bin/env bash
# PostToolUse hook: format + lint + typecheck after every Write|Edit|MultiEdit.
#
# Each step soft-fails (|| true) so a missing tool never blocks Claude.
# Output is truncated to 20 lines so it doesn't flood context.

INPUT=$(cat)
FILE=$(echo "$INPUT" | python3 -c "import sys,json
try: d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))
except: print('')" 2>/dev/null)

[ -z "$FILE" ] && exit 0
cd "${CLAUDE_PROJECT_DIR:-/Users/voxaris/nolands-estimator}" || exit 0

case "$FILE" in
  *.ts|*.tsx)
    # Auto-format
    npx prettier --write "$FILE" 2>&1 | tail -3 || true

    # Lint .tsx specifically (more rules apply to JSX)
    if [[ "$FILE" == *.tsx ]]; then
      npx eslint --fix "$FILE" 2>&1 | tail -10 || true
    fi

    # Typecheck the whole project (tsc is incremental, ~3-5s)
    TSC_OUT=$(npx tsc --noEmit 2>&1 | head -25)
    if [ -n "$TSC_OUT" ]; then
      echo "[postwrite] tsc output:" >&2
      echo "$TSC_OUT" >&2
    fi
    ;;
  *.json)
    # Validate JSON parses (catch trailing-comma / quote errors immediately)
    python3 -c "import json; json.load(open('$FILE'))" 2>&1 >/dev/null || \
      echo "[postwrite] WARNING: $FILE is not valid JSON" >&2
    ;;
esac

exit 0

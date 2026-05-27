#!/usr/bin/env bash
# Stop hook: final quality gate before Claude can end its turn.
#
# CRITICAL: must check stop_hook_active. If true, Claude is already
# continuing because of a previous Stop hook — exit 0 immediately
# or you get an infinite loop.

INPUT=$(cat)
STOP_ACTIVE=$(echo "$INPUT" | python3 -c "import sys,json
try: d=json.load(sys.stdin); print(d.get('stop_hook_active', False))
except: print('False')" 2>/dev/null)

if [ "$STOP_ACTIVE" = "True" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-/Users/voxaris/nolands-estimator}" || exit 0

# Skip the gate if the session was read-only (no recent writes).
# We approximate this by checking git diff against HEAD — if nothing
# changed, no need to retest.
if git diff --quiet HEAD 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
  exit 0
fi

echo "[stop] running typecheck..."
TSC_OUT=$(npx tsc --noEmit 2>&1)
TSC_RC=$?

if [ $TSC_RC -ne 0 ]; then
  echo "[stop] BLOCKING: typecheck failed (rc=$TSC_RC). Fix before declaring done." >&2
  echo "--- tsc output (last 25 lines) ---" >&2
  echo "$TSC_OUT" | tail -25 >&2
  # Exit 2: Claude sees this as a directive to continue working.
  exit 2
fi

echo "[stop] running vitest..."
TEST_OUT=$(npm test --silent 2>&1)
TEST_RC=$?

if [ $TEST_RC -ne 0 ]; then
  echo "[stop] BLOCKING: tests failed (rc=$TEST_RC). Fix before declaring done." >&2
  echo "--- test tail (last 30 lines) ---" >&2
  echo "$TEST_OUT" | tail -30 >&2
  exit 2
fi

echo "[stop] OK — typecheck + tests green."
exit 0

#!/usr/bin/env bash
#
# Phase 3 — End-to-end smoke test.
#
# Hits /api/_health to confirm env-var population, then dispatches a
# real outbound test call to the destination number you provide. Use
# your own phone (or a coworker's, with consent) — Sydney will pick
# up, identify herself, and verify the loop is closed.
#
# Usage:
#   ./scripts/telephony/03-smoke-test.sh +1XXXXXXXXXX
#
# Pass --env=local to hit localhost:3000, --env=prod (default) to hit
# the Vercel production deployment.

set -euo pipefail

# ─── Args ────────────────────────────────────────────────────────────
DEST_NUMBER=""
ENV_TARGET="prod"

for arg in "$@"; do
  case "$arg" in
    --env=local) ENV_TARGET="local" ;;
    --env=prod)  ENV_TARGET="prod" ;;
    +*)          DEST_NUMBER="$arg" ;;
    *)
      echo "Usage: $0 +1XXXXXXXXXX [--env=local|--env=prod]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$DEST_NUMBER" ]]; then
  echo "Usage: $0 +1XXXXXXXXXX [--env=local|--env=prod]" >&2
  exit 2
fi
if [[ ! "$DEST_NUMBER" =~ ^\+[1-9][0-9]{6,14}$ ]]; then
  echo "ERROR: destination must be E.164" >&2
  exit 2
fi

# ─── Resolve host + secret ───────────────────────────────────────────
case "$ENV_TARGET" in
  local) BASE="http://localhost:3000" ;;
  prod)  BASE="https://pitch.voxaris.io" ;;
esac

# Health-check token + dispatch secret. Both reference the same
# INTERNAL_DISPATCH_SECRET. Read from .env.local — DO NOT echo to
# scrollback.
if [[ ! -f .env.local ]]; then
  echo "ERROR: .env.local not found. Run: vercel env pull .env.local" >&2
  exit 1
fi
SECRET="$(grep -E '^INTERNAL_DISPATCH_SECRET=' .env.local | head -1 | cut -d= -f2- | tr -d '"')"
if [[ -z "$SECRET" ]]; then
  echo "ERROR: INTERNAL_DISPATCH_SECRET not in .env.local" >&2
  exit 1
fi

echo ""
echo "═══ Phase 3: Smoke test ═══"
echo ""
echo "Target env:    $ENV_TARGET ($BASE)"
echo "Destination:   $DEST_NUMBER"
echo ""

# ─── 1. /api/_health ─────────────────────────────────────────────────
echo "▸ Probing /api/_health..."
HEALTH_RESP="$(curl -fsS -X GET "$BASE/api/_health" \
  -H "X-Voxaris-Health-Token: $SECRET" 2>&1 || true)"

if [[ -z "$HEALTH_RESP" ]]; then
  echo "  ERROR: /api/_health returned nothing. Is the deploy live?" >&2
  exit 1
fi

# Pretty-print
if command -v jq >/dev/null 2>&1; then
  echo "$HEALTH_RESP" | jq '.'
else
  echo "$HEALTH_RESP"
fi

# Bail if telephony stack isn't ok.
LIVEKIT_STATUS="$(echo "$HEALTH_RESP" | grep -oE '"livekit":[[:space:]]*\{[^}]*"status":[[:space:]]*"[^"]*"' | grep -oE '"status":[[:space:]]*"[^"]*"' | grep -oE '"[a-z]+"$' | tr -d '"' | tail -1)"
if [[ "$LIVEKIT_STATUS" != "ok" ]]; then
  echo ""
  echo "  ⚠ livekit status is '$LIVEKIT_STATUS' — populate the missing env vars and re-deploy before testing dispatch." >&2
  exit 1
fi

echo ""
echo "▸ All telephony env vars populated. Dispatching test call..."

# ─── 2. POST /api/dispatch-outbound ──────────────────────────────────
DISPATCH_PAYLOAD="$(cat <<EOF
{
  "phoneE164": "$DEST_NUMBER",
  "leadId": "smoke-test-$(date +%s)",
  "leadPublicId": "lead_$(openssl rand -hex 16)",
  "customerName": "Smoke Test",
  "address": "1 Main St, Orlando, FL",
  "estimateLow": 28000,
  "estimateHigh": 52000,
  "sqft": 4357,
  "material": "asphalt-architectural",
  "office": "voxaris"
}
EOF
)"

DISPATCH_RESP="$(curl -fsS -X POST "$BASE/api/dispatch-outbound" \
  -H "content-type: application/json" \
  -H "x-dispatch-secret: $SECRET" \
  -d "$DISPATCH_PAYLOAD" 2>&1 || true)"

echo ""
echo "▸ Dispatch response:"
if command -v jq >/dev/null 2>&1; then
  echo "$DISPATCH_RESP" | jq '.'
else
  echo "$DISPATCH_RESP"
fi

if echo "$DISPATCH_RESP" | grep -q '"error"'; then
  echo "" >&2
  echo "  ✗ Dispatch failed. See response above for the specific error." >&2
  exit 1
fi

echo ""
echo "═══ Phase 3 complete ═══"
echo ""
echo "  Outbound call dispatched to $DEST_NUMBER"
echo "  Sydney should ring within ~10 seconds."
echo ""
echo "  If the phone DIDN'T ring:"
echo "    - Check /dashboard/calls for the call row + transcript"
echo "    - Tail Vercel logs: vercel logs --since=2m"
echo "    - Verify LiveKit Cloud → SIP → Outbound trunks shows the call"
echo ""
echo "  If the phone rang but Sydney didn't speak:"
echo "    - The agent isn't deployed in LiveKit Cloud or isn't named '$AGENT_NAME'"
echo "    - Check LiveKit Cloud → Agents"

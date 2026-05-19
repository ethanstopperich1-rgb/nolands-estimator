#!/usr/bin/env bash
#
# Phase 2 — LiveKit inbound trunk + outbound trunk + dispatch rule.
#
# Reads the Twilio output from Phase 1 (in .state/), generates the
# trunk JSON files, runs `lk sip` commands, writes the outbound trunk
# ID to .state/ for Phase 3.
#
# Usage:
#   ./scripts/telephony/02-livekit-sip-setup.sh
#
# Idempotent: re-running with the same phone number is safe.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SCRIPT_DIR/.state"

# ─── Sanity ──────────────────────────────────────────────────────────
if ! command -v lk >/dev/null 2>&1; then
  echo "ERROR: lk CLI not installed." >&2
  echo "  brew install livekit-cli" >&2
  exit 1
fi
for f in phone-number twilio-trunk-domain sip-username; do
  if [[ ! -f "$STATE_DIR/$f" ]]; then
    echo "ERROR: missing $STATE_DIR/$f — run Phase 1 first." >&2
    exit 1
  fi
done

PHONE_NUMBER="$(cat "$STATE_DIR/phone-number")"
TRUNK_DOMAIN="$(cat "$STATE_DIR/twilio-trunk-domain")"
SIP_USERNAME="$(cat "$STATE_DIR/sip-username")"
SLUG="voxaris-$(echo "$PHONE_NUMBER" | tr -d '+')"

# Pull SIP password — keychain first, then .state file fallback.
SIP_PASSWORD=""
if command -v security >/dev/null 2>&1; then
  SIP_PASSWORD="$(security find-generic-password \
    -a "$SIP_USERNAME" -s "voxaris-sip-$SLUG" -w 2>/dev/null || true)"
fi
if [[ -z "$SIP_PASSWORD" && -f "$STATE_DIR/sip-password" ]]; then
  SIP_PASSWORD="$(cat "$STATE_DIR/sip-password")"
fi
if [[ -z "$SIP_PASSWORD" ]]; then
  read -srp "SIP trunk password (Phase 1 generated): " SIP_PASSWORD
  echo ""
fi

# Agent name — defaults to "sydney" but can be overridden via env.
AGENT_NAME="${LIVEKIT_AGENT_NAME:-sydney}"

echo ""
echo "═══ Phase 2: LiveKit SIP trunks ═══"
echo ""
echo "Phone number:  $PHONE_NUMBER"
echo "Trunk domain:  $TRUNK_DOMAIN"
echo "SIP username:  $SIP_USERNAME"
echo "Agent name:    $AGENT_NAME"
echo ""

# ─── 1. Inbound trunk ────────────────────────────────────────────────
INBOUND_JSON="$STATE_DIR/inbound-trunk.json"
cat > "$INBOUND_JSON" <<EOF
{
  "trunk": {
    "name": "Voxaris inbound — $PHONE_NUMBER",
    "numbers": ["$PHONE_NUMBER"],
    "authUsername": "$SIP_USERNAME",
    "authPassword": "$SIP_PASSWORD"
  }
}
EOF

echo "▸ Creating LiveKit inbound trunk..."
INBOUND_RESULT="$(lk sip inbound create "$INBOUND_JSON" 2>&1)"
echo "$INBOUND_RESULT"

# Parse trunk ID from output. `lk sip inbound create` prints
# "SIPTrunkID: ST_xxx" — grep for it.
INBOUND_TRUNK_ID="$(echo "$INBOUND_RESULT" | grep -oE 'ST_[A-Za-z0-9]+' | head -1)"
if [[ -z "$INBOUND_TRUNK_ID" ]]; then
  echo "ERROR: could not parse inbound trunk ID from lk output above." >&2
  exit 1
fi
echo "$INBOUND_TRUNK_ID" > "$STATE_DIR/livekit-inbound-trunk-id"
echo "  Inbound trunk: $INBOUND_TRUNK_ID"

# ─── 2. Outbound trunk ───────────────────────────────────────────────
OUTBOUND_JSON="$STATE_DIR/outbound-trunk.json"
cat > "$OUTBOUND_JSON" <<EOF
{
  "trunk": {
    "name": "Voxaris outbound — $PHONE_NUMBER",
    "address": "$TRUNK_DOMAIN",
    "numbers": ["$PHONE_NUMBER"],
    "authUsername": "$SIP_USERNAME",
    "authPassword": "$SIP_PASSWORD"
  }
}
EOF

echo "▸ Creating LiveKit outbound trunk..."
OUTBOUND_RESULT="$(lk sip outbound create "$OUTBOUND_JSON" 2>&1)"
echo "$OUTBOUND_RESULT"

OUTBOUND_TRUNK_ID="$(echo "$OUTBOUND_RESULT" | grep -oE 'ST_[A-Za-z0-9]+' | head -1)"
if [[ -z "$OUTBOUND_TRUNK_ID" ]]; then
  echo "ERROR: could not parse outbound trunk ID from lk output above." >&2
  exit 1
fi
echo "$OUTBOUND_TRUNK_ID" > "$STATE_DIR/livekit-outbound-trunk-id"
echo "  Outbound trunk: $OUTBOUND_TRUNK_ID"

# ─── 3. Dispatch rule ────────────────────────────────────────────────
DISPATCH_JSON="$STATE_DIR/dispatch-rule.json"
cat > "$DISPATCH_JSON" <<EOF
{
  "dispatch_rule": {
    "rule": {
      "dispatchRuleIndividual": {
        "roomPrefix": "voxaris-call-"
      }
    },
    "name": "Voxaris inbound dispatch — $PHONE_NUMBER",
    "roomConfig": {
      "agents": [{ "agentName": "$AGENT_NAME" }]
    }
  }
}
EOF

echo "▸ Creating LiveKit dispatch rule..."
lk sip dispatch create "$DISPATCH_JSON" --trunks "$INBOUND_TRUNK_ID"

# ─── 4. Write env-var hints ──────────────────────────────────────────
ENV_HINTS="$STATE_DIR/env-hints.txt"
cat > "$ENV_HINTS" <<EOF
# Env vars to push to Vercel production:
#   vercel env add LIVEKIT_URL production
#   vercel env add LIVEKIT_API_KEY production
#   vercel env add LIVEKIT_API_SECRET production
#   vercel env add SIP_OUTBOUND_TRUNK_ID production
#
# When prompted, paste:
SIP_OUTBOUND_TRUNK_ID=$OUTBOUND_TRUNK_ID
EOF

# Mirror to .env.local for local dev — safe to write since it's
# gitignored.
if [[ -f .env.local ]]; then
  # Strip any prior SIP_OUTBOUND_TRUNK_ID line, then append.
  grep -v '^SIP_OUTBOUND_TRUNK_ID=' .env.local > .env.local.tmp || true
  mv .env.local.tmp .env.local
  echo "SIP_OUTBOUND_TRUNK_ID=$OUTBOUND_TRUNK_ID" >> .env.local
  echo "  Updated .env.local with SIP_OUTBOUND_TRUNK_ID"
fi

echo ""
echo "═══ Phase 2 complete ═══"
echo ""
echo "  Inbound trunk:   $INBOUND_TRUNK_ID"
echo "  Outbound trunk:  $OUTBOUND_TRUNK_ID"
echo "  Agent:           $AGENT_NAME"
echo ""
echo "Next:"
echo "  1. Push LiveKit creds + outbound trunk ID to Vercel:"
echo "       vercel env add LIVEKIT_URL production"
echo "       vercel env add LIVEKIT_API_KEY production"
echo "       vercel env add LIVEKIT_API_SECRET production"
echo "       vercel env add SIP_OUTBOUND_TRUNK_ID production"
echo "       (paste: $OUTBOUND_TRUNK_ID )"
echo ""
echo "  2. Trigger deploy: vercel deploy --prod"
echo ""
echo "  3. Smoke test: ./scripts/telephony/03-smoke-test.sh +1XXXXXXXXXX"

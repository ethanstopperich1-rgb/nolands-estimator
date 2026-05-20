#!/usr/bin/env bash
#
# One-shot Twilio env-var wire-up for Vercel.
#
# Prompts for SID, Auth Token, and Phone Number locally (silent input
# on the token so it doesn't echo to scrollback), then pushes each to
# Vercel production via `vercel env add` piped non-interactively.
#
# Usage:
#   ./scripts/wire-twilio.sh
#
# After it finishes, run `vercel deploy --prod` (or `vercel deploy
# --prod --force`) to pick up the new env vars.

set -euo pipefail

# ─── Pre-flight ─────────────────────────────────────────────────────
if ! command -v vercel >/dev/null 2>&1; then
  echo "ERROR: vercel CLI not installed." >&2
  echo "  npm i -g vercel" >&2
  exit 1
fi
if ! vercel whoami >/dev/null 2>&1; then
  echo "ERROR: vercel CLI not authenticated." >&2
  echo "  vercel login" >&2
  exit 1
fi

echo ""
echo "═══ Wire Twilio creds to Vercel production ═══"
echo ""
echo "You'll need from Twilio Console (console.twilio.com):"
echo "  1. Account SID — starts with AC..."
echo "  2. Auth Token  — only shown ONCE on token creation; if you"
echo "                   lost it, rotate it via 'Create secondary"
echo "                   auth token' then promote it."
echo "  3. Phone number — E.164, e.g. +18887869134"
echo ""

read -rp "TWILIO_ACCOUNT_SID  (AC...): " TWILIO_ACCOUNT_SID
if [[ ! "$TWILIO_ACCOUNT_SID" =~ ^AC[a-f0-9]{32}$ ]]; then
  echo "ERROR: Account SID must start with AC and be 34 chars total." >&2
  exit 2
fi

# Silent read for the secret — won't appear in terminal scrollback.
read -srp "TWILIO_AUTH_TOKEN   (hidden): " TWILIO_AUTH_TOKEN
echo ""
if [[ ${#TWILIO_AUTH_TOKEN} -lt 16 ]]; then
  echo "ERROR: Auth token looks too short ($(echo -n "$TWILIO_AUTH_TOKEN" | wc -c) chars)." >&2
  exit 2
fi

read -rp "TWILIO_PHONE_NUMBER (+1XXXXXXXXXX): " TWILIO_PHONE_NUMBER
if [[ ! "$TWILIO_PHONE_NUMBER" =~ ^\+[1-9][0-9]{6,14}$ ]]; then
  echo "ERROR: Phone number must be E.164 (e.g. +18887869134)." >&2
  exit 2
fi

echo ""
echo "▸ Pushing to Vercel production..."

# `vercel env add <name> <env>` reads the value from stdin when piped.
# This is the non-interactive shape — no prompt, no echo, no
# scrollback exposure.
push_env() {
  local name="$1"
  local value="$2"
  # Remove any existing value first so add doesn't error on duplicate.
  vercel env rm "$name" production --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$name" production >/dev/null
  echo "  ✓ $name"
}

push_env TWILIO_ACCOUNT_SID  "$TWILIO_ACCOUNT_SID"
push_env TWILIO_AUTH_TOKEN   "$TWILIO_AUTH_TOKEN"
push_env TWILIO_PHONE_NUMBER "$TWILIO_PHONE_NUMBER"

# Also set the rep-notification fallback so you get the lead alerts.
read -rp "LEAD_NOTIFY_PHONE   (where to text new-lead alerts; blank to skip): " LEAD_NOTIFY_PHONE
if [[ -n "$LEAD_NOTIFY_PHONE" ]]; then
  if [[ ! "$LEAD_NOTIFY_PHONE" =~ ^\+[1-9][0-9]{6,14}$ ]]; then
    echo "  ⚠ Phone not E.164 — skipping LEAD_NOTIFY_PHONE." >&2
  else
    push_env LEAD_NOTIFY_PHONE "$LEAD_NOTIFY_PHONE"
  fi
fi

echo ""
echo "═══ Done ═══"
echo ""
echo "Next steps:"
echo "  1. Trigger a deploy:  vercel deploy --prod"
echo "  2. Wait for deploy:   ~60s"
echo "  3. Smoke test SMS:"
echo "       vercel env pull .env.local"
echo "       npx tsx scripts/send-test-sms.ts +14078195809"
echo ""
echo "Or just submit a real test lead on pitch.voxaris.io with"
echo "your phone — confirmation SMS + Reply YES + Sydney callback"
echo "will all fire end-to-end."

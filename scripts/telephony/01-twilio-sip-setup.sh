#!/usr/bin/env bash
#
# Phase 1 — Twilio Elastic SIP Trunk setup.
#
# Creates: trunk + origination connection policy + credential list +
# associates phone number with trunk. Outputs IDs to .state/ for
# Phase 2 to pick up.
#
# Usage:
#   ./scripts/telephony/01-twilio-sip-setup.sh +18887869134
#
# Idempotent: re-running with the same number is safe — uses
# friendly-name lookups to avoid duplicating trunks/policies.

set -euo pipefail

# ─── Args + sanity ───────────────────────────────────────────────────
PHONE_NUMBER="${1:-}"
if [[ -z "$PHONE_NUMBER" ]]; then
  echo "Usage: $0 +1XXXXXXXXXX" >&2
  exit 2
fi
if [[ ! "$PHONE_NUMBER" =~ ^\+[1-9][0-9]{6,14}$ ]]; then
  echo "ERROR: phone number must be E.164 (e.g. +18887869134)" >&2
  exit 2
fi

# ─── CLI checks ──────────────────────────────────────────────────────
if ! command -v twilio >/dev/null 2>&1; then
  echo "ERROR: twilio CLI not installed." >&2
  echo "  brew install twilio/brew/twilio" >&2
  exit 1
fi
if ! twilio profiles:list 2>&1 | grep -q "active"; then
  echo "ERROR: twilio CLI not authenticated." >&2
  echo "  twilio login" >&2
  exit 1
fi

# LiveKit SIP host — needed for origination URL. Read from env if set,
# else prompt. Stored to .state/ so Phase 2 can reuse without
# re-prompting.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SCRIPT_DIR/.state"
mkdir -p "$STATE_DIR"

if [[ -z "${LIVEKIT_SIP_HOST:-}" ]]; then
  if [[ -f "$STATE_DIR/livekit-sip-host" ]]; then
    LIVEKIT_SIP_HOST="$(cat "$STATE_DIR/livekit-sip-host")"
  else
    read -rp "LiveKit Cloud SIP host (e.g. abc123.sip.livekit.cloud): " LIVEKIT_SIP_HOST
    echo "$LIVEKIT_SIP_HOST" > "$STATE_DIR/livekit-sip-host"
  fi
fi

# Strip any sip: prefix or trailing slash the user might paste.
LIVEKIT_SIP_HOST="${LIVEKIT_SIP_HOST#sip:}"
LIVEKIT_SIP_HOST="${LIVEKIT_SIP_HOST%/}"
LIVEKIT_SIP_URI="sip:${LIVEKIT_SIP_HOST};transport=tcp"

# ─── Trunk + policy names ────────────────────────────────────────────
# Slugged from the phone number so multiple numbers can coexist.
SLUG="voxaris-$(echo "$PHONE_NUMBER" | tr -d '+')"
TRUNK_FRIENDLY="${SLUG}-trunk"
TRUNK_DOMAIN="${SLUG}.pstn.twilio.com"

echo ""
echo "═══ Phase 1: Twilio Elastic SIP Trunk ═══"
echo ""
echo "Phone number:  $PHONE_NUMBER"
echo "Trunk name:    $TRUNK_FRIENDLY"
echo "Trunk domain:  $TRUNK_DOMAIN"
echo "LiveKit SIP:   $LIVEKIT_SIP_URI"
echo ""

# ─── 1. Create or find the trunk ─────────────────────────────────────
echo "▸ Looking for existing trunk..."
TRUNK_SID="$(twilio api trunking v1 trunks list \
  --properties=sid,friendlyName \
  --no-header 2>/dev/null \
  | awk -v name="$TRUNK_FRIENDLY" '$2 == name { print $1; exit }')"

if [[ -n "$TRUNK_SID" ]]; then
  echo "  Found existing trunk: $TRUNK_SID"
else
  echo "▸ Creating trunk..."
  TRUNK_SID="$(twilio api trunking v1 trunks create \
    --friendly-name "$TRUNK_FRIENDLY" \
    --domain-name "$TRUNK_DOMAIN" \
    --properties=sid \
    --no-header 2>/dev/null)"
  echo "  Created trunk: $TRUNK_SID"
fi
echo "$TRUNK_SID" > "$STATE_DIR/twilio-trunk-sid"

# ─── 2. Configure origination (inbound: Twilio → LiveKit) ───────────
echo "▸ Configuring origination URL..."
EXISTING_ORIG="$(twilio api trunking v1 trunks origination-urls list \
  --trunk-sid="$TRUNK_SID" \
  --properties=sid,friendlyName \
  --no-header 2>/dev/null \
  | awk '$2 == "LiveKit-Origination" { print $1; exit }')"

if [[ -n "$EXISTING_ORIG" ]]; then
  echo "  Found existing origination URL: $EXISTING_ORIG"
else
  twilio api trunking v1 trunks origination-urls create \
    --trunk-sid="$TRUNK_SID" \
    --friendly-name "LiveKit-Origination" \
    --sip-url "$LIVEKIT_SIP_URI" \
    --weight 1 --priority 1 --enabled >/dev/null
  echo "  Created origination URL → $LIVEKIT_SIP_URI"
fi

# ─── 3. Credential list (outbound: LiveKit → Twilio) ────────────────
echo "▸ Setting up termination credentials..."
CRED_LIST_NAME="${SLUG}-credentials"

# Check if credential list already exists. Twilio CLI doesn't expose
# credential-lists list directly; we use the REST API via curl through
# the CLI's auth.
EXISTING_CRED_LIST="$(twilio api core sip credential-lists list \
  --properties=sid,friendlyName \
  --no-header 2>/dev/null \
  | awk -v name="$CRED_LIST_NAME" '$2 == name { print $1; exit }')"

if [[ -n "$EXISTING_CRED_LIST" ]]; then
  echo "  Found existing credential list: $EXISTING_CRED_LIST"
  # Re-prompt for password so we can write it to .env.local — the
  # credential is already stored on Twilio's side but we need it here
  # too for LiveKit's outbound trunk config.
  read -rp "  SIP trunk username (already set on Twilio): " SIP_USERNAME
  read -srp "  SIP trunk password (already set on Twilio): " SIP_PASSWORD
  echo ""
  CRED_LIST_SID="$EXISTING_CRED_LIST"
else
  # Prompt for fresh credentials. Generate a strong password by default.
  SIP_USERNAME="voxaris_$(openssl rand -hex 4)"
  SIP_PASSWORD="$(openssl rand -base64 24 | tr -d '=+/' | head -c 32)"
  echo "  Auto-generated SIP username: $SIP_USERNAME"
  echo "  Auto-generated SIP password: <hidden, length 32>"
  echo ""
  read -rp "  Use these credentials? [Y/n]: " USE_AUTO
  if [[ "$USE_AUTO" =~ ^[Nn] ]]; then
    read -rp "  Custom SIP username: " SIP_USERNAME
    read -srp "  Custom SIP password (16+ chars): " SIP_PASSWORD
    echo ""
  fi

  CRED_LIST_SID="$(twilio api core sip credential-lists create \
    --friendly-name "$CRED_LIST_NAME" \
    --properties=sid \
    --no-header 2>/dev/null)"

  twilio api core sip credential-lists credentials create \
    --credential-list-sid "$CRED_LIST_SID" \
    --username "$SIP_USERNAME" \
    --password "$SIP_PASSWORD" >/dev/null

  echo "  Created credential list: $CRED_LIST_SID"
fi

# Attach credential list to trunk (idempotent — Twilio API accepts
# duplicate add as no-op).
twilio api trunking v1 trunks credentials-lists create \
  --trunk-sid "$TRUNK_SID" \
  --credential-list-sid "$CRED_LIST_SID" >/dev/null 2>&1 || true
echo "  Attached credential list to trunk"

# ─── 4. Associate phone number with trunk ───────────────────────────
echo "▸ Associating phone number with trunk..."
PHONE_SID="$(twilio phone-numbers:list \
  --properties=sid,phoneNumber \
  --no-header 2>/dev/null \
  | awk -v num="$PHONE_NUMBER" '$2 == num { print $1; exit }')"

if [[ -z "$PHONE_SID" ]]; then
  echo "ERROR: phone number $PHONE_NUMBER not found in this Twilio account" >&2
  echo "       Buy or port the number first, then re-run." >&2
  exit 1
fi

twilio api trunking v1 trunks phone-numbers create \
  --trunk-sid "$TRUNK_SID" \
  --phone-number-sid "$PHONE_SID" >/dev/null 2>&1 \
  && echo "  Associated $PHONE_NUMBER ($PHONE_SID) with trunk" \
  || echo "  Phone number already on trunk (or association call was idempotent)"

# ─── 5. Persist state for Phase 2 ────────────────────────────────────
echo "$PHONE_NUMBER" > "$STATE_DIR/phone-number"
echo "$TRUNK_SID" > "$STATE_DIR/twilio-trunk-sid"
echo "$CRED_LIST_SID" > "$STATE_DIR/twilio-credential-list-sid"
echo "$TRUNK_DOMAIN" > "$STATE_DIR/twilio-trunk-domain"
echo "$SIP_USERNAME" > "$STATE_DIR/sip-username"
# Password goes into macOS keychain, not to disk.
if command -v security >/dev/null 2>&1; then
  security add-generic-password \
    -a "$SIP_USERNAME" \
    -s "voxaris-sip-$SLUG" \
    -w "$SIP_PASSWORD" \
    -U 2>/dev/null
  echo "  Stashed SIP password in macOS keychain: voxaris-sip-$SLUG"
else
  # Non-macOS fallback — write to a 600-mode file in .state/. Add
  # .state/ to .gitignore (already done by the README).
  echo "$SIP_PASSWORD" > "$STATE_DIR/sip-password"
  chmod 600 "$STATE_DIR/sip-password"
  echo "  Stashed SIP password at $STATE_DIR/sip-password (chmod 600)"
fi

echo ""
echo "═══ Phase 1 complete ═══"
echo ""
echo "  Trunk SID:         $TRUNK_SID"
echo "  Trunk domain:      $TRUNK_DOMAIN"
echo "  Credential list:   $CRED_LIST_SID"
echo "  SIP username:      $SIP_USERNAME"
echo "  SIP password:      (stored in keychain / .state/)"
echo ""
echo "Next: ./scripts/telephony/02-livekit-sip-setup.sh"

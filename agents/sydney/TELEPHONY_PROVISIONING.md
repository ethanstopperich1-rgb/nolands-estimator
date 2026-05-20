# Telephony provisioning — 888 forwards to 321

End-to-end runbook for routing the Voxaris toll-free `+18887869134`
into Sydney via a simple carrier-level forward to Noland's already-wired
`+13219851104`. Plus the Voice Trust compliance steps for the 321
number (the actual caller-ID Sydney presents on outbound).

**Owner:** Ethan (Twilio Console needs 2FA).

**Estimated active time:** 15 min for forwarding. Voice Trust is
async — 1-7 day Twilio review.

---

## Architecture (the simple version)

```
Caller dials +18887869134 (Voxaris marketing number)
        ↓
Twilio TF Voice Config → Forward to +13219851104
        ↓
+13219851104 already wired via setup_sip.py
        ↓
Sydney answers (with AI-disclosure opener)

Sydney calls homeowner outbound
        ↓
SIP outbound trunk dials FROM +13219851104 (caller-ID)
        ↓
Homeowner sees Noland's familiar 321 number on incoming-call screen
```

**Key insight:** The 888 number is a pure marketing/branding asset.
It doesn't need its own LK inbound trunk, dispatch rule, or TwiML
Bin. It's just a forward. This means:
- One number to wire into LK (321) — already done
- One number to register for Voice Trust (321) — likely already done by Noland's
- 888 can be swapped to forward to ANY contractor number later
  without touching Sydney code

---

## Step 1 — Twilio: forward 888 → 321 [YOU, ~5 min]

The cleanest path is Twilio's built-in call forwarding via a TwiML
Bin (not the legacy "Forward to" field on phone numbers, which has
fewer features and is being deprecated).

1. **Create a TwiML Bin.** [console.twilio.com](https://console.twilio.com)
   → Develop → TwiML Bins → Create new TwiML Bin.

   **Friendly name:** `Voxaris TF → 321 forward`

   **TwiML body:**
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <Response>
     <Dial answerOnBridge="true" callerId="+18887869134">
       <Number>+13219851104</Number>
     </Dial>
   </Response>
   ```

   Why each attribute:
   - `answerOnBridge="true"` — caller hears ringing while we connect,
     not Twilio's silent "calling..." gap. Sounds like a normal call.
   - `callerId="+18887869134"` — the 321 line sees the 888 number on
     its incoming-call display. Useful for the office to know "this
     came through the Voxaris marketing line" vs a direct dial.

2. **Assign the TwiML Bin to the toll-free.** Twilio Console →
   Phone Numbers → Manage → Active numbers → click `+18887869134`.
   In the **Voice Configuration** section:
   - **A call comes in** → TwiML Bin → select `Voxaris TF → 321 forward`
   - Save.

3. **Verify.** Call `+18887869134` from your cell. You should hear
   Sydney pick up (same opener as if you'd called 321 directly).

That's it. The 888 is now live as a Sydney number.

---

## Step 2 — Sydney outbound caller-ID [YOU, ~2 min]

Already documented in `.env.example`. Set on the LK Cloud Agent:

**LK Cloud console:** cloud.livekit.io → your project → Agents →
`sydney` → Settings → Environment Variables:

```
SYDNEY_OUTBOUND_CALLER_ID = +13219851104
```

Or via CLI:
```bash
lk agent env set sydney SYDNEY_OUTBOUND_CALLER_ID=+13219851104
```

Either triggers a rolling restart of the worker (~30s).

**Verify:** trigger an outbound call via the SMS YES flow. The
homeowner should see `+13219851104` on their incoming-call display,
not `+14072890294` or any Twilio trunk DID.

If you get a Twilio SIP 403 "Caller ID unauthorized" error, the
outbound trunk isn't authorized to present 321 as caller-ID. Fix is
in Twilio Console → Elastic SIP Trunks → your trunk → Origination /
Termination → add `+13219851104` to the authorized caller-ID list.

---

## Step 3 — Voice Trust for +13219851104 [YOU, async]

Sydney's outbound calls present `+13219851104` as caller-ID. For
those calls to NOT show as "Spam Likely" / "V" / "?" on Verizon /
AT&T / T-Mobile, that number needs SHAKEN/STIR attestation via
Twilio's Voice Trust program.

**Check first — is 321 already registered?** Noland's may have done
this already if 321 is their existing published business line.
Twilio Console → Trust Hub → Trust Products → look for an active
Voice Trust profile with `+13219851104` attached.

- **Already registered:** done, skip the rest of this step.
- **Not registered:** proceed below.

### Trust Hub Customer Profile [~15 min + 1-3 day review]

If Noland's doesn't already have a Customer Profile in the Twilio
account where 321 lives:

1. Twilio Console → **Trust Hub** → **Customer Profiles** → **Create
   profile**.
2. Fill in (Noland's business, NOT Voxaris — 321 is their line):
   - **Business name:** Noland's Roofing (LLC / Inc — match
     formation docs)
   - **Business type:** LLC / Corporation / Sole Prop
   - **EIN:** Noland's federal EIN
   - **Business address:** Noland's HQ address
   - **Website URL:** Noland's website
   - **Industry vertical:** Construction → Roofing
   - **Authorized representative:** the Noland's contact (name,
     email, phone, job title)
3. Auto-verify runs; 1-3 day async for manual review if needed.

### Voice Trust profile [~10 min + 1-7 day review]

1. Twilio Console → **Trust Hub** → **Trust Products** → **Create
   trust product** → **Voice Integrity** (or "Voice Branded Caller").
2. Attach the Customer Profile from above.
3. **Use case description** (copy-paste this):

   > "Automated voice assistant for Noland's Roofing. Sydney AI
   > receptionist handles inbound calls (greeting, qualification,
   > scheduling). Outbound calls are personal follow-up to homeowners
   > who submitted a quote on Noland's Voxaris-powered estimator and
   > provided TCPA + AI-voice consent. Consent text: see
   > lib/tcpa-consent.ts in the voxaris-pitch repo. Voice disclosure:
   > opener identifies as 'AI assistant' per FCC Feb 2024 ruling."

4. **Estimated call volume:** start at 100-500/day.
5. **Avg call duration:** 3-5 min.
6. **Attach the number:** `+13219851104`.
7. Submit. 1-7 day review.

### SHAKEN/STIR (automatic after Voice Trust approves)

Once the Voice Trust profile is approved and 321 is attached, Twilio
applies "Full Attestation (A)" to all outbound calls from 321. No
extra config.

**Verify post-approval:** place an outbound call from Sydney to a
Verizon / AT&T cell. The call should display "Noland's Roofing"
(brand name from the Trust profile), not "Spam Likely."

---

## Voice compliance summary

| Number | Role | Voice Trust needed? |
|---|---|---|
| `+13219851104` | Sydney inbound + Sydney outbound caller-ID | **YES** — check if Noland's already registered |
| `+18887869134` | Pure forwarder to 321, never used as caller-ID | **NO** — forwarders don't present caller-ID outbound |

**TF Verification** (for SMS from a toll-free) is a SEPARATE Twilio
program, not needed unless you start sending SMS from 888. Sydney is
voice-only, so skip TF Verification until that changes.

---

## Operational notes

### Multi-tenant future
Each contractor onboarded as a paying customer gets their OWN inbound
number wired via `setup_sip.py` (with `INBOUND_NUMBER`, `RULE_NAME`,
`ROOM_PREFIX` env overrides). The 888 forwarding pattern is
Voxaris-specific — it's the marketing/sales number, contractors don't
need it. Each contractor's own DID does the actual customer-facing
work.

### Re-pointing 888 later
If Voxaris later wants 888 to forward to a different contractor (e.g.,
during sales demos to a new prospect), edit the TwiML Bin's
`<Number>` value to the new target. 5-second change in Twilio Console.

### Costs
- **Twilio TF inbound:** ~$0.022/min (caller dials 888)
- **Twilio Dial leg:** ~$0.013/min (888 → 321 forward)
- **Twilio 321 termination → LK SIP:** included in your SIP trunk plan
- **LK Inference:** ~$0.05-0.15/min (LLM + STT + TTS)

Per-call cost on a 3-min call: ~$0.50 for the 888-routed path,
~$0.35 if homeowners call 321 directly. The 888 surcharge is the
forwarding-leg cost.

### Rolling back the 888 forward
Twilio Console → Phone Numbers → `+18887869134` → Voice Configuration
→ change "A call comes in" back to whatever it was before (or
"Reject calls"). Instant effect.

---

## What's NOT in this runbook (intentionally)

- **LK inbound trunk for 888** — not needed, 888 is just a Twilio-side
  forward to 321
- **LK dispatch rule for 888** — not needed for the same reason
- **TF SMS Verification** — Sydney is voice-only; skip until SMS
  from 888 becomes a requirement
- **Branded Calling (First Orion / Hiya)** — defer until you're at
  50+ outbound calls/day. SHAKEN/STIR alone gets you past most
  "Spam Likely" labels at low volume
- **In-call transfers (`transfer_to_human` tool)** — separate from
  carrier-level forwarding. Currently in mock mode (env vars
  `ESCALATION_*_PHONE` empty). When real transfers are needed, point
  them to a DIFFERENT number than 321 (dialing 321 from inside Sydney
  would loop). Noland's direct office extension or a dedicated
  escalation DID.

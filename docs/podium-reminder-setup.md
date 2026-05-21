# Podium Reminder Sequences — Setup Runbook

Two reminder sequences ship in this repo:

- **Sequence A (no-show prevention)** — 5 touchpoints between booking
  and the appointment. Cron: `/api/cron/podium-reminders` every 15 min.
- **Sequence B (abandoner nurture)** — 4 touchpoints over 21 days for
  leads who pulled an estimate but never booked. (B1 is the
  estimate-ready message that fires from `/api/gemini-roof` on V3
  success — already wired via `lib/podium.ts`.) Cron:
  `/api/cron/podium-abandoners` hourly.

Both sequences soft-fail when Podium isn't configured. Until templates
are created in Podium, the cron sends inline fallback copy (locked
in `lib/reminder-templates.ts`).

## What the cron does (no action needed from you here)

- Polls JobNimbus every 15 min for jobs in the next 30 days and caches
  `appointment_at` on the matching `leads` row.
- Picks one eligible touchpoint per lead per tick using the windows
  documented in `lib/podium-reminders.ts` (`pickASequenceTouchpoint` /
  `pickBSequenceTouchpoint`).
- Sends via Podium — template path if env var set, raw-text fallback
  otherwise.
- Stamps the corresponding `_sent_at` column / advances `abandoner_step`.

## What you need to do

### 1. Apply migration 0020

`migrations/0020_reminder_sequences.sql` adds 9 columns + 2 partial
indexes to `leads`. Apply via the Supabase dashboard SQL editor
(same flow as `docs/migrations-pending.md`). Safe to run any time —
additive only, defaults to NULL / FALSE / 0 on existing rows.

Verify after apply:

```sql
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'leads'
            AND column_name = 'appointment_at') AS m0020_appt,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'leads'
            AND column_name = 'abandoner_step') AS m0020_step,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'leads'
            AND column_name = 'reminder_opted_out') AS m0020_optout;
```

All three should be `t`.

### 2. Set `CRON_SECRET`

Required for the cron auth. Same secret as `storm-pulse`:

```sh
vercel env add CRON_SECRET production
# Generate: openssl rand -hex 32
```

### 3. (Optional) Create 9 Podium templates

Until templates are set, the cron sends the inline fallback copy from
`lib/reminder-templates.ts:renderFallbackCopy`. That's fine for v1.

When you're ready to migrate copy into Podium templates, create one
template per touchpoint in the Podium dashboard. Use these merge
variables (Podium syntax — adjust if your account uses different
delimiters):

| Variable | Filled by | Example |
|---|---|---|
| `firstName` | leads.name first word | "Jane" |
| `address` | leads.address | "8450 Oak Park Ave" |
| `appointmentLocal` | Formatted ET time | "2:30 PM" |
| `appointmentDayOfWeek` | Day name in ET | "Wednesday" |
| `shareUrl` | `/r/<publicId>` deep link | "https://…/r/lead_abc" |
| `repName` | rep first name or fallback | "Tom" |

Templates and the env var that wires them:

| Touchpoint | Env var | Suggested copy (compliance-locked) |
|---|---|---|
| A1 instant booking | `PODIUM_TEMPLATE_A1_INSTANT` | "Hi {{firstName}}, {{repName}} from Noland's Roofing here. You're locked in for {{appointmentDayOfWeek}} {{appointmentLocal}} at {{address}}. Need to move it? Reply with a better day. Reply STOP to opt out." |
| A2 day before | `PODIUM_TEMPLATE_A2_T24H` | "Hi {{firstName}}, quick reminder — {{repName}} will be at {{address}} tomorrow at {{appointmentLocal}}. We've measured 3 other roofs on your street this month. Reply 1 to confirm, 2 to reschedule. STOP to opt out." |
| A3 morning of | `PODIUM_TEMPLATE_A3_MORNING` | "Good morning {{firstName}}, your roof inspection is today at {{appointmentLocal}}. {{repName}} has your address ({{address}}) as a stop today. We'll text a 30-min heads-up. Reply 2 to reschedule. STOP to opt out." |
| A4 30-min ETA | `PODIUM_TEMPLATE_A4_ETA` | "{{firstName}}, {{repName}} is ~30 minutes out from {{address}}. No need to be home — we measure exterior only. Reply 2 if you need to reschedule. STOP to opt out." |
| A5 post-appointment | `PODIUM_TEMPLATE_A5_POST_APPT` | "Hi {{firstName}}, {{repName}} finished measuring your roof. Your full estimate is at {{shareUrl}}. Questions? Reply here — we read every message. STOP to opt out." |
| B2 day-after open loop | `PODIUM_TEMPLATE_B2_T24H` | "Hi {{firstName}}, you pulled an estimate for {{address}} yesterday but didn't book a time. Your roof report is still live at {{shareUrl}}. Reply 1 to schedule, 3 to skip. STOP to opt out." |
| B3 neighbor proof | `PODIUM_TEMPLATE_B3_T3D` | "{{firstName}}, two neighbors near {{address}} booked roof inspections with Noland's this week. Your report is still here: {{shareUrl}}. Reply 1 to book, 3 to skip. STOP to opt out." |
| B4 storm-season anchor | `PODIUM_TEMPLATE_B4_T7D` | "{{firstName}}, FL storm season is here and we're booking 2-3 weeks out. Your {{address}} report is still live: {{shareUrl}}. Reply 1 to grab a slot, 3 to skip. STOP to opt out." |
| B5 grace-exit | `PODIUM_TEMPLATE_B5_T21D` | "Hi {{firstName}}, last check-in from Noland's. Your {{address}} report stays live at {{shareUrl}}. Reply 1 to book a time, 3 to stop hearing from us. We hope your roof stays dry either way." |

After creating each template, copy its UID and set the matching env
var. The cron picks it up on the next tick — no redeploy needed.

```sh
vercel env add PODIUM_TEMPLATE_A1_INSTANT production
# paste template UID, repeat for each
```

### 4. Handling replies (1 / 2 / 3 / STOP)

Podium handles **STOP** at the platform level — they unsubscribe the
contact and stop accepting outbound to that number. We mirror that on
our side by setting `leads.reminder_opted_out = TRUE` so the cron
also short-circuits future sends.

The "1/2/3" replies (confirm / reschedule / opt-out-this-thread)
need a Podium **inbound webhook** to parse. Not wired today — to be
added as PR2 once Noland's confirms which Podium plan their inbox is
on (some plans don't include inbound webhooks).

In the meantime: reps see the replies in the Podium inbox and handle
them by hand. The reminder cron continues advancing through the
sequence until the human flips the lead's status — at which point the
abandoner cron's status filter halts further sends.

## Compliance constraints

These are locked. Don't bend them when you customize templates:

- **NEVER** the word "insurance" customer-facing (FL § 627.7152). Use
  "provider" / "carrier" if you must reference an insurer.
- Always include an opt-out instruction. Templates may use "Reply
  STOP" or "Reply 3" — both work; the underlying STOP keyword is
  enforced by Podium.
- Maximum 5 abandoner touchpoints. After step 5 the cron permanently
  halts for that lead, even if they don't reply STOP.
- 18h minimum gap between any two Sequence B sends (enforced in
  `pickBSequenceTouchpoint`).
- Honest copy only. No manufactured scarcity ("only 2 spots left"
  when there aren't), no fake social proof, no guilt manipulation.

## Success criteria (track in Voxaris dashboard)

- No-show rate: target -40% vs pre-launch baseline.
- Abandoner → booked conversion in 21 days: 12-18%.
- T-24h reply rate: >35%.
- Opt-out rate: <2% across either sequence.
- Reply sentiment: monitored via Podium thread reads; flag any
  pattern of complaints to ops within 24h.

## Operational notes

- Cron schedules: `*/15 * * * *` (reminders) + `0 * * * *` (abandoners)
  in `vercel.json`. Adjust only if you understand the touchpoint
  windows in `lib/podium-reminders.ts`.
- Manual trigger for debug:
  ```sh
  curl -H "Authorization: Bearer $CRON_SECRET" \
    https://estimate.nolandsroofing.com/api/cron/podium-reminders
  ```
- Stats response shape (200 OK):
  ```json
  {
    "status": "ok",
    "stats": {
      "jnSynced": 3,
      "jnErrors": 0,
      "leadsEvaluated": 12,
      "sent": 5,
      "skipped": 7,
      "errors": 0,
      "byTouchpoint": { "A2_T24H": 3, "A3_MORNING": 2 }
    }
  }
  ```

# Noland's Estimator

White-label fork of the Voxaris estimator for **Noland's Roofing**
(Central Florida — Clermont HQ, 4 offices). Deployed at
`estimate.nolandsroofing.com`.

## This is NOT the Next.js you know

This repo runs Next.js **16 canary**. APIs, conventions, and file
structure may differ from your training data. Read the relevant guide
in `node_modules/next/dist/docs/` before writing any code.

Tailwind is **v4**. There is no `tailwind.config.ts`. Theme tokens
live in `@theme inline {…}` blocks inside `app/globals.css`.

## What this product is

The **customer-facing roof estimator** for Noland's homeowners:
address → painted EagleView-quality report in <30s → SMS confirmation
→ Sydney AI voice callback (opt-in) → appointment.

`estimate.nolandsroofing.com` is the homeowner-facing entry point of
Noland's lead-capture pipeline. Same code that powers the Voxaris
demo at `pitch.voxaris.io`, reskinned for Noland's brand.

## Relationship to other repos

- **`voxaris-pitch`** — upstream codebase. Cherry-pick bug fixes
  here. Don't sync wholesale — Voxaris's sales-demo surface
  (POSITIONING.md / MARKETING.md / EMAIL.md / app/page.tsx hero
  copy) is intentionally NOT in this repo.
- **`voxaris-pitch/agents/sydney/`** — Sydney lives there. This repo
  dispatches outbound calls via `app/api/dispatch-outbound/route.ts`
  → LK Cloud Agent `CA_3p2JuouBpV2Z`. Sydney's prompt + config is
  managed in voxaris-pitch, not here. Sydney IS Noland's voice
  agent; this repo is the lead-capture surface that feeds her.
- **Voxaris Dashboard** — leads + calls + outcomes flow back to the
  Voxaris dashboard (multi-tenant by `office_id`). Noland's data
  lives in the same Supabase project under `office_id="nolands"`.

## What we're allowed to say

- **Noland's claims, not Voxaris guarantees.** All credentials,
  service descriptions, warranties, and pricing claims are
  Noland's-claimed and Noland's-backed. We don't independently
  warrant any of it.
- **NEVER the word "insurance" customer-facing.** Use "provider" or
  "carrier" instead. Florida § 627.7152 trip-wire — same locked
  rule as Sydney's prompt. Door-hangers may use it (Noland's printed
  copy, their risk); the website + estimator + Sydney do not.
- **FCC AI-voice disclosure** — Sydney's opener identifies as "an AI
  assistant" in the first sentence (handled in voxaris-pitch).
- **TCPA voice consent** — strict `voiceConsent === true` gate at
  `/api/leads/[publicId]/voice-consent`. Omission does not count as
  consent.

## Brand tokens (locked May 2026)

Color palette extracted from Noland's door hangers (deep black + red-
orange + metallic silver). Lives in `app/globals.css` `@theme`
block under the `--color-noland-*` namespace:

```
--color-noland-black           #07080A   # hero bg, primary surface
--color-noland-black-soft      #0F1115   # card bg one notch up
--color-noland-ink             #1A1D24   # secondary surface
--color-noland-fire            #E84A1F   # primary accent (red-orange)
--color-noland-fire-light      #FF6B3D   # hover / glow
--color-noland-fire-deep       #B5340E   # pressed / dark mode
--color-noland-silver          #C8C9CD   # metallic NOLAND'S wordmark base
--color-noland-silver-light    #E8E9ED
--color-noland-silver-dark     #6E7178
--color-noland-medal           #C5A87B   # "#1 Choice" seal accent
--color-noland-storm           #1A1F2B   # storm-sky photo overlays
--color-noland-lightning       #B8E0FF   # lightning blue-white accent
```

Don't introduce other colors without a real design reason — the
brand reads as "severe weather specialists" through restraint.

## Services Noland's offers (locked May 2026 per onboarding form)

| Material | Notes |
|---|---|
| Asphalt architectural shingles | Standard residential default |
| Tile (clay / concrete) | FL premium roof type |
| Metal | Standing seam + corrugated |
| Flat (TPO / EPDM / mod-bit) | Commercial + low-slope residential |
| **Solar** | New service line (May 2026). "Noland's Roofing Solar" sub-brand. |

Confirmed scope (from the May 2026 onboarding form Destiny returned):
residential roofing, commercial, new construction, hail & storm
repair, roof cleaning, windows, gutters, drywall, siding, soffit &
fascia, solar roofing. Pole barns were explicitly crossed off.

## Service area (15 counties confirmed)

Lake · Volusia · Manatee · Lee · Orange · Seminole · Osceola ·
Sarasota · Hillsborough · Marion · Brevard · Pasco · Hernando ·
Citrus · Sumter

Four offices: Clermont (HQ) · Orange City · Bradenton · Fort Myers.

## Certifications (locked)

- CertainTeed Shingle Master Premier
- CertainTeed Triple Crown Champion (top 1% of US roofers)
- BBB Accredited
- Top 150 Roofing Contractors (Beacon)
- Licensed General Contractor

## Office hours

Mon–Fri 8:00 AM – 5:00 PM (front office). Install crews 7:00 AM –
7:00 PM. Sarah handles inbound after-hours.

## Phone numbers (locked May 2026)

Three distinct numbers, each with a single purpose:

- **`(352) 242-4322`** — Noland's main office line. Where Savannah,
  Myia, and Amanda answer in business hours. This is the number on
  the "Prefer to talk?" escape hatch in the result-page RepCTACard,
  the share-page header CTA, and Sarah's hot-transfer destination
  (all four `ESCALATION_*_PHONE` LK secrets). Confirmed on the
  onboarding form Destiny returned.
- **`(888) 786-9134`** — **The Twilio-owned number that Sarah uses
  for ALL outbound calls + ALL SMS.** Moved here May 2026 (was
  briefly +13219851104). Set as `TWILIO_PHONE_NUMBER` in Vercel
  (SMS confirmation, post-call follow-ups, rep alerts) AND as both
  `SYDNEY_OUTBOUND_CALLER_ID` + `TRANSFER_CALLER_ID` on LK Cloud
  (Sarah's outbound caller-ID + transfer bridge caller-ID).
- **`+13219851104`** — LK Cloud-provisioned Cocoa Beach number that
  receives inbound calls into Sarah's worker via the
  `nolands-sydney` dispatch rule. Customer-facing 888 forwards here
  via Twilio TwiML so the homeowner experience is always 888.
  Don't publish 321 anywhere customer-facing.

The previously-listed `(352) 500-ROOF` number is **NOT** the real
main line — that was a marketing aspiration that either never went
live or got retired. Don't publish it.

**Hot-transfer priority order:** Savannah → Myia → Amanda. All
three answer the 352-242-4322 line. Sarah's `transfer_to_human`
tool routes to that number; the office's phone tree handles the
per-person priority.

**Sarah's inbound routing (locked May 2026):** Sarah does **NOT**
answer the 352 main line during business hours. Mon-Fri 8am-5pm
ET, 352 calls go straight to humans (Savannah, Myia, Amanda). Sarah
picks up the 352 line ONLY after 5pm, before 8am, and all day Sat
/ Sun / holidays. The 888 toll-free is Sarah-direct 24/7 (used by
a small subset of homeowners who saved it from marketing materials).
Time-of-day routing is enforced upstream — likely a Twilio Schedule
or Studio Flow on the 352 line that forks to Sarah only outside the
8am-5pm window. If that routing breaks (Sarah answering during
business hours), it's a configuration regression, not a code bug;
fix the Twilio routing, not the agent prompt. Sarah's prompt has
been told that business-hours inbound is "rare overflow" so she
doesn't act surprised either way.

**Compliance gate (task #40 still pending):** outbound calls from
`+18887869134` require Twilio Toll-Free Verification to be
"Approved" or carriers may tag Sarah's calls as Spam Likely on
Verizon / AT&T / T-Mobile. SHAKEN/STIR attestation rolls up from
the verification. Verify status in
`console.twilio.com → Trust Hub → Toll-Free Verification` before
high-volume outbound dialing.

## Agent identity (customer-facing)

- **Display name: Sarah.** Female voice, formal tone. Lives as
  `AGENT_DISPLAY_NAME` in `lib/agent-config.ts` and as the
  `AGENT_DISPLAY_NAME` env var in voxaris-pitch / LK Cloud secrets.
- **Codename: Sydney.** The LK agent worker module name. Internal
  identifier only — never shown to homeowners. Don't conflate the
  two.

## Architectural invariants (carried over from voxaris-pitch)

1. **Pro Image is decorative. Solar API + Flash JSON are truth.**
   Never couple pricing logic to the painted PNG.
2. **Soft-fail to null** on every external dependency. Customer flow
   degrades gracefully (no painted image / no parcel / no storms),
   never errors out.
3. **`CACHE_SCOPE_V3` bumps** on every V3 response shape change.
4. **`office_id` check** on every write touching a lead.
5. **Painted-overlay parity** — `lib/painted-url.ts` is the only URL
   minter. 5 surfaces, 1 helper.
6. **Pricing is calibrated, not generative.** `lib/pricing/` is
   deterministic math.

## Smoke-test address

`8450 Oak Park Ave, Orlando FL 32827` — canonical complex roof. Any
change to the V3 pipeline must work on Oak Park before shipping.

## Build / dev / test

```sh
npm install
npm run dev               # next dev, port 3000
npm run build             # next build
npm run lint              # next lint
npx tsc --noEmit          # standalone typecheck
npm test                  # vitest
```

## Deploy

Pushes to `main` auto-deploy via Vercel's GitHub integration to
`estimate.nolandsroofing.com`. Vercel project needs to be linked
once: `vercel link` from this repo, then add the custom domain.

## What's connected to the Voxaris dashboard

Every lead captured here writes to Supabase under
`office_id="nolands"`. The Voxaris dashboard (separate project, same
DB) is where Noland's reps view leads / call logs / appointments.
No separate dashboard in this repo.

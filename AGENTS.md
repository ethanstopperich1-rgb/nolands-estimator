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

Three offices: Clermont (HQ) · Orange City · Bradenton.
(Fort Myers was previously documented as the 4th office but does NOT
appear on Noland's printed estimate form or in their Podium location
list as of May 26, 2026. Treat as retired / never-went-live until
re-confirmed by Destiny.)

## Certifications (locked)

- CertainTeed Premier Roofing Contractor (only 2 in Central Florida hold this)
- CertainTeed Shingle Master Premier
- CertainTeed Triple Crown Champion (also held — top 1% of US roofers;
  secondary credential, NOT what reps anchor on. The customer-facing
  estimator emphasizes Premier because that is what Noland's
  printed estimate form leads with.)
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

## Self-correcting workflow (hooks live in .claude/hooks/)

This repo uses Anthropic Claude Code hooks to catch mistakes the
moment they happen, not after a 12-error typecheck failure 30 min
later. The hook scripts live in `.claude/hooks/` and are wired via
`.claude/settings.json`.

| Hook | Fires | What it does |
|---|---|---|
| `prewrite.sh` | `PreToolUse` on Write/Edit/MultiEdit | Hard-blocks writes to `.env*`, `*credentials*`, `*.pem`. Advisories on `app/api/gemini-roof/route.ts` (CACHE_SCOPE_V3 reminder) and `migrations/0*.sql` (use `supabase migration new`). |
| `postwrite.sh` | `PostToolUse` on Write/Edit/MultiEdit | Prettier-formats + ESLints (.tsx) + runs `npx tsc --noEmit` after every edit. Output truncated to top 25 lines. |
| `stop.sh` | `Stop` when Claude tries to end its turn | Skips if `stop_hook_active=true` (prevents loops). Skips if no git diff vs HEAD. Otherwise runs `tsc + npm test`. Exit 2 forces Claude to continue working until green. |

**Critical rule for the Stop hook:** the `stop_hook_active` JSON field
in the stdin payload is `true` when Claude is already on a re-loop
because a previous Stop hook fired. If we re-fail without this guard,
Claude loops infinitely and burns tokens. The guard is at the top of
`stop.sh`. Don't remove it.

To disable hooks locally, copy the file out: `cp .claude/settings.json
.claude/settings.local.json` and strip the `hooks` block. The
`.local.json` is gitignored and takes precedence.

## Learned from mistakes

Real mistakes that broke real things. New entries at the top. Format:
`<date> — <what was learned> <(impact)>`.

- **2026-05-27** — **TierCard price block: total goes ABOVE monthly,
  both visible simultaneously.** Original layout buried total as 11px
  muted footnote below 28px monthly anchor. Customers compare totals
  across roofers; hiding it = "they must be expensive." Hormozi rule:
  show smallest increment AND full anchor at the same time. Layout
  order top-down: eyebrow "Total cash price" → $XX,XXX (30px serif) →
  "─ or financed ─" divider → $YYY/mo (20px serif) → "15 yr · 11.99%
  APR". `PRICING_CONFIRMED` gate stays as kill-switch; prod env is
  set to true. Commit `c2c8252`.
- **2026-05-27** — **Vercel CLI silently no-ops when `vercel env add`
  runs interactive in non-interactive shell.** Pass `--value
  "<actual>"` explicitly. Adding 7 env vars looked successful but
  none persisted because the interactive prompt swallowed stdin.
- **2026-05-26** — **`voice_consent` is NOT a column on `leads`.**
  It lives in `consents` as a row of `consent_type='call_recording'`.
  Pulling it in a SELECT against `leads` crashes PostgREST with
  42703 (undefined_column) and the JN-push branch silently never ran
  for 101 production leads. Always check the schema before adding
  a column to a SELECT. The fix landed in commit `a1e36c5`.
- **2026-05-26** — **`/api/dispatch-outbound` requires E.164 phone
  (+1...).** Raw `(407) 819-5809` from the consent route returns
  400 invalid_phone. Always wrap with
  `toE164(lead.phone) ?? lead.phone` before posting. Fix in commit
  `ede9e28`.
- **2026-05-26** — **LK SIP outbound trunks need explicit
  caller-IDs, not wildcard `["*"]`.** When the trunk's `numbers` is
  `*`, Twilio reports `from=sip:+*@...` and rejects the call. Fix:
  `lk sip outbound update --id <ST_ID> --numbers "+18887869134"`.
- **2026-05-26** — **Podium OAuth tokens expire.** Refresh via
  `https://api.podium.com/oauth/token` (NOT `/v4/oauth/token`) with
  `grant_type=refresh_token`. Schema drifted in early 2026.
- **2026-05-26** — **Podium v4 message channel schema.** Use
  `type=phone` (NOT `"sms"`), `identifier=<phone>` (NOT
  `phoneNumber`). Drifted from earlier docs.
- **2026-05-22** — **`apply_migration` (Supabase MCP) writes a
  migration history entry on every call.** For iterative dev, use
  `execute_sql` to test shape, then `supabase db pull --local --yes
  <name>` to generate the migration file cleanly.
- **2026-05-22** — **Test phones must bypass BOTH dedup AND CAPTCHA/
  BotID.** Whitelisting in one gate but not the other = false
  negatives in live testing. Added `isTestPhone()` helper and shared
  it across `/api/leads` and `lib/leads/dedup.ts`.
- **2026-05-15** — **Step-1 captures (phone-only foot-in-the-door)
  do NOT push to JobNimbus.** Only the full V3 estimate flow
  through `/api/gemini-roof` triggers the JN createContact path.
  If `jobnimbus_contact_id` is missing on a lead, check whether
  V3 ever ran — likely it was only step-1.
- **2026-05-12** — **Tailwind v4 has no `tailwind.config.ts`.** Theme
  tokens live in `@theme inline {…}` inside `app/globals.css`. Don't
  paste old config patterns from Tailwind v3 projects.
- **2026-05-08** — **Next.js 16 canary App Router has different
  conventions than Next 15.** API routes, conventions, and file
  structure may differ from training data. Read the relevant guide
  in `node_modules/next/dist/docs/` before writing route code.

## Rules (Karpathy-style, applied to this repo)

These rules apply on EVERY edit. The hooks enforce some; the rest are
on you to honor. Sweet spot is ~12 rules; we're at 11.

- ALWAYS bump `CACHE_SCOPE_V3` when changing the V3 response shape
  in `app/api/gemini-roof/route.ts`. Stale CDN responses bite.
- ALWAYS wrap phones with `toE164()` before posting to
  `/api/dispatch-outbound`.
- ALWAYS smoke-test `8450 Oak Park Ave, Orlando FL 32827` before
  shipping any paint-pipeline / `lib/painted-url.ts` / V3 change.
- NEVER use the word "insurance" customer-facing. Use "provider"
  or "carrier" instead (FL § 627.7152).
- NEVER mention Tavus, Retell, VAPI, or any third-party AI vendor
  externally. Customer-facing voice is always "Sarah".
- NEVER refactor / rename / clean unrelated code in the same diff.
  Minimum-viable change discipline. If you see drift, file a task.
- NEVER use TypeScript `enum` — prefer literal unions
  (`type X = "a" | "b"`).
- NEVER force push to `main` (denied in `.claude/settings.json`).
- DB queries through `services/` or `app/api/` route handlers
  only; never in components.
- Prefix commits: `feat:` / `fix:` / `docs:` / `refactor:` /
  `test:` / `chore:` / `ops:` / `seo:` / `security:`.
- Run `npx tsc --noEmit` after every change. The PostToolUse hook
  does this automatically.

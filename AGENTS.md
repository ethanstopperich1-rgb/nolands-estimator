<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This repo runs Next.js **16 canary**. APIs, conventions, and file
structure may differ from your training data. Read the relevant guide
in `node_modules/next/dist/docs/` before writing any code. Heed
deprecation notices.

Tailwind is **v4**. There is no `tailwind.config.ts`. Theme tokens
live in `@theme inline {…}` blocks inside `app/globals.css`.
<!-- END:nextjs-agent-rules -->

## What this product is

`pitch.voxaris.io` is the Voxaris public demo + sales tool. It runs
the same Next.js app that ships to paying customers as a white-label
deployment under their own brand.

- **`/`** — customer-facing roof estimator (BotID-guarded). Address
  → pin → `/api/gemini-roof` → painted result with Good/Better/Best
  tier prices. On `pitch.voxaris.io` this is Voxaris's public demo;
  on a paying customer's deployment it runs under their brand at
  `estimate.<contractor>.com` or similar.
- **`/dashboard/*`** — rep workbench (HTTP Basic + Supabase Auth
  gated). Multi-tenant by `office_id`. Lead inbox, full estimate
  workbench, calls log, canvass map. This is what the paying
  contractor logs into.

The truth path for every measurement is the **V3 pipeline** at
`app/api/gemini-roof/route.ts`. Everything else (rep workbench, lead
drawer, lead report page) reads from the same JSON shape persisted to
`leads.roof_v3_json` after the customer's session.

## Business model (locked May 2026 — outcome-led)

### The one-sentence positioning

**Voxaris turns any roofing website into a 24/7 appointment machine,
white-labeled as the contractor's brand.**

That's the job. Every component — estimator, Sydney voice AI, SMS
follow-up, AEO website, JobNimbus push — is in service of that one
outcome: **booked appointments, 24/7, on their brand.**

NOT positioned as: a lead-gen company, an EagleView competitor,
"unlimited roof reports", or a "one-stop shop." Those framings all
anchor on features instead of the outcome the roofer is actually
buying.

### What this product actually does end-to-end (Noland's deployment)

A complete top-of-funnel revenue machine. The estimator is the entry
point of an automated pipeline that takes a stranger on a website to
a booked appointment without a human touching it:

1. Homeowner lands on the contractor's white-labeled subdomain
2. Types their address → painted EagleView-quality report in <30s
3. Sydney (AI voice receptionist) calls within ~10s if they consent
4. SMS follow-up sequence on every lead, opted-in or not
5. Rep notified instantly (SMS to their cell + dashboard alert)
6. Appointment books into JobNimbus (or whatever CRM the office uses)
7. Rep wakes up to booked jobs, not missed after-hours calls

### Buyer psychology (this drives every pitch + landing-page word)

The buyer is a roofing contractor / franchise owner. The Job To Be
Done is **booked appointments with pre-measured homeowners**. Not
estimates. Not voice AI. Not websites. The appointment is the only
thing they actually pay for everything else to produce.

| Psychological obstacle | How "24/7 appointment machine" answers it |
|---|---|
| Status-quo bias | Their current stack goes dark at 5pm. Ours doesn't. |
| Loss aversion | Every unanswered after-hours call is a job that went to the competitor who picked up. |
| "We already have EagleView" | EagleView sends a PDF. We send a pre-measured homeowner to your CRM. |
| "We have a website" | A website that doesn't capture + follow up leads is a brochure. |
| Bundle price feels high | What's a booked appointment worth in FL? $8k–$40k. Math runs itself. |
| Trust gap (new vendor) | White-label means homeowners see your brand, not ours. You own the relationship. |
| "We use an answering service" | An answering service takes a message. Sydney books the appointment. |

**White-label is a psychological lock-in mechanism, not just a feature.**
Once the contractor's brand is on the subdomain, their ads point to
it, their yard signs have the QR code — switching costs become
enormous (IKEA effect + endowment effect). They've built their lead
machine on top of us. That's the moat.

### The competitive frame — we don't compete with EagleView

We compete with **the contractor's current cobbled-together stack** —
and we win by making that stack feel like the liability it is:

- vs. **EagleView**: "EagleView sends a PDF to your rep's inbox. We
  send a pre-measured homeowner to your CRM."
- vs. **website agency**: "Your agency built you a brochure. We built
  you a lead machine."
- vs. **answering service**: "An answering service takes a message.
  Sydney books the appointment."
- vs. **Angi / HomeAdvisor**: "Angi sells your lead to 4 other
  roofers. Ours routes to you exclusively, pre-measured, with the
  homeowner already on the phone."

### Hierarchy of messages (use this order in every channel)

For every pitch deck, X post, cold DM, landing page:

1. **The outcome** (always first): Booked appointments. 24/7.
   White-labeled as your brand.
2. **The mechanism** (credibility): Homeowner types address → roof
   report in <30s → Sydney calls within ~10s → appointment in your
   CRM.
3. **The contrast** (anchoring): You're paying EagleView per report,
   an agency for a site that doesn't capture leads, an answering
   service that misses after-hours. We replace all three.
4. **The proof point**: Newcomb accuracy data now. Noland's case
   study once deployed.
5. **The ask** (always specific): "Try your own address at
   pitch.voxaris.io. Takes 30 seconds."

### The cold-pitch script (canonical)

> "We turn your website into a 24/7 appointment machine —
> white-labeled as your brand. Homeowner types their address, gets
> an EagleView-quality roof report in 30 seconds, Sydney calls them
> within 10 seconds, appointment books into your CRM. You wake up to
> booked jobs, not missed calls.
>
> Florida contractors are running this at ~$1,800/mo for the
> estimator alone, ~$4,800/mo for the full stack.
>
> Demo takes 30 seconds: try your address at pitch.voxaris.io."

The "wake up to booked jobs, not missed calls" line is the
loss-aversion frame. Every roofer has experienced waking up to a
missed call that became a competitor's job. That sentence lives in
their memory.

### Pricing + sales order (commitment-and-consistency sequence)

Three SKUs per the May 2026 pricing card (Noland's Roofing proposal
for reference numbers):

- **Estimator** (the wedge): $1,500 setup + $1,795/mo · unlimited
  white-labeled reports, the lead-capture surface
- **Voice AI receptionist** (Sydney): $1,200 setup + $1,495/mo ·
  24/7 inbound + ~10-sec voice handoff on every captured lead
- **Website + AEO Framework v3.2**: $1,495 setup + $1,495/mo ·
  schema + llms.txt + 4 blog posts/mo + AEO score tracking

Bundle: ~$4,800/mo + ~$4,200 setup. ~$57k ARR per contractor.

**The sequence matters.** Do NOT pitch the bundle in cold outreach
— the foot-in-the-door psychology works against you. Sell the
estimator first ("try your address, 30 seconds"). Once they're a
customer:
- Upsell #1 (voice AI): "leads are flowing — want Sydney to call
  them within 10 seconds so you stop losing the after-hours ones?"
- Upsell #2 (AEO website): "your competitors are getting answered
  in ChatGPT/Perplexity searches. Here's how to get there too."

Each yes makes the next yes easier. Collapsing this into one
bundle pitch upfront flips the psychology against you.

**What `pitch.voxaris.io` actually is**: the public demo Voxaris uses
to close contractors. NOT the customer product. Real customer
deployments run under the contractor's own brand. Homeowners in
production deployments never see the Voxaris brand directly.

### The long-term arc (don't skip phases)

- **Phase 1 (now → 12mo)** — vertical SaaS to contractors. Get 5-20
  paying Florida offices. Each deployment is data ingestion.
- **Phase 2 (12-18mo)** — aggregate-insights surface on
  `pitch.voxaris.io`. Cross-deployment data powers homeowner-facing
  comparisons.
- **Phase 3 (24-36mo)** — transparent marketplace. Homeowner accounts,
  contractor bidding, real close-rate data. The transparent
  alternative to Angi/HomeAdvisor, only possible because phases 1+2
  built the ground-truth foundation Angi can't reproduce.

Don't skip phases. Don't run B2C homeowner marketing campaigns until
the aggregate dataset has depth (signal: when cross-office price
norms are stable and statistically meaningful at the zip-code level).

### Architectural disciplines that protect phase 3

- **Leads outlive offices.** `leads.assigned_to` and `leads.office_id`
  are nullable + replaceable on office churn. Never hard-cascade-
  delete homeowner data when an office cancels. The homeowner data
  layer is co-owned today and becomes portable in phase 3.
- **Pricing math stays calibrated, not generative.** Tier rates,
  material multipliers, waste %, penetration adders all live in
  `lib/pricing/calculate-waste.ts` as deterministic math. Pricing is
  NOT generated by AI — only measurement is. This is the line that
  keeps the product honest with homeowners and legally defensible.
- **The estimator is the wedge, the bundle is the upsell.** Don't
  pitch the bundle in cold outreach. Estimator → demo → close → then
  upsell voice AI and website+AEO.

## AI-agent discoverability (WebMCP roadmap)

Two-track strategy for being a callable tool by AI agents
(ChatGPT, Claude, Perplexity, Gemini-in-Chrome), not just a page
they screen-scrape:

### Today — published, no in-page API

- **`/.well-known/tools.json`** (`app/.well-known/tools.json/route.ts`)
  publishes a per-tenant manifest of the tools we'd expose. Tenant-
  aware: same code serves `pitch.voxaris.io/.well-known/tools.json`
  and `noland-roofing.com/.well-known/tools.json` with the right
  contractor brand + phone resolved from the host header.
- Agents that scrape `/.well-known/*` (Perplexity, file-search agents,
  the upcoming WebMCP discovery flow) find us by convention.
- Today the manifest lists `get_roof_estimate`, `get_shared_report`,
  `book_inspection`, `get_office_contact`. All marked `surface:
  "planned"` (or `"http"` where a REST endpoint already works).

### Later — WebMCP in-page registration

- **Chrome WebMCP** (`navigator.modelContext`) goes to origin trial
  in Chrome 149. Spec at https://developer.chrome.com/docs/ai/webmcp.
- When that lands, the customer-facing surfaces register the same
  tools the manifest already lists, using the imperative WebMCP API
  on the client. Same tool names — `get_roof_estimate(address)`,
  `book_inspection(publicId, timeWindow)` — so manifests and in-page
  registrations stay aligned.
- DO NOT ship the in-page registration prematurely. Until Chrome
  WebMCP is stable + has real browser share, the manifest alone is
  the right surface. The user (Ethan) explicitly scoped this to
  Phase 2 (12-18 mo). See `POSITIONING.md` for the phase arc.

### Where it does NOT belong

- `/dashboard/*` — rep workbench. No AI agent invokes this. Don't
  register WebMCP tools here.
- `/r/[publicId]` — homeowner share URL. Read-only artifact. The
  Open Graph meta tags + the URL itself ARE the agent-readable
  surface for a static report. No WebMCP tools needed.
- Auth-gated APIs — WebMCP defaults to same-origin and user-approved
  calls; gating with `INTERNAL_DISPATCH_SECRET` or BotID still
  applies to the HTTP endpoint, but the tool surface is public.

### The pitch this enables (AEO + Website upsell)

When the WebMCP era lands: "Your competitors show up as text in
ChatGPT. Voxaris-powered sites show up as a tool ChatGPT can
actually use." This is part of the Website + AEO SKU value prop —
the manifest publishes today so we can show contractors a real
artifact, not a future promise.

## Architectural principles (don't violate these)

### 1. Pro Image is decorative. Solar + Flash JSON are truth.

The cyan-painted image is for customer trust only. The headline sqft
comes from **Solar API**. Object detections (vents, chimneys, HVAC)
come from **Gemini 2.5 Flash structured output on the raw satellite
tile**. Lines and facet counts come from **Flash**. Pricing math reads
from those structured sources.

**Never couple pricing or measurement logic to the painted PNG.** If
you find yourself reading from the cyan mask in a pricing path, gate
it behind a trust signal (see `pricingMask` in the route — it's
nulled out when the paint is unreliable so a bad render can't
silently distort a quote).

Roof report (in-platform only): reps view the full report inside the
platform — drawer (`LeadDrawer` on `/dashboard/leads`) for a quick
overview, full workbench (`/dashboard/estimate?leadId=…`) for editing.
PDF export was removed in 2026-05. If you need it back, the prior
implementation lived at `app/api/leads/[publicId]/report/route.ts` +
`app/internal/report/[publicId]/page.tsx` + `lib/pdf-report.ts` (check
`git log -- lib/pdf-report.ts`).

### 2. Soft-fail to null for every external dependency.

Every external call — Solar API, Gemini Pro Image, Gemini Flash,
Static Maps, IEM storms, FDOR cadastral, FGIO parcels, Supabase, the
Iowa State Mesonet — must return null (or a typed equivalent) on
ANY failure path: timeout, 5xx, malformed JSON, sharp decode error.
**The V3 response should always be a valid JSON shape**; missing data
shows up as null in specific fields rather than a 500. The customer
flow degrades gracefully (no painted image, no parcel facts, no storm
history) but never errors out.

Look at `lib/parcel-lookup.ts` for the canonical pattern (timeout,
try/catch around the fetch, null on any failure path).

### 3. `CACHE_SCOPE_V3` bumps on every shape change.

`app/api/gemini-roof/route.ts` caches V3 responses for 30 days keyed
by `CACHE_SCOPE_V3 + lat + lng`. Whenever you change the response
shape, the pipeline behavior, or any computation that affects what's
returned, **bump the scope string** (search for `const CACHE_SCOPE_V3`).
Recent values: `v3-per-face-facets` → `v3-parcel` → `v3-composite` →
`v3-cyan-centric-verify` → `v3-dual-publisher`. Pick a slug that
reflects the change.

Forgetting this means real customers see stale cached results from
the broken pipeline. It is the #1 post-deploy footgun in this repo.

### 4. office_id check on every write that touches a lead.

Multi-tenancy is enforced at the row level. Customer-facing lead
sub-routes (only `voice-consent` today, listed in
`lib/protected-routes.ts:PUBLIC_LEAD_SUBROUTES`) bypass the staff gate;
every other sub-route at `/api/leads/[publicId]/*` is staff-gated by
middleware AND must additionally compare the JWT's `office_id`
(`getDashboardOfficeId()`) to the lead row's `office_id`. See
`app/api/leads/[publicId]/roof-v3/route.ts` for the canonical pattern.

### 5. The painted-image pipeline is layered. Don't fight Pro Image.

Pro Image (`gemini-3-pro-image-preview`) is a generative text-to-image
model. It conditions on the input tile but renders a NEW image. On
simple roofs the render is faithful; on complex ones it diverges. The
defense is in this order:

1. **Prompt** — `lib/gemini-roof-prompt.ts:GEMINI_ROOF_SYSTEM_INSTRUCTION`
   keeps the model in edit mode (translucent cyan over real shingles,
   no full re-render).
2. **Don't push facet counts** — the segmentation hint was removed
   because it forced the model into generative-fill mode on complex
   roofs. If you re-introduce it, cap at 6 and gate on
   `Solar.roofSegmentStats.length ∈ [2,6]`.
3. **Cyan mask extraction** — `lib/cyan-mask.ts` pulls just the cyan
   polygon. The rest of Pro Image's render is discarded.
4. **Composite or fallback** — `lib/composite-cyan-overlay.ts` blends
   the mask onto the real Google aerial. Hard ceiling at 35% mask
   fill (above that, mask is flood-painted junk → raw aerial alone,
   no cyan). Customer NEVER sees Pro Image's raw PNG.
5. **GroundOverlay** — `components/RoofMap.tsx` renders the cyan
   polygon as a transparent PNG over an interactive Google Map. The
   customer can pan/zoom to verify it's their house. Falls back to
   the static composite PNG when the Maps JS API fails to load.

Note: paint-verify + dual publisher were removed in commit `c2360e8`
to shave 30-50s off the wall clock (was pushing through the 90s
function ceiling on complex roofs). The composite gate at 35% fill
is the single safety net now — keep it.

If you change ANY of these layers, smoke-test the full visual
pipeline against a complex property (8450 Oak Park, Orlando is the
canonical hard case) BEFORE shipping. Pro Image regressions look
fine on Newcomb / Jupiter and broken on Oak Park.

## Build / dev / test

```sh
npm run dev              # next dev, port 3000
npm run build            # next build
npm run start            # next start
npm run lint             # next lint
npx tsc --noEmit         # standalone typecheck — use this constantly
npm test                 # vitest, runs tests/*.test.ts
```

Local + prod env vars: `vercel env pull .env.local`. Never commit
secrets — `.gitignore` excludes them but be careful with debug files.

## Deploy

Pushes to `main` auto-deploy to `pitch.voxaris.io` via Vercel's
GitHub integration. CI runs lint + build + typecheck before merge but
does NOT block deploys. Be disciplined about `npx tsc --noEmit`
before every push.

Force a fresh deploy: `vercel deploy --prod --force` (cache busts the
CDN — used when a deploy ships but the alias still serves an older
build).

## Telephony (LiveKit + Twilio)

Sydney (the AI voice receptionist) runs on **LiveKit Cloud + Twilio
Elastic SIP Trunking**. The toll-free number `+1 888 786 9134` is the
production number as of May 19, 2026.

Outbound dispatch lives in `app/api/dispatch-outbound/route.ts`. The
route uses `livekit-server-sdk`'s `SipClient.createSipParticipant` to
place outbound calls and `AgentDispatchClient` to ensure Sydney's
agent runs in the room.

### Required env vars (production)

| Var | Source | Notes |
|---|---|---|
| `LIVEKIT_URL` | LiveKit Cloud project settings | `wss://<project>.livekit.cloud` |
| `LIVEKIT_API_KEY` | LiveKit Cloud project settings | Server-only; never expose to client |
| `LIVEKIT_API_SECRET` | LiveKit Cloud project settings | Server-only; never paste in chat |
| `SIP_OUTBOUND_TRUNK_ID` | `lk sip outbound create` output | The LiveKit-side outbound trunk ID |
| `INTERNAL_DISPATCH_SECRET` | Generated once, shared between `/api/leads` and `/api/dispatch-outbound` | HMAC-style same-origin gate |
| `LEAD_NOTIFY_PHONE` | E.164, optional | Global fallback for the rep-side new-lead SMS in `lib/lead-notifications.ts`. Used pre-launch + for Voxaris-internal testing before an office row has its `inbound_number` populated. Resolution chain: `office.inbound_number` → `LEAD_NOTIFY_PHONE`. |

Optional toggles:

| Var | Effect |
|---|---|
| `SIP_PLACED_BY_AGENT=true` | Sydney's agent places the SIP call itself (vs the route placing it directly) |
| `SIP_WAIT_UNTIL_ANSWERED=true` | `createSipParticipant` blocks until the customer picks up |

### Compliance gates (don't dispatch without these)

1. **TCPA voice consent** — captured via
   `/api/leads/[publicId]/voice-consent`. Strict `voiceConsent ===
   true`; omission does NOT count. Disclosure text from
   `lib/tcpa-consent.ts:buildVoiceConsentDisclosureText` must contain
   the literal phrase "AI voice assistant" (FCC Feb 2024 ruling).
   `tests/tcpa-consent.test.ts` locks this — if those tests ever fail,
   stop dispatch immediately.
2. **Twilio Toll-Free Verification** — status must be
   `Twilio Approved` in `Trust Hub → Toll-Free Verification`.
3. **Twilio Voice Trust** — number registered under `Voice Trust`
   with SHAKEN/STIR attestation. Without it, outbound calls get
   marked `Spam Likely` on Verizon / AT&T / T-Mobile networks.

### Provider-agnostic customer messaging

Not every contractor wants Voxaris to be their two-way SMS sender —
many already run **Podium**, **HighLevel**, **Birdeye**, **BoomTown**,
**JobNimbus**, or a custom Zapier funnel for homeowner messaging.
The lead-capture flow is built so the data is **portable**: the same
`new_lead` / `appt_scheduled` / `call_completed` event payload can be
consumed by any of these platforms, without locking the office into
our Twilio sender.

How it works:

- `lib/lead-webhook.ts:publishLeadEvent` fires a versioned JSON event
  to the receiver URL configured for the office. Default destination
  is `LEAD_WEBHOOK_URL` env (global fallback); future migration will
  add `offices.lead_webhook_url` per-office.
- Payload is HMAC-SHA256 signed with `LEAD_WEBHOOK_SECRET` (or the
  per-office secret column when that lands). Header:
  `X-Voxaris-Signature: <base64>`. Receivers verify against the raw
  body using `verifyLeadWebhookSignature`.
- Schema is versioned via `LEAD_WEBHOOK_SCHEMA_VERSION`. Bump on any
  required-field change; add nullable fields freely.
- Events today: `new_lead` (on final estimate submit),
  `appt_scheduled` (post-call webhook), `call_completed` (any other
  post-call outcome).

**Kill-switch for Voxaris-side Twilio**: set
`CUSTOMER_SMS_DISABLED=true` (env, or future `offices.customer_sms_disabled`
column) to suppress the Voxaris-sent confirmation SMS to the
homeowner. The contractor's Podium / HighLevel / etc. platform then
owns that surface, driven by the same lead webhook event. Rep alerts
and the SMS-first YES flow are independent and stay on Twilio for
testing.

**Payload shape** (locked at v1.0.0):

```jsonc
{
  "schema_version": "1.0.0",
  "event": "new_lead",                    // or "appt_scheduled" | "call_completed"
  "occurred_at": "2026-05-19T18:42:00.000Z",
  "office": { "id": "uuid", "slug": "nolands", "display_name": "Noland's Roofing" },
  "lead": {
    "public_id": "lead_<32-hex>",
    "name": "Jane Homeowner",
    "email": "jane@example.com",
    "phone_raw": "(407) 555-1234",
    "phone_e164": "+14075551234",
    "address": "8450 Oak Park Ave, Orlando FL 32827",
    "estimate_low": 28000,
    "estimate_high": 52000,
    "material": "asphalt-architectural",
    "estimated_sqft": 4357,
    "source": "pitch.voxaris.io",
    "report_url": "https://pitch.voxaris.io/dashboard/leads/lead_<...>"
  },
  "extras": {                              // present on appt_scheduled / call_completed
    "outcome": "appt_scheduled",
    "appointment_at": "2026-05-22T14:00:00-04:00",
    "summary": "Booked walkthrough Tue 2pm"
  }
}
```

**Wiring Podium specifically**:
1. In Podium, create a webhook automation that accepts an inbound
   POST.
2. Set `LEAD_WEBHOOK_URL` (or per-office column) to Podium's webhook
   URL.
3. Set `LEAD_WEBHOOK_SECRET` to a shared secret; configure Podium to
   verify `X-Voxaris-Signature` (HMAC-SHA256, base64) against the
   raw body.
4. Map Podium's contact-create + message-send to fields in our
   `lead` payload.
5. Set `CUSTOMER_SMS_DISABLED=true` so Voxaris doesn't also send a
   confirmation SMS — Podium handles the customer-facing thread end
   to end.

The same recipe works for HighLevel (Inbound Webhook trigger),
Birdeye, BoomTown, JobNimbus, or a generic Zapier "Catch Hook" step.

### Phone-number tenancy

There are TWO distinct classes of phone number in the system, and
they must NEVER be confused:

1. **`+1 888 786 9134` — the Voxaris toll-free.** Reserved for
   Voxaris-to-CONTRACTOR communication: sales demos, pre-launch
   internal testing, the public `pitch.voxaris.io` demo. Homeowners
   never see this number in a production deployment. It's the
   `TWILIO_PHONE_NUMBER` env var (the global default `from` on
   `sendSms` when no per-office number is passed).

2. **Each contractor's own Twilio number.** Stored on
   `offices.twilio_number`. This is what homeowners see on the
   confirmation SMS, the YES ack, the post-call homeowner SMS, and
   the rep "new appt scheduled" alert. Routing on the inbound webhook
   uses the `To` field (the contractor's number that received the
   message) to look up the office via
   `lib/supabase.ts:resolveOfficeByTwilioNumber`, scope the lead
   lookup to that office's leads, and set the `from` on every reply.

**Send path rule**: every `sendSms` call from a tenant-scoped path
must pass `from: office.twilioNumber` — never default to the global
env var when an office is known. The current threading:

- `/api/leads` confirmation SMS → `from: officeBranding.twilioNumber`
- `/api/sms/inbound` reply (both YES handler + AI bot) →
  `from: replyFrom` where `replyFrom = inboundOffice.twilioNumber`
- `/api/sms/post-call` homeowner + rep messages →
  `from: office.twilioNumber`
- `lib/lead-notifications.ts:notifyOfficeOfNewLead` rep alert →
  `from: opts.office?.twilioNumber`

The Voxaris toll-free fallback only kicks in when an office row
hasn't been provisioned a Twilio number yet — useful for
Voxaris-internal smoke tests, but every paying contractor should
have their own number configured before going live.

### SMS-first lead flow (testing pre-Voice-Trust)

For pre-launch testing — before SHAKEN/STIR attestation is approved
and outbound voice can ship safely — Voxaris uses an SMS-gated voice
flow so the homeowner explicitly opts in via text before Sydney
calls. The full round-trip:

1. **Homeowner submits the estimator** → `/api/leads` captures the
   lead and sends the confirmation SMS via `lib/twilio.ts`. The body
   includes `"Reply YES and Sydney (our AI assistant) will call you
   now..."`.
2. **Homeowner replies YES** → `/api/sms/inbound` intercepts the YES
   keyword BEFORE the AI-reply pipeline. It:
   - Looks up the most-recent lead by phone (fuzzy match on last 10
     digits, since `leads.phone` stores raw user input not E.164).
   - Logs a `consents` row of type `voice_sms_yes` for TCPA audit.
   - Sets `leads.status = "calling"`.
   - POSTs `/api/dispatch-outbound` (server-to-server,
     `INTERNAL_DISPATCH_SECRET` gate) with the lead context.
   - Replies via SMS: "Got it — Sydney will call you in a few
     seconds from {office}."
3. **Sydney runs the call** in LiveKit. When the conversation ends,
   the agent worker POSTs `/api/sms/post-call` with
   `{ leadPublicId, outcome, summary?, appointmentAt? }`. Valid
   outcomes: `appt_scheduled`, `callback_requested`, `no_appointment`,
   `voicemail`, `failed`.
4. **`/api/sms/post-call`** closes the loop:
   - Updates `leads.status` to the outcome and appends a note line.
   - Sends a homeowner confirmation SMS (copy varies by outcome).
   - Sends a rep/office SMS via the same destination chain as
     `notifyOfficeOfNewLead`: "📅 New appt scheduled — {name},
     {address}, {deep link}".

This entire path is gated by `INTERNAL_DISPATCH_SECRET` on the
server-to-server hops and by Twilio webhook signature validation on
the inbound leg. The homeowner SMS opt-out (STOP) is enforced by
`lib/twilio.ts:sendSms` on every outbound, including the rep
notifications.

For the LiveKit agent: the Sydney worker should call
`POST {origin}/api/sms/post-call` in its `on_disconnected` /
`on_conversation_complete` handler with the lead public_id from
`ctx.job.metadata.leadId`. The `x-dispatch-secret` header value comes
from the worker's `INTERNAL_DISPATCH_SECRET` env var (same value as
the Vercel project).

### Smoke test (after wiring + env vars)

`curl -X POST $VERCEL_PROD_URL/api/_health` should return
`{ ok: true, services: { livekit: "ok", twilio_creds: "ok", ... } }`
without exposing any actual secret values.

## Working with this repo as Claude Code

- **Skim subdirectory AGENTS.md files before touching anything.** The
  root file is the big picture; local files document the conventions
  that bite if you don't read them. Today's directories with their
  own AGENTS.md: `app/api/gemini-roof/`, `app/api/leads/`,
  `app/dashboard/`, `components/dashboard/`, `lib/`, `lib/pricing/`,
  `scripts/eval-eagleview/`.
- **Use the `Explore` subagent for read-only mapping.** Don't fill
  the main session's context with grep output and file dumps. Map
  first, then come back and edit.
- **Run typecheck before every commit.** It's the only static gate
  the repo has; if you skip it the deploy will silently take you down.
- **Always `git pull --rebase` before push.** This branch is shared
  between humans + agents; you will hit non-fast-forward push errors
  if you don't. The auto-rebase recipe: stage → commit → `git pull
  --rebase origin main` → `git push origin main`.
- **Bump `CACHE_SCOPE_V3` whenever you change the V3 response.** Yes,
  every time.
- **Smoke-test the visual on 8450 Oak Park, Orlando before shipping**
  any change that touches the paint pipeline, `lib/cyan-mask.ts`,
  `lib/paint-verify.ts`, `lib/composite-cyan-overlay.ts`, or
  `components/RoofMap.tsx`. This is the canonical "complex roof that
  exposes Pro Image regressions" property.

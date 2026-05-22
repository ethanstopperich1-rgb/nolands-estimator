# Funnel Analysis: Noland's Roofing Estimator

**URL:** https://estimate.nolandsroofing.com
**Date:** 2026-05-21
**Business Type:** White-label customer-facing roof estimator → AI voice booking
**Funnel Type:** Lead-gen with instant-value reveal + AI voice qualification handoff
**Overall Funnel Health: 78/100** (up from ~62 pre-CRO pass `275ac49`+`88ec2c6`)

---

## Executive Summary

Noland's estimator is a 5-step funnel that captures a homeowner address, returns a painted-roof report with Good/Better/Best pricing in ~30s, then offers an AI voice callback (Sydney) for live booking. The recent CRO sprint shipped HI-1 (two-step form), HI-2 (side-by-side tiers), HI-4 (sticky mobile CTA), six quick wins (urgency, social proof, phone CTA, etc.), and full Podium reminder infrastructure.

**Current bottleneck cluster:** the in-flight moments between commit points — pin confirmation, the 30-second loading wait, and the booked-success state. The hero is sharp, the result page now has the levers in place, but three step transitions still feel like silent dead-air where homeowner anxiety can compound.

**Top 3 opportunities (revenue-weighted):**
1. **Share button on `/r/[publicId]`** — the page's entire reason for existing is shareability with a spouse/contractor/family member, and there's no share button. Native `navigator.share` on mobile + copy-link on desktop. *Expected lift: +8-12% of shares→return-visits, ~3-5% net new booked leads.*
2. **Loading state goes stale at 19s while the pipeline runs ~30s.** Last 11 seconds the customer sees the same "Detecting vents and penetrations…" — anxiety window. *Expected lift: -10-15% abandon rate during loading.*
3. **Booked-success state is one sentence** — no calendar add, no "what to expect in the next 10 minutes," no Sydney humanization. *Expected lift: -20-30% re-cancellation rate, +5% Sydney call answer rate.*

---

## Funnel Map

```
TRAFFIC SOURCES (door-hangers, organic, paid, referral)
   |
   v
[ Hero + Step 1 form (address only) ] ─────── 100% landed
   |  (sticky bar fires at >80vh on mobile)
   |  ✓ Two-step form (HI-1) - 220ms slide
   |  ✓ Trust strip w/ CertainTeed + 25yr
   |  ✓ "30-second" promise eyebrow
   v
[ Step 2 form (name/email/phone + consent) ]  ~70-80%* reach
   |  ✓ marketing consent required
   |  ✓ BotID + reCAPTCHA only on final submit
   v
[ Pin confirmation step ] ────────────────────  ~85% advance
   |  ⚠ NO progress indicator ("Step 2 of 3")
   |  ⚠ NO urgency / social proof
   |  ⚠ Mobile: pin-drag UX is small target
   v
[ Loading state (~30s wait) ] ────────────────  ~90% wait it out
   |  ⚠ Messages run out at 19s, last 11s feels stuck
   |  ⚠ No progress bar — just elapsed time + rotating fact
   |  ⚠ No "what we're doing right now" build-up
   v
[ Result page (sqft + tiers + map + storms + CTA) ] ~95% see it
   |  ✓ Tier cards side-by-side (HI-2) w/ "Most chosen"
   |  ✓ Real social proof line (count >= 5)
   |  ✓ Storm-season urgency
   |  ✓ Phone escape hatch
   |  ✓ Sticky mobile CTA (HI-4)
   |  ✓ Voice-consent disabled hint
   v
[ Voice consent + Lock in ] ───────────────────  ?% book (TBD)
   |  ✓ TCPA compliant; AI disclosure first sentence
   |  ⚠ "AI voice assistant" not yet humanized as Sydney
   v
[ Booked success state ("You're on the list") ] ~98% who hit it
   |  ⚠ Single sentence; no calendar add; no "what next"
   |  ⚠ No invite to add Sydney's number to contacts
   v
[ Sydney calls within ~10s ]
   |  (FCC + STIR/SHAKEN compliant; recording enabled)
   v
[ JobNimbus job created OR callback scheduled ]
   |
   v
[ Podium reminder sequence A1-A5 (post-book) ]   ← cron, every 15min
   |  + Sequence B2-B5 if never booked (hourly cron)
   v
[ Appointment ✓ or homeowner re-engaged ]

* % estimates pending real GA4 funnel data — install GA4 events
  per step before relying on these for math.
```

---

## Page-by-Page Analysis

### Step 1: Hero + Address (form step 1)
**File:** `app/page.tsx` HeroScreen ~lines 574-1130

| Dim | Score | Notes |
|---|---|---|
| Clarity | 9 | H1 promise + "in 30 seconds" is unambiguous |
| Continuity | n/a | Entry point |
| Motivation | 8 | Pratfall trust strip + 25+ years anchors |
| Friction | 9 | Single input (address). Foot-in-the-door working. |
| Trust | 8 | CertainTeed + Licensed visible above fold |

**Score: 8.5/10** — solid, shipped recently. Skip-list this step for now.

**Last remaining gap:** The reCAPTCHA brand-attribution legalese is visible inside the marketing-consent block on Step 2. Could be moved below the submit button without violating Google's display rule (the rule is "visible somewhere on the page," not "inside the form"). Reduces perceived form length.

---

### Step 2: Pin Confirmation
**File:** `app/page.tsx` PinScreen ~lines 1130-1276

| Dim | Score | Notes |
|---|---|---|
| Clarity | 9 | "Is this the right roof?" + drag instruction is clear |
| Continuity | 7 | "Step 02 · Confirm your roof" — but no Step 03 implied |
| Motivation | 5 | No urgency, no social proof, no payoff preview |
| Friction | 6 | Drag interaction can be finicky on mobile; no double-tap-to-pin |
| Trust | 7 | Address echo confirms we have the right place |

**Score: 6.8/10**

**Gaps:**
- No progress indicator ("Step 2 of 3 · Confirm")
- No "next: instant estimate" payoff anchor
- Mobile pin-drag has no touch-feedback ripple
- No "Use my location" assist option for mobile users
- No timer pressure (could be removed urgency, but a "30s away" hint here would compound the hero promise)

**Recommendations:**
- Add a small progress eyebrow: "Step 2 of 3 · Confirm your roof"
- Sub-line under the H2: *"Next stop: your real number — about 30 seconds after confirm."*
- Add a "Tap exactly on the roof" alternative for mobile (single-tap-to-place vs drag)
- Larger pin marker on viewports below md (Google Maps `optimized: false` + custom icon)

---

### Step 3: Loading State
**File:** `app/page.tsx` LoadingScreen ~lines 1277-1376
**Constants:** `LOADING_MESSAGES` lines 252-258

| Dim | Score | Notes |
|---|---|---|
| Clarity | 6 | "Measuring the roof" is honest but generic |
| Continuity | 6 | Visual link to the pin step is weak |
| Motivation | 4 | No payoff preview — the customer just waits |
| Friction | 5 | Anxiety window: messages stop updating at 19s, V3 runs ~30s |
| Trust | 6 | Roofing facts carousel exists but doesn't speak to "we're working on YOUR roof" |

**Score: 5.4/10** — biggest improvement opportunity in the funnel.

**The 19-second freeze problem.** `LOADING_MESSAGES` array has 5 entries: at 0s, 3s, 7s, 13s, 19s. After 19s the customer sees "Detecting vents and penetrations…" for up to 11 more seconds with no apparent progress. This is where loaders feel broken. Industry data: every 1s past the user's mental "should be done by now" threshold compounds abandon probability ~3-5%.

**Recommendations (P1-impact):**

1. **Extend the LOADING_MESSAGES array to 30s+** so there's always something new:
   ```
   { at: 0,  text: "Fetching satellite imagery…" },
   { at: 3,  text: "Measuring the roof…" },
   { at: 7,  text: "Identifying the outline…" },
   { at: 13, text: "Tracing roof features…" },
   { at: 19, text: "Detecting vents and penetrations…" },
   { at: 24, text: "Cross-checking with Florida property records…" },
   { at: 28, text: "Calculating your three options…" },
   { at: 33, text: "Almost there — just packaging it up…" },
   ```

2. **Add a determinate-ish progress bar** that smoothly animates 0→90% over 28s, then sits at 90% until the actual response lands. Standard "progressive ETA" pattern. The mind reads visible motion as progress; reduces perceived wait by 15-30%.

3. **Personalize the message** with the actual address:
   *"Measuring **8450 Oak Park Ave**…"* — micro-validation that we're working on THEIR roof, not running a demo.

4. **Add the painted-roof preview as a skeleton-blur** instead of a rotating fact. As soon as the Gemini Pro Image step completes (~12-18s in), swap the spinner for a blurred preview of the painted overlay. Builds anticipation; the customer sees their roof emerging.

---

### Step 4: Result Page
**File:** `app/page.tsx` ResultScreen ~lines 1391-2079

| Dim | Score | Notes |
|---|---|---|
| Clarity | 9 | Headline sqft + tier cards + map all immediately scannable |
| Continuity | 9 | Painted roof links visually to pin step |
| Motivation | 8 | 3 tiers + Most chosen + storm urgency + social proof |
| Friction | 8 | Sticky mobile CTA, voice consent on this step (not gated upfront) |
| Trust | 9 | ImageryQualityBadge (Pratfall), real numbers, parcel record |

**Score: 8.6/10** — strongest screen in the funnel. Recent CRO pass shipped 8 changes here.

**Remaining gaps:**
- ParcelBlock in the bottom-left quadrant competes with the wide RepCTACard for attention. Two CTAs in close proximity on mobile.
- No "share this report" affordance on the result page itself (customer has to scroll to find /r/ URL, or wait for the SMS).
- Disclosure band still a wall of text (HI-5 from the audit) — collapse-by-default would tighten it.
- Tier accordion expand-to-show-more works, but no analytics fire on expand — can't measure which tier homeowners actually open.

---

### Step 5: Voice Consent + Sydney Call
**Components:** `RepCTACard` ~lines 2482-2806 + `/api/dispatch-outbound` + `voxaris-pitch/agents/sydney/`

| Dim | Score | Notes |
|---|---|---|
| Clarity | 8 | "Lock in my real number" copy is sharp |
| Continuity | 9 | Sits exactly under the value (the tier prices they just saw) |
| Motivation | 8 | "Free, 20 min, no obligation" + storm urgency + social proof |
| Friction | 7 | Single checkbox + button. Disabled-state hint shipped. |
| Trust | 9 | TCPA-locked, AI disclosure, opt-out language inline |

**Score: 8.2/10**

**Gaps:**
- "AI voice assistant" is generic. The agent has a name (**Sydney**) — using it here builds Mere Exposure across multiple touchpoints (call → SMS → reminder). Compliance-safe: "Sydney (our AI assistant) can call to find a time."
- No "what Sydney will ask" preview. Some homeowners ghost the call because they don't know what to expect. A 1-line line above the checkbox: *"She'll ask 3 things: when works for you, your roof concerns, and confirm the address."*
- The button is 100% width. On wider viewports the click target is huge but the visual weight pulls focus too aggressively. Constrain to ~360px max-width on md+ for visual balance.

---

### Step 6: Booked Success State
**Inside `RepCTACard`** when `bookingState === "booked"` ~lines 2497-2535

| Dim | Score | Notes |
|---|---|---|
| Clarity | 7 | "You're on the list" + "Watch your phone" — clear but thin |
| Continuity | 8 | Same card position; visual continuity |
| Motivation | 5 | No reassurance about what's next; no upsell |
| Friction | 9 | No friction (success state) |
| Trust | 5 | No expectations set; no Sydney humanization; no calendar add |

**Score: 6.8/10**

**Gaps (a lot of leverage here):**
- Single paragraph. After committing to a call from an AI, the homeowner needs reassurance about what specifically will happen.
- No countdown ("Sydney will call you in the next 30 seconds…")
- No "Add (321) 985-1104 to your contacts so it doesn't show as Spam" — solves the actual conversion-killer of unknown-number screening.
- No "Reply to this text if you'd rather just message" alternate path.
- No calendar download (.ics) for the time-window the rep will actually visit (after Sydney books).

---

### Step 7: Homeowner Share Page (`/r/[publicId]`)
**File:** `app/r/[publicId]/page.tsx`

| Dim | Score | Notes |
|---|---|---|
| Clarity | 8 | Clean printed-report style, full lead context preserved |
| Continuity | 7 | Linked from SMS; OG meta tags branded for Noland's |
| Motivation | 7 | "Call {phone}" header CTA, "Lock in" footer CTA |
| Friction | 4 | **No share button at all** — the whole reason this page exists |
| Trust | 8 | Painted overlay + estimate range + storms preserved |

**Score: 6.8/10**

**Biggest single gap in the entire funnel:** This page is documented as "shareability with a spouse / contractor friend / insurance file" (line 11 of `app/r/[publicId]/page.tsx`) — but there is no share button. The customer has to manually copy the URL from their browser bar.

**Recommendations:**
- Native `navigator.share()` button on mobile (opens iOS/Android share sheet — SMS, AirDrop, WhatsApp, etc.). Fallback to copy-link on desktop with a "Copied!" toast.
- "Email this report" mailto:?subject=&body= link with pre-filled subject "My Noland's roof report" and body containing the URL + estimate range.
- "Text this to your spouse" tap-to-text with the URL pre-filled.
- Print-optimized — already has `@media print` styles (line 318).

---

### Step 8: SMS Confirmation
**Templates:** `lib/i18n.ts` lines 148-162

Current SMS body:
> Hi {firstName}, this is {agentName} from {officeName}. We got your estimate request for {address}. {estimateLine}Your full report: {shareUrl} — keep it for your records. Reply YES and {agentName} (our AI voice assistant) will call you now to schedule a free inspection. Reply STOP to opt out.

| Dim | Score | Notes |
|---|---|---|
| Clarity | 8 | Identifies seller, value-frames the link |
| Continuity | 8 | Mirrors the result-page voice consent |
| Motivation | 7 | "Reply YES" is a clear next action |
| Friction | 8 | Short, FCC-compliant |
| Trust | 8 | Office name + AI disclosure + opt-out |

**Score: 7.8/10** — well-crafted. Two opportunities:

- "Reply YES and {agentName}" — Mere Exposure: use "Sydney" consistently. Currently the agent name is parameterized (good) but if we set it to "Sydney" everywhere, the homeowner builds recognition.
- No social proof in the SMS. Single line addition: *"47 Florida neighbors did the same this week."* (gated on the same recent-count endpoint we already built).

---

## Funnel Metrics — what we can measure today vs. what's missing

**Currently captured:**
- `leads.created_at` (lead count)
- `leads.status` transitions (calling, appt_scheduled, callback_requested, etc.)
- `leads.appointment_at` (post 0020 migration apply)
- Sydney call events via `voxaris-pitch/agents/sydney/events.py`
- Podium send results via `lib/podium.ts` return values

**NOT captured (gaps blocking real funnel math):**
- Hero pageview → Step 2 form-submit (no GA4 event)
- Step 2 submit → Pin step reached (no event)
- Pin step → V3 fired (no event)
- V3 success → CTA card rendered (no event)
- CTA card rendered → voice consent CHECKED (no event)
- Voice consent → "Lock in" tapped (no event — only the booking outcome is logged)

**P0 RECOMMENDATION:** wire 6 GA4 events (`funnel_step_started` with a `step` property: `address`, `contact`, `pin`, `loading`, `result`, `voice_consent`, `booked`). Without this, every conversion-rate number in this doc is an estimate. Single afternoon to ship; unlocks all future CRO measurement.

---

## Revenue Impact Analysis

**Assumed inputs** (Noland's-specific — adjust when you have real data):
- ~1000 estimator visits/month (post-launch ramp)
- Current funnel: ~30% submit → ~12% see result → ~3% book = 0.3 booked appts per 100 visits
- Avg booked appt → closed job rate (industry): 30-40%
- Avg Noland's job value: $12,000-$28,000 (per the proposal pricing card range)
- LTV from one customer (1 roof, ~25-year cycle): ~$15,000

**With P1 shipped (loading state + share button + booked state):**
| Change | Expected lift |
|---|---|
| Loading state polish (3 wins) | -10% loading abandon → +6 bookings/mo |
| Share button on /r/ | +5% return-visits → +3 bookings/mo |
| Booked-success state | -15% no-show → +2 net jobs/mo |
| Pin step progress indicator | +3% pin-completion → +2 visits/mo |

Conservative combined: **~10-13 additional booked appointments/month** → **~3-4 additional closed jobs/month** → **~$36k-$112k additional revenue/month** depending on which tiers convert.

---

## Optimization Recommendations

### Priority 1 — Do Now (this week, all surgical edits to `app/page.tsx` + `app/r/[publicId]/page.tsx`)

**P1.1 · Loading state extension + personalization + progress feel**
- Extend `LOADING_MESSAGES` to 8 entries up to 33s
- Personalize messages with the customer's street name
- Add an animated determinate-ish progress bar (0→90% over 28s, hold until response)
- File: `app/page.tsx` `LOADING_MESSAGES` constant + `LoadingScreen` render
- Effort: ~1 hr

**P1.2 · Share button on `/r/[publicId]`**
- New client component `<ShareReportButton publicId={...} address={...} />`
- Mobile: `navigator.share({ title, text, url })`
- Desktop: copy-to-clipboard with toast feedback
- Add a 4-button row: Native Share / Copy Link / Email / Text
- File: new `components/ShareReportButton.tsx` + mounted in `app/r/[publicId]/page.tsx`
- Effort: ~1.5 hr

**P1.3 · Booked success state — full reassurance card**
- Expand from one sentence to: a countdown ("Sydney will call in ~10s"), a "save Sydney's number" line with one-tap contact add (`tel:+13219851104`), a "what she'll ask" preview, a "prefer SMS instead?" alternate path
- File: `app/page.tsx` RepCTACard `bookingState === "booked"` branch (~lines 2497-2535)
- Effort: ~1 hr

**P1.4 · GA4 funnel events**
- 6 events: `funnel_address_submitted`, `funnel_contact_submitted`, `funnel_pin_confirmed`, `funnel_v3_returned`, `funnel_voice_consent_checked`, `funnel_booked`
- Use `gtag('event', name, { ...props })` at each transition point
- File: `app/page.tsx` at each state transition + `RepCTACard` consent toggle
- Effort: ~1 hr (assuming GA4 already wired in `layout.tsx`)

### Priority 2 — Plan (this month)

**P2.1 · Pin step progress indicator + sub-line + larger touch target**
- "Step 2 of 3" eyebrow + "Next stop: your real number" sub-line
- Custom larger pin marker for mobile
- Optional "Use my location" assist
- Effort: ~2 hr

**P2.2 · Humanize voice consent as Sydney everywhere**
- Result page consent label: "Yes, **Sydney** (our AI assistant) can call to find a time…"
- SMS template `agentName` default = "Sydney"
- Reminder template merge variables
- Effort: ~30 min

**P2.3 · HI-5 disclosure band → progressive disclosure**
- Collapse "Not a final or binding quote. How we calculated this ▾" → expand on click
- Effort: ~30 min

**P2.4 · Calendar add on booked state**
- Generate a `.ics` data-URL for the morning/afternoon window after Sydney books
- "Add to calendar" button — works on iCal, Google, Outlook universally
- Requires data flow from Sydney's book_inspection back into the result page (postMessage from Sydney's room? Or poll `/api/leads/[publicId]/status` for 30s?)
- Effort: ~3-4 hr

**P2.5 · A/B framework selection**
- Pick one: PostHog (free tier covers up to 1M events), GrowthBook (open source), Vercel Edge Config feature flags
- Wire to a single experiment first (T-3 "Most chosen" badge variants)
- Effort: ~2 hr for the framework + ~30 min per test

### Priority 3 — Strategic (this quarter)

**P3.1 · Lighthouse CWV sweep (HI-6 from prior audit)**
- Pull CrUX field data from `/api/cwv` (need to wire) for the deploy
- Address LCP candidates (Wordmark PNG, hero Poppins Black H1)
- Lazy-load reCAPTCHA on first form-field focus
- Preconnect tags for Google Maps + reCAPTCHA + Static Maps
- Effort: ~1 day with real CWV data

**P3.2 · Exit-intent capture on result page**
- When customer scrolls past CTA without booking AND hits Esc / mouseleaves top viewport / back-button on mobile → trigger a single non-blocking sheet: "Want this report by email? We'll send it once."
- Files: new `components/ExitIntentSheet.tsx` + mounted in ResultScreen
- Note: this is BELT-AND-SUSPENDERS with the abandoner cron — cron handles 24h+, this captures the 0-2h window
- Effort: ~3 hr

**P3.3 · Anchor band (HI-3 from prior audit)**
- "The cobbled DIY path: EagleView (~$300) + private inspection (~$400) + 3 contractor quotes (6 weeks of calls). One Noland's number, free, in 30 seconds."
- Above the tier band on the result page
- Effort: ~1 hr (just copy + a div)

**P3.4 · Loading state painted-roof skeleton preview**
- When Gemini Pro Image step lands (~12-18s in via early SSE/polling), swap the rotating-fact card for a blurred painted-overlay preview
- Builds powerful anticipation; the customer literally sees their roof emerging
- Needs backend SSE or polling — bigger ship
- Effort: ~1 day

---

## Pricing Page Assessment (the result-page tier band acts as pricing)

| Checklist | Status |
|---|---|
| Headline frames value, not cost | ✓ "Three honest options for your roof" |
| Plans limited to 3 | ✓ Good / Better / Best |
| Recommended plan highlighted | ✓ "Most chosen" floating badge (HI-2) |
| Annual/monthly pricing logic | n/a — single monthly figure shown |
| Features benefit-oriented | ✓ Checkmarks visible at a glance |
| Social proof near pricing | ✓ Recent-count line in RepCTACard |
| FAQ near pricing | ✗ No FAQ — could add small Q&A under disclosure |
| Money-back / risk-reversal visible | ✓ "Free, no obligation" in RepCTACard body |
| Aspirational plan names | ✓ Essentials / Standard / Fortified |
| Action-language CTAs | ✓ "Lock in my real number" |
| Comparison with alternative spend | ✗ — see HI-3 anchor band recommendation |
| "Help me choose" | ✗ — could add `<a href="tel:">` ghost link |

**Pricing health: 9/12 boxes** — strong. Two unchecked items both addressed in P3 recommendations.

---

## Email/SMS Nurture Integration

Already shipped (see `docs/podium-reminder-setup.md`):
- B1: estimate-ready Podium send (instant, on V3 success)
- B2 T+24h Zeigarnik open-loop
- B3 T+3d neighbor proof (Mimetic)
- B4 T+7d storm-season anchor
- B5 T+21d Pratfall grace exit

For booked leads:
- A1 instant booking confirmation
- A2 T-24h day-before reminder
- A3 morning-of reminder
- A4 T-30min ETA
- A5 post-appointment endowment

**Gap:** SMS confirmation (Twilio, immediate on form submit) and Podium B1 (instant on V3 success) cover the first 0-30 min. The Podium B2 picks up at +24h. **There is a 23.5-hour window where no automated nurture fires.** For homeowners who get the estimate but don't book within 30 min, this is the highest-attention window — they just saw the painted roof and their price.

**Recommendation: add a B1.5 touchpoint at T+2-3h** ("Hi {firstName}, your roof report is still live at {shareUrl} — questions? Reply here.") Pratfall + low-friction reply. Pure cron addition to `pickBSequenceTouchpoint`.

---

## Traffic Source Alignment

Currently funnel-agnostic — same landing page for every source. Recommendations:

| Source | Intent | Recommended entry | Status |
|---|---|---|---|
| Door-hangers (QR) | Very high (already met the brand) | Direct to estimator with `?utm_source=hanger&utm_campaign=clermont` | ✗ no UTM-keyed variation |
| Branded organic search ("Noland's Roofing estimate") | High | Current homepage | ✓ |
| Non-branded ("Florida roof estimate") | Medium | Current homepage | ✓ |
| Google/Meta paid ads | Medium-Low | Should have message-match LP per ad set | ✗ no per-ad-set LPs |
| Insurance referral (e.g. after storm event) | High | Storm-specific variant with hail/wind eyebrow | ✗ — opportunity for paid post-storm campaigns |

**P3 ish:** When paid-ads ramp, add `?intent=storm` URL param that swaps the hero eyebrow to "Recent storm in your area? Get your roof checked in 30 seconds." Same landing page, message-match per source.

---

## Next Steps (recommended ship order)

1. **P1.4 GA4 events** (1 hr) — instrumentation FIRST so every other test has real numbers
2. **P1.1 Loading state polish** (1 hr) — biggest abandon-rate fix
3. **P1.2 Share button on /r/** (1.5 hr) — closes the biggest single funnel gap
4. **P1.3 Booked success state** (1 hr) — captures the conversion-after-conversion (homeowner actually answers Sydney's call)
5. **P2.2 Humanize as Sydney** (30 min) — Mere Exposure across the funnel
6. **P2.3 Disclosure band collapse** (30 min) — tightens the result page
7. **P2.1 Pin step polish** (2 hr) — smaller leak but symmetric step indicators

**~6-7 hours of focused work covers everything P1+P2 above.**

The remainder (P3.x and the A/B framework) is real work but earns its keep only AFTER P1.4 instrumentation lands and gives us baseline numbers to test against.

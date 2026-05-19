# Voxaris Marketing Operating System

> Single source of truth for marketing decisions. Combines the
> psychology (WHY), the menu of plays (WHAT), and the execution
> playbook (HOW) into one doc filtered through Voxaris's locked
> positioning. If a marketing decision doesn't match what's here,
> the decision is wrong — not the doc.

**Companions:**
- `POSITIONING.md` — the locked 24/7 appointment machine framing
- `AGENTS.md` (root) — engineering + business model invariants
- `~/.claude/skills/paid-ads/SKILL.md` — invokable in any session
- `~/.claude/skills/marketing-psychology/SKILL.md` — invokable
- `~/.claude/skills/marketing-content/SKILL.md` — invokable

---

## TL;DR — what to do right now

The single most important sentence in this entire doc: **the bottleneck
is closed contractors, not awareness or product.** Stop optimizing
the customer page. Move all attention to acquisition.

**This week:**
1. Build the `/contractors` B2B landing page (separate from the
   homeowner-facing estimator) — pixels + conversion events on day 1
2. Ship `/vs/eagleview` and `/vs/roofr` comparison pages — high-intent
   search lane that's currently empty
3. Claim G2 / Capterra / GetApp listings (2 hours, free)
4. Launch the "After-Hours Lead Loss Calculator" embed
5. Start Ethan-on-LinkedIn daily founder posts

**Next 30 days:**
- LinkedIn Ads $1,500/mo (FL roofing owners, 11-200 emp)
- Google Ads $1,000/mo (roofing software, eagleview alternative, etc.)
- Meta retargeting $500/mo (warm prospects who didn't book demo)

**60-90 days (post-Noland's):**
- Webinars + conference speaking + podcasts
- Two-sided referrals
- Press coverage

**Target unit economics:**
- Demo CPA <$200
- Demo → contract close 20-30%
- Blended CAC <$2,000
- LTV:CAC >28× (we have a $57k ARR product — burn aggressively early)
- Payback period <2 months

---

## The locked Voxaris context

### Positioning (one sentence)
**Voxaris turns any roofing website into a 24/7 appointment machine,
white-labeled as the contractor's brand.**

### What we're NOT
- ❌ A lead-gen company
- ❌ An EagleView competitor
- ❌ "Unlimited roof reports"
- ❌ A "one-stop shop"

All feature-led framings. We sell the OUTCOME.

### The end-to-end product (Noland's deployment)
1. Homeowner lands on contractor's white-labeled subdomain
2. Types address → painted EagleView-quality report in <30s
3. Sydney (AI voice) calls within ~10s if they consent
4. SMS follow-up sequence on every lead, opted in or not
5. Rep notified via SMS + dashboard alert
6. Appointment books into JobNimbus
7. Rep wakes up to booked jobs, not missed calls

### The buyer
Roofing contractor / franchise owner / GM in Florida. B2B sale.
Homeowner is the contractor's customer, not Voxaris's.

### The pricing (foot-in-the-door)
- **Estimator (wedge):** $1,500 setup + $1,795/mo
- **Voice AI (Sydney):** $1,200 setup + $1,495/mo
- **Website + AEO:** $1,495 setup + $1,495/mo
- **Full bundle:** ~$4,800/mo + ~$4,200 setup → **~$57k ARR per
  contractor**

**Never pitch the bundle in cold outreach.** Sequence:
1. Estimator demo only (the wedge)
2. After contract — upsell Sydney
3. Then upsell Website+AEO

### The canonical cold pitch (copy verbatim)
> "We turn your website into a 24/7 appointment machine —
> white-labeled as your brand. Homeowner types their address, gets
> an EagleView-quality roof report in 30 seconds, Sydney calls them
> within 10 seconds, appointment books into your CRM. You wake up
> to booked jobs, not missed calls.
>
> Florida contractors are running this at ~$1,800/mo for the
> estimator alone, ~$4,800/mo for the full stack.
>
> Demo takes 30 seconds: try your address at pitch.voxaris.io."

The line that does the work: **"wake up to booked jobs, not missed
calls."** Loss aversion in 9 words. Use everywhere.

### Hierarchy of messages — every channel, every time
1. **Outcome** (booked appointments, 24/7, white-labeled)
2. **Mechanism** (address → 30s report → 10s Sydney call → CRM)
3. **Contrast** (replaces EagleView + agency + answering service)
4. **Proof** (Newcomb accuracy data; Noland's case study once live)
5. **Ask** ("Try your address at pitch.voxaris.io")

### Who we actually compete with
Not EagleView, not Angi, not Roofr, not website agencies. **We
compete with the contractor's current cobbled-together stack** and
win by making it feel like the liability it is.

| Their current piece | Our wedge |
|---|---|
| EagleView | "Sends a PDF. We send a pre-measured homeowner to your CRM." |
| Website agency | "Built you a brochure. We built you a lead machine." |
| Answering service | "Takes a message. Sydney books the appointment." |
| Angi / HomeAdvisor | "Sells your lead to 4 other roofers. Ours routes exclusively." |

### Discipline
- **Never use the literal word "insurance"** — use "claim", "your
  provider", "premium discounts" (May 2026 scrub)
- **Never run consumer-facing ads to homeowners** in Phase 1 (Phase 2-3
  problem)
- **White-label is the moat** — homeowners see contractor's brand,
  not Voxaris

---

## Part 1 — The WHY (Marketing Psychology)

Mental models that explain why people buy and why marketing works
or fails. Each one lists the Voxaris-specific application.

### The 10 models that change what we should do this week

**1. Theory of Constraints**
> Every system has one bottleneck. Fix it before optimizing elsewhere.

Voxaris bottleneck is **closed contractors**, not product. Every
hour spent on the customer page is wasted until acquisition is
unblocked. The product is ahead of GTM.

**2. Jobs to Be Done**
> People hire products to do a job. Frame around outcome, not features.

The roofer hires Voxaris for **booked appointments.** Locked.

**3. Inversion**
> Ask "what would guarantee failure?" then avoid those things.

Failures: pitching bundle in cold outreach, letting homeowner see
Voxaris brand, AI-generated pricing, B2C ads before Phase 2, single
channel.

**4. Status-Quo Bias**
> People prefer the current state. Change requires effort + feels risky.

The #1 obstacle for roofers. Every ad must make the cobbled stack
feel like the liability — not Voxaris feel like a nice-to-have.

**5. Loss Aversion**
> Losses feel ~2× as painful as equivalent gains.

"Wake up to booked jobs, not missed calls" — most valuable copy
asset Voxaris has. Use everywhere.

**6. Anchoring**
> First number heavily influences subsequent judgments.

Anchor $1,795/mo against cobbled-stack cost (~$1,700/mo for
EagleView + agency + answering service). Same dollars, different
pocket.

**7. Mental Accounting**
> Same money feels different based on pocket.

"$1,795/mo" → "less than your current EagleView bill." Reframe.

**8. Endowment Effect / IKEA Effect**
> People value what they own + what they built.

White-label is a psychological lock-in mechanism. Once contractor's
brand is on subdomain + ads + yard signs → switching costs become
emotional. The moat.

**9. Mimetic Desire + Authority**
> People want what others want. Desirable people = social proof.

Until Noland's is live, every cold pitch fights upstream. The day
Noland's signs + ships is the day every other pitch gets 2-3× easier.

**10. Rule of 7 + Compounding**
> ~7 touchpoints before conversion.

Roofers need 7+ exposures. Today they get 1 (organic X). Multi-touch,
multi-channel is the unblock.

### Foundational thinking models (apply when stuck)

- **First Principles** — break to basic truths, build up
- **Circle of Competence** — stay in what you're good at
- **Occam's Razor** — simplest explanation first
- **Pareto (80/20)** — find the vital few
- **Local vs Global Optima** — zoom out before zooming in
- **Opportunity Cost** — every choice has a cost
- **Diminishing Returns** — 10th post ≠ 1st post impact
- **Second-Order Thinking** — flash sale = revenue (1st) + discount
  training (2nd)
- **Map ≠ Territory** — your persona is a model, not reality
- **Probabilistic Thinking** — think in odds, plan multiple outcomes
- **Barbell Strategy** — 80% proven channels, 20% experiments

### Buyer psychology (apply to copy, design, sequences)

- **Fundamental Attribution Error** — when buyers don't convert,
  examine your process, not their character
- **Mere Exposure Effect** — familiarity breeds liking
- **Availability Heuristic** — vivid examples feel common (case
  studies)
- **Confirmation Bias** — align messaging to existing beliefs
- **Mimetic Desire** — people want what others want
- **Sunk Cost Fallacy** — kill underperforming campaigns
- **Endowment Effect** — free trials let them "own" it
- **IKEA Effect** — let customers configure/customize/build
- **Zero-Price Effect** — free is psychologically different
- **Hyperbolic Discounting** — lead with immediate benefits
- **Status-Quo Bias** — reduce switching friction ("import in one
  click")
- **Default Effect** — pre-selected options win
- **Paradox of Choice** — three tiers > seven
- **Goal-Gradient Effect** — show progress bars to drive completion
- **Peak-End Rule** — design memorable peaks + strong endings
- **Zeigarnik Effect** — unfinished tasks pull attention ("you're
  80% done")
- **Pratfall Effect** — small flaws increase trust ("not a final
  quote")
- **Curse of Knowledge** — your product feels obvious to you
- **Mental Accounting** — reframe price into known budget line
- **Regret Aversion** — money-back guarantees, "no commitment"
- **Social Proof** — customer counts, logos, "trending"

### Persuasion & influence (ethical only)

- **Reciprocity** — give first
- **Commitment & Consistency** — small commitments → bigger ones
- **Authority Bias** — credentials, expert endorsements
- **Liking / Similarity** — relatable spokespeople, founder stories
- **Unity Principle** — "one of us"
- **Scarcity / Urgency** — only if genuine
- **Foot-in-the-Door** — small ask → bigger ask (Voxaris uses this)
- **Door-in-the-Face** — big ask, retreat to what you wanted
- **Anchoring** — show high anchor first
- **Decoy Effect** — third clearly-worse option makes target obvious
- **Framing** — same fact, different feel ("90% success" vs "10%
  failure")
- **Contrast Effect** — show "before" clearly

### Pricing psychology

- **Charm Pricing** — $1,795 feels much less than $1,800
- **Rounded-Price (Fluency)** — round numbers feel premium
- **Rule of 100** — <$100 use %, >$100 use $. ($500 off > 20% off)
- **Good-Better-Best** — three tiers, middle is the target
- **Mental Accounting** — "$3/day" vs "$90/month" — reframe the
  pocket

### Design & delivery

- **Hick's Law** — fewer options, faster decisions
- **AIDA** — Attention → Interest → Desire → Action
- **Rule of 7** — ~7 touchpoints before conversion
- **Nudge Theory** — small framing changes, big behavior shifts
- **BJ Fogg** — Behavior = Motivation × Ability × Prompt (all three)
- **EAST Framework** — Easy, Attractive, Social, Timely
- **COM-B Model** — Capability × Opportunity × Motivation
- **Activation Energy** — reduce the first step (pre-fill, templates)
- **North Star Metric** — one metric. Voxaris Phase 1: **paying
  contractors.** Not MRR, not demos.
- **The Cobra Effect** — incentives that backfire (watch what
  behavior an incentive actually produces)

### Growth & scaling

- **Feedback Loops** — output becomes input
- **Compounding** — small consistent gains accumulate
- **Network Effects** — value grows with users (Phase 3 marketplace)
- **Flywheel Effect** — sustained effort creates self-maintaining
  momentum
- **Switching Costs** — ethical lock-in via integrations, data,
  workflows
- **Exploration vs Exploitation** — 80% optimize / 20% try new
- **Critical Mass** — depth before breadth (FL before TX/CA)
- **Survivorship Bias** — study failures, not just successes

### Challenge → models quick reference

| Challenge | Models to apply |
|---|---|
| Conversions are zero | Theory of Constraints, Hick's Law, Activation Energy, BJ Fogg |
| Price feels too high | Anchoring, Framing, Mental Accounting, Loss Aversion, Rule of 100 |
| Building trust | Authority, Social Proof, Reciprocity, Pratfall, Liking |
| Increasing urgency | Scarcity (genuine only), Loss Aversion, Zeigarnik |
| Retention / churn | Endowment Effect, Switching Costs, Status-Quo, IKEA |
| Growth stalling | Theory of Constraints, Local vs Global, Compounding |
| Decision paralysis | Paradox of Choice, Default Effect, Nudge, Hick's Law |
| Onboarding drop-off | Goal-Gradient, IKEA, Commitment, Activation Energy |
| Why people don't switch | Status-Quo, Sunk Cost, Switching Costs, Regret Aversion |
| Cold outreach not landing | Rule of 7, Mere Exposure, Mimetic Desire, Curse of Knowledge |

---

## Part 2 — The WHAT (139 Marketing Ideas Filtered)

### The Voxaris filter (apply before any recommendation)

Gate every idea through these 6 constraints:

1. B2B sale to FL roofing contractors → cuts homeowner-facing plays
2. Pre-revenue, small team → cuts high-budget plays
3. Theory of Constraints: bottleneck is closed contractors, not
   awareness → cuts pure-brand plays
4. Mimetic desire blocked until Noland's lives → defers case-study
   plays
5. Foot-in-the-door: Estimator wedge only in cold → cuts bundle ads
6. Never use the word "insurance" anywhere

### Tier 1 — Ship in next 30 days (highest ROI)

| # | Idea | Why it fits Voxaris now |
|---|---|---|
| **15** | **Engineering as Marketing** | The estimator IS the lead magnet. Compound it: ship "After-Hours Lead Loss Calculator." |
| **11** | **Competitor Comparison Pages** | `/vs/eagleview`, `/vs/roofr`, `/vs/hover`. High-intent searchers. Zero competitive content exists. |
| **87** | **Powered By Marketing** | Already half-shipped via `/r/[publicId]`. Add "Powered by Voxaris" footer on white-labels. |
| **88** | **Free Migrations** | "We import your EagleView reports + JobNimbus history at no cost." Status-quo-bias buster. |
| **39** | **LinkedIn Audience (Ethan founder)** | Highest-trust B2B channel. Daily Ethan posts = Rule of 7 ignition. |
| **41** | **X Audience** | Already in plan via Higgsfield Supercomputer launch sequence. |
| **18** | **Calculator Marketing** | "After-Hours Lead Loss Calculator." Loss-aversion turned into a viral embed. |
| **78** | **Product Hunt Launch** | Once Noland's lives with real customer story. ~5-10K free impressions. |
| **128** | **G2 / Capterra / GetApp listings** | Free, B2B buyers search these. Competitors are listed; Voxaris isn't. 2-hour win. |
| **23-34** | **Paid Ads** | LinkedIn primary, Google complement, Meta retargeting. See Part 3. |

### Tier 2 — 60-90 days (after Noland's is live)

| # | Idea | Why it waits |
|---|---|---|
| **65** | Live Webinars | "How FL roofers 3x'd close rate" — needs Noland's data |
| **70** | Conference Speaking | FRSA Convention, IRE. Submit talks now. |
| **107** | Podcasts ("Roof to Roof") | Ethan interviews FL roofing GMs. Doubles as prospecting. |
| **62** | Integration Marketing | JobNimbus + CompanyCam + AccuLynx joint marketing |
| **63** | Community Sponsorship (FRSA) | Florida Roofing & Sheet Metal Contractors Association |
| **137** | Two-Sided Referrals | Contractor refers contractor → both get a free month |
| **74** | Press Coverage | RoofingContractor.com, Roofing Magazine, FL Roofing Magazine |

### Tier 3 — Compounding bets (start now, payoff in 6-12 mo)

| # | Idea | Why now |
|---|---|---|
| **3** | Glossary Marketing | SEO foundation: "what is roof pitch" etc. |
| **4** | Programmatic SEO | "Roof Estimator [City, FL]" × 100 + "EagleView Alternative for [State]" × 50 |
| **6** | Proprietary Data Content | "State of Florida Roofing 2026" report (Phase 2 data layer foundation) |
| **108** | Public Changelog | `pitch.voxaris.io/changelog`. Builds trust with technical buyers. |
| **123** | Open Source as Marketing | Open-source cyan-mask compositor. Developer goodwill + AEO signal. |
| **134** | Certifications | "Voxaris Certified Roofer." Gamifies adoption, feeds mimetic desire. |

### Skip / defer for Voxaris

- ❌ TikTok / short-form B2C — wrong audience for 35-55 roofing GMs
- ❌ Reality TV / Cameo / Documentaries — too high-budget pre-revenue
- ❌ Lifetime Deals — destroys $57k/yr ARR math
- ❌ Black Friday / New Year promos — B2B SaaS doesn't move on
  consumer holidays
- ❌ International / Price localization — FL Phase 1 first
- ❌ Marketing Stunts / OOH — premature scale plays
- ❌ Self-created Awards — requires brand authority not yet earned

### Full 139 reference (organized)

#### Content & SEO (1-10)
Easy Keyword Ranking · SEO Audit · Glossary Marketing · Programmatic
SEO · Content Repurposing · Proprietary Data Content · Internal
Linking · Content Refreshing · Knowledge Base SEO · Parasite SEO

#### Competitor & Comparison (11-13)
Competitor Comparison Pages · Marketing Jiu-Jitsu · Competitive Ad
Research

#### Free Tools & Engineering (14-22)
Side Projects · Engineering as Marketing · Importers · Quiz
Marketing · Calculator Marketing · Chrome Extensions · Microsites ·
Scanners · Public APIs

#### Paid Advertising (23-34)
Podcast Ads · Pre-targeting · Facebook · Instagram · Twitter ·
LinkedIn · Reddit · Quora · Google · YouTube · Cross-Platform
Retargeting · Click-to-Messenger

#### Social Media & Community (35-44)
Community Marketing · Quora · Reddit Keyword Research · Reddit
Marketing · LinkedIn Audience · Instagram Audience · X Audience ·
Short Form Video · Engagement Pods · Comment Marketing

#### Email Marketing (45-53)
Mistake Emails · Reactivation · Founder Welcome · Dynamic Capture ·
Monthly Newsletters · Inbox Placement · Onboarding Emails · Win-back ·
Trial Reactivation

#### Partnerships & Programs (54-64)
Affiliate Discovery · Influencer Whitelisting · Reseller Programs ·
Expert Networks · Newsletter Swaps · Article Quotes (HARO) · Pixel
Sharing · Shared Slack Channels · Affiliate Program · Integration
Marketing · Community Sponsorship

#### Events & Speaking (65-72)
Live Webinars · Virtual Summits · Roadshows · Local Meetups · Meetup
Sponsorship · Conference Speaking · Host Your Own Conference ·
Conference Sponsorship

#### PR & Media (73-76)
Media Acquisitions · Press Coverage · Fundraising PR · Documentaries

#### Launches & Promotions (77-86)
Black Friday · Product Hunt · Early-Access Referrals · New Year
Promos · Early Access Pricing · PH Alternatives · Twitter Giveaways ·
Giveaways · Vacation Giveaways · Lifetime Deals

#### Product-Led Growth (87-96)
Powered By Marketing · Free Migrations · Contract Buyouts · One-Click
Registration · In-App Upsells · Newsletter Referrals · Viral Loops ·
Offboarding Flows · Concierge Setup · Onboarding Optimization

#### Content Formats (97-109)
Playlists · Templates · Graphic Novels · Promo Videos · Industry
Interviews · Social Screenshots · Online Courses · Book Marketing ·
Annual Reports · End of Year Wraps · Podcasts · Changelogs · Public
Demos

#### Unconventional & Creative (110-122)
Awards · Challenges · Reality TV · Controversy · Moneyball Marketing ·
Curation · Grants · Product Competitions · Cameo · OOH · Marketing
Stunts · Guerrilla · Humor

#### Platforms & Marketplaces (123-130)
Open Source · App Store Optimization · App Marketplaces · YouTube
Reviews · YouTube Channel · Source Platforms (G2/Capterra/GetApp) ·
Review Sites · Live Audio

#### International & Localization (131-132)
International Expansion · Price Localization

#### Developer & Technical (133-136)
Investor Marketing · Certifications · Support as Marketing ·
Developer Relations

#### Audience-Specific (137-139)
Two-Sided Referrals · Podcast Tours · Customer Language

---

## Part 3 — The HOW (Paid Ads Execution)

### Required context before launching anything
1. Goal (awareness / traffic / leads / sales)
2. CPA / ROAS target
3. Monthly budget
4. Constraints (brand, compliance, geo)
5. Product / offer / landing page
6. Audience (ICP, problem solved, lookalike source)
7. Current state (prior ads, pixels, conversion rate)

### Platform selection

| Platform | Best For | Voxaris Use? |
|---|---|---|
| **LinkedIn** | B2B, decision-makers, title + company targeting | ✅ **Primary** — FL roofing owner targeting is laser-precise |
| **Google Ads** | High-intent search | ✅ Complement — search lane for "roofing software", etc. |
| **Meta (FB/IG)** | Demand gen, visual products | ✅ Retargeting only — warm prospects |
| Twitter/X | Tech, thought leadership | ❌ Organic only (paid is weak for B2B roofing) |
| TikTok | 18-34, viral creative | ❌ Wrong audience |

### Naming convention (lock this)
```
[Platform]_[Objective]_[Audience]_[Offer]_[Date]

LI_Demo_Owners-FL-Roofing_Estimator_2026Q2
GOOG_Search_RoofingSoftware_Demo_Ongoing
META_Retarget_ContractorsPage_Estimator_2026Q2
```

### Account structure
```
Account
└── Campaign: [Objective] — [Audience/Product]
    ├── Ad Set: [Targeting variation]
    │   ├── Ad 1: Creative A (founder video)
    │   ├── Ad 2: Creative B (painted overlay screenshot)
    │   └── Ad 3: Creative C (case study card)
    └── Ad Set: [Targeting variation 2]
```

### Voxaris 4-phase paid plan

#### Phase 1 — Foundation (Week 1)

**Goal:** Don't spend a dollar until tracking works.

- Install LinkedIn Insight Tag on `pitch.voxaris.io`
- Install Meta Pixel + Conversions API on `pitch.voxaris.io`
- Install Google tag (`gtag.js`)
- Create conversion events:
  - `demo_booked` (value $5,000 — CAC tolerance)
  - `contract_signed` (value $4,800 — first-month MRR)
- UTM discipline on every ad URL
- Build dedicated B2B landing page `pitch.voxaris.io/contractors`
  (NOT the customer-facing estimator — contractors aren't
  estimating their own roof)
- Cal.com / Calendly booking flow wired to fire conversion event

#### Phase 2 — LinkedIn launch (Weeks 2-4)

**Goal:** 2-3 closed contractors at <$2k CAC.

**Campaign:** `LI_Demo_Owners-FL-Roofing_Estimator_2026Q2`

**Targeting:**
- Titles: Owner, President, CEO, GM, VP Operations, Marketing
  Director
- Function: General Management, Operations, Marketing
- Seniority: Owner, CXO, VP, Director
- Industry: Construction (Construction / Building Materials)
- Company size: 11-200
- Geography: FL (Orlando, Tampa, Jacksonville, Miami, Naples, Fort
  Myers metros)
- Exclude: existing customers, Voxaris employees

**Budget:** $1,500/mo, 2 ad sets × $25/day each.

**Creative (3 per ad set):**
- Founder-led 15-30sec video (Higgsfield Soul ID — identity-faithful
  Ethan on camera)
- Painted Oak Park overlay screenshot + tier table
- Noland's case study card (once live)

**Hook:**
> "Wake up to booked jobs, not missed calls. Voxaris turns your
> website into a 24/7 appointment machine — white-labeled as your
> brand. Homeowner types their address, gets an EagleView-quality
> report in 30 seconds, Sydney calls them within 10 seconds,
> appointment in your CRM."

**CTA:** "Book your 15-min demo" → fires `demo_booked` event.

#### Phase 3 — Google Ads (Weeks 3-6)

**Goal:** Capture high-intent search traffic.

**Keywords (exact + phrase):**
- `roofing software` / `roofing CRM`
- `roof measurement software` / `eagleview alternative`
- `lead capture for roofers` / `instant roof estimate widget`
- `AI receptionist for contractors` / `after hours answering
  service roofers`

**Negative keywords:** jobs, careers, free download, complaints,
reviews of competitors, hiring

**Budget:** $1,000/mo. Manual CPC to start, switch to Maximize
Conversions once 50+ demo bookings tracked.

**Landing:** Same `/contractors` page.

#### Phase 4 — Meta retargeting (Week 4+)

**Goal:** Close warm prospects who didn't book.

- Audience: `pitch.voxaris.io/contractors` visitors who did NOT
  fire `demo_booked` event
- Window: 30 days
- Frequency cap: 3-5x/week
- Creative: Noland's case study, founder thread, behind-the-scenes
  painted overlay generation
- Budget: $500/mo

### KPI targets

| Metric | Target | Why |
|---|---|---|
| LinkedIn CPM | $30-80 | Realistic FL B2B owner targeting |
| LinkedIn CTR | >0.8% | Cold B2B benchmark |
| Demo CPA | <$200 | Tolerable given $57k ARR LTV |
| Demo → Contract close | 20-30% | Standard B2B SaaS demo close |
| **Blended CAC** | **<$2,000** | **28× LTV:CAC. Excellent.** |
| Payback period | <2 months | First contractor month covers CAC |

### Ad copy frameworks

**Problem-Agitate-Solve (PAS):**
`[Problem] → [Agitate pain] → [Solution] → [CTA]`

**Before-After-Bridge (BAB):**
`[Current pain] → [Desired future] → [Product as bridge]`

**Social Proof Lead:**
`[Stat/testimonial] → [What you do] → [CTA]`

**Headline patterns:**
- `[Keyword] + [Benefit]` — Search
- `[Number] + [Outcome]` — Social
- `[Question]` — Curiosity
- `[Contrarian]` — Pattern interrupt

**CTA library:**
- Soft (TOFU): Learn More, See How It Works, Watch Demo
- Hard (BOFU): Book a Demo, Start Free Trial, Sign Up Free
- Urgency (genuine only): Limited Time, Only X Spots Left

### Conversion tracking setup

Install BEFORE spending:

| Platform | Pixel | Server-side |
|---|---|---|
| Google | `gtag.js` (AW-XXXXXXXXX) | Enhanced Conversions |
| Meta | Meta Pixel | Conversions API (CAPI) |
| LinkedIn | Insight Tag | Conversions API |
| TikTok | TikTok Pixel | Events API |

**Validation:**
- Pixel fires on every page (browser extension check)
- Events fire on confirmed action (NOT button click)
- Event parameters carry correct values
- No duplicates
- Mobile + desktop both fire
- Server-side dedupe via shared `event_id`

**Use server-side (CAPI / Events API) when:**
- Running Meta or TikTok (strongly recommended)
- Audience tech-savvy (high ad-blocker usage)
- Need accurate purchase/revenue attribution
- Spending >$5K/mo on any platform

### Optimization levers

**If CPA too high:**
1. Check landing page (problem post-click?)
2. Tighten audience
3. Test new creative angles
4. Improve quality score
5. Adjust bid strategy

**If CTR low:** creative isn't resonating → new hooks; or audience
mismatch → refine targeting; or fatigue → refresh creative.

**If CPM high:** audience too narrow → expand; competition → try
other placements; relevance score → improve creative fit.

### Bid strategy progression
1. Manual or cost caps to start
2. Gather 50+ conversions
3. Switch to automated with targets based on historical data
4. Monitor + adjust

### Retargeting funnel

| Stage | Audience | Window | Frequency Cap |
|---|---|---|---|
| Hot | Cart/trial/demo-started | 1-7 days | Higher OK |
| Warm | Key page visitors | 7-30 days | 3-5x/week |
| Cold | Any visit | 30-90 days | 1-2x/week |

### Pre-launch universal checklist
- [ ] Conversion tracking tested with real conversion
- [ ] Landing page <3s load
- [ ] Mobile-friendly
- [ ] UTM parameters working
- [ ] Budget correct (daily vs lifetime)
- [ ] Targeting matches intent
- [ ] Ad creative approved
- [ ] Naming convention applied
- [ ] Team notified of launch

### What NOT to do

- ❌ Launch without conversion tracking
- ❌ Pitch the bundle in cold ads (Estimator wedge only)
- ❌ Run TikTok / X paid (wrong audience)
- ❌ Stop campaigns during LinkedIn 7-day learning phase
- ❌ Make >30% budget changes in single move (kills learning)
- ❌ One ad per ad set (need 3+ to test)
- ❌ Skip mobile (60%+ of traffic)
- ❌ Use "insurance" anywhere in copy

---

## The integrated 30/60/90 plan

### Week 1 — Foundation
- Build `/contractors` B2B landing page
- Install LI Insight Tag + Meta Pixel + Google tag
- Define conversion events (demo_booked, contract_signed)
- Wire Cal.com booking flow
- Claim G2 / Capterra / GetApp listings
- Set up campaign naming + UTM discipline

### Weeks 2-4 — LinkedIn launch + comparison pages
- LinkedIn campaign live ($1,500/mo)
- Ship `/vs/eagleview`, `/vs/roofr`, `/vs/hover` pages
- Launch "After-Hours Lead Loss Calculator"
- Ethan starts daily LinkedIn founder posts
- Continue X content via Higgsfield Supercomputer plan
- Add "Powered by Voxaris" footer to `/r/[publicId]` share pages

### Weeks 3-6 — Google Ads + content
- Google Ads campaign live ($1,000/mo)
- Submit conference speaker proposals (FRSA, IRE)
- Start "Roof to Roof" podcast prep (cheap to produce)
- First glossary SEO pages ship ("what is roof pitch", etc.)

### Weeks 4-8 — Meta retargeting + Noland's lighthouse
- Meta retargeting live ($500/mo)
- Noland's deployment goes live → first real case study data
- Reach out to RoofingContractor.com for founder profile
- Sponsor FRSA newsletter

### Weeks 8-12 — Scale what works
- Increase LinkedIn spend on winning ad sets (+30% increments,
  3-5 day learning waits)
- Launch first webinar with Noland's data
- Open two-sided referral program
- Submit Product Hunt launch

### KPI tracking (weekly review)

| Metric | Source | Cadence |
|---|---|---|
| Spend vs budget pacing | Platform dashboards | Daily |
| Demo CPA per channel | Platform + GA4 | Weekly |
| LinkedIn CTR + CPM | LinkedIn | Weekly |
| Comparison-page traffic | GA4 | Weekly |
| Demo → contract close rate | Cal.com + Stripe | Weekly |
| Blended CAC | Spreadsheet | Monthly |
| LTV:CAC ratio | Spreadsheet | Monthly |
| Founder LinkedIn impressions | LinkedIn | Weekly |
| North Star: paying contractors | Stripe + dashboard | Weekly |

---

## Decision tables — when to do what

### Marketing problem → which Part to consult

| Problem | Part |
|---|---|
| "Why aren't they buying?" | Part 1 (Psychology) |
| "What should we try this week?" | Part 2 (Ideas) |
| "How do we run the channel?" | Part 3 (Paid Ads) |
| "What's our north star?" | This doc top — paying contractors |
| "Should we run [tactic]?" | Part 2 filter → Part 1 model check |

### Stage → highest-ROI ideas

| Stage | Ideas to prioritize |
|---|---|
| Pre-launch (now) | #15 Engineering as Marketing, #79 Early Access Referrals, #81 Early Access Pricing |
| First 30 days | #11 Comparison Pages, #128 G2/Capterra, #18 Calculator, #39 LinkedIn Founder, #28 LinkedIn Ads |
| Post-Noland's | #65 Webinars, #74 Press, #137 Two-Sided Referrals, #78 Product Hunt |
| Scale | #4 Programmatic SEO, #62 Integration Marketing, #134 Certifications |

### Budget → channel allocation

| Budget | Allocation |
|---|---|
| $0 | LinkedIn founder posts, comparison pages, G2/Capterra, X organic, glossary SEO |
| $1K/mo | + Google Ads (test) |
| $3K/mo | + LinkedIn Ads ($1.5K) + Google ($1K) + Meta retargeting ($500) |
| $5K/mo | + scale winners by 30% increments |
| $10K+/mo | + sponsorships (FRSA), webinars, conference sponsorship |

---

## Discipline guardrails (the no-fly list)

1. **Never use the word "insurance"** anywhere customer-facing
2. **Never pitch the bundle in cold outreach** — Estimator wedge only
3. **Never run consumer-facing ads to homeowners** in Phase 1
4. **Never let pricing math become AI-generated** — deterministic in
   `lib/pricing/calculate-waste.ts`
5. **Never let homeowner see the Voxaris brand** — white-label always
6. **Never launch paid ads without conversion tracking**
7. **Never stop a campaign during the platform's learning phase**
8. **Never make >30% budget changes in a single move**
9. **Never optimize the customer page when the bottleneck is
   contractor acquisition** (Theory of Constraints)
10. **Never expand to TX/CA before Critical Mass in FL** (5-20
    paying contractors)

---

## The single sentence to remember

**The bottleneck is closed contractors. Everything in this doc
exists to move that one metric.**

Every model, every idea, every campaign — if it doesn't move
"paying FL roofing contractors" up and to the right, it's wrong
priority.

# Competitor Intelligence — EagleView & Roofr

> Last comprehensive sweep: **2026-05-18**.
> Auto-refreshed nightly by `/api/cron/competitor-scrape` (04:00 UTC)
> into Vercel Blob at `competitors/{YYYY-MM-DD}/{slug}.json`. Cron output
> surfaces a diff vs. yesterday so we see the moment they reprice or
> rename a product.
>
> Raw HTML scrapes for one-off deep dives sit at
> `/Users/voxaris/voxaris-intel/raw/` (pulled via CloakBrowser →
> stealth Chromium, bypasses Cloudflare / bot detection).

---

## TL;DR — How Voxaris wins against each

| Competitor | Their wedge | Their weakness | Our wedge |
| --- | --- | --- | --- |
| **EagleView** | Insurance-grade measurements (98.77% acc), Xactimate integration, 20+ years of imagery archive | $15–87/report pay-as-you-go, 24–48h turnaround, opaque quote-only subscription, expensive at volume | Sub-30s painted estimate at the address, no per-report charge, customer self-serve flow, transparent pricing |
| **Roofr** | All-in-one CRM + proposals + payments + Instant Estimator widget, transparent pricing | $13/report still adds up at volume, no Xactimate, "great pre-sale, weak post-sale," QuickBooks 2-way still missing, limited insurance restoration | Customer-facing self-serve estimate (their Instant Estimator is rep-facing), built-in storm intelligence, Voxaris V3 painted overlay is more confidence-inspiring than a number alone |

The blunt version: **EagleView owns insurance**, **Roofr owns retail SaaS**, and **Voxaris's wedge is the customer-facing self-serve estimate that closes in the first 5 minutes after a homeowner types their address**. Neither competitor sells that experience.

---

## EagleView

### Company

| Field | Value |
| --- | --- |
| HQ | Bothell, WA |
| Founded | 2008 |
| CEO | **Piers Dormeyer** (May 2023 → present). Ten-year EagleView veteran, previously President of Commercial Group. BS Engineering UF, MBA MIT Sloan. |
| Chairman | Chris Jurasek (former CEO, elevated when Dormeyer took CEO seat) |
| Revenue | ~**$253.6 M** (FY 2026 reported) |
| Ownership | Private equity (Vista Equity Partners since 2018) |
| Wikipedia | <https://en.wikipedia.org/wiki/EagleView_Technologies> |
| Leadership | <https://www.eagleview.com/leadership/> |

### Product line (post-2025 rebrand to "EagleView One")

| Product | What it is | Notes |
| --- | --- | --- |
| **EagleView One** | The subscription platform that swallowed everything else. Quote-only, no public pricing. | Launched 2025. Feb 2026 update added 3D walls/windows/doors at 98.77% claimed accuracy. |
| **Bid Perfect™** | Entry-level cheap report, designed to "win the bid." Upsold to a Premium Roof Report after the contract is signed. | ~$15/report at the low end |
| **Premium Roof Report** | The flagship — full pitch, material list, perimeter, drip edge, ridges, etc. | $25–50/report typical, up to $87 for complex roofs |
| **QuickView** | Trimmed-down report for fast quotes | Cheaper than Premium |
| **Inform / Assess** | Insurance-adjuster-focused workflow products | Lives inside EagleView One |
| **Residential / Commercial Reports** | Per-property flat-fee commercial; per-square residential | |

### Pricing (what they actually charge, derived from contractor reports)

- **No public list price.** Quote-only.
- **Per-report**: $15–$38 standard, up to **$87 for Premium**.
- **Residential**: priced by roof size in squares.
- **Commercial**: flat rate per property.
- **Subscription**: only worth it above ~15 reports/month; opaque.
- Field intel: *"initial quote is rarely the best offer — push back with monthly volume."*

### The big 2026 launch — 3D Property Intelligence (Feb 26, 2026)

EagleView One now ships **complete exterior 3D**: walls, windows, doors, roof penetrations. Toggle between roof and full-structure views. Aerial imagery overlaid on the 3D roof surface. **98.77%** claimed measurement accuracy. Subscription-only — no per-report unlock.

Their narrative: *"foundational data for predictive maintenance, valuation modeling, risk analysis, and next-generation AI systems."* Translation: they're pivoting from a roof-measurement vendor to an underwriting / insurance-data platform. The roofing contractor is no longer their primary customer.

### Common contractor complaints (G2 / Capterra / App Store)

1. **Turnaround time** — "24–48 hour delivery means you can't quote while on-site." App Store reviews flag this as the #1 frustration. Contractors pre-order reports the day BEFORE they need them.
2. **Cost vs. value** — *"price point can be improved," "struggle to decide if benefits outweigh price"* — recurring theme on Capterra. 20–40 roofs/month × $25–50 = real money.
3. **Customer service** — one G2 reviewer on hold for >1 hour, no agent ever connected.
4. **Newer homes** — no satellite imagery available yet → unusable.
5. **Tree obstruction** — measurements fall apart on heavily-treed lots.
6. **Contract / billing** — multiple reports of being auto-signed into a contract, billed for unused services.

### Voxaris's wedge against EagleView

- **Time-to-quote**: ~25s painted estimate vs. their 24–48 hours. We close the deal while they're still in the queue.
- **No per-report fee** to the contractor — pricing is bundled with the platform subscription.
- **Customer self-serve** — the homeowner gets their estimate in the same flow that captures the lead. EagleView only sells to the contractor.
- **Newer homes** — Voxaris V3 hybrid (Solar + Voxaris vision + OSM footprint) works on properties EagleView's imagery archive hasn't indexed yet.
- **Trade off honestly**: EagleView still has more granular insurance reports + Xactimate. That's their last fortress. We don't try to win the insurance restoration buyer — we win the retail-replacement buyer who's stuck waiting on EagleView turnaround.

---

## Roofr

### Company

| Field | Value |
| --- | --- |
| HQ | Toronto, ON (with Lisbon office) |
| Founded | 2016 |
| CEO / Co-founder | **Richard "Richy" Nelson**. 3rd-generation roofer, installer at 12, 15 years in roofing before founding Roofr. |
| CTO / Co-founder | Kevin Redman |
| Other execs | Marissa Rocha (VP Revenue), Richard Rutitis (VP BizOps), Rajiv Jhurani (SVP Product), Ryan O'Nell (CRO, appointed 2026) |
| Funding | **$43.9 M–$65.4 M total** across 6 rounds. Most recent: **Series B in Jan 2025**, led by TCV + ABC Supply. Prior $23.5 M Series A (Oct 2023, Vertical Venture Partners). Y Combinator 2017. |
| Revenue (est) | ~$34.7 M annual |
| Headcount | ~280 employees (Feb 2026), 4 continents |
| About | <https://roofr.com/about> |

### Product line

| Product | What it is |
| --- | --- |
| **Roofr Measurements** | Aerial roof measurement reports. $13–$19/report. 2-hour guaranteed on paid plans, 24h on Starter. |
| **Proposals** | Branded proposal builder + e-signature. Their original flagship. |
| **CRM** | Lead pipeline, statuses, task management. |
| **Instant Estimator** | Embeddable widget that gives the homeowner a quote from their address — at the contractor's pricing model. $149/mo add-on. |
| **Roofr Sites (Beta)** | AI-generated contractor website. $99/mo add-on. |
| **Payments** | Stripe-backed invoicing + ACH/credit collection. |
| **Material orders** | One-click order to SRS Distribution + ABC Supply + Beacon. ABC Supply is a Roofr investor — that's the strategic moat. |

### Pricing (March 2026 overhaul — public list price)

| Tier | Monthly | Per-report | Seats | Notes |
| --- | --- | --- | --- | --- |
| **Starter** | Free | $19 | unlimited | 24h delivery, no card required |
| **Essentials** | **$249/mo** ($209 annual) | $13 | 5 | 2h guaranteed delivery, unlimited proposals |
| **Scale** | **$349/mo** ($299 annual) | $13 | 10 | QuickBooks integration, advanced job boards |
| Add-ons | Instant Estimator $149/mo · Roofr Sites $99/mo · Measure+ $109–169/mo | | | |

The legacy "Pro $99 / Premium $169" tiers were retired in March 2026 — anyone quoting those is out of date.

### Common contractor complaints

1. **Volume math doesn't scale** — 100 measurements/mo × $13 = $1,300/mo on reports alone (on top of $349/mo Scale). Add Instant Estimator + Sites and you're $547/mo before reports.
2. **QuickBooks two-way sync is the #1 missing-feature complaint** on Capterra.
3. **"Great pre-sale, weak post-sale"** — no production scheduling, crew management, inventory. Roofr is a sales tool, not an ops tool.
4. **Flashing math is wrong** — system applies step/wall flashing to chimneys incorrectly per multiple G2 reviews.
5. **No Xactimate** — they're explicitly not the insurance-restoration tool.
6. **Mobile image upload limits** break the workflow for photo-heavy users.
7. **Beta program glitches** — feature releases occasionally take down workflows.

### Integration footprint

- ✅ **QuickBooks Online** — paid plans only, and it's one-way (the complaint above).
- ✅ **SRS Distribution + ABC Supply + Beacon** — native material ordering. Their moat (ABC Supply invested via Series B).
- ✅ **CompanyCam** — via integration, photo doc.
- ❌ **Xactimate** — explicitly not supported.
- ❌ **JobNimbus / AccuLynx** — competitor CRMs, no integration.

### Voxaris's wedge against Roofr

- **Customer-facing self-serve estimate** is the real wedge. Roofr's Instant Estimator is *contractor-embed* — the homeowner clicks a widget on the contractor's site. Voxaris is *Voxaris-hosted* — pitch.voxaris.io is OUR funnel, and the contractor brand is white-labeled.
- **Storm intelligence baked in** — Roofr has zero severe-weather signal. Voxaris pulls verified storm history at 1–50 mi radius / 1–365 day windows, ties it to imagery date so reps see "your customer's roof had 3 hail events since the last satellite pass."
- **Painted overlay** — Roofr's measurement reports are PDFs with line items. Voxaris hands the customer a painted satellite tile that's emotionally believable in 25 seconds.
- **Voice agent layer** — Roofr is keyboard-and-mouse only. Voxaris has Sydney (inbound voice agent) capturing leads 24/7.
- **Don't fight the CRM battle** — Roofr's pipeline + proposals + payments are mature. Position Voxaris as the *demand-capture* layer that feeds into Roofr (or AccuLynx, JobNimbus) for downstream ops. Could even integrate.

---

## EagleView vs. Roofr — head-to-head (the rep needs this in a pitch)

| Axis | EagleView | Roofr | Voxaris |
| --- | --- | --- | --- |
| **Per-report cost** | $15–$87 | $13–$19 | $0 — bundled |
| **Subscription** | Quote-only, opaque | $249–$349/mo public | Per-office, transparent (to be set) |
| **Measurement turnaround** | 24–48 h | 2 h guaranteed (paid) | **~25 s** painted, live |
| **Customer self-serve estimate** | ❌ | Instant Estimator widget ($149/mo add-on, contractor-embedded) | **Native, Voxaris-hosted** |
| **Painted/visual overlay** | 3D model in EagleView One (subscription) | Static report PDF | **Painted satellite + edges + objects, served inline** |
| **Storm intelligence** | ❌ | ❌ | **Verified events, 1–50 mi / 1–365 day, rep-adjustable** |
| **Voice agent / inbound calls** | ❌ | ❌ | **Sydney 24/7** |
| **Xactimate integration** | ✅ flagship | ❌ | ❌ (not the target buyer) |
| **CRM / proposals / payments** | Adjacent partners | Native, mature | Light — focus on demand capture |
| **Insurance restoration fit** | ✅ best in class | ❌ explicit non-goal | ❌ explicit non-goal |
| **Retail replacement fit** | OK but slow | ✅ strong | ✅ strong + faster + customer-facing |
| **Public pricing transparency** | ❌ | ✅ since March 2026 | Should match Roofr's transparency to win the comparison |

---

## Threats to watch (set up the cron diff to flag these)

1. **EagleView's per-report price drops below $20** → they're trying to choke Roofr out of retail.
2. **Roofr ships QuickBooks two-way sync** → their #1 complaint goes away, they get stronger in retail ops.
3. **Roofr launches an Instant Estimator widget that goes live on their OWN domain** (not just embeddable) → they encroach on our wedge.
4. **EagleView One drops a sub-30s "live" measurement tier** → directly attacks our speed advantage. The 3D launch is one step toward this.
5. **Either ships a voice-agent layer** → kills the Sydney moat.
6. **Roofr acquires or partners with a storm-data provider** (HailTrace, WeatherCheck, ImpactList) → closes the storm-intel gap.

The nightly cron diff catches #1, #2, #3, #4 via the pricing token + content hash. #5 and #6 will surface in press releases — `/api/cron/competitor-scrape` includes EagleView's `/press-releases/` and Roofr's `/blog`.

---

## Ops — how this file stays current

| Source | Refresh | Storage |
| --- | --- | --- |
| Nightly marketing scrape | 04:00 UTC daily | Vercel Blob `competitors/{date}/{slug}.json` |
| One-off deep dives | Manual via CloakBrowser | Local `/Users/voxaris/voxaris-intel/raw/` |
| News + funding | Manual quarterly | Edit this file directly |
| Leadership / hiring | Manual quarterly | Edit this file directly |

**To force-trigger the cron**: `curl -H "Authorization: Bearer $CRON_SECRET" https://pitch.voxaris.io/api/cron/competitor-scrape` — returns the diff against last night.

**To re-run a deep CloakBrowser scrape**: run the python block under `/Users/voxaris/voxaris-intel/` (or recreate from the README block we ran 2026-05-18). Outputs land in `voxaris-intel/raw/`.

---

## Sources

- EagleView pricing analysis — <https://roofingsoftwareguide.com/guides/eagleview-pricing/>
- EagleView Capterra reviews — <https://www.capterra.com/p/175004/EagleView-Roofing/reviews/>
- EagleView G2 reviews — <https://www.g2.com/products/eagleview-eagleview/reviews>
- EagleView 3D launch press — <https://www.eagleview.com/news-announcements/eagleview-launches-complete-exterior-interactive-remote-first-3d-property-intelligence-in-ultra-high-fidelity-now-in-eagleview-one/>
- EagleView CEO appointment — <https://www.eagleview.com/press-releases/eagleview-technologies-appoints-piers-dormeyer-to-chief-executive-officer/>
- Roofr pricing — <https://www.roofr.com/pricing>
- Roofr Capterra reviews — <https://www.capterra.com/p/208102/Roofr/reviews/>
- Roofr G2 reviews — <https://www.g2.com/products/roofr/reviews>
- Roofr Series B announcement — <https://roofr.com/blog/roofr-raises-series-b-funding-from-tcv-and-abc-supply-to-expand-roofing-crm>
- Roofr March 2026 pricing overhaul — <https://roofr.com/product-blog/updates-to-roofrs-pricing-heres-what-you-need-to-know>
- Roofr vs EagleView comparison — <https://roofingsoftwareguide.com/comparisons/roofr-vs-eagleview/>
- EagleView Pitchbook — <https://pitchbook.com/profiles/company/115538-59>
- Roofr Pitchbook — <https://pitchbook.com/profiles/company/182791-54>

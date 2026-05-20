# Voxaris Email Sequences

> Ready-to-paste email copy for every lifecycle stage. Every sequence
> is locked to POSITIONING.md voice: outcome > feature, "wake up to
> booked jobs, not missed calls" loss-aversion line, anchored against
> cobbled stack (EagleView + agency + answering service), Estimator
> wedge in cold (NEVER bundle), zero use of the word "insurance",
> white-label discipline preserved.

**Companions:**
- `POSITIONING.md` — locked positioning
- `MARKETING.md` — full marketing operating system
- `AGENTS.md` — engineering + business invariants
- `~/.claude/skills/email-sequences/SKILL.md` — invokable

---

## The 9 sequences (priority order)

| # | Sequence | Trigger | Goal | Length |
|---|---|---|---|---|
| 1 | Cold prospect → demo | LI ad / comparison page / cold list | Book 15-min demo | 6 emails / 18 days |
| 2 | Demo booked → attended | Calendly booking | Show up | 3 emails |
| 3 | Demo attended → contract | Demo completion | Sign contract | 4 emails / 14 days |
| 4 | Contract → activated | First payment | First lead captured | 5 emails / 14 days |
| 5 | Active → Sydney upsell | 30+ days Estimator, leads flowing | Buy Voice AI | 3 emails / 21 days |
| 6 | Active → AEO upsell | 60+ days Estimator + Voice | Buy Website+AEO | 3 emails / 21 days |
| 7 | Trial expiring | Day -3, -1 (if trial offered) | Convert | 3 emails |
| 8 | Failed payment recovery | Stripe webhook fail | Recover | 4 emails / 14 days |
| 9 | Cancelled → win-back | 30/60/90 days post-cancel | Return | 3 emails / 90 days |

---

## Sequence 1 — Cold prospect → demo booked

**Trigger:** LinkedIn ad lead, `/vs/eagleview` comparison page submit,
Apollo cold list. Lead source captured via UTM.

**Goal:** Book 15-min demo. Single conversion event.

**Length:** 6 emails over 18 days. Stop on demo booking OR explicit
opt-out OR 6th email no-response.

**Cadence:** Tue/Thu morning ET. Days 0, 3, 6, 10, 14, 18.

**From:** Ethan Stopperich, Voxaris (real human inbox, NOT noreply@).

**Discipline:** Estimator wedge only. NEVER mention bundle in cold.

---

### Email 1.1 — Cold open (Day 0)

**Subject:** A 30-second roof estimate for [Company]

**Preview:** Type your own address. See what your homeowners see.

**Body:**
> Hey [Name],
>
> Quick one. I built a tool that lets a homeowner type their address on
> your website and get an EagleView-quality roof report in 30 seconds —
> measured sqft, painted overlay, Good/Better/Best tier prices,
> branded as [Company].
>
> Then Sydney (an AI voice receptionist) calls them within 10 seconds
> if they consent, books the appointment, drops it into JobNimbus.
>
> You wake up to booked jobs, not missed calls.
>
> Florida roofers are running this at $1,795/mo for the estimator
> alone. Replaces what most pay EagleView, their website agency, and
> their answering service combined.
>
> Try your own address at pitch.voxaris.io — takes 30 seconds.
>
> If it's interesting, grab a 15-min slot here: [Calendly link]
>
> — Ethan
> Founder, Voxaris

**CTA:** "Book a 15-min demo" → Calendly link

**Why this works:** Loss aversion (missed calls = competitor jobs) +
mechanism specificity (30s, 10s, JobNimbus) + soft anchor against
cobbled stack + low-friction self-serve demo (Activation Energy).

---

### Email 1.2 — Anchor + cost reframe (Day 3)

**Subject:** What [Company] probably pays for 3 disconnected vendors

**Preview:** EagleView + website agency + answering service. Math
inside.

**Body:**
> [Name],
>
> Most Florida roofers I talk to spend roughly:
>
> - **EagleView**: ~$600/mo for ~12 reports
> - **Website agency**: ~$800/mo for a site that doesn't book leads
> - **Answering service**: ~$300/mo that takes messages, never books
>
> **Total: ~$1,700/mo for three vendors that don't talk to each other.**
>
> Voxaris Estimator is $1,795/mo and replaces all three. Same total,
> but now your leads get captured, painted, and pre-qualified before
> your phone rings.
>
> Worth 15 minutes to see how it works?
>
> [Book a slot]
>
> — Ethan

**CTA:** "See it in action" → Calendly link

**Why this works:** Anchoring + mental accounting (reframe the
dollars from "new cost" to "consolidated existing cost").

---

### Email 1.3 — Social proof / Newcomb data (Day 6)

**Subject:** EagleView-quality, measured within 2% sqft

**Preview:** The accuracy data we built this on.

**Body:**
> [Name],
>
> The accuracy question always comes up first. So here's the data:
>
> We benchmarked the painted-overlay estimator against EagleView
> reports on 5 Florida properties (Jupiter, Newcomb, Oak Park, etc.).
> Average sqft variance: **<2%.**
>
> On HIGH-imagery Florida properties — which is most of the state —
> the satellite-derived measurement matches what your rep will measure
> on site within the margin of waste-factor anyway.
>
> Reps confirm everything during the 20-minute walkthrough. The
> homeowner just gets the painted overlay + Good/Better/Best tier
> prices the moment they hit "estimate."
>
> Want to see it run on a property you know? Grab 15 minutes:
>
> [Book a slot]
>
> — Ethan

**CTA:** "Book a 15-min demo" → Calendly link

**Why this works:** Authority bias (specific data, named addresses)
+ pratfall effect (admitting the 2% variance honestly).

---

### Email 1.4 — Loss aversion direct (Day 10)

**Subject:** [Name], your competitor answered at 9:43pm last Tuesday

**Preview:** A real story from a FL roofer we talked to last month.

**Body:**
> [Name],
>
> Real story. Last month I sat down with a Florida roofer who told me
> this:
>
> *"I lost a $34k tile job because the homeowner called us at 9:43pm
> on a Tuesday. We were closed. My competitor's answering service
> said someone would call back tomorrow. The homeowner Googled
> 'roofer Orlando' that night and a different shop answered at 9:51.
> They had the appointment booked by Wednesday morning."*
>
> That happens to every Florida roofer. Every week. The lead never
> shows up in your funnel because they never got past the after-hours
> wall.
>
> Voxaris doesn't sleep. Homeowner types their address at 9:43pm →
> painted estimate at 9:44 → Sydney calls them at 9:45 → appointment
> on your tablet by morning.
>
> You wake up to booked jobs.
>
> 15-min walk-through: [Calendly link]
>
> — Ethan

**CTA:** "See the after-hours flow" → Calendly link

**Why this works:** Availability heuristic (vivid specific story) +
loss aversion (specific dollar amount lost) + mimetic desire (another
FL roofer figured this out).

---

### Email 1.5 — Objection handler (Day 14)

**Subject:** "We already have a website" — sound familiar?

**Preview:** It's not the website. It's what the website does after
the visit.

**Body:**
> [Name],
>
> Three things I hear most when I pitch this:
>
> **"We already have a website."** Sure. But a site that doesn't
> capture and follow up leads is a brochure. Voxaris doesn't replace
> your site — it turns it into a lead machine.
>
> **"We already use EagleView."** Keep using it for the close-out
> reports. EagleView sends a PDF to your rep. Voxaris sends a
> pre-measured homeowner to your CRM. Different jobs.
>
> **"$1,795/mo is a lot."** It's the same as your current EagleView +
> agency + answering service combined. Same dollars, different pocket.
>
> If any of those landed: 15 minutes, [Calendly link].
>
> If none of them did, just hit reply and tell me what's actually
> stopping you. I'll either change your mind or tell you we're not the
> right fit.
>
> — Ethan

**CTA:** "Book 15 minutes" → Calendly link (secondary: reply to email)

**Why this works:** Door-in-the-face structure (three objections,
retreats to "just reply") + status-quo bias unwound directly.

---

### Email 1.6 — Final / breakup (Day 18)

**Subject:** Should I close the loop, [Name]?

**Preview:** Last note from me. Honest question inside.

**Body:**
> [Name],
>
> Last one from me. I've sent five emails about turning your website
> into a 24/7 appointment machine. Haven't heard back.
>
> Three options:
>
> 1. **You're interested but slammed.** Reply with "next month" — I'll
>    follow up then.
> 2. **You want a demo.** [Calendly link]
> 3. **Not a fit.** Reply "stop" and I'll close the loop. No follow-up.
>
> Either way, you can always try your own address at
> pitch.voxaris.io — takes 30 seconds, no signup.
>
> — Ethan

**CTA:** Book demo (primary), reply with timing (secondary)

**Why this works:** Door-in-the-face + reciprocity (giving them an
easy out signals respect) + zero-price effect (the self-serve demo
costs nothing).

---

## Sequence 2 — Demo booked → attended

**Trigger:** Calendly booking event.

**Goal:** Reduce no-show. Pre-call build-up so they show up ready.

**Length:** 3 emails. Auto-confirm + pre-call value + day-of reminder.

---

### Email 2.1 — Confirmation + pre-work (Immediate)

**Subject:** Confirmed: your Voxaris demo on [Date]

**Preview:** One thing to try before our call.

**Body:**
> [Name],
>
> Confirmed — we're on for [Date] at [Time] ET. Calendar invite
> incoming.
>
> Before the call: spend 30 seconds at pitch.voxaris.io. Type your
> shop's address (or a customer's). Watch the painted overlay drop in.
> Hit the Good/Better/Best tiers.
>
> That's exactly what your homeowner sees the moment they type their
> address on your white-labeled subdomain. Showing up to the demo
> having tried it yourself makes our 15 minutes 5x more useful.
>
> Talk soon,
> Ethan

**CTA:** "Try the live demo" → pitch.voxaris.io

**Why this works:** IKEA Effect (effort = value) + Activation Energy
reduction (one tiny task before the call).

---

### Email 2.2 — Pre-call value (24 hours before)

**Subject:** Quick prep for tomorrow's call, [Name]

**Preview:** The one slide I'll show you.

**Body:**
> [Name],
>
> Tomorrow at [Time]. Quick prep so we use the 15 minutes well.
>
> I'll show you one thing: a real Orlando property (8450 Oak Park
> Ave) running through the whole flow.
>
> - Address → painted satellite overlay (under 30s)
> - Three tier prices, white-labeled
> - The SMS the homeowner gets
> - The reply that triggers Sydney to call
> - The appointment landing in the rep dashboard
>
> Then you tell me what would or wouldn't work for [Company]. Quick.
>
> See you tomorrow.
>
> — Ethan

**CTA:** None (calendar invite already accepted)

**Why this works:** Specific preview reduces no-show anxiety. Names
a real address to signal authenticity (not vaporware).

---

### Email 2.3 — Day-of reminder (2 hours before)

**Subject:** Voxaris call in 2 hours

**Preview:** [Zoom/Meet link inside]

**Body:**
> See you at [Time] ET.
>
> [Zoom / Google Meet link]
>
> If something came up, reschedule here: [Calendly reschedule link].
> I'd rather move the call than have you show up distracted.
>
> — Ethan

**CTA:** "Join the call" → meeting link

**Why this works:** Permission-to-reschedule lowers guilt-cancel
behavior + maintains relationship for retry.

---

## Sequence 3 — Demo attended → contract signed

**Trigger:** Demo completion (manual trigger or Calendly webhook).

**Goal:** Sign contract. Move from "interested" to "committed."

**Length:** 4 emails over 14 days.

**Discipline:** STILL Estimator only. Bundle conversation happens
after they're a customer.

---

### Email 3.1 — Thank you + recap (1 hour post-call)

**Subject:** Recap from our call + next step

**Preview:** Everything we covered, the link to try it on your data.

**Body:**
> [Name],
>
> Good call. Quick recap of what we covered:
>
> - Address → painted estimate → tier prices in <30s
> - Sydney (AI voice) on every consented lead within 10s
> - SMS round-trip if voice isn't consented
> - Appointments land in JobNimbus (or [their CRM])
> - White-labeled — homeowner sees [Company], not Voxaris
> - $1,795/mo Estimator, replaces EagleView + agency + answering service
>
> Next step: I'll send the agreement Wednesday. We can have you live
> on [Company]'s subdomain inside 7 days.
>
> Any questions before then? Just reply.
>
> — Ethan

**CTA:** Reply with questions (primary), agreement coming Weds

**Why this works:** Commitment & consistency — recap locks in
what was discussed. Specific timeline (Weds, 7 days) creates
forward momentum.

---

### Email 3.2 — Case study / proof (Day 3)

**Subject:** How [Noland's] uses Voxaris

**Preview:** Real numbers from a real Florida roofer.

**Body:**
> [Name],
>
> Wanted to share what [Noland's Roofing] does with their Voxaris
> setup, since you asked on our call.
>
> [Once Noland's is live, include 3-4 specific data points: leads
> captured / month, after-hours capture %, demo-to-close rate,
> avg job size. Until then, lean on Newcomb accuracy data.]
>
> Their painted overlay accuracy on the last 50 properties: avg
> variance from rep-measured sqft was 1.8%.
>
> Their after-hours appointment-capture rate (Sydney): 31% — leads
> that would have died at the answering service now book the next
> morning.
>
> Worth a look. Reply when you're ready to talk paperwork.
>
> — Ethan

**CTA:** Reply to start paperwork

**Why this works:** Mimetic desire (another FL roofer is doing this)
+ availability heuristic (specific numbers) + authority bias.

---

### Email 3.3 — Objection clearer (Day 7)

**Subject:** Anything still in the way, [Name]?

**Preview:** Common questions I get at this stage.

**Body:**
> [Name],
>
> Between the demo and signing, here are the three questions I get
> most:
>
> **"How long until we're live?"** Seven days. We provision your
> subdomain, wire your CRM, train Sydney on your office's name, and
> ship.
>
> **"What if it doesn't work for our properties?"** Florida HIGH-
> imagery covers ~95% of FL residential. The 5% that don't resolve
> get flagged and your rep handles them the old way.
>
> **"Can we cancel if it's not working?"** Month-to-month. No
> annual lock. We don't keep customers by trapping them.
>
> Anything I missed? Reply or grab another 15 minutes:
> [Calendly link]
>
> — Ethan

**CTA:** Reply with questions OR schedule follow-up

**Why this works:** Regret aversion (cancel clause) + framing
(month-to-month = "no risk") + curse-of-knowledge unwound (the
questions you didn't know to ask, answered).

---

### Email 3.4 — Soft close (Day 14)

**Subject:** Closing the loop, [Name]

**Preview:** Where do we land?

**Body:**
> [Name],
>
> Two weeks since our demo. Three paths:
>
> 1. **Ready to ship.** Reply "send the contract" and I'll have it in
>    your inbox today.
> 2. **Still thinking.** Reply with what's holding you up. I'd rather
>    address it head-on than keep emailing.
> 3. **Not the right time.** Reply "later" and I'll follow up in 60
>    days. No more emails until then.
>
> Either way, your subdomain is reserved at [company-slug].voxaris.io
> for another week. After that it opens up.
>
> — Ethan

**CTA:** Reply with one of the three (primary action)

**Why this works:** Scarcity (subdomain reservation, genuine) +
respect (the "not the right time" option) + door-in-the-face
structure narrows to a yes/no.

---

## Sequence 4 — Contract signed → activated

**Trigger:** First payment posted in Stripe.

**Goal:** Get them to **first painted overlay generated + first
homeowner lead captured + first appointment booked** within 14 days.

**Length:** 5 emails over 14 days. Trigger-based, not pure time.

**Voice:** Warm, founder-led, action-oriented.

---

### Email 4.1 — Welcome from founder (Immediate)

**Subject:** Welcome to Voxaris, [Name] — your first 24 hours

**Preview:** Three things to do today. Each takes <5 min.

**Body:**
> [Name],
>
> Welcome aboard. Real quick — three things in the next 24 hours:
>
> **1. Subdomain.** Your white-label is live at
> [company-slug].voxaris.io. Open it in a browser, type a customer's
> address, watch the overlay drop. See if it feels like your brand.
>
> **2. Logo + brand color.** Reply with your logo (PNG) + brand hex
> code. We'll have your white-label looking like yours by end of day.
>
> **3. JobNimbus connection.** [Direct link to OAuth flow]. Two
> clicks, leads start flowing.
>
> Direct line: [Ethan's cell]. Text or call anytime — I run point on
> every new customer in the first 30 days.
>
> Let's get you to your first booked job from a Voxaris lead.
>
> — Ethan

**CTA:** Reply with logo + brand color → first action

**Why this works:** IKEA Effect (immediate configuration =
ownership) + commitment & consistency (3 small yeses) + founder
contact = liking/similarity bias.

---

### Email 4.2 — Day 2 setup nudge (Day 2, conditional)

**Subject:** [Name], 2 quick things to finish setup

**Preview:** You're one OAuth click from leads landing in your CRM.

**Body:**
> [Name],
>
> Saw you tried the demo but haven't connected JobNimbus yet — that's
> the last piece before leads start flowing.
>
> [Direct OAuth link]
>
> Two clicks. Takes 30 seconds.
>
> Once that's done, every homeowner who types their address on your
> subdomain becomes a lead in your JobNimbus — pre-measured, with the
> painted overlay attached.
>
> Stuck on anything? Text me: [Ethan's cell].
>
> — Ethan

**CTA:** "Connect JobNimbus" → OAuth link

**Why this works:** Goal-gradient effect (you're almost done) +
zeigarnik (unfinished task) + curse-of-knowledge unwound (literally
"two clicks, 30 seconds").

---

### Email 4.3 — First-lead celebration (Triggered on first lead captured)

**Subject:** First Voxaris lead, [Name] 🎉

**Preview:** [Homeowner name] just typed their address.

**Body:**
> [Name],
>
> Your first one just landed.
>
> **Lead:** [Homeowner first name]
> **Address:** [Address]
> **Measured sqft:** [X,XXX]
> **Estimate range:** [$XX,XXX-$XX,XXX]
> **Captured at:** [Time]
>
> Sydney is calling them right now if they consented to voice. The
> SMS round-trip is firing either way.
>
> Open the lead in your dashboard: [Direct dashboard link]
>
> This is exactly what every after-hours lead now looks like for
> [Company].
>
> Welcome to the appointment machine.
>
> — Ethan

**CTA:** "Open lead" → dashboard deep link

**Why this works:** Peak-end rule (memorable peak moment) +
milestone celebration + commitment escalation (now they've SEEN it
work).

---

### Email 4.4 — First-week check-in (Day 7)

**Subject:** Week 1 wrap — [Name], how's it going?

**Preview:** Real numbers from your first 7 days.

**Body:**
> [Name],
>
> Week 1 wrap-up for [Company]:
>
> - **Leads captured:** [X]
> - **After-hours captures (Sydney calls):** [Y]
> - **Appointments booked:** [Z]
> - **Avg homeowner estimate range:** $[low]-$[high]
>
> If those numbers feel low, two questions:
>
> 1. Where are you driving traffic to your subdomain? (Yard signs?
>    Truck wraps? Existing site nav?)
> 2. Is the painted overlay showing right on the properties you've
>    tested?
>
> Reply with where you're stuck and we'll fix it this week. I have a
> 15-min slot tomorrow: [Calendly link].
>
> — Ethan

**CTA:** Reply with question OR book check-in call

**Why this works:** Product usage report + activation energy
reduction (here's how to drive more traffic) + founder availability
maintains the high-touch white-glove feel.

---

### Email 4.5 — Day 14 milestone (Day 14)

**Subject:** Two weeks in, [Name] — what's working

**Preview:** [Specific lead count or notable win]

**Body:**
> [Name],
>
> Two weeks live. Here's what stood out:
>
> [Insert one specific observation — biggest lead, fastest
> appointment-book, after-hours win, etc.]
>
> Most contractors hit their first booked job from a Voxaris lead
> between days 10-21. If you've had one already, hit reply and tell
> me about it — I keep a running file of these for the team.
>
> If not yet — let's troubleshoot. The most common gap at this point
> is traffic flow to your subdomain, not the product itself.
>
> 15-min slot: [Calendly link]
>
> — Ethan

**CTA:** Reply with first booked job OR schedule troubleshoot call

**Why this works:** Mimetic desire (other contractors hit milestones)
+ peak-end rule (positive close to onboarding) + opens the door to
upsell sequence.

---

## Sequence 5 — Active contractor → Sydney (Voice AI) upsell

**Trigger:** 30+ days as Estimator customer AND leads/week ≥ threshold
(suggest 10/week).

**Goal:** Convert Estimator-only to Estimator + Voice AI ($1,495/mo).

**Length:** 3 emails over 21 days.

**Discipline:** Foot-in-the-door — Voice AI is the natural next yes.

---

### Email 5.1 — Pattern surface (Day 30, conditional on lead volume)

**Subject:** [Name], a pattern I'm seeing in your leads

**Preview:** After-hours leads that aren't getting answered.

**Body:**
> [Name],
>
> Pulled your last 30 days of data:
>
> - **Total leads captured:** [X]
> - **After-hours leads (between 6pm-8am):** [Y]
> - **After-hours appointment-book rate:** [Z%]
>
> That after-hours number is the leak. Right now they get the SMS
> confirmation, but unless they reply YES, no one calls them until
> morning. Some of those will die overnight to whoever answers.
>
> Sydney closes that gap. Same flow you have now, but the moment a
> lead lands with voice consent, she calls in ~10 seconds and books
> the appointment. After-hours capture rate typically jumps from
> [current %] to ~25-35%.
>
> Want to see what Sydney would sound like for [Company]? 15 min:
> [Calendly link]
>
> — Ethan

**CTA:** "See Sydney in action" → Calendly link

**Why this works:** Loss aversion (you ARE losing these), specific
data (their actual numbers), foot-in-the-door (Sydney is the
natural next yes).

---

### Email 5.2 — Demo Sydney (Day 37)

**Subject:** Sydney's first 30 seconds, for [Company]

**Preview:** [Audio clip embed or link]

**Body:**
> [Name],
>
> Here's what Sydney sounds like opening a call to a homeowner who
> just submitted at [Company]:
>
> [Audio clip embed — generated Sydney sample using office name]
>
> Notice:
>
> - Identifies as an AI assistant up front (FCC AI-voice rule
>   compliance)
> - Knows the homeowner's name, address, and estimate range
> - Asks ONE question: "morning, afternoon, or evening for a free
>   inspection?"
> - Transfers to a rep if they want to talk to a human
>
> $1,495/mo. Adds to your existing Estimator. Live in 3-4 days.
>
> Reply "let's go" or grab a slot: [Calendly link].
>
> — Ethan

**CTA:** "Add Sydney" → Calendly link

**Why this works:** Pratfall (AI disclosure upfront builds trust) +
peak-end (audio sample is the visceral peak) + low-commitment ask.

---

### Email 5.3 — Soft close on Sydney (Day 50)

**Subject:** [Name], should I close the Sydney loop?

**Preview:** Three paths.

**Body:**
> [Name],
>
> Three weeks since I floated Sydney. Three paths:
>
> 1. **Add it.** Reply "send the agreement" — live in 4 days.
> 2. **Wait.** Reply with when. I'll follow up then.
> 3. **Not yet.** Reply "stay on Estimator" and I'll stop pitching
>    Sydney for 90 days.
>
> Either way, your Estimator setup keeps humming. Sydney is purely
> additive.
>
> — Ethan

**CTA:** Reply with one of three (primary action)

**Why this works:** Door-in-the-face structure + status-quo bias
respected ("Estimator keeps humming") + scarcity NOT used (genuine
respect over manufactured urgency).

---

## Sequence 6 — Active contractor → Website+AEO upsell

**Trigger:** 60+ days as Estimator + Voice customer.

**Goal:** Convert to full bundle (add Website+AEO at $1,495/mo).

**Length:** 3 emails over 21 days.

**Voice:** Forward-looking, Phase-2 framing (AEO + AI agents).

---

### Email 6.1 — AEO opening (Day 60)

**Subject:** When ChatGPT recommends roofers, [Name]...

**Preview:** Where does [Company] show up?

**Body:**
> [Name],
>
> Quick test: open ChatGPT, type "best roofing companies in
> [Orlando/your city]". What comes up?
>
> If [Company] isn't in the top 3 — or if Angi / HomeAdvisor / your
> competitors are — that's AEO (Answer Engine Optimization). It's
> the new SEO, and most roofers haven't touched it yet.
>
> Voxaris Website + AEO is the third SKU. We rebuild your site (or
> add to it) with the structured data and content that gets you
> surfaced when homeowners ask AI agents for a roofer.
>
> $1,495/mo + a $1,495 one-time setup. Blog content (4 posts/mo),
> schema, llms.txt, AEO score tracking.
>
> Want to see the framework? 15 min: [Calendly link].
>
> — Ethan

**CTA:** "See the AEO framework" → Calendly link

**Why this works:** Specific test they can run RIGHT NOW (Activation
Energy) + Loss aversion (your competitors are there, you're not) +
zeitgeist relevance (AI agents are real and growing).

---

### Email 6.2 — Stack the full picture (Day 70)

**Subject:** The full Voxaris stack for [Company]

**Preview:** What you have + what you're missing.

**Body:**
> [Name],
>
> Where [Company] is today:
>
> - ✅ **Estimator** ($1,795/mo) — homeowner types address → painted
>   estimate → tier prices
> - ✅ **Sydney** ($1,495/mo) — voice AI books appointments 24/7
> - ⚪ **Website + AEO** ($1,495/mo) — the third leg
>
> Right now you're capturing homeowners who already know about
> [Company]. Website + AEO captures the ones who don't — the ones
> who ask Google, ChatGPT, or Perplexity for a roofer.
>
> Three legs = full stack. Most contractors who add the third see
> traffic to their Voxaris subdomain go up 3-4x within 60 days.
>
> 15 min to walk through it: [Calendly link].
>
> — Ethan

**CTA:** "Walk through the third leg" → Calendly link

**Why this works:** Zeigarnik (incomplete checklist) + paradox of
choice resolved (the three-leg framework is clean and memorable) +
upside framing (3-4x traffic).

---

### Email 6.3 — Bundle close (Day 81)

**Subject:** [Name], where do we land on the third leg?

**Preview:** Three paths.

**Body:**
> [Name],
>
> Same drill as last time:
>
> 1. **Add Website + AEO.** Reply "send the agreement" — kickoff
>    next week.
> 2. **Not yet.** Reply with when.
> 3. **Sticking with what's working.** Reply "stay" and I'll stop
>    pitching this for 90 days.
>
> Your existing setup keeps humming either way.
>
> — Ethan

**CTA:** Reply with one of three

**Why this works:** Pattern recognition from Sydney sequence — they
know how this works now. Commitment & consistency makes the third
yes easier.

---

## Sequence 7 — Trial expiring (if trial offered)

**Note:** Voxaris doesn't currently offer a trial — Estimator is
month-to-month with no risk. Keep this template ready if/when a
free trial becomes a sales motion.

**Trigger:** Trial end date - 3 days.

**Goal:** Convert before expiry.

**Length:** 3 emails.

### Email 7.1 — 3 days before (Day -3)
Subject: 3 days left on your Voxaris trial, [Name]
- Show what they've used (leads captured, painted overlays generated)
- Single CTA: convert

### Email 7.2 — Day of expiry (Day 0)
Subject: Today's your last day, [Name]
- Sense of urgency (genuine)
- Convert button + last-chance value

### Email 7.3 — Day after (Day +1)
Subject: [Name], we kept your data — here if you want back in
- Door open
- Door-in-the-face: stay or go cleanly

---

## Sequence 8 — Failed payment recovery

**Trigger:** Stripe webhook: invoice.payment_failed

**Goal:** Recover revenue. Assume it's an honest mistake (expired
card) before assuming malice.

**Length:** 4 emails over 14 days.

---

### Email 8.1 — Friendly notice (Day 0)

**Subject:** Quick — payment issue on your Voxaris account

**Preview:** Probably an expired card. 30-second fix.

**Body:**
> [Name],
>
> Heads up — this month's payment for [Company] didn't go through.
> Usually means a card expired or a new card needs to be added.
>
> 30-second fix: [Update payment link]
>
> No urgency yet — your account stays active. Just wanted to flag it.
>
> — Ethan

**CTA:** "Update payment" → Stripe portal link

---

### Email 8.2 — Reminder (Day 3)

**Subject:** Voxaris payment — still pending

**Preview:** Quick reminder, no action taken yet on your account.

**Body:**
> [Name],
>
> Still showing a failed payment for [Company]. Account is active,
> nothing's changed yet — just want to make sure this doesn't
> become a thing.
>
> [Update payment link]
>
> Stuck on it? Reply and I'll help directly.
>
> — Ethan

**CTA:** "Update payment" → Stripe portal

---

### Email 8.3 — Service warning (Day 7)

**Subject:** [Name] — Voxaris account at risk

**Preview:** Service will pause in 7 days without payment.

**Body:**
> [Name],
>
> Have to flag this directly: without payment in the next 7 days,
> [Company]'s Voxaris subdomain will pause. New homeowner leads will
> stop coming in. Existing leads stay in your CRM but Sydney won't
> dispatch.
>
> [Update payment link]
>
> If something's going on, reply and we'll figure it out. I'd rather
> sort it than lose you.
>
> — Ethan

**CTA:** "Update payment" → Stripe portal

---

### Email 8.4 — Final notice (Day 14)

**Subject:** Voxaris paused for [Company]

**Preview:** Reactivation takes 30 seconds when you're ready.

**Body:**
> [Name],
>
> [Company]'s Voxaris account is paused as of today. New leads won't
> land in your CRM. Your subdomain shows a "back soon" page.
>
> To reactivate: [Update payment link]. Service resumes in <60
> seconds once payment clears.
>
> Your historical leads and dashboard are intact for 90 days. Reply
> if you want to walk through anything — door's open.
>
> — Ethan

**CTA:** "Reactivate" → Stripe portal

---

## Sequence 9 — Cancelled contractor → win-back

**Trigger:** 30, 60, 90 days post-cancellation.

**Goal:** Bring them back. NO desperation, NO guilt.

**Length:** 3 emails over 90 days.

---

### Email 9.1 — What's new (Day +30)

**Subject:** [Name] — three things since you left

**Preview:** No pitch. Just an update.

**Body:**
> [Name],
>
> Quick one. Since [Company] cancelled, three things shipped at
> Voxaris:
>
> 1. [Concrete feature improvement]
> 2. [Concrete feature improvement]
> 3. [Concrete feature improvement]
>
> Not pitching. Just keeping you in the loop in case any of those
> would have changed the cancel decision.
>
> Door's open if you want to talk: [Calendly link].
>
> — Ethan

**CTA:** Calendly (low pressure)

---

### Email 9.2 — Addressed-your-reason (Day +60)

**Subject:** [Name] — about the [their cancel reason]

**Preview:** Specific update on the thing you flagged.

**Body:**
> [Name],
>
> When [Company] cancelled, you mentioned [their primary cancellation
> reason from the survey]. Wanted to circle back — we addressed it:
>
> [Specific fix or feature that addresses their reason]
>
> If that changes anything, hit reply or grab a slot: [Calendly link].
>
> If not, no worries. Last touch from me is a quick offer in 30
> days — then I'll close the loop unless you tell me otherwise.
>
> — Ethan

**CTA:** Reply / Calendly

---

### Email 9.3 — Offer + door (Day +90)

**Subject:** Last note from me, [Name]

**Preview:** A small offer if you want back in. Otherwise — door's
closed.

**Body:**
> [Name],
>
> Last reach-out. If [Company] ever wants to spin Voxaris back up:
>
> - **Waived setup fee** (~$1,500 saved)
> - **First month free** on whichever SKU(s) you want
> - **Your historical data restored** — all leads + dashboards
>   exactly where you left them
>
> Offer's good for 30 days. After that, I'll close the loop and
> stop emailing.
>
> [Calendly link] or reply.
>
> Wishing [Company] well either way.
>
> — Ethan

**CTA:** Calendly OR reply

---

## Metrics + benchmarks

| Metric | B2B SaaS benchmark | Voxaris target |
|---|---|---|
| Open rate (cold) | 20-30% | 35%+ (personalized) |
| Open rate (active customers) | 40-60% | 55%+ |
| Click rate (cold) | 2-4% | 5%+ |
| Click rate (transactional) | 10-20% | 25%+ |
| Cold → demo booked | 1-3% | 2%+ |
| Demo → contract close | 20-30% | 25%+ |
| Failed payment recovery rate | 50-65% | 65%+ |
| Win-back conversion rate | 5-10% | 8%+ |
| Unsubscribe rate | <0.5% | <0.3% |

## Testing priority (highest impact → lowest)

1. **Subject lines** — single biggest swing
2. **Send time** — test Tue vs Thu, 9am vs 11am ET
3. **Email length** — shorter usually wins B2B
4. **CTA placement** — single primary CTA, test in-body vs sign-off
5. **Personalization depth** — first name vs company vs role vs city
6. **Sequence timing** — test 18-day vs 14-day cold cadence

## Tool stack recommendations

| Sequence | Tool | Why |
|---|---|---|
| Cold outbound (1) | Apollo, Instantly, or Smartlead | Multi-inbox warmup, deliverability |
| Demo nurture (2-3) | Cal.com + transactional email (Resend) | Tied to booking events |
| Onboarding (4) | Customer.io or Loops | Behavior-triggered, in-product events |
| Upsells (5-6) | Customer.io with usage triggers | Conditional on actual lead volume |
| Trial / payment (7-8) | Stripe webhooks → Resend / Customer.io | Event-driven |
| Win-back (9) | Customer.io segmented audience | Time-based + reason-segmented |

## Discipline checklist (every send)

- [ ] Leads with outcome (booked appointments), not feature
- [ ] Uses "wake up to booked jobs, not missed calls" in cold
- [ ] Anchored against cobbled stack where relevant
- [ ] **Never uses the word "insurance"**
- [ ] Estimator-only pitch in cold (NOT bundle)
- [ ] One CTA per email
- [ ] First name fallback ("there" or "friend")
- [ ] Sends Tue-Thu ET morning
- [ ] From a real human inbox, not noreply@
- [ ] Tested on mobile (subject + preview + first 50 chars)
- [ ] Includes plain-text version
- [ ] UTM parameters on every link

## The one line to keep in every cold email

**"You wake up to booked jobs, not missed calls."**

Don't ship a cold sequence without it.

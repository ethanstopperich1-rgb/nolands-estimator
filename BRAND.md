# Noland's Brand Spec

Locked May 2026. This file is the source of truth for visual + copy
decisions on `estimate.nolandsroofing.com`. If anything in the
codebase contradicts it, the code is wrong.

## Where the brand comes from

Extracted from Noland's printed marketing assets (door hangers + the
existing `nolandsroofing.com` site). Source images live in the
shared review folder; not committed to this repo because they're
Noland's IP, not ours.

## Color palette (the lock)

Hex codes are in `app/globals.css` `@theme` under the
`--color-noland-*` namespace. Don't duplicate them anywhere else.

| Token | Hex | Role |
|---|---|---|
| `--color-noland-black` | `#07080A` | Hero background, primary surface |
| `--color-noland-black-soft` | `#0F1115` | Card backgrounds one notch up from hero |
| `--color-noland-ink` | `#1A1D24` | Secondary surface |
| `--color-noland-fire` | `#E84A1F` | **Primary accent** — the cursive "Roofing" red-orange |
| `--color-noland-fire-light` | `#FF6B3D` | Hover / glow states |
| `--color-noland-fire-deep` | `#B5340E` | Pressed / focused / dark-mode buttons |
| `--color-noland-silver` | `#C8C9CD` | The metallic NOLAND'S wordmark base |
| `--color-noland-silver-light` | `#E8E9ED` | Highlight on chrome wordmark gradient |
| `--color-noland-silver-dark` | `#6E7178` | Shadow on chrome wordmark gradient |
| `--color-noland-medal` | `#C5A87B` | "#1 Choice" seal accent / gold-ish elements |
| `--color-noland-storm` | `#1A1F2B` | Storm-sky photo overlay tint |
| `--color-noland-lightning` | `#B8E0FF` | Lightning blue-white accent |

## Typography

- **Display sans (for "NOLAND'S" wordmark + huge phone numbers):**
  heavy condensed sans. Closest open webfont: **Bebas Neue** or
  **Anton**. Use with CSS metallic-silver gradient
  (`linear-gradient(180deg, #E8E9ED 0%, #6E7178 50%, #C8C9CD 100%)`)
  to reproduce the wordmark sheen.
- **Cursive accent (for "Roofing", section titles like "Storm Damage"
  / "Renovations"):** flowing script in `--color-noland-fire`. Use
  **Allura**, **Pinyon Script**, or **Great Vibes**.
- **Body:** DM Sans — readable on phones, already in the stack from
  the Voxaris upstream.
- **Vertical orientation text** ("SEVERE WEATHER SPECIALISTS" running
  up the side): Bebas Neue with `writing-mode: vertical-rl` +
  `letter-spacing: 0.2em`.

## Voice + copy

Noland's brand voice is **neighborly + credentialed**. Local family
of contractors who happen to be at the top of the FL industry.

**Do:**
- Be specific. "Lake, Orange, Volusia, Manatee, Lee counties."
- Reference Florida weather explicitly. "Florida's harshest weather."
- Use action verbs. "Call us." "Get a real number."
- Speak to homeowners, not industry. "Your roof." Not "the asset."

**Don't:**
- ❌ Use the word **"insurance"** anywhere customer-facing. Use
  "provider" or "carrier". Florida § 627.7152 trip-wire — same locked
  rule as Sydney's prompt.
- ❌ Stack credentials without context. List them, but anchor each
  to a homeowner benefit.
- ❌ Use generic contractor copy. "Quality you can trust" / "We care
  about every job" — these are everywhere. Noland's is specific.
- ❌ Use cyan/teal/purple — those are Voxaris-internal colors.

## Hero promise (locked)

```
Eyebrow:   Clermont's #1 choice · Severe Weather Specialists
Headline:  Get your roof priced in 30 seconds.
Subhead:   We measure your roof from satellite imagery and price it
           on the spot. Free, no obligation, no pressure.
Close:     No callbacks until you ask.
```

Spanish version (Florida-natural, "tu" not "usted"):
```
Eyebrow:   La #1 opción de Clermont · Especialistas en Clima Severo
Headline:  Conoce el precio de tu techo en 30 segundos.
Subhead:   Medimos tu techo desde imágenes satelitales y te damos el
           precio al instante. Gratis, sin compromiso, sin presión.
Close:     Sin llamadas hasta que las pidas.
```

## Photography mood

- **Hero:** dramatic FL storm scene (lightning over a roof) — matches
  the back of the door hanger.
- **Material section:** clean close-up shots of shingle / tile / metal
  / solar.
- **Trust band:** photos of actual office buildings or branded trucks
  when available.
- **Avoid:** stock smiling-contractor imagery, generic suburban
  hero shots, anything that could be any roofer in any state.

## What goes on the page (priority order)

1. **Hero with address input** — single focused conversion path
2. **The promise + no-callback line** — answers homeowner objection #1
3. **Credential band** — CertainTeed Premier Contractor (only 2 in
   Central FL), BBB A+, Top 150, Select ShingleMaster, "Since 2011" —
   short text labels, not logos until Noland's sends the logo SVGs.
   (Verified May 2026 against Noland's printed estimate form: lead
   with Premier credential, not Triple Crown — Premier is the higher-
   tier authority claim and the one their reps anchor on in person.)
4. **Services grid** — Roofing / Storm Damage / Renovations /
   **Solar** (new May 2026)
5. **"Severe Weather Specialists" vertical-text emphasis** — the
   signature visual element on Noland's door hangers; reproduce on
   the web
6. **Phone CTA** — (352) 500-ROOF, big, click-to-call on mobile
7. **Programs band** — Best Price Guarantee +$100 (excludes
   tile/metal), $200 + Publix gift card referral, 24-hour emergency
8. **Service area** — Lake / Orange / Volusia / Osceola / Sumter /
   Polk / Seminole / Flagler / Manatee / Lee counties
9. **Footer credentials** — license #s (CCC1335461, CBC1268061),
   "Since 2011," social links, BBB seal
   (CBC1268061 verified May 2026 against Noland's printed estimate
   form. Previous docs had CBC1262165 — that was a typo / OCR error.)

## Asset checklist (need from Noland's)

- [ ] Vector logo SVG — both "Noland's Roofing" and "Noland's Roofing
      Solar" variants
- [ ] Exact metallic-silver wordmark gradient stops (or confirm the
      placeholder we extracted matches)
- [ ] Font files (or font names) for the cursive script + display sans
- [ ] BBB A+ official badge image
- [ ] CertainTeed Premier Roofing Contractor official badge (primary)
- [ ] CertainTeed Triple Crown Champion official badge (secondary)
- [ ] GAF GoldElite Commercial official badge
- [ ] Roofing Contractor Top 150 2024 official badge
- [ ] Select ShingleMaster official badge
- [ ] HomeAdvisor Screened & Approved badge
- [ ] 3-5 hi-res hero photos: storm scene, roof close-ups, office or
      truck shots

Until those arrive, we use placeholder treatments (extracted hex
codes, text-only credential labels, stock storm photography flagged
"placeholder").

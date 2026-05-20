# Noland's Estimator

White-label fork of the Voxaris roof estimator for **Noland's Roofing**
(Central Florida — Clermont HQ, 4 offices serving Lake, Orange, Volusia,
Osceola, Sumter, Polk, Seminole, Flagler, Manatee, and Lee counties).

**Deployed:** `estimate.nolandsroofing.com`

## What it does

Homeowner types their address, gets a real roof price in under 30
seconds — measured from satellite imagery, priced as a Good / Better /
Best range, sent via SMS, optionally followed by an AI voice callback
to schedule a free inspection.

Built on the Voxaris roof estimator pipeline (Google Solar API +
Gemini Pro Image painted overlay + Gemini Flash structured detection
+ FDOR parcel + IEM storms) — reskinned for Noland's brand.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 ·
Vercel · Supabase (shared with Voxaris) · LiveKit Cloud Agent
"Sydney" for voice callbacks (managed in `voxaris-pitch`, not here).

## Run locally

```bash
vercel env pull .env.local
npm install --legacy-peer-deps
npm run dev
# open http://localhost:3000
```

## Routes

- `/` — Homeowner estimator (address → satellite measurement → price → SMS)
- `/r/[publicId]` — Share URL for the homeowner's estimate (bilingual EN/ES)
- `/dashboard/*` — Reserved for Noland's reps if needed (currently lives in
  the Voxaris dashboard, separate project, same DB under `office_id="nolands"`)
- `/privacy`, `/terms` — Legal

## CI

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

## Brand

Locked palette extracted from Noland's door hangers — deep black + red-
orange (the cursive "Roofing" script) + metallic silver (the "NOLAND'S"
wordmark). Tokens in `app/globals.css` under `--color-noland-*`. See
[AGENTS.md](AGENTS.md) for the full invariant set.

## What lives elsewhere

- **Sydney voice agent** → `voxaris-pitch/agents/sydney/`. Deploy with
  `lk agent deploy` from that repo. This repo dispatches calls via
  `/api/dispatch-outbound`.
- **Lead dashboard** → Voxaris dashboard (separate project, same DB).
  Noland's reps log in there to view leads / call logs / appointments.
- **Pricing math** → `lib/pricing/`. Deterministic, calibrated, not
  AI-generated. AI does measurement; humans + math do pricing.

## Compliance

- FCC AI-voice disclosure in Sydney's openers (locked)
- TCPA strict `voiceConsent === true` gate
- FL § 627.7152 — the word "insurance" is BANNED customer-facing
  ("provider" / "carrier" instead). Door-hangers may use it (Noland's
  printed copy, their risk); the website + estimator + Sydney do not.
- Noland's claims, no Voxaris guarantees on credentials / warranties /
  service descriptions.

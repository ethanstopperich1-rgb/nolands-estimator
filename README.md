# Voxaris Pitch

**Estimate to deal in five minutes.** The closing tool for roofing teams.

Voxaris Pitch turns an address into a signed proposal. Type the property in, and Pitch auto-measures the roof, assesses the material and condition, prices a tiered quote, and outputs a branded PDF.

This is a proprietary internal product owned by Voxaris (repo: `roofai-internal`).

## Features

- **One-shot estimate** — address autocomplete → instant roof size, pitch, material, complexity
- **Tiered proposal generator** — Good / Better / Best with built-in financing math
- **Live Xactimate-style line items** — for insurance work, full per-code breakdown
- **Storm history radar** — flags insurance-eligible properties automatically
- **Pitch Vision** — material / age / damage / penetrations from satellite (V3 Gemini pipeline)
- **Customer embed** — `embed.js` iframe widget for partner roofer sites
- **AI outbound** — LiveKit voice agent (Sydney) + Twilio SMS after TCPA consent
- **Rep dashboard** — `/dashboard/*` leads, calls, canvass (Supabase + RLS)

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · Vercel · Supabase

## Run locally

```bash
cp .env.local.example .env.local   # fill in keys
npm install --legacy-peer-deps
npm run dev
# open http://localhost:3000
```

## White-label

See **[docs/WHITE-LABEL.md](docs/WHITE-LABEL.md)** for the two deployment models (multi-office vs per-partner deploy).

Per-deploy env overrides (`PITCH_*`, with `ROOFAI_*` aliases):

```
PITCH_COMPANY_NAME=Acme Roofing
PITCH_PHONE=(555) 123-4567
PITCH_EMAIL=estimates@acmeroofing.com
PITCH_PRIMARY_COLOR=#0a0d12
PITCH_ACCENT_COLOR=#67dcff
PITCH_SHOW_XACTIMATE=true
```

Multi-tenant in one deployment: pass `?office=<slug>` or embed `data-brand="<slug>"`; TCPA copy names that office via `GET /api/office/branding`.

## Routes

- `/` — Customer V3 estimator (address → pin → Gemini roof → quote → lead)
- `/embed` — Iframe embed surface for partner sites
- `/dashboard/*` — Rep pipeline (staff auth + Supabase RLS)
- `/privacy`, `/terms` — Legal (TCPA disclosures link here)

**Note:** Public proposal URLs at `/p/<id>` were retired; old links redirect to `/`. Export PDFs from the rep dashboard or use `LEAD_WEBHOOK_URL`.

## CI

```bash
npm run typecheck
npm run lint
npm run test
npm run test:rls
npm run build
```

## Pricing engine

Two engines in `lib/pricing.ts`:

1. **Headline pricing** — material × pitch × multipliers + add-ons
2. **Itemized engine** (`buildDetailedEstimate`) — Xactimate-style line items; tune via `BRAND_CONFIG.materialPriceOverrides`

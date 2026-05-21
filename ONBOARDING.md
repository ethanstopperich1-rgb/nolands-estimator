# Onboarding — Noland's Estimator

Welcome. This repo is the customer-facing roof estimator at
`estimate.nolandsroofing.com`. By the end of day 3 you'll have shipped a
PR to production. Read this end-to-end first, then start.

If something here is wrong or stale, fix it as part of your first PR.

---

## 1. Prerequisites

- **Node 24+** (canary Next.js 16 / React 19 requires it). `nvm use 24`.
- **npm 10+** (ships with Node 24).
- **Vercel CLI** — `npm i -g vercel`. Auth with the Voxaris team.
- **Supabase MCP** (optional but recommended) — gives you read/write
  against the shared DB from Claude Code. Same project as Voxaris
  Dashboard; Noland's data is filtered by `office_id="nolands"`.
- **Git access** to `voxaris/nolands-estimator` and read-only on
  `voxaris/voxaris-pitch` (Sydney lives there; you'll reference it).

Env vars are pulled from Vercel — you do not hand-write `.env.local`.
Required keys (Vercel provides them): `GOOGLE_MAPS_API_KEY`,
`GEMINI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`KV_REST_API_URL` + `KV_REST_API_TOKEN` (Upstash), `LIVEKIT_*`,
`SENTRY_DSN`. Anything missing fails the route at runtime with a
descriptive log — soft-fails to null where safe.

## 2. Setup

```bash
git clone git@github.com:voxaris/nolands-estimator.git
cd nolands-estimator
vercel link          # select the "nolands-estimator" project
vercel env pull .env.local
npm install --legacy-peer-deps   # React 19 peer-dep noise; the flag is required
npm run dev          # http://localhost:3000
```

Gotchas:
- `npm install` without `--legacy-peer-deps` will fail on `@react-three/*`.
- `next dev` boots in ~6s. First request to `/api/gemini-roof` takes
  25-50s (Gemini Pro Image is the bottleneck) — that's normal.
- If you see "Cost cap exceeded" in dev, set `RATELIMIT_FAIL_OPEN=1` in
  `.env.local`. Don't ship that flag.

Verify with the canonical smoke address: `8450 Oak Park Ave, Orlando FL
32827`. You should get a painted roof image + Good/Better/Best tiers in
under a minute.

## 3. Project tour

| Directory | What it owns |
|---|---|
| `app/page.tsx` + `app/r/[publicId]/` | Homeowner UI — address entry, painted estimate, shareable bilingual EN/ES report. |
| `app/api/gemini-roof/route.ts` | **The V3 truth pipeline.** 3,300 lines. Read `app/api/gemini-roof/AGENTS.md` before touching. |
| `app/api/leads/` | Lead capture + voice-consent gate. TCPA `voiceConsent === true` lives here. See sibling AGENTS.md. |
| `app/api/dispatch-outbound/` | Hands a confirmed lead to Sydney (LiveKit Cloud Agent `CA_3p2JuouBpV2Z`, lives in `voxaris-pitch`). |
| `lib/` | Stateless helpers — image processing, parcel lookup, pricing math, auth. Read `lib/AGENTS.md`. |
| `lib/pricing/` | Deterministic tier math. Calibrated, not AI-generated. Read its AGENTS.md before touching any number on a quote. |
| `lib/seo/structured-data.ts` | JSON-LD + areaServed county list (you'll edit this in your first PR). |
| `migrations/` | Supabase migrations. RLS-tested via `npm run test:rls`. |

Skim — don't deep-read — `middleware.ts` (origin + staff gates) and
`instrumentation.ts` (Sentry boot).

## 4. Locked invariants — do NOT break

These are reproduced from the root `AGENTS.md` and the V3 pipeline doc.
If a PR touches any of these, your reviewer will block on it.

1. **Pro Image is decorative. Solar API + Flash JSON are truth.** Never
   couple pricing logic to the painted PNG.
2. **Soft-fail to null** on every external dep (Solar, Static Maps,
   FDOR, IEM, OSM). Customer flow degrades gracefully — never 500s.
3. **`CACHE_SCOPE_V3`** at `app/api/gemini-roof/route.ts:1134` bumps on
   every V3 response-shape change. #1 footgun in the file.
4. **`office_id` check** on every Supabase write touching a lead.
5. **`lib/painted-url.ts`** is the only URL minter for painted overlays.
6. **Pricing is calibrated, not generative.** `lib/pricing/` is math.
7. **Never the word "insurance"** customer-facing (FL § 627.7152). Use
   "provider" or "carrier". Applies to website + estimator + Sydney
   prompt. Door-hangers are Noland's printed copy and out of scope.
8. **FCC AI-voice disclosure** — Sydney identifies as "an AI assistant"
   in her first sentence. Managed in `voxaris-pitch/agents/sydney/`.
9. **TCPA strict gate** — `voiceConsent === true`, no implicit consent.
10. **Cost-cap before any AI call.** `lib/cost-cap.ts:trackAiSpend()`
    fails closed in prod when the day's $ ceiling is hit.

## 5. Your first PR — add a Florida county to the service area

Noland's just opened a referral pipeline in **Brevard County**. Add it.

**Step 1 — Find the canonical list.** It's in two places:

```
lib/seo/structured-data.ts        # JSON-LD areaServed (public SEO)
lib/county-data-sources.ts        # Parcel + GIS data sources
```

**Step 2 — Edit `lib/seo/structured-data.ts`.** Add `"Brevard"` to the
prose paragraph around line 119 (keep alphabetical-ish: it slots between
Volusia and Osceola in the existing list) AND add an `AdministrativeArea`
entry: `{ "@type": "AdministrativeArea", name: "Brevard County, FL" }`.

**Step 3 — Edit `lib/county-data-sources.ts`.** Append a new
`CountyDataSource` to `COUNTY_DATA_SOURCES`. Brevard's PA is at
`bcpao.us`; their GIS export sits at the county Open Data portal. Set
`slug: "brevard"`, `updateCadence: "nightly"`, and `ownerNamesIncluded:
true` after you verify the export schema.

**Step 4 — Typecheck + test.**

```bash
npm run typecheck     # tsc --noEmit, ~6s
npm run lint
npm test              # vitest via tsx
```

**Step 5 — Smoke-test locally.** `npm run dev`, then submit a Brevard
address (e.g. `1234 N Wickham Rd, Melbourne FL 32935`). Confirm the
estimate renders and the SEO source includes "Brevard" in the
`areaServed` block (View Source → search for the county name).

**Step 6 — Commit + push.**

```bash
git checkout -b feat/brevard-county-service-area
git add lib/seo/structured-data.ts lib/county-data-sources.ts
git commit  # use a HEREDOC for the message
git push -u origin feat/brevard-county-service-area
gh pr create --title "Add Brevard County to service area"
```

**Step 7 — Deploy.** Push to `main` (after PR approval) triggers Vercel
auto-deploy to `estimate.nolandsroofing.com`. Preview deploys spin up
per branch. Watch the deploy at
`vercel.com/voxaris/nolands-estimator/deployments`. Verify on prod by
fetching `/sitemap.xml` and confirming Brevard appears in JSON-LD.

## 6. Where to find help

- **`AGENTS.md`** at the repo root + per-directory. Open the closest
  one to the file you're editing.
- **`app/api/gemini-roof/AGENTS.md`** — V3 pipeline rules, smoke
  addresses, the wall-clock budget. Mandatory before touching that
  route.
- **`lib/AGENTS.md` and `lib/pricing/AGENTS.md`** — conventions for
  network calls, sharp, RLS, and pricing math.
- **Claude Code skills** — run `/seo-audit` after editing SEO surfaces,
  `/perfect-prompt` before handing the model a fuzzy task, and
  `/systematic-debug` when a flake doesn't reproduce.
- **`voxaris-pitch/agents/sydney/AGENTS.md`** — the voice agent. We
  dispatch to her; we don't edit her here.
- **`voxaris-dashboard`** repo — where Noland's reps view leads.
- **Slack `#nolands-estimator`** — ping `@ethan` for anything blocked
  more than 30 minutes.

---

## Hidden knowledge that needs to be documented (not yet captured)

These came up while writing this doc. File issues or add them:

1. **`--legacy-peer-deps` is required.** Not in README; new devs hit
   the `@react-three/*` peer-dep wall on day 1.
2. **`CA_3p2JuouBpV2Z`** — the LiveKit Cloud Agent ID for Sydney's
   Noland's dispatch is a magic string in `dispatch-outbound/route.ts`.
   Should live in env or a constants module with a comment.
3. **Brevard / county-add workflow** — `lib/seo/structured-data.ts`
   and `lib/county-data-sources.ts` are not cross-referenced. Adding a
   county to one and forgetting the other is a silent SEO regression.
4. **Wall-clock budget for `/api/gemini-roof`** — the 90s Vercel
   function ceiling is in `app/api/gemini-roof/AGENTS.md` prose but not
   surfaced as a CI assertion or a `maxDuration` export.
5. **`RATELIMIT_FAIL_OPEN=1` dev escape hatch** — undocumented outside
   `lib/AGENTS.md`. New devs hit cost-cap blocks in dev and think
   they're broken.

Add fixes for these to your second PR.

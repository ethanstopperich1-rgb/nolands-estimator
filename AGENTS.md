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

`pitch.voxaris.io` is a homeowner-facing roof estimator + a rep-facing
sales workbench, both running off the same Next.js app:

- **`/`** — customer surface (BotID-guarded). Address → pin →
  /api/gemini-roof → painted result with Good/Better/Best tier prices.
- **`/dashboard/*`** — rep surface (HTTP Basic + Supabase Auth gated).
  Lead list, lead drawer, full estimate workbench.

The truth path for every measurement is the **V3 pipeline** at
`app/api/gemini-roof/route.ts`. Everything else (rep workbench, lead
drawer, lead report page) reads from the same JSON shape persisted to
`leads.roof_v3_json` after the customer's session.

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

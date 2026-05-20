# `lib/` — shared utility modules

56 files of mostly stateless helpers. Anything that runs server-side
and isn't a route, page, or component goes here. Browser-side code
that's purely a helper (no React, no DOM) is also welcome.

## Subdirectories with their own AGENTS.md

- **`lib/pricing/`** — tier pricing, material multipliers, waste
  formula. Read its AGENTS.md before touching any number that shows
  up on a quote.
- **`lib/gemini-roof/`** — input parsing + request guards split out
  from the route. Read its sibling at `app/api/gemini-roof/AGENTS.md`.
- **`lib/leads/`** — lead-shape validation extracted in `5d08124`.

## Conventions (the ones that bite)

### 1. Soft-fail to null

**Every external dependency in this folder must return null (or a
typed equivalent like `[]`) on failure.** Never throw past a public
function boundary if the consumer is part of the V3 pipeline or the
customer flow.

The canonical pattern (from `lib/parcel-lookup.ts`):

```ts
export async function lookupParcel(
  lat: number,
  lng: number,
): Promise<ParcelLookupResult | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  try {
    const r = await fetch(URL, { signal: AbortSignal.timeout(6_000) });
    if (!r.ok) return null;
    const body = await r.json();
    if (body.error) return null;
    return shapeResult(body);
  } catch {
    return null;
  }
}
```

Note:
- Explicit `AbortSignal.timeout()` on every fetch (FGIO, FDOR, IEM,
  Solar, Static Maps are all academic / .gov-adjacent and occasionally
  hang; never let them block the route).
- Try/catch wraps everything — including JSON parse and any sharp
  decoding.
- The function signature includes `| null` in the return type so
  callers MUST handle the failure case.

### 2. `sharp` always goes in try/catch

`sharp` throws on a wide variety of inputs (truncated PNG, mismatched
dimensions, invalid color modes). Every `await sharp(buf)…toBuffer()`
must be inside try/catch. Soft-fail to the input buffer when the
transform fails. See `lib/watermark.ts:54-72` and
`lib/composite-cyan-overlay.ts:80-130` for the canonical pattern.

### 3. No fetch during render

Files in this folder that get imported by client components MUST NOT
make network requests at module scope or in any render path. Network
calls happen in:
- Server components (`async function Page()`)
- Route handlers (`app/api/*/route.ts`)
- Explicit data-fetching helpers (only called from the above)

A `"use client"` page touching a lib that hits the network at import
time will break SSR and ship secrets to the browser bundle. The
build catches some of these via type errors (server-only imports)
but not all.

### 4. Service-role Supabase clients are SERVER-ONLY

`createServiceRoleClient()` in `lib/supabase.ts` returns a client with
the service-role key. It bypasses RLS. **It must only be called from
route handlers / server actions, never from a `"use client"` component
or a shared utility that might be imported by one.** Use the cookie
adapter client (`createServerClient(await buildCookieAdapter())`) when
you need an RLS-respecting client.

### 5. Public vs private modules

There's no formal `index.ts` boundary, but the convention is:

- Modules consumed by route handlers + server actions are **internal**
  (most of `lib/`)
- Modules consumed by `"use client"` components are **client-safe** —
  they must not transitively import server-only deps (Supabase service
  role, BigQuery client, etc.)

If you add a new lib and it could be imported by a client, audit its
transitive imports. The build will yell about most violations but not
all (it's better at catching `process.env.SOME_SECRET` than at
catching a service-role client being instantiated lazily).

### 6. Cost-cap is the circuit breaker

`lib/cost-cap.ts` enforces a daily dollar ceiling on AI calls (Pro
Image is ~$0.075/call, Flash is ~$0.005). Every call in the V3
pipeline that's not free MUST go through `trackAiSpend` before firing.
See `app/api/gemini-roof/route.ts:1711` for the convention. Without
this, a distributed-attacker pump can run a $thousand-dollar bill in
an afternoon.

In dev, cost-cap fails open. In prod (when `KV_REST_API_URL` is set),
it fails **closed** — calls reject when the day's budget is exhausted.
Set `RATELIMIT_FAIL_OPEN=1` only as an emergency escape hatch.

## Module index (the ones worth knowing about)

### Image processing

- `composite-cyan-overlay.ts` — composite cyan mask onto raw Google
  aerial. Hard ceiling at 35% mask fill (anti-flood-paint guard).
  This is the only paint safety net since `c2360e8` removed paint-verify.
- `cyan-mask.ts` — extract cyan polygon from Pro Image PNG. Also
  exports `maskToCyanOverlayPng` for transparent overlay generation.
- `paint-verify.ts` — REMOVED in commit `c2360e8` (the retry wrapper +
  verify pass were eating 20-40s on the critical path; the composite
  35% fill ceiling catches the catastrophic "Pro Image flood-painted
  the frame" case without the round-trip).
- `watermark.ts` — stamp `voxaris.io` on the painted PNG.

### Geometry + measurement

- `roof-geometry.ts` (in `lib/roof-geometry/`) — polygon math,
  Solar segment → plane match, edge classification.
- `roof-geometry/azimuth-cluster.ts` — count distinct wings by
  azimuth mod 90°.
- `penetration-filter.ts` — 6-layer guard chain on object detections
  (confidence floor, bbox sanity, cyan-mask gate, two-pass agreement,
  24" dedup, per-sqft caps). Consumes `pricingMask`, not `cyanMask`.
- `reconcile-roof-polygon.ts` — accept / clip / replace Gemini's
  outline against Solar's bbox. Used by the legacy V2 path.

### Data lookups

- `parcel-lookup.ts` — FL DOR statewide cadastral. Year built, sqft,
  value, last sale. Soft-fails to null.
- `streetview.ts` — REMOVED (was Phase 1 of "Why this roof needs
  attention", reverted in `3522152`). Don't reintroduce without
  fixing the geocoder-on-road-centerline bug first.
- `hail-mrms.ts` — NOAA MRMS hail history.
- `buildings.ts` — OSM / Microsoft Buildings footprint lookups
  (used by the undercount correction path).
- `bigquery.ts` — BigQuery client setup for the NOAA storms dataset.

### Pricing

- `pricing/calculate-waste.ts` — material-aware tier rates,
  geometric waste formula, penetration adders, monthly finance helper.
  **READ `lib/pricing/AGENTS.md` BEFORE TOUCHING THIS FILE.**

### Auth + tenancy

- `dashboard.ts` — `getDashboardOfficeId`, `getDashboardUser`,
  `getDashboardSupabase`. The JWT → office_id resolution lives here.
  Has a STRICT_DASHBOARD_AUTH flag that controls fail-open vs
  fail-closed in non-session contexts.
- `protected-routes.ts` (extracted in `5d08124`) — single source of
  truth for which API + page paths are staff-gated.
- `api-public-guard.ts` (extracted in `5d08124`) — origin check +
  rate limit wrapper for billable public GETs.
- `tcpa-consent.ts` — disclosure text builders for the voice consent
  audit row.
- `staff-session.ts` (in `lib/`) — HTTP Basic + Supabase Auth
  session helpers for the staff middleware.

### Misc

- `cost-cap.ts` — daily AI spend ceiling. Fail-closed in prod.
- `ratelimit.ts` — Upstash-backed token-bucket. Fail-open in dev,
  fail-closed in prod when KV is configured.
- `origin-guard.ts` — origin allowlist for cross-site embed.
- `validate-image.ts` — PNG magic-byte check, size cap.
- `validate-roof-v3.ts` — runtime shape validation of incoming roof
  payloads (defense against client-side injection on `/api/leads`).
- `branding.ts` + `env-branding.ts` — white-label scaffolding (not
  yet wired to a multi-brand deploy).
- `roofing-facts.ts` — shared canonical list of "did you know" facts
  used by both customer loading screen and rep estimator.

## When in doubt

- **Adding a new lib** — does it call the network? Add `AbortSignal.timeout`
  + try/catch + soft-fail-to-null. Is it imported by a client? Audit
  the transitive deps.
- **Adding a Supabase write** — does it need RLS bypassed? Use service
  role + filter by office_id manually. Otherwise use the cookie adapter.
- **Adding sharp** — wrap in try/catch, soft-fail to the input buffer.
- **Adding fetch** — `AbortSignal.timeout` is mandatory.

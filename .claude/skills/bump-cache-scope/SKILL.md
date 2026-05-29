---
name: bump-cache-scope
description: >-
  Bump CACHE_SCOPE_V3 in app/api/gemini-roof/route.ts whenever the V3 response
  shape, pipeline behavior, or any pricing/measurement computation changes.
  Forgetting this is the #1 post-deploy footgun — real customers get stale
  cached results from the OLD pipeline keyed by CACHE_SCOPE_V3 + lat + lng for
  30 days. Use right after any change that affects what /api/gemini-roof
  returns.
---

# bump-cache-scope

`/api/gemini-roof` caches V3 responses for 30 days keyed by
`CACHE_SCOPE_V3 + lat + lng`. If you change the response shape, the pipeline,
or any pricing/measurement computation but DON'T bump the scope string, real
customers keep getting the stale pre-change result. This is the single most
common way a "shipped" fix silently doesn't reach production.

## When to bump
ANY of these → bump:
- The V3 JSON response shape changed (added/removed/renamed a field).
- Pricing math changed (tier rates, waste, multipliers, penetration adders).
- Pipeline behavior changed (paint, Solar, Flash, parcel, storms logic).
- A measurement computation that affects the returned numbers changed.

NOT needed for: pure prompt copy, dashboard-only, or non-V3 routes.

## How
```bash
cd /Users/voxaris/nolands-estimator
grep -n "const CACHE_SCOPE_V3" app/api/gemini-roof/route.ts   # find the current value
```
Edit it to a NEW slug that describes the change. Recent lineage:
`v3-per-face-facets` → `v3-parcel` → `v3-composite` → `v3-cyan-centric-verify`
→ `v3-dual-publisher`. Pick a short, descriptive slug, e.g.:
```ts
const CACHE_SCOPE_V3 = "v3-<what-changed>";   // e.g. "v3-pricing-multiplier-fix"
```

## Verify
```bash
npx tsc --noEmit
# Smoke-test the canonical complex roof if the paint/measurement path changed:
#   8450 Oak Park Ave, Orlando FL 32827
```
Then commit + push (Vercel auto-deploys on push to main). The first request per
(lat,lng) after deploy now misses the old cache and recomputes — confirm the
change is actually visible on a fresh address.

---
name: smoke-oak-park
description: >-
  Run the canonical visual smoke test on 8450 Oak Park Ave, Orlando FL 32827 —
  the complex roof that exposes Pro Image / paint-pipeline regressions. Use
  AFTER any change to the paint pipeline, lib/cyan-mask.ts,
  lib/composite-cyan-overlay.ts, lib/painted-url.ts, components/RoofMap.tsx, or
  the V3 route — BEFORE shipping. Regressions look fine on simple roofs
  (Newcomb/Jupiter) and broken on Oak Park.
disable-model-invocation: true
---

# smoke-oak-park

The mandatory pre-ship check for any paint/measurement change. Oak Park is the
canonical hard case: Pro Image diverges on complex roofs, and the composite 35%
fill-fraction gate is the only safety net. If it looks right on Oak Park, it's
safe; passing on Newcomb alone proves nothing.

## When this is required (per AGENTS.md)
Any change touching: `app/api/gemini-roof/route.ts`, `lib/cyan-mask.ts`,
`lib/paint-verify.ts`, `lib/composite-cyan-overlay.ts`, `lib/painted-url.ts`,
`lib/gemini-roof-prompt.ts`, or `components/RoofMap.tsx`.

## Run it
Bypass the 30-day cache by hitting a fresh deploy (or bump `CACHE_SCOPE_V3`
first — the result is cached by `CACHE_SCOPE_V3 + lat + lng`).

```bash
# Against the deployed estimator (replace with the current prod/preview URL):
curl -s -X POST "https://estimate.nolandsroofing.com/api/gemini-roof" \
  -H "Content-Type: application/json" \
  -d '{"address":"8450 Oak Park Ave, Orlando FL 32827"}' | python3 -m json.tool | head -60
```
Or run the address through the live estimator UI and inspect the painted
overlay.

## What to verify (the regression signatures)
1. **Painted overlay is on the RIGHT house** (not a neighbor) — the #1 Oak Park bug.
2. **Cyan is a translucent OVERLAY on real shingles**, not a generative re-render.
3. **Mask fill ≤ 35%** — above that the composite must fall back to raw aerial
   (no cyan). A flood-painted roof = the gate failed.
4. **Headline sqft comes from Solar** (sane for a large complex roof), not a
   wildly off number.
5. **Facet count is plausible** (the segmentation hint stays OFF; capped at 6
   only if reintroduced).
6. **Pin/map zoom = 21**, house centered.

## If it's broken
Don't ship. The defense order is prompt → no-facet-hint → cyan-mask extraction
→ composite 35% gate → GroundOverlay fallback (see AGENTS.md §5). Check which
layer regressed; the 35% fill gate is the load-bearing safety net.

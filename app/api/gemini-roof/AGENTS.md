# `app/api/gemini-roof/route.ts` — the V3 truth pipeline

This is the single most important route in the repo. 3,300+ lines.
Every measurement the customer sees and every quote the rep proposes
flows out of here. Read this file before editing the route — there
are several gotchas that aren't obvious from the code alone.

## What it does

`POST /api/gemini-roof?lat=…&lng=…&pinConfirmed=1[&leadPublicId=…]`

Given a lat/lng pin, returns a `GeminiRoofResponseV3` (interface at
`route.ts:847`) containing:

- Solar API photogrammetric measurements (sqft, pitch, segments)
- A painted cyan PNG of the roof (customer-visible)
- A cyan-overlay PNG (transparent, used by the interactive map)
- Object detections (vents, chimneys, HVAC, skylights, dishes, panels)
- Edges + facets (line classifications, per-plane areas)
- Pricing inputs (waste %, penetration adders)
- Parcel data (year built, sqft, value — from FL DOR cadastral)
- Paint-verify telemetry (verdict, cyan coverage)

Two response shapes:

- **V3** (pin-confirmed flow, customer + rep both use this) — returned
  by `handleV3Pinned` at line 1837
- **V2 / legacy** (no pin, called by the rep "regenerate" path) —
  returned by `handle` at line 3116. Older + simpler. Slated for
  removal once nothing reads it.

## File map (top-level structure)

| Lines | What lives there |
|---|---|
| 118-145 | Tile constants, model IDs, cache scopes |
| 193-285 | `fetchGoogleStaticTile` — Static Maps + sharp shadow-lift. Returns BOTH the shadow-lifted version (for Gemini) AND `rawBase64` (for the composite). |
| 357-499 | `callGeminiMultimodal` — Pro Image paint call. Generative, not pixel-edit. |
| 501-606 | `callGeminiMultimodalWithVerify` — wraps the paint call with retry-on-verify-fail. |
| 665-682 | `callSolar` — Solar API findClosest. Soft-fails to null. |
| 847-1095 | `GeminiRoofResponseV3` interface. **This is the contract.** |
| 1134 | `CACHE_SCOPE_V3` — bump when you change the response shape. |
| 1143-1287 | `GEMINI_OBJECTS_PROMPT` (Flash rich-data on raw tile). |
| 1290-1394 | `GEMINI_LINES_PROMPT` + schema (Flash lines on raw tile). |
| 1395-1457 | `GEMINI_LINES_FROM_PAINTED_PROMPT` (Flash lines on painted PNG, fallback). |
| 1458-1554 | `callGeminiLines` — Flash structured output for line classification. |
| 1596-1707 | `callGeminiRichData` — Flash structured output for objects + facets + material. |
| 1709-1835 | `persistEstimateToLead` — Supabase write via service role. Includes office_id check. |
| **1837-3114** | **`handleV3Pinned` — the main pipeline.** All measurement logic. |
| 3116-3298 | `handle` — legacy V2 path. |
| 3301-3340 | Exported `GET` / `POST` handlers (thin shim around `parseInputs` + dispatcher). |

## The pipeline in `handleV3Pinned` (read this carefully before editing)

Condensed in commit `c2360e8` (wall clock was hitting the 90s function
ceiling). Today's pipeline:

```
1. parseInputs → (lat, lng, pinConfirmed, leadPublicId)
2. Check cache (key = CACHE_SCOPE_V3 + lat + lng). Skip if skipCache=1.
3. Parallel: fetchGoogleStaticTile + callSolar + parcelPromise (lookupParcel
   against Solar.center, runs in background until needed)
4. Parallel fan-out:
   - callGeminiMultimodal (paint pass, ~25-50s, ONE attempt no retry)
   - callGeminiRichData on raw tile (objects + facets + material, ~8-15s)
5. extractCyanMask on painted PNG (serial after paint, ~1s)
6. Filter penetrations (penetration-filter.ts) — single-pass detections
   with the six-guard filter chain (confidence, bbox, cyan-mask gate,
   dedup, per-sqft caps).
7. Solar segment math → sloped/footprint sqft, facets array
8. UNDERCOUNT CORRECTION: when imagery is MEDIUM/LOW + footprint
   suspiciously small, swap in OSM GIS footprint × Solar slope ratio.
   See `correction` audit trail in the response.
9. Display vs quotable split:
   - sqft (display) = segments ≥ 3° pitch (customer headline)
   - quotableSqft = segments ≥ 12° pitch (tier pricing)
10. Geometric waste + penetration adders → pricing
11. Customer image:
    - If cyanMask area > 0 AND mask fill ≤ 35% → composite onto raw aerial
    - Else → raw aerial alone (no cyan)
    - Customer NEVER sees Pro Image's raw PNG
12. Watermark
13. Generate cyanOverlay (transparent PNG + lat/lng bounds for GroundOverlay)
14. Resolve parcelPromise
15. Build result + cache + persistEstimateToLead (waitUntil)
16. Return JSON
```

**Removed in `c2360e8`:** paint-verify retry wrapper, dual publisher,
callGeminiLines on raw tile, callGeminiLines on painted tile,
callGeminiRichData on painted tile (two-pass agreement). Wall clock
went from 70-120s → 30-55s. If you reintroduce any of these, BUDGET
the wall clock first — the 90s function ceiling is hard.

## Critical invariants — don't break these

### Pro Image is decorative

Never let `paintedImageBase64` (especially the raw Pro Image variant)
drive measurement or pricing. The cyan mask is OK for the gate in
`filterPenetrations`, but ONLY through `pricingMask` (the trust-gated
copy). If you find yourself reading from `cyanMask` directly in a
pricing path, you're coupling to a generative model — wrong layer.

### CACHE_SCOPE_V3 must bump on every shape change

Forgetting this is the #1 footgun in this file. Real customers see
stale cached results from the broken pipeline if you forget.

Every time you:
- add a field to `GeminiRoofResponseV3`
- change the meaning of an existing field
- change a computation that affects what's returned
- change a downstream lib that affects what's returned (e.g.
  `lib/parcel-lookup.ts`, `lib/composite-cyan-overlay.ts`)

→ bump `CACHE_SCOPE_V3` at line 1134 to a slug describing the change.

### Soft-fail to null

Pro Image fails? `paintedImageBase64 = null`, pipeline continues.
Solar 404s? Try OSM GIS, then null pitch, pipeline continues. Flash
times out? Empty `objects[]`, pipeline continues. Parcel lookup
fails? `parcel = null`, pipeline continues. The response is ALWAYS
a valid JSON shape; missing data is missing fields, not 500s.

### `office_id` on persistEstimateToLead

Don't write to a lead row without checking the caller's office_id
matches the lead's office_id. See `roof-v3/route.ts` for the canonical
pattern.

## Smoke-test properties

When changing anything in the paint pipeline, test against ALL of:

| Property | Coords | Why it's the test case |
|---|---|---|
| 2863 Newcomb Ct, Orlando | 28.5844052, -81.1733044 | Simple 4-facet hip; Pro Image is faithful here; EagleView ground truth |
| 813 Summerwood Dr, Jupiter | 26.93252, -80.10804 | Solar undercounts → OSM correction fires; tests GIS fallback |
| 8450 Oak Park Rd, Orlando | 28.4885634, -81.4998067 | 17-segment complex estate; Pro Image regresses here on bad prompts |

Eval harness: `scripts/eval-eagleview/run-pipeline-eval.ts` (see
that subdir's AGENTS.md).

## Models in use

- `gemini-3-pro-image-preview` — paint pass (decorative cyan)
- `gemini-2.5-flash` — objects, lines, rich data (truth, structured JSON)
- `gemini-2.5-pro` — visual roof assessment (customer-facing material +
  hedged condition observations from `lib/visual-roof-eval.ts`). Reads
  the top-down RAW tile + a heading-corrected Street View pano; identity-
  gated before any customer copy is rendered. **Customer renderer MUST
  hedge every observation** ("appears to be", "possible", "what looks
  like") — see `feedback_visual_condition_legal_framing` in
  ~/.claude/projects/.../memory.

**Pro Image and Flash have DIFFERENT config rules** (see comments at
lines 17-37 of route.ts):

| | Pro Image (paint) | Flash (understanding) |
|---|---|---|
| temperature | 0 | 1.0 |
| mediaResolution | NOT set (empty responses if you do) | MEDIA_RESOLUTION_HIGH |
| systemInstruction | NOT split (degrades crispness) | Allowed |
| parts order | text FIRST, then image | Either |

If you copy a generationConfig from a Flash call to Pro Image (or
vice versa) the model will silently degrade. Each call's config is
intentional; don't "harmonize" them.

## Common edits and where they land

| Change | Where |
|---|---|
| Add a new response field | `GeminiRoofResponseV3` at line 847, then the result builder near line 2900, then bump CACHE_SCOPE_V3 |
| Change waste % formula | `lib/pricing/calculate-waste.ts:calculateGeometricWaste`; route just calls it |
| Change penetration filter behavior | `lib/penetration-filter.ts`; route just calls it |
| Change paint prompt | `lib/gemini-roof-prompt.ts:GEMINI_ROOF_SYSTEM_INSTRUCTION`. **Lock this file.** Multiple regressions when people "improve" it. Smoke-test against Newcomb + Oak Park before any change. |
| Add a Solar segment filter | The split at `SHINGLE_MIN_PITCH_DEG = 12` (line ~2052) is for pricing; `DISPLAY_MIN_PITCH_DEG = 3` is for the customer headline. Don't conflate. |
| Change cache TTL | `setCached(CACHE_SCOPE_V3, lat, lng, result, 60*60*24*30)` near line 3055. |
| Make the route faster | Pro Image is 25-50s and dominates. Everything else runs in parallel during that window — no further parallelism possible without adding a separate request. |

## Pitfalls (real ones, with commit references)

- **Wrong-house regression** (`a32a487` segmentation hint, reverted in
  `6e096dd`) — pushing Pro Image to render "≥ N facets" flips it from
  edit mode to generative mode on complex roofs. Don't reintroduce
  facet-count hints without strict guards.
- **Sqft undercount** (`79648e1`) — `SHINGLE_MIN_PITCH_DEG = 12` ate
  real low-slope wings on Oak Park. The fix is the 3°/12° display
  vs quotable split. Don't conflate.
- **Composite fallback hole** (Cursor catch, fixed in `89c97f4`) —
  if mask is null/empty after paint succeeds, customer was seeing
  raw Gemini PNG. Always fall through to raw aerial on any mask
  failure. See the dual-publisher block at the bottom of `handleV3Pinned`.
- **Cache scope drift** — multiple times I've forgotten to bump
  `CACHE_SCOPE_V3` after a field change. Real customers got stale
  cached results from the BROKEN pipeline. Always bump.

# `scripts/eval-eagleview/` — pipeline evaluation harness

Reference suite of properties with known measurements (EagleView
ground truth where available). Runs the live V3 pipeline against
each and prints per-stage diagnostics + tier prices. Use this before
shipping any change to the paint pipeline, the pricing module, or
the V3 route's measurement logic.

## Files

- `run-pipeline-eval.ts` — main eval harness. Hits the live route
  for each `CASE`, dumps per-stage signals + final tiers.
- `smoke-test-modules.ts` — fast module-level unit tests for things
  not yet covered by `tests/`.
- `validate-classifier.ts` — line-classifier check against the
  Newcomb edge ground truth.
- `addresses.json` — extra address samples (canvass / batch testing).
- `v3-newcomb-*.json` — captured V3 responses for diffing across
  pipeline iterations.
- `sample.pdf` / `sample.txt` — input fixtures.

## Test cases (`run-pipeline-eval.ts:CASES`)

| Short | Address | What it exercises |
|---|---|---|
| `newcomb` | 2863 Newcomb Ct, Orlando | Simple 4-facet hip, EagleView ground truth (facets, pitch, LF) |
| `jupiter` | 813 Summerwood Dr, Jupiter | Solar undercount → OSM correction path |
| `oakpark` | 8450 Oak Park Rd, Orlando | 17-segment complex estate, Pro Image regression canary |

## How to run

```sh
# Against local dev server
GEMINI_URL=http://localhost:3000 npx tsx scripts/eval-eagleview/run-pipeline-eval.ts

# Against production
GEMINI_URL=https://pitch.voxaris.io npx tsx scripts/eval-eagleview/run-pipeline-eval.ts

# Single case
npx tsx scripts/eval-eagleview/run-pipeline-eval.ts --case oakpark
```

The harness PRINTS — it doesn't assert. You're the gate. After your
change, run before and after, eyeball the diff. Key lines to compare:

- `Solar … sqft sloped` — should not move on properties where
  imagery is HIGH
- `Filter stats raw→…→caps` — penetration filter pass-through; bad
  cyan mask shows up as a big drop at `afterMask`
- `Waste % … breakdown` — confirm the formula contributions
- `Tier totals` — the customer-facing dollars; > 5% movement on
  Newcomb means you changed pricing math accidentally
- `paint-verify verdict / coverage` — confirms Pro Image edited vs
  regenerated

## When to add a case

Whenever you ship a fix for a real customer property that exposed a
new failure mode. Examples:

- Oak Park (added in `4747702`) — Pro Image generative-mode regression
- Future case: a steep-pitch property where the 12° quotable filter
  ate the entire roof
- Future case: a gated community where parcel lookup picks the HOA
  common-area lot

The pattern: real address from a real complaint → add to `CASES` →
fix → eval suite catches future regressions.

## Conventions

- Pin coords come from Google geocoder + manual verification. If you
  can't see the actual rooftop in Google Maps at the lat/lng, your
  pin is on the road and the test will be a Solar-misses case.
- Don't commit Pro Image raw output to the repo. The `v3-newcomb-*.json`
  files have the response stripped of `paintedImageBase64` (the file
  size would balloon).
- Eval expectations (where present) come from EagleView (paid reports,
  $30/property). Brad has the Newcomb EV report locally. Don't make
  numbers up.

## Smoke test rituals

After any change to:

- `app/api/gemini-roof/route.ts` paint pipeline
- `lib/gemini-roof-prompt.ts`
- `lib/cyan-mask.ts`
- `lib/paint-verify.ts`
- `lib/composite-cyan-overlay.ts`
- `lib/penetration-filter.ts`
- `lib/pricing/calculate-waste.ts`

run the eval suite against all three reference properties. If
Newcomb tier dollars move by > 5% you've broken something. If Oak
Park's painted polygon STILL looks like a different house, the dual
publisher hasn't kicked in or the segmentation hint sneaked back.

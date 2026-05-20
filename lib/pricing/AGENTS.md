# `lib/pricing/` — tier math + waste + adders

The numbers in this folder are what the customer sees on their
estimate. Don't change them without thinking about what regresses.
Don't change them without smoke-testing the eval harness (see
`scripts/eval-eagleview/AGENTS.md`).

## Files

- **`calculate-waste.ts`** — the entire pricing module today. Slated
  for split into `tiers.ts`, `waste.ts`, `adders.ts`, `finance.ts`
  if it grows further.

## What's in there

### Tier rate tables (`CUSTOMER_MATERIAL_RATES`)

Per-sqft rates for each material, broken into three tiers (essentials
/ standard / fortified). Multipliers are absolute, not relative —
metal is ~3× shingle, tile is ~2.5×. Audit-grade per-sqft costs that
calibrate against actual contractor markets in FL.

When you edit these, you ARE moving the customer's quote by 5-20%
typically. Smoke-test the eval suite before shipping.

### `geminiMaterialToRateKey`

Maps the Gemini material enum (`asphalt_shingle`, `metal`,
`concrete_tile`, etc.) to the rate-table key. Add a new material
here AND in `CUSTOMER_MATERIAL_RATES` together.

### `customerRatesForMaterial(key | null)`

Returns the material-specific rate table, or the architectural
shingle baseline when the key is null. This is the safe default —
when material confidence is low (or detection fails), we quote
shingle prices rather than the wrong premium price. See
`app/page.tsx:MATERIAL_CONFIDENCE_FLOORS` for the per-material
confidence gate.

### `calculateGeometricWaste`

Replaces the legacy flat 12% waste with property-specific math:

- Facet count → more facets, more cuts, more waste
- Azimuth clusters → more wings, more cuts at corners
- Compactness → L-shapes need more waste than rectangles
- Steep pitch → harder to walk, more material per cut
- Secondary structures → attached additions complicate transitions

**Compactness comes from `pricingMask`, not `cyanMask`** (route.ts).
The trust gate prevents a bad paint from inflating the waste %.

### `calculatePenetrationAdders`

Per-fixture dollar adders (chimney $700, skylight $280, vent $25,
etc.). Customer total = `effectiveSqft × rate + penetrationAddersTotal`.
The object array fed in is post-filter (`filterPenetrations` ran
upstream).

### `monthlyFromTotal(principal, apr?, months?)` + `FINANCE_TERMS`

Standard amortized payment formula. Defaults to 9.99% APR over 180
months. The customer page displays this BIG and the total in fine
print — the financing math is the leading number, not a footnote.

### `calculateTieredPricingWithPenetrations`

The orchestrator. Takes `(sqft, waste, objects, materialKey)` →
returns `{ tiers: TierPrice[] }`. Each tier is `{ id, label, total,
monthly, breakdown }`. The customer page renders these directly.

## Conventions

### Sqft input should be `quotableSqft`, not `sqft`

The customer page's headline sqft (3°+ filter, "your roof") differs
from the pricing-eligible asphalt area (12°+ filter). Tier math
expects the latter. `app/page.tsx:pricingSqft` resolves this:
```ts
const pricingSqft = result.solar.quotableSqft ?? sqft;
```
If you ever wire pricing on the rep side, do the same.

### Material confidence gate is on the consumer

The pricing module trusts whatever materialKey it gets. The
confidence floor lives in `app/page.tsx:MATERIAL_CONFIDENCE_FLOORS`
so the page can choose between "use detected" and "fall back to
shingle." Don't move the gate into the pricing lib; the consumer
is the one who knows what confidence is acceptable.

### Don't read from the painted image here

`calculate-waste.ts` should not depend on `cyanMask`, paint-verify,
or anything visual. It receives numbers (compactness as a scalar,
not a mask). Coupling to the paint pipeline is the wrong layer —
it makes pricing sensitive to a Pro Image regression.

The current state respects this. Don't regress it.

## Smoke-testing changes

Three reference properties + their expected outputs (commit `4747702`
documented the calibration):

- **Newcomb** — 4 facets, 18° pitch, simple. ~$25k-$45k tier spread.
- **Jupiter** — 6 segments, MEDIUM imagery → OSM correction fires.
- **Oak Park** — 17 segments, 4,357 quotable sqft @ ~$45k-$95k.

Run `scripts/eval-eagleview/run-pipeline-eval.ts` after any change
to this folder. Compare tier dollar totals before/after; differences
> 5% on Newcomb mean you've moved a number that wasn't supposed to
move.

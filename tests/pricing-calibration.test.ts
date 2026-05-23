/**
 * Regression test — locks the 2026-05-23 Noland's-JN calibration.
 *
 * The tier rates were calibrated against 399 closed-won Noland's JN
 * invoices. The math: a 2,500 sqft typical FL single-family with the
 * estimator's default 12% waste should land at ~$22,400 Standard tier
 * — within 5% of what Noland's would actually invoice.
 *
 * If any of these numbers drift, the test fails LOUD before the
 * miscalibrated quote reaches a homeowner.
 *
 * To intentionally recalibrate: update the comment block above
 * ROOFING_TIERS in calculate-waste.ts with the new ground-truth
 * source, then update the expected values here. Do NOT update one
 * without the other.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ROOFING_TIERS,
  ARCHITECTURAL_SHINGLE_RATE_PER_SQFT,
  RATE_LOW_PER_SQFT,
  RATE_HIGH_PER_SQFT,
  CUSTOMER_MATERIAL_RATES,
  calculateTieredPricing,
  calculateSuggestedWaste,
} from "../lib/pricing/calculate-waste";

test("per-sqft rate locked for each tier (calibration regression)", () => {
  const essentials = ROOFING_TIERS.find((t) => t.id === "good");
  const standard = ROOFING_TIERS.find((t) => t.id === "better");
  const fortified = ROOFING_TIERS.find((t) => t.id === "best");
  assert.equal(essentials?.ratePerSqft, 6.0);
  assert.equal(standard?.ratePerSqft, 8.0);
  assert.equal(fortified?.ratePerSqft, 10.5);
});

test("architectural shingle default + bands locked at 2026-05 calibration", () => {
  assert.equal(ARCHITECTURAL_SHINGLE_RATE_PER_SQFT, 8.0);
  assert.equal(RATE_LOW_PER_SQFT, 7.0);
  assert.equal(RATE_HIGH_PER_SQFT, 9.0);
});

test("customer-facing material rate band for architectural shingle locked", () => {
  const rates = CUSTOMER_MATERIAL_RATES["asphalt-architectural"];
  assert.ok(rates, "asphalt-architectural rate band must exist");
  assert.equal(rates.low, 7.0);
  assert.equal(rates.mid, 8.0);
  assert.equal(rates.high, 9.0);
});

test("typical 2,500 sqft FL home lands tiers in the calibrated dollar bands", () => {
  const waste = calculateSuggestedWaste({
    facetCount: 4,
    valleysLf: 0,
    ridgesHipsLf: 80,
    avgPitchDeg: 22.6, // ~5/12 (FL typical)
    totalSqft: 2500,
  });
  const tiers = calculateTieredPricing(2500, waste, "asphalt-architectural");
  const e = tiers.find((t) => t.tier.id === "good")!;
  const s = tiers.find((t) => t.tier.id === "better")!;
  const f = tiers.find((t) => t.tier.id === "best")!;

  // Per the calibration comment block in calculate-waste.ts:
  //   Essentials 2,800 effSqft × $6.00  = $16,800
  //   Standard   2,800 effSqft × $8.00  = $22,400 ← FL median
  //   Fortified  2,800 effSqft × $10.50 = $29,400 ← Noland's parent-job median
  // ±10% tolerance for waste variance + $50 rounding.
  assert.ok(e.total >= 15_000 && e.total <= 19_000, `Essentials $${e.total} outside [15k, 19k]`);
  assert.ok(s.total >= 20_000 && s.total <= 25_500, `Standard $${s.total} outside [20k, 25.5k]`);
  assert.ok(f.total >= 26_000 && f.total <= 33_000, `Fortified $${f.total} outside [26k, 33k]`);
});

test("Standard on a small home (1,500 sqft) lands in $12.5k-$17k band", () => {
  const waste = calculateSuggestedWaste({
    facetCount: 4,
    valleysLf: 0,
    ridgesHipsLf: 60,
    avgPitchDeg: 18.4,
    totalSqft: 1500,
  });
  const tiers = calculateTieredPricing(1500, waste, "asphalt-architectural");
  const s = tiers.find((t) => t.tier.id === "better")!;
  assert.ok(s.total >= 12_500 && s.total <= 17_000, `Standard $${s.total} outside [12.5k, 17k]`);
});

test("Standard on a larger home (3,500 sqft) lands in $28k-$38k band", () => {
  const waste = calculateSuggestedWaste({
    facetCount: 6,
    valleysLf: 30,
    ridgesHipsLf: 120,
    avgPitchDeg: 22.6,
    totalSqft: 3500,
  });
  const tiers = calculateTieredPricing(3500, waste, "asphalt-architectural");
  const s = tiers.find((t) => t.tier.id === "better")!;
  assert.ok(s.total >= 28_000 && s.total <= 38_000, `Standard $${s.total} outside [28k, 38k]`);
});

test("tier dollar ordering: Essentials < Standard < Fortified (no inversions)", () => {
  const waste = calculateSuggestedWaste({
    facetCount: 4,
    valleysLf: 0,
    ridgesHipsLf: 80,
    avgPitchDeg: 22.6,
    totalSqft: 2500,
  });
  const tiers = calculateTieredPricing(2500, waste, "asphalt-architectural");
  const e = tiers.find((t) => t.tier.id === "good")!;
  const s = tiers.find((t) => t.tier.id === "better")!;
  const f = tiers.find((t) => t.tier.id === "best")!;
  assert.ok(e.total < s.total, `Essentials ${e.total} must be less than Standard ${s.total}`);
  assert.ok(s.total < f.total, `Standard ${s.total} must be less than Fortified ${f.total}`);
});

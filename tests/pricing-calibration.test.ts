/**
 * Regression test — locks the 2026-05-23 v2 calibration.
 *
 * v2 used Google Solar API to retrieve sloped roof sqft for 68 of 80
 * Noland's JN closed-won invoices (85% match rate). The Retail median
 * came in at $6.21/sqft (n=40), much lower than the single FGIO
 * observation v1 had used ($10/sqft). v2 anchors Standard at $7.25
 * (slightly above the Retail median).
 *
 * Locked rates:
 *   Essentials   $5.50/sqft
 *   Standard     $7.25/sqft
 *   Fortified    $9.50/sqft
 *
 * To re-calibrate: hit /api/internal/pricing-calibration?sample=80 and
 * update both this file and the comment block in calculate-waste.ts.
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

test("per-sqft rate locked for each tier (v2 Solar API calibration)", () => {
  const essentials = ROOFING_TIERS.find((t) => t.id === "good");
  const standard = ROOFING_TIERS.find((t) => t.id === "better");
  const fortified = ROOFING_TIERS.find((t) => t.id === "best");
  assert.equal(essentials?.ratePerSqft, 5.5);
  assert.equal(standard?.ratePerSqft, 7.25);
  assert.equal(fortified?.ratePerSqft, 9.5);
});

test("architectural shingle default + bands locked at v2 calibration", () => {
  assert.equal(ARCHITECTURAL_SHINGLE_RATE_PER_SQFT, 7.25);
  assert.equal(RATE_LOW_PER_SQFT, 5.5);
  assert.equal(RATE_HIGH_PER_SQFT, 9.75);
});

test("customer-facing material rate band for architectural shingle locked at v2", () => {
  const rates = CUSTOMER_MATERIAL_RATES["asphalt-architectural"];
  assert.ok(rates, "asphalt-architectural rate band must exist");
  assert.equal(rates.low, 5.5);
  assert.equal(rates.mid, 7.25);
  assert.equal(rates.high, 9.75);
});

test("typical 2,500 sqft FL home tiers land in v2 calibrated dollar bands", () => {
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

  // v2 calibration math (2,800 effSqft @ 12% waste):
  //   Essentials 2,800 × $5.50  = $15,400
  //   Standard   2,800 × $7.25  = $20,300
  //   Fortified  2,800 × $9.50  = $26,600
  // ±10% tolerance for waste variance + $50 rounding.
  assert.ok(e.total >= 13_500 && e.total <= 17_500, `Essentials $${e.total} outside [13.5k, 17.5k]`);
  assert.ok(s.total >= 18_000 && s.total <= 23_500, `Standard $${s.total} outside [18k, 23.5k]`);
  assert.ok(f.total >= 23_500 && f.total <= 30_500, `Fortified $${f.total} outside [23.5k, 30.5k]`);
});

test("Standard on a small home (1,500 sqft) lands in v2 calibrated band", () => {
  const waste = calculateSuggestedWaste({
    facetCount: 4,
    valleysLf: 0,
    ridgesHipsLf: 60,
    avgPitchDeg: 18.4,
    totalSqft: 1500,
  });
  const tiers = calculateTieredPricing(1500, waste, "asphalt-architectural");
  const s = tiers.find((t) => t.tier.id === "better")!;
  assert.ok(s.total >= 11_000 && s.total <= 15_500, `Standard $${s.total} outside [11k, 15.5k]`);
});

test("Standard on a larger home (3,500 sqft) lands in v2 calibrated band", () => {
  const waste = calculateSuggestedWaste({
    facetCount: 6,
    valleysLf: 30,
    ridgesHipsLf: 120,
    avgPitchDeg: 22.6,
    totalSqft: 3500,
  });
  const tiers = calculateTieredPricing(3500, waste, "asphalt-architectural");
  const s = tiers.find((t) => t.tier.id === "better")!;
  assert.ok(s.total >= 25_000 && s.total <= 35_000, `Standard $${s.total} outside [25k, 35k]`);
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

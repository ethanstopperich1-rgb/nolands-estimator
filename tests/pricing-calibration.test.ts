/**
 * Regression test — locks the 2026-05-27 PM PDF ground-truth calibration.
 *
 * Supersedes the 2026-05-23 v2 Solar-API calibration ($5.50/$7.25/$9.50).
 * Per Mr. Nolan (Oak Park Rd strategy call #7), tier rates were re-derived
 * against Noland's printed estimate form at the 33-square (3,300 effective
 * sqft) reference roof. Per-EFFECTIVE-sqft rates:
 *
 *   GOOD    $3.90  ($390/square)  → PDF Option 1  $12,875.64
 *   BETTER  $4.21  ($421/square)  → PDF Option 2  $13,905.70
 *   BEST    $4.88  ($488/square)  → PDF Option 3  $16,094.56
 *   ELITE   $5.27  ($527/square)  → PDF Option 4  $17,382.12
 *
 * commit f74ff87 + the ROOFING_TIERS header comment in calculate-waste.ts
 * carry the full derivation. To re-calibrate, update both source + this file.
 *
 * ─── KNOWN DIVERGENCE — do NOT "fix" by editing the locked dollar values ───
 *
 * calculateTieredPricing multiplies each tier by
 *   materialMultiplier = CUSTOMER_MATERIAL_RATES["asphalt-architectural"].mid (7.25)
 *                        / ARCHITECTURAL_SHINGLE_RATE_PER_SQFT (6.95)
 *                      = 1.04317
 * even for the BASE architectural material (and for material=null), because
 * those two "architectural shingle mid rate" constants drifted apart across
 * calibrations. Net effect: the live pipeline quotes ~4.3% ABOVE the
 * PDF-locked tier rates — GOOD lands $13,450 on the 33-square reference roof,
 * not the PDF's $12,876.
 *
 * The tier RATES themselves are PDF-correct (see the bare-rate test below);
 * the materialMultiplier is the leak. Resolving it changes live
 * customer-facing pricing that Mr. Nolan verifies personally, so it is an
 * owner decision, not a test edit. Until then:
 *   - the "bare tier math" test locks the PDF-correct INTENT, and
 *   - the "pipeline output" + per-home tests lock the CURRENT pipeline reality
 *     (a characterization snapshot — any unintended pricing drift trips it).
 * When the multiplier is fixed, the characterization numbers below must be
 * re-blessed to the new (lower) output in the same commit.
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
  flatCustomerWaste,
} from "../lib/pricing/calculate-waste";

test("per-sqft rate locked for each tier (2026-05-27 PM PDF ground truth)", () => {
  const good = ROOFING_TIERS.find((t) => t.id === "good");
  const better = ROOFING_TIERS.find((t) => t.id === "better");
  const best = ROOFING_TIERS.find((t) => t.id === "best");
  const elite = ROOFING_TIERS.find((t) => t.id === "elite");
  assert.equal(good?.ratePerSqft, 3.9);
  assert.equal(better?.ratePerSqft, 4.21);
  assert.equal(best?.ratePerSqft, 4.88);
  assert.equal(elite?.ratePerSqft, 5.27);
});

test("architectural shingle anchor + customer range bands locked", () => {
  // Anchor used as the materialMultiplier denominator. NOTE: this is 6.95
  // while CUSTOMER_MATERIAL_RATES["asphalt-architectural"].mid is 7.25 — the
  // drift that produces the +4.3% multiplier divergence documented above.
  assert.equal(ARCHITECTURAL_SHINGLE_RATE_PER_SQFT, 6.95);
  // Customer-facing price-range band (GOOD $6.44 .. ELITE $8.70 from the PDF).
  assert.equal(RATE_LOW_PER_SQFT, 6.44);
  assert.equal(RATE_HIGH_PER_SQFT, 8.7);
});

test("customer-facing material rate band for architectural shingle locked", () => {
  const rates = CUSTOMER_MATERIAL_RATES["asphalt-architectural"];
  assert.ok(rates, "asphalt-architectural rate band must exist");
  assert.equal(rates.low, 5.5);
  assert.equal(rates.mid, 7.25);
  assert.equal(rates.high, 9.75);
});

test("bare tier math reproduces Noland's printed estimate on the 33-square reference roof", () => {
  // PDF reference roof = 33 squares = 3,300 EFFECTIVE sqft.
  // flatCustomerWaste = 10%, so 3,000 net → round(3,000 × 1.10) = 3,300 eff.
  const eff = Math.round(3000 * (1 + flatCustomerWaste(3000).suggestedPercent / 100));
  assert.equal(eff, 3300, "reference roof must be exactly 3,300 effective sqft");

  // The PDF dollar amounts the tier RATES were derived from. The bare math
  // (effSqft × ratePerSqft, $50-rounded — no material multiplier) must land
  // within one $50 rounding step of each printed figure.
  const pdf: Record<string, number> = {
    good: 12_875.64,
    better: 13_905.7,
    best: 16_094.56,
    elite: 17_382.12,
  };
  for (const tier of ROOFING_TIERS) {
    const bare = Math.round((eff * tier.ratePerSqft) / 50) * 50;
    const target = pdf[tier.id];
    assert.ok(
      Math.abs(bare - target) <= 50,
      `${tier.id} bare $${bare} must be within $50 of PDF $${target}`,
    );
  }
});

test("pipeline output on the 33-square reference roof (characterization — includes materialMultiplier)", () => {
  const tiers = calculateTieredPricing(3000, flatCustomerWaste(3000), "asphalt-architectural");
  const total = (id: string) => tiers.find((t) => t.tier.id === id)!.total;
  // Current live-pipeline output. ~4.3% above the bare/PDF values because of
  // the materialMultiplier divergence (see header). Re-bless when fixed.
  assert.equal(total("good"), 13_450);
  assert.equal(total("better"), 14_500);
  assert.equal(total("best"), 16_800);
  assert.equal(total("elite"), 18_150);
});

test("typical 2,500 sqft FL home — pipeline output snapshot", () => {
  const waste = calculateSuggestedWaste({
    facetCount: 4,
    valleysLf: 0,
    ridgesHipsLf: 80,
    avgPitchDeg: 22.6,
    totalSqft: 2500,
  });
  assert.equal(waste.suggestedPercent, 19);
  const tiers = calculateTieredPricing(2500, waste, "asphalt-architectural");
  const total = (id: string) => tiers.find((t) => t.tier.id === id)!.total;
  assert.equal(tiers[0].effectiveSqft, 2975);
  assert.equal(total("good"), 12_100);
  assert.equal(total("better"), 13_050);
  assert.equal(total("best"), 15_150);
  assert.equal(total("elite"), 16_350);
});

test("small home (1,500 sqft) — pipeline output snapshot", () => {
  const waste = calculateSuggestedWaste({
    facetCount: 4,
    valleysLf: 0,
    ridgesHipsLf: 60,
    avgPitchDeg: 18.4,
    totalSqft: 1500,
  });
  const tiers = calculateTieredPricing(1500, waste, "asphalt-architectural");
  const total = (id: string) => tiers.find((t) => t.tier.id === id)!.total;
  assert.equal(total("good"), 7_150);
  assert.equal(total("better"), 7_700);
  assert.equal(total("best"), 8_950);
  assert.equal(total("elite"), 9_650);
});

test("larger home (3,500 sqft) — pipeline output snapshot", () => {
  const waste = calculateSuggestedWaste({
    facetCount: 6,
    valleysLf: 30,
    ridgesHipsLf: 120,
    avgPitchDeg: 22.6,
    totalSqft: 3500,
  });
  const tiers = calculateTieredPricing(3500, waste, "asphalt-architectural");
  const total = (id: string) => tiers.find((t) => t.tier.id === id)!.total;
  assert.equal(total("good"), 18_250);
  assert.equal(total("better"), 19_650);
  assert.equal(total("best"), 22_800);
  assert.equal(total("elite"), 24_650);
});

test("tier dollar ordering: Good < Better < Best < Elite (no inversions)", () => {
  const waste = calculateSuggestedWaste({
    facetCount: 4,
    valleysLf: 0,
    ridgesHipsLf: 80,
    avgPitchDeg: 22.6,
    totalSqft: 2500,
  });
  const tiers = calculateTieredPricing(2500, waste, "asphalt-architectural");
  const g = tiers.find((t) => t.tier.id === "good")!.total;
  const b = tiers.find((t) => t.tier.id === "better")!.total;
  const be = tiers.find((t) => t.tier.id === "best")!.total;
  const el = tiers.find((t) => t.tier.id === "elite")!.total;
  assert.ok(g < b, `Good ${g} must be < Better ${b}`);
  assert.ok(b < be, `Better ${b} must be < Best ${be}`);
  assert.ok(be < el, `Best ${be} must be < Elite ${el}`);
});

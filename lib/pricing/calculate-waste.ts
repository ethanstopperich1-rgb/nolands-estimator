/**
 * EagleView-style waste-factor calculator.
 *
 * EagleView's premium reports include a "Suggested Waste Factor" derived
 * property-specifically from facet count, valley/hip counts, and pitch
 * distribution. Their public reports show suggested waste anywhere from
 * ~10% on simple gables to ~41% on extremely complex roofs.
 *
 * We mirror their structure:
 *   - One suggested % (the customer doesn't see this; the rep does)
 *   - A waste table at fixed steps so the rep can pick a different number
 *
 * Formula derived from message (5) of the 2026-05-16 product spec.
 * Tuned to land in the 10–28% band for typical Central-Florida residential.
 *
 * INPUT comes from the V3 pipeline shape (facets[] + edges + avgPitch).
 * No legacy RoofData dependency.
 */

export interface WasteInputs {
  /** Facet count from V3 `result.facets.length` (Solar-derived). */
  facetCount: number;
  /** Total valley linear feet from `result.geminiEdges.valleysLf` (preferred)
   *  or `result.edges.valleysLf` (Solar fallback). Used to count "valley
   *  events" — we approximate one valley per 15ft of valley LF. */
  valleysLf: number | null;
  /** Total ridge + hip linear feet. Approximated to event count the same way. */
  ridgesHipsLf: number | null;
  /** Average pitch in degrees from `result.solar.pitchDegrees` (or the
   *  rep's manual entry). */
  avgPitchDeg: number;
  /** Total roof sqft (sloped). Used to size the waste table. */
  totalSqft: number;
}

export interface WasteResult {
  /** Suggested waste percentage, e.g. 14. Already capped to [10, 28]. */
  suggestedPercent: number;
  /** Internal complexity score (higher = more waste). Surfaced on the
   *  internal workbench so the rep can defend the number. */
  complexityScore: number;
  /** Inputs that fed the score, broken out so the internal panel can
   *  show "what drove this". */
  breakdown: {
    fromFacets: number;
    fromValleys: number;
    fromRidgesHips: number;
    fromSteepPitch: number;
  };
  /** Waste table at fixed steps for the rep's reference. Total squares
   *  = sqft / 100 × (1 + percent / 100). */
  table: Array<{ percent: number; totalSquares: number }>;
}

const WASTE_TABLE_STEPS = [0, 10, 12, 15, 18, 20, 25] as const;
const STEEP_PITCH_THRESHOLD_DEG = 33.7; // ≈ 8/12

/** One "valley event" is approximated as 15 LF of total valley line —
 *  matches the typical residential valley run between two roof planes. */
const VALLEY_LF_PER_EVENT = 15;
/** Similar approximation for ridges + hips: each event is ~25 LF
 *  (slightly longer than a valley because ridges span full bays). */
const RIDGE_HIP_LF_PER_EVENT = 25;

export function calculateSuggestedWaste(inputs: WasteInputs): WasteResult {
  const facets = Math.max(0, inputs.facetCount);
  const valleyEvents =
    inputs.valleysLf != null && inputs.valleysLf > 0
      ? inputs.valleysLf / VALLEY_LF_PER_EVENT
      : 0;
  const ridgeHipEvents =
    inputs.ridgesHipsLf != null && inputs.ridgesHipsLf > 0
      ? inputs.ridgesHipsLf / RIDGE_HIP_LF_PER_EVENT
      : 0;

  // Per-driver contributions. Coefficients calibrated to land typical
  // FL residential at 12–18%, hit the 25%+ band only on genuinely
  // complex cross-hip / multi-dormer cases.
  const fromFacets = facets * 0.75;
  const fromValleys = valleyEvents * 3.5;
  const fromRidgesHips = ridgeHipEvents * 1.8;
  const fromSteepPitch = inputs.avgPitchDeg > STEEP_PITCH_THRESHOLD_DEG ? 4 : 0;

  const score = fromFacets + fromValleys + fromRidgesHips + fromSteepPitch;
  const suggestedPercent = Math.min(28, Math.max(10, Math.round(10 + score)));

  const baseSquares = inputs.totalSqft / 100;
  const table = WASTE_TABLE_STEPS.map((percent) => ({
    percent,
    totalSquares: Math.ceil(baseSquares * (1 + percent / 100) * 10) / 10,
  }));

  return {
    suggestedPercent,
    complexityScore: Math.round(score * 10) / 10,
    breakdown: {
      fromFacets: Math.round(fromFacets * 10) / 10,
      fromValleys: Math.round(fromValleys * 10) / 10,
      fromRidgesHips: Math.round(fromRidgesHips * 10) / 10,
      fromSteepPitch,
    },
    table,
  };
}

// ─── Pricing constants ──────────────────────────────────────────────────

/** 2026 Central Florida default for full-turnkey architectural-shingle
 *  reroof — tear-off included, 1–2 layers typical. Sits in the middle
 *  of the $5.50–$8.00 range published by local distributors. */
export const ARCHITECTURAL_SHINGLE_RATE_PER_SQFT = 7.0;

/** Low and high bands for the customer-facing price-range display.
 *  ±10% around the default rate. */
export const RATE_LOW_PER_SQFT = 6.3;
export const RATE_HIGH_PER_SQFT = 7.7;

export interface PriceResult {
  /** sqft × (1 + waste) — what the customer pays the rate against. */
  effectiveSqft: number;
  /** sqft × (1 + waste) × $7.00, rounded. */
  total: number;
  /** Low end at $6.30/sqft. */
  totalLow: number;
  /** High end at $7.70/sqft. */
  totalHigh: number;
  /** The waste object that fed the math, so the internal workbench can
   *  show how the number was reached. */
  waste: WasteResult;
}

export function calculateCustomerPrice(
  totalSqft: number,
  waste: WasteResult,
): PriceResult {
  const effectiveSqft = Math.round(totalSqft * (1 + waste.suggestedPercent / 100));
  return {
    effectiveSqft,
    total: Math.round(effectiveSqft * ARCHITECTURAL_SHINGLE_RATE_PER_SQFT),
    totalLow: Math.round(effectiveSqft * RATE_LOW_PER_SQFT),
    totalHigh: Math.round(effectiveSqft * RATE_HIGH_PER_SQFT),
    waste,
  };
}

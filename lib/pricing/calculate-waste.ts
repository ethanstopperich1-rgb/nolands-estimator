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

// ─── Penetration adders ─────────────────────────────────────────────────
//
// Per-object flashing + labor adders applied on top of sqft × rate ×
// (1 + waste). The $7/sqft turnkey rate folds GENERIC flashing material
// into the per-sqft cost, but per-penetration labor + specialty kits
// scale with the number of objects on the roof — not with sqft. A roof
// with three skylights and a chimney has the same sqft as one with
// nothing on it, but a meaningfully different real cost.
//
// Numbers calibrated to 2026 Central Florida architectural reroof. Each
// figure includes both the flashing material AND the per-fixture labor
// allocation.
//
// Sources of these numbers: FL distributor pricing sheets for vent
// boots / chimney kits / skylight kits, plus typical crew per-fixture
// time (5-30 min depending on type). Numbers are conservative — a
// crew can underrun them on a clean roof, but over-runs (rot under
// the chimney, broken skylight glass, etc.) are also possible.
export const PENETRATION_ADDERS: Record<string, number> = {
  vent: 25,
  plumbing_boot: 25,
  stack: 35,
  chimney: 700,
  skylight: 280,
  hvac_unit: 200,
  satellite_dish: 90,
  // Solar panels stay in place during reroof — no flashing replacement
  // required, just protection during work. Small allocation per panel.
  solar_panel: 50,
};

export interface PenetrationBreakdown {
  /** Counts of each object type from V3 result.objects[]. Unknown
   *  types are tolerated — they contribute $0. */
  counts: Record<string, number>;
  /** Total dollar adder across all penetrations. */
  total: number;
  /** Per-line itemization for the rep workbench. */
  lines: Array<{ type: string; count: number; unit: number; subtotal: number }>;
}

export function calculatePenetrationAdders(
  objects: Array<{ type: string }>,
): PenetrationBreakdown {
  const counts: Record<string, number> = {};
  for (const obj of objects) {
    counts[obj.type] = (counts[obj.type] ?? 0) + 1;
  }
  let total = 0;
  const lines: PenetrationBreakdown["lines"] = [];
  for (const [type, count] of Object.entries(counts)) {
    const unit = PENETRATION_ADDERS[type] ?? 0;
    const subtotal = unit * count;
    total += subtotal;
    lines.push({ type, count, unit, subtotal });
  }
  // Sort by subtotal descending so the most expensive line items rise
  // to the top of the rep's view.
  lines.sort((a, b) => b.subtotal - a.subtotal);
  return { counts, total, lines };
}

export interface PriceResult {
  /** sqft × (1 + waste) — what the customer pays the rate against. */
  effectiveSqft: number;
  /** Shingle line: effectiveSqft × $7.00. */
  shinglesSubtotal: number;
  /** Penetration adders: Σ(count × per-fixture cost). */
  penetrationsSubtotal: number;
  /** shinglesSubtotal + penetrationsSubtotal, rounded. */
  total: number;
  /** Low end: effectiveSqft × $6.30 + penetrations. */
  totalLow: number;
  /** High end: effectiveSqft × $7.70 + penetrations. */
  totalHigh: number;
  /** The waste object that fed the math. */
  waste: WasteResult;
  /** Per-fixture itemization. Empty when no objects on roof. */
  penetrations: PenetrationBreakdown;
}

export function calculateCustomerPrice(
  totalSqft: number,
  waste: WasteResult,
  objects: Array<{ type: string }> = [],
): PriceResult {
  const effectiveSqft = Math.round(totalSqft * (1 + waste.suggestedPercent / 100));
  const shinglesSubtotal = Math.round(
    effectiveSqft * ARCHITECTURAL_SHINGLE_RATE_PER_SQFT,
  );
  const penetrations = calculatePenetrationAdders(objects);
  const shinglesLow = Math.round(effectiveSqft * RATE_LOW_PER_SQFT);
  const shinglesHigh = Math.round(effectiveSqft * RATE_HIGH_PER_SQFT);
  return {
    effectiveSqft,
    shinglesSubtotal,
    penetrationsSubtotal: penetrations.total,
    total: shinglesSubtotal + penetrations.total,
    totalLow: shinglesLow + penetrations.total,
    totalHigh: shinglesHigh + penetrations.total,
    waste,
    penetrations,
  };
}

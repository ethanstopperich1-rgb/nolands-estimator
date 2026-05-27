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
 *  reroof — tear-off included, 1–2 layers typical.
 *
 *  Calibrated 2026-05-23 (v2) against 68 Noland's JN closed-won
 *  invoices paired with Google Solar API sloped-roof sqft (85% match
 *  rate on n=80 Solar API calls). The Solar API returns the true
 *  sloped roof area in roofSegmentStats.areaMeters2 — no pitch
 *  multiplier guesswork.
 *
 *  Observed $/sqft by JN record_type:
 *    Retail              n=40  median $6.21  p25 $5.39  p75 $10.11
 *    Insurance           n=18  median $7.83  p25 $7.34  p75 $8.87
 *    New Construction    n=10  median $4.52  (low — new builds skip tear-off)
 *    OVERALL             n=68  median $7.20  p25 $5.47  p75 $9.66
 *
 *  The Retail median ($6.21) is the most relevant — that's the cash
 *  homeowner doing a roofing project from the estimator. We anchor
 *  the Standard tier (most-chosen) at $7.25 to land slightly above
 *  the Retail median, accounting for the fact that estimator-driven
 *  jobs may skew toward higher complexity than door-knocked walk-ins.
 *
 *  Calibration v1 (earlier today): bumped tiers based on 1 single
 *  high-confidence FGIO observation ($10/sqft). With 68 observations
 *  from Solar API we now see that the actual Noland's Retail rate is
 *  ~$6.21/sqft, NOT $10. v1 OVER-corrected. v2 reverts toward the
 *  real median. */
// 2026-05-26 PDF GROUND-TRUTH RE-CALIBRATION — see ROOFING_TIERS
// header comment for the full derivation. Anchor rate is now $6.95
// (BETTER tier = "Popular" = most-chosen anchor on the paper). Holds
// material multipliers proportional: tile/metal/flat tiers scale off
// this anchor.
export const ARCHITECTURAL_SHINGLE_RATE_PER_SQFT = 6.95;

/** Low and high bands for the customer-facing price-range display.
 *  Anchored to GOOD ($6.44) and ELITE ($8.70) per the May 2026 PDF
 *  ground-truth re-calibration — same dollar range the homeowner
 *  sees on Noland's printed estimate. */
export const RATE_LOW_PER_SQFT = 6.44;
export const RATE_HIGH_PER_SQFT = 8.7;

/**
 * Material-aware customer rate table.
 *
 * The customer flow originally locked to architectural-shingle rates
 * regardless of what Gemini detected — that produced 3–4× UNDER-quotes
 * on metal and 30%+ under-quotes on tile. For a lead-gen tool that's the
 * worst direction to err (rep arrives with a number 2× higher than what
 * the customer expected and the deal evaporates).
 *
 * Bands are full-turnkey installed costs per SLOPED-sqft (after the
 * pitch slope multiplier, before waste). Source: lib/pricing.ts
 * MATERIAL_RATES + Q2 2026 distributor pass-throughs. "unknown" is not
 * in the table; the customerRatesForMaterial() helper falls through to
 * architectural shingle.
 */
export const CUSTOMER_MATERIAL_RATES: Record<
  string,
  { label: string; low: number; mid: number; high: number }
> = {
  "asphalt-3tab": { label: "Builder-grade shingle", low: 4.0, mid: 4.5, high: 5.25 },
  "asphalt-architectural": { label: "Architectural shingle", low: 5.5, mid: 7.25, high: 9.75 },
  "metal-shingle": { label: "Metal shingle", low: 9.0, mid: 11.0, high: 13.5 },
  "metal-standing-seam": { label: "Standing-seam metal", low: 18.0, mid: 22.0, high: 28.0 },
  "tile-concrete": { label: "Concrete tile", low: 7.5, mid: 9.5, high: 12.0 },
  "tile-clay": { label: "Clay tile", low: 11.0, mid: 14.0, high: 18.0 },
  "wood-shake": { label: "Wood shake", low: 8.0, mid: 10.0, high: 14.0 },
  "flat-membrane": { label: "Flat membrane", low: 5.5, mid: 7.0, high: 9.5 },
};

const DEFAULT_MATERIAL_KEY = "asphalt-architectural";

/** Returns the customer-facing rate band for a detected material. Falls
 *  back to architectural shingle when material is null / unknown / not
 *  in the table. */
export function customerRatesForMaterial(
  material: string | null | undefined,
): { key: string; label: string; low: number; mid: number; high: number } {
  if (material && CUSTOMER_MATERIAL_RATES[material]) {
    return { key: material, ...CUSTOMER_MATERIAL_RATES[material] };
  }
  return { key: DEFAULT_MATERIAL_KEY, ...CUSTOMER_MATERIAL_RATES[DEFAULT_MATERIAL_KEY] };
}

/**
 * Translate Gemini Flash's `roof_material.type` enum to our
 * customer-pricing keys. Gemini uses underscore_separated_lowercase;
 * CUSTOMER_MATERIAL_RATES uses hyphen-separated-lowercase. Unknown /
 * mismatched values return null (caller defaults to architectural).
 */
export function geminiMaterialToRateKey(
  geminiType: string | null | undefined,
): string | null {
  if (!geminiType) return null;
  switch (geminiType) {
    case "asphalt_shingle_3tab":
      return "asphalt-3tab";
    case "asphalt_shingle_architectural":
      return "asphalt-architectural";
    case "concrete_tile":
      return "tile-concrete";
    case "clay_tile_barrel":
    case "clay_tile_flat":
      return "tile-clay";
    case "metal_standing_seam":
      return "metal-standing-seam";
    case "metal_corrugated":
      return "metal-shingle";
    case "wood_shake":
      return "wood-shake";
    case "membrane_flat":
      return "flat-membrane";
    case "slate":
      // No dedicated band; clay tile is the closest existing one.
      return "tile-clay";
    case "unknown":
    default:
      return null;
  }
}

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

// ─── Geometric customer-facing waste ────────────────────────────────────
//
// `calculateGeometricWaste` is the production replacement for the flat
// 12% the customer used to see. It derives waste from signals we
// actually measure reliably from satellite imagery:
//
//   - Facet count (cross-validated across three Flash passes)
//   - Azimuth clusters from Solar's per-facet azimuth distribution
//     (number of distinct "wings" of the house, mod 90°)
//   - Compactness of the painted polygon (perimeter² / 4π × area)
//   - Steep-pitch flag (kept from the original formula)
//   - Secondary-structures count from the Flash rich-data pass
//
// What it deliberately does NOT use: edge linear feet from the Gemini
// line-tracer. The tracer under-counts eaves and confuses rakes/hips,
// so the prior edge-LF terms in `calculateSuggestedWaste` are unreliable.
// Solar azimuth distribution + painted-polygon compactness are
// deterministic geometric measurements; they don't depend on Flash's
// edge-classification accuracy.
//
// Output is clamped to [10, 25] — the customer-side range we're
// confident in. The rep workbench retains `calculateSuggestedWaste`
// for the detailed breakdown when edge data is available.

export interface GeometricWasteInputs {
  /** Canonical facet count (painted-Flash > raw-Flash > Solar segments).
   *  Null when no facet count is available — falls back to safe default. */
  facetCount: number | null;
  /** Distinct azimuth clusters from Solar (see countAzimuthClusters). */
  azimuthClusters: number;
  /** Painted-polygon compactness ratio. Null when paint failed. */
  compactness: number | null;
  /** Average pitch in degrees from Solar. */
  avgPitchDeg: number | null;
  /** Count of secondary_structures (attached garages, lanais, additions)
   *  from the Flash rich-data pass. */
  secondaryStructuresCount: number;
  /** Total sloped sqft — used to size the waste table. */
  totalSqft: number;
}

export interface GeometricWasteResult extends WasteResult {
  breakdown: {
    fromFacets: number;
    /** New term — replaces fromValleys + fromRidgesHips. */
    fromAzimuthClusters: number;
    /** New term — painted-polygon shape complexity. */
    fromCompactness: number;
    fromSteepPitch: number;
    /** New term — additions create cuts/seams that drive waste. */
    fromSecondaryStructures: number;
    /** Carried for interface compatibility with WasteResult; always 0. */
    fromValleys: number;
    fromRidgesHips: number;
  };
}

const STEEP_PITCH_THRESHOLD_DEG_GEOMETRIC = 33.7; // ≈ 8/12

export function calculateGeometricWaste(
  inputs: GeometricWasteInputs,
): GeometricWasteResult {
  // Facet term — only contributes above the "simple roof" baseline of
  // 4 facets (a hip with 4 sides). Each extra facet adds 0.8 points.
  const facets = inputs.facetCount ?? 4;
  const fromFacets = Math.max(0, facets - 4) * 0.8;

  // Azimuth-clusters term — the strongest single signal. Each cluster
  // beyond the first represents a distinct wing direction.
  //   1 cluster → +0  (simple gable / simple hip)
  //   2 clusters → +3.5  (L-shape, attached perpendicular addition)
  //   3 clusters → +7.0  (cross-gable)
  //   4+ clusters → +10.5+ (multi-wing complex)
  const fromAzimuthClusters = Math.max(0, inputs.azimuthClusters - 1) * 3.5;

  // Compactness term — measures shape complexity of the painted polygon.
  // The 1.4 baseline corresponds to a simple rectangle; anything above
  // that is shape complexity (notches, wings, L-shapes).
  const fromCompactness =
    inputs.compactness != null && inputs.compactness > 1.4
      ? (inputs.compactness - 1.4) * 8
      : 0;

  // Steep-pitch term — same threshold as the legacy formula. Steep
  // roofs waste more shingles in trim cuts at hip/rake intersections.
  const fromSteepPitch =
    inputs.avgPitchDeg != null && inputs.avgPitchDeg > STEEP_PITCH_THRESHOLD_DEG_GEOMETRIC
      ? 4
      : 0;

  // Secondary-structures term — attached garages, lanais, and additions
  // create extra valley/rake intersections regardless of facet count.
  const fromSecondaryStructures =
    inputs.secondaryStructuresCount >= 2
      ? 3
      : inputs.secondaryStructuresCount === 1
        ? 1.5
        : 0;

  const score =
    fromFacets +
    fromAzimuthClusters +
    fromCompactness +
    fromSteepPitch +
    fromSecondaryStructures;

  // Clamp [10, 25]. The 25% ceiling is tighter than the legacy 28% —
  // the customer-side number should be conservative; the rep can quote
  // higher on the on-site visit when warranted.
  const suggestedPercent = Math.min(25, Math.max(10, Math.round(10 + score)));

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
      fromAzimuthClusters: Math.round(fromAzimuthClusters * 10) / 10,
      fromCompactness: Math.round(fromCompactness * 10) / 10,
      fromSteepPitch,
      fromSecondaryStructures: Math.round(fromSecondaryStructures * 10) / 10,
      fromValleys: 0,
      fromRidgesHips: 0,
    },
    table,
  };
}

// ─── Flat customer-facing waste ─────────────────────────────────────────
//
// The customer flow uses a flat waste assumption because we don't expose
// edge LFs and don't want to over-quote based on a single Solar
// classifier misfire. 10% is the FL residential install-waste floor
// for simple hip-and-gable roofs — tightened from 12% on 2026-05-25
// to keep customer-facing tier prices competitive without
// under-quoting actual install material needs. Reps can still bump
// to 12-28% in the dashboard workbench when complexity warrants
// (steep pitch, multi-facet, lots of valleys).
//
// The internal rep workbench keeps `calculateSuggestedWaste` for the
// detailed breakdown when edge data is available.
export const FLAT_CUSTOMER_WASTE_PERCENT = 10;

export function flatCustomerWaste(totalSqft: number): WasteResult {
  const baseSquares = totalSqft / 100;
  const table = WASTE_TABLE_STEPS.map((percent) => ({
    percent,
    totalSquares: Math.ceil(baseSquares * (1 + percent / 100) * 10) / 10,
  }));
  return {
    suggestedPercent: FLAT_CUSTOMER_WASTE_PERCENT,
    complexityScore: 0,
    breakdown: {
      fromFacets: 0,
      fromValleys: 0,
      fromRidgesHips: 0,
      fromSteepPitch: 0,
    },
    table,
  };
}

// ─── Good / Better / Best tiered pricing ────────────────────────────────
//
// Standard roofer-language three-tier structure used industry-wide. The
// rep can talk the customer up or down; the customer sees their roof
// priced three ways instead of a single range.
//
// Pricing is anchored to 2026 Central Florida retail full-turnkey
// (tear-off + decking pass + underlayment + drip edge + flashing +
// shingles + ridge cap + cleanup + permits + warranty). These rates were
// validated against three distributor sheets (ABC Supply, Beacon, SRS)
// and adjusted for current FL labor (≈ $75–$95/hr per crew member).
//
// Numbers are deliberately conservative on the low end — we'd rather
// quote $9,500 and find a reason to charge $10,200 on site than quote
// $18k and have the customer ghost us.

export interface RoofingTier {
  /** Internal id — kept stable across the rename so dashboard,
   *  share page, JN job descriptions, and /api/gemini-roof don't
   *  break. The customer-facing `name` is what the homeowner sees. */
  id: "good" | "better" | "best" | "elite";
  /** Customer-facing name. Aligned May 2026 with Noland's printed
   *  estimate form (Nolands_Roofing_Estimator.pdf, May 2026):
   *  GOOD / BETTER / BEST / ELITE — 4 tiers verbatim from paper.
   *  Previously folded Best+Elite into one tier — un-folded on
   *  2026-05-26 because the operator wants the full ladder shown
   *  (the +$1,288 ELITE upgrade from BEST is what drives the
   *  "lifetime transferable" close). */
  name: string;
  /** Eyebrow chip text — paper says "Basic Protection" / "Popular" /
   *  "Premium Protection System" — short authority-coded labels above
   *  each tier card. */
  eyebrow: string;
  /** One-line subtitle pitched at homeowner literacy. */
  tagline: string;
  /** Bullet list of material / labor inclusions. */
  features: string[];
  /** Manufacturer warranty headline. */
  warranty: string;
  /** Wind warranty MPH — concrete differentiator between tiers per
   *  Noland's printed PDF (May 27, 2026):
   *    GOOD / BETTER: 130 mph (CertainTeed Landmark base rating)
   *    BEST  / ELITE: 160 mph (Integrity Roof System upgrade)
   *  The wind ladder is a real warranty differentiator — don't widen
   *  to a free `number` type; literal-union locks the values to
   *  match printed marketing. */
  windMph: 130 | 160;
  /** CertainTeed warranty tier badge — escalates up the ladder
   *  matching Noland's actual installer credentials:
   *    GOOD:  SureStart 10yr  (any installer can offer)
   *    BETTER: 3-Star  (only Select Shingle Master can offer)
   *    BEST:  5-Star Premier  (only Premier Contractor can offer —
   *           only 2 roofers in all of Central Florida hold this) */
  ctWarranty: "SureStart 10yr" | "3-Star" | "4-Star" | "5-Star Premier";
  /** Aspirational exclusivity claim — set only on the top tier
   *  to anchor the "only 2 in Central Florida" anti-status signal. */
  exclusiveClaim?: string;
  /** Per-effective-sqft installed rate (sloped sqft × (1 + waste)). */
  ratePerSqft: number;
  /** Internal-only — color theme for chip rendering. */
  accent: "neutral" | "primary" | "premium" | "elite";
}

// Tier feature lists align with the CertainTeed product ladder.
// Noland's Roofing is a CertainTeed Triple Crown Champion installer
// (one of CertainTeed's top installer designations, which grants
// access to their 5-Star Warranty program). Aligning our published
// tiers with CertainTeed product names keeps the on-site visit
// continuous with what the homeowner already saw on the estimate —
// "Standard means Landmark Pro" reads the same on the satellite
// estimate, the rep workbench, and the in-person quote.
//
// Source: CertainTeed shingle product line + Noland's public
// installer credentials (nolandsroofing.com — Triple Crown
// Champion award reference).
//
// ─── 2026-05-23 CALIBRATION v2 (Solar API ground-truth, 85% match) ───
//
// Real Noland's data pulled via /api/internal/pricing-calibration.
// Pairs JN closed-won invoices with Google Solar API sloped-roof sqft
// (which is what the V3 estimator uses, so calibration matches what
// the estimator outputs by construction).
//
// Observed $/sqft (n=68, sample=80, 85% Solar API match rate):
//   Retail              n=40  median $6.21  p25 $5.39  p75 $10.11
//   Insurance           n=18  median $7.83  p25 $7.34  p75 $8.87
//   New Construction    n=10  median $4.52  (new builds skip tear-off)
//   OVERALL             n=68  median $7.20  p25 $5.47  p75 $9.66
//
// v1 (earlier today) bumped tiers to $6/$8/$10.50 based on 1 single
// FGIO observation at $10/sqft. With 68 Solar API observations we now
// see that's an outlier — the actual Retail median is $6.21/sqft.
// v1 OVER-corrected. v2 anchors Standard at $7.25 (slightly above
// Retail median to account for estimator-driven jobs skewing toward
// higher complexity than walk-ins) and preserves the tier spread
// proportionally.
//
// New rate spread (sloped sqft, before per-fixture penetration adders):
//   Essentials   $5.50  (just below Retail p25 of $5.39)
//   Standard     $7.25  (Retail median + small premium)
//   Fortified    $9.50  (between Retail p75 $10.11 and Insurance p75 $8.87)
//
// Verification math (2,500 sqft typical FL home @ 10% waste = 2,750 effSqft):
//   Essentials   2,750 × $5.50  = $15,125
//   Standard     2,750 × $7.25  = $19,938  ← Retail median $6.21 × 2,750 = $17,078 + premium
//   Fortified    2,750 × $9.50  = $26,125  ← matches Insurance p75 + walkthrough adders
//
// Per-office override via env: NOLANDS_STANDARD_RATE_PER_SQFT will be
// added when the four offices want per-region calibration (Clermont vs
// Fort Myers vs Bradenton have different labor costs). For now the
// rates are uniform across offices.
//
// To re-run the calibration: GET /api/internal/pricing-calibration with
// `?sample=80` (or higher). Free as long as Solar API stays under 10K
// calls/month for the billing account.
// Tier feature lists now mirror Noland's printed estimate form
// (Nolands_Roofing_Estimator.pdf, May 2026). Customer experience
// stays continuous from website → painted result → rep sit-down.
//
// ─── 2026-05-26 PDF GROUND-TRUTH RE-CALIBRATION ───
//
// Re-read Noland's actual printed estimate. 4 tiers, not 3. Exact
// dollar amounts on the paper for the reference 2,000-sqft roof:
//
//   Option 1  GOOD   "Basic Protection"  Economy           $12,875.64
//   Option 2  BETTER "Popular"  All CertainTeed Approved   $13,905.70
//   Option 3  BEST   "Premium Protection System"           $16,094.56
//   Option 4  ELITE  "Best of the Best" — Only 2 Roofers   $17,382.12
//
// All 4 quoted at 15-yr @ 11.99% APR (FINANCE_TERMS updated).
//
// Per-sqft rates derived by ÷ 2,000 sqft (the reference roof size
// implied by the dollar amounts matching JN closed-won median):
//
//   GOOD    $6.44/sqft   (was $5.50 — under-priced by ~17%)
//   BETTER  $6.95/sqft   (was $7.25 — was close, slightly trimmed)
//   BEST    $8.05/sqft   (NEW middle-upper tier — 4-Star + Integrity)
//   ELITE   $8.70/sqft   (was "Best" at $9.50 — now properly framed
//                         as ELITE with the 5-Star Premier credential)
//
// ─── 2026-05-27 PM CORRECTED CALIBRATION ───
//
// The original "÷ 2,000 sqft" derivation was wrong. The PDF reference
// roof is actually **33 roofing squares = 3,300 effective sqft**
// (post-waste). Reverse-engineering from Mr. Nolan's verbal on the
// Oak Park 7 call:
//   "Hey, the numbers I gave you yesterday or day before, that was
//   based on 33 squares."
//   "It should have been at 390 square."
//
// Confirmed by the PDF math:
//   $12,875.64 ÷ 33 squares = $390.17/square = $3.90/sqft
//
// All 4 tiers derive against the same 33-square reference:
//
//   GOOD    3,300 × $3.90 = $12,870  → matches PDF $12,875.64 ✓ ($390/sq)
//   BETTER  3,300 × $4.21 = $13,893  → matches PDF $13,905.70 ✓ ($421/sq)
//   BEST    3,300 × $4.88 = $16,104  → matches PDF $16,094.56 ✓ ($488/sq)
//   ELITE   3,300 × $5.27 = $17,391  → matches PDF $17,382.12 ✓ ($527/sq)
//
// All deltas inside the $50 rounding step calculateTieredPricing
// applies. The estimator produces prices that match what Noland's
// would hand-write on the printed estimate form for the same roof.
//
// IMPORTANT — these are per-EFFECTIVE-sqft rates. The calc does
// `effectiveSqft = totalSqft × (1 + waste%)` and then
// `total = effectiveSqft × ratePerSqft`. Satellite measurement
// returns NET roof area; waste is the multiplier that converts net
// to install-area. Default 10% waste; complex roofs scale up.
//
// Verification on Roy's house (4871 Esplanade St, 5,830 sqft post-
// waste = 58.3 squares):
//   GOOD    5,830 × $3.90 = $22,737  ← Mr. Nolan's "$390/sq" target ✓
//   BETTER  5,830 × $4.21 = $24,544
//   BEST    5,830 × $4.88 = $28,450
//   ELITE   5,830 × $5.27 = $30,724
//
// These are intentionally lower than typical Florida market rates.
// Mr. Nolan: "I purposely want this to be a little bit cheaper than
// what our actual price is to attract more customers. My salesman's
// job to actually go there and sell it." Salesperson closes at 50%
// in-person and upsells if the inspection reveals more scope.
//
// Locked by Mr. Nolan: "I want to double check the algorithm before
// you make it live." Smoke-test on 4871 Esplanade St must produce
// $22,737 ±2% on GOOD before going live on estimate.nolandsroofing.com.
//
// Wind + warranty laddering (verbatim from PDF):
//   GOOD    130 MPH · CertainTeed SureStart 10yr
//   BETTER  130 MPH · CertainTeed 3-Star (Select Shingle Master only)
//   BEST    160 MPH · CertainTeed 4-Star (Select Shingle Master only)
//                   + Integrity Roof System
//   ELITE   160 MPH · CertainTeed 5-Star Premier (only 2 roofers in
//                                                 Central FL)
//                   + Integrity Roof System
//
// Shingle laddering:
//   GOOD/BETTER use Landmark (architectural)
//   BEST uses Landmark Pro
//   ELITE uses Landmark Shingles PRO (same shingle name as BEST on
//   paper; the differentiator at ELITE is the 5-Star Premier
//   exclusivity, not a different shingle line)
export const ROOFING_TIERS: RoofingTier[] = [
  {
    id: "good",
    name: "Good",
    eyebrow: "Basic Protection",
    tagline:
      "Economy package — CertainTeed Landmark shingles + the SureStart manufacturer warranty.",
    features: [
      "CertainTeed Landmark architectural shingle",
      "CertainTeed Shadow Ridge + Swift Start starter",
      "Synthetic underlayment",
      "Aluminum drip edge + pipe boots",
      "Permit + tear-off + magnetic site sweep",
      "10-year workmanship warranty",
    ],
    warranty:
      "CertainTeed SureStart — 10-yr manufacturing defects · 130 mph wind",
    windMph: 130,
    ctWarranty: "SureStart 10yr",
    // PDF-derived rate (Noland's printed estimate, 33-square reference):
    // $12,875.64 ÷ 3,300 effective sqft = $3.90/sqft = $390/square.
    // Locked by Mr. Nolan on Oak Park 7 call.
    ratePerSqft: 3.9,
    accent: "neutral",
  },
  {
    id: "better",
    name: "Better",
    eyebrow: "Popular",
    tagline:
      "Most Florida homeowners pick this — Landmark shingles + the upgraded 3-Star warranty only a CertainTeed Select Shingle Master can offer.",
    features: [
      "CertainTeed Landmark architectural shingle",
      "CertainTeed Shadow Ridge + Swift Start starter",
      "Synthetic underlayment + starter strip",
      "Ice & water shield in valleys + at penetrations",
      "Pre-finished aluminum drip edge",
      "Hip & ridge cap shingles",
      "CertainTeed 3-Star Warranty (Select Shingle Master only)",
    ],
    warranty: "CertainTeed 3-Star Warranty · 130 mph wind · 15-yr workmanship",
    windMph: 130,
    ctWarranty: "3-Star",
    // PDF-derived: $13,905.70 ÷ 3,300 effective sqft = $4.21/sqft = $421/square.
    ratePerSqft: 4.21,
    accent: "primary",
  },
  {
    id: "best",
    name: "Best",
    eyebrow: "Premium Protection System",
    tagline:
      "CertainTeed Landmark Pro + the Integrity Roof System upgraded to 160 mph wind with the 4-Star Warranty — only a CertainTeed Select Shingle Master can offer this.",
    features: [
      "CertainTeed Landmark Pro premium dimensional shingle",
      "CertainTeed Shadow Ridge + Swift Start starter",
      "CertainTeed Integrity Roof System (engineered as a system, not parts)",
      "Synthetic underlayment + ice & water in valleys + penetrations",
      "Pre-finished aluminum drip edge + premium ridge vent",
      "Upgraded wind warranty: 160 mph",
      "CertainTeed 4-Star Warranty (Select Shingle Master only)",
    ],
    warranty:
      "CertainTeed 4-Star Warranty · 160 mph wind · 20-yr workmanship",
    windMph: 160,
    ctWarranty: "4-Star",
    // PDF-derived: $16,094.56 ÷ 3,300 effective sqft = $4.88/sqft = $488/square.
    ratePerSqft: 4.88,
    accent: "premium",
  },
  {
    id: "elite",
    name: "Elite",
    eyebrow: "Best of the Best",
    tagline:
      "The flagship — same Integrity Roof System as Best, upgraded to the CertainTeed 5-Star Premier Warranty. A credential only 2 roofers in all of Central Florida can offer.",
    features: [
      "CertainTeed Landmark Pro premium dimensional shingle",
      "CertainTeed Shadow Ridge + Swift Start starter",
      "CertainTeed Integrity Roof System (engineered as a system, not parts)",
      "Synthetic underlayment + ice & water across the full roof deck",
      "Pre-finished aluminum drip edge + premium ridge vent",
      "Hurricane-grade ring-shank nailing pattern",
      "Upgraded wind warranty: 160 mph",
      "CertainTeed 5-Star Premier Warranty (only 2 roofers in Central FL) — lifetime transferable",
    ],
    warranty:
      "CertainTeed 5-Star Premier Warranty · 160 mph wind · Lifetime transferable",
    windMph: 160,
    ctWarranty: "5-Star Premier",
    exclusiveClaim: "Only 2 roofers in all of Central Florida can offer this",
    // PDF-derived: $17,382.12 ÷ 3,300 effective sqft = $5.27/sqft = $527/square.
    ratePerSqft: 5.27,
    accent: "elite",
  },
];

export interface TierPrice {
  tier: RoofingTier;
  /** sqft × (1 + waste) — what the rate is multiplied against. */
  effectiveSqft: number;
  /** Final price: effectiveSqft × tier.ratePerSqft, rounded to $50. */
  total: number;
  /** Estimated monthly payment at our default financing terms. The
   *  customer-visible headline. See `FINANCE_TERMS` for the math. */
  monthly: number;
}

/**
 * Default financing terms surfaced to the homeowner.
 *
 * Calibrated against typical roofing finance partners in FL (Service
 * Finance, GreenSky, EnerBank, Hearth, Mosaic). 15-year @ 11.99% APR
 * matches Noland's printed estimate form — most partners have a
 * 6.99–12.99% range with 10/15/20-year options. We surface 11.99/15
 * as the default so the monthly number is honest (not a teaser 0% APR
 * that resets to 24.99% after year one) and matches the rate Noland's
 * already quotes on paper.
 *
 * If/when a real finance partner is wired up (Hearth API is the most
 * dev-friendly), this constant gets replaced by a live partner quote.
 */
export const FINANCE_TERMS = {
  // 11.99% APR matches Noland's printed estimate form (Nolands_Roofing_
  // Estimator.pdf, May 2026 — all 4 tiers quoted at "15 year @ 11.99%
  // APR"). Was 9.99% — that was a guess from earlier in the build that
  // under-quoted the monthly payment by ~$30-50 per tier. Corrected to
  // match ground truth.
  aprPercent: 11.99,
  termMonths: 180, // 15 years
} as const;

/**
 * Standard amortizing monthly payment.
 *
 *   P × r(1+r)^n / ((1+r)^n − 1)
 *
 * where P = principal, r = monthly rate (APR/12), n = term months.
 *
 * Returns 0 when principal ≤ 0 or terms are invalid (callers can
 * branch on that for the "no estimate yet" empty state).
 */
export function monthlyFromTotal(
  principal: number,
  aprPercent: number = FINANCE_TERMS.aprPercent,
  termMonths: number = FINANCE_TERMS.termMonths,
): number {
  if (principal <= 0 || aprPercent < 0 || termMonths <= 0) return 0;
  if (aprPercent === 0) return Math.round(principal / termMonths);
  const r = aprPercent / 100 / 12;
  const factor = Math.pow(1 + r, termMonths);
  const monthly = (principal * r * factor) / (factor - 1);
  return Math.round(monthly);
}

/** Compute prices for all four tiers from a sqft + waste pair.
 *
 *  Rounds to the nearest $50 so the customer doesn't see "$9,847" — the
 *  visual register of a quote is round numbers, not laser-precise math.
 */
export function calculateTieredPricing(
  totalSqft: number,
  waste: WasteResult,
  /** Detected material key (CUSTOMER_MATERIAL_RATES). When omitted /
   *  unknown, tier rates use the legacy architectural-shingle baseline. */
  material?: string | null,
): TierPrice[] {
  const effectiveSqft = Math.round(totalSqft * (1 + waste.suggestedPercent / 100));
  const rates = customerRatesForMaterial(material);
  const materialMultiplier = rates.mid / ARCHITECTURAL_SHINGLE_RATE_PER_SQFT;
  return ROOFING_TIERS.map((tier) => {
    const scaledRate = tier.ratePerSqft * materialMultiplier;
    const raw = effectiveSqft * scaledRate;
    const total = Math.round(raw / 50) * 50;
    const monthly = monthlyFromTotal(total);
    return { tier, effectiveSqft, total, monthly };
  });
}

/** Compute prices for all four tiers AND add per-fixture penetration
 *  adders on top of each tier's shingle line. Real total = effectiveSqft
 *  × tier.ratePerSqft × materialMultiplier + Σ(per-fixture adder × count),
 *  rounded to $50.
 *
 *  This is what the customer should see — a roof with three skylights
 *  and a chimney really does cost $1,260 more than an identical-sqft
 *  bare roof, AND a concrete-tile roof costs ~35% more than the
 *  architectural-shingle baseline. Stacks the material-aware tier
 *  scaling (calculateTieredPricing) with per-fixture adders + monthly
 *  amortization in one call. */
export function calculateTieredPricingWithPenetrations(
  totalSqft: number,
  waste: WasteResult,
  objects: Array<{ type: string }>,
  /** Detected material key (CUSTOMER_MATERIAL_RATES). Falls back to
   *  architectural shingle when omitted / unknown. */
  material?: string | null,
): { tiers: TierPrice[]; penetrations: PenetrationBreakdown } {
  const penetrations = calculatePenetrationAdders(objects);
  const effectiveSqft = Math.round(totalSqft * (1 + waste.suggestedPercent / 100));
  const rates = customerRatesForMaterial(material);
  const materialMultiplier = rates.mid / ARCHITECTURAL_SHINGLE_RATE_PER_SQFT;
  const tiers = ROOFING_TIERS.map((tier) => {
    const scaledRate = tier.ratePerSqft * materialMultiplier;
    const raw = effectiveSqft * scaledRate + penetrations.total;
    const total = Math.round(raw / 50) * 50;
    const monthly = monthlyFromTotal(total);
    return { tier, effectiveSqft, total, monthly };
  });
  return { tiers, penetrations };
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

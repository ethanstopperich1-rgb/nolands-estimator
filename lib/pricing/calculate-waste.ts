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
  "asphalt-3tab": { label: "Builder-grade shingle", low: 3.8, mid: 4.4, high: 5.1 },
  "asphalt-architectural": { label: "Architectural shingle", low: 6.3, mid: 7.0, high: 7.7 },
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

// ─── Flat customer-facing waste ─────────────────────────────────────────
//
// The customer flow uses a flat waste assumption because we don't expose
// edge LFs and don't want to over-quote based on a single Solar
// classifier misfire. 12% is the FL residential midpoint for simple
// hip-and-gable roofs — a touch lower than the earlier 15% which was
// causing perceived over-pricing on simple homes.
//
// The internal rep workbench keeps `calculateSuggestedWaste` for the
// detailed breakdown when edge data is available.
export const FLAT_CUSTOMER_WASTE_PERCENT = 12;

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
  /** Internal id. */
  id: "good" | "better" | "best";
  /** Customer-facing name. */
  name: string;
  /** One-line subtitle pitched at homeowner literacy. */
  tagline: string;
  /** Bullet list of material / labor inclusions. */
  features: string[];
  /** Manufacturer warranty headline. */
  warranty: string;
  /** Per-effective-sqft installed rate (sloped sqft × (1 + waste)). */
  ratePerSqft: number;
  /** Internal-only — color theme for chip rendering. */
  accent: "neutral" | "primary" | "premium";
}

export const ROOFING_TIERS: RoofingTier[] = [
  {
    id: "good",
    name: "Essentials",
    tagline: "Code-compliant reroof. Solid 30-year shingle, basic kit.",
    features: [
      "30-year architectural shingle (GAF Royal Sovereign or comparable)",
      "Synthetic underlayment",
      "Aluminum drip edge + pipe boots",
      "Standard ridge cap",
      "Permit + tear-off + haul-away",
      "10-year workmanship warranty",
    ],
    warranty: "30-year manufacturer · 10-year workmanship",
    ratePerSqft: 5.25,
    accent: "neutral",
  },
  {
    id: "better",
    name: "Standard",
    tagline: "What most Florida homeowners pick. Premium architectural + ice & water.",
    features: [
      "Premium architectural shingle (GAF Timberline HDZ or Owens Corning Duration)",
      "Synthetic underlayment + starter strip",
      "Ice & water shield in valleys + penetrations",
      "Pre-finished aluminum drip edge",
      "Hip & ridge cap shingles",
      "130 mph wind warranty",
      "Lifetime limited manufacturer warranty",
    ],
    warranty: "Lifetime manufacturer · 15-year workmanship",
    ratePerSqft: 7.0,
    accent: "primary",
  },
  {
    id: "best",
    name: "Fortified",
    tagline: "Impact-rated. Qualifies for FL insurance discounts.",
    features: [
      "Class 4 impact-resistant shingle (GAF Armor Shield II or Atlas StormMaster)",
      "Synthetic underlayment + ice & water across entire roof deck",
      "Pre-finished aluminum drip edge + premium ridge vent",
      "Hurricane-grade ring-shank nailing pattern",
      "Designer hip & ridge cap (Timbertex or equivalent)",
      "Wind warranty rated 130+ mph",
      "50-year transferable warranty",
      "Insurance hail / wind discount eligibility",
    ],
    warranty: "50-year transferable · 25-year workmanship",
    ratePerSqft: 9.5,
    accent: "premium",
  },
];

export interface TierPrice {
  tier: RoofingTier;
  /** sqft × (1 + waste) — what the rate is multiplied against. */
  effectiveSqft: number;
  /** Final price: effectiveSqft × tier.ratePerSqft, rounded to $50. */
  total: number;
}

/** Compute prices for all three tiers from a sqft + waste pair.
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
    return { tier, effectiveSqft, total };
  });
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

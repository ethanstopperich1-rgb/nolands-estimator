/**
 * Material-classification ensemble — combines two independent signals:
 *
 *   1. **Flash** — single-image satellite tile call (raw aerial only).
 *      Schema in lib/gemini-roof-prompt.ts:GEMINI_ROOF_SCHEMA.
 *      Enum is richer (11 values) but the single top-down angle is
 *      the worst angle for material discrimination: barrel tile vs
 *      pavers blur, architectural vs 3-tab blur, standing-seam metal
 *      can read as flat membrane.
 *
 *   2. **Pro 2-image** — top-down + Street View pano, run through
 *      Gemini 2.5 Pro by lib/visual-roof-eval.ts:runVisualRoofEval.
 *      Enum is coarser (8 values) — does not distinguish concrete vs
 *      clay tile sub-types, does not include slate / wood-shake /
 *      metal_corrugated — but the Street View angle shows the material
 *      at the elevation a roofer would judge it. Substantially more
 *      reliable on the materials it CAN classify.
 *
 * The ensemble returns a SINGLE Flash-enum value for the downstream
 * pricing path (lib/pricing/calculate-waste.ts:geminiMaterialToRateKey
 * expects Flash's enum). Pro's coarser enum maps UP to the matching
 * Flash family; when both agree, the more specific Flash value wins.
 *
 * When the two sources DISAGREE at the family level (e.g. Flash says
 * shingle, Pro says metal), the ensemble returns the higher-confidence
 * source's answer at a reduced combined confidence so the pricing path
 * can safely fall back to architectural-shingle defaults via its
 * existing 0.65 confidence threshold.
 *
 * When Pro is unavailable (pano skipped, identity mismatch, eval
 * failed), the ensemble returns Flash unchanged. When Flash is
 * unavailable, returns Pro mapped to its Flash equivalent.
 */

/** Flash satellite call's material enum — matches GEMINI_ROOF_SCHEMA. */
export type FlashMaterial =
  | "asphalt_shingle_3tab"
  | "asphalt_shingle_architectural"
  | "concrete_tile"
  | "clay_tile_barrel"
  | "clay_tile_flat"
  | "metal_standing_seam"
  | "metal_corrugated"
  | "wood_shake"
  | "slate"
  | "membrane_flat"
  | "unknown";

/** Pro 2-image call's material enum — matches lib/visual-roof-eval.ts. */
export type ProMaterial =
  | "asphalt_3tab"
  | "asphalt_architectural"
  | "concrete_tile"
  | "clay_tile"
  | "metal_standing_seam"
  | "flat_membrane"
  | "mixed"
  | "unknown";

export type ProConfidenceBand = "high" | "medium" | "low";

export interface EnsembleInput {
  /** Flash satellite material call. Null when Flash call failed. */
  flash: { type: string; confidence: number } | null;
  /** Pro 2-image (top-down + Street View) result. Null when:
   *  - pano was skipped (rural / >30m guardrail)
   *  - identity gate tripped (Pro saw a different building)
   *  - Pro call failed / timed out / parse error */
  pro: { type: string; confidence: ProConfidenceBand } | null;
}

export interface EnsembleResult {
  /** Best Flash-enum value to feed to geminiMaterialToRateKey. */
  material: FlashMaterial;
  /** Combined confidence 0–1. The downstream pricing path uses a 0.65
   *  threshold — anything below that falls back to architectural-
   *  shingle defaults. */
  confidence: number;
  /** Where the answer came from. Logged in route.ts and surfaced on
   *  the rep workbench so the audit trail is honest. */
  source:
    | "agree"           // both sources agree at family level
    | "flash_only"      // Pro unavailable, used Flash
    | "pro_only"        // Flash unavailable, used Pro mapped
    | "flash_wins"      // disagree, Flash had higher confidence
    | "pro_wins"        // disagree, Pro had higher confidence
    | "disagree_unknown"; // disagree, both confident → fall back
}

/** Pro coarse enum → Flash equivalent. Family-level mapping; when both
 *  sources agree at the family level the more specific Flash sub-type
 *  is preserved (e.g. Pro "clay_tile" + Flash "clay_tile_barrel" → keep
 *  the Flash barrel value). */
function mapProToFlash(pro: ProMaterial): FlashMaterial {
  switch (pro) {
    case "asphalt_3tab":
      return "asphalt_shingle_3tab";
    case "asphalt_architectural":
      return "asphalt_shingle_architectural";
    case "concrete_tile":
      return "concrete_tile";
    case "clay_tile":
      // Pro doesn't distinguish barrel vs flat — pick barrel as the
      // FL default; the rate band for both clay sub-types is identical.
      return "clay_tile_barrel";
    case "metal_standing_seam":
      return "metal_standing_seam";
    case "flat_membrane":
      return "membrane_flat";
    case "mixed":
    case "unknown":
      return "unknown";
  }
}

/** Coarse family bucket for the disagreement check. Sub-types within a
 *  family all map to the same bucket so "Flash clay_tile_barrel + Pro
 *  clay_tile" counts as agreement, not disagreement. */
function familyOf(m: FlashMaterial): string {
  switch (m) {
    case "asphalt_shingle_3tab":
    case "asphalt_shingle_architectural":
      return "asphalt";
    case "concrete_tile":
    case "clay_tile_barrel":
    case "clay_tile_flat":
      return "tile";
    case "metal_standing_seam":
    case "metal_corrugated":
      return "metal";
    case "wood_shake":
      return "wood";
    case "slate":
      return "slate";
    case "membrane_flat":
      return "membrane";
    case "unknown":
      return "unknown";
  }
}

/** Pro confidence band → numeric, calibrated against Flash's 0–1 scale.
 *  high=0.85 mirrors Flash's "HIGH" Solar imagery confidence; medium=
 *  0.65 sits right at the existing pricing trust threshold; low=0.45
 *  is below the threshold, so a Pro-low result alone never drives
 *  pricing away from the architectural-shingle default. */
function proConfToNumeric(c: ProConfidenceBand): number {
  switch (c) {
    case "high":
      return 0.85;
    case "medium":
      return 0.65;
    case "low":
      return 0.45;
  }
}

/** Validates a string is a known Flash enum value. Returns "unknown"
 *  when the input doesn't match — defensive against schema drift on
 *  either end. */
function asFlashEnum(s: string): FlashMaterial {
  const allowed: ReadonlyArray<FlashMaterial> = [
    "asphalt_shingle_3tab",
    "asphalt_shingle_architectural",
    "concrete_tile",
    "clay_tile_barrel",
    "clay_tile_flat",
    "metal_standing_seam",
    "metal_corrugated",
    "wood_shake",
    "slate",
    "membrane_flat",
    "unknown",
  ];
  return (allowed as ReadonlyArray<string>).includes(s)
    ? (s as FlashMaterial)
    : "unknown";
}

/** Validates a string is a known Pro enum value. */
function asProEnum(s: string): ProMaterial {
  const allowed: ReadonlyArray<ProMaterial> = [
    "asphalt_3tab",
    "asphalt_architectural",
    "concrete_tile",
    "clay_tile",
    "metal_standing_seam",
    "flat_membrane",
    "mixed",
    "unknown",
  ];
  return (allowed as ReadonlyArray<string>).includes(s)
    ? (s as ProMaterial)
    : "unknown";
}

/** Core ensemble decision. Pure function — easy to unit-test. */
export function ensembleMaterial(input: EnsembleInput): EnsembleResult {
  const flash = input.flash
    ? { type: asFlashEnum(input.flash.type), confidence: input.flash.confidence }
    : null;
  const pro = input.pro
    ? {
        type: asProEnum(input.pro.type),
        confidence: proConfToNumeric(input.pro.confidence),
      }
    : null;

  // Both unavailable → unknown, zero confidence.
  if (!flash && !pro) {
    return { material: "unknown", confidence: 0, source: "flash_only" };
  }

  // Only Flash available — pass through unchanged.
  if (flash && !pro) {
    return {
      material: flash.type,
      confidence: flash.confidence,
      source: "flash_only",
    };
  }

  // Only Pro available — map to Flash enum.
  if (!flash && pro) {
    return {
      material: mapProToFlash(pro.type),
      confidence: pro.confidence,
      source: "pro_only",
    };
  }

  // Both available. (Both guaranteed truthy by previous branches; the
  // non-null assertions are safe but explicit for the type checker.)
  const f = flash!;
  const p = pro!;
  const proAsFlash = mapProToFlash(p.type);

  // Pro returned "mixed" or "unknown" — no actionable signal, fall
  // back to Flash without disagreement penalty.
  if (p.type === "mixed" || p.type === "unknown") {
    return {
      material: f.type,
      confidence: f.confidence,
      source: "flash_only",
    };
  }

  // Flash returned "unknown" — trust Pro fully.
  if (f.type === "unknown") {
    return {
      material: proAsFlash,
      confidence: p.confidence,
      source: "pro_only",
    };
  }

  // Family-level comparison. Sub-types in the same family count as
  // agreement (Flash "clay_tile_barrel" + Pro "clay_tile" → agree;
  // Flash keeps its more specific sub-type).
  if (familyOf(f.type) === familyOf(proAsFlash)) {
    return {
      material: f.type,
      // Two sources agree → boost confidence. Cap at 0.95 to leave
      // headroom for genuinely-certain ground-truth signals.
      confidence: Math.min(0.95, Math.max(f.confidence, p.confidence) + 0.1),
      source: "agree",
    };
  }

  // Genuine disagreement. Three sub-cases:
  //   (a) Both confident (≥0.65) → real conflict. Don't pick a winner;
  //       return "unknown" so the downstream 0.65 confidence threshold
  //       falls back to the safe architectural-shingle default rate.
  //   (b) One confident, one not → trust the confident one but reduce
  //       combined confidence so the threshold check stays meaningful.
  //   (c) Neither confident → trust the higher one at its own conf.
  const fConfident = f.confidence >= 0.65;
  const pConfident = p.confidence >= 0.65;

  if (fConfident && pConfident) {
    return {
      material: "unknown",
      confidence: 0.55,
      source: "disagree_unknown",
    };
  }

  if (f.confidence >= p.confidence) {
    return {
      material: f.type,
      // Disagreement penalty: drop combined confidence by 0.15 vs the
      // standalone Flash number. Caps at the original 0.65 threshold —
      // a real "Flash medium, Pro disagrees" case now sits at 0.50 and
      // falls back to architectural defaults. That's the right
      // direction: when sources fight, don't bet the quote on either.
      confidence: Math.max(0, f.confidence - 0.15),
      source: "flash_wins",
    };
  }

  return {
    material: proAsFlash,
    confidence: Math.max(0, p.confidence - 0.15),
    source: "pro_wins",
  };
}

/** Convenience: extract the inputs from a V3 result object's two
 *  material-bearing fields and run the ensemble. Returns null when
 *  neither field is populated. */
export function ensembleFromV3(result: {
  geminiAnalysis: { roofMaterial: { type: string; confidence: number } | null };
  visualRoofAssessment: {
    primaryMaterial: string;
    confidence: "high" | "medium" | "low";
  } | null;
}): EnsembleResult {
  return ensembleMaterial({
    flash: result.geminiAnalysis.roofMaterial,
    pro: result.visualRoofAssessment
      ? {
          type: result.visualRoofAssessment.primaryMaterial,
          confidence: result.visualRoofAssessment.confidence,
        }
      : null,
  });
}


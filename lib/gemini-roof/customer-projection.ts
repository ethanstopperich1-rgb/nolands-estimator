/**
 * Customer-facing V3 projection.
 *
 * The full `GeminiRoofResponseV3` object the pipeline builds carries the
 * data-fusion METHOD (Solar→GIS undercount correction), the vision-pipeline
 * internals (per-facet pitch/azimuth, dual edge classifiers, two-pass
 * agreement + the penetration-filter funnel), and the pricing-model breakdown
 * (geometric-waste term decomposition, per-fixture adder lines). Those are
 * trade secrets — they let a competitor reverse-engineer the estimator.
 *
 * `toCustomerV3()` is the ONLY thing the browser is allowed to see. It is a
 * pure, additive projection: it strips every METHOD field and keeps only the
 * OUTPUT fields the customer page actually renders or recomputes pricing from.
 *
 * INVARIANT — PRICING MUST STAY BYTE-IDENTICAL. The customer page recomputes
 * Good/Better/Best/Elite in-browser from exactly these retained inputs:
 *   - solar.sqft                              (pricing-eligible area)
 *   - geminiAnalysis.roofMaterial.type + .confidence   (material + the
 *       confidence GATE that decides whether the detected material is used
 *       or falls back to architectural shingle — dropping .confidence would
 *       change the price on every NON-asphalt roof)
 *   - pricing.recommendedWastePercent         (waste %)
 *   - objects[].type                          (per-fixture penetration adders)
 * Stripping a field the recompute reads would move a customer-visible price.
 * Mr. Nolan owns pricing. Do not relocate any of the above into the strip set.
 *
 * The full object is still cached (`setCached`) and persisted to the lead row
 * (`persistEstimateToLead`) UNCHANGED — the rep workbench + dashboard need it.
 * This projection applies ONLY to the value returned to a non-staff browser.
 * Staff requests (`isStaffRequest(req)`) get the full object so the rep
 * "Regenerate" / debug surfaces keep working.
 *
 * When this shape changes, bump `CACHE_SCOPE_V3` in route.ts — a stale cache
 * would otherwise serve the old fat payload.
 */

import type { GeminiRoofResponseV3 } from "@/app/api/gemini-roof/route";

/**
 * Slim, OUTPUT-only shape sent to the customer browser. Every field here is
 * something `app/page.tsx` reads to render or to recompute pricing. Mirrors
 * the safe-to-expose subset the `/r/[publicId]` share page already projects.
 */
export interface CustomerV3Response {
  /** Measurements (output). All sqft / pitch / imagery fields — no method. */
  solar: GeminiRoofResponseV3["solar"];
  /** Tile placement for the interactive map. */
  tile: GeminiRoofResponseV3["tile"];
  /** Customer-visible painted composite. */
  paintedImageBase64: GeminiRoofResponseV3["paintedImageBase64"];
  /** Which path produced the visible image (output flag, not a method leak). */
  customerImageSource: GeminiRoofResponseV3["customerImageSource"];
  /** Transparent cyan PNG + bounds for the GroundOverlay on the live map. */
  cyanOverlay: GeminiRoofResponseV3["cyanOverlay"];
  /** Rooftop object overlay pins + per-fixture penetration-adder inputs. */
  objects: GeminiRoofResponseV3["objects"];
  /** EagleView-style penetration rollup (output totals). */
  penetrationTotals: GeminiRoofResponseV3["penetrationTotals"];
  /** Per-facet pitch/azimuth/sqft is a METHOD leak — stripped to empty
   *  placeholders so the customer page's `facets.length` facet-count chip
   *  stays byte-identical without exposing the geometry. */
  facets: Array<Record<string, never>>;
  /** Whole-roof derived output (stories / complexity / etc.). */
  derived: GeminiRoofResponseV3["derived"];
  /** PV-fit + sunshine output. */
  solarPotential: GeminiRoofResponseV3["solarPotential"];
  /** Vision analysis — OUTPUT subset only. Method-y rep fields
   *  (conditionHints, visibleDamage, secondaryStructures, siteObstacles,
   *  apparentAgeBand) are dropped; per-item confidences are dropped EXCEPT
   *  roofMaterial.confidence, which the in-browser pricing gate needs. */
  geminiAnalysis: {
    /** count only — complexity + confidence are method signals, dropped. */
    facetCountEstimate: { count: number } | null;
    /** type drives material-aware pricing; confidence is the pricing gate. */
    roofMaterial: { type: string; confidence: number } | null;
  };
  /** Pricing INPUTS the customer page renders / recomputes from. The
   *  method-y wasteBreakdown + penetrationAdderLines are dropped. */
  pricing: {
    recommendedWastePercent: number;
    penetrationAddersTotal: number;
  };
  /** FL cadastral output for the "Why this roof needs attention" card. */
  parcel: GeminiRoofResponseV3["parcel"];
  /** Customer-facing condition read. Rep-only free-text `observationNotes`
   *  is dropped (matches the share-page projection); the rest renders. */
  visualRoofAssessment:
    | (Omit<
        NonNullable<GeminiRoofResponseV3["visualRoofAssessment"]>,
        "observationNotes"
      >)
    | null;
  /** Render timestamp (output). */
  computedAt: GeminiRoofResponseV3["computedAt"];
}

/**
 * Project a full V3 result down to the customer-safe OUTPUT-only shape.
 *
 * Pure + additive: builds a NEW object referencing only the kept fields.
 * Never mutates `full`. Never touches pricing math — it relocates / strips
 * fields, it does not recompute anything.
 */
export function toCustomerV3(full: GeminiRoofResponseV3): CustomerV3Response {
  const va = full.visualRoofAssessment;

  return {
    solar: full.solar,
    tile: full.tile,
    paintedImageBase64: full.paintedImageBase64,
    customerImageSource: full.customerImageSource,
    cyanOverlay: full.cyanOverlay,
    objects: full.objects,
    penetrationTotals: full.penetrationTotals,
    // Preserve only the COUNT of facets (the page renders `facets.length`);
    // drop every per-facet pitch/azimuth/sqft value (the method leak).
    facets: full.facets.map(() => ({})),
    derived: full.derived,
    solarPotential: full.solarPotential,
    geminiAnalysis: {
      facetCountEstimate: full.geminiAnalysis.facetCountEstimate
        ? { count: full.geminiAnalysis.facetCountEstimate.count }
        : null,
      roofMaterial: full.geminiAnalysis.roofMaterial
        ? {
            type: full.geminiAnalysis.roofMaterial.type,
            confidence: full.geminiAnalysis.roofMaterial.confidence,
          }
        : null,
    },
    pricing: {
      recommendedWastePercent: full.pricing.recommendedWastePercent,
      penetrationAddersTotal: full.pricing.penetrationAddersTotal,
    },
    parcel: full.parcel,
    visualRoofAssessment: va
      ? {
          primaryMaterial: va.primaryMaterial,
          conditionObservations: va.conditionObservations,
          confidence: va.confidence,
          streetViewVerified: va.streetViewVerified,
          streetViewDate: va.streetViewDate,
        }
      : null,
    computedAt: full.computedAt,
  };
}

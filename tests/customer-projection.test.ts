/**
 * Trade-secret boundary test — locks the OUTPUT-only customer projection.
 *
 * `toCustomerV3()` is the ONLY thing the public `/api/gemini-roof` endpoint
 * returns to a non-staff browser. This test asserts the method / model leak
 * fields NEVER survive the projection, and that the pricing-recompute inputs
 * the customer page reads DO survive (so prices stay byte-identical).
 *
 * Runs under Node's built-in test runner via tsx (see package.json `test`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toCustomerV3 } from "../lib/gemini-roof/customer-projection";

// A complete-enough V3 result. Cast through `any` then the projector's
// input type — the test only cares about which keys survive, not exact
// pipeline values. Every field the strip-set targets is populated so a
// regression that forgets to strip one trips the assertions below.
const FULL: Parameters<typeof toCustomerV3>[0] = {
  solar: {
    sqft: 3300,
    quotableSqft: 3100,
    footprintSqft: 2400,
    pitchDegrees: 22,
    segmentCount: 6,
    imageryQuality: "HIGH",
    imageryDate: "2025-04-01",
  },
  correction: {
    applied: true,
    reason: "MEDIUM imagery + Solar undercount vs OSM",
    solarRawSlopedSqft: 2900,
    solarRawFootprintSqft: 2100,
    gisSource: "OSM",
    gisFootprintSqft: 2400,
    slopeFactor: 1.38,
  },
  tile: { centerLat: 28.41, centerLng: -81.29, zoom: 21, widthPx: 1280, heightPx: 1280 },
  paintedImageBase64: "iVBORw0KGgoAAAANSU...",
  paintedImageRawBase64: "RAW-GENERATIVE-PAINT-SECRET",
  customerImageSource: "composite",
  objects: [
    { type: "chimney", centerPx: { x: 10, y: 20 }, bboxPx: { x: 1, y: 2, width: 3, height: 4 }, confidence: 0.91 },
    { type: "vent", centerPx: { x: 30, y: 40 }, bboxPx: { x: 5, y: 6, width: 7, height: 8 }, confidence: 0.77 },
  ],
  penetrationTotals: { count: 2, perimeterFt: 6, areaSqft: 0.8 },
  edges: { ridgesHipsLf: 120, valleysLf: 40, rakesLf: 60, eavesLf: 90 },
  geminiEdges: { ridgesHipsLf: 118, valleysLf: 38, rakesLf: 62, eavesLf: 88, linesCount: 14 },
  facets: [
    { pitchDegrees: 22, pitchOnTwelve: "5/12", azimuthDegrees: 180, compassDirection: "S", slopedSqft: 800, footprintSqft: 740 },
    { pitchDegrees: 22, pitchOnTwelve: "5/12", azimuthDegrees: 0, compassDirection: "N", slopedSqft: 800, footprintSqft: 740 },
    { pitchDegrees: 18, pitchOnTwelve: "4/12", azimuthDegrees: 90, compassDirection: "E", slopedSqft: 750, footprintSqft: 710 },
  ],
  derived: { stories: 1, estimatedAtticSqft: 2000, predominantCompass: "S", complexity: "moderate" },
  solarPotential: { maxPanels: 32, annualSunshineHours: 2900 },
  geminiAnalysis: {
    facetCountEstimate: { count: 6, complexity: "moderate", confidence: 0.82 },
    roofMaterial: { type: "asphalt_shingle_architectural", confidence: 0.88 },
    conditionHints: [{ hint: "granule_loss", confidence: 0.6 }],
    visibleDamage: [{ kind: "missing_shingle", location_hint: "SW corner", confidence: 0.55 }],
    secondaryStructures: [{ kind: "lanai", confidence: 0.7 }],
    siteObstacles: [{ kind: "tree_overhang", confidence: 0.65 }],
    apparentAgeBand: { band: "10-15yr", confidence: 0.6 },
  },
  cyanOverlay: {
    base64: "CYAN-PNG...",
    bounds: { north: 28.42, south: 28.4, east: -81.28, west: -81.3 },
    widthPx: 1280,
    heightPx: 1280,
  },
  paintVerify: null,
  qualitySignals: {
    compactness: 1.8,
    azimuthClusters: 2,
    twoPassAgreementRate: 0.9,
    filterStats: {
      raw: 12,
      afterConfidence: 9,
      afterBbox: 8,
      afterMask: 7,
      afterTwoPass: 6,
      afterDedup: 5,
      afterCaps: 4,
    },
  },
  pricing: {
    recommendedWastePercent: 10,
    wasteBreakdown: {
      fromFacets: 4,
      fromAzimuthClusters: 3,
      fromCompactness: 2,
      fromSteepPitch: 1,
      fromSecondaryStructures: 2,
    },
    penetrationAddersTotal: 725,
    penetrationAdderLines: [
      { type: "chimney", count: 1, unit: 700, subtotal: 700 },
      { type: "vent", count: 1, unit: 25, subtotal: 25 },
    ],
  },
  parcel: {
    parcelId: "12-34-56",
    countyNumber: 48,
    yearBuilt: 2005,
    effectiveYearBuilt: 2005,
    livingSqft: 2400,
    lotSqft: 9000,
    justValue: 480000,
    buildingCount: 1,
    lastSale: { priceUsd: 425000, year: 2019 },
    dorUseCode: "0100",
    assessmentYear: 2025,
  },
  visualRoofAssessment: {
    primaryMaterial: "asphalt_shingle",
    conditionObservations: ["granule_loss", "minor_staining"],
    confidence: "medium",
    observationNotes: "REP-ONLY FREE TEXT THAT MUST NOT LEAK",
    streetViewVerified: true,
    streetViewDate: "2024-03-01",
  },
  modelVersion: "gemini-internal-model-id-3.1",
  computedAt: "2026-05-29T12:00:00.000Z",
} as unknown as Parameters<typeof toCustomerV3>[0];

test("toCustomerV3 strips every method / model leak field", () => {
  const out = toCustomerV3(FULL) as Record<string, unknown>;

  // Required by the task's acceptance gate #5:
  assert.equal("correction" in out, false, "correction (Solar→GIS fusion) leaked");
  assert.equal("facets" in out && Array.isArray(out.facets) && (out.facets as unknown[]).every((f) => Object.keys(f as object).length === 0), true, "facets per-facet geometry leaked");
  assert.equal("edges" in out, false, "edges (classifier) leaked");
  assert.equal("geminiEdges" in out, false, "geminiEdges (dual classifier) leaked");
  assert.equal("modelVersion" in out, false, "modelVersion leaked");
  assert.equal("paintedImageRawBase64" in out, false, "raw generative paint leaked");
  assert.equal("paintVerify" in out, false, "paintVerify leaked");

  // qualitySignals must be gone entirely (the whole block is method internals).
  assert.equal("qualitySignals" in out, false, "qualitySignals.filterStats etc leaked");

  // pricing must NOT carry the model breakdown.
  const pricing = out.pricing as Record<string, unknown>;
  assert.equal("wasteBreakdown" in pricing, false, "pricing.wasteBreakdown leaked");
  assert.equal("penetrationAdderLines" in pricing, false, "pricing.penetrationAdderLines leaked");

  // geminiAnalysis must drop the method-y sub-fields + per-item confidences.
  const ga = out.geminiAnalysis as Record<string, unknown>;
  assert.equal("conditionHints" in ga, false, "geminiAnalysis.conditionHints leaked");
  assert.equal("visibleDamage" in ga, false, "geminiAnalysis.visibleDamage leaked");
  assert.equal("secondaryStructures" in ga, false, "geminiAnalysis.secondaryStructures leaked");
  assert.equal("siteObstacles" in ga, false, "geminiAnalysis.siteObstacles leaked");
  assert.equal("apparentAgeBand" in ga, false, "geminiAnalysis.apparentAgeBand leaked");
  const fce = ga.facetCountEstimate as Record<string, unknown>;
  assert.equal("complexity" in fce, false, "facetCountEstimate.complexity leaked");
  assert.equal("confidence" in fce, false, "facetCountEstimate.confidence leaked");

  // visualRoofAssessment must drop the rep-only free-text notes.
  const va = out.visualRoofAssessment as Record<string, unknown>;
  assert.equal("observationNotes" in va, false, "visualRoofAssessment.observationNotes leaked");
});

test("toCustomerV3 keeps the pricing-recompute inputs (prices stay identical)", () => {
  const out = toCustomerV3(FULL) as Record<string, unknown>;

  // solar.sqft — pricing-eligible area the page prices against.
  assert.equal((out.solar as { sqft: number }).sqft, 3300);

  // material type + confidence — the in-browser material-confidence GATE.
  const ga = out.geminiAnalysis as { roofMaterial: { type: string; confidence: number } };
  assert.equal(ga.roofMaterial.type, "asphalt_shingle_architectural");
  assert.equal(ga.roofMaterial.confidence, 0.88);

  // waste % + penetration adder total.
  const pricing = out.pricing as { recommendedWastePercent: number; penetrationAddersTotal: number };
  assert.equal(pricing.recommendedWastePercent, 10);
  assert.equal(pricing.penetrationAddersTotal, 725);

  // objects[].type — drives per-fixture penetration adders.
  const objects = out.objects as Array<{ type: string }>;
  assert.deepEqual(objects.map((o) => o.type), ["chimney", "vent"]);

  // facet-count chip basis stays intact (length preserved).
  assert.equal((out.facets as unknown[]).length, 3);
  assert.equal((ga as unknown as { facetCountEstimate: { count: number } }).facetCountEstimate.count, 6);
});

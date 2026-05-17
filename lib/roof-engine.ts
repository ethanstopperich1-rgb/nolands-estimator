// lib/roof-engine.ts
import type {
  ComplexityTier, Edge, Facet, FacetAttribution, FlashingBreakdown,
  LineItem, LineItemCategory, LineItemUnit, Material, PricedEstimate,
  PricingInputs, RoofData, RoofDiagnostics, RoofObject, RoofTotals,
  SimplifiedItem,
} from "@/types/roof";
import {
  BRAND_CONFIG, getMaterialPrice, type MaterialPriceKey,
} from "@/lib/branding";

/**
 * Compute flashing line items from facets + edges + objects.
 * Tier C: chimney/skylight/dormer perimeter math + per-edge LF rollup.
 * Wall-step / headwall / apron are zero in Tier C (Tier B+ signals).
 */
export function computeFlashing(
  _facets: Facet[],
  edges: Edge[],
  objects: RoofObject[],
): FlashingBreakdown {
  // _facets reserved for Tier B+ extension (wall-step detection)

  const chimneys = objects.filter((o) => o.kind === "chimney");
  const chimneyLf = chimneys.reduce(
    (s, c) => s + 2 * (c.dimensionsFt.width + c.dimensionsFt.length),
    0,
  );

  const skylights = objects.filter((o) => o.kind === "skylight");
  const skylightLf = skylights.reduce(
    (s, k) => s + 2 * (k.dimensionsFt.width + k.dimensionsFt.length),
    0,
  );

  const dormers = objects.filter((o) => o.kind === "dormer");
  const dormerStepLf = dormers.reduce(
    (s, d) => s + 2 * d.dimensionsFt.length,
    0,
  );

  const valleyLfRaw = edges
    .filter((e) => e.type === "valley")
    .reduce((s, e) => s + e.lengthFt, 0);
  const valleyLf = valleyLfRaw * 1.05;

  const eaveLf = edges
    .filter((e) => e.type === "eave")
    .reduce((s, e) => s + e.lengthFt, 0);
  const rakeLf = edges
    .filter((e) => e.type === "rake")
    .reduce((s, e) => s + e.lengthFt, 0);
  const dripEdgeLf = eaveLf + rakeLf;

  // Uses unrounded valleyLf so IWS doesn't accumulate rounding error.
  const iwsSqft = Math.round(eaveLf * 3 + valleyLf * 6);

  const pipeBootCount = objects.filter(
    (o) => o.kind === "vent" || o.kind === "stack",
  ).length;

  return {
    chimneyLf: Math.round(chimneyLf),
    skylightLf: Math.round(skylightLf),
    dormerStepLf: Math.round(dormerStepLf),
    wallStepLf: 0,
    headwallLf: 0,
    apronLf: 0,
    valleyLf: Math.round(valleyLf),
    dripEdgeLf: Math.round(dripEdgeLf),
    pipeBootCount,
    iwsSqft,
  };
}

/**
 * Andrew's monotone-chain convex hull on the union of facet polygons,
 * projected to local meters. Returns the convexity ratio
 * (poly area / convex hull area). 1.0 = fully convex; <0.78 = strong
 * reflex (L/T/U-shape).
 *
 * Used as a "cut-up" complexity signal — matches the existing
 * inferComplexityFromPolygons heuristic.
 */
export function computeUnionConvexity(facets: Facet[]): number {
  if (facets.length === 0) return 1;
  const allPts: Array<{ lat: number; lng: number }> = [];
  for (const f of facets) allPts.push(...f.polygon);
  if (allPts.length < 3) return 1;

  const cLat = allPts.reduce((s, p) => s + p.lat, 0) / allPts.length;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  const pts = allPts.map((p) => ({
    x: p.lng * 111_320 * cosLat,
    y: p.lat * 111_320,
  }));

  // Total polygon area = sum of per-facet shoelace areas (footprint approx)
  let polyArea = 0;
  for (const f of facets) {
    const poly = f.polygon.map((p) => ({
      x: p.lng * 111_320 * cosLat,
      y: p.lat * 111_320,
    }));
    let sum = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      sum += a.x * b.y - b.x * a.y;
    }
    polyArea += Math.abs(sum) / 2;
  }

  // Convex hull (Andrew's monotone chain)
  const sorted = [...pts].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (
    o: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Array<{ x: number; y: number }> = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<{ x: number; y: number }> = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let hullArea = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    hullArea += a.x * b.y - b.x * a.y;
  }
  hullArea = Math.abs(hullArea) / 2;
  // polyArea is sum-of-facet-areas, not the true union area. If facets
  // overlap in footprint, the ratio can exceed 1; clamp to keep the
  // metric in its documented [0, 1] range.
  return hullArea > 0 ? Math.min(1, polyArea / hullArea) : 1;
}

/** Tier C complexity-classifier thresholds. Mirrors the v1 heuristic so
 *  estimates don't shift on existing addresses just because the data path
 *  changed. Tier B/A replaces this with continuous signals. */
const TIER_C_COMPLEXITY_THRESHOLDS = {
  reflexConvexity: 0.78,
  complexFacetCount: 6,
  complexDormerCount: 3,
  complexValleyLf: 60,
  moderateFacetCount: 3,
  moderateDormerCount: 1,
  moderateValleyLf: 20,
} as const;

/**
 * Tier C complexity classifier — facet count + dormer count + valley LF +
 * reflex convexity. Tier B/A may replace with continuous signals.
 */
export function classifyComplexity(input: {
  facets: Facet[];
  edges: Edge[];
  objects: RoofObject[];
}): ComplexityTier {
  const T = TIER_C_COMPLEXITY_THRESHOLDS;
  const facetCount = input.facets.length;
  const dormerCount = input.objects.filter((o) => o.kind === "dormer").length;
  const valleyLf = input.edges
    .filter((e) => e.type === "valley")
    .reduce((s, e) => s + e.lengthFt, 0);
  const hasReflex = computeUnionConvexity(input.facets) < T.reflexConvexity;

  if (
    facetCount >= T.complexFacetCount ||
    hasReflex ||
    dormerCount >= T.complexDormerCount ||
    valleyLf >= T.complexValleyLf
  ) {
    return "complex";
  }
  if (
    facetCount >= T.moderateFacetCount ||
    dormerCount >= T.moderateDormerCount ||
    valleyLf >= T.moderateValleyLf
  ) {
    return "moderate";
  }
  return "simple";
}

export function suggestedWastePctTierC(c: ComplexityTier): number {
  return c === "complex" ? 14 : c === "simple" ? 7 : 11;
}

export function computeTotals(
  facets: Facet[],
  edges: Edge[],
  objects: RoofObject[],
  wasteOverridePct?: number,
): RoofTotals {
  const totalRoofAreaSqft = facets.reduce((s, f) => s + f.areaSqftSloped, 0);
  const totalFootprintSqft = facets.reduce((s, f) => s + f.areaSqftFootprint, 0);
  const totalSquares = Math.ceil((totalRoofAreaSqft / 100) * 3) / 3;
  const averagePitchDegrees = totalRoofAreaSqft > 0
    ? facets.reduce((s, f) => s + f.pitchDegrees * f.areaSqftSloped, 0) / totalRoofAreaSqft
    : 0;

  const complexity = classifyComplexity({ facets, edges, objects });
  // `??` would treat 0 as a valid override; in this domain a 0% waste is
  // always a bug (no roofing job has zero cut waste). Use a positivity
  // guard so accidental zeros fall through to the suggested value.
  const wastePct = (wasteOverridePct != null && wasteOverridePct > 0)
    ? wasteOverridePct
    : suggestedWastePctTierC(complexity);

  // Material consensus by area, ignoring null facets.
  // Ties broken by first-insertion order (deterministic via Map iteration).
  const materialVotes = new Map<Material | null, number>();
  for (const f of facets) {
    materialVotes.set(f.material, (materialVotes.get(f.material) ?? 0) + f.areaSqftSloped);
  }
  let predominantMaterial: Material | null = null;
  let topVote = -1;
  for (const [mat, area] of materialVotes) {
    if (mat !== null && area > topVote) {
      predominantMaterial = mat;
      topVote = area;
    }
  }

  // ── EagleView-equivalent measurements ────────────────────────────────
  // Sum edge linear feet by classification. Ridges + hips are
  // intentionally combined to match EagleView's "Ridges/Hips" line
  // (carrier estimates / EagleView reports group them, and Tier C's
  // classifier doesn't have the dihedral-angle signal to reliably
  // separate them anyway — confidence is 0.4). Tier B/A can split this
  // back out by emitting separate fields if/when their classifier
  // overrides land.
  // Soft-fail to null (not 0) when no edges of a given kind exist —
  // null reads as "no data, hide the chip"; 0 misleadingly reads as
  // "we measured zero feet of valleys" in the UI.
  let ridgesHipsLf = 0;
  let valleysLf = 0;
  let rakesLf = 0;
  let eavesLf = 0;
  let hasRidgeHip = false;
  let hasValley = false;
  let hasRake = false;
  let hasEave = false;
  for (const e of edges) {
    if (e.type === "ridge" || e.type === "hip") {
      ridgesHipsLf += e.lengthFt;
      hasRidgeHip = true;
    } else if (e.type === "valley") {
      valleysLf += e.lengthFt;
      hasValley = true;
    } else if (e.type === "rake") {
      rakesLf += e.lengthFt;
      hasRake = true;
    } else if (e.type === "eave") {
      eavesLf += e.lengthFt;
      hasEave = true;
    }
  }

  // Penetration totals — derived from objects[] (Roboflow vision).
  // dimensionsFt is the bbox; perimeter = 2(w+l), area = w*l. Tier C
  // doesn't have actual roof-hole geometry so this is a bbox-area
  // approximation; close enough for the customer-facing chip.
  let penPerimeter = 0;
  let penArea = 0;
  for (const o of objects) {
    const w = o.dimensionsFt?.width ?? 0;
    const l = o.dimensionsFt?.length ?? 0;
    penPerimeter += 2 * (w + l);
    penArea += w * l;
  }
  const hasObjects = objects.length > 0;

  // Estimated attic sqft — 9% deduction for chimney chases / utility
  // pass-throughs / non-ceiling roof area. Conservative approximation
  // of EagleView's surveyed "Estimated Attic" line; the exact number
  // would require interior floor-plan data we don't have.
  const estimatedAtticSqft =
    totalFootprintSqft > 0 ? Math.round(totalFootprintSqft * 0.91) : null;

  // Story heuristic — no building-height signal in Solar/vision Tier C,
  // so this is a pitch+footprint inference. Compact + steep ⇒ likely 2
  // stories; sprawling + shallow ⇒ 1. Florida ranches are the common
  // 1-story case; 2-story colonials/coastals trip the steep+compact
  // branch. Skipped (null) when inputs aren't trustworthy.
  let stories: number | null = null;
  if (totalFootprintSqft > 0 && facets.length > 0) {
    const pitchDeg = averagePitchDegrees;
    const fp = totalFootprintSqft;
    // ~26.6° = 6/12 pitch. Steeper than that + footprint <= 2000 sqft
    // is the 2-story signal. Larger footprints are almost always
    // single-story FL ranches regardless of pitch.
    if (pitchDeg >= 26.6 && fp <= 2000) stories = 2;
    else stories = 1;
  }

  return {
    facetsCount: facets.length,
    edgesCount: edges.length,
    objectsCount: objects.length,
    totalRoofAreaSqft: Math.round(totalRoofAreaSqft),
    totalFootprintSqft: Math.round(totalFootprintSqft),
    totalSquares,
    averagePitchDegrees: Math.round(averagePitchDegrees * 10) / 10,
    wastePct,
    complexity,
    predominantMaterial,
    totalRidgesHipsLf: hasRidgeHip ? Math.round(ridgesHipsLf) : null,
    totalValleysLf: hasValley ? Math.round(valleysLf) : null,
    totalRakesLf: hasRake ? Math.round(rakesLf) : null,
    totalEavesLf: hasEave ? Math.round(eavesLf) : null,
    totalPenetrations: hasObjects ? objects.length : null,
    totalPenetrationPerimeterFt: hasObjects ? Math.round(penPerimeter) : null,
    totalPenetrationAreaSqft:
      hasObjects ? Math.round(penArea * 10) / 10 : null,
    estimatedAtticSqft,
    stories,
  };
}

const M_TO_FT = 3.28084;

function edgeBearingDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const f1 = toRad(a.lat), f2 = toRad(b.lat);
  const dl = toRad(b.lng - a.lng);
  const y = Math.sin(dl) * Math.cos(f2);
  const x =
    Math.cos(f1) * Math.sin(f2) -
    Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  // Edges are bidirectional, so 30 and 210 represent the same orientation.
  // Normalize to [0, 180).
  return ((bearing % 180) + 180) % 180;
}

function angularDistDeg(a: number, b: number): number {
  return Math.abs(((a - b + 90) % 180) - 90);
}


/**
 * Edge classification from Solar API per-facet polygons.
 *
 * INPUT shape: each `Facet` has a 4-vertex rectangle polygon (rotated
 * to building axis) + pitch + azimuth + 3D normal. These polygons
 * DO NOT share vertices — they're independent bbox-derived rectangles
 * sitting near each other. The old vertex-coincidence test found zero
 * shared edges on simple gables → all rakes+eaves, no ridges/valleys
 * (the Newcomb case: EagleView 59 ridges, ours 0).
 *
 * NEW APPROACH: detect shared edges by spatial proximity, classify by
 * dihedral relationship between facets:
 *
 *   1. Project all vertices to local meter coordinates around the
 *      roof centroid (planar geometry, no haversine in the inner loop).
 *   2. For each facet, label each of its 4 edges with an intrinsic role
 *      based on bearing relative to that facet's azimuth:
 *        - perpendicular to azimuth + on the DOWNslope side → eave-candidate
 *        - perpendicular to azimuth + on the UPslope side  → ridge-candidate
 *        - parallel to azimuth                              → rake-candidate
 *   3. Across facet pairs, find edges that are parallel + close +
 *      overlapping. Those are shared. Classify each shared edge by
 *      what the two facets' azimuths do at that edge:
 *        - both flow AWAY from edge      → ridge (peak)
 *        - both flow TOWARD edge         → valley (drain)
 *        - azimuths ~perpendicular       → hip (corner)
 *   4. Edges with no shared partner = exterior. Classified by their
 *      intrinsic role above.
 *
 * Output confidence stays at 0.4 so Tier B / LiDAR refinements still
 * win when available.
 */
export function classifyEdges(
  facets: Facet[],
  dominantAzimuthDeg: number | null,
): Edge[] {
  void dominantAzimuthDeg;
  if (facets.length === 0) return [];

  // 1) Build local meter coordinates around the centroid.
  let cLat = 0, cLng = 0, n = 0;
  for (const f of facets) {
    for (const p of f.polygon) { cLat += p.lat; cLng += p.lng; n++; }
  }
  cLat /= Math.max(n, 1);
  cLng /= Math.max(n, 1);
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((cLat * Math.PI) / 180);
  const toLocal = (p: { lat: number; lng: number }) => ({
    x: (p.lng - cLng) * mPerDegLng,
    y: (p.lat - cLat) * mPerDegLat,
  });
  const fromLocal = (q: { x: number; y: number }) => ({
    lat: q.y / mPerDegLat + cLat,
    lng: q.x / mPerDegLng + cLng,
  });

  // 2) Walk every edge of every facet, projecting to local meters.
  //    Compute intrinsic per-edge data including its azimuth-relative
  //    role (downslope/upslope/side).
  interface LocalEdge {
    facetIdx: number;
    facetId: string;
    /** Local-meter endpoints. */
    a: { x: number; y: number };
    b: { x: number; y: number };
    /** Midpoint in local meters. */
    m: { x: number; y: number };
    /** Edge length in meters. */
    lenM: number;
    /** Edge length in feet (output unit). */
    lenFt: number;
    /** Bearing in degrees, normalized to [0, 180). */
    bearingDeg: number;
    /** Lat/lng for emission. */
    aLL: { lat: number; lng: number };
    bLL: { lat: number; lng: number };
    /** Intrinsic role: which side of this facet is this edge on?
     *  "downslope" = eave-side (perpendicular to azimuth, downhill end)
     *  "upslope"   = ridge-side (perpendicular to azimuth, uphill end)
     *  "side"      = rake-side  (parallel to azimuth) */
    role: "downslope" | "upslope" | "side";
  }
  const edges: LocalEdge[] = [];
  facets.forEach((f, fIdx) => {
    if (f.polygon.length < 3) return;
    // Facet centroid in local meters.
    let fx = 0, fy = 0;
    const pts = f.polygon.map(toLocal);
    for (const p of pts) { fx += p.x; fy += p.y; }
    fx /= pts.length; fy /= pts.length;
    // Azimuth: compass heading of the downslope direction (where water
    // flows). In local-xy with y=north, downslope unit vector:
    //   az=0° (N): water flows north  → (0,  1)
    //   az=90°(E):                E   → (1,  0)
    //   az=180°(S):               S   → (0, -1)
    //   az=270°(W):               W   → (-1, 0)
    const azRad = (f.azimuthDeg * Math.PI) / 180;
    const downX = Math.sin(azRad);
    const downY = Math.cos(azRad);

    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenM = Math.hypot(dx, dy);
      if (lenM < 0.15) continue; // sub-half-foot dust
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Vector from facet centroid to edge midpoint, normalized.
      const cmx = mid.x - fx;
      const cmy = mid.y - fy;
      const cmLen = Math.hypot(cmx, cmy) || 1;
      const nx = cmx / cmLen;
      const ny = cmy / cmLen;
      // Dot with downslope direction → +1 means edge is on the downhill
      // side of facet; -1 means uphill side; 0 means parallel to slope.
      const dotDown = nx * downX + ny * downY;
      // Edge direction angle for parallel-to-slope detection.
      const edgeAngleDeg =
        (((Math.atan2(dy, dx) * 180) / Math.PI) % 180 + 180) % 180;
      const slopeAngleDeg =
        (((Math.atan2(downY, downX) * 180) / Math.PI) % 180 + 180) % 180;
      const parallelToSlope = angularDistDeg(edgeAngleDeg, slopeAngleDeg) <= 25;
      let role: LocalEdge["role"];
      if (parallelToSlope) role = "side";
      else if (dotDown > 0) role = "downslope";
      else role = "upslope";

      const aLL = fromLocal(a);
      const bLL = fromLocal(b);
      edges.push({
        facetIdx: fIdx,
        facetId: f.id,
        a, b, m: mid,
        lenM,
        lenFt: lenM * M_TO_FT,
        bearingDeg: edgeBearingDeg(aLL, bLL),
        aLL, bLL,
        role,
      });
    }
  });
  if (edges.length === 0) return [];

  // 3) Find shared edges by proximity (parallel + close + overlapping).
  //    Pair-up: at most one partner per edge (the closest valid one).
  const partner = new Array<number | null>(edges.length).fill(null);
  const overlapM = new Array<number>(edges.length).fill(0);
  const PARALLEL_TOL_DEG = 12;
  const PERP_DIST_TOL_M = 1.2;
  const MIN_OVERLAP_M = 0.45;

  function overlapLengthM(e1: LocalEdge, e2: LocalEdge): {
    overlap: number;
    perpDist: number;
  } {
    // Bearing test.
    if (angularDistDeg(e1.bearingDeg, e2.bearingDeg) > PARALLEL_TOL_DEG) {
      return { overlap: 0, perpDist: Infinity };
    }
    // Unit vector along e1.
    const ux = (e1.b.x - e1.a.x) / Math.max(e1.lenM, 1e-6);
    const uy = (e1.b.y - e1.a.y) / Math.max(e1.lenM, 1e-6);
    // Project e1's endpoints onto its own axis (scalar coords).
    const e1a = 0;
    const e1b = e1.lenM;
    // Project e2's endpoints onto e1's axis using e1.a as origin.
    const v2ax = e2.a.x - e1.a.x;
    const v2ay = e2.a.y - e1.a.y;
    const v2bx = e2.b.x - e1.a.x;
    const v2by = e2.b.y - e1.a.y;
    const t2a = v2ax * ux + v2ay * uy;
    const t2b = v2bx * ux + v2by * uy;
    const tMin = Math.min(t2a, t2b);
    const tMax = Math.max(t2a, t2b);
    const overlap = Math.max(0, Math.min(e1b, tMax) - Math.max(e1a, tMin));
    // Perpendicular distance from e2.a to the e1 line.
    // Perp component is the residual after subtracting along-axis part.
    const perpAx = v2ax - t2a * ux;
    const perpAy = v2ay - t2a * uy;
    const perpDist = Math.hypot(perpAx, perpAy);
    return { overlap, perpDist };
  }

  for (let i = 0; i < edges.length; i++) {
    let bestJ: number | null = null;
    let bestOverlap = MIN_OVERLAP_M;
    for (let j = 0; j < edges.length; j++) {
      if (j === i) continue;
      if (edges[j].facetIdx === edges[i].facetIdx) continue;
      const { overlap, perpDist } = overlapLengthM(edges[i], edges[j]);
      if (perpDist > PERP_DIST_TOL_M) continue;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestJ = j;
      }
    }
    if (bestJ !== null) {
      partner[i] = bestJ;
      overlapM[i] = bestOverlap;
    }
  }

  // Each edge may have picked a partner that didn't pick it back (rare,
  // with overlapping rectangles it can happen). Require mutual partner
  // for a shared edge, OR an asymmetric pairing where the other side
  // is geometrically the same physical edge. The mutual check is the
  // robust one — keep only mutual pairs.
  const seen = new Set<string>();
  interface SharedEdge {
    e1: LocalEdge;
    e2: LocalEdge;
    overlapM: number;
    type: "ridge" | "hip" | "valley";
  }
  const shared: SharedEdge[] = [];

  for (let i = 0; i < edges.length; i++) {
    const j = partner[i];
    if (j === null) continue;
    if (partner[j] !== i) continue;
    const key = i < j ? `${i}-${j}` : `${j}-${i}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const e1 = edges[i];
    const e2 = edges[j];
    const f1 = facets[e1.facetIdx];
    const f2 = facets[e2.facetIdx];

    // Classify by azimuth relationship.
    const azDiff = (() => {
      const d = Math.abs(f1.azimuthDeg - f2.azimuthDeg) % 360;
      return d > 180 ? 360 - d : d;
    })();

    let type: "ridge" | "hip" | "valley";
    if (azDiff < 45) {
      // Same direction — unusual. Treat as hip.
      type = "hip";
    } else if (azDiff >= 135) {
      // Opposing slopes — could be ridge or valley depending on which
      // way each slope flows relative to the shared edge.
      const r1 = e1.role;
      const r2 = e2.role;
      // Both facets see the edge on their UPSLOPE side → both peak at
      // this edge → ridge.
      // Both see it on DOWNSLOPE → both drain to this edge → valley.
      if (r1 === "upslope" && r2 === "upslope") type = "ridge";
      else if (r1 === "downslope" && r2 === "downslope") type = "valley";
      else type = "ridge"; // mixed, default ridge
    } else {
      // azDiff between 45° and 135° → perpendicular → hip.
      type = "hip";
    }

    // Average the overlap length of the two edges' projections — both
    // sides see the same physical edge, but the rectangles' projections
    // differ slightly. Average is more stable than either alone.
    const overlap = (overlapM[i] + overlapM[j]) / 2;
    shared.push({ e1, e2, overlapM: overlap, type });
  }

  // 4) Exterior edges = those without a mutual partner.
  const isShared = new Array<boolean>(edges.length).fill(false);
  for (let i = 0; i < edges.length; i++) {
    const j = partner[i];
    if (j !== null && partner[j] === i) isShared[i] = true;
  }
  interface ExteriorEdge { e: LocalEdge; type: "eave" | "rake"; }
  const exterior: ExteriorEdge[] = [];
  for (let i = 0; i < edges.length; i++) {
    if (isShared[i]) continue;
    const e = edges[i];
    let type: "eave" | "rake";
    if (e.role === "side") type = "rake";
    else if (e.role === "downslope") type = "eave";
    else type = "eave"; // upslope-but-exterior — peak with no neighbor, treat as eave for safety
    exterior.push({ e, type });
  }

  // 5) Emit Edge[] in the existing shape.
  const out: Edge[] = [];
  let edgeId = 0;
  for (const s of shared) {
    out.push({
      id: `edge-${edgeId++}`,
      type: s.type,
      polyline: [
        { lat: s.e1.aLL.lat, lng: s.e1.aLL.lng, heightM: 0 },
        { lat: s.e1.bLL.lat, lng: s.e1.bLL.lng, heightM: 0 },
      ],
      lengthFt: Math.round(s.overlapM * M_TO_FT),
      facetIds: [s.e1.facetId, s.e2.facetId],
      confidence: 0.4,
    });
  }
  for (const x of exterior) {
    out.push({
      id: `edge-${edgeId++}`,
      type: x.type,
      polyline: [
        { lat: x.e.aLL.lat, lng: x.e.aLL.lng, heightM: 0 },
        { lat: x.e.bLL.lat, lng: x.e.bLL.lng, heightM: 0 },
      ],
      lengthFt: Math.round(x.e.lenFt),
      facetIds: [x.e.facetId],
      confidence: 0.4,
    });
  }
  return out;
}

// ---- Pricing engine (Tier C) -----------------------------------------------

export function makeDegradedRoofData(opts: {
  address: RoofData["address"];
  attempts: RoofDiagnostics["attempts"];
}): RoofData {
  return {
    address: opts.address,
    source: "none",
    refinements: [],
    confidence: 0,
    imageryDate: null,
    ageYearsEstimate: null,
    ageBucket: null,
    facets: [],
    edges: [],
    objects: [],
    outlinePolygon: null,
    flashing: {
      chimneyLf: 0, skylightLf: 0, dormerStepLf: 0, wallStepLf: 0,
      headwallLf: 0, apronLf: 0, valleyLf: 0, dripEdgeLf: 0,
      pipeBootCount: 0, iwsSqft: 0,
    },
    totals: {
      facetsCount: 0, edgesCount: 0, objectsCount: 0,
      totalRoofAreaSqft: 0, totalFootprintSqft: 0, totalSquares: 0,
      averagePitchDegrees: 0, wastePct: 11, complexity: "moderate",
      predominantMaterial: null,
    },
    diagnostics: {
      attempts: opts.attempts,
      warnings: ["We couldn't analyze this address — no source had coverage."],
      needsReview: [],
    },
  };
}

const UNDERLAYMENT_WASTE_FACTOR = 1.1;

const SHINGLE_KEY: Record<Material, MaterialPriceKey> = {
  "asphalt-3tab": "RFG_3T",
  "asphalt-architectural": "RFG_ARCH",
  "metal-standing-seam": "RFG_METAL",
  "tile-concrete": "RFG_TILE",
  // Tier C: no Xactimate codes for these yet — fall back to ARCH pricing
  // until specific codes are added. They're rare in FL; reps override
  // material before save.
  "wood-shake": "RFG_ARCH",
  "flat-membrane": "RFG_ARCH",
};

const SHINGLE_CODE: Record<Material, string> = {
  "asphalt-3tab": "RFG 3T",
  "asphalt-architectural": "RFG ARCH",
  "metal-standing-seam": "RFG METAL",
  "tile-concrete": "RFG TILE",
  "wood-shake": "RFG WOOD",
  "flat-membrane": "RFG MEMBRANE",
};

const SHINGLE_LABEL: Record<Material, string> = {
  "asphalt-3tab": "Builder grade shingle",
  "asphalt-architectural": "Architectural composition shingle",
  "metal-standing-seam": "Standing-seam metal",
  "tile-concrete": "Concrete / clay tile",
  "wood-shake": "Wood shake",
  "flat-membrane": "Flat membrane",
};

function steepChargeMultiplier(pitchDegrees: number): number {
  if (pitchDegrees < 33.7) return 0;   // < ~8/12
  if (pitchDegrees < 39.8) return 0.25; // 8-10/12
  return 0.35;                          // > 10/12
}

function complexityMultiplier(c: ComplexityTier): number {
  if (c === "simple") return 1.0;
  if (c === "moderate") return 1.1;
  return 1.25;
}

const SIMPLIFIED_GROUPS: Array<{ name: string; codes: string[] }> = [
  { name: "Materials & shingles", codes: ["RFG ARCH", "RFG 3T", "RFG METAL", "RFG TILE", "RFG WOOD", "RFG MEMBRANE", "RFG STARTER", "RFG RIDG"] },
  { name: "Underlayment & weatherproofing", codes: ["RFG SYNF", "RFG IWS"] },
  { name: "Flashing & metal", codes: ["RFG DRIP", "RFG VAL", "RFG PIPEFL", "FLASH CHIM", "FLASH SKY", "FLASH DRMR", "FLASH WALL", "FLASH HEAD", "FLASH APRN"] },
  { name: "Tear-off & disposal", codes: ["RFG SHGLR", "RFG DEPSTL"] },
  { name: "Decking repair (allowance)", codes: ["RFG DECK"] },
  { name: "Ventilation", codes: ["RFG RDGV"] },
  { name: "Add-ons & upgrades", codes: ["ADDON"] },
  { name: "Labor adjustments", codes: ["RFG STP", "COMPLEXITY"] },
  { name: "Overhead & profit", codes: ["O&P"] },
];

function makeFlatItem(args: {
  code: string;
  description: string;
  friendlyName: string;
  quantity: number;
  unit: LineItemUnit;
  unitCostLow: number;
  unitCostHigh: number;
  category: LineItemCategory;
}): LineItem {
  const q = Math.max(0, args.quantity);
  return {
    code: args.code,
    description: args.description,
    friendlyName: args.friendlyName,
    quantity: Math.round(q * 100) / 100,
    unit: args.unit,
    unitCostLow: args.unitCostLow,
    unitCostHigh: args.unitCostHigh,
    extendedLow: Math.round(q * args.unitCostLow * 100) / 100,
    extendedHigh: Math.round(q * args.unitCostHigh * 100) / 100,
    category: args.category,
  };
}

export function priceRoofData(data: RoofData, inputs: PricingInputs): PricedEstimate {
  // Degraded RoofData → empty PricedEstimate
  if (data.source === "none" || data.facets.length === 0) {
    return {
      lineItems: [], simplifiedItems: [],
      subtotalLow: 0, subtotalHigh: 0,
      overheadProfit: { low: 0, high: 0 },
      totalLow: 0, totalHigh: 0,
      squares: 0, hasPerFacetDetail: false,
    };
  }

  const items: LineItem[] = [];
  const totalSqft = data.totals.totalRoofAreaSqft;
  const totalSquares = totalSqft / 100;
  // `??` would treat 0 as a valid override; in this domain a 0% waste is
  // always a bug (no roofing job has zero cut waste). Same guard as
  // computeTotals — positivity required for the override to apply.
  const wastePct = (inputs.wasteOverridePct != null && inputs.wasteOverridePct > 0)
    ? inputs.wasteOverridePct
    : data.totals.wastePct;
  const wasteFactor = 1 + wastePct / 100;

  // ---- Tear-off ----------------------------------------------------------
  const tearoffMultiplier =
    inputs.serviceType === "new" ? 0 :
    inputs.serviceType === "layover" ? 0 :
    inputs.serviceType === "repair" ? 0.25 : 1;
  if (tearoffMultiplier > 0) {
    const t = getMaterialPrice("RFG_SHGLR");
    items.push(makeFlatItem({
      code: "RFG SHGLR",
      description: "Tear off composition shingles",
      friendlyName: "Remove old shingles",
      quantity: totalSquares * tearoffMultiplier,
      unit: "SQ",
      unitCostLow: t.low, unitCostHigh: t.high,
      category: "tearoff",
    }));
    const d = getMaterialPrice("RFG_DEPSTL");
    items.push(makeFlatItem({
      code: "RFG DEPSTL",
      description: "Disposal / dump fee",
      friendlyName: "Disposal & dumpster",
      quantity: totalSquares * tearoffMultiplier,
      unit: "SQ",
      unitCostLow: d.low, unitCostHigh: d.high,
      category: "tearoff",
    }));
  }

  // ---- Decking allowance -------------------------------------------------
  if (inputs.serviceType === "reroof-tearoff" || inputs.serviceType === "new") {
    const dk = getMaterialPrice("RFG_DECK");
    items.push(makeFlatItem({
      code: "RFG DECK",
      description: "Sheathing replacement allowance",
      friendlyName: "Decking repair (10% allowance)",
      quantity: totalSqft * 0.1,
      unit: "SF",
      unitCostLow: dk.low, unitCostHigh: dk.high,
      category: "decking",
    }));
  }

  // ---- Underlayment ------------------------------------------------------
  if (inputs.serviceType !== "repair") {
    const u = getMaterialPrice("RFG_SYNF");
    items.push(makeFlatItem({
      code: "RFG SYNF",
      description: "Synthetic underlayment",
      friendlyName: "Synthetic underlayment",
      quantity: totalSquares * UNDERLAYMENT_WASTE_FACTOR,
      unit: "SQ",
      unitCostLow: u.low, unitCostHigh: u.high,
      category: "underlayment",
    }));
  }

  // ---- IWS ---------------------------------------------------------------
  if (data.flashing.iwsSqft > 0 && inputs.serviceType !== "repair") {
    const iws = getMaterialPrice("RFG_IWS");
    items.push(makeFlatItem({
      code: "RFG IWS",
      description: "Ice & water shield (eaves + valleys)",
      friendlyName: "Ice & water shield (eaves + valleys)",
      quantity: data.flashing.iwsSqft / 100,
      unit: "SQ",
      unitCostLow: iws.low, unitCostHigh: iws.high,
      category: "underlayment",
    }));
  }

  // ---- Drip edge ---------------------------------------------------------
  if (data.flashing.dripEdgeLf > 0 && inputs.serviceType !== "repair") {
    const dr = getMaterialPrice("RFG_DRIP");
    items.push(makeFlatItem({
      code: "RFG DRIP",
      description: "Drip edge",
      friendlyName: "Drip edge",
      quantity: data.flashing.dripEdgeLf,
      unit: "LF",
      unitCostLow: dr.low, unitCostHigh: dr.high,
      category: "flashing",
    }));
  }

  // ---- Valley metal ------------------------------------------------------
  if (data.flashing.valleyLf > 0 && inputs.serviceType !== "repair") {
    const v = getMaterialPrice("RFG_VAL");
    items.push(makeFlatItem({
      code: "RFG VAL",
      description: "Valley metal",
      friendlyName: "Valley metal",
      quantity: data.flashing.valleyLf,
      unit: "LF",
      unitCostLow: v.low, unitCostHigh: v.high,
      category: "flashing",
    }));
  }

  // ---- Chimney / skylight / dormer-step flashing (NEW in Tier C) ---------
  // Per-feature LF, replacing the legacy 3-row constant table.
  // RFG_FLASH isn't yet a branding key, so fall back to RFG_DRIP per-LF rate
  // (the closest existing flashing-metal material).
  const flashKey: MaterialPriceKey = "RFG_DRIP";
  if (data.flashing.chimneyLf > 0 && inputs.serviceType !== "repair") {
    const f = getMaterialPrice(flashKey);
    items.push(makeFlatItem({
      code: "FLASH CHIM",
      description: "Chimney flashing kit (counter + step)",
      friendlyName: "Chimney flashing",
      quantity: data.flashing.chimneyLf,
      unit: "LF",
      unitCostLow: f.low, unitCostHigh: f.high,
      category: "flashing",
    }));
  }
  if (data.flashing.skylightLf > 0 && inputs.serviceType !== "repair") {
    const f = getMaterialPrice(flashKey);
    items.push(makeFlatItem({
      code: "FLASH SKY",
      description: "Skylight flashing kit",
      friendlyName: "Skylight flashing",
      quantity: data.flashing.skylightLf,
      unit: "LF",
      unitCostLow: f.low, unitCostHigh: f.high,
      category: "flashing",
    }));
  }
  if (data.flashing.dormerStepLf > 0 && inputs.serviceType !== "repair") {
    const f = getMaterialPrice(flashKey);
    items.push(makeFlatItem({
      code: "FLASH DRMR",
      description: "Dormer step flashing",
      friendlyName: "Dormer step flashing",
      quantity: data.flashing.dormerStepLf,
      unit: "LF",
      unitCostLow: f.low, unitCostHigh: f.high,
      category: "flashing",
    }));
  }

  // Tier B wall-to-roof junctions — only populated when the multiview
  // inspector ran (refinements includes "multiview-obliques"). All three
  // are zero under Tier C by design.
  if (data.flashing.wallStepLf > 0 && inputs.serviceType !== "repair") {
    const f = getMaterialPrice(flashKey);
    items.push(makeFlatItem({
      code: "FLASH WALL",
      description: "Wall-to-roof step flashing (non-dormer)",
      friendlyName: "Wall step flashing",
      quantity: data.flashing.wallStepLf,
      unit: "LF",
      unitCostLow: f.low, unitCostHigh: f.high,
      category: "flashing",
    }));
  }
  if (data.flashing.headwallLf > 0 && inputs.serviceType !== "repair") {
    const f = getMaterialPrice(flashKey);
    items.push(makeFlatItem({
      code: "FLASH HEAD",
      description: "Headwall flashing (top of wall-to-roof junction)",
      friendlyName: "Headwall flashing",
      quantity: data.flashing.headwallLf,
      unit: "LF",
      unitCostLow: f.low, unitCostHigh: f.high,
      category: "flashing",
    }));
  }
  if (data.flashing.apronLf > 0 && inputs.serviceType !== "repair") {
    const f = getMaterialPrice(flashKey);
    items.push(makeFlatItem({
      code: "FLASH APRN",
      description: "Apron flashing (bottom of wall-to-roof junction)",
      friendlyName: "Apron flashing",
      quantity: data.flashing.apronLf,
      unit: "LF",
      unitCostLow: f.low, unitCostHigh: f.high,
      category: "flashing",
    }));
  }

  // ---- Shingles (per-facet pricing) --------------------------------------
  const sh = getMaterialPrice(SHINGLE_KEY[inputs.material]);
  const facetAttribution: FacetAttribution[] = [];
  let shingleQty = 0;
  let shingleExtLow = 0;
  let shingleExtHigh = 0;
  // Shingle priced at flat $/SQ — steep-pitch surcharge is a labor-only
  // adjustment per Xactimate convention (RFG STP line, below). The per-facet
  // attribution still shows each facet's $ contribution (proportional to
  // its waste-adjusted sloped area), which is what the rep view consumes.
  const shingleUnitLow = sh.low * inputs.materialMultiplier;
  const shingleUnitHigh = sh.high * inputs.materialMultiplier;
  for (const facet of data.facets) {
    const facetSquares = (facet.areaSqftSloped / 100) *
      (inputs.serviceType === "repair" ? 0.15 : wasteFactor);
    const extLow = facetSquares * shingleUnitLow;
    const extHigh = facetSquares * shingleUnitHigh;
    facetAttribution.push({
      facetId: facet.id,
      areaSqftSloped: facet.areaSqftSloped,
      pitchDegrees: facet.pitchDegrees,
      extendedLow: Math.round(extLow * 100) / 100,
      extendedHigh: Math.round(extHigh * 100) / 100,
    });
    shingleQty += facetSquares;
    shingleExtLow += extLow;
    shingleExtHigh += extHigh;
  }
  items.push({
    code: SHINGLE_CODE[inputs.material],
    description: SHINGLE_LABEL[inputs.material],
    friendlyName: SHINGLE_LABEL[inputs.material],
    quantity: Math.round(shingleQty * 100) / 100,
    unit: "SQ",
    unitCostLow: sh.low * inputs.materialMultiplier,
    unitCostHigh: sh.high * inputs.materialMultiplier,
    extendedLow: Math.round(shingleExtLow * 100) / 100,
    extendedHigh: Math.round(shingleExtHigh * 100) / 100,
    category: "shingles",
    facetAttribution,
  });

  // ---- Starter strip -----------------------------------------------------
  if (data.flashing.dripEdgeLf > 0 && inputs.serviceType !== "repair") {
    const st = getMaterialPrice("RFG_STARTER");
    items.push(makeFlatItem({
      code: "RFG STARTER",
      description: "Starter strip",
      friendlyName: "Starter strip (eaves)",
      quantity: data.flashing.dripEdgeLf,
      unit: "LF",
      unitCostLow: st.low, unitCostHigh: st.high,
      category: "shingles",
    }));
  }

  // ---- Ridge / hip cap ---------------------------------------------------
  const ridgeHipLf = data.edges
    .filter((e) => e.type === "ridge" || e.type === "hip")
    .reduce((s, e) => s + e.lengthFt, 0);
  if (ridgeHipLf > 0) {
    const rd = getMaterialPrice("RFG_RIDG");
    items.push(makeFlatItem({
      code: "RFG RIDG",
      description: "Ridge / hip cap",
      friendlyName: "Ridge & hip caps",
      quantity: ridgeHipLf,
      unit: "LF",
      unitCostLow: rd.low, unitCostHigh: rd.high,
      category: "shingles",
    }));
  }

  // ---- Pipe boots --------------------------------------------------------
  if (inputs.serviceType !== "repair" && data.flashing.pipeBootCount > 0) {
    const pf = getMaterialPrice("RFG_PIPEFL");
    items.push(makeFlatItem({
      code: "RFG PIPEFL",
      description: "Pipe jack / flashing",
      friendlyName: "Pipe flashings",
      quantity: data.flashing.pipeBootCount,
      unit: "EA",
      unitCostLow: pf.low, unitCostHigh: pf.high,
      category: "flashing",
    }));
  }

  // ---- Add-ons -----------------------------------------------------------
  for (const a of inputs.addOns.filter((a) => a.enabled)) {
    items.push({
      code: "ADDON",
      description: a.label,
      friendlyName: a.label,
      quantity: 1, unit: "EA",
      unitCostLow: a.price, unitCostHigh: a.price,
      extendedLow: a.price, extendedHigh: a.price,
      category: "addons",
    });
  }

  // ---- Labor adjustments (steep + complexity over 35% of subtotal) -------
  const baseSubLow = items.reduce((s, it) => s + it.extendedLow, 0);
  const baseSubHigh = items.reduce((s, it) => s + it.extendedHigh, 0);
  const laborLow = baseSubLow * 0.35 * inputs.laborMultiplier;
  const laborHigh = baseSubHigh * 0.35 * inputs.laborMultiplier;

  // Steep charge: area-weighted across facets
  const totalArea = data.facets.reduce((s, f) => s + f.areaSqftSloped, 0);
  const weightedSteep = totalArea > 0
    ? data.facets.reduce(
        (s, f) => s + steepChargeMultiplier(f.pitchDegrees) * f.areaSqftSloped,
        0,
      ) / totalArea
    : 0;
  if (weightedSteep > 0) {
    const low = laborLow * weightedSteep;
    const high = laborHigh * weightedSteep;
    items.push({
      code: "RFG STP",
      description: "Steep roof charge (continuous pitch surcharge)",
      friendlyName: `Steep-pitch labor surcharge (+${Math.round(weightedSteep * 100)}%)`,
      quantity: 1, unit: "%",
      unitCostLow: low, unitCostHigh: high,
      extendedLow: Math.round(low * 100) / 100,
      extendedHigh: Math.round(high * 100) / 100,
      category: "labor",
    });
  }

  const complexityMult = complexityMultiplier(data.totals.complexity);
  if (complexityMult > 1) {
    const extra = complexityMult - 1;
    const low = laborLow * extra;
    const high = laborHigh * extra;
    items.push({
      code: "COMPLEXITY",
      description: "Cut-up roof / complexity adjustment",
      friendlyName: `Cut-up roof adjustment (+${Math.round(extra * 100)}%)`,
      quantity: 1, unit: "%",
      unitCostLow: low, unitCostHigh: high,
      extendedLow: Math.round(low * 100) / 100,
      extendedHigh: Math.round(high * 100) / 100,
      category: "labor",
    });
  }

  // ---- O&P ---------------------------------------------------------------
  const subLow = items.reduce((s, it) => s + it.extendedLow, 0);
  const subHigh = items.reduce((s, it) => s + it.extendedHigh, 0);
  const opPct =
    (BRAND_CONFIG.defaultMarkup.overheadPercent +
      BRAND_CONFIG.defaultMarkup.profitPercent) / 100;
  const opLow = subLow * opPct;
  const opHigh = subHigh * opPct;
  items.push({
    code: "O&P",
    description: "Overhead & profit",
    friendlyName: `Overhead & profit (${Math.round(opPct * 100)}%)`,
    quantity: 1, unit: "%",
    unitCostLow: opLow, unitCostHigh: opHigh,
    extendedLow: Math.round(opLow * 100) / 100,
    extendedHigh: Math.round(opHigh * 100) / 100,
    category: "op",
  });

  const totalLow = subLow + opLow;
  const totalHigh = subHigh + opHigh;

  const simplifiedItems: SimplifiedItem[] = SIMPLIFIED_GROUPS.map((g) => {
    const matching = items.filter((it) => g.codes.includes(it.code));
    return {
      group: g.name,
      totalLow: Math.round(matching.reduce((s, it) => s + it.extendedLow, 0) * 100) / 100,
      totalHigh: Math.round(matching.reduce((s, it) => s + it.extendedHigh, 0) * 100) / 100,
      codes: matching.map((it) => it.code),
    };
  }).filter((g) => g.totalLow > 0 || g.totalHigh > 0);

  return {
    lineItems: items,
    simplifiedItems,
    subtotalLow: Math.round(subLow * 100) / 100,
    subtotalHigh: Math.round(subHigh * 100) / 100,
    overheadProfit: {
      low: Math.round(opLow * 100) / 100,
      high: Math.round(opHigh * 100) / 100,
    },
    totalLow: Math.round(totalLow * 100) / 100,
    totalHigh: Math.round(totalHigh * 100) / 100,
    squares: Math.round((totalSqft / 100) * 100) / 100,
    hasPerFacetDetail: data.facets.length >= 2,
  };
}

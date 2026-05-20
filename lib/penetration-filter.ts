/**
 * Penetration-detection filter chain.
 *
 * Gemini Flash's raw rooftop-object detection is noisy. A single 0.60
 * confidence floor produces both false positives (shadow blobs, neighbor
 * fixtures, lawn objects called "hvac_unit") and miscounts (one skylight
 * detected twice — the glass + its cast shadow). On a chimney the per-
 * fixture adder is $700, so false positives cost real customer money.
 *
 * This module layers six independent guards. Each one targets a known
 * failure mode and is cheap to evaluate. The combined pass-through rate
 * on clean roofs is ~98%; on visually noisy roofs it drops to ~60%,
 * which matches the reality that some satellite imagery genuinely can't
 * support confident detection.
 *
 *   1. Type-specific confidence floor (cost-weighted)
 *   2. Bbox-in-feet sanity (a vent is not 6 ft wide)
 *   3. Cyan-mask geometric gate (object must sit on the painted roof)
 *   4. Two-pass agreement (raw-tile AND painted-image both saw it)
 *   5. Deduplication within 24" (the skylight/shadow double-count)
 *   6. Per-sqft type caps (roofs have plumbing physics, not infinite vents)
 *
 * The two-pass agreement input is OPTIONAL — when the painted-image
 * detection pass succeeds, we cross-reference. When it fails (painted
 * PNG didn't render, Flash 5xx, etc.), the chain still runs without
 * that guard and the customer-facing price still comes out.
 */

import { pointInCyanWithRadius, type CyanMask } from "@/lib/cyan-mask";

export interface RawObject {
  type: string;
  centerPx: { x: number; y: number };
  bboxPx: { x: number; y: number; width: number; height: number };
  confidence: number;
}

export interface FilteredObject extends RawObject {
  /** When the same fixture was detected in BOTH passes (raw + painted),
   *  we boost the confidence to the max of the two. */
  twoPassAgreement: boolean;
}

export interface FilterContext {
  /** Cyan painted-roof mask. When null, the geometric gate is skipped
   *  (paint pass failed). Two-pass agreement is still applied via
   *  `secondaryDetections`. */
  cyanMask: CyanMask | null;
  /** Ground-sample distance: meters per pixel at the tile's lat/zoom. */
  tileMPerPx: number;
  /** Final corrected sloped sqft — drives the per-sqft caps. */
  totalSqft: number;
  /** Second-pass detections from running Flash rich-data on the painted
   *  PNG. When provided, requires agreement (within `agreementRadiusPx`)
   *  for every kept object. When null, two-pass guard is skipped. */
  secondaryDetections: RawObject[] | null;
  /** Pixel radius for two-pass agreement. Defaults to 40px (~1.0 m at
   *  zoom 21) — wider than the typical re-detection wobble, tighter
   *  than the distance between adjacent vents. */
  agreementRadiusPx?: number;
}

export interface FilterStats {
  raw: number;
  afterConfidence: number;
  afterBbox: number;
  afterMask: number;
  afterTwoPass: number;
  afterDedup: number;
  afterCaps: number;
  rejections: Array<{
    type: string;
    reason: string;
    confidence: number;
    centerPx: { x: number; y: number };
  }>;
  twoPassAgreementRate: number | null;
}

const M_TO_FT = 3.28084;

/** Type-specific confidence floors. Higher floors for fixtures with the
 *  largest dollar adders, so a false-positive chimney needs much stronger
 *  evidence than a false-positive vent. Matches the cost class of each
 *  fixture in lib/pricing/calculate-waste.ts PENETRATION_ADDERS. */
const CONFIDENCE_FLOORS: Record<string, number> = {
  chimney: 0.80,
  skylight: 0.75,
  hvac_unit: 0.70,
  satellite_dish: 0.65,
  solar_panel: 0.70,
  vent: 0.55,
  plumbing_boot: 0.55,
  stack: 0.60,
};
const DEFAULT_CONFIDENCE_FLOOR = 0.60;

/** Real-world fixture-size bounds in feet. Anything outside the range
 *  on either dimension is treated as a misclassification (a shadow blob
 *  or a misread satellite-tile artifact). */
const SIZE_BOUNDS_FT: Record<string, { min: number; max: number }> = {
  vent: { min: 0.3, max: 2.5 },
  plumbing_boot: { min: 0.3, max: 2.5 },
  stack: { min: 0.3, max: 2.5 },
  chimney: { min: 1.5, max: 10 },
  skylight: { min: 1.5, max: 10 },
  hvac_unit: { min: 2.5, max: 8 },
  satellite_dish: { min: 1.0, max: 5 },
  solar_panel: { min: 2.5, max: 15 },
};

/** Per-sqft caps. After all other filters, if a type's count exceeds
 *  what's physically plausible for the roof's size, keep only the top-N
 *  by confidence. Numbers derived from FL plumbing-code requirements
 *  (one stack per ~250 sqft of fixtures) and observed residential
 *  prevalence. */
function maxAllowed(type: string, sqft: number): number {
  switch (type) {
    case "chimney":
      // 1 on standard residential, 2 on large homes (> 3500 sqft).
      return sqft > 3500 ? 2 : 1;
    case "skylight":
      // Roughly 1 per 600 sqft of roof; cap at 6 for large homes.
      return Math.min(6, Math.max(1, Math.floor(sqft / 600)));
    case "hvac_unit":
      // Almost never on a pitched residential roof — usually on flat
      // additions or the ground. Allow 1 to cover the edge case.
      return 1;
    case "satellite_dish":
      return 2;
    case "solar_panel":
      // A solar array can have many panels — cap is generous.
      return 60;
    case "vent":
    case "plumbing_boot":
    case "stack": {
      // Plumbing physics: ~1 stack per bathroom + 2 attic vents per
      // 1000 sqft. Allow ~1 per 250 sqft + 3 floor.
      return Math.min(20, Math.max(4, Math.floor(sqft / 250) + 3));
    }
    default:
      return 10;
  }
}

/**
 * Run the full filter chain. Returns kept objects + audit-trail stats.
 */
export function filterPenetrations(
  raw: RawObject[],
  ctx: FilterContext,
): { kept: FilteredObject[]; stats: FilterStats } {
  const rejections: FilterStats["rejections"] = [];
  const drop = (obj: RawObject, reason: string): void => {
    rejections.push({
      type: obj.type,
      reason,
      confidence: obj.confidence,
      centerPx: obj.centerPx,
    });
  };

  // ─── Stage 1 — Type-specific confidence floors ───────────────────────
  const afterConfidence: RawObject[] = [];
  for (const obj of raw) {
    const floor = CONFIDENCE_FLOORS[obj.type] ?? DEFAULT_CONFIDENCE_FLOOR;
    if (typeof obj.confidence !== "number" || obj.confidence < floor) {
      drop(obj, `confidence ${obj.confidence?.toFixed(2)} < floor ${floor.toFixed(2)}`);
    } else {
      afterConfidence.push(obj);
    }
  }

  // ─── Stage 2 — Bbox-in-feet sanity ───────────────────────────────────
  const afterBbox: RawObject[] = [];
  for (const obj of afterConfidence) {
    const wFt = obj.bboxPx.width * ctx.tileMPerPx * M_TO_FT;
    const hFt = obj.bboxPx.height * ctx.tileMPerPx * M_TO_FT;
    const bounds = SIZE_BOUNDS_FT[obj.type];
    if (bounds) {
      const longest = Math.max(wFt, hFt);
      const shortest = Math.min(wFt, hFt);
      if (longest > bounds.max) {
        drop(obj, `${obj.type} too large: ${longest.toFixed(1)}ft > ${bounds.max}ft`);
        continue;
      }
      if (shortest < bounds.min) {
        drop(obj, `${obj.type} too small: ${shortest.toFixed(1)}ft < ${bounds.min}ft`);
        continue;
      }
    }
    afterBbox.push(obj);
  }

  // ─── Stage 3 — Cyan-mask geometric gate ──────────────────────────────
  //   Object center (with a forgiving 8px tolerance for eave-edge cases)
  //   must sit on the painted polygon. Without paint, skip this stage.
  const afterMask: RawObject[] = [];
  if (ctx.cyanMask) {
    for (const obj of afterBbox) {
      const inside = pointInCyanWithRadius(
        ctx.cyanMask,
        Math.round(obj.centerPx.x),
        Math.round(obj.centerPx.y),
        8,
      );
      if (inside) {
        afterMask.push(obj);
      } else {
        drop(
          obj,
          `center (${Math.round(obj.centerPx.x)},${Math.round(obj.centerPx.y)}) outside painted roof`,
        );
      }
    }
  } else {
    afterMask.push(...afterBbox);
  }

  // ─── Stage 4 — Two-pass agreement ────────────────────────────────────
  //   When secondary detections are available (Flash on the painted
  //   image), require type-matching detection within `agreementRadiusPx`.
  //   Boost confidence on agreement (mean of the two).
  const radius = ctx.agreementRadiusPx ?? 40;
  const radius2 = radius * radius;
  const afterTwoPass: FilteredObject[] = [];
  let agreementCount = 0;
  let twoPassAgreementRate: number | null = null;
  if (ctx.secondaryDetections) {
    const secondary = [...ctx.secondaryDetections];
    for (const obj of afterMask) {
      // Find best-match secondary detection of the same type.
      let bestIdx = -1;
      let bestD2 = Infinity;
      for (let i = 0; i < secondary.length; i++) {
        const s = secondary[i];
        if (s.type !== obj.type) continue;
        const dx = s.centerPx.x - obj.centerPx.x;
        const dy = s.centerPx.y - obj.centerPx.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2 && d2 <= radius2) {
          bestD2 = d2;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        const match = secondary.splice(bestIdx, 1)[0];
        agreementCount++;
        afterTwoPass.push({
          ...obj,
          confidence: Math.max(obj.confidence, match.confidence),
          twoPassAgreement: true,
        });
      } else {
        // No agreement — keep only when single-pass confidence is very
        // high (≥ floor + 0.15). This preserves the obvious chimney /
        // skylight on roofs where the painted-image pass under-detected.
        const floor = CONFIDENCE_FLOORS[obj.type] ?? DEFAULT_CONFIDENCE_FLOOR;
        if (obj.confidence >= floor + 0.15) {
          afterTwoPass.push({ ...obj, twoPassAgreement: false });
        } else {
          drop(obj, `no two-pass match within ${radius}px`);
        }
      }
    }
    twoPassAgreementRate =
      afterMask.length === 0 ? null : agreementCount / afterMask.length;
  } else {
    for (const obj of afterMask) {
      afterTwoPass.push({ ...obj, twoPassAgreement: false });
    }
  }

  // ─── Stage 5 — Deduplication ─────────────────────────────────────────
  //   Cluster same-type detections whose centers fall within 24" of
  //   each other. Keep the highest-confidence representative; the
  //   others are the "skylight + its shadow" double-count.
  const dedupRadiusPx = (24 / 12) / M_TO_FT / ctx.tileMPerPx; // 24" → px
  const dedupR2 = dedupRadiusPx * dedupRadiusPx;
  const afterDedup: FilteredObject[] = [];
  const claimed = new Array<boolean>(afterTwoPass.length).fill(false);
  for (let i = 0; i < afterTwoPass.length; i++) {
    if (claimed[i]) continue;
    const a = afterTwoPass[i];
    let best = i;
    let bestConf = a.confidence;
    for (let j = i + 1; j < afterTwoPass.length; j++) {
      if (claimed[j]) continue;
      const b = afterTwoPass[j];
      if (b.type !== a.type) continue;
      const dx = b.centerPx.x - a.centerPx.x;
      const dy = b.centerPx.y - a.centerPx.y;
      if (dx * dx + dy * dy <= dedupR2) {
        claimed[j] = true;
        if (b.confidence > bestConf) {
          best = j;
          bestConf = b.confidence;
        }
        drop(b, `dedup'd against ${a.type} at (${Math.round(a.centerPx.x)},${Math.round(a.centerPx.y)})`);
      }
    }
    claimed[best] = true;
    afterDedup.push(afterTwoPass[best]);
  }

  // ─── Stage 6 — Per-sqft type caps ────────────────────────────────────
  //   Group by type, sort descending by confidence, keep the top N.
  const byType = new Map<string, FilteredObject[]>();
  for (const obj of afterDedup) {
    if (!byType.has(obj.type)) byType.set(obj.type, []);
    byType.get(obj.type)!.push(obj);
  }
  const afterCaps: FilteredObject[] = [];
  byType.forEach((group, type) => {
    const max = maxAllowed(type, ctx.totalSqft);
    group.sort((a, b) => b.confidence - a.confidence);
    afterCaps.push(...group.slice(0, max));
    for (const dropped of group.slice(max)) {
      drop(
        dropped,
        `exceeds per-sqft cap (max ${max} ${type} for ${Math.round(ctx.totalSqft)} sqft)`,
      );
    }
  });

  return {
    kept: afterCaps,
    stats: {
      raw: raw.length,
      afterConfidence: afterConfidence.length,
      afterBbox: afterBbox.length,
      afterMask: afterMask.length,
      afterTwoPass: afterTwoPass.length,
      afterDedup: afterDedup.length,
      afterCaps: afterCaps.length,
      rejections,
      twoPassAgreementRate,
    },
  };
}

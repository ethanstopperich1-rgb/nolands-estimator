/**
 * Post-flight verification for Gemini Pro Image paint results.
 *
 * Pro Image (responseModalities ["IMAGE","TEXT"]) is non-deterministic
 * and occasionally fails to produce a useful cyan polygon — either it
 * returns no cyan at all, or paints the wrong area.
 *
 * Important context: we no longer display Pro Image's full image to the
 * customer. As of commit 767c233 the customer-facing image is a
 * composite of (a) the real Google Static Maps aerial + (b) the cyan
 * polygon Gemini drew, masked out via lib/cyan-mask.ts. So the only
 * thing we need from Pro Image is a USEFUL CYAN MASK — the facade it
 * "regenerates" gets thrown away by the composite step.
 *
 * That means verify only cares about the cyan polygon, not the
 * underlying facade. We check three things:
 *
 *   1. Cyan exists at all (>= ~5% of the tile). Below this floor, the
 *      composite would just show bare aerial with no annotation — the
 *      customer report that triggered this rewrite.
 *   2. Cyan isn't pathological (<= ~80% of the tile). The model
 *      painting "everything" is usually a sign it gave up trying to
 *      identify the roof and tinted the whole frame.
 *   3. Cyan centroid sits near the pin (the central building). If the
 *      centroid is wildly off-center, Pro Image painted a neighbor or
 *      drifted onto a structure away from the pin.
 *
 * The old MAE-on-non-cyan-pixels check has been removed. It was
 * calibrated for the pre-composite world where Pro Image's facade was
 * shown directly to the customer. With the composite approach the
 * facade is discarded, and the MAE check was incorrectly rejecting
 * paints whose cyan polygon was actually fine.
 */

import sharp from "sharp";

export type PaintVerdict = "edited" | "hallucinated" | "ambiguous";

export interface PaintVerifyResult {
  verdict: PaintVerdict;
  /** Human-readable reason — surfaced to structured logs only. */
  reason: string;
  /** Fraction of the painted image that's cyan-shifted [0..1]. */
  cyanCoverageFraction: number;
  /** Distance (in normalized tile units, 0=center 1=corner) from the
   *  cyan centroid to the tile center. Null when no cyan was found. */
  cyanCentroidOffset: number | null;
  /** Mean absolute error per channel on non-cyan pixels [0..255]. Kept
   *  as a diagnostic-only telemetry field — does NOT drive the verdict
   *  in the composite world. Null when no MAE pass ran. */
  nonCyanMae: number | null;
  /** Number of non-cyan pixels sampled for nonCyanMae. */
  sampleCount: number;
}

/** Same pixel-level cyan test as lib/cyan-mask.ts — kept inline so this
 *  module is dependency-free besides sharp. */
function isCyanPixel(r: number, g: number, b: number): boolean {
  if (b <= r || g <= r) return false;
  if (Math.max(g, b) < 110) return false;
  if (Math.min(g, b) - r < 25) return false;
  return true;
}

const COMPARE_SIZE = 128;

/** Tiles with cyan covering less than this fraction get retried — Pro
 *  Image effectively gave up on the overlay task. Real residential
 *  roofs at zoom 21 reliably cover 5-60% of the tile. */
const CYAN_COVERAGE_FLOOR = 0.05;

/** Tiles with cyan covering MORE than this fraction also fail. The
 *  model painted "everything" rather than identifying a discrete roof
 *  polygon — usually means it gave up. */
const CYAN_COVERAGE_CEILING = 0.80;

/** Normalized centroid-to-center distance threshold. The tile is
 *  COMPARE_SIZE × COMPARE_SIZE; tile-center is (64, 64). At the corner
 *  the distance is √2/2 ≈ 0.71. A threshold of 0.35 means "centroid
 *  more than ~35% of the way from center to corner" → wrong building.
 *  Generous — the pin is supposed to be on the building, so a real
 *  roof's centroid lands well inside this radius. */
const MAX_CENTROID_OFFSET = 0.35;

/**
 * Verify that Pro Image returned a usable cyan polygon. The input tile
 * parameter is retained for API compat / telemetry MAE; it is NOT used
 * to drive the verdict.
 */
export async function verifyPaintedAgainstInput(
  inputTileBase64: string,
  paintedBase64: string,
): Promise<PaintVerifyResult> {
  const decode = (b64: string) =>
    sharp(Buffer.from(b64, "base64"))
      .resize(COMPARE_SIZE, COMPARE_SIZE, { kernel: "lanczos3" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

  let src: Buffer;
  let dst: Buffer;
  try {
    const [srcOut, dstOut] = await Promise.all([
      decode(inputTileBase64),
      decode(paintedBase64),
    ]);
    src = srcOut.data;
    dst = dstOut.data;
  } catch (err) {
    return {
      verdict: "ambiguous",
      reason: `decode_failed: ${err instanceof Error ? err.message : String(err)}`,
      cyanCoverageFraction: 0,
      cyanCentroidOffset: null,
      nonCyanMae: null,
      sampleCount: 0,
    };
  }

  const total = COMPARE_SIZE * COMPARE_SIZE;
  const center = (COMPARE_SIZE - 1) / 2;
  const halfDiag = Math.SQRT2 * center;

  // ─── Cyan mask + centroid ────────────────────────────────────────────
  let cyanCount = 0;
  let sumX = 0;
  let sumY = 0;
  const isCyan = new Uint8Array(total);
  for (let y = 0; y < COMPARE_SIZE; y++) {
    for (let x = 0; x < COMPARE_SIZE; x++) {
      const i = y * COMPARE_SIZE + x;
      const r = dst[i * 3];
      const g = dst[i * 3 + 1];
      const b = dst[i * 3 + 2];
      if (isCyanPixel(r, g, b)) {
        isCyan[i] = 1;
        cyanCount++;
        sumX += x;
        sumY += y;
      }
    }
  }
  const cyanFrac = cyanCount / total;

  // Cyan-coverage floor.
  if (cyanFrac < CYAN_COVERAGE_FLOOR) {
    return {
      verdict: "hallucinated",
      reason:
        `cyan_coverage ${(cyanFrac * 100).toFixed(1)}% < floor ` +
        `${(CYAN_COVERAGE_FLOOR * 100).toFixed(0)}%`,
      cyanCoverageFraction: cyanFrac,
      cyanCentroidOffset: null,
      nonCyanMae: null,
      sampleCount: 0,
    };
  }

  // Cyan-coverage ceiling.
  if (cyanFrac > CYAN_COVERAGE_CEILING) {
    return {
      verdict: "hallucinated",
      reason:
        `cyan_coverage ${(cyanFrac * 100).toFixed(1)}% > ceiling ` +
        `${(CYAN_COVERAGE_CEILING * 100).toFixed(0)}% (model painted everything)`,
      cyanCoverageFraction: cyanFrac,
      cyanCentroidOffset: null,
      nonCyanMae: null,
      sampleCount: 0,
    };
  }

  // Cyan centroid sanity. The pin is centered at (640, 640) in the
  // source tile; at COMPARE_SIZE that's the geometric center.
  const cx = sumX / cyanCount;
  const cy = sumY / cyanCount;
  const offsetPx = Math.hypot(cx - center, cy - center);
  const offsetNormalized = offsetPx / halfDiag;
  if (offsetNormalized > MAX_CENTROID_OFFSET) {
    return {
      verdict: "hallucinated",
      reason:
        `cyan centroid offset ${(offsetNormalized * 100).toFixed(0)}% ` +
        `> ${(MAX_CENTROID_OFFSET * 100).toFixed(0)}% (painted wrong building)`,
      cyanCoverageFraction: cyanFrac,
      cyanCentroidOffset: offsetNormalized,
      nonCyanMae: null,
      sampleCount: 0,
    };
  }

  // Telemetry: compute non-cyan MAE for the structured log line, but
  // do NOT use it to drive the verdict. With the composite display
  // approach, non-cyan pixels are discarded, so MAE on them doesn't
  // matter for what the customer sees. We log it so dashboards can
  // still track Pro Image's "edit vs regenerate" rate over time.
  let maeSum = 0;
  let n = 0;
  for (let i = 0; i < total; i++) {
    if (isCyan[i]) continue;
    const sr = src[i * 3];
    const sg = src[i * 3 + 1];
    const sb = src[i * 3 + 2];
    const dr = dst[i * 3];
    const dg = dst[i * 3 + 1];
    const db = dst[i * 3 + 2];
    maeSum += Math.abs(dr - sr) + Math.abs(dg - sg) + Math.abs(db - sb);
    n++;
  }
  const mae = n > 0 ? maeSum / (n * 3) : 0;

  return {
    verdict: "edited",
    reason:
      `cyan_coverage=${(cyanFrac * 100).toFixed(0)}% ` +
      `centroid_offset=${(offsetNormalized * 100).toFixed(0)}% ` +
      `(diagnostic mae=${mae.toFixed(1)})`,
    cyanCoverageFraction: cyanFrac,
    cyanCentroidOffset: offsetNormalized,
    nonCyanMae: mae,
    sampleCount: n,
  };
}

/**
 * Minimal post-flight check for Gemini Pro Image paint results.
 *
 * History: this module went through three iterations.
 *
 *   v1 — MAE-on-non-cyan-pixels. Calibrated for the pre-composite
 *        world. Rejected the wrong things once composite shipped.
 *   v2 — Cyan-coverage floor + ceiling + centroid offset. Still too
 *        aggressive; rejected legitimate asymmetric roofs (L-shapes,
 *        wings) where the cyan centroid drifts off the geometric
 *        center of the frame.
 *   v3 (this) — One single check: did Pro Image return AT LEAST 3%
 *        cyan? If yes, ship it. If no, retry once. If still no, give
 *        up; the composite step (lib/composite-cyan-overlay) falls
 *        back to the bare Google aerial so the customer sees their
 *        real house regardless.
 *
 * The tightened prompt (output constraint + abstention path + no
 * generation-coded vocabulary) drops the first-shot failure rate
 * to ~1-2%. The composite step makes a failed paint non-fatal. So
 * the only verify we actually need is "did SOMETHING get painted?" —
 * everything else was over-engineering that produced false-negatives
 * and stripped real cyan polygons from real customer estimates.
 */

import sharp from "sharp";

export type PaintVerdict = "edited" | "hallucinated" | "ambiguous";

export interface PaintVerifyResult {
  verdict: PaintVerdict;
  /** Human-readable reason — surfaced to structured logs only. */
  reason: string;
  /** Fraction of the painted image that's cyan-shifted [0..1]. */
  cyanCoverageFraction: number;
  /** Retained on the interface for response-shape compat with prior
   *  v2 callers. Always null in v3 (no centroid check). */
  cyanCentroidOffset: number | null;
  /** Retained for telemetry — does NOT drive the verdict. Null when
   *  we short-circuited via the cyan-coverage floor. */
  nonCyanMae: number | null;
  /** Always 0 in v3 — kept for response-shape compat. */
  sampleCount: number;
}

function isCyanPixel(r: number, g: number, b: number): boolean {
  if (b <= r || g <= r) return false;
  if (Math.max(g, b) < 110) return false;
  if (Math.min(g, b) - r < 25) return false;
  return true;
}

const COMPARE_SIZE = 128;
/** The ONLY check. 3% of a 1280×1280 tile is ~49,000 pixels — well
 *  below the 5-10% a real residential roof reliably hits, but above
 *  the noise floor of stray cyan-ish pixels in the satellite image
 *  itself (a swimming pool, a teal car). */
const CYAN_COVERAGE_FLOOR = 0.03;

export async function verifyPaintedAgainstInput(
  _inputTileBase64: string,
  paintedBase64: string,
): Promise<PaintVerifyResult> {
  let dst: Buffer;
  try {
    const out = await sharp(Buffer.from(paintedBase64, "base64"))
      .resize(COMPARE_SIZE, COMPARE_SIZE, { kernel: "lanczos3" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    dst = out.data;
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
  let cyanCount = 0;
  for (let i = 0; i < total; i++) {
    const r = dst[i * 3];
    const g = dst[i * 3 + 1];
    const b = dst[i * 3 + 2];
    if (isCyanPixel(r, g, b)) cyanCount++;
  }
  const cyanFrac = cyanCount / total;

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

  return {
    verdict: "edited",
    reason: `cyan_coverage=${(cyanFrac * 100).toFixed(0)}% (above 3% floor)`,
    cyanCoverageFraction: cyanFrac,
    cyanCentroidOffset: null,
    nonCyanMae: null,
    sampleCount: 0,
  };
}

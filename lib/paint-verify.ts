/**
 * Post-flight verification for Gemini Pro Image paint results.
 *
 * Pro Image (responseModalities ["IMAGE","TEXT"]) is non-deterministic
 * and occasionally regenerates a NEW image from scratch instead of
 * editing the supplied satellite tile. The route comment header
 * documents this; customers have seen "fully AI-generated houses" come
 * back in production. Prompt tightening reduces the rate but does not
 * eliminate it — the only way to GUARANTEE we never show a hallucinated
 * image is to look at the pixels after the fact.
 *
 * This module compares the painted output to the input tile on the
 * non-cyan pixels only (the cyan is the model's only legal change).
 * A clean edit preserves the underlying photo within ~10 MAE; a
 * hallucinated scene diverges to 40-100+.
 *
 * Edge cases handled:
 *   - Large houses where cyan covers > 50% of the tile (few non-cyan
 *     samples remain): adaptive threshold relaxes by sample size so
 *     we don't falsely flag legitimate paints on McMansion roofs.
 *   - Pro Image returning no cyan at all (the model "forgot" the
 *     overlay task and just drew a house): cyan-coverage floor of 4%
 *     catches this independently of MAE.
 *   - Different output resolutions (Pro Image sometimes returns
 *     1024×1024 when given 1280×1280): both images are downsampled
 *     to 128×128 before comparison so resolution drift doesn't matter.
 */

import sharp from "sharp";

export type PaintVerdict = "edited" | "hallucinated" | "ambiguous";

export interface PaintVerifyResult {
  verdict: PaintVerdict;
  /** Human-readable reason — surfaced to structured logs only. */
  reason: string;
  /** Fraction of the painted image that's cyan-shifted [0..1]. */
  cyanCoverageFraction: number;
  /** Mean absolute error per channel on non-cyan pixels [0..255]. Null
   *  when the verdict comes from the cyan-coverage floor (no MAE
   *  pass ran). */
  nonCyanMae: number | null;
  /** Number of non-cyan pixels we averaged over. */
  sampleCount: number;
}

/** Same pixel-level cyan test as lib/cyan-mask.ts — kept inline so
 *  this module is dependency-free besides sharp. */
function isCyanPixel(r: number, g: number, b: number): boolean {
  if (b <= r || g <= r) return false;
  if (Math.max(g, b) < 110) return false;
  if (Math.min(g, b) - r < 25) return false;
  return true;
}

interface Thresholds {
  /** mae ≤ this → edited */
  edited: number;
  /** mae ≥ this → hallucinated */
  hallucinated: number;
}

/** Adaptive thresholds based on non-cyan sample size. Fewer non-cyan
 *  pixels means each pixel carries more statistical weight, so the
 *  band relaxes — a McMansion that fills 80% of the frame would only
 *  leave ~3,200 non-cyan pixels at 128×128 and we shouldn't flag it
 *  for hallucination off of small color drift. */
function thresholdsForSample(nonCyanFrac: number): Thresholds {
  if (nonCyanFrac >= 0.5) return { edited: 14, hallucinated: 32 };
  if (nonCyanFrac >= 0.25) return { edited: 18, hallucinated: 38 };
  if (nonCyanFrac >= 0.1) return { edited: 24, hallucinated: 45 };
  // < 10% non-cyan — house fills nearly the entire frame. Trust the
  // cyan-coverage floor for hallucination detection; only flag MAE in
  // the extreme range.
  return { edited: 30, hallucinated: 60 };
}

const COMPARE_SIZE = 128;
/** Tiles with cyan covering less than this fraction are treated as
 *  hallucinations regardless of MAE. Real residential roofs at zoom 21
 *  reliably cover 8-60% of the tile. A "fake house" hallucination
 *  often returns 0-3% cyan because the model interpreted the task as
 *  "render a satellite image" and forgot the overlay step entirely. */
const CYAN_COVERAGE_FLOOR = 0.04;

/**
 * Verify that the painted image is a real edit of the supplied tile,
 * not a from-scratch hallucination.
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
    // Decode failure is its own diagnostic — return ambiguous so the
    // caller decides (typically: keep the painted image, log a warning).
    return {
      verdict: "ambiguous",
      reason: `decode_failed: ${err instanceof Error ? err.message : String(err)}`,
      cyanCoverageFraction: 0,
      nonCyanMae: null,
      sampleCount: 0,
    };
  }

  const total = COMPARE_SIZE * COMPARE_SIZE;

  // ─── Pass 1: build cyan mask on the painted image ────────────────────
  const isCyan = new Uint8Array(total);
  let cyanCount = 0;
  for (let i = 0; i < total; i++) {
    const r = dst[i * 3];
    const g = dst[i * 3 + 1];
    const b = dst[i * 3 + 2];
    if (isCyanPixel(r, g, b)) {
      isCyan[i] = 1;
      cyanCount++;
    }
  }
  const cyanFrac = cyanCount / total;

  // Hard signal: no cyan = the model didn't paint, regardless of what
  // else it produced.
  if (cyanFrac < CYAN_COVERAGE_FLOOR) {
    return {
      verdict: "hallucinated",
      reason:
        `cyan_coverage ${(cyanFrac * 100).toFixed(1)}% < floor ` +
        `${(CYAN_COVERAGE_FLOOR * 100).toFixed(0)}%`,
      cyanCoverageFraction: cyanFrac,
      nonCyanMae: null,
      sampleCount: 0,
    };
  }

  // ─── Pass 2: MAE on non-cyan pixels ──────────────────────────────────
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
  const nonCyanFrac = n / total;
  const t = thresholdsForSample(nonCyanFrac);

  if (mae <= t.edited) {
    return {
      verdict: "edited",
      reason:
        `mae ${mae.toFixed(1)} ≤ ${t.edited} ` +
        `(non_cyan=${(nonCyanFrac * 100).toFixed(0)}%)`,
      cyanCoverageFraction: cyanFrac,
      nonCyanMae: mae,
      sampleCount: n,
    };
  }
  if (mae >= t.hallucinated) {
    return {
      verdict: "hallucinated",
      reason:
        `mae ${mae.toFixed(1)} ≥ ${t.hallucinated} ` +
        `(non_cyan=${(nonCyanFrac * 100).toFixed(0)}%)`,
      cyanCoverageFraction: cyanFrac,
      nonCyanMae: mae,
      sampleCount: n,
    };
  }
  return {
    verdict: "ambiguous",
    reason:
      `mae ${mae.toFixed(1)} in dead zone [${t.edited}, ${t.hallucinated}] ` +
      `(non_cyan=${(nonCyanFrac * 100).toFixed(0)}%)`,
    cyanCoverageFraction: cyanFrac,
    nonCyanMae: mae,
    sampleCount: n,
  };
}

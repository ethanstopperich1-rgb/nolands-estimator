/**
 * Cyan-mask extraction from the Gemini Pro Image painted PNG.
 *
 * The paint pass draws cyan (#38C5EE = R56 G197 B238) at ~40% opacity on
 * every roof plane. Extracting the mask gives us a ground-truthed roof
 * silhouette in pixel space that downstream stages can use for:
 *
 *   1. Geometric gating of penetration detections (drop objects whose
 *      centerPx falls outside the painted polygon — kills lawn / neighbor
 *      false positives).
 *   2. Compactness ratio (perimeter² / 4π × area) — a deterministic
 *      shape-complexity signal for the waste formula. Simple rectangle
 *      ≈ 1.3, L-shape ≈ 1.8, cross-gable ≈ 2.2+.
 *
 * Detection heuristic: a pixel is "cyan-painted" when its hue sits in
 * the cyan band AND it's bright enough to be a real overlay (not a deep
 * shadow). We work in RGB directly — the underlying satellite pixel
 * blended with #38C5EE @ 40% opacity preserves the cyan dominance
 * (B + G > R by a wide margin, max(B,G) ≥ 110) across the shingle
 * brightness range we see in production.
 */

import sharp from "sharp";

export interface CyanMask {
  /** Flat row-major mask. `mask[y * width + x] === 1` when the pixel is
   *  cyan-painted, else 0. */
  mask: Uint8Array;
  width: number;
  height: number;
  /** Count of mask=1 pixels. */
  areaPx: number;
  /** Count of mask=1 pixels that have at least one non-mask 4-neighbor
   *  (or sit on the image border). */
  perimeterPx: number;
  /** perimeter² / (4π × area). Circle = 1.0, square ≈ 1.27,
   *  simple residential rectangle ≈ 1.3–1.5, L-shape ≈ 1.7–2.0,
   *  cross-gable / multi-wing ≈ 2.2+. Null when areaPx === 0. */
  compactness: number | null;
}

/** Pixel-level cyan test. Tuned against actual production paint output
 *  (Winter Garden, Orlando, Jupiter) — works on the 40% translucent fill
 *  AND on the full-opacity 2–3px stroke. Returns true when the pixel is
 *  visibly cyan-shifted vs the underlying shingle tone. */
function isCyanPixel(r: number, g: number, b: number): boolean {
  // 1. Blue + green must both exceed red (otherwise it's brown/yellow shingle).
  if (b <= r || g <= r) return false;
  // 2. Bright enough — a deep shadow can satisfy (1) and not be paint.
  if (Math.max(g, b) < 110) return false;
  // 3. Cyan-shifted vs neutral gray. min(g,b) − r needs a clear margin,
  //    otherwise plain bright concrete (driveway) sneaks through.
  if (Math.min(g, b) - r < 25) return false;
  return true;
}

/**
 * Extract the cyan-painted mask from a base64 PNG. Returns null when the
 * input fails to decode (caller falls back to mask-less filtering).
 */
export async function extractCyanMask(
  paintedBase64: string,
): Promise<CyanMask | null> {
  try {
    const buf = Buffer.from(paintedBase64, "base64");
    const { data, info } = await sharp(buf)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (channels < 3) return null;
    const mask = new Uint8Array(width * height);
    let areaPx = 0;
    for (let i = 0; i < width * height; i++) {
      const base = i * channels;
      const r = data[base];
      const g = data[base + 1];
      const b = data[base + 2];
      if (isCyanPixel(r, g, b)) {
        mask[i] = 1;
        areaPx++;
      }
    }
    if (areaPx === 0) {
      return { mask, width, height, areaPx, perimeterPx: 0, compactness: null };
    }
    // Perimeter = mask pixels with at least one 4-neighbor that is NOT
    // mask (image-border counts as "not mask"). Cheap O(width × height).
    let perimeterPx = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!mask[i]) continue;
        const left = x === 0 || mask[i - 1] === 0;
        const right = x === width - 1 || mask[i + 1] === 0;
        const top = y === 0 || mask[i - width] === 0;
        const bottom = y === height - 1 || mask[i + width] === 0;
        if (left || right || top || bottom) perimeterPx++;
      }
    }
    const compactness =
      (perimeterPx * perimeterPx) / (4 * Math.PI * areaPx);
    return { mask, width, height, areaPx, perimeterPx, compactness };
  } catch {
    return null;
  }
}

/** Single-pixel lookup. Returns false when the coords are out of bounds
 *  so callers don't need to range-check before asking. */
export function pointInCyan(
  cyan: CyanMask,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x >= cyan.width || y >= cyan.height) return false;
  return cyan.mask[y * cyan.width + x] === 1;
}

/** Tolerant gate: accept a point if it OR any of its 4-neighbors within
 *  `radiusPx` is cyan. Lets us forgive small detection-center errors
 *  near the eave without admitting lawn fixtures. */
export function pointInCyanWithRadius(
  cyan: CyanMask,
  x: number,
  y: number,
  radiusPx: number,
): boolean {
  if (radiusPx <= 0) return pointInCyan(cyan, x, y);
  const r = Math.ceil(radiusPx);
  const r2 = radiusPx * radiusPx;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      if (pointInCyan(cyan, x + dx, y + dy)) return true;
    }
  }
  return false;
}

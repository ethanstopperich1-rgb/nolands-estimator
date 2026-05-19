/**
 * Cyan-mask extraction from the Gemini Pro Image painted PNG.
 *
 * Two outputs:
 *
 *   1. `mask` (binary, 0/1) — used by:
 *      - the penetration filter's geometric gate (does this object
 *        center sit on a painted roof?)
 *      - the compactness ratio + area / perimeter calculations that
 *        feed the geometric waste formula
 *
 *   2. `alphaMap` (continuous, 0-255) — used by:
 *      - lib/composite-cyan-overlay.ts to paint the cyan onto the raw
 *        Google aerial with the SAME smoothness Pro Image painted with
 *      - lib/cyan-mask.ts → maskToCyanOverlayPng for the interactive
 *        Google Maps GroundOverlay layer
 *
 *      Each byte is "how cyan-shifted is this pixel from neutral"
 *      mapped to alpha. Translucent fill pixels get ~100-160 alpha,
 *      full-opacity stroke pixels get 240-255 alpha, neutral pixels
 *      get 0. The smooth ramp at edges is what makes the composite
 *      look magazine-clean instead of pixel-aliased.
 *
 * Prior versions used a binary mask + a separate "stroke mask" with
 * morphological filtering. That produced jagged extracted edges and
 * blob-shaped false positives that the morphology had to chase. The
 * continuous-alpha approach side-steps both problems — Pro Image's
 * own anti-aliasing carries through the extraction unchanged.
 */

import sharp from "sharp";

export interface CyanMask {
  /** Binary mask. `mask[y * width + x] === 1` when the pixel is
   *  cyan-painted (translucent fill OR full-opacity stroke). Used for
   *  geometric ops only — the composite uses `alphaMap` instead. */
  mask: Uint8Array;
  /** Continuous per-pixel alpha [0, 255]. Smoothly tapers at painted
   *  edges and at the boundary between full-opacity stroke and
   *  translucent fill, so the composite preserves Pro Image's
   *  anti-aliasing. */
  alphaMap: Uint8Array;
  width: number;
  height: number;
  /** Count of `mask[i] === 1` pixels. */
  areaPx: number;
  /** Count of mask=1 pixels with at least one non-mask 4-neighbor
   *  (or sitting on the image border). */
  perimeterPx: number;
  /** perimeter² / (4π × area). Circle = 1.0, square ≈ 1.27,
   *  simple residential rectangle ≈ 1.3–1.5, L-shape ≈ 1.7–2.0,
   *  cross-gable / multi-wing ≈ 2.2+. Null when areaPx === 0. */
  compactness: number | null;
}

/** Brightness floor — deep shadow pixels can look "blue" in RGB without
 *  being paint. Pixels darker than this are zero-alpha regardless. */
const BRIGHTNESS_FLOOR = 110;
/** Saturation floor on `min(g,b) - r`. Below this, the pixel is either
 *  neutral or driveway-bright concrete; not paint. */
const CYAN_SAT_FLOOR = 22;
/** Saturation at which we render at full opacity. Pure brand cyan
 *  (#38C5EE = 56,197,238) → sat = min(197,238) - 56 = 141. Map that
 *  to alpha=255. Pixels above this clamp at 255. */
const CYAN_SAT_FULL = 110;

/** Continuous "how cyan is this pixel" mapping to [0, 255]. Returns:
 *
 *    0   for neutral / non-cyan pixels (filtered by brightness + sat)
 *    ~115 for 40%-fill cyan over typical mid-gray shingle (~99,156,172)
 *    ~255 for pure cyan strokes (56,197,238)
 *
 *  The smooth ramp between thresholds is what gives the composite
 *  its anti-aliased edges.
 */
function cyanAlpha(r: number, g: number, b: number): number {
  // Reject deep shadows (false-blue pixels in dark areas).
  if (Math.max(g, b) < BRIGHTNESS_FLOOR) return 0;
  // Reject pixels where red is not clearly suppressed vs green/blue
  // (otherwise plain bright concrete sneaks through).
  if (b <= r || g <= r) return 0;
  const sat = Math.min(g, b) - r;
  if (sat < CYAN_SAT_FLOOR) return 0;
  // Linear ramp from saturation floor to full-opacity threshold.
  const t = (sat - CYAN_SAT_FLOOR) / (CYAN_SAT_FULL - CYAN_SAT_FLOOR);
  return Math.min(255, Math.max(0, Math.round(t * 255)));
}

/**
 * Extract the cyan-painted mask + continuous alpha map from a base64
 * PNG. Returns null when the input fails to decode.
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
    const total = width * height;
    const mask = new Uint8Array(total);
    const alphaMap = new Uint8Array(total);
    let areaPx = 0;
    for (let i = 0; i < total; i++) {
      const base = i * channels;
      const a = cyanAlpha(data[base], data[base + 1], data[base + 2]);
      if (a > 0) {
        alphaMap[i] = a;
        mask[i] = 1;
        areaPx++;
      }
    }
    if (areaPx === 0) {
      return {
        mask,
        alphaMap,
        width,
        height,
        areaPx,
        perimeterPx: 0,
        compactness: null,
      };
    }
    // Perimeter = mask pixels with at least one 4-neighbor that is NOT
    // mask (image border counts as "not mask"). Cheap O(width × height).
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
    return {
      mask,
      alphaMap,
      width,
      height,
      areaPx,
      perimeterPx,
      compactness,
    };
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

/**
 * Render the continuous alpha map to a transparent PNG suitable for use
 * as a Google Maps `GroundOverlay`. Each cyan pixel keeps its per-pixel
 * alpha so the GroundOverlay renders with the same smoothness as the
 * static composite.
 *
 * Output dimensions match the mask exactly — the caller is expected to
 * georeference the overlay against the same tile bounds the original
 * painted PNG was produced for.
 */
export async function maskToCyanOverlayPng(
  mask: CyanMask,
  opts: { r?: number; g?: number; b?: number; alphaScale?: number } = {},
): Promise<Buffer> {
  const r = opts.r ?? 0x38;
  const g = opts.g ?? 0xc5;
  const b = opts.b ?? 0xee;
  const scale = opts.alphaScale ?? 1.0;
  const { width, height, alphaMap } = mask;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < alphaMap.length; i++) {
    const base = i * 4;
    const a = alphaMap[i];
    if (a > 0) {
      rgba[base] = r;
      rgba[base + 1] = g;
      rgba[base + 2] = b;
      rgba[base + 3] = Math.min(255, Math.round(a * scale));
    }
    // Else fully transparent — RGBA bytes default to 0.
  }
  return sharp(rgba, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
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

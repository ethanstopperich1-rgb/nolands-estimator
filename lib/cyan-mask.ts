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
   *  cyan-painted (either translucent fill OR full-opacity stroke). */
  mask: Uint8Array;
  /** Stroke-only mask. `strokeMask[i] === 1` when the pixel is
   *  near-pure cyan (the 2-3px boundary stroke Pro Image draws on
   *  every legal edge). A subset of `mask`. Used by the composite
   *  step to render the bright facet outlines at full opacity over
   *  the translucent fill, so interior ridge/hip/valley/eave lines
   *  stay visually distinct after compositing. */
  strokeMask: Uint8Array;
  width: number;
  height: number;
  /** Count of mask=1 pixels (fill + stroke). */
  areaPx: number;
  /** Count of strokeMask=1 pixels. */
  strokePx: number;
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

/** Stricter cyan test that ONLY matches the near-pure cyan pixels Pro
 *  Image uses for the full-opacity boundary stroke.
 *
 *  Reference: brand cyan #38C5EE = (56, 197, 238). A pure-stroke pixel
 *  is close to that. A 40% translucent fill over a typical mid-gray
 *  shingle (~128,128,128) blends to roughly (99, 156, 172) — much
 *  redder and much less blue than the stroke. Detecting the stroke
 *  separately lets the composite restore the bright facet outlines
 *  that disappear when we render every cyan pixel at a single flat
 *  fill alpha. */
function isCyanStrokePixel(r: number, g: number, b: number): boolean {
  // Tight bounds around #38C5EE = (56, 197, 238). The fill is the
  // 40%-opacity blend OVER shingles; even over dark shingles the
  // blended red component sits well above 70. The full-opacity stroke
  // sits within ±15 of each channel. Tightening this band (vs the
  // earlier (110, 170-230, 200, b-r>=100) version) suppresses the
  // bright "smudge" false positives where a few stray fill pixels
  // landed in the loose stroke band and got rendered at full alpha.
  if (r > 85) return false;
  if (b < 220) return false;
  if (g < 180 || g > 215) return false;
  if (b - r < 135) return false;
  return true;
}

/**
 * Demote stroke pixels in blob-shaped clusters back to fill. A real
 * facet-boundary stroke is a thin line (2-4px wide); a smudge is a
 * wider blob (8+px) of pixels that happen to share the same cyan
 * hue. Both pass `isCyanStrokePixel`, but only lines are useful
 * structure.
 *
 * Test: for each stroke pixel, look 3 pixels out in the 4 cardinal
 * directions. If ALL FOUR of those probe points are also stroke
 * pixels, this pixel sits inside a blob ≥7px across — demote it.
 * If ANY probe lands on non-stroke (line edge, line end, fill, or
 * out-of-frame), this pixel is on or near a line boundary — keep it.
 */
function thinStrokeMask(
  strokeMask: Uint8Array,
  width: number,
  height: number,
): { thinMask: Uint8Array; thinPx: number; demotedPx: number } {
  const thinMask = new Uint8Array(strokeMask.length);
  const R = 3; // ring radius — pixels with ≥4px of stroke in every
  //                direction get demoted (blob signature).
  let thinPx = 0;
  let demotedPx = 0;
  const inside = (x: number, y: number) =>
    x >= 0 && x < width && y >= 0 && y < height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!strokeMask[i]) continue;
      // Out-of-frame probes count as non-stroke (line at frame edge
      // should still survive).
      const left = inside(x - R, y) && strokeMask[y * width + (x - R)];
      const right = inside(x + R, y) && strokeMask[y * width + (x + R)];
      const up = inside(x, y - R) && strokeMask[(y - R) * width + x];
      const down = inside(x, y + R) && strokeMask[(y + R) * width + x];
      if (left && right && up && down) {
        // All four cardinal probes hit stroke → this pixel is inside
        // a ≥7px-thick blob, not on a thin line.
        demotedPx++;
      } else {
        thinMask[i] = 1;
        thinPx++;
      }
    }
  }
  return { thinMask, thinPx, demotedPx };
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
    const strokeMask = new Uint8Array(width * height);
    let areaPx = 0;
    let strokePx = 0;
    for (let i = 0; i < width * height; i++) {
      const base = i * channels;
      const r = data[base];
      const g = data[base + 1];
      const b = data[base + 2];
      if (isCyanPixel(r, g, b)) {
        mask[i] = 1;
        areaPx++;
        if (isCyanStrokePixel(r, g, b)) {
          strokeMask[i] = 1;
          strokePx++;
        }
      }
    }
    if (areaPx === 0) {
      return {
        mask,
        strokeMask,
        width,
        height,
        areaPx,
        strokePx,
        perimeterPx: 0,
        compactness: null,
      };
    }

    // Demote blob-shaped cyan clusters back to fill so only thin
    // facet-boundary lines render at full opacity in the composite.
    // Without this, bright cyan smudges (4-15px diameter) survive on
    // the interior of the fill and look like paint splatter.
    const { thinMask, thinPx, demotedPx } = thinStrokeMask(
      strokeMask,
      width,
      height,
    );
    if (demotedPx > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[cyan-mask] stroke_thinned strokes=${strokePx} → ${thinPx} ` +
          `(demoted=${demotedPx} blob pixels to fill alpha)`,
      );
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
    return {
      mask,
      strokeMask: thinMask,
      width,
      height,
      areaPx,
      strokePx: thinPx,
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
 * Render the cyan mask to a transparent PNG suitable for use as a
 * Google Maps `GroundOverlay`. Cyan pixels get filled with brand cyan
 * (#38C5EE) at the supplied alpha; non-cyan pixels are fully transparent.
 *
 * Output dimensions match the mask exactly — the caller is expected to
 * georeference the overlay against the same tile bounds the original
 * painted PNG was produced for.
 */
export async function maskToCyanOverlayPng(
  mask: CyanMask,
  opts: { r?: number; g?: number; b?: number; alpha?: number } = {},
): Promise<Buffer> {
  const r = opts.r ?? 0x38;
  const g = opts.g ?? 0xc5;
  const b = opts.b ?? 0xee;
  const fillAlpha = Math.round((opts.alpha ?? 0.55) * 255);
  const { width, height } = mask;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < mask.mask.length; i++) {
    const base = i * 4;
    if (mask.mask[i] === 1) {
      rgba[base] = r;
      rgba[base + 1] = g;
      rgba[base + 2] = b;
      // Stroke pixels render at full opacity so the facet-boundary
      // lines stay crisp through the GroundOverlay. Fill pixels render
      // at the configured translucent alpha. Same two-tier render the
      // static composite uses (lib/composite-cyan-overlay.ts), so the
      // interactive map and the static fallback look consistent.
      rgba[base + 3] = mask.strokeMask[i] === 1 ? 255 : fillAlpha;
    } else {
      // Fully transparent. RGBA bytes default to 0; alpha at base+3
      // already 0 means transparent. No-op explicitly for clarity.
      rgba[base + 3] = 0;
    }
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

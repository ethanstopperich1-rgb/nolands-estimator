/**
 * Watermark the painted-PNG output with a faint `voxaris.io` stamp in
 * the bottom-right corner.
 *
 * The painted roof is the visual asset the customer sees on the
 * estimate, the proposal PDF, and the share link — high-value content
 * that competitors can right-click and reuse. A subtle ~25%-opacity
 * mark makes the provenance obvious without disrupting the visual.
 *
 * Implementation: composite an SVG layer with sharp. Returns base64
 * of the watermarked PNG; falls back to the input on any failure
 * (sharp is the only failure mode and the route already treats sharp
 * errors as soft — we'd rather ship the unwatermarked image than 500).
 */

import sharp from "sharp";

/** Width of the watermark text block, in pixels. Calibrated for the
 *  1280×1280 painted PNG (TILE_SIZE_PX * TILE_SCALE). */
const STAMP_WIDTH = 220;
const STAMP_HEIGHT = 36;
const STAMP_PADDING = 24;

function buildStampSvg(width: number, height: number): Buffer {
  // Positioned bottom-right with a soft drop shadow so the mark stays
  // legible on bright (white roofs, snow) AND dark (asphalt) backgrounds.
  const x = width - STAMP_WIDTH - STAMP_PADDING;
  const y = height - STAMP_HEIGHT - STAMP_PADDING;
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="1.2" />
    </filter>
  </defs>
  <g transform="translate(${x}, ${y})" opacity="0.55">
    <text x="2" y="26"
          font-family="ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          font-size="22" font-weight="500"
          fill="#000" filter="url(#soft)" opacity="0.45">voxaris.io</text>
    <text x="0" y="24"
          font-family="ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          font-size="22" font-weight="500"
          fill="#ffffff">voxaris.io</text>
  </g>
</svg>`;
  return Buffer.from(svg);
}

/**
 * Apply the watermark to a base64-encoded PNG and return the new
 * base64 string. Soft-fails to the input on any error.
 */
export async function watermarkPaintedPng(base64: string): Promise<string> {
  try {
    const input = Buffer.from(base64, "base64");
    const meta = await sharp(input).metadata();
    const width = meta.width ?? 1280;
    const height = meta.height ?? 1280;
    const stamp = buildStampSvg(width, height);
    const out = await sharp(input)
      .composite([{ input: stamp, top: 0, left: 0, blend: "over" }])
      .png({ compressionLevel: 8 })
      .toBuffer();
    return out.toString("base64");
  } catch (err) {
    console.warn(
      "[watermark] failed, returning unwatermarked",
      err instanceof Error ? err.message : String(err),
    );
    return base64;
  }
}

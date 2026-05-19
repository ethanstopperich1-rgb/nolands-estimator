/**
 * Customer-facing painted-image composite.
 *
 * Background — why this exists:
 *
 *   The V3 pipeline calls Google Gemini 3 Pro Image with the satellite
 *   tile and a prompt to "paint cyan on every visible roof plane." The
 *   model returns a 1280×1280 PNG. Until May 2026 we sent that PNG
 *   directly to the customer as their "your roof, painted" visual.
 *
 *   But Gemini 3 Pro Image is a *generative* text-to-image model that
 *   conditions on the input image — it doesn't pixel-edit. The painted
 *   PNG it returns is its *interpretation* of the building, not a
 *   pixel-faithful overlay on the original aerial. On simple 4-facet
 *   hip roofs that interpretation closely matches the photo. On
 *   complex 17-facet multi-wing estates (8450 Oak Park, Orlando) the
 *   model renders an idealized, symmetric "concept of an estate" that
 *   diverges visibly from the actual building.
 *
 *   The customer notices. ("That's not even my house.") Trust dies.
 *
 *   Fix: stop sending the customer Gemini's generated image. Use
 *   Gemini only to *find* the roof boundary (extracted as a cyan mask
 *   in lib/cyan-mask.ts), then composite that mask as a translucent
 *   cyan tint onto the *real* Google Static Maps aerial. The customer
 *   sees their actual satellite photo with cyan highlighting where
 *   we measured — no generative geometry, no fictional facets.
 *
 * Design notes:
 *
 *   - Cyan color matches the original prompt's #38C5EE (so the rep
 *     workbench's reference to "cyan" stays consistent).
 *   - 40% opacity matches the prompt's documented overlay strength
 *     (`lib/gemini-roof-prompt.ts:41`). Shingle texture stays visible
 *     under the tint.
 *   - The mask comes from the post-paint cyan extraction in
 *     lib/cyan-mask.ts, so it tracks Gemini's actual roof detection
 *     (incl. its choices about chimneys/skylights/etc).
 *   - We render the mask as a single full-alpha cyan PNG with the
 *     mask's per-pixel alpha, then sharp-composite at 40% global
 *     opacity. sharp's `composite` blend "over" handles the alpha
 *     blending in linear-ish RGB without us writing a pixel loop.
 *   - Watermark is layered on top after compositing so it remains
 *     legible against the cyan-tinted shingles.
 *
 * Failure mode: if the mask has 0 cyan pixels (Gemini paint failed)
 * or the aerial fails to decode, the function returns the raw aerial
 * unchanged. Caller treats this as "no cyan overlay this time" — the
 * estimate still ships, just without the highlighted polygon.
 */

import sharp from "sharp";

import type { CyanMask } from "@/lib/cyan-mask";

/** Brand cyan — must match `GEMINI_ROOF_SYSTEM_INSTRUCTION` so the
 *  highlight color the customer sees lines up with prompt/docs. */
const OVERLAY_HEX = "#38C5EE";
/** Overall tint strength. 102/255 ≈ 40% — matches the prompt
 *  ("Fill: cyan #38C5EE at ~40% opacity"). */
const OVERLAY_ALPHA = 102;
/** Hard ceiling on how much of the frame the mask is allowed to cover
 *  before we treat it as "Pro Image painted the whole scene cyan."
 *
 *  At zoom 21 + scale 2 a typical FL residential roof occupies 8-25%
 *  of the 1280×1280 tile (we frame the property to dominate but the
 *  building footprint at that zoom is rarely more than a quarter of
 *  the image). Anything past 35% means Gemini's "cyan" bled into lawn,
 *  pool cage, driveway, neighbor structure, or the model gave up and
 *  flood-filled the whole frame. We can't trust that mask to mark
 *  "only the roof" — compositing it would tint everything and produce
 *  the same uncanny image we're trying to escape.
 *
 *  When this guard fires we skip the composite and return the raw
 *  aerial unchanged. Customer sees their actual photo, no cyan, no
 *  fake overlay. Better than a credibility-burning composite. */
const MAX_MASK_FILL_FRACTION = 0.35;

/**
 * Composite the cyan mask onto the raw satellite aerial.
 *
 * @param rawAerialBase64 — raw Google Static Maps PNG. NOT the
 *   shadow-lifted version sent to Gemini; the customer should see
 *   Google's actual photo, not our preprocessing.
 * @param cyanMask — extracted by `extractCyanMask(paintedBase64)`.
 *   Must match the aerial in dimensions; pipeline guarantees this
 *   because both come from the same 1280×1280 tile fetch.
 * @returns base64 PNG of the composited image. Falls back to
 *   `rawAerialBase64` on any error so the customer always sees
 *   *some* picture of their house.
 */
export async function compositeCyanOnAerial(
  rawAerialBase64: string,
  cyanMask: CyanMask,
): Promise<string> {
  if (cyanMask.areaPx === 0) {
    // Gemini paint returned no cyan — no overlay to apply, just send
    // the raw aerial through.
    return rawAerialBase64;
  }

  // Fill-fraction guard: when Gemini paints the WHOLE frame cyan
  // (failure mode seen on 8450 Oak Park — 17-segment hint forced the
  // model into generative-fill mode), the extracted mask covers lawn,
  // pool, driveway, neighbor structures. Compositing that mask tints
  // the entire photo and the customer still sees a fake-looking image.
  // Reject and return raw aerial unchanged.
  const framePx = cyanMask.width * cyanMask.height;
  const fillFraction = framePx > 0 ? cyanMask.areaPx / framePx : 0;
  if (fillFraction > MAX_MASK_FILL_FRACTION) {
    console.warn(
      `[composite] mask fill_fraction=${(fillFraction * 100).toFixed(1)}% ` +
        `> ${(MAX_MASK_FILL_FRACTION * 100).toFixed(0)}% ceiling — ` +
        `skipping composite (Gemini likely flood-painted the frame), ` +
        `returning raw aerial`,
    );
    return rawAerialBase64;
  }

  try {
    const aerial = Buffer.from(rawAerialBase64, "base64");

    // Verify aerial dimensions match the mask. If they don't we'd
    // be drawing the cyan overlay on the wrong pixels — soft-fail to
    // the raw aerial rather than ship a misaligned composite.
    const meta = await sharp(aerial).metadata();
    if (
      meta.width !== cyanMask.width ||
      meta.height !== cyanMask.height
    ) {
      console.warn(
        "[composite] mask/aerial size mismatch — skipping composite",
        { aerial: { w: meta.width, h: meta.height }, mask: { w: cyanMask.width, h: cyanMask.height } },
      );
      return rawAerialBase64;
    }

    // Build a single RGBA buffer the size of the aerial. For each
    // mask=1 pixel, set RGB to brand cyan and A to OVERLAY_ALPHA.
    // For mask=0 pixels, leave A=0 so sharp's composite skips them.
    const { width, height } = cyanMask;
    const rgba = Buffer.alloc(width * height * 4);
    const r = parseInt(OVERLAY_HEX.slice(1, 3), 16);
    const g = parseInt(OVERLAY_HEX.slice(3, 5), 16);
    const b = parseInt(OVERLAY_HEX.slice(5, 7), 16);
    for (let i = 0; i < cyanMask.mask.length; i++) {
      if (!cyanMask.mask[i]) continue;
      const base = i * 4;
      rgba[base] = r;
      rgba[base + 1] = g;
      rgba[base + 2] = b;
      rgba[base + 3] = OVERLAY_ALPHA;
    }

    const overlay = await sharp(rgba, {
      raw: { width, height, channels: 4 },
    })
      .png()
      .toBuffer();

    const composited = await sharp(aerial)
      .composite([{ input: overlay, top: 0, left: 0, blend: "over" }])
      .png({ compressionLevel: 8 })
      .toBuffer();

    return composited.toString("base64");
  } catch (err) {
    console.warn(
      "[composite] failed, returning raw aerial",
      err instanceof Error ? err.message : String(err),
    );
    return rawAerialBase64;
  }
}

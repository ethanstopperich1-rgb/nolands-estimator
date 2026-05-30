/**
 * /twitter-image — the X/Twitter card image.
 *
 * Renders the exact same branded Noland's card as the Open Graph image
 * (app/opengraph-image.tsx) so x.com and any `twitter:image` consumer
 * gets the correct logo'd card on the production domain.
 *
 * IMPORTANT (Next.js 16 / Turbopack): route-segment config exports
 * (`runtime`) MUST be declared directly in the route file — they
 * cannot be re-exported via `export { runtime } from "..."` (Turbopack
 * can't statically parse a re-exported config field and fails the
 * build with "can't recognize the exported `runtime` field"). So we
 * re-export ONLY the default component (allowed) and declare `runtime`
 * + the image metadata as direct local consts mirroring
 * opengraph-image.tsx. Keeps the two cards byte-identical with no
 * duplicated render code.
 */

import OpengraphImage from "./opengraph-image";

export const runtime = "nodejs";
export const alt = "Noland's Roofing — Get your roof priced in 30 seconds";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default OpengraphImage;

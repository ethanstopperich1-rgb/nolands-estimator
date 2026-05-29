/**
 * /twitter-image — the X/Twitter card image.
 *
 * Reuses the exact same branded Noland's card as the Open Graph image
 * (app/opengraph-image.tsx) so x.com and any `twitter:image` consumer
 * renders the correct logo'd card on the correct (production) domain.
 *
 * Why this file exists: `twitter:image` previously pointed at a static
 * `twitter-image.png` that doesn't exist in this repo (a 404). Next.js
 * auto-detects this special file and generates a valid twitter:image
 * from its default export. Re-exporting the OG generator keeps the two
 * cards byte-identical with zero duplicated design code.
 */

export {
  default,
  runtime,
  alt,
  size,
  contentType,
} from "./opengraph-image";

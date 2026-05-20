/**
 * Homeowner-share URL builder.
 *
 * The shape:
 *   https://pitch.voxaris.io/r/<lead_public_id>
 *
 * Strategy:
 *   - Public, no auth — the `lead_<32-hex>` public_id is the bearer
 *     token. ~128 bits of entropy makes URL guessing infeasible.
 *   - Server-rendered from the persisted V3 response in
 *     `leads.roof_v3_json` — never re-runs the pipeline, so loads
 *     instantly and costs $0.
 *   - Homeowner-readable surface: hides PII (email, exact phone) and
 *     internal-only fields. Designed to be shared with a spouse,
 *     emailed to oneself, bookmarked.
 *   - Open Graph + Twitter Card meta tags make the URL render as a
 *     rich preview in iMessage / WhatsApp / Messages / Twitter /
 *     Facebook (see `app/r/[publicId]/opengraph-image.tsx`).
 *   - `noindex, nofollow` — these are private to the homeowner. We
 *     don't want Google or other crawlers building a public index of
 *     real leads.
 */

/** Build the public homeowner-share URL for a lead. Accepts an
 *  optional origin override for SSR contexts where `window` isn't
 *  available (server actions, route handlers, edge functions). */
export function buildHomeownerShareUrl(
  publicId: string,
  origin?: string,
): string {
  const base =
    origin ??
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "https://pitch.voxaris.io");
  return `${base.replace(/\/$/, "")}/r/${publicId}`;
}

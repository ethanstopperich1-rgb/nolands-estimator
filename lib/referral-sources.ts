/**
 * lib/referral-sources.ts — rep referral-link → JobNimbus Source attribution.
 *
 * Personal/rep share links (e.g. estimate.nolandsroofing.com/greg) 307-redirect
 * to the estimator with a `utm_source` tag (next.config.ts). lib/attribution.ts
 * captures it client-side and composeSource() folds it into the lead row's
 * `source` column as "{utm_source} / {medium} / {campaign}" — e.g. Greg's link
 * produces "greg-noland / owner / personal".
 *
 * This maps the utm_source TOKEN (the part before the first " / ") to a
 * JobNimbus Source name so the lead is attributed to that rep in JN's native
 * Source reporting — instead of the generic "Voxaris Estimator" bucket.
 *
 * ── IMPORTANT ──────────────────────────────────────────────────────────────
 * Each value here must EXACTLY match a Source that exists in
 * JobNimbus → Settings → Sources, or JN rejects it. createContact /
 * createInspectionJob fall back to the default source on rejection, so a
 * missing/typo'd source never blocks a lead — it just loses the rep
 * attribution until the source is added. Add the source in JN first, then
 * map it here.
 *
 * To add a rep:
 *   1. next.config.ts — clone the /greg redirect with the rep's utm_source.
 *   2. JobNimbus Settings → Sources — add the rep's Source (exact string).
 *   3. Add one line below: "<utm_source>": "<exact JN Source string>".
 */

const REFERRAL_SOURCE_BY_UTM: Record<string, string> = {
  // estimate.nolandsroofing.com/greg → utm_source=greg-noland
  "greg-noland": "Voxaris Estimator - Greg Noland",
};

/**
 * Resolve a JobNimbus Source name from a composed lead `source` string.
 * Returns null when the lead did not arrive via a known rep referral link
 * (caller then uses the default source).
 */
export function resolveReferralSource(
  leadSource: string | null | undefined,
): string | null {
  if (!leadSource) return null;
  const token = leadSource.split("/")[0].trim().toLowerCase();
  return REFERRAL_SOURCE_BY_UTM[token] ?? null;
}

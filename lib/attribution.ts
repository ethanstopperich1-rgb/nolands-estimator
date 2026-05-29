/**
 * lib/attribution.ts — UTM / referrer source attribution.
 *
 * The estimator captures the landing-URL marketing attribution on the
 * client (utm_*, gclid, fbclid, referrer, landing_path) and POSTs it in
 * an `attribution` object on both /api/leads and /api/leads/quick-capture.
 * This module turns that client-supplied object into a single short,
 * human-readable string we store in the existing `leads.source` TEXT
 * column AND surface in the Slack "new lead" ping — so the team can see
 * "google / cpc / spring-roof" instead of a flat "estimator" the moment a
 * homeowner first hits the form.
 *
 * ── No migration ─────────────────────────────────────────────────────
 * Deliberately writes ONLY to the existing `source` text column. There
 * are no utm_* columns and we add none — this ships without a Supabase
 * apply step. Raw object storage is out of scope for v1.
 *
 * ── Security posture ─────────────────────────────────────────────────
 * `attribution` is fully client-supplied (anyone can POST anything), so
 * parseAttribution() is defensive: it allow-lists known keys, drops
 * everything else, caps each field's length, coerces non-strings away,
 * and NEVER throws (returns an empty object on null / garbage input).
 * The composed source string is also length-capped so it can't bloat the
 * row or the Slack payload.
 */

/** Per-field length cap on incoming attribution values. Real UTM values
 *  are short; anything longer is log/row bloat or an injection attempt. */
const FIELD_MAX_LEN = 200;
/** Cap on the composed source string written to leads.source + Slack. */
const SOURCE_MAX_LEN = 80;

/** The only attribution keys we accept. Unknown keys are dropped. */
const ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "fbclid",
  "referrer",
  "landing_path",
] as const;

export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];

export type Attribution = Partial<Record<AttributionKey, string>>;

/** Collapse internal whitespace + trim. Keeps the value single-line so
 *  it can't break the Slack mrkdwn line or the log JSON. */
function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Validate + sanitize a client-supplied attribution object.
 *
 * - Returns `{}` for null / non-object / array / garbage (never throws).
 * - Keeps only the allow-listed keys.
 * - Coerces values to string, drops non-strings, trims, caps length.
 * - Drops empty values so callers can use plain `?.` checks.
 */
export function parseAttribution(raw: unknown): Attribution {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const input = raw as Record<string, unknown>;
  const out: Attribution = {};
  for (const key of ATTRIBUTION_KEYS) {
    const v = input[key];
    if (typeof v !== "string") continue;
    const cleaned = tidy(v).slice(0, FIELD_MAX_LEN);
    if (cleaned.length > 0) out[key] = cleaned;
  }
  return out;
}

/** Extract a bare hostname from a referrer string. Returns null when the
 *  value isn't a parseable URL (e.g. already a bare host, or junk). */
function referrerHost(referrer: string | undefined): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The site's own host(s) — a referral FROM our own domain is not a real
 *  external referral (it's same-site navigation), so we fall through to
 *  the fallback rather than labelling it "referral: estimate.nolands...". */
const OWN_HOSTS = new Set([
  "estimate.nolandsroofing.com",
  "nolandsroofing.com",
  "www.nolandsroofing.com",
  "nolands-estimator.vercel.app",
  "demo.voxaris.io",
  "pitch.voxaris.io",
  "localhost",
]);

function isOwnHost(host: string): boolean {
  if (OWN_HOSTS.has(host)) return true;
  // Treat any *.nolandsroofing.com subdomain as own-site too.
  return host.endsWith(".nolandsroofing.com");
}

/**
 * Compose a short, human-readable source label from parsed attribution.
 *
 * Precedence (first match wins):
 *   1. utm_source present → "{source} / {medium||-} / {campaign||-}"
 *   2. gclid present      → "google ads"
 *   3. fbclid present     → "facebook ads"
 *   4. external referrer  → "referral: {host}"
 *   5. fallback           → the passed fallback (e.g. body.source) or "direct"
 *
 * Always capped at SOURCE_MAX_LEN chars.
 */
export function composeSource(
  attribution: Attribution,
  fallback?: string | null,
): string {
  const cap = (s: string): string => s.slice(0, SOURCE_MAX_LEN).trim();

  if (attribution.utm_source) {
    const medium = attribution.utm_medium || "-";
    const campaign = attribution.utm_campaign || "-";
    return cap(`${attribution.utm_source} / ${medium} / ${campaign}`);
  }
  if (attribution.gclid) return "google ads";
  if (attribution.fbclid) return "facebook ads";

  const host = referrerHost(attribution.referrer);
  if (host && !isOwnHost(host)) {
    return cap(`referral: ${host}`);
  }

  const fb = typeof fallback === "string" ? tidy(fallback) : "";
  return cap(fb.length > 0 ? fb : "direct");
}

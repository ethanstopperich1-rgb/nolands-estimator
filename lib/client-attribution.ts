/**
 * lib/client-attribution.ts — browser-side landing-URL attribution capture.
 *
 * Reads the marketing attribution off the FIRST landing URL (utm_* params,
 * gclid, fbclid) plus document.referrer + the landing path, and persists it
 * in sessionStorage so it survives the multi-step estimator wizard AND a
 * later quick-capture in the same session. Both /api/leads and
 * /api/leads/quick-capture POST bodies include the result as an
 * `attribution` object; the server folds it into the `source` column via
 * lib/attribution.ts.
 *
 * Client-only: every export guards `typeof window` so importing this into a
 * "use client" component is safe even if a code path runs during SSR — it
 * just returns an empty object.
 *
 * Sanitize at the source too (the server re-sanitizes defensively): plain
 * text only, capped length, allow-listed keys.
 */

const STORAGE_KEY = "vx_attribution";
/** Per-field cap. Mirrors the server-side FIELD_MAX_LEN in lib/attribution.ts. */
const FIELD_MAX_LEN = 200;
/** landing_path can legitimately be longer (full pathname + query). */
const PATH_MAX_LEN = 500;

const PARAM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "fbclid",
] as const;

export type ClientAttribution = Record<string, string>;

/** Plain-text only + length cap. Strips ASCII control chars (so a crafted
 *  value can't inject newlines/escapes into the persisted JSON or the
 *  composed source string), collapses whitespace runs, then caps length. */
function clean(value: string, max: number): string {
  // Drop ASCII control chars (codepoint < 32 or 127) so a crafted value
  // can't inject newlines/escapes into the persisted JSON or the composed
  // source string; then collapse whitespace runs and cap length.
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Build the attribution object from the current window location + referrer. */
function captureFromWindow(): ClientAttribution {
  const out: ClientAttribution = {};
  try {
    const params = new URLSearchParams(window.location.search);
    for (const key of PARAM_KEYS) {
      const raw = params.get(key);
      if (raw) {
        const v = clean(raw, FIELD_MAX_LEN);
        if (v) out[key] = v;
      }
    }
    const referrer = clean(document.referrer ?? "", FIELD_MAX_LEN);
    if (referrer) out.referrer = referrer;
    const landingPath = clean(
      `${window.location.pathname}${window.location.search}`,
      PATH_MAX_LEN,
    );
    if (landingPath) out.landing_path = landingPath;
  } catch {
    /* Any window/URL access failure -> empty attribution. Never throws. */
  }
  return out;
}

/**
 * Return the session's captured attribution, initializing it from the
 * current landing URL on first call and persisting to sessionStorage so it
 * survives the multi-step wizard and a later quick-capture in the same tab.
 *
 * Returns `{}` during SSR (no window) — callers spread it into the POST body
 * unconditionally, so an empty object simply sends no attribution.
 */
export function getAttribution(): ClientAttribution {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as ClientAttribution;
      }
    }
  } catch {
    /* sessionStorage blocked (private mode) / bad JSON -> fall through to a
       fresh capture; we just won't persist it. */
  }
  const captured = captureFromWindow();
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(captured));
  } catch {
    /* Persistence is best-effort. */
  }
  return captured;
}

/**
 * Eagerly capture + persist attribution. Call once on mount (inside a
 * `useEffect`) so the FIRST landing URL is recorded before any client-side
 * navigation rewrites the query string. Idempotent — if already stored, it
 * keeps the existing (earliest) capture.
 */
export function initAttribution(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.sessionStorage.getItem(STORAGE_KEY) != null) return;
  } catch {
    /* If we can't read storage we also can't persist — just capture for
       this call's getAttribution() consumers. */
  }
  getAttribution();
}

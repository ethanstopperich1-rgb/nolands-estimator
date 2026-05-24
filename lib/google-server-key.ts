/**
 * Resolve the Google API key used for server-side calls (Places, Solar,
 * Static Maps). Centralized so we have one place to enforce the
 * "don't fall back to NEXT_PUBLIC_ in production" rule.
 *
 * Why this matters: NEXT_PUBLIC_GOOGLE_MAPS_KEY is embedded in the
 * browser JS bundle by Next.js. It MUST be IP-allowlisted or HTTP-
 * referrer-restricted on the Google Cloud Console to be safe in the
 * client. Using that key for server-side Solar API calls — which are
 * billed per request and are not in the client-side allowlist — gives
 * any attacker who lifts the key from the bundle a path to burn our
 * billing on a different API surface.
 *
 * GOOGLE_SERVER_KEY is a separate key with its own restrictions
 * (server-IP-allowlist on the Vercel function IPs) and is the only
 * key that should sign server-to-server Google API calls.
 *
 * Behavior:
 *   - prod: require GOOGLE_SERVER_KEY. Return null if missing — callers
 *     should return 503 so a misconfigured deploy can't silently fall
 *     through to the browser key.
 *   - dev/preview: fall back to NEXT_PUBLIC_GOOGLE_MAPS_KEY for ease
 *     of localhost iteration. The risk is fenced to non-prod.
 */

export function getGoogleServerKey(): string | null {
  const server = process.env.GOOGLE_SERVER_KEY;
  if (server) return server;
  if (process.env.NODE_ENV !== "production") {
    return process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? null;
  }
  return null;
}

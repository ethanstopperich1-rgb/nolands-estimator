/**
 * Staff route gating — shared by middleware.ts and unit tests.
 */

export const PROTECTED_API_PREFIXES = [
  "/api/photos",
  "/api/voice-note",
  "/api/supplement",
  "/api/insights",
  "/api/vision",
  "/api/verify-polygon",
  "/api/estimates",
  "/api/aerial",
] as const;

export const PROTECTED_PAGE_PATHS = new Set<string>();

export const PROTECTED_PAGE_PREFIXES = ["/dashboard", "/internal"] as const;

/** Customer-facing sub-routes under /api/leads/<publicId>/ */
export const PUBLIC_LEAD_SUBROUTES = new Set<string>(["voice-consent"]);

export function isProtected(pathname: string, method: string): boolean {
  if (pathname === "/api/proposals" && method === "POST") return true;

  const leadSubMatch = pathname.match(/^\/api\/leads\/[^/]+\/([^/?#]+)/);
  if (leadSubMatch && !PUBLIC_LEAD_SUBROUTES.has(leadSubMatch[1])) {
    return true;
  }

  if (PROTECTED_PAGE_PATHS.has(pathname)) return true;

  for (const prefix of PROTECTED_PAGE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return true;
  }

  for (const prefix of PROTECTED_API_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return true;
  }

  return false;
}

export function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

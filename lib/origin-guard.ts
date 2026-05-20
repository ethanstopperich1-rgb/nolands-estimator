/**
 * Origin / Referer allowlist for expensive public API routes.
 *
 * Why: even with BotID + rate limiting, an attacker can hot-link our
 * Gemini / Places endpoints from their own site and burn billing. A
 * cheap first-line check on `Origin` (or `Referer` when Origin is
 * absent — Safari sometimes strips it on same-origin GETs) blocks the
 * obvious abuse vector without paying for a Redis round-trip.
 *
 * Allowlist sources, in order:
 *   1. Same-origin (Origin host === request host) — always allowed
 *   2. `ALLOWED_ORIGINS` env var (comma-separated hostnames or full URLs)
 *   3. *.vercel.app preview deployments — allowed in non-prod NODE_ENV
 *      so PR previews + branch deploys keep working
 *
 * Fails OPEN in development (NODE_ENV !== 'production') so localhost
 * curl still works. Fails CLOSED in production with a 403 when the
 * origin doesn't match.
 */

import { NextResponse } from "next/server";

function parseHost(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    // Bare hostname like "voxaris.io" (env var form).
    return value.trim().toLowerCase() || null;
  }
}

function allowedHosts(): Set<string> {
  const raw = process.env.ALLOWED_ORIGINS ?? "";
  const hosts = new Set<string>();
  for (const piece of raw.split(",")) {
    const h = parseHost(piece);
    if (h) hosts.add(h);
  }
  // Belt + suspenders: hard-code the production hosts so a missing env
  // var doesn't accidentally close the door on real customer traffic.
  hosts.add("voxaris.io");
  hosts.add("www.voxaris.io");
  hosts.add("pitch.voxaris.io");
  return hosts;
}

/**
 * Returns `null` to allow the request, or a 403 NextResponse to block.
 * Same call shape as `rateLimit(req)` — meant to be the first guard in
 * a handler:
 *
 *   const blocked = checkOrigin(req);
 *   if (blocked) return blocked;
 */
export function checkOrigin(req: Request): NextResponse | null {
  if (process.env.NODE_ENV !== "production") return null;

  const origin = parseHost(req.headers.get("origin"));
  const referer = parseHost(req.headers.get("referer"));
  const requestHost = (() => {
    try {
      return new URL(req.url).host.toLowerCase();
    } catch {
      return null;
    }
  })();

  const candidate = origin ?? referer;

  // No origin / referer at all = direct script call (curl, server-to-
  // server, headless scraper). Reject.
  if (!candidate) {
    return NextResponse.json(
      { error: "Origin header required" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Same-origin: always OK. Covers production AND every Vercel
  // preview / branch URL without us having to enumerate them.
  if (requestHost && candidate === requestHost) return null;

  // Explicit allowlist (env-configurable + hard-coded prod hosts).
  if (allowedHosts().has(candidate)) return null;

  // Vercel preview / branch deploys served from *.vercel.app.
  if (candidate.endsWith(".vercel.app")) return null;

  return NextResponse.json(
    { error: "Origin not allowed" },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

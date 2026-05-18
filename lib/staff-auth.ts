/**
 * Lightweight "is this request from a staff session?" check.
 *
 * Mirrors the cookie + Basic auth checks middleware.ts performs, but
 * usable from inside route handlers when we need to gate a specific
 * code path (e.g. ?debug=1 on /api/gemini-roof) without redirecting
 * the entire route through middleware.
 *
 * Returns true on ANY of:
 *  - `voxaris-staff` cookie matches STAFF_AUTH_USER:STAFF_AUTH_PASS
 *  - `Authorization: Basic …` header matches STAFF_AUTH_USER:PASS
 *  - A Supabase Auth cookie is present (`sb-*-auth-token`)
 *
 * The Supabase-cookie check is presence-only, matching the same
 * trade-off middleware.ts makes — server components downstream will
 * still validate the JWT before reading actual data.
 *
 * Fails CLOSED: any decode error / missing env returns false.
 */

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function decodeBasic(raw: string): { user: string; pass: string } | null {
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function hasSupabaseSessionCookie(req: Request): boolean {
  const header = req.headers.get("cookie");
  if (!header) return false;
  // sb-<project_ref>-auth-token — presence only (not JWT-validated;
  // downstream supabase.auth.getUser() catches expired sessions).
  return /(?:^|;\s*)sb-[^=]*-auth-token=/.test(header);
}

export function isStaffRequest(req: Request): boolean {
  const user = process.env.STAFF_AUTH_USER;
  const pass = process.env.STAFF_AUTH_PASS;

  // Cookie path — primary signal from /api/auth/staff-login.
  if (user && pass) {
    const cookieVal = getCookie(req, "voxaris-staff");
    if (cookieVal) {
      const creds = decodeBasic(cookieVal);
      if (
        creds &&
        constantTimeEq(creds.user, user) &&
        constantTimeEq(creds.pass, pass)
      ) {
        return true;
      }
    }

    // HTTP Basic header — script / curl callers.
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Basic ")) {
      const creds = decodeBasic(auth.slice(6).trim());
      if (
        creds &&
        constantTimeEq(creds.user, user) &&
        constantTimeEq(creds.pass, pass)
      ) {
        return true;
      }
    }
  }

  // Supabase Auth — once magic-link rollout lands, this becomes the
  // primary signal. Presence-only by design (see header comment).
  if (hasSupabaseSessionCookie(req)) return true;

  return false;
}

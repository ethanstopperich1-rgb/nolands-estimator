/**
 * GET /api/oauth/podium/start — kicks off the Podium 3-legged OAuth.
 *
 * What this does:
 *   Generates a CSRF state value, stashes it in a short-lived HttpOnly
 *   cookie, then 302-redirects the operator to Podium's authorize page
 *   with the correct client_id + scopes + redirect_uri. Podium prompts
 *   the operator to log in (as a Noland's Podium admin), they approve
 *   the app, Podium 302s back to /api/oauth/podium/callback with a
 *   ?code=... query param.
 *
 * This route is operator-only — there's no homeowner-facing surface
 * for it. The middleware doesn't gate /api/oauth/* today, so anyone
 * who knows the URL can hit it, but that's fine: clicking it just
 * starts the OAuth flow which still requires authenticating as a
 * Noland's Podium admin on Podium's side. No homeowner gets through
 * by accident.
 *
 * Setup pre-reqs (already done):
 *   ✅ PODIUM_CLIENT_ID    — env var, set 2026-05-26
 *   ✅ PODIUM_CLIENT_SECRET — env var (sensitive)
 *   ✅ Redirect URL in Podium app: /api/oauth/podium/callback
 *
 * One-shot use only. Once we've captured an access token + refresh
 * token, this route doesn't need to run again until the refresh
 * token expires (Podium default: ~6 months).
 */
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Scopes selected when the OAuth app was created. Order is significant
// to Podium's consent screen (it shows them in the same order). Match
// the app config exactly — otherwise Podium rejects with
// "invalid_scope".
const SCOPES = [
  "write_messages",
  "write_contacts",
  "read_locations",
  "read_contacts",
  "read_messages",
];

// Podium's OAuth endpoint per docs.podium.com/reference/oauth.
// NOTE: not under /v4 — OAuth lives at the root of api.podium.com.
// First attempt used /v4/oauth/authorize and got route_not_found.
const AUTHORIZE_URL = "https://api.podium.com/oauth/authorize";

export async function GET(req: Request): Promise<Response> {
  const clientId = process.env.PODIUM_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "PODIUM_CLIENT_ID not configured in Vercel env" },
      { status: 503 },
    );
  }

  // CSRF state — random 32 bytes hex, stashed in an HttpOnly cookie
  // that the callback route validates against the returned ?state=.
  const state = randomBytes(32).toString("hex");

  const origin = new URL(req.url).origin;
  // The redirect_uri MUST exactly match one registered on the Podium OAuth
  // app, or Podium rejects with "redirect_uri mismatch". Deriving it from
  // the request origin breaks when /start is hit on a domain (e.g. the
  // custom domain) that differs from what was registered at setup (e.g. a
  // *.vercel.app URL). PODIUM_REDIRECT_URI pins it to the registered value
  // regardless of which domain starts the flow; the callback reads the same
  // env so the token exchange stays consistent.
  const redirectUri =
    process.env.PODIUM_REDIRECT_URI ?? `${origin}/api/oauth/podium/callback`;

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);

  const res = NextResponse.redirect(url.toString(), 302);
  // 10-minute window for the operator to complete consent on Podium's
  // side. After that the cookie expires and the callback rejects the
  // state mismatch.
  res.cookies.set("podium_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}

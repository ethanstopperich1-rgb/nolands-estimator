import { NextResponse, type NextRequest } from "next/server";
import { isApiPath, isProtected } from "@/lib/protected-routes";

/**
 * Staff auth middleware — HTTP Basic gate on rep-facing routes.
 *
 * Why HTTP Basic and not NextAuth / Clerk:
 *   - The internal app has ~18 staff users across PE-backed offices.
 *     A shared staff password set in env vars covers that user count
 *     fine, and HTTP Basic is supported by every browser without any
 *     client-side library. Total auth code: 60 lines + 2 env vars.
 *   - Avoids the larger NextAuth wiring (DB, session, callbacks)
 *     while we're still iterating on the product.
 *   - Easy to swap for NextAuth / Clerk / Vercel Sign-In later — the
 *     middleware is the only file that needs replacement.
 *
 * Env vars (set in Vercel):
 *   STAFF_AUTH_USER       — required in prod
 *   STAFF_AUTH_PASS       — required in prod
 *
 * In production WITHOUT these env vars set, ALL protected routes
 * return 503 (fail-closed). In dev they pass through to keep local
 * iteration friction-free. The fail-closed behavior in prod was a
 * direct response to a code review flagging that `lib/ratelimit.ts`
 * failed-open without Redis — we don't want auth to repeat that
 * mistake.
 *
 * Public surfaces NOT protected (customer-facing, intentional):
 *   /                       customer V3 holy-grail estimator
 *   /embed                  iframe embed for partner sites
 *   /api/leads              lead capture (BotID-guarded)
 *   /api/sms/*              Twilio webhooks (HMAC-validated)
 *   /api/places/*           address autocomplete (used by /)
 *   /api/gemini-roof        V3 truth pipeline (used by / + /dashboard/estimate)
 *   /api/solar              auxiliary Solar lookups (used by /)
 *   /api/building           OSM building lookup
 *   /api/storms             storm history
 *   /api/hail-mrms          radar hail
 *   /api/weather            weather context
 *
 * Protected surfaces (staff-only, gated below):
 *   /dashboard/*            internal dashboard (Supabase-gated)
 *   /api/photos             rep photo uploads (Vercel Blob)
 *   /api/voice-note         rep dictation (Whisper)
 *   /api/supplement         PDF parse (rep tool)
 *   /api/insights           rep insights panel
 *   /api/vision             Claude vision (rep tool)
 *   /api/verify-polygon     Claude vision QA (rep tool)
 *   /api/verify-polygon-multiview  same
 *   /api/estimates          rep estimate persistence (stub)
 *   /api/aerial             unused; gated until a call site exists
 *   /api/leads/<id>/*       rep tools (V3 regen, etc). The
 *                           "voice-consent" sub-route is exempt — see
 *                           PUBLIC_LEAD_SUBROUTES below.
 */

/**
 * INTENTIONALLY PUBLIC (do NOT add these to PROTECTED_* in lib/protected-routes.ts):
 *
 *   /, /embed                  customer-facing surfaces
 *   /login, /auth/*            sign-in flow
 *   /privacy, /terms           legal pages (TCPA + state-law compliance)
 *   /api/leads, /api/sms/*     public ingest endpoints (BotID / Twilio HMAC)
 *   /api/places/*              address autocomplete
 *   /api/gemini-roof           V3 truth pipeline
 *   /api/solar, /api/building, /api/storms, /api/hail-mrms, /api/weather
 *   /api/office/branding       office display + TCPA copy for customer UI
 *
 * Anything new and rep-only goes in PROTECTED_API_PREFIXES (lib/protected-routes.ts).
 */

function unauthorizedResponse(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Voxaris Staff", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Pages get a redirect to the styled /login page instead of a 401
 * Basic Auth challenge — that's what surfaces the browser's native
 * (and ugly) "Sign in" dialog. APIs still get the 401 + WWW-
 * Authenticate header so scripts / curl callers keep working.
 *
 * `next` carries the original path so post-login lands the user
 * exactly where they tried to go.
 */
function redirectToLogin(req: NextRequest): NextResponse {
  const dest = new URL("/login", req.url);
  const fullPath = req.nextUrl.pathname + req.nextUrl.search;
  // Don't bounce back to /login (creates a redirect loop) and don't
  // round-trip the root — the marketing redirect already handles that.
  if (fullPath !== "/" && !fullPath.startsWith("/login")) {
    dest.searchParams.set("next", fullPath);
  }
  return NextResponse.redirect(dest, 307);
}

/**
 * Decode and validate the `voxaris-staff` cookie (base64-encoded
 * `user:pass`, same shape as an HTTP Basic header so one decode path
 * covers both transports). Returns true on a constant-time match
 * against STAFF_AUTH_USER / STAFF_AUTH_PASS.
 */
function hasStaffCookie(req: NextRequest, user: string, pass: string): boolean {
  const raw = req.cookies.get("voxaris-staff")?.value;
  if (!raw) return false;
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const u = decoded.slice(0, idx);
  const p = decoded.slice(idx + 1);
  if (u.length !== user.length || p.length !== pass.length) return false;
  let mismatch = 0;
  for (let i = 0; i < u.length; i++) {
    mismatch |= u.charCodeAt(i) ^ user.charCodeAt(i);
  }
  for (let i = 0; i < p.length; i++) {
    mismatch |= p.charCodeAt(i) ^ pass.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Detect a valid Supabase Auth session by sniffing the cookies. The
 * actual cookie name is `sb-<project_ref>-auth-token` — we match the
 * pattern rather than the literal so the middleware doesn't need to
 * know the project ref. A cookie alone doesn't prove the session is
 * still VALID (the JWT inside could be expired), but it's a strong
 * enough signal at the middleware layer; downstream Server Components
 * still verify via supabase.auth.getUser() before reading data.
 *
 * This is a deliberate trade-off: the alternative (calling getUser()
 * inside middleware) would add a network round-trip + a Supabase API
 * call to every protected request — too expensive. We accept that an
 * expired cookie temporarily slips past the middleware gate; the
 * Server Component fallback catches it within a single request.
 */
function hasSupabaseSession(req: NextRequest): boolean {
  for (const c of req.cookies.getAll()) {
    if (c.name.startsWith("sb-") && c.name.endsWith("-auth-token")) {
      return true;
    }
  }
  return false;
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // Customer-proposal share links live at `/p/<random-id>`. The page-
  // level metadata already sets `robots: { index: false }` for Google /
  // Googlebot, but other crawlers (Bing, Yandex, ChatGPT, etc.) respect
  // the `X-Robots-Tag` HTTP header more consistently than HTML meta.
  // Belt + suspenders for the customer-PII-on-share-link surface.
  if (pathname.startsWith("/p/")) {
    const res = NextResponse.next();
    res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    return res;
  }

  // Public demo surface — pitch.voxaris.io/demo lets prospects play
  // with the dashboard without auth. Internally rewrite to /dashboard
  // so the same Server Components render, then set the demo header
  // so lib/dashboard.ts forces the demo-data fallback (never touches
  // real Supabase rows even when SUPABASE_* env vars are set in prod).
  //
  // URL stays /demo in the browser — DashboardChrome reads
  // usePathname() to detect the prefix and rewrites its nav links.
  if (pathname === "/demo" || pathname.startsWith("/demo/")) {
    const target = pathname === "/demo" ? "/dashboard" : "/dashboard" + pathname.slice(5);
    const url = req.nextUrl.clone();
    url.pathname = target;
    const reqHeaders = new Headers(req.headers);
    reqHeaders.set("x-voxaris-demo", "1");
    const res = NextResponse.rewrite(url, { request: { headers: reqHeaders } });
    // Don't let search engines index the demo or its rewritten target.
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    return res;
  }

  // `/` is the customer-facing root (V3 holy-grail flow). No auth, no
  // redirect — it renders the Patek-style estimator directly. Internal
  // staff use /dashboard/* (Supabase-gated) for their tools.

  if (!isProtected(pathname, req.method)) {
    return NextResponse.next();
  }

  // Supabase session — preferred path once auth migration is rolled
  // out. When the user has a valid session cookie, skip the staff
  // password check entirely.
  if (hasSupabaseSession(req)) {
    return NextResponse.next();
  }

  const user = process.env.STAFF_AUTH_USER;
  const pass = process.env.STAFF_AUTH_PASS;

  // Fail-closed in production when auth env vars are missing — this
  // mirrors what we'd want for a defense-in-depth posture. Dev passes
  // through so localhost work doesn't require setting env vars.
  if (!user || !pass) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse(
        "Service unavailable: staff authentication is not configured.",
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.next();
  }

  // Cookie path — set by /api/auth/staff-login when the user submits
  // the styled /login form. This is the primary signal for browsers.
  if (hasStaffCookie(req, user, pass)) {
    return NextResponse.next();
  }

  // Authorization header path — preserved for scripts / curl callers
  // that prefer HTTP Basic. Any time the browser delivers a request
  // WITHOUT a cookie and WITHOUT a header, we route it to the styled
  // /login page instead of returning a 401-Basic challenge that the
  // browser renders as its native dialog.
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Basic ")) {
    return isApiPath(pathname)
      ? unauthorizedResponse()
      : redirectToLogin(req);
  }

  let decoded: string;
  try {
    decoded = atob(auth.slice(6).trim());
  } catch {
    return isApiPath(pathname)
      ? unauthorizedResponse()
      : redirectToLogin(req);
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) {
    return isApiPath(pathname)
      ? unauthorizedResponse()
      : redirectToLogin(req);
  }
  const reqUser = decoded.slice(0, idx);
  const reqPass = decoded.slice(idx + 1);

  if (reqUser.length !== user.length || reqPass.length !== pass.length) {
    return isApiPath(pathname)
      ? unauthorizedResponse()
      : redirectToLogin(req);
  }
  let mismatch = 0;
  for (let i = 0; i < reqUser.length; i++) {
    mismatch |= reqUser.charCodeAt(i) ^ user.charCodeAt(i);
  }
  for (let i = 0; i < reqPass.length; i++) {
    mismatch |= reqPass.charCodeAt(i) ^ pass.charCodeAt(i);
  }
  if (mismatch !== 0) {
    return isApiPath(pathname)
      ? unauthorizedResponse()
      : redirectToLogin(req);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Match everything except static assets and Next.js internals. The
   * `isProtected()` helper above does the real gating. Done this way
   * (broad matcher + in-function filter) because Next.js matchers
   * don't support arbitrary regex composition cleanly across many
   * prefixes, and the alternative — listing every protected path in
   * the matcher — duplicates the same data twice and goes stale.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon|apple-icon|icon\\.|opengraph-image|twitter-image|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|woff|woff2|map)).*)",
  ],
};

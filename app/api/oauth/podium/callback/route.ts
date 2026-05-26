/**
 * GET /api/oauth/podium/callback — completes the Podium OAuth handshake.
 *
 * Podium redirects here after the operator approves the app on Podium's
 * consent screen. The URL carries:
 *   ?code=<authorization-code>&state=<csrf-state>
 *
 * Our job:
 *   1. Verify the state matches the cookie set by /api/oauth/podium/start
 *      (CSRF protection — without this, an attacker could craft a
 *      redirect that grants their app access to Noland's Podium).
 *   2. Exchange the auth code for an access_token + refresh_token via
 *      Podium's /v4/oauth/token endpoint.
 *   3. Display the tokens to the operator in an HTML page (one-shot
 *      view, includes copy buttons). They paste the tokens back to me
 *      and I set them as Vercel env vars + run a Locations probe to
 *      find Noland's location UID.
 *
 * Why no automatic env-var persistence:
 *   Vercel's CLI is the canonical way to set production env vars, and
 *   automating it from inside a function would require a Vercel API
 *   token stored in the same env (chicken-and-egg). The one-shot HTML
 *   display is the smallest reliable surface for a one-time setup
 *   that the operator-plus-Claude pair completes together.
 *
 * After the tokens are saved as env vars, this route is dormant — it
 * only fires again when we re-run /api/oauth/podium/start (e.g. when
 * the refresh token expires in ~6 months).
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// NOTE: not under /v4 — OAuth lives at the root of api.podium.com.
const TOKEN_URL = "https://api.podium.com/oauth/token";

interface PodiumTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return errorPage(
      "Podium returned an error",
      `${error}: ${url.searchParams.get("error_description") ?? "(no description)"}`,
    );
  }
  if (!code || !state) {
    return errorPage(
      "Missing code or state in callback",
      "Hit /api/oauth/podium/start first to begin a fresh flow.",
    );
  }

  // ─── CSRF check ────────────────────────────────────────────────────
  const cookieState = (req as unknown as { cookies: { get: (n: string) => { value: string } | undefined } }).cookies.get("podium_oauth_state")?.value;
  if (!cookieState || cookieState !== state) {
    return errorPage(
      "State mismatch",
      "The CSRF token in the URL doesn't match the cookie. This means either the cookie expired (>10 min between /start and /callback) or someone tampered with the redirect. Start over at /api/oauth/podium/start.",
    );
  }

  // ─── Exchange code for tokens ──────────────────────────────────────
  const clientId = process.env.PODIUM_CLIENT_ID;
  const clientSecret = process.env.PODIUM_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return errorPage(
      "Podium credentials missing",
      "PODIUM_CLIENT_ID or PODIUM_CLIENT_SECRET is unset in Vercel env. This route can't exchange the code without them.",
    );
  }
  const redirectUri = `${url.origin}/api/oauth/podium/callback`;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  let tokens: PodiumTokenResponse;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!res.ok) {
      console.error("[podium oauth] token exchange failed", {
        status: res.status,
        body,
      });
      return errorPage(
        `Token exchange failed (${res.status})`,
        JSON.stringify(body, null, 2),
      );
    }
    tokens = body as unknown as PodiumTokenResponse;
  } catch (err) {
    console.error("[podium oauth] fetch threw", err);
    return errorPage(
      "Network error reaching Podium token endpoint",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ─── Display tokens to operator ────────────────────────────────────
  // Browser copy of a 1.7kb JWT often gets mangled (zero-vs-O, l-vs-1
  // ambiguity in some fonts). Log the FULL tokens to Vercel function
  // logs as the canonical capture path — `vercel logs` returns them
  // byte-exact and Claude reads them from CLI. The HTML page is the
  // backup display.
  //
  // Security: Vercel function logs are visible only to the project
  // team. Anyone with `vercel logs` access for nolands-estimator can
  // see these. We rotate the refresh token after first use anyway.
  console.log(
    "[podium oauth] FULL_ACCESS_TOKEN_START===" +
      tokens.access_token +
      "===FULL_ACCESS_TOKEN_END",
  );
  console.log(
    "[podium oauth] FULL_REFRESH_TOKEN_START===" +
      tokens.refresh_token +
      "===FULL_REFRESH_TOKEN_END",
  );
  console.log(
    "[podium oauth] handshake complete",
    {
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      token_type: tokens.token_type,
    },
  );

  const html = renderTokenPage(tokens);
  const res = new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  res.cookies.delete("podium_oauth_state");
  return res;
}

function errorPage(title: string, detail: string): Response {
  const html = `<!doctype html><meta charset=utf-8><title>Podium OAuth — ${escapeHtml(title)}</title>
<style>body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0a0a0a;color:#e8e8e8;padding:48px;max-width:780px;margin:0 auto}
h1{color:#ff6b6b;font-size:18px;margin:0 0 16px}pre{background:#1a1a1a;padding:16px;border-radius:8px;white-space:pre-wrap;word-break:break-all;border:1px solid #2a2a2a}</style>
<h1>❌ ${escapeHtml(title)}</h1><pre>${escapeHtml(detail)}</pre><p>Start over: <a href="/api/oauth/podium/start" style="color:#7cdcfe">/api/oauth/podium/start</a></p>`;
  return new NextResponse(html, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderTokenPage(t: PodiumTokenResponse): string {
  return `<!doctype html><meta charset=utf-8><title>Podium OAuth — Success</title>
<style>
  body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0a0a0a;color:#e8e8e8;padding:48px;max-width:920px;margin:0 auto}
  h1{color:#86efac;font-size:22px;margin:0 0 8px}
  h2{color:#ffaa44;font-size:14px;margin:24px 0 8px}
  .field{background:#1a1a1a;padding:16px;border-radius:8px;border:1px solid #2a2a2a;margin-bottom:8px}
  .label{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px}
  .value{word-break:break-all;font-size:13px;color:#e8e8e8}
  .copy{margin-left:12px;cursor:pointer;background:#2a2a2a;color:#e8e8e8;border:0;padding:4px 10px;border-radius:4px;font-size:11px}
  .copy:hover{background:#3a3a3a}
  .warn{background:#3a2a00;border-left:3px solid #ffaa44;padding:14px;border-radius:4px;margin:24px 0;color:#ffd88c}
  .next{background:#1a3a1a;border-left:3px solid #86efac;padding:14px;border-radius:4px;margin:24px 0;color:#bdf3bd}
</style>
<h1>✅ Podium OAuth — Token Captured</h1>
<p>Copy the two tokens below into the chat with Claude. Claude will set them as Vercel env vars + complete the integration.</p>

<div class="warn"><b>⚠️ This page shows the tokens ONCE.</b> If you refresh or navigate away, you lose them and have to redo the OAuth flow at <a href="/api/oauth/podium/start" style="color:#ffd88c">/api/oauth/podium/start</a>.</div>

<h2>PODIUM_ACCESS_TOKEN</h2>
<div class="field"><div class="label">Set this as the Vercel env var named PODIUM_ACCESS_TOKEN <button class="copy" onclick="navigator.clipboard.writeText(document.getElementById('at').textContent);this.textContent='copied!'">copy</button></div><div class="value" id="at">${escapeHtml(t.access_token)}</div></div>

<h2>PODIUM_REFRESH_TOKEN</h2>
<div class="field"><div class="label">Save this for when the access token expires <button class="copy" onclick="navigator.clipboard.writeText(document.getElementById('rt').textContent);this.textContent='copied!'">copy</button></div><div class="value" id="rt">${escapeHtml(t.refresh_token)}</div></div>

<h2>Metadata</h2>
<div class="field"><div class="label">expires_in (seconds)</div><div class="value">${String(t.expires_in)} (${Math.round(t.expires_in / 3600)}h)</div></div>
<div class="field"><div class="label">token_type</div><div class="value">${escapeHtml(t.token_type)}</div></div>
<div class="field"><div class="label">scope</div><div class="value">${escapeHtml(t.scope)}</div></div>

<div class="next"><b>Next:</b> paste both tokens into your chat with Claude. Claude will then run <code style="background:#0a0a0a;padding:2px 6px;border-radius:3px">GET /v4/locations</code> to find Noland's Clermont location UID and set <code style="background:#0a0a0a;padding:2px 6px;border-radius:3px">PODIUM_LOCATION_UID</code>. After that the integration is live.</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

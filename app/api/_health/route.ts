/**
 * Deep health probe — verifies the env-var landscape required for each
 * downstream service is populated, without exposing any actual secret
 * values. Used after env-var changes (especially the LiveKit + Twilio
 * wiring on a new toll-free number) to confirm the production
 * deployment can dispatch real outbound calls.
 *
 * Distinct from `/api/healthz` which is the unconditional liveness
 * probe for uptime monitors. This route is the deep diagnostic.
 *
 * Auth: requires the `X-Voxaris-Health-Token` header to match
 * `INTERNAL_DISPATCH_SECRET`. We don't want a public probe leaking
 * the service inventory to attackers ("oh, they use LiveKit, Twilio,
 * Supabase, Gemini, IEM, FDOR..." is itself reconnaissance).
 *
 * Returns per-service status, never values. Each service reports:
 *   - "ok" — all required env vars present
 *   - "partial" — some present, some missing (lists which are missing)
 *   - "missing" — none configured
 *
 * Side-effect-free. No outbound network calls; just checks process.env.
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";

type ServiceStatus = "ok" | "partial" | "missing";

interface ServiceReport {
  status: ServiceStatus;
  required: string[];
  missing: string[];
  optional?: { var: string; present: boolean }[];
}

function envCheck(
  required: string[],
  optional: string[] = [],
): ServiceReport {
  const missing = required.filter((k) => !process.env[k]);
  const status: ServiceStatus =
    missing.length === 0
      ? "ok"
      : missing.length === required.length
        ? "missing"
        : "partial";
  return {
    status,
    required,
    missing,
    optional: optional.length
      ? optional.map((k) => ({ var: k, present: Boolean(process.env[k]) }))
      : undefined,
  };
}

export async function GET(req: Request): Promise<NextResponse> {
  // Auth gate — same secret as dispatch-outbound's same-origin gate.
  // If it's not configured, the route 503s so a future deploy where
  // the secret got dropped doesn't silently turn into a public
  // service-inventory leak.
  const expected = process.env.INTERNAL_DISPATCH_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "service_unavailable" },
      { status: 503 },
    );
  }
  const provided = req.headers.get("x-voxaris-health-token") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const services: Record<string, ServiceReport> = {
    // Telephony — the production-blocker stack for Sydney + outbound
    // dispatch. If any of these are "missing" or "partial", calls
    // won't fire.
    livekit: envCheck(
      ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "SIP_OUTBOUND_TRUNK_ID"],
      ["SIP_PLACED_BY_AGENT", "SIP_WAIT_UNTIL_ANSWERED"],
    ),
    twilio_creds: envCheck(
      ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
      // Optional: global fallback for rep-side new-lead SMS when the
      // office row doesn't carry an inbound_number. Used pre-launch
      // and for Voxaris-internal testing.
      ["LEAD_NOTIFY_PHONE"],
    ),
    internal_dispatch: envCheck(["INTERNAL_DISPATCH_SECRET"]),

    // AI providers — Gemini for V3 pipeline, Anthropic optional for
    // ancillary features.
    gemini: envCheck(["GEMINI_API_KEY"], ["GEMINI_MODEL", "GEMINI_OBJECTS_MODEL"]),
    google_maps: envCheck(["GOOGLE_SERVER_KEY"], ["NEXT_PUBLIC_GOOGLE_MAPS_KEY"]),

    // Storage + auth
    supabase: envCheck(
      [
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
      ],
      ["SUPABASE_DB_PASSWORD"],
    ),
    staff_auth: envCheck(["STAFF_AUTH_USER", "STAFF_AUTH_PASS"]),

    // Bot protection + rate limit
    botid: envCheck(
      ["NEXT_PUBLIC_BOTID_SITE_KEY"],
      ["NEXT_PUBLIC_RECAPTCHA_SITE_KEY"],
    ),
    upstash_kv: envCheck(
      ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
      ["RATELIMIT_FAIL_OPEN"],
    ),

    // Public data sources (no auth required; presence-of-feature
    // toggles only)
    bigquery: envCheck([], ["GCP_SERVICE_ACCOUNT_KEY"]),
  };

  const allOk = Object.values(services).every(
    (s) => s.status === "ok" || s.required.length === 0,
  );
  const someMissing = Object.values(services).some(
    (s) => s.missing.length > 0,
  );

  return NextResponse.json(
    {
      ok: allOk && !someMissing,
      ts: new Date().toISOString(),
      vercel_env: process.env.VERCEL_ENV ?? "unknown",
      services,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

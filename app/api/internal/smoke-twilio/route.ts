/**
 * POST /api/internal/smoke-twilio
 *
 * Internal smoke test for the estimate-ready MMS path. Fires a real
 * Twilio MMS through `sendEstimateReadyViaTwilio` so we can verify
 * the wire end-to-end without driving the BotID-gated public funnel.
 *
 * Gated by INTERNAL_DISPATCH_SECRET (same shared secret as
 * /api/dispatch-outbound + /api/internal/pricing-calibration). Without
 * the header, returns 401. Mirrors the auth posture of the JN
 * calibration endpoint.
 *
 * Body (POST JSON):
 *   {
 *     to:        "+14075551234",   // required, E.164
 *     painted?:  "https://...png", // optional; uses canonical test PNG when omitted
 *     name?:     "Ethan",
 *     address?:  "8450 Oak Park Ave",
 *     low?:      25000,
 *     high?:     44000,
 *   }
 *
 * Response:
 *   { ok: true, sid: "SM...", to, mediaUrl }
 *
 * NEVER call from production traffic. This is a dev/ops surface only.
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { sendEstimateReadyViaTwilio } from "@/lib/twilio";

export const runtime = "nodejs";

interface SmokeBody {
  to: string;
  painted?: string;
  name?: string;
  address?: string;
  low?: number;
  high?: number;
}

function isE164(s: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(s.trim());
}

export async function POST(req: Request): Promise<NextResponse> {
  // Auth — same INTERNAL_DISPATCH_SECRET gate as the calibration route.
  const expected = process.env.INTERNAL_DISPATCH_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "service_unavailable" },
      { status: 503 },
    );
  }
  const provided = req.headers.get("x-dispatch-secret") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Parse + validate body.
  let body: SmokeBody;
  try {
    body = (await req.json()) as SmokeBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.to || !isE164(body.to)) {
    return NextResponse.json(
      { ok: false, error: "phone_required_e164" },
      { status: 400 },
    );
  }

  // Reasonable defaults so the smoke test can be a one-line curl with
  // just the `to` field.
  const painted =
    body.painted ?? "https://nolands-estimator.vercel.app/icon.png";
  const name = body.name ?? "Smoke Test";
  const address = body.address ?? "8450 Oak Park Ave";
  const low = body.low ?? 25651;
  const high = body.high ?? 44306;
  const fakeLeadId = `lead_smoke_${Date.now().toString(16)}`;

  // Fire the REAL helper — same code path the V3 success branch calls.
  const result = await sendEstimateReadyViaTwilio({
    customerPhone: body.to,
    customerName: name,
    address,
    paintedImageUrl: painted,
    shareUrl: `https://nolands-estimator.vercel.app/r/${fakeLeadId}`,
    lowEstimate: low,
    highEstimate: high,
    leadPublicId: fakeLeadId,
  });

  if (!result.sent) {
    return NextResponse.json(
      {
        ok: false,
        reason: result.reason,
        error: result.error,
        helper: "sendEstimateReadyViaTwilio",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    sid: result.sid,
    to: body.to,
    mediaUrl: painted,
    helper: "sendEstimateReadyViaTwilio",
  });
}

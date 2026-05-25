import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { checkPayloadSize, PAYLOAD_LIMITS } from "@/lib/payload-guard";
import {
  sendPostCallNotifications,
  VALID_POSTCALL_OUTCOMES,
  type PostCallOutcome,
} from "@/lib/post-call-notifications";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/sms/post-call
 *
 * Manual / testing webhook to fire the post-call notification chain
 * for a given lead. Sarah's worker does NOT call this directly —
 * her shutdown handler POSTs to /api/agent/events (call_ended), which
 * then fans out to lib/post-call-notifications.ts. This endpoint is
 * kept for:
 *
 *   - Manual smoke tests (curl with INTERNAL_DISPATCH_SECRET)
 *   - Future provider integrations (e.g. a webhook from an external
 *     CRM that wants to re-fire the SMS chain)
 *   - Debugging post-call SMS delivery without re-running a real call
 *
 * Auth: shared INTERNAL_DISPATCH_SECRET via x-dispatch-secret header.
 *
 * Payload (JSON):
 *   {
 *     "leadPublicId": "lead_<32-hex>",       // required
 *     "outcome": "appt_scheduled" |          // optional, defaults to
 *                "callback_requested" |      //   "appt_scheduled" so
 *                "no_appointment" |          //   the test flow has a
 *                "voicemail" | "failed",     //   sensible default
 *     "summary": "Booked Tue 2pm walkthrough",  // optional
 *     "appointmentAt": "2026-05-22T18:00:00Z"   // optional ISO
 *   }
 *
 * Returns: same shape as before (ok / leadPublicId / outcome / notified).
 */

interface PostCallPayload {
  leadPublicId?: string;
  outcome?: PostCallOutcome;
  summary?: string;
  appointmentAt?: string;
}

function authorize(req: Request): boolean {
  const expected = process.env.INTERNAL_DISPATCH_SECRET;
  if (!expected) return false;
  const provided = req.headers.get("x-dispatch-secret") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const oversized = checkPayloadSize(req, { maxBytes: PAYLOAD_LIMITS.small });
  if (oversized) return oversized;
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: PostCallPayload;
  try {
    body = (await req.json()) as PostCallPayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.leadPublicId || typeof body.leadPublicId !== "string") {
    return NextResponse.json(
      { error: "missing_fields", required: ["leadPublicId"] },
      { status: 400 },
    );
  }

  const outcome: PostCallOutcome = body.outcome ?? "appt_scheduled";
  if (!VALID_POSTCALL_OUTCOMES.has(outcome)) {
    return NextResponse.json(
      { error: "invalid_outcome", allowed: [...VALID_POSTCALL_OUTCOMES] },
      { status: 400 },
    );
  }

  const result = await sendPostCallNotifications({
    leadPublicId: body.leadPublicId,
    outcome,
    summary: body.summary,
    appointmentAt: body.appointmentAt,
  });

  if (!result.ok) {
    // Map common reasons to HTTP status. Unknown reasons → 500.
    const status =
      result.reason === "supabase_not_configured"
        ? 503
        : result.reason === "lead_not_found"
          ? 404
          : result.reason === "invalid_outcome"
            ? 400
            : 500;
    return NextResponse.json(
      { error: result.reason ?? "unknown_error", leadPublicId: body.leadPublicId },
      { status },
    );
  }

  return NextResponse.json({
    ok: true,
    leadPublicId: result.leadPublicId,
    outcome: result.outcome,
    notified: result.notified,
  });
}

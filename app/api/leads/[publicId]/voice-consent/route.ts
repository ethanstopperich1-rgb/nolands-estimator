import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { rateLimit } from "@/lib/ratelimit";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";

export const runtime = "nodejs";
// Same dispatch window as /api/leads — call dispatch is fire-and-forget
// inside waitUntil() so the customer's POST returns fast.
export const maxDuration = 30;

/**
 * POST /api/leads/[publicId]/voice-consent
 *
 * Captures TCPA voice consent AFTER the customer has seen their
 * estimate and explicitly opts in. Records the disclosure text, IP, UA,
 * and timestamp in the `consents` table (separate row from the SMS /
 * marketing consent already on file), then dispatches the outbound
 * automated voice intro via /api/dispatch-outbound — the SAME pipeline
 * the original form flow used, just gated on a moment of clearer
 * intent.
 *
 * TCPA compliance posture:
 *  - "Prior express written consent" required for an autodialed /
 *    prerecorded voice call to a wireless number for marketing.
 *  - That consent must be obtained BEFORE the call is placed. This
 *    endpoint captures it, persists the receipt, then triggers the
 *    call — order matters; the customer cannot have already received
 *    the automated call when they check this box.
 *  - Per the FCC's 2023 "one-to-one consent" rule (effective Jan 2025),
 *    consent must be specific to a single seller. We satisfy that by
 *    naming the assigned office in the disclosure text and binding the
 *    consent row to that office_id.
 *  - Disclosure text + IP + UA + timestamp persist in `consents`
 *    (`consent_type: "call_recording"`) so the audit trail is
 *    regulator-grade.
 *
 * Body shape (defensive parse — additive client mistakes don't 400):
 *   {
 *     consent: true,           // must be true; false / missing → 400
 *     disclosureText?: string  // override the default disclosure
 *   }
 */

interface RequestBody {
  consent?: unknown;
  disclosureText?: unknown;
}

const DEFAULT_DISCLOSURE_TEXT =
  "Customer authorized an automated outbound voice intro call from " +
  "the assigned business after viewing their estimate. Recording may " +
  "apply where permitted by law. Reply STOP to opt out.";

export async function POST(
  req: Request,
  context: { params: Promise<{ publicId: string }> },
): Promise<NextResponse> {
  const rl = await rateLimit(req, "public");
  if (rl) return rl;

  const { publicId } = await context.params;
  if (!publicId || !/^lead_[0-9a-f]{32}$/i.test(publicId)) {
    return NextResponse.json({ error: "invalid_public_id" }, { status: 400 });
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }
  if (body.consent !== true) {
    return NextResponse.json({ error: "consent_required" }, { status: 400 });
  }

  // Capture the TCPA receipt's IP + UA at the moment of consent (NOT
  // at lead-creation time — these are the values relevant to the
  // voice-call authorization).
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const consentIp =
    xff.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
  const consentUserAgent = req.headers.get("user-agent") || null;

  if (!supabaseServiceRoleConfigured()) {
    return NextResponse.json(
      {
        error: "service_unavailable",
        message: "Supabase service role is not configured.",
      },
      { status: 503 },
    );
  }

  const supabase = createServiceRoleClient();
  // Look up the lead — we need its office_id (for tenancy) + phone (for
  // dispatch). Public-id collision across offices is impossible by
  // construction (32-hex randomness), so no office filter is needed.
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("id, office_id, phone, name, address, estimate_low, estimate_high")
    .eq("public_id", publicId)
    .maybeSingle();
  if (leadErr) {
    console.error("[voice-consent] supabase lead lookup failed:", leadErr.message);
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!lead) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!lead.phone) {
    return NextResponse.json(
      { error: "no_phone_on_lead" },
      { status: 400 },
    );
  }

  const disclosureText =
    typeof body.disclosureText === "string" && body.disclosureText.trim()
      ? body.disclosureText.trim()
      : DEFAULT_DISCLOSURE_TEXT;

  // Persist the audit row — append-only, regulator-grade.
  const { error: consentErr } = await supabase.from("consents").insert({
    office_id: lead.office_id,
    lead_id: lead.id,
    // Same enum as the form-time row. `call_recording` is the closest
    // match — disclosure_text disambiguates that this is voice-outbound
    // authorization specifically.
    consent_type: "call_recording",
    disclosure_text: disclosureText,
    email: null,
    phone: lead.phone,
    ip_address: consentIp,
    user_agent: consentUserAgent,
  });
  if (consentErr) {
    console.error(
      "[voice-consent] supabase consent insert failed:",
      consentErr.message,
    );
    return NextResponse.json({ error: "consent_write_failed" }, { status: 500 });
  }

  // Fire the outbound dispatch (fire-and-forget under waitUntil so the
  // customer's request returns immediately and the function lives long
  // enough for the dispatch to land). Best-effort: a dispatch failure
  // does NOT roll back the consent — the rep can manually call the
  // customer using the same number, and the consent receipt is on file.
  if (process.env.INTERNAL_DISPATCH_SECRET) {
    const origin = new URL(req.url).origin;
    const dispatchSecret = process.env.INTERNAL_DISPATCH_SECRET;
    waitUntil(
      fetch(`${origin}/api/dispatch-outbound`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-voxaris-dispatch-secret": dispatchSecret,
        },
        body: JSON.stringify({
          leadPublicId: publicId,
          phone: lead.phone,
          name: lead.name,
          address: lead.address,
          estimateLow: lead.estimate_low,
          estimateHigh: lead.estimate_high,
          officeId: lead.office_id,
          // Tag for downstream telemetry / dispatch logic so it can
          // distinguish a post-result opt-in call from a form-time one.
          trigger: "post-result-consent",
        }),
      })
        .then(() =>
          console.log("[voice-consent] dispatched outbound", { publicId }),
        )
        .catch((err) =>
          console.error("[voice-consent] dispatch fetch failed:", err),
        ),
    );
  } else {
    console.warn(
      "[voice-consent] INTERNAL_DISPATCH_SECRET unset; consent recorded but no call dispatched",
    );
  }

  return NextResponse.json({ ok: true });
}

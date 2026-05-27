import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { checkPayloadSize, PAYLOAD_LIMITS } from "@/lib/payload-guard";
import {
  checkAuthLockout,
  recordAuthFailure,
  AUTH_THROTTLE_MAX,
  AUTH_THROTTLE_WINDOW_SECONDS,
} from "@/lib/auth-throttle";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import { buildVoiceConsentDisclosureText } from "@/lib/tcpa-consent";
import { toE164 } from "@/lib/twilio";
import { verifyRecaptcha } from "@/lib/recaptcha";

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
 *   }
 *
 * `disclosureText` USED to be accepted from the client. Removed — a
 * malicious or buggy client could forge the audit-row disclosure to
 * something other than what the customer actually saw, undermining
 * TCPA defensibility. The server now substitutes the resolved office
 * name into a fixed template (see below). Future per-office variants
 * should be a server-side lookup keyed off office_id, never a client
 * field.
 */

interface RequestBody {
  consent?: unknown;
  /** reCAPTCHA v3 token minted client-side with action="voice_consent".
   *  Voice consent triggers an automated outbound call to a phone we
   *  collected earlier — high TCPA risk surface, deserves a fresh bot
   *  signal in addition to the lead-creation token already on file. */
  recaptchaToken?: string;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ publicId: string }> },
): Promise<NextResponse> {
  // Payload size cap — body is `{ consent: true }`, never large.
  const oversized = checkPayloadSize(req, { maxBytes: PAYLOAD_LIMITS.small });
  if (oversized) return oversized;

  const rl = await rateLimit(req, "public");
  if (rl) return rl;

  // Brute-force throttle. The publicId is the only thing protecting
  // against a forced-consent attack: an attacker who scrapes or guesses
  // a lead_<32hex> id could POST a `{consent:true}` and trigger an
  // outbound call to the victim's phone. The id space is large (2^128),
  // but defense in depth — cap failures per IP at 5 in a 15-min window.
  const lock = await checkAuthLockout(req, "voice-consent");
  if (lock.locked) {
    return NextResponse.json(
      {
        error: `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfterSeconds / 60)} minutes.`,
        retryAfterSeconds: lock.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(lock.retryAfterSeconds),
          "X-RateLimit-Limit": String(AUTH_THROTTLE_MAX),
          "X-RateLimit-Window": String(AUTH_THROTTLE_WINDOW_SECONDS),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const { publicId } = await context.params;
  if (!publicId || !/^lead_[0-9a-f]{32}$/i.test(publicId)) {
    await recordAuthFailure(req, "voice-consent");
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

  // reCAPTCHA v3 — gate the voice-dispatch trigger behind a fresh bot
  // signal. The lead-creation token already on file proves the lead
  // wasn't a bot at form submit; this proves the consent click isn't a
  // bot pushing the button. Soft-fails when RECAPTCHA_SECRET_KEY unset
  // (dev / preview) per the same pattern as /api/leads. In production:
  // a missing token = 400 reject.
  const xffEarly = req.headers.get("x-forwarded-for") ?? "";
  const captchaIp =
    xffEarly.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
  const captcha = await verifyRecaptcha(
    body.recaptchaToken,
    "voice_consent",
    captchaIp,
  );
  if (!captcha.ok) {
    await recordAuthFailure(req, "voice-consent");
    console.warn(
      `[voice-consent] recaptcha_failed reason=${captcha.reason} score=${captcha.score} action=${captcha.action}`,
    );
    return NextResponse.json(
      {
        error: "captcha_failed",
        reason: captcha.reason,
        score: captcha.score,
      },
      { status: 400 },
    );
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
  // Look up the lead AND its office slug — we need the slug (not the
  // UUID) for the dispatch payload. Tenancy is enforced by the public_id
  // (lead_<32-hex>) so no separate office filter is needed.
  //
  // The embedded join on `offices:office_id ( slug )` doesn't roundtrip
  // cleanly through the generated supabase types, so the result is
  // narrowed via an explicit cast on the line below.
  interface LeadWithOffice {
    id: string;
    office_id: string;
    phone: string | null;
    name: string | null;
    address: string | null;
    estimate_low: number | null;
    estimate_high: number | null;
    jobnimbus_contact_id: string | null;
    offices: { slug: string | null } | { slug: string | null }[] | null;
  }
  const { data: leadRaw, error: leadErr } = await supabase
    .from("leads")
    .select(
      "id, office_id, phone, name, address, estimate_low, estimate_high, " +
        "jobnimbus_contact_id, " +
        "offices:office_id ( slug )",
    )
    .eq("public_id", publicId)
    .maybeSingle();
  if (leadErr) {
    console.error("[voice-consent] supabase lead lookup failed:", leadErr.message);
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!leadRaw) {
    // Treat publicId-not-found as a brute-force signal — feeds the
    // throttle so an attacker scanning the id space gets locked out.
    await recordAuthFailure(req, "voice-consent");
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const lead = leadRaw as unknown as LeadWithOffice;
  if (!lead.phone) {
    return NextResponse.json(
      { error: "no_phone_on_lead" },
      { status: 400 },
    );
  }

  // Idempotency / harassment gate — if a call-recording consent row
  // already exists for this lead, refuse. Prevents an attacker who
  // learned the publicId from spamming consent inserts + dispatching
  // repeat calls to the customer. Audit (2026-05) flagged the original
  // open replay as a TCPA exposure.
  const { count: existingConsentCount, error: existingErr } = await supabase
    .from("consents")
    .select("id", { head: true, count: "exact" })
    .eq("lead_id", lead.id)
    .eq("consent_type", "call_recording");
  if (existingErr) {
    console.error(
      "[voice-consent] existing-consent lookup failed:",
      existingErr.message,
    );
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if ((existingConsentCount ?? 0) > 0) {
    return NextResponse.json(
      { error: "consent_already_recorded" },
      { status: 409 },
    );
  }

  // Resolve the office's display name so the audit row names the
  // specific seller (FCC one-to-one consent rule). Falls back to a
  // generic placeholder only when the office row is unreachable.
  const { data: officeRow } = await supabase
    .from("offices")
    .select("name")
    .eq("id", lead.office_id)
    .maybeSingle();
  const officeDisplayName = officeRow?.name ?? "the assigned business";
  const disclosureText = buildVoiceConsentDisclosureText(officeDisplayName);

  // Persist the audit row — append-only, regulator-grade.
  const { error: consentErr } = await supabase.from("consents").insert({
    office_id: lead.office_id,
    lead_id: lead.id,
    // Distinct from the form-time `tcpa_marketing` row — this is the
    // voice-call authorization specifically. Migration 0021 widened
    // the prod CHECK constraint to permit this value (May 2026).
    consent_type: "call_recording",
    disclosure_text: disclosureText,
    email: null,
    phone: lead.phone,
    ip_address: consentIp,
    user_agent: consentUserAgent,
  });

  // Log the TCPA consent capture to JobNimbus immediately — this
  // creates the audit trail in the place Noland's reps actually look
  // (the JN contact timeline), independent of whether Sarah dials
  // successfully or not.
  if (!consentErr) {
    const { logJN } = await import("@/lib/jn-log");
    logJN(
      lead.jobnimbus_contact_id,
      "voice-consent",
      `TCPA voice-call consent captured from /r/${publicId}\n` +
        `Phone: ${lead.phone ?? "n/a"}\n` +
        `IP: ${consentIp ?? "n/a"}\n` +
        `Disclosure text contained "AI voice assistant" (FCC compliance).\n` +
        `Office: ${officeDisplayName}`,
    );
  }
  if (consentErr) {
    // Verbose log retained — surfaces PostgrestError fields (code,
    // details, hint) in Vercel runtime logs for future ops. JSON
    // response stays opaque to avoid leaking schema details to
    // homeowners.
    console.error("[voice-consent] supabase consent insert failed", {
      message: consentErr.message,
      details: consentErr.details,
      hint: consentErr.hint,
      code: consentErr.code,
      lead_id: lead.id,
      office_id: lead.office_id,
    });
    return NextResponse.json(
      { error: "consent_write_failed" },
      { status: 500 },
    );
  }

  // Fire the outbound dispatch (fire-and-forget under waitUntil so the
  // customer's request returns immediately and the function lives long
  // enough for the dispatch to land). Best-effort: a dispatch failure
  // does NOT roll back the consent — the rep can manually call the
  // customer using the same number, and the consent receipt is on file.
  // Dispatch payload contract (matches /api/dispatch-outbound):
  //   - leadId  : opaque caller string (we pass publicId; the dispatcher
  //               only uses it for room-name + telemetry, not lookup)
  //   - office  : SLUG, not UUID. The dispatcher enforces a slug regex.
  // The previous version sent leadPublicId + officeId and a
  // x-voxaris-dispatch-secret header — both wrong, so dispatch silently
  // 401'd / 400'd after the consent row was already written. Audit
  // (2026-05) caught the drift.
  // The supabase `offices:office_id ( slug )` shape can come back as
  // either a single object or a 1-element array depending on the
  // codegen settings — handle both. `offices` is always nullable
  // (cross-tenant cleanup might have orphaned a lead).
  const officeRel = lead.offices;
  const officeSlug = Array.isArray(officeRel)
    ? officeRel[0]?.slug ?? null
    : officeRel?.slug ?? null;
  if (!officeSlug) {
    console.warn(
      "[voice-consent] lead missing office slug; consent recorded but no call dispatched",
      { publicId, officeId: lead.office_id },
    );
    return NextResponse.json(
      {
        ok: true,
        dispatched: false,
        reason: "missing_office_slug",
        debug: { office_id: lead.office_id },
      },
    );
  }
  if (!process.env.INTERNAL_DISPATCH_SECRET) {
    console.warn("[voice-consent] INTERNAL_DISPATCH_SECRET unset");
    return NextResponse.json(
      {
        ok: true,
        dispatched: false,
        reason: "missing_dispatch_secret",
      },
    );
  }

  // AWAIT dispatch (was waitUntil fire-and-forget — silenced failures).
  // The customer is staring at the page expecting Sarah to ring within
  // 10s. We'd rather take 1-2s on this round-trip and surface a real
  // failure than show "calling now" while the SIP leg silently 401s.
  // Diagnostic payload (debug.dispatch) carries the dispatch-outbound
  // response so the next click reveals env / LK / Twilio issues
  // immediately. Strip the debug block back once Sarah dials reliably.
  const origin = new URL(req.url).origin;
  const dispatchSecret = process.env.INTERNAL_DISPATCH_SECRET;
  let dispatchStatus = 0;
  let dispatchBody: unknown = null;
  try {
    const dispatchRes = await fetch(`${origin}/api/dispatch-outbound`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-dispatch-secret": dispatchSecret,
      },
      body: JSON.stringify({
        leadId: publicId,
        // dispatch-outbound demands E.164 (+1XXXXXXXXXX); the lead row
        // stores the raw user-typed format ("(407) 819-5809"). Convert
        // here so dispatch passes its phone-format gate. If toE164
        // returns null (somehow not a US phone), pass the raw string
        // and let dispatch return the same 400 it would have anyway.
        phone: toE164(lead.phone) ?? lead.phone,
        name: lead.name,
        address: lead.address,
        estimateLow: lead.estimate_low,
        estimateHigh: lead.estimate_high,
        office: officeSlug,
        trigger: "post-result-consent",
      }),
    });
    dispatchStatus = dispatchRes.status;
    try {
      dispatchBody = await dispatchRes.json();
    } catch {
      dispatchBody = { parse_error: "non-json response" };
    }
    console.log("[voice-consent] dispatch response", {
      publicId,
      status: dispatchStatus,
      body: dispatchBody,
    });
  } catch (err) {
    console.error("[voice-consent] dispatch fetch threw:", err);
    return NextResponse.json({
      ok: true,
      dispatched: false,
      reason: "dispatch_fetch_threw",
      debug: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  if (dispatchStatus < 200 || dispatchStatus >= 300) {
    // Log the dispatch failure to JN so the rep sees it in their
    // timeline ("consent captured but Sarah never dialed — call them
    // manually"). Fire-and-forget; the response goes back immediately.
    const { logJN } = await import("@/lib/jn-log");
    logJN(
      lead.jobnimbus_contact_id,
      "voice-consent",
      `Sarah dispatch FAILED status=${dispatchStatus}. Consent on file, ` +
        `homeowner expects a call — call manually now.`,
    );
    return NextResponse.json({
      ok: true,
      dispatched: false,
      reason: "dispatch_non_2xx",
      debug: { status: dispatchStatus, body: dispatchBody },
    });
  }

  // Dispatch succeeded — log to JN so reps see Sarah is on the line.
  {
    const { logJN } = await import("@/lib/jn-log");
    logJN(
      lead.jobnimbus_contact_id,
      "voice-consent",
      `Sarah outbound dispatched (LK Cloud → Twilio SIP). ` +
        `Phone: ${lead.phone ?? "n/a"}.`,
    );
  }

  return NextResponse.json({
    ok: true,
    dispatched: true,
    debug: dispatchBody,
  });
}

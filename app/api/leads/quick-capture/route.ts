/**
 * POST /api/leads/quick-capture
 *
 * Phone-only "text me my estimate" capture — the foot-in-the-door
 * variant of /api/leads. Homeowners who view the painted result but
 * aren't ready to give their full name + email + voice consent can
 * still drop just a phone number and we'll text them the secure
 * share link.
 *
 * Closes the 70-85% funnel leak between "saw the painted roof" and
 * "submitted PII." This is industry-standard top-of-funnel CRO
 * pattern (foot-in-the-door + reciprocity) — they get the roof
 * report for free, we get a phone number we can text + the option
 * to graduate them into the full lock-in flow later.
 *
 * Auth + abuse defense (mirror of /api/leads):
 *   - BotID verification — same anti-bot signal as the full form
 *   - Origin guard — must be a same-origin POST
 *   - Rate limit "standard" bucket
 *
 * TCPA posture:
 *   - Explicit consent gate (consent === true required)
 *   - Disclosure text from lib/tcpa-consent.ts (Quick Capture variant
 *     — narrower than full marketing consent but still TCPA-valid
 *     because it names the office explicitly + states message frequency
 *     varies + includes STOP/HELP)
 *   - Stamps tcpa_consent + tcpa_consent_text on the lead row so the
 *     audit trail matches what the homeowner agreed to
 *
 * Downstream actions on success:
 *   1. Insert a thin lead row in Supabase (name = "Quick Capture",
 *      email = null, phone = E.164, address, tcpa_consent = true)
 *   2. Returns the new leadPublicId immediately
 *   3. Fire-and-forget Podium SMS with the share URL + painted PNG
 *      attachment (reuses sendEstimateReadyViaPodium)
 *   4. Fire-and-forget JN createContact with tag
 *      "phone-only-capture" so the rep knows full PII isn't here yet
 *
 * What this does NOT do:
 *   - No voice-consent capture (Sarah doesn't dial quick-capture leads
 *     unless they later opt in via SMS YES)
 *   - No email send (no email captured)
 *   - No Twilio confirmation SMS (we use Podium for the share-link
 *     send — single channel, no inbox fragmentation)
 *
 * The homeowner can later graduate to a full lead by completing the
 * lock-in form — the existing /api/leads "update" path will recognize
 * their phone and upgrade the existing row (no duplicate).
 */

import { NextResponse } from "next/server";
import { checkBotId } from "botid/server";
import { randomBytes } from "node:crypto";

import { checkOrigin } from "@/lib/origin-guard";
import { rateLimit } from "@/lib/ratelimit";
import { toE164 } from "@/lib/twilio";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
  resolveOfficeBySlug,
} from "@/lib/supabase";
import { buildQuickCaptureConsentText } from "@/lib/tcpa-consent";

interface QuickCaptureBody {
  /** US phone, any common format — we E.164 it server-side. */
  phone: string;
  /** Full street address as displayed on the result page. */
  address: string;
  /** Office slug (e.g. "nolands"). Matches /api/leads. */
  office: string;
  /** Explicit TCPA consent — UI checkbox must be true. */
  consent: boolean;

  // Optional V3-result data the page can pass through so the SMS
  // can reference real numbers + the painted image. All optional;
  // SMS soft-fails to a plain share-link send when missing.
  zip?: string;
  lat?: number;
  lng?: number;
  paintedUrl?: string;
  estimateLow?: number;
  estimateHigh?: number;
  /** ISO 'en' | 'es'. */
  preferredLanguage?: "en" | "es";
}

const OFFICE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/i;

/**
 * Generates a 32-hex public_id matching the leads table's existing
 * format (lead_<32hex>). Crypto-random so the URL is unguessable.
 */
function newLeadPublicId(): string {
  return `lead_${randomBytes(16).toString("hex")}`;
}

export async function POST(req: Request): Promise<NextResponse> {
  // ─── Defense layers (same as /api/leads) ──────────────────────────
  const __o = checkOrigin(req);
  if (__o) return __o;
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;
  const __bot = await checkBotId();
  if ("isBot" in __bot && __bot.isBot && !__bot.isVerifiedBot) {
    return NextResponse.json({ error: "Bot detected" }, { status: 403 });
  }

  // ─── Parse + validate body ────────────────────────────────────────
  let body: QuickCaptureBody;
  try {
    body = (await req.json()) as QuickCaptureBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body.consent !== true) {
    return NextResponse.json(
      { error: "consent_required", message: "TCPA consent checkbox must be checked." },
      { status: 400 },
    );
  }
  if (typeof body.phone !== "string" || body.phone.trim().length < 7) {
    return NextResponse.json({ error: "phone_required" }, { status: 400 });
  }
  const phoneE164 = toE164(body.phone);
  if (!phoneE164) {
    return NextResponse.json(
      { error: "phone_invalid", message: "Phone must be a valid US number." },
      { status: 400 },
    );
  }
  if (typeof body.address !== "string" || body.address.trim().length < 4) {
    return NextResponse.json({ error: "address_required" }, { status: 400 });
  }
  if (typeof body.office !== "string" || !OFFICE_SLUG_RE.test(body.office)) {
    return NextResponse.json({ error: "office_required" }, { status: 400 });
  }
  const officeSlug = body.office.trim().toLowerCase();

  // ─── Resolve office + insert lead ─────────────────────────────────
  if (!supabaseServiceRoleConfigured()) {
    return NextResponse.json(
      { error: "service_unavailable", reason: "supabase_not_configured" },
      { status: 503 },
    );
  }
  const office = await resolveOfficeBySlug(officeSlug);
  if (!office) {
    return NextResponse.json(
      { error: "office_unknown", office: officeSlug },
      { status: 404 },
    );
  }

  const supabase = createServiceRoleClient();
  const submittedAt = new Date().toISOString();
  const consentText = buildQuickCaptureConsentText(office.displayName ?? "Noland's Roofing");
  const consentIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const consentUserAgent = req.headers.get("user-agent") ?? null;
  const leadPublicId = newLeadPublicId();
  const preferredLanguage = body.preferredLanguage === "es" ? "es" : "en";

  // Dedup: when a lead row already exists for this phone in this office
  // within the last hour, reuse the existing public_id instead of
  // inserting a duplicate. The home-page "submit, refresh, resubmit"
  // pattern would otherwise create 3 rows + 3 SMS sends.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: existing } = await supabase
    .from("leads")
    .select("public_id, phone")
    .eq("office_id", office.id)
    .gte("created_at", oneHourAgo)
    .ilike("phone", `%${phoneE164.slice(-10)}%`)
    .limit(1)
    .maybeSingle();
  if (existing?.public_id) {
    return NextResponse.json({
      ok: true,
      leadPublicId: existing.public_id,
      reused: true,
      message: "Already captured — resending your estimate.",
    });
  }

  // email is NOT NULL on the leads table — pass empty string for the
  // no-email-yet quick-capture path. Rep dashboards already handle
  // empty-string email correctly (they hide the column or show "—").
  const leadRow = {
    office_id: office.id,
    public_id: leadPublicId,
    name: "Quick Capture",
    email: "",
    phone: phoneE164,
    address: body.address.trim(),
    zip: body.zip ?? null,
    lat: body.lat ?? null,
    lng: body.lng ?? null,
    estimate_low: body.estimateLow ?? null,
    estimate_high: body.estimateHigh ?? null,
    source: "quick-capture",
    status: "quick_captured",
    tcpa_consent: true,
    tcpa_consent_at: submittedAt,
    tcpa_consent_text: consentText,
    preferred_language: preferredLanguage,
  };

  const { data: inserted, error } = await supabase
    .from("leads")
    .insert(leadRow) // office-id-check: ok-leadRow-above-has-office_id
    .select("id, public_id")
    .single();
  if (error || !inserted) {
    console.error("[quick-capture] supabase insert failed:", error?.message);
    return NextResponse.json(
      { error: "lead_insert_failed", detail: error?.message },
      { status: 500 },
    );
  }

  // Audit-trail consent row — matches /api/leads pattern. consent_type
  // "tcpa_marketing" is the same as the full-form path (migration 0021
  // widened the CHECK constraint to accept this value).
  await supabase.from("consents").insert({
    office_id: office.id,
    lead_id: inserted.id,
    consent_type: "tcpa_marketing",
    disclosure_text: consentText,
    email: null,
    phone: phoneE164,
    ip_address: consentIp,
    user_agent: consentUserAgent,
  });

  // ─── Fire-and-forget side effects ─────────────────────────────────
  // Podium SMS send. Soft-fails if Podium env isn't wired.
  if (body.paintedUrl && body.estimateLow != null && body.estimateHigh != null) {
    void import("@/lib/podium").then(({ sendEstimateReadyViaPodium }) =>
      sendEstimateReadyViaPodium({
        customerPhone: phoneE164,
        customerName: "Friend", // No name yet — Podium template renders "Hi Friend"
        address: body.address.split(",")[0].trim(),
        paintedImageUrl: body.paintedUrl!,
        shareUrl: `${process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "https://nolands-estimator.vercel.app"}/r/${leadPublicId}`,
        lowEstimate: body.estimateLow!,
        highEstimate: body.estimateHigh!,
        leadPublicId,
      }).then((result) => {
        if (!result.sent && result.reason !== "not_configured") {
          console.warn(
            `[quick-capture] podium_send_failed reason=${result.reason} ${result.error ?? ""}`,
          );
        }
      }).catch((err) =>
        console.warn(
          "[quick-capture] podium_unexpected",
          err instanceof Error ? err.message : String(err),
        ),
      ),
    );
  }

  // JN createContact — tagged "phone-only-capture" so reps know full PII
  // is missing. Fire-and-forget; failure logged but never blocks.
  void import("@/lib/jobnimbus").then(async ({ createContact, jobNimbusConfigured }) => {
    if (!jobNimbusConfigured()) return;
    try {
      const created = await createContact({
        displayName: "Quick Capture",
        phone: phoneE164,
        address: body.address.trim(),
        zip: body.zip,
        tags: ["estimator", "nolands", "phone-only-capture"],
        language: preferredLanguage,
        // voiceConsent intentionally omitted — quick-capture doesn't
        // collect voice consent. The contact will auto-tag voice-consent-no.
        voiceConsent: false,
      });
      if (created.ok) {
        // Stash the JN contact id on the lead row so a future full
        // lock-in submission can graduate the same JN record.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any)
          .from("leads")
          .update({ jobnimbus_contact_id: created.jnid })
          .eq("public_id", leadPublicId);
      } else if (created.reason !== "not_configured") {
        console.warn(
          `[quick-capture] jn_contact_create_failed reason=${created.reason} ${created.error ?? ""}`,
        );
      }
    } catch (err) {
      console.warn(
        "[quick-capture] jn_unexpected",
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  return NextResponse.json({
    ok: true,
    leadPublicId,
    reused: false,
    message: "Estimate sent — check your texts.",
  });
}

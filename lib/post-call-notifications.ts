/**
 * lib/post-call-notifications.ts
 *
 * Shared post-call notification engine. Called from two surfaces:
 *
 *   1. /api/sms/post-call — the legacy webhook Sarah's worker COULD call
 *      directly (kept for manual smoke tests + future integrations).
 *   2. /api/agent/events handleCallEnded — the canonical path. Sarah's
 *      worker already POSTs call_ended to that route with outcome +
 *      summary + transcript. After the DB write, the route fans out
 *      here so EVERY Sarah call automatically sends:
 *        - Homeowner SMS (localized EN/ES, copy varies by outcome)
 *        - Rep SMS to office number with lead details + dashboard link
 *        - lead_webhook event for Podium/HighLevel/etc. mirroring
 *
 * Soft-fail discipline: every step is wrapped — a Twilio outage doesn't
 * lose the DB update, a Supabase outage doesn't block the homeowner
 * SMS path. Returns a structured result so callers can log which
 * channels actually fired.
 *
 * Created 2026-05-26 as part of POSTCALL-FANOUT (task #185). The
 * sendHomeownerSms + sendRepUpdate helpers were extracted from the
 * previous /api/sms/post-call/route.ts body and now live here as the
 * single source of truth.
 */

import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
  type OfficeBranding,
} from "@/lib/supabase";
// 2026-05-26: Twilio direct SMS retired. Post-call notifications
// (homeowner outcome SMS + rep update SMS) now route through Podium
// so reps see the entire customer conversation in one Podium inbox.
// `toE164` (formatter) survives; `twilioConfigured` is no longer
// used here (replaced with `podiumConfigured`).
import { toE164 } from "@/lib/twilio";
import { sendPodiumText, podiumConfigured } from "@/lib/podium";
import { resolveNotifyPhone } from "@/lib/lead-notifications";
import { parseLang, t, type Lang } from "@/lib/i18n";
import {
  LEAD_WEBHOOK_SCHEMA_VERSION,
  publishLeadEvent,
} from "@/lib/lead-webhook";
import { sendSlackLeadEvent } from "@/lib/slack-notifications";

// ─── Public types ──────────────────────────────────────────────────────

export type PostCallOutcome =
  | "appt_scheduled"
  | "callback_requested"
  | "no_appointment"
  | "voicemail"
  | "failed";

export const VALID_POSTCALL_OUTCOMES: ReadonlySet<PostCallOutcome> = new Set([
  "appt_scheduled",
  "callback_requested",
  "no_appointment",
  "voicemail",
  "failed",
]);

export interface PostCallInput {
  /** lead.public_id — the `lead_<32hex>` identifier. */
  leadPublicId: string;
  /** Outcome reported by Sarah at call end. */
  outcome: PostCallOutcome;
  /** Optional one-line conversation summary (from Sarah's summarizer). */
  summary?: string;
  /** Optional ISO timestamp of the booked appointment (when outcome=appt_scheduled). */
  appointmentAt?: string;
  /** Optional dashboard origin override. Defaults to env-resolved value. */
  dashboardOrigin?: string;
}

export interface PostCallResult {
  ok: boolean;
  leadPublicId: string;
  outcome: PostCallOutcome;
  notified: {
    homeowner: boolean;
    rep: boolean;
  };
  /** Set when the function bailed early (e.g. supabase not configured). */
  reason?: string;
}

// ─── Public entry point ────────────────────────────────────────────────

/**
 * Send post-call SMS notifications (homeowner + rep) and publish the
 * provider-agnostic lead webhook event for the given lead.
 *
 * Idempotency: NOT idempotent by itself. The caller is responsible for
 * gating duplicate fires (e.g. /api/agent/events checks calls.outcome
 * before fan-out). The lead.status update IS idempotent — the same
 * outcome stamped twice is a no-op.
 */
export async function sendPostCallNotifications(
  input: PostCallInput,
): Promise<PostCallResult> {
  const baseResult: PostCallResult = {
    ok: false,
    leadPublicId: input.leadPublicId,
    outcome: input.outcome,
    notified: { homeowner: false, rep: false },
  };

  if (!supabaseServiceRoleConfigured()) {
    return { ...baseResult, reason: "supabase_not_configured" };
  }
  if (!VALID_POSTCALL_OUTCOMES.has(input.outcome)) {
    return { ...baseResult, reason: "invalid_outcome" };
  }

  const sb = createServiceRoleClient();

  // ─── 1. Look up lead + office ────────────────────────────────────────
  // Cast through `any` — `jobnimbus_contact_id` was added by migration
  // 0019 but generated types haven't been regenerated. Same pattern as
  // app/api/gemini-roof/route.ts (priorLead SELECT) and
  // app/api/cron/scheduled-callback/route.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny: any = sb;
  const { data: lead, error: leadErr } = await sbAny
    .from("leads")
    .select(
      // jobnimbus_contact_id pulled here so the homeowner-SMS send
      // can fire a [SMS-OUT] note on the JN contact timeline — every
      // post-call homeowner SMS is visible inside JobNimbus.
      "public_id, office_id, name, address, phone, estimate_low, estimate_high, estimated_sqft, material, source, notes, preferred_language, jobnimbus_contact_id",
    )
    .eq("public_id", input.leadPublicId)
    .maybeSingle();

  if (leadErr || !lead) {
    console.error(
      "[post-call-notifications] lead not found:",
      input.leadPublicId,
      leadErr?.message,
    );
    return { ...baseResult, reason: "lead_not_found" };
  }

  const { data: officeRow } = await sb
    .from("offices")
    .select(
      "id, slug, name, inbound_number, twilio_number, brand_color, logo_url, livekit_agent_name",
    )
    .eq("id", lead.office_id)
    .maybeSingle();

  const office: OfficeBranding | null = officeRow
    ? {
        id: officeRow.id,
        slug: officeRow.slug,
        displayName: officeRow.name,
        inboundNumber: officeRow.inbound_number,
        twilioNumber: officeRow.twilio_number,
        brandColor: officeRow.brand_color,
        logoUrl: officeRow.logo_url,
        livekitAgentName: officeRow.livekit_agent_name,
      }
    : null;

  // ─── 2. Update lead status + append note ─────────────────────────────
  const noteLine = `[${new Date().toISOString()}] post-call outcome=${input.outcome}${
    input.appointmentAt ? ` appt=${input.appointmentAt}` : ""
  }${input.summary ? ` — ${input.summary}` : ""}`;
  const updatedNotes = [lead.notes ?? "", noteLine].filter(Boolean).join("\n");

  try {
    await sb
      .from("leads")
      .update({
        status: input.outcome,
        notes: updatedNotes,
        updated_at: new Date().toISOString(),
      })
      .eq("public_id", lead.public_id);
  } catch (err) {
    // Don't bail — homeowner / rep SMS are higher priority than the
    // status update. The dashboard will eventually pick up the call
    // outcome via /api/agent/events's own DB write.
    console.error("[post-call-notifications] lead update failed:", err);
  }

  // ─── 3. Notify homeowner via SMS ─────────────────────────────────────
  const homeownerLang: Lang =
    parseLang((lead as { preferred_language?: unknown }).preferred_language) ??
    "en";
  const homeownerPhoneE164 = toE164(lead.phone);
  const sentHomeowner = await sendHomeownerSms({
    phoneE164: homeownerPhoneE164,
    outcome: input.outcome,
    name: lead.name,
    officeDisplayName: office?.displayName ?? "Noland's Roofing",
    // Pass through so the Podium send fires a JN note on the contact.
    jobnimbusContactId:
      (lead as { jobnimbus_contact_id?: string | null }).jobnimbus_contact_id ?? null,
    lang: homeownerLang,
    fromNumber: office?.twilioNumber ?? undefined,
    appointmentAt: input.appointmentAt,
  });

  // ─── 4. Notify rep / office via SMS ──────────────────────────────────
  const origin =
    input.dashboardOrigin ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.NEXT_PUBLIC_BASE_URL ??
        "https://nolands-estimator.vercel.app");

  const sentRep = await sendRepUpdate({
    office,
    lead,
    outcome: input.outcome,
    appointmentAt: input.appointmentAt,
    summary: input.summary,
    dashboardOrigin: origin,
  });

  // ─── 5. Publish provider-agnostic lead webhook + Slack ping ──────────
  // Same fan-out pattern as /api/leads — one event payload, two
  // independent sinks (generic webhook + Slack channel). Slack send
  // is no-op when SLACK_WEBHOOK_URL is unset.
  const callEvent = {
    schema_version: LEAD_WEBHOOK_SCHEMA_VERSION,
    event: (input.outcome === "appt_scheduled"
      ? "appt_scheduled"
      : "call_completed") as "appt_scheduled" | "call_completed",
    occurred_at: new Date().toISOString(),
    office: {
      id: office?.id ?? lead.office_id,
      slug: office?.slug ?? "",
      display_name: office?.displayName ?? "Noland's Roofing",
    },
    lead: {
      public_id: lead.public_id,
      name: lead.name,
      email: null,
      phone_raw: lead.phone,
      phone_e164: homeownerPhoneE164,
      address: lead.address,
      estimate_low: lead.estimate_low,
      estimate_high: lead.estimate_high,
      material: lead.material,
      estimated_sqft: lead.estimated_sqft,
      source: lead.source,
      report_url: `${origin}/dashboard/leads/${lead.public_id}`,
    },
    extras: {
      outcome: input.outcome,
      appointment_at: input.appointmentAt ?? null,
      summary: input.summary ?? null,
    },
  };
  void publishLeadEvent({ office, event: callEvent });
  void sendSlackLeadEvent(callEvent);

  return {
    ok: true,
    leadPublicId: lead.public_id,
    outcome: input.outcome,
    notified: { homeowner: sentHomeowner, rep: sentRep },
  };
}

// ─── Internal helpers (extracted from /api/sms/post-call/route.ts) ────

async function sendHomeownerSms(opts: {
  phoneE164: string | null;
  outcome: PostCallOutcome;
  name: string;
  officeDisplayName: string;
  lang: Lang;
  fromNumber?: string;
  appointmentAt?: string;
  jobnimbusContactId?: string | null;
}): Promise<boolean> {
  if (!opts.phoneE164 || !podiumConfigured()) return false;
  const firstName = opts.name.split(/\s+/)[0] ?? "there";
  let body: string;
  switch (opts.outcome) {
    case "appt_scheduled": {
      const when = opts.appointmentAt
        ? formatAppt(opts.appointmentAt, opts.lang)
        : opts.lang === "es"
          ? "tu hora seleccionada"
          : "your selected time";
      body = t("sms.postcall.appt_scheduled", opts.lang, {
        firstName,
        officeName: opts.officeDisplayName,
        when,
      });
      break;
    }
    case "callback_requested":
      body = t("sms.postcall.callback_requested", opts.lang, {
        firstName,
        officeName: opts.officeDisplayName,
      });
      break;
    case "voicemail":
      body = t("sms.postcall.voicemail", opts.lang, { firstName });
      break;
    case "no_appointment":
      body = t("sms.postcall.no_appointment", opts.lang, { firstName });
      break;
    default:
      // Fallback for "failed" + any unknown outcome.
      body = t("sms.postcall.no_appointment", opts.lang, { firstName });
  }
  try {
    await sendPodiumText({
      phone: opts.phoneE164,
      contactName: opts.name,
      body,
      openInbox: true,
      jobnimbusContactId: opts.jobnimbusContactId ?? null,
    });
    return true;
  } catch (err) {
    console.error("[post-call-notifications] homeowner SMS failed:", err);
    return false;
  }
}

async function sendRepUpdate(opts: {
  office: OfficeBranding | null;
  lead: {
    public_id: string;
    name: string;
    address: string;
    phone: string | null;
    estimate_low: number | null;
    estimate_high: number | null;
    estimated_sqft: number | null;
    material: string | null;
    source: string | null;
  };
  outcome: PostCallOutcome;
  appointmentAt?: string;
  summary?: string;
  dashboardOrigin: string;
}): Promise<boolean> {
  const dest = resolveNotifyPhone(opts.office);
  if (!dest || !podiumConfigured()) return false;

  // GSM-7 safe: no emoji, no em-dash. Each headline stays single-
  // segment with the body lines that follow.
  const headline =
    opts.outcome === "appt_scheduled"
      ? `APPT SCHEDULED - ${opts.lead.name}`
      : opts.outcome === "callback_requested"
        ? `CALLBACK REQUESTED - ${opts.lead.name}`
        : opts.outcome === "voicemail"
          ? `VOICEMAIL LEFT - ${opts.lead.name}`
          : `CALL ENDED (${opts.outcome}) - ${opts.lead.name}`;

  const lines: string[] = [headline, opts.lead.address];
  if (opts.appointmentAt) lines.push(`When: ${formatAppt(opts.appointmentAt)}`);
  if (
    opts.lead.estimate_low != null &&
    opts.lead.estimate_high != null
  ) {
    lines.push(
      `Est $${opts.lead.estimate_low.toLocaleString()}-$${opts.lead.estimate_high.toLocaleString()}`,
    );
  }
  const phoneE164 = toE164(opts.lead.phone);
  if (phoneE164) lines.push(`Customer: ${phoneE164}`);
  if (opts.summary) lines.push(opts.summary);
  lines.push(`${opts.dashboardOrigin}/dashboard/leads/${opts.lead.public_id}`);

  try {
    await sendPodiumText({
      phone: dest,
      // Stable label so rep post-call alerts upsert into a single
      // ops conversation rather than a new thread per call.
      contactName: "Noland's rep alert",
      body: lines.join("\n"),
      // Quiet send — don't open the customer-triage inbox on rep
      // ops messages.
      openInbox: false,
    });
    return true;
  } catch (err) {
    console.error("[post-call-notifications] rep SMS failed:", err);
    return false;
  }
}

function formatAppt(iso: string, lang: Lang = "en"): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(lang === "es" ? "es-US" : "en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

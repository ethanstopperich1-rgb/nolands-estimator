import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { sendSms, toE164, twilioConfigured } from "@/lib/twilio";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
  type OfficeBranding,
} from "@/lib/supabase";
import { resolveNotifyPhone } from "@/lib/lead-notifications";
import {
  LEAD_WEBHOOK_SCHEMA_VERSION,
  publishLeadEvent,
} from "@/lib/lead-webhook";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/sms/post-call
 *
 * Webhook the Sydney LiveKit agent calls when the conversation ends.
 * It closes the SMS-first lead loop:
 *
 *   1. Update the lead row: status = "appt_scheduled" (or whatever
 *      outcome the agent reports), append a note with the summary.
 *   2. SMS the homeowner: "Thanks — your inspection is set. A rep
 *      will confirm shortly."
 *   3. SMS the rep / office: "New lead appt scheduled — {name},
 *      {address}, deep link to the report."
 *
 * Auth: shared INTERNAL_DISPATCH_SECRET. Same gate as
 * /api/dispatch-outbound — the agent worker uses the same secret to
 * call back into the app.
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
 * Behavior is testing-grade — soft-fail on every external step so a
 * Twilio outage doesn't lose the dashboard status update, and a
 * Supabase outage doesn't block the homeowner SMS.
 */

interface PostCallPayload {
  leadPublicId?: string;
  outcome?:
    | "appt_scheduled"
    | "callback_requested"
    | "no_appointment"
    | "voicemail"
    | "failed";
  summary?: string;
  appointmentAt?: string;
}

const VALID_OUTCOMES = new Set([
  "appt_scheduled",
  "callback_requested",
  "no_appointment",
  "voicemail",
  "failed",
]);

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

  const outcome = body.outcome ?? "appt_scheduled";
  if (!VALID_OUTCOMES.has(outcome)) {
    return NextResponse.json(
      { error: "invalid_outcome", allowed: [...VALID_OUTCOMES] },
      { status: 400 },
    );
  }

  if (!supabaseServiceRoleConfigured()) {
    return NextResponse.json(
      { error: "supabase_not_configured" },
      { status: 503 },
    );
  }
  const sb = createServiceRoleClient();

  // ─── 1. Look up lead + office ──────────────────────────────────────
  const { data: lead, error: leadErr } = await sb
    .from("leads")
    .select(
      "public_id, office_id, name, address, phone, estimate_low, estimate_high, estimated_sqft, material, source, notes",
    )
    .eq("public_id", body.leadPublicId)
    .maybeSingle();

  if (leadErr || !lead) {
    console.error("[sms-postcall] lead not found:", body.leadPublicId, leadErr?.message);
    return NextResponse.json({ error: "lead_not_found" }, { status: 404 });
  }

  const { data: officeRow } = await sb
    .from("offices")
    .select("id, slug, name, inbound_number, twilio_number, brand_color, logo_url, livekit_agent_name")
    .eq("id", lead.office_id)
    .maybeSingle();

  const office = officeRow
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

  // ─── 2. Update lead status + note ──────────────────────────────────
  const noteLine = `[${new Date().toISOString()}] post-call outcome=${outcome}${
    body.appointmentAt ? ` appt=${body.appointmentAt}` : ""
  }${body.summary ? ` — ${body.summary}` : ""}`;
  const updatedNotes = [lead.notes ?? "", noteLine].filter(Boolean).join("\n");

  try {
    await sb
      .from("leads")
      .update({
        status: outcome,
        notes: updatedNotes,
        updated_at: new Date().toISOString(),
      })
      .eq("public_id", lead.public_id);
  } catch (err) {
    console.error("[sms-postcall] lead update failed:", err);
  }

  // ─── 3. Notify homeowner via SMS ───────────────────────────────────
  const homeownerPhoneE164 = toE164(lead.phone);
  const sentHomeowner = await sendHomeownerSms({
    phoneE164: homeownerPhoneE164,
    outcome,
    name: lead.name,
    officeDisplayName: office?.displayName ?? "Voxaris",
    // FROM the contractor's own Twilio number — same brand the
    // homeowner already saw on the confirmation + ack SMSes.
    fromNumber: office?.twilioNumber ?? undefined,
    appointmentAt: body.appointmentAt,
  });

  // ─── 4. Notify rep / office via SMS ────────────────────────────────
  const origin =
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.NEXT_PUBLIC_BASE_URL ?? "https://pitch.voxaris.io";

  // Reuse the lead-notifications helper, but with an "appt scheduled"
  // headline so the rep's phone shows the right urgency. We piggyback
  // on the same resolver chain (office.inbound_number → LEAD_NOTIFY_PHONE).
  const repNotified = await sendRepUpdate({
    office,
    lead,
    outcome,
    appointmentAt: body.appointmentAt,
    summary: body.summary,
    dashboardOrigin: origin,
  });

  // Provider-agnostic post-call event — same payload model as the
  // new_lead event so a Podium / HighLevel / Zapier receiver can
  // pivot off `event` and update its own pipeline stage.
  void publishLeadEvent({
    office,
    event: {
      schema_version: LEAD_WEBHOOK_SCHEMA_VERSION,
      event: outcome === "appt_scheduled" ? "appt_scheduled" : "call_completed",
      occurred_at: new Date().toISOString(),
      office: {
        id: office?.id ?? lead.office_id,
        slug: office?.slug ?? "",
        display_name: office?.displayName ?? "Voxaris",
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
        outcome,
        appointment_at: body.appointmentAt ?? null,
        summary: body.summary ?? null,
      },
    },
  });

  return NextResponse.json({
    ok: true,
    leadPublicId: lead.public_id,
    outcome,
    notified: {
      homeowner: sentHomeowner,
      rep: repNotified,
    },
  });
}

async function sendHomeownerSms(opts: {
  phoneE164: string | null;
  outcome: string;
  name: string;
  officeDisplayName: string;
  fromNumber?: string;
  appointmentAt?: string;
}): Promise<boolean> {
  if (!opts.phoneE164 || !twilioConfigured()) return false;
  const firstName = opts.name.split(/\s+/)[0] ?? "there";
  let body: string;
  switch (opts.outcome) {
    case "appt_scheduled": {
      const when = opts.appointmentAt ? formatAppt(opts.appointmentAt) : "your selected time";
      body = `Hi ${firstName}, your roof inspection with ${opts.officeDisplayName} is set for ${when}. A rep will confirm shortly. Reply STOP to opt out.`;
      break;
    }
    case "callback_requested":
      body = `Hi ${firstName}, thanks for chatting with us. A ${opts.officeDisplayName} rep will call you back shortly. Reply STOP to opt out.`;
      break;
    case "voicemail":
      body = `Hi ${firstName}, we just left you a voicemail. Reply YES to have us try again, or text us back any time. Reply STOP to opt out.`;
      break;
    case "no_appointment":
      body = `Hi ${firstName}, thanks for your time. If you'd like an estimate later, just reply here. Reply STOP to opt out.`;
      break;
    default:
      body = `Hi ${firstName}, thanks for chatting with ${opts.officeDisplayName}. A team member will follow up. Reply STOP to opt out.`;
  }
  try {
    await sendSms({ to: opts.phoneE164, body, from: opts.fromNumber });
    return true;
  } catch (err) {
    console.error("[sms-postcall] homeowner SMS failed:", err);
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
  outcome: string;
  appointmentAt?: string;
  summary?: string;
  dashboardOrigin: string;
}): Promise<boolean> {
  // We piggyback on notifyOfficeOfNewLead's destination resolution
  // and add a custom prefix line via the `source` field so the rep
  // sees "📅 Appt scheduled" instead of "🏠 New lead". Simplest
  // path-of-least-resistance: just send a separate SMS via sendSms
  // directly so we control the body shape, and reuse resolveNotifyPhone
  // for destination resolution.
  const dest = resolveNotifyPhone(opts.office);
  if (!dest || !twilioConfigured()) return false;

  const headline =
    opts.outcome === "appt_scheduled"
      ? `📅 New appt scheduled — ${opts.lead.name}`
      : opts.outcome === "callback_requested"
        ? `📞 Callback requested — ${opts.lead.name}`
        : opts.outcome === "voicemail"
          ? `📭 Voicemail left — ${opts.lead.name}`
          : `ℹ️ Call ended (${opts.outcome}) — ${opts.lead.name}`;

  const lines: string[] = [headline, opts.lead.address];
  if (opts.appointmentAt) lines.push(`When: ${formatAppt(opts.appointmentAt)}`);
  if (
    opts.lead.estimate_low != null &&
    opts.lead.estimate_high != null
  ) {
    lines.push(
      `Est $${opts.lead.estimate_low.toLocaleString()}–$${opts.lead.estimate_high.toLocaleString()}`,
    );
  }
  const phoneE164 = toE164(opts.lead.phone);
  if (phoneE164) lines.push(`Customer: ${phoneE164}`);
  if (opts.summary) lines.push(opts.summary);
  lines.push(`${opts.dashboardOrigin}/dashboard/leads/${opts.lead.public_id}`);

  try {
    await sendSms({
      to: dest,
      body: lines.join("\n"),
      // Send the rep alert FROM their own number too — keeps it from
      // looking like an unknown sender on the rep's phone.
      from: opts.office?.twilioNumber ?? undefined,
    });
    return true;
  } catch (err) {
    console.error("[sms-postcall] rep SMS failed:", err);
    return false;
  }
}

function formatAppt(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
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

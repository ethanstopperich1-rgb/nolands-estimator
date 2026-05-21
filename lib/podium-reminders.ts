/**
 * Podium reminder dispatcher.
 *
 * Single entrypoint: sendReminderTouchpoint(touchpoint, lead).
 *
 * The cron routes (/api/cron/podium-reminders + /api/cron/podium-abandoners)
 * already decide which lead is eligible for which touchpoint this tick.
 * This module's job is just "given a touchpoint and a lead, render the
 * message and POST to Podium."
 *
 * Soft-fail discipline (mirror lib/podium.ts):
 *   - When PODIUM_ACCESS_TOKEN / PODIUM_LOCATION_UID are unset, return
 *     { sent: false, reason: "not_configured" } and never throw.
 *   - When the phone is missing or marked opted out, skip.
 *   - When Podium returns 429, return { sent: false, reason:
 *     "rate_limited" } — caller decides whether to retry.
 *
 * Compliance constraints (locked):
 *   - reminder_opted_out hard gate — checked here (defense in depth)
 *     and in the cron's SQL filter.
 *   - "Insurance" never appears customer-facing (template + fallback
 *     copy both audited).
 *   - The opt-out keyword (STOP) is always in the body when we send
 *     fallback copy; Podium's platform handles STOP on templates per
 *     their telecom-compliance layer.
 */

import { podiumConfigured } from "@/lib/podium";
import {
  type ReminderTouchpoint,
  type ReminderVars,
  renderFallbackCopy,
  resolveTemplateUid,
} from "@/lib/reminder-templates";

export interface ReminderLead {
  publicId: string;
  name: string;
  /** E.164 or raw phone string — Podium accepts both, normalizes server-side. */
  phone: string;
  address: string;
  /** Already-resolved share URL. */
  shareUrl: string;
  /** Appointment time, UTC. Optional (only Sequence A uses it). */
  appointmentAt?: string | null;
  /** Office row hint for sender name + rep attribution. */
  repFirstName?: string | null;
  /** Hard gate — short-circuit if true. */
  optedOut: boolean;
}

export interface ReminderSendResult {
  sent: boolean;
  reason?:
    | "not_configured"
    | "opted_out"
    | "no_phone"
    | "rate_limited"
    | "error";
  /** Podium message UID on success. */
  messageUid?: string;
  error?: string;
  /** Which path served — useful for ops dashboards. */
  via?: "template" | "fallback";
}

const PODIUM_MESSAGES_URL = "https://api.podium.com/v4/messages";

/**
 * Format an appointment timestamp into America/New_York local time
 * strings the templates can interpolate. Returns empty strings when
 * appointmentAt is null (Sequence B doesn't use them).
 */
function formatAppointment(appointmentAt: string | null | undefined): {
  appointmentLocal: string;
  appointmentDayOfWeek: string;
} {
  if (!appointmentAt) {
    return { appointmentLocal: "", appointmentDayOfWeek: "" };
  }
  try {
    const dt = new Date(appointmentAt);
    if (Number.isNaN(dt.getTime())) {
      return { appointmentLocal: "", appointmentDayOfWeek: "" };
    }
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(dt);
    const dow = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
    }).format(dt);
    return { appointmentLocal: time, appointmentDayOfWeek: dow };
  } catch {
    return { appointmentLocal: "", appointmentDayOfWeek: "" };
  }
}

/**
 * Build the merge-variable bag for a single send.
 */
export function buildReminderVars(lead: ReminderLead): ReminderVars {
  const firstName = lead.name.split(/\s+/)[0] || "there";
  const { appointmentLocal, appointmentDayOfWeek } = formatAppointment(
    lead.appointmentAt,
  );
  return {
    firstName,
    address: lead.address,
    appointmentLocal,
    appointmentDayOfWeek,
    shareUrl: lead.shareUrl,
    repName: lead.repFirstName?.trim() || "the Noland's team",
  };
}

/**
 * Send one reminder touchpoint. See module header for soft-fail rules.
 */
export async function sendReminderTouchpoint(
  touchpoint: ReminderTouchpoint,
  lead: ReminderLead,
): Promise<ReminderSendResult> {
  if (lead.optedOut) {
    return { sent: false, reason: "opted_out" };
  }
  if (!lead.phone || lead.phone.trim().length < 7) {
    return { sent: false, reason: "no_phone" };
  }
  if (!podiumConfigured()) {
    return { sent: false, reason: "not_configured" };
  }

  const accessToken = process.env.PODIUM_ACCESS_TOKEN!;
  const locationUid = process.env.PODIUM_LOCATION_UID!;
  const senderName = process.env.PODIUM_SENDER_NAME ?? "Noland's Roofing";

  const vars = buildReminderVars(lead);
  const templateUid = resolveTemplateUid(touchpoint);

  // Build the Podium /v4/messages body. Two shapes:
  //   - template path: include templateUid + merge variables
  //   - fallback path: include rendered raw body
  // Podium's API tolerates either body or templateUid as the message
  // content selector; sending both lets the template override at the
  // platform side if Noland's later configures one.
  const channel = {
    type: "sms" as const,
    phoneNumber: lead.phone,
    contactName: lead.name,
  };

  const requestBody: Record<string, unknown> = {
    channel,
    locationUid,
    senderName,
    setOpenInbox: false, // Reminder threads stay scoped; rep doesn't need to triage.
  };

  let via: "template" | "fallback";
  if (templateUid) {
    requestBody.templateUid = templateUid;
    requestBody.templateVariables = vars;
    via = "template";
  } else {
    requestBody.body = renderFallbackCopy(touchpoint, vars);
    via = "fallback";
  }

  try {
    const res = await fetch(PODIUM_MESSAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (res.status === 429) {
      return { sent: false, reason: "rate_limited", via };
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return {
        sent: false,
        reason: "error",
        via,
        error: `podium_${res.status}: ${errText.slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as { data?: { uid?: string } };
    return {
      sent: true,
      via,
      messageUid: json.data?.uid,
    };
  } catch (err) {
    return {
      sent: false,
      reason: "error",
      via,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Map a touchpoint to the leads-table column that tracks "sent at"
 * timestamps. Sequence B writes to a single counter column
 * (abandoner_step) plus the universal abandoner_last_sent_at — handled
 * by the caller, not this map.
 */
export const A_TOUCHPOINT_COLUMN: Record<
  Extract<
    ReminderTouchpoint,
    | "A1_INSTANT"
    | "A2_T24H"
    | "A3_MORNING"
    | "A4_ETA"
    | "A5_POST_APPT"
  >,
  string
> = {
  A1_INSTANT: "reminder_instant_sent_at",
  A2_T24H: "reminder_t24h_sent_at",
  A3_MORNING: "reminder_morning_sent_at",
  A4_ETA: "reminder_eta_sent_at",
  A5_POST_APPT: "reminder_post_appt_sent_at",
};

/**
 * Sequence A scheduling math. Given an appointment time and "now",
 * return the highest-priority Sequence A touchpoint that is currently
 * eligible AND hasn't been sent yet. Returns null when nothing fits.
 *
 * Eligibility windows (UTC math but anchored to appointment instant):
 *   A1 INSTANT   — appointment_at within [now, now+30d] AND
 *                  reminder_instant_sent_at IS NULL
 *   A2 T24H      — appointment_at within [now+20h, now+28h]
 *   A3 MORNING   — appointment_at within [now+3h, now+7h]
 *                  (covers the typical morning-of slot)
 *   A4 ETA       — appointment_at within [now+15m, now+50m]
 *   A5 POST_APPT — appointment_at within [now-3h, now-30m]
 *
 * Tick math: cron runs every 15 min, so windows are sized to absorb
 * one missed tick without skipping the touchpoint. The narrowest is
 * A4 (~35-min window) which still tolerates 2 missed ticks before
 * we'd actually drop it.
 */
export function pickASequenceTouchpoint(
  appointmentAt: Date,
  now: Date,
  sentFlags: {
    instant: boolean;
    t24h: boolean;
    morning: boolean;
    eta: boolean;
    postAppt: boolean;
  },
): "A1_INSTANT" | "A2_T24H" | "A3_MORNING" | "A4_ETA" | "A5_POST_APPT" | null {
  const deltaMs = appointmentAt.getTime() - now.getTime();
  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;

  // A5 first — post-appointment touchpoint takes priority once the
  // appointment slot has passed, even if earlier sends were missed.
  if (deltaMs <= -30 * MIN && deltaMs >= -3 * HOUR && !sentFlags.postAppt) {
    return "A5_POST_APPT";
  }
  // A4 ETA window.
  if (deltaMs >= 15 * MIN && deltaMs <= 50 * MIN && !sentFlags.eta) {
    return "A4_ETA";
  }
  // A3 morning-of window (~3-7 hrs out).
  if (deltaMs >= 3 * HOUR && deltaMs <= 7 * HOUR && !sentFlags.morning) {
    return "A3_MORNING";
  }
  // A2 day-before window.
  if (deltaMs >= 20 * HOUR && deltaMs <= 28 * HOUR && !sentFlags.t24h) {
    return "A2_T24H";
  }
  // A1 instant — any future appointment we haven't confirmed yet.
  if (deltaMs > 0 && deltaMs <= 30 * 24 * HOUR && !sentFlags.instant) {
    return "A1_INSTANT";
  }
  return null;
}

/**
 * Sequence B scheduling math. Given the lead's created_at and the
 * current abandoner_step, decide which (if any) touchpoint fires now.
 *
 * Step-to-touchpoint:
 *   step=0 + age >= 0     → already-sent at submit by /api/gemini-roof (B1)
 *                           Cron upgrades 0→1 to mark B1 as having fired;
 *                           if you're using cron-only, treat this as "send B1".
 *                           For now we assume B1 fires from /api/gemini-roof
 *                           and the cron starts at step >= 1 needing B2.
 *   step=1 + age >= 24h   → B2 OPEN LOOP
 *   step=2 + age >= 3d    → B3 NEIGHBOR
 *   step=3 + age >= 7d    → B4 STORM ANCHOR
 *   step=4 + age >= 21d   → B5 GRACE EXIT
 *   step=5                → nothing more, ever
 *
 * Minimum-gap rule: enforce abandoner_last_sent_at >= 18h between
 * sends. Prevents accidental double-sends on cron overlap and protects
 * the customer's inbox.
 */
export function pickBSequenceTouchpoint(
  createdAt: Date,
  abandonerStep: number,
  abandonerLastSentAt: Date | null,
  now: Date,
):
  | "B2_T24H_OPEN_LOOP"
  | "B3_T3D_NEIGHBOR"
  | "B4_T7D_STORM_ANCHOR"
  | "B5_T21D_GRACE_EXIT"
  | null {
  if (abandonerStep >= 5) return null;

  const ageMs = now.getTime() - createdAt.getTime();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  // Minimum 18h gap between any two B-sequence sends.
  if (abandonerLastSentAt) {
    const sinceLast = now.getTime() - abandonerLastSentAt.getTime();
    if (sinceLast < 18 * HOUR) return null;
  }

  if (abandonerStep <= 1 && ageMs >= 1 * DAY) return "B2_T24H_OPEN_LOOP";
  if (abandonerStep === 2 && ageMs >= 3 * DAY) return "B3_T3D_NEIGHBOR";
  if (abandonerStep === 3 && ageMs >= 7 * DAY) return "B4_T7D_STORM_ANCHOR";
  if (abandonerStep === 4 && ageMs >= 21 * DAY) return "B5_T21D_GRACE_EXIT";
  return null;
}

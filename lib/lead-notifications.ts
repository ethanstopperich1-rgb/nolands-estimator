/**
 * Rep / office SMS notifications for new leads.
 *
 * Fires after a successful `/api/leads` capture so reps see the new
 * lead on their phone within seconds — same urgency-window the
 * 10-second voice handoff is built around, but as text instead of a
 * call. Useful when the homeowner did NOT consent to a voice call,
 * when the office is closed, or just as a parallel ping the rep can
 * action on their own time.
 *
 * Destination resolution (in order):
 *   1. `office.notifyPhone` — per-office config column. Not wired
 *      yet (no migration); reserved for the migration that adds the
 *      column.
 *   2. `office.inboundNumber` — the office's customer-facing main
 *      line. Common case for small offices: the same number reps
 *      already monitor for incoming customer calls.
 *   3. `LEAD_NOTIFY_PHONE` env var — single global fallback for
 *      testing + the Voxaris-internal flow before any contractor
 *      offices are deployed. E.164 format.
 *
 * Soft-fail: any failure (Twilio down, no destination resolvable,
 * opted out) is logged but does NOT break the lead capture response.
 * Reps can still find the lead in the dashboard — the SMS is the
 * speed-of-notice optimization, not the system of record.
 *
 * Compliance: rep notifications are INTERNAL operator messages, not
 * consumer marketing, so they're NOT subject to TCPA marketing
 * consent. They ARE still subject to opt-out: if a rep texted STOP
 * to the Twilio number, we honor that. The `skipOptOutCheck: true`
 * flag on `sendSms` is reserved for STOP/HELP auto-replies and not
 * used here.
 */

import { sendSms, toE164, twilioConfigured, SmsOptedOutError } from "@/lib/twilio";
import type { OfficeBranding } from "@/lib/supabase";

export interface NewLeadNotificationPayload {
  /** Public ID (`lead_<32-hex>`) — used to build the dashboard deep link. */
  leadPublicId: string;
  /** Homeowner name as they typed it. */
  name: string;
  /** Property address, formatted. */
  address: string;
  /** Homeowner phone in any input format; will be normalized to E.164. */
  phone: string | null | undefined;
  /** Estimate low/high if the customer reached that step. */
  estimateLow?: number | null;
  estimateHigh?: number | null;
  /** Detected material slug (`asphalt-architectural`, etc.) if any. */
  material?: string | null;
  /** Final sloped sqft from the V3 response if available. */
  sqft?: number | null;
  /** Source label — `Pitch.voxaris.io`, partner subdomain, etc. */
  source?: string | null;
}

/** Resolve the destination phone for office-side lead alerts, in
 *  priority order. Returns null when nothing is configured (caller
 *  treats null as "no notification this lead"). */
export function resolveNotifyPhone(
  office: OfficeBranding | null,
): string | null {
  // Future: prefer `office.notifyPhone` when the column lands. For
  // now `OfficeBranding` doesn't expose a dedicated field, so we go
  // straight to `inboundNumber` and the env fallback.
  const candidates: Array<string | null | undefined> = [
    office?.inboundNumber,
    process.env.LEAD_NOTIFY_PHONE,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const e164 = toE164(c);
    if (e164) return e164;
  }
  return null;
}

/**
 * Compose the SMS body. Designed to fit in a single 160-char
 * segment when possible — but explicitly allows multi-segment when
 * the property + estimate range pushes past the limit. Twilio
 * charges per segment; the rep-side audience is small so the cost
 * is negligible vs the speed-of-notice value.
 */
export function buildNewLeadSmsBody(
  payload: NewLeadNotificationPayload,
  dashboardOrigin: string,
): string {
  const lines: string[] = [];
  lines.push(`🏠 New Voxaris lead — ${payload.name}`);
  lines.push(payload.address);

  if (payload.estimateLow != null && payload.estimateHigh != null) {
    const lo = payload.estimateLow.toLocaleString();
    const hi = payload.estimateHigh.toLocaleString();
    const sqftBit =
      payload.sqft != null ? ` · ${payload.sqft.toLocaleString()} sqft` : "";
    lines.push(`Est $${lo}–$${hi}${sqftBit}`);
  }

  const phoneE164 = toE164(payload.phone);
  if (phoneE164) {
    lines.push(`Call: ${phoneE164}`);
  }

  // Deep link to the lead report page. Reps tap it and land on the
  // exact same painted-overlay + tier breakdown the customer saw.
  lines.push(`${dashboardOrigin}/dashboard/leads/${payload.leadPublicId}`);
  return lines.join("\n");
}

/**
 * Fire the rep-notification SMS. Fire-and-forget at the call site —
 * this function only returns null/error for telemetry purposes.
 *
 * @returns `{ sid, status }` on success; `null` on any failure
 *          (Twilio not configured, no destination, send failed, or
 *          recipient opted out). Errors are logged inside.
 */
export async function notifyOfficeOfNewLead(opts: {
  office: OfficeBranding | null;
  lead: NewLeadNotificationPayload;
  /** Origin of the dashboard for building the deep-link URL.
   *  Usually `https://pitch.voxaris.io` in production or
   *  `process.env.VERCEL_URL`-derived in preview. */
  dashboardOrigin: string;
}): Promise<{ sid: string; status: string } | null> {
  if (!twilioConfigured()) {
    console.log("[lead-notify] twilio_not_configured — skipping rep SMS");
    return null;
  }

  const destination = resolveNotifyPhone(opts.office);
  if (!destination) {
    console.log(
      "[lead-notify] no_destination — neither office.inboundNumber nor LEAD_NOTIFY_PHONE is set; skipping rep SMS",
    );
    return null;
  }

  const body = buildNewLeadSmsBody(opts.lead, opts.dashboardOrigin);

  try {
    const result = await sendSms({
      to: destination,
      body,
      // Rep notifications are operator messages, not consumer
      // marketing. Still gated by opt-out — if a rep texted STOP, the
      // gate respects it (and we log + move on; the rep will need to
      // text START to resume notifications).
    });
    console.log("[lead-notify] sent rep alert", {
      leadPublicId: opts.lead.leadPublicId,
      destination,
      sid: result.sid,
      status: result.status,
    });
    return { sid: result.sid, status: result.status };
  } catch (err) {
    if (err instanceof SmsOptedOutError) {
      console.log(
        "[lead-notify] destination opted out — rep notifications paused for",
        destination,
      );
      return null;
    }
    console.error(
      "[lead-notify] send failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

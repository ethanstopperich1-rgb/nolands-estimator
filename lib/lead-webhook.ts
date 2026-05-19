/**
 * Lead webhook — the provider-agnostic outbound integration point.
 *
 * Contractors don't all use the same customer-messaging stack. Many
 * already run Podium for two-way SMS with homeowners; others use
 * HighLevel, Birdeye, BoomTown, JobNimbus, or a hand-rolled Zapier
 * funnel. Voxaris should NOT force every office through our Twilio
 * sender — instead we publish a clean, versioned "new lead" event
 * and let each office pipe it into whichever platform they already
 * pay for.
 *
 * Resolution order for the destination URL (first non-empty wins):
 *   1. `office.leadWebhookUrl` — per-office column (NOT in the schema
 *      yet; reserved for the migration that adds it).
 *   2. `LEAD_WEBHOOK_URL` env — global fallback for testing + the
 *      Voxaris-internal flow. Same env var already referenced by
 *      `lib/sms-conversation.ts` in its comments, kept consistent.
 *
 * Auth: HMAC-SHA256 signature over the raw JSON body, sent in the
 * `X-Voxaris-Signature` header. The signing secret is
 * `LEAD_WEBHOOK_SECRET` (per-office column reserved for future). The
 * receiving platform verifies the signature before acting on the
 * payload, which gives Podium / HighLevel / etc. defense against a
 * spoofed POST.
 *
 * Schema versioning: every payload carries `schema_version` so a
 * future shape change doesn't break a contractor's downstream
 * automation. Bump the version when you change required fields;
 * add nullable fields without bumping.
 *
 * Soft-fail: any transport or 4xx/5xx is logged but does NOT break
 * lead capture. Same discipline as the rep-notification SMS.
 *
 * Cost / latency: fire-and-forget POST with a 5s AbortSignal so a
 * slow receiver can't park a serverless function instance.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { OfficeBranding } from "@/lib/supabase";

/** Bump this when required fields change. Add nullable fields freely. */
export const LEAD_WEBHOOK_SCHEMA_VERSION = "1.0.0";

export interface LeadWebhookEvent {
  /** Stable schema version — receivers can branch on this. */
  schema_version: string;
  /** Event type. Today only `new_lead`; future: `appt_scheduled`,
   *  `call_completed`, `consent_updated`, etc. */
  event: "new_lead" | "appt_scheduled" | "call_completed";
  /** ISO 8601 UTC. */
  occurred_at: string;
  /** Tenancy. The receiver should scope writes by this. */
  office: {
    id: string;
    slug: string;
    display_name: string;
  };
  lead: {
    /** Public ID (`lead_<32-hex>`). Stable across the lead's lifetime. */
    public_id: string;
    name: string;
    email: string | null;
    phone_raw: string | null;
    phone_e164: string | null;
    address: string;
    /** From the V3 pipeline if the homeowner reached final submit. */
    estimate_low: number | null;
    estimate_high: number | null;
    material: string | null;
    estimated_sqft: number | null;
    /** Source label — `pitch.voxaris.io`, partner subdomain, etc. */
    source: string | null;
    /** Deep link to the full report inside the contractor's dashboard. */
    report_url: string;
  };
  /** Free-form fields for the receiver's pipeline. Today empty;
   *  future: `appointment_at`, `call_summary`, etc. */
  extras?: Record<string, unknown>;
}

export interface LeadWebhookResolved {
  url: string;
  secret: string | null;
  source: "office" | "env";
}

/** Find the destination URL + signing secret for an office. Returns
 *  null when nothing's configured (caller treats null as "no webhook
 *  this event"). */
export function resolveLeadWebhook(
  // Today `OfficeBranding` doesn't carry the columns yet; the
  // signature accepts a wider shape so the future migration drops
  // straight in.
  office:
    | (OfficeBranding & {
        leadWebhookUrl?: string | null;
        leadWebhookSecret?: string | null;
      })
    | null,
): LeadWebhookResolved | null {
  const officeUrl = office && "leadWebhookUrl" in office ? office.leadWebhookUrl : null;
  const officeSecret =
    office && "leadWebhookSecret" in office ? office.leadWebhookSecret : null;
  if (officeUrl) {
    return {
      url: officeUrl,
      secret: officeSecret ?? null,
      source: "office",
    };
  }
  const envUrl = process.env.LEAD_WEBHOOK_URL;
  if (envUrl) {
    return {
      url: envUrl,
      secret: process.env.LEAD_WEBHOOK_SECRET ?? null,
      source: "env",
    };
  }
  return null;
}

/** Sign a JSON body with the configured HMAC-SHA256 secret. Returns
 *  the base64 signature. Receivers verify by recomputing over the
 *  raw body and comparing in constant time. */
export function signLeadWebhookBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

/** Constant-time signature verification. For use by routes that
 *  receive webhooks back from Voxaris (none today, but the helper
 *  belongs alongside the signer). */
export function verifyLeadWebhookSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const expected = signLeadWebhookBody(body, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * POST the event to the configured webhook. Soft-fails on every
 * error path — returns `null` so the caller can decide whether to
 * log telemetry, but never throws.
 */
export async function publishLeadEvent(opts: {
  office: Parameters<typeof resolveLeadWebhook>[0];
  event: LeadWebhookEvent;
}): Promise<{ ok: true; status: number } | null> {
  const target = resolveLeadWebhook(opts.office);
  if (!target) return null;

  const body = JSON.stringify(opts.event);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "voxaris-lead-webhook/1.0",
    "x-voxaris-event": opts.event.event,
    "x-voxaris-schema-version": opts.event.schema_version,
  };
  if (target.secret) {
    headers["x-voxaris-signature"] = signLeadWebhookBody(body, target.secret);
  }

  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error("[lead-webhook] non-2xx response", {
        status: res.status,
        event: opts.event.event,
        public_id: opts.event.lead.public_id,
        source: target.source,
      });
      return null;
    }
    console.log("[lead-webhook] published", {
      event: opts.event.event,
      public_id: opts.event.lead.public_id,
      status: res.status,
      source: target.source,
    });
    return { ok: true, status: res.status };
  } catch (err) {
    console.error("[lead-webhook] transport failed", {
      event: opts.event.event,
      public_id: opts.event.lead.public_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

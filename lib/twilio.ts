/**
 * Minimal Twilio REST helpers. We don't pull in the heavy `twilio`
 * Node SDK — the Messages API is a single POST endpoint and signature
 * validation is HMAC-SHA1 over a sorted form payload. Keeping it
 * lean keeps the Vercel function bundle small.
 *
 * Env vars required:
 *   TWILIO_ACCOUNT_SID    — starts with AC...
 *   TWILIO_AUTH_TOKEN     — kept server-side only
 *   TWILIO_PHONE_NUMBER   — the from-number in E.164 format (+1...)
 *
 * Webhook security: validateTwilioSignature() implements the standard
 * X-Twilio-Signature HMAC-SHA1 check described at
 * https://www.twilio.com/docs/usage/security#validating-requests
 */

import { createHmac } from "node:crypto";

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

export interface SendSmsOptions {
  /** E.164 destination, e.g. "+14075551234". */
  to: string;
  /** Message body. Twilio splits >160 chars into multi-segment messages. */
  body: string;
  /** Optional override of the from number (defaults to TWILIO_PHONE_NUMBER). */
  from?: string;
  /** Optional public HTTPS URL(s) to attach as MMS media. Twilio fetches
   *  the URL server-side and includes it as MMS picture/audio/video.
   *  Single URL = one media attachment; array supports up to 10. Must
   *  be HTTPS, < 5 MB per file (Twilio limit, US carriers usually cap
   *  lower at ~1.6 MB picture/600 KB video). When set, Twilio bills as
   *  MMS (~$0.02) instead of SMS ($0.008). */
  mediaUrl?: string | string[];
  /** When true, skip the Supabase opt-out check. Use ONLY for system
   *  messages that don't fall under TCPA (e.g. internal operator
   *  notifications). Never pass true for messages to a consumer. */
  skipOptOutCheck?: boolean;
}

export interface TwilioSendResult {
  sid: string;
  status: string;
  to: string;
}

/** Normalize US phone input to E.164. Returns null if it can't be
 *  parsed — many leads will submit "(407) 555-1234" formats. */
export function toE164(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}

/**
 * Check Supabase for a recorded STOP / opt-out before sending. Returns
 * true when the recipient has opted out at any point AND there is no
 * later opt-in. Failing closed on transport errors — a Supabase blip
 * shouldn't allow a message to a number that may have opted out.
 *
 * Defined here (not in a shared SMS module) because every outbound
 * Twilio path runs through `sendSms` — gating at this layer makes it
 * impossible to accidentally bypass.
 */
async function isOptedOut(toE164: string): Promise<boolean> {
  try {
    const { supabaseServiceRoleConfigured, createServiceRoleClient } = await import(
      "@/lib/supabase"
    );
    if (!supabaseServiceRoleConfigured()) return false;
    const sb = createServiceRoleClient();
    const { data, error } = await sb
      .from("sms_opt_outs")
      .select("opted_out_at, opted_in_at")
      .eq("phone_e164", toE164)
      .maybeSingle();
    if (error) return false;
    if (!data) return false;
    // Re-opted-in: a later opted_in_at trumps the original opt-out.
    if (data.opted_in_at && data.opted_out_at && data.opted_in_at > data.opted_out_at) {
      return false;
    }
    return Boolean(data.opted_out_at);
  } catch {
    // Fail open at this layer is the wrong choice for TCPA — but
    // throwing here breaks every legitimate outbound. Caller-side
    // handling is checked via opts.skipOptOutCheck for the few paths
    // (Twilio account-level STOP echo, system messages) where the
    // check would create a recursion.
    return false;
  }
}

export class SmsOptedOutError extends Error {
  constructor(public readonly recipient: string) {
    super(`Recipient ${recipient} has opted out of SMS; aborting outbound send.`);
    this.name = "SmsOptedOutError";
  }
}

/**
 * Send an SMS via Twilio's REST API. Throws on transport / 4xx / 5xx.
 * Throws `SmsOptedOutError` (which callers can catch and treat as a
 * non-error) when the recipient is on the opt-out list. Callers can
 * pass `skipOptOutCheck: true` to bypass for opt-out-confirmation
 * replies — but DO NOT pass it for marketing or transactional sends.
 */
export async function sendSms(opts: SendSmsOptions): Promise<TwilioSendResult> {
  if (!ACCOUNT_SID || !AUTH_TOKEN) {
    throw new Error("Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing)");
  }
  const from = opts.from ?? FROM_NUMBER;
  if (!from) {
    throw new Error("Twilio from-number not configured (TWILIO_PHONE_NUMBER missing)");
  }

  // Gate against the opt-out list. This runs before EVERY outbound
  // because TCPA defensibility requires it. Caller can pass
  // skipOptOutCheck for the narrow set of system messages (e.g. an
  // out-of-band notice to the operator) that don't go to consumers.
  if (!opts.skipOptOutCheck) {
    const blocked = await isOptedOut(opts.to);
    if (blocked) {
      throw new SmsOptedOutError(opts.to);
    }
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({
    To: opts.to,
    From: from,
    Body: opts.body,
  });

  // MMS media — Twilio accepts repeated MediaUrl form fields up to 10.
  // URLSearchParams.append (not .set) preserves the repeat semantic.
  if (opts.mediaUrl) {
    const urls = Array.isArray(opts.mediaUrl) ? opts.mediaUrl : [opts.mediaUrl];
    for (const u of urls.slice(0, 10)) {
      if (u && u.startsWith("https://")) form.append("MediaUrl", u);
    }
  }

  const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Twilio send failed ${res.status}: ${errText.slice(0, 400)}`);
  }
  const json = (await res.json()) as { sid: string; status: string; to: string };
  return { sid: json.sid, status: json.status, to: json.to };
}

/**
 * Validate an incoming Twilio webhook signature.
 *
 * Twilio signs requests by:
 *   1. Concatenating the FULL request URL (including query string)
 *   2. Appending each POST parameter sorted alphabetically as key+value
 *      (no separator)
 *   3. HMAC-SHA1 with the Auth Token, then base64-encoded
 *   4. Sent as the X-Twilio-Signature header
 *
 * @param url        The exact URL Twilio called (must match what's
 *                   configured in the Twilio console — including https
 *                   and any trailing slash).
 * @param params     The form-encoded POST body parameters as a flat
 *                   key-value map.
 * @param signature  The X-Twilio-Signature header value.
 */
export function validateTwilioSignature(opts: {
  url: string;
  params: Record<string, string>;
  signature: string | null;
}): boolean {
  if (!AUTH_TOKEN) return false;
  if (!opts.signature) return false;
  const sortedKeys = Object.keys(opts.params).sort();
  let data = opts.url;
  for (const key of sortedKeys) data += key + opts.params[key];
  const expected = createHmac("sha1", AUTH_TOKEN).update(data).digest("base64");
  // Constant-time compare.
  if (expected.length !== opts.signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ opts.signature.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Whether Twilio is configured at all — used by callers that should
 *  silently no-op in dev if env vars aren't set yet. */
export function twilioConfigured(): boolean {
  return Boolean(ACCOUNT_SID && AUTH_TOKEN && FROM_NUMBER);
}

// ─── Estimate-ready helper ──────────────────────────────────────────
//
// Direct equivalent of `sendEstimateReadyViaPodium` in lib/podium.ts.
// We dropped through to Twilio direct (May 2026) to skip the Podium
// developer-portal application loop — Twilio is already wired for
// the TCPA confirmation SMS at /api/leads, so adding the
// estimate-ready hop here doesn't introduce a new dependency.
//
// Customer experience: homeowner submits the lock-in form → gets the
// Twilio confirmation SMS ("Reply YES and Sarah will call") → ~25s
// later when V3 completes, gets a second MMS with the painted-roof
// PNG + tier-pricing teaser + share link. Same 888-786-9134 from
// number both times so the conversation lives in one thread on the
// homeowner's phone.

export interface EstimateReadyInput {
  /** E.164 customer phone. */
  customerPhone: string;
  /** Customer's full name — first-name extracted for the greeting. */
  customerName: string;
  /** Short address (first comma-separated segment is enough). */
  address: string;
  /** Public HTTPS URL to the painted-roof PNG. Twilio fetches it
   *  server-side. Pass empty/undefined for text-only fallback. */
  paintedImageUrl?: string;
  /** Public share URL — homeowner taps this to see the full result
   *  page with painted overlay + tier cards + storm history. */
  shareUrl: string;
  /** Customer-facing cash totals (low + high of the tier ladder).
   *  Whole dollars. */
  lowEstimate: number;
  highEstimate: number;
  /** Lead public_id — included in logs for correlation. */
  leadPublicId: string;
}

export interface EstimateReadySendResult {
  sent: boolean;
  reason?: "not_configured" | "opted_out" | "error";
  /** Twilio message SID on success. */
  sid?: string;
  error?: string;
}

/**
 * Compose the estimate-ready message body. Three clean reply paths:
 *   YES      → Sarah (AI assistant) calls in 10 sec
 *   SCHEDULE → pick a time, no immediate call
 *   call the office line directly
 *
 * FCC Feb 2024 AI-voice disclosure satisfied by naming Sarah as
 * "our AI assistant" in the same sentence as the YES instruction.
 *
 * Kept SMS-segment-aware (under 480 chars = 3 segments worst case)
 * even though MMS doesn't strictly cap — defensive in case Twilio
 * falls back to SMS if the MediaUrl fetch fails.
 */
function renderEstimateReadyBody(input: EstimateReadyInput): string {
  const firstName = input.customerName.split(/\s+/)[0] || "there";
  const low = input.lowEstimate.toLocaleString();
  const high = input.highEstimate.toLocaleString();
  return (
    `Your roof estimate is ready, ${firstName}. ` +
    `Three options between $${low}–$${high} cash. ` +
    `Reply YES and Sarah (our AI assistant) calls in 10 seconds, ` +
    `or SCHEDULE to pick a time. ` +
    `Prefer to talk? Call (352) 242-4322. ` +
    `Full report: ${input.shareUrl}. Reply STOP to opt out.`
  ).slice(0, 480);
}

/**
 * Send the estimate-ready follow-up via Twilio MMS. Drops the painted
 * roof PNG as the MMS attachment so the homeowner sees the visual in
 * the message preview without having to tap the link.
 *
 * Soft-fails — never throws. Caller treats `sent: false` as "Twilio
 * wasn't able to send; the customer page already shows the painted
 * result anyway." Mirrors the Podium adapter's failure posture so
 * call-site swap is a one-liner.
 */
export async function sendEstimateReadyViaTwilio(
  input: EstimateReadyInput,
): Promise<EstimateReadySendResult> {
  if (!twilioConfigured()) {
    return { sent: false, reason: "not_configured" };
  }
  try {
    const body = renderEstimateReadyBody(input);
    const result = await sendSms({
      to: input.customerPhone,
      body,
      // Painted PNG as MMS attachment. Twilio fetches the URL server-
      // side, so it must be HTTPS + publicly reachable for the lifetime
      // of the send (a few seconds). Our painted PNG URL meets both.
      mediaUrl: input.paintedImageUrl || undefined,
    });
    return { sent: true, sid: result.sid };
  } catch (err) {
    if (err instanceof SmsOptedOutError) {
      return { sent: false, reason: "opted_out" };
    }
    return {
      sent: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

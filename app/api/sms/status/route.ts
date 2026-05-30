import { checkPayloadSize, PAYLOAD_LIMITS } from "@/lib/payload-guard";
import { twilioConfigured, validateTwilioSignature } from "@/lib/twilio";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";

export const runtime = "nodejs";

/**
 * POST /api/sms/status
 *
 * Twilio delivery-status callback webhook. Configure this URL as the
 * `StatusCallback` on outbound message sends (lib/twilio.ts threads
 * `statusCallback` into the Messages API create call):
 *
 *   https://<your-domain>/api/sms/status   (HTTP POST)
 *
 * Twilio posts an application/x-www-form-urlencoded body as the message
 * advances queued → sending → sent → delivered / undelivered / failed,
 * with at least:
 *   - MessageSid     the SID of the message being reported on
 *   - MessageStatus  the new lifecycle status
 *   - ErrorCode      Twilio error code on failure (e.g. 30007, 21610)
 *
 * Flow:
 *   1. Validate X-Twilio-Signature so a forged POST can't rewrite our
 *      sms_messages audit rows.
 *   2. UPSERT-by-update the sms_messages row WHERE message_sid =
 *      MessageSid: status = MessageStatus, error_code = ErrorCode
 *      (nullable), updated_at = now().
 *   3. Soft-fail everywhere — always ACK Twilio with 200 + empty TwiML
 *      so it doesn't retry a callback we've already absorbed.
 */
export async function POST(req: Request) {
  // Status callbacks are form-encoded and tiny. Cap at 100 KB so a
  // forged POST can't pre-buffer megabytes before we verify the
  // signature.
  const oversized = checkPayloadSize(req, { maxBytes: PAYLOAD_LIMITS.normal });
  if (oversized) return oversized;
  if (!twilioConfigured()) {
    return new Response("Twilio not configured", { status: 503 });
  }

  // Twilio always posts URL-encoded.
  const raw = await req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;

  // Validate signature. The URL Twilio signs MUST match exactly — we
  // reconstruct from the request, but if you front this behind a proxy
  // that rewrites the host, set TWILIO_WEBHOOK_URL_OVERRIDE.
  const url =
    process.env.TWILIO_WEBHOOK_URL_OVERRIDE ??
    req.url.replace(/^http:\/\//, "https://");
  const signature = req.headers.get("x-twilio-signature");
  if (!validateTwilioSignature({ url, params, signature })) {
    console.warn("[sms-status] invalid Twilio signature");
    return new Response("Forbidden", { status: 403 });
  }

  const messageSid = (params.MessageSid ?? "").trim();
  const messageStatus = (params.MessageStatus ?? "").trim();
  // ErrorCode is present + non-empty only on failed / undelivered.
  const errorCode = (params.ErrorCode ?? "").trim() || null;

  // No MessageSid / status to act on — ACK so Twilio stops retrying.
  if (!messageSid || !messageStatus) {
    return new Response("<Response/>", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }

  // Update the durable mirror of the Twilio message lifecycle. Soft-
  // fails: a Supabase blip / missing table / unconfigured service role
  // must never bounce the callback (Twilio would retry, and the audit
  // row is best-effort). `as any` because sms_messages (migration 0025)
  // isn't in the generated Supabase types yet — same pattern as
  // lib/twilio.ts:recordOutboundSms.
  if (supabaseServiceRoleConfigured()) {
    try {
      const sb = createServiceRoleClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (sb as any)
        .from("sms_messages")
        .update({
          status: messageStatus,
          error_code: errorCode,
          updated_at: new Date().toISOString(),
        })
        .eq("message_sid", messageSid);
    } catch (err) {
      console.error("[sms-status] sms_messages update threw:", err);
    }
  } else {
    console.warn(
      "[sms-status] status NOT persisted — Supabase service role unconfigured.",
    );
  }

  // ACK Twilio with empty TwiML so it doesn't queue a retry.
  return new Response("<Response/>", {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

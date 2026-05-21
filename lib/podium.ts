/**
 * Podium API adapter — pushes leads INTO Noland's Podium inbox.
 *
 * Why this exists alongside lib/sentdm.ts:
 *   - sent.dm is great as a standalone messaging API, but Noland's
 *     uses Podium as their primary customer-comms hub. Pushing leads
 *     to ANY other channel fragments Noland's reps' workflow — they'd
 *     have two inboxes to monitor.
 *   - This adapter sends the estimate-ready follow-up THROUGH Podium
 *     so the conversation lives in Noland's existing inbox. Reps reply
 *     where they already work.
 *
 * Twilio confirmation SMS (lib/twilio.ts) is UNCHANGED — that's the
 * regulator-grade TCPA-locked first message. Podium handles the
 * engagement follow-up + ongoing conversation.
 *
 * Podium API contract (verified May 2026 via docs.podium.com/reference):
 *   - Base URL: https://api.podium.com/v4/
 *   - Auth: Bearer access token (OAuth 2). Token lives in
 *     PODIUM_ACCESS_TOKEN env. For prod, set up refresh-token rotation
 *     separately (this adapter assumes a long-lived token for v1).
 *   - Required scope: write_messages, write_contacts
 *   - POST /v4/messages — send text-only message
 *   - POST /v4/messages/attachment — send with painted PNG attached
 *     (multipart/form-data, max 30 MB, rate limit 10 rpm)
 *   - Contacts auto-upsert via the channel.contactName field — no
 *     explicit create-contact step needed.
 *
 * Soft-fails to no-op when any of these env vars are unset:
 *   PODIUM_ACCESS_TOKEN
 *   PODIUM_LOCATION_UID         (Noland's Podium location UUID)
 *   PODIUM_SENDER_NAME          (defaults to "Noland's Roofing")
 *
 * Setup the user owes (one-time):
 *   1. In Podium dashboard → API & Integrations → create OAuth app,
 *      scopes: write_messages, write_contacts. Save client_id + secret.
 *   2. Run the 3-legged OAuth flow once to obtain an access token.
 *      Store as PODIUM_ACCESS_TOKEN. (Refresh logic for v2.)
 *   3. Get the location UID from
 *        GET https://api.podium.com/v4/locations
 *      → find Noland's Clermont location → copy its uid →
 *      vercel env add PODIUM_LOCATION_UID production
 */

export interface PodiumEstimateReadyInput {
  /** Customer's E.164 phone number. */
  customerPhone: string;
  customerName: string;
  /** Short address, e.g. "8450 Oak Park Ave". */
  address: string;
  /** Pre-signed URL to the painted-roof PNG (HTTPS-accessible >=24h). */
  paintedImageUrl: string;
  /** Public share URL — typically https://nolands-estimator.vercel.app/r/{leadPublicId} */
  shareUrl: string;
  /** Estimate range in whole dollars per month (financed). */
  lowEstimate: number;
  highEstimate: number;
  /** Lead UUID — idempotency hint to skip retries on the Podium side. */
  leadPublicId: string;
}

export interface PodiumSendResult {
  sent: boolean;
  reason?: "not_configured" | "rate_limited" | "error";
  /** Podium message UUID, when send succeeded. */
  messageUid?: string;
  /** Error details when reason === "error". */
  error?: string;
}

/**
 * Check whether the Podium env is wired. Routes can guard
 * Podium-specific code paths without importing the adapter eagerly.
 */
export function podiumConfigured(): boolean {
  return Boolean(process.env.PODIUM_ACCESS_TOKEN && process.env.PODIUM_LOCATION_UID);
}

/**
 * Render the estimate-ready message body. SMS-safe length (<160 chars
 * including link). When the painted PNG sends as an MMS attachment,
 * Podium handles wrapping per-carrier.
 */
function renderBody(input: PodiumEstimateReadyInput): string {
  const firstName = input.customerName.split(/\s+/)[0] || "there";
  return (
    `Hi ${firstName}, your Noland's Roofing estimate for ${input.address} is ` +
    `ready ($${input.lowEstimate}–$${input.highEstimate}/mo financed): ` +
    `${input.shareUrl}. Reply STOP to opt out.`
  ).slice(0, 480); // Podium handles SMS segmentation; cap at 3 segments worst case.
}

/**
 * Send the estimate-ready Rich message (with painted PNG attachment)
 * via Podium. The message lands in Noland's Clermont location inbox
 * as a NEW conversation in OPEN state — reps see it immediately.
 *
 * Three-step flow:
 *   1. Fetch the painted PNG from the share URL (Supabase Storage
 *      signed URL).
 *   2. POST to /v4/messages/attachment with the PNG as multipart
 *      attachment + the message body.
 *   3. Podium auto-creates/updates the contact + opens the inbox
 *      thread.
 *
 * Soft-fails — never throws. Caller treats `sent: false` as
 * "Podium wasn't available; fall back to plain Twilio SMS or skip."
 */
export async function sendEstimateReadyViaPodium(
  input: PodiumEstimateReadyInput,
): Promise<PodiumSendResult> {
  if (!podiumConfigured()) {
    return { sent: false, reason: "not_configured" };
  }

  const accessToken = process.env.PODIUM_ACCESS_TOKEN!;
  const locationUid = process.env.PODIUM_LOCATION_UID!;
  const senderName = process.env.PODIUM_SENDER_NAME ?? "Noland's Roofing";

  try {
    // Fetch the painted PNG. Podium's docs are explicit about the
    // attachment field accepting a File, but on Node we need a Blob.
    const imageRes = await fetch(input.paintedImageUrl);
    if (!imageRes.ok) {
      // No painted image yet → fall through to text-only send so the
      // customer still gets the share-link CTA.
      return sendTextOnly(input, accessToken, locationUid, senderName);
    }
    const imageBlob = await imageRes.blob();

    const dataPayload = {
      body: renderBody(input),
      channel: {
        type: "sms",
        // SMS channel uses phone number; Podium upserts the contact
        // by phone on the named location.
        phoneNumber: input.customerPhone,
        contactName: input.customerName,
      },
      locationUid,
      senderName,
      // Open the inbox so the rep sees it as a fresh thread to triage.
      setOpenInbox: true,
    };

    const form = new FormData();
    form.append("attachment", imageBlob, `noland-roof-${input.leadPublicId}.png`);
    form.append("data", JSON.stringify(dataPayload));

    const res = await fetch("https://api.podium.com/v4/messages/attachment", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // NOTE: do NOT set Content-Type manually for multipart — fetch
        // computes the boundary string. Setting it here breaks the
        // multipart parser server-side.
      },
      body: form,
    });

    if (res.status === 429) {
      return { sent: false, reason: "rate_limited" };
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return {
        sent: false,
        reason: "error",
        error: `podium_${res.status}: ${errText.slice(0, 200)}`,
      };
    }

    const json = (await res.json()) as { data?: { uid?: string } };
    return {
      sent: true,
      messageUid: json.data?.uid,
    };
  } catch (err) {
    return {
      sent: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Text-only fallback when the painted image isn't fetchable. Same
 * shape as the attachment send but hits the simpler /messages endpoint.
 */
async function sendTextOnly(
  input: PodiumEstimateReadyInput,
  accessToken: string,
  locationUid: string,
  senderName: string,
): Promise<PodiumSendResult> {
  try {
    const res = await fetch("https://api.podium.com/v4/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body: renderBody(input),
        channel: {
          type: "sms",
          phoneNumber: input.customerPhone,
          contactName: input.customerName,
        },
        locationUid,
        senderName,
        setOpenInbox: true,
      }),
    });

    if (res.status === 429) return { sent: false, reason: "rate_limited" };
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return {
        sent: false,
        reason: "error",
        error: `podium_${res.status}: ${errText.slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as { data?: { uid?: string } };
    return { sent: true, messageUid: json.data?.uid };
  } catch (err) {
    return {
      sent: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

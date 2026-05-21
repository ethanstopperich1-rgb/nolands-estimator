/**
 * sent.dm wrapper — unified SMS / WhatsApp / RCS messaging.
 *
 * Why this exists alongside lib/twilio.ts:
 *   - Twilio handles the TCPA-locked confirmation SMS at /api/leads and
 *     Sydney's voice SIP routing. That flow is regulator-grade and not
 *     touched here.
 *   - sent.dm is for HIGH-ENGAGEMENT outbound where we want the message
 *     to render richly when possible: the share-page link (rich card
 *     with the painted-roof image + tier pricing), an inspection-ready
 *     reminder, or any future MMS/RCS-style touchpoint.
 *
 * DSN-gated pattern (mirrors lib/recaptcha.ts + Sentry):
 *   - If SENT_API_KEY is unset, `sendUnifiedMessage()` returns
 *     `{ sent: false, reason: "not_configured" }` without throwing.
 *   - Production code can call this freely; non-prod / forks without
 *     a sent.dm account stay green.
 *
 * NEVER replaces lib/twilio.ts for the TCPA confirmation SMS. The
 * consent flow at /api/leads is intentionally Twilio-only — switching
 * providers there requires re-verifying 10DLC + re-validating the
 * consent text + re-running the TCPA audit. Out of scope.
 *
 * Pricing reference (May 2026 per sent.dm/en):
 *   - Pay-as-you-go: $0.015/contact/month + carrier fees passed through
 *   - Sandbox mode: `sandbox: true` in request, no real send, no $
 *
 * Docs: https://docs.sent.dm/llms-full.txt
 */

import SentDm from "@sentdm/sentdm";

/** Lazy singleton — created on first call so the module can be
 *  imported safely in routes that may never invoke it. */
let _client: SentDm | null = null;
function getClient(): SentDm | null {
  const key = process.env.SENT_API_KEY;
  if (!key) return null;
  if (_client) return _client;
  // Constructor pulls from SENT_API_KEY env automatically per the
  // SDK README; explicit pass-through keeps the intent obvious in
  // code review.
  _client = new SentDm({ apiKey: key });
  return _client;
}

export interface SendMessageInput {
  /** E.164 phone number(s). The SDK accepts an array — most use cases
   *  here are single-recipient. */
  to: string | string[];
  /** sent.dm template — referenced by UUID + name. Templates are
   *  authored in the sent.dm dashboard or via POST /v3/templates. The
   *  same template renders as SMS or RCS or WhatsApp depending on what
   *  channels the recipient supports. */
  template: { id: string; name: string };
  /** Variables substituted into the template. Schema is defined by
   *  the template itself. */
  variables?: Record<string, string | number | boolean>;
  /** Optional explicit channel preference. Defaults to letting sent.dm
   *  pick the best available channel for the recipient. */
  channels?: Array<"sms" | "whatsapp" | "rcs">;
  /** When true, validates the request and returns realistic response
   *  shape without sending. Use in unit tests + preview deploys. */
  sandbox?: boolean;
  /** Idempotency key — 24h dedup cache per customer. Prevents
   *  double-sends on webhook retries. */
  idempotencyKey?: string;
}

export interface SendMessageResult {
  sent: boolean;
  /** Reason for non-send. "not_configured" when SENT_API_KEY missing,
   *  "sandbox" when running in sandbox mode, "error" on API failure. */
  reason?: "not_configured" | "sandbox" | "error";
  /** Per-recipient message IDs returned by sent.dm. Track via
   *  GET /v3/messages/{id} or webhook for delivery status. */
  messageIds?: string[];
  /** Error details when reason === "error". */
  error?: string;
}

/**
 * Send a templated message via sent.dm's unified channel router.
 *
 * Returns immediately with per-recipient message IDs. Tracks delivery
 * via webhooks (configure separately in the sent.dm dashboard at
 * /dashboard/webhooks).
 *
 * Soft-fails — never throws. Caller treats `sent: false` as "the
 * channel wasn't available; try the Twilio path or skip the send."
 */
export async function sendUnifiedMessage(
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const client = getClient();
  if (!client) {
    return { sent: false, reason: "not_configured" };
  }

  try {
    // The SDK type is broad — we cast through `as any` because the
    // template variables shape is template-specific and not known
    // ahead of time. The SDK validates server-side anyway.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = {
      to: Array.isArray(input.to) ? input.to : [input.to],
      template: input.template,
    };
    if (input.variables) params.variables = input.variables;
    if (input.channels) params.channels = input.channels;
    if (input.sandbox) params.sandbox = true;

    const response = await client.messages.send(params, {
      headers: input.idempotencyKey
        ? { "Idempotency-Key": input.idempotencyKey }
        : undefined,
    });

    const recipients = (response as { data?: { recipients?: Array<{ message_id?: string }> } })
      .data?.recipients ?? [];
    const messageIds = recipients
      .map((r) => r.message_id)
      .filter((id): id is string => typeof id === "string");

    if (input.sandbox) {
      return { sent: false, reason: "sandbox", messageIds };
    }
    return { sent: true, messageIds };
  } catch (err) {
    return {
      sent: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Lightweight feature-flag check. Routes can guard sent.dm-specific
 * code paths without importing the full SDK eagerly.
 */
export function sentDmConfigured(): boolean {
  return Boolean(process.env.SENT_API_KEY);
}

// ─── Customer-facing estimate-ready follow-up ─────────────────────────
//
// sendEstimateReady() fires after the painted-roof V3 pipeline succeeds
// for a lead. It's the SECOND message the homeowner receives (the
// first is the Twilio TCPA-locked confirmation SMS — unchanged here,
// regulator-grade). This one is the engagement-rich follow-up:
//
//   - On RCS-capable devices (iOS, modern Android): Rich Card with
//     the painted-roof image inline, three-tier teaser bullet, "View
//     estimate" and "Call Noland's" CTAs
//   - Everywhere else: plain SMS with the share URL + estimate range
//
// Why this pattern (Twilio THEN sent.dm, not replace):
//   - The TCPA consent text in lib/tcpa-consent.ts is locked to
//     Twilio as the named carrier in the recorded consent disclosure.
//     Switching the consent channel requires legal re-validation and
//     a fresh 10DLC registration on sent.dm's side. Out of scope.
//   - This second message is "service follow-up" under TCPA — the
//     homeowner already opted in, this is informational fulfillment
//     of their request. The disclosure burden is lower.
//   - sent.dm STILL enforces its own opt-out flow ("Reply STOP")
//     independent of Twilio's, so a customer who opts out via either
//     channel is honored by both.
//
// Required sent.dm template (one-time setup in dashboard):
//   Name:     estimate_ready
//   Channels: SMS, RCS, WhatsApp
//   Variables:
//     firstName       — customer's first name
//     address         — short address (street, e.g. "8450 Oak Park Ave")
//     shareUrl        — full URL to /r/{leadPublicId}
//     paintedImageUrl — pre-signed Supabase Storage URL to the
//                       painted-roof PNG (TTL >= 7 days)
//     lowEstimate     — low end of monthly estimate (e.g. "318")
//     highEstimate    — high end (e.g. "576")
//   SMS body:
//     "Hi {{firstName}}, your Noland's Roofing estimate for {{address}}
//      is ready: {{shareUrl}}. Reply STOP to opt out."
//   RCS Rich Card:
//     image:       {{paintedImageUrl}}
//     title:       "{{firstName}}, your roof estimate is ready"
//     body:        "Three ways to roof your home, $${{lowEstimate}}–
//                   ${{highEstimate}}/mo financed."
//     button 1:    "View estimate" → {{shareUrl}}
//     button 2:    "Call Noland's" → tel:+13522424322
//   Copy the UUID and set:
//     vercel env add SENT_DM_ESTIMATE_TEMPLATE_ID production

export interface SendEstimateReadyInput {
  /** Customer's E.164 phone number — must already have voiceConsent. */
  customerPhone: string;
  customerFirstName: string;
  /** Short address, e.g. "8450 Oak Park Ave" — without city/state. */
  address: string;
  /** Pre-signed URL to the painted-roof PNG. Must be HTTPS-accessible
   *  for at least 7 days (RCS scrapers re-fetch). Use lib/painted-url.ts
   *  to mint this with a long-enough TTL. */
  paintedImageUrl: string;
  /** Public share URL — typically https://nolands-estimator.vercel.app/r/{leadPublicId} */
  shareUrl: string;
  /** Estimate range in WHOLE DOLLARS per month (financed). */
  lowEstimate: number;
  highEstimate: number;
  /** Lead UUID — used as the idempotency key so retry loops don't
   *  double-buzz the customer. */
  leadPublicId: string;
}

/**
 * Send the estimate-ready Rich Card to the customer.
 *
 * Soft-fails when SENT_API_KEY or SENT_DM_ESTIMATE_TEMPLATE_ID are
 * unset — production code can call this freely; partner forks without
 * a sent.dm account stay green.
 */
export async function sendEstimateReady(
  input: SendEstimateReadyInput,
): Promise<SendMessageResult> {
  const templateId = process.env.SENT_DM_ESTIMATE_TEMPLATE_ID;
  if (!templateId) {
    return { sent: false, reason: "not_configured" };
  }

  return sendUnifiedMessage({
    to: input.customerPhone,
    template: { id: templateId, name: "estimate_ready" },
    variables: {
      firstName: input.customerFirstName,
      address: input.address,
      shareUrl: input.shareUrl,
      paintedImageUrl: input.paintedImageUrl,
      lowEstimate: input.lowEstimate,
      highEstimate: input.highEstimate,
    },
    // Channel order: try RCS first (rich card), fall to SMS for
    // devices that don't support it. WhatsApp included for Spanish-
    // speaking FL homeowners who prefer it. sent.dm picks one per
    // recipient based on availability + cost.
    channels: ["rcs", "sms", "whatsapp"],
    idempotencyKey: `estimate-${input.leadPublicId}`,
  });
}

// ─── Internal operator notifications ──────────────────────────────────
//
// notifyOwner() is the "Claude / the system pings Ethan" channel.
// Distinct from customer messaging — not subject to TCPA marketing
// consent (it's operator-to-operator), no opt-out flow, no compliance
// disclosure. The recipient is YOU, hardcoded via OWNER_PHONE_E164.
//
// Use this for:
//   - "Deploy complete" pings after vercel deploy --prod
//   - Cron-job summaries (storm pulse fired, parcel ingestion done)
//   - Incident alerts (the silent-403 case would have paged here)
//   - Long-running task completion (parallel agents finished)
//   - "A real lead just came in" out-of-band notification
//   - Anything you want to know about without watching the terminal
//
// Setup the user owes (one-time):
//   1. vercel env add SENT_API_KEY production    (grab from app.sent.dm)
//   2. vercel env add OWNER_PHONE_E164 production (your number, +1XXXXXXXXXX)
//   3. Create a template in the sent.dm dashboard:
//        - Name: ops_alert
//        - Body: "{{message}}"
//        - Channels: SMS + RCS (auto-routes per recipient device)
//      Copy the template UUID, then:
//   4. vercel env add SENT_DM_OPS_TEMPLATE_ID production
//
// Until those are set, every notifyOwner() call no-ops gracefully.

export interface NotifyOwnerOptions {
  /** Short label that appears as a tag/prefix. e.g. "deploy", "incident",
   *  "lead". Helps you mentally route the ping at a glance. */
  tag?: string;
  /** When true, sandbox the send so you can test the call path without
   *  actually buzzing your phone. */
  sandbox?: boolean;
  /** Idempotency key — pass the same value to suppress double-sends
   *  (e.g. the deployment ID, the lead ID, the cron tick). */
  idempotencyKey?: string;
  /** Optional override for the recipient. Defaults to OWNER_PHONE_E164. */
  to?: string;
}

/**
 * Ping the operator. Always returns — never throws.
 *
 * Skipped silently when any of these aren't configured:
 *   - SENT_API_KEY              (wrapper is dormant)
 *   - OWNER_PHONE_E164          (no recipient)
 *   - SENT_DM_OPS_TEMPLATE_ID   (no template UUID)
 *
 * This lets you sprinkle notifyOwner() calls liberally — they're
 * inert in dev / preview / partner forks where the operator
 * notification channel isn't wired up.
 */
export async function notifyOwner(
  message: string,
  opts: NotifyOwnerOptions = {},
): Promise<SendMessageResult> {
  const recipient = opts.to ?? process.env.OWNER_PHONE_E164;
  const templateId = process.env.SENT_DM_OPS_TEMPLATE_ID;
  if (!recipient || !templateId) {
    return { sent: false, reason: "not_configured" };
  }

  // Cap message length to a single SMS-equivalent so we don't blow up
  // the operator phone with multi-part messages. Tagged messages get
  // a tighter cap to leave room for the prefix.
  const body = opts.tag
    ? `[${opts.tag}] ${message}`.slice(0, 160)
    : message.slice(0, 160);

  return sendUnifiedMessage({
    to: recipient,
    template: { id: templateId, name: "ops_alert" },
    variables: { message: body },
    sandbox: opts.sandbox,
    idempotencyKey: opts.idempotencyKey,
  });
}

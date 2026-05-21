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

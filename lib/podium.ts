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
  /** JobNimbus contact id from the V3 push. When present, EVERY
   *  successful Podium send fires a `[SMS-OUT]` note on the JN contact
   *  timeline so reps see the full conversation history inside JN
   *  (not just in Podium). Omit → JN logging is skipped (with a warn). */
  jobnimbusContactId?: string | null;
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

// ─── Read side (health probe + brand-voice mining) ────────────────────
// Podium send was retired but the OAuth scopes include read_messages /
// read_contacts / read_locations, so a valid token can READ the historical
// conversations for voice mining. These helpers verify the token actually
// authenticates (presence != validity — same lesson as the JN key) and
// return only statuses/counts (no message content / PII).

/** Bearer-auth GET against the Podium v4 API. Returns status + parsed body. */
async function podiumGet(
  path: string,
): Promise<{ status: number; json: unknown }> {
  const token = process.env.PODIUM_ACCESS_TOKEN ?? "";
  try {
    const res = await fetch(`https://api.podium.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

export interface PodiumHealth {
  configured: boolean;
  /** HTTP status from GET /v4/locations — confirms the token is valid. */
  locationsStatus: number | null;
  /** HTTP status from GET /v4/conversations — confirms read scope. */
  conversationsStatus: number | null;
  /** Conversations visible (best-effort count, no content). */
  conversationCount: number | null;
  /** True when both reads returned 200 — token valid + can mine. */
  ok: boolean;
  /** When the conversations read != 200, the (truncated) error body so we
   *  can see exactly what Podium wants. Validation text only, no PII. */
  conversationsError?: string | null;
}

/**
 * Probe whether the current PODIUM_ACCESS_TOKEN is valid and can READ
 * conversations. Returns statuses + a count only — NEVER message content
 * (no PII surfaces through this). Used by /api/podium/health to confirm
 * the re-auth landed before we wire the voice-mining pull.
 */
export async function checkPodiumRead(): Promise<PodiumHealth> {
  if (!process.env.PODIUM_ACCESS_TOKEN) {
    return {
      configured: false,
      locationsStatus: null,
      conversationsStatus: null,
      conversationCount: null,
      ok: false,
    };
  }
  const loc = await podiumGet("/v4/locations");
  // Conversations list almost certainly needs the locationUid (sends use it
  // too). Pass it; surface the error body if it still 400s so Podium tells
  // us the exact missing param.
  const locUid = process.env.PODIUM_LOCATION_UID ?? "";
  const conv = await podiumGet(
    `/v4/conversations?locationUid=${encodeURIComponent(locUid)}`,
  );
  let count: number | null = null;
  const cj = conv.json as
    | { data?: unknown[]; conversations?: unknown[]; meta?: { total?: number } }
    | null;
  if (cj) {
    if (typeof cj.meta?.total === "number") count = cj.meta.total;
    else if (Array.isArray(cj.data)) count = cj.data.length;
    else if (Array.isArray(cj.conversations)) count = cj.conversations.length;
  }
  let conversationsError: string | null = null;
  if (conv.status !== 200) {
    try {
      conversationsError = JSON.stringify(conv.json).slice(0, 300);
    } catch {
      conversationsError = null;
    }
  }
  return {
    configured: true,
    locationsStatus: loc.status,
    conversationsStatus: conv.status,
    conversationCount: count,
    ok: loc.status === 200 && conv.status === 200,
    conversationsError,
  };
}

export interface MinedMessage {
  /** Best-effort direction marker (Podium field varies). */
  dir: string;
  text: string;
}
export interface MineResult {
  conversationsFetched: number;
  messagesCollected: number;
  /** Keys of the first message object — schema discovery (no values). */
  firstMessageKeys: string[];
  sample: MinedMessage[];
}

/**
 * Brand-voice mining pull. Pages the location's conversations, fetches each
 * thread's messages, and returns a capped sample of message text + a
 * direction marker so the caller can isolate REP-OUTBOUND phrasings.
 *
 * Transient analysis only — nothing is persisted. Operator-gated at the
 * route. Returns first-message keys too so we can confirm the direction/
 * body field names against Podium's actual schema.
 */
export async function minePodiumVoice(
  maxConversations = 15,
  maxMessagesPerConv = 40,
): Promise<MineResult | { error: string }> {
  const locUid = process.env.PODIUM_LOCATION_UID ?? "";
  const convRes = await podiumGet(
    `/v4/conversations?locationUid=${encodeURIComponent(locUid)}`,
  );
  if (convRes.status !== 200) {
    return { error: `conversations status ${convRes.status}` };
  }
  const cj = convRes.json as { data?: Array<Record<string, unknown>> } | null;
  const convs = Array.isArray(cj?.data) ? cj!.data! : [];

  let firstMessageKeys: string[] = [];
  const sample: MinedMessage[] = [];
  let messagesCollected = 0;
  let conversationsFetched = 0;

  for (const c of convs.slice(0, maxConversations)) {
    const uid = String((c as { uid?: string }).uid ?? "");
    if (!uid) continue;
    const mRes = await podiumGet(
      `/v4/conversations/${encodeURIComponent(uid)}/messages`,
    );
    if (mRes.status !== 200) continue;
    conversationsFetched++;
    const mj = mRes.json as { data?: Array<Record<string, unknown>> } | null;
    const msgs = Array.isArray(mj?.data) ? mj!.data! : [];
    for (const m of msgs.slice(0, maxMessagesPerConv)) {
      const mo = m as Record<string, unknown>;
      if (firstMessageKeys.length === 0) firstMessageKeys = Object.keys(mo);
      const text = String(mo.body ?? mo.text ?? mo.message ?? "").trim();
      if (!text) continue;
      const dir = String(
        mo.direction ?? mo.channelType ?? mo.type ?? mo.source ?? "?",
      );
      messagesCollected++;
      if (sample.length < 250) sample.push({ dir, text: text.slice(0, 300) });
    }
  }
  return { conversationsFetched, messagesCollected, firstMessageKeys, sample };
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
        // 2026-05-26: Podium /v4/messages schema requires
        // type="phone" (lowercase) + identifier (NOT phoneNumber).
        // Original code used type="sms" + phoneNumber — both
        // rejected with 400 invalid_request_values. Verified
        // working via live curl test: 200 OK, delivered to
        // Clermont inbox.
        type: "phone",
        identifier: input.customerPhone,
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
      console.warn("[podium-mms] rate_limited", { status: 429, phone: input.customerPhone });
      return { sent: false, reason: "rate_limited" };
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const detail = `podium_${res.status}: ${errText.slice(0, 400)}`;
      console.error("[podium-mms] HTTP error", {
        status: res.status,
        body: errText.slice(0, 400),
        phone: input.customerPhone,
        locationUid,
      });
      return {
        sent: false,
        reason: "error",
        error: detail,
      };
    }

    const json = (await res.json()) as { data?: { uid?: string } };
    // Log the outbound MMS to JN so reps see the full conversation
    // timeline inside JobNimbus (not just in Podium's separate inbox).
    if (input.jobnimbusContactId) {
      const { logJN } = await import("@/lib/jn-log");
      logJN(
        input.jobnimbusContactId,
        "sms-out",
        `[Podium MMS] to ${input.customerPhone}\n` +
          `Body: ${renderBody(input)}\n` +
          `Attachment: painted roof PNG (${input.paintedImageUrl})\n` +
          `Podium message uid: ${json.data?.uid ?? "n/a"}`,
      );
    }
    return {
      sent: true,
      messageUid: json.data?.uid,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[podium-mms] threw", { error: detail, phone: input.customerPhone });
    return {
      sent: false,
      reason: "error",
      error: detail,
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
          // See sendEstimateReadyViaPodium for the 2026-05-26 schema
          // note. Same fix applies here for the text-only fallback.
          type: "phone",
          identifier: input.customerPhone,
          contactName: input.customerName,
        },
        locationUid,
        senderName,
        setOpenInbox: true,
      }),
    });

    if (res.status === 429) {
      console.warn("[podium-text] rate_limited", { status: 429, phone: input.customerPhone });
      return { sent: false, reason: "rate_limited" };
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const detail = `podium_${res.status}: ${errText.slice(0, 400)}`;
      console.error("[podium-text] HTTP error", {
        status: res.status,
        body: errText.slice(0, 400),
        phone: input.customerPhone,
        locationUid,
      });
      return {
        sent: false,
        reason: "error",
        error: detail,
      };
    }
    const json = (await res.json()) as { data?: { uid?: string } };
    // Same JN-log as the MMS path — the homeowner gets a text either
    // way, so the timeline should record it either way.
    if (input.jobnimbusContactId) {
      const { logJN } = await import("@/lib/jn-log");
      logJN(
        input.jobnimbusContactId,
        "sms-out",
        `[Podium SMS, text-only fallback] to ${input.customerPhone}\n` +
          `Body: ${renderBody(input)}\n` +
          `Podium message uid: ${json.data?.uid ?? "n/a"}`,
      );
    }
    return { sent: true, messageUid: json.data?.uid };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[podium-text] threw", { error: detail, phone: input.customerPhone });
    return {
      sent: false,
      reason: "error",
      error: detail,
    };
  }
}

/**
 * Generic Podium text sender — the canonical outbound-SMS path now
 * that Twilio direct SMS has been retired (2026-05-26).
 *
 * Any outbound SMS that was previously routed through Twilio's
 * `sendSms` helper goes through this function instead. The customer
 * receives the message FROM the Podium location's provisioned number
 * (not from a per-office Twilio number). For Noland's, that means
 * every outbound SMS appears in the same Podium-managed conversation
 * thread, which is what reps see in Podium's inbox.
 *
 * Soft-fail discipline (same as the rest of this module):
 *   - When PODIUM_ACCESS_TOKEN / PODIUM_LOCATION_UID are unset,
 *     return `{ sent: false, reason: "not_configured" }` and never
 *     throw.
 *   - When Podium returns 429, return `{ sent: false, reason:
 *     "rate_limited" }`.
 *   - Any other error returns `{ sent: false, reason: "error" }`.
 *
 * Caller is responsible for E.164 normalization of `phone` (use
 * `lib/twilio.ts:toE164` — the formatter is generic and survives
 * the Twilio SMS retirement).
 */
export interface PodiumTextInput {
  /** Recipient phone in E.164 (e.g. "+13525551234"). */
  phone: string;
  /** Display name for Podium's contact-upsert. Use the homeowner's
   *  name on customer-facing sends; use a stable rep label like
   *  "Rep alert" for rep-targeted operational sends. */
  contactName: string;
  /** Message body. Podium handles SMS segmentation; cap at ~480
   *  chars worst case (3 segments) to keep mobile UX clean. */
  body: string;
  /** Open the inbox so reps see the thread for triage. Default true
   *  for customer-facing sends; pass `false` for low-signal
   *  operational sends (rep alerts, post-call summaries to reps). */
  openInbox?: boolean;
  /** JobNimbus contact id (homeowner's). When present, the send fires
   *  a `[SMS-OUT]` note on the JN contact timeline. Omit for rep-only
   *  sends (rep alerts go to a phone but not to a JN-contact-linked
   *  homeowner). */
  jobnimbusContactId?: string | null;
}

/**
 * In-memory access token cache. Podium access tokens are short-lived
 * (~1h TTL). When PODIUM_ACCESS_TOKEN expires, we exchange the
 * refresh token for a new access token and cache it in this module-
 * level variable for the lifetime of the Lambda instance. Next cold
 * start picks up the env var again; warm instances reuse the cached
 * token.
 *
 * Not perfect — different Lambda instances will each refresh
 * independently. With Podium's per-app refresh-token rotation rules
 * (refresh tokens stay valid across reuse), this is fine.
 */
let cachedAccessToken: string | null = null;
let cachedAccessTokenExpiresAt: number | null = null;

async function refreshPodiumAccessToken(): Promise<string | null> {
  const refreshToken = process.env.PODIUM_REFRESH_TOKEN;
  const clientId = process.env.PODIUM_CLIENT_ID;
  const clientSecret = process.env.PODIUM_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) {
    console.error("[podium] refresh missing creds", {
      hasRefresh: !!refreshToken,
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
    });
    return null;
  }
  try {
    const res = await fetch("https://api.podium.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[podium] refresh failed", {
        status: res.status,
        body: body.slice(0, 400),
      });
      return null;
    }
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      console.error("[podium] refresh returned no access_token", json);
      return null;
    }
    cachedAccessToken = json.access_token;
    const ttl = typeof json.expires_in === "number" ? json.expires_in : 3600;
    // Refresh 60s early to dodge edge-case expirations during the
    // outbound HTTP roundtrip.
    cachedAccessTokenExpiresAt = Date.now() + (ttl - 60) * 1000;
    console.log("[podium] refreshed access_token", {
      ttl,
      expiresInSec: ttl - 60,
    });
    return cachedAccessToken;
  } catch (err) {
    console.error(
      "[podium] refresh threw:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function currentAccessToken(): string {
  // Cached refresh wins if it's still valid.
  if (
    cachedAccessToken &&
    cachedAccessTokenExpiresAt &&
    cachedAccessTokenExpiresAt > Date.now()
  ) {
    return cachedAccessToken;
  }
  return process.env.PODIUM_ACCESS_TOKEN!;
}

export async function sendPodiumText(
  input: PodiumTextInput,
): Promise<PodiumSendResult> {
  if (!podiumConfigured()) {
    return { sent: false, reason: "not_configured" };
  }

  const locationUid = process.env.PODIUM_LOCATION_UID!;
  const senderName = process.env.PODIUM_SENDER_NAME ?? "Noland's Roofing";

  // Inner function so we can retry once on 401 after a refresh.
  async function attempt(token: string) {
    return fetch("https://api.podium.com/v4/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body: input.body.slice(0, 480),
        channel: {
          // Schema verified working 2026-05-26 via live curl: 200 OK
          // delivered to Clermont inbox. type="phone" (NOT "sms"),
          // identifier (NOT phoneNumber).
          type: "phone",
          identifier: input.phone,
          contactName: input.contactName,
        },
        locationUid,
        senderName,
        setOpenInbox: input.openInbox ?? true,
      }),
    });
  }

  try {
    let res = await attempt(currentAccessToken());

    // 401 → token likely expired. Refresh via grant_type=refresh_token
    // and retry ONCE. Podium access tokens are short-lived (~1h) and
    // we don't currently have a proactive refresh cron — this on-
    // demand path keeps SMS reliable across the expiry window.
    if (res.status === 401) {
      console.warn(
        "[podium] 401 — attempting refresh_token exchange + retry",
      );
      const fresh = await refreshPodiumAccessToken();
      if (fresh) {
        res = await attempt(fresh);
      }
    }

    if (res.status === 429) {
      console.warn("[podium] rate_limited", { status: 429, phone: input.phone });
      return { sent: false, reason: "rate_limited" };
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const detail = `podium_${res.status}: ${errText.slice(0, 400)}`;
      console.error("[podium] HTTP error", {
        status: res.status,
        body: errText.slice(0, 400),
        phone: input.phone,
        locationUid,
      });
      return {
        sent: false,
        reason: "error",
        error: detail,
      };
    }
    const json = (await res.json()) as { data?: { uid?: string } };
    // Log to JN if the caller passed a contact id (homeowner sends).
    // Rep alerts pass no contactId and skip JN — they're operational,
    // not part of the homeowner timeline.
    if (input.jobnimbusContactId) {
      const { logJN } = await import("@/lib/jn-log");
      logJN(
        input.jobnimbusContactId,
        "sms-out",
        `[Podium SMS] to ${input.phone}\n${input.body.slice(0, 480)}\n` +
          `Podium message uid: ${json.data?.uid ?? "n/a"}`,
      );
    }
    return { sent: true, messageUid: json.data?.uid };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[podium] threw", { error: detail, phone: input.phone });
    return {
      sent: false,
      reason: "error",
      error: detail,
    };
  }
}

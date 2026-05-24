import { NextResponse } from "next/server";
import { generateText } from "ai";
import { checkPayloadSize, PAYLOAD_LIMITS } from "@/lib/payload-guard";
import {
  sendSms,
  toE164,
  twilioConfigured,
  validateTwilioSignature,
} from "@/lib/twilio";
import {
  appendTurn,
  getConversation,
  type SmsConversation,
} from "@/lib/sms-conversation";
import {
  createServiceRoleClient,
  resolveOfficeByTwilioNumber,
  supabaseServiceRoleConfigured,
  type OfficeBranding,
} from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/sms/inbound
 *
 * Twilio webhook for inbound SMS. Configure this URL in the Twilio
 * console (Phone Numbers → Manage → Active Numbers → your number →
 * Messaging → "A MESSAGE COMES IN" → set to:
 *
 *   https://<your-domain>/api/sms/inbound   (HTTP POST)
 *
 * Twilio posts an application/x-www-form-urlencoded body with at least:
 *   - From          E.164 sender
 *   - To            E.164 recipient (our Twilio number)
 *   - Body          message text
 *   - MessageSid    unique Twilio ID
 *
 * Flow:
 *   1. Validate X-Twilio-Signature so random POSTs can't trigger the bot
 *   2. Look up the conversation by phone (includes lead context from
 *      /api/leads if the customer filled out the wizard first)
 *   3. Call Qwen via the Vercel AI Gateway with a tight roofing-only
 *      system prompt + the conversation history
 *   4. Send the reply back via Twilio outbound SMS and append both
 *      turns to the conversation log
 *
 * Cost: ~$0.0003/inbound + ~$0.0008/outbound Twilio (US) + ~$0.0005
 * Qwen call = <$0.002 per customer reply.
 */
export async function POST(req: Request) {
  // Twilio inbound bodies are form-encoded and well under 10 KB in
  // normal operation. Cap at 100 KB so a forged POST can't pre-buffer
  // megabytes before we can verify the signature.
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
    console.warn("[sms-inbound] invalid Twilio signature");
    return new Response("Forbidden", { status: 403 });
  }

  const from = toE164(params.From);
  const to = toE164(params.To);
  const body = (params.Body ?? "").trim();
  if (!from || !body) {
    // Twilio expects a 200 even on no-op so it doesn't retry.
    return new Response("<Response/>", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }

  // ─── Tenancy: route by destination number ─────────────────────────
  // Each contractor brings their own Twilio number for customer
  // messaging. The `To` field tells us which contractor received this
  // SMS, which scopes the lead lookup AND determines the `From`
  // number on every outbound reply. If we can't resolve an office
  // (e.g. the Voxaris toll-free receiving a homeowner message during
  // pre-launch internal testing), we fall back to no-office mode and
  // send replies from TWILIO_PHONE_NUMBER (the global default).
  const inboundOffice = to ? await resolveOfficeByTwilioNumber(to) : null;
  const replyFrom = inboundOffice?.twilioNumber ?? undefined;

  // STOP / UNSUBSCRIBE / END / QUIT / CANCEL — Twilio handles the
  // account-level suppression automatically, but we ALSO persist the
  // opt-out in Supabase so future outbound paths (different sender ID,
  // a per-office Twilio number, a scheduled follow-up three weeks
  // later) check Supabase as the source of truth instead of relying
  // on Twilio's account block. Persisting also creates the
  // TCPA-defensible audit trail.
  const stopMatch = body.match(/^(stop|stopall|unsubscribe|cancel|end|quit)$/i);
  if (stopMatch) {
    const keyword = stopMatch[1].toLowerCase();
    if (supabaseServiceRoleConfigured()) {
      try {
        const sb = createServiceRoleClient();
        // Upsert keyed on phone_e164 so a repeat STOP doesn't error.
        // We don't update opted_out_at on conflict — the original
        // timestamp is the legally-relevant one.
        await sb
          .from("sms_opt_outs")
          .upsert(
            {
              phone_e164: from,
              source: "sms_stop",
              keyword,
            },
            { onConflict: "phone_e164", ignoreDuplicates: true },
          );
      } catch (err) {
        console.error("[sms-inbound] failed to persist opt-out:", err);
      }
    } else {
      console.warn(
        "[sms-inbound] opt-out NOT persisted — Supabase service role unconfigured. " +
          "Set SUPABASE_SERVICE_ROLE_KEY to enable TCPA-grade opt-out tracking.",
      );
    }
    console.log("[sms-inbound] opt-out received from", from);
    return new Response("<Response/>", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }

  // ─── YES → trigger Sydney callback ────────────────────────────────
  // Deterministic intercept BEFORE the AI-reply pipeline. The
  // confirmation SMS sent from /api/leads ends with:
  //   "Reply YES and Sydney will call you now..."
  // When the homeowner replies YES (or close variants), we:
  //   1. Look up their most-recent lead row by phone (Supabase service
  //      role; office_id comes from the lead row).
  //   2. POST /api/dispatch-outbound with the lead context. The
  //      INTERNAL_DISPATCH_SECRET gate keeps this server-to-server.
  //   3. Reply via SMS: "Got it — calling you in a few seconds."
  //   4. Append the turn so the SMS thread shows the YES + reply.
  //
  // TCPA note: the homeowner's affirmative reply to a clear AI-voice
  // disclosure ("Sydney, our AI assistant, will call you") is express
  // written consent under TCPA + the FCC Feb 2024 AI-voice ruling. We
  // log a consent row alongside the dispatch for the audit trail.
  const yesMatch = body.match(/^(yes|y|yeah|yep|yup|sure|ok|okay|call me|call)\b/i);
  if (yesMatch) {
    const handled = await handleYesCallback({
      from,
      body,
      inboundOffice,
      replyFrom,
    });
    if (handled) {
      return new Response("<Response/>", {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }
    // If the YES handler couldn't find a lead, fall through to the AI
    // path so the homeowner gets some response instead of silence.
  }

  // Append the inbound user message.
  const conv = await appendTurn({ phone: from, role: "user", body });

  // Generate an AI reply. We respond asynchronously via the Twilio
  // REST API rather than via TwiML <Message> because TwiML responses
  // require we finish within Twilio's webhook timeout (~15s) AND we
  // want to keep the reply pipeline identical to outbound paths
  // initiated from the server (e.g., post-quote confirmation).
  let reply: string;
  try {
    reply = await generateReply(conv);
  } catch (err) {
    console.error("[sms-inbound] reply generation failed:", err);
    reply =
      "Thanks for the message — a Noland's Roofing team member will follow up shortly. (Reply HUMAN to skip the bot.)";
  }

  try {
    await sendSms({ to: from, body: reply, from: replyFrom });
    await appendTurn({ phone: from, role: "assistant", body: reply });
  } catch (err) {
    console.error("[sms-inbound] outbound send failed:", err);
  }

  // ACK Twilio with empty TwiML so it doesn't queue a duplicate reply.
  return new Response("<Response/>", {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

/** System prompt — keeps the bot on-topic and brand-consistent.
 *  Two distinct modes:
 *    - WARM: customer already submitted /quote, we know their lead
 *    - COLD: customer texted the number first, we have nothing —
 *            mini-onboard them, capture name + address, then steer
 *            to the /quote wizard (where the visual estimator works
 *            better than over SMS) OR collect enough fields to fire
 *            an SMS-only estimate. */
function buildSystemPrompt(conv: SmsConversation): string {
  const lead = conv.lead;
  if (lead) {
    return `You are the Noland's Roofing SMS concierge. You text customers who already got an online estimate.

The customer already submitted a roofing estimate request:
  Name: ${lead.name}
  Address: ${lead.address}
  Material chosen: ${lead.material ?? "not specified"}
  Roof size: ${lead.estimatedSqft ? `${lead.estimatedSqft} sqft` : "not measured"}
  Estimate range: ${
    lead.estimateLow && lead.estimateHigh
      ? `$${lead.estimateLow.toLocaleString()} – $${lead.estimateHigh.toLocaleString()}`
      : "pending"
  }
  Add-ons: ${(lead.selectedAddOns ?? []).join(", ") || "none"}
  Submitted: ${lead.submittedAt}

Rules:
1. Replies under 320 characters (2 SMS segments). Most should be 1 segment (160 chars).
2. Warm, direct, like a roofing rep — not a chatbot. Never use emojis or markdown.
3. NEVER make up pricing, warranty terms, or appointment times. If asked something specific you can't answer from the context, say "I'll have a team member confirm — should I have them call you?"
4. Push toward booking a free in-person inspection. That's the goal of every conversation.
5. If they text BOOK or ask to schedule, confirm address is still ${lead.address} and ask: morning, afternoon, or evening preference + 2 best days.
6. Stay strictly on roofing topics. Off-topic → redirect.
7. Sign with "— Noland's Roofing" ONLY on the first reply of the thread.`;
  }

  // COLD inbound — they texted us first, we have nothing.
  // Onboarding state machine driven by what we've already learned in
  // the conversation. The model reads the history and chooses the
  // next question.
  return `You are the Noland's Roofing SMS concierge. A new customer just texted our number with NO prior estimate on file.

Your job in order of priority:
1. Greet them warmly on the FIRST reply: "Hey, this is Noland's Roofing. What can I help you with?" Sign that first message "— Noland's Roofing".
2. Figure out why they texted. Common reasons: storm damage check, want an estimate, claim question, follow-up to a flyer/yard sign.
3. Capture the essentials, one at a time over the next 2-3 messages:
   - Their first name
   - Property address (street + city + state, or ZIP at minimum)
   - Roofing situation in their words ("hail last week, lots of granules in gutters")
4. Once you have name + address, offer ONE of these two paths:
   (a) "I can run a free instant estimate right now — visit estimate.nolandsroofing.com and it'll text the range back in 30 seconds." (preferred for most cases)
   (b) "If you'd rather, I can have a roofer call you in the next hour to walk through it — what's a good time window?" (for urgent damage / claim work)
5. If they're clearly in an claim ("State Farm denied my claim", "adjuster said it's wear and tear"), shift to: "We help homeowners with denied or under-scoped claims. What carrier are you with, and roughly when was the date of loss?"

Rules:
- Replies under 320 characters. One message = one ask. Don't pile 4 questions in a row.
- Warm, direct, like a roofing rep. No emojis. No markdown.
- NEVER make up pricing, warranty terms, or appointment times. If asked, say "I'll have a team member confirm" and capture their preferred call window.
- If the message looks like spam, a wrong number, or off-topic chatter, reply once: "I think you may have the wrong number — this is Noland's Roofing in Clermont, FL. Were you looking for a roof estimate?" If they confirm wrong number, stop replying.
- Stay strictly on roofing. Off-topic → "I can only help with your roofing project — anything I can answer there?"

You have full conversation history below. Read it before replying so you don't re-ask for info already given.`;
}

/**
 * Look up the homeowner's most-recent lead by phone, fire an outbound
 * Sydney dispatch, and reply via SMS. Returns true when the dispatch
 * was attempted (success OR failure both count — we already replied),
 * false when there's no matching lead so the caller can fall through
 * to the AI path.
 */
async function handleYesCallback(opts: {
  from: string;
  body: string;
  /** Office resolved from the destination Twilio number. When null,
   *  we're in pre-launch testing on the Voxaris toll-free; fall back
   *  to phone-only lookup across all offices. */
  inboundOffice: OfficeBranding | null;
  /** Twilio number to send the ack reply from. */
  replyFrom: string | undefined;
}): Promise<boolean> {
  if (!supabaseServiceRoleConfigured()) {
    console.warn("[sms-inbound:yes] supabase service role not configured");
    return false;
  }
  const sb = createServiceRoleClient();

  // Most-recent lead for this phone. The `phone` column stores the
  // RAW user input (formatted, hyphens, parens, etc.), not E.164, so
  // a strict equality match would miss. We match on the trailing 10
  // digits via ilike — robust against (407) 555-1234 / 407-555-1234 /
  // 4075551234 / +14075551234. Tenancy is enforced via the lead row's
  // office_id; the inbound webhook is shared across all offices on the
  // Voxaris Twilio number for testing.
  const last10 = opts.from.replace(/\D/g, "").slice(-10);
  if (last10.length !== 10) {
    console.warn("[sms-inbound:yes] non-10-digit from", opts.from);
    return false;
  }
  // Scope to the office that received the SMS when we resolved one.
  // This is the right multi-tenant boundary: a homeowner who has
  // leads with two different contractors should be answered by the
  // contractor whose number they texted.
  let leadsQuery = sb
    .from("leads")
    .select(
      "public_id, office_id, name, address, phone, estimate_low, estimate_high, estimated_sqft, material, tcpa_consent",
    )
    .ilike("phone", `%${last10}%`)
    .order("created_at", { ascending: false })
    .limit(1);
  if (opts.inboundOffice) {
    leadsQuery = leadsQuery.eq("office_id", opts.inboundOffice.id);
  }
  const { data: leads, error } = await leadsQuery;
  const lead = leads?.[0] ?? null;

  if (error) {
    console.error("[sms-inbound:yes] lead lookup failed:", error.message);
    return false;
  }
  if (!lead) {
    // Mask phone in logs — full E.164 is PII / TCPA-sensitive and ends
    // up in long-retention log sinks. Keep enough to correlate (last 4)
    // without exposing the full number.
    const masked = opts.from ? `***${opts.from.slice(-4)}` : "(unknown)";
    console.log("[sms-inbound:yes] no lead found for phone", masked);
    return false;
  }

  // Look up the office slug — /api/dispatch-outbound requires it for
  // tenancy + Sydney's per-office persona.
  const { data: office } = await sb
    .from("offices")
    .select("slug, name, livekit_agent_name")
    .eq("id", lead.office_id)
    .maybeSingle();

  if (!office) {
    console.error("[sms-inbound:yes] office not found for lead", lead.public_id);
    return false;
  }

  // Log the voice-consent event. This is the TCPA paper trail for the
  // SMS YES → AI voice callback path.
  try {
    // lead_id intentionally omitted — the consents FK targets leads.id
    // (uuid), not the public_id string. The phone + office_id + ISO
    // timestamp are enough to correlate to the lead in audits.
    await sb.from("consents").insert({
      consent_type: "voice_sms_yes",
      consented_at: new Date().toISOString(),
      disclosure_text: `Homeowner replied YES to: 'Reply YES and Sydney (our AI assistant) will call you now to schedule a free inspection.' Lead public_id: ${lead.public_id}`,
      phone: opts.from,
      office_id: lead.office_id,
      user_agent: "twilio-sms-webhook",
    });
  } catch (err) {
    console.warn("[sms-inbound:yes] consent insert failed:", err);
  }

  // Update lead status so the dashboard shows "calling" on the row
  // between YES and the post-call webhook.
  try {
    await sb
      .from("leads")
      .update({ status: "calling", updated_at: new Date().toISOString() })
      .eq("public_id", lead.public_id);
  } catch (err) {
    console.warn("[sms-inbound:yes] lead status update failed:", err);
  }

  // POST /api/dispatch-outbound. We resolve the origin from the
  // request URL we're already serving — same host, so this stays
  // server-to-server within Vercel.
  const dispatchSecret = process.env.INTERNAL_DISPATCH_SECRET ?? "";
  if (!dispatchSecret) {
    console.error("[sms-inbound:yes] INTERNAL_DISPATCH_SECRET missing");
    await sendSms({
      to: opts.from,
      body: "Thanks — a team member will call you shortly.",
      from: opts.replyFrom,
    });
    await appendTurn({ phone: opts.from, role: "user", body: opts.body });
    await appendTurn({
      phone: opts.from,
      role: "assistant",
      body: "Thanks — a team member will call you shortly.",
    });
    return true;
  }

  const origin =
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.NEXT_PUBLIC_BASE_URL ?? "https://estimate.nolandsroofing.com";

  const dispatchPayload = {
    leadId: lead.public_id,
    leadPublicId: lead.public_id,
    name: lead.name,
    phone: opts.from,
    address: lead.address,
    estimateLow: lead.estimate_low ?? undefined,
    estimateHigh: lead.estimate_high ?? undefined,
    estimatedSqft: lead.estimated_sqft ?? undefined,
    material: lead.material ?? undefined,
    office: office.slug,
    agentName: office.livekit_agent_name ?? "sydney",
  };

  try {
    const res = await fetch(`${origin}/api/dispatch-outbound`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dispatch-secret": dispatchSecret,
      },
      body: JSON.stringify(dispatchPayload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        "[sms-inbound:yes] dispatch failed",
        res.status,
        text.slice(0, 300),
      );
    } else {
      console.log("[sms-inbound:yes] dispatched Sydney for", lead.public_id);
    }
  } catch (err) {
    console.error("[sms-inbound:yes] dispatch fetch threw:", err);
  }

  // Reply to the homeowner — we already kicked off the call, so this
  // is an acknowledgment regardless of whether the SIP leg succeeds
  // (Sydney's logs are the source of truth for the call itself).
  const ackBody = `Got it — ${office.livekit_agent_name ? office.livekit_agent_name.charAt(0).toUpperCase() + office.livekit_agent_name.slice(1) : "Sydney"} will call you in a few seconds from ${office.name}.`;
  try {
    await sendSms({ to: opts.from, body: ackBody, from: opts.replyFrom });
  } catch (err) {
    console.error("[sms-inbound:yes] ack SMS failed:", err);
  }

  await appendTurn({ phone: opts.from, role: "user", body: opts.body });
  await appendTurn({ phone: opts.from, role: "assistant", body: ackBody });
  return true;
}

async function generateReply(conv: SmsConversation): Promise<string> {
  // Build the message list — last 10 turns is plenty for SMS context.
  const recent = conv.turns.slice(-10);
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const t of recent) {
    if (t.role === "user" || t.role === "assistant") {
      messages.push({ role: t.role, content: t.body });
    }
  }

  const { text } = await generateText({
    // Same Gateway model used by /api/voice-note + /api/supplement
    model: "alibaba/qwen-3-235b",
    system: buildSystemPrompt(conv),
    messages,
    maxOutputTokens: 200,
    temperature: 0.6,
  });
  // Defensive trim — Qwen occasionally over-produces despite max tokens.
  const trimmed = text.trim().slice(0, 320);
  return trimmed;
}

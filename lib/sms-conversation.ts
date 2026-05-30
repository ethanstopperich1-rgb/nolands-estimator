/**
 * SMS conversation state — short-term memory keyed by phone number.
 * Backed by Upstash Redis (same instance used by lib/cache.ts and
 * lib/ratelimit.ts). Falls back to in-memory only when Redis env vars
 * aren't set, so dev / preview still works without provisioning.
 *
 * State stored per phone:
 *   - Lead context (name, address, estimate range, material, etc.)
 *     captured at /quote submit. Used by the AI so SMS replies don't
 *     re-ask for things the customer already filled out.
 *   - Last N messages of the back-and-forth, so the bot has continuity.
 *
 * TTL: 30 days. After that, a returning customer's prior conversation
 * is dropped and they get a fresh thread. The lead itself is persisted
 * separately (via LEAD_WEBHOOK_URL / Supabase when wired) — this is
 * just chat memory.
 */

import { Redis } from "@upstash/redis";

let redisClient: Redis | null | undefined;
function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
  if (!url || !token) {
    redisClient = null;
    return null;
  }
  try {
    redisClient = new Redis({ url, token });
    return redisClient;
  } catch (err) {
    console.warn("[sms-conversation] Upstash Redis init failed:", err);
    redisClient = null;
    return null;
  }
}

const MEMORY: Map<string, SmsConversation> = new Map();
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface LeadContext {
  /** Lead ID issued by /api/leads. */
  leadId: string;
  /** Customer name as submitted. */
  name: string;
  /** Customer email. */
  email?: string;
  /** Full street address. */
  address: string;
  /** Estimated range from the wizard's pricing engine. */
  estimateLow?: number;
  estimateHigh?: number;
  /** Material the customer selected. */
  material?: string;
  /** Squares of roof area. */
  estimatedSqft?: number;
  /** Selected add-ons (gutters, skylights, etc.). */
  selectedAddOns?: string[];
  /** ISO submission timestamp. */
  submittedAt: string;
}

export interface SmsTurn {
  /** "user" = customer text, "assistant" = our reply. */
  role: "user" | "assistant" | "system";
  body: string;
  /** ISO timestamp. */
  at: string;
}

/** A single time-slot offer the homeowner can pick from via SMS. */
export interface SlotOffer {
  /** Single-letter shortcode the homeowner replies with ("A", "B"). */
  key: string;
  /** Booking start time in ISO 8601 with timezone offset. */
  iso: string;
  /** Human-readable label shown in the SMS body. e.g. "Wed May 27, 9 AM". */
  label: string;
  /** Window classifier — used downstream when creating the JN task. */
  window: "morning" | "afternoon";
}

export interface SmsConversation {
  phone: string; // E.164
  lead?: LeadContext;
  turns: SmsTurn[];
  /** ISO time of the most recent inbound or outbound message. */
  lastActivityAt: string;
  /** Time slots offered to the homeowner via the YES/SCHEDULE → "pick a
   *  time" flow. Cleared after the homeowner replies A or B and we
   *  book the slot in JobNimbus. Stale offers (>24h old) are re-issued
   *  by the inbound handler. */
  offeredSlots?: SlotOffer[];
  /** ISO time the current offeredSlots were sent. Drives the 24h
   *  staleness check. */
  offeredAt?: string;
  /** Cold-start booking flow ("Text ROOF to 888" — Gap 3). Tracks where
   *  a brand-new texter (no lead on file) is in the capture→book funnel:
   *    - "await_address" : greeted, waiting for the property address
   *    - "await_name"    : have the address, waiting for their name
   *  Cleared once the lead is created and slots are offered (the A/B
   *  pick then flows through the normal slot-pick handler). */
  coldStage?: "await_address" | "await_name";
  /** Address captured during the cold-start flow (raw homeowner text). */
  coldAddress?: string;
  /** First name captured during the cold-start flow. */
  coldName?: string;
}

function key(phone: string): string {
  return `sms-conv:${phone}`;
}

export async function getConversation(
  phone: string,
): Promise<SmsConversation | null> {
  const mem = MEMORY.get(phone);
  if (mem) return mem;
  const redis = getRedis();
  if (!redis) return null;
  try {
    const v = await redis.get<SmsConversation>(key(phone));
    if (v) MEMORY.set(phone, v);
    return v ?? null;
  } catch (err) {
    console.warn("[sms-conversation] redis read failed:", err);
    return null;
  }
}

export async function saveConversation(
  conv: SmsConversation,
): Promise<void> {
  // Cap history at 24 turns (12 user + 12 assistant) to keep prompts
  // tight and Redis records small.
  if (conv.turns.length > 24) {
    conv.turns = conv.turns.slice(-24);
  }
  MEMORY.set(conv.phone, conv);
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(key(conv.phone), conv, { ex: TTL_SECONDS });
  } catch (err) {
    console.warn("[sms-conversation] redis write failed:", err);
  }
}

/** Create or update conversation with lead context captured at /quote
 *  submit. Idempotent — safe to call repeatedly. */
export async function attachLeadContext(opts: {
  phone: string;
  lead: LeadContext;
}): Promise<SmsConversation> {
  const existing = await getConversation(opts.phone);
  const conv: SmsConversation = {
    phone: opts.phone,
    lead: opts.lead,
    turns: existing?.turns ?? [],
    lastActivityAt: new Date().toISOString(),
  };
  await saveConversation(conv);
  return conv;
}

/** Append a single turn (user or assistant) to the conversation. */
export async function appendTurn(opts: {
  phone: string;
  role: SmsTurn["role"];
  body: string;
}): Promise<SmsConversation> {
  const existing = (await getConversation(opts.phone)) ?? {
    phone: opts.phone,
    turns: [],
    lastActivityAt: new Date().toISOString(),
  };
  const turn: SmsTurn = {
    role: opts.role,
    body: opts.body,
    at: new Date().toISOString(),
  };
  existing.turns.push(turn);
  existing.lastActivityAt = turn.at;
  await saveConversation(existing);
  return existing;
}

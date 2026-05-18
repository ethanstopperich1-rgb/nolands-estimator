import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

/**
 * Daily AI-spend circuit breaker.
 *
 * Rate limits cap requests per IP per minute. They don't cap total $-burn
 * across all IPs. A distributed attacker (or a buggy retry loop on a
 * single trusted client) can stay under the per-IP cap and still drain
 * the Gemini / Anthropic budget in a day.
 *
 * This module tracks today's estimated spend in Redis under a daily-
 * rotating key. Before each expensive call, the route calls
 * `assertAiSpendUnderCap()` which returns a 503 once the daily limit is
 * exceeded. After the call lands, it reports the actual spend via
 * `trackAiSpend()`.
 *
 * Daily cap defaults to $200/day, override with AI_DAILY_USD_CAP. Set to
 * 0 to disable (not recommended in prod).
 *
 * FAIL MODE: if Redis is unavailable, the cap is bypassed (request
 * proceeds). The rate limiter already fail-closes in prod when Redis is
 * gone, so this isn't an additional risk surface — both defenses share
 * the same Redis-required posture.
 */

const DEFAULT_DAILY_USD_CAP = 200;

let cachedRedis: Redis | null = null;
let probedRedis = false;

function getRedis(): Redis | null {
  if (probedRedis) return cachedRedis;
  probedRedis = true;
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
  if (!url || !token) return null;
  try {
    cachedRedis = new Redis({ url, token });
    return cachedRedis;
  } catch (err) {
    console.warn("[cost-cap] redis init failed:", err);
    return null;
  }
}

function dailyKey(): string {
  // UTC date — pick a fixed timezone to avoid rollover weirdness around
  // midnight in any one zone. UTC is consistent with Vercel logs.
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `pitch-cost:${y}-${m}-${d}`;
}

function dailyCapUsd(): number {
  const raw = process.env.AI_DAILY_USD_CAP;
  if (!raw) return DEFAULT_DAILY_USD_CAP;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_USD_CAP;
}

/**
 * Pre-call check. Call this BEFORE the AI request so a budget-exhausted
 * day returns a fast 503 without ever billing Gemini.
 */
export async function assertAiSpendUnderCap(): Promise<NextResponse | null> {
  const cap = dailyCapUsd();
  if (cap === 0) return null;
  const redis = getRedis();
  if (!redis) return null;

  try {
    const raw = await redis.get<number | string>(dailyKey());
    const spent = typeof raw === "number" ? raw : Number(raw ?? 0);
    if (Number.isFinite(spent) && spent >= cap) {
      console.error(
        `[cost-cap] daily AI spend cap reached: $${spent.toFixed(2)} >= $${cap.toFixed(2)}`,
      );
      return NextResponse.json(
        { error: "ai_daily_cap_reached" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return null;
  } catch (err) {
    console.warn("[cost-cap] cap check threw:", err);
    return null;
  }
}

/**
 * Post-call accounting. `usd` is the estimated $-cost of the call that
 * just completed. Best-effort; failure is logged but never thrown.
 */
export async function trackAiSpend(usd: number, tag: string): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    const key = dailyKey();
    await redis.incrbyfloat(key, usd);
    await redis.expire(key, 60 * 60 * 36);
    console.log(`[cost-cap] +$${usd.toFixed(4)} (${tag})`);
  } catch (err) {
    console.warn("[cost-cap] track threw:", err);
  }
}

/**
 * Approximate per-call cost (USD) — conservative HIGH-end. Used by AI
 * routes to report spend without the route having to know its own
 * pricing. Update the table when Gemini / Anthropic price-changes.
 */
export const AI_CALL_COST_USD = {
  gemini_pro_image_paint: 0.18,
  gemini_flash_json: 0.01,
  solar_findclosest: 0.05,
  chromium_pdf_render: 0.02,
} as const;

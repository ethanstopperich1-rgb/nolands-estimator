/**
 * Brute-force throttle for /api/auth/staff-login.
 *
 * Tracks failed-attempts-per-IP in Upstash Redis. 5 failures within a
 * 15-minute window locks the IP out for the remainder of the window.
 * Successful login clears the counter immediately.
 *
 * Fails OPEN when Redis env vars are missing (dev / preview) — same
 * posture as `lib/ratelimit.ts`. A working brute-force defense in prod
 * matters more than a working one in localhost.
 *
 * Why a hand-rolled counter instead of the existing Upstash Ratelimit
 * helper: we only want to consume the budget on FAILURE, not on every
 * attempt. The sliding-window limiter consumes a token per call
 * regardless of outcome, so a legit user who mistypes once would burn
 * a token they didn't deserve to lose.
 */

import { Redis } from "@upstash/redis";

const WINDOW_SECONDS = 15 * 60; // 15 minutes
const MAX_FAILURES = 5;

let cachedRedis: Redis | null = null;
let probed = false;

function getRedis(): Redis | null {
  if (probed) return cachedRedis;
  probed = true;
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
  if (!url || !token) return null;
  try {
    cachedRedis = new Redis({ url, token });
  } catch {
    cachedRedis = null;
  }
  return cachedRedis;
}

function ipKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = req.headers.get("x-real-ip");
  const ip = real || fwd || "unknown";
  return `pitch-login-fails:${ip}`;
}

export interface LockoutStatus {
  locked: boolean;
  failures: number;
  retryAfterSeconds: number;
}

/**
 * Read-only check — does NOT consume a token. Call before validating
 * credentials so we can short-circuit locked IPs.
 */
export async function checkLockout(req: Request): Promise<LockoutStatus> {
  const redis = getRedis();
  if (!redis) return { locked: false, failures: 0, retryAfterSeconds: 0 };
  const key = ipKey(req);
  try {
    const raw = await redis.get<number | string>(key);
    const failures = typeof raw === "string" ? Number(raw) : (raw ?? 0);
    if (failures >= MAX_FAILURES) {
      const ttl = await redis.ttl(key);
      return {
        locked: true,
        failures,
        retryAfterSeconds: Math.max(1, ttl),
      };
    }
    return { locked: false, failures, retryAfterSeconds: 0 };
  } catch {
    return { locked: false, failures: 0, retryAfterSeconds: 0 };
  }
}

/**
 * Increment the failure counter and (on first write) set the 15-minute
 * window. After this returns, the caller should send the standard 401.
 */
export async function recordFailure(req: Request): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const key = ipKey(req);
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, WINDOW_SECONDS);
  } catch {
    /* best-effort */
  }
}

/**
 * Wipe the failure counter on successful authentication so a legit
 * user who mistyped a few times then got it right doesn't carry the
 * residue forward.
 */
export async function clearFailures(req: Request): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(ipKey(req));
  } catch {
    /* best-effort */
  }
}

export const LOGIN_THROTTLE_MAX = MAX_FAILURES;
export const LOGIN_THROTTLE_WINDOW_SECONDS = WINDOW_SECONDS;

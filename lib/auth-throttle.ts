/**
 * Generalization of `lib/login-throttle.ts` — same 5-failures-per-IP-
 * per-15-minutes lockout, but keyed by a caller-supplied namespace so
 * different auth-equivalent endpoints get independent counters.
 *
 * Use for any route where a brute-force attempt is the threat model:
 *  - voice-consent toggle (TCPA-critical — attacker who guessed a
 *    publicId could try to flip consent on a victim's lead)
 *  - SMS YES handler intercepts in /api/sms/inbound (already
 *    Twilio-signature-gated, but defense in depth on the lookup step)
 *  - any future webhook bearer endpoint
 *
 * Fails OPEN when Redis is unavailable (same posture as the existing
 * login throttle and the main rate-limit module). A working brute-
 * force defense in prod matters more than a working one in localhost.
 */

import { Redis } from "@upstash/redis";

const WINDOW_SECONDS = 15 * 60;
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

function ipFromRequest(req: Request): string {
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || "unknown";
}

function keyFor(namespace: string, req: Request): string {
  return `pitch-auth-throttle:${namespace}:${ipFromRequest(req)}`;
}

export interface AuthLockoutStatus {
  locked: boolean;
  failures: number;
  retryAfterSeconds: number;
}

/** Read-only — does NOT consume a token. Call BEFORE the protected
 *  operation so locked IPs short-circuit cheaply. */
export async function checkAuthLockout(
  req: Request,
  namespace: string,
): Promise<AuthLockoutStatus> {
  const redis = getRedis();
  if (!redis) return { locked: false, failures: 0, retryAfterSeconds: 0 };
  const key = keyFor(namespace, req);
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

/** Record a failed attempt and start the 15-minute lockout window on
 *  the first failure for this IP+namespace pair. */
export async function recordAuthFailure(
  req: Request,
  namespace: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const key = keyFor(namespace, req);
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, WINDOW_SECONDS);
  } catch {
    /* best-effort */
  }
}

/** Clear on successful authentication so a legitimate user who mistyped
 *  earlier doesn't carry residue toward future lockouts. */
export async function clearAuthFailures(
  req: Request,
  namespace: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(keyFor(namespace, req));
  } catch {
    /* best-effort */
  }
}

export const AUTH_THROTTLE_MAX = MAX_FAILURES;
export const AUTH_THROTTLE_WINDOW_SECONDS = WINDOW_SECONDS;

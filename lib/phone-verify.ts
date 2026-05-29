/**
 * lib/phone-verify.ts — "is this number real + dialable" pre-dial gate.
 *
 * Sits in front of Sarah's outbound autodial (/api/dispatch-outbound).
 * A homeowner setting `voiceConsent: true` proves CONSENT, not phone
 * POSSESSION — a typo'd, fake, or disconnected number passes the TCPA
 * consent gate but should NOT be autodialed. Dialing dead/invalid
 * numbers wastes Sarah's outbound minutes and, worse, risks dialing a
 * reassigned number the homeowner never actually controlled (a TCPA
 * exposure). This module asks Twilio Lookup whether the number is a
 * real, deliverable line BEFORE the dial fires.
 *
 * ── Design posture: SOFT-FAIL OPEN ─────────────────────────────────
 *
 * Mirrors the philosophy in lib/ratelimit.ts's header: this is a
 * DEFENSE-IN-DEPTH control, NOT a hard auth boundary. We never block a
 * legitimate dial because Lookup had a hiccup. If Twilio creds are
 * unset, the lookup times out (~4s AbortSignal), or any non-404 error
 * occurs, we return `{ ok: true, lineType: null, reason:
 * "lookup_unavailable" }` and let the dial proceed. We only return
 * `ok: false` when Twilio AFFIRMATIVELY tells us the number is bad
 * (HTTP 404 not-found, a Line Type Intelligence error_code, or a
 * clearly-undeliverable line type). Never throws.
 *
 * ── Cost ───────────────────────────────────────────────────────────
 *
 * Twilio Lookup v2 with line_type_intelligence bills ~$0.008/call.
 * Repeat submissions of the SAME number (homeowner re-submits, dedup
 * misses, etc.) must not re-pay — results are cached per-number for
 * 30 days via lib/cache.ts (`phone-verify:v1:{e164}`).
 *
 * ── Env ────────────────────────────────────────────────────────────
 *
 * Reuses the SAME Twilio credentials as lib/twilio.ts:
 *   TWILIO_ACCOUNT_SID    — Basic-auth username
 *   TWILIO_AUTH_TOKEN     — Basic-auth password
 *
 * Kill-switch: set TWILIO_LOOKUP_ENABLED=0 (or "false") to disable the
 * lookup entirely and always soft-pass — useful if Lookup ever starts
 * misbehaving in prod and we want to ungate dials without a redeploy.
 * Unset = treat as enabled whenever Twilio creds exist.
 */

import { getCachedByKey, setCachedByKey, CACHE_TTL } from "@/lib/cache";

/** Cred accessors — read at call time (not module init) so test setup
 *  that mutates process.env before importing-then-calling sees the
 *  right values, matching how lib/ratelimit.ts probes env lazily. */
function twilioCreds(): { sid: string; token: string } | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return { sid, token };
}

/** Whether the Lookup gate is enabled. Disabled when Twilio creds are
 *  absent OR the explicit kill-switch is flipped off. */
function lookupEnabled(): boolean {
  const flag = process.env.TWILIO_LOOKUP_ENABLED;
  if (flag === "0" || flag?.toLowerCase() === "false") return false;
  return twilioCreds() !== null;
}

export interface DialableResult {
  /** True when the dial should proceed. Soft-fails OPEN: `true` also
   *  covers "we couldn't check" (creds unset / timeout / non-404 error).
   *  Only `false` when Twilio affirmatively says the number is bad. */
  ok: boolean;
  /** Twilio line type: "mobile" | "landline" | "voip" | etc. — null
   *  when the lookup was skipped or didn't return type intelligence. */
  lineType: string | null;
  /** Why we returned this verdict. `null` on a clean valid lookup;
   *  "lookup_unavailable" on any soft-fail; otherwise a reason string
   *  for the skipped dial (e.g. "not_found", "lti_error:60606"). */
  reason: string | null;
}

/** Shape of the slice of the Lookup v2 response we read. */
interface LookupV2Response {
  valid?: boolean;
  line_type_intelligence?: {
    type?: string | null;
    error_code?: number | string | null;
  } | null;
}

const CACHE_KEY_PREFIX = "phone-verify:v1:";

/** Line types Twilio LTI can return that we treat as undeliverable for
 *  a voice call. `nonFixedVoip`/`personal`/`tollFree` and the standard
 *  mobile/landline/fixedVoip are all dialable. We're conservative —
 *  only block on types that genuinely can't receive a call. */
const UNDELIVERABLE_LINE_TYPES = new Set<string>([
  // Twilio doesn't currently emit a dedicated "disconnected" line type
  // via LTI (that surfaces as valid:false / error_code instead), but
  // future-proof the set here so a clearly-dead type is caught.
  "unknown_disconnected",
]);

/**
 * Ask Twilio Lookup v2 whether an E.164 number is a real, dialable
 * line. Soft-fails OPEN — see module header. Never throws. Caches the
 * verdict for 30 days per number.
 *
 * @param e164  E.164 phone, e.g. "+14075551234". Caller should already
 *              have normalized via toE164(); a malformed value just
 *              soft-passes (Lookup would 404 → but we don't want to
 *              block on a normalization miss, so we guard up front).
 */
export async function verifyDialable(e164: string): Promise<DialableResult> {
  // Guard: nothing to look up / gate disabled → soft-pass. Don't pay
  // for a lookup we can't act on, and don't block a dial we can't vet.
  if (!e164 || !lookupEnabled()) {
    return { ok: true, lineType: null, reason: "lookup_unavailable" };
  }

  // Cache hit short-circuits the paid API call. The cached value is the
  // full DialableResult so repeat submits replay the exact verdict.
  const cacheKey = `${CACHE_KEY_PREFIX}${e164}`;
  try {
    const cached = await getCachedByKey<DialableResult>(cacheKey);
    if (cached) return cached;
  } catch {
    // Cache read failure is non-fatal — fall through to a live lookup.
  }

  const creds = twilioCreds();
  if (!creds) {
    // Race between lookupEnabled() and here (creds cleared mid-flight)
    // — soft-pass, don't throw.
    return { ok: true, lineType: null, reason: "lookup_unavailable" };
  }

  // ~4s budget. Lookup is usually <500ms; anything longer is an outage
  // and we'd rather soft-pass than stall the (already-delayed, inside-
  // waitUntil) dispatch.
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 4000);

  let result: DialableResult;
  try {
    const auth = Buffer.from(`${creds.sid}:${creds.token}`).toString("base64");
    const url = `https://lookup.twilio.com/v2/PhoneNumbers/${encodeURIComponent(
      e164,
    )}?Fields=line_type_intelligence`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
      signal: ctrl.signal,
    });

    if (res.status === 404) {
      // Twilio could not resolve the number at all — it's not a real,
      // assignable phone number. Hard "don't dial" verdict.
      result = { ok: false, lineType: null, reason: "not_found" };
    } else if (!res.ok) {
      // Any other non-2xx (401 bad creds, 429 rate-limited, 5xx outage)
      // → soft-fail OPEN. A Lookup hiccup must not block a real dial.
      console.warn("[phone-verify] lookup non-OK; soft-passing", {
        status: res.status,
      });
      result = { ok: true, lineType: null, reason: "lookup_unavailable" };
    } else {
      const json = (await res.json()) as LookupV2Response;
      const lti = json.line_type_intelligence ?? null;
      const lineType = lti?.type ?? null;
      const errorCode = lti?.error_code ?? null;

      if (json.valid === false) {
        // Twilio's top-level validity check says this isn't a usable
        // number — treat as undeliverable.
        result = { ok: false, lineType, reason: "invalid" };
      } else if (errorCode != null) {
        // LTI couldn't resolve the line — most commonly an invalid /
        // unallocated number. Block the dial; carry the code for logs.
        result = { ok: false, lineType, reason: `lti_error:${errorCode}` };
      } else if (lineType && UNDELIVERABLE_LINE_TYPES.has(lineType)) {
        result = { ok: false, lineType, reason: `undeliverable:${lineType}` };
      } else {
        // Valid mobile / landline / voip — dial away.
        result = { ok: true, lineType, reason: null };
      }
    }
  } catch (err) {
    // Timeout (AbortError) or transport failure → soft-fail OPEN.
    console.warn("[phone-verify] lookup threw; soft-passing", {
      err: err instanceof Error ? err.message : String(err),
    });
    result = { ok: true, lineType: null, reason: "lookup_unavailable" };
  } finally {
    clearTimeout(timeout);
  }

  // Only cache DEFINITIVE verdicts (clean pass or a Twilio-confirmed
  // bad number). Never cache a soft-fail "lookup_unavailable" — that's
  // a transient state; caching it for 30 days would freeze a temporary
  // outage into a month of unverified dials for that number.
  if (result.reason !== "lookup_unavailable") {
    try {
      await setCachedByKey(cacheKey, result, CACHE_TTL.monthly);
    } catch {
      // Cache write failure is non-fatal.
    }
  }

  return result;
}

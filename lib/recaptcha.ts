/**
 * Google reCAPTCHA v3 (invisible / score-based) verifier.
 *
 * Layered ON TOP of Vercel BotID for `POST /api/leads`. Both signals
 * have to pass for a lead to land. Architecture:
 *
 *   Client (app/page.tsx) — loads `grecaptcha`, mints a token per submit
 *     with `action: "submit_lead"`, sends it to /api/leads as
 *     `recaptchaToken`.
 *   Server (here) — POSTs token + secret to Google's siteverify, checks
 *     the score against THRESHOLD (default 0.5 per Google's
 *     recommendation), and asserts the action matches what the client
 *     claimed.
 *
 * Env vars:
 *   NEXT_PUBLIC_RECAPTCHA_SITE_KEY — client-side site key (public)
 *   RECAPTCHA_SECRET_KEY           — server-side secret (private)
 *   RECAPTCHA_MIN_SCORE            — override default 0.5 if needed
 *
 * Fails OPEN when `RECAPTCHA_SECRET_KEY` is unset so dev / preview
 * deployments keep working without provisioning Google credentials.
 * In production with the key set, a missing or low-score token is a
 * hard rejection.
 */

const SITE_VERIFY = "https://www.google.com/recaptcha/api/siteverify";
const DEFAULT_MIN_SCORE = 0.5;
const VERIFY_TIMEOUT_MS = 5_000;

interface SiteVerifyResponse {
  success: boolean;
  score?: number;
  action?: string;
  hostname?: string;
  challenge_ts?: string;
  "error-codes"?: string[];
}

export interface RecaptchaResult {
  /** Whether the request should be allowed through. */
  ok: boolean;
  /** Why it was rejected (or "configured_off" / "ok"). Useful in logs. */
  reason: string;
  /** Raw score (0.0–1.0); null when verification was skipped or failed. */
  score: number | null;
  /** Action Google saw on the token, for action-mismatch detection. */
  action: string | null;
}

function minScore(): number {
  const raw = Number(process.env.RECAPTCHA_MIN_SCORE);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_MIN_SCORE;
}

/**
 * Verify a v3 token against Google's siteverify endpoint.
 *
 * @param token           The token minted by `grecaptcha.execute()`.
 * @param expectedAction  The action string the client claimed at
 *                        execute time (e.g. "submit_lead"). Used to
 *                        detect token replay across actions.
 * @param remoteIp        Optional client IP for Google's risk model.
 */
export async function verifyRecaptcha(
  token: string | null | undefined,
  expectedAction: string,
  remoteIp?: string | null,
): Promise<RecaptchaResult> {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) {
    // Dev / preview / partner fork without Google credentials. Fail
    // open — BotID is still enforcing the bot gate; reCAPTCHA is
    // additive. The audit on this would catch a prod deploy that
    // forgot to set the secret because `score: null` makes it obvious
    // in logs.
    return { ok: true, reason: "configured_off", score: null, action: null };
  }

  if (!token || typeof token !== "string") {
    return {
      ok: false,
      reason: "missing_token",
      score: null,
      action: null,
    };
  }

  const params = new URLSearchParams();
  params.set("secret", secret);
  params.set("response", token);
  if (remoteIp) params.set("remoteip", remoteIp);

  let data: SiteVerifyResponse;
  try {
    const res = await fetch(SITE_VERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      cache: "no-store",
    });
    data = (await res.json()) as SiteVerifyResponse;
  } catch (err) {
    // Network hiccup talking to Google. Don't let a Google outage take
    // down lead capture — BotID is still in place. Log loudly so the
    // signal isn't lost.
    console.warn(
      "[recaptcha] siteverify network failure — allowing through:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: true, reason: "verify_network_error", score: null, action: null };
  }

  if (!data.success) {
    return {
      ok: false,
      reason: `siteverify_failed:${(data["error-codes"] ?? []).join(",") || "unknown"}`,
      score: typeof data.score === "number" ? data.score : null,
      action: data.action ?? null,
    };
  }

  // Action mismatch — token was minted for a different action (or no
  // action). Either a client bug or a replay attempt. Reject.
  if (data.action && data.action !== expectedAction) {
    return {
      ok: false,
      reason: `action_mismatch:${data.action}`,
      score: typeof data.score === "number" ? data.score : null,
      action: data.action,
    };
  }

  const score = typeof data.score === "number" ? data.score : null;
  const threshold = minScore();
  if (score !== null && score < threshold) {
    return {
      ok: false,
      reason: `low_score:${score.toFixed(2)}<${threshold}`,
      score,
      action: data.action ?? null,
    };
  }

  return {
    ok: true,
    reason: "ok",
    score,
    action: data.action ?? null,
  };
}

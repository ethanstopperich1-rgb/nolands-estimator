/**
 * JobNimbus event-logger — every customer-facing touchpoint should
 * leave a note on the contact so Noland's reps see the full timeline
 * inside JN itself (not buried in Vercel logs or Supabase rows).
 *
 * Touchpoints that go through this helper:
 *   - voice-consent submit  (TCPA paper trail visible to reps)
 *   - Podium SMS outbound   (every text Sarah/system sends to homeowner)
 *   - Podium SMS inbound    (every reply the homeowner sends back)
 *   - Sarah call start      (call_started event from agent worker)
 *   - Sarah call end        (full transcript dump on disconnect)
 *
 * Soft-fail philosophy:
 *   - If `contactId` is missing/empty, log a warning to Vercel and
 *     return — never throw. The lead may have only step-1 captured
 *     (no V3 push to JN yet).
 *   - If JOBNIMBUS_API_KEY is unset, attachNote already returns
 *     `{ ok: false, reason: "not_configured" }` — same soft-fail.
 *   - HTTP failures get console.error'd with a [jn-log] tag so they
 *     surface in `vercel logs --filter='[jn-log]'`.
 *
 * Fire-and-forget: callers should NOT await this. Wrap it in
 * `void logJN(...)` so the caller's response isn't blocked on JN's
 * 200-500ms round-trip.
 */
import { attachNote, jobNimbusConfigured } from "@/lib/jobnimbus";

export type JNLogTag =
  | "voice-consent"
  | "sms-out"
  | "sms-in"
  | "call-started"
  | "call-ended"
  | "post-call"
  | "consent-tcpa-marketing"
  | "lead-step1"
  | "lead-step-final";

/**
 * Format a note body with a tag prefix so reps can scan the JN
 * timeline visually (Noland's reps already do this — every existing
 * intake-log note in their org starts with a `[SOURCE]` token).
 */
function formatBody(tag: JNLogTag, body: string): string {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return `[${tag.toUpperCase()}] ${ts}\n${body.trim()}`;
}

/**
 * Fire-and-forget JN note attachment. Returns immediately; the
 * actual HTTP request runs on the event loop.
 *
 * Usage:
 *   void logJN(lead.jobnimbus_contact_id, "voice-consent",
 *              `TCPA consent captured at /r/${publicId}. IP: ${ip}`);
 */
export function logJN(
  contactId: string | null | undefined,
  tag: JNLogTag,
  body: string,
): void {
  if (!contactId) {
    // No JN linkage yet — most likely a step-1 capture that never
    // ran through V3. Log so we know what's being dropped.
    console.warn(
      `[jn-log] no contactId for tag=${tag} — skipping. ` +
        `body=${body.slice(0, 80)}...`,
    );
    return;
  }
  if (!jobNimbusConfigured()) {
    console.warn(`[jn-log] JOBNIMBUS_API_KEY not set — skipping tag=${tag}`);
    return;
  }
  // Fire the request without awaiting. The caller's response goes
  // out the door immediately; this resolves on the event loop.
  void (async () => {
    try {
      const result = await attachNote({
        contactId,
        body: formatBody(tag, body),
      });
      if (!result.ok) {
        console.error(
          `[jn-log] attachNote failed tag=${tag} contactId=${contactId} ` +
            `reason=${result.reason} error=${result.error ?? ""}`,
        );
        return;
      }
      console.log(
        `[jn-log] tag=${tag} contactId=${contactId} note=${result.jnid}`,
      );
    } catch (err) {
      console.error(
        `[jn-log] threw tag=${tag} contactId=${contactId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

/**
 * Same as logJN but awaits — use ONLY from background routes like
 * cron handlers where the response isn't user-facing.
 */
export async function logJNSync(
  contactId: string | null | undefined,
  tag: JNLogTag,
  body: string,
): Promise<void> {
  if (!contactId || !jobNimbusConfigured()) {
    if (!contactId) {
      console.warn(`[jn-log] sync: no contactId for tag=${tag}`);
    }
    return;
  }
  try {
    const result = await attachNote({
      contactId,
      body: formatBody(tag, body),
    });
    if (!result.ok) {
      console.error(
        `[jn-log] sync attachNote failed tag=${tag} reason=${result.reason}`,
      );
    } else {
      console.log(
        `[jn-log] sync tag=${tag} contactId=${contactId} note=${result.jnid}`,
      );
    }
  } catch (err) {
    console.error(
      `[jn-log] sync threw tag=${tag}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

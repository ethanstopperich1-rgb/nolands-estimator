/**
 * Reminder template registry.
 *
 * Two send paths are supported:
 *   1. Podium template IDs — set the env var below to a Podium template
 *      UID and the cron sends via the template path (preferred — gives
 *      Noland's reps a paper trail in Podium and lets them A/B test
 *      copy without code changes).
 *   2. Inline fallback copy — when the env var is unset, the cron sends
 *      the raw-text fallback defined here. Lets us launch before
 *      Noland's drafts the templates in Podium.
 *
 * Touchpoint names are the canonical contract between cron logic and
 * the lib/podium-reminders.ts dispatcher. Do not rename without a
 * coordinated grep — `tests/reminder-state-machine.test.ts` locks the
 * set.
 *
 * Marketing psychology each touchpoint targets is annotated inline so
 * the copywriter (Noland's or Voxaris) can preserve the lever when
 * customizing template text. See marketing-psychology skill for the
 * full model.
 */

export type ReminderTouchpoint =
  // Sequence A — no-show prevention (between booking and appointment)
  | "A1_INSTANT"
  | "A2_T24H"
  | "A3_MORNING"
  | "A4_ETA"
  | "A5_POST_APPT"
  // Sequence B — abandoner nurture (estimator submitted, never booked).
  // B1 fires from /api/gemini-roof on V3 success (Podium estimate-ready
  // rich card). B1_5 closes the 23.5h dark window between B1 and B2 —
  // the highest-attention moment for an abandoner is the 2-3h after
  // they pulled the estimate but didn't book.
  | "B15_T2H_NUDGE"
  | "B2_T24H_OPEN_LOOP"
  | "B3_T3D_NEIGHBOR"
  | "B4_T7D_STORM_ANCHOR"
  | "B5_T21D_GRACE_EXIT";

/**
 * Env var name registry. Each touchpoint maps to ONE env var that, if
 * set, holds the Podium template UID. Unset → fallback to inline copy.
 */
export const REMINDER_TEMPLATE_ENV: Record<ReminderTouchpoint, string> = {
  A1_INSTANT: "PODIUM_TEMPLATE_A1_INSTANT",
  A2_T24H: "PODIUM_TEMPLATE_A2_T24H",
  A3_MORNING: "PODIUM_TEMPLATE_A3_MORNING",
  A4_ETA: "PODIUM_TEMPLATE_A4_ETA",
  A5_POST_APPT: "PODIUM_TEMPLATE_A5_POST_APPT",
  B15_T2H_NUDGE: "PODIUM_TEMPLATE_B15_T2H",
  B2_T24H_OPEN_LOOP: "PODIUM_TEMPLATE_B2_T24H",
  B3_T3D_NEIGHBOR: "PODIUM_TEMPLATE_B3_T3D",
  B4_T7D_STORM_ANCHOR: "PODIUM_TEMPLATE_B4_T7D",
  B5_T21D_GRACE_EXIT: "PODIUM_TEMPLATE_B5_T21D",
};

/**
 * Variables every template/fallback receives. Keep the names short —
 * Podium's template merge syntax matches by exact key.
 */
export interface ReminderVars {
  firstName: string;
  /** Short address (no state/zip) — e.g. "8450 Oak Park Ave". */
  address: string;
  /** Local appointment time formatted in America/New_York. Empty string for B-sequence. */
  appointmentLocal: string;
  /** Day of week of appointment (Monday, Tuesday, ...). Empty for B-sequence. */
  appointmentDayOfWeek: string;
  /** Public share URL — typically estimate.nolandsroofing.com/r/<publicId>. */
  shareUrl: string;
  /** Rep first name when known; defaults to "the Noland's team". */
  repName: string;
}

/**
 * Inline fallback copy. Used when the Podium template env var isn't set.
 *
 * Compliance constraints (locked):
 *   - NEVER the word "insurance" customer-facing (FL § 627.7152).
 *   - Always include opt-out language ("Reply STOP" or "Reply 3" per
 *     touchpoint design).
 *   - Noland's claims, not Voxaris guarantees.
 *
 * Length budget: keep under 320 chars (≤ 2 SMS segments). Podium
 * handles segmentation but billable units add up at scale.
 */
export function renderFallbackCopy(
  touchpoint: ReminderTouchpoint,
  v: ReminderVars,
): string {
  switch (touchpoint) {
    // ─── Sequence A ─────────────────────────────────────────────────
    case "A1_INSTANT":
      // Commitment & Consistency + Reciprocity + Pratfall opt-out.
      // We name the rep (commitment by proxy), confirm the slot
      // verbatim (consistency anchor), and offer reschedule
      // without guilt (pratfall) so people don't ghost.
      return (
        `Hi ${v.firstName}, ${v.repName} from Noland's Roofing here. ` +
        `You're locked in for ${v.appointmentDayOfWeek} ${v.appointmentLocal} ` +
        `at ${v.address}. Need to move it? Reply with a better day. ` +
        `Reply STOP to opt out.`
      );

    case "A2_T24H":
      // Mere Exposure + Local social proof. Mentioning the
      // neighborhood activity normalizes the visit.
      return (
        `Hi ${v.firstName}, quick reminder — ${v.repName} from Noland's ` +
        `will be at ${v.address} tomorrow at ${v.appointmentLocal}. ` +
        `We've measured 3 other roofs on your street this month. ` +
        `Reply 1 to confirm, 2 to reschedule. STOP to opt out.`
      );

    case "A3_MORNING":
      // Goal-Gradient + Anchoring. "First stop today" creates
      // anticipation of an imminent specific event.
      return (
        `Good morning ${v.firstName}, your roof inspection is today ` +
        `at ${v.appointmentLocal}. ${v.repName} has your address ` +
        `(${v.address}) as a stop today. We'll text you a 30-min ` +
        `heads-up. Reply 2 to reschedule. STOP to opt out.`
      );

    case "A4_ETA":
      // Loss Aversion + reschedule opt-out. Naming the imminent
      // arrival prevents "I forgot" no-shows.
      return (
        `${v.firstName}, ${v.repName} is ~30 minutes out from ` +
        `${v.address}. No need to be home — we measure exterior only. ` +
        `Reply 2 if you need to reschedule. STOP to opt out.`
      );

    case "A5_POST_APPT":
      // Peak-End + endowment. Closing the loop on a strong note
      // even when no estimate was given on the spot.
      return (
        `Hi ${v.firstName}, ${v.repName} finished measuring your ` +
        `roof. Your full estimate is at ${v.shareUrl}. Questions? ` +
        `Reply here — we read every message. STOP to opt out.`
      );

    // ─── Sequence B ─────────────────────────────────────────────────
    case "B15_T2H_NUDGE":
      // Pratfall + low-friction reply. The customer has the estimate
      // still warm on their phone (the Podium B1 message landed ~2h
      // ago). This is NOT a sales push — it's a "still here if you
      // have questions" open door. Conversion lift comes from
      // re-opening the conversation thread inside Podium while the
      // homeowner is most likely to be actively comparing options.
      return (
        `Hi ${v.firstName}, your roof report for ${v.address} is still ` +
        `live: ${v.shareUrl}. Questions about the price or what's included? ` +
        `Reply here — a real person will answer. Reply STOP to opt out.`
      );

    case "B2_T24H_OPEN_LOOP":
      // Zeigarnik. Open loop — explicit "you started but didn't
      // finish" framing. People feel the unfinished tug.
      return (
        `Hi ${v.firstName}, you pulled an estimate for ${v.address} ` +
        `yesterday but didn't book a time. Your roof report is still ` +
        `live at ${v.shareUrl}. Reply 1 to schedule, 3 to skip. STOP to opt out.`
      );

    case "B3_T3D_NEIGHBOR":
      // Mimetic desire. Real local proof point — neighbors using
      // Noland's makes the decision feel pre-validated.
      return (
        `${v.firstName}, two neighbors near ${v.address} booked ` +
        `roof inspections with Noland's this week. Your report is ` +
        `still here: ${v.shareUrl}. Reply 1 to book, 3 to skip. STOP to opt out.`
      );

    case "B4_T7D_STORM_ANCHOR":
      // Anchoring + storm context. FL weather is genuinely a
      // forcing function — this isn't manufactured urgency.
      return (
        `${v.firstName}, FL storm season is here and we're booking ` +
        `2-3 weeks out. Your ${v.address} report is still live: ` +
        `${v.shareUrl}. Reply 1 to grab a slot, 3 to skip. STOP to opt out.`
      );

    case "B5_T21D_GRACE_EXIT":
      // Pratfall. Final check-in that explicitly admits we'll
      // stop pinging — increases trust + reduces opt-out rage.
      return (
        `Hi ${v.firstName}, last check-in from Noland's. Your ` +
        `${v.address} report stays live at ${v.shareUrl}. Reply 1 to ` +
        `book a time, 3 to stop hearing from us. We hope your roof ` +
        `stays dry either way.`
      );
  }
}

/**
 * Resolve a touchpoint to either a Podium template UID (when env-set)
 * or null (caller must use renderFallbackCopy).
 */
export function resolveTemplateUid(
  touchpoint: ReminderTouchpoint,
): string | null {
  const envName = REMINDER_TEMPLATE_ENV[touchpoint];
  const value = process.env[envName];
  return value && value.trim() ? value.trim() : null;
}

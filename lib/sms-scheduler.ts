/**
 * SMS scheduling helpers — drives the YES/SCHEDULE → offer-two-slots
 * → A/B-picks → book-JN-task state machine in /api/sms/inbound.
 *
 * Time-slot policy (Noland's defaults):
 *   - Morning window: 9:00 AM ET (1 hour)
 *   - Afternoon window: 1:00 PM ET (1 hour)
 *   - Skip Saturday + Sunday
 *   - Skip slots more than 7 business days out (keeps offers fresh)
 *   - Earliest = next business day (never today — homeowner needs prep time
 *     + the rep needs lead time to route the task)
 *
 * What this module DOES NOT do (yet):
 *   - JN availability check before offering. v1 always offers the next
 *     business-day morning + afternoon, regardless of what's already
 *     booked on the JN calendar. Risk = double-booking at launch
 *     volume is low. v2 should call searchJobsByDateRange and filter
 *     out taken slots; left as TODO. See checkAvailability() in
 *     voxaris-pitch/agents/sydney/tools.py for the reference
 *     implementation Sarah's voice agent already runs.
 */

import type { SlotOffer } from "@/lib/sms-conversation";

// Eastern Time offset for Noland's. FL doesn't observe DST changes for
// this purpose (we just use the offset at runtime — Intl handles DST).
const TZ_NOLANDS = "America/New_York";

interface SlotTemplate {
  hour: number; // 0-23, local ET
  window: "morning" | "afternoon";
  label: string;
}

const DEFAULT_TEMPLATES: SlotTemplate[] = [
  { hour: 9, window: "morning", label: "9 AM–12 PM" },
  { hour: 13, window: "afternoon", label: "1 PM–5 PM" },
];

/**
 * Compute the next N business-day slot offers starting from `from`.
 *
 * Default behavior: offer slots from the next business day onward
 * (skipping today and weekends), pick the FIRST n unique slots
 * across the candidate windows in order.
 *
 * Returns an array of SlotOffer objects ready to persist on the
 * SmsConversation + render into the SMS body.
 */
export function nextBusinessSlots(opts?: {
  from?: Date;
  count?: number;
  templates?: SlotTemplate[];
}): SlotOffer[] {
  const from = opts?.from ?? new Date();
  const count = opts?.count ?? 2;
  const templates = opts?.templates ?? DEFAULT_TEMPLATES;

  const slots: SlotOffer[] = [];
  // Walk forward day-by-day from tomorrow until we have `count` slots
  // or we've walked 7 days (safety cap — avoids infinite loop on
  // weird inputs).
  let dayCursor = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  let daysWalked = 0;
  while (slots.length < count && daysWalked < 7) {
    const dow = getEtDayOfWeek(dayCursor);
    const isWeekend = dow === 0 || dow === 6;
    if (!isWeekend) {
      for (const t of templates) {
        if (slots.length >= count) break;
        const iso = buildEtIsoString(dayCursor, t.hour);
        slots.push({
          key: String.fromCharCode("A".charCodeAt(0) + slots.length),
          iso,
          label: `${formatEtDayLabel(dayCursor)} ${t.label}`,
          window: t.window,
        });
      }
    }
    dayCursor = new Date(dayCursor.getTime() + 24 * 60 * 60 * 1000);
    daysWalked++;
  }
  return slots;
}

/**
 * Availability-aware variant of nextBusinessSlots. EXCLUDES windows that
 * already have an appointment on the JobNimbus calendar, then rolls
 * forward to find `count` FREE windows.
 *
 * Pass the unix-SECOND start times of booked tasks (from
 * `searchTasksByDateRange` — appointments live as JN tasks, not jobs).
 * Any candidate (ET-day, window) that collides with a booked task is
 * skipped.
 *
 * Conservative by design: a window with ANY existing appointment is
 * treated as taken. v1 has no per-rep capacity model (that's the
 * multi-location calendar work) — worst case the homeowner gets a
 * slightly-later window, never a double-booked one. If fewer than
 * `count` free slots exist in the horizon, returns what it found and the
 * caller falls back to `nextBusinessSlots` so an offer always goes out.
 */
export function selectAvailableSlots(opts: {
  bookedUnix: number[];
  from?: Date;
  count?: number;
  maxBusinessDays?: number;
  templates?: SlotTemplate[];
}): SlotOffer[] {
  const from = opts.from ?? new Date();
  const count = opts.count ?? 2;
  const maxBusinessDays = opts.maxBusinessDays ?? 10;
  const templates = opts.templates ?? DEFAULT_TEMPLATES;

  // Bucket booked appointments into "<ET-day>:<window>" keys.
  const taken = new Set<string>();
  for (const unix of opts.bookedUnix) {
    const bucket = etDayWindowBucket(unix);
    if (bucket) taken.add(bucket);
  }

  const slots: SlotOffer[] = [];
  let dayCursor = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  let businessDaysWalked = 0;
  let calendarDaysWalked = 0; // safety cap against an infinite loop
  while (
    slots.length < count &&
    businessDaysWalked < maxBusinessDays &&
    calendarDaysWalked < 30
  ) {
    const dow = getEtDayOfWeek(dayCursor);
    const isWeekend = dow === 0 || dow === 6;
    if (!isWeekend) {
      businessDaysWalked++;
      const dayKey = etDayKey(dayCursor);
      for (const t of templates) {
        if (slots.length >= count) break;
        if (taken.has(`${dayKey}:${t.window}`)) continue; // window booked
        slots.push({
          key: String.fromCharCode("A".charCodeAt(0) + slots.length),
          iso: buildEtIsoString(dayCursor, t.hour),
          label: `${formatEtDayLabel(dayCursor)} ${t.label}`,
          window: t.window,
        });
      }
    }
    dayCursor = new Date(dayCursor.getTime() + 24 * 60 * 60 * 1000);
    calendarDaysWalked++;
  }
  return slots;
}

/**
 * Public: the "<ET-day>:<window>" bucket for a unix-SECOND time, or null
 * if it's outside our offered windows. Used by the booking handler's
 * Gap 1.5 re-check — "is the picked slot STILL free at book time?" — to
 * compare the chosen slot against tasks booked since the offer went out.
 */
export function windowBucketOf(unixSeconds: number): string | null {
  return etDayWindowBucket(unixSeconds);
}

/**
 * Compose the "pick a time" SMS body. Mentions both offered slots,
 * the A/B keys, and the CALL fallback. Stays under 320 chars (~2 SMS
 * segments) to keep deliverability + cost in line.
 */
export function buildSlotOfferBody(opts: {
  firstName: string;
  slots: SlotOffer[];
}): string {
  const greet = opts.firstName.split(/\s+/)[0] || "there";
  const slotsRendered = opts.slots
    .map((s) => `${s.key}) ${s.label}`)
    .join("  ");
  return (
    `Got it, ${greet}! Two open windows this week:  ` +
    `${slotsRendered}  ` +
    `Reply ${opts.slots.map((s) => s.key).join(" or ")} to lock it in. ` +
    `Prefer a call? Reply CALL or call (352) 242-4322. Reply STOP to opt out.`
  ).slice(0, 480);
}

/**
 * Compose the confirmation SMS sent after the homeowner picks a slot.
 * Tone: warm + concrete + sets the reminder expectation.
 */
export function buildSlotConfirmedBody(opts: {
  firstName: string;
  slot: SlotOffer;
}): string {
  const greet = opts.firstName.split(/\s+/)[0] || "there";
  return (
    `Locked in for ${opts.slot.label}, ${greet}. ` +
    `A Noland's Roofing rep will arrive in that window. ` +
    `We'll text a reminder the morning of. Reply STOP to opt out.`
  ).slice(0, 320);
}

/**
 * Parse a homeowner's reply into a slot pick. Accepts "A", "B", "1",
 * "2", "a)", "B.", "option a", and similar lazy formats.
 * Returns the matched SlotOffer or null.
 */
export function parseSlotPick(
  body: string,
  offered: SlotOffer[],
): SlotOffer | null {
  if (offered.length === 0) return null;
  const cleaned = body.trim().toUpperCase();
  // Letter form: "A", "B", "a)", "B.", "option a"
  const letterMatch = cleaned.match(/\b([A-Z])\b/);
  if (letterMatch) {
    const slot = offered.find((s) => s.key === letterMatch[1]);
    if (slot) return slot;
  }
  // Numeric form: "1", "2", "option 1"
  const numMatch = cleaned.match(/\b([12])\b/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    return offered[idx] ?? null;
  }
  return null;
}

/**
 * Detect whether an offer set is stale (>24h old). Stale offers must
 * be re-issued — calendar slots that were open yesterday may be
 * booked today, and the homeowner's intent might have shifted.
 */
export function isOfferStale(offeredAt: string | undefined): boolean {
  if (!offeredAt) return true;
  const offered = new Date(offeredAt);
  if (Number.isNaN(offered.getTime())) return true;
  const ageMs = Date.now() - offered.getTime();
  return ageMs > 24 * 60 * 60 * 1000;
}

// ─── Internals (timezone arithmetic) ──────────────────────────────────

/**
 * Day of week (0 = Sunday, 6 = Saturday) for a given Date evaluated in
 * Noland's local timezone (ET). Uses Intl.DateTimeFormat to avoid the
 * "Date.getDay() returns UTC-relative" trap.
 */
function getEtDayOfWeek(date: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ_NOLANDS,
    weekday: "short",
  });
  const short = fmt.format(date);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[short] ?? 0;
}

/** ET calendar-day key "YYYY-MM-DD" for a Date (en-CA renders ISO order). */
function etDayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ_NOLANDS,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Map a unix-SECOND timestamp to its "<ET-day>:<window>" bucket, or null
 * when the time falls outside our offered windows (e.g. evening) so it
 * never blocks a 9 AM / 1 PM offer. Morning = before 12 PM ET; afternoon
 * = 12 PM–5 PM ET. Keep the boundaries in sync with DEFAULT_TEMPLATES.
 */
function etDayWindowBucket(unixSeconds: number): string | null {
  if (!Number.isFinite(unixSeconds)) return null;
  const d = new Date(unixSeconds * 1000);
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ_NOLANDS,
    hour: "2-digit",
    hour12: false,
  }).format(d);
  // "24" can appear at midnight in some runtimes; normalize to 0.
  const hour = parseInt(hourStr, 10) % 24;
  if (Number.isNaN(hour)) return null;
  if (hour < 12) return `${etDayKey(d)}:morning`;
  if (hour < 17) return `${etDayKey(d)}:afternoon`;
  return null; // evening / after-hours — doesn't conflict with our windows
}

/**
 * Build an ISO 8601 timestamp anchored at the given local hour in ET.
 * Output looks like "2026-05-27T09:00:00-04:00" (DST-aware).
 *
 * We do this the "hard way" with parts because vanilla `new Date()`
 * interprets fractional ISO as UTC, which throws off the rendering.
 */
function buildEtIsoString(date: Date, hourLocal: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ_NOLANDS,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "2026";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  // longOffset looks like "GMT-04:00"; strip the "GMT" prefix.
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00";
  const offset = tzPart.replace(/^GMT/, "");
  const hh = String(hourLocal).padStart(2, "0");
  return `${year}-${month}-${day}T${hh}:00:00${offset}`;
}

/** Human-readable day label for the SMS: "Wed May 27". */
function formatEtDayLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ_NOLANDS,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

import { NextResponse } from "next/server";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import { resolveBaseUrl } from "@/lib/base-url";
import {
  pickBSequenceTouchpoint,
  sendReminderTouchpoint,
  type ReminderLead,
} from "@/lib/podium-reminders";
import type { ReminderTouchpoint } from "@/lib/reminder-templates";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/cron/podium-abandoners
 *
 * Sequence B (abandoner nurture) cron — runs hourly.
 *
 * Targets leads who pulled a roof estimate but never booked. These
 * are NOT no-shows — they're top-of-funnel re-engagement, gated by
 * TCPA consent and bounded to 4 touchpoints over 21 days.
 *
 * Flow:
 *   1. Query leads where:
 *      - phone present
 *      - tcpa_consent = true (TCPA acts as our marketing-consent proxy
 *        until a dedicated marketing_consent column lands)
 *      - reminder_opted_out = false
 *      - abandoner_step < 5
 *      - status NOT IN ('appt_scheduled','booked','completed',
 *        'lost','unsubscribed') — the "still in play" states
 *      - created_at within last 30 days (cap the nurture pool)
 *   2. For each lead, pickBSequenceTouchpoint decides which step
 *      fires now. Returns null if no touchpoint fits the
 *      created_at + abandoner_step window.
 *   3. Send via sendReminderTouchpoint. On success, increment
 *      abandoner_step + stamp abandoner_last_sent_at.
 *
 * Failure isolation: per-lead try/catch — one Podium error doesn't
 * block the batch.
 */

// Statuses where the lead has converted or explicitly disengaged.
// These short-circuit any further abandoner nurture.
const NURTURE_TERMINAL_STATUSES = [
  "appt_scheduled",
  "booked",
  "completed",
  "lost",
  "unsubscribed",
];

interface AbandonerRunStats {
  leadsEvaluated: number;
  sent: number;
  skipped: number;
  errors: number;
  byTouchpoint: Record<string, number>;
}

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.warn(
      "[cron podium-abandoners] rejected — CRON_SECRET not configured",
    );
    return false;
  }
  if (req.headers.get("authorization") === `Bearer ${expected}`) return true;
  if (req.headers.get("x-vercel-cron-signature") === expected) return true;
  return false;
}

// Step-to-touchpoint lookup for stamping back to the row. Kept here
// because the cron is the only writer of abandoner_step.
function touchpointToStep(
  tp:
    | "B2_T24H_OPEN_LOOP"
    | "B3_T3D_NEIGHBOR"
    | "B4_T7D_STORM_ANCHOR"
    | "B5_T21D_GRACE_EXIT",
): number {
  switch (tp) {
    case "B2_T24H_OPEN_LOOP":
      return 2;
    case "B3_T3D_NEIGHBOR":
      return 3;
    case "B4_T7D_STORM_ANCHOR":
      return 4;
    case "B5_T21D_GRACE_EXIT":
      return 5;
  }
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!supabaseServiceRoleConfigured()) {
    return NextResponse.json({
      status: "skipped",
      reason: "supabase_service_role_not_configured",
    });
  }

  const stats: AbandonerRunStats = {
    leadsEvaluated: 0,
    sent: 0,
    skipped: 0,
    errors: 0,
    byTouchpoint: {},
  };
  const now = new Date();
  // Cast to any until migration 0020 is applied + types regenerated.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createServiceRoleClient();
  const baseUrl = resolveBaseUrl();

  // Cap nurture pool to leads <= 30 days old. Older than that, the
  // homeowner's purchase intent has decayed past where it's worth a
  // re-engagement send.
  const poolStart = new Date(
    now.getTime() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  let leads: Array<Record<string, any>> = [];
  try {
    const { data, error } = await sb
      .from("leads")
      .select(
        "public_id, name, phone, address, office_id, created_at, status, " +
          "tcpa_consent, reminder_opted_out, abandoner_step, " +
          "abandoner_last_sent_at",
      )
      .eq("reminder_opted_out", false)
      .eq("tcpa_consent", true)
      .lt("abandoner_step", 5)
      .gte("created_at", poolStart)
      .not("status", "in", `(${NURTURE_TERMINAL_STATUSES.join(",")})`)
      .limit(500);
    if (error) {
      console.warn("[cron podium-abandoners] lead query failed:", error.message);
      return NextResponse.json(
        { status: "error", reason: error.message, stats },
        { status: 500 },
      );
    }
    leads = data ?? [];
  } catch (err) {
    console.warn("[cron podium-abandoners] lead query threw:", err);
    return NextResponse.json(
      { status: "error", reason: String(err), stats },
      { status: 500 },
    );
  }

  stats.leadsEvaluated = leads.length;

  for (const row of leads) {
    try {
      if (!row.phone || row.phone.trim().length < 7) {
        stats.skipped += 1;
        continue;
      }
      const createdAt = new Date(row.created_at);
      if (Number.isNaN(createdAt.getTime())) {
        stats.skipped += 1;
        continue;
      }
      const lastSent = row.abandoner_last_sent_at
        ? new Date(row.abandoner_last_sent_at)
        : null;

      const touchpoint = pickBSequenceTouchpoint(
        createdAt,
        Number(row.abandoner_step ?? 0),
        lastSent && !Number.isNaN(lastSent.getTime()) ? lastSent : null,
        now,
      );
      if (!touchpoint) {
        stats.skipped += 1;
        continue;
      }

      const reminderLead: ReminderLead = {
        publicId: row.public_id,
        name: row.name ?? "there",
        phone: row.phone ?? "",
        address: row.address ?? "",
        shareUrl: `${baseUrl}/r/${row.public_id}`,
        appointmentAt: null,
        repFirstName: null,
        optedOut: Boolean(row.reminder_opted_out),
      };

      const result = await sendReminderTouchpoint(
        touchpoint as ReminderTouchpoint,
        reminderLead,
      );
      if (!result.sent) {
        if (result.reason === "not_configured") {
          stats.skipped += 1;
        } else {
          stats.errors += 1;
        }
        continue;
      }

      const newStep = touchpointToStep(touchpoint);
      const { error: stampErr } = await sb
        .from("leads")
        .update({
          abandoner_step: newStep,
          abandoner_last_sent_at: new Date().toISOString(),
        })
        .eq("public_id", row.public_id)
        // Only advance step forward — guards against double-cron-overlap
        // races re-sending the same step.
        .lt("abandoner_step", newStep);
      if (stampErr) {
        console.warn(
          `[cron podium-abandoners] stamp failed for ${row.public_id}:`,
          stampErr.message,
        );
      }
      stats.sent += 1;
      stats.byTouchpoint[touchpoint] = (stats.byTouchpoint[touchpoint] ?? 0) + 1;
    } catch (err) {
      console.warn(
        `[cron podium-abandoners] lead ${row.public_id} threw:`,
        err,
      );
      stats.errors += 1;
    }
  }

  return NextResponse.json({ status: "ok", stats });
}

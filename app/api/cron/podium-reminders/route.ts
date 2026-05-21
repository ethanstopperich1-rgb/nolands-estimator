import { NextResponse } from "next/server";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import { resolveBaseUrl } from "@/lib/base-url";
import {
  jobNimbusConfigured,
  searchJobsByDateRange,
} from "@/lib/jobnimbus";
import {
  pickASequenceTouchpoint,
  sendReminderTouchpoint,
  A_TOUCHPOINT_COLUMN,
  type ReminderLead,
} from "@/lib/podium-reminders";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/cron/podium-reminders
 *
 * Sequence A (no-show prevention) cron — runs every 15 minutes.
 *
 * Flow:
 *   1. JN sync — fetch jobs whose date_start falls in [now, now+30d]
 *      via searchJobsByDateRange. For each job with a primary contact
 *      id matching a leads.jobnimbus_contact_id, upsert appointment_at
 *      + appointment_jn_job_id on the lead row. This denormalized cache
 *      lets the reminder logic skip a JN round-trip per lead per tick.
 *   2. Pick — for each lead with appointment_at set and NOT opted out,
 *      ask pickASequenceTouchpoint which touchpoint is eligible right
 *      now (one per lead per tick).
 *   3. Send — dispatch via sendReminderTouchpoint. Soft-fails when
 *      Podium isn't configured.
 *   4. Stamp — write the corresponding "_sent_at" column atomically
 *      (UPDATE ... WHERE column IS NULL — idempotent under retry).
 *
 * Auth: matches the storm-pulse pattern. CRON_SECRET via Bearer or
 * x-vercel-cron-signature.
 *
 * Failure isolation: every external call (JN, Podium, Supabase) is
 * try-catch wrapped at the lead level. One lead's failure can't block
 * the rest of the batch.
 */

interface ReminderRunStats {
  jnSynced: number;
  jnErrors: number;
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
      "[cron podium-reminders] rejected — CRON_SECRET not configured",
    );
    return false;
  }
  if (req.headers.get("authorization") === `Bearer ${expected}`) return true;
  if (req.headers.get("x-vercel-cron-signature") === expected) return true;
  return false;
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

  const stats: ReminderRunStats = {
    jnSynced: 0,
    jnErrors: 0,
    leadsEvaluated: 0,
    sent: 0,
    skipped: 0,
    errors: 0,
    byTouchpoint: {},
  };
  const now = new Date();
  // Cast to any until migration 0020 is applied + types regenerated —
  // same pattern as the JN columns. We query/write columns the type
  // generator doesn't know about yet (appointment_at, reminder_*).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createServiceRoleClient();
  const baseUrl = resolveBaseUrl();

  // ── Step 1: JN → cache sync ─────────────────────────────────────────
  if (jobNimbusConfigured()) {
    try {
      const startUnix = Math.floor(now.getTime() / 1000);
      const endUnix = startUnix + 30 * 24 * 60 * 60;
      const search = await searchJobsByDateRange(startUnix, endUnix, 200);
      if (search.ok) {
        for (const job of search.jobs) {
          if (!job.primaryContactId || !job.dateStart) continue;
          try {
            const apptIso = new Date(job.dateStart * 1000).toISOString();
            const { error } = await sb
              .from("leads")
              .update({
                appointment_at: apptIso,
                appointment_jn_job_id: job.jnid,
              })
              .eq("jobnimbus_contact_id", job.primaryContactId);
            if (error) {
              stats.jnErrors += 1;
            } else {
              stats.jnSynced += 1;
            }
          } catch {
            stats.jnErrors += 1;
          }
        }
      } else {
        stats.jnErrors += 1;
      }
    } catch (err) {
      console.warn("[cron podium-reminders] JN sync failed:", err);
      stats.jnErrors += 1;
    }
  }

  // ── Step 2: query eligible leads ────────────────────────────────────
  // Eligible = has appointment_at set in [now-3h, now+30d], not opted out.
  // The 3h trailing window covers Sequence A5 (post-appointment touch).
  const windowStart = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(
    now.getTime() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  let leads: Array<Record<string, any>> = [];
  try {
    const { data, error } = await sb
      .from("leads")
      .select(
        "public_id, name, phone, address, office_id, appointment_at, " +
          "reminder_instant_sent_at, reminder_t24h_sent_at, " +
          "reminder_morning_sent_at, reminder_eta_sent_at, " +
          "reminder_post_appt_sent_at, reminder_opted_out",
      )
      .eq("reminder_opted_out", false)
      .gte("appointment_at", windowStart)
      .lte("appointment_at", windowEnd)
      .limit(500);
    if (error) {
      console.warn("[cron podium-reminders] lead query failed:", error.message);
      return NextResponse.json(
        { status: "error", reason: error.message, stats },
        { status: 500 },
      );
    }
    leads = data ?? [];
  } catch (err) {
    console.warn("[cron podium-reminders] lead query threw:", err);
    return NextResponse.json(
      { status: "error", reason: String(err), stats },
      { status: 500 },
    );
  }

  stats.leadsEvaluated = leads.length;

  // ── Step 3: pick + send per lead ────────────────────────────────────
  for (const row of leads) {
    try {
      const apptAt = new Date(row.appointment_at);
      if (Number.isNaN(apptAt.getTime())) {
        stats.skipped += 1;
        continue;
      }
      const touchpoint = pickASequenceTouchpoint(apptAt, now, {
        instant: Boolean(row.reminder_instant_sent_at),
        t24h: Boolean(row.reminder_t24h_sent_at),
        morning: Boolean(row.reminder_morning_sent_at),
        eta: Boolean(row.reminder_eta_sent_at),
        postAppt: Boolean(row.reminder_post_appt_sent_at),
      });
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
        appointmentAt: row.appointment_at,
        repFirstName: null, // Future: resolve from office assignment.
        optedOut: Boolean(row.reminder_opted_out),
      };

      const result = await sendReminderTouchpoint(touchpoint, reminderLead);
      if (!result.sent) {
        if (result.reason === "not_configured") {
          // Cron continues to run safely; just don't stamp.
          stats.skipped += 1;
        } else {
          stats.errors += 1;
        }
        continue;
      }

      const column = A_TOUCHPOINT_COLUMN[touchpoint];
      const stamp: Record<string, string> = {};
      stamp[column] = new Date().toISOString();
      const { error: stampErr } = await sb
        .from("leads")
        .update(stamp)
        .eq("public_id", row.public_id)
        .is(column, null);
      if (stampErr) {
        // Send already went out — log but don't double-send.
        console.warn(
          `[cron podium-reminders] stamp failed for ${row.public_id} ${touchpoint}:`,
          stampErr.message,
        );
      }
      stats.sent += 1;
      stats.byTouchpoint[touchpoint] = (stats.byTouchpoint[touchpoint] ?? 0) + 1;
    } catch (err) {
      console.warn(
        `[cron podium-reminders] lead ${row.public_id} threw:`,
        err,
      );
      stats.errors += 1;
    }
  }

  return NextResponse.json({ status: "ok", stats });
}

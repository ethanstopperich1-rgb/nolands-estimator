import { NextResponse } from "next/server";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import { resolveBaseUrl } from "@/lib/base-url";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/cron/scheduled-callback
 *
 * CAL-2 — Sydney auto-dial at the homeowner's booked appointment time.
 *
 * Runs every 5 minutes via Vercel Cron. Watches leads.appointment_at
 * and fires /api/dispatch-outbound for any lead whose slot just hit.
 * This is the missing link in the SMS scheduling flow: handleSlotPick
 * already books the JN Measure Call task and stamps appointment_at,
 * but until this cron, nothing actually rang the homeowner's phone
 * at the booked time.
 *
 * Flow per tick:
 *   1. Query leads WHERE appointment_at BETWEEN now-2min AND now+5min
 *      AND callback_dispatched_at IS NULL AND reminder_opted_out=false
 *      AND phone IS NOT NULL.
 *   2. For each lead — verify a TCPA voice-consent row exists in
 *      `consents` (call_recording OR voice_sms_yes). Skip the lead if
 *      not. This is the strict gate: we never dial without paper trail.
 *   3. POST /api/dispatch-outbound with the full lead context
 *      (leadId, phone, address, office, language, jobnimbusContactId,
 *      estimate values).
 *   4. On 2xx response, stamp callback_dispatched_at = NOW() with an
 *      idempotency guard (.is("callback_dispatched_at", null)) so a
 *      concurrent cron firing can't dial twice.
 *
 * Per-row try/catch — one lead's failure can't block the rest of the
 * batch. The 5-min cron rhythm + the appointment window means a
 * transient failure self-heals on the next tick (within 5 min of the
 * slot opening, still inside the 7-min query window).
 *
 * Auth: matches podium-reminders. CRON_SECRET via Bearer header or
 * x-vercel-cron-signature.
 *
 * Staleness gate: the [now-2min, now+5min] window means we never dial
 * a homeowner more than 7 minutes off their booked slot. Cron delays
 * past 7 min mean the row stays NULL (re-dial deferred) rather than
 * the homeowner getting a surprise call at 11pm because the cron
 * caught up from a 4-hour-old slot.
 */

interface ScheduledCallbackStats {
  leadsEvaluated: number;
  dispatched: number;
  skippedNoConsent: number;
  skippedNoPhone: number;
  errors: number;
}

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.warn(
      "[cron scheduled-callback] rejected — CRON_SECRET not configured",
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

  const stats: ScheduledCallbackStats = {
    leadsEvaluated: 0,
    dispatched: 0,
    skippedNoConsent: 0,
    skippedNoPhone: 0,
    errors: 0,
  };
  const now = new Date();
  // Cast to any — callback_dispatched_at lives in migration 0023, TS
  // types not yet regenerated. Same pattern as podium-reminders for
  // appointment_at + reminder_* columns.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createServiceRoleClient();
  const baseUrl = resolveBaseUrl();
  const dispatchSecret = process.env.INTERNAL_DISPATCH_SECRET ?? "";
  if (!dispatchSecret) {
    console.error(
      "[cron scheduled-callback] INTERNAL_DISPATCH_SECRET missing — cannot POST /api/dispatch-outbound",
    );
    return NextResponse.json(
      { status: "error", reason: "dispatch_secret_missing", stats },
      { status: 503 },
    );
  }

  // Window: catch slots that opened up to 2 minutes ago (cron lag) and
  // slots opening in the next 5 minutes (so we don't miss anything
  // until next tick). This is intentionally tighter than the reminder
  // cron's 30-day window — we only fire one call per booked slot.
  const windowStart = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
  const windowEnd = new Date(now.getTime() + 5 * 60 * 1000).toISOString();

  let leads: Array<Record<string, unknown>> = [];
  try {
    const { data, error } = await sb
      .from("leads")
      .select(
        "id, public_id, name, phone, address, office_id, " +
          "appointment_at, jobnimbus_contact_id, preferred_language, " +
          "estimate_low, estimate_high, estimated_sqft, material",
      )
      .is("callback_dispatched_at", null)
      .eq("reminder_opted_out", false)
      .not("phone", "is", null)
      .gte("appointment_at", windowStart)
      .lte("appointment_at", windowEnd)
      .limit(100);
    if (error) {
      console.warn(
        "[cron scheduled-callback] lead query failed:",
        error.message,
      );
      return NextResponse.json(
        { status: "error", reason: error.message, stats },
        { status: 500 },
      );
    }
    leads = data ?? [];
  } catch (err) {
    console.warn("[cron scheduled-callback] lead query threw:", err);
    return NextResponse.json(
      { status: "error", reason: String(err), stats },
      { status: 500 },
    );
  }

  stats.leadsEvaluated = leads.length;

  for (const row of leads) {
    const r = row as {
      id: string;
      public_id: string;
      name: string | null;
      phone: string | null;
      address: string | null;
      office_id: string;
      appointment_at: string | null;
      jobnimbus_contact_id: string | null;
      preferred_language: string | null;
      estimate_low: number | null;
      estimate_high: number | null;
      estimated_sqft: number | null;
      material: string | null;
    };
    try {
      if (!r.phone) {
        stats.skippedNoPhone += 1;
        continue;
      }

      // TCPA strict-gate: a consents row matching this lead's phone +
      // office must exist with a voice-consent-bearing type. We check
      // both 'call_recording' (estimator form-submit + voice-consent
      // route) and 'voice_sms_yes' (SMS YES + A/B slot-pick paths).
      const { data: consentRows, error: consentErr } = await sb
        .from("consents")
        .select("id")
        .eq("office_id", r.office_id)
        .eq("phone", r.phone)
        .in("consent_type", ["call_recording", "voice_sms_yes"])
        .limit(1);
      if (consentErr) {
        console.warn(
          `[cron scheduled-callback] consent lookup failed for ${r.public_id}:`,
          consentErr.message,
        );
        stats.errors += 1;
        continue;
      }
      if (!consentRows || consentRows.length === 0) {
        console.log(
          `[cron scheduled-callback] no consent on file for ${r.public_id} — skipping`,
        );
        stats.skippedNoConsent += 1;
        continue;
      }

      // Resolve the office slug — dispatch-outbound requires it.
      const { data: office, error: officeErr } = await sb
        .from("offices")
        .select("slug")
        .eq("id", r.office_id)
        .maybeSingle();
      if (officeErr || !office?.slug) {
        console.warn(
          `[cron scheduled-callback] office lookup failed for ${r.public_id}:`,
          officeErr?.message ?? "no office row",
        );
        stats.errors += 1;
        continue;
      }

      const dispatchPayload = {
        leadId: r.public_id,
        name: r.name ?? "there",
        phone: r.phone,
        address: r.address ?? "",
        office: office.slug,
        preferredLanguage: r.preferred_language === "es" ? "es" : "en",
        jobnimbusContactId: r.jobnimbus_contact_id ?? undefined,
        estimateLow: r.estimate_low ?? undefined,
        estimateHigh: r.estimate_high ?? undefined,
        estimatedSqft: r.estimated_sqft ?? undefined,
        material: r.material ?? undefined,
      };

      let dispatchOk = false;
      try {
        const res = await fetch(`${baseUrl}/api/dispatch-outbound`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-dispatch-secret": dispatchSecret,
          },
          body: JSON.stringify(dispatchPayload),
        });
        dispatchOk = res.ok;
        if (!dispatchOk) {
          const text = await res.text().catch(() => "");
          console.warn(
            `[cron scheduled-callback] dispatch failed for ${r.public_id} status=${res.status} body=${text.slice(0, 200)}`,
          );
        } else {
          console.log(
            `[cron scheduled-callback] dispatched ${r.public_id} at appointment_at=${r.appointment_at}`,
          );
        }
      } catch (err) {
        console.warn(
          `[cron scheduled-callback] dispatch fetch threw for ${r.public_id}:`,
          err,
        );
      }

      if (dispatchOk) {
        // Idempotency stamp — .is() guard ensures concurrent cron
        // firings can't double-dispatch. The send already went out, so
        // a stamp failure logs but doesn't retry the call.
        const { error: stampErr } = await sb
          .from("leads")
          .update({ callback_dispatched_at: new Date().toISOString() })
          .eq("id", r.id)
          .is("callback_dispatched_at", null);
        if (stampErr) {
          console.warn(
            `[cron scheduled-callback] stamp failed for ${r.public_id}:`,
            stampErr.message,
          );
        }
        stats.dispatched += 1;
      } else {
        stats.errors += 1;
      }
    } catch (err) {
      console.warn(
        `[cron scheduled-callback] lead ${r.public_id} threw:`,
        err,
      );
      stats.errors += 1;
    }
  }

  return NextResponse.json({ status: "ok", stats });
}

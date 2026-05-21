/**
 * Per-office daily Gemini cost cap + audit logger.
 *
 * Bounds tail-risk on the $0.134/call Pro Image pricing. A single
 * retry loop, a malicious tenant, or a frontend bug could otherwise
 * burn $500+/day silently. Per the Wave 1 cost-cap decision:
 *   - Default 25 calls/day per office (~$3.35/day, ~$100/month)
 *   - Configurable per-office via `offices.daily_image_cap`
 *   - Returns 429 when exceeded (gives the customer a clean "try
 *     again tomorrow" path instead of a silent 500)
 *
 * Backed by `migrations/0018_gemini_cost_counter.sql`. If the
 * migration hasn't been applied, both functions soft-fail to "allow"
 * — the cap is a guardrail, not a hard requirement. Production calls
 * succeed; ops sees the missing-table error in logs and applies the
 * migration.
 *
 * Schema:
 *   gemini_calls — append-only audit table, one row per call
 *   offices.daily_image_cap — INTEGER, NOT NULL DEFAULT 25
 *
 * Cost reference (May 2026 pricing):
 *   pro_image: $0.134/call at 1K resolution = 1340 cents/100 = ~13c
 *   flash:     ~$0.0005/call = ~0.05c
 *   flash_text:~$0.0005/call = ~0.05c
 */

import { createServiceRoleClient } from "@/lib/supabase";

/** Approximate cost in cents for accounting purposes. Used by both
 *  the runtime gate AND the nightly drift cron. */
export const GEMINI_COST_CENTS: Record<ModelKind, number> = {
  pro_image: 13, // $0.134 rounded
  flash: 1, // <$0.01, but storing 0 makes drift detection harder
  flash_text: 1,
};

export type ModelKind = "pro_image" | "flash" | "flash_text";

export interface CostCheckResult {
  allowed: boolean;
  /** Calls used today (out of cap). null when the DB lookup failed. */
  usedToday: number | null;
  /** This office's daily cap. null when unknown. */
  capToday: number | null;
  /** When `allowed: false`, the reason for human-readable logging. */
  reason: "ok" | "cap_reached" | "db_unavailable";
}

/**
 * Check whether this office can make another Pro Image call today.
 * Call this BEFORE the Gemini fetch.
 *
 * Soft-fails to `allowed: true` on any DB error — we never block a
 * customer's roof estimate because of an accounting outage. Ops sees
 * the "db_unavailable" reason in logs and patches Supabase.
 */
export async function checkGeminiCostCap(
  officeId: string,
): Promise<CostCheckResult> {
  try {
    // Cast through unknown: the gemini_calls table + daily_image_cap
    // column + gemini_calls_today RPC are added by migration 0018 which
    // may not be applied yet in every environment. Once the migration
    // lands and types are regenerated, the casts can be removed. The
    // soft-fail-to-allowed behavior below handles "migration not yet
    // run" identically to "DB unreachable".
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = createServiceRoleClient() as any;

    const { data: office, error: officeErr } = await sb
      .from("offices")
      .select("daily_image_cap")
      .eq("id", officeId)
      .maybeSingle();
    if (officeErr || !office) {
      return { allowed: true, usedToday: null, capToday: null, reason: "db_unavailable" };
    }

    const cap =
      typeof office.daily_image_cap === "number" ? (office.daily_image_cap as number) : 25;

    const { data: count, error: countErr } = await sb.rpc("gemini_calls_today", {
      p_office_id: officeId,
    });
    if (countErr) {
      return { allowed: true, usedToday: null, capToday: cap, reason: "db_unavailable" };
    }

    const used = typeof count === "number" ? count : 0;
    if (used >= cap) {
      return { allowed: false, usedToday: used, capToday: cap, reason: "cap_reached" };
    }

    return { allowed: true, usedToday: used, capToday: cap, reason: "ok" };
  } catch {
    // Belt-and-suspenders soft-fail. Better to spend $13 on one extra
    // call than to hard-fail a paying customer's estimate.
    return { allowed: true, usedToday: null, capToday: null, reason: "db_unavailable" };
  }
}

export interface LogGeminiCallInput {
  officeId: string;
  modelKind: ModelKind;
  /** Cost in cents. Defaults to GEMINI_COST_CENTS[modelKind]. */
  costCents?: number;
  /** Output token count for drift detection. */
  tokensOut?: number | null;
  leadId?: string | null;
  address?: string | null;
}

/**
 * Append a row to `gemini_calls` after a successful call. Fire-and-
 * forget — never throws; logs to console on DB error so the customer
 * flow proceeds. The append-only audit trail is the source of truth
 * for cost dashboards and drift detection.
 */
export async function logGeminiCall(input: LogGeminiCallInput): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = createServiceRoleClient() as any;
    const { error } = await sb.from("gemini_calls").insert({
      office_id: input.officeId,
      model_kind: input.modelKind,
      cost_cents: input.costCents ?? GEMINI_COST_CENTS[input.modelKind],
      tokens_out: input.tokensOut ?? null,
      lead_id: input.leadId ?? null,
      address: input.address ?? null,
    });
    if (error) {
      console.warn("[gemini-cost-cap] log insert failed", {
        kind: input.modelKind,
        err: error.message,
      });
    }
  } catch (err) {
    console.warn("[gemini-cost-cap] log unexpected error", {
      kind: input.modelKind,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

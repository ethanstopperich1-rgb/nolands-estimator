/**
 * lib/leads/dedup.ts — duplicate-lead detection + graceful linkage.
 *
 * ── The product rule ──────────────────────────────────────────────
 *
 * When the same homeowner submits an estimate request more than once
 * within the dedup window, we DO want to keep the audit trail (each
 * submission becomes its own row) but we DO NOT want to:
 *
 *   ✗ fire a second customer confirmation SMS
 *   ✗ dispatch Sydney a second time
 *   ✗ ping the rep a second time
 *   ✗ burn another Gemini Pro Image call to repaint the same roof
 *
 * Mechanism: the new row's `parent_lead_id` points at the canonical
 * first submission. The route layer checks for that linkage and
 * suppresses side effects accordingly. The painted overlay + V3
 * measurements are copied from the parent so the report is
 * immediately available on the duplicate row's /r/[publicId] without
 * re-running the pipeline.
 *
 * ── Matching rule (tunable) ───────────────────────────────────────
 *
 *   - Match on normalized phone OR normalized email
 *   - Within the dedup window (default: 30 days)
 *   - Same office_id (cross-tenant submissions are independent —
 *     the same person submitting at TWO contractors' subdomains is
 *     genuinely two leads, not a dupe)
 *
 * The 30-day window is the "current customer engagement" boundary.
 * Inside it, the homeowner is mid-funnel for the original contractor
 * touch. Outside, they're a fresh re-engagement (re-fire SMS, fresh
 * painted overlay since cache likely expired anyway).
 *
 * ── Graceful fallback ─────────────────────────────────────────────
 *
 * If the `parent_lead_id` column hasn't been provisioned yet (e.g.
 * migration 0008_lead_dedup hasn't been applied), `findDuplicate`
 * catches the error, logs once, and returns null. Lead insert
 * proceeds normally — at the cost of duplicate notifications until
 * the migration lands. No crash, no broken production.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_DEDUP_WINDOW_DAYS = 30;

export interface DuplicateMatch {
  /** The parent lead's UUID (leads.id) — store as parent_lead_id on
   *  the new row. */
  parentId: string;
  /** The parent lead's public_id — surface in the customer response
   *  so we can redirect to /r/[parentPublicId]. */
  parentPublicId: string;
  /** Parent's persisted roof_v3_json — copy onto the new row so the
   *  painted overlay reuses without a fresh Gemini call. */
  parentRoofV3Json: unknown;
  /** Match reason for telemetry: which key triggered the dedup. */
  matchedOn: "phone" | "email";
}

let degradedLogged = false;

/**
 * Normalize a phone to the last 10 digits for matching. Strips +1,
 * parens, hyphens, spaces. Returns null when input doesn't have
 * enough digits to be a US phone.
 */
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/**
 * Normalize an email for matching. Lowercases + trims. We do NOT
 * strip plus-suffixes (foo+test@gmail.com vs foo@gmail.com) because
 * those are intentionally distinct addresses for the user.
 */
function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed.includes("@")) return null;
  return trimmed;
}

/**
 * Look up a recent matching lead in the same office. Returns the
 * parent match or null. Graceful on schema-not-ready errors.
 */
export async function findDuplicateLead(opts: {
  supabase: SupabaseClient;
  officeId: string;
  phone: string | null | undefined;
  email: string | null | undefined;
  windowDays?: number;
}): Promise<DuplicateMatch | null> {
  const windowDays = opts.windowDays ?? DEFAULT_DEDUP_WINDOW_DAYS;
  const sinceIso = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const normalizedPhone = normalizePhone(opts.phone);
  const normalizedEmail = normalizeEmail(opts.email);
  if (!normalizedPhone && !normalizedEmail) return null;

  try {
    // We do two probes (phone, email) instead of a single OR query
    // because phone is stored as raw user input (not normalized),
    // so we need a substring match on the last-10 digits. Postgres
    // OR queries across different column predicates don't play
    // nicely with the partial indexes we added in migration 0008.
    //
    // Phone probe first (higher signal — most homeowners share an
    // email per household but phones are 1:1 per person).
    if (normalizedPhone) {
      const { data: phoneMatches, error: phoneErr } = await opts.supabase
        .from("leads")
        .select("id, public_id, roof_v3_json, parent_lead_id, created_at")
        .eq("office_id", opts.officeId)
        .ilike("phone", `%${normalizedPhone}%`)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(1);
      if (phoneErr) throw phoneErr;
      if (phoneMatches && phoneMatches[0]) {
        const m = phoneMatches[0];
        // If the matched row is ITSELF a duplicate, walk up to the
        // canonical root so we don't build a chain of dupe-of-dupe.
        const rootId = m.parent_lead_id ?? m.id;
        const rootRow = m.parent_lead_id
          ? await fetchRoot(opts.supabase, opts.officeId, rootId)
          : m;
        if (rootRow) {
          return {
            parentId: rootRow.id as string,
            parentPublicId: rootRow.public_id as string,
            parentRoofV3Json: rootRow.roof_v3_json,
            matchedOn: "phone",
          };
        }
      }
    }

    if (normalizedEmail) {
      const { data: emailMatches, error: emailErr } = await opts.supabase
        .from("leads")
        .select("id, public_id, roof_v3_json, parent_lead_id, created_at")
        .eq("office_id", opts.officeId)
        .eq("email", normalizedEmail)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(1);
      if (emailErr) throw emailErr;
      if (emailMatches && emailMatches[0]) {
        const m = emailMatches[0];
        const rootId = m.parent_lead_id ?? m.id;
        const rootRow = m.parent_lead_id
          ? await fetchRoot(opts.supabase, opts.officeId, rootId)
          : m;
        if (rootRow) {
          return {
            parentId: rootRow.id as string,
            parentPublicId: rootRow.public_id as string,
            parentRoofV3Json: rootRow.roof_v3_json,
            matchedOn: "email",
          };
        }
      }
    }

    return null;
  } catch (err) {
    // Schema-not-ready (column parent_lead_id missing) or any other
    // Supabase error. Log ONCE and degrade gracefully — better to
    // accept a duplicate-notification day than to break lead capture.
    if (!degradedLogged) {
      degradedLogged = true;
      console.warn(
        "[dedup] degraded — dupe detection skipped. Likely the parent_lead_id column isn't migrated yet (migration 0008_lead_dedup). Apply it via Supabase Studio or `supabase db push`. Error:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  }
}

/**
 * Walk one hop to fetch the canonical root row when a match itself
 * is already a dupe. We don't follow multi-hop chains because the
 * dedup logic always points new dupes at the canonical root, so
 * chains are bounded at depth 2.
 */
async function fetchRoot(
  supabase: SupabaseClient,
  officeId: string,
  rootId: string,
): Promise<{
  id: string;
  public_id: string;
  roof_v3_json: unknown;
} | null> {
  try {
    const { data, error } = await supabase
      .from("leads")
      .select("id, public_id, roof_v3_json")
      .eq("office_id", officeId)
      .eq("id", rootId)
      .maybeSingle();
    if (error || !data) return null;
    return data as { id: string; public_id: string; roof_v3_json: unknown };
  } catch {
    return null;
  }
}

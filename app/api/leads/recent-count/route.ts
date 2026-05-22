import { NextResponse } from "next/server";
import {
  createServiceRoleClient,
  resolveOfficeIdBySlug,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";

/**
 * GET /api/leads/recent-count?days=7&office=nolands
 *
 * Rolling lead count for the social-proof line in RepCTACard
 * ("Joined by N homeowners this week"). CRO QW-2.
 *
 * Defaults: days=7, office=nolands.
 *
 * Why this is public:
 *   - The number is not PII — it's an aggregate count across one
 *     office. Same kind of number a homepage "5,000+ customers" badge
 *     publishes.
 *   - Rendered on the customer-facing /r/[publicId] and / surfaces,
 *     both of which are unauthenticated by design.
 *
 * Why this is cached:
 *   - Cron-style traffic hammer protection: this endpoint is hit by
 *     every customer who lands on the result page. Cache the count
 *     at the edge for 15 minutes so we don't run a COUNT query per
 *     pageview.
 *   - Customer-visible drift of <15 min is invisible.
 *
 * Soft-fail discipline (matches the rest of the codebase):
 *   - Supabase not configured → return { count: null, reason:
 *     "not_configured" }. RepCTACard guards on `typeof count ===
 *     "number"` so a null suppresses the line entirely.
 *   - Query errors → return { count: null, reason: "error" }.
 *   - Never 500s — this endpoint is decorative, not critical-path.
 */

// Cache at the edge for 15 minutes. Next.js sets s-maxage on the
// Cache-Control response automatically from this export.
export const revalidate = 900;
export const runtime = "nodejs";

interface CountResponse {
  count: number | null;
  days: number;
  office: string;
  /** Set on the null path so ops can grep logs. */
  reason?: "not_configured" | "error";
}

export async function GET(req: Request): Promise<NextResponse<CountResponse>> {
  const url = new URL(req.url);
  const daysRaw = Number(url.searchParams.get("days") ?? "7");
  // Clamp to a sane window — anything > 90 days is meaningless social
  // proof (looks stale), anything < 1 is nonsense.
  const days = Math.max(1, Math.min(90, Number.isFinite(daysRaw) ? daysRaw : 7));
  const office = (url.searchParams.get("office") ?? "nolands").slice(0, 64);

  if (!supabaseServiceRoleConfigured()) {
    return NextResponse.json(
      { count: null, days, office, reason: "not_configured" },
      // Even the null path is cacheable — Supabase being unconfigured
      // doesn't change for the lifetime of a deployment.
      { headers: { "Cache-Control": "s-maxage=900, stale-while-revalidate=3600" } },
    );
  }

  try {
    // Resolve the slug ("nolands") to the office UUID before querying.
    // leads.office_id is a UUID column — querying by the slug string
    // would return zero rows silently.
    const officeId = await resolveOfficeIdBySlug(office);
    if (!officeId) {
      // Office not found is operationally the same as soft-fail: don't
      // surface a misleading number. Cache briefly so a misconfigured
      // slug doesn't hammer the resolver.
      return NextResponse.json(
        { count: null, days, office, reason: "not_configured" },
        { headers: { "Cache-Control": "s-maxage=60" } },
      );
    }
    const sb = createServiceRoleClient();
    const sinceIso = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { count, error } = await sb
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("office_id", officeId)
      .gte("created_at", sinceIso);

    if (error) {
      console.warn(
        "[leads/recent-count] supabase error:",
        error.message,
      );
      return NextResponse.json(
        { count: null, days, office, reason: "error" },
        { headers: { "Cache-Control": "s-maxage=60" } },
      );
    }

    return NextResponse.json(
      { count: count ?? 0, days, office },
      {
        headers: {
          "Cache-Control": "s-maxage=900, stale-while-revalidate=3600",
        },
      },
    );
  } catch (err) {
    console.warn("[leads/recent-count] unexpected:", err);
    return NextResponse.json(
      { count: null, days, office, reason: "error" },
      { headers: { "Cache-Control": "s-maxage=60" } },
    );
  }
}

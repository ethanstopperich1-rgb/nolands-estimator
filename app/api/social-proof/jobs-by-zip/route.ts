import { NextResponse } from "next/server";

/**
 * GET /api/social-proof/jobs-by-zip?zip=34711
 *
 * Per-zip job-completion count, sourced from Noland's live JobNimbus
 * data. Rendered on the result page above the tier cards as "Noland's
 * has completed N reroofs in your zip code recently" — mimetic-desire
 * + local-relevance social proof.
 *
 * Why JN-backed (not Supabase-backed like /api/leads/recent-count):
 *   - leads.zip in Supabase = only NEW Voxaris-estimator leads (small
 *     count, pre-launch). JN holds Noland's REAL job history at scale
 *     (54k contacts, 65k jobs, decade-long).
 *   - For social proof to land, the number has to be IMPRESSIVE. JN
 *     gives us 34711 = 117 jobs / 8 closed-won. Supabase gives us
 *     maybe 0-5 estimator leads. Different magnitudes entirely.
 *
 * Why this is public + cached:
 *   - Per-zip aggregate count is not PII. Same magnitude as homepage
 *     "5,000+ customers" badges.
 *   - 24-hour edge cache: per-zip won-job counts don't change daily.
 *
 * Soft-fail discipline:
 *   - JN key not set → { count: null, reason: "not_configured" }
 *   - JN errors → { count: null, reason: "error" }
 *   - Returns 0 (not null) when the zip is valid but has zero won jobs
 *     so the UI can suppress the line entirely (the UI gates on
 *     `count >= 3` to avoid weak social proof).
 *   - Never 500s — decorative, not critical-path.
 *
 * Cache: 24h s-maxage, 1h stale-while-revalidate.
 *
 * Filter notes:
 *   - JN's `match` filter on `zip` is indexed and works (probed May 2026).
 *   - Won-status filter uses bool.should — JN's filter parser doesn't
 *     support `terms` clauses (silently returns 0).
 *   - Status names match Noland's exact pipeline: "Contract Awarded",
 *     "Paid & Closed", "Final Invoice Sent".
 */

export const runtime = "nodejs";
// 24 hours — per-zip counts move slowly, no need to re-query per
// pageview. Stale-while-revalidate lets the next request serve from
// cache while a refresh runs in the background.
export const revalidate = 86400;

interface ZipCountResponse {
  count: number | null;
  zip: string;
  /** Lookback window in days. Defaults to 365 — "this past year". */
  days: number;
  reason?: "not_configured" | "error" | "invalid_zip";
}

const JN_BASE_URL = "https://app.jobnimbus.com/api1";
const WON_STATUSES = [
  "Contract Awarded",
  "Paid & Closed",
  "Final Invoice Sent",
] as const;

export async function GET(req: Request): Promise<NextResponse<ZipCountResponse>> {
  const url = new URL(req.url);
  const zipRaw = (url.searchParams.get("zip") ?? "").trim();
  const daysRaw = Number(url.searchParams.get("days") ?? "365");
  const days = Math.max(30, Math.min(730, Number.isFinite(daysRaw) ? daysRaw : 365));

  // Validate zip — US 5-digit only. JN address records store the
  // 5-digit zip; nothing else searches.
  const zip = zipRaw.slice(0, 5);
  if (!/^\d{5}$/.test(zip)) {
    return NextResponse.json(
      { count: null, zip: zipRaw, days, reason: "invalid_zip" },
      { headers: { "Cache-Control": "s-maxage=86400" } },
    );
  }

  const jnKey = process.env.JOBNIMBUS_API_KEY;
  if (!jnKey) {
    return NextResponse.json(
      { count: null, zip, days, reason: "not_configured" },
      { headers: { "Cache-Control": "s-maxage=86400" } },
    );
  }

  try {
    // bool.should across the won statuses + must match on zip.
    // JN's filter parser doesn't support `terms` (returns 0 silently),
    // so bool.should is the canonical multi-value match.
    const filter = JSON.stringify({
      must: [
        { match: { zip } },
        {
          bool: {
            should: WON_STATUSES.map((s) => ({
              match: { status_name: s },
            })),
            minimum_should_match: 1,
          },
        },
      ],
    });

    // size=1 + count from response — we only need the count, not bodies.
    const qs = new URLSearchParams({ filter, size: "1" }).toString();
    const res = await fetch(`${JN_BASE_URL}/jobs?${qs}`, {
      headers: {
        Authorization: `Bearer ${jnKey}`,
        Accept: "application/json",
      },
      // Soft per-request timeout — JN's filter endpoint usually <500ms
      // but a hung query shouldn't block a customer page render.
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) {
      console.warn(
        `[social-proof/jobs-by-zip] JN responded ${res.status} for zip=${zip}`,
      );
      return NextResponse.json(
        { count: null, zip, days, reason: "error" },
        { headers: { "Cache-Control": "s-maxage=300" } },
      );
    }

    const data = (await res.json()) as { count?: number };
    const count = typeof data.count === "number" ? data.count : 0;

    return NextResponse.json(
      { count, zip, days },
      {
        headers: {
          "Cache-Control": "s-maxage=86400, stale-while-revalidate=3600",
        },
      },
    );
  } catch (err) {
    console.warn(
      "[social-proof/jobs-by-zip] unexpected:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { count: null, zip, days, reason: "error" },
      { headers: { "Cache-Control": "s-maxage=300" } },
    );
  }
}

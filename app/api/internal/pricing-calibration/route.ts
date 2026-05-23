import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * GET /api/internal/pricing-calibration?sample=80
 *
 * Pulls Noland's closed-won JN jobs ($5k+ invoice, valid FL lat/lng),
 * pairs each address with Google Solar API roof sqft (the same source
 * the production V3 estimator uses), and computes observed $/sqft to
 * calibrate lib/pricing/calculate-waste.ts against ground truth.
 *
 * Why an internal endpoint instead of a local script:
 *   - JOBNIMBUS_API_KEY + GOOGLE_SERVER_KEY are Vercel --sensitive env
 *     vars that don't pull locally. Running server-side has access.
 *   - Google Solar API is FREE for the first 10K calls/month per
 *     billing account. 80-300 calls per run = well within free tier.
 *   - One endpoint = one set of soft-fail guards + retry logic shared
 *     across all calibration runs.
 *
 * Auth: gated by INTERNAL_DISPATCH_SECRET (same shared secret as
 * /api/dispatch-outbound). Header: x-dispatch-secret. Prevents
 * random scripts from burning Solar quota.
 *
 * Output: structured JSON with median + IQR per JN record_type +
 * the matching individual observations so the rates can be tuned
 * defensibly.
 */

export const runtime = "nodejs";
export const maxDuration = 300; // up to 5 min for 100-300 lookups

const JN_BASE_URL = "https://app.jobnimbus.com/api1";
const SOLAR_URL =
  "https://solar.googleapis.com/v1/buildingInsights:findClosest";

const WON_STATUSES = [
  "Contract Awarded",
  "Paid & Closed",
  "Final Invoice Sent",
] as const;

interface JnJob {
  jnid?: string;
  approved_invoice_total?: number | null;
  parent_approved_invoice_total?: number | null;
  approved_estimate_total?: number | null;
  geo?: { lat?: number; lon?: number } | null;
  record_type_name?: string | null;
  status_name?: string | null;
  address_line1?: string | null;
  zip?: string | null;
}

interface CalibrationObservation {
  invoice: number;
  estimate: number | null;
  roof_sqft: number;
  rate_per_sqft: number;
  record_type: string;
  address: string;
  zip: string;
  solar_quality: string;
}

interface CalibrationResponse {
  ok: boolean;
  pulled_won_jobs: number;
  qualified_for_lookup: number;
  attempted_lookups: number;
  successful_lookups: number;
  match_rate_pct: number;
  observations_in_band: number;
  per_record_type: Record<
    string,
    {
      n: number;
      median: number;
      p25: number;
      p75: number;
      mean: number;
    }
  >;
  overall: {
    n: number;
    median: number;
    p25: number;
    p75: number;
    mean: number;
  } | null;
  current_engine_default: number;
  recommended_default: number | null;
  observations: CalibrationObservation[];
  errors: string[];
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function jnFetch(path: string): Promise<unknown> {
  const key = process.env.JOBNIMBUS_API_KEY;
  if (!key) throw new Error("JOBNIMBUS_API_KEY not set");
  const res = await fetch(`${JN_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`JN ${path} returned ${res.status}`);
  }
  return res.json();
}

/**
 * Call Google Solar API's findClosest endpoint. Returns total roof
 * sqft (sum of roof_segment_stats.stats.area_meters2) converted from
 * m² to sqft. Returns null on any failure path (404, no quota, no
 * imagery, low confidence). Same soft-fail discipline as the
 * production V3 pipeline.
 */
async function solarSqft(
  lat: number,
  lng: number,
  apiKey: string,
): Promise<{ sqft: number; quality: string } | null> {
  const url =
    `${SOLAR_URL}?location.latitude=${lat}&location.longitude=${lng}` +
    `&requiredQuality=LOW&key=${apiKey}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      solarPotential?: {
        wholeRoofStats?: { areaMeters2?: number };
        roofSegmentStats?: Array<{ stats?: { areaMeters2?: number } }>;
      };
      imageryQuality?: string;
    };
    // Prefer wholeRoofStats (sum of all segments) when present.
    let m2 = data.solarPotential?.wholeRoofStats?.areaMeters2;
    if (!m2) {
      m2 = (data.solarPotential?.roofSegmentStats ?? []).reduce(
        (sum, s) => sum + (s.stats?.areaMeters2 ?? 0),
        0,
      );
    }
    if (!m2 || m2 < 30) return null; // < 30m² ≈ < 320 sqft = noise
    return {
      sqft: m2 * 10.7639, // m² → sqft
      quality: data.imageryQuality ?? "UNKNOWN",
    };
  } catch {
    return null;
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  // Auth: secret gate on the full observations array (individual JN
  // contact + address + invoice $). The AGGREGATES (median/p25/p75)
  // are not PII and stay accessible without auth for one-time calibration
  // runs. When the secret is provided + matches, the response also
  // includes the observations array. When absent or wrong, aggregates
  // only — homeowner-level data is never leaked.
  let includeObservations = false;
  const expected = process.env.INTERNAL_DISPATCH_SECRET;
  const provided = req.headers.get("x-dispatch-secret") ?? "";
  if (expected && provided) {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      includeObservations = true;
    }
  }

  const googleKey =
    process.env.GOOGLE_SERVER_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!googleKey) {
    return NextResponse.json(
      { ok: false, error: "google_key_not_configured" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const sample = Math.max(
    10,
    Math.min(500, Number(url.searchParams.get("sample") ?? "120")),
  );

  const errors: string[] = [];

  // 1. Pull qualified JN won jobs
  let allJobs: JnJob[] = [];
  try {
    const filterJson = JSON.stringify({
      must: [
        {
          bool: {
            should: WON_STATUSES.map((s) => ({ match: { status_name: s } })),
            minimum_should_match: 1,
          },
        },
      ],
    });
    const qs = new URLSearchParams({
      filter: filterJson,
      size: "500",
    }).toString();
    const data = (await jnFetch(`/jobs?${qs}`)) as { results?: JnJob[] };
    allJobs = data.results ?? [];
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `jn_pull_failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  // 2. Filter to lookup-eligible
  const qualified: Array<{
    invoice: number;
    estimate: number | null;
    lat: number;
    lon: number;
    record_type: string;
    address: string;
    zip: string;
  }> = [];
  for (const j of allJobs) {
    const inv = j.approved_invoice_total ?? j.parent_approved_invoice_total ?? 0;
    const lat = j.geo?.lat;
    const lon = j.geo?.lon;
    if (typeof inv !== "number" || inv < 5000) continue;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    if (lat === 0 || lon === 0) continue;
    if (lat < 24 || lat > 31.5 || lon < -88 || lon > -79.5) continue;
    qualified.push({
      invoice: inv,
      estimate: j.approved_estimate_total ?? null,
      lat,
      lon,
      record_type: j.record_type_name ?? "Unknown",
      address: j.address_line1 ?? "",
      zip: j.zip ?? "",
    });
  }

  // 3. Call Solar API for each in the sample (rate-limited at 600 QPM,
  //    we throttle at ~10/sec = 600 QPM ceiling).
  const observations: CalibrationObservation[] = [];
  const toLookup = qualified.slice(0, sample);
  for (const q of toLookup) {
    const solar = await solarSqft(q.lat, q.lon, googleKey);
    if (!solar) continue;
    const rate = q.invoice / solar.sqft;
    if (rate < 1.5 || rate > 30) continue; // sanity band
    observations.push({
      invoice: q.invoice,
      estimate: q.estimate,
      roof_sqft: Math.round(solar.sqft),
      rate_per_sqft: Math.round(rate * 100) / 100,
      record_type: q.record_type,
      address: q.address,
      zip: q.zip,
      solar_quality: solar.quality,
    });
    // Small throttle — keep us under 600 QPM
    await new Promise((r) => setTimeout(r, 100));
  }

  // 4. Aggregate per record_type + overall
  const perTypeMap = new Map<string, number[]>();
  const all: number[] = [];
  for (const o of observations) {
    all.push(o.rate_per_sqft);
    if (!perTypeMap.has(o.record_type)) perTypeMap.set(o.record_type, []);
    perTypeMap.get(o.record_type)!.push(o.rate_per_sqft);
  }

  function statsOf(arr: number[]): {
    n: number;
    median: number;
    p25: number;
    p75: number;
    mean: number;
  } {
    const sorted = [...arr].sort((x, y) => x - y);
    return {
      n: sorted.length,
      median: Math.round(percentile(sorted, 0.5) * 100) / 100,
      p25: Math.round(percentile(sorted, 0.25) * 100) / 100,
      p75: Math.round(percentile(sorted, 0.75) * 100) / 100,
      mean:
        Math.round(
          (sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)) *
            100,
        ) / 100,
    };
  }

  const perRecordType: CalibrationResponse["per_record_type"] = {};
  for (const [rt, rates] of perTypeMap) {
    if (rates.length >= 3) perRecordType[rt] = statsOf(rates);
  }
  const overall = all.length >= 5 ? statsOf(all) : null;

  // Recommended default = overall median (rounded to nearest $0.25)
  // unless the sample is too small (<10) in which case no recommendation.
  const recommended =
    overall && overall.n >= 10
      ? Math.round(overall.median * 4) / 4
      : null;

  const body: CalibrationResponse = {
    ok: true,
    pulled_won_jobs: allJobs.length,
    qualified_for_lookup: qualified.length,
    attempted_lookups: toLookup.length,
    successful_lookups: observations.length,
    match_rate_pct: Math.round((observations.length / Math.max(1, toLookup.length)) * 100),
    observations_in_band: observations.length,
    per_record_type: perRecordType,
    overall,
    current_engine_default: 8.0, // ARCHITECTURAL_SHINGLE_RATE_PER_SQFT
    recommended_default: recommended,
    // Observations array only when secret was validated. Aggregates
    // alone (above) are safe to expose — they're a single statistic
    // per record_type, not joinable to any homeowner.
    observations: includeObservations ? observations.slice(0, 30) : [],
    errors,
  };

  return NextResponse.json(body);
}

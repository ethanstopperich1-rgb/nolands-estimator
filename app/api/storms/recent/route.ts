/**
 * GET /api/storms/recent?lat=..&lng=..&radiusMiles=10&daysBack=7
 *
 * Near-real-time severe weather lookup backed by the Iowa Environmental
 * Mesonet (IEM) Local Storm Reports feed. IEM mirrors raw NWS LSRs
 * within an hour, vs. NOAA SPC's QC'd archive which lags 1+ day.
 *
 * Why a separate endpoint from /api/storms:
 *   • /api/storms = BigQuery NOAA historic_severe_storms, T+1d, 1995-present
 *   • /api/storms/recent = IEM LSRs, T+1h, last 30d max
 *
 * Both feed the same StormEvent shape so UI components are interchangeable.
 *
 * Sources are public records (NOAA-funded, Congressionally mandated to be
 * free). No auth, no key, no scraping — direct JSON from a .gov-adjacent
 * academic mirror (Iowa State).
 */

import { NextResponse } from "next/server";
import { guardPublicBillableRequest } from "@/lib/api-public-guard";

export const runtime = "nodejs";

/** Mirror of the shape /api/storms returns so UI cards can swap sources
 *  without conditionals. */
interface StormEvent {
  type: string;
  date: string | null;
  magnitude: number | null;
  magnitudeType: string | null;
  distanceMiles: number | null;
  /** IEM extras — populated here, ignored by the shared UI when null. */
  eventLat?: number;
  eventLng?: number;
  /** Brief LSR remark text from the NWS forecaster who logged it.
   *  e.g. "QUARTER SIZE HAIL REPORTED BY TRAINED SPOTTER NEAR OVIEDO." */
  remark?: string;
}

interface StormSummary {
  total: number;
  hailCount: number;
  tornadoCount: number;
  windCount: number;
  maxHailInches: number | null;
  radiusMiles: number;
  daysBack: number;
  source: "iem-lsr";
}

/** Great-circle distance, miles. */
function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 3958.7613;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** IEM LSR typetext values we care about. IEM uses a single-letter `type`
 *  code (H/T/N/...) and a human-readable `typetext` ("HAIL", "TORNADO",
 *  "TSTM WND GST", etc.). Matching on typetext is the stable contract —
 *  the single-letter codes are reused (e.g. T = TORNADO but also TSTM)
 *  and shift over time. */
const IEM_TYPETEXT_ALLOW = new Set([
  "HAIL",
  "TORNADO",
  "FUNNEL CLOUD",
  "WATERSPOUT",
  "TSTM WND DMG",
  "TSTM WND GST",
  "NON-TSTM WND DMG",
  "NON-TSTM WND GST",
  "HIGH WIND",
  "HIGH SUST WINDS",
  "MARINE TSTM WIND",
]);

function normalizeType(raw: string): string {
  const u = raw.toUpperCase();
  if (u === "HAIL") return "hail";
  if (u === "TORNADO" || u === "FUNNEL CLOUD" || u === "WATERSPOUT") return "tornado";
  if (u.includes("WND") || u.includes("WIND")) return "thunderstorm wind";
  return raw.toLowerCase();
}

interface IEMFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    valid: string; // ISO timestamp UTC
    type: string; // "HAIL" / "TORNADO" / ...
    magnitude: number | string | null;
    /** "M" for hail size in inches stored in magnitude as inches-precision */
    unit?: string;
    remark?: string | null;
    typetext?: string;
    /** city / location text */
    city?: string;
    county?: string;
    state?: string;
  };
}

interface IEMResponse {
  type: "FeatureCollection";
  features: IEMFeature[];
}

export async function GET(req: Request) {
  const gated = await guardPublicBillableRequest(req, "standard");
  if (gated) return gated;

  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const radius = Math.max(1, Math.min(50, Number(searchParams.get("radiusMiles")) || 10));
  // Cap was previously 30 — bumped to 365 so the rep workbench's
  // "lead lookup happens days/weeks after the storm" use case actually
  // gets data instead of being silently clamped. The IEM endpoint
  // accepts multi-year windows; 365 is the sane outer limit for a
  // single drawer fetch.
  // IEM hard-caps practical queries around ~30 days. 7 is the canvass
  // default; 30 covers the "last month" pill on the UI.
  const days = Math.max(1, Math.min(365, Number(searchParams.get("daysBack")) || 90));
  // WFO (NWS Weather Forecast Office) bound on the upstream payload.
  // IEM's `state=XX` parameter is silently ignored on `lsr.geojson`
  // (verified 2026-05 — passing state=FL returned CO/MA/NY data), so
  // we have to enumerate the WFOs that cover the territory. The
  // `wfos` query param IS respected.
  //
  // Florida WFO coverage:
  //   TBW  Tampa Bay   JAX  Jacksonville   MFL  Miami / S. Florida
  //   MLB  Melbourne (incl. Orlando + Volusia)
  //   TAE  Tallahassee (panhandle)         KEY  Key West
  //   EYW  Key West (legacy alias kept for safety)
  //
  // Caller can override with ?wfos=ABC,DEF,... when serving other
  // territories. Validated against a safe pattern.
  const wfosRaw = searchParams.get("wfos");
  const wfos =
    wfosRaw && /^[A-Z]{3}(,[A-Z]{3})*$/.test(wfosRaw.toUpperCase())
      ? wfosRaw.toUpperCase()
      : "TBW,JAX,MFL,MLB,TAE,KEY,EYW";

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 89.9 ||
    Math.abs(lng) > 180
  ) {
    return NextResponse.json(
      { error: "lat & lng required and must be valid coordinates" },
      { status: 400 },
    );
  }

  // Bbox from radius. 1deg lat = 69mi; 1deg lng = 69·cos(lat) mi.
  // Pad by 1.2× so we don't miss events at the edge after we apply
  // the precise Haversine filter below.
  const padded = radius * 1.2;
  const dLat = padded / 69;
  const dLng = padded / (69 * Math.cos((lat * Math.PI) / 180));
  const minLat = lat - dLat;
  const maxLat = lat + dLat;
  const minLng = lng - dLng;
  const maxLng = lng + dLng;

  // IEM expects UTC iso-ish timestamps `YYYY-MM-DDTHH:MM`.
  //
  // BUCKET ROUND: round ets DOWN to the nearest 10-minute mark and
  // start to the nearest hour. Without bucketing, every request had
  // a minute-precision timestamp → unique URL → Next.js fetch cache
  // never hit, defeating the entire `next.revalidate=600` line. With
  // 10-min buckets, all requests inside a 10-min window share one
  // cache entry and the upstream sees ~6 hits/hour total, not one
  // hit per page render.
  const BUCKET_MIN = 10;
  const now = new Date();
  const etsBucket = new Date(
    Math.floor(now.getTime() / (BUCKET_MIN * 60_000)) * BUCKET_MIN * 60_000,
  );
  const start = new Date(etsBucket.getTime() - days * 24 * 60 * 60 * 1000);
  // round start to the hour so day-boundary queries cluster too
  start.setUTCMinutes(0, 0, 0);
  const fmt = (d: Date) =>
    d.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:mm"

  const url = new URL("https://mesonet.agron.iastate.edu/geojson/lsr.geojson");
  url.searchParams.set("sts", fmt(start));
  url.searchParams.set("ets", fmt(etsBucket));
  // Bound the upstream payload to our WFO list (see comment up top).
  // Without this IEM returns every LSR in CONUS for the window —
  // 5k-50k features, hits the 10k cap, our bbox filter then misses
  // every nearby event because the cap truncated FL data out.
  url.searchParams.set("wfos", wfos);

  let raw: IEMResponse;
  try {
    const r = await fetch(url.toString(), {
      // IEM is a high-traffic academic service — we cache aggressively
      // on our end so this endpoint stays snappy for the dashboard.
      next: { revalidate: 600 }, // 10 min — LSRs aren't realtime-realtime
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      return NextResponse.json(
        { error: `iem_upstream_${r.status}` },
        { status: 502 },
      );
    }
    raw = (await r.json()) as IEMResponse;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "iem_fetch_failed" },
      { status: 502 },
    );
  }

  const events: StormEvent[] = [];
  for (const f of raw.features ?? []) {
    const [lon, latP] = f.geometry?.coordinates ?? [NaN, NaN];
    if (!Number.isFinite(latP) || !Number.isFinite(lon)) continue;
    if (latP < minLat || latP > maxLat || lon < minLng || lon > maxLng) continue;
    const ttRaw = (f.properties.typetext ?? "").toUpperCase().trim();
    if (!IEM_TYPETEXT_ALLOW.has(ttRaw)) continue;
    const dist = haversineMiles(lat, lng, latP, lon);
    if (dist > radius) continue;
    // IEM stores hail size in `magnitude` (inches) and wind speed in
    // `magnitude` (MPH). One field, two units, disambiguated by type.
    const magRaw = f.properties.magnitude;
    const magnitude =
      typeof magRaw === "number"
        ? magRaw
        : typeof magRaw === "string" && magRaw.length
          ? Number(magRaw)
          : null;
    events.push({
      type: normalizeType(ttRaw),
      date: f.properties.valid ?? null,
      magnitude: Number.isFinite(magnitude as number) ? (magnitude as number) : null,
      magnitudeType: ttRaw === "HAIL" ? "inches" : f.properties.unit ?? null,
      distanceMiles: Math.round(dist * 10) / 10,
      eventLat: latP,
      eventLng: lon,
      remark: f.properties.remark ?? undefined,
    });
  }

  // Sort newest first.
  events.sort((a, b) => {
    const da = a.date ? Date.parse(a.date) : 0;
    const db = b.date ? Date.parse(b.date) : 0;
    return db - da;
  });

  const hail = events.filter((e) => e.type === "hail");
  const tornado = events.filter((e) => e.type === "tornado");
  const wind = events.filter((e) => e.type === "thunderstorm wind");
  const maxHailInches = hail.reduce<number | null>((m, e) => {
    if (e.magnitude == null) return m;
    return m == null || e.magnitude > m ? e.magnitude : m;
  }, null);

  const summary: StormSummary = {
    total: events.length,
    hailCount: hail.length,
    tornadoCount: tornado.length,
    windCount: wind.length,
    maxHailInches,
    radiusMiles: radius,
    daysBack: days,
    source: "iem-lsr",
  };

  return NextResponse.json({ events, summary });
}

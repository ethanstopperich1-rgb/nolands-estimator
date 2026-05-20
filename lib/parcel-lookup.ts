/**
 * Per-property parcel lookup via the Florida statewide cadastral layer.
 *
 * Source of truth: the FloridaGIO `Florida_Statewide_Cadastral`
 * FeatureServer, which mirrors the Florida Department of Revenue's
 * annual NAL (Name-Address-Legal) submissions from all 67 county
 * property appraisers. Same dataset listed in our
 * `STATEWIDE_FL_PARCELS` constant, but the FeatureServer flavor of it
 * supports per-point spatial queries — no GDB download required.
 *
 * Why this exists (May 2026): the V3 estimator needed a "Why this roof
 * needs attention" customer card. Aerial imagery answers *what's there*
 * but not *how old it is*. NAL gives us actual year built, effective
 * year built (post-renovation), living sqft, current taxable value,
 * and the most recent sale — every one of which is a credible reason
 * a homeowner should be thinking about their roof right now.
 *
 * Cost: $0. The endpoint is a public ArcGIS FeatureServer hosted by
 * FGIO (Esri free tier) under their `Gh9awoU677aKree0` org. No key,
 * no rate-limit headers documented; we use polite caching (90d cache
 * scope, parcel attributes only change once/year at roll publish).
 *
 * Failure modes intentionally soft:
 *   • Pin on the road / commercial lot / water → no parcel polygon
 *     intersects → return null.
 *   • Gated-community common-area lot (24M sqft HOA tract with 0
 *     buildings) → filtered out by the residential+buildings guard
 *     below → fall back to expanding the query buffer.
 *   • Endpoint 5xx / timeout → return null. V3 estimate still ships,
 *     the customer card just hides the parcel section.
 *
 * The route always uses `pinConfirmed` + Solar API's building centroid
 * (not the geocoded address) as the query point. Solves the
 * "geocoder snaps to road centerline" problem that bit Street View.
 */

// One service, all 67 FL counties. Annual refresh tracks DOR's NAL
// submission cycle (typically July-Aug roll publish).
const FDOR_CADASTRAL_URL =
  "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query";

/**
 * FL DOR property classification — the state-mandated 2-digit code.
 * Source: Lee County PA's published DOR Code List (mirrors DR-493).
 *
 * Counties store the code as a 4-character string. The format is
 * `SSxx` where SS is the state code and xx is an optional county
 * subcategorization (or `00` when the county doesn't subcategorize).
 * Concretely:
 *   "0001" → parseInt 1   → 01 SINGLE FAMILY
 *   "0019" → parseInt 19  → 19 PROFESSIONAL BUILDING (commercial)
 *   "0048" → parseInt 48  → 48 WAREHOUSING (industrial)
 *   "0082" → parseInt 82  → 82 FOREST/PARKS/REC (government)
 *   "0100" → parseInt 100 → 1 (after div-100 normalization) SFR
 *   "0140" → parseInt 140 → 1 SFR with golf-course subcategory
 *
 * Residential band = state codes 00-09:
 *   00 VACANT RESIDENTIAL          (skip — no building to roof)
 *   01 SINGLE FAMILY               ✓ bullseye
 *   02 MOBILE HOME                 ✓ still has a roof
 *   03 MULTI-FAMILY 10+            ✓ apt building, real roof
 *   04 CONDO                       ✓ but often HOA-owned roof — flag downstream
 *   05 COOPERATIVES                ✓
 *   06 RETIREMENT HOMES            ✓
 *   07 MISC RESIDENTIAL            ✓
 *   08 MULTI-FAMILY <10            ✓ duplex/triplex/fourplex
 *   09 COMMON ELEMENTS             (skip — HOA tract, no individual home)
 *
 * Everything 10-99 = commercial / industrial / ag / gov / misc → skip.
 */
function isResidentialUseCode(raw: string): boolean {
  // Strip any non-digits + leading zeros, then take the state code.
  const digits = raw.replace(/\D/g, "");
  if (!digits) return false;
  const n = parseInt(digits, 10);
  if (!Number.isFinite(n)) return false;
  // Normalize "0100"-style codes by dividing by 100 if >= 100.
  const stateCode = n >= 100 ? Math.floor(n / 100) : n;
  // Skip 00 (vacant) and 09 (common elements) — those have a residential
  // category but no roofable structure of the homeowner's.
  return stateCode >= 1 && stateCode <= 8;
}

export interface ParcelLookupResult {
  /** State-uniform parcel ID — 17-19 char string. For audit + dedupe. */
  parcelId: string;
  /** Florida county number (10-99). 60 = Palm Beach, 48 = Orange, etc. */
  countyNumber: number;
  /** Year the structure was originally built. 0 means "unknown" on the
   *  DOR record — we treat 0 as null when surfacing. */
  yearBuilt: number | null;
  /** Year of last substantive renovation/addition. Often the same as
   *  yearBuilt for untouched homes; higher when there's been a major
   *  upgrade. The gap is itself a useful customer signal ("your home
   *  is 48 years old, last significant work in 2015"). */
  effectiveYearBuilt: number | null;
  /** Total living area in sqft (excludes garage, lanai, unfinished
   *  attic). Useful sanity check against our aerial-derived footprint. */
  livingSqft: number | null;
  /** Lot size in sqft. The aerial sometimes gets the lot+building
   *  wrong; this gives us a backstop. */
  lotSqft: number | null;
  /** Just value — Florida's term for market value as assessed by the
   *  county. Drives "what tier of roof does this customer expect?"
   *  + finance product eligibility. */
  justValue: number | null;
  /** Number of buildings on the parcel. >1 means accessory dwelling /
   *  detached garage / pool house; the customer card should note it
   *  so the rep doesn't get blindsided in measurement. */
  buildingCount: number | null;
  /** Most recent recorded sale on this parcel. Used to support "you've
   *  owned this home for 18 years — your roof is overdue" framing. */
  lastSale: {
    priceUsd: number;
    year: number;
  } | null;
  /** DOR property use code. Returned for downstream gating + audit. */
  dorUseCode: string;
  /** Assessment year — when the county last updated the roll record.
   *  Used in the customer card's "data as of YYYY" subtitle. */
  assessmentYear: number | null;
}

interface FdorFeature {
  attributes: {
    PARCEL_ID?: string;
    CO_NO?: number;
    ACT_YR_BLT?: number | null;
    EFF_YR_BLT?: number | null;
    TOT_LVG_AR?: number | null;
    LND_SQFOOT?: number | null;
    JV?: number | null;
    NO_BULDNG?: number | null;
    SALE_PRC1?: number | null;
    SALE_YR1?: number | null;
    DOR_UC?: string | null;
    ASMNT_YR?: number | null;
  };
}

interface FdorQueryResponse {
  features?: FdorFeature[];
  error?: { code: number; message: string };
}

/**
 * Fetch the parcel containing (lat, lng), returning null if no
 * residential parcel intersects.
 *
 * Always pass the building centroid (from Solar API or the V3
 * polygon) — NOT the geocoded address. Geocoders snap to road
 * centerlines, which are between parcels and yield no hits.
 */
export async function lookupParcel(
  lat: number,
  lng: number,
): Promise<ParcelLookupResult | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    console.warn(
      `[parcel] invalid query point lat=${lat} lng=${lng} — skipping FDOR lookup`,
    );
    return null;
  }

  // Logging philosophy: one breadcrumb per OUTCOME — not per query.
  // On success, log a single `parcel_pick` line for the tier that hit.
  // On total failure, log a single `parcel_lookup_null` line with all
  // three tier counts so ops can diagnose without scrolling through
  // 6-9 lines per failed request.

  // First pass: zero-tolerance point-in-polygon query at the exact
  // building centroid. Returns 1 feature on residential lots, 0 on
  // road pins, 1 (giant HOA tract) on gated common areas.
  const exact = await runQuery(lat, lng, 0);
  const exactPick = pickResidential(exact, "exact");
  if (exactPick) return exactPick;

  // Fallback: 25m buffer. Catches the "geocoder snapped to the wrong
  // side of the property line" case + small footprint errors. Still
  // gated by residential filter so an adjacent commercial parcel
  // doesn't win.
  const buffered25 = await runQuery(lat, lng, 25);
  const bufferedPick = pickResidential(buffered25, "buffered25");
  if (bufferedPick) return bufferedPick;

  // Last-resort 100m buffer. Catches cases where the building centroid
  // sits slightly off-parcel (Solar's photogrammetric center can drift
  // up to ~30m on complex roofs). Still residentially gated so a
  // neighbor's house parcel will be picked over the road or HOA tract.
  const buffered100 = await runQuery(lat, lng, 100);
  const final = pickResidential(buffered100, "buffered100");
  if (!final) {
    console.warn(
      `[parcel] no_residential_match ` +
        `lat=${lat.toFixed(5)} lng=${lng.toFixed(5)} ` +
        `tiers=exact:${exact.length}/buffered25:${buffered25.length}/buffered100:${buffered100.length}`,
    );
  }
  return final;
}

/**
 * Run the FeatureServer query. `bufferMeters > 0` switches from a
 * point spatial-rel to an envelope around the point.
 */
async function runQuery(
  lat: number,
  lng: number,
  bufferMeters: number,
): Promise<FdorFeature[]> {
  const params = new URLSearchParams({
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields:
      "PARCEL_ID,CO_NO,ACT_YR_BLT,EFF_YR_BLT,TOT_LVG_AR,LND_SQFOOT," +
      "JV,NO_BULDNG,SALE_PRC1,SALE_YR1,DOR_UC,ASMNT_YR",
    returnGeometry: "false",
    f: "json",
  });

  if (bufferMeters > 0) {
    // Convert meters → degrees with a per-lat cosine adjustment.
    // 1° lat ≈ 111_320 m, 1° lng ≈ 111_320·cos(lat) m.
    const dLat = bufferMeters / 111_320;
    const dLng = bufferMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
    const env = {
      xmin: lng - dLng,
      ymin: lat - dLat,
      xmax: lng + dLng,
      ymax: lat + dLat,
      spatialReference: { wkid: 4326 },
    };
    params.set("geometry", JSON.stringify(env));
    params.set("geometryType", "esriGeometryEnvelope");
  } else {
    params.set("geometry", `${lng},${lat}`);
  }

  try {
    const r = await fetch(`${FDOR_CADASTRAL_URL}?${params.toString()}`, {
      // Bumped 6s → 12s. The 6s window was failing on Vercel us-east-1
      // → FGIO Esri hosts during peak load — the indexed spatial
      // query itself is fast but the cross-region TLS handshake plus
      // queue time on FGIO's shared tenancy occasionally pushes total
      // wall clock past 6s. 12s leaves enough headroom for the slow
      // path without bottlenecking the V3 pipeline (parcel call is
      // fired in parallel with Gemini's 25-50s paint, so anything
      // under 50s is free latency).
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) {
      console.warn(
        `[parcel] fdor_http_${r.status} buffer=${bufferMeters}m ` +
          `(returning empty feature set, lookup falls through to next tier)`,
      );
      return [];
    }
    const body = (await r.json()) as FdorQueryResponse;
    if (body.error) {
      console.warn(
        `[parcel] fdor_api_error buffer=${bufferMeters}m ` +
          `code=${body.error.code} msg="${body.error.message}"`,
      );
      return [];
    }
    return body.features ?? [];
  } catch (err) {
    // Surface the actual error reason — prior version swallowed every
    // throw silently, so timeouts looked identical to "0 features
    // returned" in production logs. Now we log abort timeouts, DNS
    // failures, and TLS handshake errors distinctly.
    console.warn(
      `[parcel] fdor_fetch_failed buffer=${bufferMeters}m reason="${
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      }"`,
    );
    return [];
  }
}

/**
 * Pick the best residential parcel from the candidate list. Filters:
 *   1. DOR use code must start with a residential prefix.
 *   2. At least one building on the parcel (kills HOA common areas).
 *   3. When multiple match (rare, only on a buffered query that
 *      straddles a property line), prefer the smaller lot — that's
 *      the homeowner's actual parcel, not the abutting HOA tract.
 */
function pickResidential(
  features: FdorFeature[],
  queryLabel: string,
): ParcelLookupResult | null {
  if (features.length === 0) return null;
  const rejections: string[] = [];
  const candidates = features.filter((f) => {
    const a = f.attributes ?? {};
    const dorUc = (a.DOR_UC ?? "").toString();
    const isRes = isResidentialUseCode(dorUc);
    const hasBuilding = (a.NO_BULDNG ?? 0) > 0;
    // Sanity floor on living area — kills 480-sqft "home" records that
    // are actually yacht-club outbuildings on multi-acre lots even when
    // the DOR code somehow slips through.
    const hasRealLivingArea = (a.TOT_LVG_AR ?? 0) >= 400;
    const ok = isRes && hasBuilding && hasRealLivingArea;
    if (!ok) {
      const why = !isRes
        ? `dor_uc=${dorUc || "(empty)"} not residential`
        : !hasBuilding
          ? `no_buildings (NO_BULDNG=${a.NO_BULDNG ?? "null"})`
          : `living_area<400 (TOT_LVG_AR=${a.TOT_LVG_AR ?? "null"})`;
      rejections.push(`${a.PARCEL_ID ?? "(no-id)"}: ${why}`);
    }
    return ok;
  });

  if (candidates.length === 0) {
    if (rejections.length > 0) {
      console.warn(
        `[parcel] ${queryLabel}_rejected ${rejections.length} candidates:` +
          ` ${rejections.slice(0, 3).join("; ")}` +
          (rejections.length > 3 ? ` +${rejections.length - 3} more` : ""),
      );
    }
    return null;
  }

  // Smallest residential lot wins — that's the home, not the
  // surrounding common-area tract.
  candidates.sort(
    (a, b) =>
      (a.attributes.LND_SQFOOT ?? Infinity) -
      (b.attributes.LND_SQFOOT ?? Infinity),
  );
  console.log(
    `[parcel] ${queryLabel}_pick ` +
      `parcel_id=${candidates[0].attributes.PARCEL_ID ?? "?"} ` +
      `dor_uc=${candidates[0].attributes.DOR_UC ?? "?"} ` +
      `(${candidates.length} candidates, smallest-lot wins)`,
  );

  return toResult(candidates[0]);
}

function toResult(f: FdorFeature): ParcelLookupResult {
  const a = f.attributes;
  // ACT_YR_BLT / EFF_YR_BLT come back as 0 when the county didn't
  // report — normalize to null so consumers don't ship "Built in 0" UI.
  const yr = (n: number | null | undefined) =>
    n && n > 1700 && n < 2100 ? n : null;

  const lastSaleYear = yr(a.SALE_YR1);
  const lastSalePrice = a.SALE_PRC1 ?? 0;

  return {
    parcelId: a.PARCEL_ID ?? "",
    countyNumber: Math.round(a.CO_NO ?? 0),
    yearBuilt: yr(a.ACT_YR_BLT),
    effectiveYearBuilt: yr(a.EFF_YR_BLT),
    livingSqft: a.TOT_LVG_AR && a.TOT_LVG_AR > 0 ? a.TOT_LVG_AR : null,
    lotSqft: a.LND_SQFOOT && a.LND_SQFOOT > 0 ? a.LND_SQFOOT : null,
    justValue: a.JV && a.JV > 0 ? a.JV : null,
    buildingCount: a.NO_BULDNG ?? null,
    lastSale:
      lastSaleYear && lastSalePrice > 0
        ? { priceUsd: lastSalePrice, year: lastSaleYear }
        : null,
    dorUseCode: (a.DOR_UC ?? "").toString().padStart(4, "0"),
    assessmentYear: yr(a.ASMNT_YR),
  };
}

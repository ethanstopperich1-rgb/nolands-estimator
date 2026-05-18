/**
 * Google Street View Static API wrapper.
 *
 * Pulls a ground-level photograph of the property's front facade so the
 * V3 pipeline can analyze roof + house condition at ~100× the resolution
 * of the straight-down satellite tile. The satellite view tells us
 * sqft + facets + major staining; the Street View image tells us vent
 * boot rubber, drip edge integrity, fascia rot, gutter sag, flashing
 * rust, and house-care signals that simply aren't visible from above.
 *
 * Cost per call: ~$0.007 (Static API pricing; first 1k/month free for
 * Maps Platform standard projects).
 *
 * Pipeline:
 *   1. Hit the Street View Metadata endpoint at (lat, lng, radius=50m)
 *      to find the nearest panorama. Returns the panorama's actual
 *      camera lat/lng + pano_id + image date.
 *   2. Compute the heading the panorama camera would need to face the
 *      building's lat/lng (great-circle bearing math).
 *   3. Fetch the Street View Static image with that heading, 80° FOV,
 *      15° pitch (slightly upward to catch the roof line).
 *   4. Return base64 + the panorama capture date so downstream code can
 *      surface "imagery from <month> <year>" to the customer.
 *
 * Soft-failure: if no panorama is in range (private road, rural acreage)
 * the function returns null and the rest of the V3 pipeline carries on
 * without ground-level data. The customer flow never errors out because
 * Street View was missing for one address.
 */

export interface StreetViewResult {
  /** Base64-encoded JPEG bytes from the Street View Static API. */
  imageBase64: string;
  /** Camera location of the panorama, in case downstream code wants to
   *  show "photo taken from {N} feet down the street." */
  panoLat: number;
  panoLng: number;
  /** YYYY-MM date the panorama was captured. Important for the customer
   *  story — "Imagery from Mar 2024" sets the right expectation. */
  panoDate: string | null;
  /** Pano ID — opaque, used for analytics + cache keys downstream. */
  panoId: string;
  /** Heading we asked the static endpoint to render, 0–360°. */
  heading: number;
}

interface StreetViewMetadataResponse {
  status:
    | "OK"
    | "ZERO_RESULTS"
    | "NOT_FOUND"
    | "OVER_QUERY_LIMIT"
    | "REQUEST_DENIED"
    | "INVALID_REQUEST"
    | "UNKNOWN_ERROR";
  pano_id?: string;
  location?: { lat: number; lng: number };
  date?: string;
  copyright?: string;
}

/**
 * Great-circle bearing from one lat/lng to another, in degrees 0–360
 * where 0 = north. This is the heading the panorama camera needs to
 * point to face the building.
 *
 * Standard spherical-bearing math; for typical residential distances
 * (< 100 m between panorama and building) a flat-earth approximation
 * would also work, but the spherical form is the same number of lines
 * and handles edge cases.
 */
function bearingDegrees(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(fromLat);
  const φ2 = toRad(toLat);
  const Δλ = toRad(toLng - fromLng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
}

/**
 * Fetch a Street View image of the property at (lat, lng).
 *
 * Returns null when no panorama is available within 50m. Throws only
 * when the Google API itself returns a hard error (quota / auth).
 */
export async function fetchStreetViewForProperty(
  lat: number,
  lng: number,
  apiKey: string,
): Promise<StreetViewResult | null> {
  if (!apiKey) return null;

  // Step 1 — Metadata. Confirms there IS a panorama nearby + tells us
  // where the camera actually was so we can compute the heading the
  // image needs to be rendered with. `source=outdoor` skips indoor
  // panoramas (which would face a wall, not the house).
  const metaUrl =
    `https://maps.googleapis.com/maps/api/streetview/metadata` +
    `?location=${lat},${lng}` +
    `&radius=50` +
    `&source=outdoor` +
    `&key=${apiKey}`;
  let meta: StreetViewMetadataResponse;
  try {
    const r = await fetch(metaUrl, {
      // Metadata is free and tiny — short timeout is fine.
      signal: AbortSignal.timeout(6_000),
    });
    if (!r.ok) return null;
    meta = (await r.json()) as StreetViewMetadataResponse;
  } catch {
    return null;
  }
  if (meta.status !== "OK" || !meta.location || !meta.pano_id) {
    return null;
  }

  const panoLat = meta.location.lat;
  const panoLng = meta.location.lng;
  const heading = bearingDegrees(panoLat, panoLng, lat, lng);

  // Step 2 — Static image. Square 640×640, slightly upward pitch (15°)
  // so we capture the roof line + fascia + gutter + upper facade.
  // 80° FOV gives a balanced framing — not so wide we lose detail,
  // not so narrow we miss the roof above the windows.
  const imageUrl =
    `https://maps.googleapis.com/maps/api/streetview` +
    `?size=640x640` +
    `&pano=${encodeURIComponent(meta.pano_id)}` +
    `&heading=${heading.toFixed(2)}` +
    `&pitch=15` +
    `&fov=80` +
    `&key=${apiKey}`;
  let bytes: ArrayBuffer;
  try {
    const r = await fetch(imageUrl, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    bytes = await r.arrayBuffer();
  } catch {
    return null;
  }

  return {
    imageBase64: Buffer.from(bytes).toString("base64"),
    panoLat,
    panoLng,
    panoDate: meta.date ?? null,
    panoId: meta.pano_id,
    heading,
  };
}

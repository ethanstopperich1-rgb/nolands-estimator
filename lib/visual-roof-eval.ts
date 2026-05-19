/**
 * Visual roof-age / condition eval — Gemini 2.5 Pro over 2 photographic
 * sources (top-down Static Maps tile + curated Street View pano).
 *
 * Deliberately decoupled from the V3 pipeline. The Flash fine-grained
 * outputs are unreliable on satellite tiles alone (see the
 * `feedback_gemini_flash_unreliable` memory); this is the experimental
 * 2-image Pro path used by:
 *
 *   - scripts/eval-eagleview/eval-roof-visual.ts  (local CLI eval, fs output)
 *   - app/internal/visual-eval/page.tsx           (staff-gated deployed surface)
 *
 * Hard constraints from the design discussion (KEEP THESE):
 *   - Top-down tile uses the same params as the V3 pipeline so identity
 *     is anchored on the same Solar-API centroid the customer sees.
 *   - Street View pano must be <30m from centroid OR we drop it. The
 *     camera heading is computed pano → centroid so it points AT the
 *     building.
 *   - Pro is forbidden from estimating age in years. Only enum
 *     observations + per-image identity verdicts.
 */

const PIN_TILE_ZOOM = 21;
const TILE_SIZE_PX = 640;
const TILE_SCALE = 2;

export const STREET_VIEW_MAX_DISTANCE_M = 30;
const STREET_VIEW_FOV = 80;
const STREET_VIEW_SIZE_PX = 640;

const PRO_MODEL = "gemini-2.5-pro";

export interface ProResult {
  images: Array<{ index: number; identity: string; reason: string }>;
  primaryMaterial: string;
  materialReason?: string;
  conditionObservations: string[];
  observationNotes?: string;
  confidence: string;
  confidenceReason?: string;
}

export interface PanoMeta {
  id: string | null;
  distanceM: number | null;
  heading: number | null;
  date: string | null;
  skipped: boolean;
  skipReason: string | null;
}

export interface EvalResult {
  lat: number;
  lng: number;
  label: string;
  pano: PanoMeta;
  topDown: { base64: string; mime: "image/png" };
  streetView: { base64: string; mime: "image/jpeg" } | null;
  pro: { raw: string; parsed: ProResult | null };
  totalLatencyMs: number;
}

// ─── geo helpers ───────────────────────────────────────────────────────
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Heading from `from` toward `to`, per design spec:
 *   heading = atan2(Δlng, Δlat) → degrees, normalized to [0, 360)
 *
 * Flat-earth approximation — fine over the <30m distance cap.
 */
export function headingDeg(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const dLng = to.lng - from.lng;
  const dLat = to.lat - from.lat;
  const rad = Math.atan2(dLng, dLat);
  const deg = (rad * 180) / Math.PI;
  return (deg + 360) % 360;
}

// ─── image fetchers ────────────────────────────────────────────────────
async function fetchTopDownTile(
  lat: number,
  lng: number,
  googleKey: string,
): Promise<{ bytes: Buffer; mime: "image/png" }> {
  const url =
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${lat},${lng}&zoom=${PIN_TILE_ZOOM}` +
    `&size=${TILE_SIZE_PX}x${TILE_SIZE_PX}&scale=${TILE_SCALE}` +
    `&maptype=satellite&key=${googleKey}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`staticmap_${res.status}: ${await res.text().catch(() => "")}`);
  }
  return { bytes: Buffer.from(await res.arrayBuffer()), mime: "image/png" };
}

interface StreetViewMetadata {
  status: string;
  pano_id?: string;
  location?: { lat: number; lng: number };
  date?: string;
}

async function fetchStreetViewMetadata(
  lat: number,
  lng: number,
  googleKey: string,
): Promise<StreetViewMetadata> {
  const url =
    `https://maps.googleapis.com/maps/api/streetview/metadata` +
    `?location=${lat},${lng}&key=${googleKey}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`sv_metadata_${res.status}`);
  }
  return (await res.json()) as StreetViewMetadata;
}

async function fetchStreetViewPano(
  panoId: string,
  heading: number,
  googleKey: string,
): Promise<{ bytes: Buffer; mime: "image/jpeg" }> {
  const url =
    `https://maps.googleapis.com/maps/api/streetview` +
    `?pano=${encodeURIComponent(panoId)}&heading=${heading.toFixed(2)}` +
    `&fov=${STREET_VIEW_FOV}&size=${STREET_VIEW_SIZE_PX}x${STREET_VIEW_SIZE_PX}` +
    `&key=${googleKey}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`sv_image_${res.status}`);
  }
  return { bytes: Buffer.from(await res.arrayBuffer()), mime: "image/jpeg" };
}

// ─── Gemini Pro caller ─────────────────────────────────────────────────
const SYSTEM_INSTRUCTION = `You are a roof condition assessor for a Florida roofing-sales tool. You will receive two photographic images of what should be the same residential property at known coordinates. Your job is to:

1. VERIFY each image actually shows the target building. If an image shows a different building, neighboring property, an unrelated structure, or is too occluded by trees / vehicles / objects to assess, flag it as identity_mismatch and do NOT use it for material or condition assessment.

2. Identify the PRIMARY ROOF MATERIAL from the verified images:
   - "asphalt_3tab" (flat appearance, simple tab pattern)
   - "asphalt_architectural" (dimensional, layered shadow pattern)
   - "concrete_tile" or "clay_tile" (curved barrels, terracotta/brown)
   - "metal_standing_seam" (vertical ribs, often gray/silver/colored)
   - "flat_membrane" (TPO/EPDM, low-slope, no shingle pattern)
   - "mixed" (different materials on different sections)
   - "unknown" (can't tell)

3. List specific VISIBLE CONDITION OBSERVATIONS from the verified images. Use only observable evidence — do NOT estimate age in years. Possible observations:
   - "dark_streaking" (algae/moss streaks running down slopes)
   - "granule_loss" (darker patches where granules wore off)
   - "missing_shingles" (visible underlayment patches)
   - "patches_or_repairs" (mismatched colors / sections)
   - "tarp_visible" (active damage / waiting on claim)
   - "ridge_damage" (caps lifted or missing)
   - "moss_or_vegetation" (visible growth on roof)
   - "color_uniformity_good" (consistent color, looks newer)
   - "tree_overhang_heavy" (canopy obstructs assessment)
   - "no_visible_issues" (clean from the available angle)

4. Self-report confidence: "high" (both images verified target, multiple condition observations possible), "medium" (one image verified, partial assessment), "low" (identity uncertain or both images too obstructed to assess).

DO NOT estimate roof age in years. DO NOT invent condition observations you can't point to in the images. If you can't see the roof clearly, say so via low confidence + tree_overhang_heavy.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    images: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          identity: {
            type: "string",
            enum: ["match", "mismatch", "uncertain", "obstructed"],
          },
          reason: { type: "string" },
        },
        required: ["index", "identity", "reason"],
      },
    },
    primaryMaterial: {
      type: "string",
      enum: [
        "asphalt_3tab",
        "asphalt_architectural",
        "concrete_tile",
        "clay_tile",
        "metal_standing_seam",
        "flat_membrane",
        "mixed",
        "unknown",
      ],
    },
    materialReason: { type: "string" },
    conditionObservations: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "dark_streaking",
          "granule_loss",
          "missing_shingles",
          "patches_or_repairs",
          "tarp_visible",
          "ridge_damage",
          "moss_or_vegetation",
          "color_uniformity_good",
          "tree_overhang_heavy",
          "no_visible_issues",
        ],
      },
    },
    observationNotes: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    confidenceReason: { type: "string" },
  },
  required: ["images", "primaryMaterial", "conditionObservations", "confidence"],
};

async function callGeminiPro(args: {
  topDownBase64: string;
  streetViewBase64: string | null;
  lat: number;
  lng: number;
  address: string;
  panoId: string | null;
  panoDistanceM: number | null;
  heading: number | null;
  geminiKey: string;
}): Promise<{ raw: string; parsed: ProResult | null }> {
  const parts: Array<
    { inline_data: { mime_type: string; data: string } } | { text: string }
  > = [];
  parts.push({
    inline_data: { mime_type: "image/png", data: args.topDownBase64 },
  });
  parts.push({
    text:
      `Image 1 above: top-down satellite of target building at ` +
      `lat=${args.lat}, lng=${args.lng}. The address is ${args.address}.`,
  });
  if (
    args.streetViewBase64 &&
    args.panoId &&
    args.heading != null &&
    args.panoDistanceM != null
  ) {
    parts.push({
      inline_data: { mime_type: "image/jpeg", data: args.streetViewBase64 },
    });
    parts.push({
      text:
        `Image 2 above: Google Street View at heading ${args.heading.toFixed(0)}° ` +
        `from pano ${args.panoId} located ${args.panoDistanceM.toFixed(1)}m from ` +
        `the target building centroid. This should show the front of the same ` +
        `building visible in Image 1.`,
    });
  } else {
    parts.push({
      text:
        `Image 2 unavailable for this property — no usable Street View pano ` +
        `within ${STREET_VIEW_MAX_DISTANCE_M}m of the target centroid. Base your ` +
        `assessment on Image 1 only and adjust confidence accordingly.`,
    });
  }
  parts.push({
    text:
      "Per your system instructions, verify both images show the target " +
      "building, then return the JSON object matching the response schema.",
  });

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${PRO_MODEL}:generateContent?key=${args.geminiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gemini_pro_${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  let parsed: ProResult | null = null;
  try {
    parsed = JSON.parse(raw) as ProResult;
  } catch {
    parsed = null;
  }
  return { raw, parsed };
}

// ─── orchestrator ──────────────────────────────────────────────────────
export async function runVisualRoofEval(args: {
  lat: number;
  lng: number;
  label: string;
  geminiKey: string;
  googleKey: string;
}): Promise<EvalResult> {
  const t0 = Date.now();

  // 1. Top-down tile
  const topDown = await fetchTopDownTile(args.lat, args.lng, args.googleKey);

  // 2. Street View metadata + guardrails
  const meta = await fetchStreetViewMetadata(
    args.lat,
    args.lng,
    args.googleKey,
  );
  let pano: PanoMeta = {
    id: null,
    distanceM: null,
    heading: null,
    date: meta.date ?? null,
    skipped: true,
    skipReason: null,
  };
  let streetView: { base64: string; mime: "image/jpeg" } | null = null;
  let streetViewBytes: Buffer | null = null;

  if (meta.status !== "OK" || !meta.pano_id || !meta.location) {
    pano.skipReason = `metadata_status=${meta.status}`;
  } else {
    const distanceM = haversineMeters(meta.location, {
      lat: args.lat,
      lng: args.lng,
    });
    if (distanceM > STREET_VIEW_MAX_DISTANCE_M) {
      pano = {
        id: meta.pano_id,
        distanceM,
        heading: null,
        date: meta.date ?? null,
        skipped: true,
        skipReason: `pano_too_far_${distanceM.toFixed(1)}m`,
      };
    } else {
      const heading = headingDeg(meta.location, {
        lat: args.lat,
        lng: args.lng,
      });
      const sv = await fetchStreetViewPano(
        meta.pano_id,
        heading,
        args.googleKey,
      );
      streetViewBytes = sv.bytes;
      streetView = { base64: sv.bytes.toString("base64"), mime: "image/jpeg" };
      pano = {
        id: meta.pano_id,
        distanceM,
        heading,
        date: meta.date ?? null,
        skipped: false,
        skipReason: null,
      };
    }
  }

  // 3. Gemini Pro
  const pro = await callGeminiPro({
    topDownBase64: topDown.bytes.toString("base64"),
    streetViewBase64: streetViewBytes ? streetViewBytes.toString("base64") : null,
    lat: args.lat,
    lng: args.lng,
    address: args.label,
    panoId: pano.id,
    panoDistanceM: pano.distanceM,
    heading: pano.heading,
    geminiKey: args.geminiKey,
  });

  return {
    lat: args.lat,
    lng: args.lng,
    label: args.label,
    pano,
    topDown: { base64: topDown.bytes.toString("base64"), mime: "image/png" },
    streetView,
    pro,
    totalLatencyMs: Date.now() - t0,
  };
}

/** Hardcoded reference set so the page can offer one-click runs. */
export const REFERENCE_CASES = [
  {
    short: "newcomb",
    name: "2863 Newcomb Ct, Orlando FL",
    lat: 28.5844052,
    lng: -81.17330439999999,
  },
  {
    short: "jupiter",
    name: "813 Summerwood Dr, Jupiter FL",
    lat: 26.93252,
    lng: -80.10804,
  },
  {
    short: "oakpark",
    name: "8450 Oak Park Rd, Orlando FL",
    lat: 28.4885634,
    lng: -81.49980670000001,
  },
] as const;

export type ReferenceShort = (typeof REFERENCE_CASES)[number]["short"];

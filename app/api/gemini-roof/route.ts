/**
 * /api/gemini-roof — V3 truth pipeline endpoint.
 *
 * Fans out to Solar API + multiple Gemini calls in parallel:
 *   1. Solar API → authoritative pitch + per-segment azimuth + footprint
 *   2. Gemini 3 Pro Image (multimodal IMAGE+TEXT) → painted overlay
 *   3. Gemini 2.5 Flash (structured JSON) → rooftop objects + material
 *      + condition hints + visible damage + secondary structures
 *   4. Gemini 2.5 Flash (structured JSON) → ridge/hip/valley/rake/eave
 *      polylines for edge measurement
 *
 * The geometry module (lib/roof-geometry) handles pixel → lat/lng →
 * sqft / LF math. This route is the orchestrator.
 *
 * ─── GEMINI 3 CONFIG RULES (empirically verified, do not "fix") ───────
 *
 * Google publishes two prompting guides that disagree on temperature,
 * media resolution, parts order, and system-instruction placement.
 * That's because they target two different task types:
 *
 *   A) IMAGE-UNDERSTANDING / TEXT GENERATION (Flash text calls below)
 *      Google's `ai.google.dev/gemini-api/docs/prompt-strategies`:
 *        - temperature 1.0 (Gemini 3 default)
 *        - mediaResolution: MEDIA_RESOLUTION_HIGH for fine detail
 *        - Persona + rules in systemInstruction
 *        - parts order [image, text] per the image-understanding guide
 *        - User content opens with anchor phrase "Based on the image
 *          above, return..."
 *
 *   B) IMAGE-EDIT (Pro Image multimodal, responseModalities ["IMAGE","TEXT"])
 *      The image-generation model is a DIFFERENT beast. We verified
 *      Brad's working config against bad Pro Image responses on
 *      2026-05-18 and the rules are:
 *        - temperature 0 (1.0 → empty responses)
 *        - NO mediaResolution param (causes empty responses)
 *        - NO systemInstruction split (edit prompt must travel with
 *          the image in user content)
 *        - parts order [text, image] (image-first degraded facet-line
 *          crispness in side-by-side; Brad's text-first produced the
 *          magazine-clean Winter Garden + Orlando paints)
 *        - Open with "Edit this 1280×1280 aerial satellite image."
 *          NOT "You are a senior inspector..." (the persona opener
 *          made Pro Image generate a new image from scratch)
 *
 * If a future Gemini release ever publishes an official image-edit
 * prompting guide, revisit this. Until then: don't apply (A) rules to
 * (B) calls.
 *
 * GET ?lat=X&lng=Y[&address=...&skipCache=1]
 * POST { lat, lng, address?, skipCache? }
 */

import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import sharp from "sharp";
import { checkBotId } from "botid/server";
import { rateLimit } from "@/lib/ratelimit";
import { checkOrigin } from "@/lib/origin-guard";
import {
  AI_CALL_COST_USD,
  assertAiSpendUnderCap,
  trackAiSpend,
} from "@/lib/cost-cap";
import { validatePaintedPngBase64 } from "@/lib/validate-image";
import { watermarkPaintedPng } from "@/lib/watermark";
import { isStaffRequest } from "@/lib/staff-auth";
import { fetchWithTimeout } from "@/lib/safe-fetch";
import { getCached, setCached } from "@/lib/cache";
import { fetchGisFootprint } from "@/lib/reconcile-roof-polygon";
import { polygonAreaSqft } from "@/lib/polygon";
import { rotateAllFacets } from "@/lib/solar-facets";
import { classifyEdges } from "@/lib/roof-engine";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import type { Json } from "@/types/supabase";
import type { Facet, Edge, Material } from "@/types/roof";
import {
  buildTileMetadata,
  pixelPolygonToLatLng,
  processVisionOutput,
  reconcileGeminiAgainstSolar,
  type ReconciliationResult,
  type RoofMeasurements,
  type SolarPlaneMatch,
  type VisionRoofOutput,
} from "@/lib/roof-geometry";
import {
  GEMINI_ROOF_SCHEMA,
  GEMINI_ROOF_SYSTEM_INSTRUCTION,
  GEMINI_ROOF_USER_TRIGGER,
} from "@/lib/gemini-roof-prompt";

export const runtime = "nodejs";
// Paint-only mode budget: Pro Image is the only Gemini call now.
// 90s leaves ~30s of slack on top of typical 25–50s paint latency
// without blowing past Vercel's default function ceiling.
export const maxDuration = 90;

const TILE_ZOOM = 20;
const TILE_SCALE = 2 as const;
const TILE_SIZE_PX = 640; // Google `size=640x640`; image becomes 1280×1280 at scale=2
const GEMINI_MODEL =
  process.env.GEMINI_MODEL ?? "gemini-3-pro-image-preview";
const CACHE_SCOPE = "gemini-roof-v1";

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | { inlineData: { mimeType: string; data: string } };

type Confidence = "high" | "medium" | "low";

interface GeminiPredictionRaw {
  outline?: Array<{ x: number; y: number }>;
  facets?: Array<{
    letter: string;
    polygon: Array<{ x: number; y: number }>;
    orientation: string;
    confidence: Confidence;
  }>;
  roof_lines?: Array<{
    start: { x: number; y: number };
    end: { x: number; y: number };
    is_perimeter: boolean;
  }>;
  objects?: Array<{
    kind:
      | "vent"
      | "chimney"
      | "hvac_unit"
      | "skylight"
      | "plumbing_boot"
      | "satellite_dish"
      | "solar_panel";
    center: { x: number; y: number };
    bbox: { x: number; y: number; width: number; height: number };
    confidence: Confidence;
  }>;
}

interface SolarSegment {
  pitchDegrees?: number;
  azimuthDegrees?: number;
  stats?: { areaMeters2?: number; groundAreaMeters2?: number };
  boundingBox?: {
    sw: { latitude: number; longitude: number };
    ne: { latitude: number; longitude: number };
  };
}

interface SolarResponse {
  center?: { latitude: number; longitude: number };
  /** Whole-building bbox. Google's photogrammetric building model
   *  emits this alongside `center` — used to pick a tile zoom level
   *  that makes the target building dominate the frame. */
  boundingBox?: {
    sw: { latitude: number; longitude: number };
    ne: { latitude: number; longitude: number };
  };
  solarPotential?: {
    roofSegmentStats?: SolarSegment[];
    wholeRoofStats?: { groundAreaMeters2?: number };
    maxArrayPanelsCount?: number;
    maxSunshineHoursPerYear?: number;
  };
  imageryDate?: { year: number; month: number; day: number };
  imageryQuality?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface ParsedInputs {
  lat: number;
  lng: number;
  address: string | null;
  skipCache: boolean;
  /** When true, the lat/lng is the customer's confirmed pin position.
   *  The route uses this as the EXACT tile center — no Solar-bbox
   *  recentering, no zoom auto-pick from building dimensions. */
  pinConfirmed: boolean;
  /** When true, echo raw Gemini-text into the response for diagnostics. */
  debug: boolean;
  /** When set, the route persists the V3 result to leads.roof_v3_json
   *  via waitUntil() so the rep workbench can "See report" instantly. */
  leadPublicId: string | null;
}

function parseInputs(req: Request, body: unknown): ParsedInputs | NextResponse {
  if (req.method === "GET") {
    const u = new URL(req.url);
    const lat = Number(u.searchParams.get("lat"));
    const lng = Number(u.searchParams.get("lng"));
    const address = u.searchParams.get("address");
    const skipCache = u.searchParams.get("skipCache") === "1";
    const pinConfirmed = u.searchParams.get("pinConfirmed") === "1";
    const debug = u.searchParams.get("debug") === "1";
    const leadPublicId = u.searchParams.get("leadPublicId");
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
    }
    return {
      lat, lng, address, skipCache, pinConfirmed, debug,
      leadPublicId: leadPublicId && /^lead_[0-9a-f]{32}$/i.test(leadPublicId) ? leadPublicId : null,
    };
  }
  const b = body as {
    lat?: number;
    lng?: number;
    address?: string;
    skipCache?: boolean;
    pinConfirmed?: boolean;
    debug?: boolean;
    leadPublicId?: string;
  };
  if (!b || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }
  return {
    lat: Number(b.lat),
    lng: Number(b.lng),
    address: b.address ?? null,
    skipCache: !!b.skipCache,
    pinConfirmed: !!b.pinConfirmed,
    debug: !!b.debug,
    leadPublicId:
      typeof b.leadPublicId === "string" && /^lead_[0-9a-f]{32}$/i.test(b.leadPublicId)
        ? b.leadPublicId
        : null,
  };
}

async function fetchGoogleStaticTile(
  lat: number,
  lng: number,
  apiKey: string,
  zoom: number = TILE_ZOOM,
): Promise<{ base64: string; mimeType: "image/png" }> {
  const url =
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${lat},${lng}&zoom=${zoom}` +
    `&size=${TILE_SIZE_PX}x${TILE_SIZE_PX}&scale=${TILE_SCALE}` +
    `&maptype=satellite&key=${apiKey}`;
  const res = await fetchWithTimeout(url, { timeoutMs: 15_000, cache: "no-store" });
  if (!res.ok) {
    throw new Error(`google_static_${res.status}`);
  }
  const raw = Buffer.from(await res.arrayBuffer());

  // ─── Shadow-lift preprocessing ────────────────────────────────────────
  // Lifts dark areas (skylight-cast shadows, tree shadows on roof,
  // dormer shadows) before the tile reaches Gemini so the model is less
  // tempted to treat sharp shadow boundaries as roof edges. We're not
  // washing out the image — we're reducing the contrast between
  // "lit shingle" and "shadowed shingle" so they read as the same
  // surface.
  //
  // Pipeline:
  //   - gamma(1.25): lifts midtones (the typical shingle exposure)
  //     more than highlights or pure black. Shadow detail comes up
  //     without blowing out bright roof areas.
  //   - linear(0.92, 18): subtle contrast reduction + 18-unit black-
  //     point lift. RGB(20,20,30) → ~(36,36,46); RGB(220,210,200) →
  //     ~(220,211,202). Asymmetric lift = relative shadow brightening.
  //   - modulate({ saturation: 0.92 }): slight desaturation reduces
  //     the chance Gemini latches onto color edges that aren't real
  //     plane transitions.
  //
  // Failure modes are bounded: the only downside of this preprocessing
  // is a slightly flatter input image. The Gemini overlay still
  // renders correctly on top of the ORIGINAL tile in the browser
  // (we're only sending the lifted version to Gemini, not displaying
  // it). Try/catch ensures a sharp failure just falls back to the raw
  // tile — the route never breaks.
  let processed: Buffer = raw;
  try {
    processed = await sharp(raw)
      .gamma(1.25)
      .linear(0.92, 18)
      .modulate({ saturation: 0.92 })
      .png()
      .toBuffer();
  } catch (err) {
    console.warn(
      "[gemini-roof] shadow-lift preprocessing failed; using raw tile:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return { base64: processed.toString("base64"), mimeType: "image/png" };
}

/**
 * Pick an optimal zoom level so the target building dominates the
 * frame. Solar API's `boundingBox` gives us the building's lat/lng
 * extent; we want the building's longest dimension to occupy roughly
 * 50–65% of the 1280-px tile width.
 *
 * Reasoning: at zoom 20 (our prior default), a typical residential
 * building (~12m wide) occupies only ~14% of the tile. The surrounding
 * 86% is yard / driveway / neighbors — plenty of room for Gemini's
 * visual attention to wander to a brighter neighboring roof. At a
 * tighter zoom the target building physically dominates the frame
 * and the wrong-building failure mode collapses to near zero.
 *
 * Clamped to [19, 22]:
 *   - Zoom 22 is Google's max for satellite imagery in most US regions;
 *     pushing further returns a blurred upscale.
 *   - Zoom 19 is the floor — below that we lose roof-edge detail.
 *
 * The 20% padding factor is added to the building bbox so eaves and
 * roof overhangs don't get cropped at the tile edges.
 */
function pickOptimalZoom(
  bbox: NonNullable<SolarResponse["boundingBox"]>,
  centerLat: number,
): number {
  const M_PER_DEG_LAT = 111_320;
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const widthM = (bbox.ne.longitude - bbox.sw.longitude) * 111_320 * cosLat;
  const heightM = (bbox.ne.latitude - bbox.sw.latitude) * M_PER_DEG_LAT;
  const longestM = Math.max(widthM, heightM, 8) * 1.2; // 20% padding
  const TARGET_FRACTION = 0.55;
  const tilePx = TILE_SIZE_PX * TILE_SCALE; // 1280
  const targetTileM = longestM / TARGET_FRACTION;
  const targetMPerPx = targetTileM / tilePx;
  // metersPerPixel = 156543.03392 × cos(lat) / 2^(Z + scale − 1)
  // Solve for Z: Z = log2(num / mPerPx) − (scale − 1)
  const num = 156_543.03392 * cosLat;
  const z = Math.log2(num / targetMPerPx) - (TILE_SCALE - 1);
  return Math.min(22, Math.max(19, Math.round(z)));
}

interface GeminiMultimodalResult {
  /** Base64-encoded painted image returned by Gemini (PNG). */
  paintedImageBase64: string | null;
  /** Parsed Layer 2 object detection. Native Gemini format: box_2d is
   *  [ymin, xmin, ymax, xmax] normalized 0-1000 per Google's docs.
   *  We descale to pixel coords downstream via `box2dToPx()`. */
  objects: Array<{
    type: string;
    box_2d: [number, number, number, number];
    confidence: number;
  }>;
  /** Raw text part for debugging when JSON parse fails. */
  rawText: string | null;
}

/**
 * Descale Google's native [ymin, xmin, ymax, xmax] 0-1000 normalized
 * format into our 1280×1280 tile's pixel coordinates + center.
 * Gemini docs are explicit that this is the model's trained format;
 * descaling on our side preserves accuracy.
 */
function box2dToPx(
  box: [number, number, number, number],
  tileSize = 1280,
): {
  centerPx: { x: number; y: number };
  bboxPx: { x: number; y: number; width: number; height: number };
} {
  const [ymin, xmin, ymax, xmax] = box;
  const k = tileSize / 1000;
  const x = Math.round(xmin * k);
  const y = Math.round(ymin * k);
  const width = Math.max(1, Math.round((xmax - xmin) * k));
  const height = Math.max(1, Math.round((ymax - ymin) * k));
  return {
    centerPx: {
      x: Math.round(x + width / 2),
      y: Math.round(y + height / 2),
    },
    bboxPx: { x, y, width, height },
  };
}

/**
 * Multimodal Gemini call. Requests BOTH an annotated image (cyan
 * roof-overlay paint) AND JSON object-detection in one round trip via
 * `responseModalities: ["IMAGE", "TEXT"]`. This is the V3 architecture
 * — the painted image IS the visual we show the customer; the objects
 * JSON drives the rich-data layer. Solar runs in parallel for the
 * headline measurement number.
 */
async function callGeminiMultimodal(
  tileBase64: string,
  apiKey: string,
  /**
   * Solar API's segment count for this roof. When > 1, we inject a
   * floor-count hint into the system prompt so Pro Image is forced to
   * draw at least that many interior boundary lines. Pro Image
   * working from a single overhead photo can otherwise visually merge
   * adjacent hip planes with similar pitch — the customer-visible
   * "one big diamond" failure mode the rep flagged on Jupiter
   * 2026-05-18. Solar already has the photogrammetric truth; we just
   * weren't telling Pro Image about it. Free fix, no extra API cost.
   */
  solarSegmentCount: number | null = null,
): Promise<GeminiMultimodalResult> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  // Append a per-request hint when Solar gave us a useful count.
  // ≥2 because a single segment doesn't need a "split more" nudge.
  const hint =
    solarSegmentCount != null && solarSegmentCount >= 2
      ? `\n\n## SEGMENTATION HINT (per-request)\nPhotogrammetric data for this property reports ${solarSegmentCount} distinct roof planes. Your interior 1-pixel boundary lines must reflect at least that many facets — every fold where two planes meet at a different pitch or azimuth gets its own crisp line. Do NOT merge adjacent planes into one continuous polygon just because they share a similar visual color from straight above.`
      : "";
  const promptForThisCall = GEMINI_ROOF_SYSTEM_INSTRUCTION + hint;
  const body = {
    // IMPORTANT: image-editing tasks (`responseModalities: ["IMAGE",
    // "TEXT"]`) require the edit instruction to travel WITH the
    // image in user content — moving it to systemInstruction broke
    // the painted output on 2026-05-18. For multimodal image-edit
    // calls, keep the full prompt inline. Text-only Flash calls
    // (callGeminiRichData, callGeminiLines) DO use systemInstruction
    // because there's no image-edit binding to worry about.
    contents: [
      {
        // Parts order: [text, image]. Google's image-understanding
        // doc recommends [image, text] for understanding tasks — but
        // for image-EDIT tasks with `responseModalities: ["IMAGE",
        // "TEXT"]`, the working configuration (verified by the
        // magazine-clean Winter Garden + Orlando paints from 2026-05-
        // 17) is text-first. Image-first reduced facet-outline
        // crispness in side-by-side tests. Keep this as-is.
        parts: [
          { text: promptForThisCall },
          { inline_data: { mime_type: "image/png", data: tileBase64 } },
        ] satisfies GeminiPart[],
      },
    ],
    generationConfig: {
      // IMPORTANT: Pro Image (gemini-3-pro-image-preview) does NOT
      // play by the same rules as the text/vision models.
      //   - `temperature: 1.0` produces empty responses (verified on
      //     Jupiter 2026-05-18: 200 OK with no inline_data part).
      //   - `mediaResolution: HIGH` is likewise unsupported on image
      //     generation — same empty-response failure mode.
      // Both knobs are documented for Gemini 3 text/vision models, not
      // image-edit. Keep this call at temperature 0 + no media res
      // override. Flash text calls below still use temperature 1.0 +
      // mediaResolution HIGH per Google's docs.
      temperature: 0,
      responseModalities: ["IMAGE", "TEXT"],
    },
  };
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Must be < route maxDuration (90s) so we fail fast with a clean
    // error instead of letting Vercel kill the function with a
    // FUNCTION_INVOCATION_TIMEOUT 504.
    timeoutMs: 80_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gemini_${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          inline_data?: { mime_type: string; data: string };
          inlineData?: { mimeType: string; data: string };
        }>;
      };
    }>;
  };

  let paintedImageBase64: string | null = null;
  let rawText: string | null = null;
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part.inline_data ?? part.inlineData;
    if (inline?.data && !paintedImageBase64) {
      paintedImageBase64 = inline.data;
    }
    if (part.text && !rawText) {
      rawText = part.text;
    }
  }

  // Parse objects out of the text part. Gemini may return:
  //   - Pure JSON: { "objects": [...] }
  //   - Markdown-fenced JSON: ```json\n{...}\n```
  //   - JSON embedded in prose
  // Strip code fences first, then look for the first {...} block.
  let objects: GeminiMultimodalResult["objects"] = [];
  if (rawText) {
    let candidate = rawText.trim();
    candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const jsonSlice = candidate.slice(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(jsonSlice) as { objects?: typeof objects };
        if (Array.isArray(parsed.objects)) objects = parsed.objects;
      } catch {
        // Soft-fail — leave objects empty. The painted image is still useful.
      }
    }
  }

  return { paintedImageBase64, objects, rawText };
}

// Legacy single-modality call retained for non-pin-confirmed paths.
// Returns the older structured-output shape (outline/facets/lines/objects).
async function callGemini(
  tileBase64: string,
  apiKey: string,
): Promise<GeminiPredictionRaw> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: GEMINI_ROOF_SYSTEM_INSTRUCTION }] },
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: "image/png",
              data: tileBase64,
            },
          },
          { text: GEMINI_ROOF_USER_TRIGGER },
        ] satisfies GeminiPart[],
      },
    ],
    generationConfig: {
      // See multimodal-call notes above for the temperature 1.0 +
      // mediaResolution HIGH rationale.
      temperature: 1.0,
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
      responseMimeType: "application/json",
      responseSchema: GEMINI_ROOF_SCHEMA,
    },
  };
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 55_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gemini_${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("gemini_no_text_in_response");
  }
  let parsed: GeminiPredictionRaw;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`gemini_invalid_json: ${err instanceof Error ? err.message : "?"}`);
  }
  return parsed;
}

async function callSolar(
  lat: number,
  lng: number,
  apiKey: string,
): Promise<SolarResponse | null> {
  const requiredQuality = process.env.SOLAR_REQUIRED_QUALITY ?? "LOW";
  const url =
    `https://solar.googleapis.com/v1/buildingInsights:findClosest` +
    `?location.latitude=${lat}&location.longitude=${lng}` +
    `&requiredQuality=${requiredQuality}&key=${apiKey}`;
  try {
    const res = await fetchWithTimeout(url, { timeoutMs: 15_000, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as SolarResponse;
  } catch {
    return null;
  }
}

function solarToPlaneMatches(solar: SolarResponse | null): SolarPlaneMatch[] {
  const segs = solar?.solarPotential?.roofSegmentStats ?? [];
  return segs
    .filter((s) => s.boundingBox && typeof s.pitchDegrees === "number")
    .map((s) => {
      const bb = s.boundingBox!;
      const centerLat = (bb.sw.latitude + bb.ne.latitude) / 2;
      const centerLng = (bb.sw.longitude + bb.ne.longitude) / 2;
      const areaM2 = s.stats?.areaMeters2 ?? 0;
      return {
        centerLat,
        centerLng,
        pitchDegrees: s.pitchDegrees ?? 0,
        azimuthDeg: s.azimuthDegrees ?? 0,
        solarAreaSqft: areaM2 * 10.7639,
      };
    });
}

function normalizeGeminiOutput(raw: GeminiPredictionRaw): VisionRoofOutput {
  return {
    outlinePx: raw.outline ?? [],
    facets: (raw.facets ?? []).map((f) => ({
      letter: f.letter,
      polygonPx: f.polygon,
      orientation: f.orientation,
      confidence: f.confidence ?? "medium",
    })),
    roofLines: (raw.roof_lines ?? []).map((lf) => ({
      startPx: lf.start,
      endPx: lf.end,
      isPerimeter: lf.is_perimeter,
    })),
    objects: (raw.objects ?? []).map((o) => ({
      kind: o.kind,
      centerPx: o.center,
      bboxPx: o.bbox,
      confidence: o.confidence ?? "medium",
    })),
  };
}

/**
 * Convert the raw Google Solar response into the shape `classifyEdges`
 * expects (Facet[] with rotated polygons). Mirrors what /api/solar +
 * lib/sources/solar-source.ts do internally — inlined here so the V3
 * route doesn't have to roundtrip through the HTTP /api/solar endpoint
 * to get real edge measurements.
 */
function buildFacetsFromSolar(
  solar: SolarResponse | null,
): { facets: Facet[]; dominantAzimuthDeg: number | null } {
  const segs = solar?.solarPotential?.roofSegmentStats ?? [];
  if (segs.length === 0) return { facets: [], dominantAzimuthDeg: null };

  // Per-segment enriched data (matches lib/sources/solar-source.ts shape)
  const enriched = segs.map((s) => {
    const bb = s.boundingBox;
    return {
      pitchDegrees: s.pitchDegrees ?? 0,
      azimuthDegrees: s.azimuthDegrees ?? 0,
      areaSqft: Math.round((s.stats?.areaMeters2 ?? 0) * 10.7639),
      groundAreaSqft: Math.round((s.stats?.groundAreaMeters2 ?? 0) * 10.7639),
      bboxLatLng: bb
        ? {
            swLat: bb.sw.latitude,
            swLng: bb.sw.longitude,
            neLat: bb.ne.latitude,
            neLng: bb.ne.longitude,
          }
        : { swLat: 0, swLng: 0, neLat: 0, neLng: 0 },
    };
  });

  // Area-weighted dominant azimuth, mod 90, double-angle averaged.
  // Mirrors the helper inside /api/solar/route.ts so edges classify
  // consistently across the two consumers.
  let sumX = 0;
  let sumY = 0;
  let totalA = 0;
  for (const s of enriched) {
    if (s.areaSqft <= 0) continue;
    const a = ((s.azimuthDegrees % 90) + 90) % 90;
    const rad = (a * Math.PI) / 90;
    sumX += Math.cos(rad) * s.areaSqft;
    sumY += Math.sin(rad) * s.areaSqft;
    totalA += s.areaSqft;
  }
  let dominantAzimuthDeg: number | null = null;
  if (totalA > 0) {
    const avg = (Math.atan2(sumY, sumX) * 90) / Math.PI / 2;
    dominantAzimuthDeg = ((avg % 90) + 90) % 90;
  }

  // Rotate per-facet bboxes to the building's true axis (otherwise the
  // edges are all axis-aligned and the edge classifier reports
  // garbage). rotateAllFacets returns lat/lng polygons in the same
  // order as the input enriched segments.
  const segmentPolygons = rotateAllFacets(enriched, dominantAzimuthDeg);

  const facets: Facet[] = enriched.map((seg, idx) => {
    const polygon = segmentPolygons[idx] ?? [];
    const pitchRad = (seg.pitchDegrees * Math.PI) / 180;
    const azRad = (seg.azimuthDegrees * Math.PI) / 180;
    return {
      id: `facet-${idx}`,
      polygon,
      normal: {
        x: Math.sin(pitchRad) * Math.sin(azRad),
        y: Math.sin(pitchRad) * Math.cos(azRad),
        z: Math.cos(pitchRad),
      },
      pitchDegrees: seg.pitchDegrees,
      azimuthDeg: seg.azimuthDegrees,
      areaSqftSloped: seg.areaSqft,
      areaSqftFootprint: seg.groundAreaSqft,
      material: null as Material | null,
      isLowSlope: seg.pitchDegrees < 18.43,
    };
  });

  return { facets, dominantAzimuthDeg };
}

/** Sum classified edges into EagleView-style totals (ridges + hips merged
 *  to match EagleView's "Total Ridges/Hips" field; valleys, rakes, eaves
 *  separate). */
function sumEdgesByType(edges: Edge[]): {
  ridgesHipsLf: number;
  valleysLf: number;
  rakesLf: number;
  eavesLf: number;
} {
  let r = 0,
    v = 0,
    k = 0,
    e = 0;
  for (const edge of edges) {
    if (edge.type === "ridge" || edge.type === "hip") r += edge.lengthFt;
    else if (edge.type === "valley") v += edge.lengthFt;
    else if (edge.type === "rake") k += edge.lengthFt;
    else if (edge.type === "eave") e += edge.lengthFt;
  }
  return {
    ridgesHipsLf: Math.round(r),
    valleysLf: Math.round(v),
    rakesLf: Math.round(k),
    eavesLf: Math.round(e),
  };
}

function imageryDateString(
  d: SolarResponse["imageryDate"] | undefined,
): string | null {
  if (!d?.year) return null;
  const m = String(d.month ?? 1).padStart(2, "0");
  const day = String(d.day ?? 1).padStart(2, "0");
  return `${d.year}-${m}-${day}`;
}

// ─── Route handlers ──────────────────────────────────────────────────

/** V3 (holy-grail) response shape — pin-confirmed customer flow. */
export interface GeminiRoofResponseV3 {
  /** Customer-facing solar measurements (sqft, pitch, facets, etc).
   *  When imagery quality is MEDIUM/LOW and Solar's photogrammetric
   *  footprint is suspiciously low vs OSM, the `sqft` + `footprintSqft`
   *  fields here are GIS-corrected (see `correction` for the audit
   *  trail). The customer always sees the corrected number — the raw
   *  Solar values are preserved under `correction.solarRawSqft` etc. */
  solar: {
    sqft: number | null;
    footprintSqft: number | null;
    pitchDegrees: number | null;
    segmentCount: number;
    imageryQuality: string | null;
    imageryDate: string | null;
  };
  /** Undercount-correction audit trail. `applied: true` means we
   *  swapped Solar's footprint for the GIS footprint × Solar slope.
   *  Null when correction didn't run (HIGH imagery / GIS unavailable /
   *  GIS failed validation). */
  correction: {
    applied: boolean;
    reason: string;
    /** Raw Solar values before correction. */
    solarRawSlopedSqft: number;
    solarRawFootprintSqft: number;
    /** GIS source (OSM or MS Buildings) + its footprint area. */
    gisSource: string | null;
    gisFootprintSqft: number | null;
    /** Multiplier applied to GIS footprint to get the corrected sloped
     *  area: solarRawSloped / solarRawFootprint. */
    slopeFactor: number | null;
  } | null;
  /** Tile metadata so the frontend can position the painted image
   *  exactly where Google Maps would put a satellite tile. */
  tile: {
    centerLat: number;
    centerLng: number;
    zoom: number;
    widthPx: number;
    heightPx: number;
  };
  /** Base64-encoded PNG returned by Gemini — cyan-painted roof
   *  overlay drawn directly onto the satellite tile. The frontend
   *  shows this in place of the raw tile. Null when Gemini failed
   *  but Solar succeeded — customer still gets the headline number. */
  paintedImageBase64: string | null;
  /** Rooftop objects detected by Gemini (vents, chimneys, skylights,
   *  HVAC, solar panels, etc). Empty array when Gemini failed. */
  objects: Array<{
    type: string;
    centerPx: { x: number; y: number };
    bboxPx: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
  /** Derived totals from `objects[]` + tile GSD. Mirrors EagleView's
   *  "Roof Penetrations: 3 · Perimeter 6 ft · Area 0.8 sq ft" block. */
  penetrationTotals: {
    count: number;
    perimeterFt: number;
    areaSqft: number;
  };
  /** EagleView-equivalent edge lengths derived from Solar's per-facet
   *  azimuth + adjacency (production roof-engine classifier). Null
   *  fields when Solar didn't return enough segments to classify. */
  edges: {
    ridgesHipsLf: number | null;
    valleysLf: number | null;
    rakesLf: number | null;
    eavesLf: number | null;
  };
  /** Second-opinion edge totals from Gemini direct line detection.
   *  Cheaper to compute (cheap Flash call, $0.005) but vision-fuzzy;
   *  Solar's geometric classification is generally more reliable on
   *  HIGH imagery. Use these when Solar has too few segments to
   *  classify well (MEDIUM/LOW imagery on complex roofs).
   *  `linesCount` is the raw count Gemini returned. */
  geminiEdges: {
    ridgesHipsLf: number;
    valleysLf: number;
    rakesLf: number;
    eavesLf: number;
    linesCount: number;
  } | null;
  /** Per-facet breakdown from Solar (one entry per roofSegmentStats).
   *  Empty array when Solar returned no segments. */
  facets: Array<{
    pitchDegrees: number;
    pitchOnTwelve: string;
    azimuthDegrees: number;
    compassDirection: string;
    slopedSqft: number;
    footprintSqft: number;
  }>;
  /** Whole-roof derived fields — also mirror EagleView. */
  derived: {
    stories: number;
    estimatedAtticSqft: number | null;
    predominantCompass: string | null;
    complexity: "simple" | "moderate" | "complex";
  };
  /** Solar-API-only metrics: how much PV would fit, annual sunshine. */
  solarPotential: {
    maxPanels: number | null;
    annualSunshineHours: number | null;
  };
  /** Vision analysis (separate from Solar's measurement). Rep-only
   *  fields (visibleDamage, secondaryStructures, siteObstacles,
   *  apparentAgeBand) drive the workbench's "site & condition notes"
   *  panel — they are NOT surfaced to the customer page. */
  geminiAnalysis: {
    facetCountEstimate: {
      count: number;
      complexity: "simple" | "moderate" | "complex";
      confidence: number;
    } | null;
    roofMaterial: { type: string; confidence: number } | null;
    conditionHints: Array<{ hint: string; confidence: number }>;
    visibleDamage: Array<{ kind: string; location_hint?: string; confidence: number }>;
    secondaryStructures: Array<{ kind: string; confidence: number }>;
    siteObstacles: Array<{ kind: string; confidence: number }>;
    apparentAgeBand: { band: string; confidence: number } | null;
  };
  modelVersion: string;
  computedAt: string;
}

/** V2 (legacy) response shape — retained for the existing test harness +
 *  any non-pin callers. The route gates on `pinConfirmed` to choose. */
export interface GeminiRoofResponse {
  measurements: RoofMeasurements;
  reconciliation: ReconciliationResult;
  imageryDate: string | null;
  imageryQuality: string | null;
  modelVersion: string;
  computedAt: string;
}

const PIN_TILE_ZOOM = 21; // Fixed zoom for pin-confirmed flow; building dominates frame
// Bumped 2026-05-18 — schema change: objects now use Google's native
// `box_2d` 0-1000 format instead of the prior `bounding_box` shape, so
// any pre-existing cached entries would deserialize wrong. Bumping the
// scope key forces a fresh painted call on every address. Also covers
// the temperature: 1.0 + mediaResolution HIGH + systemInstruction split
// changes from the same commit — any of those could produce a
// different output even at the same lat/lng.
// Bumped 2026-05-18 (round 2) — prompt now leads with "EDIT this
// image" + image-before-text order to fix the cyan-blob-on-black
// regression. Also fixed Solar slope-factor fallback for the
// `sloped<footprint` impossible-data case.
// Bumped 2026-05-18 — Pro Image now receives a per-request Solar
// segment-count hint that forces interior facet subdivisions. Prior
// cache entries lack that segmentation detail.
// Bumped 2026-05-18 — Flash facet-count prompt now uses per-face
// counting (EagleView-style) instead of per-wing counting. Cached
// "5–10 facets on Jupiter" entries from before this change are no
// longer correct — re-paint forces fresh per-face counts.
const CACHE_SCOPE_V3 = "gemini-roof-v3-per-face-facets";

/** Cheap text-only model used solely for object detection alongside
 *  the painted-image call. Pro Image is expensive ($0.075/call) and
 *  returns no text in multimodal mode — so we fan out a second call
 *  to gemini-2.5-flash (~$0.005) with structured JSON output for the
 *  vents/chimneys/skylights chips. */
const GEMINI_OBJECTS_MODEL = process.env.GEMINI_OBJECTS_MODEL ?? "gemini-2.5-flash";

const GEMINI_OBJECTS_PROMPT = `Analyze this 1280×1280 aerial satellite image of a residential property. The target building is centered at pixel (640, 640). Only consider the central building — ignore neighbors, yards, and ground objects (except for site_obstacles below).

Return eight fields. Per-field rules below. Confidence on every field is float 0.0–1.0 reflecting your ACTUAL certainty (1.0 = sure; 0.7–0.9 = typical confident observation; <0.5 = genuine uncertainty).

## 1. objects[] — physical rooftop fixtures
Identify every physical fixture sitting on the central building's roof. Return ONLY what you can clearly identify.

### Be conservative — false positives are worse than misses
Many residential roofs have ZERO penetrations besides one or two small plumbing vents along the ridge. A typical asphalt-shingle roof with no skylights, no chimney, and no HVAC on the roof should return objects: []. Returning fixtures that aren't really there leads to inflated repair quotes and bad-faith customer experiences. Better to miss a real vent than to invent one.

If you're not certain a feature is a physical 3D fixture, do NOT include it. Use confidence < 0.5 to mark uncertain detections — those are dropped downstream.

### Visual cues for each type (what they actually look like)
- **vent** — small circular or square cap, 6–12 inches across, white / galvanized / black metal. Has a clear sharp boundary and casts a small short shadow. Usually appears in groups of 1–4 along the ridge.
- **plumbing_boot** — similar size to vent but with a flexible black rubber collar at the base.
- **stack** — vertical pipe sticking up from the roof near the ridge (small; treat similarly to vent).
- **chimney** — tall masonry or metal rectangular structure with a clearly distinct surface (brick texture or metal panels), typically 2–6 ft wide on the long dimension, penetrates near the ridge, casts a long shadow.
- **hvac_unit** — large boxy unit ~3–5 ft on a side, usually on flat sections, often with visible grilles or fans. Almost never present on a residential pitched roof.
- **skylight** — clear / translucent rectangular panel, distinctly LIGHTER than surrounding shingles, often with reflective glare. Has a clear straight-edged rectangular outline. NOT just a lighter patch — must have a definite rectangle shape.
- **satellite_dish** — round / oval disc on a visible mount, distinctive curved shape with a clear shadow.
- **solar_panel** — dark rectangular array, multiple panels in a grid, blue / black surface that's distinctly different from shingle texture.

### Anti-patterns — these are NOT objects, do not detect them
- **Discolored shingle patches** — areas where shingles have weathered unevenly, granule loss patches, or staining. These have soft fuzzy edges, blend into surrounding shingles, and don't cast shadows. Skip.
- **Algae / moss streaks** — black or green vertical streaks running down a slope from the ridge. Skip (those are condition_hints, not objects).
- **Dirt / debris piles** — leaves, branches, debris on the roof. Skip (condition_hints).
- **Roof texture artifacts** — granule patterns, shingle seam shadows, ridge cap shadow lines. Skip.
- **Shadows cast by features** — the shadow of a skylight is NOT a skylight; the shadow of a chimney is NOT a chimney. Return the feature once; ignore the shadow.
- **Pixel-level satellite imagery noise** — compression artifacts, scan lines, sensor noise. Skip.

### Discrimination test
For each candidate, ask: "Does this have a CLEAR SHARP BOUNDARY, a UNIFORM SURFACE that's visibly different from shingles, and (if it's tall) a SHADOW that matches its expected height?" If all three answers are yes, include it. If any answer is "maybe," set confidence < 0.5. If two or more are no, skip it.

### Counting rules
- Each entry must correspond to a physical 3D object on the roof.
- A shadow cast by an object is NOT a separate object. Three skylights side by side = 3 entries, not 6.
- Skip objects under tree canopy (don't infer).
- A roof with zero visible penetrations should return objects: [] — that's a valid answer.

Per object: { type, center_pixel: [x, y], bounding_box: { x, y, width, height }, confidence }
Confidence: 1.0 = sure; 0.7–0.9 = typical confident; <0.5 = uncertain (will be filtered out).

## 2. facet_count_estimate — every visible triangular or trapezoidal face

A facet is a SINGLE triangular or trapezoidal roof surface bounded by ridge / hip / valley / eave / rake edges. **Each face counts separately, even when it shares a pitch with an adjacent face.** This matches how a professional roof measurement service (e.g. EagleView) reports facet count — per-face, not per-wing.

Targets by roof type (use these as calibration, not lower bounds):
- Simple front-back gable: **2 facets**
- Simple hip (square ranch): **4 facets** — N, S, E, W triangles meeting at the peak
- L-shaped gable: **4 facets** (2 per wing)
- Cross-hip (typical FL ranch): **8–12 facets** — each wing has its own 4 hip faces
- Cross-hip + dormers: **12–20 facets**
- Multi-wing hip + turret + porch: **20–40 facets**

**Key counting rules** — these are where most under-counts come from:
- A 4-sided hip roof has **FOUR facets** (the four triangle faces meeting at the apex), NOT ONE "hip wing"
- A hexagonal turret has **SIX facets**, not one cone
- An L-shaped house with two crossed hips has **EIGHT facets** (4 hips × 2 wings), NOT 2
- A gable with one dormer adds **3–4 facets** to the parent gable's 2 (front, back + dormer sides + dormer face)
- Eyebrow vents and small architectural pop-ups are separate facets
- Each side of a cross-hip valley is its own facet (the valley line separates two adjacent facets, doesn't merge them)

Do NOT count as separate facets:
- **Shadows cast on a face** by skylights, chimneys, dormers, ridges, or trees — same face with a dark patch, not a new face
- **Attached porches / carports with a visibly shallower separate roof** — those are separate structures and don't count
- **Two halves of the same rectangular plane** divided by a shingle-color seam — still one face

Classification (recalibrated for per-face counting):
- **simple**: 2–8 facets (gable, simple hip, L-shape)
- **moderate**: 9–20 facets (cross-hip, multi-wing, single dormer cluster)
- **complex**: 21+ facets (multi-wing hip with turret, dormer cluster, attached additions)

Return: { count, complexity, confidence }

## 3. roof_material — predominant covering
Choose the SINGLE most likely material. asphalt_shingle_architectural is the FL residential default unless you see clear evidence of another.

Visual cues:
- **asphalt_shingle_3tab** — uniform thin shingles, often gray, distinctive 3-tab pattern visible
- **asphalt_shingle_architectural** — thicker dimensional shingles, varied granule pattern, slight shadow lines between courses
- **concrete_tile** — uniform rectangular tiles in rows, often gray or earth-toned
- **clay_tile_barrel** — half-cylinder S-curve tiles, distinctive ripple pattern, often terracotta / red
- **clay_tile_flat** — flat rectangular clay tiles, terracotta colored
- **metal_standing_seam** — long parallel vertical seams every 12–24 inches, shiny or matte metal
- **metal_corrugated** — ribbed metal with regular wavy texture
- **wood_shake** — irregular brown wood pieces in varied widths
- **slate** — dark gray / black tiles, often irregular sizes
- **membrane_flat** — smooth flat surface (TPO / EPDM), often gray or white, no shingle pattern
- **unknown** — only when imagery is too poor to tell

Return: { type, confidence }

## 4. condition_hints[] — discrete visible signs of wear
List ONLY observable features. Empty array is valid (and correct when the roof is intact). Use uniform_clean only when the entire roof has no notable issues.

Allowed hints: moss_or_algae, dark_streaking, shingle_wear_granule_loss, missing_tabs, patches_or_repairs, tarp_visible, ponding_water, tree_debris, rust_staining, uniform_clean

Per hint: { hint, confidence }

## 5. visible_damage[] — discrete damage observations
Each entry is ONE observation. Include only what you can SEE. Empty array is correct for healthy roofs.

Allowed kinds: lifted_shingles, missing_shingles, exposed_underlayment, ridge_cap_lifting, visible_sagging, displaced_tiles, blistering, hail_bruising_pattern, wind_streak_pattern, patched_area

Per damage: { kind, location_hint?: "north slope" / "ridge near chimney" / etc, confidence }

## 6. secondary_structures[] — attached, continuous additions
List ATTACHED additions whose roof plane is visibly CONTINUOUS with the main house (same pitch, same shingles, no horizontal seam at the wall).

Allowed kinds: attached_garage, attached_carport, screened_lanai, covered_porch, sunroom, addition_wing, shed_attached

Skip detached structures and porches with their own visibly shallower roofs (those are separate structures, not additions).

Per structure: { kind, confidence }

## 7. site_obstacles[] — crew access / staging concerns
Surrounding features that would affect a roofing crew's access, dumpster staging, or material delivery.

Allowed kinds: heavy_tree_overhang, overhead_utility_wires, pool_adjacent, narrow_side_yard, fenced_property, shared_driveway, steep_grade

Per obstacle: { kind, confidence }

## 8. apparent_age_band — rough age guess
One band based on overall appearance (granule coverage uniformity, color uniformity, visible weathering). Rough banding, not a precise age.

- new_under_5y — uniform sharp color, no streaking, clean granules
- mid_5_to_15y — minor weathering, slightly faded color, no major issues
- mature_15_to_25y — visible weathering, color variation, possible minor wear
- end_of_life_25y_plus — heavy wear, granule loss, severely faded color
- indeterminate — imagery too poor or roof too obscured

Return: { band, confidence }`;

// ─── Gemini line-detection sidecar (third Flash call) ──────────────────
//
// Solar's per-facet edge classification works well on HIGH imagery but
// misses ~30-50% of edges on MEDIUM/LOW (Solar only returns 6 segments
// for Jupiter's actual 34-facet roof — most ridges/hips are hidden in
// the segment-union boundary). This sidecar asks Gemini to find every
// visible roof line and classify it directly from the image. The math
// layer converts pixel → lat/lng → linear feet with slope correction.
//
// Output is OPTIONAL on the V3 response — when populated it's a
// second-opinion overlay against Solar's geometric classification.

const GEMINI_LINES_MODEL = "gemini-2.5-flash";

const GEMINI_LINES_PROMPT = `Trace every visible roof edge on the central building in this 1280×1280 aerial satellite image (centered at pixel 640, 640).

You are doing comprehensive perimeter + interior edge classification. Coverage is the success metric — UNDER-TRACING IS THE FAILURE MODE.

## The five edge types
- **ridge** — HIGHEST horizontal line where two opposing slopes meet at the peak
- **hip** — sloped diagonal from a peak corner down to a building corner (hip roofs only; gable roofs have zero)
- **valley** — sloped inward-V where two pitched planes meet (dormers, intersecting wings)
- **rake** — sloped open-gable edge where the roof drops to air on one side
- **eave** — HORIZONTAL outer perimeter at the BOTTOM of each slope, where the roof meets the gutter

## Expected coverage
Every house has eaves. Every pitched roof has at least one ridge or one set of hips.

| Roof shape | Typical edge mix | Total |
|------------|-----------------|-------|
| Simple gable | 1 ridge + 2 long eaves + 4 rakes | 7 |
| Simple hip | 4 hips + 4 eaves | 8 |
| Cross-gable | 2+ ridges + 4–6 eaves + 4–8 rakes | 10–16 |
| Hip + dormer | 4 hips + 4 eaves + 1–2 valleys + 1–2 small ridges per dormer | 10–14 |

If you return zero eaves, you are wrong — re-examine. Every visible roof has visible eaves.
If you return zero ridges AND zero hips, you are wrong — every pitched roof has at least one of those.

## Self-consistency rule
Eaves and rakes ALTERNATE around the perimeter of a rectangular house. The perimeter pattern is eave → rake → eave → rake → eave → rake → eave → rake (back to start). If you returned 4 rakes and 0 eaves, OR 4 eaves and 0 rakes, you are wrong.

## Classification — pick by orientation + position
| Line position + orientation | Type |
|-----------------------------|------|
| Horizontal, at the BOTTOM of a slope (meets gutter / open air below) | **eave** |
| Horizontal, at the TOP of two opposing slopes (highest point) | **ridge** |
| Sloped, peak corner → building corner | **hip** |
| Sloped, inward V between two slopes | **valley** |
| Sloped, on the open side of a gable (roof drops to a wall + air) | **rake** |

## Rules
1. Return EVERY visible edge. Aim for completeness.
2. A line is a STRAIGHT segment between two pixel endpoints. For curves or steps, return multiple short segments.
3. Coordinates are pixel space (0–1279), origin top-left.
4. Only the central building. Skip neighbors, ground, vegetation.

## Output
Per line: { type, start_pixel: [x, y], end_pixel: [x, y], confidence: 0.0–1.0 }

Confidence reflects how clearly you can see and classify each line.`;

const GEMINI_LINES_SCHEMA = {
  type: "OBJECT",
  properties: {
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: {
            type: "STRING",
            enum: ["ridge", "hip", "valley", "rake", "eave"],
          },
          start_pixel: { type: "ARRAY", items: { type: "NUMBER" } },
          end_pixel: { type: "ARRAY", items: { type: "NUMBER" } },
          confidence: { type: "NUMBER", description: "Float 0.0–1.0" },
        },
        required: ["type", "start_pixel", "end_pixel", "confidence"],
      },
    },
    /** Facet count derived from this image. On the painted-pass call,
     *  this is much more reliable than the rich-data raw-tile pass
     *  because each facet is rendered as a discrete cyan polygon —
     *  counting polygons beats counting "distinct roof planes in
     *  satellite imagery" by a wide margin. */
    facet_count: {
      type: "OBJECT",
      properties: {
        count: { type: "INTEGER" },
        complexity: {
          type: "STRING",
          enum: ["simple", "moderate", "complex"],
        },
        confidence: { type: "NUMBER", description: "Float 0.0–1.0" },
      },
      required: ["count", "complexity", "confidence"],
    },
  },
  required: ["lines"],
} as const;

interface GeminiLineDetection {
  type: "ridge" | "hip" | "valley" | "rake" | "eave";
  start_pixel: [number, number];
  end_pixel: [number, number];
  confidence: number;
}

interface GeminiFacetCount {
  count: number;
  complexity: "simple" | "moderate" | "complex";
  confidence: number;
}

/** Second-pass prompt: classify cyan strokes already drawn on the
 *  painted image. Way more reliable than tracing raw satellite, because
 *  the Pro Image pass already did the hard "is this a roof edge"
 *  decision and marked it with cyan paint. Flash just identifies +
 *  classifies what's already visually highlighted. */
const GEMINI_LINES_FROM_PAINTED_PROMPT = `This image is an aerial roof with cyan strokes drawn on every legal edge by a prior model pass. Your job: (a) enumerate and classify every cyan line, AND (b) count the discrete cyan polygons that make up the roof.

The cyan IS the ground truth. You don't detect edges from scratch — you read what the painting already shows.

## PART A — Lines

### Two kinds of cyan to find
1. **Outer perimeter cyan** — every segment around the outside of the painted region. Each segment is an eave, rake, or gable end.
2. **Interior cyan** — thin strokes drawn inside the painted region. These are ridges, hips, or valleys where two planes meet.

### Classification cheat sheet
| Cyan line position + orientation | Type |
|----------------------------------|------|
| Horizontal, at the TOP boundary between two painted regions | **ridge** |
| Horizontal, on the BOTTOM outer perimeter | **eave** |
| Sloped diagonal, peak point → building corner | **hip** |
| Sloped inward V between two painted regions | **valley** |
| Sloped, on the open side of a gable (perimeter line that drops diagonally) | **rake** |

### Rules
1. Return EVERY visible cyan line. If you see a cyan line, you MUST return it.
2. Classify by geometric role (orientation + position), not by what you'd guess from the underlying image.
3. A line is a STRAIGHT segment between two pixel endpoints. Curves or steps → multiple short segments.
4. Coordinates are pixel space (0–1279), origin top-left.
5. Only the central building's cyan markup. Ignore any incidental cyan on neighbors.
6. A typical home has 6–14 cyan lines total.

## PART B — Facet count

Count the number of DISTINCT CYAN POLYGONS that make up the painted roof. Each facet (roof plane) is rendered as one continuous painted region.

### How to count
- **Two regions share a thin cyan stroke between them** (a ridge, hip, or valley line interior to the painted area) → that's TWO facets, even though the cyan is continuous in color.
- **One region with NO interior cyan strokes dividing it** → ONE facet.
- **Dark shadow patches inside a single painted region** (skylight shadows, chimney shadows, tree shadows on the roof) → still ONE facet. Shadows don't divide planes; only interior cyan strokes do.
- **Two regions that are physically separated by uncolored space** (e.g. a porch with its own roof not painted) → only count the painted regions as facets of the central roof. Don't count what isn't painted.

### Common counts
- Simple gable: **2 facets** (front + back, separated by one ridge stroke)
- Simple hip: **4 facets** (separated by 4 hip strokes meeting at a peak)
- L-shaped house: **4–6 facets**
- Cross-gable: **4+ facets**
- Hip with dormers: **6–10 facets**
- Complex multi-wing hip: **10+ facets**

### Failure modes to avoid
- Don't double-count shadow patches as facets. If a single rectangle of cyan has three dark triangular shadows inside it, the answer is ONE facet, not four.
- Don't count vents, skylights, or chimney footprints as facets — those are penetrations, not planes.
- Don't undercount by treating connected painted regions as one when they have an interior ridge / hip / valley stroke between them.

### Complexity classification
- **simple**: 2–4 facets
- **moderate**: 5–10 facets
- **complex**: 11+ facets

## Output
{
  lines: [{ type, start_pixel: [x, y], end_pixel: [x, y], confidence }, …],
  facet_count: { count, complexity, confidence }
}

Coverage on lines + accurate facet count are both required. Under-tracing on lines is the dominant failure mode there; over-counting facets (counting shadows as planes) is the dominant failure mode there. Be careful with both.`;

async function callGeminiLines(
  tileBase64: string,
  apiKey: string,
  promptOverride?: string,
): Promise<{ lines: GeminiLineDetection[]; facetCount: GeminiFacetCount | null }> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_LINES_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    // promptOverride wins for the systemInstruction when a caller wants
    // to ask Gemini for a different line set (e.g. only valleys, only
    // rakes) — otherwise the default lines prompt applies.
    systemInstruction: {
      parts: [{ text: promptOverride ?? GEMINI_LINES_PROMPT }],
    },
    contents: [
      {
        parts: [
          { inline_data: { mime_type: "image/png", data: tileBase64 } },
          {
            text:
              "Based on the aerial image above, return a JSON object " +
              "with a `lines` array — one entry per visible roof line.",
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 1.0,
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
      responseMimeType: "application/json",
      responseSchema: GEMINI_LINES_SCHEMA,
    },
  };
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gemini_lines_${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.warn("[gemini-lines] no_text_in_response");
    return { lines: [], facetCount: null };
  }
  try {
    const parsed = JSON.parse(text) as {
      lines?: GeminiLineDetection[];
      facet_count?: GeminiFacetCount;
    };
    const lines = parsed.lines ?? [];
    const facetCount = parsed.facet_count ?? null;
    // Per-type observability so we can spot under-trace failures in
    // production without re-running with debug=1. Healthy roofs return
    // at least 1 ridge + 2 eaves + 2–4 rakes-or-hips.
    const byType = lines.reduce<Record<string, number>>((acc, l) => {
      acc[l.type] = (acc[l.type] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `[gemini-lines] total=${lines.length} ` +
        `ridges=${byType.ridge ?? 0} hips=${byType.hip ?? 0} ` +
        `valleys=${byType.valley ?? 0} rakes=${byType.rake ?? 0} ` +
        `eaves=${byType.eave ?? 0}` +
        (facetCount ? ` · facets=${facetCount.count} (${facetCount.complexity})` : ""),
    );
    if ((byType.eave ?? 0) === 0 || (byType.ridge ?? 0) + (byType.hip ?? 0) === 0) {
      console.warn(
        "[gemini-lines] under-trace_detected — missing eaves and/or ridges/hips. " +
          "Customer page falls back to Solar classifier which often misfires " +
          "as all-rakes on simple gables; consider re-running with the painted " +
          "image as input for a stronger signal.",
      );
    }
    return { lines, facetCount };
  } catch (err) {
    console.warn(
      "[gemini-lines] parse_failed",
      err instanceof Error ? err.message : String(err),
    );
    return { lines: [], facetCount: null };
  }
}

/**
 * Pixel-space line segment → linear feet using the tile's GSD + slope
 * correction. Ridge + eave are horizontal in 3D so projected length
 * equals true length. Hip/valley/rake are sloped — multiply by
 * (1 / cos(avgPitch)) so the measurement reflects the diagonal run.
 */
function gemLineLengthFt(
  startPx: [number, number],
  endPx: [number, number],
  mPerPx: number,
  avgPitchDeg: number | null,
  isSloped: boolean,
): number {
  const dx = endPx[0] - startPx[0];
  const dy = endPx[1] - startPx[1];
  const runPx = Math.hypot(dx, dy);
  const runM = runPx * mPerPx;
  const runFt = runM * 3.28084;
  if (isSloped && avgPitchDeg != null && avgPitchDeg > 0 && avgPitchDeg < 80) {
    return runFt / Math.cos((avgPitchDeg * Math.PI) / 180);
  }
  return runFt;
}

interface GeminiRichDataResult {
  objects: GeminiMultimodalResult["objects"];
  facetCountEstimate: {
    count: number;
    complexity: "simple" | "moderate" | "complex";
    confidence: number;
  } | null;
  roofMaterial: { type: string; confidence: number } | null;
  conditionHints: Array<{ hint: string; confidence: number }>;
  /** Discrete visible-damage observations — surfaced to the rep workbench
   *  only (not the customer page). */
  visibleDamage: Array<{ kind: string; location_hint?: string; confidence: number }>;
  /** Attached additions whose roof plane is continuous with the main house. */
  secondaryStructures: Array<{ kind: string; confidence: number }>;
  /** Surrounding-site features that affect crew access or staging. */
  siteObstacles: Array<{ kind: string; confidence: number }>;
  /** Rough age banding from visible weathering. */
  apparentAgeBand: { band: string; confidence: number } | null;
  /** Raw text returned by Gemini. Surfaced for the ?debug=1 path so the
   *  route can echo what the model actually emitted. */
  rawText: string | null;
}

async function callGeminiRichData(
  tileBase64: string,
  apiKey: string,
): Promise<GeminiRichDataResult> {
  const empty: GeminiRichDataResult = {
    objects: [],
    facetCountEstimate: null,
    roofMaterial: null,
    conditionHints: [],
    visibleDamage: [],
    secondaryStructures: [],
    siteObstacles: [],
    apparentAgeBand: null,
    rawText: null,
  };
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_OBJECTS_MODEL}:generateContent?key=${apiKey}`;
  // Use the broader schema from lib/gemini-roof-prompt.ts which covers
  // objects + facets + material + condition.
  const body = {
    systemInstruction: { parts: [{ text: GEMINI_OBJECTS_PROMPT }] },
    contents: [
      {
        parts: [
          { inline_data: { mime_type: "image/png", data: tileBase64 } },
          {
            text:
              "Based on the aerial image above, return the JSON object " +
              "matching the response schema — objects, facet count, " +
              "material, condition, damage, additions, obstacles, age band.",
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 1.0,
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
      responseMimeType: "application/json",
      responseSchema: GEMINI_ROOF_SCHEMA,
    },
  };
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gemini_rich_${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.warn("[gemini-rich] no_text_in_response");
    return empty;
  }
  try {
    const parsed = JSON.parse(text) as {
      objects?: GeminiMultimodalResult["objects"];
      facet_count_estimate?: GeminiRichDataResult["facetCountEstimate"];
      roof_material?: GeminiRichDataResult["roofMaterial"];
      condition_hints?: GeminiRichDataResult["conditionHints"];
      visible_damage?: GeminiRichDataResult["visibleDamage"];
      secondary_structures?: GeminiRichDataResult["secondaryStructures"];
      site_obstacles?: GeminiRichDataResult["siteObstacles"];
      apparent_age_band?: GeminiRichDataResult["apparentAgeBand"];
    };
    console.log(
      `[gemini-rich] parsed objects=${parsed.objects?.length ?? 0} ` +
        `facetEst=${parsed.facet_count_estimate ? "yes" : "no"} ` +
        `material=${parsed.roof_material ? parsed.roof_material.type : "no"} ` +
        `hints=${parsed.condition_hints?.length ?? 0} ` +
        `damage=${parsed.visible_damage?.length ?? 0} ` +
        `addons=${parsed.secondary_structures?.length ?? 0} ` +
        `obstacles=${parsed.site_obstacles?.length ?? 0} ` +
        `age=${parsed.apparent_age_band?.band ?? "no"}`,
    );
    return {
      objects: parsed.objects ?? [],
      facetCountEstimate: parsed.facet_count_estimate ?? null,
      roofMaterial: parsed.roof_material ?? null,
      conditionHints: parsed.condition_hints ?? [],
      visibleDamage: parsed.visible_damage ?? [],
      secondaryStructures: parsed.secondary_structures ?? [],
      siteObstacles: parsed.site_obstacles ?? [],
      apparentAgeBand: parsed.apparent_age_band ?? null,
      rawText: text,
    };
  } catch (err) {
    console.warn(
      "[gemini-rich] parse_failed",
      err instanceof Error ? err.message : String(err),
      `text_preview=${text.slice(0, 200)}`,
    );
    return { ...empty, rawText: text };
  }
}

/**
 * Persists the V3 result to leads.roof_v3_json so the rep workbench
 * can render "See report" instantly. Painted image (base64) is moved
 * to Supabase Storage; the row carries the URL plus the structured
 * summary. Mirrors the shape /api/leads/[publicId]/roof-v3 produces
 * so downstream readers don't care which path filled the row.
 *
 * Best-effort — wrapped in waitUntil() by the caller. Any failure
 * logs and silently no-ops; the customer doesn't see persistence
 * errors.
 */
async function persistEstimateToLead(
  leadPublicId: string,
  result: GeminiRoofResponseV3,
): Promise<void> {
  if (!supabaseServiceRoleConfigured()) return;
  const supabase = createServiceRoleClient();

  // Upload painted PNG to Storage so the JSON row stays small.
  //
  // The `painted-roofs` bucket should be PRIVATE — earlier versions
  // emitted a public URL, which meant anyone who learned a publicId
  // (lead_<32-hex>) could pull customer-property imagery anonymously.
  // Audit (2026-05) flagged this. Switch to a signed URL with a short
  // TTL; the rep workbench renews on demand, and customer-facing share
  // pages should fetch via a server route that re-signs per request.
  //
  // Migration note: bucket needs to be marked Private in Supabase
  // Studio (or via SQL: update storage.buckets set public=false where
  // id='painted-roofs'). Until that flips, getPublicUrl + signed URL
  // both work; once flipped, only signed URLs work.
  let paintedUrl: string | null = null;
  if (result.paintedImageBase64) {
    // Validate PNG magic-bytes + size cap even though the base64 here
    // is server-produced. Cheap insurance against a future code path
    // where this base64 turns out to be client-influenced.
    const validated = validatePaintedPngBase64(result.paintedImageBase64);
    if (!validated.ok) {
      console.warn(
        `[gemini-roof v3] painted_upload_rejected reason=${validated.reason}`,
      );
    } else {
      try {
        const objectKey = `${leadPublicId}.png`;
        const up = await supabase.storage
          .from("painted-roofs")
          .upload(objectKey, validated.bytes, {
            contentType: "image/png",
            upsert: true,
          });
        if (!up.error) {
          // 7-day signed URL — long enough for the rep workbench's
          // typical follow-up window without standing up a re-signer
          // route. Customer-facing share pages should re-sign per
          // request via a server handler (TODO once /p/<id> returns).
          const { data: signed, error: signErr } = await supabase.storage
            .from("painted-roofs")
            .createSignedUrl(objectKey, 60 * 60 * 24 * 7);
          if (signed?.signedUrl) {
            paintedUrl = signed.signedUrl;
          } else {
            console.warn(
              "[gemini-roof v3] painted_signed_url_failed",
              signErr?.message ?? "unknown",
            );
          }
        } else {
          console.warn(
            "[gemini-roof v3] painted_upload_failed",
            up.error.message,
          );
        }
      } catch (err) {
        console.warn(
          "[gemini-roof v3] painted_upload_threw",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  const { paintedImageBase64: _drop, ...rest } = result;
  void _drop;
  const roofV3Json = {
    ...rest,
    painted_url: paintedUrl,
    generated_at: new Date().toISOString(),
    generated_via: "customer-flow",
  } as unknown as Json;

  // Defense-in-depth: look up the lead's office_id first and include
  // it in the update predicate. Service-role bypasses RLS, so omitting
  // office_id would let a malformed publicId match across tenants.
  // PublicId entropy makes that practically infeasible today, but the
  // invariant documented in lib/supabase.ts says "Always tag office_id".
  const { data: priorLead } = await supabase
    .from("leads")
    .select("office_id")
    .eq("public_id", leadPublicId)
    .maybeSingle();
  if (!priorLead) {
    console.warn(
      `[gemini-roof v3] persist_skipped lead_not_found publicId=${leadPublicId}`,
    );
    return;
  }

  const { error } = await supabase
    .from("leads")
    .update({ roof_v3_json: roofV3Json })
    .eq("public_id", leadPublicId)
    .eq("office_id", priorLead.office_id);
  if (error) {
    console.warn(
      "[gemini-roof v3] lead_update_failed",
      error.message,
      `publicId=${leadPublicId}`,
    );
    return;
  }
  console.log(
    `[gemini-roof v3] persisted_to_lead publicId=${leadPublicId} painted=${paintedUrl ? "yes" : "no"}`,
  );
}

/**
 * V3 handler — pin-confirmed customer flow ("the holy grail").
 *
 * The customer has dragged a pin onto the center of their roof. We:
 *   1. Refetch a Google Static Maps tile centered EXACTLY on the pin
 *      at fixed zoom 21 (1280×1280 px after scale=2).
 *   2. Call Solar API in parallel for measurement data.
 *   3. Call Gemini in multimodal mode — returns a cyan-painted version
 *      of the tile + JSON of rooftop objects.
 *   4. Return: painted image + Solar measurements + objects.
 *
 * No reconciliation, no Solar-bbox recentering, no centroid drift
 * tolerance — the pin IS the source of truth.
 */
async function handleV3Pinned(
  lat: number,
  lng: number,
  skipCache: boolean,
  debug: boolean = false,
  leadPublicId: string | null = null,
): Promise<NextResponse> {
  if (!skipCache) {
    const cached = await getCached<GeminiRoofResponseV3>(CACHE_SCOPE_V3, lat, lng);
    if (cached) return NextResponse.json(cached);
  }

  const googleKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!googleKey) {
    return NextResponse.json({ error: "missing_google_key" }, { status: 503 });
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return NextResponse.json({ error: "missing_gemini_key" }, { status: 503 });
  }

  // Post-call accounting — track cost AT pipeline entry rather than
  // per-call, so a partial failure still bills the budget for whatever
  // Gemini we did consume. Conservative: assume one paint + one Flash +
  // one Solar fanout on every V3 entry that misses cache.
  void trackAiSpend(
    AI_CALL_COST_USD.gemini_pro_image_paint +
      AI_CALL_COST_USD.gemini_flash_json +
      AI_CALL_COST_USD.solar_findclosest,
    `gemini-roof-v3 lat=${lat.toFixed(4)} lng=${lng.toFixed(4)}`,
  );

  // Pin = tile center. Fixed zoom 21. No Solar recentering.
  const [tile, solar] = await Promise.all([
    fetchGoogleStaticTile(lat, lng, googleKey, PIN_TILE_ZOOM),
    callSolar(lat, lng, googleKey),
  ]);

  // Pipeline architecture:
  //   - Multimodal paint (Pro Image, ~25–50s) — the cyan overlay.
  //     THIS PROMPT IS LOCKED. It's not hallucinating and the visual
  //     wow factor is critical. Do not modify GEMINI_ROOF_PROMPT
  //     unless objects are misbehaving again.
  //   - Rich-data Flash (~8–15s) runs IN PARALLEL — free latency
  //     since paint dominates total wall clock. Provides facet count
  //     correction (Solar undercounts on some imagery), penetration
  //     objects (vents, skylights, chimneys), roof material guess.
  //     Strict confidence floor 0.60 to prevent the "4 skylights, 3
  //     vents on a clean roof" hallucinations seen before.
  //   - Line-trace Flash calls REMAIN REMOVED — edge LFs from those
  //     never aligned with EagleView and weren't shown to the customer.
  //
  // Two-call parallel mode keeps total latency ≈ paint latency (the
  // user's hard constraint of < 45s) while restoring the data points
  // the rep workbench needs.
  let paintedImageBase64: string | null = null;
  let objects: GeminiRoofResponseV3["objects"] = [];
  let geminiAnalysis: GeminiRoofResponseV3["geminiAnalysis"] = {
    facetCountEstimate: null,
    roofMaterial: null,
    conditionHints: [],
    visibleDamage: [],
    secondaryStructures: [],
    siteObstacles: [],
    apparentAgeBand: null,
  };
  let geminiRawText: string | null = null;
  let geminiRichErr: string | null = null;
  // Three-call parallel block — total wall clock = max(paint) ≈ 25–30s.
  //   - Pro Image paint (slowest)
  //   - Flash rich-data (objects + facet count + material)
  //   - Flash lines-on-raw (eaves / ridges / valleys / rakes / hips
  //     from the RAW satellite tile). Flash 2.5 has been trained on
  //     aerial imagery and can identify real roof geometry directly.
  //     This is the fallback if the painted-pass below returns empty
  //     lines (the painted-pass strokes can get absorbed into the
  //     translucent cyan fill on some roofs — observed on Newcomb).
  // Pull Solar's segment count BEFORE firing Pro Image so we can inject
  // it as a "minimum facets" hint. Solar's already resolved at this
  // point (it ran in parallel with the tile fetch), so this is a free
  // synchronous read. On Jupiter's hip-and-turret composition Solar
  // returns ~5 distinct shingle segments. Without this hint Pro Image
  // visually merged adjacent same-pitch hips into one big polygon.
  const solarSegmentsForHint =
    solar?.solarPotential?.roofSegmentStats?.length ?? null;
  const [paintedResult, richResult, rawLinesResult] = await Promise.allSettled([
    callGeminiMultimodal(tile.base64, geminiKey, solarSegmentsForHint),
    callGeminiRichData(tile.base64, geminiKey),
    callGeminiLines(tile.base64, geminiKey),
  ]);

  if (paintedResult.status === "fulfilled") {
    paintedImageBase64 = paintedResult.value.paintedImageBase64;
  } else {
    console.warn(
      "[gemini-roof v3] painted_call_failed",
      paintedResult.reason instanceof Error
        ? paintedResult.reason.message
        : String(paintedResult.reason),
    );
  }

  if (richResult.status === "fulfilled") {
    const rich = richResult.value;
    // Strict 0.60 confidence floor — anything below is likely a
    // shingle smudge, weathering patch, or shadow blob being read as
    // a fixture. Calibrated after the "4 skylights, 3 vents" case
    // landed on a roof with only one of each.
    const OBJECT_CONFIDENCE_FLOOR = 0.60;
    const rawObjectCount = rich.objects.length;
    const kept = rich.objects.filter(
      (o) =>
        typeof o.confidence === "number" &&
        o.confidence >= OBJECT_CONFIDENCE_FLOOR,
    );
    if (rawObjectCount !== kept.length) {
      console.log(
        `[gemini-roof v3] objects_filtered ` +
          `raw=${rawObjectCount} kept=${kept.length} ` +
          `dropped=${rawObjectCount - kept.length} (confidence<${OBJECT_CONFIDENCE_FLOOR})`,
      );
    }
    objects = kept.map((o) => {
      // box_2d → pixel coords via Google's documented descale step.
      const { centerPx, bboxPx } = box2dToPx(o.box_2d);
      return {
        type: o.type,
        centerPx,
        bboxPx,
        confidence: o.confidence,
      };
    });
    geminiAnalysis = {
      facetCountEstimate: rich.facetCountEstimate,
      roofMaterial: rich.roofMaterial,
      conditionHints: rich.conditionHints,
      visibleDamage: rich.visibleDamage,
      secondaryStructures: rich.secondaryStructures,
      siteObstacles: rich.siteObstacles,
      apparentAgeBand: rich.apparentAgeBand,
    };
    geminiRawText = rich.rawText;
  } else {
    geminiRichErr =
      richResult.reason instanceof Error
        ? `${richResult.reason.name}: ${richResult.reason.message}`
        : String(richResult.reason);
    console.warn("[gemini-roof v3] rich_data_call_failed", geminiRichErr);
  }

  // ─── Edge / line source selection ──────────────────────────────────
  //
  // Two candidate sources:
  //   A. RAW-tile lines pass (ran in parallel above) — Flash on satellite
  //   B. PAINTED-tile lines pass (serial below) — Flash on cyan overlay
  //
  // Prefer painted when it has BOTH eaves AND ridges/hips (means the
  // strokes were prominent enough); otherwise fall back to raw. Both
  // outputs use the same schema so the selection is trivial.
  let rawLinesValue: GeminiLineDetection[] = [];
  let rawFacetCount: GeminiFacetCount | null = null;
  if (rawLinesResult.status === "fulfilled") {
    rawLinesValue = rawLinesResult.value.lines;
    rawFacetCount = rawLinesResult.value.facetCount;
  } else {
    console.warn(
      "[gemini-roof v3] raw_lines_call_failed",
      rawLinesResult.reason instanceof Error
        ? rawLinesResult.reason.message
        : String(rawLinesResult.reason),
    );
  }

  let paintedLinesValue: GeminiLineDetection[] = [];
  let paintedFacetCount: GeminiFacetCount | null = null;
  if (paintedImageBase64) {
    try {
      const lr = await callGeminiLines(
        paintedImageBase64,
        geminiKey,
        GEMINI_LINES_FROM_PAINTED_PROMPT,
      );
      paintedLinesValue = lr.lines;
      paintedFacetCount = lr.facetCount;
      console.log(
        `[gemini-roof v3] painted_lines lines=${lr.lines.length} ` +
          `facets=${lr.facetCount?.count ?? "null"} ${lr.facetCount?.complexity ?? ""}`,
      );
    } catch (err) {
      console.warn(
        "[gemini-roof v3] painted_lines_call_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Selection rule — painted wins if it has the canonical mix of eaves
  // AND ridges/hips. Otherwise raw wins (it's the more reliable source
  // on roofs where Pro Image's strokes are subtle).
  const paintedByType = paintedLinesValue.reduce<Record<string, number>>(
    (acc, l) => { acc[l.type] = (acc[l.type] ?? 0) + 1; return acc; },
    {},
  );
  const paintedHasCanonical =
    (paintedByType.eave ?? 0) > 0 &&
    ((paintedByType.ridge ?? 0) + (paintedByType.hip ?? 0)) > 0;
  let linesValue: GeminiLineDetection[] | null = null;
  if (paintedHasCanonical) {
    linesValue = paintedLinesValue;
    console.log(
      `[gemini-roof v3] line_source=painted ` +
        `(painted=${paintedLinesValue.length} raw=${rawLinesValue.length})`,
    );
  } else if (rawLinesValue.length > 0) {
    linesValue = rawLinesValue;
    console.log(
      `[gemini-roof v3] line_source=raw ` +
        `(painted=${paintedLinesValue.length} under-traced, raw=${rawLinesValue.length})`,
    );
  } else if (paintedLinesValue.length > 0) {
    linesValue = paintedLinesValue;
    console.log(
      `[gemini-roof v3] line_source=painted_partial ` +
        `(painted=${paintedLinesValue.length} no canonical mix, raw=0)`,
    );
  }

  // Facet count source — painted is canonical when > 0, else raw lines
  // facet_count, else rich-data raw-tile estimate. Always prefer
  // visually-grounded counts over the raw-tile rich-data pass which
  // tends to over-count shadow patches as separate planes.

  const canonicalFacetCount =
    (paintedFacetCount && paintedFacetCount.count > 0 ? paintedFacetCount : null) ??
    (rawFacetCount && rawFacetCount.count > 0 ? rawFacetCount : null);
  if (canonicalFacetCount) {
    geminiAnalysis = {
      ...geminiAnalysis,
      facetCountEstimate: canonicalFacetCount,
    };
  }

  console.log(
    `[gemini-roof v3] pinned (${lat.toFixed(5)},${lng.toFixed(5)}) ` +
      `painted=${paintedImageBase64 ? "yes" : "no"} ` +
      `objects=${objects.length} ` +
      `facets_canonical=${geminiAnalysis.facetCountEstimate?.count ?? "null"} ` +
      `lines=${linesValue?.length ?? 0}`,
  );

  // Filter out flat / near-flat Solar segments before summing sqft.
  //
  // Solar's photogrammetric model treats attached flat planes as
  // legitimate roof segments — pool cages / screen enclosures, lanai
  // covers, attached pergolas, carport awnings. None of those get
  // shingled (they need TPO or modified bitumen if anything at all),
  // and including them inflates the customer-visible price by 20-40%
  // on homes with a big pool overhang.
  //
  // Threshold of 5° (≈ 1/12 pitch) cleanly separates real shingled
  // roof (4/12 = 18° and steeper) from screen/lanai planes (0-3°).
  // Modern flat-roof homes (rare in FL) would be filtered too — but
  // those need a different product anyway, so the shingles estimator
  // declining to quote them is the right behavior.
  // 12° (~ 2.5/12) — Florida residential shingles are 4/12 (18.4°)
  // minimum; anything below is a lanai / pool cage / patio cover /
  // pergola / carport awning, none of which get re-shingled. Earlier
  // 5° and 8° thresholds were too generous and let pool overhangs
  // slip through, inflating sqft (and price) by 30–50% on homes with
  // big screen enclosures. The 4/12 minimum is a hard FL code +
  // manufacturer-warranty constraint so 12° is safely below the
  // legitimate-shingle floor.
  const SHINGLE_MIN_PITCH_DEG = 12;
  const allSegments = solar?.solarPotential?.roofSegmentStats ?? [];
  const shingleSegments = allSegments.filter(
    (seg) => (seg.pitchDegrees ?? 0) >= SHINGLE_MIN_PITCH_DEG,
  );
  const excludedSegments = allSegments.length - shingleSegments.length;
  const excludedM2 = allSegments
    .filter((seg) => (seg.pitchDegrees ?? 0) < SHINGLE_MIN_PITCH_DEG)
    .reduce((s, seg) => s + (seg.stats?.areaMeters2 ?? 0), 0);

  const totalSlopedM2 = shingleSegments.reduce(
    (s, seg) => s + (seg.stats?.areaMeters2 ?? 0),
    0,
  );
  const totalFootprintM2 =
    solar?.solarPotential?.wholeRoofStats?.groundAreaMeters2 ?? 0;
  const avgPitchDeg = (() => {
    if (shingleSegments.length === 0 || totalSlopedM2 === 0) return null;
    return (
      shingleSegments.reduce(
        (s, seg) => s + (seg.pitchDegrees ?? 0) * (seg.stats?.areaMeters2 ?? 0),
        0,
      ) / totalSlopedM2
    );
  })();

  if (excludedSegments > 0) {
    console.log(
      `[gemini-roof v3] flat_segments_excluded ` +
        `count=${excludedSegments}/${allSegments.length} ` +
        `area=${Math.round(excludedM2 * 10.7639)}sqft ` +
        `(pitch<${SHINGLE_MIN_PITCH_DEG}° — pool cage/lanai/awning)`,
    );
  }

  // Convert Gemini's pixel line segments to linear feet using the
  // tile's ground-sample-distance (meters per pixel at this lat/zoom),
  // slope-corrected on hip/valley/rake LFs since those run along the
  // pitched surface, not the ground.
  let geminiEdges: GeminiRoofResponseV3["geminiEdges"] = null;
  if (linesValue && linesValue.length > 0) {
    const tileCosLatLocal = Math.cos((lat * Math.PI) / 180);
    const tileMPerPxLocal =
      (156_543.03392 * tileCosLatLocal) /
      Math.pow(2, PIN_TILE_ZOOM + TILE_SCALE - 1);
    let r = 0;
    let v = 0;
    let k = 0;
    let e = 0;
    for (const ln of linesValue) {
      const isSloped =
        ln.type === "hip" || ln.type === "valley" || ln.type === "rake";
      const lf = gemLineLengthFt(
        ln.start_pixel,
        ln.end_pixel,
        tileMPerPxLocal,
        avgPitchDeg,
        isSloped,
      );
      if (ln.type === "ridge" || ln.type === "hip") r += lf;
      else if (ln.type === "valley") v += lf;
      else if (ln.type === "rake") k += lf;
      else if (ln.type === "eave") e += lf;
    }
    geminiEdges = {
      ridgesHipsLf: Math.round(r),
      valleysLf: Math.round(v),
      rakesLf: Math.round(k),
      eavesLf: Math.round(e),
      linesCount: linesValue.length,
    };
    console.log(
      `[gemini-roof v3] gemini_lines count=${linesValue.length} ` +
        `ridges+hips=${Math.round(r)}ft valleys=${Math.round(v)}ft ` +
        `rakes=${Math.round(k)}ft eaves=${Math.round(e)}ft`,
    );
  }

  // Raw Solar values (in sqft).
  const solarRawSloped = totalSlopedM2 > 0 ? Math.round(totalSlopedM2 * 10.7639) : 0;
  const solarRawFootprint = totalFootprintM2 > 0 ? Math.round(totalFootprintM2 * 10.7639) : 0;

  // ─── Undercount correction (ported from lib/roof-pipeline.ts) ─────
  // Solar's photogrammetric model can dramatically undercount complex
  // roofs on MEDIUM/LOW imagery (Jupiter case: 1,721 sqft on a 3,654
  // sqft building, -53%). When imagery quality is below HIGH AND
  // Solar's footprint is suspiciously small vs the OSM/MS-Buildings
  // building polygon, swap in `GIS footprint × Solar slope ratio` as
  // the corrected sloped area. Solar's measured pitch is solid even
  // on MEDIUM imagery — only the AREA is unreliable.
  //
  // HIGH-imagery cases (Solar.imageryQuality === "HIGH") pass through
  // unchanged because Solar is already accurate (Orlando: -2.3%,
  // Oak Park: +1.6%, Winter Garden: trusted).
  let correction: GeminiRoofResponseV3["correction"] = null;
  let finalSlopedSqft = solarRawSloped;
  let finalFootprintSqft = solarRawFootprint;

  // Confidence proxy: HIGH = 0.85, MEDIUM = 0.70, LOW = 0.55. Same
  // mapping as production solar-source.ts.
  const solarConfidence =
    solar?.imageryQuality === "HIGH"
      ? 0.85
      : solar?.imageryQuality === "MEDIUM"
        ? 0.7
        : solar?.imageryQuality === "LOW"
          ? 0.55
          : 0.5;
  const solarBelowHigh = solarConfidence < 0.85;
  const haveRawValues = solarRawSloped > 0 && solarRawFootprint > 0;
  const solarFullyFailed = !solar || solarRawFootprint === 0;

  // Branch A: Solar returned nothing at all (rural 404 / zero segments).
  // Try GIS for a footprint; without Solar pitch we can't compute sloped
  // sqft, so the response carries footprint-only + null pitch + null
  // sloped sqft. UI surfaces "auto-pitch unavailable" so a rep can
  // enter pitch manually in /dashboard/estimate. Correction is recorded
  // so the audit trail is honest: footprint is real GIS truth, pitch
  // is unknown — no fake data injected.
  if (solarFullyFailed) {
    try {
      const gis = await fetchGisFootprint(lat, lng, undefined);
      if (gis) {
        const gisSqft = polygonAreaSqft(gis.polygon);
        const cosLat = Math.cos((lat * Math.PI) / 180);
        const gisCLat =
          gis.polygon.reduce((s, p) => s + p.lat, 0) / gis.polygon.length;
        const gisCLng =
          gis.polygon.reduce((s, p) => s + p.lng, 0) / gis.polygon.length;
        const dLatM = (gisCLat - lat) * 111_320;
        const dLngM = (gisCLng - lng) * 111_320 * cosLat;
        const gisOffsetM = Math.hypot(dLatM, dLngM);
        const gisIsResidential = gisSqft >= 600 && gisSqft <= 12_000;
        const gisCentroidNearPin = gisOffsetM <= 25;
        if (gisIsResidential && gisCentroidNearPin) {
          finalFootprintSqft = Math.round(gisSqft);
          correction = {
            applied: true,
            reason:
              `solar_unavailable: Solar API returned no data. ` +
              `${gis.source} footprint ${Math.round(gisSqft)} sqft used; ` +
              `pitch unknown — rep must enter manually.`,
            solarRawSlopedSqft: 0,
            solarRawFootprintSqft: 0,
            gisSource: gis.source,
            gisFootprintSqft: Math.round(gisSqft),
            slopeFactor: null,
          };
          console.log(
            `[gemini-roof v3] solar_unavailable_gis_only ` +
              `gis=${gis.source} sqft=${Math.round(gisSqft)} offset_m=${gisOffsetM.toFixed(0)}`,
          );
        } else {
          correction = {
            applied: false,
            reason:
              `solar_unavailable + GIS rejected (` +
              (!gisIsResidential
                ? `${Math.round(gisSqft)} sqft outside [600,12000]`
                : `centroid ${gisOffsetM.toFixed(0)}m from pin (>25m)`) +
              `).`,
            solarRawSlopedSqft: 0,
            solarRawFootprintSqft: 0,
            gisSource: gis.source,
            gisFootprintSqft: Math.round(gisSqft),
            slopeFactor: null,
          };
        }
      } else {
        correction = {
          applied: false,
          reason:
            "solar_unavailable + no GIS footprint (OSM + MS Buildings both empty).",
          solarRawSlopedSqft: 0,
          solarRawFootprintSqft: 0,
          gisSource: null,
          gisFootprintSqft: null,
          slopeFactor: null,
        };
      }
    } catch (err) {
      console.warn(
        "[gemini-roof v3] solar_unavailable_gis_lookup_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  } else if (solarBelowHigh && haveRawValues) {
    try {
      const hn = undefined; // pin-confirmed flow has no street-number context
      const gis = await fetchGisFootprint(lat, lng, hn);
      if (gis) {
        const gisSqft = polygonAreaSqft(gis.polygon);
        const ratio = solarRawFootprint / gisSqft;

        // Validate GIS polygon — residential bounds + centroid near pin.
        const gisIsResidential = gisSqft >= 600 && gisSqft <= 12_000;
        const cosLat = Math.cos((lat * Math.PI) / 180);
        const gisCLat =
          gis.polygon.reduce((s, p) => s + p.lat, 0) / gis.polygon.length;
        const gisCLng =
          gis.polygon.reduce((s, p) => s + p.lng, 0) / gis.polygon.length;
        const dLatM = (gisCLat - lat) * 111_320;
        const dLngM = (gisCLng - lng) * 111_320 * cosLat;
        const gisOffsetM = Math.hypot(dLatM, dLngM);
        const gisCentroidNearPin = gisOffsetM <= 25;
        const solarUndercounting = ratio < 0.6;

        if (gisIsResidential && gisCentroidNearPin && solarUndercounting) {
          // Slope factor: ratio of sloped surface area to ground
          // footprint. For a pitched roof, this MUST be >= 1.0
          // (sloped surface is the hypotenuse). When Solar's
          // imagery is bad, it sometimes returns `sloped < footprint`
          // — physically impossible. Verified on Jupiter 2026-05-18:
          // Solar returned sloped=1419 / footprint=1612 → 0.88,
          // which then dragged OSM 3,336 × 0.88 = 2,937 instead of
          // the correct ~3,594. Fix: detect the bad case and use the
          // physical slope factor from avgPitchDeg.
          const rawSlopeFactor = solarRawSloped / solarRawFootprint;
          const physicalSlopeFactor =
            avgPitchDeg != null && avgPitchDeg > 0 && avgPitchDeg < 80
              ? 1 / Math.cos((avgPitchDeg * Math.PI) / 180)
              : null;
          let slopeFactor: number;
          let slopeFactorSource: string;
          if (rawSlopeFactor >= 1.0) {
            slopeFactor = rawSlopeFactor;
            slopeFactorSource = "solar raw ratio";
          } else if (physicalSlopeFactor != null) {
            // Solar gave a physically-impossible ratio. Recompute
            // from average pitch (1 / cos(θ)).
            slopeFactor = physicalSlopeFactor;
            slopeFactorSource = `physical 1/cos(${avgPitchDeg!.toFixed(1)}°)`;
          } else {
            // No pitch data either — assume a 5/12 (22.6°) typical
            // FL residential roof, slope factor ≈ 1.083.
            slopeFactor = 1.083;
            slopeFactorSource = "default 5/12";
          }
          const correctedSloped = Math.round(gisSqft * slopeFactor);
          finalSlopedSqft = correctedSloped;
          finalFootprintSqft = Math.round(gisSqft);
          correction = {
            applied: true,
            reason:
              `Solar imagery ${solar?.imageryQuality ?? "?"} undercounted: ` +
              `${solarRawFootprint} sqft → ${Math.round(gisSqft)} sqft footprint ` +
              `(${gis.source} GIS, slope ${slopeFactor.toFixed(3)} ` +
              `from ${slopeFactorSource})`,
            solarRawSlopedSqft: solarRawSloped,
            solarRawFootprintSqft: solarRawFootprint,
            gisSource: gis.source,
            gisFootprintSqft: Math.round(gisSqft),
            slopeFactor: Number(slopeFactor.toFixed(3)),
          };
          console.log(
            `[gemini-roof v3] solar_undercount_corrected ` +
              `gis=${gis.source} solar_footprint=${solarRawFootprint} ` +
              `gis_sqft=${Math.round(gisSqft)} ratio=${ratio.toFixed(2)} ` +
              `final_sqft=${correctedSloped}`,
          );
        } else if (gis) {
          // GIS was fetched but didn't meet correction criteria. Record
          // why so the audit trail explains the no-op.
          const why = !gisIsResidential
            ? `GIS ${Math.round(gisSqft)} sqft outside residential bounds [600,12000]`
            : !gisCentroidNearPin
              ? `GIS centroid ${gisOffsetM.toFixed(0)}m from pin (>25m)`
              : `Solar not undercounting (ratio ${ratio.toFixed(2)} ≥ 0.6)`;
          correction = {
            applied: false,
            reason: `Correction skipped: ${why}`,
            solarRawSlopedSqft: solarRawSloped,
            solarRawFootprintSqft: solarRawFootprint,
            gisSource: gis.source,
            gisFootprintSqft: Math.round(gisSqft),
            slopeFactor: null,
          };
        }
      } else {
        correction = {
          applied: false,
          reason: "No GIS footprint available (OSM + MS Buildings both empty).",
          solarRawSlopedSqft: solarRawSloped,
          solarRawFootprintSqft: solarRawFootprint,
          gisSource: null,
          gisFootprintSqft: null,
          slopeFactor: null,
        };
      }
    } catch (err) {
      console.warn(
        "[gemini-roof v3] undercount_check_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ─── Derived totals (penetrations, facets, edges, attic, stories) ──
  //
  // The customer-facing report needs to mirror EagleView's anatomy
  // section. Everything below is computed deterministically from data
  // we already have on the server — no extra API calls.

  // Tile GSD (meters per pixel) at the pin location/zoom. Used to
  // convert Gemini's pixel bboxes into feet for penetration totals.
  const tileCosLat = Math.cos((lat * Math.PI) / 180);
  const tileMPerPx =
    (156_543.03392 * tileCosLat) / Math.pow(2, PIN_TILE_ZOOM + TILE_SCALE - 1);
  const M_TO_FT = 3.28084;

  // Penetration totals (perimeter + area) from Gemini's object bboxes.
  let penetrationPerimeterFt = 0;
  let penetrationAreaSqft = 0;
  for (const o of objects) {
    const wFt = o.bboxPx.width * tileMPerPx * M_TO_FT;
    const hFt = o.bboxPx.height * tileMPerPx * M_TO_FT;
    penetrationPerimeterFt += 2 * (wFt + hFt);
    penetrationAreaSqft += wFt * hFt;
  }
  const penetrationTotals = {
    count: objects.length,
    perimeterFt: Math.round(penetrationPerimeterFt * 10) / 10,
    areaSqft: Math.round(penetrationAreaSqft * 10) / 10,
  };

  // Per-facet breakdown from Solar's roofSegmentStats.
  function azToCompass(az: number): string {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round(((az % 360) + 360) % 360 / 45) % 8];
  }
  function degreesToOnTwelve(deg: number): string {
    if (deg <= 0) return "flat";
    if (deg >= 80) return "vertical";
    const rise = Math.tan((deg * Math.PI) / 180) * 12;
    return `${Math.max(1, Math.round(rise))}/12`;
  }
  // Use the same shingle-segments set so the rep workbench's facet
  // list excludes pool cages / lanai planes that won't be shingled.
  const facets: GeminiRoofResponseV3["facets"] = shingleSegments
    .filter((s) => typeof s.pitchDegrees === "number")
    .map((s) => {
      const pitchDegrees = s.pitchDegrees ?? 0;
      const azimuthDegrees = s.azimuthDegrees ?? 0;
      const slopedSqft = Math.round(((s.stats?.areaMeters2 ?? 0) * 10.7639) * 10) / 10;
      const footprintSqft = Math.round(((s.stats?.groundAreaMeters2 ?? 0) * 10.7639) * 10) / 10;
      return {
        pitchDegrees,
        pitchOnTwelve: degreesToOnTwelve(pitchDegrees),
        azimuthDegrees,
        compassDirection: azToCompass(azimuthDegrees),
        slopedSqft,
        footprintSqft,
      };
    });

  // EagleView-equivalent edge totals — derived from Solar's per-facet
  // adjacency using the production roof-engine classifier.
  //
  // The classifier walks every facet polygon edge, detects pairs of
  // edges shared between adjacent facets (those are interior:
  // ridge/hip/valley), and classifies them using the building's
  // dominant azimuth + the edge bearing. Open edges (no shared
  // partner) become eave or rake based on whether they're parallel
  // or perpendicular to the dominant axis.
  //
  // This is what production /estimate uses; we're just plumbing it
  // through the V3 endpoint. On HIGH-imagery cases the numbers are
  // accurate enough to use for material orders. On MEDIUM/LOW (e.g.
  // Jupiter's 6 segments), Solar's per-facet geometry is coarser so
  // these are approximations — but they're principled approximations
  // rooted in actual photogrammetry rather than the prior heuristics.
  const { facets: rawFacets, dominantAzimuthDeg } = buildFacetsFromSolar(solar);
  const classifiedEdges = classifyEdges(rawFacets, dominantAzimuthDeg);
  const edges: GeminiRoofResponseV3["edges"] =
    classifiedEdges.length === 0
      ? { ridgesHipsLf: null, valleysLf: null, rakesLf: null, eavesLf: null }
      : sumEdgesByType(classifiedEdges);

  // Predominant compass direction (area-weighted).
  let predominantCompass: string | null = null;
  if (facets.length > 0) {
    const byDir = new Map<string, number>();
    for (const f of facets) {
      byDir.set(f.compassDirection, (byDir.get(f.compassDirection) ?? 0) + f.slopedSqft);
    }
    let best: string | null = null;
    let bestArea = -1;
    byDir.forEach((area, dir) => {
      if (area > bestArea) {
        best = dir;
        bestArea = area;
      }
    });
    predominantCompass = best;
  }

  // Stories heuristic — steep + compact → 2-story, sprawling shallow → 1.
  const stories =
    avgPitchDeg != null && avgPitchDeg >= 26.6 && finalFootprintSqft > 0 && finalFootprintSqft <= 2_000
      ? 2
      : 1;

  // Estimated attic — footprint × 0.91 (chimney/utility chase allowance).
  const estimatedAtticSqft =
    finalFootprintSqft > 0 ? Math.round(finalFootprintSqft * 0.91) : null;

  // Complexity (derived; prefer Gemini's call when available).
  const complexity: "simple" | "moderate" | "complex" =
    geminiAnalysis.facetCountEstimate?.complexity ??
    (facets.length >= 11 ? "complex" : facets.length >= 5 ? "moderate" : "simple");

  // Stamp the painted PNG with a faint `voxaris.io` watermark BEFORE
  // it goes into the response / Supabase Storage. This runs AFTER the
  // line-classification Gemini passes above so the stamp doesn't pollute
  // downstream model input. Soft-fails to the unwatermarked image.
  if (paintedImageBase64) {
    paintedImageBase64 = await watermarkPaintedPng(paintedImageBase64);
  }

  const result: GeminiRoofResponseV3 = {
    solar: {
      sqft: finalSlopedSqft > 0 ? finalSlopedSqft : null,
      footprintSqft: finalFootprintSqft > 0 ? finalFootprintSqft : null,
      pitchDegrees: avgPitchDeg,
      segmentCount: shingleSegments.length,
      imageryQuality: solar?.imageryQuality ?? null,
      imageryDate: imageryDateString(solar?.imageryDate),
    },
    correction,
    tile: {
      centerLat: lat,
      centerLng: lng,
      zoom: PIN_TILE_ZOOM,
      widthPx: TILE_SIZE_PX * TILE_SCALE,
      heightPx: TILE_SIZE_PX * TILE_SCALE,
    },
    paintedImageBase64,
    objects,
    penetrationTotals,
    edges,
    geminiEdges,
    facets,
    derived: {
      stories,
      estimatedAtticSqft,
      predominantCompass,
      complexity,
    },
    solarPotential: {
      maxPanels: solar?.solarPotential?.maxArrayPanelsCount ?? null,
      annualSunshineHours: solar?.solarPotential?.maxSunshineHoursPerYear ?? null,
    },
    geminiAnalysis,
    modelVersion: GEMINI_MODEL,
    computedAt: new Date().toISOString(),
  };

  // 30-day cache. Pin-confirmed → safe to long-cache; the pin is
  // stable for a given building. If a rep re-pins, the lat/lng
  // changes and the cache key changes.
  await setCached(CACHE_SCOPE_V3, lat, lng, result, 60 * 60 * 24 * 30);

  // Mirror the result to the lead row so the rep workbench / lead
  // drawer can render "See report" instantly without re-running the
  // pipeline. Async via waitUntil() — customer response not blocked
  // on Supabase write or Storage upload.
  if (leadPublicId) {
    waitUntil(persistEstimateToLead(leadPublicId, result).catch((err) => {
      console.warn(
        "[gemini-roof v3] persist_to_lead_failed",
        err instanceof Error ? err.message : String(err),
      );
    }));
  }

  if (debug) {
    // Echo the raw Gemini text + any caught error in the response.
    // Diagnostic-only — never shown to customers, never cached.
    return NextResponse.json({
      ...result,
      _debug: { geminiRawText, geminiRichErr },
    });
  }
  return NextResponse.json(result);
}

async function handle(
  lat: number,
  lng: number,
  skipCache: boolean,
): Promise<NextResponse> {
  if (!skipCache) {
    const cached = await getCached<GeminiRoofResponse>(CACHE_SCOPE, lat, lng);
    if (cached) {
      return NextResponse.json(cached);
    }
  }

  const googleKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!googleKey) {
    return NextResponse.json(
      { error: "missing_google_key" },
      { status: 503 },
    );
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return NextResponse.json(
      { error: "missing_gemini_key" },
      { status: 503 },
    );
  }

  // 1. Call Solar FIRST. The Jupiter failure (2026-05-16) showed
  //    that Gemini wanders to brighter neighboring roofs at the
  //    default zoom 20 because the target building only occupies ~14%
  //    of the tile. Solar's `boundingBox` + `center` let us pick a
  //    tighter zoom (typically 21) and recenter the tile on the actual
  //    photogrammetric building center — so the target building
  //    dominates 50–65% of the frame and Gemini physically can't grab
  //    a neighbor.
  //
  //    Solar is fast (~1–2s) and free. The Solar-first sequencing
  //    costs a small amount of latency vs the prior parallel path but
  //    is the only way to get the wrong-building failure under control.
  //    If Solar fails (rural / no coverage), we fall back to the prior
  //    geocoded-center + zoom 20 behavior.
  const solar = await callSolar(lat, lng, googleKey);

  let tileCenterLat = lat;
  let tileCenterLng = lng;
  let tileZoom = TILE_ZOOM;
  if (solar?.boundingBox && solar?.center) {
    tileCenterLat = solar.center.latitude;
    tileCenterLng = solar.center.longitude;
    tileZoom = pickOptimalZoom(solar.boundingBox, tileCenterLat);
    console.log(
      `[gemini-roof] solar_bbox_recenter from=(${lat.toFixed(5)},${lng.toFixed(5)}) ` +
        `to=(${tileCenterLat.toFixed(5)},${tileCenterLng.toFixed(5)}) ` +
        `zoom=${tileZoom} (was ${TILE_ZOOM})`,
    );
  } else {
    console.warn(
      "[gemini-roof] solar_bbox_unavailable — falling back to geocoded center + zoom 20",
    );
  }

  // 2. Fetch the tile at the building-centered location/zoom.
  const tile = await fetchGoogleStaticTile(
    tileCenterLat,
    tileCenterLng,
    googleKey,
    tileZoom,
  );
  const tileMeta = buildTileMetadata({
    centerLat: tileCenterLat,
    centerLng: tileCenterLng,
    zoom: tileZoom,
    scale: TILE_SCALE,
    sizePx: TILE_SIZE_PX,
  });

  // 3. Call Gemini with the recentered/rezoomed tile.
  const geminiResult = await callGemini(tile.base64, geminiKey).catch(
    (err) => err instanceof Error ? err : new Error(String(err)),
  );
  if (geminiResult instanceof Error) {
    console.warn("[gemini-roof] gemini_failed", geminiResult.message);
    return NextResponse.json(
      { error: "gemini_failed", detail: geminiResult.message },
      { status: 502 },
    );
  }
  const geminiRaw = geminiResult;

  const vision = normalizeGeminiOutput(geminiRaw);
  if (vision.outlinePx.length < 3) {
    // The revised prompt (2026-05-16) tells Gemini to return empty
    // arrays when no roof is identifiable within a 400-px radius of
    // the tile center, instead of fabricating a polygon on a nearby
    // wrong building. Honor that by surfacing a 422 with a clear
    // "manual review needed" signal — caller treats this as a soft
    // failure, not an error.
    return NextResponse.json(
      {
        error: "no_roof_identifiable",
        detail:
          "Gemini could not identify a roof within 400px of the tile center. Manual review needed.",
      },
      { status: 422 },
    );
  }

  // 3. Reconcile Gemini outline against Solar's ground truth BEFORE
  //    running the geometry math. The reconciler either accepts
  //    Gemini's polygon, clips it to Solar's bbox (over-trace recovery),
  //    or replaces it entirely with Solar's bbox-derived polygon
  //    (under-trace or wrong-building recovery). The result is always
  //    a usable polygon.
  let reconciliation: ReconciliationResult | null = null;
  const wholeRoofAreaM2 = solar?.solarPotential?.wholeRoofStats?.groundAreaMeters2;
  if (
    solar?.center &&
    solar?.boundingBox &&
    typeof wholeRoofAreaM2 === "number" &&
    wholeRoofAreaM2 > 0
  ) {
    const geminiOutlineLatLng = pixelPolygonToLatLng(vision.outlinePx, tileMeta);
    reconciliation = reconcileGeminiAgainstSolar({
      geminiOutline: geminiOutlineLatLng,
      solarBuildingCenter: {
        lat: solar.center.latitude,
        lng: solar.center.longitude,
      },
      solarWholeRoofAreaSqft: wholeRoofAreaM2 * 10.7639,
      solarBoundingBox: {
        sw: {
          lat: solar.boundingBox.sw.latitude,
          lng: solar.boundingBox.sw.longitude,
        },
        ne: {
          lat: solar.boundingBox.ne.latitude,
          lng: solar.boundingBox.ne.longitude,
        },
      },
    });
    console.log(
      `[gemini-roof] reconcile result=${reconciliation.outlineSource} ` +
        `accept=${reconciliation.acceptedAsIs} ` +
        `ratio=${reconciliation.diagnostics.areaRatio.toFixed(2)} ` +
        `centroid_off=${reconciliation.diagnostics.centroidDistanceM.toFixed(1)}m`,
    );
  }

  // 4. Process: pixels → measurements, enriched with Solar.
  const solarPlanes = solarToPlaneMatches(solar);
  const measurements = processVisionOutput({
    vision,
    tile: tileMeta,
    solarPlanes,
  });

  // Override the geometry's outlinePolygon with the reconciled polygon
  // when the reconciler ran. The facets / linear features / objects
  // stay as Gemini produced them — they're additive intelligence even
  // when the outline got rejected.
  if (reconciliation) {
    measurements.outlinePolygon = reconciliation.finalOutline;
  }

  const result: GeminiRoofResponse = {
    measurements,
    reconciliation: reconciliation ?? {
      acceptedAsIs: true,
      reason: "Solar wholeRoofStats unavailable — accepted Gemini outline by default.",
      fallback: null,
      finalOutline: measurements.outlinePolygon,
      outlineSource: "gemini",
      diagnostics: { geminiAreaSqft: 0, solarAreaSqft: 0, areaRatio: 0, centroidDistanceM: 0 },
    },
    imageryDate: imageryDateString(solar?.imageryDate),
    imageryQuality: solar?.imageryQuality ?? null,
    modelVersion: GEMINI_MODEL,
    computedAt: new Date().toISOString(),
  };

  await setCached(CACHE_SCOPE, lat, lng, result, 60 * 60 * 24 * 30);
  return NextResponse.json(result);
}

export async function GET(req: Request): Promise<NextResponse> {
  const origin = checkOrigin(req);
  if (origin) return origin;
  // Bucket dropped from "standard" (60/min) → "expensive" (10/min):
  // each invocation costs ~$0.05–$0.15 in Gemini credits, so the cap
  // needs to match the cost class. BotID + origin allowlist already
  // filter the obvious abusers; the rate limit catches a logged-in
  // staff member accidentally hammering refresh.
  const rl = await rateLimit(req, "expensive");
  if (rl) return rl;
  // Daily $-spend circuit breaker. Rate limits are per-IP; the cap
  // catches a distributed attacker or a buggy retry loop that stays
  // under the per-IP cap and still drains the daily AI budget.
  const capGate = await assertAiSpendUnderCap();
  if (capGate) return capGate;
  const verdict = await checkBotId();
  if ("isBot" in verdict && verdict.isBot && !verdict.isVerifiedBot) {
    return NextResponse.json({ error: "Bot detected" }, { status: 403 });
  }
  const parsed = parseInputs(req, null);
  if (parsed instanceof NextResponse) return parsed;
  // ?debug=1 returns raw Gemini text + caught errors — useful for ops,
  // but a prompt-leak vector for the public. Strip it unless the caller
  // is staff (cookie / Basic / Supabase session).
  if (parsed.debug && !isStaffRequest(req)) parsed.debug = false;
  try {
    return await (parsed.pinConfirmed
      ? handleV3Pinned(parsed.lat, parsed.lng, parsed.skipCache, parsed.debug, parsed.leadPublicId)
      : handle(parsed.lat, parsed.lng, parsed.skipCache));
  } catch (err) {
    // Log the full error for operators (Sentry / Vercel logs); return a
    // generic shape to the client so stack hints / prompt fragments /
    // dependency names don't leak. The audit flagged this in 2026-05.
    console.error("[gemini-roof] unhandled", err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const origin = checkOrigin(req);
  if (origin) return origin;
  // See GET above — same expensive bucket + BotID gate.
  const rl = await rateLimit(req, "expensive");
  if (rl) return rl;
  const capGate = await assertAiSpendUnderCap();
  if (capGate) return capGate;
  const verdict = await checkBotId();
  if ("isBot" in verdict && verdict.isBot && !verdict.isVerifiedBot) {
    return NextResponse.json({ error: "Bot detected" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }
  const parsed = parseInputs(req, body);
  if (parsed instanceof NextResponse) return parsed;
  // See GET above — staff-only debug flag.
  if (parsed.debug && !isStaffRequest(req)) parsed.debug = false;
  try {
    return await (parsed.pinConfirmed
      ? handleV3Pinned(parsed.lat, parsed.lng, parsed.skipCache, parsed.debug, parsed.leadPublicId)
      : handle(parsed.lat, parsed.lng, parsed.skipCache));
  } catch (err) {
    // Log the full error for operators (Sentry / Vercel logs); return a
    // generic shape to the client so stack hints / prompt fragments /
    // dependency names don't leak. The audit flagged this in 2026-05.
    console.error("[gemini-roof] unhandled", err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

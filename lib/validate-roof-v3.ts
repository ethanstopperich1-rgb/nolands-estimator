/**
 * Allow-list validation for the client-supplied `roofV3` payload on
 * /api/leads.
 *
 * The customer-side estimator POSTs the V3 result (Gemini paint + Solar
 * measurements + objects). Originally we stored ALL fields the client
 * sent with `...rest`. That works today because nothing trusts the
 * extra fields, but it's a latent injection vector: as soon as some
 * future code reads `lead.roof_v3_json.someField` and uses it for
 * pricing / messaging / dispatch, the client can manipulate it.
 *
 * This module strips the payload down to the fields the dashboard
 * actually consumes. Unknown fields are discarded. Number fields are
 * coerced + clamped to safe ranges.
 */

import type { Json } from "@/types/supabase";

export interface SanitizedRoofV3 {
  totalSlopedSqft: number | null;
  totalFootprintSqft: number | null;
  predominantPitch: string | null;
  material: string | null;
  materialConfidence: "high" | "medium" | "low" | null;
  objectCounts: Record<string, number>;
  imageryDate: string | null;
  imageryQuality: "HIGH" | "MEDIUM" | "LOW" | null;
  modelVersion: string | null;
}

const ALLOWED_MATERIALS = new Set([
  "asphalt-3tab",
  "asphalt-architectural",
  "metal-standing-seam",
  "metal-shingle",
  "tile-concrete",
  "tile-clay",
  "wood-shake",
  "flat-membrane",
  "unknown",
]);

const ALLOWED_OBJECT_TYPES = new Set([
  "vent",
  "plumbing_boot",
  "stack",
  "chimney",
  "skylight",
  "hvac_unit",
  "satellite_dish",
  "solar_panel",
]);

function asString(v: unknown, maxLen = 64): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function asFiniteNumber(
  v: unknown,
  min: number,
  max: number,
): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function pickObjectCounts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  const counts =
    obj.counts && typeof obj.counts === "object"
      ? (obj.counts as Record<string, unknown>)
      : obj;
  for (const [k, v] of Object.entries(counts)) {
    if (!ALLOWED_OBJECT_TYPES.has(k)) continue;
    const n = asFiniteNumber(v, 0, 99);
    if (n != null) out[k] = Math.round(n);
  }
  return out;
}

/**
 * Sanitize the client-supplied roofV3 payload. `paintedImageBase64` is
 * handled separately by the caller — strip it before passing here.
 */
export function sanitizeRoofV3Payload(input: unknown): {
  sanitized: SanitizedRoofV3;
  json: Json;
} {
  const src = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;

  const rawMaterial = asString(src.material, 32)?.toLowerCase() ?? null;
  const material =
    rawMaterial && ALLOWED_MATERIALS.has(rawMaterial) ? rawMaterial : null;

  const rawConfidence = asString(src.materialConfidence, 16)?.toLowerCase();
  const materialConfidence =
    rawConfidence === "high" || rawConfidence === "medium" || rawConfidence === "low"
      ? rawConfidence
      : null;

  const rawQuality = asString(src.imageryQuality, 16)?.toUpperCase();
  const imageryQuality =
    rawQuality === "HIGH" || rawQuality === "MEDIUM" || rawQuality === "LOW"
      ? (rawQuality as "HIGH" | "MEDIUM" | "LOW")
      : null;

  const sanitized: SanitizedRoofV3 = {
    totalSlopedSqft: asFiniteNumber(src.totalSlopedSqft, 0, 100_000),
    totalFootprintSqft: asFiniteNumber(src.totalFootprintSqft, 0, 100_000),
    predominantPitch: asString(src.predominantPitch, 8),
    material,
    materialConfidence,
    objectCounts: pickObjectCounts(src.objects ?? src.objectCounts),
    imageryDate: asString(src.imageryDate, 32),
    imageryQuality,
    modelVersion: asString(src.modelVersion, 64),
  };

  const json = JSON.parse(JSON.stringify(sanitized)) as Json;
  return { sanitized, json };
}

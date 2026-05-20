/**
 * Read branding-related env vars with PITCH_* as canonical keys and
 * ROOFAI_* as deprecated aliases (roofai-internal repo name).
 */

export function envBrand(key: string, fallback = ""): string {
  if (typeof process === "undefined") return fallback;
  const pitch = process.env[`PITCH_${key}`];
  if (pitch) return pitch;
  const roofai = process.env[`ROOFAI_${key}`];
  if (roofai) return roofai;
  return fallback;
}

export function envBrandFlag(key: string, fallback = false): boolean {
  const raw = envBrand(key, fallback ? "true" : "");
  return raw === "true" || raw === "1";
}

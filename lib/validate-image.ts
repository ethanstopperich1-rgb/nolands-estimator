/**
 * Client-supplied image validation for inbound POSTs.
 *
 * The /api/leads + /api/leads/[publicId]/roof-v3 routes accept a
 * base64-encoded painted PNG from the client and upload it to Supabase
 * Storage. Without these checks, a hostile client can:
 *
 *   1. Plant arbitrary content (any file type) tagged as `image/png`.
 *   2. Burn storage by uploading multi-MB payloads up to whatever the
 *      Vercel body-size limit is set to.
 *
 * Validates:
 *   - Total decoded byte length ≤ MAX_PAINTED_PNG_BYTES (default 2 MB).
 *   - First 8 bytes match the PNG file signature.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const MAX_PAINTED_PNG_BYTES = 2 * 1024 * 1024;

export type ValidatePaintedPngResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: string };

export function validatePaintedPngBase64(
  base64: unknown,
  maxBytes: number = MAX_PAINTED_PNG_BYTES,
): ValidatePaintedPngResult {
  if (typeof base64 !== "string" || base64.length === 0) {
    return { ok: false, reason: "empty_or_non_string" };
  }
  if (base64.length > Math.ceil((maxBytes * 4) / 3) + 16) {
    return { ok: false, reason: "base64_too_long" };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return { ok: false, reason: "base64_decode_failed" };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, reason: "decoded_empty" };
  }
  if (bytes.byteLength > maxBytes) {
    return { ok: false, reason: "exceeds_size_cap" };
  }
  if (bytes.byteLength < PNG_MAGIC.length) {
    return { ok: false, reason: "too_short_for_png_header" };
  }
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) {
      return { ok: false, reason: "bad_png_magic" };
    }
  }
  return { ok: true, bytes };
}

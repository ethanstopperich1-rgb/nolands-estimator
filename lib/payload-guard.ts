/**
 * Defensive Content-Length cap for /api/* routes.
 *
 * Most routes have implicit upper bounds on legitimate body size:
 *   - JSON-only routes (login, consent, webhooks): well under 10 KB
 *   - Lead capture with embedded painted PNG: ~2 MB cap on the PNG
 *   - Gemini pipeline triggers: query params + small JSON body
 *
 * Without an explicit cap, an attacker can POST gigabyte-scale bodies
 * to exhaust function memory before the per-route validator runs. This
 * helper is a defense-in-depth first guard — call it at the top of a
 * route handler, BEFORE awaiting `req.json()` / `req.text()`.
 *
 * Implementation note: Vercel Functions limit body size to 4.5 MB by
 * default but that ceiling is platform-level — this helper enforces
 * tighter per-route caps that match the actual schema.
 *
 * Returns `null` to proceed, or a 413 NextResponse to reject.
 */

import { NextResponse } from "next/server";

interface Options {
  /** Hard cap on Content-Length in bytes. Defaults to 100 KB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 100 * 1024; // 100 KB

export function checkPayloadSize(
  req: Request,
  opts: Options = {},
): NextResponse | null {
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const raw = req.headers.get("content-length");
  if (!raw) return null; // Streamed bodies / GET requests — no header.
  const declared = Number.parseInt(raw, 10);
  if (!Number.isFinite(declared) || declared < 0) {
    return NextResponse.json(
      { error: "invalid_content_length" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (declared > max) {
    return NextResponse.json(
      {
        error: "payload_too_large",
        max_bytes: max,
        declared_bytes: declared,
      },
      {
        status: 413,
        headers: {
          "Cache-Control": "no-store",
          // Tell well-behaved clients the cap so they don't retry.
          "X-Max-Body-Bytes": String(max),
        },
      },
    );
  }
  return null;
}

/** Common preset sizes used across the codebase. */
export const PAYLOAD_LIMITS = {
  /** Small JSON: login, consent toggles, simple webhooks. */
  small: 16 * 1024,
  /** Normal JSON: most routes with a few text fields. */
  normal: 100 * 1024,
  /** Large JSON: leads with embedded V3 metadata + base64 image. */
  large: 5 * 1024 * 1024,
} as const;

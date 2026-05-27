/**
 * GET /api/internal/spyfu-sync
 *
 * Live SpyFu data pull. Replaces the May-27 one-off PDF dump with an
 * on-demand API call that returns the four datasets the Intel Brief is
 * built from:
 *   - Domain stats (page-2 numbers)
 *   - Top paid keywords (the AIM $23K x-ray)
 *   - Top organic keywords (the 920 keyword footprint)
 *   - Competitors (organic + paid)
 *   - Ad waste flags
 *
 * Auth: gated by INTERNAL_DISPATCH_SECRET via `x-dispatch-secret`
 * header. NOT for customer-facing routes.
 *
 * Usage:
 *   curl -H "x-dispatch-secret: $INTERNAL_DISPATCH_SECRET" \
 *        https://demo.voxaris.io/api/internal/spyfu-sync
 *
 * Soft-fails when SPYFU_API_KEY / SPYFU_API_ID env vars unset. Returns
 * a structured `{ ok: false, reason: "not_configured" }` so the
 * dashboard knows to fall back to the cached PDF data in memory.
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  getDomainStats,
  getTopOrganicKeywords,
  getTopPaidKeywords,
  getCompetitors,
  detectAdWaste,
  spyFuConfigured,
} from "@/lib/spyfu";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const expected = process.env.INTERNAL_DISPATCH_SECRET;
  if (!expected) return false;
  const provided = req.headers.get("x-dispatch-secret") ?? "";
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!spyFuConfigured()) {
    return NextResponse.json({
      ok: false,
      reason: "not_configured",
      hint:
        "Set SPYFU_API_KEY + SPYFU_API_ID env vars on Vercel prod. " +
        "Sign up at https://www.spyfu.com/api/documentation and copy " +
        "the credentials from your account's API page.",
    });
  }

  const url = new URL(req.url);
  const domain = url.searchParams.get("domain") ?? "nolandsroofing.com";

  // Pull all 5 datasets in parallel. Each soft-fails to its own
  // {ok:false, reason} so partial responses still ship useful data.
  const [domainStats, paidKw, organicKw, competitors, adWaste] =
    await Promise.all([
      getDomainStats(domain),
      getTopPaidKeywords(domain, { limit: 100 }),
      getTopOrganicKeywords(domain, { limit: 100, sortBy: "clicks" }),
      getCompetitors(domain),
      detectAdWaste(domain),
    ]);

  return NextResponse.json({
    ok: true,
    domain,
    pulledAt: new Date().toISOString(),
    domainStats,
    paidKeywords: paidKw,
    organicKeywords: organicKw,
    competitors,
    adWasteDetection: adWaste,
  });
}

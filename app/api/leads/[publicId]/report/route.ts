import { NextResponse } from "next/server";
import { renderRoofReportPDF } from "@/lib/pdf-report";

/**
 * GET /api/leads/[publicId]/report
 *
 * EagleView-style multi-page PDF roof inspection report. Pulls the
 * lead's `roof_v3_json` (Gemini V3 analysis), renders the branded
 * template at /internal/report/[publicId] via headless Chromium, and
 * streams the resulting PDF.
 *
 * Auth: rep-protected — the route lives under /api/leads/[publicId]/*
 * which is gated by the dashboard Basic Auth + staff-cookie middleware
 * gate (see middleware.ts → PROTECTED_API_PREFIXES + the per-route
 * pattern used by ./roof-v3/route.ts).
 *
 * Runtime: Node.js — needs Buffer, the playwright-core launcher, and
 * (on Vercel) the @sparticuz/chromium native binary. The Edge runtime
 * cannot host headless Chromium.
 */
export const runtime = "nodejs";
// Cold lambda + chromium boot + 5-page render comfortably fits in 60s.
// If we add image-heavy comp pages this needs to bump to 120s.
export const maxDuration = 60;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  const { publicId } = await ctx.params;
  if (!/^lead_[0-9a-f]{32}$/i.test(publicId)) {
    return NextResponse.json({ error: "invalid_public_id" }, { status: 400 });
  }

  const origin = new URL(req.url).origin;
  let pdf: Buffer;
  try {
    pdf = await renderRoofReportPDF(publicId, origin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "lead_not_found" || msg === "lead_missing_roof_v3_json") {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (msg === "supabase_service_role_unconfigured") {
      return NextResponse.json({ error: msg }, { status: 503 });
    }
    console.warn("[api/leads/report] render failed", msg);
    return NextResponse.json(
      { error: "report_render_failed", message: msg },
      { status: 500 },
    );
  }

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="voxaris-roof-report-${publicId}.pdf"`,
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}

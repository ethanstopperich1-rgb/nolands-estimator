import { NextResponse } from "next/server";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import { validatePaintedPngBase64 } from "@/lib/validate-image";

export const runtime = "nodejs";
// V3 pipeline can take 25-40s on a cold Gemini call + Solar fallback.
export const maxDuration = 60;

/**
 * POST /api/leads/[publicId]/roof-v3
 *
 * Generates (or refreshes) the Gemini V3 roof analysis for an existing
 * lead. Pulls the lead's lat/lng, fires the /api/gemini-roof pin-
 * confirmed pipeline, uploads the painted PNG to Supabase Storage, and
 * persists the result on `leads.roof_v3_json`.
 *
 * Use case: a lead arrived through the legacy /quote flow (or anywhere
 * else) without a V3 payload. The rep opens the lead in the dashboard
 * and one-clicks "Generate roof analysis" to fill the drawer with the
 * full painted breakdown.
 *
 * Auth: rep-protected by middleware (`/api/leads` prefix is gated).
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ publicId: string }> },
): Promise<NextResponse> {
  const { publicId } = await ctx.params;
  // Canonical publicId only — the previous loose `[a-z0-9_-]{4,64}`
  // fallback accepted 4-char ids which weakened the entropy floor.
  if (!/^lead_[0-9a-f]{32}$/i.test(publicId)) {
    return NextResponse.json({ error: "invalid_public_id" }, { status: 400 });
  }

  if (!supabaseServiceRoleConfigured()) {
    return NextResponse.json(
      { error: "supabase_unconfigured" },
      { status: 503 },
    );
  }

  const supabase = createServiceRoleClient();
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("id, office_id, public_id, lat, lng, address, roof_v3_json")
    .eq("public_id", publicId)
    .maybeSingle();
  if (leadErr || !lead) {
    return NextResponse.json({ error: "lead_not_found" }, { status: 404 });
  }
  if (lead.lat == null || lead.lng == null) {
    return NextResponse.json(
      {
        error: "lead_missing_coordinates",
        message:
          "Lead has no lat/lng — cannot pin-confirm the roof. Geocode the address first.",
      },
      { status: 422 },
    );
  }

  // Fire the V3 pipeline against the lead's pin. We hit the same
  // origin so middleware doesn't reject internal calls — base URL
  // resolves from the incoming request.
  const origin = new URL(req.url).origin;
  const v3Url =
    `${origin}/api/gemini-roof?lat=${lead.lat}&lng=${lead.lng}&pinConfirmed=1`;
  const t0 = Date.now();
  const r = await fetch(v3Url, { cache: "no-store" });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return NextResponse.json(
      {
        error: "gemini_pipeline_failed",
        status: r.status,
        body: txt.slice(0, 400),
      },
      { status: 502 },
    );
  }
  const v3 = (await r.json()) as {
    paintedImageBase64?: string | null;
    [k: string]: unknown;
  };
  const latencyMs = Date.now() - t0;

  // Upload painted image to Storage, then strip it from the JSON we
  // persist (matches the /api/leads POST shape).
  let paintedUrl: string | null = null;
  if (typeof v3.paintedImageBase64 === "string" && v3.paintedImageBase64.length > 0) {
    const validated = validatePaintedPngBase64(v3.paintedImageBase64);
    if (!validated.ok) {
      console.warn(`[roof-v3] painted image rejected: ${validated.reason}`);
    } else {
      try {
        const objectKey = `${publicId}.png`;
        const up = await supabase.storage
          .from("painted-roofs")
          .upload(objectKey, validated.bytes, {
            contentType: "image/png",
            upsert: true,
          });
        if (up.error) {
          console.error("[roof-v3] painted upload failed:", up.error.message);
        } else {
          const { data: pub } = supabase.storage
            .from("painted-roofs")
            .getPublicUrl(objectKey);
          paintedUrl = pub.publicUrl;
        }
      } catch (e) {
        console.error("[roof-v3] painted upload threw:", e);
      }
    }
  }
  const { paintedImageBase64: _drop, ...rest } = v3;
  // Cast through unknown to satisfy the Supabase Json typing — the
  // payload is structurally a Json tree (numbers, strings, nested
  // objects, arrays), TypeScript just can't infer that from `unknown`.
  const roofV3Json = {
    ...rest,
    painted_url: paintedUrl,
    generated_at: new Date().toISOString(),
    generated_via: "dashboard-button",
  } as unknown as import("@/types/supabase").Json;

  // office_id in the predicate honors the documented service-role
  // invariant in lib/supabase.ts — defense-in-depth against any future
  // weakening of the publicId entropy.
  const { error: upErr } = await supabase
    .from("leads")
    .update({ roof_v3_json: roofV3Json })
    .eq("public_id", publicId)
    .eq("office_id", lead.office_id);
  if (upErr) {
    return NextResponse.json(
      { error: "lead_update_failed", message: upErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    publicId,
    latencyMs,
    paintedUrl,
  });
}

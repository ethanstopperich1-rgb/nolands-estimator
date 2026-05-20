import { NextResponse } from "next/server";
import {
  getDashboardOfficeId,
  getDashboardSupabase,
  getDashboardUser,
} from "@/lib/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/leads/[publicId]
 *
 * Returns a single lead row, scoped to the active dashboard office.
 * Used by /dashboard/estimate?leadId=<publicId> to pre-populate the
 * rep workbench when the rep clicks a lead from the leads list.
 *
 * Auth: dashboard Supabase session required. Reps can only see leads
 * within their office; Supabase RLS enforces the final gate at the
 * row level even if office_id is spoofed.
 */
export async function GET(
  _req: Request,
  context: { params: Promise<{ publicId: string }> },
): Promise<NextResponse> {
  const { publicId } = await context.params;
  if (!publicId || !/^lead_[0-9a-f]{32}$/i.test(publicId)) {
    return NextResponse.json({ error: "invalid_public_id" }, { status: 400 });
  }

  const [user, supabase, officeId] = await Promise.all([
    getDashboardUser(),
    getDashboardSupabase(),
    getDashboardOfficeId(),
  ]);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!supabase || !officeId) {
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }

  const { data, error } = await supabase
    .from("leads")
    .select(
      [
        "public_id",
        "name",
        "email",
        "phone",
        "address",
        "lat",
        "lng",
        "source",
        "tcpa_consent",
        "tcpa_consent_at",
        "created_at",
        "notes",
      ].join(","),
    )
    .eq("public_id", publicId)
    .eq("office_id", officeId)
    .maybeSingle();

  if (error) {
    console.warn("[api/leads/[publicId]] supabase error", error.message);
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ lead: data });
}

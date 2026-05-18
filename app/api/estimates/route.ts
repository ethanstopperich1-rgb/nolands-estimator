/**
 * POST /api/estimates
 *
 * Persists a rep-side roof estimate (from the /dashboard/estimate
 * workbench) WITHOUT the TCPA + contact-info gate that /api/leads
 * imposes. Reps explore properties before any customer is on file —
 * they need to save the work without inventing fake consent.
 *
 * The row lands in the same `leads` table as customer leads so the
 * downstream rep tools (leads list, drawer, V3 regen, /dashboard/
 * estimate?leadId=…) all just work. Two fields tag it apart:
 *
 *   source = "rep-workbench"     filtered out of customer pipeline counts
 *   email  = rep+<8hex>@voxaris.local
 *                                synthetic, never receives mail. Unique
 *                                per row so the unique index on email
 *                                doesn't collide.
 *
 * Auth: rep-protected. /api/leads is intentionally public for customer
 * capture, but /api/estimates is staff-only — middleware.ts gates this
 * by adding the route to PROTECTED_API_PREFIXES.
 */

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import {
  createServiceRoleClient,
  resolveOfficeIdBySlug,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import type { Json } from "@/types/supabase";

export const runtime = "nodejs";
export const maxDuration = 15;

interface RepEstimatePayload {
  address: string;
  lat: number;
  lng: number;
  zip?: string | null;
  /** The full V3 response captured at runtime (sans the painted base64
   *  — that's already been uploaded to Storage by /api/gemini-roof). */
  roofV3?: unknown;
  /** Rep workbench overrides. All optional — the materialMult /
   *  laborMult default to 1 in the UI. */
  material?: string;
  manualPitchOn12?: number;
  tearOff?: boolean;
  laborMult?: number;
  materialMult?: number;
  notes?: string;
}

const FALLBACK_OFFICE_SLUG = "voxaris";

function newLeadPublicId(): string {
  return `lead_${randomBytes(16).toString("hex")}`;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!supabaseServiceRoleConfigured()) {
    return NextResponse.json(
      { error: "supabase_unconfigured" },
      { status: 503 },
    );
  }

  let body: RepEstimatePayload;
  try {
    body = (await req.json()) as RepEstimatePayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.address?.trim()) {
    return NextResponse.json({ error: "address_required" }, { status: 400 });
  }
  if (!Number.isFinite(body.lat) || !Number.isFinite(body.lng)) {
    return NextResponse.json({ error: "lat_lng_required" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  // Office is required for tenancy / RLS. Reps signed into Supabase
  // already have an office_id on `public.users`, but rep workbench
  // calls today happen pre-magic-link; resolve from the seed office.
  // Swap to JWT-derived office once STRICT_DASHBOARD_AUTH=1 lands.
  const officeId = await resolveOfficeIdBySlug(FALLBACK_OFFICE_SLUG);
  if (!officeId) {
    return NextResponse.json({ error: "office_lookup_failed" }, { status: 500 });
  }

  const publicId = newLeadPublicId();
  // Synthetic email keeps the leads.email NOT NULL constraint happy
  // without ever being able to receive real mail (.local TLD is
  // reserved by RFC 6762 for mDNS — guaranteed un-routable).
  const syntheticEmail = `rep+${publicId.slice(5, 13)}@voxaris.local`;

  const repInputs = {
    material: body.material ?? null,
    manualPitchOn12: body.manualPitchOn12 ?? null,
    tearOff: body.tearOff ?? null,
    laborMult: body.laborMult ?? null,
    materialMult: body.materialMult ?? null,
  };

  // Stash the rep workbench overrides + the V3 payload on roof_v3_json
  // so the drawer + workbench re-open with the same numbers later.
  const roofV3Json: Json = {
    ...(body.roofV3 as Record<string, unknown> | undefined ?? {}),
    rep_inputs: repInputs as unknown as Json,
    generated_via: "rep-workbench",
    generated_at: new Date().toISOString(),
  } as unknown as Json;

  const { error: insertErr } = await supabase.from("leads").insert({
    public_id: publicId,
    office_id: officeId,
    name: "(rep estimate)",
    email: syntheticEmail,
    phone: null,
    address: body.address.trim(),
    zip: body.zip?.trim() || null,
    lat: body.lat,
    lng: body.lng,
    source: "rep-workbench",
    notes: body.notes?.trim() || null,
    status: "new",
    roof_v3_json: roofV3Json,
  });

  if (insertErr) {
    console.error("[api/estimates] insert failed:", insertErr.message);
    return NextResponse.json(
      { error: "save_failed", message: insertErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ publicId });
}

/**
 * /dashboard/leads/[publicId] — full-page lead report.
 *
 * Replaces the side-drawer-only view of a lead with a full-width
 * report page. Reps land here when they click "See report" from the
 * lead drawer / table. The page renders the painted overlay big, the
 * customer + property cards, headline measurements, anatomy, edges,
 * storm history (rep-adjustable radius + window), and a regenerate
 * CTA when the painted PNG is missing — same surfaces the drawer
 * had, just in full-page form.
 *
 * Server component handles the lead lookup (service-role via
 * `getDashboardSupabase`). Interactive bits (storm fetch knobs, the
 * regenerate button) live in the client component below.
 */

import { notFound } from "next/navigation";
import {
  getDashboardOfficeId,
  getDashboardSupabase,
  type Lead,
} from "@/lib/dashboard";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import LeadReport from "@/components/dashboard/LeadReport";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Re-mint the painted-roof signed URL on every page load.
 *
 * `painted-roofs` is a private Supabase Storage bucket (since the
 * 2026-05 PII migration). The original signed URL written into
 * `roof_v3_json.painted_url` is good for 7 days; after that the
 * report page would show "Painted overlay unavailable" even though
 * the PNG itself still lives in Storage.
 *
 * Solution: every time we serve the report, ask Storage for a fresh
 * 7-day signed URL keyed to `${publicId}.png`. If the object doesn't
 * exist, the Storage API returns an error and we leave painted_url
 * untouched — the LeadReport falls through to the regenerate CTA.
 *
 * Cost is one Storage API call per page load. Worth it: reps stop
 * having to click 'Regenerate' just because a URL aged out.
 */
async function refreshPaintedUrl(
  lead: Lead,
): Promise<Lead> {
  if (!supabaseServiceRoleConfigured()) return lead;
  const v3 = lead.roof_v3_json as Record<string, unknown> | null;
  if (!v3) return lead;
  // V3 ran at some point — we have measurements but maybe a stale URL.
  // Worth probing Storage for the object.
  try {
    const supabase = createServiceRoleClient();
    const objectKey = `${lead.public_id}.png`;
    const { data, error } = await supabase.storage
      .from("painted-roofs")
      .createSignedUrl(objectKey, 60 * 60 * 24 * 7);
    if (error || !data?.signedUrl) return lead;
    // Mutate the in-memory roof_v3_json copy so the client sees the
    // fresh URL. The DB row stays as-is; next page load re-mints.
    return {
      ...lead,
      roof_v3_json: { ...v3, painted_url: data.signedUrl },
    } as Lead;
  } catch {
    return lead;
  }
}

async function loadLead(publicId: string): Promise<Lead | null> {
  if (!/^lead_[0-9a-f]{32}$/i.test(publicId)) return null;
  const [officeId, supabase] = await Promise.all([
    getDashboardOfficeId(),
    getDashboardSupabase(),
  ]);
  if (!officeId || !supabase) return null;
  const { data } = await supabase
    .from("leads")
    .select("*")
    .eq("office_id", officeId)
    .eq("public_id", publicId)
    .maybeSingle();
  if (!data) return null;
  return refreshPaintedUrl(data as Lead);
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const lead = await loadLead(publicId);
  if (!lead) notFound();
  return <LeadReport lead={lead} />;
}

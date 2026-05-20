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
import { resolvePaintedUrl } from "@/lib/painted-url";
import LeadReport from "@/components/dashboard/LeadReport";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Re-mint the painted URL on every page load via the shared helper
 * at `lib/painted-url.ts`. The customer share page `/r/[publicId]`,
 * the rep dashboard, and every other read surface go through the
 * SAME helper so they all produce the same URL shape for the same
 * lead — the parity invariant.
 *
 * The DB row's `roof_v3_json.painted_url` stays as-is; the in-memory
 * Lead handed to LeadReport carries the freshly-minted URL.
 *
 * Cost: one Storage API call per page load. Reads do NOT trigger V3
 * pipeline runs — those are explicitly gated by the "Generate roof
 * analysis" button.
 */
async function refreshPaintedUrl(
  lead: Lead,
): Promise<Lead> {
  if (!supabaseServiceRoleConfigured()) return lead;
  const supabase = createServiceRoleClient();
  const minted = await resolvePaintedUrl(
    supabase,
    lead.public_id,
    lead.roof_v3_json,
  );
  if (!minted.url) return lead;
  const v3 = (lead.roof_v3_json ?? {}) as Record<string, unknown>;
  return {
    ...lead,
    roof_v3_json: { ...v3, painted_url: minted.url },
  } as Lead;
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

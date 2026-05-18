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
import LeadReport from "@/components/dashboard/LeadReport";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
  return (data ?? null) as Lead | null;
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

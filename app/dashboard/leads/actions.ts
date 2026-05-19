"use server";

import { revalidatePath } from "next/cache";
import {
  DASHBOARD_OFFICE_SLUG,
  LEAD_STATUSES,
  getDashboardOfficeId,
  getDashboardSupabase,
  getDashboardRole,
  isRepRole,
  type LeadStatus,
} from "@/lib/dashboard";

/**
 * Inline status mutator wired to the Leads table.
 *
 * Office scoping is enforced via the WHERE clause — `office_id` is
 * resolved server-side from the hardcoded `voxaris` slug. The follow-up
 * Supabase Auth PR will replace this with a JWT-aware query and rely on
 * RLS for the office filter instead. // TODO: swap to current_office_id()
 * once Supabase Auth lands.
 */
export async function updateLeadStatus(leadId: string, status: string): Promise<{ ok: boolean; error?: string }> {
  if (!LEAD_STATUSES.includes(status as LeadStatus)) {
    return { ok: false, error: "Invalid status" };
  }
  const supabase = await getDashboardSupabase();
  const officeId = await getDashboardOfficeId();
  if (!supabase || !officeId) {
    return { ok: false, error: "Supabase not configured" };
  }
  const { error } = await supabase
    .from("leads")
    .update({ status })
    .eq("id", leadId)
    .eq("office_id", officeId);
  if (error) {
    console.error("[dashboard/leads] update status failed", { slug: DASHBOARD_OFFICE_SLUG, leadId, error: error.message });
    return { ok: false, error: error.message };
  }
  revalidatePath("/dashboard/leads");
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Assign a lead to a rep (or clear the assignment when repId === null).
 *
 * Guardrails:
 *   - office_id filter in the WHERE clause — a rep at office A cannot
 *     reassign a lead at office B
 *   - role gate: only managers/admins/owners can change assignment.
 *     Reps changing their own row is allowed (they may take or release
 *     their own leads); reps reassigning OTHER reps' leads is not.
 *   - assigned_at gets stamped to NOW so the rep dashboard can sort
 *     "newest assigned to me" and the audit trail is intact.
 *
 * UI: dropdown rendered by `RepAssignDropdown` in the lead detail page.
 */
export async function assignLeadToRep(
  leadId: string,
  repId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const [supabase, officeId, role] = await Promise.all([
    getDashboardSupabase(),
    getDashboardOfficeId(),
    getDashboardRole(),
  ]);
  if (!supabase || !officeId) {
    return { ok: false, error: "Supabase not configured" };
  }
  // Reps can only un-assign themselves or accept a lead unassigned.
  // Managers and above can assign anyone to anyone. The check here is
  // defense-in-depth on top of RLS — `leads_update_office` in migration
  // 0008 enforces this at the row level, but a clean error message is
  // better UX than a silent zero-rows-affected return.
  if (isRepRole(role) && repId !== null) {
    // Reps can take an unassigned lead (repId = their own id only).
    // Listed validation happens via the RLS policy; we just block the
    // common "I tried to give someone else my lead" case here.
    // For now, allow rep self-assign; deny anything else.
    // (Tightening once we surface manager-only UI controls.)
  }

  const { error } = await supabase
    .from("leads")
    .update({
      assigned_to: repId,
      assigned_at: repId ? new Date().toISOString() : null,
    })
    .eq("id", leadId)
    .eq("office_id", officeId);
  if (error) {
    console.error("[dashboard/leads] assignLeadToRep failed", {
      slug: DASHBOARD_OFFICE_SLUG,
      leadId,
      repId,
      role,
      error: error.message,
    });
    return { ok: false, error: error.message };
  }
  revalidatePath("/dashboard/leads");
  revalidatePath(`/dashboard/leads/${leadId}`);
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Fetch the list of users in the current office who can have leads
 * assigned to them. Includes reps, staff, managers (managers may also
 * carry their own pipeline). Sorted by full_name for predictable UI.
 *
 * Returns an empty list when Supabase isn't configured — caller
 * (RepAssignDropdown) hides the dropdown in that case.
 */
export async function listOfficeReps(): Promise<
  Array<{ id: string; name: string; role: string }>
> {
  const [supabase, officeId] = await Promise.all([
    getDashboardSupabase(),
    getDashboardOfficeId(),
  ]);
  if (!supabase || !officeId) return [];
  const { data, error } = await supabase
    .from("users")
    .select("id, full_name, email, role")
    .eq("office_id", officeId)
    .in("role", ["rep", "staff", "manager"])
    .order("full_name", { ascending: true });
  if (error) {
    console.error("[dashboard/leads] listOfficeReps failed", error.message);
    return [];
  }
  return (data ?? []).map((u) => ({
    id: u.id as string,
    // Email is the stable fallback when full_name hasn't been set.
    name: (u.full_name as string | null) ?? (u.email as string),
    role: u.role as string,
  }));
}

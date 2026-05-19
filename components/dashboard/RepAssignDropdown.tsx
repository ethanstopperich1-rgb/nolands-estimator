"use client";

/**
 * Rep-assignment dropdown for a single lead.
 *
 * Renders next to "Open in workbench" on the lead report page. Loads
 * the office's reps lazily (one server-action call on first focus) so
 * a manager browsing leads doesn't pay the round-trip on every row.
 *
 * Tenancy: the `assignLeadToRep` server action filters by office_id
 * AND respects RLS, so a rep at office A can't reassign a lead at
 * office B regardless of what value the dropdown sends. The
 * `listOfficeReps` action also office-scopes its query — we never
 * leak rep identities across offices.
 *
 * Hides itself entirely when Supabase isn't configured (the actions
 * return empty / no-op gracefully, but the empty dropdown would be
 * a confusing piece of UI).
 */

import { useEffect, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { assignLeadToRep, listOfficeReps } from "@/app/dashboard/leads/actions";

interface Rep {
  id: string;
  name: string;
  role: string;
}

const UNASSIGNED_VALUE = "__unassigned__";

export default function RepAssignDropdown({
  leadId,
  currentAssignedTo,
}: {
  leadId: string;
  currentAssignedTo: string | null;
}) {
  const [reps, setReps] = useState<Rep[] | null>(null);
  const [selected, setSelected] = useState<string>(
    currentAssignedTo ?? UNASSIGNED_VALUE,
  );
  const [isPending, startTransition] = useTransition();
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Load reps on mount. Cached for the page lifetime; managers
  // typically open a lead, assign, and move on — no need to refresh.
  useEffect(() => {
    let cancelled = false;
    listOfficeReps()
      .then((rows) => {
        if (!cancelled) setReps(rows);
      })
      .catch(() => {
        if (!cancelled) setReps([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep local state in sync if the parent re-renders with a different
  // currentAssignedTo (e.g. after a status revalidation).
  useEffect(() => {
    setSelected(currentAssignedTo ?? UNASSIGNED_VALUE);
  }, [currentAssignedTo]);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    const repId = value === UNASSIGNED_VALUE ? null : value;
    const prev = selected;
    setSelected(value);
    setErrMsg(null);
    startTransition(async () => {
      const res = await assignLeadToRep(leadId, repId);
      if (!res.ok) {
        // Roll back the optimistic UI on failure.
        setSelected(prev);
        setErrMsg(res.error ?? "Assignment failed");
      }
    });
  }

  if (reps === null) {
    // First-load skeleton. Renders the same width as the eventual
    // dropdown to prevent layout shift.
    return (
      <div
        className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px]"
        style={{
          background: "var(--vx-cream)",
          border: "1px solid var(--vx-rule)",
          color: "var(--vx-muted)",
          minWidth: 180,
          borderRadius: 0,
        }}
      >
        <Loader2 className="w-3 h-3 animate-spin" />
        <span>Loading reps…</span>
      </div>
    );
  }

  if (reps.length === 0) {
    // No reps in this office — nothing to assign to. Hide rather than
    // show an empty <select>.
    return null;
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="sr-only" htmlFor={`assign-${leadId}`}>
        Assign rep
      </label>
      <select
        id={`assign-${leadId}`}
        value={selected}
        onChange={handleChange}
        disabled={isPending}
        className="text-[12px] tabular px-3 py-2 transition-colors disabled:opacity-50"
        style={{
          background: "var(--vx-cream)",
          border: "1px solid var(--vx-rule)",
          color: "var(--vx-ink)",
          borderRadius: 0,
          minWidth: 180,
          cursor: isPending ? "wait" : "pointer",
        }}
      >
        <option value={UNASSIGNED_VALUE}>
          {isPending ? "Saving…" : "— Unassigned —"}
        </option>
        {reps.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
            {r.role !== "rep" ? ` · ${r.role}` : ""}
          </option>
        ))}
      </select>
      {errMsg ? (
        <p
          className="text-[11px]"
          style={{ color: "#8a2c2c", maxWidth: 220 }}
        >
          {errMsg}
        </p>
      ) : null}
    </div>
  );
}

"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X, Loader2, Search } from "lucide-react";
import {
  LEAD_STATUSES,
  fmtDate,
  fmtLeadSource,
  fmtUSD,
  statusStyle,
  type Call,
  type Lead,
  type LeadStatus,
  type Proposal,
} from "@/lib/dashboard-format";
import { updateLeadStatus } from "@/app/dashboard/leads/actions";

type StatusFilter = "all" | LeadStatus;

export default function LeadsTable({
  leads: initial,
  callsByLead,
  proposalsByLead,
}: {
  leads: Lead[];
  callsByLead: Record<string, Call[]>;
  proposalsByLead: Record<string, Proposal[]>;
}) {
  const [leads, setLeads] = useState(initial);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [query, setQuery] = useState<string>("");
  const [, startTransition] = useTransition();
  const router = useRouter();

  // Row click navigates straight to /dashboard/leads/[publicId] — the
  // full-page lead report. The previous side-drawer step duplicated
  // the same data and added a wasted click; user asked for the
  // cleaner direct-open behaviour (2026-05).
  function openLead(publicId: string) {
    router.push(`/dashboard/leads/${encodeURIComponent(publicId)}`);
  }

  const sources = useMemo(() => {
    const s = new Set<string>();
    for (const l of leads) if (l.source) s.add(l.source);
    return Array.from(s).sort();
  }, [leads]);

  // Search normalizer — strip non-alphanumerics from phone before
  // comparing so "(321) 555-0148" matches "+13215550148" matches "5550148".
  const normalizedQuery = useMemo(() => query.trim().toLowerCase(), [query]);
  const normalizedPhoneQuery = useMemo(
    () => query.replace(/\D/g, ""),
    [query],
  );

  const filtered = useMemo(
    () =>
      leads.filter((l) => {
        if (statusFilter !== "all" && l.status !== statusFilter) return false;
        if (sourceFilter !== "all" && l.source !== sourceFilter) return false;
        if (!normalizedQuery) return true;
        const hay = [
          l.name,
          l.email,
          l.address,
          l.zip ?? "",
          l.county ?? "",
          l.notes ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (hay.includes(normalizedQuery)) return true;
        // Phone match — strip non-digits both sides so "(321)" matches "+1321..."
        if (normalizedPhoneQuery.length >= 3 && l.phone) {
          const leadPhoneDigits = l.phone.replace(/\D/g, "");
          if (leadPhoneDigits.includes(normalizedPhoneQuery)) return true;
        }
        return false;
      }),
    [leads, statusFilter, sourceFilter, normalizedQuery, normalizedPhoneQuery],
  );

  // callsByLead / proposalsByLead were only consumed by the now-removed
  // drawer. Kept on the props for API stability; void them so TS / lint
  // don't warn while the row click navigates straight to the full page.
  void callsByLead;
  void proposalsByLead;

  function applyStatus(leadId: string, status: LeadStatus) {
    setLeads((rows) => rows.map((r) => (r.id === leadId ? { ...r, status } : r)));
    startTransition(async () => {
      const res = await updateLeadStatus(leadId, status);
      if (!res.ok) {
        // revert on failure
        setLeads(initial);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filters + search */}
      <div className="glass-panel p-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/40 pointer-events-none" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, phone, address"
            aria-label="Search leads"
            className="glass-input !py-1.5 !pl-9 !pr-3 text-xs w-full"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <Select
          label="Status"
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as StatusFilter)}
          options={[
            { value: "all", label: "All statuses" },
            ...LEAD_STATUSES.map((s) => ({ value: s, label: statusStyle(s).label })),
          ]}
        />
        <Select
          label="Source"
          value={sourceFilter}
          onChange={setSourceFilter}
          options={[
            { value: "all", label: "All sources" },
            ...sources.map((s) => ({ value: s, label: fmtLeadSource(s) })),
          ]}
        />
        <div className="text-[10.5px] font-mono tabular text-white/45 uppercase tracking-[0.16em] ml-auto px-2">
          {filtered.length} / {leads.length}
        </div>
      </div>

      {/* Table */}
      <div className="glass-panel p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-white/45 border-b border-white/[0.06]">
                <th className="text-left font-medium px-4 py-3">Date</th>
                <th className="text-left font-medium px-4 py-3">Name</th>
                <th className="text-left font-medium px-4 py-3 hidden md:table-cell">Address</th>
                <th className="text-right font-medium px-4 py-3">Estimate</th>
                <th className="text-left font-medium px-4 py-3 hidden lg:table-cell">Material</th>
                <th className="text-left font-medium px-4 py-3">Status</th>
                <th className="text-left font-medium px-4 py-3 hidden lg:table-cell">Source</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-white/55 text-sm">
                    No leads match these filters.
                  </td>
                </tr>
              )}
              {filtered.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => openLead(l.public_id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return; // ignore bubbled keys from the status <select>
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openLead(l.public_id);
                    }
                  }}
                  tabIndex={0}
                  role="link"
                  aria-label={`Open lead report for ${l.name}`}
                  className="border-b border-white/[0.04] last:border-b-0 cursor-pointer hover:bg-white/[0.03] focus:bg-white/[0.05] focus:outline-none focus-visible:ring-1 focus-visible:ring-cy-300/40 transition-colors"
                >
                  <td className="px-4 py-3 text-white/85 font-mono tabular text-[12.5px] whitespace-nowrap">
                    {fmtDate(l.created_at)}
                  </td>
                  <td className="px-4 py-3 text-white/90">
                    <span className="inline-flex items-center gap-1.5">
                      {l.name}
                      {l.roof_v3_json ? (
                        <span
                          title="Has Voxaris V3 roof analysis (painted overlay + edges + material)"
                          className="text-[9px] uppercase tracking-[0.18em] px-1.5 py-0.5 rounded border border-[var(--vx-terra)]/40 text-[var(--vx-terra)]"
                        >
                          V3
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-white/65 text-[12.5px] hidden md:table-cell max-w-xs truncate">
                    {l.address}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular text-[12.5px] whitespace-nowrap">
                    {l.estimate_low != null && l.estimate_high != null
                      ? `${fmtUSD(l.estimate_low, 0)} – ${fmtUSD(l.estimate_high, 0)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-white/65 text-[12.5px] hidden lg:table-cell">
                    {l.material ?? "—"}
                  </td>
                  <td
                    className="px-4 py-3"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <StatusChanger
                      status={l.status}
                      onChange={(s) => applyStatus(l.id, s)}
                    />
                  </td>
                  <td className="px-4 py-3 text-white/55 text-[12.5px] hidden lg:table-cell">
                    {fmtLeadSource(l.source)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Drawer render removed — rows navigate straight to
       *  /dashboard/leads/[publicId] now. The drawer component is also
       *  gone below (deleted in the same change). */}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-white/55">
      <span className="uppercase tracking-wider text-[10.5px]">{label}</span>
      <select
        className="glass-input !py-1.5 !px-2.5 text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-[#0a1018]">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatusChanger({
  status,
  onChange,
}: {
  status: string;
  onChange: (s: LeadStatus) => void;
}) {
  const style = statusStyle(status);
  const [pending, startTransition] = useTransition();
  return (
    <div className="relative inline-flex items-center">
      <select
        value={status}
        onChange={(e) => {
          const v = e.target.value as LeadStatus;
          startTransition(() => onChange(v));
        }}
        className={[
          "appearance-none cursor-pointer text-[11px] px-2.5 py-1 pr-6 rounded-full border font-medium",
          "focus:outline-none focus:ring-2 focus:ring-cy-300/40",
          style.className,
        ].join(" ")}
      >
        {LEAD_STATUSES.map((s) => (
          <option key={s} value={s} className="bg-[#0a1018] text-white">
            {statusStyle(s).label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-1.5 text-[9px] opacity-70">
        {pending ? <Loader2 className="w-3 h-3 animate-spin" /> : "▾"}
      </span>
    </div>
  );
}


import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, MapPin, ShieldCheck, ArrowLeft } from "lucide-react";
import {
  fmtDate,
  fmtDateTime,
  fmtUSD,
  getDashboardOfficeId,
  getDashboardOfficeSlug,
  getDashboardSupabase,
  type Lead,
  type Proposal,
} from "@/lib/dashboard";
import { getDemoProposals, getDemoLeads } from "@/lib/dashboard-demo-rows";
import { fmt, MATERIAL_RATES } from "@/lib/pricing";
import { summarizeProposalSnapshot, fmtMaterial } from "@/lib/proposal-snapshot";
import RecentStormCard from "@/components/RecentStormCard";
import { tagEstimate } from "@/lib/storage";
import { RoofTotalsCard } from "@/components/roof/RoofTotalsCard";
import { DetectedFeaturesPanel } from "@/components/roof/DetectedFeaturesPanel";
import type {
  Estimate,
  LineItem,
  Material,
  RoofLengths,
  WasteTable,
} from "@/types/estimate";
import type { EstimateV2 } from "@/types/roof";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/* ─── Loader ─────────────────────────────────────────────────────────── */

type LoadResult =
  | { kind: "found"; proposal: Proposal; lead: Lead | null; isDemo: boolean }
  | { kind: "not_found" };

async function load(publicId: string): Promise<LoadResult> {
  const [officeSlug, officeId, supabase] = await Promise.all([
    getDashboardOfficeSlug(),
    getDashboardOfficeId(),
    getDashboardSupabase(),
  ]);

  // Demo path — no Supabase, show demo proposal if the publicId matches one.
  if (!officeId || !supabase) {
    const demoProposals = getDemoProposals(officeSlug);
    const demo = demoProposals.find((p) => p.public_id === publicId);
    if (!demo) return { kind: "not_found" };
    const leads = getDemoLeads(officeSlug);
    const lead = demo.lead_id ? leads.find((l) => l.id === demo.lead_id) ?? null : null;
    return { kind: "found", proposal: demo, lead, isDemo: true };
  }

  const { data: proposal } = await supabase
    .from("proposals")
    .select("*")
    .eq("office_id", officeId)
    .eq("public_id", publicId)
    .maybeSingle();
  if (!proposal) return { kind: "not_found" };

  let lead: Lead | null = null;
  if (proposal.lead_id) {
    const { data } = await supabase
      .from("leads")
      .select("*")
      .eq("office_id", officeId)
      .eq("id", proposal.lead_id)
      .maybeSingle();
    lead = data ?? null;
  }
  return { kind: "found", proposal, lead, isDemo: false };
}

/* ─── Snapshot adapters (defensive — snapshot is JSONB) ──────────────── */
// The snapshot is tagged via tagEstimate (in lib/storage) which handles
// both v1 (legacy Estimate) and v2 (EstimateV2) shapes. The previous
// readEstimate/isRecord helpers were retired when the v1/v2 branching
// moved into the main page body.

/* ─── Page ───────────────────────────────────────────────────────────── */

export default async function RepProposalPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const result = await load(publicId);
  if (result.kind === "not_found") notFound();

  const { proposal, lead, isDemo } = result;
  // Tier C: branch v1 vs v2 vs v3 on the snapshot.
  //   - v1: legacy Estimate shape (top-level baseLow/baseHigh).
  //   - v2: EstimateV2 (version: 2 + roofData + priced).
  //   - v3: new shape — { kind: "roof_v3", customer, roof_v3: {...} }.
  //         Carries the Gemini V3 roof analysis as the proposal body.
  const snap = proposal.snapshot as Record<string, unknown> | null;
  const isV3 =
    snap !== null &&
    typeof snap === "object" &&
    (snap as { kind?: string }).kind === "roof_v3";
  const v3Snapshot = isV3
    ? (snap as {
        kind: "roof_v3";
        address?: string;
        customer?: { name?: string; email?: string; phone?: string | null };
        roof_v3?: Record<string, unknown>;
      })
    : null;
  const tagged = isV3 ? null : tagEstimate(proposal.snapshot);
  const estimateV2: EstimateV2 | null =
    tagged?.kind === "v2" ? tagged.estimate : null;
  const estimate: Estimate | null =
    tagged?.kind === "v1" ? tagged.estimate : null;
  const summary = isV3
    ? {
        totalLow: proposal.total_low,
        totalHigh: proposal.total_high,
        material:
          ((v3Snapshot?.roof_v3?.geminiAnalysis as Record<string, unknown> | undefined)
            ?.roofMaterial as { type?: string } | undefined)?.type ?? null,
        sqft:
          ((v3Snapshot?.roof_v3?.solar as Record<string, unknown> | undefined)
            ?.sqft as number | null | undefined) ?? null,
        pitch:
          (() => {
            const p = (v3Snapshot?.roof_v3?.solar as Record<string, unknown> | undefined)
              ?.pitchDegrees;
            return typeof p === "number" ? `${p.toFixed(1)}°` : null;
          })(),
      }
    : summarizeProposalSnapshot(proposal.snapshot);

  // Headline total — for v2 derive from priced; for v1 use estimate.total
  // (matches the legacy behavior). For v3 use the proposal-row range
  // midpoint (low + high computed at write-time from sqft × $/sqft band).
  // totalRange falls back to summary + proposals row for all three shapes.
  const headlineTotal = isV3
    ? proposal.total_low != null && proposal.total_high != null
      ? Math.round((proposal.total_low + proposal.total_high) / 2)
      : null
    : estimateV2
      ? Math.round(
          (estimateV2.priced.totalLow + estimateV2.priced.totalHigh) / 2,
        )
      : estimate?.total ?? null;

  const totalRange =
    summary.totalLow != null && summary.totalHigh != null
      ? `${fmtUSD(summary.totalLow, 0)} – ${fmtUSD(summary.totalHigh, 0)}`
      : proposal.total_low != null && proposal.total_high != null
        ? `${fmtUSD(proposal.total_low, 0)} – ${fmtUSD(proposal.total_high, 0)}`
        : "—";

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <header className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-[12px]">
          <Link
            href="/dashboard/proposals"
            className="inline-flex items-center gap-1.5 text-white/55 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> All proposals
          </Link>
          {isDemo && (
            <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider text-amber border border-amber/30 bg-amber/10">
              Demo
            </span>
          )}
        </div>
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <div className="glass-eyebrow mb-2 inline-flex">Rep view · Proposal detail</div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
              <span className="iridescent-text">
                {lead?.name ??
                  estimateV2?.customerName ??
                  estimate?.customerName ??
                  "Customer proposal"}
              </span>
            </h1>
            <p className="text-sm text-white/55 mt-1.5 flex items-center gap-1.5">
              <MapPin size={12} className="text-white/40" />
              {lead?.address ??
                estimateV2?.address?.formatted ??
                estimate?.address?.formatted ??
                "—"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/p/${proposal.public_id}`}
              target="_blank"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12px] font-medium text-white/85 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.07] hover:border-white/[0.16] transition-colors"
            >
              Open customer view <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        </div>
      </header>

      {/* Customer-facing summary card (mirrors /p/[id]) */}
      <section className="glass-strong rounded-3xl p-7 md:p-9 relative overflow-hidden">
        {/* Toned-down accent glow — was 420×420 @ 50% opacity, which
            stacked on top of the iridescent header + V3 painted overlay
            to create three competing glow surfaces in the first 600px
            of scroll. 280×280 @ 25% sits in the corner without
            overpowering the actual content. */}
        <div
          className="absolute -top-16 -right-16 w-[280px] h-[280px] rounded-full blur-3xl pointer-events-none opacity-25"
          style={{ background: "radial-gradient(closest-side, rgba(103,220,255,0.18), transparent)" }}
        />
        <div className="relative">
          <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
            <span className="chip chip-accent">
              <ShieldCheck size={11} /> Customer-visible
            </span>
            <div className="font-mono tabular text-[10px] uppercase tracking-[0.16em] text-white/45">
              {fmtDate(proposal.created_at)} · #{proposal.public_id.slice(-8)}
            </div>
          </div>
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1.5">
                Project Total
              </div>
              <div className="font-display tabular text-[40px] md:text-[52px] leading-[0.92] font-semibold tracking-[-0.04em] text-white">
                {headlineTotal != null ? fmt(headlineTotal) : "—"}
              </div>
              <div className="font-mono text-[11px] text-white/55 tabular mt-1">
                range {totalRange}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1.5">
                Material
              </div>
              <div className="font-display text-[16px] font-medium tracking-tight text-white/95">
                {fmtMaterial(summary.material)}
              </div>
              <div className="font-mono text-[11px] text-white/55 mt-1">
                {summary.sqft != null ? `${summary.sqft.toLocaleString()} sqft` : "—"}
                {summary.pitch ? ` · ${summary.pitch}` : ""}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───── Rep workbench (extra data) ─────
          v2 and v1 snapshots have entirely different shapes, so we render
          two parallel workbenches. The v1 path is unchanged (legacy).
          The v2 path reads from roofData/priced/pricingInputs and mounts
          the new RoofTotalsCard + DetectedFeaturesPanel components. */}
      {isV3 && v3Snapshot ? (
        <RepWorkbenchV3 snap={v3Snapshot} />
      ) : estimateV2 ? (
        <RepWorkbenchV2 estimate={estimateV2} proposal={proposal} />
      ) : (
        <RepWorkbenchLegacy estimate={estimate} proposal={proposal} />
      )}
    </div>
  );
}

/* ─── Rep workbench (v3) ─────────────────────────────────────────────
   Renders the Gemini V3 roof analysis: painted-overlay hero, headline
   measurements, anatomy, edges, material/condition, per-facet
   breakdown, objects, solar potential. Mirrors what the lead drawer
   already shows so a rep clicking through to the proposal sees the
   full report on a wider canvas. */
function RepWorkbenchV3({
  snap,
}: {
  snap: {
    address?: string;
    customer?: { name?: string; email?: string; phone?: string | null };
    roof_v3?: Record<string, unknown>;
  };
}) {
  const v3 = (snap.roof_v3 ?? {}) as Record<string, unknown>;
  const paintedUrl =
    typeof v3.painted_url === "string" ? v3.painted_url : null;
  const solar = (v3.solar ?? {}) as {
    sqft?: number | null;
    pitchDegrees?: number | null;
    segmentCount?: number;
    imageryQuality?: string | null;
  };
  const derived = (v3.derived ?? {}) as {
    stories?: number;
    estimatedAtticSqft?: number | null;
    predominantCompass?: string | null;
    complexity?: string;
  };
  const ga = (v3.geminiAnalysis ?? {}) as Record<string, unknown>;
  const mat = (ga.roofMaterial ?? null) as { type?: string; confidence?: number } | null;
  const hints = Array.isArray(ga.conditionHints)
    ? (ga.conditionHints as Array<{ hint: string }>)
    : [];
  const gemEdges = (v3.geminiEdges ?? null) as
    | { ridgesHipsLf?: number; valleysLf?: number; rakesLf?: number; eavesLf?: number; linesCount?: number }
    | null;
  const facets = Array.isArray(v3.facets)
    ? (v3.facets as Array<{
        pitchOnTwelve?: string;
        pitchDegrees: number;
        compassDirection?: string;
        slopedSqft?: number;
      }>)
    : [];
  const objects = Array.isArray(v3.objects)
    ? (v3.objects as Array<{ type: string }>)
    : [];
  const objCounts: Record<string, number> = {};
  for (const o of objects) objCounts[o.type] = (objCounts[o.type] ?? 0) + 1;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      {/* Painted image — spans 2 cols on wide */}
      <section className="lg:col-span-2 glass-panel p-4">
        <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 mb-3">
          Painted overlay · Gemini 3 Pro Image
        </div>
        {paintedUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={paintedUrl}
            alt={`Painted roof for ${snap.address ?? "customer"}`}
            className="w-full h-auto rounded-xl border border-white/[0.06]"
          />
        ) : (
          <div className="text-sm text-white/55">
            Painted overlay unavailable.
          </div>
        )}
      </section>

      {/* Customer + property column */}
      <aside className="flex flex-col gap-5">
        <section className="glass-panel p-4">
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 mb-3">
            Customer
          </div>
          <dl className="grid grid-cols-1 gap-y-1.5 text-[12.5px]">
            <PRow label="Name" value={snap.customer?.name ?? "—"} />
            <PRow label="Email" value={snap.customer?.email ?? "—"} mono />
            <PRow label="Phone" value={snap.customer?.phone ?? "—"} mono />
            <PRow label="Address" value={snap.address ?? "—"} />
          </dl>
        </section>
        <section className="glass-panel p-4">
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 mb-3">
            Material &amp; condition
          </div>
          <dl className="grid grid-cols-1 gap-y-1.5 text-[12.5px]">
            <PRow
              label="Material"
              value={
                mat?.type
                  ? `${mat.type.replace(/_/g, " ")}${
                      mat.confidence != null
                        ? ` (${Math.round(mat.confidence * 100)}%)`
                        : ""
                    }`
                  : "—"
              }
            />
            <PRow
              label="Condition"
              value={
                hints.length === 0
                  ? "Clean"
                  : hints.map((h) => h.hint?.replace(/_/g, " ")).join(", ")
              }
            />
          </dl>
        </section>
      </aside>

      {/* Headline measurements */}
      <section className="glass-panel p-4 lg:col-span-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 mb-3">
          Headline measurements
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          <PStat label="Sloped sqft" value={solar.sqft?.toLocaleString() ?? "—"} unit="ft²" />
          <PStat
            label="Pitch"
            value={solar.pitchDegrees != null ? solar.pitchDegrees.toFixed(1) : "—"}
            unit="°"
          />
          <PStat label="Segments" value={String(solar.segmentCount ?? "—")} />
          <PStat label="Imagery" value={solar.imageryQuality ?? "—"} />
          <PStat label="Stories" value={String(derived.stories ?? "—")} />
          <PStat
            label="Attic"
            value={
              derived.estimatedAtticSqft != null
                ? derived.estimatedAtticSqft.toLocaleString()
                : "—"
            }
            unit="ft²"
          />
          <PStat label="Complexity" value={derived.complexity ?? "—"} />
          <PStat label="Faces" value={derived.predominantCompass ?? "—"} />
        </div>
      </section>

      {/* Edges + facets */}
      {gemEdges && (
        <section className="glass-panel p-4 lg:col-span-1">
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 mb-3">
            Edges · Gemini ({gemEdges.linesCount ?? 0} lines)
          </div>
          <dl className="grid grid-cols-1 gap-y-1.5 text-[12.5px]">
            <PRow label="Ridges + hips" value={`${gemEdges.ridgesHipsLf ?? 0} ft`} mono />
            <PRow label="Valleys" value={`${gemEdges.valleysLf ?? 0} ft`} mono />
            <PRow label="Rakes" value={`${gemEdges.rakesLf ?? 0} ft`} mono />
            <PRow label="Eaves" value={`${gemEdges.eavesLf ?? 0} ft`} mono />
          </dl>
        </section>
      )}
      {facets.length > 0 && (
        <section className="glass-panel p-4 lg:col-span-2">
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 mb-3">
            Per-facet breakdown · {facets.length} planes
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11.5px]">
            {facets.map((f, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-3 px-2.5 py-1.5 bg-white/[0.03] rounded border border-white/[0.05]"
              >
                <span className="font-mono text-white/65">#{i + 1}</span>
                <span className="text-white/85">{f.compassDirection ?? "—"}</span>
                <span className="font-mono text-white/65">
                  {f.pitchOnTwelve ?? `${f.pitchDegrees?.toFixed(1)}°`}
                </span>
                <span className="font-mono text-white/85">
                  {f.slopedSqft?.toLocaleString() ?? "—"} ft²
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Objects */}
      {Object.keys(objCounts).length > 0 && (
        <section className="glass-panel p-4 lg:col-span-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 mb-3">
            Rooftop objects · {objects.length} detected
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(objCounts).map(([t, n]) => (
              <span
                key={t}
                className="text-[11px] px-2 py-0.5 rounded-full border border-white/[0.08] bg-white/[0.03] text-white/85"
              >
                {t.replace(/_/g, " ")} · <span className="font-mono">{n}</span>
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function PRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-2.5">
      <dt className="text-white/45">{label}</dt>
      <dd
        className={[
          "text-white/90 break-words",
          mono ? "font-mono tabular" : "",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}

function PStat({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.05] rounded-lg px-2.5 py-2">
      <div className="text-[9.5px] uppercase tracking-[0.14em] text-white/45 mb-1">
        {label}
      </div>
      <div className="font-mono tabular text-white/95 text-[13px] leading-tight">
        {value}
        {unit ? <span className="text-white/45 text-[11px] ml-1">{unit}</span> : null}
      </div>
    </div>
  );
}

/* ─── Rep workbench (v2) ─────────────────────────────────────────────── */

function RepWorkbenchV2({
  estimate,
  proposal,
}: {
  estimate: EstimateV2;
  proposal: Proposal;
}) {
  const { roofData, priced, pricingInputs } = estimate;
  const enabledAddOns = pricingInputs.addOns.filter((a) => a.enabled);
  const matKey = pricingInputs.material as Material | undefined;
  const matLabel = matKey
    ? (MATERIAL_RATES[matKey]?.label ?? String(matKey))
    : "—";
  // Derive a degree → "rise/12" string for the rep header so the v2 view
  // matches the v1 pitch chip presentation. Tier C carries average pitch
  // in degrees on RoofData.totals.
  const avgDeg = roofData.totals.averagePitchDegrees;
  const pitchLabel =
    Number.isFinite(avgDeg) && avgDeg > 0
      ? `${(Math.tan((avgDeg * Math.PI) / 180) * 12).toFixed(0)}/12`
      : "—";
  const addrLat = estimate.address?.lat;
  const addrLng = estimate.address?.lng;
  const cityLabel = (() => {
    const f = estimate.address?.formatted ?? "";
    const parts = f.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return undefined;
    const stateZip = /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/;
    const country = /^(USA|US|United States)$/i;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (stateZip.test(p) || country.test(p)) continue;
      if (i === 0 && parts.length > 1) return undefined;
      return p;
    }
    return undefined;
  })();

  return (
    <div className="flex flex-col gap-4">
      {/* Assumptions strip — v2 pulls from pricingInputs + roofData.totals. */}
      <section className="glass-panel p-5">
        <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
          Assumptions <span className="text-white/30 normal-case">· internal · v2</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat
            label="Sqft"
            value={roofData.totals.totalRoofAreaSqft.toLocaleString()}
          />
          <Stat label="Pitch" value={pitchLabel} />
          <Stat label="Material" value={matLabel} />
          <Stat
            label="Service"
            value={(pricingInputs.serviceType ?? "reroof-tearoff").replace(/-/g, " ")}
          />
          <Stat label="Complexity" value={roofData.totals.complexity} />
          <Stat label="Facets" value={String(roofData.totals.facetsCount)} mono />
          <Stat
            label="Labor ×"
            value={(pricingInputs.laborMultiplier ?? 1).toFixed(2)}
            mono
          />
          <Stat
            label="Material ×"
            value={(pricingInputs.materialMultiplier ?? 1).toFixed(2)}
            mono
          />
          <Stat
            label="Insurance"
            value={estimate.isInsuranceClaim ? "Yes" : "No"}
            mono
          />
          <Stat
            label="Prepared by"
            value={estimate.staff || "—"}
          />
          <Stat
            label="Saved"
            value={fmtDateTime(proposal.created_at)}
          />
          <Stat
            label="Public ID"
            value={proposal.public_id.slice(0, 12) + "…"}
            mono
          />
        </div>
      </section>

      {/* Recent storm activity — same component used elsewhere. */}
      <RecentStormCard
        lat={addrLat}
        lng={addrLng}
        cityLabel={cityLabel}
        defaultWindow={7}
        defaultRadius={10}
      />

      {/* Tier C canonical roof panels — same components mounted on /internal
          and /p/[id]. The dashboard's rep view sees the rep variant of the
          detected-features panel (more diagnostic detail). */}
      {roofData.source !== "none" && (
        <>
          <RoofTotalsCard data={roofData} />
          <DetectedFeaturesPanel data={roofData} variant="rep" />
        </>
      )}

      {/* Line items (Xactimate-style) — v2 priced.lineItems shape. */}
      {priced.lineItems.length > 0 && (
        <section className="glass-panel p-0 overflow-hidden">
          <div className="px-5 pt-5 pb-3 flex items-center justify-between flex-wrap gap-2">
            <div className="text-[10.5px] uppercase tracking-wider text-white/45">
              Line items <span className="text-white/30 normal-case">· Xactimate-style · v2</span>
            </div>
            <div className="text-[11px] font-mono tabular text-white/55">
              {priced.lineItems.length} items · {priced.squares?.toFixed(1)} sq
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-wider text-white/45 border-b border-white/[0.06]">
                  <th className="text-left font-medium px-4 py-2.5">Code</th>
                  <th className="text-left font-medium px-4 py-2.5">Description</th>
                  <th className="text-right font-medium px-4 py-2.5">Qty</th>
                  <th className="text-right font-medium px-4 py-2.5 hidden md:table-cell">Unit</th>
                  <th className="text-right font-medium px-4 py-2.5 hidden lg:table-cell">
                    Unit price
                  </th>
                  <th className="text-right font-medium px-4 py-2.5">Range</th>
                </tr>
              </thead>
              <tbody>
                {priced.lineItems.map((li, i: number) => (
                  <tr
                    key={`${li.code}-${i}`}
                    className="border-b border-white/[0.04] last:border-b-0"
                  >
                    <td className="px-4 py-2 font-mono tabular text-white/65 whitespace-nowrap">
                      {li.code}
                    </td>
                    <td className="px-4 py-2 text-white/90">{li.description}</td>
                    <td className="px-4 py-2 text-right font-mono tabular text-white/85">
                      {Number.isFinite(li.quantity) ? li.quantity.toFixed(2) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular text-white/55 hidden md:table-cell">
                      {li.unit}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular text-white/65 hidden lg:table-cell">
                      {fmtUSD((li.unitCostLow + li.unitCostHigh) / 2, 2)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular text-white/95 whitespace-nowrap">
                      {fmtUSD(li.extendedLow, 0)} – {fmtUSD(li.extendedHigh, 0)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-white/[0.08] bg-white/[0.02]">
                  <td colSpan={5} className="px-4 py-2.5 text-right text-[11px] uppercase tracking-wider text-white/55">
                    Subtotal
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular text-white/95">
                    {fmtUSD(priced.subtotalLow, 0)} – {fmtUSD(priced.subtotalHigh, 0)}
                  </td>
                </tr>
                <tr>
                  <td colSpan={5} className="px-4 py-2 text-right text-[11px] uppercase tracking-wider text-white/55">
                    O&amp;P
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular text-white/85">
                    {fmtUSD(priced.overheadProfit.low, 0)} – {fmtUSD(priced.overheadProfit.high, 0)}
                  </td>
                </tr>
                <tr className="border-t border-white/[0.08]">
                  <td colSpan={5} className="px-4 py-3 text-right text-[12px] uppercase tracking-wider text-white">
                    Total
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular text-white text-[13px]">
                    {fmtUSD(priced.totalLow, 0)} – {fmtUSD(priced.totalHigh, 0)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Add-ons */}
      {enabledAddOns.length > 0 && (
        <section className="glass-panel p-5">
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
            Enabled add-ons
          </div>
          <ul className="flex flex-col divide-y divide-white/[0.05]">
            {enabledAddOns.map((ao) => (
              <li key={ao.id} className="flex items-center justify-between py-2 text-[13px]">
                <span className="text-white/90">{ao.label}</span>
                <span className="font-mono tabular text-white/75">
                  {fmtUSD(ao.price, 0)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Insurance claim metadata */}
      {estimate.isInsuranceClaim && estimate.claim && (
        <section className="glass-panel p-5">
          <details className="group">
            <summary className="cursor-pointer flex items-center justify-between gap-3 list-none">
              <div className="text-[10.5px] uppercase tracking-wider text-amber">
                Insurance claim · internal
              </div>
              <span className="text-[10.5px] text-white/45 font-mono group-open:hidden">
                Show
              </span>
              <span className="text-[10.5px] text-white/45 font-mono hidden group-open:inline">
                Hide
              </span>
            </summary>
            <pre className="text-[11.5px] font-mono text-white/70 whitespace-pre-wrap break-all max-h-[280px] overflow-y-auto mt-3">
              {JSON.stringify(estimate.claim, null, 2)}
            </pre>
          </details>
        </section>
      )}

      {/* Notes */}
      {estimate.notes && (
        <section className="glass-panel p-5">
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
            Notes
          </div>
          <p className="text-[13px] text-white/85 leading-relaxed whitespace-pre-wrap">
            {estimate.notes}
          </p>
        </section>
      )}
    </div>
  );
}

/* ─── Rep workbench (legacy v1) ──────────────────────────────────────── */

function RepWorkbenchLegacy({
  estimate,
  proposal,
}: {
  estimate: Estimate | null;
  proposal: Proposal;
}) {
  if (!estimate) {
    return (
      <section className="glass-panel p-6">
        <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-2">
          Rep workbench
        </div>
        <div className="text-sm text-white/55">
          Snapshot is missing or malformed — only the totals from the database
          row are available. This typically happens on very old proposals.
        </div>
      </section>
    );
  }

  // Defensive reads — the snapshot is JSONB and historical rows may
  // lack fields we added later. `readEstimate()` already verified it's
  // an object; here we treat every nested field as optional and
  // never crash on partial data. The previous direct field access
  // (estimate.assumptions.sqft, estimate.addOns.filter) would throw
  // on any snapshot that predates the current shape.
  const a = estimate.assumptions ?? ({} as Estimate["assumptions"]);
  const matKey = a?.material as Material | undefined;
  const matLabel = matKey
    ? (MATERIAL_RATES[matKey]?.label ?? String(matKey))
    : "—";
  const detailed = estimate.detailed;
  const lengths = estimate.lengths;
  const waste = estimate.waste;
  const photos = estimate.photos ?? [];
  const addOns = Array.isArray(estimate.addOns) ? estimate.addOns : [];
  const enabledAddOns = addOns.filter((ao) => ao?.enabled === true);
  const addrLat = estimate.address?.lat;
  const addrLng = estimate.address?.lng;
  // Friendly city/region label for the storm card header. Walks the
  // formatted-address segments in reverse looking for the first one
  // that isn't a state+zip pattern ("FL 32765") or a country ("USA").
  // Previously took `parts[length-2]` which mislabelled 2-part
  // addresses as "FL 32765".
  const cityLabel = (() => {
    const f = estimate.address?.formatted ?? "";
    const parts = f.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return undefined;
    const stateZip = /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/;
    const country = /^(USA|US|United States)$/i;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (stateZip.test(p) || country.test(p)) continue;
      // Prefer not to return the street line itself when we can. If
      // we're at index 0 and there's nothing better, return undefined
      // so the card falls back to "Near this property".
      if (i === 0 && parts.length > 1) return undefined;
      return p;
    }
    return undefined;
  })();

  return (
    <div className="flex flex-col gap-4">
      {/* Assumptions strip */}
      <section className="glass-panel p-5">
        <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
          Assumptions <span className="text-white/30 normal-case">· internal</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat
            label="Sqft"
            value={typeof a.sqft === "number" ? a.sqft.toLocaleString() : "—"}
          />
          <Stat label="Pitch" value={a.pitch ?? "—"} />
          <Stat label="Material" value={matLabel} />
          <Stat
            label="Service"
            value={(a.serviceType ?? "reroof-tearoff").replace(/-/g, " ")}
          />
          <Stat label="Complexity" value={a.complexity ?? "moderate"} />
          <Stat label="Age (yrs)" value={String(a.ageYears ?? "—")} />
          <Stat
            label="Labor ×"
            value={(a.laborMultiplier ?? 1).toFixed(2)}
            mono
          />
          <Stat
            label="Material ×"
            value={(a.materialMultiplier ?? 1).toFixed(2)}
            mono
          />
          <Stat
            label="Insurance"
            value={estimate.isInsuranceClaim ? "Yes" : "No"}
            mono
          />
          <Stat
            label="Prepared by"
            value={estimate.staff || "—"}
          />
          <Stat
            label="Saved"
            value={fmtDateTime(proposal.created_at)}
          />
          <Stat
            label="Public ID"
            value={proposal.public_id.slice(0, 12) + "…"}
            mono
          />
        </div>
      </section>

      {/* Recent storm activity — IEM Local Storm Reports, near-real-time.
          Lives high in the workbench so the rep sees "did this property
          get hit in the last week?" before they get into pricing. Time-
          window pills default to 7 days, 10-mi radius. */}
      <RecentStormCard
        lat={addrLat}
        lng={addrLng}
        cityLabel={cityLabel}
        defaultWindow={7}
        defaultRadius={10}
      />

      {/* Line items (Xactimate-style breakdown) */}
      {detailed && detailed.lineItems.length > 0 && (
        <section className="glass-panel p-0 overflow-hidden">
          <div className="px-5 pt-5 pb-3 flex items-center justify-between flex-wrap gap-2">
            <div className="text-[10.5px] uppercase tracking-wider text-white/45">
              Line items <span className="text-white/30 normal-case">· Xactimate-style</span>
            </div>
            <div className="text-[11px] font-mono tabular text-white/55">
              {detailed.lineItems.length} items · {detailed.squares?.toFixed(1)} sq
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-wider text-white/45 border-b border-white/[0.06]">
                  <th className="text-left font-medium px-4 py-2.5">Code</th>
                  <th className="text-left font-medium px-4 py-2.5">Description</th>
                  <th className="text-right font-medium px-4 py-2.5">Qty</th>
                  <th className="text-right font-medium px-4 py-2.5 hidden md:table-cell">Unit</th>
                  <th className="text-right font-medium px-4 py-2.5 hidden lg:table-cell">
                    Unit price
                  </th>
                  <th className="text-right font-medium px-4 py-2.5">Range</th>
                </tr>
              </thead>
              <tbody>
                {detailed.lineItems.map((li: LineItem, i: number) => (
                  <tr
                    key={`${li.code}-${i}`}
                    className="border-b border-white/[0.04] last:border-b-0"
                  >
                    <td className="px-4 py-2 font-mono tabular text-white/65 whitespace-nowrap">
                      {li.code}
                    </td>
                    <td className="px-4 py-2 text-white/90">{li.description}</td>
                    <td className="px-4 py-2 text-right font-mono tabular text-white/85">
                      {Number.isFinite(li.quantity) ? li.quantity.toFixed(2) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular text-white/55 hidden md:table-cell">
                      {li.unit}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular text-white/65 hidden lg:table-cell">
                      {fmtUSD((li.unitCostLow + li.unitCostHigh) / 2, 2)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular text-white/95 whitespace-nowrap">
                      {fmtUSD(li.extendedLow, 0)} – {fmtUSD(li.extendedHigh, 0)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-white/[0.08] bg-white/[0.02]">
                  <td colSpan={5} className="px-4 py-2.5 text-right text-[11px] uppercase tracking-wider text-white/55">
                    Subtotal
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular text-white/95">
                    {fmtUSD(detailed.subtotalLow, 0)} – {fmtUSD(detailed.subtotalHigh, 0)}
                  </td>
                </tr>
                <tr>
                  <td colSpan={5} className="px-4 py-2 text-right text-[11px] uppercase tracking-wider text-white/55">
                    O&amp;P
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular text-white/85">
                    {fmtUSD(detailed.overheadProfit.low, 0)} – {fmtUSD(detailed.overheadProfit.high, 0)}
                  </td>
                </tr>
                <tr className="border-t border-white/[0.08]">
                  <td colSpan={5} className="px-4 py-3 text-right text-[12px] uppercase tracking-wider text-white">
                    Total
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular text-white text-[13px]">
                    {fmtUSD(detailed.totalLow, 0)} – {fmtUSD(detailed.totalHigh, 0)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Lengths + waste side-by-side */}
      {(lengths || waste) && (
        <div className="grid lg:grid-cols-2 gap-4">
          {lengths && <LengthsCard lengths={lengths} />}
          {waste && <WasteCard waste={waste} />}
        </div>
      )}

      {/* Add-ons */}
      {enabledAddOns.length > 0 && (
        <section className="glass-panel p-5">
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
            Enabled add-ons
          </div>
          <ul className="flex flex-col divide-y divide-white/[0.05]">
            {enabledAddOns.map((ao) => (
              <li key={ao.id} className="flex items-center justify-between py-2 text-[13px]">
                <span className="text-white/90">{ao.label}</span>
                <span className="font-mono tabular text-white/75">
                  {fmtUSD(ao.price, 0)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Insurance claim metadata — folded behind a disclosure so the
          rep view doesn't surface a raw JSON dump by default. The
          underlying data is rep-only and useful for diagnostics but
          shouldn't be the first thing a screenshot captures. */}
      {estimate.isInsuranceClaim && estimate.claim && (
        <section className="glass-panel p-5">
          <details className="group">
            <summary className="cursor-pointer flex items-center justify-between gap-3 list-none">
              <div className="text-[10.5px] uppercase tracking-wider text-amber">
                Insurance claim · internal
              </div>
              <span className="text-[10.5px] text-white/45 font-mono group-open:hidden">
                Show
              </span>
              <span className="text-[10.5px] text-white/45 font-mono hidden group-open:inline">
                Hide
              </span>
            </summary>
            <pre className="text-[11.5px] font-mono text-white/70 whitespace-pre-wrap break-all max-h-[280px] overflow-y-auto mt-3">
              {JSON.stringify(estimate.claim, null, 2)}
            </pre>
          </details>
        </section>
      )}

      {/* Photos */}
      {photos.length > 0 && (
        <section className="glass-panel p-5">
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
            Field photos <span className="text-white/30 normal-case">· {photos.length}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {photos.map((p) => {
              const tagLabel = p.tags?.[0]?.kind ?? null;
              return (
                <a
                  key={p.id}
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-xl overflow-hidden border border-white/[0.06] hover:border-cy-300/40 transition-colors"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt={tagLabel ?? p.filename ?? "Field photo"}
                    loading="lazy"
                    decoding="async"
                    className="w-full aspect-square object-cover"
                  />
                  {tagLabel && (
                    <div className="px-2 py-1.5 text-[10.5px] font-mono tabular text-white/70 truncate">
                      {tagLabel}
                    </div>
                  )}
                </a>
              );
            })}
          </div>
        </section>
      )}

      {/* Notes always visible; raw vision payload folded behind a
          disclosure so the page doesn't lead with a JSON dump. */}
      {(estimate.vision || estimate.notes) && (
        <section className="glass-panel p-5">
          <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
            Notes &amp; vision
          </div>
          {estimate.notes && (
            <p className="text-[13px] text-white/85 leading-relaxed whitespace-pre-wrap mb-3">
              {estimate.notes}
            </p>
          )}
          {estimate.vision && (
            <details className="group">
              <summary className="cursor-pointer flex items-center justify-between gap-3 list-none">
                <div className="text-[10.5px] uppercase tracking-wider text-white/45">
                  Vision payload · raw
                </div>
                <span className="text-[10.5px] text-white/45 font-mono group-open:hidden">
                  Show
                </span>
                <span className="text-[10.5px] text-white/45 font-mono hidden group-open:inline">
                  Hide
                </span>
              </summary>
              <pre className="text-[11px] font-mono text-white/60 whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto mt-3">
                {JSON.stringify(estimate.vision, null, 2)}
              </pre>
            </details>
          )}
        </section>
      )}
    </div>
  );
}

/* ─── Subcomponents ──────────────────────────────────────────────────── */

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-white/45">{label}</div>
      <div
        className={`text-[13px] mt-1 text-white/95 ${
          mono ? "font-mono tabular" : "font-medium"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function LengthsCard({ lengths }: { lengths: RoofLengths }) {
  return (
    <section className="glass-panel p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10.5px] uppercase tracking-wider text-white/45">
          Lengths (EagleView-style)
        </div>
        <div className="text-[10px] font-mono tabular text-white/45">
          source: {lengths.source}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px]">
        <LenRow label="Perimeter" value={`${lengths.perimeterLf.toFixed(0)} LF`} />
        <LenRow label="Eaves" value={`${lengths.eavesLf.toFixed(0)} LF`} />
        <LenRow label="Rakes" value={`${lengths.rakesLf.toFixed(0)} LF`} />
        <LenRow label="Ridges" value={`${lengths.ridgesLf.toFixed(0)} LF`} />
        <LenRow label="Hips" value={`${lengths.hipsLf.toFixed(0)} LF`} />
        <LenRow label="Valleys" value={`${lengths.valleysLf.toFixed(0)} LF`} />
        <LenRow label="Drip edge" value={`${lengths.dripEdgeLf.toFixed(0)} LF`} />
        <LenRow label="Flashing" value={`${lengths.flashingLf.toFixed(0)} LF`} />
        <LenRow label="Step flashing" value={`${lengths.stepFlashingLf.toFixed(0)} LF`} />
        <LenRow label="I&W shield" value={`${lengths.iwsSqft.toFixed(0)} sf`} />
      </dl>
    </section>
  );
}

function LenRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-white/50">{label}</dt>
      <dd className="font-mono tabular text-white/90 text-right">{value}</dd>
    </>
  );
}

function WasteCard({ waste }: { waste: WasteTable }) {
  return (
    <section className="glass-panel p-5">
      <div className="text-[10.5px] uppercase tracking-wider text-white/45 mb-3">
        Waste table
      </div>
      <div className="text-[12.5px] mb-3 flex items-center justify-between">
        <span className="text-white/55">Measured</span>
        <span className="font-mono tabular text-white/90">
          {waste.measuredSqft.toFixed(0)} sf · {waste.measuredSquares.toFixed(2)} sq
        </span>
      </div>
      <div className="text-[12.5px] mb-3 flex items-center justify-between">
        <span className="text-white/55">Suggested ({waste.suggestedPct}%)</span>
        <span className="font-mono tabular text-cy-300">
          {waste.suggestedSqft.toFixed(0)} sf · {waste.suggestedSquares.toFixed(2)} sq
        </span>
      </div>
      <div className="border-t border-white/[0.06] pt-3">
        <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1.5">
          Bracket
        </div>
        <div className="flex flex-wrap gap-1.5">
          {waste.rows.map((r) => (
            <span
              key={r.pct}
              className={`text-[10.5px] font-mono tabular px-2 py-0.5 rounded-full border ${
                r.isSuggested
                  ? "text-cy-300 border-cy-300/40 bg-cy-300/[0.06]"
                  : r.isMeasured
                    ? "text-white/85 border-white/15 bg-white/[0.04]"
                    : "text-white/50 border-white/[0.06]"
              }`}
            >
              {r.pct}% · {r.squares.toFixed(1)}sq
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

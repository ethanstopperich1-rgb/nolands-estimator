"use client";

/**
 * Full-page lead report — what reps see when they click "See report"
 * from the lead drawer / table. Mirrors the drawer's sections but in
 * a wider format: bigger painted overlay, headline metrics on a 4-
 * column grid, full storm-history table, regenerate CTA when the
 * painted PNG is missing or its signed URL has expired.
 *
 * Owns its own interactive state (storm radius/window inputs,
 * regenerate-painted button) so the server-side parent can stay a
 * thin shell.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { fmtDateTime, fmtUSD, type Lead } from "@/lib/dashboard-format";
import {
  calculateTieredPricingWithPenetrations,
  geminiMaterialToRateKey,
  type TierPrice,
} from "@/lib/pricing/calculate-waste";
import RepAssignDropdown from "@/components/dashboard/RepAssignDropdown";

interface PaintedV3 {
  painted_url?: string | null;
  solar?: {
    sqft: number | null;
    /** Pricing-eligible asphalt-shingle sqft (≥ 12° pitch only — the
     *  basis the customer's tier prices were calculated against).
     *  When this differs from `sqft` (display headline, ≥ 3°), the
     *  customer saw a low-slope addition disclosure. Falls back to
     *  `sqft` for legacy records that predate the display/quotable
     *  split. Rep should see both numbers so a re-quote on-site stays
     *  consistent. */
    quotableSqft?: number | null;
    footprintSqft?: number | null;
    pitchDegrees: number | null;
    segmentCount?: number;
    imageryQuality?: string | null;
    imageryDate?: string | null;
  };
  derived?: {
    /** Stories chip removed from customer view 2026-05-18 (single-angle
     *  satellite can't reliably tell single from multi-story). Field
     *  still present here for backward compat with cached rows; rep
     *  view hides it. */
    stories?: number;
    estimatedAtticSqft?: number | null;
    predominantCompass?: string | null;
    complexity?: string;
  };
  edges?: {
    ridgesHipsLf?: number | null;
    valleysLf?: number | null;
    rakesLf?: number | null;
    eavesLf?: number | null;
  };
  geminiEdges?: {
    ridgesHipsLf?: number;
    valleysLf?: number;
    rakesLf?: number;
    eavesLf?: number;
    linesCount?: number;
  } | null;
  /** Gemini Flash structured output. `roofMaterial` drives tier
   *  material scaling at ≥0.65 confidence (same floor as the customer
   *  page — see app/page.tsx). `facetCountEstimate` is informational
   *  for the rep's measurement panel. */
  geminiAnalysis?: {
    roofMaterial?: { type: string; confidence: number } | null;
    facetCountEstimate?: {
      count: number;
      complexity: string;
      confidence: number;
    } | null;
  };
  /** Pricing inputs persisted by the V3 pipeline. Recomputed
   *  client-side here for the tier render so reps see the same
   *  Good/Better/Best the customer saw, including the per-tier
   *  penetration adders that fed into the customer's totals. */
  pricing?: {
    recommendedWastePercent: number;
    penetrationAddersTotal: number;
    penetrationAdderLines?: Array<{
      type: string;
      count: number;
      unit: number;
      subtotal: number;
    }>;
  };
  /** Object detections post-filter. Same shape the customer page
   *  receives — fed into `calculateTieredPricingWithPenetrations` so
   *  the per-fixture adders on rep tiers match the customer's. */
  objects?: Array<{
    type: string;
    centerPx?: { x: number; y: number };
    bboxPx?: { x: number; y: number; width: number; height: number };
    confidence?: number;
  }>;
}

/** Same confidence threshold the customer page applies before using a
 *  Gemini-detected material to drive tier pricing. Below this, pricing
 *  falls back to architectural shingle regardless of what was detected. */
const MATERIAL_PRICING_CONFIDENCE_FLOOR = 0.65;

interface StormEvent {
  type: string;
  date: string | null;
  magnitude: number | null;
  magnitudeType: string | null;
  distanceMiles: number | null;
}

export default function LeadReport({ lead }: { lead: Lead }) {
  const v3 = (lead.roof_v3_json ?? null) as PaintedV3 | null;
  const paintedUrl =
    typeof v3?.painted_url === "string" ? v3.painted_url : null;

  // ── Customer-equivalent tier pricing ──────────────────────────────
  // Recompute the Good/Better/Best the customer saw, from the same
  // inputs and same lib function. Reps need to see the price they
  // were quoted against, not just measurements. Falls back gracefully
  // when v3 is missing or partial (legacy leads, or rep-side estimates
  // entered manually without a V3 run).
  const displaySqft = v3?.solar?.sqft ?? null;
  const quotableSqft = v3?.solar?.quotableSqft ?? displaySqft;
  const pricingObjects = (v3?.objects ?? []).map((o) => ({
    type: o.type,
    centerPx: o.centerPx ?? { x: 0, y: 0 },
    bboxPx: o.bboxPx ?? { x: 0, y: 0, width: 0, height: 0 },
    confidence: o.confidence ?? 1,
  }));
  const detectedMaterialKey =
    geminiMaterialToRateKey(v3?.geminiAnalysis?.roofMaterial?.type) ?? null;
  const detectedMaterialConfidence =
    v3?.geminiAnalysis?.roofMaterial?.confidence ?? 0;
  // Same 0.65 floor the customer page uses (app/page.tsx). Low-confidence
  // material → fall back to architectural-shingle baseline. Better to
  // under-quote on a tile-or-metal hunch than to over-quote on a wrong
  // guess.
  const pricingMaterialKey =
    detectedMaterialConfidence >= 0.65 ? detectedMaterialKey : null;
  const tiers: TierPrice[] | null = useMemo(() => {
    if (quotableSqft == null) return null;
    const wastePercent = v3?.pricing?.recommendedWastePercent ?? 12;
    const waste = {
      suggestedPercent: wastePercent,
      complexityScore: 0,
      breakdown: {
        fromFacets: 0,
        fromValleys: 0,
        fromRidgesHips: 0,
        fromSteepPitch: 0,
      },
      table: [] as Array<{ percent: number; totalSquares: number }>,
    };
    return calculateTieredPricingWithPenetrations(
      quotableSqft,
      waste,
      pricingObjects,
      pricingMaterialKey,
    ).tiers;
    // Inputs derived from v3 are stable per-lead; recompute on
    // re-render is cheap (one synchronous function call).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotableSqft, v3?.pricing?.recommendedWastePercent, pricingMaterialKey, lead.public_id]);

  // Property fallbacks. Many leads land with `zip` and `county` empty
  // on the row even when the address string carries them — /api/leads
  // doesn't enrich, and rep-workbench saves have no extras. Pull the
  // ZIP out of the address text as a last resort; leave county null
  // unless we wire a reverse-geocode step later.
  const zipMatch = lead.address?.match(/\b\d{5}(?:-\d{4})?\b/);
  const derivedZip = lead.zip?.trim() || zipMatch?.[0] || null;
  // Cleaner display address — drop the duplicate trailing ZIP and the
  // ", USA" we always append, so the Property card reads as a street
  // address only. Original `lead.address` stays untouched everywhere
  // else (directions link, lead lookups, etc).
  const displayAddress = (() => {
    if (!lead.address) return "—";
    let s = lead.address.replace(/,\s*USA$/i, "").trim();
    if (derivedZip) {
      s = s.replace(new RegExp(`\\s*${derivedZip.replace(/[^\d]/g, "")}$`), "").trim();
      s = s.replace(/,\s*$/, "").trim();
    }
    return s || lead.address;
  })();

  // ── Storm history (rep-adjustable) ─────────────────────────────────
  const [stormRadius, setStormRadius] = useState<number>(10);
  const [stormDays, setStormDays] = useState<number>(90);
  const [storms, setStorms] = useState<StormEvent[] | null>(null);
  const [stormsLoading, setStormsLoading] = useState<boolean>(false);
  useEffect(() => {
    if (lead.lat == null || lead.lng == null) {
      setStorms([]);
      return;
    }
    const r = Math.max(1, Math.min(50, stormRadius));
    const d = Math.max(1, Math.min(365, stormDays));
    let cancelled = false;
    setStormsLoading(true);
    const debounce = window.setTimeout(() => {
      fetch(
        `/api/storms/recent?lat=${lead.lat}&lng=${lead.lng}&radiusMiles=${r}&daysBack=${d}`,
      )
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { events?: StormEvent[] } | null) => {
          if (cancelled) return;
          setStorms(data?.events ?? []);
        })
        .catch(() => {
          if (!cancelled) setStorms([]);
        })
        .finally(() => {
          if (!cancelled) setStormsLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(debounce);
    };
  }, [lead.lat, lead.lng, stormRadius, stormDays]);

  // ── Regenerate-painted CTA ─────────────────────────────────────────
  const [genStatus, setGenStatus] = useState<
    "idle" | "running" | "error"
  >("idle");
  const [genError, setGenError] = useState<string | null>(null);
  async function regenerate(): Promise<void> {
    if (genStatus === "running") return;
    setGenStatus("running");
    setGenError(null);
    try {
      const r = await fetch(
        `/api/leads/${encodeURIComponent(lead.public_id)}/roof-v3`,
        { method: "POST" },
      );
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(data.message ?? data.error ?? `HTTP ${r.status}`);
      }
      window.location.reload();
    } catch (err) {
      setGenStatus("error");
      setGenError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-7">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="flex flex-col gap-3">
        <Link
          href="/dashboard/leads"
          className="inline-flex items-center gap-1.5 text-eyebrow uppercase tracking-[0.16em] self-start hover:opacity-80 transition-opacity"
          style={{ color: "var(--vx-muted)", fontWeight: 600 }}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          All leads
        </Link>
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <p
              className="text-[10.5px] uppercase tracking-[0.18em] font-medium"
              style={{ color: "var(--vx-muted)" }}
            >
              Lead report
            </p>
            <h1
              className="font-display mt-1"
              style={{
                color: "var(--vx-ink)",
                fontSize: "clamp(28px, 4vw, 40px)",
                lineHeight: 1.05,
                letterSpacing: "-0.02em",
              }}
            >
              {lead.name ?? lead.email ?? lead.public_id}
            </h1>
            <p
              className="mt-1.5 italic font-serif"
              style={{ color: "var(--vx-ink-soft)", fontSize: "14px" }}
            >
              {lead.address}
              {lead.created_at ? (
                <span style={{ color: "var(--vx-muted)" }}>
                  {" "}· captured {fmtDateTime(lead.created_at)}
                </span>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Rep assignment lives next to "Open in workbench" so the
                manager's first action on opening a lead is to pick who
                owns it. Hides itself when no reps are loaded (Supabase
                misconfigured, or office has no rep records yet). */}
            <RepAssignDropdown
              leadId={lead.id}
              currentAssignedTo={lead.assigned_to ?? null}
            />
            <Link
              href={`/dashboard/estimate?leadId=${encodeURIComponent(lead.public_id)}`}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-mini font-medium transition-colors"
              style={{
                background: "var(--vx-ink)",
                color: "var(--vx-cream)",
                borderRadius: 0,
              }}
            >
              Open in workbench
              <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </header>

      {/* ── Painted overlay (hero) ────────────────────────────────── */}
      <Section title="Roof overlay" badge={paintedUrl ? "V3" : null}>
        {paintedUrl ? (
          <div className="flex flex-col gap-3">
            <div
              className="overflow-hidden"
              style={{ border: "1px solid var(--vx-rule)" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={paintedUrl}
                alt={`Painted roof for ${lead.address}`}
                className="w-full h-auto block"
              />
            </div>
            {/* Inline regenerate affordance — handles the case where
                the stored image is missing the cyan overlay because
                either (a) this lead pre-dates the composite logic, or
                (b) Pro Image fell back to raw aerial at run time
                (mask < 5% or > 35% of frame). Either way the rep can
                re-roll V3 from here without leaving the page. Small
                subtle link so it doesn't compete with the image for
                attention when the cyan IS present. */}
            <div className="flex items-center justify-between gap-3 text-xs">
              <span style={{ color: "var(--vx-muted)" }}>
                Missing the cyan overlay? Re-run the analysis to rebuild it.
              </span>
              <button
                type="button"
                onClick={regenerate}
                disabled={genStatus === "running"}
                className="inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background: "transparent",
                  color: "var(--vx-terra)",
                  border: "1px solid var(--vx-terra)",
                  borderRadius: 0,
                }}
              >
                {genStatus === "running" ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Re-running…
                  </>
                ) : (
                  <>Re-run V3</>
                )}
              </button>
            </div>
            {genStatus === "error" && genError ? (
              <p
                className="text-xs"
                style={{ color: "var(--vx-terra-dark)" }}
              >
                {genError}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[14px]" style={{ color: "var(--vx-ink-soft)" }}>
              The painted overlay isn&apos;t available — either this lead
              came in before the overlay was generated, or the signed
              URL expired (overlays are signed for 7 days). Re-running
              the analysis rebuilds both.
            </p>
            <button
              type="button"
              onClick={regenerate}
              disabled={genStatus === "running"}
              className="self-start inline-flex items-center gap-2 px-5 py-2.5 text-mini font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: "var(--vx-terra)",
                color: "var(--vx-cream)",
                borderRadius: 0,
              }}
            >
              {genStatus === "running" ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Regenerating roof analysis…
                </>
              ) : (
                <>Regenerate roof analysis</>
              )}
            </button>
            {genStatus === "error" && genError ? (
              <p
                className="text-[12.5px]"
                style={{ color: "var(--vx-terra-dark)" }}
              >
                {genError}
              </p>
            ) : null}
          </div>
        )}
      </Section>

      {/* ── Customer-quoted tier prices ────────────────────────────────
          Mirrors the Good/Better/Best the customer saw on the result
          screen. Computed from the same inputs (quotableSqft, waste %,
          penetration adders, detected material at ≥0.65 confidence) and
          the same `calculateTieredPricingWithPenetrations` lib call.
          Hides when there's no V3 sqft to price against — legacy leads,
          or rows where the V3 run never persisted. */}
      {tiers && tiers.length > 0 ? (
        <Section title="Customer-quoted tiers" badge="V3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {tiers.map((t) => (
              <RepTierCard key={t.tier.id} tier={t} />
            ))}
          </div>
          {quotableSqft != null && displaySqft != null && quotableSqft < displaySqft ? (
            <p
              className="mt-3 text-xs font-serif italic"
              style={{ color: "var(--vx-ink-soft)" }}
            >
              Customer saw{" "}
              <span className="tabular" style={{ fontStyle: "normal" }}>
                {displaySqft.toLocaleString()}
              </span>{" "}
              sqft headline; tier prices cover the{" "}
              <span className="tabular" style={{ fontStyle: "normal" }}>
                {quotableSqft.toLocaleString()}
              </span>{" "}
              sqft of asphalt-shingle roof. The remaining{" "}
              <span className="tabular" style={{ fontStyle: "normal" }}>
                {(displaySqft - quotableSqft).toLocaleString()}
              </span>{" "}
              sqft is low-slope and quoted separately on site.
            </p>
          ) : null}
        </Section>
      ) : null}

      {/* ── Two-column: customer + property ───────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Section title="Customer">
          <DefList
            rows={[
              { label: "Name", value: lead.name ?? "—" },
              { label: "Email", value: lead.email ?? "—", mono: true },
              { label: "Phone", value: lead.phone ?? "—", mono: true },
              { label: "Source", value: lead.source ?? "—" },
            ]}
          />
        </Section>
        <Section
          title="Property"
          right={
            lead.lat != null && lead.lng != null ? (
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${lead.lat},${lead.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10.5px] uppercase tracking-[0.18em] inline-flex items-center gap-1 hover:opacity-80"
                style={{ color: "var(--vx-terra)" }}
              >
                Directions
                <ExternalLink className="w-3 h-3" />
              </a>
            ) : null
          }
        >
          <DefList
            rows={[
              // Address with the trailing ZIP + ", USA" peeled off so it
              // doesn't double up with the dedicated ZIP row below.
              { label: "Address", value: displayAddress },
              ...(derivedZip
                ? [{ label: "ZIP", value: derivedZip, mono: true }]
                : []),
              // County is only populated by reverse geocoding (not wired
              // yet). Hide the row entirely when missing instead of
              // showing an em-dash that looks like a missing field.
              ...(lead.county
                ? [{ label: "County", value: lead.county }]
                : []),
              ...(lead.lat != null && lead.lng != null
                ? [
                    {
                      label: "Lat / Lng",
                      mono: true,
                      value: `${lead.lat.toFixed(6)}, ${lead.lng.toFixed(6)}`,
                    },
                  ]
                : []),
            ]}
          />
        </Section>
      </div>

      {/* ── Headline measurements (if V3 ran) ───────────────────────
          Two sqft numbers when they differ: "Display sqft" is the
          customer-facing headline (3°+ filter, whole roof); "Pricing
          sqft" is the ≥12° asphalt-shingle subset the tier prices were
          calculated against. When they match (typical roof, no low-
          slope addition), we only show one. */}
      {v3?.solar ? (
        <Section title="Headline measurements">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat
              label={
                v3.solar.quotableSqft != null &&
                v3.solar.sqft != null &&
                v3.solar.quotableSqft < v3.solar.sqft
                  ? "Display sqft"
                  : "Sloped sqft"
              }
              value={v3.solar.sqft?.toLocaleString() ?? "—"}
              unit="ft²"
            />
            {v3.solar.quotableSqft != null &&
              v3.solar.sqft != null &&
              v3.solar.quotableSqft < v3.solar.sqft && (
                <Stat
                  label="Pricing sqft"
                  value={v3.solar.quotableSqft.toLocaleString()}
                  unit="ft² (asphalt-eligible)"
                />
              )}
            <Stat
              label="Pitch"
              value={
                v3.solar.pitchDegrees != null
                  ? v3.solar.pitchDegrees.toFixed(1)
                  : "—"
              }
              unit="°"
            />
            <Stat
              label="Segments"
              value={String(v3.solar.segmentCount ?? "—")}
            />
            <Stat
              label="Imagery"
              value={v3.solar.imageryQuality ?? "—"}
            />
          </div>
        </Section>
      ) : null}

      {/* ── Anatomy ───────────────────────────────────────────────── */}
      {v3?.derived ? (
        <Section title="Roof anatomy">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {/* Stories chip removed from customer page 2026-05-18
                (single-angle satellite can't reliably detect stories).
                Hidden from rep view too — surfacing the wrong number
                to the rep is worse than not showing it. */}
            <Stat
              label="Est. attic"
              value={
                v3.derived.estimatedAtticSqft != null
                  ? v3.derived.estimatedAtticSqft.toLocaleString()
                  : "—"
              }
              unit="ft²"
            />
            <Stat label="Complexity" value={v3.derived.complexity ?? "—"} />
            <Stat
              label="Faces"
              value={v3.derived.predominantCompass ?? "—"}
            />
          </div>
        </Section>
      ) : null}

      {/* ── Detected material + customer-side pricing basis ───────── */}
      {/* The customer page applies a 0.65 confidence floor before
          using a Gemini-detected material to drive tier pricing.
          Below that, pricing silently falls back to architectural
          shingle regardless of what was detected. Mirror that logic
          here so the rep KNOWS which material the customer's tier
          prices were actually calibrated against — not just what
          Gemini guessed. */}
      {v3?.geminiAnalysis?.roofMaterial ? (() => {
        const detected = v3.geminiAnalysis.roofMaterial;
        const usedForPricing =
          detected.confidence >= MATERIAL_PRICING_CONFIDENCE_FLOOR;
        return (
          <Section title="Detected material">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <Stat
                label="Detected"
                value={detected.type.replace(/_/g, " ")}
              />
              <Stat
                label="Confidence"
                value={`${Math.round(detected.confidence * 100)}%`}
              />
              <Stat
                label="Used for pricing?"
                value={
                  usedForPricing
                    ? "Yes — tier rates scaled"
                    : "No — fell back to asphalt"
                }
              />
            </div>
          </Section>
        );
      })() : null}

      {/* ── Penetration adders that fed customer tier prices ──────── */}
      {/* The customer's tier price = effectiveSqft × rate + Σ(per-
          fixture adder). Surfacing the adder breakdown lets a rep
          re-quote on-site without diverging from what the customer
          was shown. */}
      {v3?.pricing &&
       v3.pricing.penetrationAdderLines &&
       v3.pricing.penetrationAdderLines.length > 0 ? (
        <Section
          title="Penetration adders"
          badge={`+$${v3.pricing.penetrationAddersTotal.toLocaleString()} total`}
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            {v3.pricing.penetrationAdderLines.map((line) => (
              <div
                key={line.type}
                className="flex items-baseline justify-between gap-2 rounded-md border border-white/5 px-3 py-2"
              >
                <span className="capitalize text-white/70">
                  {line.type.replace(/_/g, " ")} × {line.count}
                </span>
                <span className="tabular-nums font-semibold">
                  ${line.subtotal.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {/* ── Edges ─────────────────────────────────────────────────── */}
      {(() => {
        const gem = v3?.geminiEdges ?? null;
        const solar = v3?.edges ?? null;
        const e = gem ?? solar;
        if (!e) return null;
        const source = gem
          ? `Voxaris V3 · ${gem.linesCount ?? 0} lines`
          : "Estimate";
        return (
          <Section title="Edges" badge={source}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Stat
                label="Ridges + hips"
                value={
                  e.ridgesHipsLf != null
                    ? e.ridgesHipsLf.toLocaleString()
                    : "—"
                }
                unit="lf"
              />
              <Stat
                label="Valleys"
                value={
                  e.valleysLf != null ? e.valleysLf.toLocaleString() : "—"
                }
                unit="lf"
              />
              <Stat
                label="Rakes"
                value={
                  e.rakesLf != null ? e.rakesLf.toLocaleString() : "—"
                }
                unit="lf"
              />
              <Stat
                label="Eaves"
                value={
                  e.eavesLf != null ? e.eavesLf.toLocaleString() : "—"
                }
                unit="lf"
              />
            </div>
          </Section>
        );
      })()}

      {/* ── Storm history (rep-adjustable) ────────────────────────── */}
      <Section
        title="Storm history"
        right={
          <div className="flex items-center gap-2 flex-wrap">
            <KnobInput
              label="Radius"
              suffix="mi"
              min={1}
              max={50}
              value={stormRadius}
              onChange={setStormRadius}
            />
            <KnobInput
              label="Window"
              suffix="days"
              min={1}
              max={365}
              value={stormDays}
              onChange={setStormDays}
            />
            {storms !== null && storms.length > 0 ? (
              <span
                className="text-micro uppercase tracking-[0.18em] px-1.5 py-0.5"
                style={{
                  border: "1px solid rgba(199, 107, 63, 0.4)",
                  color: "var(--vx-terra)",
                }}
              >
                {storms.length} {storms.length === 1 ? "event" : "events"}
              </span>
            ) : null}
          </div>
        }
      >
        {stormsLoading ? (
          <div
            className="text-mini inline-flex items-center gap-2"
            style={{ color: "var(--vx-ink-soft)" }}
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading storm reports…
          </div>
        ) : storms === null || storms.length === 0 ? (
          <p
            className="text-mini leading-relaxed"
            style={{ color: "var(--vx-ink-soft)" }}
          >
            No verified storm events within {stormRadius} miles of this
            address in the last {stormDays} days. Widen the radius or
            window to look further out.
          </p>
        ) : (
          <ul
            className="flex flex-col divide-y"
            style={{ borderColor: "var(--vx-rule)" }}
          >
            {storms.slice(0, 20).map((e, i) => {
              const dateLabel = e.date
                ? new Date(e.date).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : "—";
              const mag =
                e.magnitude != null
                  ? `${e.magnitude}${
                      e.magnitudeType === "inches"
                        ? '"'
                        : e.magnitudeType
                          ? ` ${e.magnitudeType}`
                          : ""
                    }`
                  : null;
              return (
                <li
                  key={`${e.date ?? "x"}-${i}`}
                  className="py-2.5 grid grid-cols-[120px_minmax(0,1fr)_auto] gap-4 items-baseline text-mini"
                  style={{ borderColor: "var(--vx-rule)" }}
                >
                  <span
                    className="tabular"
                    style={{ color: "var(--vx-ink-soft)" }}
                  >
                    {dateLabel}
                  </span>
                  <span
                    className="capitalize"
                    style={{ color: "var(--vx-ink)" }}
                  >
                    {e.type}
                    {mag ? (
                      <span
                        className="ml-2 font-medium"
                        style={{ color: "var(--vx-terra)" }}
                      >
                        {mag}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className="text-[11.5px] uppercase tracking-[0.12em] tabular"
                    style={{ color: "var(--vx-muted)" }}
                  >
                    {e.distanceMiles != null
                      ? `${e.distanceMiles.toFixed(1)} mi`
                      : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* ── Estimate range (legacy / rep-provided fields) ──────────── */}
      {lead.estimate_low != null && lead.estimate_high != null ? (
        <Section title="Estimate range">
          <p
            className="font-display tabular"
            style={{
              color: "var(--vx-ink)",
              fontSize: "26px",
              letterSpacing: "-0.015em",
            }}
          >
            {fmtUSD(lead.estimate_low, 0)} – {fmtUSD(lead.estimate_high, 0)}
          </p>
          {lead.material ? (
            <p
              className="text-mini mt-1"
              style={{ color: "var(--vx-ink-soft)" }}
            >
              {lead.material}
              {lead.estimated_sqft != null
                ? ` · ${lead.estimated_sqft.toLocaleString()} ft²`
                : ""}
            </p>
          ) : null}
        </Section>
      ) : null}

      {/* ── Notes ─────────────────────────────────────────────────── */}
      {lead.notes ? (
        <Section title="Notes">
          <p
            className="text-[14px] leading-relaxed whitespace-pre-wrap"
            style={{ color: "var(--vx-ink)" }}
          >
            {lead.notes}
          </p>
        </Section>
      ) : null}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function Section({
  title,
  children,
  right,
  badge,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  badge?: string | null;
}) {
  return (
    <section
      className="p-6"
      style={{
        background: "var(--vx-paper)",
        border: "1px solid var(--vx-rule)",
        borderRadius: "var(--vx-radius-card)",
      }}
    >
      <div className="flex items-baseline justify-between gap-3 mb-4 flex-wrap">
        <h2
          className="text-[10.5px] uppercase tracking-[0.18em] font-medium"
          style={{ color: "var(--vx-muted)" }}
        >
          {title}
        </h2>
        {right ?? (badge ? (
          <span
            className="text-micro uppercase tracking-[0.18em] px-1.5 py-0.5"
            style={{
              border: "1px solid rgba(199, 107, 63, 0.4)",
              color: "var(--vx-terra)",
            }}
          >
            {badge}
          </span>
        ) : null)}
      </div>
      {children}
    </section>
  );
}

function DefList({
  rows,
}: {
  rows: Array<{ label: string; value: string; mono?: boolean }>;
}) {
  return (
    <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-2 gap-x-4 text-[13.5px]">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt style={{ color: "var(--vx-muted)" }}>{r.label}</dt>
          <dd
            className={r.mono ? "tabular" : ""}
            style={{ color: "var(--vx-ink)" }}
          >
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Stat({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div
      className="p-3"
      style={{
        background: "var(--vx-cream)",
        border: "1px solid var(--vx-rule)",
      }}
    >
      <p
        className="text-micro uppercase tracking-[0.16em] mb-1"
        style={{ color: "var(--vx-muted)" }}
      >
        {label}
      </p>
      <p
        className="font-display tabular"
        style={{
          color: "var(--vx-ink)",
          fontSize: "22px",
          lineHeight: 1,
          letterSpacing: "-0.01em",
        }}
      >
        {value}
        {unit ? (
          <span
            className="ml-1 text-eyebrow font-medium"
            style={{ color: "var(--vx-ink-soft)", letterSpacing: "0" }}
          >
            {unit}
          </span>
        ) : null}
      </p>
    </div>
  );
}

function KnobInput({
  label,
  suffix,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  suffix: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
}) {
  return (
    <label
      className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.14em]"
      style={{ color: "var(--vx-muted)" }}
    >
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) =>
          onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))
        }
        className="w-14 px-1.5 py-0.5 text-xs tabular text-center"
        style={{
          background: "var(--vx-cream)",
          border: "1px solid var(--vx-rule)",
          borderRadius: 0,
          color: "var(--vx-ink)",
        }}
        aria-label={`${label} ${suffix}`}
      />
      <span>{suffix}</span>
    </label>
  );
}

/**
 * Per-tier card on the customer-quoted tiers row. Mirrors the
 * Good/Better/Best the customer saw on app/page.tsx but rendered in
 * the dashboard's flat-cream styling. Shows the monthly finance
 * number BIG (matching the customer's lead-with-monthly UI from
 * commit cba144d) with the cash total in fine print.
 */
function RepTierCard({ tier }: { tier: TierPrice }) {
  return (
    <div
      className="p-4 flex flex-col"
      style={{
        background: "var(--vx-cream)",
        border: "1px solid var(--vx-rule)",
      }}
    >
      <div
        className="text-micro uppercase tracking-[0.18em] font-semibold mb-1.5"
        style={{ color: "var(--vx-terra)" }}
      >
        {tier.tier.name}
      </div>
      <div
        className="text-xs mb-3"
        style={{ color: "var(--vx-ink-soft)", lineHeight: 1.45 }}
      >
        {tier.tier.tagline}
      </div>
      <div className="mt-auto">
        <div className="flex items-baseline gap-1">
          <span
            className="font-serif tabular"
            style={{ fontSize: "26px", lineHeight: 1, color: "var(--vx-ink)" }}
          >
            {fmtUSD(tier.monthly)}
          </span>
          <span
            className="font-serif italic"
            style={{ fontSize: "12px", color: "var(--vx-ink-soft)" }}
          >
            /mo
          </span>
        </div>
        <div
          className="mt-1 tabular"
          style={{ fontSize: "11px", color: "var(--vx-muted)" }}
        >
          est. {fmtUSD(tier.total)} total
        </div>
      </div>
    </div>
  );
}

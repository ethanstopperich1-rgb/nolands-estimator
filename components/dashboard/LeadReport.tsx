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

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { fmtDateTime, fmtUSD, type Lead } from "@/lib/dashboard-format";

interface PaintedV3 {
  painted_url?: string | null;
  solar?: {
    sqft: number | null;
    footprintSqft?: number | null;
    pitchDegrees: number | null;
    segmentCount?: number;
    imageryQuality?: string | null;
    imageryDate?: string | null;
  };
  derived?: {
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
}

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
          className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] self-start hover:opacity-80 transition-opacity"
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
          <Link
            href={`/dashboard/estimate?leadId=${encodeURIComponent(lead.public_id)}`}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium transition-colors"
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
      </header>

      {/* ── Painted overlay (hero) ────────────────────────────────── */}
      <Section title="Roof overlay" badge={paintedUrl ? "V3" : null}>
        {paintedUrl ? (
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
              className="self-start inline-flex items-center gap-2 px-5 py-2.5 text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
              { label: "Address", value: lead.address },
              { label: "ZIP", value: lead.zip ?? "—", mono: true },
              { label: "County", value: lead.county ?? "—" },
              {
                label: "Lat / Lng",
                mono: true,
                value:
                  lead.lat != null && lead.lng != null
                    ? `${lead.lat.toFixed(6)}, ${lead.lng.toFixed(6)}`
                    : "—",
              },
            ]}
          />
        </Section>
      </div>

      {/* ── Headline measurements (if V3 ran) ─────────────────────── */}
      {v3?.solar ? (
        <Section title="Headline measurements">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat
              label="Sloped sqft"
              value={v3.solar.sqft?.toLocaleString() ?? "—"}
              unit="ft²"
            />
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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat
              label="Stories"
              value={String(v3.derived.stories ?? "—")}
            />
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

      {/* ── Edges ─────────────────────────────────────────────────── */}
      {(() => {
        const gem = v3?.geminiEdges ?? null;
        const solar = v3?.edges ?? null;
        const e = gem ?? solar;
        if (!e) return null;
        const source = gem
          ? `Voxaris V3 · ${gem.linesCount ?? 0} lines`
          : "Solar estimate";
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
                className="text-[10px] uppercase tracking-[0.18em] px-1.5 py-0.5"
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
            className="text-[13px] inline-flex items-center gap-2"
            style={{ color: "var(--vx-ink-soft)" }}
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading storm reports…
          </div>
        ) : storms === null || storms.length === 0 ? (
          <p
            className="text-[13px] leading-relaxed"
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
                  className="py-2.5 grid grid-cols-[120px_minmax(0,1fr)_auto] gap-4 items-baseline text-[13px]"
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
              className="text-[13px] mt-1"
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
            className="text-[10px] uppercase tracking-[0.18em] px-1.5 py-0.5"
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
        className="text-[10px] uppercase tracking-[0.16em] mb-1"
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
            className="ml-1 text-[11px] font-medium"
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
        className="w-14 px-1.5 py-0.5 text-[12px] tabular text-center"
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

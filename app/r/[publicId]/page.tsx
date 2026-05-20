/**
 * /r/[publicId] — public homeowner-share page.
 *
 * Server-rendered. Renders the lead's persisted V3 roof report from
 * `leads.roof_v3_json`. No fresh Gemini call, no Solar call, no
 * Supabase mutations — purely a read-only surface backed by the
 * data we already captured during the customer flow.
 *
 * Trust model: the `lead_<32-hex>` public_id IS the bearer token.
 * Anyone with the URL can view this report — that's by design (the
 * whole point is shareability with a spouse / contractor friend /
 * insurance file). PII (email, phone, exact location) is omitted
 * server-side.
 *
 * Indexing: `noindex, nofollow` so Google / Bing don't surface real
 * leads in search. The URL is meant to be shared peer-to-peer, not
 * discovered.
 *
 * Branding: pulls the office row by `leads.office_id` and uses the
 * office's `name` + `brandColor` + `inboundNumber` so the page reads
 * as the CONTRACTOR's brand, never the Voxaris brand. White-label is
 * the moat — it lives here too.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
  type OfficeBranding,
} from "@/lib/supabase";
import { buildHomeownerShareUrl } from "@/lib/share-url";
import { resolvePaintedUrl } from "@/lib/painted-url";

// ─── Types ────────────────────────────────────────────────────────────

interface SharedReport {
  publicId: string;
  homeownerFirstName: string;
  address: string;
  estimateLow: number | null;
  estimateHigh: number | null;
  estimatedSqft: number | null;
  materialLabel: string | null;
  paintedUrl: string | null;
  tiers: Array<{ name: string; price: number; monthly: number | null }> | null;
  storms: {
    totalEvents: number | null;
    hailCount: number | null;
    maxHailInches: number | null;
    windCount: number | null;
  } | null;
  parcel: {
    yearBuilt: number | null;
    livingArea: number | null;
    lotAcres: number | null;
  } | null;
  observations: string[];
  generatedAt: string | null;
  office: {
    displayName: string;
    inboundNumber: string | null;
    brandColor: string | null;
    logoUrl: string | null;
  };
}

// ─── Data loading ─────────────────────────────────────────────────────

async function loadSharedReport(publicId: string): Promise<SharedReport | null> {
  if (!/^lead_[a-f0-9]{16,40}$/i.test(publicId)) return null;
  if (!supabaseServiceRoleConfigured()) return null;
  const sb = createServiceRoleClient();

  const { data: lead, error } = await sb
    .from("leads")
    .select(
      "public_id, name, address, estimate_low, estimate_high, estimated_sqft, material, roof_v3_json, office_id, created_at",
    )
    .eq("public_id", publicId)
    .maybeSingle();

  if (error || !lead) return null;

  const { data: officeRow } = await sb
    .from("offices")
    .select("name, inbound_number, brand_color, logo_url")
    .eq("id", lead.office_id)
    .maybeSingle();

  // Parse the persisted V3 blob. We type-narrow defensively — old
  // estimates may predate fields like `painted_url` or
  // `geminiAnalysis.condition_hints`.
  const v3 = (lead.roof_v3_json ?? {}) as Record<string, unknown>;

  // Re-mint the painted URL on every render via the shared helper.
  // Surviving the bucket flipping public→private + signed-URL TTL
  // expiry. Reads NEVER trigger a V3 pipeline run — if the bytes
  // don't exist, we render the empty-state. See lib/painted-url.ts
  // for the parity invariant.
  const paintedMint = await resolvePaintedUrl(
    sb,
    lead.public_id,
    lead.roof_v3_json,
  );
  const paintedUrl = paintedMint.url;

  const generatedAt =
    typeof v3.generated_at === "string"
      ? (v3.generated_at as string)
      : lead.created_at;

  // Tier prices — V3 persists these under `pricing.tiers` in the
  // shape `{ name, totalPrice, monthlyPrice }`. Optional everywhere.
  const tiersRaw = (
    (v3.pricing as Record<string, unknown> | undefined)?.tiers as
      | Array<Record<string, unknown>>
      | undefined
  ) ?? null;
  const tiers = tiersRaw
    ? tiersRaw
        .map((t) => ({
          name: typeof t.name === "string" ? t.name : "",
          price:
            typeof t.totalPrice === "number"
              ? t.totalPrice
              : typeof t.price === "number"
                ? t.price
                : 0,
          monthly:
            typeof t.monthlyPrice === "number"
              ? t.monthlyPrice
              : typeof t.monthly === "number"
                ? t.monthly
                : null,
        }))
        .filter((t) => t.name && t.price > 0)
    : null;

  // Storm summary — V3 persists this if the storms fetch succeeded.
  const stormsRaw = v3.storms as Record<string, unknown> | undefined;
  const stormsSummary = stormsRaw?.summary as Record<string, unknown> | undefined;
  const storms = stormsSummary
    ? {
        totalEvents:
          typeof stormsSummary.total === "number"
            ? (stormsSummary.total as number)
            : null,
        hailCount:
          typeof stormsSummary.hailCount === "number"
            ? (stormsSummary.hailCount as number)
            : null,
        maxHailInches:
          typeof stormsSummary.maxHailInches === "number"
            ? (stormsSummary.maxHailInches as number)
            : null,
        windCount:
          typeof stormsSummary.windCount === "number"
            ? (stormsSummary.windCount as number)
            : null,
      }
    : null;

  // Parcel record — same defensive parsing.
  const parcelRaw = v3.parcel as Record<string, unknown> | undefined;
  const parcel = parcelRaw
    ? {
        yearBuilt:
          typeof parcelRaw.yearBuilt === "number"
            ? (parcelRaw.yearBuilt as number)
            : null,
        livingArea:
          typeof parcelRaw.livingArea === "number"
            ? (parcelRaw.livingArea as number)
            : null,
        lotAcres:
          typeof parcelRaw.lotAcres === "number"
            ? (parcelRaw.lotAcres as number)
            : null,
      }
    : null;

  // Condition observations — pulled from Brad's visual assessment if
  // present (otherwise empty). The probe already hedges these for the
  // homeowner surface.
  const va = v3.visualRoofAssessment as Record<string, unknown> | undefined;
  const observations: string[] = Array.isArray(va?.observations)
    ? (va.observations as unknown[])
        .filter((o): o is string => typeof o === "string")
        .slice(0, 3)
    : [];

  return {
    publicId: lead.public_id,
    homeownerFirstName: lead.name.split(/\s+/)[0] ?? "there",
    address: lead.address,
    estimateLow: lead.estimate_low,
    estimateHigh: lead.estimate_high,
    estimatedSqft: lead.estimated_sqft,
    materialLabel: lead.material,
    paintedUrl,
    tiers,
    storms,
    parcel,
    observations,
    generatedAt,
    office: {
      displayName: officeRow?.name ?? "Voxaris",
      inboundNumber: officeRow?.inbound_number ?? null,
      brandColor: officeRow?.brand_color ?? null,
      logoUrl: officeRow?.logo_url ?? null,
    },
  };
}

// ─── Metadata (Open Graph + Twitter Card) ─────────────────────────────

export async function generateMetadata({
  params,
}: {
  params: Promise<{ publicId: string }>;
}): Promise<Metadata> {
  const { publicId } = await params;
  const report = await loadSharedReport(publicId);
  if (!report) {
    return { title: "Roof report", robots: { index: false, follow: false } };
  }

  const dollarRange =
    report.estimateLow != null && report.estimateHigh != null
      ? `$${report.estimateLow.toLocaleString()}–$${report.estimateHigh.toLocaleString()}`
      : "your estimate";

  const title = `${report.address} — Roof report`;
  const description = `${report.office.displayName} measured this roof from satellite. Estimate range: ${dollarRange}.`;
  const url = buildHomeownerShareUrl(publicId);

  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: {
      title,
      description,
      url,
      siteName: report.office.displayName,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

// ─── Render ───────────────────────────────────────────────────────────

export default async function HomeownerSharePage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const report = await loadSharedReport(publicId);
  if (!report) notFound();

  const accent = report.office.brandColor
    ? `#${report.office.brandColor.replace(/^#/, "")}`
    : "#0F1B2D";

  const callHref = report.office.inboundNumber
    ? `tel:${report.office.inboundNumber.replace(/[^+0-9]/g, "")}`
    : null;

  return (
    <main
      className="min-h-screen"
      style={{
        background: "var(--vx-cream, #ECE3D0)",
        color: "var(--vx-ink, #0F1B2D)",
        fontFamily: '"DM Sans", system-ui, sans-serif',
      }}
    >
      {/* Print-friendly stylesheet — when a homeowner hits Cmd-P, they
          get a clean single-column print without nav or CTA chrome.
          This is the "PDF for the 5% who want paper" answer. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
@media print {
  .no-print { display: none !important; }
  body { background: white !important; color: black !important; }
  main { padding: 0 !important; }
  .share-card { box-shadow: none !important; border: 1px solid #ddd !important; break-inside: avoid; }
}
          `,
        }}
      />

      <div className="mx-auto max-w-3xl px-5 py-10">
        {/* Header — office brand */}
        <header className="flex items-center justify-between mb-8 no-print">
          <div className="flex items-center gap-3">
            {report.office.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={report.office.logoUrl}
                alt={report.office.displayName}
                style={{ height: 32, width: "auto" }}
              />
            ) : (
              <span
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  letterSpacing: "-0.01em",
                  color: accent,
                }}
              >
                {report.office.displayName}
              </span>
            )}
          </div>
          {callHref && (
            <a
              href={callHref}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full"
              style={{
                background: accent,
                color: "white",
                fontSize: 14,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Call {report.office.inboundNumber}
            </a>
          )}
        </header>

        {/* Hero — address + estimate range */}
        <section className="share-card mb-6 p-6 rounded-2xl bg-white shadow-sm">
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: accent,
              opacity: 0.7,
              marginBottom: 8,
            }}
          >
            {report.homeownerFirstName}, here&apos;s your roof report
          </div>
          <h1
            className="font-serif"
            style={{
              fontSize: "clamp(22px, 4vw, 32px)",
              lineHeight: 1.15,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              marginBottom: 16,
            }}
          >
            {report.address}
          </h1>
          {report.estimateLow != null && report.estimateHigh != null && (
            <div
              style={{
                fontSize: "clamp(28px, 5vw, 44px)",
                fontWeight: 600,
                letterSpacing: "-0.02em",
                color: accent,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              ${report.estimateLow.toLocaleString()} – $
              {report.estimateHigh.toLocaleString()}
            </div>
          )}
          <div
            style={{
              fontSize: 13,
              marginTop: 6,
              opacity: 0.6,
              fontStyle: "italic",
            }}
          >
            Quick estimate range from satellite. Final price depends on
            what we find on site.
          </div>
        </section>

        {/* Painted satellite */}
        {report.paintedUrl && (
          <section className="share-card mb-6 rounded-2xl overflow-hidden bg-white shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={report.paintedUrl}
              alt="Roof outlined from satellite imagery"
              style={{ width: "100%", height: "auto", display: "block" }}
            />
          </section>
        )}

        {/* Roof spec */}
        <section className="share-card mb-6 p-6 rounded-2xl bg-white shadow-sm">
          <h2
            className="font-serif"
            style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}
          >
            Roof measurements
          </h2>
          <dl style={{ display: "grid", gap: 10 }}>
            {report.estimatedSqft != null && (
              <Row
                label="Sqft (measured)"
                value={`${report.estimatedSqft.toLocaleString()} sqft`}
              />
            )}
            {report.materialLabel && (
              <Row label="Current material" value={titleCase(report.materialLabel)} />
            )}
          </dl>
        </section>

        {/* Tier prices */}
        {report.tiers && report.tiers.length > 0 && (
          <section className="share-card mb-6 p-6 rounded-2xl bg-white shadow-sm">
            <h2
              className="font-serif"
              style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}
            >
              Three replacement options
            </h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 12,
              }}
            >
              {report.tiers.map((t) => (
                <div
                  key={t.name}
                  style={{
                    padding: "14px 16px",
                    background: "rgba(15, 27, 45, 0.03)",
                    borderRadius: 12,
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      opacity: 0.6,
                    }}
                  >
                    {t.name}
                  </div>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 600,
                      letterSpacing: "-0.01em",
                      fontVariantNumeric: "tabular-nums",
                      marginTop: 4,
                    }}
                  >
                    ${Math.round(t.price).toLocaleString()}
                  </div>
                  {t.monthly != null && (
                    <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>
                      est. ${Math.round(t.monthly).toLocaleString()}/mo
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Severe weather */}
        {report.storms && (report.storms.totalEvents ?? 0) > 0 && (
          <section className="share-card mb-6 p-6 rounded-2xl bg-white shadow-sm">
            <h2
              className="font-serif"
              style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}
            >
              Severe weather, last 12 months
            </h2>
            <dl style={{ display: "grid", gap: 10 }}>
              <Row
                label="Events within 25 mi"
                value={report.storms.totalEvents?.toLocaleString() ?? "—"}
              />
              {report.storms.hailCount != null && report.storms.hailCount > 0 && (
                <Row
                  label="Hail reports"
                  value={
                    report.storms.maxHailInches != null
                      ? `${report.storms.hailCount} (up to ${report.storms.maxHailInches.toFixed(2)}″)`
                      : `${report.storms.hailCount}`
                  }
                />
              )}
              {report.storms.windCount != null &&
                report.storms.windCount > 0 && (
                  <Row
                    label="Damaging-wind reports"
                    value={`${report.storms.windCount}`}
                  />
                )}
            </dl>
          </section>
        )}

        {/* Property record */}
        {report.parcel &&
          (report.parcel.yearBuilt != null ||
            report.parcel.livingArea != null ||
            report.parcel.lotAcres != null) && (
            <section className="share-card mb-6 p-6 rounded-2xl bg-white shadow-sm">
              <h2
                className="font-serif"
                style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}
              >
                Property record
              </h2>
              <dl style={{ display: "grid", gap: 10 }}>
                {report.parcel.yearBuilt != null && (
                  <Row
                    label="Year built"
                    value={`${report.parcel.yearBuilt}`}
                  />
                )}
                {report.parcel.livingArea != null && (
                  <Row
                    label="Living area"
                    value={`${report.parcel.livingArea.toLocaleString()} sqft`}
                  />
                )}
                {report.parcel.lotAcres != null && (
                  <Row
                    label="Lot size"
                    value={`${report.parcel.lotAcres.toFixed(2)} acres`}
                  />
                )}
              </dl>
            </section>
          )}

        {/* Visual observations (hedged for homeowner-readable surface) */}
        {report.observations.length > 0 && (
          <section className="share-card mb-6 p-6 rounded-2xl bg-white shadow-sm">
            <h2
              className="font-serif"
              style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}
            >
              What we noticed from the imagery
            </h2>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {report.observations.map((o, i) => (
                <li
                  key={i}
                  style={{
                    padding: "10px 0",
                    borderTop: i > 0 ? "1px solid rgba(0,0,0,0.06)" : "none",
                    fontSize: 14,
                    lineHeight: 1.5,
                  }}
                >
                  {o}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* CTA — talk to the office (white-labeled) */}
        {callHref && (
          <section
            className="share-card no-print p-6 rounded-2xl text-center"
            style={{ background: accent, color: "white" }}
          >
            <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 4 }}>
              Ready for the real number?
            </div>
            <h2
              className="font-serif"
              style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}
            >
              Lock in a free 20-minute walkthrough
            </h2>
            <a
              href={callHref}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-full"
              style={{
                background: "white",
                color: accent,
                fontSize: 15,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Call {report.office.displayName}
              <span aria-hidden>→</span>
            </a>
            <div
              style={{
                fontSize: 12,
                marginTop: 14,
                opacity: 0.8,
                fontStyle: "italic",
              }}
            >
              {report.office.inboundNumber}
            </div>
          </section>
        )}

        {/* Footer */}
        <footer
          className="mt-10 text-center"
          style={{ fontSize: 11, opacity: 0.55 }}
        >
          {report.generatedAt && (
            <div>
              Report generated{" "}
              {new Date(report.generatedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </div>
          )}
          <div className="mt-1">
            Powered by{" "}
            <Link href="/" style={{ color: "inherit", fontWeight: 600 }}>
              Voxaris
            </Link>
          </div>
        </footer>
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 16,
      }}
    >
      <dt style={{ fontSize: 13, opacity: 0.6 }}>{label}</dt>
      <dd
        style={{
          fontSize: 14,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </dd>
    </div>
  );
}

function titleCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * /internal/report/[publicId] — EagleView-style roof inspection report.
 *
 * Server Component. Pulls the lead via the service-role Supabase
 * client (this page is rep-only and gated by middleware — same auth
 * surface as /api/leads/[publicId]/*) and renders five pageable
 * print-ready sections.
 *
 * The route is consumed in two ways:
 *   1. Headless Chromium hits it from `renderRoofReportPDF()` to
 *      generate the downloadable PDF.
 *   2. Reps can open it directly in a browser for a printable preview.
 *
 * Layout rules:
 *   - Letter @ 96dpi → 816×1056px usable, minus 0.5in margins all
 *     around. Each `.page` is sized to 7.5in × 10in and breaks after.
 *   - Use inline styles + a single <style> block. No Tailwind reset
 *     in this tree because we want true paper styling, not the app
 *     dark theme.
 *   - Every data point comes from `roof_v3_json`. Zero filler.
 */

import { notFound } from "next/navigation";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type V3Solar = {
  sqft?: number | null;
  footprintSqft?: number | null;
  pitchDegrees?: number | null;
  segmentCount?: number;
  imageryQuality?: string | null;
  imageryDate?: string | null;
};
type V3Derived = {
  stories?: number;
  estimatedAtticSqft?: number | null;
  predominantCompass?: string | null;
  complexity?: string;
};
type V3Correction = {
  applied?: boolean;
  reason?: string;
  solarRawSlopedSqft?: number;
  gisSource?: string | null;
  gisFootprintSqft?: number | null;
  slopeFactor?: number | null;
};
type V3Facet = {
  pitchDegrees: number;
  pitchOnTwelve?: string;
  azimuthDegrees?: number;
  compassDirection?: string;
  slopedSqft?: number;
  footprintSqft?: number;
};
type V3Edges = {
  ridgesHipsLf?: number | null;
  valleysLf?: number | null;
  rakesLf?: number | null;
  eavesLf?: number | null;
  linesCount?: number;
};
type V3Object = { type: string; confidence?: number };
type V3Pen = { count?: number; perimeterFt?: number; areaSqft?: number };
type V3Pot = {
  maxPanels?: number | null;
  annualSunshineHours?: number | null;
};
type V3GeminiAnalysis = {
  roofMaterial?: { type?: string; confidence?: number } | null;
  facetCountEstimate?: {
    count?: number;
    complexity?: string;
    confidence?: number;
  } | null;
  conditionHints?: Array<{ hint: string; confidence?: number }>;
};
type V3 = {
  painted_url?: string | null;
  solar?: V3Solar;
  derived?: V3Derived;
  correction?: V3Correction | null;
  geminiAnalysis?: V3GeminiAnalysis;
  geminiEdges?: V3Edges | null;
  edges?: V3Edges;
  facets?: V3Facet[];
  objects?: V3Object[];
  penetrationTotals?: V3Pen | null;
  solarPotential?: V3Pot | null;
};

type Lead = {
  public_id: string;
  name: string | null;
  address: string | null;
  roof_v3_json: V3 | null;
};

async function loadLead(publicId: string): Promise<Lead | null> {
  if (!supabaseServiceRoleConfigured()) return null;
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("leads")
    .select("public_id, name, address, roof_v3_json")
    .eq("public_id", publicId)
    .maybeSingle();
  return (data as Lead | null) ?? null;
}

function fmt(n: number | null | undefined, opts?: { unit?: string; digits?: number }): string {
  if (n == null || Number.isNaN(n)) return "—";
  const d = opts?.digits ?? 0;
  return `${Number(n).toLocaleString(undefined, { maximumFractionDigits: d })}${opts?.unit ? " " + opts.unit : ""}`;
}

export default async function ReportPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  if (!/^lead_[0-9a-f]{32}$/i.test(publicId)) notFound();
  const lead = await loadLead(publicId);
  if (!lead || !lead.roof_v3_json) notFound();

  const v3 = lead.roof_v3_json;
  const solar = v3.solar ?? {};
  const derived = v3.derived ?? {};
  const correction = v3.correction ?? null;
  const ga = v3.geminiAnalysis ?? {};
  const facets = Array.isArray(v3.facets) ? v3.facets : [];
  const objects = Array.isArray(v3.objects) ? v3.objects : [];
  const pen = v3.penetrationTotals ?? null;
  const pot = v3.solarPotential ?? null;

  // Prefer Gemini line measurements over Solar bbox derivations. The
  // Gemini lines come from polyline tracing of ridges/valleys/rakes on
  // the painted overlay; Solar values are bounding-box approximations.
  const gem = v3.geminiEdges ?? null;
  const solarEdges = v3.edges ?? {};
  const edges: V3Edges =
    gem && (gem.ridgesHipsLf ?? 0) + (gem.valleysLf ?? 0) > 0
      ? gem
      : solarEdges;

  const reportDate = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const objCounts: Record<string, number> = {};
  for (const o of objects) objCounts[o.type] = (objCounts[o.type] ?? 0) + 1;

  return (
    <>
      <style>{REPORT_CSS}</style>
      <div className="report-root">
        {/* ─── PAGE 1 — Cover ─────────────────────────────────────── */}
        <section className="page">
          <div className="cover-frame">
            <div className="cover-head">
              <div className="wordmark">VOXARIS</div>
              <div className="cover-eyebrow">Roof Inspection Report</div>
            </div>
            <div className="cover-painted">
              {v3.painted_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={v3.painted_url} alt="Painted roof overlay" />
              ) : (
                <div className="painted-missing">
                  Painted overlay unavailable.
                </div>
              )}
            </div>
            <div className="cover-meta">
              <div>
                <div className="meta-label">Property</div>
                <div className="meta-value">{lead.address ?? "—"}</div>
              </div>
              <div>
                <div className="meta-label">Prepared for</div>
                <div className="meta-value">{lead.name ?? "—"}</div>
              </div>
              <div>
                <div className="meta-label">Report date</div>
                <div className="meta-value">{reportDate}</div>
              </div>
              <div>
                <div className="meta-label">Report ID</div>
                <div className="meta-value mono">{lead.public_id}</div>
              </div>
            </div>
            <div className="cover-chip">V3 · Gemini + Solar</div>
          </div>
        </section>

        {/* ─── PAGE 2 — Headline measurements ─────────────────────── */}
        <section className="page">
          <PageHeader subtitle="Headline measurements" />
          <div className="stat-grid-4">
            <Stat label="Sloped sqft" value={fmt(solar.sqft, { unit: "ft²" })} />
            <Stat
              label="Pitch"
              value={solar.pitchDegrees != null ? `${solar.pitchDegrees.toFixed(1)}°` : "—"}
            />
            <Stat
              label="Complexity"
              value={derived.complexity ?? ga.facetCountEstimate?.complexity ?? "—"}
            />
            <Stat label="Stories" value={String(derived.stories ?? "—")} />
          </div>
          {v3.painted_url ? (
            <div className="painted-secondary">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={v3.painted_url} alt="Painted roof overlay" />
            </div>
          ) : null}
          {correction?.applied ? (
            <div className="note">
              <span className="note-chip">Adjusted</span> GIS{" "}
              {correction.gisSource?.toUpperCase()} footprint{" "}
              {fmt(correction.gisFootprintSqft, { unit: "ft²" })} × slope{" "}
              {correction.slopeFactor?.toFixed(3)} corrects raw Solar reading of{" "}
              {fmt(correction.solarRawSlopedSqft, { unit: "ft²" })}.
            </div>
          ) : null}
          <PageFooter publicId={lead.public_id} page={2} />
        </section>

        {/* ─── PAGE 3 — Roof anatomy (facets + edges) ─────────────── */}
        <section className="page">
          <PageHeader subtitle="Roof anatomy" />
          <h3 className="h3">Facet breakdown</h3>
          <table className="facet-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Compass</th>
                <th>Pitch</th>
                <th style={{ textAlign: "right" }}>Sloped ft²</th>
                <th style={{ textAlign: "right" }}>Footprint ft²</th>
              </tr>
            </thead>
            <tbody>
              {facets.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty">
                    No facet data in V3 payload.
                  </td>
                </tr>
              ) : (
                facets.map((f, i) => (
                  <tr key={i}>
                    <td className="mono">{String(i + 1).padStart(2, "0")}</td>
                    <td>{f.compassDirection ?? "—"}</td>
                    <td className="mono">
                      {f.pitchOnTwelve ?? `${f.pitchDegrees.toFixed(1)}°`}
                    </td>
                    <td style={{ textAlign: "right" }} className="mono">
                      {fmt(f.slopedSqft)}
                    </td>
                    <td style={{ textAlign: "right" }} className="mono">
                      {fmt(f.footprintSqft)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <h3 className="h3" style={{ marginTop: "0.3in" }}>
            Linear measurements
          </h3>
          <div className="stat-grid-4">
            <Stat label="Ridges + hips" value={fmt(edges.ridgesHipsLf, { unit: "lf" })} />
            <Stat label="Valleys" value={fmt(edges.valleysLf, { unit: "lf" })} />
            <Stat label="Rakes" value={fmt(edges.rakesLf, { unit: "lf" })} />
            <Stat label="Eaves" value={fmt(edges.eavesLf, { unit: "lf" })} />
          </div>

          {pen ? (
            <>
              <h3 className="h3" style={{ marginTop: "0.3in" }}>
                Penetrations
              </h3>
              <div className="stat-grid-3">
                <Stat label="Count" value={String(pen.count ?? "—")} />
                <Stat label="Perimeter" value={fmt(pen.perimeterFt, { unit: "ft" })} />
                <Stat label="Surface area" value={fmt(pen.areaSqft, { unit: "ft²" })} />
              </div>
            </>
          ) : null}
          <PageFooter publicId={lead.public_id} page={3} />
        </section>

        {/* ─── PAGE 4 — Material + condition + objects + solar ────── */}
        <section className="page">
          <PageHeader subtitle="Material, condition & rooftop objects" />
          <div className="cols-2">
            <div>
              <h3 className="h3">Material</h3>
              <div className="kv">
                <span>Type</span>
                <span className="strong">
                  {ga.roofMaterial?.type ?? "—"}
                </span>
              </div>
              <div className="kv">
                <span>Confidence</span>
                <span className="mono">
                  {ga.roofMaterial?.confidence != null
                    ? `${Math.round((ga.roofMaterial.confidence ?? 0) * 100)}%`
                    : "—"}
                </span>
              </div>
              {ga.facetCountEstimate ? (
                <>
                  <div className="kv">
                    <span>Est. facet count</span>
                    <span className="mono">
                      {ga.facetCountEstimate.count ?? "—"}
                    </span>
                  </div>
                  <div className="kv">
                    <span>Layout</span>
                    <span>{ga.facetCountEstimate.complexity ?? "—"}</span>
                  </div>
                </>
              ) : null}
            </div>
            <div>
              <h3 className="h3">Visible condition</h3>
              {Array.isArray(ga.conditionHints) && ga.conditionHints.length > 0 ? (
                <ul className="hint-list">
                  {ga.conditionHints.map((h, i) => (
                    <li key={i}>
                      <span>{h.hint}</span>
                      <span className="mono dim">
                        {h.confidence != null
                          ? `${Math.round(h.confidence * 100)}%`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">No condition hints flagged.</p>
              )}
            </div>
          </div>

          <h3 className="h3" style={{ marginTop: "0.3in" }}>
            Rooftop objects
          </h3>
          {Object.keys(objCounts).length === 0 ? (
            <p className="empty">No rooftop objects detected.</p>
          ) : (
            <div className="chip-row">
              {Object.entries(objCounts).map(([type, count]) => (
                <span className="chip" key={type}>
                  {type} <span className="chip-count">{count}</span>
                </span>
              ))}
            </div>
          )}

          {pot ? (
            <>
              <h3 className="h3" style={{ marginTop: "0.3in" }}>
                Solar potential
              </h3>
              <div className="stat-grid-3">
                <Stat label="Max panels" value={fmt(pot.maxPanels)} />
                <Stat
                  label="Annual sunshine"
                  value={fmt(pot.annualSunshineHours, { unit: "hr" })}
                />
                <Stat
                  label="Predominant face"
                  value={derived.predominantCompass ?? "—"}
                />
              </div>
            </>
          ) : null}
          <PageFooter publicId={lead.public_id} page={4} />
        </section>

        {/* ─── PAGE 5 — Methodology ───────────────────────────────── */}
        <section className="page no-break-after">
          <PageHeader subtitle="Methodology & data sources" />
          <div className="prose">
            <p>
              Every measurement in this report comes from the Voxaris V3
              pipeline — a two-pass roof analysis that fuses Google Solar
              API geometry with a Gemini multimodal vision pass over the
              painted satellite tile.
            </p>
            <h3 className="h3">Pipeline</h3>
            <ol>
              <li>
                <strong>Solar pass.</strong> Google Solar returns roof
                segments, sloped sqft, pitch, and segment count for the
                pin-confirmed coordinate. Imagery quality:{" "}
                <em>{solar.imageryQuality ?? "—"}</em>
                {solar.imageryDate ? ` (captured ${solar.imageryDate})` : ""}.
              </li>
              <li>
                <strong>Painted overlay.</strong> The satellite tile is
                painted with facet polygons and re-rendered for the
                vision model.
              </li>
              <li>
                <strong>Gemini analysis.</strong> The painted tile drives
                material classification, condition hints, facet count,
                rooftop-object detection, and ridge/valley/rake/eave line
                tracing.
              </li>
              <li>
                <strong>GIS reconciliation.</strong> When the Solar
                footprint disagrees with a county GIS building polygon by
                more than the configured tolerance, the headline sqft is
                corrected via GIS footprint × slope factor.
              </li>
            </ol>
            {correction?.applied ? (
              <p>
                <strong>GIS correction applied to this report.</strong>{" "}
                Source: <span className="mono">{correction.gisSource}</span>.
                Reason: <em>{correction.reason ?? "footprint disagreement"}</em>.
              </p>
            ) : (
              <p>
                <em>No GIS correction was applied — Solar footprint and
                GIS footprint agreed within tolerance.</em>
              </p>
            )}
            <h3 className="h3">Limitations</h3>
            <ul>
              <li>
                Satellite imagery may be 6–24 months stale; recent storm
                damage may not appear.
              </li>
              <li>
                Tree canopy can occlude facets, which biases facet count
                low and rooftop-object detection toward false-negatives.
              </li>
              <li>
                Condition hints are AI-derived signals, not a substitute
                for an in-person inspection.
              </li>
            </ul>
            <p className="fineprint">
              Voxaris · Roof intelligence for residential property.
              Report ID <span className="mono">{lead.public_id}</span> ·
              Generated {reportDate}.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}

/* ─── Sub-components ────────────────────────────────────────────── */

function PageHeader({ subtitle }: { subtitle: string }) {
  return (
    <header className="page-header">
      <div className="wordmark-sm">VOXARIS</div>
      <div className="page-eyebrow">{subtitle}</div>
    </header>
  );
}

function PageFooter({ publicId, page }: { publicId: string; page: number }) {
  return (
    <footer className="page-footer">
      <span className="mono dim">{publicId}</span>
      <span className="dim">Page {page} of 5</span>
    </footer>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

/* ─── Print stylesheet ──────────────────────────────────────────── */

const REPORT_CSS = `
  :root {
    --paper: #F4EFE5;
    --ink: #1a1614;
    --ink-soft: #4a4540;
    --rule: #d8cfbf;
    --accent: #38C5EE;
  }
  html, body {
    margin: 0;
    padding: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: "Iowan Old Style", "Palatino Linotype", "Cambria", Georgia, serif;
    -webkit-font-smoothing: antialiased;
    font-size: 11pt;
  }
  .report-root {
    background: var(--paper);
  }
  .page {
    width: 7.5in;
    min-height: 10in;
    padding: 0;
    margin: 0 auto;
    page-break-after: always;
    position: relative;
    background: var(--paper);
    display: flex;
    flex-direction: column;
  }
  .page.no-break-after { page-break-after: auto; }

  .page-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding-bottom: 0.18in;
    margin-bottom: 0.24in;
    border-bottom: 1px solid var(--rule);
  }
  .page-footer {
    margin-top: auto;
    padding-top: 0.18in;
    display: flex;
    justify-content: space-between;
    font-size: 8.5pt;
    border-top: 1px solid var(--rule);
  }
  .wordmark {
    font-family: "Helvetica Neue", Arial, sans-serif;
    font-weight: 800;
    letter-spacing: 0.22em;
    font-size: 14pt;
  }
  .wordmark-sm {
    font-family: "Helvetica Neue", Arial, sans-serif;
    font-weight: 700;
    letter-spacing: 0.22em;
    font-size: 10pt;
  }
  .page-eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.18em;
    font-size: 9pt;
    color: var(--ink-soft);
  }

  /* Cover */
  .cover-frame {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 0.4in 0;
  }
  .cover-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 0.4in;
  }
  .cover-eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.22em;
    font-size: 9pt;
    color: var(--ink-soft);
  }
  .cover-painted {
    border: 1px solid var(--rule);
    background: #fff;
    aspect-ratio: 4 / 3;
    overflow: hidden;
    margin-bottom: 0.4in;
  }
  .cover-painted img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .painted-missing {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ink-soft);
    font-style: italic;
  }
  .cover-meta {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.22in 0.4in;
  }
  .meta-label {
    text-transform: uppercase;
    letter-spacing: 0.16em;
    font-size: 8.5pt;
    color: var(--ink-soft);
    margin-bottom: 0.04in;
  }
  .meta-value {
    font-size: 12pt;
    font-weight: 600;
  }
  .meta-value.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 9.5pt; font-weight: 500; }
  .cover-chip {
    align-self: flex-start;
    margin-top: 0.3in;
    border: 1px solid var(--accent);
    color: var(--accent);
    padding: 0.04in 0.12in;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    font-size: 8.5pt;
  }

  /* Stats */
  .stat-grid-4 {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.15in;
    margin-bottom: 0.2in;
  }
  .stat-grid-3 {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.15in;
    margin-bottom: 0.2in;
  }
  .stat {
    border: 1px solid var(--rule);
    padding: 0.14in 0.16in;
    background: #fbf7ef;
  }
  .stat-label {
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 8pt;
    color: var(--ink-soft);
    margin-bottom: 0.06in;
  }
  .stat-value {
    font-size: 16pt;
    font-weight: 700;
    font-family: "Helvetica Neue", Arial, sans-serif;
  }

  .painted-secondary {
    margin: 0.18in 0;
    border: 1px solid var(--rule);
  }
  .painted-secondary img {
    width: 100%;
    display: block;
    max-height: 4in;
    object-fit: cover;
  }

  .h3 {
    font-family: "Helvetica Neue", Arial, sans-serif;
    font-weight: 700;
    font-size: 11pt;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--ink-soft);
    margin: 0 0 0.12in 0;
  }

  .facet-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10pt;
  }
  .facet-table th, .facet-table td {
    border-bottom: 1px solid var(--rule);
    padding: 0.08in 0.06in;
    text-align: left;
  }
  .facet-table th {
    font-family: "Helvetica Neue", Arial, sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 8.5pt;
    color: var(--ink-soft);
    border-bottom-color: var(--ink);
  }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .dim { color: var(--ink-soft); }
  .empty { color: var(--ink-soft); font-style: italic; padding: 0.12in 0; }

  .note {
    margin-top: 0.18in;
    padding: 0.12in 0.14in;
    border-left: 2px solid var(--accent);
    background: #fbf7ef;
    font-size: 10pt;
  }
  .note-chip {
    display: inline-block;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 8pt;
    background: var(--accent);
    color: #051019;
    padding: 0.02in 0.08in;
    margin-right: 0.08in;
    font-family: "Helvetica Neue", Arial, sans-serif;
    font-weight: 700;
  }

  .cols-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.3in;
  }
  .kv {
    display: flex;
    justify-content: space-between;
    border-bottom: 1px dotted var(--rule);
    padding: 0.06in 0;
    font-size: 10.5pt;
  }
  .kv .strong { font-weight: 700; }
  .hint-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .hint-list li {
    display: flex;
    justify-content: space-between;
    padding: 0.06in 0;
    border-bottom: 1px dotted var(--rule);
    font-size: 10.5pt;
  }
  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.08in;
  }
  .chip {
    border: 1px solid var(--rule);
    padding: 0.05in 0.1in;
    font-size: 9.5pt;
    background: #fbf7ef;
  }
  .chip-count {
    font-family: ui-monospace, Menlo, monospace;
    font-weight: 700;
    margin-left: 0.06in;
  }

  .prose p, .prose li { font-size: 10.5pt; line-height: 1.5; }
  .prose ol, .prose ul { padding-left: 0.24in; }
  .fineprint {
    margin-top: 0.3in;
    font-size: 8.5pt;
    color: var(--ink-soft);
    border-top: 1px solid var(--rule);
    padding-top: 0.12in;
  }

  @media print {
    html, body { background: var(--paper) !important; }
    .page { page-break-after: always; }
    .page.no-break-after { page-break-after: auto; }
  }
`;

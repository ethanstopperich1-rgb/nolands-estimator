/**
 * Staff-gated visual roof eval surface.
 *
 *   /internal/visual-eval                       — menu + one-click case buttons
 *   /internal/visual-eval?short=newcomb         — run one of the reference cases
 *   /internal/visual-eval?lat=…&lng=…&label=…   — run an ad-hoc address
 *
 * Server component. Runs the same 2-image (top-down + Street View)
 * Gemini 2.5 Pro eval as `scripts/eval-eagleview/eval-roof-visual.ts`,
 * then renders both inline images + the Pro JSON in one page so you can
 * eyeball identity verification and observations against the actual
 * input photos.
 *
 * This is deliberately a diagnostic surface — NOT wired into the V3
 * pipeline. Reversal = delete this file + `lib/visual-roof-eval.ts` +
 * the script.
 *
 * Gated by middleware (`/internal/*` is in PROTECTED_PAGE_PREFIXES);
 * additionally, no env keys are ever rendered to the page.
 */

import {
  REFERENCE_CASES,
  runVisualRoofEval,
  STREET_VIEW_MAX_DISTANCE_M,
  type EvalResult,
  type ReferenceShort,
} from "@/lib/visual-roof-eval";

// Gemini Pro on two images takes ~30-50s. Set the function ceiling
// high enough to allow for an outlier without blowing the page render.
export const maxDuration = 120;
export const dynamic = "force-dynamic";

interface SearchParams {
  short?: string;
  lat?: string;
  lng?: string;
  label?: string;
}

function resolveRun(
  searchParams: SearchParams,
): { lat: number; lng: number; label: string; short: string | null } | null {
  if (searchParams.short) {
    const hit = REFERENCE_CASES.find(
      (c) => c.short === (searchParams.short as ReferenceShort),
    );
    if (hit) {
      return { lat: hit.lat, lng: hit.lng, label: hit.name, short: hit.short };
    }
  }
  const lat = Number(searchParams.lat);
  const lng = Number(searchParams.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return {
      lat,
      lng,
      label: searchParams.label ?? `${lat},${lng}`,
      short: null,
    };
  }
  return null;
}

function MenuView({ note }: { note?: string }) {
  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Visual roof eval</h1>
      <p style={{ color: "#555", maxWidth: 720 }}>
        Top-down Static Maps tile + heading-corrected Street View pano →
        <code style={code}>gemini-2.5-pro</code>. Returns per-image
        identity verification, primary material, condition observations
        (enum-only — no age in years), and self-reported confidence.
        Decoupled from the V3 pipeline; this is a diagnostic surface
        used to decide whether the signal is reliable enough to ship.
      </p>
      {note && (
        <p style={{ color: "#b00", background: "#fee", padding: 12, borderRadius: 6 }}>
          {note}
        </p>
      )}
      <h2 style={{ fontSize: 16, marginTop: 24 }}>Reference cases</h2>
      <ul style={{ paddingLeft: 18 }}>
        {REFERENCE_CASES.map((c) => (
          <li key={c.short} style={{ margin: "6px 0" }}>
            <a href={`/internal/visual-eval?short=${c.short}`} style={link}>
              {c.short}
            </a>{" "}
            — {c.name}{" "}
            <span style={{ color: "#888" }}>
              ({c.lat}, {c.lng})
            </span>
          </li>
        ))}
      </ul>
      <h2 style={{ fontSize: 16, marginTop: 24 }}>Ad-hoc address</h2>
      <form method="get" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input name="lat" placeholder="lat" style={input} required />
        <input name="lng" placeholder="lng" style={input} required />
        <input name="label" placeholder="label (optional)" style={input} />
        <button type="submit" style={button}>
          Run
        </button>
      </form>
      <p style={{ color: "#888", marginTop: 24, fontSize: 13 }}>
        Each run hits Gemini 2.5 Pro once (~30–50s wall clock). The page
        will appear to hang during that window — that&apos;s normal.
      </p>
    </main>
  );
}

function Img({
  base64,
  mime,
  alt,
  caption,
}: {
  base64: string;
  mime: string;
  alt: string;
  caption: string;
}) {
  return (
    <figure style={{ margin: 0 }}>
      {/* base64 data URL — next/image can't optimize it, regular <img> is correct here */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`data:${mime};base64,${base64}`}
        alt={alt}
        style={{ maxWidth: 640, width: "100%", borderRadius: 6, display: "block" }}
      />
      <figcaption style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
        {caption}
      </figcaption>
    </figure>
  );
}

function ResultView({
  result,
  label,
  short,
}: {
  result: EvalResult;
  label: string;
  short: string | null;
}) {
  const { pano, pro } = result;
  return (
    <main style={pageStyle}>
      <div style={{ marginBottom: 16 }}>
        <a href="/internal/visual-eval" style={link}>
          ← back to menu
        </a>
      </div>
      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>{label}</h1>
      <p style={{ color: "#888", margin: "0 0 16px", fontSize: 13 }}>
        ({result.lat}, {result.lng}) · {result.totalLatencyMs}ms
        {short && ` · short=${short}`}
      </p>

      <section style={section}>
        <h2 style={h2Style}>Street View</h2>
        {pano.skipped ? (
          <p>
            <strong>skipped</strong> — {pano.skipReason ?? "n/a"}
            {pano.id && <span style={{ color: "#888" }}> (nearest pano: {pano.id})</span>}
            <br />
            <span style={{ color: "#888", fontSize: 12 }}>
              Distance gate is {STREET_VIEW_MAX_DISTANCE_M}m to avoid showing Pro a
              neighbor&apos;s rooftop.
            </span>
          </p>
        ) : (
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            <li>
              pano id <code style={code}>{pano.id}</code>
            </li>
            <li>distance to centroid {pano.distanceM?.toFixed(1)}m</li>
            <li>heading {pano.heading?.toFixed(1)}°</li>
            <li>pano date {pano.date ?? "—"}</li>
          </ul>
        )}
      </section>

      <section style={section}>
        <h2 style={h2Style}>Inputs Pro saw</h2>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Img
            base64={result.topDown.base64}
            mime={result.topDown.mime}
            alt="top-down satellite"
            caption="Image 1 — Static Maps zoom=21 satellite tile (same params as V3 pipeline)"
          />
          {result.streetView ? (
            <Img
              base64={result.streetView.base64}
              mime={result.streetView.mime}
              alt="street view"
              caption={`Image 2 — Street View heading ${pano.heading?.toFixed(0)}° from ${pano.distanceM?.toFixed(1)}m`}
            />
          ) : (
            <p style={{ color: "#888" }}>
              (no street view sent — see skip reason above)
            </p>
          )}
        </div>
      </section>

      <section style={section}>
        <h2 style={h2Style}>Pro response</h2>
        {!pro.parsed ? (
          <pre style={pre}>{pro.raw || "(empty)"}</pre>
        ) : (
          <>
            <table style={{ borderCollapse: "collapse", margin: "8px 0" }}>
              <tbody>
                <tr>
                  <td style={td}>primaryMaterial</td>
                  <td style={td}>
                    <strong>{pro.parsed.primaryMaterial}</strong>
                  </td>
                </tr>
                {pro.parsed.materialReason && (
                  <tr>
                    <td style={td}>materialReason</td>
                    <td style={td}>{pro.parsed.materialReason}</td>
                  </tr>
                )}
                <tr>
                  <td style={td}>confidence</td>
                  <td style={td}>
                    <strong>{pro.parsed.confidence}</strong>
                    {pro.parsed.confidenceReason && (
                      <span style={{ color: "#666" }}>
                        {" "}
                        — {pro.parsed.confidenceReason}
                      </span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
            <h3 style={{ fontSize: 14, margin: "12px 0 4px" }}>
              Per-image identity
            </h3>
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {pro.parsed.images.map((img) => (
                <li key={img.index}>
                  [{img.index}] <strong>{img.identity}</strong> — {img.reason}
                </li>
              ))}
            </ul>
            <h3 style={{ fontSize: 14, margin: "12px 0 4px" }}>
              Condition observations
            </h3>
            {pro.parsed.conditionObservations.length === 0 ? (
              <p style={{ color: "#888", margin: 0 }}>(none)</p>
            ) : (
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                {pro.parsed.conditionObservations.map((obs) => (
                  <li key={obs}>{obs}</li>
                ))}
              </ul>
            )}
            {pro.parsed.observationNotes && (
              <>
                <h3 style={{ fontSize: 14, margin: "12px 0 4px" }}>Notes</h3>
                <p style={{ margin: 0 }}>{pro.parsed.observationNotes}</p>
              </>
            )}
            <details style={{ marginTop: 16 }}>
              <summary style={{ cursor: "pointer", color: "#555" }}>
                raw JSON
              </summary>
              <pre style={pre}>{JSON.stringify(pro.parsed, null, 2)}</pre>
            </details>
          </>
        )}
      </section>
    </main>
  );
}

function ErrorView({ message }: { message: string }) {
  return (
    <main style={pageStyle}>
      <div style={{ marginBottom: 16 }}>
        <a href="/internal/visual-eval" style={link}>
          ← back to menu
        </a>
      </div>
      <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Eval failed</h1>
      <pre style={pre}>{message}</pre>
    </main>
  );
}

export default async function VisualEvalPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const run = resolveRun(params);
  if (!run) {
    return <MenuView />;
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  const googleKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!geminiKey || !googleKey) {
    return (
      <MenuView
        note={`Server is missing ${!geminiKey ? "GEMINI_API_KEY" : ""}${!geminiKey && !googleKey ? " and " : ""}${!googleKey ? "GOOGLE_SERVER_KEY/NEXT_PUBLIC_GOOGLE_MAPS_KEY" : ""}. Set in Vercel project env.`}
      />
    );
  }
  let result: EvalResult | null = null;
  let errorMessage: string | null = null;
  try {
    result = await runVisualRoofEval({
      lat: run.lat,
      lng: run.lng,
      label: run.label,
      geminiKey,
      googleKey,
    });
  } catch (err) {
    errorMessage =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
  }
  if (errorMessage || !result) {
    return <ErrorView message={errorMessage ?? "unknown error"} />;
  }
  return <ResultView result={result} label={run.label} short={run.short} />;
}

// ─── inline styles (no Tailwind dependency, keeps this file standalone) ─
const pageStyle: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  padding: "24px 32px",
  maxWidth: 1100,
  margin: "0 auto",
  color: "#222",
};
const section: React.CSSProperties = {
  margin: "20px 0",
  padding: 16,
  background: "#fafafa",
  border: "1px solid #e6e6e6",
  borderRadius: 8,
};
const h2Style: React.CSSProperties = {
  fontSize: 14,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "#666",
  margin: "0 0 12px",
};
const code: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  background: "#eee",
  padding: "1px 5px",
  borderRadius: 3,
};
const pre: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  background: "#f4f4f4",
  padding: 12,
  borderRadius: 6,
  overflowX: "auto",
  fontSize: 12,
};
const td: React.CSSProperties = {
  padding: "4px 12px 4px 0",
  borderBottom: "1px solid #eee",
  verticalAlign: "top",
  fontSize: 13,
};
const link: React.CSSProperties = {
  color: "#0a58ca",
  textDecoration: "none",
};
const input: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: 14,
};
const button: React.CSSProperties = {
  padding: "6px 14px",
  background: "#0a58ca",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 14,
};

/**
 * Full-pipeline eval against the three known EagleView test addresses.
 *
 *   Newcomb     — small simple roof (truth: 4 facets, 4/12 pitch,
 *                 R+H 59ft, V 22ft, K 85ft, E 88ft)
 *   Jupiter     — palm-canopy hard case (Solar MEDIUM imagery undercount)
 *   Oak Park    — large complex residential
 *
 * Hits the live /api/gemini-roof endpoint for each address with
 * `pinConfirmed=1&skipCache=1`. Renders a structured before-vs-after
 * report covering:
 *
 *   - Solar sqft (raw + corrected) and correction reason
 *   - Penetration filter chain pass-through counts (raw → 6 stages → final)
 *   - Two-pass agreement rate
 *   - Final objects by type + confidence
 *   - Cyan-mask compactness
 *   - Solar azimuth cluster count
 *   - Geometric waste % vs the legacy flat 12%
 *   - Customer tier prices: old (legacy waste, no adders) vs
 *     new (geometric waste + per-fixture adders)
 *   - EagleView ground truth where published (Newcomb)
 *
 * Usage (with `npm run dev` running locally, default):
 *   npx tsx scripts/eval-eagleview/run-pipeline-eval.ts
 *
 * Against a preview deploy:
 *   BASE_URL=https://your-preview.vercel.app \
 *   npx tsx scripts/eval-eagleview/run-pipeline-eval.ts
 *
 * The route is gated by BotID + origin + rate-limit. In dev (NODE_ENV
 * !== "production") all three guards are permissive — `npm run dev` works
 * out of the box. Against a preview URL you may need to set the request
 * Origin (the script sends one matching the URL host).
 */

import * as fs from "node:fs";
import * as path from "node:path";

const envPath = path.resolve(__dirname, "..", "..", ".env.production");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

interface TestCase {
  name: string;
  short: string;
  lat: number;
  lng: number;
  /** Published EagleView truth where available — Newcomb only today. */
  eagleview?: {
    facets?: number;
    pitchOnTwelve?: string;
    ridgesHipsLf?: number;
    valleysLf?: number;
    rakesLf?: number;
    eavesLf?: number;
    totalSqft?: number;
    wastePercent?: number;
  };
}

const CASES: TestCase[] = [
  {
    name: "2863 Newcomb Ct, Orlando FL",
    short: "newcomb",
    lat: 28.5844052,
    lng: -81.17330439999999,
    eagleview: {
      facets: 4,
      pitchOnTwelve: "4/12",
      ridgesHipsLf: 59,
      valleysLf: 22,
      rakesLf: 85,
      eavesLf: 88,
    },
  },
  {
    name: "813 Summerwood Dr, Jupiter FL",
    short: "jupiter",
    lat: 26.93252,
    lng: -80.10804,
  },
  {
    name: "8450 Oak Park Rd, Orlando FL",
    short: "oakpark",
    lat: 28.4885634,
    lng: -81.49980670000001,
  },
];

interface V3Response {
  solar: {
    sqft: number | null;
    /** Pricing-eligible sqft (≥ 12° pitch) — the asphalt-shingle basis
     *  the customer's tier prices were calculated against. Differs
     *  from `sqft` (display headline, ≥ 3°) when low-slope sections
     *  are present. Added 2026-05 audit so eval can validate the
     *  display-vs-quotable split per address. */
    quotableSqft: number | null;
    footprintSqft: number | null;
    pitchDegrees: number | null;
    segmentCount: number;
    imageryQuality: string | null;
    imageryDate: string | null;
  };
  correction: {
    applied: boolean;
    reason: string;
    solarRawSlopedSqft: number;
    solarRawFootprintSqft: number;
    gisSource: string | null;
    gisFootprintSqft: number | null;
    slopeFactor: number | null;
  } | null;
  objects: Array<{
    type: string;
    centerPx: { x: number; y: number };
    bboxPx: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
  penetrationTotals: { count: number; perimeterFt: number; areaSqft: number };
  edges: {
    ridgesHipsLf: number | null;
    valleysLf: number | null;
    rakesLf: number | null;
    eavesLf: number | null;
  };
  geminiEdges: {
    ridgesHipsLf: number;
    valleysLf: number;
    rakesLf: number;
    eavesLf: number;
    linesCount: number;
  } | null;
  facets: Array<{
    pitchDegrees: number;
    pitchOnTwelve: string;
    azimuthDegrees: number;
    compassDirection: string;
    slopedSqft: number;
    footprintSqft: number;
  }>;
  derived: {
    stories: number;
    estimatedAtticSqft: number | null;
    predominantCompass: string | null;
    complexity: "simple" | "moderate" | "complex";
  };
  geminiAnalysis: {
    facetCountEstimate: { count: number; complexity: string; confidence: number } | null;
    roofMaterial: { type: string; confidence: number } | null;
    secondaryStructures: Array<{ kind: string; confidence: number }>;
  };
  qualitySignals?: {
    compactness: number | null;
    azimuthClusters: number;
    twoPassAgreementRate: number | null;
    filterStats: {
      raw: number;
      afterConfidence: number;
      afterBbox: number;
      afterMask: number;
      afterTwoPass: number;
      afterDedup: number;
      afterCaps: number;
    };
  };
  pricing?: {
    recommendedWastePercent: number;
    wasteBreakdown: {
      fromFacets: number;
      fromAzimuthClusters: number;
      fromCompactness: number;
      fromSteepPitch: number;
      fromSecondaryStructures: number;
    };
    penetrationAddersTotal: number;
    penetrationAdderLines: Array<{
      type: string;
      count: number;
      unit: number;
      subtotal: number;
    }>;
  };
}

interface RunResult {
  tc: TestCase;
  data: V3Response | null;
  latencyMs: number;
  error: string | null;
}

// Legacy tier rates duplicated from lib/pricing/calculate-waste.ts so the
// eval can compute old-vs-new without coupling to the import surface.
const LEGACY_TIERS = [
  { id: "good", name: "Essentials", ratePerSqft: 5.25 },
  { id: "better", name: "Standard", ratePerSqft: 7.0 },
  { id: "best", name: "Fortified", ratePerSqft: 9.5 },
];

function legacyTotal(sqft: number, ratePerSqft: number, wastePercent: number): number {
  const effective = Math.round(sqft * (1 + wastePercent / 100));
  return Math.round((effective * ratePerSqft) / 50) * 50;
}

function newTotal(
  sqft: number,
  ratePerSqft: number,
  wastePercent: number,
  penetrationAdders: number,
): number {
  const effective = Math.round(sqft * (1 + wastePercent / 100));
  return Math.round((effective * ratePerSqft + penetrationAdders) / 50) * 50;
}

async function hitRoute(tc: TestCase): Promise<RunResult> {
  const url =
    `${BASE_URL}/api/gemini-roof?lat=${tc.lat}&lng=${tc.lng}` +
    `&pinConfirmed=1&skipCache=1&debug=1`;
  const t0 = Date.now();
  try {
    const host = new URL(BASE_URL).host;
    const r = await fetch(url, {
      headers: {
        // Same-origin Origin so checkOrigin allows the request even on
        // production-mode URLs (the dev path doesn't care).
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
        Host: host,
      },
    });
    const latencyMs = Date.now() - t0;
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { tc, data: null, latencyMs, error: `${r.status}: ${text.slice(0, 300)}` };
    }
    const data = (await r.json()) as V3Response;
    return { tc, data, latencyMs, error: null };
  } catch (err) {
    return {
      tc,
      data: null,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "n/a";
  return `${(n * 100).toFixed(0)}%`;
}

function fmt$(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toLocaleString()}`;
}

function printReport(r: RunResult): void {
  const { tc, data, latencyMs, error } = r;
  console.log("");
  console.log("═".repeat(78));
  console.log(`  ${tc.name}`);
  console.log(`  (${tc.lat}, ${tc.lng})  ·  ${latencyMs}ms total`);
  console.log("═".repeat(78));
  if (error) {
    console.log(`  ✖ ${error}`);
    return;
  }
  if (!data) {
    console.log(`  ✖ no response data`);
    return;
  }

  // ─── Solar measurement ──────────────────────────────────────────────
  console.log("\n  Solar measurement");
  console.log("  " + "─".repeat(60));
  const sqft = data.solar.sqft;
  const correction = data.correction;
  console.log(`    sqft (final)         ${sqft?.toLocaleString() ?? "null"}`);
  console.log(`    footprint sqft       ${data.solar.footprintSqft?.toLocaleString() ?? "null"}`);
  console.log(`    pitch                ${data.solar.pitchDegrees?.toFixed(1) ?? "null"}°`);
  console.log(`    segments (post 12°)  ${data.solar.segmentCount}`);
  console.log(`    imagery              ${data.solar.imageryQuality ?? "null"}  ${data.solar.imageryDate ?? ""}`);
  if (correction?.applied) {
    console.log(
      `    correction applied   ${correction.solarRawSlopedSqft} → ${sqft} sqft  ` +
        `(${correction.gisSource} GIS, slope ${correction.slopeFactor?.toFixed(2)})`,
    );
  } else if (correction) {
    console.log(`    correction skipped   ${correction.reason}`);
  }

  // ─── Penetration filter chain ───────────────────────────────────────
  const qs = data.qualitySignals;
  console.log("\n  Penetration filter chain");
  console.log("  " + "─".repeat(60));
  if (qs) {
    const fs = qs.filterStats;
    console.log(`    raw                  ${fs.raw}`);
    console.log(`    after confidence     ${fs.afterConfidence}  (type-specific floors)`);
    console.log(`    after bbox-in-ft     ${fs.afterBbox}`);
    console.log(`    after cyan-mask      ${fs.afterMask}  (geometric gate)`);
    console.log(`    after two-pass       ${fs.afterTwoPass}  (agreement=${fmtPct(qs.twoPassAgreementRate)})`);
    console.log(`    after dedup          ${fs.afterDedup}  (24" cluster)`);
    console.log(`    after per-sqft caps  ${fs.afterCaps}  ← FINAL`);
  } else {
    console.log(`    (qualitySignals missing — old cached response)`);
  }

  // ─── Final objects ──────────────────────────────────────────────────
  console.log("\n  Detected fixtures (post-filter)");
  console.log("  " + "─".repeat(60));
  if (data.objects.length === 0) {
    console.log(`    (none)`);
  } else {
    const byType = new Map<string, Array<{ confidence: number }>>();
    for (const o of data.objects) {
      if (!byType.has(o.type)) byType.set(o.type, []);
      byType.get(o.type)!.push({ confidence: o.confidence });
    }
    byType.forEach((entries, type) => {
      const confidences = entries.map((e) => e.confidence.toFixed(2)).join(", ");
      console.log(`    ${type.padEnd(20)} ×${entries.length}  [${confidences}]`);
    });
  }

  // ─── Geometric signals ──────────────────────────────────────────────
  console.log("\n  Geometric quality signals");
  console.log("  " + "─".repeat(60));
  console.log(`    compactness          ${qs?.compactness?.toFixed(2) ?? "n/a"}  (rectangle ≈ 1.3, L ≈ 1.8, cross ≈ 2.2+)`);
  console.log(`    azimuth clusters     ${qs?.azimuthClusters ?? "n/a"}  (1=gable, 2=L, 3+=cross-gable)`);
  console.log(`    facet count (canon)  ${data.geminiAnalysis.facetCountEstimate?.count ?? "n/a"}  ${data.geminiAnalysis.facetCountEstimate?.complexity ?? ""}`);
  console.log(`    Solar facets         ${data.facets.length}`);
  console.log(`    secondary structures ${data.geminiAnalysis.secondaryStructures.map((s) => s.kind).join(", ") || "(none)"}`);

  // ─── Waste comparison ───────────────────────────────────────────────
  console.log("\n  Waste %");
  console.log("  " + "─".repeat(60));
  const newWaste = data.pricing?.recommendedWastePercent ?? null;
  console.log(`    old (flat)           12%`);
  console.log(`    new (geometric)      ${newWaste != null ? `${newWaste}%` : "n/a"}`);
  if (data.pricing) {
    const b = data.pricing.wasteBreakdown;
    console.log(`      ├ from facets             +${b.fromFacets}`);
    console.log(`      ├ from azimuth clusters   +${b.fromAzimuthClusters}`);
    console.log(`      ├ from compactness        +${b.fromCompactness}`);
    console.log(`      ├ from steep pitch        +${b.fromSteepPitch}`);
    console.log(`      └ from secondary structs  +${b.fromSecondaryStructures}`);
  }

  // ─── Penetration adders ─────────────────────────────────────────────
  const adders = data.pricing?.penetrationAddersTotal ?? 0;
  console.log("\n  Penetration adders");
  console.log("  " + "─".repeat(60));
  console.log(`    total                ${fmt$(adders)}`);
  if (data.pricing) {
    for (const line of data.pricing.penetrationAdderLines) {
      console.log(
        `      ${line.type.padEnd(18)} ×${line.count} @ ${fmt$(line.unit)}  = ${fmt$(line.subtotal)}`,
      );
    }
  }

  // ─── Tier price comparison ──────────────────────────────────────────
  if (sqft != null && newWaste != null) {
    console.log("\n  Customer tier prices  (old → new)");
    console.log("  " + "─".repeat(60));
    for (const tier of LEGACY_TIERS) {
      const oldTotal = legacyTotal(sqft, tier.ratePerSqft, 12);
      const newT = newTotal(sqft, tier.ratePerSqft, newWaste, adders);
      const delta = newT - oldTotal;
      const sign = delta >= 0 ? "+" : "";
      console.log(
        `    ${tier.name.padEnd(12)} ${fmt$(oldTotal).padStart(9)}  →  ${fmt$(newT).padStart(9)}  ` +
          `(${sign}${fmt$(delta)})`,
      );
    }
  }

  // ─── EagleView ground truth ─────────────────────────────────────────
  if (tc.eagleview) {
    console.log("\n  EagleView ground truth");
    console.log("  " + "─".repeat(60));
    if (tc.eagleview.facets != null) {
      const ours = data.geminiAnalysis.facetCountEstimate?.count ?? data.facets.length;
      const delta = ours - tc.eagleview.facets;
      console.log(
        `    facets               EV ${tc.eagleview.facets}  ours ${ours}  (Δ${delta >= 0 ? "+" : ""}${delta})`,
      );
    }
    if (tc.eagleview.pitchOnTwelve) {
      const ours = data.facets[0]?.pitchOnTwelve ?? "—";
      console.log(`    pitch                EV ${tc.eagleview.pitchOnTwelve}  ours ${ours}`);
    }
    if (tc.eagleview.ridgesHipsLf != null && data.geminiEdges) {
      const ours = data.geminiEdges.ridgesHipsLf;
      const delta = ours - tc.eagleview.ridgesHipsLf;
      const pct = ((delta / tc.eagleview.ridgesHipsLf) * 100).toFixed(0);
      console.log(
        `    ridges+hips LF       EV ${tc.eagleview.ridgesHipsLf}  ours ${ours}  (Δ${delta >= 0 ? "+" : ""}${delta}, ${pct}%)`,
      );
    }
    if (tc.eagleview.eavesLf != null && data.geminiEdges) {
      const ours = data.geminiEdges.eavesLf;
      const delta = ours - tc.eagleview.eavesLf;
      const pct = ((delta / tc.eagleview.eavesLf) * 100).toFixed(0);
      console.log(
        `    eaves LF             EV ${tc.eagleview.eavesLf}  ours ${ours}  (Δ${delta >= 0 ? "+" : ""}${delta}, ${pct}%)`,
      );
    }
  }
}

function printSummary(results: RunResult[]): void {
  console.log("");
  console.log("═".repeat(78));
  console.log("  SUMMARY");
  console.log("═".repeat(78));
  console.log("");
  console.log(
    "  Address      Sqft   Waste   Adders    Standard $  Δ vs old  Filter rejected"
      .padEnd(78),
  );
  console.log("  " + "─".repeat(76));
  for (const r of results) {
    if (!r.data) {
      console.log(`  ${r.tc.short.padEnd(11)} ERROR  ${r.error?.slice(0, 50) ?? ""}`);
      continue;
    }
    const sqft = r.data.solar.sqft ?? 0;
    const waste = r.data.pricing?.recommendedWastePercent ?? 12;
    const adders = r.data.pricing?.penetrationAddersTotal ?? 0;
    const newT = newTotal(sqft, 7.0, waste, adders);
    const oldT = legacyTotal(sqft, 7.0, 12);
    const delta = newT - oldT;
    const fs = r.data.qualitySignals?.filterStats;
    const rejected = fs ? `${fs.raw}→${fs.afterCaps}` : "n/a";
    console.log(
      `  ${r.tc.short.padEnd(11)} ${String(sqft).padStart(5)}  ${String(waste).padStart(3)}%  ` +
        `${fmt$(adders).padStart(7)}  ${fmt$(newT).padStart(10)}  ` +
        `${(delta >= 0 ? "+" : "") + fmt$(delta)}      ${rejected}`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`Running EagleView pipeline eval against ${BASE_URL}`);
  console.log(`${CASES.length} test cases — Pro Image runs ~25-50s each.`);
  const results: RunResult[] = [];
  // Serial — each call burns ~$0.10 in Gemini credits; no need to
  // hammer the route in parallel.
  for (const tc of CASES) {
    process.stdout.write(`\n→ ${tc.name}…`);
    const r = await hitRoute(tc);
    process.stdout.write(` ${r.latencyMs}ms\n`);
    results.push(r);
  }
  for (const r of results) printReport(r);
  printSummary(results);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

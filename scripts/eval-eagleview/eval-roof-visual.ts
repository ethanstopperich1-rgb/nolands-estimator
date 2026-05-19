/**
 * Visual roof-age / condition eval — Gemini 2.5 PRO over 2 photographic
 * sources (top-down Static Maps tile + curated Street View pano).
 *
 * Core logic lives in `lib/visual-roof-eval.ts`; this is the local CLI
 * harness that reads env from .env.production / .env.local and writes
 * fetched images + Pro responses to disk for eyeballing.
 *
 * NOT wired into the V3 pipeline. See AGENTS.md + the
 * `feedback_gemini_flash_unreliable` memory for why.
 *
 * Usage:
 *   npx tsx scripts/eval-eagleview/eval-roof-visual.ts
 *
 * Requires GEMINI_API_KEY + GOOGLE_SERVER_KEY (or
 * NEXT_PUBLIC_GOOGLE_MAPS_KEY) in .env.production (preferred) or
 * .env.local.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  REFERENCE_CASES,
  runVisualRoofEval,
  type EvalResult,
} from "../../lib/visual-roof-eval";

for (const envFile of [".env.production", ".env.local"] as const) {
  const envPath = path.resolve(__dirname, "..", "..", envFile);
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`Missing ${name} in env`);
    process.exit(1);
  }
  return value;
}

const GEMINI_KEY = requireEnv("GEMINI_API_KEY", process.env.GEMINI_API_KEY);
const GOOGLE_KEY = requireEnv(
  "GOOGLE_SERVER_KEY / NEXT_PUBLIC_GOOGLE_MAPS_KEY",
  process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY,
);

const OUTPUT_ROOT = path.resolve(__dirname, "visual-eval-output");

interface RunResult {
  short: string;
  name: string;
  result: EvalResult | null;
  error: string | null;
}

function printResult(r: RunResult): void {
  console.log("");
  console.log("═".repeat(78));
  console.log(`  ${r.name}`);
  if (r.result) {
    console.log(
      `  (${r.result.lat}, ${r.result.lng})  ·  ${r.result.totalLatencyMs}ms`,
    );
  }
  console.log("═".repeat(78));
  if (r.error || !r.result) {
    console.log(`  ✖ ${r.error ?? "no result"}`);
    return;
  }
  const { pano, pro } = r.result;
  console.log("");
  console.log("  Street View");
  console.log("  " + "─".repeat(60));
  if (pano.skipped) {
    console.log(`    skipped — ${pano.skipReason}`);
    if (pano.id) console.log(`    nearest pano: ${pano.id}`);
  } else {
    console.log(`    pano id          ${pano.id}`);
    console.log(`    distance to bldg ${pano.distanceM?.toFixed(1)}m`);
    console.log(`    heading          ${pano.heading?.toFixed(1)}°`);
    console.log(`    pano date        ${pano.date ?? "—"}`);
  }
  const outDir = path.join(OUTPUT_ROOT, r.short);
  console.log("");
  console.log("  Images saved");
  console.log("  " + "─".repeat(60));
  console.log(`    top-down     ${path.relative(process.cwd(), path.join(outDir, "top-down.png"))}`);
  if (r.result.streetView) {
    console.log(`    street view  ${path.relative(process.cwd(), path.join(outDir, "street-view.jpg"))}`);
  } else {
    console.log(`    street view  (not fetched)`);
  }
  console.log("");
  console.log("  Gemini 2.5 Pro response");
  console.log("  " + "─".repeat(60));
  if (!pro.parsed) {
    console.log("    parse failed — raw text:");
    console.log(pro.raw.slice(0, 600));
    return;
  }
  const p = pro.parsed;
  console.log(`    primaryMaterial   ${p.primaryMaterial}`);
  if (p.materialReason) console.log(`      reason: ${p.materialReason}`);
  console.log(`    confidence        ${p.confidence}`);
  if (p.confidenceReason) console.log(`      reason: ${p.confidenceReason}`);
  console.log(`    images`);
  for (const img of p.images) {
    console.log(`      [${img.index}] identity=${img.identity} — ${img.reason}`);
  }
  console.log(`    conditionObservations`);
  if (p.conditionObservations.length === 0) {
    console.log(`      (none)`);
  } else {
    for (const obs of p.conditionObservations) console.log(`      - ${obs}`);
  }
  if (p.observationNotes) {
    console.log(`    notes: ${p.observationNotes}`);
  }
}

function printSummary(results: RunResult[]): void {
  console.log("");
  console.log("═".repeat(78));
  console.log("  SUMMARY");
  console.log("═".repeat(78));
  console.log("");
  console.log(
    "  short      sv?    panoDist  material                  confidence  observations",
  );
  console.log("  " + "─".repeat(76));
  for (const r of results) {
    if (r.error || !r.result) {
      console.log(`  ${r.short.padEnd(10)} ERROR  ${(r.error ?? "").slice(0, 60)}`);
      continue;
    }
    const svBadge = r.result.pano.skipped ? "no " : "yes";
    const dist =
      r.result.pano.distanceM != null
        ? `${r.result.pano.distanceM.toFixed(1)}m`
        : "—";
    const mat = r.result.pro.parsed?.primaryMaterial ?? "—";
    const conf = r.result.pro.parsed?.confidence ?? "—";
    const obs = r.result.pro.parsed?.conditionObservations?.join(",") ?? "—";
    console.log(
      `  ${r.short.padEnd(10)} ${svBadge}    ${dist.padEnd(8)}  ` +
        `${mat.padEnd(25)} ${conf.padEnd(10)} ${obs}`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`Visual roof eval — gemini-2.5-pro × 2-image (top-down + Street View)`);
  console.log(`Output dir: ${path.relative(process.cwd(), OUTPUT_ROOT)}`);
  console.log(`${REFERENCE_CASES.length} test cases.`);
  const results: RunResult[] = [];
  for (const tc of REFERENCE_CASES) {
    process.stdout.write(`\n→ ${tc.name}…`);
    const outDir = path.join(OUTPUT_ROOT, tc.short);
    fs.mkdirSync(outDir, { recursive: true });
    try {
      const result = await runVisualRoofEval({
        lat: tc.lat,
        lng: tc.lng,
        label: tc.name,
        geminiKey: GEMINI_KEY,
        googleKey: GOOGLE_KEY,
      });
      // Persist artifacts for diffing across iterations.
      fs.writeFileSync(
        path.join(outDir, "top-down.png"),
        Buffer.from(result.topDown.base64, "base64"),
      );
      if (result.streetView) {
        fs.writeFileSync(
          path.join(outDir, "street-view.jpg"),
          Buffer.from(result.streetView.base64, "base64"),
        );
      }
      fs.writeFileSync(
        path.join(outDir, "pro-response.json"),
        JSON.stringify(
          {
            case: tc,
            pano: result.pano,
            raw: result.pro.raw,
            parsed: result.pro.parsed,
          },
          null,
          2,
        ),
      );
      process.stdout.write(` ${result.totalLatencyMs}ms\n`);
      results.push({ short: tc.short, name: tc.name, result, error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(` ERROR\n`);
      results.push({ short: tc.short, name: tc.name, result: null, error: msg });
    }
  }
  for (const r of results) printResult(r);
  printSummary(results);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

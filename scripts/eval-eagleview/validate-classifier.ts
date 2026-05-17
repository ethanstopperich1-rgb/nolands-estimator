/**
 * Validate the new classifyEdges implementation against the EagleView
 * Newcomb baseline.
 *
 *   EagleView (2863 Newcomb Ct, Orlando FL 32826):
 *     Ridges + hips : 59 ft   (ridges 59, hips 0)
 *     Valleys       : 22 ft
 *     Rakes         : 85 ft
 *     Eaves         : 88 ft
 *     Facets        : 4
 *     Pitch         : 4/12
 *
 * Pulls Solar API live, builds facets the same way the V3 route does,
 * runs classifyEdges, and prints a delta table.
 *
 *   npx tsx scripts/eval-eagleview/validate-classifier.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Load env vars from .env.production if present.
const envPath = path.resolve(__dirname, "..", "..", ".env.production");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

import { classifyEdges } from "../../lib/roof-engine";
import { rotateAllFacets } from "../../lib/solar-facets";
import type { Facet, Material } from "../../types/roof";

const NEWCOMB = { lat: 28.5844052, lng: -81.17330439999999 };
const TRUTH = { ridgesHips: 59, valleys: 22, rakes: 85, eaves: 88, facets: 4 };

interface SolarResp {
  solarPotential?: {
    roofSegmentStats?: Array<{
      pitchDegrees?: number;
      azimuthDegrees?: number;
      stats?: { areaMeters2?: number; groundAreaMeters2?: number };
      boundingBox?: {
        sw: { latitude: number; longitude: number };
        ne: { latitude: number; longitude: number };
      };
    }>;
  };
  imageryQuality?: string;
}

async function fetchSolar(lat: number, lng: number): Promise<SolarResp> {
  const key = process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!key) throw new Error("missing GOOGLE_SERVER_KEY");
  const url =
    `https://solar.googleapis.com/v1/buildingInsights:findClosest` +
    `?location.latitude=${lat}&location.longitude=${lng}` +
    `&requiredQuality=LOW&key=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`solar_${r.status}: ${await r.text()}`);
  return (await r.json()) as SolarResp;
}

async function main(): Promise<void> {
  const solar = await fetchSolar(NEWCOMB.lat, NEWCOMB.lng);
  const segs = solar.solarPotential?.roofSegmentStats ?? [];
  console.log(
    `Solar returned ${segs.length} segments (imagery: ${solar.imageryQuality})`,
  );

  // Filter flat segments (mirrors the V3 route).
  const shingleSegs = segs.filter((s) => (s.pitchDegrees ?? 0) >= 8);
  console.log(`After 8° flat-filter: ${shingleSegs.length} segments\n`);

  const enriched = shingleSegs.map((s) => {
    const bb = s.boundingBox!;
    return {
      pitchDegrees: s.pitchDegrees ?? 0,
      azimuthDegrees: s.azimuthDegrees ?? 0,
      areaSqft: Math.round((s.stats?.areaMeters2 ?? 0) * 10.7639),
      groundAreaSqft: Math.round((s.stats?.groundAreaMeters2 ?? 0) * 10.7639),
      bboxLatLng: {
        swLat: bb.sw.latitude, swLng: bb.sw.longitude,
        neLat: bb.ne.latitude, neLng: bb.ne.longitude,
      },
    };
  });

  // Dominant azimuth same way buildFacetsFromSolar does.
  let sumX = 0, sumY = 0, totalA = 0;
  for (const s of enriched) {
    if (s.areaSqft <= 0) continue;
    const a = ((s.azimuthDegrees % 90) + 90) % 90;
    const rad = (a * Math.PI) / 90;
    sumX += Math.cos(rad) * s.areaSqft;
    sumY += Math.sin(rad) * s.areaSqft;
    totalA += s.areaSqft;
  }
  let dominantAzimuthDeg: number | null = null;
  if (totalA > 0) {
    const avg = (Math.atan2(sumY, sumX) * 90) / Math.PI / 2;
    dominantAzimuthDeg = ((avg % 90) + 90) % 90;
  }

  const polys = rotateAllFacets(enriched, dominantAzimuthDeg);
  const facets: Facet[] = enriched.map((s, idx) => {
    const pitchRad = (s.pitchDegrees * Math.PI) / 180;
    const azRad = (s.azimuthDegrees * Math.PI) / 180;
    return {
      id: `facet-${idx}`,
      polygon: polys[idx] ?? [],
      normal: {
        x: Math.sin(pitchRad) * Math.sin(azRad),
        y: Math.sin(pitchRad) * Math.cos(azRad),
        z: Math.cos(pitchRad),
      },
      pitchDegrees: s.pitchDegrees,
      azimuthDeg: s.azimuthDegrees,
      areaSqftSloped: s.areaSqft,
      areaSqftFootprint: s.groundAreaSqft,
      material: null as Material | null,
      isLowSlope: s.pitchDegrees < 18.43,
    };
  });

  console.log("Facets:");
  for (const f of facets) {
    console.log(
      `  ${f.id}: pitch=${f.pitchDegrees.toFixed(1)}° az=${f.azimuthDeg.toFixed(0)}° ` +
        `sloped=${f.areaSqftSloped}sqft footprint=${f.areaSqftFootprint}sqft`,
    );
  }
  console.log();

  const edges = classifyEdges(facets, dominantAzimuthDeg);
  let r = 0, v = 0, k = 0, e = 0, h = 0;
  for (const ed of edges) {
    if (ed.type === "ridge") r += ed.lengthFt;
    else if (ed.type === "hip") h += ed.lengthFt;
    else if (ed.type === "valley") v += ed.lengthFt;
    else if (ed.type === "rake") k += ed.lengthFt;
    else if (ed.type === "eave") e += ed.lengthFt;
  }
  const rh = r + h;

  const row = (label: string, truth: number, ours: number) => {
    const delta = ours - truth;
    const pct = truth === 0 ? "—" : `${((delta / truth) * 100).toFixed(0)}%`;
    return `${label.padEnd(14)} ${String(truth).padStart(5)} ft   ${String(ours).padStart(5)} ft   ${delta > 0 ? "+" : ""}${delta} (${pct})`;
  };
  console.log("Metric         EagleView    Ours       Δ");
  console.log("─".repeat(60));
  console.log(row("Ridges + hips", TRUTH.ridgesHips, rh));
  console.log(row("Valleys", TRUTH.valleys, v));
  console.log(row("Rakes", TRUTH.rakes, k));
  console.log(row("Eaves", TRUTH.eaves, e));
  console.log(row("Facets", TRUTH.facets, facets.length));
  console.log();
  console.log(`Total exterior LF: ${k + e} (EagleView: ${TRUTH.rakes + TRUTH.eaves})`);
  console.log(`Total interior LF: ${rh + v} (EagleView: ${TRUTH.ridgesHips + TRUTH.valleys})`);

  console.log("\nPer-edge breakdown:");
  for (const ed of edges) {
    console.log(`  ${ed.type.padEnd(7)} ${String(ed.lengthFt).padStart(4)} ft  ${ed.facetIds.join("↔")}`);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

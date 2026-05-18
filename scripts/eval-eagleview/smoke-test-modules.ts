import { countAzimuthClusters } from "../../lib/roof-geometry/azimuth-cluster";
import { calculateGeometricWaste } from "../../lib/pricing/calculate-waste";
import { filterPenetrations } from "../../lib/penetration-filter";

const simpleGable = countAzimuthClusters([
  { azimuthDegrees: 90, areaSqft: 600 },
  { azimuthDegrees: 270, areaSqft: 600 },
  { azimuthDegrees: 90, areaSqft: 400 },
  { azimuthDegrees: 270, areaSqft: 400 },
]);
console.log("simple gable clusters:", simpleGable, "(expect 1)");

const lShape = countAzimuthClusters([
  { azimuthDegrees: 0, areaSqft: 800 },
  { azimuthDegrees: 180, areaSqft: 800 },
  { azimuthDegrees: 90, areaSqft: 600 },
  { azimuthDegrees: 270, areaSqft: 600 },
]);
console.log("L-shape clusters:    ", lShape, "(expect 2)");

const crossGable = countAzimuthClusters([
  { azimuthDegrees: 0, areaSqft: 600 },
  { azimuthDegrees: 180, areaSqft: 600 },
  { azimuthDegrees: 90, areaSqft: 600 },
  { azimuthDegrees: 270, areaSqft: 600 },
  { azimuthDegrees: 45, areaSqft: 500 },
  { azimuthDegrees: 225, areaSqft: 500 },
]);
console.log("cross-gable clusters:", crossGable, "(expect 3)");

const w1 = calculateGeometricWaste({
  facetCount: 4,
  azimuthClusters: 1,
  compactness: 1.35,
  avgPitchDeg: 22,
  secondaryStructuresCount: 0,
  totalSqft: 1800,
});
console.log("simple gable waste:", w1.suggestedPercent + "%", w1.breakdown);

const w2 = calculateGeometricWaste({
  facetCount: 12,
  azimuthClusters: 3,
  compactness: 2.1,
  avgPitchDeg: 34,
  secondaryStructuresCount: 2,
  totalSqft: 3200,
});
console.log("complex roof waste:", w2.suggestedPercent + "%", w2.breakdown);

const fr = filterPenetrations(
  [
    {
      type: "chimney",
      centerPx: { x: 500, y: 500 },
      bboxPx: { x: 480, y: 480, width: 40, height: 40 },
      confidence: 0.65,
    },
    {
      type: "vent",
      centerPx: { x: 600, y: 600 },
      bboxPx: { x: 595, y: 595, width: 10, height: 10 },
      confidence: 0.70,
    },
    {
      type: "skylight",
      centerPx: { x: 700, y: 700 },
      bboxPx: { x: 690, y: 690, width: 60, height: 60 },
      confidence: 0.90,
    },
  ],
  { cyanMask: null, tileMPerPx: 0.075, totalSqft: 2000, secondaryDetections: null },
);
console.log("filter kept:   ", fr.kept.map((o) => `${o.type}@${o.confidence.toFixed(2)}`).join(", "));
console.log("filter dropped:", fr.stats.rejections.map((r) => `${r.type}: ${r.reason}`).join("; "));

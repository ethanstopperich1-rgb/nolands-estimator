/**
 * Azimuth clustering — counts the number of distinct "wings" of a roof
 * from the Solar API's per-facet azimuth distribution. A reliable
 * complexity signal for the waste formula, because it doesn't depend
 * on edge tracing (which the Gemini line-tracer is unreliable at).
 *
 * Theory: every gable or hip wing of a house has at most two opposing
 * facet azimuths (front + back, separated by 180°). Mod 180° collapses
 * OPPOSING facets into one bin while keeping PERPENDICULAR wings
 * distinct — exactly what we want:
 *
 *   - Simple gable / simple hip: 1 cluster (front + back facets both
 *     map to the same mod-180 bin; perpendicular hip ends do too only
 *     when they share orientation with the main slopes).
 *   - L-shape: 2 clusters (main wing + perpendicular addition).
 *   - Cross-gable / multi-wing: 3+ clusters.
 *
 * Note: mod 90° was the original choice but it collapses perpendicular
 * wings into the same cluster (0° and 90° both → 0), masking the very
 * complexity we're trying to detect. Mod 180° is the correct fold.
 *
 * Clusters with very small area share (< MIN_CLUSTER_AREA_FRACTION) are
 * dropped — they're typically a single small dormer facet that doesn't
 * represent a true wing.
 */

export interface AzimuthFacet {
  azimuthDegrees: number;
  areaSqft: number;
}

const DEFAULT_THRESHOLD_DEG = 22;
const MIN_CLUSTER_AREA_FRACTION = 0.06;
const FOLD_PERIOD_DEG = 180;

/**
 * Count distinct orientation clusters across the supplied facets.
 *
 * @param facets        Per-facet azimuth + sloped area (post pitch-filter).
 * @param thresholdDeg  Cluster radius mod 90°. Two facets join the same
 *                      cluster when their azimuths-mod-90 differ by less
 *                      than this. Default 18° (one and a half azimuth
 *                      bins) — wider than Solar's ~5° measurement
 *                      precision, tight enough that a true L-shape
 *                      resolves to two clusters.
 */
export function countAzimuthClusters(
  facets: AzimuthFacet[],
  thresholdDeg: number = DEFAULT_THRESHOLD_DEG,
): number {
  const filtered = facets.filter(
    (f) => Number.isFinite(f.azimuthDegrees) && f.areaSqft > 0,
  );
  if (filtered.length === 0) return 0;

  // Each facet contributes (azimuth mod 180°, area). Build a 1D
  // single-linkage cluster on the circular axis [0, 180).
  const items = filtered
    .map((f) => ({
      azimuth:
        ((f.azimuthDegrees % FOLD_PERIOD_DEG) + FOLD_PERIOD_DEG) % FOLD_PERIOD_DEG,
      area: f.areaSqft,
    }))
    .sort((a, b) => a.azimuth - b.azimuth);

  // Walk sorted azimuths once; whenever the gap between consecutive
  // items exceeds the threshold, start a new cluster. Then check the
  // wraparound gap (last → first + period) — if it's < threshold, the
  // first and last clusters merge.
  const clusters: Array<{ totalArea: number }> = [];
  let cursor = { totalArea: items[0].area };
  let prev = items[0].azimuth;
  for (let i = 1; i < items.length; i++) {
    const gap = items[i].azimuth - prev;
    if (gap > thresholdDeg) {
      clusters.push(cursor);
      cursor = { totalArea: items[i].area };
    } else {
      cursor.totalArea += items[i].area;
    }
    prev = items[i].azimuth;
  }
  clusters.push(cursor);

  if (clusters.length >= 2) {
    // Wraparound merge: distance from last facet azimuth back to first
    // (across the 180° → 0° boundary).
    const wrapGap =
      items[0].azimuth + FOLD_PERIOD_DEG - items[items.length - 1].azimuth;
    if (wrapGap < thresholdDeg) {
      clusters[0].totalArea += clusters[clusters.length - 1].totalArea;
      clusters.pop();
    }
  }

  // Drop tiny clusters that don't represent a real wing.
  const totalArea = clusters.reduce((s, c) => s + c.totalArea, 0);
  const significant = clusters.filter(
    (c) => c.totalArea / totalArea >= MIN_CLUSTER_AREA_FRACTION,
  );
  return significant.length;
}

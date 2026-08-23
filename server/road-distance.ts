// Pluggable geographic distance layer for grouping decisions.
//
// Modes:
//   'haversine' - straight-line distance (default; what the app always used).
//   'road'      - road-aware estimate: haversine x urban detour factor, plus
//                 a fixed penalty each time the straight segment crosses a
//                 configured barrier (a river needs a bridge detour). This is
//                 the standard detour-index approximation used when no
//                 routing engine is available.
//
// When OSRM_URL is set (a self-hosted OSRM instance with the relevant map
// extract), zone-centroid pairs can be resolved to true road distances via
// prefetchRoadMatrix(); geoDist consults that cache first in 'road' mode and
// falls back to the detour estimate for uncached pairs.

export type DistanceMode = 'haversine' | 'road';

let currentMode: DistanceMode = 'haversine';

// Urban detour index: real road distance in dense cities averages ~1.3x the
// straight line (well-documented range 1.2-1.4).
const DETOUR_FACTOR = 1.3;
// Typical extra driving to reach a bridge and come back on course.
const BARRIER_PENALTY_KM = 4;

// Named barrier polylines ([lat, lng] vertices, ordered along the barrier).
// Crossing the straight line between two points over one of these implies a
// bridge/causeway detour. Ships with the Tigris through Baghdad; extendable.
const BARRIERS: { name: string; points: [number, number][] }[] = [
  {
    name: 'Tigris (Baghdad)',
    points: [
      [33.488, 44.375],
      [33.455, 44.392],
      [33.440, 44.400],
      [33.410, 44.420],
      [33.390, 44.430],
      [33.370, 44.440],
      [33.340, 44.490],
      [33.300, 44.520],
      [33.250, 44.580],
    ],
  },
];

export function setDistanceMode(mode: DistanceMode): void {
  currentMode = mode;
}

export function getDistanceMode(): DistanceMode {
  return currentMode;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Planar segment-intersection test - adequate at city scale.
function segmentsIntersect(
  p1: [number, number], p2: [number, number],
  p3: [number, number], p4: [number, number]
): boolean {
  const orient = (a: [number, number], b: [number, number], c: [number, number]) => {
    const v = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
    if (Math.abs(v) < 1e-12) return 0;
    return v > 0 ? 1 : 2;
  };
  const o1 = orient(p1, p2, p3);
  const o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1);
  const o4 = orient(p3, p4, p2);
  return o1 !== o2 && o3 !== o4;
}

function countBarrierCrossings(lat1: number, lng1: number, lat2: number, lng2: number): number {
  let crossings = 0;
  const seg: [[number, number], [number, number]] = [[lat1, lng1], [lat2, lng2]];
  for (const barrier of BARRIERS) {
    for (let i = 1; i < barrier.points.length; i++) {
      if (segmentsIntersect(seg[0], seg[1], barrier.points[i - 1], barrier.points[i])) {
        crossings++;
        break; // one penalty per barrier, not per vertex segment
      }
    }
  }
  return crossings;
}

// --- Optional OSRM true-road-distance cache (zone-centroid level) ---

const osrmCache = new Map<string, number>();

function cacheKey(lat1: number, lng1: number, lat2: number, lng2: number): string {
  // Round to ~11m so centroid recomputations still hit the cache.
  const k = (v: number) => v.toFixed(4);
  const a = `${k(lat1)},${k(lng1)}`;
  const b = `${k(lat2)},${k(lng2)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Prefetch the pairwise road-distance matrix for a set of points from a
// self-hosted OSRM instance (OSRM_URL env var). Batched to respect OSRM's
// default table-size limits. Failures leave the cache unfilled - geoDist
// then falls back to the detour estimate, so this can never break a run.
export async function prefetchRoadMatrix(points: { lat: number; lng: number }[]): Promise<number> {
  const osrmUrl = process.env.OSRM_URL;
  if (!osrmUrl || points.length < 2) return 0;

  const BATCH = 80;
  let filled = 0;
  try {
    for (let i = 0; i < points.length; i += BATCH) {
      const batch = points.slice(i, i + BATCH);
      const coords = batch.map(p => `${p.lng},${p.lat}`).join(';');
      const url = `${osrmUrl.replace(/\/$/, '')}/table/v1/driving/${coords}?annotations=distance`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`OSRM ${resp.status}`);
      const data = await resp.json() as { distances?: number[][] };
      if (!data.distances) continue;
      for (let a = 0; a < batch.length; a++) {
        for (let b = a + 1; b < batch.length; b++) {
          const meters = data.distances[a]?.[b];
          if (typeof meters === 'number' && isFinite(meters)) {
            osrmCache.set(
              cacheKey(batch[a].lat, batch[a].lng, batch[b].lat, batch[b].lng),
              meters / 1000
            );
            filled++;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[road-distance] OSRM prefetch failed, using detour estimate:', (err as Error).message);
  }
  return filled;
}

export function clearRoadMatrix(): void {
  osrmCache.clear();
}

// The distance every grouping decision should use.
export function geoDist(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const straight = haversineKm(lat1, lng1, lat2, lng2);
  if (currentMode === 'haversine') return straight;

  const cached = osrmCache.get(cacheKey(lat1, lng1, lat2, lng2));
  if (cached !== undefined) return cached;

  return straight * DETOUR_FACTOR + countBarrierCrossings(lat1, lng1, lat2, lng2) * BARRIER_PENALTY_KM;
}

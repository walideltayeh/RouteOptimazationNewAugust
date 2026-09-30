// Pluggable geographic distance layer for grouping decisions.
//
// Modes:
//   'haversine' - straight-line distance (default; what the app always used).
//   'grid'      - street-grid distance: a rep cannot drive diagonally through
//                 a city block, so two outlets one block east and one block
//                 north of each other are two blocks apart, not 1.41. Scaling
//                 the straight line by a flat detour factor (as 'road' does)
//                 cannot express that, because it rescales every pair equally
//                 and so never changes which outlets look closest - the
//                 ranking, and therefore the grouping, comes out identical.
//                 Octile distance does change the ranking: it charges the
//                 diagonal part of a move at the true cost of cutting the
//                 corner and the rest at street cost, which favours outlets
//                 along the same street over ones catty-corner across a block.
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

export type DistanceMode = 'haversine' | 'road' | 'grid';

let currentMode: DistanceMode = 'haversine';

// Urban detour index: real road distance in dense cities averages ~1.3x the
// straight line (well-documented range 1.2-1.4).
const DETOUR_FACTOR = 1.3;
// Typical extra driving to reach a bridge and come back on course.
const BARRIER_PENALTY_KM = 4;

// Barrier polylines ([lat, lng] vertices, ordered along the barrier). Crossing
// the straight line between two points over one of these implies a bridge or
// causeway detour. Barriers are part of the plan settings - a river with few
// bridges, a railway, a motorway with no crossings - so the app carries no
// assumption about which city it is planning. A named preset is kept as an
// example of the shape.
export interface Barrier { name: string; points: [number, number][] }
let barriers: Barrier[] = [];

export const BARRIER_PRESETS: Record<string, Barrier> = {
  'tigris-baghdad': {
    name: 'Tigris (Baghdad)',
    points: [
      [33.488, 44.375], [33.455, 44.392], [33.440, 44.400], [33.410, 44.420], [33.390, 44.430],
      [33.370, 44.440], [33.340, 44.490], [33.300, 44.520], [33.250, 44.580],
    ],
  },
};

/** Replace the active barriers. Each needs a name and at least two [lat, lng] points. */
export function setBarriers(list: Barrier[]): void {
  barriers = (list || [])
    .filter(b => b && typeof b.name === 'string' && Array.isArray(b.points) && b.points.length >= 2)
    .map(b => ({ name: b.name.trim().slice(0, 80) || 'Barrier', points: b.points.map(([lat, lng]) => [Number(lat), Number(lng)] as [number, number]).filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) }))
    .filter(b => b.points.length >= 2)
    .slice(0, 50);
}
export function getBarriers(): Barrier[] { return barriers.map(b => ({ name: b.name, points: b.points.map(p => [...p] as [number, number]) })); }

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
  for (const barrier of barriers) {
    for (let i = 1; i < barrier.points.length; i++) {
      if (segmentsIntersect(seg[0], seg[1], barrier.points[i - 1], barrier.points[i])) {
        crossings++;
        break; // one penalty per barrier, not per vertex segment
      }
    }
  }
  return crossings;
}

// --- OSRM road-distance cache ---
//
// Known road distances between pairs of points. geoDist is called hundreds
// of millions of times in a run, so the lookup must not build strings: a
// coordinate rounded to 1e-4 degrees (~11 m) maps to a small integer id via
// two small-integer map lookups, and a pair of ids maps to kilometres via a
// per-id row. Everything stays a 31-bit integer key, which V8 hashes without
// allocating.
const latRows = new Map<number, Map<number, number>>(); // latI -> (lngI -> point id)
let pointCount = 0;
const pairRows: Map<number, number>[] = [];               // lower id -> (higher id -> km)
let pairCount = 0;

function pointIdOf(lat: number, lng: number, create: boolean): number {
  const latI = Math.round(lat * 1e4), lngI = Math.round(lng * 1e4);
  let row = latRows.get(latI);
  if (row === undefined) {
    if (!create) return -1;
    row = new Map<number, number>();
    latRows.set(latI, row);
  }
  let id = row.get(lngI);
  if (id === undefined) {
    if (!create) return -1;
    id = pointCount++;
    row.set(lngI, id);
    pairRows.push(new Map<number, number>());
  }
  return id;
}

/** Stores a pair's road distance; true when the pair was not known before. */
function setPairKm(lat1: number, lng1: number, lat2: number, lng2: number, km: number): boolean {
  const a = pointIdOf(lat1, lng1, true), b = pointIdOf(lat2, lng2, true);
  if (a === b) return false;
  const lo = a < b ? a : b, hi = a < b ? b : a;
  const row = pairRows[lo];
  const isNew = !row.has(hi);
  if (isNew) pairCount++;
  row.set(hi, km);
  return isNew;
}

function getPairKm(lat1: number, lng1: number, lat2: number, lng2: number): number | undefined {
  const a = pointIdOf(lat1, lng1, false);
  if (a < 0) return undefined;
  const b = pointIdOf(lat2, lng2, false);
  if (b < 0) return undefined;
  return a < b ? pairRows[a].get(b) : pairRows[b].get(a);
}

// Prefetch the pairwise road-distance matrix for a set of points (used for
// zone centroids) from the OSRM server named by OSRM_URL. Batched to respect
// OSRM's default table-size limit. Failures leave the cache unfilled - geoDist
// then falls back to the detour estimate, so this can never break a run.
export async function prefetchRoadMatrix(points: { lat: number; lng: number }[]): Promise<number> {
  const osrmUrl = process.env.OSRM_URL;
  if (!osrmUrl || points.length < 2) return 0;

  const BATCH = 80;
  let filled = 0;
  try {
    for (let i = 0; i < points.length; i += BATCH) {
      const batch = points.slice(i, i + BATCH);
      const m = await fetchTable(batch);
      if (!m) continue;
      for (let a = 0; a < batch.length; a++) {
        for (let b = a + 1; b < batch.length; b++) {
          const meters = m[a]?.[b];
          if (typeof meters === 'number' && isFinite(meters)) {
            if (setPairKm(batch[a].lat, batch[a].lng, batch[b].lat, batch[b].lng, meters / 1000)) filled++;
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
  latRows.clear();
  pairRows.length = 0;
  pointCount = 0;
  pairCount = 0;
}

// --- Outlet-level road matrix ---
//
// Real road distances for every pair of outlets a rep holds, so day cuts,
// hop checks, stop order and the kilometres shown are all by road. OSRM's
// table service answers a block of coordinates at once; the demo server
// and a default self-hosted build cap a table at 100 coordinates, so the
// points are split into chunks of half that and every pair of chunks is
// asked together, which covers every pair of points. A 300-outlet rep is
// 15 requests at the default cap and one request when OSRM_MAX_TABLE is
// raised on a self-hosted server. Pairs already known are not re-asked.
const MAX_TABLE = Math.max(20, parseInt(process.env.OSRM_MAX_TABLE || '100', 10) || 100);
let lastOsrmError = '';

export function osrmConfigured(): boolean { return !!process.env.OSRM_URL; }
export function roadMatrixSize(): number { return pairCount; }
export function roadPairKnown(lat1: number, lng1: number, lat2: number, lng2: number): boolean {
  return getPairKm(lat1, lng1, lat2, lng2) !== undefined;
}

async function fetchTable(points: { lat: number; lng: number }[]): Promise<number[][] | null> {
  const osrmUrl = process.env.OSRM_URL;
  if (!osrmUrl) return null;
  const coords = points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${osrmUrl.replace(/\/$/, '')}/table/v1/driving/${coords}?annotations=distance`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`OSRM ${resp.status}`);
    const data = await resp.json() as { code?: string; distances?: (number | null)[][]; message?: string };
    if (data.code !== 'Ok' || !data.distances) throw new Error(data.message || data.code || 'no distances');
    return data.distances.map(row => row.map(v => (typeof v === 'number' && isFinite(v) ? v : NaN)));
  } finally {
    clearTimeout(timer);
  }
}

export async function prefetchOutletMatrix(points: { lat: number; lng: number }[]): Promise<{ filled: number; requests: number; failed: boolean }> {
  if (!process.env.OSRM_URL || points.length < 2) return { filled: 0, requests: 0, failed: false };
  // Skip what is already known.
  const need = points.filter((p, i) => points.some((q, j) => j !== i && getPairKm(p.lat, p.lng, q.lat, q.lng) === undefined));
  if (need.length < 2) return { filled: 0, requests: 0, failed: false };
  const half = Math.max(10, Math.floor(MAX_TABLE / 2));
  const chunks: { lat: number; lng: number }[][] = [];
  for (let i = 0; i < need.length; i += half) chunks.push(need.slice(i, i + half));
  let filled = 0, requests = 0;
  const store = (pts: { lat: number; lng: number }[], m: number[][]) => {
    for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) {
      // Roads are one-way here and there; take the shorter direction as the pair's distance.
      const ab = m[a]?.[b], ba = m[b]?.[a];
      const meters = Number.isFinite(ab) && Number.isFinite(ba) ? Math.min(ab, ba) : Number.isFinite(ab) ? ab : ba;
      if (Number.isFinite(meters) && setPairKm(pts[a].lat, pts[a].lng, pts[b].lat, pts[b].lng, meters / 1000)) filled++;
    }
  };
  try {
    if (chunks.length === 1) {
      const m = await fetchTable(chunks[0]); requests++;
      if (m) store(chunks[0], m);
    } else {
      for (let i = 0; i < chunks.length; i++) {
        for (let j = i + 1; j < chunks.length; j++) {
          const pts = [...chunks[i], ...chunks[j]];
          const m = await fetchTable(pts); requests++;
          if (m) store(pts, m);
        }
      }
    }
    lastOsrmError = '';
    return { filled, requests, failed: false };
  } catch (err) {
    lastOsrmError = (err as Error).message;
    console.warn(`[road-distance] OSRM table failed after ${requests} request(s), using the detour estimate: ${lastOsrmError}`);
    return { filled, requests, failed: true };
  }
}

/** The driven line for a sequence of stops: geometry, road km, minutes, and the km at which each stop is reached. */
export async function osrmRoute(stops: { lat: number; lng: number }[]): Promise<{ coordinates: [number, number][]; distanceKm: number; durationMin: number; stopKm: number[] } | null> {
  const osrmUrl = process.env.OSRM_URL;
  if (!osrmUrl || stops.length < 2) return null;
  const coords = stops.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${osrmUrl.replace(/\/$/, '')}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`OSRM ${resp.status}`);
    const data = await resp.json() as { code?: string; routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] }; legs: { distance: number }[] }[] };
    const r = data.routes?.[0];
    if (data.code !== 'Ok' || !r) return null;
    const stopKm = [0];
    for (const leg of r.legs) stopKm.push(stopKm[stopKm.length - 1] + leg.distance / 1000);
    return { coordinates: r.geometry.coordinates, distanceKm: r.distance / 1000, durationMin: r.duration / 60, stopKm };
  } catch (err) {
    lastOsrmError = (err as Error).message;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** For the health endpoint: is a road server configured, and did it answer lately? */
let osrmProbe: { at: number; ok: boolean; message: string } | null = null;
export async function osrmStatus(): Promise<{ configured: boolean; reachable: boolean | null; message: string; pairsCached: number }> {
  if (!process.env.OSRM_URL) return { configured: false, reachable: null, message: 'OSRM_URL not set; road-aware mode uses a detour estimate', pairsCached: pairCount };
  if (!osrmProbe || Date.now() - osrmProbe.at > 60000) {
    try {
      const m = await fetchTable([{ lat: 0.5, lng: 0.5 }, { lat: 0.51, lng: 0.51 }]).catch(() => null);
      // A server with no road data at that spot answers "NoRoute"/"NoSegment"; that still proves it is up.
      osrmProbe = { at: Date.now(), ok: true, message: m ? 'OSRM answering' : 'OSRM up' };
    } catch (err) {
      osrmProbe = { at: Date.now(), ok: false, message: (err as Error).message };
    }
    if (lastOsrmError && !osrmProbe.ok) osrmProbe.message = lastOsrmError;
  }
  return { configured: true, reachable: osrmProbe.ok, message: osrmProbe.message, pairsCached: pairCount };
}

// Octile distance: travel the diagonal while both axes still have ground to
// cover, then straight along the remaining axis. The classic grid metric, and
// a much better match for city driving than either the straight line (too
// optimistic, and diagonally biased) or Manhattan (too pessimistic - real
// street networks do let you cut across on through-roads).
function octileKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dy = haversineKm(lat1, lng1, lat2, lng1); // north-south leg
  const dx = haversineKm(lat1, lng1, lat1, lng2); // east-west leg
  const short = Math.min(dx, dy);
  const long = Math.max(dx, dy);
  return (long - short) + Math.SQRT2 * short;
}

// The distance every grouping decision should use.
export function geoDist(lat1: number, lng1: number, lat2: number, lng2: number): number {
  if (currentMode === 'haversine') return haversineKm(lat1, lng1, lat2, lng2);
  if (currentMode === 'grid') return octileKm(lat1, lng1, lat2, lng2);

  if (pairCount > 0) {
    const road = getPairKm(lat1, lng1, lat2, lng2);
    if (road !== undefined) return road;
  }
  return haversineKm(lat1, lng1, lat2, lng2) * DETOUR_FACTOR + countBarrierCrossings(lat1, lng1, lat2, lng2) * BARRIER_PENALTY_KM;
}

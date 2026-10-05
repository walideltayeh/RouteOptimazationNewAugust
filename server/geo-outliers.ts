import { haversineKm } from "./road-distance";

export interface GeoOutlier {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
}

// Flags outlets located far outside the dataset's core coverage area (the
// market plus its rural belt) - e.g. an outlet coded to Baghdad whose GPS
// point sits in another governorate, or a Lebanese "Tripoli" geocoded to
// Libya. Always straight-line geometry, independent of the distance mode.
// Highlight-only: nothing is removed - the user decides via the exclusion
// flow after seeing the evidence.
export function detectGeoOutliers(
  outlets: { id: string; name: string; latitude: number; longitude: number }[],
  radiusKm: number = 30
): GeoOutlier[] {
  if (outlets.length < 10) return [];
  // Cluster-level isolation. Two weaker tests fail on real data: distance
  // from a median centre punishes legitimately distant-but-populated regions
  // (it flagged 483 real Lebanese outlets, 18% of that universe), while
  // k-nearest-neighbour distance misses the most common bad-data shape -
  // several records sharing one wrong coordinate, which look perfectly
  // neighbourly to each other (6 co-located Baghdad records 450km away
  // scored 0km). So: link outlets into components by proximity, then flag
  // whole components that are both small and far from the market's mass.
  const LINK_KM = 5;            // outlets within 5km belong to one component
  const CELL = LINK_KM / 111;   // degrees, ~5km
  const grid = new Map<string, typeof outlets>();
  const keyOf = (lat: number, lng: number) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;
  for (const o of outlets) {
    const k = keyOf(o.latitude, o.longitude);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(o);
  }

  const componentOf = new Map<string, number>();
  const components: { outlets: typeof outlets; lat: number; lng: number }[] = [];
  for (const seed of outlets) {
    if (componentOf.has(seed.id)) continue;
    const idx = components.length;
    const queue = [seed];
    const members: typeof outlets = [];
    componentOf.set(seed.id, idx);
    while (queue.length > 0) {
      const cur = queue.pop()!;
      members.push(cur);
      const cy = Math.floor(cur.latitude / CELL);
      const cx = Math.floor(cur.longitude / CELL);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cell = grid.get(`${cy + dy}:${cx + dx}`);
          if (!cell) continue;
          for (const n of cell) {
            if (componentOf.has(n.id)) continue;
            if (haversineKm(cur.latitude, cur.longitude, n.latitude, n.longitude) <= LINK_KM) {
              componentOf.set(n.id, idx);
              queue.push(n);
            }
          }
        }
      }
    }
    components.push({
      outlets: members,
      lat: members.reduce((s, o) => s + o.latitude, 0) / members.length,
      lng: members.reduce((s, o) => s + o.longitude, 0) / members.length,
    });
  }

  // A component is part of the market if it holds a meaningful share of the
  // universe; anything smaller must prove it sits near one that does - by
  // the real gap between outlets, not centre to centre, and possibly through
  // other villages. Centre to centre flagged 32 real Lebanese outlets: Halba
  // is 20km from Tripoli's edge but more than 30km from Tripoli's middle, and
  // the Kesrouan mountain villages chain to the coast through each other.
  const minRealSize = Math.max(10, Math.floor(outlets.length * 0.01));
  const isMain = components.map(c => c.outlets.length >= minRealSize);
  if (!isMain.some(Boolean)) return [];

  const box = components.map(c => {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const o of c.outlets) {
      if (o.latitude < minLat) minLat = o.latitude; if (o.latitude > maxLat) maxLat = o.latitude;
      if (o.longitude < minLng) minLng = o.longitude; if (o.longitude > maxLng) maxLng = o.longitude;
    }
    return { minLat, maxLat, minLng, maxLng };
  });
  // A lower bound on the gap between two components from their boxes, so most
  // pairs are ruled out without measuring a single outlet pair.
  const boxGapKm = (a: number, b: number) => {
    const A = box[a], B = box[b];
    const dLat = Math.max(0, A.minLat - B.maxLat, B.minLat - A.maxLat) * 110.57;
    const midLat = ((A.minLat + A.maxLat + B.minLat + B.maxLat) / 4) * Math.PI / 180;
    const dLng = Math.max(0, A.minLng - B.maxLng, B.minLng - A.maxLng) * 111.32 * Math.cos(midLat);
    return Math.hypot(dLat, dLng);
  };
  const gapKm = (a: number, b: number, stopBelow: number) => {
    let best = Infinity;
    for (const x of components[a].outlets) {
      for (const y of components[b].outlets) {
        const d = haversineKm(x.latitude, x.longitude, y.latitude, y.longitude);
        if (d < best) { best = d; if (best <= stopBelow) return best; }
      }
    }
    return best;
  };
  const parent = components.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let a = 0; a < components.length; a++) {
    for (let b = a + 1; b < components.length; b++) {
      if (isMain[a] && isMain[b]) continue;            // both kept whatever happens
      if (find(a) === find(b)) continue;
      if (boxGapKm(a, b) > radiusKm) continue;
      if (gapKm(a, b, radiusKm) <= radiusKm) parent[find(a)] = find(b);
    }
  }
  const anchored = new Set<number>();
  components.forEach((_, i) => { if (isMain[i]) anchored.add(find(i)); });

  const flagged: GeoOutlier[] = [];
  for (let i = 0; i < components.length; i++) {
    if (isMain[i] || anchored.has(find(i))) continue;
    let nearest = Infinity;
    for (let m = 0; m < components.length; m++) {
      if (!isMain[m]) continue;
      if (boxGapKm(i, m) >= nearest) continue;
      nearest = Math.min(nearest, gapKm(i, m, 0));
    }
    for (const o of components[i].outlets) {
      flagged.push({
        id: o.id, name: o.name,
        latitude: o.latitude, longitude: o.longitude,
        distanceKm: Math.round(nearest * 10) / 10
      });
    }
  }
  flagged.sort((a, b) => b.distanceKm - a.distanceKm);
  return flagged;
}

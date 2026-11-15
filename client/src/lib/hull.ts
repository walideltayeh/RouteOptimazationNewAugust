/** A point as [x, y] - on the map, [longitude, latitude]. */
export type Pt = [number, number];

/**
 * The convex hull of a set of points (Andrew's monotone chain), counter-
 * clockwise, without the closing point. Fewer than three distinct points,
 * or points all on one line, give back what there is.
 */
export function convexHull(points: Pt[]): Pt[] {
  const pts = Array.from(new Map(points.map(p => [`${p[0]},${p[1]}`, p])).values()).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The centre of area of a polygon; the mean of its corners if it has no area. */
export function polygonCentroid(ring: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = Math.max(1, ring.length);
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/**
 * The ground a set of points covers, as one or more rounded outlines that
 * follow the points instead of wrapping them: a territory shaped like an L,
 * or one with a pocket of outlets across the valley, is drawn as that, where
 * its convex hull would claim everything in between - including the ground
 * of whoever works inside the bend.
 *
 * The points are dropped on a grid (`cells` along the longer side - by
 * default a little over the square root of their number, so a cell holds
 * about one outlet and a dense territory does not break into crumbs), each
 * occupied cell is grown by one so neighbours join up, and the outline of
 * the grown cells is traced and its corners rounded. Holes are filled.
 * Largest piece first. Longitude is scaled by the latitude so cells are
 * square on the ground.
 */
export function footprint(points: Pt[], cells = Math.max(6, Math.min(36, Math.round(Math.sqrt(points.length) * 1.1)))): Pt[][] {
  if (points.length === 0) return [];
  const lat0 = points.reduce((s, p) => s + p[1], 0) / points.length;
  const k = Math.max(0.2, Math.cos((lat0 * Math.PI) / 180));
  const xs = points.map(p => p[0] * k), ys = points.map(p => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY);
  // A lone outlet, or several on one spot, still gets a small patch (~300 m).
  const size = Math.max(span / cells, 0.003 / 2);
  const key = (i: number, j: number) => `${i},${j}`;
  const on = new Set<string>();
  for (let n = 0; n < points.length; n++) {
    const i = Math.floor((xs[n] - minX) / size), j = Math.floor((ys[n] - minY) / size);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) on.add(key(i + di, j + dj));
  }
  // Every side of an occupied cell that faces an empty one, walked with the
  // cell on the left; the sides chain into closed outlines.
  const next = new Map<string, [number, number][]>();
  const edge = (a: [number, number], b: [number, number]) => { const kk = key(a[0], a[1]); const l = next.get(kk); if (l) l.push(b); else next.set(kk, [b]); };
  for (const c of Array.from(on)) {
    const [i, j] = c.split(",").map(Number);
    if (!on.has(key(i, j - 1))) edge([i, j], [i + 1, j]);
    if (!on.has(key(i + 1, j))) edge([i + 1, j], [i + 1, j + 1]);
    if (!on.has(key(i, j + 1))) edge([i + 1, j + 1], [i, j + 1]);
    if (!on.has(key(i - 1, j))) edge([i, j + 1], [i, j]);
  }
  const rings: [number, number][][] = [];
  for (const start of Array.from(next.keys()).sort()) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const ring: [number, number][] = [];
      let at = start.split(",").map(Number) as [number, number];
      let from: [number, number] | null = null;
      for (let guard = 0; guard < 100000; guard++) {
        const outs = next.get(key(at[0], at[1]));
        if (!outs || outs.length === 0) break;
        // Where two cells touch at a corner, keep to the left so the two do not merge into a figure of eight.
        let pick = 0;
        if (outs.length > 1 && from) {
          const dx = at[0] - from[0], dy = at[1] - from[1];
          const left = outs.findIndex(o => o[0] - at[0] === -dy && o[1] - at[1] === dx);
          if (left >= 0) pick = left;
        }
        const to = outs.splice(pick, 1)[0];
        ring.push(at);
        from = at; at = to;
        if (key(at[0], at[1]) === start) break;
      }
      if (ring.length >= 4) rings.push(ring);
    }
  }
  const area = (r: [number, number][]) => { let a = 0; for (let n = 0; n < r.length; n++) { const p = r[n], q = r[(n + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  // Outlines run counter-clockwise; a clockwise one is a hole, and is dropped.
  const outer = rings.filter(r => area(r) > 0).sort((a, b) => area(b) - area(a));
  // Corners are rounded by at most half a cell, then again by a fifth: an
  // outlet sits a full cell inside the outline, so it stays covered, and a
  // long straight side stays straight.
  const round = (r: Pt[], d: number): Pt[] => r.flatMap((p, n) => {
    const a = r[(n + r.length - 1) % r.length], b = r[(n + 1) % r.length];
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const ca = Math.min(d, la / 2) / (la || 1), cb = Math.min(d, lb / 2) / (lb || 1);
    return [[p[0] + (a[0] - p[0]) * ca, p[1] + (a[1] - p[1]) * ca], [p[0] + (b[0] - p[0]) * cb, p[1] + (b[1] - p[1]) * cb]] as Pt[];
  });
  return outer.map(r => {
    // Corners only: a straight run of cell sides is one segment.
    const corners = r.filter((p, n) => { const a = r[(n + r.length - 1) % r.length], b = r[(n + 1) % r.length]; return (p[0] - a[0]) * (b[1] - p[1]) !== (p[1] - a[1]) * (b[0] - p[0]); }) as Pt[];
    return round(round(corners, 0.5), 0.2).map(([i, j]) => [(minX + i * size) / k, minY + j * size] as Pt);
  });
}

/** Whether a point lies inside a closed outline (ray casting). */
export function insideRing(pt: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

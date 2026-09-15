import type { Outlet } from "@shared/schema";
import { geoDist } from "./road-distance";

/**
 * Grouping a rep's outlets into the days of their week.
 *
 * Load is counted in visits per week rather than in outlets, because visit
 * frequency decides how often an outlet actually costs the rep a stop:
 *   VF4 (weekly) = 1.0   VF3 (3 of 4 weeks) = 0.75
 *   VF2 (biweekly) = 0.5 VF1 (monthly) = 0.25
 */

export function weeklyLoadOf(outlet: Outlet): number {
  const vf = outlet.visitFrequency ?? 1;
  return vf / 4;
}

export function totalWeeklyLoad(outlets: Outlet[]): number {
  return outlets.reduce((sum, o) => sum + weeklyLoadOf(o), 0);
}

interface Centroid { lat: number; lng: number }

function centroidOf(group: Outlet[]): Centroid {
  if (group.length === 0) return { lat: 0, lng: 0 };
  return {
    lat: group.reduce((s, o) => s + o.latitude, 0) / group.length,
    lng: group.reduce((s, o) => s + o.longitude, 0) / group.length,
  };
}



/* ------------------------------------------------------------------ *
 * Recursive load-balanced bisection
 * ------------------------------------------------------------------ */




/**
 * Grows `k` contiguous regions outward from spread-out seeds until each holds
 * its share of the workload.
 *
 * This is the grouping the business actually asks for, and neither of the
 * earlier methods produced it:
 *
 *  - Capacitated centroid clustering met the load target by sending outlets to
 *    whichever group had room, so days interleaved across the city.
 *  - Recursive bisection cut straight lines, which tiles a uniform market
 *    nicely but not this one: Erbil is a dense core with a sparse rural fringe,
 *    so every straight slab took a slice of core AND a slice of fringe. Five
 *    days looked tight while one stretched across 79% of the territory.
 *
 * Region growing is density-blind in the right way. A region takes its NEAREST
 * unassigned outlet, so in the dense core it fills up within a few streets,
 * while a region seeded out in the countryside spreads wide because that is
 * where its neighbours are. Rural work collects into its own day - which is how
 * a rep actually plans a week - instead of being shared out among all of them.
 *
 * Growth is driven by whichever region is furthest behind on load, so the
 * regions finish together and the days come out even.
 */
export function growBalancedRegions(
  outlets: Outlet[],
  k: number,
  weightFn: (o: Outlet) => number,
  /**
   * Optional ceiling on how wide one region may become, in km (0 = none).
   *
   * This is what the "Route Compactness" setting drives, and it belongs to
   * DAY-ROUTES only. Applying it to territories as well makes the plan worse,
   * not better: a 10-rep territory legitimately spans further than one day's
   * work, so a day-sized ceiling forces the fallback path on almost every step
   * and the whole partition degrades.
   *
   * It is a preference, not a guarantee. Coverage outranks it: if no region can
   * take an outlet within the ceiling, it still goes to the nearest region
   * rather than being dropped.
   */
  maxGroupDiameterKm: number = 0,
): Outlet[][] {
  if (k <= 1 || outlets.length === 0) return [outlets];
  if (outlets.length <= k) {
    const groups: Outlet[][] = Array.from({ length: k }, () => []);
    outlets.forEach((o, i) => groups[i].push(o));
    return groups;
  }

  const n = outlets.length;
  const dist = (a: Outlet, b: Outlet) => geoDist(a.latitude, a.longitude, b.latitude, b.longitude);

  // Seeds as far apart as possible, so regions start in genuinely different
  // parts of the market rather than all inside the core.
  const seedIdx: number[] = [];
  {
    const c = centroidOf(outlets);
    let first = 0, best = -1;
    for (let i = 0; i < n; i++) {
      const d = geoDist(c.lat, c.lng, outlets[i].latitude, outlets[i].longitude);
      if (d > best) { best = d; first = i; }
    }
    seedIdx.push(first);
    const nearestSeed = outlets.map(o => dist(o, outlets[first]));
    while (seedIdx.length < k) {
      let pick = -1, far = -1;
      for (let i = 0; i < n; i++) {
        if (seedIdx.includes(i)) continue;
        if (nearestSeed[i] > far) { far = nearestSeed[i]; pick = i; }
      }
      if (pick < 0) break;
      seedIdx.push(pick);
      for (let i = 0; i < n; i++) {
        const d = dist(outlets[i], outlets[pick]);
        if (d < nearestSeed[i]) nearestSeed[i] = d;
      }
    }
  }

  const owner = new Array<number>(n).fill(-1);
  const loads = new Array<number>(k).fill(0);
  const target = outlets.reduce((s, o) => s + weightFn(o), 0) / k;

  // Bounding box per region, so the compactness cap can be checked in constant
  // time. The box diagonal slightly overstates the true spread, which is the
  // safe direction to err for a ceiling.
  const box = Array.from({ length: k }, () => ({
    minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity,
  }));
  const growBox = (g: number, o: Outlet) => {
    const b = box[g];
    b.minLat = Math.min(b.minLat, o.latitude); b.maxLat = Math.max(b.maxLat, o.latitude);
    b.minLng = Math.min(b.minLng, o.longitude); b.maxLng = Math.max(b.maxLng, o.longitude);
  };
  const spanWith = (g: number, o: Outlet): number => {
    const b = box[g];
    const minLat = Math.min(b.minLat, o.latitude), maxLat = Math.max(b.maxLat, o.latitude);
    const minLng = Math.min(b.minLng, o.longitude), maxLng = Math.max(b.maxLng, o.longitude);
    return geoDist(minLat, minLng, maxLat, maxLng);
  };

  // frontier[g][i] = distance from outlet i to the NEAREST member of region g.
  // Growing from the frontier (not from a centroid) is what keeps each region
  // in one piece.
  const frontier: number[][] = [];
  for (let g = 0; g < k; g++) {
    const seed = seedIdx[g];
    owner[seed] = g;
    loads[g] = weightFn(outlets[seed]);
    growBox(g, outlets[seed]);
    frontier.push(outlets.map(o => dist(o, outlets[seed])));
  }

  let remaining = n - k;
  while (remaining > 0) {
    // Take the cheapest growth step available anywhere, among the regions that
    // still have room.
    //
    // Letting the neediest region grow next instead made load the driver and
    // geography the passenger: a region behind on its quota would reach right
    // across the map for its next outlet. On dense Damascus data that produced
    // a 17km-wide day-route in a neighbourhood where 22 outlets fit inside
    // 508m - 33 times wider than the map required. Choosing the globally
    // nearest pair keeps every step local; capacity still caps each region, so
    // the loads come out even anyway, but tightness is no longer sacrificed to
    // get there. Dense regions fill in a few streets, sparse ones expand only
    // as far as they must.
    let g = -1, pick = -1, nearest = Infinity;
    for (let gi = 0; gi < k; gi++) {
      if (loads[gi] >= target) continue;
      const row = frontier[gi];
      for (let i = 0; i < n; i++) {
        if (owner[i] !== -1) continue;
        if (row[i] >= nearest) continue;
        // Respect the compactness ceiling while any region can still take it.
        if (maxGroupDiameterKm > 0 && spanWith(gi, outlets[i]) > maxGroupDiameterKm) continue;
        nearest = row[i]; g = gi; pick = i;
      }
    }
    // Nothing fits under the cap (or every region is full): fall back to the
    // lightest region's nearest outlet. Coverage outranks compactness.
    if (pick < 0) {
      let lightest = 0;
      for (let i = 1; i < k; i++) if (loads[i] < loads[lightest]) lightest = i;
      g = lightest;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (owner[i] !== -1) continue;
        if (frontier[g][i] < best) { best = frontier[g][i]; pick = i; }
      }
    }
    if (pick < 0 || g < 0) break;

    owner[pick] = g;
    loads[g] += weightFn(outlets[pick]);
    growBox(g, outlets[pick]);
    remaining--;
    for (let i = 0; i < n; i++) {
      if (owner[i] !== -1) continue;
      const d = dist(outlets[i], outlets[pick]);
      if (d < frontier[g][i]) frontier[g][i] = d;
    }
  }

  const groups: Outlet[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) {
    groups[owner[i] === -1 ? 0 : owner[i]].push(outlets[i]);
  }
  return groups;
}

/**
 * Evens out group loads after growing, moving only outlets that sit on a
 * shared border.
 *
 * Growth stops a region the moment it reaches its share, so regions finish a
 * little under or over and a day can land just outside the requested band (a
 * 20-visit day against a 21-24 target). This closes that gap without undoing
 * the tightness growth achieved: the outlet handed over is always the one
 * physically nearest the receiving region, so it was on the boundary anyway.
 */
export function repairLoads(
  groups: Outlet[][],
  weightFn: (o: Outlet) => number,
  maxSpreadFraction: number = 0.05,
): Outlet[][] {
  const working = groups.map(g => [...g]);
  if (working.length < 2) return working;

  const loadOf = (g: Outlet[]) => g.reduce((s, o) => s + weightFn(o), 0);
  const total = working.reduce((s, g) => s + loadOf(g), 0);
  const target = total / working.length;
  const allowed = Math.max(target * maxSpreadFraction, 1e-9);

  for (let step = 0; step < working.length * 40; step++) {
    const loads = working.map(loadOf);
    let heavy = 0, light = 0;
    for (let i = 1; i < working.length; i++) {
      if (loads[i] > loads[heavy]) heavy = i;
      if (loads[i] < loads[light]) light = i;
    }
    if (heavy === light) break;
    if (loads[heavy] - loads[light] <= allowed) break;
    if (working[heavy].length <= 1) break;

    // Nearest outlet in the heavy group to ANY member of the light group -
    // i.e. the one already on the border between them.
    let bestIdx = -1, bestD = Infinity;
    for (let i = 0; i < working[heavy].length; i++) {
      const o = working[heavy][i];
      if (o.geoStatus === 'offset') continue;
      for (const t of working[light]) {
        const d = geoDist(o.latitude, o.longitude, t.latitude, t.longitude);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
    }
    if (bestIdx < 0) break;

    const moving = working[heavy][bestIdx];
    // Do not overshoot into the mirror-image imbalance.
    if (loads[light] + weightFn(moving) > loads[heavy]) break;

    working[heavy].splice(bestIdx, 1);
    working[light].push(moving);
  }

  return working;
}

/**
 * Final polish: relocates stragglers to whichever group they actually sit in.
 *
 * The earlier swap pass scored groups by distance to their centroid, which
 * flatters a long thin group - a centroid sits in the middle of a 16km strip,
 * so every outlet looks acceptably close to it. This scores an outlet by the
 * distance to its NEAREST neighbour inside its own group, which is what the rep
 * experiences: one outlet stranded 8km from the rest of the day costs 8km
 * whatever the centroid says.
 *
 * An outlet moves when it is clearly nearer another group than its own and both
 * groups stay inside their load band, so routes tighten without reopening the
 * balance. Costs are computed from nearest-neighbour distances refreshed once
 * per pass rather than by re-scoring whole groups per candidate, which keeps
 * this linear in groups instead of cubic in outlets.
 */
export function polishByCohesion(
  groups: Outlet[][],
  weightFn: (o: Outlet) => number,
  tolerance: number = 0.08,
  maxPasses: number = 4,
): Outlet[][] {
  const working = groups.map(g => [...g]);
  if (working.length < 2) return working;

  const loadOf = (g: Outlet[]) => g.reduce((s, o) => s + weightFn(o), 0);
  const total = working.reduce((s, g) => s + loadOf(g), 0);
  const target = total / working.length;
  const lo = target * (1 - tolerance);
  const hi = target * (1 + tolerance);

  /** Distance from an outlet to the nearest OTHER member of a group. */
  const nearestIn = (o: Outlet, g: Outlet[]): number => {
    let best = Infinity;
    for (const p of g) {
      if (p.id === o.id) continue;
      const d = geoDist(o.latitude, o.longitude, p.latitude, p.longitude);
      if (d < best) best = d;
    }
    return best === Infinity ? Infinity : best;
  };

  for (let pass = 0; pass < maxPasses; pass++) {
    const loads = working.map(loadOf);
    const moves: { from: number; to: number; outlet: Outlet }[] = [];

    for (let gi = 0; gi < working.length; gi++) {
      for (const o of working[gi]) {
        if (o.geoStatus === 'offset') continue;
        const own = nearestIn(o, working[gi]);
        if (!isFinite(own)) continue;

        let bestG = -1, bestD = Infinity;
        for (let gj = 0; gj < working.length; gj++) {
          if (gj === gi) continue;
          const d = nearestIn(o, working[gj]);
          if (d < bestD) { bestD = d; bestG = gj; }
        }
        // Clearly nearer, not marginally: a 20% margin stops outlets
        // ping-ponging along a boundary where both groups fit equally well.
        if (bestG < 0 || bestD >= own * 0.8) continue;

        const w = weightFn(o);
        if (loads[gi] - w < lo) continue;
        if (loads[bestG] + w > hi) continue;
        loads[gi] -= w;
        loads[bestG] += w;
        moves.push({ from: gi, to: bestG, outlet: o });
      }
    }
    if (moves.length === 0) break;

    const moving = new Set(moves.map(m => m.outlet.id));
    for (let gi = 0; gi < working.length; gi++) {
      working[gi] = working[gi].filter(o => !moving.has(o.id));
    }
    for (const m of moves) working[m.to].push(m.outlet);
  }

  return working;
}
/**
 * Trades outlets of EQUAL weight between groups when doing so makes both
 * tighter.
 *
 * Because the two outlets carry the same visit load, every swap leaves the
 * balance exactly as it was - so unlike a plain move, this can be run to
 * convergence without ever giving back the evenness the cut achieved. It is
 * what turns the straight-line slabs left by bisection into groups that follow
 * the actual shape of the market.
 */
export function swapForCompactness(
  groups: Outlet[][],
  weightFn: (o: Outlet) => number,
  maxPasses: number = 8,
): Outlet[][] {
  const working = groups.map(g => [...g]);
  if (working.length < 2) return working;

  for (let pass = 0; pass < maxPasses; pass++) {
    const centroids = working.map(centroidOf);
    const distTo = (gi: number, o: Outlet) =>
      geoDist(centroids[gi].lat, centroids[gi].lng, o.latitude, o.longitude);

    let swaps = 0;
    for (let gi = 0; gi < working.length; gi++) {
      for (let gj = gi + 1; gj < working.length; gj++) {
        // Only outlets that would rather be in the other group are candidates.
        const wantsOut = working[gi]
          .map((o, idx) => ({ o, idx, gain: distTo(gi, o) - distTo(gj, o) }))
          .filter(c => c.gain > 0 && c.o.geoStatus !== 'offset')
          .sort((a, b) => b.gain - a.gain);
        const wantsIn = working[gj]
          .map((o, idx) => ({ o, idx, gain: distTo(gj, o) - distTo(gi, o) }))
          .filter(c => c.gain > 0 && c.o.geoStatus !== 'offset')
          .sort((a, b) => b.gain - a.gain);
        if (wantsOut.length === 0 || wantsIn.length === 0) continue;

        const usedI = new Set<number>();
        const usedJ = new Set<number>();
        for (const a of wantsOut) {
          if (usedI.has(a.idx)) continue;
          const partner = wantsIn.find(
            b => !usedJ.has(b.idx) && weightFn(b.o) === weightFn(a.o) && a.gain + b.gain > 0,
          );
          if (!partner) continue;
          usedI.add(a.idx);
          usedJ.add(partner.idx);
          swaps++;
        }
        if (usedI.size === 0) continue;

        const movingOut = Array.from(usedI).map(i => working[gi][i]);
        const movingIn = Array.from(usedJ).map(i => working[gj][i]);
        working[gi] = working[gi].filter((_, i) => !usedI.has(i)).concat(movingIn);
        working[gj] = working[gj].filter((_, i) => !usedJ.has(i)).concat(movingOut);
      }
    }
    if (swaps === 0) break;
  }

  return working;
}

/* ------------------------------------------------------------------ *
 * Tour-length polish
 * ------------------------------------------------------------------ */

/** Nearest-neighbour tour, then 2-opt until it stops improving. */
function buildTour(group: Outlet[]): Outlet[] {
  if (group.length < 3) return [...group];
  const remaining = [...group];
  const tour: Outlet[] = [remaining.shift()!];
  while (remaining.length) {
    const last = tour[tour.length - 1];
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = geoDist(last.latitude, last.longitude, remaining[i].latitude, remaining[i].longitude);
      if (d < bd) { bd = d; bi = i; }
    }
    tour.push(remaining.splice(bi, 1)[0]);
  }
  const d = (a: Outlet, b: Outlet) => geoDist(a.latitude, a.longitude, b.latitude, b.longitude);
  for (let pass = 0; pass < 12; pass++) {
    let improved = false;
    for (let i = 0; i < tour.length - 2; i++) {
      for (let j = i + 2; j < tour.length - 1; j++) {
        const delta = d(tour[i], tour[j]) + d(tour[i + 1], tour[j + 1])
                    - d(tour[i], tour[i + 1]) - d(tour[j], tour[j + 1]);
        if (delta < -1e-9) {
          let a = i + 1, b = j;
          while (a < b) { const t = tour[a]; tour[a] = tour[b]; tour[b] = t; a++; b--; }
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return tour;
}

export function tourLength(group: Outlet[]): number {
  const tour = buildTour(group);
  let total = 0;
  for (let i = 0; i < tour.length - 1; i++) {
    total += geoDist(tour[i].latitude, tour[i].longitude, tour[i + 1].latitude, tour[i + 1].longitude);
  }
  return total;
}

/**
 * Moves outlets between groups to shorten the distance actually driven.
 *
 * Every earlier pass optimised a stand-in for driving - distance to a centroid,
 * or to the nearest neighbour in the group. Those correlate with a short route
 * but are not the thing being paid for. This one scores the real objective: an
 * outlet leaves its day if the detour it costs there (the two tour legs it sits
 * between, minus the leg that would close behind it) is larger than the cheapest
 * detour it would add to some other day.
 *
 * Tours are rebuilt once per pass with nearest-neighbour plus 2-opt, and moves
 * are applied in batch, so the cost stays linear in groups rather than in
 * outlets squared.
 */
export function polishByTourLength(
  groups: Outlet[][],
  weightFn: (o: Outlet) => number,
  tolerance: number = 0.08,
  maxPasses: number = 4,
): Outlet[][] {
  const working = groups.map(g => [...g]);
  if (working.length < 2) return working;

  const loadOf = (g: Outlet[]) => g.reduce((s, o) => s + weightFn(o), 0);
  const total = working.reduce((s, g) => s + loadOf(g), 0);
  const target = total / working.length;
  const lo = target * (1 - tolerance);
  const hi = target * (1 + tolerance);
  const d = (a: Outlet, b: Outlet) => geoDist(a.latitude, a.longitude, b.latitude, b.longitude);

  for (let pass = 0; pass < maxPasses; pass++) {
    const tours = working.map(buildTour);
    const loads = working.map(loadOf);
    const moves: { from: number; to: number; outlet: Outlet }[] = [];
    const taken = new Set<string>();

    for (let gi = 0; gi < tours.length; gi++) {
      const tour = tours[gi];
      if (tour.length < 3) continue;

      for (let pos = 0; pos < tour.length; pos++) {
        const o = tour[pos];
        if (o.geoStatus === 'offset' || taken.has(o.id)) continue;
        const w = weightFn(o);
        if (loads[gi] - w < lo) continue;

        // What this stop costs where it is: the detour it forces on the tour.
        const prev = pos > 0 ? tour[pos - 1] : null;
        const next = pos < tour.length - 1 ? tour[pos + 1] : null;
        let removalGain: number;
        if (prev && next) removalGain = d(prev, o) + d(o, next) - d(prev, next);
        else if (prev) removalGain = d(prev, o);
        else if (next) removalGain = d(o, next);
        else continue;
        if (removalGain <= 0) continue;

        // Cheapest place to splice it into another day's tour.
        let bestG = -1, bestCost = Infinity;
        for (let gj = 0; gj < tours.length; gj++) {
          if (gj === gi) continue;
          if (loads[gj] + w > hi) continue;
          const t = tours[gj];
          if (t.length === 0) continue;
          let cost = Infinity;
          if (t.length === 1) {
            cost = d(t[0], o);
          } else {
            for (let e = 0; e < t.length - 1; e++) {
              const c = d(t[e], o) + d(o, t[e + 1]) - d(t[e], t[e + 1]);
              if (c < cost) cost = c;
            }
            const endCost = d(t[t.length - 1], o);
            if (endCost < cost) cost = endCost;
          }
          if (cost < bestCost) { bestCost = cost; bestG = gj; }
        }
        // 5% margin so an outlet does not shuttle back and forth between two
        // days that suit it almost equally.
        if (bestG < 0 || bestCost >= removalGain * 0.95) continue;

        loads[gi] -= w;
        loads[bestG] += w;
        taken.add(o.id);
        moves.push({ from: gi, to: bestG, outlet: o });
      }
    }

    if (moves.length === 0) break;
    const moving = new Set(moves.map(m => m.outlet.id));
    for (let gi = 0; gi < working.length; gi++) {
      working[gi] = working[gi].filter(o => !moving.has(o.id));
    }
    for (const m of moves) working[m.to].push(m.outlet);
  }

  return working;
}

/* ------------------------------------------------------------------ *
 * Space-filling-curve partition
 * ------------------------------------------------------------------ */

/**
 * Position along a Hilbert curve for a point on an integer grid.
 *
 * A Hilbert curve visits every cell of a square so that cells close together
 * on the curve are close together on the ground. That property is what makes
 * it useful here: cut the curve anywhere and both sides are compact regions.
 */
function hilbertIndex(order: number, px: number, py: number): number {
  let x = px, y = py, d = 0;
  for (let s = order / 2; s >= 1; s /= 2) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    // Rotate the quadrant so the curve stays continuous across it.
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      const t = x; x = y; y = t;
    }
  }
  return d;
}

/**
 * Splits outlets into `k` groups of equal visit load, each a contiguous piece
 * of the map, by walking a Hilbert curve and cutting it into equal-load runs.
 *
 * This replaces greedy region growing, which had a structural flaw no amount of
 * tuning could fix: a region stopped the moment it reached its quota and
 * dropped out of the running, so the outlets left over at the end - scattered
 * singles that the dense, early-finishing regions had no room for - could only
 * go to whichever regions were still under quota. The last region standing
 * inherited the remainder. Measured across ten Damascus reps, five days came
 * out tight (often under 1km) and the sixth sprawled across 72% of the rep's
 * whole territory. It had the right number of visits, which is why every count
 * check passed; it simply was not a place.
 *
 * Cutting a space-filling curve cannot produce a leftover bin. Every outlet
 * takes its position from where it is, the cuts fall where the cumulative load
 * says, and no group can finish early and leave others to sweep up.
 */
export function partitionByHilbert(
  outlets: Outlet[],
  k: number,
  weightFn: (o: Outlet) => number,
): Outlet[][] {
  if (k <= 1 || outlets.length === 0) return [outlets];
  if (outlets.length <= k) {
    const groups: Outlet[][] = Array.from({ length: k }, () => []);
    outlets.forEach((o, i) => groups[i].push(o));
    return groups;
  }

  // Project to local kilometres so latitude and longitude are comparable, then
  // onto a square grid. 2^16 cells a side is far finer than any two outlets are
  // apart, so the ordering is decided by geography rather than by rounding.
  const ORDER = 1 << 16;
  const lats = outlets.map(o => o.latitude);
  const lngs = outlets.map(o => o.longitude);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const kmPerLng = 111.32 * Math.cos((midLat * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * kmPerLng, 1e-9);
  const spanY = Math.max((maxLat - minLat) * 110.57, 1e-9);
  // One square grid over the bounding box, so a kilometre means the same in
  // both directions and the curve is not stretched along the longer axis.
  const span = Math.max(spanX, spanY);

  const ordered = outlets
    .map(o => {
      const x = Math.min(ORDER - 1, Math.floor((((o.longitude - minLng) * kmPerLng) / span) * (ORDER - 1)));
      const y = Math.min(ORDER - 1, Math.floor((((o.latitude - minLat) * 110.57) / span) * (ORDER - 1)));
      return { o, d: hilbertIndex(ORDER, x, y) };
    })
    .sort((a, b) => a.d - b.d)
    .map(e => e.o);

  // Cut into k runs whose loads match as closely as the outlets allow.
  const total = ordered.reduce((s, o) => s + weightFn(o), 0);
  const groups: Outlet[][] = Array.from({ length: k }, () => []);
  let running = 0;
  let g = 0;
  for (let i = 0; i < ordered.length; i++) {
    const w = weightFn(ordered[i]);
    // Advance to the next group when this one has had its share, while leaving
    // at least one outlet for every group still to come.
    const remainingGroups = k - g - 1;
    const remainingOutlets = ordered.length - i;
    const boundary = (total * (g + 1)) / k;
    if (g < k - 1 && running + w / 2 > boundary && remainingOutlets > remainingGroups) {
      g++;
    }
    groups[g].push(ordered[i]);
    running += w;
  }
  return groups;
}

/* ------------------------------------------------------------------ *
 * Balanced k-means with regret-ordered assignment
 * ------------------------------------------------------------------ */



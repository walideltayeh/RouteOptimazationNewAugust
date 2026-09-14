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

  // frontier[g][i] = distance from outlet i to the NEAREST member of region g.
  // Growing from the frontier (not from a centroid) is what keeps each region
  // in one piece.
  const frontier: number[][] = [];
  for (let g = 0; g < k; g++) {
    const seed = seedIdx[g];
    owner[seed] = g;
    loads[g] = weightFn(outlets[seed]);
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
        if (row[i] < nearest) { nearest = row[i]; g = gi; pick = i; }
      }
    }
    // Everything is at or over target with outlets still loose: give them to
    // whichever region is nearest, lightest first.
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

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

/**
 * Deals outlets into `buckets` groups of near-equal size while keeping each
 * bucket spatially coherent.
 *
 * Used for the week rotation inside a single day: a day's VF1 outlets are
 * split across the four weeks, VF2 across the two fortnights. Splitting those
 * by geography alone produced wildly uneven weeks (10 outlets one week, 1 the
 * next). Walking the day in route order and dealing round-robin keeps every
 * week the same size, and since a day-route is already a small area, the
 * geographic cost of doing so is negligible.
 */
export function dealEvenly(outlets: Outlet[], buckets: number): Outlet[][] {
  const result: Outlet[][] = Array.from({ length: buckets }, () => []);
  if (outlets.length === 0 || buckets <= 0) return result;

  // Nearest-neighbour walk so consecutive outlets are neighbours on the ground.
  const remaining = [...outlets];
  const ordered: Outlet[] = [];
  let current = remaining.shift()!;
  ordered.push(current);
  while (remaining.length > 0) {
    let nearestIdx = 0;
    let nearestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = geoDist(current.latitude, current.longitude, remaining[i].latitude, remaining[i].longitude);
      if (d < nearestD) { nearestD = d; nearestIdx = i; }
    }
    current = remaining.splice(nearestIdx, 1)[0];
    ordered.push(current);
  }

  ordered.forEach((o, i) => result[i % buckets].push(o));
  return result;
}


/* ------------------------------------------------------------------ *
 * Recursive load-balanced bisection
 * ------------------------------------------------------------------ */



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
    // The region furthest behind on its share grows next.
    let g = -1, worst = Infinity;
    for (let i = 0; i < k; i++) {
      const ratio = loads[i] / target;
      if (ratio < worst) { worst = ratio; g = i; }
    }
    if (g < 0) break;

    let pick = -1, nearest = Infinity;
    for (let i = 0; i < n; i++) {
      if (owner[i] !== -1) continue;
      if (frontier[g][i] < nearest) { nearest = frontier[g][i]; pick = i; }
    }
    if (pick < 0) break;

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

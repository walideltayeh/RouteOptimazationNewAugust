import type { Outlet } from "@shared/schema";
import { geoDist } from "./road-distance";

/**
 * Splitting a rep's outlets into their working-day routes.
 *
 * The previous approach handed each geographic zone to a day, so a day's size
 * was whatever the clustering step happened to produce: real plans came out as
 * 24, 26, 1, 11, 1, 1 visits across a six-day week. Zones are sized for
 * tightness, not for a day's work, and nothing ever balanced them afterwards.
 *
 * This balances on VISIT LOAD while keeping days geographically tight, which
 * is the actual business constraint: a rep works a similar-sized day every day.
 *
 * Load is measured in visits per week, not outlets, because visit frequency
 * decides how often an outlet actually costs the rep a stop:
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

/** k-means++ seeding: spread the initial day centres out instead of picking at random. */
function seedCentroids(outlets: Outlet[], k: number): Centroid[] {
  const seeds: Centroid[] = [];
  // Start from the outlet furthest from the overall centre, so the first day
  // anchors on an edge of the territory rather than its middle.
  const mid = centroidOf(outlets);
  let first = outlets[0];
  let bestD = -1;
  for (const o of outlets) {
    const d = geoDist(mid.lat, mid.lng, o.latitude, o.longitude);
    if (d > bestD) { bestD = d; first = o; }
  }
  seeds.push({ lat: first.latitude, lng: first.longitude });

  while (seeds.length < k) {
    let far: Outlet | null = null;
    let farD = -1;
    for (const o of outlets) {
      let nearest = Infinity;
      for (const s of seeds) {
        const d = geoDist(s.lat, s.lng, o.latitude, o.longitude);
        if (d < nearest) nearest = d;
      }
      if (nearest > farD) { farD = nearest; far = o; }
    }
    if (!far) break;
    seeds.push({ lat: far.latitude, lng: far.longitude });
  }
  while (seeds.length < k) seeds.push({ ...mid });
  return seeds;
}

export interface DayBalanceOptions {
  /** Fraction a day may exceed the average load before it is considered full. */
  tolerance?: number;
  iterations?: number;
}

/**
 * Partitions a rep's outlets into exactly `numDays` groups with near-equal
 * weekly visit load and tight geography.
 *
 * Capacitated Lloyd's algorithm: each round assigns every outlet to the nearest
 * day that still has room, cheapest assignments first, then recomputes the day
 * centres. Capacity is what forces balance; taking the cheapest assignments
 * first is what stops balance from shredding compactness.
 */
export function balanceIntoDayGroups(
  outlets: Outlet[],
  numDays: number,
  options: DayBalanceOptions = {},
): Outlet[][] {
  const tolerance = options.tolerance ?? 0.15;
  const iterations = options.iterations ?? 12;

  if (numDays <= 0) return [];
  if (outlets.length === 0) return Array.from({ length: numDays }, () => []);
  if (numDays === 1) return [[...outlets]];

  // Fewer outlets than days: one each, rest empty. Nothing to balance.
  if (outlets.length <= numDays) {
    const groups: Outlet[][] = Array.from({ length: numDays }, () => []);
    outlets.forEach((o, i) => groups[i].push(o));
    return groups;
  }

  const target = totalWeeklyLoad(outlets) / numDays;
  const capacity = target * (1 + tolerance);

  let centroids = seedCentroids(outlets, numDays);
  let best: Outlet[][] | null = null;
  let bestCost = Infinity;

  for (let iter = 0; iter < iterations; iter++) {
    // Every (outlet, day) pair, cheapest first. n*k is small here: a rep has
    // a few hundred outlets and at most seven days.
    const pairs: { oi: number; day: number; dist: number }[] = [];
    for (let oi = 0; oi < outlets.length; oi++) {
      const o = outlets[oi];
      for (let day = 0; day < numDays; day++) {
        pairs.push({
          oi,
          day,
          dist: geoDist(centroids[day].lat, centroids[day].lng, o.latitude, o.longitude),
        });
      }
    }
    pairs.sort((a, b) => a.dist - b.dist);

    const groups: Outlet[][] = Array.from({ length: numDays }, () => []);
    const loads = new Array<number>(numDays).fill(0);
    const assigned = new Set<number>();

    for (const pair of pairs) {
      if (assigned.has(pair.oi)) continue;
      const load = weeklyLoadOf(outlets[pair.oi]);
      if (loads[pair.day] + load > capacity) continue;
      groups[pair.day].push(outlets[pair.oi]);
      loads[pair.day] += load;
      assigned.add(pair.oi);
    }

    // Anything left over (every preferred day was full) goes to the lightest
    // day. Coverage always wins: an outlet is never dropped to protect balance.
    for (let oi = 0; oi < outlets.length; oi++) {
      if (assigned.has(oi)) continue;
      let lightest = 0;
      for (let d = 1; d < numDays; d++) if (loads[d] < loads[lightest]) lightest = d;
      groups[lightest].push(outlets[oi]);
      loads[lightest] += weeklyLoadOf(outlets[oi]);
    }

    const cost = solutionCost(groups, target);
    if (cost < bestCost) {
      bestCost = cost;
      best = groups.map(g => [...g]);
    }

    const next = groups.map((g, i) => (g.length > 0 ? centroidOf(g) : centroids[i]));
    const moved = next.some((c, i) => geoDist(c.lat, c.lng, centroids[i].lat, centroids[i].lng) > 0.001);
    centroids = next;
    if (!moved) break;
  }

  return refineBySwaps(best ?? [], target);
}

/** Spread (imbalance) plus compactness, so the search can compare rounds. */
function solutionCost(groups: Outlet[][], target: number): number {
  let imbalance = 0;
  let spread = 0;
  for (const g of groups) {
    imbalance += Math.abs(totalWeeklyLoad(g) - target);
    if (g.length > 1) {
      const c = centroidOf(g);
      for (const o of g) spread += geoDist(c.lat, c.lng, o.latitude, o.longitude);
    }
  }
  // Imbalance dominates: a tight day that only holds one outlet is not a day.
  return imbalance * 100 + spread;
}

/**
 * Moves boundary outlets from the heaviest day to a lighter neighbour when it
 * both improves balance and keeps the outlet near its new day's centre.
 */
function refineBySwaps(groups: Outlet[][], target: number): Outlet[][] {
  if (groups.length < 2) return groups;
  const working = groups.map(g => [...g]);

  for (let pass = 0; pass < 40; pass++) {
    const loads = working.map(totalWeeklyLoad);
    let heavy = 0, light = 0;
    for (let i = 1; i < working.length; i++) {
      if (loads[i] > loads[heavy]) heavy = i;
      if (loads[i] < loads[light]) light = i;
    }
    if (heavy === light) break;
    // Already even enough - a quarter of a visit is below the resolution of
    // anything a rep would notice.
    if (loads[heavy] - loads[light] < 0.25) break;

    const lightCentroid = centroidOf(working[light]);
    const heavyCentroid = centroidOf(working[heavy]);

    // The best outlet to hand over is the one already closest to the light
    // day and furthest from its own, i.e. the one on the boundary.
    let bestIdx = -1;
    let bestGain = Infinity;
    for (let i = 0; i < working[heavy].length; i++) {
      const o = working[heavy][i];
      const toLight = geoDist(lightCentroid.lat, lightCentroid.lng, o.latitude, o.longitude);
      const toHeavy = geoDist(heavyCentroid.lat, heavyCentroid.lng, o.latitude, o.longitude);
      const gain = toLight - toHeavy;
      if (gain < bestGain) { bestGain = gain; bestIdx = i; }
    }
    if (bestIdx < 0) break;

    const moving = working[heavy][bestIdx];
    const load = weeklyLoadOf(moving);
    // Don't overshoot: moving must not make the light day the heavy one.
    if (loads[light] + load > loads[heavy]) break;

    working[heavy].splice(bestIdx, 1);
    working[light].push(moving);
  }

  return working;
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

/**
 * Evens out monthly visit load between reps by moving individual boundary
 * outlets, after territories have been assigned whole zones at a time.
 *
 * Zone-level assignment can only ever be as fair as one zone is small: with a
 * handful of reps and 40-50 outlets per zone, the closest achievable split left
 * reps 16% apart. This trims the difference by handing over outlets that sit on
 * the border between a heavy territory and a lighter neighbour, so compactness
 * barely moves while the workload evens out.
 *
 * Returns the same groups, rebalanced in place.
 */
export function refineRepBalance(
  repGroups: Outlet[][],
  tolerance: number = 0.10,
): Outlet[][] {
  const groups = repGroups.map(g => [...g]);
  if (groups.length < 2) return groups;

  const monthlyVisits = (g: Outlet[]) => g.reduce((s, o) => s + (o.visitFrequency ?? 1), 0);
  const total = groups.reduce((s, g) => s + monthlyVisits(g), 0);
  const target = total / groups.length;
  // Aim at half the caller's tolerance so the finished plan sits comfortably
  // inside the band rather than resting against its edge.
  const band = target * tolerance * 0.5;

  // Bounded so a pathological dataset cannot spin here.
  const maxMoves = Math.max(50, Math.floor(total / 20));

  for (let move = 0; move < maxMoves; move++) {
    const loads = groups.map(monthlyVisits);
    let heavy = 0, light = 0;
    for (let i = 1; i < groups.length; i++) {
      if (loads[i] > loads[heavy]) heavy = i;
      if (loads[i] < loads[light]) light = i;
    }
    if (loads[heavy] - target <= band && target - loads[light] <= band) break;
    if (groups[heavy].length === 0) break;

    const lightCentroid = centroidOf(groups[light]);
    const heavyCentroid = centroidOf(groups[heavy]);

    // Prefer the outlet that is most "on the wrong side": closest to the light
    // territory's centre relative to its own.
    let bestIdx = -1;
    let bestScore = Infinity;
    for (let i = 0; i < groups[heavy].length; i++) {
      const o = groups[heavy][i];
      // Never hand over a flagged outlier - it would drag a clean territory
      // across the country.
      if (o.geoStatus === 'offset') continue;
      const toLight = geoDist(lightCentroid.lat, lightCentroid.lng, o.latitude, o.longitude);
      const toHeavy = geoDist(heavyCentroid.lat, heavyCentroid.lng, o.latitude, o.longitude);
      const score = toLight - toHeavy;
      if (score < bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestIdx < 0) break;

    const moving = groups[heavy][bestIdx];
    const visits = moving.visitFrequency ?? 1;
    // Stop rather than overshoot into a mirror-image imbalance.
    if (loads[light] + visits > loads[heavy]) break;

    groups[heavy].splice(bestIdx, 1);
    groups[light].push(moving);
  }

  return groups;
}

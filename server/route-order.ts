/**
 * The order a day's stops are driven in: an open path (the rep starts at the
 * first stop and ends at the last), built by nearest neighbour from the stop
 * farthest from the centre, then improved by 2-opt, Or-opt and 3-opt on
 * distance. A last pass then works on the path's ends and on legs over the
 * hop limit, which the earlier steps cannot see.
 *
 * Pure: the distance function is passed in, so the same code orders by
 * straight line or by road and can be tested on its own.
 */
export interface Stop { id: string; latitude: number; longitude: number }
export type Geo = (lat1: number, lng1: number, lat2: number, lng2: number) => number;

export function orderStops<T extends Stop>(outlets: T[], geo: Geo, hopKm = 0): T[] {
  const route = orderByDistance(outlets, geo);
  return relieveLongLegs(route, (a, b) => geo(a.latitude, a.longitude, b.latitude, b.longitude), hopKm);
}

function orderByDistance<T extends Stop>(outlets: T[], geo: Geo): T[] {
  if (outlets.length <= 1) return outlets;

  // Step 1: Find the centroid of all outlets
  const avgLat = outlets.reduce((sum, o) => sum + o.latitude, 0) / outlets.length;
  const avgLng = outlets.reduce((sum, o) => sum + o.longitude, 0) / outlets.length;

  // Step 2: Find the outlet farthest from centroid as starting point
  let startIdx = 0;
  let maxDist = 0;
  outlets.forEach((outlet, idx) => {
    const dist = geo(avgLat, avgLng, outlet.latitude, outlet.longitude);
    if (dist > maxDist) {
      maxDist = dist;
      startIdx = idx;
    }
  });

  // Step 3: Build initial route using nearest neighbor from the starting point
  const unvisited = [...outlets];
  const route: T[] = [];

  let current = unvisited[startIdx];
  route.push(current);
  unvisited.splice(startIdx, 1);

  while (unvisited.length > 0) {
    let nearestIdx = 0;
    let nearestDist = Infinity;

    for (let i = 0; i < unvisited.length; i++) {
      const dist = geo(
        current.latitude, current.longitude,
        unvisited[i].latitude, unvisited[i].longitude
      );
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }

    current = unvisited[nearestIdx];
    route.push(current);
    unvisited.splice(nearestIdx, 1);
  }

  // Step 4: Apply 2-opt improvement
  let improved = true;
  let iterations = 0;
  const maxIterations = 100;

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;

    for (let i = 1; i < route.length - 2; i++) {
      for (let j = i + 1; j < route.length; j++) {
        if (j - i === 1) continue;

        const currentDist = geo(
          route[i - 1].latitude, route[i - 1].longitude,
          route[i].latitude, route[i].longitude
        ) + geo(
          route[j - 1].latitude, route[j - 1].longitude,
          route[j].latitude, route[j].longitude
        );

        const newDist = geo(
          route[i - 1].latitude, route[i - 1].longitude,
          route[j - 1].latitude, route[j - 1].longitude
        ) + geo(
          route[i].latitude, route[i].longitude,
          route[j].latitude, route[j].longitude
        );

        if (newDist < currentDist) {
          const reversed = route.slice(i, j).reverse();
          route.splice(i, j - i, ...reversed);
          improved = true;
        }
      }
    }
  }

  // Step 5: Or-opt improvement - relocate segments of 1, 2, or 3 outlets
  for (const segLen of [3, 2, 1]) {
    let orImproved = true;
    let orIter = 0;
    while (orImproved && orIter < 50) {
      orImproved = false;
      orIter++;

      for (let i = 0; i < route.length - segLen + 1; i++) {
        const segStart = i;
        const segEnd = i + segLen - 1;

        const prevIdx = segStart - 1;
        const nextIdx = segEnd + 1;

        const removeCostBefore = (prevIdx >= 0
          ? geo(route[prevIdx].latitude, route[prevIdx].longitude, route[segStart].latitude, route[segStart].longitude)
          : 0);
        const removeCostAfter = (nextIdx < route.length
          ? geo(route[segEnd].latitude, route[segEnd].longitude, route[nextIdx].latitude, route[nextIdx].longitude)
          : 0);
        const removeCostBridge = (prevIdx >= 0 && nextIdx < route.length
          ? geo(route[prevIdx].latitude, route[prevIdx].longitude, route[nextIdx].latitude, route[nextIdx].longitude)
          : 0);

        const removalSaving = removeCostBefore + removeCostAfter - removeCostBridge;

        let bestInsertPos = -1;
        let bestInsertCost = Infinity;

        for (let j = 0; j < route.length - 1; j++) {
          if (j >= segStart - 1 && j <= segEnd) continue;

          const currentEdge = geo(
            route[j].latitude, route[j].longitude,
            route[j + 1].latitude, route[j + 1].longitude
          );
          const insertCost =
            geo(route[j].latitude, route[j].longitude, route[segStart].latitude, route[segStart].longitude) +
            geo(route[segEnd].latitude, route[segEnd].longitude, route[j + 1].latitude, route[j + 1].longitude) -
            currentEdge;

          if (insertCost < bestInsertCost) {
            bestInsertCost = insertCost;
            bestInsertPos = j;
          }
        }

        if (bestInsertPos >= 0 && bestInsertCost < removalSaving - 1e-10) {
          const segment = route.splice(segStart, segLen);
          const insertAt = bestInsertPos >= segStart ? bestInsertPos - segLen + 1 : bestInsertPos + 1;
          route.splice(insertAt, 0, ...segment);
          orImproved = true;
          break;
        }
      }
    }
  }

  // Step 6: 3-opt improvement (only for routes with ≤ 50 outlets to keep it tractable)
  if (route.length <= 50 && route.length >= 4) {
    const n = route.length;

    const segDist = (a: number, b: number): number => {
      return geo(route[a].latitude, route[a].longitude, route[b].latitude, route[b].longitude);
    };

    let threeOptImproved = true;
    let threeOptPasses = 0;
    const maxThreeOptPasses = 5;

    while (threeOptImproved && threeOptPasses < maxThreeOptPasses) {
      threeOptImproved = false;
      threeOptPasses++;

      for (let i = 0; i < n - 4; i++) {
        for (let j = i + 2; j < n - 2; j++) {
          for (let kk = j + 2; kk < n; kk++) {
            const i1 = i, i2 = i + 1;
            const j1 = j, j2 = j + 1;
            const k1 = kk, k2 = (kk + 1) % n;

            if (k2 === 0 && kk === n - 1) {
              continue;
            }
            if (k2 >= n) continue;

            const d0 = segDist(i1, i2) + segDist(j1, j2) + segDist(k1, k2);

            const segA = route.slice(0, i2);
            const segB = route.slice(i2, j2);
            const segC = route.slice(j2, k2);
            const segD = route.slice(k2);

            const reconnections: { segments: T[][]; cost: number }[] = [
              { segments: [segA, segB.slice().reverse(), segC, segD], cost: segDist(i1, j1) + segDist(i2, j2) + segDist(k1, k2) },
              { segments: [segA, segB, segC.slice().reverse(), segD], cost: segDist(i1, i2) + segDist(j1, k1) + segDist(j2, k2) },
              { segments: [segA, segB.slice().reverse(), segC.slice().reverse(), segD], cost: segDist(i1, j1) + segDist(i2, k1) + segDist(j2, k2) },
              { segments: [segA, segC, segB, segD], cost: segDist(i1, j2) + segDist(k1, i2) + segDist(j1, k2) },
              { segments: [segA, segC, segB.slice().reverse(), segD], cost: segDist(i1, j2) + segDist(k1, j1) + segDist(i2, k2) },
              { segments: [segA, segC.slice().reverse(), segB, segD], cost: segDist(i1, k1) + segDist(j2, i2) + segDist(j1, k2) },
              { segments: [segA, segC.slice().reverse(), segB.slice().reverse(), segD], cost: segDist(i1, k1) + segDist(j2, j1) + segDist(i2, k2) },
            ];

            let bestCost = d0;
            let bestReconnection: T[][] | null = null;

            for (const r of reconnections) {
              if (r.cost < bestCost - 1e-10) {
                bestCost = r.cost;
                bestReconnection = r.segments;
              }
            }

            if (bestReconnection) {
              const newRoute = bestReconnection.flat();
              route.length = 0;
              route.push(...newRoute);
              threeOptImproved = true;
              break;
            }
          }
          if (threeOptImproved) break;
        }
        if (threeOptImproved) break;
      }
    }
  }

  return route;
}

/**
 * Finishes an open path. The steps above keep the first stop fixed and never
 * move a stop to either end, so a path that should start at the tip of a
 * side street starts in its middle and jumps back. This pass allows those
 * moves (reversing a head or a tail, moving a short run anywhere including
 * the ends) and prices a leg over the hop limit at half as much again, so it
 * will drive a little further to avoid one long jump - what the hop limit
 * asks for - but not a lot further. The result is kept when it has fewer
 * long legs, or the same number and less distance.
 */
export function relieveLongLegs<T>(route: T[], d: (a: T, b: T) => number, hopKm: number, premium = 0.5): T[] {
  const n = route.length;
  if (n < 3) return route;
  const pen = (x: number) => (hopKm > 0 && x > hopKm ? x * (1 + premium) : x);
  const leg = (a: T | undefined, b: T | undefined) => (a === undefined || b === undefined ? 0 : pen(d(a, b)));
  const measure = (r: T[]) => {
    let km = 0, long = 0;
    for (let i = 1; i < r.length; i++) { const x = d(r[i - 1], r[i]); km += x; if (hopKm > 0 && x > hopKm) long++; }
    return { km, long };
  };
  let r = route.slice();
  let improved = true;
  for (let pass = 0; improved && pass < 40; pass++) {
    improved = false;
    // Reverse any stretch, heads and tails included.
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const before = leg(r[i - 1], r[i]) + leg(r[j], r[j + 1]);
        const after = leg(r[i - 1], r[j]) + leg(r[i], r[j + 1]);
        if (after < before - 1e-9) {
          for (let a = i, b = j; a < b; a++, b--) { const t = r[a]; r[a] = r[b]; r[b] = t; }
          improved = true;
        }
      }
    }
    // Move a run of one to three stops anywhere, either way round, ends included.
    for (let len = 1; len <= 3 && len < n; len++) {
      for (let s = 0; s + len <= n; s++) {
        const e = s + len - 1;
        const saved = leg(r[s - 1], r[s]) + leg(r[e], r[e + 1]) - leg(r[s - 1], r[e + 1]);
        if (saved <= 1e-9) continue;
        const rest = r.slice(0, s).concat(r.slice(e + 1));
        const seg = r.slice(s, e + 1);
        let best = saved - 1e-9, bestAt = -1, bestFlip = false;
        for (let k = 0; k <= rest.length; k++) {
          if (k === s) continue; // where it came from
          const a = rest[k - 1], b = rest[k];
          const gap = leg(a, b);
          const fwd = leg(a, seg[0]) + leg(seg[len - 1], b) - gap;
          const rev = leg(a, seg[len - 1]) + leg(seg[0], b) - gap;
          if (fwd < best) { best = fwd; bestAt = k; bestFlip = false; }
          if (rev < best) { best = rev; bestAt = k; bestFlip = true; }
        }
        if (bestAt >= 0) {
          if (bestFlip) seg.reverse();
          r = rest.slice(0, bestAt).concat(seg, rest.slice(bestAt));
          improved = true;
        }
      }
    }
  }
  const was = measure(route), now = measure(r);
  return now.long < was.long || (now.long === was.long && now.km < was.km - 1e-9) ? r : route;
}

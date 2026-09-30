import { describe, it, expect } from "vitest";
import type { Outlet } from "../shared/schema";
import { bandOf, reachabilityComponents, longestHop, tourLength, repairLoads, partitionByHilbert, gapBetween } from "../server/day-balancer";

// Damascus-ish coordinates. 0.009 degrees of latitude is about 1 km.
function outlet(id: string, lat: number, lng: number, vf = 2): Outlet {
  return { id, name: id, code: id, pinnedRoute: null, address: "", latitude: lat, longitude: lng, visitFrequency: vf, timePerVisit: 30, value: null, geoStatus: null, territory: null, repId: null, cluster: null, createdAt: null } as Outlet;
}
function blob(prefix: string, n: number, lat: number, lng: number, spreadKm = 0.3): Outlet[] {
  let seed = 11;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5; };
  return Array.from({ length: n }, (_, i) => outlet(`${prefix}${i}`, lat + rnd() * spreadKm / 111, lng + rnd() * spreadKm / 92));
}
const weight = (o: Outlet) => o.visitFrequency;

describe("bandOf", () => {
  it("symmetric and asymmetric bands", () => {
    const sym = bandOf(100, 0.1);
    expect(sym.lo).toBeCloseTo(90, 5);
    expect(sym.hi).toBeCloseTo(110, 5);
    const asym = bandOf(100, { below: 0.05, above: 0.2 });
    expect(asym.lo).toBeCloseTo(95, 5);
    expect(asym.hi).toBeCloseTo(120, 5);
  });
});

describe("reachabilityComponents", () => {
  it("splits a pocket that is further than the hop limit from everything else", () => {
    const main = blob("m", 20, 33.50, 36.28);
    const pocket = blob("p", 6, 33.59, 36.28); // ~10 km north
    const parts = reachabilityComponents([...main, ...pocket], 4);
    expect(parts.length).toBe(2);
    expect(parts.map(p => p.length).sort((a, b) => a - b)).toEqual([6, 20]);
    expect(gapBetween(parts[0], parts[1])).toBeGreaterThan(4);
  });
  it("is one piece when everything chains within the limit, or when the limit is off", () => {
    const chain = Array.from({ length: 6 }, (_, i) => outlet(`c${i}`, 33.50 + i * 0.03, 36.28)); // 3.3 km steps
    expect(reachabilityComponents(chain, 4).length).toBe(1);
    expect(reachabilityComponents(chain, 2).length).toBe(6);
    expect(reachabilityComponents(chain, 0).length).toBe(1);
  });
});

describe("tours", () => {
  it("longest hop and tour length agree with straight-line geometry", () => {
    const two = [outlet("a", 33.50, 36.28), outlet("b", 33.509, 36.28)]; // ~1 km apart
    expect(longestHop(two)).toBeCloseTo(1.0, 1);
    expect(tourLength(two)).toBeCloseTo(1.0, 1);
    const tight = blob("t", 12, 33.50, 36.28, 0.2);
    expect(longestHop(tight)).toBeLessThan(0.5);
    expect(longestHop([])).toBe(0);
  });
});

describe("partitionByHilbert", () => {
  it("returns k groups that together hold every outlet exactly once", () => {
    const all = [...blob("a", 30, 33.50, 36.28), ...blob("b", 30, 33.52, 36.30), ...blob("c", 30, 33.54, 36.32)];
    const groups = partitionByHilbert(all, 3, weight);
    expect(groups.length).toBe(3);
    const ids = groups.flat().map(o => o.id).sort();
    expect(ids).toEqual(all.map(o => o.id).sort());
    const loads = groups.map(g => g.reduce((s, o) => s + weight(o), 0));
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(6);
  });
});

describe("repairLoads", () => {
  it("moves border outlets until every day sits inside the band", () => {
    const heavy = blob("h", 30, 33.500, 36.280, 0.4);
    const light = blob("l", 10, 33.504, 36.280, 0.4); // adjoining
    const groups = repairLoads([heavy, light], weight, 0.1);
    const loads = groups.map(g => g.reduce((s, o) => s + weight(o), 0));
    const mean = loads.reduce((a, b) => a + b, 0) / loads.length;
    for (const l of loads) {
      expect(l).toBeGreaterThanOrEqual(mean * 0.9 - 2);
      expect(l).toBeLessThanOrEqual(mean * 1.1 + 2);
    }
    expect(groups.flat().length).toBe(40);
  });
  it("refuses a move that would create a hop longer than the limit", () => {
    const heavy = blob("h", 30, 33.500, 36.280, 0.4);
    const far = blob("l", 10, 33.590, 36.280, 0.4); // 10 km away
    const groups = repairLoads([heavy, far], weight, 0.1, 4);
    expect(groups[0].length).toBe(30);
    expect(groups[1].length).toBe(10);
  });
});

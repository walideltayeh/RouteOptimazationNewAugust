import { describe, it, expect } from "vitest";
import type { Outlet } from "../shared/schema";
import { improveByRouteCost, tourLength } from "../server/day-balancer";

function outlet(id: string, lat: number, lng: number): Outlet {
  return { id, name: id, code: id, pinnedRoute: null, address: "", latitude: lat, longitude: lng, visitFrequency: 2, timePerVisit: 30, value: null, geoStatus: null, territory: null, repId: null, cluster: null, createdAt: null } as Outlet;
}
const w = () => 1;
const km = (groups: Outlet[][]) => groups.reduce((s, g) => s + tourLength(g), 0);

describe("improveByRouteCost", () => {
  it("un-interleaves two days that alternate along the same street", () => {
    // 24 outlets on one east-west street, 150 m apart. Day A holds the even
    // ones, day B the odd ones: both tours run the whole street. The right
    // answer is west half / east half.
    const street = Array.from({ length: 24 }, (_, i) => outlet(`s${i}`, 33.5, 36.28 + i * 0.0016));
    const a = street.filter((_, i) => i % 2 === 0);
    const b = street.filter((_, i) => i % 2 === 1);
    const before = km([a, b]);
    const after = improveByRouteCost([a, b], w, 0.05, 0, 20);
    expect(after.flat().length).toBe(24);
    expect(after.map(g => g.length).sort()).toEqual([12, 12]); // band kept
    // A perfectly collinear alternation is the worst case for segment moves
    // (every interior stop has zero detour); a quarter off is what they find.
    expect(km(after)).toBeLessThan(before * 0.75);
    // And the days are far less interleaved: count runs of the same day along the street.
    const runs = (gs: Outlet[][]) => {
      const owner = new Map<string, number>(); gs.forEach((g, i) => g.forEach(o => owner.set(o.id, i)));
      let r = 1; for (let i = 1; i < 24; i++) if (owner.get(`s${i}`) !== owner.get(`s${i - 1}`)) r++; return r;
    };
    expect(runs(after)).toBeLessThan(runs([a, b]) / 2);
  });

  it("swaps a stranded pocket for outlets the other day holds near this day's core, when relocation alone cannot", () => {
    // Day A: a core of 20 in the west plus a pocket of 4 in the east.
    // Day B: 20 in the east plus 4 sitting inside A's western core.
    // Both days are at the load limit, so only exchanges can fix it.
    const westCore = Array.from({ length: 20 }, (_, i) => outlet(`wc${i}`, 33.50 + (i % 5) * 0.002, 36.28 + Math.floor(i / 5) * 0.002));
    const eastCore = Array.from({ length: 20 }, (_, i) => outlet(`ec${i}`, 33.50 + (i % 5) * 0.002, 36.33 + Math.floor(i / 5) * 0.002));
    const pocketEast = Array.from({ length: 4 }, (_, i) => outlet(`pe${i}`, 33.503 + i * 0.001, 36.335));
    const strayWest = Array.from({ length: 4 }, (_, i) => outlet(`sw${i}`, 33.503 + i * 0.001, 36.283));
    const A = [...westCore, ...pocketEast];
    const B = [...eastCore, ...strayWest];
    const before = km([A, B]);
    const after = improveByRouteCost([A, B], w, 0.02, 0, 20); // 2% band: no relocation possible
    expect(after.map(g => g.length)).toEqual([24, 24]);
    expect(km(after)).toBeLessThan(before * 0.7);
    const ofA = new Set(after[0].map(o => o.id));
    const westIds = [...westCore, ...strayWest].map(o => o.id);
    const eastIds = [...eastCore, ...pocketEast].map(o => o.id);
    const aIsWest = westIds.every(id => ofA.has(id));
    const aIsEast = eastIds.every(id => ofA.has(id));
    expect(aIsWest || aIsEast).toBe(true);
  });

  it("never makes the plan longer and respects the hop limit pricing", () => {
    const a = Array.from({ length: 10 }, (_, i) => outlet(`a${i}`, 33.50, 36.28 + i * 0.001));
    const b = Array.from({ length: 10 }, (_, i) => outlet(`b${i}`, 33.60, 36.28 + i * 0.001)); // 11 km north
    const before = km([a, b]);
    const after = improveByRouteCost([a, b], w, 0.1, 4, 5);
    expect(km(after)).toBeLessThanOrEqual(before + 1e-9);
    expect(after.map(g => g.length).sort()).toEqual([10, 10]);
  });
});

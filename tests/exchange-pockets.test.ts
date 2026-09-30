import { describe, it, expect } from "vitest";
import type { Outlet } from "../shared/schema";
import { exchangePockets, reachabilityComponents, repairLoads } from "../server/day-balancer";

function outlet(id: string, lat: number, lng: number, vf = 2): Outlet {
  return { id, name: id, code: id, pinnedRoute: null, address: "", latitude: lat, longitude: lng, visitFrequency: vf, timePerVisit: 30, value: null, geoStatus: null, territory: null, repId: null, cluster: null, createdAt: null } as Outlet;
}
const grid = (prefix: string, n: number, lat: number, lng: number, step = 0.004) =>
  Array.from({ length: n }, (_, i) => outlet(`${prefix}${i}`, lat + (i % 6) * step, lng + Math.floor(i / 6) * step));
const w = (o: Outlet) => o.visitFrequency;

describe("exchangePockets", () => {
  it("gives a pocket inside the neighbour's area to that neighbour and takes adjoining outlets back", () => {
    const westCore = grid("w", 60, 33.50, 36.20);            // ~2 km square
    const eastCore = grid("e", 60, 33.50, 36.30);            // 9 km east
    const pocket = grid("p", 8, 33.503, 36.302, 0.002);      // sits inside the east core
    const A = [...westCore, ...pocket];
    const B = eastCore;
    const before = reachabilityComponents(A, 4).length;
    expect(before).toBe(2);
    const { groups, moves } = exchangePockets([A, B], w, 0.1, 4);
    expect(moves.length).toBe(1);
    expect(moves[0]).toMatchObject({ pocket: 8, from: 0, to: 1 });
    // The pocket now belongs to B.
    const idsB = new Set(groups[1].map(o => o.id));
    expect(pocket.every(o => idsB.has(o.id))).toBe(true);
    // A is one connected piece again and the loads are within 10% of each other.
    expect(reachabilityComponents(groups[0], 4).length).toBe(1);
    const loads = groups.map(g => g.reduce((s, o) => s + w(o), 0));
    expect(Math.abs(loads[0] - loads[1]) / ((loads[0] + loads[1]) / 2)).toBeLessThanOrEqual(0.2);
    // Returned outlets came from B's side adjoining A? Here nothing adjoins within 4 km, so
    // the exchange had to fit the band without a return.
    expect(moves[0].returned).toBe(0);
  });

  it("returns adjoining outlets when the neighbour has some next to the giver's core", () => {
    // A: 55 in the west plus a pocket of 10 inside B's east core (6 km from A).
    // B: 55 in the east plus 10 right next to A's core, joined to the east core
    // by a 2 km hop. Loads start equal, so the whole border must come back.
    const westCore = grid("w", 55, 33.50, 36.20);            // lng 36.200 .. 36.236
    const border = grid("b", 10, 33.50, 36.24, 0.002);       // lng 36.240 .. 36.242
    const eastCore = grid("e", 55, 33.50, 36.265);           // lng 36.265 .. 36.301
    const pocket = grid("p", 10, 33.503, 36.305, 0.002);     // lng 36.305 .. 36.307
    const A = [...westCore, ...pocket];
    const B = [...eastCore, ...border];
    expect(reachabilityComponents(A, 4).length).toBe(2);
    expect(reachabilityComponents(B, 4).length).toBe(1);
    const { groups, moves } = exchangePockets([A, B], w, 0.05, 4);
    expect(moves.length).toBe(1);
    expect(moves[0]).toMatchObject({ pocket: 10, from: 0, to: 1, returned: 10 });
    const idsA = new Set(groups[0].map(o => o.id));
    expect(border.every(o => idsA.has(o.id))).toBe(true);
    expect(pocket.every(o => !idsA.has(o.id))).toBe(true);
    expect(groups.map(g => g.length)).toEqual([65, 65]);
    expect(reachabilityComponents(groups[0], 4).length).toBe(1);
    expect(reachabilityComponents(groups[1], 4).length).toBe(1);
  });

  it("does not treat a neighbour's own stray pocket as that neighbour's area; the stray goes to the nearer core instead", () => {
    // A's core in the west with a 17-outlet pocket 5 km east of it. B's core is
    // 12 km further east, but B also has a stray 7 right beside A's pocket.
    // B's stray must not pull A's 17 away; rather B's 7 joins A, whose core is nearer.
    const aCore = grid("a", 60, 33.50, 36.20);                 // lng 36.200 .. 36.236
    const aPocket = grid("p", 17, 33.503, 36.295, 0.002);      // ~5.5 km east of A's core
    const bStray = grid("s", 7, 33.505, 36.300, 0.002);        // right beside A's pocket
    const bCore = grid("b", 60, 33.50, 36.43);                 // 12 km east of the pocket
    const { groups, moves } = exchangePockets([[...aCore, ...aPocket], [...bCore, ...bStray]], w, 0.1, 4);
    const idsA = new Set(groups[0].map(o => o.id));
    expect(aPocket.every(o => idsA.has(o.id))).toBe(true);     // A keeps its pocket
    expect(bStray.every(o => idsA.has(o.id))).toBe(true);      // B's stray joined A
    expect(moves).toEqual([{ pocket: 7, from: 1, to: 0, returned: 0 }]);
  });

  it("gives a small pocket outright when the territories do not touch, and the load repair evens it out", () => {
    // West, middle and east reps side by side. East owns 4 outlets deep inside
    // the west rep's area; nothing of the west rep is anywhere near the east
    // core, so no return is possible and the band would be broken by a plain give.
    const west = grid("w", 62, 33.50, 36.20);                  // lng 36.200 .. 36.240
    const mid = grid("m", 60, 33.50, 36.248);                  // 36.248 .. 36.284, adjoins both
    const east = grid("e", 58, 33.50, 36.292);                 // 36.292 .. 36.328
    const stray = grid("x", 4, 33.503, 36.205, 0.002);         // inside west, east's
    const groups0 = [west, [...mid], [...east, ...stray]];
    const { groups, moves } = exchangePockets(groups0, w, 0.05, 4);
    expect(moves).toEqual([{ pocket: 4, from: 2, to: 0, returned: 0 }]);
    const idsW = new Set(groups[0].map(o => o.id));
    expect(stray.every(o => idsW.has(o.id))).toBe(true);
    // Straight after the give the west rep is over the 5% band; the repair
    // pass the optimizer runs next moves border outlets west -> middle -> east.
    const repaired = repairLoads(groups, w, 0.05, 4);
    const loads = repaired.map(g => g.reduce((s, o) => s + w(o), 0));
    const mean = loads.reduce((a, b) => a + b, 0) / 3;
    for (const l of loads) expect(Math.abs(l - mean)).toBeLessThanOrEqual(0.05 * mean + 1e-9);
    expect(repaired.flat().length).toBe(184);
    for (const g of repaired) expect(reachabilityComponents(g, 4).length).toBe(1);
  });

  it("leaves a pocket alone when no other rep is near it", () => {
    const core = grid("c", 40, 33.50, 36.20);
    const village = grid("v", 6, 33.62, 36.20, 0.002);        // 13 km north, nobody near
    const other = grid("o", 46, 33.50, 36.40);
    const { groups, moves } = exchangePockets([[...core, ...village], other], w, 0.1, 4);
    expect(moves.length).toBe(0);
    expect(groups[0].length).toBe(46);
  });

  it("does nothing when the hop limit is off", () => {
    const { moves } = exchangePockets([grid("a", 10, 33.5, 36.2), grid("b", 10, 33.5, 36.3)], w, 0.1, 0);
    expect(moves.length).toBe(0);
  });
});

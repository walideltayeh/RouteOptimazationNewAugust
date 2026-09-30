import { describe, it, expect } from "vitest";
import type { Outlet } from "../shared/schema";
import { exchangePockets, reachabilityComponents } from "../server/day-balancer";

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

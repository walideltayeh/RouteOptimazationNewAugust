import { describe, it, expect } from "vitest";
import type { Outlet } from "../shared/schema";
import { handOverStrays } from "../server/day-balancer";

function outlet(id: string, lat: number, lng: number): Outlet {
  return { id, name: id, code: id, pinnedRoute: null, address: "", latitude: lat, longitude: lng, visitFrequency: 2, timePerVisit: 30, value: null, geoStatus: null, territory: null, repId: null, cluster: null, createdAt: null } as Outlet;
}
const grid = (prefix: string, n: number, lat: number, lng: number, step = 0.003) =>
  Array.from({ length: n }, (_, i) => outlet(`${prefix}${i}`, lat + (i % 6) * step, lng + Math.floor(i / 6) * step));
const w = () => 1;

describe("handOverStrays", () => {
  it("moves a chain of strays that sits inside another day's area, even though they vote for each other", () => {
    const red = grid("r", 40, 33.50, 36.20);                    // a dense 1.5 km block
    const purpleCore = grid("p", 34, 33.50, 36.30);             // 9 km east
    const strays = Array.from({ length: 6 }, (_, i) => outlet(`s${i}`, 33.5015 + i * 0.002, 36.2075)); // a chain through red's block
    const { groups, moved } = handOverStrays([red, [...purpleCore, ...strays]], w, 0.2); // 40/40 -> 46/34 needs a 15% band
    expect(moved).toBe(6);
    expect(groups[0].length).toBe(46);
    expect(groups[1].length).toBe(34);
  });

  it("respects the band and leaves border outlets alone", () => {
    const a = grid("a", 30, 33.50, 36.20);
    const b = grid("b", 30, 33.50, 36.218);                     // adjoining block, 0.3 km gap
    const { moved } = handOverStrays([a, b], w, 0.05);
    expect(moved).toBe(0);                                      // border outlets have mixed neighbours
    const red = grid("r", 40, 33.50, 36.20);
    const strays = Array.from({ length: 6 }, (_, i) => outlet(`s${i}`, 33.5015 + i * 0.002, 36.2075));
    // 40 against 46 with a 2% band (42.1 .. 43.9): red may take three, no more.
    const tight = handOverStrays([red, [...grid("p", 40, 33.50, 36.30), ...strays]], w, 0.02);
    expect(tight.moved).toBe(3);
    expect(tight.groups.map(g => g.length)).toEqual([43, 43]);
  });
});

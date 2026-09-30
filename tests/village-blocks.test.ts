import { describe, it, expect } from "vitest";
import type { Outlet } from "../shared/schema";
import { collapseBlocks, unitLoad, partitionByHilbert } from "../server/day-balancer";

function outlet(id: string, lat: number, lng: number, vf = 2): Outlet {
  return { id, name: id, code: id, pinnedRoute: null, address: "", latitude: lat, longitude: lng, visitFrequency: vf, timePerVisit: 30, value: null, geoStatus: null, territory: null, repId: null, cluster: null, createdAt: null } as Outlet;
}
const village = (prefix: string, n: number, lat: number, lng: number) =>
  Array.from({ length: n }, (_, i) => outlet(`${prefix}${i}`, lat + (i % 4) * 0.002, lng + Math.floor(i / 4) * 0.002));
const load = (o: Outlet) => (o.visitFrequency ?? 1) / 4;

describe("village blocks", () => {
  it("collapses tight villages into single units and leaves big or lone outlets alone", () => {
    const a = village("a", 12, 33.50, 36.20);      // 12 outlets within ~500 m
    const b = village("b", 8, 33.50, 36.26);       // 6 km east
    const big = village("c", 60, 33.60, 36.30);    // a town centre bigger than a day
    const lone = outlet("lone", 33.70, 36.40);
    const { units, blocks, expand } = collapseBlocks([...a, ...b, ...big, lone], 0.5, load, 20 * 0.5);
    expect(blocks).toBe(2);
    expect(units.length).toBe(2 + 60 + 1);
    const w = unitLoad(load);
    const ua = units.find(u => u.id.startsWith("block:") && (u as any).blockMembers.length === 12)!;
    expect(w(ua)).toBeCloseTo(12 * 0.5, 9);
    expect(ua.latitude).toBeCloseTo(33.503, 3);
    // Expanding gives every outlet back exactly once.
    const groups = partitionByHilbert(units, 2, w);
    const back = expand(groups);
    expect(back.flat().length).toBe(81);
    expect(new Set(back.flat().map(o => o.id)).size).toBe(81);
    // A village stays whole in whichever group it landed.
    const ofA = back.map(g => g.filter(o => o.id.startsWith("a")).length);
    expect(ofA.sort()).toEqual([0, 12]);
  });

  it("keeps an offset outlet's village as loose outlets", () => {
    const a = village("a", 6, 33.50, 36.20);
    (a[2] as any).geoStatus = "offset";
    const { blocks, units } = collapseBlocks(a, 0.5, load, 100);
    expect(blocks).toBe(0);
    expect(units.length).toBe(6);
  });
});

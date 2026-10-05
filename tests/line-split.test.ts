import { describe, it, expect } from "vitest";
import type { Outlet } from "../shared/schema";
import { lineSplit, tourLength } from "../server/day-balancer";

function outlet(id: string, lat: number, lng: number): Outlet {
  return { id, name: id, code: id, pinnedRoute: null, address: "", latitude: lat, longitude: lng, visitFrequency: 2, timePerVisit: 30, value: null, geoStatus: null, territory: null, repId: null, cluster: null, createdAt: null } as Outlet;
}
// Points inside the hull of the other part, the overlap measure used on the real files.
function cross(o: number[], a: number[], b: number[]) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
function hull(ps: number[][]) {
  const p = [...ps].sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
  const lo: number[][] = [], up: number[][] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function inside(h: number[][], q: number[]) {
  if (h.length < 3) return false; let c = false;
  for (let i = 0, j = h.length - 1; i < h.length; j = i++) if ((h[i][1] > q[1]) !== (h[j][1] > q[1]) && q[0] < (h[j][0] - h[i][0]) * (q[1] - h[i][1]) / (h[j][1] - h[i][1]) + h[i][0]) c = !c;
  return c;
}
const intrusions = (parts: Outlet[][]) => {
  const H = parts.map(g => hull(g.map(o => [o.longitude, o.latitude])));
  return parts.reduce((n, g, a) => n + g.filter(o => H.some((h, b) => b !== a && inside(h, [o.longitude, o.latitude]))).length, 0);
};
// A day of 56 outlets spread over a 4 x 3 km neighbourhood, pseudo-random but fixed.
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const day = Array.from({ length: 56 }, (_, i) => outlet(`d${i}`, 33.50 + rnd() * 0.027, 36.30 + rnd() * 0.043));
const one = () => 1;

describe("lineSplit", () => {
  it("splits a day between two weeks into equal halves that do not overlap", () => {
    const parts = lineSplit(day, 2, one, 0.05)!;
    expect(parts.map(p => p.length).sort()).toEqual([28, 28].sort());
    expect(intrusions(parts)).toBe(0);
    // And it is a sensible cut: two half-routes cost well under one route through everything twice.
    expect(tourLength(parts[0]) + tourLength(parts[1])).toBeLessThan(2 * tourLength(day) * 0.8);
  });

  it("splits into four weeks for monthly outlets, each inside the band, none overlapping", () => {
    const parts = lineSplit(day, 4, one, 0.1)!;
    expect(parts.length).toBe(4);
    for (const p of parts) { expect(p.length).toBeGreaterThanOrEqual(13); expect(p.length).toBeLessThanOrEqual(15); }
    expect(parts.flat().length).toBe(56);
    expect(intrusions(parts)).toBe(0);
  });

  it("cuts at the natural gap between two villages", () => {
    const a = Array.from({ length: 20 }, (_, i) => outlet(`a${i}`, 33.50 + (i % 5) * 0.001, 36.30 + Math.floor(i / 5) * 0.001));
    const b = Array.from({ length: 20 }, (_, i) => outlet(`b${i}`, 33.52 + (i % 5) * 0.001, 36.33 + Math.floor(i / 5) * 0.001));
    const parts = lineSplit([...b, ...a], 2, one, 0.05)!;
    const sideOfA = parts.findIndex(p => p.some(o => o.id === "a0"));
    expect(parts[sideOfA].every(o => o.id.startsWith("a"))).toBe(true);
  });

  it("keeps every one of 13 days inside the band, however deep the cuts go", () => {
    // 290 outlets for 13 days at 20-25 visits (mean 22.3): the band is relative
    // to the whole territory's mean, not to each half's.
    const territory = Array.from({ length: 290 }, (_, i) => outlet(`t${i}`, 33.45 + rnd() * 0.09, 36.25 + rnd() * 0.11));
    const mean = 290 / 13;
    const parts = lineSplit(territory, 13, one, { below: (mean - 20) / mean, above: (25 - mean) / mean })!;
    expect(parts.length).toBe(13);
    for (const p of parts) { expect(p.length).toBeGreaterThanOrEqual(20); expect(p.length).toBeLessThanOrEqual(25); }
    expect(intrusions(parts)).toBe(0);
  });

  it("gives up when no cut can respect the band", () => {
    const lumpy = [outlet("big", 33.5, 36.3), ...Array.from({ length: 4 }, (_, i) => outlet(`s${i}`, 33.5 + i * 0.001, 36.31))];
    expect(lineSplit(lumpy, 2, o => (o.id === "big" ? 10 : 1), 0.05)).toBeNull();
  });
});

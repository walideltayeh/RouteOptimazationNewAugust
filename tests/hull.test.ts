import { describe, it, expect } from "vitest";
import { convexHull, footprint, insideRing, polygonCentroid, type Pt } from "../client/src/lib/hull";

describe("territory areas: hull and centre", () => {
  it("wraps the outer points and ignores the ones inside", () => {
    const square: Pt[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
    const hull = convexHull([...square, [1, 1], [2, 3], [3, 2], [2, 0], [0, 0]]);
    expect(hull).toHaveLength(4);
    expect(new Set(hull.map(p => p.join(",")))).toEqual(new Set(square.map(p => p.join(","))));
    expect(polygonCentroid(hull)).toEqual([2, 2]);
  });
  it("copes with one outlet, two outlets and a street of them", () => {
    expect(convexHull([[1, 1]])).toEqual([[1, 1]]);
    expect(convexHull([[1, 1], [2, 2], [1, 1]])).toHaveLength(2);
    expect(convexHull([[0, 0], [1, 1], [2, 2], [3, 3]]).length).toBeLessThan(3);
    expect(polygonCentroid([[0, 0], [2, 2]])).toEqual([1, 1]);
  });
  it("puts the centre in the body of a lopsided area, not at the mean of its corners", () => {
    // A long strip with a cluster of corners at one end.
    const ring = convexHull([[0, 0], [10, 0], [10, 1], [0, 1], [0, 0.2], [0, 0.4], [0, 0.6], [0, 0.8]]);
    expect(polygonCentroid(ring)[0]).toBeCloseTo(5, 6);
  });
});

describe("territory areas: the ground a rep's outlets cover", () => {
  // Outlets every 200 m along a line, around latitude 33.9.
  const line = (lng0: number, lat0: number, dLng: number, dLat: number, n: number): Pt[] => Array.from({ length: n }, (_, i) => [lng0 + i * dLng, lat0 + i * dLat] as Pt);
  const covered = (rings: Pt[][], p: Pt) => rings.some(r => insideRing(p, r));

  it("covers every outlet, in one piece when they are neighbours", () => {
    let seed = 5; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const town: Pt[] = Array.from({ length: 300 }, () => [35.5 + rnd() * 0.05, 33.88 + rnd() * 0.04] as Pt);
    const rings = footprint(town);
    expect(rings).toHaveLength(1);
    for (const p of town) expect(covered(rings, p)).toBe(true);
  });

  it("follows an L-shaped territory instead of claiming the ground inside the bend", () => {
    // Two streets meeting at a corner, 6 km each; the hull would take the whole triangle.
    const l = [...line(35.5, 33.9, 0.002, 0, 32), ...line(35.5, 33.9, 0, 0.0018, 32)];
    const rings = footprint(l);
    expect(rings).toHaveLength(1);
    for (const p of l) expect(covered(rings, p)).toBe(true);
    const inTheBend: Pt = [35.5 + 0.03, 33.9 + 0.027];
    expect(insideRing(inTheBend, convexHull(l))).toBe(true);
    expect(covered(rings, inTheBend)).toBe(false);
  });

  it("draws a pocket across the valley as its own piece, largest first", () => {
    const main = line(35.5, 33.9, 0.002, 0.0004, 40), pocket = line(35.68, 34.02, 0.001, 0, 6);
    const rings = footprint([...pocket, ...main]);
    expect(rings).toHaveLength(2);
    expect(covered([rings[0]], main[20])).toBe(true);
    expect(covered([rings[1]], pocket[3])).toBe(true);
    expect(covered(rings, [35.6, 33.96])).toBe(false);
  });

  it("gives one outlet a small patch and nothing for no outlets", () => {
    expect(footprint([])).toEqual([]);
    const rings = footprint([[35.5, 33.9]]);
    expect(rings).toHaveLength(1);
    expect(insideRing([35.5, 33.9], rings[0])).toBe(true);
    const lngs = rings[0].map(p => p[0]);
    expect((Math.max(...lngs) - Math.min(...lngs)) * 92.3).toBeLessThan(1); // under a kilometre across
  });
});

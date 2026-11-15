import { describe, it, expect } from "vitest";
import { orderStops, relieveLongLegs } from "../server/route-order";

const km = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const length = (r: number[][]) => r.slice(1).reduce((s, x, i) => s + km(r[i], x), 0);
const longLegs = (r: number[][], hop: number) => r.slice(1).filter((x, i) => km(r[i], x) > hop).length;

describe("stop order: path ends and long legs", () => {
  it("starts at the far end instead of jumping back to it", () => {
    // Five stops a kilometre apart heading east, and one a kilometre west of
    // the first, visited last: a 6 km jump back that starting there avoids.
    const street = [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0]];
    const route = [...street, [0, 0]];
    const out = relieveLongLegs(route, km, 4);
    expect(longLegs(route, 4)).toBe(1);
    expect(longLegs(out, 4)).toBe(0);
    expect(length(out)).toBeCloseTo(5, 6);
    expect([out[0], out[5]]).toContainEqual([0, 0]);
  });

  it("drives a little further to avoid one jump over the hop limit", () => {
    // The shortest order (10.8 km) has a 4.5 km leg; 0.65 km more has none.
    const shortest = [[0.8, 4.2], [2.3, 4.9], [6.8, 5.3], [5.9, 4], [5.5, 3.8], [5.4, 1.2]];
    const out = relieveLongLegs(shortest, km, 4);
    expect(longLegs(shortest, 4)).toBe(1);
    expect(longLegs(out, 4)).toBe(0);
    expect(length(out) - length(shortest)).toBeLessThan(0.7);
  });

  it("does not drive a lot further for it", () => {
    // Two villages 6 km apart: the gap has to be crossed once, and nothing is
    // gained by weaving between them.
    const route = [[0, 0], [0.5, 0], [1, 0], [7, 0], [7.5, 0], [8, 0]];
    const out = relieveLongLegs(route, km, 4);
    expect(longLegs(out, 4)).toBe(1);
    expect(length(out)).toBeCloseTo(8, 6);
  });

  it("leaves a path alone when it cannot be bettered, and never drops a stop", () => {
    const route = [[0, 0], [1, 0], [2, 0], [3, 0]];
    expect(relieveLongLegs(route, km, 4)).toBe(route);
    const scattered = Array.from({ length: 30 }, (_, i) => [(i * 37) % 11, (i * 53) % 7]);
    const out = relieveLongLegs(scattered, km, 2);
    expect(out).toHaveLength(30);
    expect(new Set(out.map(p => p.join(",")))).toEqual(new Set(scattered.map(p => p.join(","))));
    expect(longLegs(out, 2)).toBeLessThanOrEqual(longLegs(scattered, 2));
  });

  it("orders outlets end to end with the hop limit in force", () => {
    const flat = (lat1: number, lng1: number, lat2: number, lng2: number) => Math.hypot((lat1 - lat2) * 111, (lng1 - lng2) * 111);
    // A street of eight stops and one stop beyond its western end, listed last.
    const stops = [...Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, latitude: 0, longitude: (i + 1) * 0.009 })), { id: "west", latitude: 0, longitude: 0 }];
    const out = orderStops(stops, flat, 4);
    expect(out).toHaveLength(9);
    expect([out[0].id, out[8].id]).toContain("west");
    for (let i = 1; i < out.length; i++) expect(flat(out[i - 1].latitude, out[i - 1].longitude, out[i].latitude, out[i].longitude)).toBeLessThan(1.1);
  });
});

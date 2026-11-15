import { describe, it, expect } from "vitest";
import { relieveOverloadedDays, type DayBand, type RelieveInput } from "../server/month-polish";

interface S { id: string; latitude: number; longitude: number; x: number; call: number }
// Stops on an east-west street, 100 m apart; x is the position along it.
const stop = (x: number, call = 15): S => ({ id: `o${String(x).padStart(3, "0")}`, latitude: 0, longitude: x * 0.0009, x, call });
const street = (from: number, to: number, call = 15) => Array.from({ length: to - from }, (_, i) => stop(from + i, call));
const base = (groups: DayBand<S>[][], repeats: number): RelieveInput<S> => ({
  groups, repeats,
  dist: (a, b) => Math.abs(a.x - b.x) * 0.1,
  callMinutes: o => o.call,
  dayMinutes: (call, km) => call + (km * 1.3 / 25) * 60 + 70,
  order: stops => [...stops].sort((a, b) => a.x - b.x),
  shiftMinutes: 480,
  maxHopKm: 4,
  // A stop of one day lying between two stops of another is inside its area.
  intruders: routes => routes.reduce((n, r, i) => n + r.filter(o => routes.some((q, j) => j !== i && q.length > 1 && !q.includes(o) && o.x > Math.min(...q.map(s => s.x)) && o.x < Math.max(...q.map(s => s.x)))).length, 0),
});
const weekly = (stops: S[]): DayBand<S>[] => [1, 2, 3, 4].map(v => ({ visits: v, buckets: v === 4 ? [stops] : [] }));

describe("days over the shift", () => {
  it("hands the outlets on the border to the neighbouring day until the day fits", () => {
    // 30 weekly calls of 15 minutes are 8.8 hours; the next day has 20.
    const groups = [weekly(street(0, 30)), weekly(street(30, 50))];
    const res = relieveOverloadedDays(base(groups, 4));
    const day0 = groups[0][3].buckets[0], day1 = groups[1][3].buckets[0];
    expect(res.overBefore).toBe(4);
    expect(res.overAfter).toBe(0);
    expect(res.longestAfter).toBeLessThanOrEqual(480);
    // The four that moved are the four next to the other day, and nothing else.
    expect(day0.map(o => o.x).sort((a, b) => a - b)).toEqual(Array.from({ length: 26 }, (_, i) => i));
    expect(day1.map(o => o.x).sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i + 26));
    expect(res.moves).toBe(4);
  });

  it("does not touch a rep whose days already fit", () => {
    const a = street(0, 24), b = street(24, 48);
    const groups = [weekly(a), weekly(b)];
    const res = relieveOverloadedDays(base(groups, 4));
    expect(res).toMatchObject({ moves: 0, overBefore: 0, overAfter: 0 });
    expect(groups[0][3].buckets[0]).toBe(a);
    expect(groups[0][3].buckets[0]).toHaveLength(24);
  });

  it("keeps every day's visit count inside the band it was in", () => {
    // With a floor of 28 visits the long day may give up two outlets, not four.
    const groups = [weekly(street(0, 30)), weekly(street(30, 50))];
    const res = relieveOverloadedDays({ ...base(groups, 4), visitsBand: { min: 28, max: 32 } });
    expect(groups[0][3].buckets[0]).toHaveLength(28);
    expect(groups[1][3].buckets[0]).toHaveLength(22);
    expect(res.moves).toBe(2);
  });

  it("moves a fortnightly outlet to the other fortnight of the same day, still twice a cycle", () => {
    // One weekday: weeks 1 and 3 hold 34 calls, weeks 2 and 4 hold 20.
    const heavy = street(0, 34), light = street(34, 54);
    const groups: DayBand<S>[][] = [[{ visits: 1, buckets: [] }, { visits: 2, buckets: [heavy, light] }, { visits: 3, buckets: [] }, { visits: 4, buckets: [] }]];
    const res = relieveOverloadedDays(base(groups, 4));
    const [w13, w24] = groups[0][1].buckets;
    expect(res.overAfter).toBe(0);
    expect(w13.length + w24.length).toBe(54);
    expect(new Set([...w13, ...w24].map(o => o.id)).size).toBe(54);
    // Still two clean halves of the street: the fortnights do not interleave.
    expect(Math.max(...w13.map(o => o.x))).toBeLessThan(Math.min(...w24.map(o => o.x)));
  });

  it("leaves a pinned outlet and an outlet deep inside its day where they are", () => {
    const long = street(0, 30);
    const groups = [weekly(long), weekly(street(30, 50))];
    const pinned = new Set(["o029", "o028"]);
    relieveOverloadedDays({ ...base(groups, 4), movable: o => !pinned.has(o.id) });
    const day0 = groups[0][3].buckets[0].map(o => o.id);
    // The two on the border are pinned, so nothing can leave without crossing them.
    expect(day0).toContain("o029");
    expect(day0).toContain("o028");
    expect(day0).toHaveLength(30);
  });

  it("never makes another day longer than the day it relieves", () => {
    // Two long days side by side and nowhere else to go: 33 and 32 calls.
    // Handing one over would only swap which of them is the longest.
    const groups = [weekly(street(0, 33)), weekly(street(33, 65))];
    const res = relieveOverloadedDays(base(groups, 4));
    expect(res.longestAfter).toBeLessThanOrEqual(res.longestBefore);
    expect(groups[1][3].buckets[0].length).toBeLessThanOrEqual(33);
    expect(groups[0][3].buckets[0].length + groups[1][3].buckets[0].length).toBe(65);
  });

  it("relieves through a chain of days when only the far one has room", () => {
    // Three days along the street: 30, 30 and 14 calls. The first is not next
    // to the day with room; the middle one passes outlets on.
    const groups = [weekly(street(0, 30)), weekly(street(30, 60)), weekly(street(60, 74))];
    const res = relieveOverloadedDays(base(groups, 4));
    expect(res.overAfter).toBe(0);
    const sizes = groups.map(g => g[3].buckets[0].length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(74);
    // 27 calls are three minutes over, inside the quarter-hour of grace.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(27);
    expect(sizes[2]).toBeGreaterThan(14);
    // Still three unbroken stretches.
    const edges = groups.map(g => { const xs = g[3].buckets[0].map(o => o.x); return [Math.min(...xs), Math.max(...xs)]; });
    expect(edges[0][1]).toBeLessThan(edges[1][0]);
    expect(edges[1][1]).toBeLessThan(edges[2][0]);
  });
});

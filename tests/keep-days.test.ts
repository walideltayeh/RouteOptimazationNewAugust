import { describe, it, expect } from "vitest";
import { bandsFromCells, cycleCellOf, placeArrivals, removeOutlet, type StoredCell } from "../server/keep-days";
import { calendarCell, cycleShape, repeatsForBucket } from "../server/cycle";
import { relieveOverloadedDays, type DayBand } from "../server/month-polish";

interface S { id: string; latitude: number; longitude: number; x: number }
const stop = (x: number, tag = "o"): S => ({ id: `${tag}${String(x).padStart(3, "0")}`, latitude: 0, longitude: x * 0.0009, x });
const street = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => stop(from + i));
const dist = (a: S, b: S) => Math.abs(a.x - b.x) * 0.1;

// A month as it is stored: for each day-group and run, the outlets driven.
const cellsOf = (groups: DayBand<S>[][], repeats: number): StoredCell[] => {
  const out: StoredCell[] = [];
  groups.forEach((bands, d) => {
    for (let r = 1; r <= repeats; r++) {
      const ids: string[] = [];
      for (const band of bands) band.buckets.forEach((bucket, b) => { if (repeatsForBucket(band.visits, repeats, b).includes(r)) ids.push(...bucket.map(o => o.id)); });
      if (ids.length) out.push({ group: d, repeat: r, ids });
    }
  });
  return out;
};
const ids = (g: DayBand<S>[][]) => g.map(bands => bands.map(band => band.buckets.map(bucket => bucket.map(o => o.id).sort())));

describe("keeping the days of a plan", () => {
  it("finds a calendar cell's place in the cycle, for every cell the planner lays down", () => {
    for (const [perWeek, cycle, startSlot] of [[6, 24, 0], [5, 20, 0], [6, 26, 0], [6, 24, 3]] as const) {
      const week = [1, 2, 3, 4, 5, 6].slice(0, perWeek);
      const { repeats, dayGroups, cycleDays } = cycleShape(perWeek, cycle);
      for (let r = 1; r <= repeats; r++) for (let g = 1; g <= dayGroups; g++) {
        const c = calendarCell(r, g, dayGroups, week, startSlot);
        expect(cycleCellOf(c.week, c.dayOfWeek, week, dayGroups, cycleDays, startSlot)).toEqual({ group: g - 1, repeat: r });
      }
      // A day off, and a day past the end of the pattern, are not part of it.
      expect(cycleCellOf(1, 7, week, dayGroups, cycleDays, startSlot)).toBeNull();
      const beyond = calendarCell(1, cycleDays + 1, 1, week, startSlot);
      expect(cycleCellOf(beyond.week, beyond.dayOfWeek, week, dayGroups, cycleDays, startSlot)).toBeNull();
    }
  });

  it("reads a month back from its routes exactly as it was built", () => {
    // Two day-groups on a four-run cycle: weekly, fortnightly (two weeks apart) and monthly outlets.
    const built: DayBand<S>[][] = [0, 1].map(d => [
      { visits: 1, buckets: [street(d * 100, d * 100 + 3), street(d * 100 + 3, d * 100 + 6), [], street(d * 100 + 6, d * 100 + 8)] },
      { visits: 2, buckets: [street(d * 100 + 10, d * 100 + 20), street(d * 100 + 20, d * 100 + 28)] },
      { visits: 3, buckets: [[], [], [], []] },
      { visits: 4, buckets: [street(d * 100 + 30, d * 100 + 42)] },
    ]);
    const all = built.flat().flatMap(b => b.buckets.flat());
    const back = bandsFromCells(cellsOf(built, 4), new Map(all.map(o => [o.id, o])), 2, 4);
    expect(ids(back.groups)).toEqual(ids(built));
    expect(back.irregular.size).toBe(0);
    expect(back.shares.get("o012")).toEqual([2]);
    expect(back.shares.get("o135")).toEqual([4]);
  });

  it("leaves out outlets that are gone and flags one moved onto runs no week pattern has", () => {
    const built: DayBand<S>[][] = [[{ visits: 1, buckets: [[], [], [], []] }, { visits: 2, buckets: [street(0, 10), street(10, 20)] }, { visits: 3, buckets: [[], [], [], []] }, { visits: 4, buckets: [[]] }]];
    const cells = cellsOf(built, 4);
    // o005 was moved by hand from weeks 1 and 3 to weeks 1 and 2.
    cells.find(c => c.repeat === 3)!.ids = cells.find(c => c.repeat === 3)!.ids.filter(id => id !== "o005");
    cells.find(c => c.repeat === 2)!.ids.push("o005");
    const alive = street(0, 20).filter(o => o.id !== "o003" && o.id !== "o017");
    const back = bandsFromCells(cells, new Map(alive.map(o => [o.id, o])), 1, 4);
    const here = back.groups[0][1].buckets.flat().map(o => o.id);
    expect(here).not.toContain("o003");
    expect(here).not.toContain("o017");
    expect(here).not.toContain("o005");
    expect(Array.from(back.irregular)).toEqual(["o005"]);
    expect(here).toHaveLength(17);
  });

  it("adds an arriving outlet to the day that already passes it, and to the lighter week of that day", () => {
    const groups: DayBand<S>[][] = [0, 1].map(d => [
      { visits: 1, buckets: [[], [], [], []] },
      // Each weekday's fortnights are the two halves of its street.
      { visits: 2, buckets: [street(d * 100, d * 100 + 12), street(d * 100 + 12, d * 100 + 20)] },
      { visits: 3, buckets: [[], [], [], []] }, { visits: 4, buckets: [[]] },
    ]);
    const near = { ...stop(105, "new"), x: 105.5 };       // on the second street, among weeks 1 and 3
    const between = { ...stop(12, "new"), x: 11.6 };      // on the first, between its two fortnights
    const res = placeArrivals({ groups, repeats: 4, dist, arrivals: [{ outlet: near, shares: [2] }, { outlet: between, shares: [2] }] });
    expect(res).toMatchObject({ placed: 2, unplaced: [] });
    expect(groups[1][1].buckets[0].map(o => o.id)).toContain("new105");
    // 0.4 from one fortnight, 0.4 from the other: the one with 8 calls gets it, not the one with 12.
    expect(groups[0][1].buckets[1].map(o => o.id)).toContain("new012");
  });

  it("puts a weekly outlet of a two-run cycle on two different day-groups", () => {
    const groups: DayBand<S>[][] = [0, 1, 2].map(d => [{ visits: 1, buckets: [[], []] }, { visits: 2, buckets: [street(d * 50, d * 50 + 10)] }]);
    const o = { ...stop(48, "new"), x: 48 };
    placeArrivals({ groups, repeats: 2, dist, arrivals: [{ outlet: o, shares: [2, 2] }] });
    const on = groups.map(g => g[1].buckets[0].some(x => x.id === o.id));
    // The street it is next to (50-59) and the nearer of the other two (0-9), not the far one.
    expect(on).toEqual([true, true, false]);
  });

  it("after a deletion, the short day takes outlets from the day next to it and nothing else moves", () => {
    // Three weekly days of 28 along a street; ten outlets in the middle of day 2 close.
    const days = [street(0, 28), street(28, 56), street(56, 84)];
    const closed = new Set(street(38, 48).map(o => o.id));
    const built: DayBand<S>[][] = days.map(g => [{ visits: 1, buckets: [[], [], [], []] }, { visits: 2, buckets: [[], []] }, { visits: 3, buckets: [[], [], [], []] }, { visits: 4, buckets: [g] }]);
    const alive = days.flat().filter(o => !closed.has(o.id));
    const back = bandsFromCells(cellsOf(built, 4), new Map(alive.map(o => [o.id, o])), 3, 4);
    expect(back.groups[1][3].buckets[0]).toHaveLength(18);
    const res = relieveOverloadedDays({
      groups: back.groups, repeats: 4, dist, callMinutes: () => 15,
      dayMinutes: (call, km) => call + (km * 1.3 / 25) * 60 + 70,
      order: stops => [...stops].sort((a, b) => a.x - b.x),
      shiftMinutes: 480, maxHopKm: 4, visitsBand: { min: 24, max: 28 }, restoreBand: true,
    });
    const sizes = back.groups.map(g => g[3].buckets[0].length);
    expect(res.outOfBandBefore).toBe(4);
    expect(res.outOfBandAfter).toBe(0);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(74);
    for (const n of sizes) { expect(n).toBeGreaterThanOrEqual(24); expect(n).toBeLessThanOrEqual(28); }
    // Six outlets changed day - the fewest that put 18 back to 24 - and they
    // are the ones on the borders: the days are still three unbroken stretches.
    expect(res.moves).toBe(6);
    const edges = back.groups.map(g => { const xs = g[3].buckets[0].map(o => o.x); return [Math.min(...xs), Math.max(...xs)]; });
    expect(edges[0][1]).toBeLessThan(edges[1][0]);
    expect(edges[1][1]).toBeLessThan(edges[2][0]);
    removeOutlet(back.groups, "o000");
    expect(back.groups[0][3].buckets[0].some(o => o.id === "o000")).toBe(false);
  });

  const weeklyDays = (days: S[][]): DayBand<S>[][] => days.map(g => [{ visits: 1, buckets: [[], [], [], []] }, { visits: 2, buckets: [[], []] }, { visits: 3, buckets: [[], [], [], []] }, { visits: 4, buckets: [g] }]);
  const minutesOf = (call: number, km: number) => call + (km * 1.3 / 25) * 60 + 70;
  const repair = (groups: DayBand<S>[][], extra: object) => relieveOverloadedDays({
    groups, repeats: 4, dist, callMinutes: () => 15, dayMinutes: minutesOf,
    order: stops => [...stops].sort((a, b) => a.x - b.x), shiftMinutes: 480, maxHopKm: 4, restoreBand: true, ...extra,
  });

  it("leaves a day alone that was outside the band before the edit", () => {
    // The plan had a 20-call day against a floor of 24; one outlet of another day closes.
    const groups = weeklyDays([street(0, 20), street(20, 47), street(50, 76)]);
    const was = [20, 28, 26];
    // Twelve-minute calls, so no day is near the end of the shift and only the band is in play.
    const short = { callMinutes: () => 12, visitsBand: { min: 24, max: 28 } };
    const res = repair(groups, { ...short, before: (d: number) => ({ visits: was[d], minutes: minutesOf(was[d] * 12, was[d] * 0.1) }) });
    expect(res).toMatchObject({ moves: 0, outOfBandBefore: 0, outOfBandAfter: 0 });
    expect(groups.map(g => g[3].buckets[0].length)).toEqual([20, 27, 26]);
    // Held to the band itself, the same month has a day to mend.
    expect(repair(weeklyDays([street(0, 20), street(20, 47), street(50, 76)]), short).outOfBandBefore).toBe(4);
  });

  it("refills a day an edit left short where days are balanced by working time", () => {
    // No visits band. Three days of 26 calls; twenty outlets of the middle one close.
    const groups = weeklyDays([street(0, 26), street(46, 52), street(52, 78)]);
    const before = () => ({ visits: 26, minutes: minutesOf(26 * 15, 2.5) });
    const res = repair(groups, { before });
    const sizes = groups.map(g => g[3].buckets[0].length);
    expect(res.outOfBandBefore).toBe(4);
    expect(res.outOfBandAfter).toBe(0);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(58);
    // Four fifths of the average day is about 15 calls: the short day is
    // brought up to that from the day beside it, and no further.
    expect(sizes[1]).toBeGreaterThanOrEqual(14);
    expect(sizes[1]).toBeLessThanOrEqual(17);
    expect(sizes[0]).toBe(26);
    expect(res.newlyOver).toBe(0);
  });
});

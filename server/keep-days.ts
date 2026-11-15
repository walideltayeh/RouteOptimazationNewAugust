/**
 * Re-planning a rep's month without re-cutting it.
 *
 * A plan cut from scratch is the best plan for the outlets as they are, and
 * a different plan from the one the reps have been driving: delete three
 * closed shops and every outlet in the territory may land on another day.
 * After an edit the month is instead read back from the cells it was stored
 * as; outlets that left are taken out, outlets that arrived join the day
 * that already passes them, and only then are the days repaired where the
 * edit put them outside the visits band or over the shift
 * (server/month-polish.ts). Every outlet that can keep its day keeps it.
 *
 * Pure: the stored cells, the outlets and a distance come in; the caller
 * lays the result on the calendar.
 */
import { bucketsForFrequency, repeatsForBucket } from "./cycle";
import type { DayBand, Stop } from "./month-polish";

/** One stored route: day-group (0-based), which run of the cycle (1-based), and its outlets. */
export interface StoredCell { group: number; repeat: number; ids: string[] }

/**
 * Where a calendar cell sits in the cycle - the inverse of calendarCell in
 * cycle.ts. Null for a day outside the working week or beyond the pattern
 * (the bonus days of a month longer than its cycle). `startSlot` is the
 * weekday slot a calendar-month plan begins on.
 */
export function cycleCellOf(week: number, dayOfWeek: number, workingWeek: number[], dayGroups: number, cycleDays: number, startSlot = 0): { group: number; repeat: number } | null {
  const days = workingWeek.length > 0 ? workingWeek : [1, 2, 3, 4, 5];
  const slot = days.indexOf(dayOfWeek);
  if (slot < 0 || week < 1) return null;
  const cycleDay = (week - 1) * days.length + slot - startSlot; // 0-based
  if (cycleDay < 0 || cycleDay >= cycleDays) return null;
  return { group: cycleDay % dayGroups, repeat: Math.floor(cycleDay / dayGroups) + 1 };
}

export interface ReadBack<T> {
  /** groups[d] = one band per visits-a-cycle 1..repeats, each with its week buckets. */
  groups: DayBand<T>[][];
  /** Visits a cycle each outlet has on each day-group it is on, e.g. [2] or [2, 2]. */
  shares: Map<string, number[]>;
  /** Outlets whose runs fit no week pattern (moved by hand); they are placed again. */
  irregular: Set<string>;
}

/**
 * The day-groups, frequency bands and week buckets a month was built from,
 * recovered from its cells. Outlets not in `byId` (deleted, or moved to
 * another rep) are left out.
 */
export function bandsFromCells<T extends Stop>(cells: StoredCell[], byId: Map<string, T>, dayGroups: number, repeats: number): ReadBack<T> {
  const groups: DayBand<T>[][] = Array.from({ length: dayGroups }, () =>
    Array.from({ length: repeats }, (_, i) => ({ visits: i + 1, buckets: Array.from({ length: bucketsForFrequency(i + 1, repeats) }, () => [] as T[]) })));
  const shares = new Map<string, number[]>();
  const irregular = new Set<string>();
  const ordered = [...cells].sort((a, b) => a.group - b.group || a.repeat - b.repeat);
  for (let d = 0; d < dayGroups; d++) {
    const runs = new Map<string, number[]>(); // insertion order = first appearance on the route
    for (const c of ordered) {
      if (c.group !== d) continue;
      for (const id of c.ids) {
        if (!byId.has(id)) continue;
        const r = runs.get(id);
        if (!r) runs.set(id, [c.repeat]); else if (!r.includes(c.repeat)) r.push(c.repeat);
      }
    }
    for (const [id, r] of Array.from(runs.entries())) {
      const v = r.length;
      if (v > repeats) { irregular.add(id); continue; }
      const key = [...r].sort((a, b) => a - b).join(",");
      const band = groups[d][v - 1];
      const b = band.buckets.findIndex((_, i) => repeatsForBucket(v, repeats, i).join(",") === key);
      if (b < 0) { irregular.add(id); continue; }
      band.buckets[b].push(byId.get(id)!);
      shares.set(id, [...(shares.get(id) ?? []), v]);
    }
  }
  return { groups, shares, irregular };
}

/** Takes an outlet out of every bucket it is in. */
export function removeOutlet<T extends Stop>(groups: DayBand<T>[][], id: string): void {
  for (const bands of groups) for (const band of bands) for (const bucket of band.buckets) {
    const i = bucket.findIndex(o => o.id === id);
    if (i >= 0) bucket.splice(i, 1);
  }
}

export interface PlaceInput<T extends Stop> {
  groups: DayBand<T>[][];
  repeats: number;
  /** Outlets to add, each with the visits a cycle it is due on each day-group it joins. */
  arrivals: { outlet: T; shares: number[] }[];
  dist: (a: T, b: T) => number;
  /** Ceiling of the visits band, if days are balanced by visit count. */
  visitsMax?: number;
}

/**
 * Adds each arriving outlet to the day that already passes it: the bucket
 * whose routes hold its nearest neighbour. Among buckets about as near
 * (within a quarter of the nearest distance), one whose days still have
 * room under the ceiling is preferred, then the one with the fewest calls.
 * A day that ends up over the band is put right by the repair afterwards,
 * through its border; sending the outlet across the territory to a day
 * with room would not be.
 */
export function placeArrivals<T extends Stop>(inp: PlaceInput<T>): { placed: number; unplaced: T[] } {
  const R = Math.max(1, inp.repeats), G = inp.groups.length;
  const runsOf = (v: number, b: number) => repeatsForBucket(v, R, b).map(x => x - 1);
  // cells[d][r] = the outlets driven on run r of day-group d.
  const cells: T[][][] = inp.groups.map(bands => {
    const row: T[][] = Array.from({ length: R }, () => []);
    for (const band of bands) band.buckets.forEach((bucket, b) => { for (const r of runsOf(band.visits, b)) if (r < R) row[r].push(...bucket); });
    return row;
  });
  const arrivals = [...inp.arrivals].sort((a, b) => (a.outlet.id < b.outlet.id ? -1 : a.outlet.id > b.outlet.id ? 1 : 0));
  const unplaced: T[] = [];
  let placed = 0;
  for (const { outlet: o, shares } of arrivals) {
    const used = new Set<number>();
    for (const v of shares) {
      type Cand = { d: number; b: number; near: number; count: number; empty: boolean };
      const cands: Cand[] = [];
      for (let d = 0; d < G; d++) {
        if (used.has(d)) continue;
        const band = inp.groups[d].find(x => x.visits === v);
        if (!band) continue;
        for (let b = 0; b < band.buckets.length; b++) {
          let near = 0, count = 0, empty = false;
          for (const r of runsOf(v, b)) {
            const members = cells[d][r] ?? [];
            if (members.length === 0) { empty = true; continue; }
            let m = Infinity;
            for (const x of members) m = Math.min(m, inp.dist(o, x));
            near = Math.max(near, m);
            count = Math.max(count, members.length);
          }
          cands.push({ d, b, near, count, empty });
        }
      }
      // A day that does not exist yet is opened only when there is no other.
      const pool = cands.some(c => !c.empty) ? cands.filter(c => !c.empty) : cands;
      if (pool.length === 0) { unplaced.push(o); continue; }
      const nearest = pool.reduce((m, c) => Math.min(m, c.near), Infinity);
      const close = pool.filter(c => c.near <= nearest * 1.25 + 0.05);
      const full = (c: Cand) => (inp.visitsMax && c.count + 1 > inp.visitsMax ? 1 : 0);
      close.sort((x, y) => full(x) - full(y) || x.count - y.count || x.near - y.near || x.d - y.d || x.b - y.b);
      const pick = close[0];
      inp.groups[pick.d].find(x => x.visits === v)!.buckets[pick.b].push(o);
      for (const r of runsOf(v, pick.b)) if (r < R) cells[pick.d][r].push(o);
      used.add(pick.d);
      placed++;
    }
  }
  return { placed, unplaced };
}

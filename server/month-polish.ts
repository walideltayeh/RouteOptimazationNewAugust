/**
 * Days over the shift, fixed on the day as the rep works it.
 *
 * The day cuts balance visit counts (or an estimate of work per visit made
 * before any route exists). Once the routes exist the real day is known -
 * call minutes plus the driving of the actual stop order plus commute and
 * break - and some days run over the shift while the same rep's other days
 * have room: Beirut's one rep averaged 7.96 hours with days from 7.2 to 8.9.
 *
 * This pass takes the rep's month as built and, while a day is over the
 * shift, moves one outlet off it to another of the rep's days: a different
 * weekday, or the other week of the same weekday. It keeps the outlet's
 * frequency and spacing (a fortnightly outlet stays fortnightly, on one
 * day-group), and a move is only kept when
 *   - it lowers the overtime, counted on the re-ordered routes,
 *   - the day that takes the outlet stays no longer than the relieved day was,
 *   - no day's visit count leaves the band it was in,
 *   - no route gains a leg over the hop limit, and
 *   - no more stops end up inside another route's area than before.
 * So it only ever moves outlets on the border between two days, and a rep
 * whose days already fit is not touched at all.
 *
 * With `restoreBand` the same pass first repairs what an edit did to a month
 * that keeps its days, in both directions: a day the edit left above the
 * visits band gives an outlet up, a day it left short takes one from a
 * neighbour. Each day is measured against what it was before the edit, so
 * a day that was already outside the band is left as the plan had it, and
 * only the days the edit touched, and the neighbours that help them, change.
 *
 * Pure and deterministic: distances, call times, the day-length formula, the
 * route ordering and the overlap count are passed in.
 */
import { bucketsForFrequency, repeatsForBucket } from "./cycle";

export interface Stop { id: string; latitude: number; longitude: number }
/** One frequency band of a day-group: outlets due `visits` times a cycle here, split into week buckets. */
export interface DayBand<T> { visits: number; buckets: T[][] }

export interface RelieveInput<T extends Stop> {
  /** groups[d] = the bands of day-group d. Buckets are edited in place. */
  groups: DayBand<T>[][];
  repeats: number;
  dist: (a: T, b: T) => number;
  callMinutes: (o: T) => number;
  /**
   * Minutes of a day with these call minutes and this much driving between
   * calls. The stop order is passed when the day is being measured for real,
   * so a road server's driving times can be used; estimates pass km only.
   */
  dayMinutes: (callMinutes: number, km: number, tour?: T[]) => number;
  /** The engine's own stop ordering, so a move is judged on the route that will be driven. */
  order: (stops: T[]) => T[];
  shiftMinutes: number;
  /** Visit-count band a day must not leave (plans balanced by visit count); null when days are balanced by time. */
  visitsBand?: { min: number; max: number } | null;
  maxHopKm: number;
  movable?: (o: T) => boolean;
  /** Stops lying inside another route's area, over all the rep's routes; a move may not raise it. */
  intruders?: (routes: T[][]) => number;
  maxMoves?: number;
  /**
   * Also repair the days an edit left outside the visits band or, where days
   * are balanced by working time, much shorter than they were. For a month
   * that was edited (outlets deleted, or moved in from another rep) and
   * keeps its days.
   */
  restoreBand?: boolean;
  /**
   * With restoreBand: what a day was before the edit, by day-group and run
   * (both 0-based). A day counts as broken only where the edit made it
   * worse; without this, every day is held to the band itself.
   */
  before?: (dayGroup: number, run: number) => { visits: number; minutes: number } | null | undefined;
}
export interface RelieveResult {
  moves: number;
  /** Days over the shift by more than `graceMinutes`, before and after. */
  overBefore: number; overAfter: number;
  longestBefore: number; longestAfter: number;
  /** With restoreBand: days the edit left outside the band or short, before the repair and after it. */
  outOfBandBefore: number; outOfBandAfter: number;
  /** Days over the shift (beyond the grace) now that were not before the edit; all of them without a `before`. */
  newlyOver: number;
}

interface Cell<T> { d: number; r: number; tour: T[]; km: number; call: number; minutes: number; long: number; lo: number; hi: number; floor: number; wasOver: boolean }

export function relieveOverloadedDays<T extends Stop>(inp: RelieveInput<T>, graceMinutes = 15): RelieveResult {
  const R = Math.max(1, inp.repeats), G = inp.groups.length, S = inp.shiftMinutes;
  const movable = inp.movable ?? (() => true);
  const maxMoves = inp.maxMoves ?? 400;

  // Every band carries its full set of week buckets, so an outlet can move
  // to a week this day-group had nothing in.
  for (const bands of inp.groups) for (const band of bands) {
    const want = bucketsForFrequency(band.visits, R);
    while (band.buckets.length < want) band.buckets.push([]);
  }
  const runsCache = new Map<string, number[]>();
  const runsOf = (visits: number, b: number) => {
    const k = `${visits}:${b}`;
    let v = runsCache.get(k);
    if (!v) { v = repeatsForBucket(visits, R, b).map(x => x - 1); runsCache.set(k, v); }
    return v;
  };

  const cells: Cell<T>[][] = inp.groups.map((_, d) => Array.from({ length: R }, (_, r) => ({ d, r, tour: [] as T[], km: 0, call: 0, minutes: 0, long: 0, lo: 0, hi: Infinity, floor: 0, wasOver: false })));
  const membersOf = (d: number, r: number): T[] => {
    const out: T[] = [];
    for (const band of inp.groups[d]) band.buckets.forEach((bucket, b) => { if (runsOf(band.visits, b).includes(r)) out.push(...bucket); });
    return out;
  };
  const rebuild = (c: Cell<T>) => {
    const stops = membersOf(c.d, c.r);
    c.tour = stops.length > 1 ? inp.order(stops) : stops;
    c.km = 0; c.long = 0;
    for (let i = 1; i < c.tour.length; i++) { const x = inp.dist(c.tour[i - 1], c.tour[i]); c.km += x; if (inp.maxHopKm > 0 && x > inp.maxHopKm) c.long++; }
    c.call = c.tour.reduce((s, o) => s + inp.callMinutes(o), 0);
    c.minutes = c.tour.length > 0 ? inp.dayMinutes(c.call, c.km, c.tour) : 0;
  };
  for (const row of cells) for (const c of row) rebuild(c);

  // Overtime squared, so the worst day is relieved first and a move that
  // only shifts the overtime elsewhere does not pay; plus the day's own
  // length, which across a move is the change in driving.
  const bandGap = (n: number) => (!inp.visitsBand || n === 0 ? 0 : n < inp.visitsBand.min ? inp.visitsBand.min - n : n > inp.visitsBand.max ? n - inp.visitsBand.max : 0);
  // Repairing an edit: each day has its own band, the plan's band widened to
  // what the day was before the edit (a day that was at 19 against a floor
  // of 25 is not the edit's doing). Where days are balanced by working time
  // there is no visits band; a day is short when it falls under four fifths
  // of the rep's average day and under nine tenths of what it was.
  const restore = !!inp.restoreBand;
  if (restore) {
    const live = cells.flat().filter(c => c.tour.length > 0);
    const mean = live.reduce((t, c) => t + c.minutes, 0) / Math.max(1, live.length);
    for (const c of cells.flat()) {
      const was = inp.before?.(c.d, c.r) ?? null;
      if (inp.visitsBand) {
        c.lo = Math.min(inp.visitsBand.min, was && was.visits > 0 ? was.visits : inp.visitsBand.min);
        c.hi = Math.max(inp.visitsBand.max, was ? was.visits : inp.visitsBand.max);
      } else {
        c.floor = Math.min(0.8 * mean, was ? 0.9 * was.minutes : Infinity);
      }
      c.wasOver = !!was && was.minutes > S + graceMinutes;
    }
  }
  const gapOf = (c: Cell<T>, n: number) => (!restore || n === 0 ? 0 : n < c.lo ? c.lo - n : n > c.hi ? n - c.hi : 0);
  const shortOf = (c: Cell<T>, minutes: number, n: number) => (restore && n > 0 ? Math.max(0, c.floor - minutes) : 0);
  // A visit outside the band outweighs any overtime one outlet could cause,
  // so the band is settled first.
  const BAND_WEIGHT = 10000;
  const cost = (c: Cell<T>, minutes: number, n: number) => {
    const over = Math.max(0, minutes - S), gap = gapOf(c, n), short = shortOf(c, minutes, n);
    return over * over + 2 * minutes + BAND_WEIGHT * gap * gap + short * short;
  };
  const broken = (c: Cell<T>) => gapOf(c, c.tour.length) > 0 || shortOf(c, c.minutes, c.tour.length) > 1e-6;
  const allRoutes = (): T[][] => {
    const seen = new Set<string>(), out: T[][] = [];
    for (const row of cells) for (const c of row) {
      if (c.tour.length === 0) continue;
      const k = c.tour.map(o => o.id).sort().join(",");
      if (!seen.has(k)) { seen.add(k); out.push(c.tour); }
    }
    return out;
  };
  const days = () => cells.flat().filter(c => c.tour.length > 0);
  const overCount = () => days().filter(c => c.minutes > S + graceMinutes).length;
  const longest = () => days().reduce((m, c) => Math.max(m, c.minutes), 0);
  const outOfBand = () => days().filter(broken).length;
  const newlyOver = () => days().filter(c => c.minutes > S + graceMinutes && !c.wasOver).length;

  const result: RelieveResult = { moves: 0, overBefore: overCount(), overAfter: 0, longestBefore: longest(), longestAfter: 0, outOfBandBefore: outOfBand(), outOfBandAfter: 0, newlyOver: 0 };
  if (longest() <= S && result.outOfBandBefore === 0) {
    result.overAfter = result.overBefore; result.longestAfter = result.longestBefore; result.outOfBandAfter = result.outOfBandBefore; result.newlyOver = newlyOver();
    return result;
  }

  let intruders = inp.intruders ? inp.intruders(allRoutes()) : 0;
  // Repairing an edit, a move may leave a stop or two inside another
  // route's area: up to one in a hundred of the rep's stops in all. The
  // alternative, when a border outlet cannot cross cleanly, is to cut the
  // whole month again and move a hundred outlets to mend two days.
  const intrudersAtStart = intruders;
  const weekSlack = restore ? Math.max(1, Math.round(0.01 * days().reduce((t, c) => t + c.tour.length, 0))) : 0;
  const stuck = new Set<Cell<T>>();
  const tabu = new Set<string>();

  while (result.moves < maxMoves) {
    // The day to work on: one the edit broke first (furthest outside its
    // band, then shortest), else the longest day over the shift.
    const open = days().filter(c => !stuck.has(c));
    const offBand = restore
      ? open.filter(broken).sort((a, b) => gapOf(b, b.tour.length) - gapOf(a, a.tour.length) || shortOf(b, b.minutes, b.tour.length) - shortOf(a, a.minutes, a.tour.length) || a.d - b.d || a.r - b.r)[0]
      : undefined;
    const worst = offBand ?? open.filter(c => c.minutes > S + 1e-6).sort((a, b) => b.minutes - a.minutes || a.d - b.d || a.r - b.r)[0];
    if (!worst) break;
    const worstMinutes = worst.minutes;
    // A day short of visits or of work takes an outlet in; any other day gives one up.
    const takes = !!offBand && (worst.tour.length < worst.lo || shortOf(worst, worst.minutes, worst.tour.length) > 1e-6);

    // `reach` is how far the outlet sits from the routes it would join, in
    // those routes' own typical legs: 1 is a next-door stop on the border.
    type Cand = { o: T; band: DayBand<T>; b: number; d2: number; band2: DayBand<T>; b2: number; give: Cell<T>[]; recv: Cell<T>[]; gain: number; reach: number };
    const cands: Cand[] = [];
    // One outlet from bucket b of `band` (day-group d1) to bucket b2 of day-group d2.
    const consider = (o: T, d1: number, band: DayBand<T>, b: number, d2: number, band2: DayBand<T>, b2: number) => {
      if (d2 === d1 && b2 === b) return;
      if (tabu.has(`${o.id}|${d2}|${b2}`)) return;
      const from = runsOf(band.visits, b), to = runsOf(band.visits, b2);
      const give = (d2 === d1 ? from.filter(r => !to.includes(r)) : from).map(r => cells[d1][r]);
      const recv = (d2 === d1 ? to.filter(r => !from.includes(r)) : to).map(r => cells[d2][r]);
      if (!(takes ? recv : give).includes(worst) || recv.some(c => c.tour.length === 0)) return;
      // Two shops in one building stay on one day.
      if (give.some(c => c.tour.some(x => x !== o && inp.dist(x, o) < 0.005))) return;
      if (restore) {
        // Together the days touched may not end up further outside their bands.
        const before = give.reduce((t, c) => t + gapOf(c, c.tour.length) ** 2, 0) + recv.reduce((t, c) => t + gapOf(c, c.tour.length) ** 2, 0);
        const after = give.reduce((t, c) => t + gapOf(c, c.tour.length - 1) ** 2, 0) + recv.reduce((t, c) => t + gapOf(c, c.tour.length + 1) ** 2, 0);
        if (after > before) return;
      } else if (give.some(c => bandGap(c.tour.length - 1) > bandGap(c.tour.length)) || recv.some(c => bandGap(c.tour.length + 1) > bandGap(c.tour.length))) return;
      // Estimated on the routes as they stand: what leaving saves, what the cheapest slot costs.
      let gain = 0;
      const call = inp.callMinutes(o);
      for (const c of give) {
        const i = c.tour.indexOf(o), prev = c.tour[i - 1], next = c.tour[i + 1];
        const saved = (prev ? inp.dist(prev, o) : 0) + (next ? inp.dist(o, next) : 0) - (prev && next ? inp.dist(prev, next) : 0);
        const after = c.tour.length > 1 ? inp.dayMinutes(c.call - call, Math.max(0, c.km - saved)) : 0;
        gain += cost(c, c.minutes, c.tour.length) - cost(c, after, c.tour.length - 1);
      }
      let reach = 0;
      for (const c of recv) {
        let add = Math.min(inp.dist(o, c.tour[0]), inp.dist(c.tour[c.tour.length - 1], o));
        for (let i = 1; i < c.tour.length; i++) add = Math.min(add, inp.dist(c.tour[i - 1], o) + inp.dist(o, c.tour[i]) - inp.dist(c.tour[i - 1], c.tour[i]));
        gain += cost(c, c.minutes, c.tour.length) - cost(c, inp.dayMinutes(c.call + call, c.km + add), c.tour.length + 1);
        let near = Infinity;
        for (const x of c.tour) near = Math.min(near, inp.dist(o, x));
        reach = Math.max(reach, near / Math.max(0.03, c.tour.length > 1 ? c.km / (c.tour.length - 1) : near));
      }
      if (gain > 1e-6 && reach <= 3) cands.push({ o, band, b, d2, band2, b2, give, recv, gain, reach });
    };
    if (takes) {
      // Every way one outlet of another day could come to this one.
      for (const band2 of inp.groups[worst.d]) {
        for (let b2 = 0; b2 < band2.buckets.length; b2++) {
          if (!runsOf(band2.visits, b2).includes(worst.r)) continue;
          for (let d1 = 0; d1 < G; d1++) {
            const band = inp.groups[d1].find(x => x.visits === band2.visits);
            if (!band) continue;
            band.buckets.forEach((bucket, b) => { for (const o of bucket) if (movable(o)) consider(o, d1, band, b, worst.d, band2, b2); });
          }
        }
      }
    } else {
      // Every way one outlet could leave this day.
      for (const band of inp.groups[worst.d]) {
        band.buckets.forEach((bucket, b) => {
          if (!runsOf(band.visits, b).includes(worst.r)) return;
          for (const o of bucket) {
            if (!movable(o)) continue;
            for (let d2 = 0; d2 < G; d2++) {
              const band2 = inp.groups[d2].find(x => x.visits === band.visits);
              if (!band2) continue;
              for (let b2 = 0; b2 < band2.buckets.length; b2++) consider(o, worst.d, band, b, d2, band2, b2);
            }
          }
        });
      }
    }
    // Next-door outlets first, the biggest relief first among those: an
    // outlet deep inside its own day would relieve it just as much, and
    // drag the other day's area across it.
    const ring = (c: Cand) => (c.reach <= 1 ? 0 : c.reach <= 2 ? 1 : 2);
    cands.sort((x, y) => ring(x) - ring(y) || y.gain - x.gain || (x.o.id < y.o.id ? -1 : x.o.id > y.o.id ? 1 : 0) || x.d2 - y.d2 || x.b2 - y.b2);

    // The best few are tried for real: routes re-ordered, every guard checked.
    let accepted = false;
    for (const c of cands.slice(0, 16)) {
      const touched = [...c.give, ...c.recv];
      const before = touched.map(x => ({ tour: x.tour, km: x.km, call: x.call, minutes: x.minutes, long: x.long }));
      const costBefore = touched.reduce((s, x) => s + cost(x, x.minutes, x.tour.length), 0);
      const longBefore = touched.reduce((s, x) => s + x.long, 0);
      const at = c.band.buckets[c.b].indexOf(c.o);
      c.band.buckets[c.b].splice(at, 1);
      c.band2.buckets[c.b2].push(c.o);
      touched.forEach(rebuild);
      const realGain = costBefore - touched.reduce((s, x) => s + cost(x, x.minutes, x.tour.length), 0);
      const longNow = touched.reduce((s, x) => s + x.long, 0);
      // A move made for the shift may not leave the day that takes the
      // outlet longer than the day it relieves was: the longest day of the
      // month never grows. (A move made for the band is judged on the band.)
      let ok = realGain > 1e-6 && longNow <= longBefore && (!!offBand || c.recv.every(x => x.minutes <= worstMinutes + 1e-6));
      let now = intruders;
      if (ok && inp.intruders) { now = inp.intruders(allRoutes()); ok = now <= intruders || now <= intrudersAtStart + weekSlack; }
      if (ok) {
        intruders = now;
        result.moves++;
        // A day with nothing to hand over may have a neighbour with room now:
        // the relief travels from the lightest days inward, a step at a time.
        stuck.clear();
        accepted = true;
        break;
      }
      c.band2.buckets[c.b2].pop();
      c.band.buckets[c.b].splice(at, 0, c.o);
      touched.forEach((x, i) => Object.assign(x, before[i]));
      tabu.add(`${c.o.id}|${c.d2}|${c.b2}`);
    }
    if (!accepted) stuck.add(worst);
  }

  result.overAfter = overCount();
  result.longestAfter = longest();
  result.outOfBandAfter = outOfBand();
  result.newlyOver = newlyOver();
  return result;
}

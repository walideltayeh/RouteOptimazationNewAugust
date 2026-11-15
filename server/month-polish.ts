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
}
export interface RelieveResult {
  moves: number;
  /** Days over the shift by more than `graceMinutes`, before and after. */
  overBefore: number; overAfter: number;
  longestBefore: number; longestAfter: number;
}

interface Cell<T> { d: number; r: number; tour: T[]; km: number; call: number; minutes: number; long: number }

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

  const cells: Cell<T>[][] = inp.groups.map((_, d) => Array.from({ length: R }, (_, r) => ({ d, r, tour: [] as T[], km: 0, call: 0, minutes: 0, long: 0 })));
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
  const cost = (minutes: number) => { const over = Math.max(0, minutes - S); return over * over + 2 * minutes; };
  const bandGap = (n: number) => (!inp.visitsBand || n === 0 ? 0 : n < inp.visitsBand.min ? inp.visitsBand.min - n : n > inp.visitsBand.max ? n - inp.visitsBand.max : 0);
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

  const result: RelieveResult = { moves: 0, overBefore: overCount(), overAfter: 0, longestBefore: longest(), longestAfter: 0 };
  if (longest() <= S) { result.overAfter = result.overBefore; result.longestAfter = result.longestBefore; return result; }

  let intruders = inp.intruders ? inp.intruders(allRoutes()) : 0;
  const stuck = new Set<Cell<T>>();
  const tabu = new Set<string>();

  while (result.moves < maxMoves) {
    const worst = days().filter(c => c.minutes > S + 1e-6 && !stuck.has(c)).sort((a, b) => b.minutes - a.minutes || a.d - b.d || a.r - b.r)[0];
    if (!worst) break;
    const worstMinutes = worst.minutes;

    // Every way one outlet could leave the worst day.
    // `reach` is how far the outlet sits from the routes it would join, in
    // those routes' own typical legs: 1 is a next-door stop on the border.
    type Cand = { o: T; band: DayBand<T>; b: number; d2: number; band2: DayBand<T>; b2: number; give: Cell<T>[]; recv: Cell<T>[]; gain: number; reach: number };
    const cands: Cand[] = [];
    for (const band of inp.groups[worst.d]) {
      band.buckets.forEach((bucket, b) => {
        const from = runsOf(band.visits, b);
        if (!from.includes(worst.r)) return;
        for (const o of bucket) {
          if (!movable(o)) continue;
          for (let d2 = 0; d2 < G; d2++) {
            const band2 = inp.groups[d2].find(x => x.visits === band.visits);
            if (!band2) continue;
            for (let b2 = 0; b2 < band2.buckets.length; b2++) {
              if (d2 === worst.d && b2 === b) continue;
              if (tabu.has(`${o.id}|${d2}|${b2}`)) continue;
              const to = runsOf(band.visits, b2);
              const give = (d2 === worst.d ? from.filter(r => !to.includes(r)) : from).map(r => cells[worst.d][r]);
              const recv = (d2 === worst.d ? to.filter(r => !from.includes(r)) : to).map(r => cells[d2][r]);
              if (!give.includes(worst) || recv.some(c => c.tour.length === 0)) continue;
              // Two shops in one building stay on one day.
              if (give.some(c => c.tour.some(x => x !== o && inp.dist(x, o) < 0.005))) continue;
              if (give.some(c => bandGap(c.tour.length - 1) > bandGap(c.tour.length)) || recv.some(c => bandGap(c.tour.length + 1) > bandGap(c.tour.length))) continue;
              // Estimated on the routes as they stand: what leaving saves, what the cheapest slot costs.
              let gain = 0;
              const call = inp.callMinutes(o);
              for (const c of give) {
                const i = c.tour.indexOf(o), prev = c.tour[i - 1], next = c.tour[i + 1];
                const saved = (prev ? inp.dist(prev, o) : 0) + (next ? inp.dist(o, next) : 0) - (prev && next ? inp.dist(prev, next) : 0);
                const after = c.tour.length > 1 ? inp.dayMinutes(c.call - call, Math.max(0, c.km - saved)) : 0;
                gain += cost(c.minutes) - cost(after);
              }
              let reach = 0;
              for (const c of recv) {
                let add = Math.min(inp.dist(o, c.tour[0]), inp.dist(c.tour[c.tour.length - 1], o));
                for (let i = 1; i < c.tour.length; i++) add = Math.min(add, inp.dist(c.tour[i - 1], o) + inp.dist(o, c.tour[i]) - inp.dist(c.tour[i - 1], c.tour[i]));
                gain += cost(c.minutes) - cost(inp.dayMinutes(c.call + call, c.km + add));
                let near = Infinity;
                for (const x of c.tour) near = Math.min(near, inp.dist(o, x));
                reach = Math.max(reach, near / Math.max(0.03, c.tour.length > 1 ? c.km / (c.tour.length - 1) : near));
              }
              if (gain > 1e-6 && reach <= 3) cands.push({ o, band, b, d2, band2, b2, give, recv, gain, reach });
            }
          }
        }
      });
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
      const costBefore = touched.reduce((s, x) => s + cost(x.minutes), 0);
      const longBefore = touched.reduce((s, x) => s + x.long, 0);
      const at = c.band.buckets[c.b].indexOf(c.o);
      c.band.buckets[c.b].splice(at, 1);
      c.band2.buckets[c.b2].push(c.o);
      touched.forEach(rebuild);
      const realGain = costBefore - touched.reduce((s, x) => s + cost(x.minutes), 0);
      const longNow = touched.reduce((s, x) => s + x.long, 0);
      // The day that takes the outlet may not end up longer than the day
      // it relieves was: the longest day of the month never grows.
      let ok = realGain > 1e-6 && longNow <= longBefore && c.recv.every(x => x.minutes <= worstMinutes + 1e-6);
      let now = intruders;
      if (ok && inp.intruders) { now = inp.intruders(allRoutes()); ok = now <= intruders; }
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
  return result;
}

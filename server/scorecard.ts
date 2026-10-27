/**
 * The RTM scorecard: how good a finished plan is, in the terms a field-sales
 * manager signs off on. Pure: it takes outlets, reps and day routes and
 * returns KPIs, a grade, plain-language checks and a per-rep table. The
 * optimizer attaches it to every run and the dashboard shows it as is.
 */
import { haversineKm } from "./road-distance";
import { callMinutesFor, dayMinutes, DEFAULT_WORKDAY, type WorkdayModel } from "./rtm";

export interface ScoreOutlet {
  id: string; name: string; latitude: number; longitude: number;
  visitFrequency: number; timePerVisit?: number | null; channel?: string | null;
  territory?: string | null; geoStatus?: string | null; repId?: string | null;
}
export interface ScoreCell {
  repId: string; week: number; dayOfWeek: number;
  outletIds: string[]; routeOrder?: string[] | null; totalDistance?: number | null;
}
export interface ScoreInputs {
  outlets: ScoreOutlet[];
  reps: { id: string; name: string }[];
  schedules: ScoreCell[];
  band: { min: number; max: number };
  maxHopKm: number;
  workday?: WorkdayModel;
  /** totalDistance on the cells is road km (a road server was used). */
  roadKm?: boolean;
  /** Outlets' timePerVisit came from the file rather than a default. */
  callTimeIsReal?: boolean;
  /** Days were balanced by working time rather than by visit count. */
  balanceBy?: "visits" | "time";
}
export type CheckStatus = "pass" | "warn" | "fail";
export interface ScoreCheck { id: string; status: CheckStatus; title: string; detail?: string }
export interface RepScore {
  repId: string; name: string; outlets: number; monthlyVisits: number;
  visitsPerDay: { min: number; avg: number; max: number };
  kmPerMonth: number; kmPerDay: number; hoursPerDay: number; maxHoursPerDay: number;
  longHops: number; overlapPct: number;
}
export interface Scorecard {
  grade: "A" | "B" | "C" | "D";
  score: number;
  headline: string;
  kpis: {
    reps: number; dayRoutes: number; distinctRoutes: number;
    outlets: number; planned: number; heldForReview: number; unplanned: number; excluded: number; coveragePct: number;
    visitsPerDay: { min: number; avg: number; max: number }; daysInBandPct: number;
    kmPerDay: number; kmPerMonth: number; drivingHoursPerDay: number; callHoursPerDay: number;
    workdayHours: number; maxWorkdayHours: number; overloadedDays: number; shiftHours: number;
    routeOverlapPct: number; territoryOverlapPct: number; repBalancePct: number;
    longHops: number; routesWithLongHop: number; longestHopKm: number;
    /** Long drives beyond the ones a route needs to reach villages more than the hop limit apart. */
    avoidableLongHops: number; routesWithAvoidableHop: number;
    kmBasis: "road" | "straight-line";
    /** Share of days within 12% of the median workday. */
    evenDaysPct: number;
    balanceBy: "visits" | "time";
  };
  checks: ScoreCheck[];
  perRep: RepScore[];
}

// --- geometry: convex hulls on (lng, lat) and point-in-polygon
type P = [number, number];
function hull(points: P[]): P[] {
  const pts = Array.from(new Map(points.map(p => [`${p[0]},${p[1]}`, p])).values()).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P[] = [], upper: P[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
interface Poly { pts: P[]; minX: number; maxX: number; minY: number; maxY: number }
function poly(points: P[]): Poly {
  const pts = hull(points);
  return { pts, minX: Math.min(...pts.map(p => p[0])), maxX: Math.max(...pts.map(p => p[0])), minY: Math.min(...pts.map(p => p[1])), maxY: Math.max(...pts.map(p => p[1])) };
}
function inside(pg: Poly, q: P): boolean {
  if (pg.pts.length < 3 || q[0] < pg.minX || q[0] > pg.maxX || q[1] < pg.minY || q[1] > pg.maxY) return false;
  let c = false; const h = pg.pts;
  for (let i = 0, j = h.length - 1; i < h.length; j = i++) {
    if ((h[i][1] > q[1]) !== (h[j][1] > q[1]) && q[0] < (h[j][0] - h[i][0]) * (q[1] - h[i][1]) / (h[j][1] - h[i][1]) + h[i][0]) c = !c;
  }
  return c;
}
/**
 * Share of members lying inside another group's area. The other group's area
 * is the hull of its own outlets only: a weekly outlet sits on both weeks'
 * routes, and both routes must drive to it, so it neither intrudes nor
 * stretches either route's area over the other.
 */
export function overlapShare(groups: P[][]): number {
  const keys = groups.map(g => new Set(g.map(q => `${q[0]},${q[1]}`)));
  const sharedCache = new Map<number, boolean>();
  const shared = (a: number, b: number) => {
    const k = a * 100003 + b;
    let v = sharedCache.get(k);
    if (v === undefined) { v = groups[a].some(q => keys[b].has(`${q[0]},${q[1]}`)); sharedCache.set(k, v); }
    return v;
  };
  const whole = groups.map(poly);
  const own = new Map<string, Poly>();
  const areaOf = (b: number, a: number): Poly => {
    if (!shared(a, b)) return whole[b];
    const k = `${b}|${a}`;
    let pg = own.get(k);
    if (!pg) { pg = poly(groups[b].filter(q => !keys[a].has(`${q[0]},${q[1]}`))); own.set(k, pg); }
    return pg;
  };
  let n = 0, tot = 0;
  groups.forEach((g, a) => {
    for (const q of g) {
      tot++;
      const k = `${q[0]},${q[1]}`;
      for (let b = 0; b < groups.length; b++) {
        if (b === a) continue;
        // The bounding box of the whole group rules most groups out before any key or hull work.
        const wb = whole[b];
        if (q[0] < wb.minX || q[0] > wb.maxX || q[1] < wb.minY || q[1] > wb.maxY) continue;
        if (keys[b].has(k)) continue;
        if (inside(areaOf(b, a), q)) { n++; break; }
      }
    }
  });
  return tot > 0 ? n / tot : 0;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number) => Math.round(x * 1000) / 10;
const fmt = (n: number) => n.toLocaleString("en-US");

export function scorePlan(inp: ScoreInputs): Scorecard {
  const wd = inp.workday ?? DEFAULT_WORKDAY;
  const byId = new Map(inp.outlets.map(o => [o.id, o]));
  const repName = new Map(inp.reps.map(r => [r.id, r.name]));
  const cells = inp.schedules.filter(s => (s.outletIds?.length ?? 0) > 0);

  // Coverage.
  const excluded = inp.outlets.filter(o => o.territory === "Excluded").length;
  const held = inp.outlets.filter(o => o.territory !== "Excluded" && (o.territory === "Needs Review" || o.geoStatus === "offset")).length;
  const planned = new Set<string>();
  for (const c of cells) for (const id of c.outletIds) planned.add(id);
  const active = inp.outlets.filter(o => o.territory !== "Excluded").length;
  const plannedCount = inp.outlets.filter(o => planned.has(o.id)).length;
  const unplanned = Math.max(0, active - held - plannedCount);
  const coverageBase = Math.max(1, active - held);

  // Each driven day.
  const days = cells.map(c => {
    const order = (c.routeOrder && c.routeOrder.length > 0 ? c.routeOrder : c.outletIds).map(id => byId.get(id)).filter(Boolean) as ScoreOutlet[];
    const legs: number[] = [];
    for (let i = 1; i < order.length; i++) legs.push(haversineKm(order[i - 1].latitude, order[i - 1].longitude, order[i].latitude, order[i].longitude));
    const straight = legs.reduce((a, b) => a + b, 0);
    const roadKm = inp.roadKm && c.totalDistance != null ? c.totalDistance : undefined;
    const callMin = order.reduce((s, o) => s + callMinutesFor(o, 15, inp.callTimeIsReal !== false), 0);
    const t = dayMinutes(callMin, straight, wd, roadKm);
    return { cell: c, visits: c.outletIds.length, legs, km: roadKm ?? straight, drive: t.drive, total: t.total, callMin };
  });
  const visits = days.map(d => d.visits);
  const inBand = days.filter(d => d.visits >= inp.band.min && d.visits <= inp.band.max).length;
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const shift = wd.shiftMinutes;
  const overloaded = days.filter(d => d.total > shift + 15).length;
  const byTime = inp.balanceBy === "time";
  const sortedTotals = days.map(d => d.total).sort((a, b) => a - b);
  const medTotal = sortedTotals.length ? sortedTotals[Math.floor(sortedTotals.length / 2)] : 0;
  const even = days.filter(d => medTotal > 0 && Math.abs(d.total - medTotal) <= 0.12 * medTotal).length;

  // Distinct routes (a route driven on several days counts once) for hops and overlap.
  const distinct = new Map<string, (typeof days)[number]>();
  for (const d of days) {
    const k = `${d.cell.repId}|${[...d.cell.outletIds].sort().join(",")}`;
    if (!distinct.has(k)) distinct.set(k, d);
  }
  const routes = Array.from(distinct.values());
  // A route over villages more than the hop limit apart needs one long
  // drive per gap: (pieces - 1). Long drives beyond that are avoidable -
  // the order goes back and forth - and only those count against the plan.
  const piecesOf = (ids: string[]) => {
    const pts = ids.map(id => byId.get(id)).filter(Boolean) as ScoreOutlet[];
    const parent = pts.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      if (haversineKm(pts[i].latitude, pts[i].longitude, pts[j].latitude, pts[j].longitude) <= inp.maxHopKm) parent[find(i)] = find(j);
    }
    return new Set(pts.map((_, i) => find(i))).size;
  };
  let longHops = 0, routesWithLong = 0, longest = 0, avoidable = 0, routesWithAvoidable = 0;
  for (const r of routes) {
    const over = inp.maxHopKm > 0 ? r.legs.filter(l => l > inp.maxHopKm) : [];
    longHops += over.length; if (over.length) routesWithLong++;
    if (over.length) {
      const extra = Math.max(0, over.length - (piecesOf(r.cell.outletIds) - 1));
      avoidable += extra; if (extra > 0) routesWithAvoidable++;
    }
    for (const l of r.legs) if (l > longest) longest = l;
  }
  const pt = (id: string): P | null => { const o = byId.get(id); return o ? [o.longitude, o.latitude] : null; };
  const routesByRep = new Map<string, P[][]>();
  for (const r of routes) {
    const list = routesByRep.get(r.cell.repId) ?? [];
    list.push(r.cell.outletIds.map(pt).filter(Boolean) as P[]);
    routesByRep.set(r.cell.repId, list);
  }
  let overlapN = 0, overlapTot = 0;
  const repOverlap = new Map<string, number>();
  routesByRep.forEach((gs, rep) => {
    const share = gs.length > 1 ? overlapShare(gs) : 0;
    const n = gs.reduce((s, g) => s + g.length, 0);
    overlapN += share * n; overlapTot += n; repOverlap.set(rep, share);
  });
  const territories = Array.from(routesByRep.values()).map(gs => gs.flat());
  const territoryOverlap = territories.length > 1 ? overlapShare(territories) : 0;

  // Per rep.
  const repIds = Array.from(new Set(days.map(d => d.cell.repId)));
  const perRep: RepScore[] = repIds.map(id => {
    const ds = days.filter(d => d.cell.repId === id);
    const v = ds.map(d => d.visits);
    const outletsOfRep = new Set<string>(); ds.forEach(d => d.cell.outletIds.forEach(o => outletsOfRep.add(o)));
    const km = ds.reduce((s, d) => s + d.km, 0);
    const own = routes.filter(r => r.cell.repId === id);
    return {
      repId: id, name: repName.get(id) ?? id, outlets: outletsOfRep.size, monthlyVisits: v.reduce((a, b) => a + b, 0),
      visitsPerDay: { min: Math.min(...v), avg: r1(avg(v)), max: Math.max(...v) },
      kmPerMonth: Math.round(km), kmPerDay: r1(km / Math.max(1, ds.length)),
      hoursPerDay: r1(avg(ds.map(d => d.total)) / 60), maxHoursPerDay: r1(Math.max(...ds.map(d => d.total)) / 60),
      longHops: own.reduce((s, r) => s + (inp.maxHopKm > 0 ? r.legs.filter(l => l > inp.maxHopKm).length : 0), 0),
      overlapPct: pct(repOverlap.get(id) ?? 0),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  // Balance in the unit the plan was balanced in: hours of work when days
  // were balanced by working time, visits otherwise.
  const repMinutes = new Map<string, number>();
  for (const d of days) repMinutes.set(d.cell.repId, (repMinutes.get(d.cell.repId) ?? 0) + d.total);
  const loads = byTime ? perRep.map(r => repMinutes.get(r.repId) ?? 0) : perRep.map(r => r.monthlyVisits);
  const meanLoad = avg(loads);
  const balance = loads.length > 1 && meanLoad > 0 ? (Math.max(...loads) - Math.min(...loads)) / meanLoad : 0;

  const kpis: Scorecard["kpis"] = {
    reps: repIds.length, dayRoutes: days.length, distinctRoutes: routes.length,
    outlets: inp.outlets.length, planned: plannedCount, heldForReview: held, unplanned, excluded,
    coveragePct: pct(Math.min(1, plannedCount / coverageBase)),
    visitsPerDay: { min: visits.length ? Math.min(...visits) : 0, avg: r1(avg(visits)), max: visits.length ? Math.max(...visits) : 0 },
    daysInBandPct: pct(days.length ? inBand / days.length : 0),
    kmPerDay: r1(avg(days.map(d => d.km))), kmPerMonth: Math.round(days.reduce((s, d) => s + d.km, 0)),
    drivingHoursPerDay: r1(avg(days.map(d => d.drive)) / 60), callHoursPerDay: r1(avg(days.map(d => d.callMin)) / 60),
    workdayHours: r1(avg(days.map(d => d.total)) / 60), maxWorkdayHours: r1(days.length ? Math.max(...days.map(d => d.total)) / 60 : 0),
    overloadedDays: overloaded, shiftHours: r1(shift / 60),
    routeOverlapPct: pct(overlapTot ? overlapN / overlapTot : 0), territoryOverlapPct: pct(territoryOverlap),
    repBalancePct: pct(balance), longHops, routesWithLongHop: routesWithLong, longestHopKm: r1(longest),
    avoidableLongHops: avoidable, routesWithAvoidableHop: routesWithAvoidable,
    kmBasis: inp.roadKm ? "road" : "straight-line",
    evenDaysPct: pct(days.length ? even / days.length : 0),
    balanceBy: byTime ? "time" : "visits",
  };

  // Points out of 100.
  const coverageShare = plannedCount / coverageBase;
  const step = (x: number, steps: [number, number][]) => { for (const [lim, pts] of steps) if (x <= lim) return pts; return 0; };
  const longShare = routes.length ? routesWithAvoidable / routes.length : 0;
  const overloadShare = days.length ? overloaded / days.length : 0;
  const points =
    20 * Math.min(1, coverageShare) +
    15 * (days.length ? (byTime ? even : inBand) / days.length : 0) +
    step(balance, [[0.05, 15], [0.10, 10], [0.20, 5]]) +
    step(kpis.routeOverlapPct / 100, [[0.01, 15], [0.03, 10], [0.08, 5]]) +
    step(territoryOverlap, [[0.01, 10], [0.03, 7], [0.08, 3]]) +
    step(longShare, [[0.05, 10], [0.15, 6], [0.30, 3]]) +
    step(overloadShare, [[0, 15], [0.05, 10], [0.15, 5]]);
  const score = Math.round(points);
  const grade: Scorecard["grade"] = score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : "D";

  // Plain-language checks.
  const checks: ScoreCheck[] = [];
  checks.push(unplanned === 0
    ? { id: "coverage", status: "pass", title: `All ${fmt(plannedCount)} outlets are on a route.` }
    : { id: "coverage", status: unplanned / coverageBase > 0.02 ? "fail" : "warn", title: `${fmt(unplanned)} outlet${unplanned === 1 ? " has" : "s have"} no route.`, detail: "Re-run the plan, or check those outlets' coordinates." });
  if (held > 0) checks.push({ id: "held", status: "warn", title: `${fmt(held)} outlet${held === 1 ? " is" : "s are"} held for review.`, detail: "They sit far from every other outlet, most likely wrong coordinates. Fix or remove them, then re-run." });
  const outBand = days.length - inBand;
  if (byTime) checks.push({
    id: "band", status: kpis.evenDaysPct >= 85 ? "pass" : "warn",
    title: `Days are balanced by working time: ${kpis.evenDaysPct}% are within 12% of a typical ${r1(medTotal / 60)}-hour day.`,
    detail: `Visits a day run from ${kpis.visitsPerDay.min} to ${kpis.visitsPerDay.max}: fewer where calls are long or outlets far apart.`,
  });
  else checks.push(outBand === 0
    ? { id: "band", status: "pass", title: `Every day has ${inp.band.min}-${inp.band.max} visits.` }
    : { id: "band", status: outBand / Math.max(1, days.length) > 0.15 ? "warn" : "pass", title: `${fmt(outBand)} of ${fmt(days.length)} days fall outside ${inp.band.min}-${inp.band.max} visits.`, detail: `Days run from ${kpis.visitsPerDay.min} to ${kpis.visitsPerDay.max} visits.` });
  checks.push({ id: "balance", status: balance <= 0.05 ? "pass" : balance <= 0.12 ? "warn" : "fail", title: `Reps' workloads are within ${kpis.repBalancePct}% of each other.`,
    detail: loads.length > 1 ? (byTime ? `Hours a month per rep: ${Math.round(Math.min(...loads) / 60)} to ${Math.round(Math.max(...loads) / 60)}.` : `Monthly visits per rep: ${Math.min(...loads)} to ${Math.max(...loads)}.`) : undefined });
  checks.push({ id: "overlap", status: kpis.routeOverlapPct <= 1 ? "pass" : kpis.routeOverlapPct <= 3 ? "warn" : "fail", title: kpis.routeOverlapPct <= 1 ? "A rep's routes do not cross each other's areas." : `${kpis.routeOverlapPct}% of stops sit inside another route of the same rep.` });
  if (kpis.reps > 1) checks.push({ id: "territories", status: kpis.territoryOverlapPct <= 1 ? "pass" : kpis.territoryOverlapPct <= 3 ? "warn" : "fail", title: kpis.territoryOverlapPct <= 1 ? "Reps' territories do not overlap." : `${kpis.territoryOverlapPct}% of outlets sit inside another rep's territory.` });
  if (inp.maxHopKm > 0) checks.push(routesWithLong === 0
    ? { id: "hops", status: "pass", title: `No drive between two calls is over ${inp.maxHopKm} km.` }
    : routesWithAvoidable === 0
      ? { id: "hops", status: "pass", title: `Every drive over ${inp.maxHopKm} km is the only way to the next village.`, detail: `${routesWithLong} of ${routes.length} routes cross such a gap; the longest is ${kpis.longestHopKm} km.` }
      : { id: "hops", status: longShare <= 0.1 ? "warn" : "fail", title: `${routesWithAvoidable} of ${routes.length} routes have a drive over ${inp.maxHopKm} km that a better order or cut would avoid.`, detail: `${routesWithLong} routes cross a gap over ${inp.maxHopKm} km in all; the longest is ${kpis.longestHopKm} km.` });
  checks.push(overloaded === 0
    ? { id: "workday", status: "pass", title: `Every day fits a ${kpis.shiftHours}-hour shift.`, detail: `An average day is ${kpis.callHoursPerDay} h of calls and ${kpis.drivingHoursPerDay} h of driving.` }
    : { id: "workday", status: overloadShare <= 0.05 ? "warn" : "fail", title: `${overloaded} day${overloaded === 1 ? " runs" : "s run"} over the ${kpis.shiftHours}-hour shift.`, detail: `The longest is ${kpis.maxWorkdayHours} h. Shorter calls, fewer visits a day, or one more rep would fix it.` });

  const summary = `${kpis.reps} rep${kpis.reps === 1 ? "" : "s"}, ${fmt(plannedCount)} outlets, ${kpis.visitsPerDay.avg} visits and ${kpis.kmPerDay} km a day.`;
  const toReview = checks.filter(c => c.status !== "pass").length;
  const headline = grade === "A"
    ? `Ready to roll out: ${summary}`
    : `${summary} ${toReview} point${toReview === 1 ? "" : "s"} to review.`;
  return { grade, score, headline, kpis, checks, perRep };
}

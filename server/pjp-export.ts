/**
 * The Permanent Journey Plan workbook: what a field-sales team rolls out.
 * Summary (grade, KPIs, checks, reps), the full journey plan stop by stop
 * with dates and map links, one sheet per rep, each rep-day's load, and the
 * outlet master with every outlet's rep and days. Pure: the route handler
 * passes storage, the scorecard and a date for each calendar cell.
 */
import * as XLSX from "xlsx";
import { haversineKm } from "./road-distance";
import { callMinutesFor, dayMinutes, DEFAULT_WORKDAY } from "./rtm";
import type { Scorecard } from "./scorecard";

export interface PjpOutlet {
  id: string; name: string; code?: string | null; channel?: string | null; latitude: number; longitude: number;
  visitFrequency: number; timePerVisit?: number | null; territory?: string | null; geoStatus?: string | null; repId?: string | null;
}
export interface PjpCell { repId: string; week: number; dayOfWeek: number; outletIds: string[]; routeOrder?: string[] | null; totalDistance?: number | null }
export interface PjpInputs {
  outlets: PjpOutlet[];
  reps: { id: string; name: string; code?: string | null }[];
  schedules: PjpCell[];
  scorecard: Scorecard | null;
  /** The calendar date (YYYY-MM-DD) of a cell, or '' when it falls before the plan starts. */
  dateOf: (week: number, dayOfWeek: number) => string;
  /** Working weekdays in order, ISO numbers. */
  workingWeek: number[];
  roadKm?: boolean;
  title?: string;
}

const DAY = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const r1 = (x: number) => Math.round(x * 10) / 10;
const mapLink = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;

/** Excel sheet names: 31 characters, no []:*?/\, unique. */
function sheetName(raw: string, used: Set<string>): string {
  let base = raw.replace(/[\[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let name = base, n = 2;
  while (used.has(name.toLowerCase())) { const suffix = ` (${n++})`; name = base.slice(0, 31 - suffix.length) + suffix; }
  used.add(name.toLowerCase());
  return name;
}

function sheet(rows: (string | number | null)[][], widths: number[], links?: { col: number; fromRow: number }): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = widths.map(w => ({ wch: w }));
  if (links) {
    for (let r = links.fromRow; r < rows.length; r++) {
      const ref = XLSX.utils.encode_cell({ r, c: links.col });
      const cell = ws[ref];
      // A HYPERLINK formula, not a cell link: thirteen thousand cell links
      // made a 2,700-outlet plan a 10 MB file; formulas cost a few bytes each.
      if (cell && typeof cell.v === "string" && cell.v.startsWith("http")) { cell.f = `HYPERLINK("${cell.v}","Map")`; cell.v = "Map"; cell.t = "s"; }
    }
  }
  return ws;
}

export function buildPjpWorkbook(inp: PjpInputs): Buffer {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  const byId = new Map(inp.outlets.map(o => [o.id, o]));
  const repById = new Map(inp.reps.map(r => [r.id, r]));
  const weekIndex = (d: number) => Math.max(0, inp.workingWeek.indexOf(d));
  const cells = inp.schedules
    .filter(c => (c.outletIds?.length ?? 0) > 0)
    .map(c => ({ ...c, date: inp.dateOf(c.week, c.dayOfWeek) }))
    .sort((a, b) => (repById.get(a.repId)?.name ?? "").localeCompare(repById.get(b.repId)?.name ?? "", undefined, { numeric: true })
      || (a.date || "9").localeCompare(b.date || "9") || a.week - b.week || weekIndex(a.dayOfWeek) - weekIndex(b.dayOfWeek));

  // ---- stops
  const stopHeader = ["Rep", "Date", "Weekday", "Week", "Stop", "Outlet code", "Outlet name", "Channel", "Visits a month", "Call min", "Km from previous", "Latitude", "Longitude", "Map"];
  const stopRows: (string | number | null)[][] = [];
  const repDayRows: (string | number | null)[][] = [];
  const stopsByRep = new Map<string, (string | number | null)[][]>();
  for (const c of cells) {
    const rep = repById.get(c.repId);
    const order = (c.routeOrder && c.routeOrder.length ? c.routeOrder : c.outletIds).map(id => byId.get(id)).filter(Boolean) as PjpOutlet[];
    let prev: PjpOutlet | null = null, km = 0, callMin = 0;
    order.forEach((o, i) => {
      const leg = prev ? haversineKm(prev.latitude, prev.longitude, o.latitude, o.longitude) : 0;
      km += leg;
      const call = callMinutesFor(o, 15, true);
      callMin += call;
      const row = [rep?.name ?? c.repId, c.date || "", DAY[c.dayOfWeek] ?? "", c.week, i + 1, o.code ?? "", o.name, o.channel ?? "", o.visitFrequency, call, prev ? r1(leg) : null, o.latitude, o.longitude, mapLink(o.latitude, o.longitude)];
      stopRows.push(row);
      const list = stopsByRep.get(c.repId) ?? []; list.push(row); stopsByRep.set(c.repId, list);
      prev = o;
    });
    const driveKm = inp.roadKm && c.totalDistance != null ? c.totalDistance : km;
    const t = dayMinutes(callMin, km, DEFAULT_WORKDAY, inp.roadKm && c.totalDistance != null ? c.totalDistance : undefined);
    repDayRows.push([rep?.name ?? c.repId, c.date || "", DAY[c.dayOfWeek] ?? "", c.week, order.length, r1(driveKm), r1(callMin / 60), r1(t.drive / 60), r1(t.total / 60)]);
  }

  // ---- summary
  const sc = inp.scorecard;
  const summary: (string | number | null)[][] = [
    [inp.title ?? "Permanent Journey Plan"],
    ["Generated", new Date().toISOString().slice(0, 16).replace("T", " ")],
    [],
  ];
  if (sc) {
    summary.push(["Grade", `${sc.grade} (${sc.score}/100)`], ["Summary", sc.headline], []);
    const k = sc.kpis;
    summary.push(["Key figures"],
      ["Reps", k.reps], ["Day routes", k.dayRoutes], ["Outlets planned", `${k.planned} (${k.coveragePct}%)`], ["Held for review", k.heldForReview],
      ["Visits a day", `${k.visitsPerDay.avg} (from ${k.visitsPerDay.min} to ${k.visitsPerDay.max})`], ["Km a day", `${k.kmPerDay} (${k.kmBasis})`],
      ["Km a month, all reps", k.kmPerMonth], ["Average workday", `${k.workdayHours} h (longest ${k.maxWorkdayHours} h of a ${k.shiftHours}-hour shift)`],
      ["Route overlap", `${k.routeOverlapPct}%`], ["Territory overlap", `${k.territoryOverlapPct}%`], ["Rep balance", `within ${k.repBalancePct}%`],
      ["Balanced by", k.balanceBy === "time" ? "working time" : "visit count"], []);
    summary.push(["Checks before roll-out"]);
    for (const c of sc.checks) summary.push([c.status === "pass" ? "OK" : c.status === "warn" ? "Review" : "Fix", c.title + (c.detail ? ` ${c.detail}` : "")]);
    summary.push([], ["Rep", "Outlets", "Visits a month", "Visits a day", "Km a day", "Hours a day", "Longest day (h)", "Long drives"]);
    for (const r of sc.perRep) summary.push([r.name, r.outlets, r.monthlyVisits, r.visitsPerDay.avg, r.kmPerDay, r.hoursPerDay, r.maxHoursPerDay, r.longHops]);
  }
  XLSX.utils.book_append_sheet(wb, sheet(summary, [24, 60, 14, 12, 10, 12, 14, 12]), sheetName("Summary", used));
  XLSX.utils.book_append_sheet(wb, sheet([stopHeader, ...stopRows], [14, 11, 11, 6, 6, 12, 32, 16, 8, 8, 10, 11, 11, 6], { col: 13, fromRow: 1 }), sheetName("Journey Plan", used));
  XLSX.utils.book_append_sheet(wb, sheet([["Rep", "Date", "Weekday", "Week", "Visits", "Km", "Call hours", "Driving hours", "Workday hours"], ...repDayRows], [14, 11, 11, 6, 7, 7, 10, 12, 13]), sheetName("Rep Days", used));

  // ---- one sheet per rep (up to 60; beyond that the Journey Plan sheet filters by rep)
  const repsInOrder = inp.reps.filter(r => stopsByRep.has(r.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (repsInOrder.length <= 60) {
    for (const r of repsInOrder) {
      XLSX.utils.book_append_sheet(wb, sheet([stopHeader, ...(stopsByRep.get(r.id) ?? [])], [14, 11, 11, 6, 6, 12, 32, 16, 8, 8, 10, 11, 11, 6], { col: 13, fromRow: 1 }), sheetName(r.name, used));
    }
  }

  // ---- outlet master
  const daysOf = new Map<string, { rep: string; slots: Set<string> }>();
  for (const c of cells) for (const id of c.outletIds) {
    const e = daysOf.get(id) ?? { rep: repById.get(c.repId)?.name ?? c.repId, slots: new Set<string>() };
    e.slots.add(`${DAY[c.dayOfWeek]?.slice(0, 3) ?? c.dayOfWeek} W${c.week}`);
    daysOf.set(id, e);
  }
  const master: (string | number | null)[][] = [["Outlet code", "Outlet name", "Channel", "Visits a month", "Latitude", "Longitude", "Rep", "Visit days", "Status", "Map"]];
  for (const o of inp.outlets) {
    const e = daysOf.get(o.id);
    const status = o.territory === "Excluded" ? "Excluded" : (o.geoStatus === "offset" || o.territory === "Needs Review") ? "Held for review" : e ? "Planned" : "Not planned";
    master.push([o.code ?? "", o.name, o.channel ?? "", o.visitFrequency, o.latitude, o.longitude, e?.rep ?? "", e ? Array.from(e.slots).join(", ") : "", status, mapLink(o.latitude, o.longitude)]);
  }
  XLSX.utils.book_append_sheet(wb, sheet(master, [12, 32, 16, 8, 11, 11, 14, 40, 14, 6], { col: 9, fromRow: 1 }), sheetName("Outlet Master", used));

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}

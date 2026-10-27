/**
 * Route-to-market planning rules, as pure functions: how many reps a
 * universe needs, how long a call takes in each channel, which working week
 * a market keeps, and what a day of work looks like in minutes. The
 * blueprint (what to plan) and the scorecard (how good the plan is) are both
 * built from these, so the numbers a planner sees before and after a run
 * agree with each other.
 */
import { haversineKm } from "./road-distance";

// ---------------------------------------------------------------- headcount

export interface HeadcountOption {
  reps: number;
  visitsPerDay: number;
  /** Inside the user's min-max band. */
  fits: boolean;
}
export interface HeadcountChoice extends HeadcountOption {
  options: HeadcountOption[];
  /** Why this count, in a sentence. */
  reason: string;
}

/**
 * The number of reps for a month of visits. When a whole number of reps fits
 * the visits band, aim for its middle. When none does - 728 visits on 24
 * days is 30.3 a day for one rep and 15.2 for two, against 25-30 - take the
 * count whose day is nearest the band. Overloading counts half again as much
 * as underloading, because a rep cannot make calls the day has no time for;
 * the old rule always rounded up and doubled the team for a 1% overload.
 */
export function chooseHeadcount(totalMonthlyVisits: number, daySlotsPerRep: number, minPerDay: number, maxPerDay: number): HeadcountChoice {
  const D = Math.max(1, daySlotsPerRep);
  const lo = Math.max(1, Math.min(minPerDay, maxPerDay));
  const hi = Math.max(lo, maxPerDay);
  const perDay = (k: number) => totalMonthlyVisits / (Math.max(1, k) * D);
  const fitsBand = (k: number) => perDay(k) >= lo - 1e-9 && perDay(k) <= hi + 1e-9;
  const option = (k: number): HeadcountOption => ({ reps: k, visitsPerDay: Math.round(perDay(k) * 10) / 10, fits: fitsBand(k) });
  if (totalMonthlyVisits <= 0) return { ...option(1), options: [option(1)], reason: "No visits to plan." };

  const fewest = Math.max(1, Math.ceil(totalMonthlyVisits / (D * hi)));
  const most = Math.max(1, Math.floor(totalMonthlyVisits / (D * lo)));
  let chosen: number;
  let reason: string;
  if (fewest <= most) {
    const mid = (lo + hi) / 2;
    chosen = Math.min(Math.max(Math.round(totalMonthlyVisits / (D * mid)), fewest), most);
    reason = fewest === most
      ? `${chosen} rep${chosen === 1 ? "" : "s"} is the only team size that keeps every day inside ${lo}-${hi} visits.`
      : `${chosen} reps puts an average day nearest the middle of ${lo}-${hi} visits (${fewest} to ${most} reps would all fit).`;
  } else {
    const cost = (k: number) => {
      const p = perDay(k);
      return p > hi ? 1.5 * (p - hi) / hi : p < lo ? (lo - p) / lo : 0;
    };
    const candidates = [most, fewest].filter((k, i, a) => k >= 1 && a.indexOf(k) === i);
    chosen = candidates.reduce((b, k) => (cost(k) < cost(b) - 1e-12 ? k : b), candidates[0]);
    const p = perDay(chosen);
    const other = candidates.find(k => k !== chosen);
    reason = `No team size fits ${lo}-${hi} visits a day exactly. ${chosen} rep${chosen === 1 ? "" : "s"} gives ${p.toFixed(1)} a day, the nearest to your band` +
      (other ? `; ${other} would give ${perDay(other).toFixed(1)}.` : ".");
  }
  const options: HeadcountOption[] = [];
  for (let k = Math.max(1, Math.min(chosen, fewest) - 1); k <= Math.max(chosen, most) + 1 && options.length < 6; k++) options.push(option(k));
  return { ...option(chosen), options, reason };
}

// ----------------------------------------------------------------- channels

export type ChannelKey =
  | "hypermarket" | "supermarket" | "minimarket" | "grocery" | "kiosk" | "wholesale"
  | "pharmacy" | "petrol" | "horeca" | "specialist" | "other";

/** Typical sell-in call length in minutes: order, stock check, shelf, payment. */
export const CHANNEL_CALL_MINUTES: Record<ChannelKey, number> = {
  hypermarket: 45, supermarket: 30, minimarket: 20, grocery: 12, kiosk: 8, wholesale: 25,
  pharmacy: 15, petrol: 12, horeca: 15, specialist: 15, other: 15,
};
export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  hypermarket: "Hypermarket", supermarket: "Supermarket", minimarket: "Minimarket", grocery: "Grocery / traditional",
  kiosk: "Kiosk", wholesale: "Wholesale", pharmacy: "Pharmacy", petrol: "Petrol station", horeca: "HoReCa",
  specialist: "Specialist", other: "Other",
};
// Order matters: the first rule that matches wins, so "mini market" is a
// minimarket before it is a market, and "super market" a supermarket.
const CHANNEL_RULES: [ChannelKey, RegExp][] = [
  ["hypermarket", /hyper|هايبر|هيبر/i],
  ["minimarket", /mini\s*-?\s*market|minimarket|ميني\s*ماركت|ميني/i],
  ["supermarket", /super\s*-?\s*market|supermarket|\bsm\b|سوبر\s*ماركت|سوبرماركت|سوبر/i],
  ["wholesale", /whole\s*sale|wholesaler|cash\s*&?\s*carry|distributor|جملة|جمله|موزع/i],
  ["pharmacy", /pharma|drug\s*store|صيدلي/i],
  ["petrol", /petrol|gas\s*station|fuel|محطة|محطه|وقود/i],
  ["horeca", /horeca|hotel|restaurant|cafe|café|coffee|bakery|مطعم|مقهى|كافيه|فندق|مخبز|افران|فرن/i],
  ["kiosk", /kiosk|newel|stall|كشك|بسطة/i],
  ["specialist", /special|butcher|roaster|nuts|مكسرات|محمص|ملحمة/i],
  ["grocery", /grocery|retail|traditional|corner|market|mart|بقال|بقالة|مفرد|ماركت|مواد غذائية|دكان/i],
];

export function classifyChannel(raw: string | null | undefined): ChannelKey | null {
  if (!raw || !String(raw).trim()) return null;
  const s = String(raw);
  for (const [key, re] of CHANNEL_RULES) if (re.test(s)) return key;
  return "other";
}

/** The call length for an outlet: its own, else its channel's, else the fallback. */
export function callMinutesFor(o: { timePerVisit?: number | null; channel?: string | null }, fallback = 15, ownTimeIsReal = true): number {
  if (ownTimeIsReal && o.timePerVisit && o.timePerVisit > 0) return o.timePerVisit;
  const ch = classifyChannel(o.channel);
  return ch ? CHANNEL_CALL_MINUTES[ch] : fallback;
}

// ------------------------------------------------------------ working week

/** ISO weekdays, Monday = 1 ... Sunday = 7. */
export interface WorkingWeekGuess { days: number[]; label: string; country: string | null }
const SAT_THU = [6, 7, 1, 2, 3, 4];
const SUN_THU_SAT = SAT_THU;
const MON_SAT = [1, 2, 3, 4, 5, 6];
// Rough boxes, smallest first so Lebanon wins over the Syria box around it.
const COUNTRY_BOXES: { country: string; lat: [number, number]; lng: [number, number]; days: number[] }[] = [
  { country: "Lebanon", lat: [33.05, 34.7], lng: [35.1, 36.65], days: MON_SAT },
  { country: "Kuwait", lat: [28.5, 30.1], lng: [46.5, 48.5], days: SUN_THU_SAT },
  { country: "Qatar", lat: [24.4, 26.2], lng: [50.7, 51.7], days: SUN_THU_SAT },
  { country: "Bahrain", lat: [25.7, 26.4], lng: [50.3, 50.9], days: SUN_THU_SAT },
  { country: "UAE", lat: [22.6, 26.1], lng: [51.5, 56.4], days: MON_SAT },
  { country: "Jordan", lat: [29.2, 33.4], lng: [34.9, 39.3], days: SAT_THU },
  { country: "Syria", lat: [32.3, 37.35], lng: [35.6, 42.4], days: SAT_THU },
  { country: "Iraq", lat: [29.0, 37.4], lng: [38.8, 48.6], days: SAT_THU },
  { country: "Egypt", lat: [22.0, 31.7], lng: [24.7, 36.9], days: SAT_THU },
  { country: "Saudi Arabia", lat: [16.3, 32.2], lng: [34.5, 55.7], days: SUN_THU_SAT },
  { country: "Oman", lat: [16.6, 26.4], lng: [52.0, 59.9], days: SUN_THU_SAT },
  { country: "Turkey", lat: [35.8, 42.2], lng: [25.6, 44.9], days: MON_SAT },
];
const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export function weekLabel(days: number[]): string {
  if (days.length === 0) return "";
  return days.length > 2 ? `${WEEKDAY_SHORT[days[0]]}-${WEEKDAY_SHORT[days[days.length - 1]]}` : days.map(d => WEEKDAY_SHORT[d]).join(", ");
}
// Lebanon is too narrow for a box: one wide enough for Hermel takes in
// Damascus. A coarse outline of its border instead, as [lng, lat].
const LEBANON: [number, number][] = [
  [35.10, 33.09], [35.62, 33.07], [35.82, 33.28], [36.03, 33.55], [36.07, 33.80], [36.40, 34.05],
  [36.62, 34.20], [36.45, 34.45], [36.35, 34.65], [35.97, 34.65], [35.80, 34.45], [35.65, 34.25],
  [35.48, 33.90], [35.38, 33.55], [35.20, 33.27],
];
function inPolygon(poly: [number, number][], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i][1] > y) !== (poly[j][1] > y) && x < (poly[j][0] - poly[i][0]) * (y - poly[i][1]) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
  }
  return c;
}
export function guessWorkingWeek(lat: number, lng: number): WorkingWeekGuess {
  const hit = COUNTRY_BOXES.find(b => b.country === "Lebanon"
    ? inPolygon(LEBANON, lng, lat)
    : lat >= b.lat[0] && lat <= b.lat[1] && lng >= b.lng[0] && lng <= b.lng[1]);
  const days = hit ? hit.days : MON_SAT;
  return { days, label: weekLabel(days), country: hit ? hit.country : null };
}

// ------------------------------------------------------- workload in minutes

export interface WorkdayModel {
  /** Paid day in minutes, start to finish. */
  shiftMinutes: number;
  /** Lunch and prayer breaks inside the shift. */
  breakMinutes: number;
  /** Driving to the first call and home from the last. */
  commuteMinutes: number;
  /** Average driving speed between calls, km/h, for straight-line distances. */
  speedKmh: number;
  /** Straight-line to road distance. */
  detourFactor: number;
}
export const DEFAULT_WORKDAY: WorkdayModel = { shiftMinutes: 480, breakMinutes: 30, commuteMinutes: 40, speedKmh: 25, detourFactor: 1.3 };

/** Minutes a day of `calls` calls takes, given its call minutes and straight-line km between calls. */
export function dayMinutes(callMinutesTotal: number, straightKm: number, wd: WorkdayModel = DEFAULT_WORKDAY, roadKm?: number): { drive: number; total: number } {
  const km = roadKm ?? straightKm * wd.detourFactor;
  const drive = (km / Math.max(1, wd.speedKmh)) * 60;
  return { drive, total: callMinutesTotal + drive + wd.commuteMinutes + wd.breakMinutes };
}

// ------------------------------------------------------------ local density

/** For each point, the distance to its k-th nearest neighbour (km), via a grid. */
export function kthNeighbourKm(points: { latitude: number; longitude: number }[], k = 3): number[] {
  const n = points.length;
  if (n <= k) return points.map(() => 0);
  const cell = 0.01; // ~1 km
  const grid = new Map<string, number[]>();
  const key = (la: number, lo: number) => `${Math.floor(la / cell)}:${Math.floor(lo / cell)}`;
  points.forEach((p, i) => { const kk = key(p.latitude, p.longitude); const g = grid.get(kk); if (g) g.push(i); else grid.set(kk, [i]); });
  const out: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const cy = Math.floor(p.latitude / cell), cx = Math.floor(p.longitude / cell);
    let ring = 1;
    let found: number[] = [];
    // Grow the search square until it holds k neighbours, then one more ring
    // so a nearer point just outside the square is not missed.
    for (;;) {
      found = [];
      for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
        const g = grid.get(`${cy + dy}:${cx + dx}`);
        if (g) for (const j of g) if (j !== i) found.push(j);
      }
      if (found.length >= k || ring > 400) break;
      ring = ring < 8 ? ring + 1 : ring * 2;
    }
    if (found.length < k) { out[i] = 0; continue; }
    const ds = found.map(j => haversineKm(p.latitude, p.longitude, points[j].latitude, points[j].longitude)).sort((a, b) => a - b);
    const kth = ds[k - 1];
    // Anything within kth could sit one ring further out than searched; widen once.
    const reach = Math.ceil(kth / (cell * 111)) + 1;
    if (reach > ring) {
      const more: number[] = [];
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const g = grid.get(`${cy + dy}:${cx + dx}`);
        if (g) for (const j of g) if (j !== i) more.push(haversineKm(p.latitude, p.longitude, points[j].latitude, points[j].longitude));
      }
      more.sort((a, b) => a - b);
      out[i] = more[k - 1] ?? kth;
    } else out[i] = kth;
  }
  return out;
}

export const median = (arr: number[]) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
export const quantile = (arr: number[], q: number) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

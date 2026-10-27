/**
 * The RTM blueprint: what the uploaded universe needs, worked out before
 * anything is planned. It reads the outlets the way an RTM consultant would
 * on day one - where the market is, how dense it is, which channels and
 * frequencies it holds, what a call costs in minutes - and proposes the
 * working week, the visits band, the hop limit and the team size, with the
 * reasons, plus the data problems to fix first. Pure: the route handler
 * feeds it storage and saved settings, and sends `body` to the optimizer.
 */
import {
  chooseHeadcount, classifyChannel, callMinutesFor, guessWorkingWeek, weekLabel, kthNeighbourKm, median, quantile,
  CHANNEL_LABELS, CHANNEL_CALL_MINUTES, DEFAULT_WORKDAY, type HeadcountChoice, type WorkdayModel, type ChannelKey,
} from "./rtm";
import { haversineKm } from "./road-distance";
import type { ScoreCheck } from "./scorecard";

export interface BlueprintOutlet {
  id: string; name: string; latitude: number; longitude: number; visitFrequency: number;
  timePerVisit?: number | null; channel?: string | null; territory?: string | null; geoStatus?: string | null; code?: string | null;
}
export interface SavedPlanSettings {
  workingDays?: number[]; minVisitsPerDay?: number; maxVisitsPerDay?: number; maxHopKm?: number;
  cycleMode?: "fixed" | "calendarMonth"; cycleWorkingDays?: number; planMonth?: string; monthEdges?: "wholeWeeks" | "allDays";
  country?: string | null; distanceMode?: string;
}
export interface UploadMeta {
  fileName?: string; sheetUsed?: string | null; otherSheets?: string[]; rowsUsingDefaultVf?: number; defaultVisitFrequency?: number;
  callTimeSources?: { file: number; channel: number; assumed: number }; skippedRows?: number; uploadedAt?: string;
}
export interface BlueprintInputs {
  outlets: BlueprintOutlet[];
  saved?: SavedPlanSettings | null;
  upload?: UploadMeta | null;
  workday?: WorkdayModel;
  roadServer?: boolean;
  /** The planner's own choices on the blueprint screen; they win over everything else. */
  choice?: { workingDays?: number[]; minVisitsPerDay?: number; maxVisitsPerDay?: number; balanceBy?: "visits" | "time"; maxHopKm?: number } | null;
}
export interface Blueprint {
  market: {
    outlets: number; active: number; heldForReview: number; excluded: number;
    country: string | null; centre: { lat: number; lng: number };
    radiusKm: number; neighbourKm: number; character: "dense city" | "city" | "city and towns" | "towns and villages";
  };
  frequency: { vf1: number; vf2: number; vf3: number; vf4: number; monthlyVisits: number; assumedRows: number; assumedVf: number };
  channels: { key: ChannelKey; label: string; count: number; callMinutes: number }[];
  call: { avgMinutes: number; source: "file" | "channel" | "assumed" | "mixed" };
  workload: { callMinutes: number; travelMinutesPerCall: number; sustainableCallsPerDay: number; dayHoursAtBand: number; shiftHours: number };
  setup: {
    workingDays: number[]; weekLabel: string; weekSource: "your last plan" | "usual for the country" | "default" | "your choice";
    cycleMode: "fixed" | "calendarMonth"; cycleWorkingDays: number; planMonth?: string; monthEdges?: "wholeWeeks" | "allDays";
    minVisitsPerDay: number; maxVisitsPerDay: number; bandSource: "your last plan" | "workload" | "your choice";
    maxHopKm: number; distanceMode: "road" | "haversine";
    balanceBy: "visits" | "time"; balanceReason: string;
  };
  headcount: HeadcountChoice;
  checks: ScoreCheck[];
  /** The optimize request this blueprint stands for. */
  body: Record<string, unknown>;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function buildBlueprint(inp: BlueprintInputs): Blueprint {
  const wd = inp.workday ?? DEFAULT_WORKDAY;
  const all = inp.outlets;
  const excluded = all.filter(o => o.territory === "Excluded").length;
  const held = all.filter(o => o.territory !== "Excluded" && (o.geoStatus === "offset" || o.territory === "Needs Review"));
  const active = all.filter(o => o.territory !== "Excluded" && !(o.geoStatus === "offset" || o.territory === "Needs Review"));
  const pts = active.length > 0 ? active : all;

  // Where and how dense.
  const centre = { lat: median(pts.map(o => o.latitude)), lng: median(pts.map(o => o.longitude)) };
  const radiusKm = quantile(pts.map(o => haversineKm(centre.lat, centre.lng, o.latitude, o.longitude)), 0.9);
  const nn = kthNeighbourKm(pts, 2);
  const neighbourKm = median(nn);
  const character: Blueprint["market"]["character"] =
    neighbourKm < 0.12 ? "dense city" : neighbourKm < 0.3 ? "city" : neighbourKm < 0.8 ? "city and towns" : "towns and villages";
  const guess = guessWorkingWeek(centre.lat, centre.lng);

  // Frequencies.
  const vf = (k: number) => pts.filter(o => o.visitFrequency === k).length;
  const monthlyVisits = pts.reduce((s, o) => s + (o.visitFrequency || 1), 0);

  // Channels and call time.
  const chCount = new Map<ChannelKey, number>();
  for (const o of pts) { const k = classifyChannel(o.channel); if (k) chCount.set(k, (chCount.get(k) ?? 0) + 1); }
  const sources = inp.upload?.callTimeSources;
  const callSource: Blueprint["call"]["source"] = !sources ? "assumed"
    : sources.file > 0 && sources.channel + sources.assumed === 0 ? "file"
    : sources.channel > 0 && sources.file + sources.assumed === 0 ? "channel"
    : sources.assumed > 0 && sources.file + sources.channel === 0 ? "assumed" : "mixed";
  // Visit-weighted: a weekly supermarket costs four calls a month, a monthly kiosk one.
  const callMin = monthlyVisits > 0
    ? pts.reduce((s, o) => s + (o.visitFrequency || 1) * callMinutesFor(o, 15, true), 0) / monthlyVisits
    : 15;

  // Travel between calls: about the distance to the second-nearest outlet,
  // capped at a long hop, by road, at town speed.
  const hopCap = 6;
  const travelKm = nn.length ? nn.reduce((s, d) => s + Math.min(d, hopCap), 0) / nn.length : 0.5;
  const travelMin = (travelKm * wd.detourFactor / wd.speedKmh) * 60;
  const productive = wd.shiftMinutes - wd.breakMinutes - wd.commuteMinutes;
  const sustainable = Math.max(4, Math.floor(productive / Math.max(1, callMin + travelMin)));

  // Setup: what the user chose last time wins, unless that plan was for another country.
  const saved = inp.saved ?? null;
  const sameMarket = !saved?.country || !guess.country || saved.country === guess.country;
  const choice = inp.choice ?? null;
  const chosenWeek = choice?.workingDays?.length ? choice.workingDays : null;
  const workingDays = chosenWeek ?? (saved?.workingDays?.length && sameMarket ? saved.workingDays : guess.days);
  const weekSource: Blueprint["setup"]["weekSource"] = chosenWeek ? "your choice" : saved?.workingDays?.length && sameMarket ? "your last plan" : guess.country ? "usual for the country" : "default";
  const chosenBand = choice?.minVisitsPerDay && choice?.maxVisitsPerDay ? [Math.min(choice.minVisitsPerDay, choice.maxVisitsPerDay), Math.max(choice.minVisitsPerDay, choice.maxVisitsPerDay)] : null;
  const savedBand = saved?.minVisitsPerDay && saved?.maxVisitsPerDay && sameMarket ? [saved.minVisitsPerDay, saved.maxVisitsPerDay] : null;
  const band = chosenBand ?? savedBand ?? [Math.max(6, Math.round(sustainable * 0.85)), Math.max(8, Math.min(45, sustainable))];
  const bandSource: Blueprint["setup"]["bandSource"] = chosenBand ? "your choice" : savedBand ? "your last plan" : "workload";
  const cycleMode = saved?.cycleMode && sameMarket && !chosenWeek ? saved.cycleMode : "fixed";
  const cycleWorkingDays = cycleMode === "fixed"
    ? (saved?.cycleWorkingDays && sameMarket && (!chosenWeek || chosenWeek.length === saved.workingDays?.length) ? saved.cycleWorkingDays : workingDays.length * 4)
    : (saved?.cycleWorkingDays ?? workingDays.length * 4);
  const p75 = quantile(kthNeighbourKm(pts, 3), 0.75);
  const maxHopKm = choice?.maxHopKm && choice.maxHopKm > 0 ? choice.maxHopKm : saved?.maxHopKm && sameMarket ? saved.maxHopKm : p75 > 1.5 ? 8 : 4;
  const distanceMode: "road" | "haversine" = inp.roadServer ? "road" : "haversine";

  // Balance by working time when the work per visit differs enough to
  // matter: a 30-minute supermarket next to an 8-minute kiosk, or villages
  // whose next call is several kilometres away. Spread measured as the
  // visit-weighted coefficient of variation of call + travel minutes.
  const perVisit = pts.map((o, i) => callMinutesFor(o, 15, true) + (Math.min(nn[i] ?? 0, hopCap) * wd.detourFactor / wd.speedKmh) * 60);
  const wSum = pts.reduce((s, o) => s + (o.visitFrequency || 1), 0) || 1;
  const wMean = pts.reduce((s, o, i) => s + (o.visitFrequency || 1) * perVisit[i], 0) / wSum;
  const wVar = pts.reduce((s, o, i) => s + (o.visitFrequency || 1) * (perVisit[i] - wMean) ** 2, 0) / wSum;
  const spread = wMean > 0 ? Math.sqrt(wVar) / wMean : 0;
  const balanceBy: "visits" | "time" = choice?.balanceBy ?? (spread > 0.2 ? "time" : "visits");
  const balanceReason = choice?.balanceBy
    ? (balanceBy === "time" ? "Your choice: days balanced by working time." : "Your choice: days balanced by visit count.")
    : balanceBy === "time"
    ? `Work per visit varies a lot here (from ${Math.round(quantile(perVisit, 0.1))} to ${Math.round(quantile(perVisit, 0.9))} minutes), so days are balanced by working time: a day of large stores or far-apart villages gets fewer calls.`
    : `Work per visit is similar across outlets (${Math.round(wMean)} minutes on average), so days are balanced by visit count.`;

  const headcount = chooseHeadcount(monthlyVisits, cycleWorkingDays || workingDays.length * 4, band[0], band[1]);
  // Then against the shift: a team size whose average day would run past
  // 95% of the shift gets one more rep, if one more still fits the band.
  // Visits alone put Lebanon at 8 reps and 7.8-hour days; 9 is 7.0 hours.
  const hoursAt = (k: number) => ((monthlyVisits / (k * (cycleWorkingDays || workingDays.length * 4))) * (callMin + travelMin) + wd.commuteMinutes + wd.breakMinutes) / 60;
  while (hoursAt(headcount.reps) > 0.95 * wd.shiftMinutes / 60) {
    const next = headcount.options.find(o => o.reps === headcount.reps + 1) ?? null;
    const perDayNext = monthlyVisits / ((headcount.reps + 1) * (cycleWorkingDays || workingDays.length * 4));
    if (perDayNext < band[0] * 0.9) break;
    headcount.reason = `${headcount.reps + 1} reps: with ${headcount.reps} the average day would be ${hoursAt(headcount.reps).toFixed(1)} hours of an ${wd.shiftMinutes / 60}-hour shift; ${headcount.reps + 1} gives ${hoursAt(headcount.reps + 1).toFixed(1)} hours and ${perDayNext.toFixed(1)} visits a day.`;
    headcount.reps += 1;
    headcount.visitsPerDay = Math.round(perDayNext * 10) / 10;
    headcount.fits = next ? next.fits : perDayNext >= band[0] && perDayNext <= band[1];
    if (!headcount.options.some(o => o.reps === headcount.reps)) headcount.options.push({ reps: headcount.reps, visitsPerDay: headcount.visitsPerDay, fits: headcount.fits });
  }
  const dayHours = hoursAt(headcount.reps);

  // Readiness: what to fix before rolling out.
  const checks: ScoreCheck[] = [];
  checks.push({ id: "outlets", status: "pass", title: `${fmt(pts.length)} outlets ready to plan${inp.upload?.fileName ? ` from ${inp.upload.fileName}` : ""}.`,
    detail: inp.upload?.sheetUsed && (inp.upload.otherSheets?.length ?? 0) > 0 ? `Read the sheet "${inp.upload.sheetUsed}"; the workbook also has ${inp.upload.otherSheets!.join(", ")}.` : undefined });
  if ((inp.upload?.skippedRows ?? 0) > 0) checks.push({ id: "skipped", status: "warn", title: `${fmt(inp.upload!.skippedRows!)} rows were skipped for missing names or coordinates.` });
  if (held.length > 0) checks.push({ id: "held", status: "warn", title: `${fmt(held.length)} outlet${held.length === 1 ? " is" : "s are"} far from every other outlet and will be held for review.`, detail: "Most likely wrong coordinates. The plan is built without them." });
  const assumed = inp.upload?.rowsUsingDefaultVf ?? 0;
  if (assumed > 0) checks.push({ id: "frequency", status: "warn", title: `${assumed === all.length ? "No" : `${fmt(assumed)} rows had no`} visit frequency; ${assumed === all.length ? "all outlets were" : "they were"} set to every two weeks.`, detail: "Frequency decides the team size. Add a VF column (1, 2 or 4) if that is not right." });
  else checks.push({ id: "frequency", status: "pass", title: `Visit frequency from the file: ${[vf(4) && `${fmt(vf(4))} weekly`, vf(2) && `${fmt(vf(2))} every two weeks`, vf(1) && `${fmt(vf(1))} monthly`, vf(3) && `${fmt(vf(3))} three weeks in four`].filter(Boolean).join(", ")}.` });
  checks.push(callSource === "file"
    ? { id: "calltime", status: "pass", title: `Call times from the file, ${callMin.toFixed(0)} minutes on average.` }
    : callSource === "assumed"
      ? { id: "calltime", status: "warn", title: "No call times or channels in the file: 15 minutes a call is assumed.", detail: "Add a Channel column (Supermarket, Grocery, Kiosk...) or a call-minutes column for a truer workday." }
      : { id: "calltime", status: "pass", title: `Call times set by channel, ${callMin.toFixed(0)} minutes on average.` });
  // Same name on the same spot: a list exported twice.
  const seen = new Map<string, number>();
  for (const o of pts) { const k = `${o.name.trim().toLowerCase()}|${o.latitude.toFixed(5)}|${o.longitude.toFixed(5)}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
  const dups = Array.from(seen.values()).reduce((s, n) => s + (n > 1 ? n - 1 : 0), 0);
  if (dups > 0) checks.push({ id: "duplicates", status: "warn", title: `${fmt(dups)} likely duplicate${dups === 1 ? "" : "s"}: same name on the same spot.`, detail: "Review them on the Territory Map before rolling out." });
  if (!headcount.fits) checks.push({ id: "band", status: "warn", title: `No team size fits ${band[0]}-${band[1]} visits a day exactly.`, detail: headcount.reason });

  const body: Record<string, unknown> = {
    workingDays, workingDaysPerWeek: workingDays.length,
    cycleMode, cycleWorkingDays, ...(cycleMode === "calendarMonth" ? { planMonth: saved?.planMonth, monthEdges: saved?.monthEdges ?? "wholeWeeks" } : {}),
    minVisitsPerDay: band[0], maxVisitsPerDay: band[1], maxHopKm, distanceMode,
    weightMode: "isolation", maxZoneRadiusKm: 30, country: guess.country, balanceBy, reps: headcount.reps,
  };

  return {
    market: { outlets: all.length, active: pts.length, heldForReview: held.length, excluded, country: guess.country, centre, radiusKm: Math.round(radiusKm * 10) / 10, neighbourKm: Math.round(neighbourKm * 1000) / 1000, character },
    frequency: { vf1: vf(1), vf2: vf(2), vf3: vf(3), vf4: vf(4), monthlyVisits, assumedRows: assumed, assumedVf: inp.upload?.defaultVisitFrequency ?? 2 },
    channels: Array.from(chCount.entries()).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, label: CHANNEL_LABELS[key], count, callMinutes: CHANNEL_CALL_MINUTES[key] })),
    call: { avgMinutes: Math.round(callMin * 10) / 10, source: callSource },
    workload: { callMinutes: Math.round(callMin * 10) / 10, travelMinutesPerCall: Math.round(travelMin * 10) / 10, sustainableCallsPerDay: sustainable, dayHoursAtBand: Math.round(dayHours * 10) / 10, shiftHours: wd.shiftMinutes / 60 },
    setup: { workingDays, weekLabel: weekLabel(workingDays), weekSource, cycleMode, cycleWorkingDays, planMonth: saved?.planMonth, monthEdges: saved?.monthEdges, minVisitsPerDay: band[0], maxVisitsPerDay: band[1], bandSource, maxHopKm, distanceMode, balanceBy, balanceReason },
    headcount, checks, body,
  };
}

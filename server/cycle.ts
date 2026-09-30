/**
 * The journey-plan cycle, as pure functions: how many day-groups and repeats a
 * cycle length becomes, where each (repeat, group) cell lands on the calendar,
 * which working dates a calendar month covers, and how visit frequencies are
 * spread across repeats. Nothing here touches storage or request state, so it
 * can be tested on its own.
 */
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export type MonthEdges = 'wholeWeeks' | 'allDays';

/** Reads a working week off a request body, falling back to the first N weekdays. */
export function parseWorkingWeek(body: any): number[] {
  const raw = body?.workingDays;
  if (Array.isArray(raw)) {
    const days = Array.from(new Set(
      raw.map((d: any) => parseInt(String(d), 10)).filter((d: number) => d >= 1 && d <= 7),
    ));
    if (days.length > 0) return days;
  }
  const count = Math.max(1, Math.min(7, parseInt(String(body?.workingDaysPerWeek ?? 5), 10) || 5));
  return Array.from({ length: count }, (_, i) => i + 1);
}

export const isoWeekday = (d: Date) => (d.getDay() === 0 ? 7 : d.getDay());
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const nextMonthKey = (now: Date = new Date()) => {
  const y = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const m = now.getMonth() === 11 ? 1 : now.getMonth() + 2;
  return `${y}-${String(m).padStart(2, '0')}`;
};

/**
 * The working dates of one calendar month.
 *
 * 'wholeWeeks' runs from the first day of the month that starts the working
 * week to the last day that ends it - first Saturday to last Thursday on a
 * Saturday-to-Thursday week - which is how the business describes its month.
 * It leaves the partial weeks at either edge to no plan at all: two days in
 * October 2026, eight in November. 'allDays' covers every working day of the
 * month and starts mid-week when the 1st falls mid-week.
 */
export function monthPlanDates(year: number, month: number, week: number[], edges: MonthEdges): { start: Date; end: Date; dates: Date[] } | null {
  const days = week.length > 0 ? week : [1, 2, 3, 4, 5];
  const inWeek = new Set(days);
  const all: Date[] = [];
  for (let d = new Date(year, month - 1, 1); d.getMonth() === month - 1; d.setDate(d.getDate() + 1)) all.push(new Date(d));
  const working = all.filter(d => inWeek.has(isoWeekday(d)));
  if (working.length === 0) return null;
  let start = working[0];
  let end = working[working.length - 1];
  if (edges === 'wholeWeeks') {
    const s = all.find(d => isoWeekday(d) === days[0]);
    const e = [...all].reverse().find(d => isoWeekday(d) === days[days.length - 1]);
    if (s && e && s.getTime() <= e.getTime()) { start = s; end = e; }
  }
  const dates = working.filter(d => d.getTime() >= start.getTime() && d.getTime() <= end.getTime());
  return dates.length > 0 ? { start, end, dates } : null;
}

/**
 * A cycle is dayGroups distinct day-routes, each driven `repeats` times, and
 * dayGroups x repeats is the PATTERN length. The plan itself may be one day
 * longer: a month of 23 working days is planned as an 11 x 2 pattern plus day
 * 23, which is pattern day 1 again - the next cycle's first day. Nothing is
 * ever dropped.
 *
 * Run count prefers even spacing for fortnightly calls. Four runs gives a
 * weekly/fortnightly/monthly plan (the classic four-week PJP); two runs gives
 * fortnightly calls exactly half a cycle apart. Three or five runs put the two
 * visits of a fortnightly outlet 9 and 18 days apart, so they are used only
 * when nothing else fits - and a 27-day month is planned as 13 x 2 with one
 * bonus day rather than 9 x 3, because 13/13 beats 9/18.
 *
 * 5-day week, no length -> 20 days = 5 groups x 4.
 * 6-day week, no length -> 24 days = 6 groups x 4.
 * 26 working days       -> 13 groups x 2.
 * 23 working days       -> 11 groups x 2, plus one bonus day.
 */
export function cycleShape(workingDaysPerWeek: number, requested = 0): { cycleDays: number; repeats: number; dayGroups: number; planDays: number } {
  const wd = Math.max(1, workingDaysPerWeek || 5);
  const planDays = requested > 0 ? requested : wd * 4;
  const divisor = (n: number, prefs: number[]) => prefs.find(r => n % r === 0);
  let cycleDays = planDays;
  let repeats = divisor(planDays, [4, 2]);
  if (!repeats && planDays > 2 && divisor(planDays - 1, [4, 2])) { cycleDays = planDays - 1; repeats = divisor(cycleDays, [4, 2]); }
  if (!repeats) repeats = divisor(planDays, [3, 5]);
  if (!repeats && planDays > 2 && divisor(planDays - 1, [3, 5])) { cycleDays = planDays - 1; repeats = divisor(cycleDays, [3, 5]); }
  if (!repeats) { cycleDays = Math.max(2, planDays - (planDays % 2)); repeats = 2; }
  return { cycleDays, repeats, dayGroups: Math.max(1, Math.round(cycleDays / repeats)), planDays: Math.max(cycleDays, planDays) };
}

/**
 * Where a (repeat, day-group) cell falls on the calendar. Cycle working day
 * (r-1) * dayGroups + g, laid onto weeks of the working week. With 13 groups
 * x 2 repeats and a 6-day week, group 1 is driven on cycle day 1 (week 1,
 * first working day) and cycle day 14 (week 3, second working day): 13
 * working days apart. A plan that starts mid-week (the 1st on a Thursday)
 * begins part-way through week 1, which is what startSlot expresses.
 */
export function calendarCell(repeat: number, group: number, dayGroups: number, week: number[], startSlot = 0) {
  const days = week.length > 0 ? week : [1, 2, 3, 4, 5];
  const wd = days.length;
  const cycleDay = (repeat - 1) * dayGroups + group; // 1-based
  const pos = startSlot + cycleDay - 1;
  return { cycleDay, week: Math.floor(pos / wd) + 1, dayOfWeek: days[pos % wd] };
}

/**
 * The real calendar dates of the first `count` working days of the plan: from
 * its start date when it has one (a calendar-month plan), else from tomorrow.
 */
export function upcomingWorkingDates(count: number, week: number[], planStartDate = '', now: Date = new Date()): Date[] {
  const days = new Set(week.length > 0 ? week : [1, 2, 3, 4, 5]);
  const dates: Date[] = [];
  const cursor = planStartDate ? new Date(planStartDate + 'T00:00:00') : new Date(now);
  cursor.setHours(0, 0, 0, 0);
  if (!planStartDate) cursor.setDate(cursor.getDate() + 1); // start tomorrow, never today
  for (let guard = 0; guard < count * 7 + 14 && dates.length < count; guard++) {
    if (days.has(isoWeekday(cursor))) dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

/**
 * A day-group is driven `repeats` times per cycle, so one membership can carry
 * at most `repeats` visits. An outlet needing more (weekly calls on a 2-repeat
 * cycle) is given a second day-group; each membership carries its share.
 */
export function membershipsFor(vf: number, repeats: number): number[] {
  const need = Math.max(1, Math.min(vf || 1, repeats * 2));
  const out: number[] = [];
  let left = need;
  while (left > 0) { const take = Math.min(repeats, left); out.push(take); left -= take; }
  return out;
}

/**
 * How many offset buckets a frequency band needs, so its visits spread evenly.
 * When the runs divide by the visits (4 runs, 2 visits) the buckets are the
 * stride: two buckets, seen in runs {1,3} and {2,4}. When they do not (3 runs,
 * 2 visits) every bucket is its own offset: one bucket per run.
 */
export function bucketsForFrequency(vf: number, repeats: number): number {
  const times = Math.min(Math.max(1, vf), repeats);
  return repeats % times === 0 ? repeats / times : repeats;
}

/**
 * Which repeats (1-based) a bucket of this frequency band is visited in: the
 * bucket's own offset, then every repeats/times runs after it, rounded down.
 * Each run then lands in exactly `times` buckets, so the runs stay even.
 */
export function repeatsForBucket(vf: number, repeats: number, bucketIndex: number): number[] {
  const times = Math.min(Math.max(1, vf), repeats);
  const out = new Set<number>();
  for (let j = 0; j < times; j++) out.add(((bucketIndex + Math.floor((j * repeats) / times)) % repeats) + 1);
  return Array.from(out).sort((a, b) => a - b);
}

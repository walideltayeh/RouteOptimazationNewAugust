import { describe, it, expect } from "vitest";
import {
  cycleShape, calendarCell, monthPlanDates, upcomingWorkingDates, parseWorkingWeek,
  membershipsFor, bucketsForFrequency, repeatsForBucket, ymd, isoWeekday, nextMonthKey,
} from "../server/cycle";

const SAT_THU = [6, 7, 1, 2, 3, 4]; // Damascus: Saturday to Thursday, Friday off
const MON_FRI = [1, 2, 3, 4, 5];

describe("cycleShape", () => {
  it("defaults to four weeks of the working week", () => {
    expect(cycleShape(5)).toEqual({ cycleDays: 20, repeats: 4, dayGroups: 5, planDays: 20 });
    expect(cycleShape(6)).toEqual({ cycleDays: 24, repeats: 4, dayGroups: 6, planDays: 24 });
  });
  it("plans 26 days as 13 groups driven twice", () => {
    expect(cycleShape(6, 26)).toEqual({ cycleDays: 26, repeats: 2, dayGroups: 13, planDays: 26 });
  });
  it("plans an odd month as a pattern plus one bonus day, never dropping a day", () => {
    expect(cycleShape(6, 23)).toEqual({ cycleDays: 22, repeats: 2, dayGroups: 11, planDays: 23 });
    expect(cycleShape(6, 27)).toEqual({ cycleDays: 26, repeats: 2, dayGroups: 13, planDays: 27 });
  });
  it("prefers four runs when the length allows it", () => {
    expect(cycleShape(5, 24).repeats).toBe(4);
    expect(cycleShape(5, 28).repeats).toBe(4);
  });
  it("never returns fewer than one group or two repeats", () => {
    const s = cycleShape(1, 1);
    expect(s.dayGroups).toBeGreaterThanOrEqual(1);
    expect(s.repeats).toBeGreaterThanOrEqual(2);
  });
});

describe("calendarCell", () => {
  it("lays a 13 x 2 cycle so the two visits are 13 working days apart", () => {
    const first = calendarCell(1, 1, 13, SAT_THU);
    const second = calendarCell(2, 1, 13, SAT_THU);
    expect(first).toEqual({ cycleDay: 1, week: 1, dayOfWeek: 6 });
    expect(second).toEqual({ cycleDay: 14, week: 3, dayOfWeek: 7 });
  });
  it("keeps a four-week cycle on the same weekday every week", () => {
    for (let r = 1; r <= 4; r++) expect(calendarCell(r, 3, 6, SAT_THU).dayOfWeek).toBe(SAT_THU[2]);
    expect(calendarCell(4, 3, 6, SAT_THU).week).toBe(4);
  });
  it("offsets a plan that starts mid-week", () => {
    // Plan starts on the Thursday slot (index 5) of a Sat-Thu week: day 1 is Thursday W1, day 2 is Saturday W2.
    expect(calendarCell(1, 1, 6, SAT_THU, 5)).toEqual({ cycleDay: 1, week: 1, dayOfWeek: 4 });
    expect(calendarCell(1, 2, 6, SAT_THU, 5)).toEqual({ cycleDay: 2, week: 2, dayOfWeek: 6 });
  });
});

describe("monthPlanDates", () => {
  it("October 2026 on a Sat-Thu week: whole weeks run Sat 3 to Thu 29, 24 days", () => {
    const plan = monthPlanDates(2026, 10, SAT_THU, "wholeWeeks")!;
    expect(ymd(plan.start)).toBe("2026-10-03");
    expect(ymd(plan.end)).toBe("2026-10-29");
    expect(plan.dates.length).toBe(24);
    expect(plan.dates.every(d => isoWeekday(d) !== 5)).toBe(true); // never a Friday
  });
  it("October 2026 every working day: Thu 1 to Sat 31, 26 days", () => {
    const plan = monthPlanDates(2026, 10, SAT_THU, "allDays")!;
    expect(ymd(plan.start)).toBe("2026-10-01");
    expect(ymd(plan.end)).toBe("2026-10-31");
    expect(plan.dates.length).toBe(26);
  });
  it("a Monday-Friday month", () => {
    const plan = monthPlanDates(2026, 11, MON_FRI, "wholeWeeks")!;
    expect(ymd(plan.start)).toBe("2026-11-02");
    expect(ymd(plan.end)).toBe("2026-11-27");
    expect(plan.dates.length).toBe(20);
  });
  it("returns null when the month has no working day", () => {
    expect(monthPlanDates(2026, 2, [], "allDays")).not.toBeNull();
    expect(monthPlanDates(2026, 10, [5], "wholeWeeks")!.dates.every(d => isoWeekday(d) === 5)).toBe(true);
  });
});

describe("upcomingWorkingDates", () => {
  it("starts on the plan start date and skips days off", () => {
    const dates = upcomingWorkingDates(8, SAT_THU, "2026-10-03");
    expect(dates.map(ymd)).toEqual(["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-10", "2026-10-11"]);
  });
  it("without a start date it begins tomorrow", () => {
    const dates = upcomingWorkingDates(3, MON_FRI, "", new Date(2026, 8, 30)); // Wed 30 Sep
    expect(dates.map(ymd)).toEqual(["2026-10-01", "2026-10-02", "2026-10-05"]);
  });
});

describe("visit spreading", () => {
  it("a fortnightly outlet on a 2-repeat cycle is one membership of two visits", () => {
    expect(membershipsFor(2, 2)).toEqual([2]);
    expect(membershipsFor(4, 2)).toEqual([2, 2]); // weekly needs a second day-group
    expect(membershipsFor(1, 4)).toEqual([1]);
  });
  it("buckets are the stride when runs divide by visits, else one per run", () => {
    expect(bucketsForFrequency(2, 4)).toBe(2);
    expect(bucketsForFrequency(2, 3)).toBe(3);
    expect(bucketsForFrequency(3, 4)).toBe(4);
    expect(bucketsForFrequency(1, 4)).toBe(4);
  });
  it("every run carries the same number of buckets, so day loads stay even", () => {
    for (const repeats of [2, 3, 4, 5]) {
      for (const vf of [1, 2, 3, 4]) {
        const buckets = bucketsForFrequency(vf, repeats);
        const perRun = new Map<number, number>();
        for (let b = 0; b < buckets; b++) for (const r of repeatsForBucket(vf, repeats, b)) perRun.set(r, (perRun.get(r) ?? 0) + 1);
        const counts = Array.from({ length: repeats }, (_, i) => perRun.get(i + 1) ?? 0);
        expect(new Set(counts).size, `vf${vf} x ${repeats} runs -> ${counts.join(",")}`).toBe(1);
      }
    }
  });
  it("fortnightly on four runs lands in runs 1+3 or 2+4", () => {
    expect(repeatsForBucket(2, 4, 0)).toEqual([1, 3]);
    expect(repeatsForBucket(2, 4, 1)).toEqual([2, 4]);
  });
});

describe("parseWorkingWeek", () => {
  it("keeps the order the user gave and drops junk", () => {
    expect(parseWorkingWeek({ workingDays: [6, 7, 1, 2, 3, 4, "x", 9] })).toEqual(SAT_THU);
  });
  it("falls back to the first N weekdays", () => {
    expect(parseWorkingWeek({ workingDaysPerWeek: 6 })).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseWorkingWeek({})).toEqual(MON_FRI);
  });
});

describe("nextMonthKey", () => {
  it("rolls over the year", () => {
    expect(nextMonthKey(new Date(2026, 11, 15))).toBe("2027-01");
    expect(nextMonthKey(new Date(2026, 8, 26))).toBe("2026-10");
  });
});

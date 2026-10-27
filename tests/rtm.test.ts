import { describe, it, expect } from "vitest";
import { chooseHeadcount, classifyChannel, callMinutesFor, guessWorkingWeek, dayMinutes, kthNeighbourKm, CHANNEL_CALL_MINUTES } from "../server/rtm";
import { scorePlan, overlapShare } from "../server/scorecard";

describe("headcount", () => {
  it("aims for the middle of the band when several team sizes fit", () => {
    // 4,058 monthly visits on a 26-day cycle at 20-25 a day: 7 or 8 reps fit; 7 is nearest 22.5.
    const h = chooseHeadcount(4058, 26, 20, 25);
    expect(h.reps).toBe(7);
    expect(h.fits).toBe(true);
    expect(h.visitsPerDay).toBeCloseTo(22.3, 1);
  });
  it("takes one rep at 30.3 a day over two at 15.2 when nothing fits 25-30", () => {
    const h = chooseHeadcount(728, 24, 25, 30);
    expect(h.reps).toBe(1);
    expect(h.fits).toBe(false);
    expect(h.reason).toMatch(/nearest/);
    expect(h.options.map(o => o.reps)).toContain(2);
  });
  it("prefers a slightly light day to an overloaded one at equal distance", () => {
    // 2,300 visits, 24 days, 25-30: 3 reps = 31.9 (6% over), 4 reps = 24.0 (4% under).
    expect(chooseHeadcount(2300, 24, 25, 30).reps).toBe(4);
  });
});

describe("channels and call time", () => {
  it("recognises channels in English and Arabic", () => {
    expect(classifyChannel("Super Market")).toBe("supermarket");
    expect(classifyChannel("سوبر ماركت")).toBe("supermarket");
    expect(classifyChannel("Retailer -مفرد")).toBe("grocery");
    expect(classifyChannel("GROCERY")).toBe("grocery");
    expect(classifyChannel("KIOSK")).toBe("kiosk");
    expect(classifyChannel("كشك")).toBe("kiosk");
    expect(classifyChannel("Wholesale - جملة")).toBe("wholesale");
    expect(classifyChannel("Mini Market")).toBe("minimarket");
    expect(classifyChannel("Petrol Station")).toBe("petrol");
    expect(classifyChannel("")).toBeNull();
    expect(classifyChannel("Something else")).toBe("other");
  });
  it("uses the outlet's own call time, else its channel's, else the fallback", () => {
    expect(callMinutesFor({ timePerVisit: 22, channel: "KIOSK" })).toBe(22);
    expect(callMinutesFor({ timePerVisit: 30, channel: "KIOSK" }, 15, false)).toBe(CHANNEL_CALL_MINUTES.kiosk);
    expect(callMinutesFor({ timePerVisit: 30, channel: null }, 15, false)).toBe(15);
  });
});

describe("working week", () => {
  it("reads the market's usual week from where the outlets are", () => {
    expect(guessWorkingWeek(33.51, 36.29)).toMatchObject({ country: "Syria", label: "Sat-Thu" });
    expect(guessWorkingWeek(33.33, 44.39)).toMatchObject({ country: "Iraq", label: "Sat-Thu" });
    expect(guessWorkingWeek(33.89, 35.50)).toMatchObject({ country: "Lebanon", label: "Mon-Sat" });   // Beirut
    expect(guessWorkingWeek(34.43, 35.84)).toMatchObject({ country: "Lebanon" });                      // Tripoli
    expect(guessWorkingWeek(34.01, 36.21)).toMatchObject({ country: "Lebanon" });                      // Baalbek
    expect(guessWorkingWeek(33.72, 36.10)).toMatchObject({ country: "Syria" });                        // Zabadani
    expect(guessWorkingWeek(48.85, 2.35)).toMatchObject({ country: null, label: "Mon-Sat" });
  });
});

describe("workday minutes", () => {
  it("adds calls, driving, commute and breaks", () => {
    // 25 calls of 12 min, 8 km straight -> 10.4 road km at 25 km/h = 25 min driving.
    const t = dayMinutes(300, 8);
    expect(t.drive).toBeCloseTo(24.96, 1);
    expect(t.total).toBeCloseTo(300 + 24.96 + 40 + 30, 1);
  });
  it("measures local density by the k-th nearest neighbour", () => {
    const pts = Array.from({ length: 100 }, (_, i) => ({ latitude: 33.5 + (i % 10) * 0.001, longitude: 36.3 + Math.floor(i / 10) * 0.001 }));
    const d = kthNeighbourKm(pts, 1);
    // A 10 x 10 grid at ~100 m spacing: every nearest neighbour is ~0.09-0.11 km away.
    for (const x of d) { expect(x).toBeGreaterThan(0.08); expect(x).toBeLessThan(0.12); }
    const lone = kthNeighbourKm([...pts, { latitude: 33.6, longitude: 36.3 }], 1);
    expect(lone[100]).toBeGreaterThan(9);
  });
});

describe("scorecard", () => {
  const outlet = (id: string, lat: number, lng: number, extra: Record<string, unknown> = {}) => ({ id, name: id, latitude: lat, longitude: lng, visitFrequency: 2, timePerVisit: 12, channel: null, territory: null, geoStatus: null, repId: "r1", ...extra });
  // Two reps, each with two compact routes side by side: a clean plan.
  const block = (p: string, lat: number, lng: number) => Array.from({ length: 25 }, (_, i) => outlet(`${p}${i}`, lat + (i % 5) * 0.002, lng + Math.floor(i / 5) * 0.002));
  const a1 = block("a", 33.50, 36.30), a2 = block("b", 33.50, 36.32), b1 = block("c", 33.53, 36.30), b2 = block("d", 33.53, 36.32);
  const outlets = [...a1, ...a2, ...b1, ...b2];
  const cell = (repId: string, week: number, day: number, g: typeof a1) => ({ repId, week, dayOfWeek: day, outletIds: g.map(o => o.id), routeOrder: g.map(o => o.id) });
  const clean = [cell("r1", 1, 1, a1), cell("r1", 1, 2, a2), cell("r2", 1, 1, b1), cell("r2", 1, 2, b2)];
  const base = { outlets, reps: [{ id: "r1", name: "Rep 1" }, { id: "r2", name: "Rep 2" }], band: { min: 20, max: 30 }, maxHopKm: 4, callTimeIsReal: true };

  it("grades a clean, balanced, fully covered plan an A", () => {
    const s = scorePlan({ ...base, schedules: clean });
    expect(s.kpis.coveragePct).toBe(100);
    expect(s.kpis.routeOverlapPct).toBe(0);
    expect(s.kpis.territoryOverlapPct).toBe(0);
    expect(s.kpis.repBalancePct).toBe(0);
    expect(s.kpis.daysInBandPct).toBe(100);
    expect(s.grade).toBe("A");
    expect(s.checks.every(c => c.status === "pass")).toBe(true);
    expect(s.perRep.map(r => r.name)).toEqual(["Rep 1", "Rep 2"]);
    // 25 calls of 12 min = 5 h of calls; plus a short drive, commute and break.
    expect(s.kpis.callHoursPerDay).toBe(5);
  });

  it("marks interleaved routes, missing outlets and overloaded days", () => {
    // Rep 1's two routes take alternate outlets of both blocks: they cover the same ground.
    const both = [...a1, ...a2];
    const odd = both.filter((_, i) => i % 2 === 1), even = both.filter((_, i) => i % 2 === 0);
    const messy = [cell("r1", 1, 1, even), cell("r1", 1, 2, odd), cell("r2", 1, 1, b1)]; // b2 is never visited
    const s = scorePlan({ ...base, schedules: messy, outlets: outlets.map(o => ({ ...o, timePerVisit: 25 })) });
    expect(s.kpis.routeOverlapPct).toBeGreaterThan(30);
    expect(s.kpis.unplanned).toBe(25);
    expect(s.kpis.overloadedDays).toBeGreaterThan(0); // 25 calls x 25 min = 10.4 h
    expect(s.grade).not.toBe("A");
    const ids = s.checks.filter(c => c.status !== "pass").map(c => c.id);
    expect(ids).toEqual(expect.arrayContaining(["coverage", "overlap", "workday"]));
  });

  it("counts outlets held for review apart from unplanned ones", () => {
    const held = outlet("far", 41.84, 12.46, { geoStatus: "offset", territory: "Needs Review" });
    const s = scorePlan({ ...base, schedules: clean, outlets: [...outlets, held] });
    expect(s.kpis.heldForReview).toBe(1);
    expect(s.kpis.unplanned).toBe(0);
    expect(s.checks.find(c => c.id === "held")?.status).toBe("warn");
  });

  it("counts only the long drives a route does not need", () => {
    // Two villages 6 km apart on one route: one drive between them is the price of the route.
    const v1 = Array.from({ length: 4 }, (_, i) => outlet(`v${i}`, 33.50 + i * 0.001, 36.30));
    const v2 = Array.from({ length: 4 }, (_, i) => outlet(`w${i}`, 33.50 + i * 0.001, 36.365));
    const tidy = [...v1, ...v2];
    const zigzag = [v1[0], v2[0], v1[1], v2[1], v1[2], v2[2], v1[3], v2[3]];
    const one = (order: typeof v1) => scorePlan({ ...base, outlets: [...v1, ...v2], band: { min: 1, max: 30 }, schedules: [{ repId: "r1", week: 1, dayOfWeek: 1, outletIds: order.map(o => o.id), routeOrder: order.map(o => o.id) }] });
    const a = one(tidy), b = one(zigzag);
    expect(a.kpis.longHops).toBe(1);
    expect(a.kpis.avoidableLongHops).toBe(0);
    expect(a.checks.find(c => c.id === "hops")?.status).toBe("pass");
    expect(b.kpis.longHops).toBe(7);
    expect(b.kpis.avoidableLongHops).toBe(6);
    expect(b.checks.find(c => c.id === "hops")?.status).toBe("fail");
    expect(a.headline).toMatch(/^(Ready to roll out: )?1 rep, 8 outlets/);
  });

  it("measures overlap between groups by convex hulls", () => {
    const sq = (x: number, y: number): [number, number][] => [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1], [x + 0.5, y + 0.5]];
    expect(overlapShare([sq(0, 0), sq(2, 0)])).toBe(0);
    expect(overlapShare([sq(0, 0), [[0.4, 0.4], [0.6, 0.6], [0.5, 0.45]]])).toBeGreaterThan(0.3);
  });
});

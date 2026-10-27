import { describe, it, expect } from "vitest";
import type { Outlet } from "../shared/schema";
import { sequenceDays, spreadTour, tourLength } from "../server/day-balancer";

const outlet = (id: string, lat: number, lng: number) => ({ id, name: id, latitude: lat, longitude: lng, visitFrequency: 2 } as Outlet);
// A day-group of 5 outlets around a centre.
const day = (k: number, lat: number, lng: number) => Array.from({ length: 5 }, (_, i) => outlet(`${k}-${i}`, lat + (i % 2) * 0.001, lng + Math.floor(i / 2) * 0.001));

describe("sequenceDays", () => {
  it("drives six days along the territory instead of jumping across it", () => {
    // Six day areas on a line, 3 km apart, handed over shuffled.
    const pos = [4, 0, 5, 2, 1, 3];
    const groups = pos.map(p => day(p, 33.5, 36.2 + p * 0.032));
    const order = sequenceDays(groups);
    const seq = order.map(i => pos[i]);
    expect(seq.join(",") === "0,1,2,3,4,5" || seq.join(",") === "5,4,3,2,1,0").toBe(true);
  });
  it("orders thirteen days of a 26-day cycle the same way, and keeps empty days last", () => {
    const pos = [7, 3, 12, 0, 9, 5, 1, 11, 2, 8, 4, 10, 6];
    const groups = [...pos.map(p => day(p, 33.5 + p * 0.02, 36.2)), [] as Outlet[]];
    const order = sequenceDays(groups);
    expect(order[order.length - 1]).toBe(13);
    const seq = order.slice(0, 13).map(i => pos[i]);
    const steps = seq.slice(1).map((p, i) => Math.abs(p - seq[i]));
    expect(steps.every(s => s === 1)).toBe(true);
  });
});

describe("spreadTour", () => {
  it("tracks a real tour's length closely enough to rank cuts of a large group", () => {
    let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const big = Array.from({ length: 400 }, (_, i) => outlet(`b${i}`, 33.4 + rnd() * 0.1, 36.2 + rnd() * 0.1));
    const small = big.slice(0, 100);
    const ratioBig = spreadTour(big) / tourLength(big), ratioSmall = spreadTour(small) / tourLength(small);
    // Same distribution, different size: the estimate's bias is similar, so comparisons hold.
    expect(Math.abs(ratioBig - ratioSmall)).toBeLessThan(0.25);
  });
});

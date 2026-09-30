import { describe, it, expect } from "vitest";
import { cumulativeKm, positionAt, drivingMinutes, haversineKm, type Stop } from "../client/src/lib/route-playback-math";

// Four stops in a line, roughly 1 km apart (0.009 degrees of latitude).
const stops: Stop[] = [0, 1, 2, 3].map(i => ({ id: `s${i}`, name: `Stop ${i + 1}`, lat: 33.5 + i * 0.009, lng: 36.28 }));

describe("route playback maths", () => {
  it("accumulates distance stop by stop", () => {
    const cum = cumulativeKm(stops);
    expect(cum[0]).toBe(0);
    expect(cum.length).toBe(4);
    expect(cum[1]).toBeCloseTo(1.0, 1);
    expect(cum[3]).toBeCloseTo(3.0, 1);
    expect(cum[3]).toBeCloseTo(haversineKm(stops[0].lat, stops[0].lng, stops[3].lat, stops[3].lng), 5);
  });

  it("places the marker on the right leg and builds the trail", () => {
    const cum = cumulativeKm(stops);
    const start = positionAt(stops, cum, 0);
    expect(start.reached).toBe(0);
    expect(start.trail.length).toBe(2); // stop 1 plus the marker on it
    const mid = positionAt(stops, cum, cum[1] + (cum[2] - cum[1]) / 2);
    expect(mid.reached).toBe(1);
    expect(mid.legT).toBeCloseTo(0.5, 2);
    expect(mid.lat).toBeCloseTo((stops[1].lat + stops[2].lat) / 2, 6);
    expect(mid.trail.length).toBe(3);
    const end = positionAt(stops, cum, 999);
    expect(end.reached).toBe(3);
    expect(end.trail.length).toBe(4);
    expect(end.lat).toBe(stops[3].lat);
  });

  it("handles one stop and negative input", () => {
    const one = [stops[0]];
    const cum = cumulativeKm(one);
    expect(cum).toEqual([0]);
    expect(positionAt(one, cum, 5).reached).toBe(0);
    expect(positionAt(stops, cumulativeKm(stops), -3).reached).toBe(0);
    expect(positionAt([], [], 1).reached).toBe(-1);
  });

  it("driving minutes at an urban speed", () => {
    expect(drivingMinutes(25)).toBeCloseTo(60, 5);
    expect(drivingMinutes(10, 50)).toBeCloseTo(12, 5);
  });
});

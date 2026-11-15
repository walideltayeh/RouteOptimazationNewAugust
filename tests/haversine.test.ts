import { describe, it, expect } from "vitest";
import { haversineKm, haversineExactKm } from "../server/road-distance";

describe("great-circle distance", () => {
  it("matches the haversine formula to a hundred-billionth inside a market", () => {
    let seed = 42; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    let worst = 0;
    for (let i = 0; i < 20000; i++) {
      // Anywhere from the equator to 65 degrees, pairs up to ~1.5 degrees apart.
      const lat1 = (rnd() - 0.5) * 130, lng1 = (rnd() - 0.5) * 340;
      const lat2 = lat1 + (rnd() - 0.5) * 3, lng2 = lng1 + (rnd() - 0.5) * 3;
      const exact = haversineExactKm(lat1, lng1, lat2, lng2), fast = haversineKm(lat1, lng1, lat2, lng2);
      if (exact > 1e-6) worst = Math.max(worst, Math.abs(fast - exact) / exact);
    }
    expect(worst).toBeLessThan(1e-11);
  });
  it("is zero for the same point and symmetric", () => {
    expect(haversineKm(33.5, 36.3, 33.5, 36.3)).toBe(0);
    expect(haversineKm(33.5, 36.3, 33.52, 36.33)).toBe(haversineKm(33.52, 36.33, 33.5, 36.3));
  });
  it("uses the formula as written for points far apart", () => {
    // Beirut to Baghdad, and across the date line.
    expect(haversineKm(33.89, 35.5, 33.31, 44.36)).toBe(haversineExactKm(33.89, 35.5, 33.31, 44.36));
    expect(haversineKm(10, 179.9, 10, -179.9)).toBeCloseTo(21.9, 0);
  });
  it("knows a few distances", () => {
    // One degree of latitude is 111.19 km; 0.01 degree of longitude at 33.9 N is 0.923 km.
    expect(haversineKm(33, 36, 34, 36)).toBeCloseTo(111.195, 2);
    expect(haversineKm(33.9, 35.5, 33.9, 35.51)).toBeCloseTo(0.9229, 3);
  });
});

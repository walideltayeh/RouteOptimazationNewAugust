import { describe, it, expect } from "vitest";
import { detectGeoOutliers } from "../server/geo-outliers";

let n = 0;
const pt = (lat: number, lng: number) => ({ id: `o${n++}`, name: `o${n}`, latitude: lat, longitude: lng });
// A city of 400 outlets on a 20 x 20 grid, ~0.5 km apart: lat 33.80..33.89, lng 35.48..35.58 (Beirut-like).
const city = () => Array.from({ length: 400 }, (_, i) => pt(33.80 + (i % 20) * 0.0045, 35.48 + Math.floor(i / 20) * 0.0054));
const village = (lat: number, lng: number, k = 6) => Array.from({ length: k }, (_, i) => pt(lat + (i % 3) * 0.002, lng + Math.floor(i / 3) * 0.002));

describe("geographic outliers", () => {
  it("keeps a town that is near the market's edge though far from its centre", () => {
    const c = city();
    // ~22 km north of the city's north edge (33.89), ~27 km from its centre: centre-to-centre at 30 km would be close to the line.
    const town = village(34.09, 35.53, 8);
    // ~25 km from the edge, ~32 km from the centre: the old rule flagged this.
    const town2 = village(33.80 - 0.225, 35.53 - 0.12, 8);
    const flagged = detectGeoOutliers([...c, ...town, ...town2], 30);
    expect(flagged.length).toBe(0);
  });

  it("keeps a chain of villages that reaches the market through each other", () => {
    const c = city();
    // Three villages heading east, each ~22 km beyond the last: the farthest is ~66 km from the city.
    const chain = [village(33.85, 35.82), village(33.85, 36.06), village(33.85, 36.30)];
    expect(detectGeoOutliers([...c, ...chain.flat()], 30).length).toBe(0);
  });

  it("flags records geocoded to the wrong country, including several sharing one wrong point", () => {
    const c = city();
    const rome = Array.from({ length: 5 }, () => pt(41.8443, 12.4635));       // five records on one point in Rome
    const libya = [pt(32.8872, 13.1913)];                                       // "Tripoli" geocoded to Libya
    const warehouse = [pt(30.2973, 47.7132)];                                   // a Basra warehouse in a Beirut file
    const flagged = detectGeoOutliers([...c, ...rome, ...libya, ...warehouse], 30);
    expect(new Set(flagged.map(f => f.id))).toEqual(new Set([...rome, ...libya, ...warehouse].map(o => o.id)));
    // Each is reported with its real gap to the market, farthest first.
    expect(flagged[0].distanceKm).toBeGreaterThan(flagged[flagged.length - 1].distanceKm);
    const romeGap = flagged.find(f => f.id === rome[0].id)!.distanceKm;
    expect(romeGap).toBeGreaterThan(2000);
    expect(romeGap).toBeLessThan(2300);
  });

  it("does not flag anything when the file is one cluster or too small to judge", () => {
    expect(detectGeoOutliers(city(), 30)).toEqual([]);
    expect(detectGeoOutliers([pt(0, 0), pt(10, 10), pt(20, 20)], 30)).toEqual([]);
  });
});

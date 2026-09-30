import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { geoDist, haversineKm, setDistanceMode, prefetchOutletMatrix, roadPairKnown, roadMatrixSize, clearRoadMatrix } from "../server/road-distance";

// A fake OSRM table service: the road distance between two points is their
// straight-line distance times 1.5, plus 200 m one way (a one-way street).
function fakeOsrm() {
  const calls: number[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    const m = /\/table\/v1\/driving\/([^?]+)/.exec(url);
    if (!m) return { ok: false, status: 404, json: async () => ({}) } as any;
    const pts = m[1].split(';').map(s => s.split(',').map(Number)).map(([lng, lat]) => ({ lat, lng }));
    calls.push(pts.length);
    const distances = pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : haversineKm(a.lat, a.lng, b.lat, b.lng) * 1500 + (i < j ? 200 : 0))));
    return { ok: true, status: 200, json: async () => ({ code: 'Ok', distances }) } as any;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}
const pt = (i: number) => ({ lat: 33.5 + (i % 10) * 0.005, lng: 36.3 + Math.floor(i / 10) * 0.005 });

describe("road distances from OSRM", () => {
  beforeEach(() => { process.env.OSRM_URL = 'http://osrm.test'; clearRoadMatrix(); });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.OSRM_URL; setDistanceMode('haversine'); });

  it("fetches every pair of a rep's outlets in chunk pairs and answers by road, shorter direction", async () => {
    const calls = fakeOsrm();
    const points = Array.from({ length: 120 }, (_, i) => pt(i)); // 3 chunks of 50 at the default cap of 100
    const r = await prefetchOutletMatrix(points);
    expect(r.failed).toBe(false);
    expect(calls.length).toBe(3);                    // each pair of chunks in one request
    expect(calls.every(n => n <= 100)).toBe(true);   // never over the table cap
    expect(r.filled).toBe(120 * 119 / 2);
    expect(roadMatrixSize()).toBe(120 * 119 / 2);
    for (let i = 0; i < 120; i++) for (let j = i + 1; j < 120; j++) expect(roadPairKnown(points[i].lat, points[i].lng, points[j].lat, points[j].lng)).toBe(true);

    setDistanceMode('road');
    const a = points[3], b = points[77];
    const straight = haversineKm(a.lat, a.lng, b.lat, b.lng);
    expect(geoDist(a.lat, a.lng, b.lat, b.lng)).toBeCloseTo(straight * 1.5, 6);          // the shorter direction, in km
    expect(geoDist(b.lat, b.lng, a.lat, a.lng)).toBeCloseTo(straight * 1.5, 6);          // symmetric
    expect(geoDist(a.lat + 0.00003, a.lng, b.lat, b.lng)).toBeCloseTo(straight * 1.5, 3); // a GPS jitter of 3 m still hits
    // An unknown point falls back to the detour estimate, and straight-line mode ignores the roads.
    expect(geoDist(a.lat, a.lng, 33.7, 36.5)).toBeCloseTo(haversineKm(a.lat, a.lng, 33.7, 36.5) * 1.3, 6);
    setDistanceMode('haversine');
    expect(geoDist(a.lat, a.lng, b.lat, b.lng)).toBeCloseTo(straight, 9);
    // Nothing is asked twice.
    await prefetchOutletMatrix(points);
    expect(calls.length).toBe(3);
  });

  it("keeps the run going on a failing server", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const r = await prefetchOutletMatrix([pt(0), pt(1), pt(2)]);
    expect(r.failed).toBe(true);
    expect(roadMatrixSize()).toBe(0);
    setDistanceMode('road');
    expect(geoDist(pt(0).lat, pt(0).lng, pt(1).lat, pt(1).lng)).toBeCloseTo(haversineKm(pt(0).lat, pt(0).lng, pt(1).lat, pt(1).lng) * 1.3, 6);
  });
});

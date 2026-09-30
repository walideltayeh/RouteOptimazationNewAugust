import { describe, it, expect } from "vitest";
import { PlaybackEngine, SRC, type MapLike, type PlaybackSnapshot, type RoadPath } from "../client/src/lib/route-playback-engine";
import type { Stop } from "../client/src/lib/route-playback-math";

function fakeMap(): MapLike & { sources: Map<string, { data: any }> } {
  const sources = new Map<string, { data: any }>();
  const layers = new Map<string, any>();
  return {
    sources,
    getSource: (id) => { const s = sources.get(id); return s ? { setData: (d: any) => { s.data = d; } } : undefined; },
    addSource: (id, src) => { sources.set(id, { data: src.data }); },
    removeSource: (id) => { sources.delete(id); },
    getLayer: (id) => layers.get(id),
    addLayer: (layer) => { layers.set(layer.id, layer); },
    removeLayer: (id) => { layers.delete(id); },
    setPaintProperty: () => {},
    getBounds: () => ({ contains: () => true }),
    easeTo: () => {},
    fitBounds: () => {},
  };
}
function clock() {
  let t = 0; const frames: ((ts: number) => void)[] = [];
  return { now: () => t, raf: (cb: (ts: number) => void) => { frames.push(cb); return frames.length; }, cancel: () => { frames.length = 0; }, step(ms: number) { t += ms; const cb = frames.shift(); if (cb) cb(t); }, pending: () => frames.length };
}

// Three stops on a line, 1 km apart as the crow flies.
const stops: Stop[] = [0, 1, 2].map(i => ({ id: `s${i}`, name: `Stop ${i + 1}`, lat: 33.5 + i * 0.009, lng: 36.28 }));
// The road wiggles: 20 vertices, 1.5 km per leg by road; stop 2 reached at 1.5 km, stop 3 at 3.0 km.
const road: RoadPath = {
  coordinates: Array.from({ length: 21 }, (_, i) => [36.28 + (i % 2 === 0 ? 0 : 0.006), 33.5 + i * 0.0009] as [number, number]),
  stopKm: [0, 1.5, 3.0],
  distanceKm: 3.0,
  durationMin: 9,
};
const route = { key: "r", scheduleId: "sched-1", repName: "Rep", dayLabel: "Sat W1", color: "#000", stops };

describe("playback along a road line", () => {
  it("follows the road vertices and reaches stops at the road kilometres", async () => {
    const map = fakeMap(); const c = clock();
    let latest: PlaybackSnapshot | null = null;
    const engine = new PlaybackEngine(() => map, s => { latest = s; }, () => "b", c.raf, c.cancel, c.now);
    engine.start(route, 0, road);
    expect(latest!.source).toBe("road");
    expect(latest!.durationMin).toBe(9);
    expect(map.sources.get(SRC.ahead)!.data.features[0].geometry.coordinates.length).toBe(21);
    // Stop 2 is reached half-way along the road (its leg is half the road
    // length), whatever the straight-line distance says.
    engine.seek(0.45);
    expect(latest!.reached).toBe(1);
    engine.seek(0.55);
    expect(latest!.reached).toBe(2);
    const head = map.sources.get(SRC.head)!.data.features[0].geometry.coordinates;
    // The marker sits on the wiggling road, i.e. its longitude is not the straight-line longitude.
    const onRoad = road.coordinates.some(([lng, lat]) => Math.abs(lng - head[0]) < 0.004 && Math.abs(lat - head[1]) < 0.001);
    expect(onRoad).toBe(true);
    engine.seek(1);
    expect(latest!.reached).toBe(3);
    expect(latest!.done).toBe(true);
  });

  it("upgrades from straight lines to the road when it arrives, keeping the position", async () => {
    const map = fakeMap(); const c = clock();
    let latest: PlaybackSnapshot | null = null;
    const engine = new PlaybackEngine(() => map, s => { latest = s; }, () => "b", c.raf, c.cancel, c.now);
    engine.start(route, 0);
    expect(latest!.source).toBe("straight");
    engine.seek(0.5);
    engine.upgradeToRoad("r", road);
    expect(latest!.source).toBe("road");
    expect(latest!.km / latest!.totalKm).toBeCloseTo(0.5, 6);
    expect(map.sources.get(SRC.ahead)!.data.features[0].geometry.coordinates.length).toBe(21);
    // A road for a different route, or one with the wrong stop count, is ignored.
    engine.upgradeToRoad("other", road);
    expect(latest!.source).toBe("road");
    const engine2 = new PlaybackEngine(() => fakeMap(), s => { latest = s; }, () => "b", c.raf, c.cancel, c.now);
    engine2.start(route, 0);
    engine2.upgradeToRoad("r", { ...road, stopKm: [0, 1] });
    expect(latest!.source).toBe("straight");
  });
});

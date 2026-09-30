import { describe, it, expect } from "vitest";
import { PlaybackEngine, SRC, SECONDS_PER_ROUTE, type MapLike, type PlaybackSnapshot } from "../client/src/lib/route-playback-engine";
import type { Stop } from "../client/src/lib/route-playback-math";

/** A map that remembers what it was given, and a clock we control. */
function fakeMap() {
  const sources = new Map<string, { data: any }>();
  const layers = new Map<string, any>();
  const paint: Record<string, any> = {};
  const camera: any[] = [];
  const map: MapLike & { sources: typeof sources; layers: typeof layers; paint: typeof paint; camera: typeof camera } = {
    sources, layers, paint, camera,
    getSource: (id) => { const s = sources.get(id); return s ? { setData: (d: any) => { s.data = d; } } : undefined; },
    addSource: (id, src) => { if (sources.has(id)) throw new Error(`source ${id} exists`); sources.set(id, { data: src.data }); },
    removeSource: (id) => { for (const l of layers.values()) if (l.source === id) throw new Error(`layer ${l.id} still uses ${id}`); sources.delete(id); },
    getLayer: (id) => layers.get(id),
    addLayer: (layer) => { if (layers.has(layer.id)) throw new Error(`layer ${layer.id} exists`); if (!sources.has(layer.source)) throw new Error(`no source ${layer.source}`); layers.set(layer.id, layer); },
    removeLayer: (id) => { layers.delete(id); },
    setPaintProperty: (layer, name, value) => { paint[`${layer}.${name}`] = value; },
    getBounds: () => ({ contains: () => true }),
    easeTo: (o) => camera.push(["easeTo", o]),
    fitBounds: (b, o) => camera.push(["fitBounds", b, o]),
  };
  // The Rep Map's own route layers, which the playback dims and restores.
  sources.set("rep-routes", { data: null });
  layers.set("rep-routes-solid", { id: "rep-routes-solid", source: "rep-routes" });
  return map;
}

function clock() {
  let t = 0;
  const frames: ((ts: number) => void)[] = [];
  return {
    now: () => t,
    raf: (cb: (ts: number) => void) => { frames.push(cb); return frames.length; },
    cancel: () => { frames.length = 0; },
    /** Advance time and run the pending frame once. */
    step(ms: number) { t += ms; const cb = frames.shift(); if (cb) cb(t); },
    pending: () => frames.length,
  };
}

const stops: Stop[] = [0, 1, 2, 3, 4].map(i => ({ id: `s${i}`, name: `Stop ${i + 1}`, lat: 33.5 + i * 0.009, lng: 36.28 })); // ~1 km apart, ~4 km total
const route = { key: "r1", repName: "Rep 1", dayLabel: "Saturday W1", color: "#ff0000", stops };

describe("route playback engine", () => {
  it("creates its layers, fits the camera, and draws stop 1 at rest", () => {
    const map = fakeMap(); const c = clock();
    const snaps: (PlaybackSnapshot | null)[] = [];
    const engine = new PlaybackEngine(() => map, s => snaps.push(s), () => "bounds", c.raf, c.cancel, c.now);
    expect(engine.start(route, 0)).toBe(true);
    expect(Object.values(SRC).every(id => map.sources.has(id))).toBe(true);
    expect(map.layers.size).toBe(7);
    expect(map.camera[0][0]).toBe("fitBounds");
    expect(map.paint["rep-routes-solid.line-opacity"]).toBe(0.12);
    const last = snaps[snaps.length - 1]!;
    expect(last.km).toBe(0);
    expect(last.reached).toBe(1);
    expect(last.totalKm).toBeCloseTo(4.0, 0);
    expect(map.sources.get(SRC.ahead)!.data.features[0].geometry.coordinates.length).toBe(5);
    expect(map.sources.get(SRC.stops)!.data.features.filter((f: any) => f.properties.visited).length).toBe(1);
  });

  it("advances the marker frame by frame, grows the trail, and finishes", async () => {
    const map = fakeMap(); const c = clock();
    let latest: PlaybackSnapshot | null = null;
    const engine = new PlaybackEngine(() => map, s => { latest = s; }, () => "bounds", c.raf, c.cancel, c.now);
    engine.start(route, 0);
    await new Promise(r => setTimeout(r, 5)); // the autoplay timer
    expect(latest!.playing).toBe(true);
    expect(c.pending()).toBe(1);
    // Half the route at 1x takes half of SECONDS_PER_ROUTE.
    const half = (SECONDS_PER_ROUTE / 2) * 1000;
    let elapsed = 0;
    c.step(0); // first frame sets the clock
    while (elapsed < half) { c.step(100); elapsed += 100; }
    expect(latest!.km).toBeGreaterThan(engine.total * 0.45);
    expect(latest!.km).toBeLessThan(engine.total * 0.55);
    const trail = map.sources.get(SRC.trail)!.data.features[0].geometry.coordinates;
    expect(trail.length).toBeGreaterThanOrEqual(3);
    const head = map.sources.get(SRC.head)!.data.features[0].geometry.coordinates;
    expect(head[1]).toBeGreaterThan(stops[1].lat);
    expect(head[1]).toBeLessThan(stops[3].lat);
    // Run to the end.
    for (let i = 0; i < 400 && c.pending(); i++) c.step(100);
    expect(latest!.done).toBe(true);
    expect(latest!.playing).toBe(false);
    expect(latest!.reached).toBe(5);
    expect(latest!.km).toBeCloseTo(engine.total, 6);
    expect(map.sources.get(SRC.stops)!.data.features.every((f: any) => f.properties.visited)).toBe(true);
  });

  it("speed, pause, seek and restart behave", async () => {
    const map = fakeMap(); const c = clock();
    let latest: PlaybackSnapshot | null = null;
    const engine = new PlaybackEngine(() => map, s => { latest = s; }, () => "bounds", c.raf, c.cancel, c.now);
    engine.start(route, 0);
    await new Promise(r => setTimeout(r, 5));
    engine.setSpeed(4);
    c.step(0);
    c.step(1000); // 4x for one second = 4/30 of the route x 4
    const kmAt4x = latest!.km;
    expect(kmAt4x).toBeCloseTo(engine.total / SECONDS_PER_ROUTE * 4, 3);
    engine.pause();
    expect(latest!.playing).toBe(false);
    expect(c.pending()).toBe(0);
    engine.seek(0.5);
    expect(latest!.km).toBeCloseTo(engine.total / 2, 6);
    engine.restart();
    expect(latest!.playing).toBe(true);
    expect(latest!.km).toBe(0);
  });

  it("stop removes every layer and source and restores the other routes", async () => {
    const map = fakeMap(); const c = clock();
    let latest: PlaybackSnapshot | null = null;
    const engine = new PlaybackEngine(() => map, s => { latest = s; }, () => "bounds", c.raf, c.cancel, c.now);
    engine.start(route, 0);
    engine.stop();
    expect(map.layers.size).toBe(1); // only the Rep Map's own layer remains
    expect(map.sources.size).toBe(1);
    expect(latest).toBeNull();
    expect(map.paint["rep-routes-solid.line-opacity"]).toBe(0.6);
    // Starting again after a stop works (no "source exists" error).
    expect(engine.start(route, 0)).toBe(true);
    expect(map.layers.size).toBe(7);
    // Starting a second route while one is open replaces it cleanly.
    expect(engine.start({ ...route, key: "r2", stops: stops.slice(0, 3) }, 0)).toBe(true);
    expect(map.sources.get(SRC.ahead)!.data.features[0].geometry.coordinates.length).toBe(3);
  });

  it("refuses an empty route and a missing map", () => {
    const c = clock();
    const none = new PlaybackEngine(() => null, () => {}, () => "b", c.raf, c.cancel, c.now);
    expect(none.start(route, 0)).toBe(false);
    const map = fakeMap();
    const engine = new PlaybackEngine(() => map, () => {}, () => "b", c.raf, c.cancel, c.now);
    expect(engine.start({ ...route, stops: [] }, 0)).toBe(false);
  });
});

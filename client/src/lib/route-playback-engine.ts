import { cumulativeKm, positionAt, type Stop } from "./route-playback-math";

/**
 * The playback engine, free of React and of the real Mapbox object so it can
 * be driven in a test: give it anything that looks like a map (the subset of
 * the Mapbox GL API below), a clock and an animation-frame scheduler, and it
 * animates a route by feeding GeoJSON to four sources.
 */
export interface GeoJSONSourceLike { setData(data: any): void }
export interface MapLike {
  getSource(id: string): GeoJSONSourceLike | undefined;
  addSource(id: string, source: any): void;
  removeSource(id: string): void;
  getLayer(id: string): unknown;
  addLayer(layer: any): void;
  removeLayer(id: string): void;
  setPaintProperty(layer: string, name: string, value: any): void;
  getBounds(): { contains(p: [number, number]): boolean } | null | undefined;
  easeTo(opts: { center: [number, number]; duration: number }): void;
  fitBounds(bounds: any, opts: any): void;
}

export interface PlaybackRoute {
  key: string;
  repName: string;
  dayLabel: string;
  color: string;
  stops: Stop[];
}

export interface PlaybackSnapshot {
  route: PlaybackRoute;
  playing: boolean;
  speed: number;
  km: number;
  totalKm: number;
  reached: number; // stops reached so far, as a count
  done: boolean;
}

export const SRC = { trail: "playback-trail", ahead: "playback-ahead", head: "playback-head", stops: "playback-stops" } as const;
const LAYERS = ["playback-head", "playback-head-glow", "playback-stop-labels", "playback-stops", "playback-trail", "playback-ahead"];
export const SECONDS_PER_ROUTE = 30; // a whole day plays in half a minute at 1x

export class PlaybackEngine {
  private route: PlaybackRoute | null = null;
  private cum: number[] = [];
  private km = 0;
  private playing = false;
  private speed = 1;
  private frame: number | null = null;
  private lastTs: number | null = null;
  private lastEmit = -Infinity;
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly map: () => MapLike | null,
    private readonly onChange: (s: PlaybackSnapshot | null) => void,
    private readonly makeBounds: (stops: Stop[]) => any,
    private readonly raf: (cb: (ts: number) => void) => number = (cb) => requestAnimationFrame(cb),
    private readonly cancelRaf: (id: number) => void = (id) => cancelAnimationFrame(id),
    private readonly now: () => number = () => performance.now(),
  ) {}

  get total(): number { return this.cum[this.cum.length - 1] ?? 0; }
  get current(): PlaybackRoute | null { return this.route; }

  private snapshot(): PlaybackSnapshot | null {
    if (!this.route) return null;
    const pos = positionAt(this.route.stops, this.cum, this.km);
    return { route: this.route, playing: this.playing, speed: this.speed, km: Math.min(this.km, this.total), totalKm: this.total, reached: pos.reached + 1, done: this.km >= this.total && this.route.stops.length > 0 };
  }
  private emit(force = false) {
    const t = this.now();
    if (!force && t - this.lastEmit < 100) return;
    this.lastEmit = t;
    this.onChange(this.snapshot());
  }

  private src(id: string) { return this.map()?.getSource(id); }

  private ensureLayers(color: string) {
    const m = this.map();
    if (!m || m.getSource(SRC.trail)) return;
    const empty = { type: "FeatureCollection", features: [] };
    m.addSource(SRC.ahead, { type: "geojson", data: empty });
    m.addLayer({ id: "playback-ahead", type: "line", source: SRC.ahead, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": color, "line-width": 3, "line-opacity": 0.25, "line-dasharray": [1, 2] } });
    m.addSource(SRC.trail, { type: "geojson", data: empty });
    m.addLayer({ id: "playback-trail", type: "line", source: SRC.trail, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": color, "line-width": 5, "line-opacity": 0.95 } });
    m.addSource(SRC.stops, { type: "geojson", data: empty });
    m.addLayer({ id: "playback-stops", type: "circle", source: SRC.stops, paint: { "circle-radius": 11, "circle-color": ["case", ["boolean", ["get", "visited"], false], color, "#ffffff"], "circle-stroke-width": 2, "circle-stroke-color": color } });
    m.addLayer({ id: "playback-stop-labels", type: "symbol", source: SRC.stops, layout: { "text-field": ["to-string", ["get", "order"]], "text-size": 11, "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"], "text-allow-overlap": true }, paint: { "text-color": ["case", ["boolean", ["get", "visited"], false], "#ffffff", color] } });
    m.addSource(SRC.head, { type: "geojson", data: empty });
    m.addLayer({ id: "playback-head-glow", type: "circle", source: SRC.head, paint: { "circle-radius": 18, "circle-color": color, "circle-opacity": 0.25, "circle-blur": 0.6 } });
    m.addLayer({ id: "playback-head", type: "circle", source: SRC.head, paint: { "circle-radius": 8, "circle-color": "#111111", "circle-stroke-width": 3, "circle-stroke-color": "#ffffff" } });
    // The regular route lines fade so the journey stands out.
    this.dimOthers(true);
  }

  private dimOthers(dim: boolean) {
    const m = this.map();
    if (!m) return;
    const tryPaint = (layer: string, prop: string, value: any) => { try { if (m.getLayer(layer)) m.setPaintProperty(layer, prop, value); } catch { /* layer may be mid-rebuild */ } };
    for (const id of ["rep-routes-solid", "rep-routes-dashed"]) tryPaint(id, "line-opacity", dim ? 0.12 : 0.6);
    tryPaint("rep-circles", "circle-opacity", dim ? 0.25 : 1);
    tryPaint("rep-labels", "text-opacity", dim ? 0.25 : 1);
  }

  private removeLayers() {
    const m = this.map();
    if (!m) return;
    for (const id of LAYERS) { try { if (m.getLayer(id)) m.removeLayer(id); } catch { /* already gone */ } }
    for (const id of Object.values(SRC)) { try { if (m.getSource(id)) m.removeSource(id); } catch { /* already gone */ } }
    this.dimOthers(false);
  }

  private draw(force = false) {
    const m = this.map();
    const route = this.route;
    if (!m || !route) return;
    const pos = positionAt(route.stops, this.cum, this.km);
    this.src(SRC.trail)?.setData({ type: "FeatureCollection", features: pos.trail.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pos.trail } }] : [] });
    this.src(SRC.head)?.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [pos.lng, pos.lat] } }] });
    this.src(SRC.stops)?.setData({ type: "FeatureCollection", features: route.stops.map((s, i) => ({ type: "Feature", properties: { order: i + 1, visited: i <= pos.reached, name: s.name }, geometry: { type: "Point", coordinates: [s.lng, s.lat] } })) });
    if (this.playing) {
      const b = m.getBounds();
      if (b && !b.contains([pos.lng, pos.lat])) m.easeTo({ center: [pos.lng, pos.lat], duration: 600 });
    }
    this.emit(force);
  }

  private tick = (ts: number) => {
    this.frame = null;
    if (!this.playing) return;
    const last = this.lastTs ?? ts;
    this.lastTs = ts;
    const kmPerSec = Math.max(this.total / SECONDS_PER_ROUTE, 0.05);
    this.km = Math.min(this.total, this.km + kmPerSec * this.speed * Math.max(0, ts - last) / 1000);
    if (this.km >= this.total) {
      this.playing = false;
      this.draw(true);
      return;
    }
    this.draw();
    this.frame = this.raf(this.tick);
  };

  start(route: PlaybackRoute, autoplayDelayMs = 850) {
    const m = this.map();
    if (!m || route.stops.length === 0) return false;
    this.pause();
    this.removeLayers();
    this.route = route;
    this.cum = cumulativeKm(route.stops);
    this.km = 0;
    this.ensureLayers(route.color);
    this.src(SRC.ahead)?.setData({ type: "FeatureCollection", features: route.stops.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route.stops.map(s => [s.lng, s.lat]) } }] : [] });
    try { m.fitBounds(this.makeBounds(route.stops), { padding: 80, duration: 800, maxZoom: 15 }); } catch { /* bounds are best-effort */ }
    this.draw(true);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => { this.startTimer = null; if (this.route?.key === route.key) this.play(); }, autoplayDelayMs);
    return true;
  }

  play() {
    if (!this.route) return;
    if (this.km >= this.total) this.km = 0;
    this.playing = true;
    this.lastTs = null;
    this.emit(true);
    if (this.frame === null) this.frame = this.raf(this.tick);
  }

  pause() {
    this.playing = false;
    if (this.frame !== null) { this.cancelRaf(this.frame); this.frame = null; }
    if (this.route) this.emit(true);
  }

  restart() {
    this.pause();
    this.km = 0;
    this.draw(true);
    this.play();
  }

  setSpeed(s: number) { this.speed = s; this.emit(true); }

  seek(fraction: number) {
    this.km = Math.max(0, Math.min(this.total, this.total * fraction));
    this.draw(true);
  }

  stop() {
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
    this.pause();
    this.route = null;
    this.removeLayers();
    this.onChange(null);
  }

  /** Called when the component goes away: nothing left on the map, no timers. */
  dispose() {
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
    this.playing = false;
    if (this.frame !== null) { this.cancelRaf(this.frame); this.frame = null; }
    this.route = null;
    this.removeLayers();
  }
}

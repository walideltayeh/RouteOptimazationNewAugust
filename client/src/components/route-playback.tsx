import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import mapboxgl from "mapbox-gl";
import { Button } from "@/components/ui/button";
import { Play, Pause, RotateCcw, X, Car } from "lucide-react";
import { cumulativeKm, positionAt, drivingMinutes, type Stop } from "@/lib/route-playback-math";

/**
 * Route playback: a marker drives a day's route from stop 1 to the last,
 * drawing the journey behind it while a counter shows the kilometres and
 * stops so far. Distances are straight-line, the same ones the optimizer
 * plans with. The layers live on the map only while a playback is open.
 */
export interface PlaybackRoute {
  key: string;
  repName: string;
  dayLabel: string;
  color: string;
  stops: Stop[];
}

export interface PlaybackState {
  route: PlaybackRoute;
  playing: boolean;
  speed: number;
  km: number;
  totalKm: number;
  reached: number; // stops reached so far (1-based count)
  done: boolean;
}

const SRC = { trail: "playback-trail", ahead: "playback-ahead", head: "playback-head", stops: "playback-stops" };
const SECONDS_PER_ROUTE = 30; // at 1x, a whole day plays in half a minute

export function useRoutePlayback(map: MutableRefObject<mapboxgl.Map | null>, isMapLoaded: boolean) {
  const [state, setState] = useState<PlaybackState | null>(null);
  const routeRef = useRef<PlaybackRoute | null>(null);
  const cumRef = useRef<number[]>([]);
  const kmRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const lastPanelRef = useRef(0);

  const src = (id: string) => map.current?.getSource(id) as mapboxgl.GeoJSONSource | undefined;

  const ensureLayers = useCallback((color: string) => {
    const m = map.current;
    if (!m || m.getSource(SRC.trail)) return;
    const empty = { type: "FeatureCollection" as const, features: [] };
    m.addSource(SRC.ahead, { type: "geojson", data: empty });
    m.addLayer({ id: "playback-ahead", type: "line", source: SRC.ahead, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": color, "line-width": 3, "line-opacity": 0.2, "line-dasharray": [1, 2] } });
    m.addSource(SRC.trail, { type: "geojson", data: empty });
    m.addLayer({ id: "playback-trail", type: "line", source: SRC.trail, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": color, "line-width": 5, "line-opacity": 0.95 } });
    m.addSource(SRC.stops, { type: "geojson", data: empty });
    m.addLayer({ id: "playback-stops", type: "circle", source: SRC.stops, paint: { "circle-radius": 11, "circle-color": ["case", ["get", "visited"], color, "#ffffff"], "circle-stroke-width": 2, "circle-stroke-color": color } });
    m.addLayer({ id: "playback-stop-labels", type: "symbol", source: SRC.stops, layout: { "text-field": ["get", "order"], "text-size": 11, "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"], "text-allow-overlap": true }, paint: { "text-color": ["case", ["get", "visited"], "#ffffff", color] } });
    m.addSource(SRC.head, { type: "geojson", data: empty });
    m.addLayer({ id: "playback-head-glow", type: "circle", source: SRC.head, paint: { "circle-radius": 18, "circle-color": color, "circle-opacity": 0.25, "circle-blur": 0.6 } });
    m.addLayer({ id: "playback-head", type: "circle", source: SRC.head, paint: { "circle-radius": 8, "circle-color": "#111111", "circle-stroke-width": 3, "circle-stroke-color": "#ffffff" } });
    // The regular route lines fade so the journey stands out.
    for (const id of ["rep-routes-solid", "rep-routes-dashed"]) if (m.getLayer(id)) m.setPaintProperty(id, "line-opacity", 0.12);
    if (m.getLayer("rep-circles")) m.setPaintProperty("rep-circles", "circle-opacity", 0.25);
    if (m.getLayer("rep-labels")) m.setPaintProperty("rep-labels", "text-opacity", 0.25);
  }, [map]);

  const removeLayers = useCallback(() => {
    const m = map.current;
    if (!m) return;
    for (const id of ["playback-head", "playback-head-glow", "playback-stop-labels", "playback-stops", "playback-trail", "playback-ahead"]) if (m.getLayer(id)) m.removeLayer(id);
    for (const id of Object.values(SRC)) if (m.getSource(id)) m.removeSource(id);
    for (const id of ["rep-routes-solid", "rep-routes-dashed"]) if (m.getLayer(id)) m.setPaintProperty(id, "line-opacity", 0.6);
    if (m.getLayer("rep-circles")) m.setPaintProperty("rep-circles", "circle-opacity", 1);
    if (m.getLayer("rep-labels")) m.setPaintProperty("rep-labels", "text-opacity", 1);
  }, [map]);

  const draw = useCallback((km: number, force = false) => {
    const m = map.current;
    const route = routeRef.current;
    if (!m || !route) return;
    const pos = positionAt(route.stops, cumRef.current, km);
    src(SRC.trail)?.setData({ type: "FeatureCollection", features: pos.trail.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pos.trail } }] : [] });
    src(SRC.head)?.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [pos.lng, pos.lat] } }] });
    src(SRC.stops)?.setData({ type: "FeatureCollection", features: route.stops.map((s, i) => ({ type: "Feature", properties: { order: i + 1, visited: i <= pos.reached, name: s.name }, geometry: { type: "Point", coordinates: [s.lng, s.lat] } })) });
    // Keep the marker in view.
    const b = m.getBounds();
    if (b && !b.contains([pos.lng, pos.lat])) m.easeTo({ center: [pos.lng, pos.lat], duration: 600 });
    const now = performance.now();
    if (force || now - lastPanelRef.current > 100) {
      lastPanelRef.current = now;
      const total = cumRef.current[cumRef.current.length - 1] ?? 0;
      setState(prev => prev ? { ...prev, km: Math.min(km, total), totalKm: total, reached: pos.reached + 1, done: km >= total, playing: playingRef.current } : prev);
    }
  }, [map]);

  const tick = useCallback((ts: number) => {
    if (!playingRef.current) return;
    const last = lastTsRef.current ?? ts;
    lastTsRef.current = ts;
    const total = cumRef.current[cumRef.current.length - 1] ?? 0;
    const kmPerSec = Math.max(total / SECONDS_PER_ROUTE, 0.05);
    kmRef.current = Math.min(total, kmRef.current + kmPerSec * speedRef.current * ((ts - last) / 1000));
    draw(kmRef.current);
    if (kmRef.current >= total) {
      playingRef.current = false;
      draw(kmRef.current, true);
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [draw]);

  const play = useCallback(() => {
    if (!routeRef.current) return;
    const total = cumRef.current[cumRef.current.length - 1] ?? 0;
    if (kmRef.current >= total) kmRef.current = 0;
    playingRef.current = true;
    lastTsRef.current = null;
    setState(prev => prev ? { ...prev, playing: true, done: false } : prev);
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const pause = useCallback(() => {
    playingRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setState(prev => prev ? { ...prev, playing: false } : prev);
  }, []);

  const restart = useCallback(() => {
    pause();
    kmRef.current = 0;
    draw(0, true);
    play();
  }, [pause, draw, play]);

  const setSpeed = useCallback((s: number) => {
    speedRef.current = s;
    setState(prev => prev ? { ...prev, speed: s } : prev);
  }, []);

  const seek = useCallback((fraction: number) => {
    const total = cumRef.current[cumRef.current.length - 1] ?? 0;
    kmRef.current = Math.max(0, Math.min(total, total * fraction));
    draw(kmRef.current, true);
  }, [draw]);

  const stop = useCallback(() => {
    pause();
    routeRef.current = null;
    removeLayers();
    setState(null);
  }, [pause, removeLayers]);

  const start = useCallback((route: PlaybackRoute) => {
    const m = map.current;
    if (!m || !isMapLoaded || route.stops.length === 0) return;
    pause();
    removeLayers();
    routeRef.current = route;
    cumRef.current = cumulativeKm(route.stops);
    kmRef.current = 0;
    speedRef.current = state?.speed ?? 1;
    ensureLayers(route.color);
    src(SRC.ahead)?.setData({ type: "FeatureCollection", features: route.stops.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route.stops.map(s => [s.lng, s.lat]) } }] : [] });
    const bounds = new mapboxgl.LngLatBounds();
    route.stops.forEach(s => bounds.extend([s.lng, s.lat]));
    m.fitBounds(bounds, { padding: 80, duration: 800 });
    const total = cumRef.current[cumRef.current.length - 1] ?? 0;
    setState({ route, playing: false, speed: speedRef.current, km: 0, totalKm: total, reached: 0, done: false });
    draw(0, true);
    // Let the camera settle, then go.
    setTimeout(() => { if (routeRef.current?.key === route.key) play(); }, 850);
  }, [map, isMapLoaded, pause, removeLayers, ensureLayers, draw, play, state?.speed]);

  // Tear down with the component.
  useEffect(() => () => { playingRef.current = false; if (rafRef.current) cancelAnimationFrame(rafRef.current); removeLayers(); }, [removeLayers]);

  return { state, start, stop, play, pause, restart, setSpeed, seek };
}

export function RoutePlaybackPanel({ state, onPlay, onPause, onRestart, onStop, onSpeed, onSeek }: {
  state: PlaybackState;
  onPlay: () => void; onPause: () => void; onRestart: () => void; onStop: () => void;
  onSpeed: (s: number) => void; onSeek: (fraction: number) => void;
}) {
  const n = state.route.stops.length;
  const fraction = state.totalKm > 0 ? state.km / state.totalKm : 1;
  const current = Math.min(n, Math.max(1, state.reached));
  const stopName = state.route.stops[current - 1]?.name ?? "";
  return (
    <div className="absolute bottom-3 left-3 z-30 w-[min(420px,calc(100%-24px))] rounded-xl border border-[#e5e5e5] bg-white/95 p-3 shadow-lg backdrop-blur dark:border-[#38383a] dark:bg-[#1c1c1e]/95" data-testid="route-playback">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: state.route.color }} />
            <span className="truncate">{state.route.repName} · {state.route.dayLabel}</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-[#6e6e73]" title={stopName}>
            {state.done ? `Route complete · ${n} stops` : `Stop ${current} of ${n}${stopName ? ` · ${stopName}` : ""}`}
          </div>
        </div>
        <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={onStop} aria-label="Close playback"><X className="h-4 w-4" /></Button>
      </div>

      <div className="mt-2 flex items-baseline gap-3">
        <div className="text-2xl font-semibold tabular-nums" data-testid="text-playback-km">{state.km.toFixed(1)}<span className="ml-1 text-sm font-normal text-[#6e6e73]">of {state.totalKm.toFixed(1)} km</span></div>
        <div className="flex items-center gap-1 text-xs text-[#6e6e73]"><Car className="h-3.5 w-3.5" /> ~{Math.round(drivingMinutes(state.km))} min driving</div>
      </div>

      <input
        type="range" min={0} max={1000} value={Math.round(fraction * 1000)}
        onChange={e => onSeek(Number(e.target.value) / 1000)}
        className="mt-2 w-full accent-[#8B0000]" aria-label="Position along the route" data-testid="slider-playback"
      />

      <div className="mt-2 flex items-center gap-1.5">
        {state.playing
          ? <Button size="sm" className="h-7 rounded-full px-3" onClick={onPause} data-testid="button-playback-pause"><Pause className="mr-1 h-3.5 w-3.5" /> Pause</Button>
          : <Button size="sm" className="h-7 rounded-full px-3" onClick={onPlay} data-testid="button-playback-play"><Play className="mr-1 h-3.5 w-3.5" /> {state.done ? "Replay" : state.km > 0 ? "Resume" : "Play"}</Button>}
        <Button size="sm" variant="outline" className="h-7 rounded-full px-2" onClick={onRestart} title="Restart"><RotateCcw className="h-3.5 w-3.5" /></Button>
        <div className="ml-auto flex items-center gap-1">
          {[1, 2, 4].map(s => (
            <button key={s} type="button" onClick={() => onSpeed(s)} className={`rounded-full px-2 py-0.5 text-xs ${state.speed === s ? "bg-[#1d1d1f] text-white" : "bg-[#f5f5f7] text-[#1d1d1f] hover:bg-[#e8e8ed]"}`} data-testid={`button-speed-${s}`}>{s}x</button>
          ))}
        </div>
      </div>
      <p className="mt-1.5 text-[11px] text-[#86868b]">Straight-line distances, as the optimizer plans them. Driving time assumes 25 km/h in town.</p>
    </div>
  );
}

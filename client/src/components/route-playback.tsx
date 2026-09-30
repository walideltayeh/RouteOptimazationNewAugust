import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import mapboxgl from "mapbox-gl";
import { Button } from "@/components/ui/button";
import { Play, Pause, RotateCcw, X, Car } from "lucide-react";
import { drivingMinutes, type Stop } from "@/lib/route-playback-math";
import { PlaybackEngine, type PlaybackRoute, type PlaybackSnapshot, type RoadPath } from "@/lib/route-playback-engine";

export type { PlaybackRoute };
export type PlaybackState = PlaybackSnapshot;

/**
 * Route playback: a marker drives a day's route from stop 1 to the last,
 * drawing the journey behind it while a counter shows the kilometres and
 * stops so far. The engine (client/src/lib/route-playback-engine.ts) does
 * the work and is tested against a fake map; this hook binds it to React
 * and Mapbox, and asks the server for the road line of the route. When a
 * road server is configured the marker follows real streets and the
 * kilometres and minutes are road figures; otherwise straight lines.
 */
export function useRoutePlayback(map: MutableRefObject<mapboxgl.Map | null>, isMapLoaded: boolean, onError?: (message: string) => void) {
  const [state, setState] = useState<PlaybackState | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new PlaybackEngine(
      () => map.current as any,
      (s) => setState(s),
      (stops: Stop[]) => { const b = new mapboxgl.LngLatBounds(); stops.forEach(s => b.extend([s.lng, s.lat])); return b; },
    );
  }
  const engine = engineRef.current;
  const roadCache = useRef(new Map<string, RoadPath | null>());

  useEffect(() => () => engine.dispose(), [engine]);

  const start = useCallback((route: PlaybackRoute) => {
    if (!map.current || !isMapLoaded) { onError?.("The map is still loading; try again in a moment."); return; }
    try {
      const cached = route.scheduleId ? roadCache.current.get(route.scheduleId) : undefined;
      if (!engine.start(route, 850, cached ?? null)) { onError?.("This route has no stops to play."); return; }
      // Straight lines start at once; the road line replaces them when it arrives.
      if (route.scheduleId && cached === undefined) {
        const id = route.scheduleId;
        fetch(`/api/schedules/${id}/road-route`, { credentials: "include" })
          .then(async res => (res.ok ? (await res.json()) as RoadPath & { stopIds: string[] } : null))
          .then(road => {
            if (!road) { roadCache.current.set(id, null); return; }
            const ok = road.stopIds.length === route.stops.length && road.stopIds.every((sid, i) => sid === route.stops[i].id);
            const path: RoadPath | null = ok ? { coordinates: road.coordinates, stopKm: road.stopKm, distanceKm: road.distanceKm, durationMin: road.durationMin } : null;
            roadCache.current.set(id, path);
            if (path) engine.upgradeToRoad(route.key, path);
          })
          .catch(() => roadCache.current.set(id, null));
      }
    } catch (err) {
      console.error("[playback] could not start:", err);
      onError?.((err as Error)?.message || "Could not start the playback.");
      try { engine.stop(); } catch { /* nothing else to do */ }
    }
  }, [engine, map, isMapLoaded, onError]);

  return {
    state,
    start,
    stop: useCallback(() => engine.stop(), [engine]),
    play: useCallback(() => engine.play(), [engine]),
    pause: useCallback(() => engine.pause(), [engine]),
    restart: useCallback(() => engine.restart(), [engine]),
    setSpeed: useCallback((s: number) => engine.setSpeed(s), [engine]),
    seek: useCallback((f: number) => engine.seek(f), [engine]),
  };
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
  const minutes = state.source === "road" && state.durationMin !== undefined
    ? state.durationMin * fraction
    : drivingMinutes(state.km);
  return (
    <div className="absolute bottom-3 left-3 z-30 w-[min(420px,calc(100%-24px))] rounded-xl border border-[#e5e5e5] bg-white/95 p-3 shadow-lg backdrop-blur dark:border-[#38383a] dark:bg-[#1c1c1e]/95" data-testid="route-playback">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: state.route.color }} />
            <span className="truncate">{state.route.repName} · {state.route.dayLabel}</span>
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${state.source === "road" ? "bg-green-50 text-green-700" : "bg-[#f5f5f7] text-[#6e6e73]"}`} data-testid="badge-playback-source">
              {state.source === "road" ? "Road" : "Straight line"}
            </span>
          </div>
          <div className="mt-0.5 truncate text-xs text-[#6e6e73]" title={stopName}>
            {state.done ? `Route complete · ${n} stops` : `Stop ${current} of ${n}${stopName ? ` · ${stopName}` : ""}`}
          </div>
        </div>
        <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={onStop} aria-label="Close playback"><X className="h-4 w-4" /></Button>
      </div>

      <div className="mt-2 flex items-baseline gap-3">
        <div className="text-2xl font-semibold tabular-nums" data-testid="text-playback-km">{state.km.toFixed(1)}<span className="ml-1 text-sm font-normal text-[#6e6e73]">of {state.totalKm.toFixed(1)} km</span></div>
        <div className="flex items-center gap-1 text-xs text-[#6e6e73]"><Car className="h-3.5 w-3.5" /> ~{Math.round(minutes)} min driving</div>
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
      <p className="mt-1.5 text-[11px] text-[#86868b]">
        {state.source === "road"
          ? "Road distance and driving time from the road server."
          : "Straight-line distances, as the optimizer plans them without a road server. Driving time assumes 25 km/h in town."}
      </p>
    </div>
  );
}

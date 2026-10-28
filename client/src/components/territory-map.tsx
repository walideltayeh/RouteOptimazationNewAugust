import { useEffect, useRef, useState, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MapPin, Users, Navigation, Trash2, RefreshCw, Download, X, LassoSelect, Layers } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTheme } from '@/lib/theme';
import { apiRequest } from '@/lib/queryClient';
import { runJob } from '@/lib/jobs';
import type { Outlet, Rep } from '@shared/schema';

// Set a default token or use environment variable
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || import.meta.env.VITE_MAPBOX_PUBLIC_KEY;
if (MAPBOX_TOKEN && MAPBOX_TOKEN !== 'demo_token' && !MAPBOX_TOKEN.includes('your_') && MAPBOX_TOKEN.length > 10) {
  mapboxgl.accessToken = MAPBOX_TOKEN;
}

interface TerritoryMapProps {
  className?: string;
}

// Territory colors for visual distinction
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const HELD_OUT_LABEL = 'Held out (duplicates)';
const FAR_AWAY_LABEL = 'Needs review (far from the area)';
const UNOWNED_LABELS: Record<string, string> = {
  [HELD_OUT_LABEL]: 'Duplicates you chose to hold out of the plan. They are kept on file and can be restored from the dashboard.',
  [FAR_AWAY_LABEL]: 'Further from the core area than the max zone radius, so they were left out of the routes. Raise the radius or fix the coordinates, then optimize again.',
  'Unassigned': 'Not in any rep\'s plan. Run a new optimization to place them.',
};
const TERRITORY_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
];

// Mapbox cannot swap a base style under layers already drawn, so a theme
// switch remounts the map on the matching base map.
export default function TerritoryMap(props: TerritoryMapProps) {
  const theme = useTheme();
  return <TerritoryMapView key={theme} {...props} />;
}

function TerritoryMapView({ className }: TerritoryMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const drilldownLayersRef = useRef<string[]>([]);
  const drilldownHandlersRef = useRef<{ layerId: string; click: any; mouseenter: any; mouseleave: any }[]>([]);
  const [selectedOutlet, setSelectedOutlet] = useState<Outlet | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [isRenderingMarkers, setIsRenderingMarkers] = useState(false);
  const [viewMode, setViewMode] = useState<'cluster' | 'individual'>('cluster');
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [needsReoptimization, setNeedsReoptimization] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  // Lasso selection: draw a loop around outlets, delete them together, then
  // see what that did to the count and re-plan from scratch.
  const [lassoActive, setLassoActive] = useState(false);
  const lassoActiveRef = useRef(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectedCountRef = useRef(0);
  const outletsRef = useRef<Outlet[]>([]);
  const [deleteSummary, setDeleteSummary] = useState<{ before: number; deleted: number; after: number } | null>(null);
  const [showLassoDeleteConfirm, setShowLassoDeleteConfirm] = useState(false);
  // Move the selection to another rep; the touched territories are re-planned
  // on the spot by the server, and the result is shown here.
  const [reassignTargetId, setReassignTargetId] = useState<string>('');
  const [reworkSummary, setReworkSummary] = useState<{
    movedOutlets: number; toRep: { id: string; name: string };
    repsReworked: { repId: string; name: string; outlets: number; monthlyVisits: number; schedules: number; overCapacity: boolean }[];
    warnings: string[];
  } | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: mapboxConfig, isLoading: isMapboxConfigLoading } = useQuery<{ token?: string }>({
    queryKey: ['/api/config/mapbox'],
  });
  const resolvedMapboxToken = mapboxConfig?.token || MAPBOX_TOKEN;

  const { data: outlets = [] } = useQuery<Outlet[]>({
    queryKey: ['/api/outlets'],
  });

  const { data: reps = [] } = useQuery<Rep[]>({
    queryKey: ['/api/reps'],
  });
  useEffect(() => { outletsRef.current = outlets; }, [outlets]);
  useEffect(() => { lassoActiveRef.current = lassoActive; }, [lassoActive]);
  useEffect(() => { selectedCountRef.current = selectedIds.size; }, [selectedIds]);

  // Changed your mind: drop the selection, any pending delete, and the tool.
  const cancelSelection = () => {
    setSelectedIds(prev => (prev.size ? new Set() : prev));
    setShowLassoDeleteConfirm(false);
    setLassoActive(false);
  };

  // The settings the last plan ran with; "optimize from scratch" reuses them.
  const { data: planSettings } = useQuery<any>({ queryKey: ['/api/plan-settings'] });

  const deleteManyMutation = useMutation({
    mutationFn: async (outletIds: string[]) => {
      const res = await apiRequest("POST", "/api/outlets/delete-many", { outletIds });
      return res.json() as Promise<{ before: number; deleted: number; after: number }>;
    },
    onSuccess: (r) => {
      setDeleteSummary(prev => prev ? { before: prev.before, deleted: prev.deleted + r.deleted, after: r.after } : r);
      setSelectedIds(new Set());
      setShowLassoDeleteConfirm(false);
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      queryClient.invalidateQueries({ queryKey: ['/api/outlets/duplicates'] });
      toast({ title: `${r.deleted} outlet${r.deleted === 1 ? '' : 's'} deleted`, description: `${r.before.toLocaleString()} before, ${r.after.toLocaleString()} now.` });
    },
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  // Reps ranked by how close their territory is to the selection: the
  // nearest outlet of each rep to the selection's centre. A rep that already
  // owns part of the selection is listed with that count.
  const rankedTargetReps = useMemo(() => {
    if (selectedIds.size === 0) return [] as { rep: Rep; distKm: number; owns: number }[];
    const sel = outlets.filter(o => selectedIds.has(o.id));
    if (sel.length === 0) return [];
    const cLat = sel.reduce((a, o) => a + o.latitude, 0) / sel.length;
    const cLng = sel.reduce((a, o) => a + o.longitude, 0) / sel.length;
    const nearest = new Map<string, number>();
    const owns = new Map<string, number>();
    for (const o of outlets) {
      if (!o.repId || o.territory === 'Excluded') continue;
      if (selectedIds.has(o.id)) { owns.set(o.repId, (owns.get(o.repId) ?? 0) + 1); continue; }
      const d = haversineKm(cLat, cLng, o.latitude, o.longitude);
      const cur = nearest.get(o.repId);
      if (cur === undefined || d < cur) nearest.set(o.repId, d);
    }
    return reps
      .map(rep => ({ rep, distKm: nearest.get(rep.id) ?? Infinity, owns: owns.get(rep.id) ?? 0 }))
      .sort((a, b) => a.distKm - b.distKm);
  }, [selectedIds, outlets, reps]);

  // Default the target to the nearest rep that does not already own the
  // whole selection.
  useEffect(() => {
    if (rankedTargetReps.length === 0) { setReassignTargetId(''); return; }
    const first = rankedTargetReps.find(r => r.owns < selectedIds.size) ?? rankedTargetReps[0];
    setReassignTargetId(prev => (prev && rankedTargetReps.some(r => r.rep.id === prev)) ? prev : first.rep.id);
  }, [rankedTargetReps, selectedIds.size]);

  const reassignSelectionMutation = useMutation({
    mutationFn: async ({ outletIds, toRepId }: { outletIds: string[]; toRepId: string }) => {
      const res = await apiRequest("POST", "/api/reps/reassign-outlets", { outletIds, toRepId });
      return res.json() as Promise<{
        movedOutlets: number; toRep: { id: string; name: string };
        repsReworked: { repId: string; name: string; outlets: number; monthlyVisits: number; schedules: number; overCapacity: boolean }[];
        warnings: string[]; message: string;
      }>;
    },
    onSuccess: (r) => {
      setReworkSummary({ movedOutlets: r.movedOutlets, toRep: r.toRep, repsReworked: r.repsReworked || [], warnings: r.warnings || [] });
      setSelectedIds(new Set());
      setLassoActive(false);
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      queryClient.invalidateQueries({ queryKey: ['/api/reps'] });
      const n = (r.repsReworked || []).length;
      toast({ title: `${r.movedOutlets} outlet${r.movedOutlets === 1 ? '' : 's'} moved to ${r.toRep.name}`, description: `${n} territor${n === 1 ? 'y' : 'ies'} re-planned.` });
    },
    onError: (e: Error) => toast({ title: "Move failed", description: e.message, variant: "destructive" }),
  });

  // A fresh optimization on the outlets that remain, with the settings the
  // last plan used - the same as starting a new optimization from the
  // dashboard, without re-entering anything.
  const freshOptimizeMutation = useMutation({
    mutationFn: async () => {
      if (!planSettings?.configured) throw new Error("No saved settings yet - run an optimization from the dashboard first.");
      const body = {
        workingDays: planSettings.workingDays,
        workingDaysPerWeek: planSettings.workingDays?.length,
        cycleMode: planSettings.cycleMode,
        planMonth: planSettings.planMonth,
        monthEdges: planSettings.monthEdges,
        cycleWorkingDays: planSettings.cycleMode === 'calendarMonth' ? 0 : planSettings.cycleWorkingDays,
        minVisitsPerDay: planSettings.minVisitsPerDay,
        maxVisitsPerDay: planSettings.maxVisitsPerDay,
        weightMode: planSettings.weightMode,
        distanceMode: planSettings.distanceMode,
        maxZoneRadiusKm: planSettings.maxZoneRadiusKm,
        maxHopKm: planSettings.maxHopKm,
      };
      return runJob("/api/optimize", body);
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      queryClient.invalidateQueries({ queryKey: ['/api/reps'] });
      queryClient.invalidateQueries({ queryKey: ['/api/plan-settings'] });
      setDeleteSummary(null);
      setNeedsReoptimization(false);
      toast({ title: "New plan ready", description: data?.message || "Optimization complete." });
    },
    onError: (e: Error) => toast({ title: "Optimization failed", description: e.message, variant: "destructive" }),
  });

  // Delete outlet mutation
  const deleteMutation = useMutation({
    mutationFn: async (outletId: string) => {
      await apiRequest("DELETE", `/api/outlets/${outletId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      toast({ title: "Success", description: "Outlet deleted successfully" });
      setSelectedOutlet(null);
      setShowDeleteConfirm(false);
      setNeedsReoptimization(true);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete outlet", variant: "destructive" });
    }
  });

  // Reoptimize mutation
  const reoptimizeMutation = useMutation({
    mutationFn: async () => {
      // No body: the server rebuilds every rep's routes with the settings
      // the plan was built on. This used to post 15-25 visits over a
      // five-day week, whatever the dashboard said.
      return runJob("/api/reoptimize", {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      queryClient.invalidateQueries({ queryKey: ['/api/reps'] });
      toast({ title: "Routes rebuilt", description: "Every rep's routes were re-planned with the saved settings." });
      setNeedsReoptimization(false);
      setReworkSummary(null);
      setIsOptimizing(false);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to reoptimize routes", variant: "destructive" });
      setIsOptimizing(false);
    }
  });

  const handleDeleteOutlet = () => {
    if (!selectedOutlet) return;
    deleteMutation.mutate(selectedOutlet.id);
  };

  // Excel of the map as it is right now: every outlet with its rep, territory,
  // code, coordinates and route days; a sheet per rep; the held-out duplicates.
  const [isExporting, setIsExporting] = useState(false);
  const exportTerritories = async (repId?: string) => {
    setIsExporting(true);
    try {
      const response = await fetch(repId ? `/api/export/territories?repId=${encodeURIComponent(repId)}` : '/api/export/territories');
      if (!response.ok) {
        let msg = 'Export failed';
        try { msg = (await response.json()).message || msg; } catch {}
        throw new Error(msg);
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const name = /filename=([^;]+)/.exec(disposition)?.[1]?.trim() || `territory_map_${new Date().toISOString().split('T')[0]}.xlsx`;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      window.URL.revokeObjectURL(url); document.body.removeChild(a);
      toast({ title: 'Exported', description: `${name} - ${outlets.length.toLocaleString()} outlets as they stand now.` });
    } catch (e: any) {
      toast({ title: 'Export failed', description: e?.message || 'Could not build the Excel file', variant: 'destructive' });
    } finally {
      setIsExporting(false);
    }
  };

  // Ray-casting point-in-polygon on lng/lat; fine at city scale.
  const insidePolygon = (pt: [number, number], ring: [number, number][]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      const hit = ((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < ((xj - xi) * (pt[1] - yi)) / ((yj - yi) || 1e-12) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  };

  // Lasso: while the tool is on, dragging on the map draws a loop instead of
  // panning; releasing selects every outlet inside it. Shift adds to the
  // current selection. Works with touch as well as the mouse. Esc while
  // drawing drops the loop and keeps the selection as it was; Esc otherwise
  // cancels the selection and leaves the tool.
  useEffect(() => {
    const m = map.current;
    if (!m || !isMapLoaded) return;
    // Listen on the container, not the canvas: the territory clusters are
    // DOM markers sitting over the canvas, and a loop drawn across them
    // must not break. Capture phase so the markers never see the drag.
    const canvas = m.getCanvasContainer();
    const mapCanvas = m.getCanvas();
    let drawing = false;
    let ring: [number, number][] = [];
    const LASSO_SRC = 'lasso-src';
    const ensureLayers = () => {
      if (!m.getSource(LASSO_SRC)) {
        m.addSource(LASSO_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({ id: 'lasso-fill', type: 'fill', source: LASSO_SRC, paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.12 } });
        m.addLayer({ id: 'lasso-line', type: 'line', source: LASSO_SRC, paint: { 'line-color': '#2563eb', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
      }
    };
    const draw = () => {
      ensureLayers();
      const src = m.getSource(LASSO_SRC) as mapboxgl.GeoJSONSource;
      src.setData(ring.length > 2
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, properties: {} }] }
        : { type: 'FeatureCollection', features: [] });
    };
    const pointOf = (e: MouseEvent | TouchEvent): [number, number] => {
      const rect = mapCanvas.getBoundingClientRect();
      const src = 'touches' in e ? (e.touches[0] ?? (e as TouchEvent).changedTouches[0]) : (e as MouseEvent);
      const ll = m.unproject([src.clientX - rect.left, src.clientY - rect.top]);
      return [ll.lng, ll.lat];
    };
    const start = (e: MouseEvent | TouchEvent) => {
      if (!lassoActiveRef.current) return;
      if ('button' in e && e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      drawing = true; ring = [pointOf(e)]; draw();
    };
    const move = (e: MouseEvent | TouchEvent) => {
      if (!drawing) return;
      e.preventDefault(); e.stopPropagation();
      ring.push(pointOf(e)); draw();
    };
    const end = (e: MouseEvent | TouchEvent) => {
      if (!drawing) return;
      drawing = false;
      const additive = 'shiftKey' in e && (e as MouseEvent).shiftKey;
      if (ring.length > 2) {
        const hit = outletsRef.current.filter(o => insidePolygon([o.longitude, o.latitude], ring)).map(o => o.id);
        setSelectedIds(prev => {
          const next = additive ? new Set(prev) : new Set<string>();
          hit.forEach(id => next.add(id));
          return next;
        });
      }
      ring = []; draw();
    };
    const onKey = (e: KeyboardEvent) => {
      // An open dropdown or dialog takes Esc for itself first.
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (drawing) { drawing = false; ring = []; draw(); e.preventDefault(); return; }
      if (!lassoActiveRef.current && selectedCountRef.current === 0) return;
      e.preventDefault();
      setSelectedIds(prev => (prev.size ? new Set() : prev));
      setShowLassoDeleteConfirm(false);
      setLassoActive(false);
    };
    canvas.addEventListener('mousedown', start, true);
    canvas.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', end, true);
    canvas.addEventListener('touchstart', start, { passive: false, capture: true });
    canvas.addEventListener('touchmove', move, { passive: false, capture: true });
    window.addEventListener('touchend', end, true);
    window.addEventListener('keydown', onKey);
    return () => {
      canvas.removeEventListener('mousedown', start, true);
      canvas.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', end, true);
      canvas.removeEventListener('touchstart', start, true);
      canvas.removeEventListener('touchmove', move, true);
      window.removeEventListener('touchend', end, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [isMapLoaded]);

  // The tool takes over dragging while it is on.
  useEffect(() => {
    const m = map.current;
    if (!m || !isMapLoaded) return;
    if (lassoActive) { m.dragPan.disable(); m.getCanvas().style.cursor = 'crosshair'; }
    else { m.dragPan.enable(); m.getCanvas().style.cursor = ''; }
  }, [lassoActive, isMapLoaded]);

  // Selected outlets get a ring so the selection reads on the map.
  useEffect(() => {
    const m = map.current;
    if (!m || !isMapLoaded) return;
    const SRC = 'selected-outlets-src';
    const features = outlets.filter(o => selectedIds.has(o.id)).map(o => ({
      type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [o.longitude, o.latitude] }, properties: { id: o.id },
    }));
    const data = { type: 'FeatureCollection' as const, features };
    if (!m.getSource(SRC)) {
      m.addSource(SRC, { type: 'geojson', data });
      m.addLayer({ id: 'selected-outlets', type: 'circle', source: SRC, paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 3, 'circle-stroke-color': '#dc2626' } });
    } else {
      (m.getSource(SRC) as mapboxgl.GeoJSONSource).setData(data);
    }
  }, [selectedIds, outlets, isMapLoaded]);

  // Initialize map
  useEffect(() => {
    if (map.current || !mapContainer.current || isMapboxConfigLoading) return;

    try {
      if (!resolvedMapboxToken || resolvedMapboxToken === 'demo_token' || resolvedMapboxToken.includes('your_') || resolvedMapboxToken.length <= 10) {
        setMapError('Mapbox token is not configured.');
        return;
      }
      mapboxgl.accessToken = resolvedMapboxToken;

      // No home city: the outlets decide where the map goes (fitBounds on
      // render). Until they load, show the world rather than someone else's
      // country.
      map.current = new mapboxgl.Map({
        container: mapContainer.current,
        style: document.documentElement.classList.contains('dark') ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/light-v11',
        center: [20, 20],
        zoom: 1.5
      });

      map.current.on('load', () => {
        setIsMapLoaded(true);
      });

      map.current.on('error', (e) => {
        console.error('Map error:', e);
        setMapError('Failed to load map. Please check your Mapbox token.');
      });

      return () => {
        if (map.current) {
          map.current.remove();
        }
      };
    } catch (error) {
      console.error('Failed to initialize map:', error);
      setMapError('Failed to initialize map. Please check your configuration.');
    }
  }, [isMapboxConfigLoading, resolvedMapboxToken]);

  // Cluster-based rendering for massive datasets
  useEffect(() => {
    if (!map.current || !isMapLoaded || outlets.length === 0) return;

    setIsRenderingMarkers(true);

    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    drilldownHandlersRef.current.forEach(({ layerId, click, mouseenter, mouseleave }) => {
      if (map.current) {
        map.current.off('click', layerId, click);
        map.current.off('mouseenter', layerId, mouseenter);
        map.current.off('mouseleave', layerId, mouseleave);
      }
    });
    drilldownHandlersRef.current = [];
    clearDrilldownLayers();

    if (viewMode === 'cluster') {
      renderTerritoryVisualization();
      const drilled = drilledTerritoryRef.current;
      if (drilled && territoryGroups[drilled]?.length) drillIntoTerritory(drilled);
      else drilledTerritoryRef.current = null;
    } else {
      drilledTerritoryRef.current = null;
      renderGeoJSONIndividualView();
    }
    // Keep the selection rings above whatever was just drawn.
    if (map.current.getLayer('selected-outlets')) map.current.moveLayer('selected-outlets');

  }, [outlets, isMapLoaded, viewMode]);

  // Remove every layer we drew, then every source. Mapbox will not remove a
  // source while a layer still uses it - it only fires an error event - so
  // removing in push order used to leave sources behind, and the "source
  // already there" guard below then skipped re-drawing the layer: after any
  // change to the outlet list the individual view went blank.
  const clearDrilldownLayers = () => {
    const m = map.current;
    if (!m) return;
    const ids = drilldownLayersRef.current;
    ids.forEach(id => { if (m.getLayer(id)) m.removeLayer(id); });
    ids.forEach(id => { if (m.getSource(id)) m.removeSource(id); });
    drilldownLayersRef.current = [];
  };

  // Zoom into one territory and draw its outlets one by one. Remembered in
  // drilledTerritoryRef so a data refresh (a deletion, a re-plan) re-opens the
  // same territory instead of dropping back to the cluster bubbles.
  const drilledTerritoryRef = useRef<string | null>(null);
  const drillIntoTerritory = (territory: string) => {
    const territoryOutlets = territoryGroups[territory];
    if (!territoryOutlets || territoryOutlets.length === 0 || !map.current) return;
    drilledTerritoryRef.current = territory;
    const territoryBounds = new mapboxgl.LngLatBounds();
    territoryOutlets.forEach(outlet => {
      territoryBounds.extend([outlet.longitude, outlet.latitude]);
    });
    map.current!.fitBounds(territoryBounds, { padding: 50 });

    drilldownHandlersRef.current.forEach(({ layerId, click, mouseenter, mouseleave }) => {
      if (map.current) {
        map.current.off('click', layerId, click);
        map.current.off('mouseenter', layerId, mouseenter);
        map.current.off('mouseleave', layerId, mouseleave);
      }
    });
    drilldownHandlersRef.current = [];
    clearDrilldownLayers();

    const sourceId = `drilldown-source-${territory}`;
    const circleLayerId = `drilldown-circles-${territory}`;
    const symbolLayerId = `drilldown-labels-${territory}`;
    const color = getTerritoryColor(territory);

    const geojson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: territoryOutlets.map((outlet, idx) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [outlet.longitude, outlet.latitude] },
        properties: { id: outlet.id, name: outlet.name, index: idx + 1, outletJson: JSON.stringify(outlet) }
      }))
    };

    map.current!.addSource(sourceId, { type: 'geojson', data: geojson });
    map.current!.addLayer({
      id: circleLayerId,
      type: 'circle',
      source: sourceId,
      paint: {
        'circle-radius': 6,
        'circle-color': color,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff'
      }
    });
    map.current!.addLayer({
      id: symbolLayerId,
      type: 'symbol',
      source: sourceId,
      layout: {
        'text-field': ['get', 'index'],
        'text-size': 9,
        'text-offset': [0, -1.2]
      },
      paint: { 'text-color': color }
    });

    drilldownLayersRef.current.push(circleLayerId, symbolLayerId, sourceId);

    const clickHandler = (e: any) => {
      if (e.features && e.features[0]) {
        const props = e.features[0].properties;
        if (props?.outletJson) {
          setSelectedOutlet(JSON.parse(props.outletJson));
        }
      }
    };
    const mouseenterHandler = () => {
      if (map.current) map.current.getCanvas().style.cursor = 'pointer';
    };
    const mouseleaveHandler = () => {
      if (map.current) map.current.getCanvas().style.cursor = '';
    };

    map.current!.on('click', circleLayerId, clickHandler);
    map.current!.on('mouseenter', circleLayerId, mouseenterHandler);
    map.current!.on('mouseleave', circleLayerId, mouseleaveHandler);

    drilldownHandlersRef.current.push({
      layerId: circleLayerId,
      click: clickHandler,
      mouseenter: mouseenterHandler,
      mouseleave: mouseleaveHandler
    });
  };

  // Render territory clusters instead of individual markers for performance
  const renderTerritoryVisualization = () => {
    const bounds = new mapboxgl.LngLatBounds();
    
    Object.entries(territoryGroups).forEach(([territory, territoryOutlets]) => {
      if (territoryOutlets.length === 0) return;
      
      // Calculate territory center
      const centerLat = territoryOutlets.reduce((sum, o) => sum + o.latitude, 0) / territoryOutlets.length;
      const centerLng = territoryOutlets.reduce((sum, o) => sum + o.longitude, 0) / territoryOutlets.length;
      
      bounds.extend([centerLng, centerLat]);

      // Create cluster marker for territory
      const clusterEl = document.createElement('div');
      clusterEl.className = 'cluster-marker flex items-center justify-center rounded-full border-2 border-white shadow-lg cursor-pointer hover:scale-110 transition-transform font-semibold text-white text-xs';
      
      // Size based on outlet count
      const size = Math.min(Math.max(20 + Math.log(territoryOutlets.length) * 8, 24), 60);
      clusterEl.style.width = `${size}px`;
      clusterEl.style.height = `${size}px`;
      clusterEl.style.backgroundColor = getTerritoryColor(territory);
      clusterEl.textContent = territoryOutlets.length.toString();
      
      // Add territory info on hover
      const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(`
        <div class="p-2">
          <h3 class="font-semibold text-sm">${territory}</h3>
          <p class="text-xs text-muted-foreground">${territoryOutlets.length} outlets</p>
          <p class="text-xs text-muted-foreground">VF2: ${territoryOutlets.filter(o => o.visitFrequency === 2).length} | VF4: ${territoryOutlets.filter(o => o.visitFrequency === 4).length}</p>
        </div>
      `);

      clusterEl.addEventListener('click', () => drillIntoTerritory(territory));

      const marker = new mapboxgl.Marker(clusterEl)
        .setLngLat([centerLng, centerLat])
        .setPopup(popup)
        .addTo(map.current!);
      markersRef.current.push(marker);
    });

    // Fit map to show all territories
    if (Object.keys(territoryGroups).length > 0) {
      map.current!.fitBounds(bounds, { padding: 50 });
    }
    
    setIsRenderingMarkers(false);
  };

  const renderGeoJSONIndividualView = () => {
    const bounds = new mapboxgl.LngLatBounds();

    Object.entries(territoryGroups).forEach(([territory, territoryOutlets]) => {
      if (territoryOutlets.length === 0) return;
      const safeTerritory = territory.replace(/[^a-zA-Z0-9]/g, '_');
      const sourceId = `individual-source-${safeTerritory}`;
      const circleLayerId = `individual-circles-${safeTerritory}`;
      const color = getTerritoryColor(territory);

      const features = territoryOutlets.map((outlet, idx) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [outlet.longitude, outlet.latitude] },
        properties: { id: outlet.id, name: outlet.name, address: outlet.address || '', territory, index: idx + 1, outletJson: JSON.stringify(outlet) }
      }));

      territoryOutlets.forEach(o => bounds.extend([o.longitude, o.latitude]));

      const existing = map.current!.getSource(sourceId) as mapboxgl.GeoJSONSource | undefined;
      if (existing) existing.setData({ type: 'FeatureCollection', features });
      else map.current!.addSource(sourceId, { type: 'geojson', data: { type: 'FeatureCollection', features } });
      if (!map.current!.getLayer(circleLayerId)) {

        map.current!.addLayer({
          id: circleLayerId,
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 6,
            'circle-color': color,
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#ffffff'
          }
        });

        drilldownLayersRef.current.push(sourceId, circleLayerId);

        const clickHandler = (e: any) => {
          if (e.features && e.features[0]) {
            const props = e.features[0].properties;
            try {
              const outlet = JSON.parse(props.outletJson);
              setSelectedOutlet(outlet);
            } catch {}
          }
        };
        const mouseenterHandler = () => { if (map.current) map.current.getCanvas().style.cursor = 'pointer'; };
        const mouseleaveHandler = () => { if (map.current) map.current.getCanvas().style.cursor = ''; };

        map.current!.on('click', circleLayerId, clickHandler);
        map.current!.on('mouseenter', circleLayerId, mouseenterHandler);
        map.current!.on('mouseleave', circleLayerId, mouseleaveHandler);

        drilldownHandlersRef.current.push({
          layerId: circleLayerId,
          click: clickHandler,
          mouseenter: mouseenterHandler,
          mouseleave: mouseleaveHandler
        });
      }
    });

    if (Object.keys(territoryGroups).length > 0) {
      map.current!.fitBounds(bounds, { padding: 50 });
    }
    setIsRenderingMarkers(false);
  };

  // A territory is a REP's territory. This grouped by the outlet's zone label
  // ("Zone 31" - sixty of them) and then looked the rep up by matching that
  // label to "Territory 3", which never matched, so the page showed sixty
  // unowned clusters and no rep. Ownership is repId; the label is the rep's.
  const createTerritoryGroups = () => {
    if (outlets.length === 0) return {};
    const groups: Record<string, Outlet[]> = {};
    const labelOfRep = new Map(reps.map(r => [r.id, r.territory || r.name]));
    outlets.forEach(outlet => {
      // Three different things used to share the "Unassigned" label: the
      // duplicates the user held out, the outlets too far from the area to
      // route, and outlets no rep has. Name each for what it is.
      const territory = (outlet.repId && labelOfRep.get(outlet.repId))
        || (outlet.territory === 'Excluded' ? HELD_OUT_LABEL : outlet.territory === 'Needs Review' ? FAR_AWAY_LABEL : 'Unassigned');
      if (!groups[territory]) groups[territory] = [];
      groups[territory].push(outlet);
    });
    return groups;
  };

  const territoryGroups = useMemo(() => createTerritoryGroups(), [outlets, reps]);

  // Day-slots in the plan, for the visits/day figure; four weeks of five if
  // no plan has been run yet.
  const cycleSlots = planSettings?.configured && planSettings.cycleDays ? planSettings.cycleDays : 20;

  const getTerritoryColor = (territory: string) => {
    if (territory in UNOWNED_LABELS) return territory === HELD_OUT_LABEL ? '#D1D5DB' : territory === FAR_AWAY_LABEL ? '#F59E0B' : '#9CA3AF';
    const territoryNames = Object.keys(territoryGroups).filter(t => !(t in UNOWNED_LABELS)).sort();
    const index = territoryNames.indexOf(territory) % TERRITORY_COLORS.length;
    return TERRITORY_COLORS[index];
  };

  const getRepForTerritory = (territory: string) => {
    return reps.find(rep => (rep.territory || rep.name) === territory);
  };

  if (!isMapboxConfigLoading && (!resolvedMapboxToken || resolvedMapboxToken.includes('demo_token'))) {
    return (
      <div className="flex flex-col h-full ${className}">
        {/* Map Header */}

        <div className="flex flex-1 gap-4">
          {/* Map */}


                <div className="w-full h-[500px] rounded-lg bg-muted flex items-center justify-center">
                  <div className="text-center p-4">
                    <p className="text-muted-foreground mb-2">Map requires Mapbox API token</p>
                    <p className="text-sm text-muted-foreground">Mapbox is not configured for this app.</p>
                  </div>
                </div>


          {/* Territory Legend and Info */}

        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Map toolbar: the page title is in the app header */}
      <Card className="mb-4">
        <CardHeader className="p-3 md:px-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg bg-muted p-1" role="tablist" aria-label="Map view">
                {([['cluster', 'Clusters'], ['individual', 'Outlets']] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={viewMode === mode}
                    onClick={() => setViewMode(mode)}
                    className={`rounded-md px-3 py-1 text-[13px] font-medium ${viewMode === mode ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
                    data-testid={`button-view-${mode}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Button
                size="sm"
                variant={lassoActive ? 'default' : 'outline'}
                className="h-9"
                onClick={() => setLassoActive(v => !v)}
                title="Draw a loop around outlets to select them. Hold Shift to add to the selection; Esc cancels."
                aria-pressed={lassoActive}
                data-testid="button-lasso"
              >
                <LassoSelect className="h-4 w-4" />
                {lassoActive ? 'Lasso on — draw to select' : 'Lasso select'}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><MapPin className="h-4 w-4" /><span className="font-medium tabular-nums text-foreground">{outlets.length.toLocaleString()}</span> outlets</span>
              <span className="inline-flex items-center gap-1.5"><Users className="h-4 w-4" /><span className="font-medium tabular-nums text-foreground">{reps.length}</span> reps</span>
              <span className="inline-flex items-center gap-1.5"><Layers className="h-4 w-4" /><span className="font-medium tabular-nums text-foreground">{Object.keys(territoryGroups).length}</span> territories</span>
              <Button
                size="sm"
                variant="outline"
                className="h-9"
                disabled={isExporting || outlets.length === 0}
                onClick={() => exportTerritories()}
                title="Export every territory to Excel, as the map stands now"
                data-testid="button-export-territory-map"
              >
                <Download className="h-4 w-4" />
                {isExporting ? 'Exporting…' : 'Export to Excel'}
              </Button>
            </div>
          </div>
        </CardHeader>
        {(lassoActive || selectedIds.size > 0) && (
          <div className="mx-3 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/15 bg-primary/[0.04] px-3 py-2 text-sm text-foreground md:mx-4" data-testid="lasso-bar">
            {selectedIds.size === 0 ? (
              <span className="mr-auto">Drag a loop around the outlets you want. Hold Shift to add to a selection; press Esc to cancel, even mid-loop.</span>
            ) : (
              <>
                <span className="mr-auto font-medium" data-testid="text-lasso-count">
                  {selectedIds.size.toLocaleString()} outlet{selectedIds.size === 1 ? '' : 's'} selected
                </span>
                <Button size="sm" variant="destructive" className="text-xs px-3 h-7" onClick={() => setShowLassoDeleteConfirm(true)} data-testid="button-lasso-delete">
                  Delete {selectedIds.size.toLocaleString()}
                </Button>
                <Select value={reassignTargetId} onValueChange={setReassignTargetId}>
                  <SelectTrigger className="h-7 w-[220px] bg-white text-xs dark:bg-card" data-testid="select-lasso-target-rep">
                    <SelectValue placeholder="Move to rep…" />
                  </SelectTrigger>
                  <SelectContent>
                    {rankedTargetReps.map(({ rep, distKm, owns }, idx) => (
                      <SelectItem key={rep.id} value={rep.id}>
                        {rep.territory || rep.name} · {rep.name}
                        {Number.isFinite(distKm) ? ` — ${distKm < 1 ? `${Math.round(distKm * 1000)} m` : `${distKm.toFixed(1)} km`}` : ''}
                        {idx === 0 ? ' · closest' : ''}
                        {owns > 0 ? ` · owns ${owns}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="text-xs px-3 h-7"
                  disabled={!reassignTargetId || reassignSelectionMutation.isPending}
                  onClick={() => reassignSelectionMutation.mutate({ outletIds: Array.from(selectedIds), toRepId: reassignTargetId })}
                  title="Move the selected outlets to this rep and re-plan the territories involved"
                  data-testid="button-lasso-move"
                >
                  {reassignSelectionMutation.isPending ? 'Moving…' : `Move ${selectedIds.size.toLocaleString()}`}
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              className="bg-white text-xs px-3 h-7 dark:bg-card"
              onClick={cancelSelection}
              title="Clear the selection and leave the lasso (Esc)"
              data-testid="button-lasso-cancel"
            >
              <X className="mr-1 h-3.5 w-3.5" />
              {selectedIds.size === 0 ? 'Cancel' : 'Cancel selection'}
            </Button>
          </div>
        )}
      </Card>

      {showLassoDeleteConfirm && selectedIds.size > 0 && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900" data-testid="lasso-delete-confirm">
          <p className="mb-2">
            Delete <strong>{selectedIds.size}</strong> selected outlet{selectedIds.size === 1 ? '' : 's'}? They are removed from the list for good — this is not the same as holding a duplicate out of the plan.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={deleteManyMutation.isPending} onClick={() => deleteManyMutation.mutate(Array.from(selectedIds))} data-testid="button-lasso-delete-confirm">
              {deleteManyMutation.isPending ? 'Deleting…' : `Yes, delete ${selectedIds.size}`}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowLassoDeleteConfirm(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {reworkSummary && (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" data-testid="lasso-rework-summary">
          <p className="mb-1">
            Moved <strong>{reworkSummary.movedOutlets}</strong> outlet{reworkSummary.movedOutlets === 1 ? '' : 's'} to <strong>{reworkSummary.toRep.name}</strong> and re-planned {reworkSummary.repsReworked.length} territor{reworkSummary.repsReworked.length === 1 ? 'y' : 'ies'} with the saved settings:
          </p>
          <ul className="mb-2 ml-4 list-disc">
            {reworkSummary.repsReworked.map(r => (
              <li key={r.repId}>
                {r.name}: {r.outlets} outlets, {r.monthlyVisits} visits over {r.schedules} route day{r.schedules === 1 ? '' : 's'}
                {r.schedules > 0 ? ` (${(r.monthlyVisits / r.schedules).toFixed(1)}/day)` : ''}
                {r.overCapacity ? ' — over capacity' : ''}
              </li>
            ))}
          </ul>
          {reworkSummary.warnings.length > 0 && (
            <p className="mb-2 text-amber-800">{reworkSummary.warnings.join(' ')}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={isOptimizing} onClick={() => { setIsOptimizing(true); reoptimizeMutation.mutate(); }} data-testid="button-reoptimize-after-move">
              {isOptimizing ? 'Rebuilding…' : "Rebuild every rep's routes"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setReworkSummary(null)}>Dismiss</Button>
          </div>
        </div>
      )}
      {deleteSummary && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="lasso-summary">
          <p className="mb-2">
            You had <strong>{deleteSummary.before.toLocaleString()}</strong> outlets, deleted <strong>{deleteSummary.deleted.toLocaleString()}</strong>, and now have <strong>{deleteSummary.after.toLocaleString()}</strong>.
            The current plan still counts the deleted ones' days; re-plan to rebuild territories and routes on what remains.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={freshOptimizeMutation.isPending || !planSettings?.configured} onClick={() => freshOptimizeMutation.mutate()} data-testid="button-optimize-fresh">
              {freshOptimizeMutation.isPending ? 'Optimizing… (about half a minute)' : 'Optimize from scratch with the saved settings'}
            </Button>
            {planSettings?.configured && (
              <span className="text-xs text-amber-800">
                {planSettings.minVisitsPerDay}-{planSettings.maxVisitsPerDay} visits/day · {planSettings.workingDayNames?.[0]}-{planSettings.workingDayNames?.[planSettings.workingDayNames.length - 1]}{planSettings.planStart ? ` · ${planSettings.planStart} to ${planSettings.planEnd}` : ''}
              </span>
            )}
            <Button size="sm" variant="ghost" onClick={() => setDeleteSummary(null)}>Dismiss</Button>
          </div>
        </div>
      )}

      <div className="flex flex-1 flex-col gap-4 xl:flex-row">
        {/* Map: as tall as the window allows, never a 500px letterbox */}
        <Card className="flex-1 min-w-0">
          <CardContent className="p-0 h-full relative">
            <div
              ref={mapContainer}
              className="w-full h-[60vh] min-h-[420px] xl:h-[calc(100vh-15rem)] rounded-lg"
            />
            {isRenderingMarkers && (
              <div className="absolute inset-0 bg-white bg-opacity-90 flex items-center justify-center rounded-lg">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {viewMode === 'cluster' ? 'Loading territory visualization...' : 'Loading individual outlets...'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {viewMode === 'cluster'
                      ? `${outlets.length} outlets grouped into ${Object.keys(territoryGroups).length} territories`
                      : `Loading ${outlets.length} individual markers`
                    }
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Territory Legend and Info */}
        <div className="w-full space-y-4 xl:w-80 xl:shrink-0">
          {/* Territory Legend */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Territories</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 max-h-[40vh] xl:max-h-[calc(100vh-22rem)] overflow-y-auto">
              {Object.entries(territoryGroups).map(([territory, territoryOutlets]) => {
                const rep = getRepForTerritory(territory);
                const vf2Count = territoryOutlets.filter(o => o.visitFrequency === 2).length;
                const vf4Count = territoryOutlets.filter(o => o.visitFrequency === 4).length;

                return (
                  <div key={territory} className="p-3 bg-muted/60 rounded-lg">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div
                        className="w-4 h-4 rounded-full border border-input"
                        style={{ backgroundColor: getTerritoryColor(territory) }}
                      ></div>
                      <div>
                        <div className="font-medium text-sm">{territory}</div>
                        {rep && (
                          <div className="text-xs text-muted-foreground">{rep.name} ({rep.code})</div>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-medium">{territoryOutlets.length} outlets</div>
                      <div className="text-xs text-muted-foreground">
                        VF2: {vf2Count} | VF4: {vf4Count}
                      </div>
                      {!(territory in UNOWNED_LABELS) && (
                        <div className="text-xs text-green-600">
                          ~{Math.round(territoryOutlets.reduce((sum, o) => sum + (o.visitFrequency || 2), 0) / cycleSlots)} visits/day
                        </div>
                      )}
                    </div>
                  </div>
                  {territory in UNOWNED_LABELS && (
                    <p className="mt-2 text-xs text-muted-foreground" data-testid={`text-unowned-${territory === HELD_OUT_LABEL ? 'held-out' : territory === FAR_AWAY_LABEL ? 'far' : 'unassigned'}`}>
                      {UNOWNED_LABELS[territory]}
                    </p>
                  )}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Reoptimize Button - appears after changes */}
          {needsReoptimization && (
            <Card className="border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20">
              <CardContent className="py-4">
                <p className="text-sm text-amber-800 dark:text-amber-200 mb-3">
                  Changes detected. Reoptimize to update all routes and schedules.
                </p>
                <Button
                  onClick={() => {
                    setIsOptimizing(true);
                    reoptimizeMutation.mutate();
                  }}
                  disabled={isOptimizing}
                  className="w-full"
                >
                  {isOptimizing ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  Reoptimize All Routes
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Selected Outlet Info */}
          {selectedOutlet && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Outlet Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <div className="font-medium">{selectedOutlet.name}</div>
                  {selectedOutlet.address && (
                    <div className="text-sm text-muted-foreground mt-1">{selectedOutlet.address}</div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">Visit Frequency:</span>
                    <Badge variant="outline" className="ml-2">
                      VF{selectedOutlet.visitFrequency}
                    </Badge>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Territory:</span>
                    <div className="font-medium">{selectedOutlet.territory || 'Unassigned'}</div>
                  </div>
                </div>

                <div className="text-xs text-muted-foreground">
                  <div>Lat: {selectedOutlet.latitude.toFixed(6)}</div>
                  <div>Lng: {selectedOutlet.longitude.toFixed(6)}</div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setSelectedOutlet(null); setShowDeleteConfirm(false); }}
                    className="flex-1"
                  >
                    Close
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setShowDeleteConfirm(true)}
                    className="flex-1"
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Delete
                  </Button>
                </div>
                
                {/* Delete Confirmation */}
                {showDeleteConfirm && (
                  <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
                    <p className="text-sm text-red-800 dark:text-red-200 mb-3">
                      Delete this outlet? This cannot be undone.
                    </p>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowDeleteConfirm(false)}>
                        Cancel
                      </Button>
                      <Button 
                        variant="destructive" 
                        size="sm"
                        className="flex-1"
                        onClick={handleDeleteOutlet}
                        disabled={deleteMutation.isPending}
                      >
                        {deleteMutation.isPending ? "Deleting..." : "Confirm Delete"}
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
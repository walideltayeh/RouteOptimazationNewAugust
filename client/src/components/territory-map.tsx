import { useEffect, useRef, useState, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MapPin, Users, Navigation, Trash2, RefreshCw } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
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
const TERRITORY_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
];

export default function TerritoryMap({ className }: TerritoryMapProps) {
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
  const outletsRef = useRef<Outlet[]>([]);
  const [deleteSummary, setDeleteSummary] = useState<{ before: number; deleted: number; after: number } | null>(null);
  const [showLassoDeleteConfirm, setShowLassoDeleteConfirm] = useState(false);
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
      const res = await apiRequest("POST", "/api/optimize", body);
      return res.json();
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
      const response = await apiRequest("POST", "/api/optimize", {
        minVisitsPerDay: 15,
        maxVisitsPerDay: 25,
        workingDaysPerWeek: 5,
        calculationMode: 'manual'
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      queryClient.invalidateQueries({ queryKey: ['/api/reps'] });
      toast({ title: "Success", description: "Routes reoptimized successfully" });
      setNeedsReoptimization(false);
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
  // current selection. Works with touch as well as the mouse.
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
    canvas.addEventListener('mousedown', start, true);
    canvas.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', end, true);
    canvas.addEventListener('touchstart', start, { passive: false, capture: true });
    canvas.addEventListener('touchmove', move, { passive: false, capture: true });
    window.addEventListener('touchend', end, true);
    return () => {
      canvas.removeEventListener('mousedown', start, true);
      canvas.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', end, true);
      canvas.removeEventListener('touchstart', start, true);
      canvas.removeEventListener('touchmove', move, true);
      window.removeEventListener('touchend', end, true);
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

      // Set Lebanon as default center since that's the data we're working with
      const lebanonCenter: [number, number] = [35.8623, 33.8938]; // Beirut coordinates
      
      map.current = new mapboxgl.Map({
        container: mapContainer.current,
        style: 'mapbox://styles/mapbox/light-v11',
        center: lebanonCenter,
        zoom: 8
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
    drilldownLayersRef.current.forEach(id => {
      if (map.current?.getLayer(id)) map.current.removeLayer(id);
      if (map.current?.getSource(id)) map.current.removeSource(id);
    });
    drilldownLayersRef.current = [];

    if (viewMode === 'cluster') {
      renderTerritoryVisualization();
    } else {
      renderGeoJSONIndividualView();
    }

  }, [outlets, isMapLoaded, viewMode]);

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
      clusterEl.className = 'cluster-marker flex items-center justify-center rounded-full border-2 border-white shadow-lg cursor-pointer hover:scale-110 transition-transform font-bold text-white text-xs';
      
      // Size based on outlet count
      const size = Math.min(Math.max(20 + Math.log(territoryOutlets.length) * 8, 24), 60);
      clusterEl.style.width = `${size}px`;
      clusterEl.style.height = `${size}px`;
      clusterEl.style.backgroundColor = getTerritoryColor(territory);
      clusterEl.textContent = territoryOutlets.length.toString();
      
      // Add territory info on hover
      const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(`
        <div class="p-2">
          <h3 class="font-bold text-sm">${territory}</h3>
          <p class="text-xs text-gray-600">${territoryOutlets.length} outlets</p>
          <p class="text-xs text-gray-600">VF2: ${territoryOutlets.filter(o => o.visitFrequency === 2).length} | VF4: ${territoryOutlets.filter(o => o.visitFrequency === 4).length}</p>
        </div>
      `);

      clusterEl.addEventListener('click', () => {
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
        drilldownLayersRef.current.forEach(id => {
          if (map.current?.getLayer(id)) map.current.removeLayer(id);
          if (map.current?.getSource(id)) map.current.removeSource(id);
        });
        drilldownLayersRef.current = [];

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
      });

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

      if (!map.current!.getSource(sourceId)) {
        map.current!.addSource(sourceId, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features }
        });

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
      const territory = (outlet.repId && labelOfRep.get(outlet.repId)) || 'Unassigned';
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
    if (territory === 'Unassigned') return '#9CA3AF';
    const territoryNames = Object.keys(territoryGroups).filter(t => t !== 'Unassigned').sort();
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


                <div className="w-full h-[500px] rounded-lg bg-gray-100 flex items-center justify-center">
                  <div className="text-center p-4">
                    <p className="text-gray-600 mb-2">Map requires Mapbox API token</p>
                    <p className="text-sm text-gray-500">Mapbox is not configured for this app.</p>
                  </div>
                </div>


          {/* Territory Legend and Info */}

        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Map Header */}
      <Card className="mb-4">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center">
              <Navigation className="mr-2 h-5 w-5" />
              Territory Map
            </CardTitle>
            <div className="flex items-center space-x-4 text-sm text-gray-600">
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant={viewMode === 'cluster' ? 'default' : 'outline'}
                  className={`rounded-full text-xs px-3 h-7 ${viewMode === 'cluster' ? 'bg-[#1d1d1f] text-white hover:bg-[#1d1d1f]/90' : ''}`}
                  onClick={() => setViewMode('cluster')}
                >
                  Cluster View
                </Button>
                <Button
                  size="sm"
                  variant={viewMode === 'individual' ? 'default' : 'outline'}
                  className={`rounded-full text-xs px-3 h-7 ${viewMode === 'individual' ? 'bg-[#1d1d1f] text-white hover:bg-[#1d1d1f]/90' : ''}`}
                  onClick={() => setViewMode('individual')}
                >
                  Individual View
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant={lassoActive ? 'default' : 'outline'}
                  className={`rounded-full text-xs px-3 h-7 ${lassoActive ? 'bg-blue-600 text-white hover:bg-blue-600/90' : ''}`}
                  onClick={() => setLassoActive(v => !v)}
                  title="Draw a loop around outlets to select them. Hold Shift to add to the selection."
                  data-testid="button-lasso"
                >
                  {lassoActive ? 'Lasso on — draw to select' : 'Lasso select'}
                </Button>
                {selectedIds.size > 0 && (
                  <>
                    <span className="text-xs font-medium text-red-700" data-testid="text-lasso-count">{selectedIds.size} selected</span>
                    <Button size="sm" variant="destructive" className="rounded-full text-xs px-3 h-7" onClick={() => setShowLassoDeleteConfirm(true)} data-testid="button-lasso-delete">
                      Delete {selectedIds.size}
                    </Button>
                    <Button size="sm" variant="ghost" className="rounded-full text-xs px-2 h-7" onClick={() => setSelectedIds(new Set())} data-testid="button-lasso-clear">
                      Clear
                    </Button>
                  </>
                )}
              </div>
              <div className="flex items-center">
                <MapPin className="mr-1 h-4 w-4" />
                {outlets.length.toLocaleString()} Outlets
              </div>
              <div className="flex items-center">
                <Users className="mr-1 h-4 w-4" />
                {reps.length} Reps
              </div>
              <div className="flex items-center">
                <div className="w-3 h-3 rounded-full bg-blue-500 mr-1"></div>
                {Object.keys(territoryGroups).length} Territories
              </div>
            </div>
          </div>
        </CardHeader>
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

      <div className="flex flex-1 gap-4">
        {/* Map */}
        <Card className="flex-1">
          <CardContent className="p-0 h-full relative">
            <div 
              ref={mapContainer}
              className="w-full h-[500px] rounded-lg"
            />
            {isRenderingMarkers && (
              <div className="absolute inset-0 bg-white bg-opacity-90 flex items-center justify-center rounded-lg">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                  <p className="mt-2 text-sm text-gray-600">
                    {viewMode === 'cluster' ? 'Loading territory visualization...' : 'Loading individual outlets...'}
                  </p>
                  <p className="text-xs text-gray-500">
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
        <div className="w-80 space-y-4">
          {/* Territory Legend */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Territories</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 max-h-[500px] overflow-y-auto">
              {Object.entries(territoryGroups).map(([territory, territoryOutlets]) => {
                const rep = getRepForTerritory(territory);
                const vf2Count = territoryOutlets.filter(o => o.visitFrequency === 2).length;
                const vf4Count = territoryOutlets.filter(o => o.visitFrequency === 4).length;

                return (
                  <div key={territory} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center space-x-3">
                      <div
                        className="w-4 h-4 rounded-full border border-gray-300"
                        style={{ backgroundColor: getTerritoryColor(territory) }}
                      ></div>
                      <div>
                        <div className="font-medium text-sm">{territory}</div>
                        {rep && (
                          <div className="text-xs text-gray-600">{rep.name} ({rep.code})</div>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-medium">{territoryOutlets.length} outlets</div>
                      <div className="text-xs text-gray-600">
                        VF2: {vf2Count} | VF4: {vf4Count}
                      </div>
                      <div className="text-xs text-green-600">
                        ~{Math.round(territoryOutlets.reduce((sum, o) => sum + (o.visitFrequency || 2), 0) / cycleSlots)} visits/day
                      </div>
                    </div>
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
                    <div className="text-sm text-gray-600 mt-1">{selectedOutlet.address}</div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-gray-600">Visit Frequency:</span>
                    <Badge variant="outline" className="ml-2">
                      VF{selectedOutlet.visitFrequency}
                    </Badge>
                  </div>
                  <div>
                    <span className="text-gray-600">Territory:</span>
                    <div className="font-medium">{selectedOutlet.territory || 'Unassigned'}</div>
                  </div>
                </div>

                <div className="text-xs text-gray-500">
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
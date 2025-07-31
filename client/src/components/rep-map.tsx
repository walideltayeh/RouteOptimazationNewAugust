import { useState, useMemo, useRef, useEffect } from "react";
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Rep, Outlet, Schedule } from "@shared/schema";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || import.meta.env.VITE_MAPBOX_PUBLIC_KEY;
if (MAPBOX_TOKEN && MAPBOX_TOKEN !== 'demo_token' && !MAPBOX_TOKEN.includes('your_') && MAPBOX_TOKEN.length > 10) {
  mapboxgl.accessToken = MAPBOX_TOKEN;
}

// Color palette for different reps
const REP_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#FED766', '#2AB7CA',
  '#FE4A49', '#6C5CE7', '#A8E6CF', '#FFD93D', '#FC913A',
  '#F9C74F', '#90BE6D', '#43AA8B', '#577590', '#F94144'
];

export function RepMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const [selectedReps, setSelectedReps] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<number>(0); // 0 = Monday
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const markersRef = useRef<mapboxgl.Marker[]>([]);

  const { data: reps = [] } = useQuery<Rep[]>({ 
    queryKey: ["/api/reps"] 
  });

  const { data: outlets = [] } = useQuery<Outlet[]>({ 
    queryKey: ["/api/outlets"] 
  });

  const { data: schedules = [] } = useQuery<Schedule[]>({ 
    queryKey: ["/api/schedules"] 
  });

  // Filter schedules for selected reps and day
  const filteredSchedules = useMemo(() => {
    return schedules.filter(schedule => 
      selectedReps.includes(schedule.repId) && 
      schedule.dayOfWeek === selectedDay &&
      schedule.week === 1 // Show week 1 schedule
    );
  }, [schedules, selectedReps, selectedDay]);

  // Group outlets by rep for the selected day
  const repOutlets = useMemo(() => {
    const result: Record<string, { rep: Rep; outlets: Outlet[]; color: string }> = {};
    
    filteredSchedules.forEach(schedule => {
      const rep = reps.find(r => r.id === schedule.repId);
      if (!rep) return;

      const scheduleOutlets = (schedule.outletIds as string[])
        .map(id => outlets.find(o => o.id === id))
        .filter((o): o is Outlet => o !== undefined);

      if (!result[rep.id]) {
        const repIndex = reps.findIndex(r => r.id === rep.id);
        result[rep.id] = {
          rep,
          outlets: [],
          color: REP_COLORS[repIndex % REP_COLORS.length]
        };
      }

      result[rep.id].outlets.push(...scheduleOutlets);
    });

    return result;
  }, [filteredSchedules, reps, outlets]);

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || !MAPBOX_TOKEN || map.current) return;

    try {
      const mapInstance = new mapboxgl.Map({
        container: mapContainer.current,
        style: 'mapbox://styles/mapbox/light-v11',
        center: [35.8623, 33.8547], // Lebanon center
        zoom: 8
      });

      mapInstance.on('load', () => {
        setIsMapLoaded(true);
      });

      map.current = mapInstance;
    } catch (error) {
      console.error('Error initializing map:', error);
    }

    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, []);

  // Update map when data changes
  useEffect(() => {
    if (!map.current || !isMapLoaded) return;

    console.log('RepMap update - Selected reps:', selectedReps);
    console.log('RepMap update - Filtered schedules:', filteredSchedules);
    console.log('RepMap update - Rep outlets:', repOutlets);

    // Clear existing markers
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    // Clear existing layers and sources for all reps
    reps.forEach((rep) => {
      const sourceId = `route-${rep.id}`;
      const layerId = `route-layer-${rep.id}`;
      
      if (map.current!.getLayer(layerId)) {
        map.current!.removeLayer(layerId);
      }
      if (map.current!.getSource(sourceId)) {
        map.current!.removeSource(sourceId);
      }
    });

    // Add markers and routes for each selected rep
    Object.entries(repOutlets).forEach(([repId, data]) => {
      // Add markers for outlets
      data.outlets.forEach((outlet, idx) => {
        const el = document.createElement('div');
        el.className = 'rep-marker';
        el.style.width = '30px';
        el.style.height = '30px';
        el.style.backgroundColor = data.color;
        el.style.borderRadius = '50%';
        el.style.border = '2px solid white';
        el.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.color = 'white';
        el.style.fontWeight = 'bold';
        el.style.fontSize = '12px';
        el.innerHTML = (idx + 1).toString();

        const marker = new mapboxgl.Marker(el)
          .setLngLat([outlet.longitude, outlet.latitude])
          .setPopup(
            new mapboxgl.Popup({ offset: 25 })
              .setHTML(`
                <div>
                  <strong>${outlet.name}</strong><br/>
                  ${outlet.address}<br/>
                  <span style="color: ${data.color}">${data.rep.name}</span>
                </div>
              `)
          )
          .addTo(map.current!);

        markersRef.current.push(marker);
      });

      // Draw route lines
      if (data.outlets.length > 1 && map.current) {
        const routeCoordinates = data.outlets.map(o => [o.longitude, o.latitude]);
        
        // Add source and layer for this rep's route
        const sourceId = `route-${repId}`;
        const layerId = `route-layer-${repId}`;

        if (!map.current.getSource(sourceId)) {
          map.current.addSource(sourceId, {
            type: 'geojson',
            data: {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: routeCoordinates
              }
            }
          });

          map.current.addLayer({
            id: layerId,
            type: 'line',
            source: sourceId,
            layout: {
              'line-join': 'round',
              'line-cap': 'round'
            },
            paint: {
              'line-color': data.color,
              'line-width': 3,
              'line-opacity': 0.6
            }
          });
        }
      }
    });

    // Fit bounds to show all outlets
    if (Object.keys(repOutlets).length > 0) {
      const allOutlets = Object.values(repOutlets).flatMap(r => r.outlets);
      if (allOutlets.length > 0) {
        const bounds = new mapboxgl.LngLatBounds();
        allOutlets.forEach(outlet => {
          bounds.extend([outlet.longitude, outlet.latitude]);
        });
        map.current.fitBounds(bounds, { padding: 50 });
      }
    }
  }, [repOutlets, isMapLoaded, reps]);

  const toggleRep = (repId: string) => {
    setSelectedReps(prev => 
      prev.includes(repId) 
        ? prev.filter(id => id !== repId)
        : [...prev, repId]
    );
  };

  const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  if (!MAPBOX_TOKEN) {
    return (
      <Card className="h-full">
        <CardHeader>
          <CardTitle>Rep Map</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            Map cannot be displayed. Mapbox token is not configured.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-4">
        <CardTitle>Sales Rep Routes</CardTitle>
        <div className="flex flex-col gap-4 mt-4">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={open}
                className="w-full justify-between"
              >
                {selectedReps.length === 0
                  ? "Select reps..."
                  : `${selectedReps.length} rep${selectedReps.length === 1 ? "" : "s"} selected`}
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[300px] p-0">
              <Command>
                <CommandInput placeholder="Search reps..." />
                <CommandEmpty>No rep found.</CommandEmpty>
                <CommandGroup className="max-h-[300px] overflow-y-auto">
                  {reps.map((rep) => {
                    const repIndex = reps.findIndex(r => r.id === rep.id);
                    const color = REP_COLORS[repIndex % REP_COLORS.length];
                    return (
                      <CommandItem
                        key={rep.id}
                        value={rep.name}
                        onSelect={() => toggleRep(rep.id)}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            selectedReps.includes(rep.id) ? "opacity-100" : "opacity-0"
                          )}
                        />
                        <div className="flex items-center gap-2 flex-1">
                          <div 
                            className="w-3 h-3 rounded-full" 
                            style={{ backgroundColor: color }}
                          />
                          <span>{rep.name} - {rep.territory}</span>
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </Command>
            </PopoverContent>
          </Popover>

          <select
            value={selectedDay}
            onChange={(e) => setSelectedDay(Number(e.target.value))}
            className="px-3 py-2 border rounded-md w-full"
          >
            {daysOfWeek.map((day, index) => (
              <option key={day} value={index}>{day}</option>
            ))}
          </select>
        </div>
      </CardHeader>
      <CardContent className="flex-1 p-4">
        <div ref={mapContainer} className="h-full min-h-[400px] rounded-lg overflow-hidden border" />

        {/* Legend */}
        {selectedReps.length > 0 && (
          <div className="mt-4 p-3 border rounded-lg">
            <h4 className="font-semibold mb-2 text-sm">Selected Reps</h4>
            <div className="space-y-2">
              {Object.entries(repOutlets).map(([repId, data]) => {
                const schedule = filteredSchedules.find(s => s.repId === repId);
                return (
                  <div key={repId} className="flex items-center gap-2">
                    <div 
                      className="w-3 h-3 rounded-full flex-shrink-0" 
                      style={{ backgroundColor: data.color }}
                    />
                    <span className="text-xs truncate">
                      {data.rep.name} - {data.outlets.length} outlets
                      {schedule && schedule.totalDistance && ` (${schedule.totalDistance.toFixed(1)}km)`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
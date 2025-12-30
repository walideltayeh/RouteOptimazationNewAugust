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
import { Check, ChevronsUpDown, Zap, Save, Download, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import RouteOrderEditor from "@/components/route-order-editor";
import type { Rep, Outlet, Schedule, RoleHierarchy, RoleSchedule } from "@shared/schema";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || import.meta.env.VITE_MAPBOX_PUBLIC_KEY;
if (MAPBOX_TOKEN && MAPBOX_TOKEN !== 'demo_token' && !MAPBOX_TOKEN.includes('your_') && MAPBOX_TOKEN.length > 10) {
  mapboxgl.accessToken = MAPBOX_TOKEN;
}

// Color palette for different days
const DAY_COLORS = [
  '#FF6B6B', // Monday - Red
  '#4ECDC4', // Tuesday - Teal
  '#45B7D1', // Wednesday - Blue
  '#FED766', // Thursday - Yellow
  '#2AB7CA', // Friday - Light Blue
  '#FE4A49', // Saturday - Pink
  '#6C5CE7'  // Sunday - Purple
];

const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function RepMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const [selectedReps, setSelectedReps] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]); // Default to weekdays
  const [selectedWeeks, setSelectedWeeks] = useState<number[]>([1]); // Default to week 1
  const [selectedRole, setSelectedRole] = useState<string>('rep'); // Default to Sales Rep
  const [showAllLinkedRoles, setShowAllLinkedRoles] = useState(false); // Show rep + all linked role routes
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<{ schedule: Schedule; rep: Rep } | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: reps = [] } = useQuery<Rep[]>({ 
    queryKey: ["/api/reps"] 
  });

  const { data: outlets = [] } = useQuery<Outlet[]>({ 
    queryKey: ["/api/outlets"] 
  });

  const { data: schedules = [], isLoading: schedulesLoading, refetch: refetchSchedules } = useQuery<Schedule[]>({ 
    queryKey: ["/api/schedules"] 
  });

  const { data: roleHierarchies = [] } = useQuery<RoleHierarchy[]>({
    queryKey: ["/api/role-hierarchies"]
  });

  const { data: roleSchedules = [] } = useQuery<RoleSchedule[]>({
    queryKey: ["/api/role-schedules"]
  });
  
  // Force refetch schedules when component mounts
  useEffect(() => {
    refetchSchedules();
  }, []);

  // Get unique roles from hierarchies and role schedules for the filter dropdown
  const availableRoles = useMemo(() => {
    const roleMap = new Map<string, { role: string; roleName: string; colorHex: string }>();
    roleMap.set('rep', { role: 'rep', roleName: 'Sales Rep', colorHex: '#3B82F6' });
    
    // First check role hierarchies (for rep-specific hierarchies)
    roleHierarchies.forEach(h => {
      // Exclude template entries and inactive hierarchies
      if (h.role !== 'rep' && h.role !== '_config' && h.isActive && h.repId !== 'template') {
        roleMap.set(h.role, { role: h.role, roleName: h.roleName, colorHex: h.colorHex });
      }
    });
    
    // Also check role schedules for roles that might not be in hierarchies
    roleSchedules.forEach(rs => {
      if (rs.role !== 'rep' && !roleMap.has(rs.role)) {
        // Get color from template hierarchies if available
        const template = roleHierarchies.find(h => h.repId === 'template' && h.role === rs.role);
        roleMap.set(rs.role, { 
          role: rs.role, 
          roleName: rs.roleName || rs.role, 
          colorHex: template?.colorHex || '#3B82F6' 
        });
      }
    });
    
    return Array.from(roleMap.values());
  }, [roleHierarchies, roleSchedules]);

  // Get the current role's color
  const getCurrentRoleColor = () => {
    const roleInfo = availableRoles.find(r => r.role === selectedRole);
    return roleInfo?.colorHex || '#3B82F6';
  };

  // Filter schedules for selected reps, days, weeks, and role
  const filteredSchedules = useMemo(() => {
    // For Sales Rep, use regular schedules
    if (selectedRole === 'rep') {
      // Base schedules only store weeks 1-2, so we need to map weeks 3-4 to 1-2
      const filtered = schedules.filter(schedule => {
        if (!selectedReps.includes(schedule.repId)) return false;
        if (!selectedDays.includes(schedule.dayOfWeek)) return false;
        
        // Check if any selected week matches (accounting for mirroring)
        const matchingWeeks = selectedWeeks.some(selectedWeek => {
          const sourceWeek = selectedWeek <= 2 ? selectedWeek : selectedWeek - 2;
          return schedule.week === sourceWeek;
        });
        return matchingWeeks;
      });
      return filtered;
    }
    
    // For other roles, use role schedules filtered by role field directly
    // Role schedules have the role field stored, so we can filter by that instead of hierarchyId
    console.log('Role filtering - Selected role:', selectedRole, 'Selected reps:', selectedReps, 'Total role schedules:', roleSchedules.length);
    
    // Filter role schedules by role, repId, day, and week
    // Role schedules may have actual week 3/4 values when offset pushes them there
    // But we also need to handle week mirroring for base weeks 1-2
    const filteredRoleSchedules = roleSchedules.filter(rs => {
      // Filter by role field directly
      if (rs.role !== selectedRole) return false;
      // Filter by selected reps
      if (!selectedReps.includes(rs.repId)) return false;
      // Filter by selected days
      if (!selectedDays.includes(rs.dayOfWeek)) return false;
      
      // Check if any selected week matches (direct match or via mirroring)
      const matchingWeeks = selectedWeeks.some(selectedWeek => {
        // Direct match
        if (rs.week === selectedWeek) return true;
        // Mirror match for weeks 3-4 -> weeks 1-2
        if (selectedWeek > 2) {
          const mirrorWeek = selectedWeek - 2;
          return rs.week === mirrorWeek;
        }
        return false;
      });
      return matchingWeeks;
    });
    
    console.log('Filtered role schedules:', filteredRoleSchedules.length, 'Sample:', filteredRoleSchedules.slice(0, 2));
    
    // Convert role schedules to Schedule-like objects for compatibility
    return filteredRoleSchedules.map(rs => ({
      id: rs.id,
      repId: rs.repId,
      week: rs.week,
      dayOfWeek: rs.dayOfWeek,
      outletIds: rs.outletIds,
      routeOrder: rs.routeOrder, // Preserve the stored route order
      totalDistance: rs.totalDistance,
      estimatedDuration: rs.estimatedDuration,
      createdAt: rs.createdAt
    } as Schedule));
  }, [schedules, roleSchedules, roleHierarchies, selectedReps, selectedDays, selectedWeeks, selectedRole]);

  // Filter all linked role schedules for "Show All Linked Roles" mode
  const linkedRoleSchedules = useMemo(() => {
    if (!showAllLinkedRoles || selectedRole !== 'rep') {
      return [];
    }
    
    // Get all role schedules for selected reps (excluding rep role itself)
    return roleSchedules.filter(rs => {
      if (rs.role === 'rep') return false;
      if (!selectedReps.includes(rs.repId)) return false;
      if (!selectedDays.includes(rs.dayOfWeek)) return false;
      
      // Check if any selected week matches (direct match or via mirroring)
      const matchingWeeks = selectedWeeks.some(selectedWeek => {
        if (rs.week === selectedWeek) return true;
        if (selectedWeek > 2) {
          const mirrorWeek = selectedWeek - 2;
          return rs.week === mirrorWeek;
        }
        return false;
      });
      return matchingWeeks;
    });
  }, [roleSchedules, selectedReps, selectedDays, selectedWeeks, showAllLinkedRoles, selectedRole]);

  // Group outlets by rep, day, and week for the selected days
  const repDayOutlets = useMemo(() => {
    const result: Record<string, { 
      rep: Rep; 
      daySchedules: Record<string, { 
        outlets: Outlet[]; 
        color: string; 
        dayOfWeek: number;
        week: number;
        schedule: Schedule;
        roleName?: string;
      }> 
    }> = {};
    
    if (schedulesLoading || !outlets.length) {
      return result;
    }
    
    // For role schedules, check if we have any role schedules
    if (selectedRole !== 'rep' && roleSchedules.length === 0) {
      return result;
    }
    
    // For rep schedules, check if we have schedules
    if (selectedRole === 'rep' && schedules.length === 0) {
      return result;
    }
    
    const roleColor = getCurrentRoleColor();
    const roleInfo = availableRoles.find(r => r.role === selectedRole);
    
    filteredSchedules.forEach(schedule => {
      const rep = reps.find(r => r.id === schedule.repId);
      if (!rep) {
        return;
      }

      // Check if outletIds is an array or needs parsing
      const outletIdArray = Array.isArray(schedule.outletIds) 
        ? schedule.outletIds 
        : typeof schedule.outletIds === 'string' 
          ? JSON.parse(schedule.outletIds as string)
          : [];
      
      const scheduleOutlets = outletIdArray
        .map((id: string) => {
          const outlet = outlets.find((o: Outlet) => o.id === id);
          return outlet;
        })
        .filter((o: Outlet | undefined): o is Outlet => o !== undefined);

      if (!result[rep.id]) {
        result[rep.id] = {
          rep,
          daySchedules: {}
        };
      }

      // Create a unique key for each day-week combination
      const scheduleKey = `${schedule.dayOfWeek}-${schedule.week}`;
      
      // Use role-specific color or day color based on mode
      const displayColor = selectedRole === 'rep' 
        ? DAY_COLORS[(schedule.dayOfWeek - 1) % DAY_COLORS.length]
        : roleColor;
      
      result[rep.id].daySchedules[scheduleKey] = {
        outlets: scheduleOutlets,
        color: displayColor,
        dayOfWeek: schedule.dayOfWeek,
        week: schedule.week,
        schedule,
        roleName: roleInfo?.roleName
      };
    });

    // If showing all linked roles, also add those schedules
    if (showAllLinkedRoles && selectedRole === 'rep') {
      linkedRoleSchedules.forEach(roleSchedule => {
        const rep = reps.find(r => r.id === roleSchedule.repId);
        if (!rep) return;

        const outletIdArray = Array.isArray(roleSchedule.outletIds) 
          ? roleSchedule.outletIds 
          : typeof roleSchedule.outletIds === 'string' 
            ? JSON.parse(roleSchedule.outletIds as string)
            : [];
        
        const scheduleOutlets = outletIdArray
          .map((id: string) => outlets.find((o: Outlet) => o.id === id))
          .filter((o: Outlet | undefined): o is Outlet => o !== undefined);

        if (!result[rep.id]) {
          result[rep.id] = {
            rep,
            daySchedules: {}
          };
        }

        // Create unique key including role to distinguish from rep schedule
        const scheduleKey = `${roleSchedule.dayOfWeek}-${roleSchedule.week}-${roleSchedule.role}`;
        
        // Get color from role hierarchy
        const roleColorInfo = availableRoles.find(r => r.role === roleSchedule.role);
        
        result[rep.id].daySchedules[scheduleKey] = {
          outlets: scheduleOutlets,
          color: roleColorInfo?.colorHex || '#9CA3AF',
          dayOfWeek: roleSchedule.dayOfWeek,
          week: roleSchedule.week,
          schedule: {
            id: roleSchedule.id,
            repId: roleSchedule.repId,
            week: roleSchedule.week,
            dayOfWeek: roleSchedule.dayOfWeek,
            outletIds: roleSchedule.outletIds,
            routeOrder: roleSchedule.routeOrder,
            totalDistance: roleSchedule.totalDistance,
            estimatedDuration: roleSchedule.estimatedDuration,
            createdAt: roleSchedule.createdAt
          } as Schedule,
          roleName: roleSchedule.roleName || roleSchedule.role
        };
      });
    }

    return result;
  }, [filteredSchedules, reps, outlets, selectedRole, availableRoles, roleSchedules, schedules, schedulesLoading, showAllLinkedRoles, linkedRoleSchedules]);

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
    console.log('RepMap update - Selected days:', selectedDays);
    console.log('RepMap update - All schedules:', schedules.length);
    console.log('RepMap update - Filtered schedules:', filteredSchedules);
    console.log('RepMap update - Rep outlets:', repDayOutlets);
    console.log('RepMap update - Total outlets:', outlets.length);

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

    // Clear existing layers and sources for all reps, ALL days (1-7), and ALL weeks (1-4)
    // This ensures stale layers are removed when toggling days/weeks
    // Use a comprehensive list of possible role names to ensure all stale layers are cleared
    const knownRoleNames = ['merchandiser', 'collection_agent', 'supervisor', 'driver', 'custom'];
    
    reps.forEach((rep) => {
      [1, 2, 3, 4, 5, 6, 7].forEach((day) => {
        [1, 2, 3, 4].forEach((week) => {
          // Clear base schedule layers
          const sourceId = `route-${rep.id}-${day}-${week}`;
          const layerId = `route-layer-${rep.id}-${day}-${week}`;
          
          if (map.current!.getLayer(layerId)) {
            map.current!.removeLayer(layerId);
          }
          if (map.current!.getSource(sourceId)) {
            map.current!.removeSource(sourceId);
          }
          
          // Clear role schedule layers using known role names and availableRoles
          const allRoleNames = [...knownRoleNames, ...availableRoles.map(r => r.role)];
          const uniqueRoleNames = Array.from(new Set(allRoleNames));
          
          uniqueRoleNames.forEach((roleName) => {
            if (roleName === 'rep') return;
            const roleSourceId = `route-${rep.id}-${day}-${week}-${roleName}`;
            const roleLayerId = `route-layer-${rep.id}-${day}-${week}-${roleName}`;
            
            if (map.current!.getLayer(roleLayerId)) {
              map.current!.removeLayer(roleLayerId);
            }
            if (map.current!.getSource(roleSourceId)) {
              map.current!.removeSource(roleSourceId);
            }
          });
        });
      });
    });

    // Add markers and routes for each selected rep and day
    console.log('Adding markers for repDayOutlets:', repDayOutlets);
    
    Object.entries(repDayOutlets).forEach(([repId, repData]) => {
      console.log('Processing rep:', repId, repData.rep.name);
      
      Object.entries(repData.daySchedules).forEach(([scheduleKey, dayData]) => {
        console.log(`Processing schedule ${scheduleKey} for rep ${repData.rep.name}, outlets:`, dayData.outlets.length);
        
        // Add markers for outlets with day-specific colors
        dayData.outlets.forEach((outlet, idx) => {
          const el = document.createElement('div');
          el.className = 'rep-marker';
          el.style.width = '30px';
          el.style.height = '30px';
          el.style.backgroundColor = dayData.color;
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
                    <span style="color: ${dayData.color}">${repData.rep.name} - ${daysOfWeek[dayData.dayOfWeek - 1] || `Day ${dayData.dayOfWeek}`} (Week ${dayData.week})</span>
                  </div>
                `)
            )
            .addTo(map.current!);

          markersRef.current.push(marker);
        });

        // Draw route lines for each day separately
        if (dayData.outlets.length > 1 && map.current) {
          // Use route order if available, otherwise use outlet order
          const orderedOutlets = dayData.schedule.routeOrder 
            ? (dayData.schedule.routeOrder as string[]).map(id => 
                dayData.outlets.find(o => o.id === id)!
              ).filter(Boolean)
            : dayData.outlets;
            
          const routeCoordinates = orderedOutlets.map(o => [o.longitude, o.latitude]);
          
          // Add source and layer for this rep's route on this specific day and week
          const sourceId = `route-${repId}-${dayData.dayOfWeek}-${dayData.week}`;
          const layerId = `route-layer-${repId}-${dayData.dayOfWeek}-${dayData.week}`;

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
                'line-color': dayData.color,
                'line-width': 3,
                'line-opacity': 0.6,
                // Different dash patterns for different weeks
                'line-dasharray': dayData.week === 1 || dayData.week === 3 ? [1, 0] : [2, 2]
              }
            });
          }
        }
      });
    });

    // Fit bounds to show all outlets
    if (Object.keys(repDayOutlets).length > 0) {
      const allOutlets = Object.values(repDayOutlets).flatMap(r => 
        Object.values(r.daySchedules).flatMap(d => d.outlets)
      );
      if (allOutlets.length > 0) {
        const bounds = new mapboxgl.LngLatBounds();
        allOutlets.forEach(outlet => {
          bounds.extend([outlet.longitude, outlet.latitude]);
        });
        map.current.fitBounds(bounds, { padding: 50 });
      }
    }
  }, [repDayOutlets, isMapLoaded, reps, selectedDays]);

  const toggleRep = (repId: string) => {
    setSelectedReps(prev => 
      prev.includes(repId) 
        ? prev.filter(id => id !== repId)
        : [...prev, repId]
    );
  };

  // Optimize route mutation
  const optimizeRouteMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/optimize-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repIds: selectedReps,
          days: selectedDays
        })
      });
      if (!response.ok) throw new Error('Failed to optimize routes');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      toast({
        title: "Routes Optimized!",
        description: "The selected routes have been further optimized for efficiency.",
      });
      setIsOptimizing(false);
    },
    onError: () => {
      toast({
        title: "Optimization Failed",
        description: "There was an error optimizing the routes. Please try again.",
        variant: "destructive",
      });
      setIsOptimizing(false);
    }
  });

  // Save routes mutation
  const saveRoutesMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/save-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repIds: selectedReps,
          days: selectedDays
        })
      });
      if (!response.ok) throw new Error('Failed to save routes');
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Routes Saved!",
        description: "The optimized routes have been saved successfully.",
      });
      setIsSaving(false);
    },
    onError: () => {
      toast({
        title: "Save Failed",
        description: "There was an error saving the routes. Please try again.",
        variant: "destructive",
      });
      setIsSaving(false);
    }
  });

  // Export to Excel
  const handleExport = async () => {
    setIsExporting(true);
    try {
      const response = await fetch('/api/export/schedules');

      if (!response.ok) throw new Error('Failed to export routes');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `route_schedules_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: "Export Successful!",
        description: "Routes have been exported to Excel.",
      });
    } catch (error) {
      toast({
        title: "Export Failed",
        description: "There was an error exporting the routes.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };



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
        {/* Action Buttons */}
        {selectedReps.length > 0 && (
          <div className="flex gap-2 mt-4">
            <Button
              onClick={() => {
                setIsOptimizing(true);
                optimizeRouteMutation.mutate();
              }}
              disabled={isOptimizing || selectedReps.length === 0}
              size="sm"
            >
              {isOptimizing ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
              ) : (
                <Zap className="h-4 w-4 mr-2" />
              )}
              Optimize Routes
            </Button>
            <Button
              onClick={() => {
                setIsSaving(true);
                saveRoutesMutation.mutate();
              }}
              disabled={isSaving || selectedReps.length === 0}
              variant="secondary"
              size="sm"
            >
              {isSaving ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-800 mr-2"></div>
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save
            </Button>
            <Button
              onClick={handleExport}
              disabled={isExporting || selectedReps.length === 0}
              variant="outline"
              size="sm"
            >
              {isExporting ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-800 mr-2"></div>
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              Export to Excel
            </Button>
          </div>
        )}
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
                          <span>{rep.name} - {rep.territory}</span>
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </Command>
            </PopoverContent>
          </Popover>

          <div className="space-y-2">
            <label className="text-sm font-medium">Select Role</label>
            <div className="flex flex-wrap gap-2">
              {availableRoles.map((role) => (
                <button
                  key={role.role}
                  onClick={() => {
                    setSelectedRole(role.role);
                    // Disable show all linked roles when switching away from rep
                    if (role.role !== 'rep') {
                      setShowAllLinkedRoles(false);
                    }
                  }}
                  className={`
                    px-3 py-1.5 rounded-full text-sm font-medium transition-all
                    ${selectedRole === role.role 
                      ? 'text-white shadow-sm' 
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }
                  `}
                  style={{ 
                    backgroundColor: selectedRole === role.role ? role.colorHex : undefined,
                  }}
                  data-testid={`button-role-${role.role}`}
                >
                  {role.roleName}
                </button>
              ))}
            </div>
            {selectedRole === 'rep' && availableRoles.length > 1 && (
              <label className="flex items-center space-x-2 mt-2">
                <input
                  type="checkbox"
                  checked={showAllLinkedRoles}
                  onChange={(e) => setShowAllLinkedRoles(e.target.checked)}
                  className="rounded border-gray-300"
                  data-testid="checkbox-show-all-roles"
                />
                <span className="text-sm">Show all linked role routes (with day offsets)</span>
              </label>
            )}
            {availableRoles.length === 1 && (
              <p className="text-xs text-muted-foreground">
                Configure role hierarchies to see other roles
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Select Days</label>
            <div className="grid grid-cols-2 gap-2">
              {daysOfWeek.map((day, index) => {
                const dayNumber = index + 1; // Convert 0-based index to 1-based dayOfWeek
                return (
                  <label key={day} className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={selectedDays.includes(dayNumber)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedDays([...selectedDays, dayNumber]);
                        } else {
                          setSelectedDays(selectedDays.filter(d => d !== dayNumber));
                        }
                      }}
                      className="rounded border-gray-300"
                    />
                    <div className="flex items-center gap-1">
                      <div 
                        className="w-3 h-3 rounded-full" 
                        style={{ backgroundColor: DAY_COLORS[index] }}
                      />
                      <span className="text-sm">{day}</span>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Select Weeks</label>
            <div className="grid grid-cols-2 gap-2">
              {[1, 2, 3, 4].map((week) => (
                <label key={week} className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={selectedWeeks.includes(week)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedWeeks([...selectedWeeks, week]);
                      } else {
                        setSelectedWeeks(selectedWeeks.filter(w => w !== week));
                      }
                    }}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm">Week {week}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-2 text-xs text-muted-foreground">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedWeeks([1, 3])}
                className="h-6 px-2"
              >
                Select Week 1/3
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedWeeks([2, 4])}
                className="h-6 px-2"
              >
                Select Week 2/4
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 p-4">
        <div ref={mapContainer} className="h-full min-h-[400px] rounded-lg overflow-hidden border" />

        {/* Help message when nothing is selected */}
        {selectedReps.length === 0 && (
          <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg text-center">
            <p className="text-sm text-gray-600">
              Select reps, days, and weeks from the filters above to view their routes on the map
            </p>
          </div>
        )}

        {/* Legend */}
        {selectedReps.length > 0 && (
          <div className="mt-4 p-3 border rounded-lg">
            <h4 className="font-semibold mb-2 text-sm">Selected Routes</h4>
            <div className="space-y-2">
              {Object.entries(repDayOutlets).map(([repId, repData]) => {
                return Object.entries(repData.daySchedules).map(([scheduleKey, dayData]) => {
                  return (
                    <div key={`${repId}-${scheduleKey}`} className="flex items-center gap-2">
                      <div 
                        className="w-3 h-3 rounded-full flex-shrink-0" 
                        style={{ backgroundColor: dayData.color }}
                      />
                      <span className="text-xs truncate flex-1">
                        {repData.rep.name} - {dayData.roleName ? `${dayData.roleName} - ` : ''}{daysOfWeek[dayData.dayOfWeek - 1] || `Day ${dayData.dayOfWeek}`} (Week {dayData.week}) - {dayData.outlets.length} outlets
                        {dayData.schedule.totalDistance && ` (${dayData.schedule.totalDistance.toFixed(1)}km)`}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => setEditingSchedule({ schedule: dayData.schedule, rep: repData.rep })}
                        title="Edit visit order"
                        data-testid={`button-edit-route-${dayData.schedule.id}`}
                      >
                        <GripVertical className="h-3 w-3" />
                      </Button>
                    </div>
                  );
                });
              })}
            </div>
          </div>
        )}

        {/* Route Order Editor */}
        {editingSchedule && (
          <RouteOrderEditor
            schedule={editingSchedule.schedule}
            outlets={outlets}
            isOpen={!!editingSchedule}
            onClose={() => setEditingSchedule(null)}
            repName={editingSchedule.rep.name}
          />
        )}
      </CardContent>
    </Card>
  );
}
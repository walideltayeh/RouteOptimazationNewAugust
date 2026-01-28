import { useEffect, useRef, useState } from 'react';
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
import { kMeansClustering, findOptimalClusters, enhancedKMeansClustering, workloadBasedClustering, calculateOptimalReps } from '@/lib/clustering';

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
  const [selectedOutlet, setSelectedOutlet] = useState<Outlet | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [isRenderingMarkers, setIsRenderingMarkers] = useState(false);
  const [viewMode, setViewMode] = useState<'cluster' | 'individual'>('cluster');
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [needsReoptimization, setNeedsReoptimization] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: outlets = [] } = useQuery<Outlet[]>({
    queryKey: ['/api/outlets'],
  });

  const { data: reps = [] } = useQuery<Rep[]>({
    queryKey: ['/api/reps'],
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

  // Initialize map
  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    try {
      if (!MAPBOX_TOKEN || MAPBOX_TOKEN === 'demo_token' || MAPBOX_TOKEN.includes('your_') || MAPBOX_TOKEN.length <= 10) {
        setMapError('Mapbox token not configured. Please set VITE_MAPBOX_PUBLIC_KEY environment variable.');
        return;
      }

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
        console.log('Map loaded successfully');
      });

      map.current.on('error', (e) => {
        console.error('Map error:', e);
        setMapError('Failed to load map. Please check your Mapbox token.');
      });

      // Add performance monitoring
      map.current.on('data', (e) => {
        if (e.dataType === 'source' && e.isSourceLoaded) {
          console.log('Map data loaded');
        }
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
  }, []);

  // Cluster-based rendering for massive datasets
  useEffect(() => {
    if (!map.current || !isMapLoaded || outlets.length === 0) return;

    console.log(`Rendering ${outlets.length} outlets using cluster visualization`);
    setIsRenderingMarkers(true);

    // Clear existing markers and sources
    const existingMarkers = document.querySelectorAll('.outlet-marker, .cluster-marker');
    existingMarkers.forEach(marker => marker.remove());

    // For very large datasets, use territory cluster visualization instead of individual markers
    if (outlets.length > 100) {
      renderTerritoryVisualization();
    } else {
      renderIndividualMarkers();
    }

  }, [outlets, isMapLoaded]);

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
        // Zoom to territory bounds on click
        const territoryBounds = new mapboxgl.LngLatBounds();
        territoryOutlets.forEach(outlet => {
          territoryBounds.extend([outlet.longitude, outlet.latitude]);
        });
        map.current!.fitBounds(territoryBounds, { padding: 50 });
      });

      new mapboxgl.Marker(clusterEl)
        .setLngLat([centerLng, centerLat])
        .setPopup(popup)
        .addTo(map.current!);
    });

    // Fit map to show all territories
    if (Object.keys(territoryGroups).length > 0) {
      map.current!.fitBounds(bounds, { padding: 50 });
    }
    
    setIsRenderingMarkers(false);
  };

  // Render individual markers for small datasets
  const renderIndividualMarkers = async () => {
    const bounds = new mapboxgl.LngLatBounds();
    const BATCH_SIZE = 25;
    
    for (let i = 0; i < outlets.length; i += BATCH_SIZE) {
      const batch = outlets.slice(i, i + BATCH_SIZE);
      
      await new Promise(resolve => {
        requestAnimationFrame(() => {
          batch.forEach((outlet) => {
            bounds.extend([outlet.longitude, outlet.latitude]);

            const markerEl = document.createElement('div');
            markerEl.className = 'outlet-marker w-3 h-3 rounded-full border border-white shadow-sm cursor-pointer hover:scale-125 transition-transform';
            markerEl.style.backgroundColor = getColorForTerritory(outlet.id);

            markerEl.addEventListener('click', () => {
              setSelectedOutlet(outlet);
            });

            new mapboxgl.Marker(markerEl)
              .setLngLat([outlet.longitude, outlet.latitude])
              .addTo(map.current!);
          });
          resolve(void 0);
        });
      });
    }

    if (outlets.length > 0) {
      map.current!.fitBounds(bounds, { padding: 50 });
    }
    
    setIsRenderingMarkers(false);
  };

  // Use clustering to create proper territory groups
  const createTerritoryGroups = () => {
    if (outlets.length === 0) return {};

    // Convert outlets to points for clustering
    const points = outlets.map(outlet => ({
      id: outlet.id,
      latitude: outlet.latitude,
      longitude: outlet.longitude,
      data: outlet
    }));

    // Calculate optimal number of reps based on workload
    const optimalReps = reps.length > 0 ? reps.length : calculateOptimalReps(outlets);

    // Use workload-based clustering for better territory distribution
    const clusters = workloadBasedClustering(points, optimalReps);

    // Create territory groups from clusters
    const territoryGroups: Record<string, Outlet[]> = {};

    clusters.forEach((cluster, index) => {
      const territoryName = `Zone ${String.fromCharCode(65 + index)}`; // Zone A, B, C, etc.
      territoryGroups[territoryName] = cluster.points.map(point => point.data);
    });

    // Handle any outlets not assigned to clusters
    const assignedOutletIds = new Set(
      Object.values(territoryGroups).flat().map(outlet => outlet.id)
    );

    const unassignedOutlets = outlets.filter(outlet => !assignedOutletIds.has(outlet.id));
    if (unassignedOutlets.length > 0) {
      territoryGroups['Unassigned'] = unassignedOutlets;
    }

    return territoryGroups;
  };

  const territoryGroups = createTerritoryGroups();

  const getColorForTerritory = (outletId: string) => {
    // Find which territory this outlet belongs to
    for (const [territory, territoryOutlets] of Object.entries(territoryGroups)) {
      if (territoryOutlets.some(outlet => outlet.id === outletId)) {
        if (territory === 'Unassigned') return '#9CA3AF';
        const territoryNames = Object.keys(territoryGroups).filter(t => t !== 'Unassigned').sort();
        const index = territoryNames.indexOf(territory) % TERRITORY_COLORS.length;
        return TERRITORY_COLORS[index];
      }
    }
    return '#9CA3AF'; // Default for unassigned
  };

  const getTerritoryColor = (territory: string) => {
    if (territory === 'Unassigned') return '#9CA3AF';
    const territoryNames = Object.keys(territoryGroups).filter(t => t !== 'Unassigned').sort();
    const index = territoryNames.indexOf(territory) % TERRITORY_COLORS.length;
    return TERRITORY_COLORS[index];
  };

  const getRepForTerritory = (territory: string) => {
    return reps.find(rep => rep.territory === territory);
  };

  if (!MAPBOX_TOKEN || MAPBOX_TOKEN.includes('demo_token')) {
    return (
      <div className="flex flex-col h-full ${className}">
        {/* Map Header */}

        <div className="flex flex-1 gap-4">
          {/* Map */}


                <div className="w-full h-[500px] rounded-lg bg-gray-100 flex items-center justify-center">
                  <div className="text-center p-4">
                    <p className="text-gray-600 mb-2">Map requires Mapbox API token</p>
                    <p className="text-sm text-gray-500">Set VITE_MAPBOX_TOKEN in your environment</p>
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
              {outlets.length > 100 && (
                <div className="flex items-center text-orange-600">
                  <div className="w-3 h-3 rounded-full bg-orange-500 mr-1"></div>
                  Cluster View
                </div>
              )}
            </div>
          </div>
        </CardHeader>
      </Card>

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
                    {outlets.length > 100 ? 'Loading territory visualization...' : 'Loading map markers...'}
                  </p>
                  <p className="text-xs text-gray-500">
                    {outlets.length > 100 
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
            <CardContent className="space-y-3">
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
                        ~{Math.round(territoryOutlets.reduce((sum, o) => sum + (o.visitFrequency || 2), 0) / 5)} visits/day
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
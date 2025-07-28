import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MapPin, Users, Navigation } from 'lucide-react';
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

  const { data: outlets = [] } = useQuery<Outlet[]>({
    queryKey: ['/api/outlets'],
  });

  const { data: reps = [] } = useQuery<Rep[]>({
    queryKey: ['/api/reps'],
  });

  // Initialize map
  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    try {
      if (!MAPBOX_TOKEN || MAPBOX_TOKEN === 'demo_token' || MAPBOX_TOKEN.includes('your_') || MAPBOX_TOKEN.length <= 10) {
        setMapError('Mapbox token not configured. Please set VITE_MAPBOX_PUBLIC_KEY environment variable.');
        return;
      }

      map.current = new mapboxgl.Map({
        container: mapContainer.current,
        style: 'mapbox://styles/mapbox/light-v11',
        center: [-74.5, 40.5],
        zoom: 9
      });

      map.current.on('load', () => {
        setIsMapLoaded(true);
        console.log('Map loaded successfully');
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
  }, []);

  // Add markers and fit bounds when outlets change (with performance optimization)
  useEffect(() => {
    if (!map.current || !isMapLoaded || outlets.length === 0) return;

    // Performance optimization: limit markers for large datasets
    const MAX_MARKERS = 500; // Limit markers to prevent browser freeze
    const shouldLimitMarkers = outlets.length > MAX_MARKERS;
    const displayOutlets = shouldLimitMarkers ? outlets.slice(0, MAX_MARKERS) : outlets;

    console.log(`Rendering ${displayOutlets.length} of ${outlets.length} outlets on map`);
    setIsRenderingMarkers(true);

    // Clear existing markers
    const existingMarkers = document.querySelectorAll('.outlet-marker');
    existingMarkers.forEach(marker => marker.remove());

    const bounds = new mapboxgl.LngLatBounds();

    // Use requestAnimationFrame to prevent blocking the UI thread
    const renderMarkersAsync = async () => {
      const BATCH_SIZE = 50; // Process markers in batches
      
      for (let i = 0; i < displayOutlets.length; i += BATCH_SIZE) {
        const batch = displayOutlets.slice(i, i + BATCH_SIZE);
        
        await new Promise(resolve => {
          requestAnimationFrame(() => {
            batch.forEach((outlet) => {
              bounds.extend([outlet.longitude, outlet.latitude]);

              const markerEl = document.createElement('div');
              markerEl.className = 'outlet-marker w-4 h-4 rounded-full border border-white shadow-md cursor-pointer hover:scale-110 transition-transform flex items-center justify-center';
              markerEl.style.backgroundColor = getColorForTerritory(outlet.id);
              markerEl.innerHTML = '<div class="w-1 h-1 bg-white rounded-full"></div>';

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

      // Fit map to show all outlets
      if (displayOutlets.length > 0) {
        map.current!.fitBounds(bounds, { padding: 50 });
      }

      // Show warning if markers were limited
      if (shouldLimitMarkers) {
        console.warn(`Performance optimization: Showing ${MAX_MARKERS} of ${outlets.length} outlets. Use clustering for better performance with large datasets.`);
      }
      
      setIsRenderingMarkers(false);
    };

    renderMarkersAsync();


  }, [outlets, isMapLoaded]);

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
                {outlets.length} Outlets
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

      <div className="flex flex-1 gap-4">
        {/* Map */}
        <Card className="flex-1">
          <CardContent className="p-0 h-full relative">
            <div 
              ref={mapContainer}
              className="w-full h-[500px] rounded-lg"
            />
            {isRenderingMarkers && outlets.length > 100 && (
              <div className="absolute inset-0 bg-white bg-opacity-80 flex items-center justify-center rounded-lg">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                  <p className="mt-2 text-sm text-gray-600">Loading map markers...</p>
                  <p className="text-xs text-gray-500">{outlets.length > 500 ? `Showing first 500 of ${outlets.length} outlets` : `Loading ${outlets.length} outlets`}</p>
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

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedOutlet(null)}
                  className="w-full"
                >
                  Close Details
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MapPin, Users, Navigation, Layers, Grid3X3, Check, ChevronsUpDown } from 'lucide-react';
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
  const [selectedOutlet, setSelectedOutlet] = useState<Outlet | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [isRenderingMarkers, setIsRenderingMarkers] = useState(false);
  const [viewMode, setViewMode] = useState<'cluster' | 'individual'>('cluster');
  const [selectedZones, setSelectedZones] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  const { data: outlets = [] } = useQuery<Outlet[]>({
    queryKey: ['/api/outlets'],
  });

  const { data: reps = [] } = useQuery<Rep[]>({
    queryKey: ['/api/reps'],
  });

  // Group outlets by territory/rep for clustering
  const territoryGroups = outlets.reduce((acc, outlet) => {
    const key = outlet.territory || outlet.repId || 'unassigned';
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(outlet);
    return acc;
  }, {} as Record<string, Outlet[]>);

  // Get territory color
  const getTerritoryColor = (territory: string) => {
    const territories = Object.keys(territoryGroups);
    const index = territories.indexOf(territory);
    return TERRITORY_COLORS[index % TERRITORY_COLORS.length];
  };

  // Get rep for territory
  const getRepForTerritory = (territory: string) => {
    const territoryOutlets = territoryGroups[territory];
    if (!territoryOutlets || territoryOutlets.length === 0) return null;
    return reps.find(r => r.id === territoryOutlets[0].repId);
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

  // Render map markers based on view mode
  useEffect(() => {
    if (!map.current || !isMapLoaded || outlets.length === 0) return;

    console.log(`Rendering ${outlets.length} outlets in ${viewMode} mode`);
    setIsRenderingMarkers(true);
    
    // For very large datasets, skip map rendering to prevent freezing
    if (outlets.length > 1000) {
      console.log('Dataset too large for map rendering, showing territory summary only');
      setMapError(`Dataset has ${outlets.length} outlets. Map display disabled for performance. Use dashboard analytics instead.`);
      setIsRenderingMarkers(false);
      return;
    }
    
    // Clear existing sources and layers
    try {
      if (map.current.getSource('territories')) {
        map.current.removeLayer('territory-clusters');
        map.current.removeLayer('territory-labels');
        map.current.removeSource('territories');
      }
      if (map.current.getSource('individual-outlets')) {
        map.current.removeLayer('individual-markers');
        map.current.removeSource('individual-outlets');
      }
    } catch (error) {
      console.log('Source/layer cleanup:', error);
    }

    if (viewMode === 'cluster') {
      renderClusterView();
    } else {
      renderIndividualView();
    }

    setIsRenderingMarkers(false);
  }, [outlets, reps, isMapLoaded, viewMode, selectedZones]);

  const renderClusterView = () => {
    // Create territory cluster data
    const territoryFeatures = Object.entries(territoryGroups).map(([territory, outlets], index) => {
      // Calculate center point of outlets in this territory
      const avgLat = outlets.reduce((sum, o) => sum + o.latitude, 0) / outlets.length;
      const avgLng = outlets.reduce((sum, o) => sum + o.longitude, 0) / outlets.length;
      
      return {
        type: 'Feature' as const,
        properties: {
          territory,
          count: outlets.length,
          color: TERRITORY_COLORS[index % TERRITORY_COLORS.length],
          outlets: outlets.slice(0, 10).map(o => ({ id: o.id, name: o.name })) // Limit to 10 for performance
        },
        geometry: {
          type: 'Point' as const,
          coordinates: [avgLng, avgLat]
        }
      };
    });

    try {
      // Add source
      map.current!.addSource('territories', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: territoryFeatures
        }
      });

      // Add cluster layer
      map.current!.addLayer({
        id: 'territory-clusters',
        type: 'circle',
        source: 'territories',
        paint: {
          'circle-radius': {
            type: 'exponential',
            property: 'count',
            stops: [
              [1, 15],
              [10, 25],
              [50, 35],
              [100, 45]
            ]
          },
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.8,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff'
        }
      });

      // Add count labels
      map.current!.addLayer({
        id: 'territory-labels',
        type: 'symbol',
        source: 'territories',
        layout: {
          'text-field': ['get', 'count'],
          'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
          'text-size': 12,
          'text-offset': [0, 0],
          'text-anchor': 'center'
        },
        paint: {
          'text-color': '#ffffff'
        }
      });

      // Add click handler for clusters
      map.current!.on('click', 'territory-clusters', (e) => {
        if (e.features && e.features[0]) {
          const feature = e.features[0];
          const properties = feature.properties as any;
          const { territory, count, outlets } = properties;
          
          setSelectedZones(prev => {
            if (prev.includes(territory)) {
              return prev.filter(z => z !== territory);
            } else {
              return [...prev, territory];
            }
          });
          
          // Show popup with territory info and button to view individual outlets
          new mapboxgl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(`
              <div class="p-3">
                <h3 class="font-bold mb-2">${territory}</h3>
                <p class="text-sm text-gray-600 mb-2">${count} outlets</p>
                <div class="mb-3 max-h-32 overflow-y-auto">
                  ${JSON.parse(outlets).map((o: any) => 
                    `<div class="text-xs text-gray-700">${o.name}</div>`
                  ).join('')}
                  ${count > 10 ? `<div class="text-xs text-gray-500">...and ${count - 10} more</div>` : ''}
                </div>
                <button onclick="window.showIndividualOutlets('${territory}')" 
                        class="w-full px-3 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600">
                  View Individual Outlets
                </button>
              </div>
            `)
            .addTo(map.current!);
        }
      });

      // Fit map to show all territories
      if (territoryFeatures.length > 0) {
        const coordinates = territoryFeatures.map(f => f.geometry.coordinates);
        const bounds = coordinates.reduce((bounds, coord) => {
          return bounds.extend(coord as [number, number]);
        }, new mapboxgl.LngLatBounds(coordinates[0] as [number, number], coordinates[0] as [number, number]));
        
        map.current!.fitBounds(bounds, { padding: 50 });
      }

      console.log(`Successfully rendered ${territoryFeatures.length} territory clusters`);
      
    } catch (error) {
      console.error('Error adding territory clusters:', error);
      setMapError('Failed to render territories. The dataset might be too large.');
    }
  };

  const renderIndividualView = () => {
    // Filter outlets by selected zones if any
    const outletsToShow = selectedZones.length > 0
      ? selectedZones.flatMap(zone => territoryGroups[zone] || [])
      : outlets.slice(0, 200); // Limit to 200 for performance

    const outletFeatures = outletsToShow.map((outlet, index) => ({
      type: 'Feature' as const,
      properties: {
        id: outlet.id,
        name: outlet.name,
        territory: outlet.territory,
        visitFrequency: outlet.visitFrequency,
        color: getTerritoryColor(outlet.territory || outlet.repId || 'unassigned')
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [outlet.longitude, outlet.latitude]
      }
    }));

    try {
      // Add source
      map.current!.addSource('individual-outlets', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: outletFeatures
        }
      });

      // Add individual outlet markers
      map.current!.addLayer({
        id: 'individual-markers',
        type: 'circle',
        source: 'individual-outlets',
        paint: {
          'circle-radius': 8,
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.8,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff'
        }
      });

      // Add click handler for individual outlets
      map.current!.on('click', 'individual-markers', (e) => {
        if (e.features && e.features[0]) {
          const feature = e.features[0];
          const properties = feature.properties as any;
          const { name, territory, visitFrequency } = properties;
          
          new mapboxgl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(`
              <div class="p-2">
                <h3 class="font-bold">${name}</h3>
                <p class="text-sm text-gray-600">Territory: ${territory}</p>
                <p class="text-sm text-gray-600">Visit Frequency: VF${visitFrequency}</p>
              </div>
            `)
            .addTo(map.current!);
        }
      });

      // Fit map to show outlets
      if (outletFeatures.length > 0) {
        const coordinates = outletFeatures.map(f => f.geometry.coordinates);
        const bounds = coordinates.reduce((bounds, coord) => {
          return bounds.extend(coord as [number, number]);
        }, new mapboxgl.LngLatBounds(coordinates[0] as [number, number], coordinates[0] as [number, number]));
        
        map.current!.fitBounds(bounds, { padding: 50 });
      }

      console.log(`Successfully rendered ${outletFeatures.length} individual outlets`);
      
    } catch (error) {
      console.error('Error adding individual outlets:', error);
      setMapError('Failed to render individual outlets.');
    }
  };

  // Global function to switch to individual view for a specific zone
  useEffect(() => {
    (window as any).showIndividualOutlets = (territory: string) => {
      setSelectedZones([territory]);
      setViewMode('individual');
    };
  }, []);

  if (mapError) {
    return (
      <div className={`flex flex-col h-full ${className}`}>
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center">
              <Navigation className="mr-2 h-5 w-5" />
              Territory Map
            </CardTitle>
          </CardHeader>
        </Card>

        <div className="flex flex-1 gap-4">
          <div className="w-full h-[500px] rounded-lg bg-gray-100 flex items-center justify-center">
            <div className="text-center p-4">
              <p className="text-gray-600 mb-2">{mapError}</p>
              {outlets.length > 1000 && (
                <p className="text-sm text-gray-500">Use Dashboard Analytics for data insights</p>
              )}
            </div>
          </div>
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
            <div className="flex items-center space-x-4">
              {/* View Mode Toggle */}
              <div className="flex bg-gray-100 rounded-lg p-1">
                <Button
                  variant={viewMode === 'cluster' ? 'default' : 'ghost'}
                  size="sm"
                  className="h-8 px-3"
                  onClick={() => {
                    setViewMode('cluster');
                    setSelectedZones([]);
                  }}
                >
                  <Layers className="mr-1 h-4 w-4" />
                  Clusters
                </Button>
                <Button
                  variant={viewMode === 'individual' ? 'default' : 'ghost'}
                  size="sm"
                  className="h-8 px-3"
                  onClick={() => setViewMode('individual')}
                >
                  <Grid3X3 className="mr-1 h-4 w-4" />
                  Individual
                </Button>
              </div>
              
              {/* Stats */}
              <div className="flex items-center space-x-4 text-sm text-gray-600">
                <div className="flex items-center">
                  <MapPin className="mr-1 h-4 w-4" />
                  {outlets.length.toLocaleString()} Outlets
                </div>
                <div className="flex items-center">
                  <Users className="mr-1 h-4 w-4" />
                  {reps.length} Reps
                </div>
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
            {isRenderingMarkers && (
              <div className="absolute inset-0 bg-white bg-opacity-90 flex items-center justify-center rounded-lg">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                  <p className="mt-2 text-sm text-gray-600">
                    Loading {viewMode === 'cluster' ? 'territory clusters' : 'individual outlets'}...
                  </p>
                </div>
              </div>
            )}
            
            {/* Selected Zones Info */}
            {selectedZones.length > 0 && viewMode === 'individual' && (
              <div className="absolute top-4 left-4 bg-white rounded-lg shadow-lg p-3 max-w-xs">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-semibold text-sm">Viewing Zones</h4>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => {
                      setSelectedZones([]);
                      setViewMode('cluster');
                    }}
                  >
                    ×
                  </Button>
                </div>
                <div className="space-y-1">
                  {selectedZones.map(zone => (
                    <div key={zone}>
                      <p className="text-sm text-gray-600">{zone}</p>
                      <p className="text-xs text-gray-500">
                        {territoryGroups[zone]?.length || 0} outlets
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Territory Legend and Info */}
        <div className="w-80 space-y-4">
          {/* Territory Selector */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Territories</CardTitle>
            </CardHeader>
            <CardContent>
              <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    className="w-full justify-between"
                  >
                    {selectedZones.length === 0
                      ? "Select territories..."
                      : `${selectedZones.length} zone${selectedZones.length === 1 ? '' : 's'} selected`}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-full p-0">
                  <Command>
                    <CommandInput placeholder="Search territories..." />
                    <CommandEmpty>No territory found.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        onSelect={() => {
                          setSelectedZones([]);
                          setViewMode('cluster');
                          setOpen(false);
                        }}
                      >
                        <Check
                          className={`mr-2 h-4 w-4 ${
                            selectedZones.length === 0 ? "opacity-100" : "opacity-0"
                          }`}
                        />
                        All Territories
                      </CommandItem>
                      {Object.entries(territoryGroups).map(([territory, territoryOutlets]) => {
                        return (
                          <CommandItem
                            key={territory}
                            onSelect={() => {
                              setSelectedZones(current => {
                                const isSelected = current.includes(territory);
                                const newSelection = isSelected
                                  ? current.filter(t => t !== territory)
                                  : [...current, territory];
                                
                                if (newSelection.length > 0) {
                                  setViewMode('individual');
                                } else {
                                  setViewMode('cluster');
                                }
                                
                                return newSelection;
                              });
                            }}
                          >
                            <Check
                              className={`mr-2 h-4 w-4 ${
                                selectedZones.includes(territory) ? "opacity-100" : "opacity-0"
                              }`}
                            />
                            <div className="flex items-center space-x-2">
                              <div
                                className="w-3 h-3 rounded-full"
                                style={{ backgroundColor: getTerritoryColor(territory) }}
                              />
                              <span>{territory} ({territoryOutlets.length} outlets)</span>
                            </div>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </Command>
                </PopoverContent>
              </Popover>

              {/* Selected Territories Details */}
              {selectedZones.length > 0 && (
                <div className="mt-4 space-y-3">
                  {selectedZones.map(territory => {
                    const territoryOutlets = territoryGroups[territory];
                    const rep = getRepForTerritory(territory);
                    const vf2Count = territoryOutlets?.filter(o => o.visitFrequency === 2).length || 0;
                    const vf4Count = territoryOutlets?.filter(o => o.visitFrequency === 4).length || 0;

                    return (
                      <div key={territory} className="p-3 bg-gray-50 rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="font-semibold text-sm">{territory}</h4>
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: getTerritoryColor(territory) }}
                          />
                        </div>
                        {rep && (
                          <p className="text-xs text-gray-600 mb-1">{rep.name}</p>
                        )}
                        <div className="text-xs text-gray-500">
                          <span className="font-medium">{territoryOutlets?.length || 0}</span> outlets • 
                          VF2: <span className="font-medium">{vf2Count}</span> • 
                          VF4: <span className="font-medium">{vf4Count}</span>
                        </div>
                      </div>
                    );
                  })}
                  <div className="pt-2 border-t text-sm">
                    <p className="font-medium">Total Selected:</p>
                    <p className="text-gray-600">
                      {selectedZones.reduce((sum, zone) => sum + (territoryGroups[zone]?.length || 0), 0)} outlets across {selectedZones.length} zones
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
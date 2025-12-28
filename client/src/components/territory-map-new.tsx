import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MapPin, Users, Navigation, Layers, Grid3X3, Check, ChevronsUpDown, RefreshCw, Edit2, AlertCircle } from 'lucide-react';
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
  const [selectedOutlet, setSelectedOutlet] = useState<Outlet | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [isRenderingMarkers, setIsRenderingMarkers] = useState(false);
  const [viewMode, setViewMode] = useState<'cluster' | 'individual'>('cluster');
  const [selectedZones, setSelectedZones] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [editingOutlet, setEditingOutlet] = useState<{id: string, name: string, territory: string} | null>(null);
  const [newTerritory, setNewTerritory] = useState<string>('');
  const [pendingChanges, setPendingChanges] = useState<Array<{id: string, name: string, oldTerritory: string, newTerritory: string}>>([]);
  const [showReoptimizeDialog, setShowReoptimizeDialog] = useState(false);
  const [vfFilters, setVfFilters] = useState<{vf1: boolean, vf2: boolean, vf4: boolean}>({vf1: true, vf2: true, vf4: true});
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: outlets = [] } = useQuery<Outlet[]>({
    queryKey: ['/api/outlets'],
  });

  const { data: reps = [] } = useQuery<Rep[]>({
    queryKey: ['/api/reps'],
  });

  const reassignMutation = useMutation({
    mutationFn: async (updates: Array<{id: string, territory: string, repId?: string, outletData: {name: string, oldTerritory: string}}>) => {
      const apiUpdates = updates.map(u => ({ id: u.id, territory: u.territory, repId: u.repId }));
      await apiRequest("POST", "/api/outlets/bulk-reassign", { updates: apiUpdates });
      return updates; // Return the full data for onSuccess
    },
    onSuccess: (updates) => {
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
      // Only add to pending changes after successful mutation
      updates.forEach(update => {
        setPendingChanges(prev => [...prev, {
          id: update.id,
          name: update.outletData.name,
          oldTerritory: update.outletData.oldTerritory,
          newTerritory: update.territory
        }]);
      });
      toast({ title: "Success", description: "Outlets reassigned successfully" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to reassign outlets", variant: "destructive" });
    }
  });

  const reoptimizeMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/reoptimize", {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      queryClient.invalidateQueries({ queryKey: ['/api/reps'] });
      setPendingChanges([]);
      setShowReoptimizeDialog(false);
      toast({ 
        title: "Re-optimization complete", 
        description: "All schedules have been regenerated with the new zone assignments" 
      });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to re-optimize schedules", variant: "destructive" });
    }
  });

  const handleReassignOutlet = () => {
    if (!editingOutlet || !newTerritory) return;
    
    const rep = reps.find(r => r.territory === newTerritory);
    const updates = [{ 
      id: editingOutlet.id, 
      territory: newTerritory, 
      repId: rep?.id,
      outletData: { name: editingOutlet.name, oldTerritory: editingOutlet.territory }
    }];
    
    // Pending changes are now added in onSuccess callback
    reassignMutation.mutate(updates);
    setEditingOutlet(null);
    setNewTerritory('');
  };

  const handleApplyReoptimization = () => {
    reoptimizeMutation.mutate();
  };

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

    console.log(`Rendering ${outlets.length} outlets in ${viewMode} mode, VF filters: VF1=${vfFilters.vf1}, VF2=${vfFilters.vf2}, VF4=${vfFilters.vf4}`);
    setIsRenderingMarkers(true);
    
    // For very large datasets, use optimized rendering
    if (outlets.length > 5000) {
      console.log('Dataset too large for map rendering, showing territory summary only');
      setMapError(`Dataset has ${outlets.length} outlets. Map display disabled for performance. Use dashboard analytics instead.`);
      setIsRenderingMarkers(false);
      return;
    }
    
    // Clear existing sources and layers properly
    const mapInstance = map.current;
    try {
      if (mapInstance.getLayer('territory-clusters')) mapInstance.removeLayer('territory-clusters');
      if (mapInstance.getLayer('territory-labels')) mapInstance.removeLayer('territory-labels');
      if (mapInstance.getSource('territories')) mapInstance.removeSource('territories');
      if (mapInstance.getLayer('individual-markers')) mapInstance.removeLayer('individual-markers');
      if (mapInstance.getSource('individual-outlets')) mapInstance.removeSource('individual-outlets');
    } catch (error) {
      console.log('Source/layer cleanup:', error);
    }

    // Capture current filter state for use in render functions
    const currentVfFilters = { ...vfFilters };
    const currentSelectedZones = [...selectedZones];

    if (viewMode === 'cluster') {
      renderClusterView();
    } else {
      // Inline rendering for individual view to ensure fresh filter state
      let outletsToShow = currentSelectedZones.length > 0
        ? currentSelectedZones.flatMap(zone => territoryGroups[zone] || [])
        : outlets.length > 500 ? outlets.slice(0, 500) : outlets;
      
      // Apply VF filters with current state
      outletsToShow = outletsToShow.filter(outlet => {
        const vf = outlet.visitFrequency;
        if (vf === 1 && !currentVfFilters.vf1) return false;
        if (vf === 2 && !currentVfFilters.vf2) return false;
        if (vf === 4 && !currentVfFilters.vf4) return false;
        return true;
      });
      
      console.log(`Filtered to ${outletsToShow.length} outlets after VF filter`);

      const outletFeatures = outletsToShow.map((outlet) => ({
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
        mapInstance.addSource('individual-outlets', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: outletFeatures
          }
        });

        mapInstance.addLayer({
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

        // Attach click handler inline
        attachIndividualMarkerClickHandler();

        if (outletFeatures.length > 0) {
          const coordinates = outletFeatures.map(f => f.geometry.coordinates);
          const bounds = coordinates.reduce((bounds, coord) => {
            return bounds.extend(coord as [number, number]);
          }, new mapboxgl.LngLatBounds(coordinates[0] as [number, number], coordinates[0] as [number, number]));
          mapInstance.fitBounds(bounds, { padding: 50 });
        }
        
        console.log(`Successfully rendered ${outletFeatures.length} individual markers`);
      } catch (error) {
        console.error('Error adding individual markers:', error);
      }
    }

    setIsRenderingMarkers(false);
  }, [outlets, reps, isMapLoaded, viewMode, selectedZones, vfFilters]);

  // Helper function to attach click handler for individual markers
  const attachIndividualMarkerClickHandler = () => {
    if (!map.current) return;
    
    map.current.on('click', 'individual-markers', (e) => {
      if (e.features && e.features[0]) {
        const feature = e.features[0];
        const properties = feature.properties as any;
        const { id, name, territory, visitFrequency } = properties;
        
        const escapeHtml = (str: string) => str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
        
        const safeName = escapeHtml(name || '');
        const safeTerritory = escapeHtml(territory || '');
        
        const getVfBadgeStyle = (vf: number) => {
          switch (vf) {
            case 1: return 'background-color: #dcfce7; color: #15803d; border: 1px solid #86efac;';
            case 2: return 'background-color: #ffedd5; color: #c2410c; border: 1px solid #fdba74;';
            case 4: return 'background-color: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5;';
            default: return 'background-color: #f3f4f6; color: #374151; border: 1px solid #d1d5db;';
          }
        };
        
        const vfLabel = visitFrequency === 1 ? 'VF1 (Monthly)' : visitFrequency === 2 ? 'VF2 (Bi-weekly)' : 'VF4 (Weekly)';
        
        const popup = new mapboxgl.Popup()
          .setLngLat(e.lngLat)
          .setHTML(`
            <div class="p-3" style="min-width: 220px;">
              <h3 class="font-bold text-base mb-2">${safeName}</h3>
              <div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">
                <div style="margin-bottom: 4px;"><strong>Code:</strong> ${escapeHtml(id || '')}</div>
                <div style="margin-bottom: 4px;"><strong>Zone:</strong> ${safeTerritory}</div>
                <div style="margin-bottom: 4px;"><strong>Visit Frequency:</strong></div>
                <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; ${getVfBadgeStyle(visitFrequency)}">
                  ${vfLabel}
                </span>
              </div>
              <button 
                data-outlet-id="${escapeHtml(id || '')}"
                data-outlet-name="${safeName}"
                data-outlet-territory="${safeTerritory}"
                class="edit-outlet-btn mt-2 w-full px-3 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600 cursor-pointer">
                Reassign to Different Zone
              </button>
            </div>
          `)
          .addTo(map.current!);
        
        setTimeout(() => {
          const btn = document.querySelector('.edit-outlet-btn');
          if (btn) {
            btn.addEventListener('click', (evt) => {
              const target = evt.target as HTMLElement;
              const outletId = target.dataset.outletId || '';
              const outletName = target.dataset.outletName || '';
              const outletTerritory = target.dataset.outletTerritory || '';
              setEditingOutlet({ id: outletId, name: outletName, territory: outletTerritory });
              popup.remove();
            });
          }
        }, 0);
      }
    });
  };

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
          outlets: JSON.stringify(outlets.slice(0, 10).map(o => ({ id: o.id, name: o.name }))) // Limit to 10 for performance
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

      // Add click handler for clusters - using safe data attributes to avoid XSS
      map.current!.on('click', 'territory-clusters', (e) => {
        if (e.features && e.features[0]) {
          const feature = e.features[0];
          const properties = feature.properties as any;
          const { territory, count, outlets } = properties;
          
          // Escape HTML special characters for display
          const escapeHtml = (str: string) => str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
          
          const safeTerritory = escapeHtml(territory || '');
          
          setSelectedZones(prev => {
            if (prev.includes(territory)) {
              return prev.filter(z => z !== territory);
            } else {
              return [...prev, territory];
            }
          });
          
          // Parse outlets and escape their names
          let outletsList: any[] = [];
          try {
            outletsList = JSON.parse(outlets);
          } catch (e) {
            outletsList = [];
          }
          
          // Show popup with territory info and button to view individual outlets
          const popup = new mapboxgl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(`
              <div class="p-3">
                <h3 class="font-bold mb-2">${safeTerritory}</h3>
                <p class="text-sm text-gray-600 mb-2">${count} outlets</p>
                <div class="mb-3 max-h-32 overflow-y-auto">
                  ${outletsList.map((o: any) => 
                    `<div class="text-xs text-gray-700">${escapeHtml(o.name || '')}</div>`
                  ).join('')}
                  ${count > 10 ? `<div class="text-xs text-gray-500">...and ${count - 10} more</div>` : ''}
                </div>
                <button 
                  data-territory="${safeTerritory}"
                  class="view-territory-btn w-full px-3 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600 cursor-pointer">
                  View Individual Outlets
                </button>
              </div>
            `)
            .addTo(map.current!);
          
          // Attach click handler after popup is added
          setTimeout(() => {
            const btn = document.querySelector('.view-territory-btn');
            if (btn) {
              btn.addEventListener('click', (evt) => {
                const target = evt.target as HTMLElement;
                const territoryName = target.dataset.territory || '';
                setSelectedZones([territoryName]);
                setViewMode('individual');
                popup.remove();
              });
            }
          }, 0);
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
    let outletsToShow = selectedZones.length > 0
      ? selectedZones.flatMap(zone => territoryGroups[zone] || [])
      : outlets.length > 500 ? outlets.slice(0, 500) : outlets; // Limit for very large datasets
    
    // Apply VF filters (visualization only, doesn't affect scheduling)
    outletsToShow = outletsToShow.filter(outlet => {
      const vf = outlet.visitFrequency;
      if (vf === 1 && !vfFilters.vf1) return false;
      if (vf === 2 && !vfFilters.vf2) return false;
      if (vf === 4 && !vfFilters.vf4) return false;
      return true;
    });

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

      // Add click handler for individual outlets - using safe data attributes to avoid XSS
      map.current!.on('click', 'individual-markers', (e) => {
        if (e.features && e.features[0]) {
          const feature = e.features[0];
          const properties = feature.properties as any;
          const { id, name, territory, visitFrequency } = properties;
          
          // Escape HTML special characters for display
          const escapeHtml = (str: string) => str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
          
          const safeName = escapeHtml(name || '');
          const safeTerritory = escapeHtml(territory || '');
          
          // Get VF badge color based on visit frequency
          const getVfBadgeStyle = (vf: number) => {
            switch (vf) {
              case 1: return 'background-color: #dcfce7; color: #15803d; border: 1px solid #86efac;'; // Green
              case 2: return 'background-color: #ffedd5; color: #c2410c; border: 1px solid #fdba74;'; // Orange
              case 4: return 'background-color: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5;'; // Red
              default: return 'background-color: #f3f4f6; color: #374151; border: 1px solid #d1d5db;';
            }
          };
          
          const vfLabel = visitFrequency === 1 ? 'VF1 (Monthly)' : visitFrequency === 2 ? 'VF2 (Bi-weekly)' : 'VF4 (Weekly)';
          
          // Use data attributes instead of inline onclick to prevent XSS
          const popup = new mapboxgl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(`
              <div class="p-3" style="min-width: 220px;">
                <h3 class="font-bold text-base mb-2">${safeName}</h3>
                <div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">
                  <div style="margin-bottom: 4px;"><strong>Code:</strong> ${escapeHtml(id || '')}</div>
                  <div style="margin-bottom: 4px;"><strong>Zone:</strong> ${safeTerritory}</div>
                  <div style="margin-bottom: 4px;"><strong>Visit Frequency:</strong></div>
                  <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; ${getVfBadgeStyle(visitFrequency)}">
                    ${vfLabel}
                  </span>
                </div>
                <button 
                  data-outlet-id="${escapeHtml(id || '')}"
                  data-outlet-name="${safeName}"
                  data-outlet-territory="${safeTerritory}"
                  class="edit-outlet-btn mt-2 w-full px-3 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600 cursor-pointer">
                  Reassign to Different Zone
                </button>
              </div>
            `)
            .addTo(map.current!);
          
          // Attach click handler after popup is added
          setTimeout(() => {
            const btn = document.querySelector('.edit-outlet-btn');
            if (btn) {
              btn.addEventListener('click', (evt) => {
                const target = evt.target as HTMLElement;
                const outletId = target.dataset.outletId || '';
                const outletName = target.dataset.outletName || '';
                const outletTerritory = target.dataset.outletTerritory || '';
                setEditingOutlet({ id: outletId, name: outletName, territory: outletTerritory });
                popup.remove();
              });
            }
          }, 0);
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

  // Note: Individual outlet view switching is now handled via data attributes and event delegation
  // to prevent XSS vulnerabilities with user-supplied territory names

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
              {outlets.length > 5000 && (
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

              {/* Re-optimize button */}
              {pendingChanges.length > 0 && (
                <Button 
                  variant="default" 
                  className="bg-orange-500 hover:bg-orange-600"
                  onClick={() => setShowReoptimizeDialog(true)}
                  data-testid="button-reoptimize"
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Re-optimize ({pendingChanges.length} changes)
                </Button>
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
                    Loading {viewMode === 'cluster' ? 'territory clusters' : 'individual outlets'}...
                  </p>
                  {outlets.length > 1000 && (
                    <p className="text-xs text-gray-500 mt-1">
                      Processing {outlets.length} outlets...
                    </p>
                  )}
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
            
            {/* VF Legend and Filter */}
            <div className="absolute bottom-4 left-4 bg-white rounded-lg shadow-lg p-3">
              <h4 className="font-semibold text-sm mb-2">Visit Frequency Legend</h4>
              <div className="space-y-2">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={vfFilters.vf1} 
                    onChange={(e) => setVfFilters(prev => ({...prev, vf1: e.target.checked}))}
                    className="rounded border-gray-300"
                  />
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 border border-green-200">
                    VF1 - Monthly
                  </span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={vfFilters.vf2} 
                    onChange={(e) => setVfFilters(prev => ({...prev, vf2: e.target.checked}))}
                    className="rounded border-gray-300"
                  />
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800 border border-orange-200">
                    VF2 - Bi-weekly
                  </span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={vfFilters.vf4} 
                    onChange={(e) => setVfFilters(prev => ({...prev, vf4: e.target.checked}))}
                    className="rounded border-gray-300"
                  />
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 border border-red-200">
                    VF4 - Weekly
                  </span>
                </label>
              </div>
              <p className="text-xs text-gray-500 mt-2">Toggle to filter outlets on map</p>
            </div>
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
                  <Command className="h-[300px]">
                    <CommandInput placeholder="Search territories..." />
                    <CommandEmpty>No territory found.</CommandEmpty>
                    <CommandGroup className="overflow-y-auto max-h-[240px]">
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
                    const vf1Count = territoryOutlets?.filter(o => o.visitFrequency === 1).length || 0;
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
                        <div className="text-xs text-gray-500 space-y-1">
                          <div><span className="font-medium">{territoryOutlets?.length || 0}</span> outlets total</div>
                          <div className="flex flex-wrap gap-1">
                            {vf1Count > 0 && (
                              <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-xs">
                                VF1: {vf1Count}
                              </Badge>
                            )}
                            {vf2Count > 0 && (
                              <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-200 text-xs">
                                VF2: {vf2Count}
                              </Badge>
                            )}
                            {vf4Count > 0 && (
                              <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 text-xs">
                                VF4: {vf4Count}
                              </Badge>
                            )}
                          </div>
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

      {/* Outlet Reassignment Dialog */}
      <Dialog open={!!editingOutlet} onOpenChange={(open) => !open && setEditingOutlet(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center">
              <Edit2 className="mr-2 h-5 w-5" />
              Reassign Outlet
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="text-sm text-gray-600">Outlet:</p>
              <p className="font-medium">{editingOutlet?.name}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Current Zone:</p>
              <Badge variant="outline">{editingOutlet?.territory}</Badge>
            </div>
            <div>
              <p className="text-sm text-gray-600 mb-2">New Zone:</p>
              <Select value={newTerritory} onValueChange={setNewTerritory}>
                <SelectTrigger data-testid="select-new-territory">
                  <SelectValue placeholder="Select new territory" />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(territoryGroups).filter(t => t !== editingOutlet?.territory).map(territory => (
                    <SelectItem key={territory} value={territory}>{territory}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingOutlet(null)}>Cancel</Button>
            <Button 
              onClick={handleReassignOutlet} 
              disabled={!newTerritory || reassignMutation.isPending}
              data-testid="button-confirm-reassign"
            >
              {reassignMutation.isPending ? "Reassigning..." : "Reassign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Re-optimization Confirmation Dialog */}
      <Dialog open={showReoptimizeDialog} onOpenChange={setShowReoptimizeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center">
              <AlertCircle className="mr-2 h-5 w-5 text-orange-500" />
              Apply Re-optimization
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              You have made {pendingChanges.length} zone reassignment(s). Re-optimizing will regenerate all schedules with the VF-aware algorithm.
            </p>
            <div className="bg-gray-50 rounded-lg p-3 max-h-48 overflow-y-auto">
              <p className="text-xs font-medium text-gray-700 mb-2">Changes to apply:</p>
              {pendingChanges.map((change, idx) => (
                <div key={idx} className="text-xs text-gray-600 py-1 border-b border-gray-200 last:border-0">
                  <span className="font-medium">{change.name}</span>: {change.oldTerritory} → {change.newTerritory}
                </div>
              ))}
            </div>
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
              <p className="text-sm text-yellow-800">
                This will regenerate all rep schedules. The process ensures VF4 outlets are visited weekly, VF2 bi-weekly, and VF1 monthly.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReoptimizeDialog(false)}>Cancel</Button>
            <Button 
              onClick={handleApplyReoptimization}
              disabled={reoptimizeMutation.isPending}
              className="bg-orange-500 hover:bg-orange-600"
              data-testid="button-apply-reoptimize"
            >
              {reoptimizeMutation.isPending ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Re-optimizing...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Apply Re-optimization
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
import { useEffect, useState, useCallback, useMemo } from 'react';
import { GoogleMap, LoadScript, Marker, InfoWindow, MarkerClusterer } from '@react-google-maps/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MapPin, Users, Navigation, Layers, Grid3X3, Check, ChevronsUpDown, RefreshCw, Edit2, AlertCircle, Download, Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import type { Outlet, Rep } from '@shared/schema';

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

interface TerritoryMapProps {
  className?: string;
}

const TERRITORY_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
];

const mapContainerStyle = {
  width: '100%',
  height: '500px',
  borderRadius: '0.5rem'
};

const defaultCenter = {
  lat: 33.8938,
  lng: 35.8623
};

export default function TerritoryMap({ className }: TerritoryMapProps) {
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [selectedOutlet, setSelectedOutlet] = useState<Outlet | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<{territory: string, lat: number, lng: number, count: number, outlets: Outlet[]} | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [viewMode, setViewMode] = useState<'cluster' | 'individual'>('cluster');
  const [selectedZones, setSelectedZones] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [editingOutlet, setEditingOutlet] = useState<{id: string, name: string, territory: string, lat?: number, lng?: number} | null>(null);
  const [newTerritory, setNewTerritory] = useState<string>('');
  const [pendingChanges, setPendingChanges] = useState<Array<{id: string, name: string, oldTerritory: string, newTerritory: string}>>([]);
  const [showReoptimizeDialog, setShowReoptimizeDialog] = useState(false);
  const [vfFilters, setVfFilters] = useState<{vf1: boolean, vf2: boolean, vf4: boolean}>({vf1: true, vf2: true, vf4: true});
  const [isExporting, setIsExporting] = useState(false);
  const [deletingOutletId, setDeletingOutletId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingZone, setDeletingZone] = useState<{name: string, count: number} | null>(null);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const exportAllClusters = async () => {
    setIsExporting(true);
    try {
      const response = await fetch('/api/export/clusters');
      if (!response.ok) throw new Error('Export failed');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clusters_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast({
        title: "Export successful",
        description: "All clusters exported to Excel",
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: "Failed to export clusters",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const exportSelectedClusters = async () => {
    if (selectedZones.length === 0) {
      toast({
        title: "No clusters selected",
        description: "Please select at least one cluster to export",
        variant: "destructive",
      });
      return;
    }
    setIsExporting(true);
    try {
      const clusterIds = selectedZones.join(',');
      const response = await fetch(`/api/export/clusters?clusters=${encodeURIComponent(clusterIds)}`);
      if (!response.ok) throw new Error('Export failed');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clusters_selected_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast({
        title: "Export successful",
        description: `${selectedZones.length} cluster(s) exported to Excel`,
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: "Failed to export selected clusters",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

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
      return updates;
    },
    onSuccess: (updates) => {
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
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
      queryClient.invalidateQueries({ queryKey: ['/api/role-schedules'] });
      queryClient.invalidateQueries({ queryKey: ['/api/reps'] });
      setPendingChanges([]);
      setShowReoptimizeDialog(false);
      toast({ 
        title: "Re-optimization complete", 
        description: "All schedules and role schedules have been regenerated with the new zone assignments" 
      });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to re-optimize schedules", variant: "destructive" });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (outletId: string) => {
      await apiRequest("DELETE", `/api/outlets/${outletId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      toast({ title: "Success", description: "Outlet deleted successfully" });
      setDeletingOutletId(null);
      setShowDeleteConfirm(false);
      setShowReoptimizeDialog(true);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete outlet", variant: "destructive" });
    }
  });

  const handleDeleteOutlet = () => {
    if (!deletingOutletId) return;
    deleteMutation.mutate(deletingOutletId);
  };

  const bulkDeleteMutation = useMutation({
    mutationFn: async (zoneName: string) => {
      await apiRequest("DELETE", `/api/outlets/zone/${encodeURIComponent(zoneName)}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      toast({ title: "Success", description: `Zone "${deletingZone?.name}" deleted successfully (${deletingZone?.count} outlets)` });
      setDeletingZone(null);
      setShowBulkDeleteConfirm(false);
      setSelectedZones(prev => prev.filter(z => z !== deletingZone?.name));
      setShowReoptimizeDialog(true);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete zone", variant: "destructive" });
    }
  });

  const handleBulkDeleteZone = () => {
    if (!deletingZone) return;
    bulkDeleteMutation.mutate(deletingZone.name);
  };

  const handleReassignOutlet = () => {
    if (!editingOutlet || !newTerritory) return;
    
    const rep = reps.find(r => r.territory === newTerritory);
    const updates = [{ 
      id: editingOutlet.id, 
      territory: newTerritory, 
      repId: rep?.id,
      outletData: { name: editingOutlet.name, oldTerritory: editingOutlet.territory }
    }];
    
    reassignMutation.mutate(updates);
    setEditingOutlet(null);
    setNewTerritory('');
  };

  const handleApplyReoptimization = () => {
    reoptimizeMutation.mutate();
  };

  const territoryGroups = useMemo(() => {
    return outlets.reduce((acc, outlet) => {
      const key = outlet.territory || outlet.repId || 'unassigned';
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(outlet);
      return acc;
    }, {} as Record<string, Outlet[]>);
  }, [outlets]);

  const getTerritoryColor = useCallback((territory: string) => {
    const territories = Object.keys(territoryGroups);
    const index = territories.indexOf(territory);
    return TERRITORY_COLORS[index % TERRITORY_COLORS.length];
  }, [territoryGroups]);

  const getRepForTerritory = (territory: string) => {
    const territoryOutlets = territoryGroups[territory];
    if (!territoryOutlets || territoryOutlets.length === 0) return null;
    return reps.find(r => r.id === territoryOutlets[0].repId);
  };

  const filterByVf = useCallback((outletList: Outlet[]) => {
    return outletList.filter(outlet => {
      const vf = outlet.visitFrequency;
      if (vf === 1 && !vfFilters.vf1) return false;
      if (vf === 2 && !vfFilters.vf2) return false;
      if (vf === 4 && !vfFilters.vf4) return false;
      return true;
    });
  }, [vfFilters]);

  const clusterData = useMemo(() => {
    const data: Array<{territory: string, lat: number, lng: number, count: number, color: string, outlets: Outlet[]}> = [];
    
    Object.entries(territoryGroups).forEach(([territory, territoryOutlets], index) => {
      const filtered = filterByVf(territoryOutlets);
      if (filtered.length > 0) {
        const avgLat = filtered.reduce((sum, o) => sum + o.latitude, 0) / filtered.length;
        const avgLng = filtered.reduce((sum, o) => sum + o.longitude, 0) / filtered.length;
        data.push({
          territory,
          lat: avgLat,
          lng: avgLng,
          count: filtered.length,
          color: TERRITORY_COLORS[index % TERRITORY_COLORS.length],
          outlets: filtered
        });
      }
    });
    
    return data;
  }, [territoryGroups, filterByVf]);

  const individualOutlets = useMemo(() => {
    let outletsToShow = selectedZones.length > 0
      ? selectedZones.flatMap(zone => territoryGroups[zone] || [])
      : outlets.length > 500 ? outlets.slice(0, 500) : outlets;
    
    return filterByVf(outletsToShow);
  }, [outlets, selectedZones, territoryGroups, filterByVf]);

  const onMapLoad = useCallback((mapInstance: google.maps.Map) => {
    setMap(mapInstance);
    setIsMapLoaded(true);
  }, []);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    
    const bounds = new google.maps.LatLngBounds();
    let hasPoints = false;
    
    if (viewMode === 'cluster') {
      clusterData.forEach(cluster => {
        bounds.extend({ lat: cluster.lat, lng: cluster.lng });
        hasPoints = true;
      });
    } else {
      individualOutlets.forEach(outlet => {
        bounds.extend({ lat: outlet.latitude, lng: outlet.longitude });
        hasPoints = true;
      });
    }
    
    if (hasPoints) {
      map.fitBounds(bounds, { top: 50, right: 50, bottom: 50, left: 50 });
    }
  }, [map, isMapLoaded, viewMode, clusterData, individualOutlets]);

  const createClusterIcon = (color: string, count: number) => {
    const size = Math.min(60, Math.max(30, 20 + count / 5));
    const svg = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 2}" fill="${color}" stroke="white" stroke-width="2" opacity="0.85"/>
        <text x="${size/2}" y="${size/2 + 4}" text-anchor="middle" fill="white" font-size="12" font-weight="bold">${count}</text>
      </svg>
    `;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  };

  const createOutletIcon = (color: string) => {
    const svg = `
      <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="10" fill="${color}" stroke="white" stroke-width="2" opacity="0.85"/>
      </svg>
    `;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  };

  const getVfBadgeClass = (vf: number) => {
    switch (vf) {
      case 1: return 'bg-green-100 text-green-800 border-green-200';
      case 2: return 'bg-orange-100 text-orange-800 border-orange-200';
      case 4: return 'bg-red-100 text-red-800 border-red-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getVfLabel = (vf: number) => {
    switch (vf) {
      case 1: return 'VF1 (Monthly)';
      case 2: return 'VF2 (Bi-weekly)';
      case 4: return 'VF4 (Weekly)';
      default: return 'Unknown';
    }
  };

  if (!GOOGLE_MAPS_API_KEY) {
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
              <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
              <p className="text-gray-600 mb-2">Google Maps API key is not configured.</p>
              <p className="text-sm text-gray-500">Please set VITE_GOOGLE_MAPS_API_KEY environment variable.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full ${className}`}>
      <Card className="mb-4">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center">
              <Navigation className="mr-2 h-5 w-5" />
              Territory Map
            </CardTitle>
            <div className="flex items-center space-x-4">
              <div className="flex bg-gray-100 rounded-lg p-1">
                <Button
                  variant={viewMode === 'cluster' ? 'default' : 'ghost'}
                  size="sm"
                  className="h-8 px-3"
                  onClick={() => {
                    setViewMode('cluster');
                    setSelectedZones([]);
                    setSelectedOutlet(null);
                    setSelectedCluster(null);
                  }}
                >
                  <Layers className="mr-1 h-4 w-4" />
                  Clusters
                </Button>
                <Button
                  variant={viewMode === 'individual' ? 'default' : 'ghost'}
                  size="sm"
                  className="h-8 px-3"
                  onClick={() => {
                    setViewMode('individual');
                    setSelectedCluster(null);
                  }}
                  disabled={outlets.length > 5000}
                  title={outlets.length > 5000 ? 'Individual view disabled for large datasets (>5000 outlets). Click on a cluster to view its outlets.' : ''}
                >
                  <Grid3X3 className="mr-1 h-4 w-4" />
                  Individual
                </Button>
              </div>
              
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

              <div className="flex items-center space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportAllClusters}
                  disabled={isExporting || outlets.length === 0}
                  title="Export all clusters to Excel"
                >
                  {isExporting ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2" />
                  ) : (
                    <Download className="mr-2 h-4 w-4" />
                  )}
                  Export All
                </Button>
                {selectedZones.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportSelectedClusters}
                    disabled={isExporting}
                    title={`Export ${selectedZones.length} selected cluster(s)`}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Export Selected ({selectedZones.length})
                  </Button>
                )}
              </div>

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
        <Card className="flex-1">
          <CardContent className="p-0 h-full relative">
            <LoadScript 
              googleMapsApiKey={GOOGLE_MAPS_API_KEY}
              onError={() => setMapError('Failed to load Google Maps. Please check your API key.')}
            >
              <GoogleMap
                mapContainerStyle={mapContainerStyle}
                center={defaultCenter}
                zoom={8}
                onLoad={onMapLoad}
                options={{
                  mapTypeControl: false,
                  streetViewControl: false,
                  fullscreenControl: true,
                  zoomControl: true,
                }}
              >
                {viewMode === 'cluster' && isMapLoaded && typeof google !== 'undefined' && clusterData.map((cluster) => {
                  const size = Math.min(60, Math.max(30, 20 + cluster.count / 5));
                  return (
                    <Marker
                      key={cluster.territory}
                      position={{ lat: cluster.lat, lng: cluster.lng }}
                      icon={{
                        url: createClusterIcon(cluster.color, cluster.count),
                        scaledSize: new google.maps.Size(size, size),
                        anchor: new google.maps.Point(size / 2, size / 2)
                      }}
                      onClick={() => {
                        setSelectedCluster(cluster);
                        setSelectedOutlet(null);
                      }}
                    />
                  );
                })}

                {viewMode === 'individual' && isMapLoaded && typeof google !== 'undefined' && individualOutlets.map((outlet) => (
                  <Marker
                    key={outlet.id}
                    position={{ lat: outlet.latitude, lng: outlet.longitude }}
                    icon={{
                      url: createOutletIcon(getTerritoryColor(outlet.territory || outlet.repId || 'unassigned')),
                      scaledSize: new google.maps.Size(24, 24),
                      anchor: new google.maps.Point(12, 12)
                    }}
                    onClick={() => {
                      setSelectedOutlet(outlet);
                      setSelectedCluster(null);
                    }}
                  />
                ))}

                {selectedCluster && (
                  <InfoWindow
                    position={{ lat: selectedCluster.lat, lng: selectedCluster.lng }}
                    onCloseClick={() => setSelectedCluster(null)}
                  >
                    <div className="p-2 min-w-[200px]">
                      <h3 className="font-bold text-base mb-2">{selectedCluster.territory}</h3>
                      <p className="text-sm text-gray-600 mb-2">{selectedCluster.count} outlets</p>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => {
                            setSelectedZones([selectedCluster.territory]);
                            setViewMode('individual');
                            setSelectedCluster(null);
                          }}
                        >
                          View Outlets
                        </Button>
                      </div>
                    </div>
                  </InfoWindow>
                )}

                {selectedOutlet && (
                  <InfoWindow
                    position={{ lat: selectedOutlet.latitude, lng: selectedOutlet.longitude }}
                    onCloseClick={() => setSelectedOutlet(null)}
                  >
                    <div className="p-2 min-w-[220px]">
                      <h3 className="font-bold text-base mb-2">{selectedOutlet.name}</h3>
                      <div className="text-xs text-gray-600 space-y-1 mb-3">
                        <div><strong>Code:</strong> {selectedOutlet.id}</div>
                        <div><strong>Zone:</strong> {selectedOutlet.territory}</div>
                        <div><strong>Visit Frequency:</strong></div>
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${getVfBadgeClass(selectedOutlet.visitFrequency)}`}>
                          {getVfLabel(selectedOutlet.visitFrequency)}
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditingOutlet({
                              id: selectedOutlet.id,
                              name: selectedOutlet.name,
                              territory: selectedOutlet.territory || '',
                              lat: selectedOutlet.latitude,
                              lng: selectedOutlet.longitude
                            });
                            setSelectedOutlet(null);
                          }}
                        >
                          <Edit2 className="h-3 w-3 mr-1" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            setDeletingOutletId(selectedOutlet.id);
                            setShowDeleteConfirm(true);
                            setSelectedOutlet(null);
                          }}
                        >
                          <Trash2 className="h-3 w-3 mr-1" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  </InfoWindow>
                )}
              </GoogleMap>
            </LoadScript>
            
            {!isMapLoaded && (
              <div className="absolute inset-0 bg-white bg-opacity-90 flex items-center justify-center rounded-lg">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                  <p className="mt-2 text-sm text-gray-600">Loading map...</p>
                </div>
              </div>
            )}
            
            {outlets.length > 5000 && viewMode === 'cluster' && (
              <div className="absolute top-4 left-4 right-4 bg-blue-50 border border-blue-200 rounded-lg p-3 z-10">
                <div className="flex items-start">
                  <AlertCircle className="h-5 w-5 text-blue-500 mr-2 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-blue-800">Large Dataset Mode</p>
                    <p className="text-xs text-blue-600 mt-1">
                      Showing {Object.keys(territoryGroups).length} territory clusters for {outlets.length.toLocaleString()} outlets. 
                      Click on a cluster to view individual outlets in that zone.
                    </p>
                  </div>
                </div>
              </div>
            )}
            
            {selectedZones.length > 0 && viewMode === 'individual' && (
              <div className="absolute top-4 left-4 bg-white rounded-lg shadow-lg p-3 max-w-xs z-10">
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
            
            <div className="absolute bottom-4 left-4 bg-white rounded-lg shadow-lg p-3 z-10">
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

        <div className="w-80 space-y-4">
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
                          <div className="flex items-center gap-2">
                            <div
                              className="w-3 h-3 rounded-full"
                              style={{ backgroundColor: getTerritoryColor(territory) }}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                              onClick={() => {
                                setDeletingZone({ name: territory, count: territoryOutlets?.length || 0 });
                                setShowBulkDeleteConfirm(true);
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
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
                  {(() => {
                    const outletLat = editingOutlet?.lat || 0;
                    const outletLng = editingOutlet?.lng || 0;
                    
                    const calcDistance = (lat1: number, lng1: number, lat2: number, lng2: number) => {
                      const dLat = lat2 - lat1;
                      const dLng = lng2 - lng1;
                      return Math.sqrt(dLat * dLat + dLng * dLng);
                    };
                    
                    const zonesWithDistance = Object.keys(territoryGroups)
                      .filter(t => t !== editingOutlet?.territory)
                      .map(territory => {
                        const zoneOutlets = territoryGroups[territory];
                        const avgLat = zoneOutlets.reduce((sum, o) => sum + o.latitude, 0) / zoneOutlets.length;
                        const avgLng = zoneOutlets.reduce((sum, o) => sum + o.longitude, 0) / zoneOutlets.length;
                        const distance = calcDistance(outletLat, outletLng, avgLat, avgLng);
                        return { territory, distance };
                      })
                      .sort((a, b) => a.distance - b.distance);
                    
                    const recommendedZones = new Set(zonesWithDistance.slice(0, 2).map(z => z.territory));
                    
                    return zonesWithDistance.map(({ territory }) => (
                      <SelectItem key={territory} value={territory}>
                        {recommendedZones.has(territory) ? `Recommended - ${territory}` : territory}
                      </SelectItem>
                    ));
                  })()}
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

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center text-red-600">
              <Trash2 className="mr-2 h-5 w-5" />
              Delete Outlet
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Are you sure you want to delete this outlet? This action cannot be undone.
            </p>
            <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
              <p className="text-sm text-red-700 dark:text-red-300">
                The outlet will be permanently removed from all schedules and routes.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowDeleteConfirm(false); setDeletingOutletId(null); }}>
              Cancel
            </Button>
            <Button 
              variant="destructive"
              onClick={handleDeleteOutlet}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Outlet"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showBulkDeleteConfirm} onOpenChange={setShowBulkDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center text-red-600">
              <Trash2 className="mr-2 h-5 w-5" />
              Delete Entire Zone
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Are you sure you want to delete the zone <strong>"{deletingZone?.name}"</strong> and all <strong>{deletingZone?.count}</strong> outlets in it?
            </p>
            <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
              <p className="text-sm text-red-700 dark:text-red-300">
                This action cannot be undone. All outlets in this zone will be removed from schedules and routes.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowBulkDeleteConfirm(false); setDeletingZone(null); }}>
              Cancel
            </Button>
            <Button 
              variant="destructive"
              onClick={handleBulkDeleteZone}
              disabled={bulkDeleteMutation.isPending}
            >
              {bulkDeleteMutation.isPending ? "Deleting..." : `Delete Zone (${deletingZone?.count} outlets)`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showReoptimizeDialog} onOpenChange={setShowReoptimizeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center">
              <RefreshCw className="mr-2 h-5 w-5" />
              Re-optimize Schedules
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              You have made changes that affect outlet assignments. Would you like to re-optimize all schedules now?
            </p>
            {pendingChanges.length > 0 && (
              <div className="max-h-40 overflow-y-auto space-y-2">
                {pendingChanges.map((change, i) => (
                  <div key={i} className="text-xs p-2 bg-gray-50 rounded">
                    <span className="font-medium">{change.name}</span>: {change.oldTerritory} → {change.newTerritory}
                  </div>
                ))}
              </div>
            )}
            <div className="p-3 bg-orange-50 dark:bg-orange-900/20 rounded-lg border border-orange-200 dark:border-orange-800">
              <p className="text-sm text-orange-700 dark:text-orange-300">
                Re-optimization will regenerate all schedules and routes based on current zone assignments.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReoptimizeDialog(false)}>
              Later
            </Button>
            <Button 
              onClick={handleApplyReoptimization}
              disabled={reoptimizeMutation.isPending}
              className="bg-orange-500 hover:bg-orange-600"
            >
              {reoptimizeMutation.isPending ? "Optimizing..." : "Re-optimize Now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

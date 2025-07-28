import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { ArrowLeftRight, Save, X, MapPin, Users } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import type { Outlet, Rep } from '@shared/schema';

interface TerritoryCustomizationProps {
  onClose?: () => void;
}

export default function TerritoryCustomization({ onClose }: TerritoryCustomizationProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draggedOutlet, setDraggedOutlet] = useState<Outlet | null>(null);
  const [dragOverZone, setDragOverZone] = useState<string | null>(null);
  const [modifiedOutlets, setModifiedOutlets] = useState<Map<string, string>>(new Map());

  const { data: outlets = [] } = useQuery<Outlet[]>({
    queryKey: ['/api/outlets'],
  });

  const { data: reps = [] } = useQuery<Rep[]>({
    queryKey: ['/api/reps'],
  });

  // Group outlets by territory
  const territoryGroups = outlets.reduce((acc, outlet) => {
    const territory = outlet.territory || 'Unassigned';
    if (!acc[territory]) {
      acc[territory] = [];
    }
    // Check if outlet has been modified
    const modifiedTerritory = modifiedOutlets.get(outlet.id);
    if (modifiedTerritory) {
      // Place in modified territory instead
      if (!acc[modifiedTerritory]) {
        acc[modifiedTerritory] = [];
      }
      acc[modifiedTerritory].push(outlet);
    } else {
      acc[territory].push(outlet);
    }
    return acc;
  }, {} as Record<string, Outlet[]>);

  // Sort territories by zone number
  const sortedTerritories = Object.keys(territoryGroups).sort((a, b) => {
    const aNum = parseInt(a.replace('Zone ', ''));
    const bNum = parseInt(b.replace('Zone ', ''));
    return aNum - bNum;
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const updates = Array.from(modifiedOutlets.entries()).map(([outletId, newTerritory]) => ({
        outletId,
        territory: newTerritory,
      }));
      
      return apiRequest('/api/outlets/bulk-update-territory', {
        method: 'PATCH',
        body: JSON.stringify({ updates }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard/metrics'] });
      
      toast({
        title: 'Success!',
        description: `Updated ${modifiedOutlets.size} outlet assignments`,
      });
      
      setModifiedOutlets(new Map());
      if (onClose) onClose();
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Failed to save territory changes',
        variant: 'destructive',
      });
    },
  });

  const handleDragStart = (e: React.DragEvent, outlet: Outlet) => {
    setDraggedOutlet(outlet);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, territory: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverZone(territory);
  };

  const handleDragLeave = () => {
    setDragOverZone(null);
  };

  const handleDrop = (e: React.DragEvent, newTerritory: string) => {
    e.preventDefault();
    setDragOverZone(null);
    
    if (!draggedOutlet) return;
    
    const currentTerritory = modifiedOutlets.get(draggedOutlet.id) || draggedOutlet.territory || 'Unassigned';
    
    if (currentTerritory !== newTerritory) {
      const newModified = new Map(modifiedOutlets);
      
      // If moving back to original territory, remove from modified
      if (newTerritory === draggedOutlet.territory) {
        newModified.delete(draggedOutlet.id);
      } else {
        newModified.set(draggedOutlet.id, newTerritory);
      }
      
      setModifiedOutlets(newModified);
    }
    
    setDraggedOutlet(null);
  };

  const handleReset = () => {
    setModifiedOutlets(new Map());
  };

  const getTerritoryColor = (territory: string) => {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
      '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
    ];
    const index = sortedTerritories.indexOf(territory);
    return colors[index % colors.length];
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold">Territory Customization</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Drag outlets between zones to reassign them. Changes will be reflected in schedules after saving.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="secondary">
            {modifiedOutlets.size} changes
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={modifiedOutlets.size === 0}
          >
            Reset
          </Button>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={modifiedOutlets.size === 0 || saveMutation.isPending}
          >
            <Save className="h-4 w-4 mr-1" />
            Save Changes
          </Button>
        </div>
      </div>
      <ScrollArea className="h-[500px]">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedTerritories.map((territory) => {
              const zoneOutlets = territoryGroups[territory] || [];
              const isDropTarget = dragOverZone === territory;
              const rep = reps.find(r => 
                r.territories?.includes(territory) || 
                r.assignedZones?.includes(parseInt(territory.replace('Zone ', '')))
              );
              
              return (
                <div
                  key={territory}
                  className={`border rounded-lg p-4 transition-all ${
                    isDropTarget ? 'border-primary bg-primary/5 scale-105' : 'border-border'
                  }`}
                  onDragOver={(e) => handleDragOver(e, territory)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, territory)}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-4 h-4 rounded-full"
                        style={{ backgroundColor: getTerritoryColor(territory) }}
                      />
                      <h3 className="font-semibold">{territory}</h3>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {zoneOutlets.length} outlets
                      </Badge>
                      {rep && (
                        <Badge variant="secondary" className="text-xs">
                          <Users className="h-3 w-3 mr-1" />
                          {rep.name}
                        </Badge>
                      )}
                    </div>
                  </div>
                  
                  <Separator className="mb-3" />
                  
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {zoneOutlets.length === 0 ? (
                      <div className="text-sm text-muted-foreground text-center py-4">
                        Drop outlets here
                      </div>
                    ) : (
                      zoneOutlets.map((outlet) => {
                        const isModified = modifiedOutlets.has(outlet.id);
                        const originalTerritory = outlet.territory || 'Unassigned';
                        
                        return (
                          <div
                            key={outlet.id}
                            draggable
                            onDragStart={(e) => handleDragStart(e, outlet)}
                            className={`
                              p-2 bg-background border rounded cursor-move
                              hover:shadow-sm transition-shadow
                              ${isModified ? 'border-orange-500 bg-orange-50' : ''}
                            `}
                          >
                            <div className="flex items-start gap-2">
                              <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground flex-shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-sm truncate">
                                  {outlet.name}
                                </div>
                                <div className="text-xs text-muted-foreground truncate">
                                  {outlet.address}
                                </div>
                                {isModified && (
                                  <div className="text-xs text-orange-600 mt-1">
                                    <ArrowLeftRight className="h-3 w-3 inline mr-1" />
                                    From {originalTerritory}
                                  </div>
                                )}
                              </div>
                              <Badge variant="outline" className="text-xs flex-shrink-0">
                                VF{outlet.visitFrequency}
                              </Badge>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      </ScrollArea>
    </div>
  );
}
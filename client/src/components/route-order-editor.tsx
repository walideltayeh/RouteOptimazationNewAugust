import { useState, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  GripVertical, 
  Save, 
  X, 
  MapPin, 
  Clock, 
  RotateCcw,
  ArrowUp,
  ArrowDown,
  AlertTriangle
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Schedule, Outlet } from "@shared/schema";

interface RouteOrderEditorProps {
  schedule: Schedule;
  outlets: Outlet[];
  isOpen: boolean;
  onClose: () => void;
  repName?: string;
}

interface DragItem {
  id: string;
  index: number;
}

const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default function RouteOrderEditor({ 
  schedule, 
  outlets, 
  isOpen, 
  onClose,
  repName 
}: RouteOrderEditorProps) {
  const { toast } = useToast();
  
  const getInitialOrder = useCallback(() => {
    // Prefer routeOrder if available, otherwise fall back to outletIds
    const routeOrder = Array.isArray(schedule.routeOrder) && schedule.routeOrder.length > 0
      ? schedule.routeOrder as string[]
      : null;
    
    if (routeOrder) {
      return routeOrder;
    }
    
    const outletIds = Array.isArray(schedule.outletIds) 
      ? schedule.outletIds as string[]
      : JSON.parse(String(schedule.outletIds) || '[]');
    return outletIds;
  }, [schedule.outletIds, schedule.routeOrder]);

  const [orderedOutletIds, setOrderedOutletIds] = useState<string[]>(getInitialOrder);
  const [draggedItem, setDraggedItem] = useState<DragItem | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Check for missing outlets and track them
  const orderedOutlets = orderedOutletIds
    .map(id => outlets.find(o => o.id === id))
    .filter((o): o is Outlet => o !== undefined);
  
  const missingOutletCount = orderedOutletIds.length - orderedOutlets.length;
  const hasMissingOutlets = missingOutletCount > 0;

  const updateScheduleMutation = useMutation({
    mutationFn: async ({ scheduleId, routeOrder }: { scheduleId: string; routeOrder: string[] }) => {
      const response = await apiRequest("PUT", `/api/schedules/${scheduleId}`, {
        routeOrder: routeOrder,
        outletIds: routeOrder
      });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Route order updated",
        description: "The visit order has been saved successfully.",
      });
      // Invalidate all schedule-related queries to ensure fresh data
      queryClient.invalidateQueries({ queryKey: ["/api/schedules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/schedules/rep", schedule.repId] });
      onClose();
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update route order.",
        variant: "destructive",
      });
    },
  });

  const handleDragStart = (e: React.DragEvent, id: string, index: number) => {
    setDraggedItem({ id, index });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    
    if (draggedItem === null) return;
    
    const newOrder = [...orderedOutletIds];
    const [removed] = newOrder.splice(draggedItem.index, 1);
    newOrder.splice(dropIndex, 0, removed);
    
    setOrderedOutletIds(newOrder);
    setDraggedItem(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
    setDragOverIndex(null);
  };

  const moveItem = (fromIndex: number, direction: 'up' | 'down') => {
    const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
    if (toIndex < 0 || toIndex >= orderedOutletIds.length) return;
    
    const newOrder = [...orderedOutletIds];
    const [removed] = newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, removed);
    setOrderedOutletIds(newOrder);
  };

  const handleReset = () => {
    setOrderedOutletIds(getInitialOrder());
  };

  const handleSave = () => {
    updateScheduleMutation.mutate({
      scheduleId: schedule.id,
      routeOrder: orderedOutletIds
    });
  };

  const hasChanges = JSON.stringify(orderedOutletIds) !== JSON.stringify(getInitialOrder());

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" />
            Edit Visit Order
            {repName && <Badge variant="outline">{repName}</Badge>}
          </DialogTitle>
          <div className="text-sm text-muted-foreground">
            {dayNames[schedule.dayOfWeek]} - Week {schedule.week} ({orderedOutlets.length} outlets)
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-hidden">
          <Card className="h-full flex flex-col">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <GripVertical className="h-4 w-4 text-muted-foreground" />
                  Drag outlets to reorder visits
                </span>
                {hasChanges && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleReset}
                    data-testid="button-reset-order"
                  >
                    <RotateCcw className="h-4 w-4 mr-1" />
                    Reset
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto p-3">
              {hasMissingOutlets && (
                <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-center gap-2 text-amber-800">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  <span className="text-sm">
                    {missingOutletCount} outlet{missingOutletCount > 1 ? 's' : ''} could not be loaded. 
                    Please refresh the page or contact support.
                  </span>
                </div>
              )}
              <div className="space-y-1">
                {orderedOutlets.map((outlet, index) => (
                  <div
                    key={outlet.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, outlet.id, index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, index)}
                    onDragEnd={handleDragEnd}
                    className={`
                      flex items-center gap-3 p-3 rounded-lg border bg-card
                      cursor-grab active:cursor-grabbing
                      transition-all duration-150
                      ${draggedItem?.id === outlet.id ? 'opacity-50 scale-95' : ''}
                      ${dragOverIndex === index ? 'border-primary border-2 bg-primary/5' : 'border-border'}
                      hover:border-primary/50 hover:bg-accent/50
                    `}
                    data-testid={`draggable-outlet-${outlet.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <GripVertical className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                      <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold flex-shrink-0">
                        {index + 1}
                      </div>
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{outlet.name}</div>
                      <div className="text-sm text-muted-foreground truncate">
                        {outlet.address}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        {outlet.timePerVisit && (
                          <Badge variant="secondary" className="text-xs">
                            <Clock className="h-3 w-3 mr-1" />
                            {outlet.timePerVisit} min
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-xs">
                          VF{outlet.visitFrequency}
                        </Badge>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => moveItem(index, 'up')}
                        disabled={index === 0}
                        data-testid={`button-move-up-${outlet.id}`}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => moveItem(index, 'down')}
                        disabled={index === orderedOutlets.length - 1}
                        data-testid={`button-move-down-${outlet.id}`}
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <DialogFooter className="gap-2 pt-4">
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-order">
            <X className="h-4 w-4 mr-2" />
            Cancel
          </Button>
          <Button 
            onClick={handleSave} 
            disabled={!hasChanges || updateScheduleMutation.isPending || hasMissingOutlets}
            data-testid="button-save-order"
          >
            <Save className="h-4 w-4 mr-2" />
            {updateScheduleMutation.isPending ? "Saving..." : "Save Order"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

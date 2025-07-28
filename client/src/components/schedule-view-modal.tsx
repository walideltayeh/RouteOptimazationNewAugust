import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Calendar, MapPin, Save, X, Edit3, Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Schedule, Outlet, Rep } from "@shared/schema";

interface ScheduleViewModalProps {
  repId: string;
  isOpen: boolean;
  onClose: () => void;
  isEditMode: boolean;
}

export default function ScheduleViewModal({ repId, isOpen, onClose, isEditMode }: ScheduleViewModalProps) {
  const { toast } = useToast();
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  const { data: rep } = useQuery<Rep | undefined>({
    queryKey: ["/api/reps", repId],
    queryFn: async () => {
      const reps = await fetch("/api/reps").then(res => res.json()) as Rep[];
      return reps.find(r => r.id === repId);
    },
    enabled: !!repId,
  });

  const { data: schedules = [], isLoading } = useQuery<Schedule[]>({
    queryKey: ["/api/schedules/rep", repId],
    enabled: !!repId && isOpen,
  });

  const { data: outlets = [] } = useQuery<Outlet[]>({
    queryKey: ["/api/outlets"],
  });

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
        title: "Schedule updated",
        description: "The schedule has been successfully updated.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/schedules/rep", repId] });
      setEditingSchedule(null);
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update schedule.",
        variant: "destructive",
      });
    },
  });

  const weekNames = ["Week 1", "Week 2"];
  const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  // Group schedules by week
  const schedulesByWeek = schedules.reduce((acc, schedule) => {
    const week = schedule.week;
    if (!acc[week]) acc[week] = [];
    acc[week].push(schedule);
    return acc;
  }, {} as Record<number, Schedule[]>);

  const getOutletName = (outletId: string) => {
    const outlet = outlets.find(o => o.id === outletId);
    return outlet?.name || `Unknown Outlet`;
  };
  
  const getOutletDetails = (outletId: string) => {
    const outlet = outlets.find(o => o.id === outletId);
    if (!outlet) return null;
    return {
      name: outlet.name,
      address: outlet.address,
      territory: outlet.territory,
      visitFrequency: outlet.visitFrequency
    };
  };

  const handleSaveSchedule = () => {
    if (!editingSchedule) return;
    
    const routeOrder = Array.isArray(editingSchedule.routeOrder) 
      ? editingSchedule.routeOrder as string[]
      : [];
    
    updateScheduleMutation.mutate({
      scheduleId: editingSchedule.id,
      routeOrder: routeOrder
    });
  };

  if (isLoading) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Loading Schedule...</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-center p-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center">
              <Calendar className="mr-2 h-5 w-5" />
              {isEditMode ? "Edit Schedule" : "View Schedule"} - {rep?.name}
            </DialogTitle>
            <div className="flex items-center space-x-2">
              {isEditMode && editingSchedule && (
                <>
                  <Button 
                    size="sm" 
                    onClick={handleSaveSchedule}
                    disabled={updateScheduleMutation.isPending}
                  >
                    <Save className="mr-2 h-4 w-4" />
                    Save Changes
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setEditingSchedule(null)}
                  >
                    <X className="mr-2 h-4 w-4" />
                    Cancel
                  </Button>
                </>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6">
          {/* Route Info */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center">
                <MapPin className="mr-2 h-5 w-5 text-primary" />
                Zone: {rep?.territory}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <span className="text-sm text-gray-600">Route Code:</span>
                  <div className="font-medium">{rep?.code}</div>
                </div>
                <div>
                  <span className="text-sm text-gray-600">Working Days:</span>
                  <div className="font-medium">{rep?.workingDaysPerWeek} days/week</div>
                </div>
                <div>
                  <span className="text-sm text-gray-600">Daily Visits:</span>
                  <div className="font-medium">{rep?.minDailyVisits}-{rep?.maxDailyVisits}</div>
                </div>
                <div>
                  <span className="text-sm text-gray-600">Status:</span>
                  <Badge variant={rep?.isActive ? "default" : "secondary"}>
                    {rep?.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Weekly Schedules - Show complete zones for each day */}
          {[1, 2].map(weekNum => {
            const weekSchedules = schedulesByWeek[weekNum] || [];
            if (weekSchedules.length === 0) {
              return (
                <Card key={weekNum}>
                  <CardHeader>
                    <CardTitle>Week {weekNum}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-gray-500 text-center py-4">No schedule generated for this week</p>
                  </CardContent>
                </Card>
              );
            }

            // Sort schedules by day of week
            const sortedSchedules = weekSchedules.sort((a, b) => a.dayOfWeek - b.dayOfWeek);

            return (
              <Card key={weekNum}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    Week {weekNum} {weekNum <= 2 && <span className="text-sm text-gray-500">(repeats as Week {weekNum + 2})</span>}
                    <Badge variant="outline">{sortedSchedules.length} zones scheduled</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Day</TableHead>
                          <TableHead>Zone Assignment</TableHead>
                          <TableHead className="text-center">Visit Count</TableHead>
                          <TableHead className="text-center">Estimated Time</TableHead>
                          {isEditMode && <TableHead className="text-center">Actions</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortedSchedules.map((schedule) => {
                          // Get zone info from first outlet in schedule
                          const firstOutletId = Array.isArray(schedule.outletIds) && (schedule.outletIds as string[])[0];
                          const firstOutlet = firstOutletId ? outlets.find(o => o.id === firstOutletId) : null;
                          const zoneName = firstOutlet?.territory || "Unknown Zone";
                          
                          return (
                            <TableRow key={schedule.id}>
                              <TableCell className="font-medium">
                                {dayNames[schedule.dayOfWeek] || `Day ${schedule.dayOfWeek + 1}`}
                              </TableCell>
                              <TableCell>
                                <div className="space-y-2">
                                  <div className="flex items-center space-x-2">
                                    <Badge variant="default" className="text-xs">
                                      {zoneName}
                                    </Badge>
                                    <span className="text-sm text-gray-600">
                                      ({Array.isArray(schedule.outletIds) ? (schedule.outletIds as string[]).length : 0} outlets)
                                    </span>
                                  </div>
                                  <div className="text-xs text-gray-500">
                                    Complete zone visit - all outlets in this zone
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell className="text-center">
                                <Badge variant="secondary">
                                  {Array.isArray(schedule.outletIds) ? (schedule.outletIds as string[]).length : 0}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-center">
                                <div className="flex items-center justify-center">
                                  <Clock className="mr-1 h-4 w-4 text-gray-400" />
                                  <span className="text-sm text-gray-600">
                                    {schedule.estimatedDuration ? `${Math.round(schedule.estimatedDuration / 60)}h ${schedule.estimatedDuration % 60}m` : "N/A"}
                                  </span>
                                </div>
                              </TableCell>
                              {isEditMode && (
                                <TableCell className="text-center">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setEditingSchedule(schedule)}
                                  >
                                    <Edit3 className="h-4 w-4" />
                                  </Button>
                                </TableCell>
                              )}
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {schedules.length === 0 && (
            <Card>
              <CardContent className="text-center py-8">
                <p className="text-gray-500">No schedule found for this rep. Run optimization to generate schedules.</p>
              </CardContent>
            </Card>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
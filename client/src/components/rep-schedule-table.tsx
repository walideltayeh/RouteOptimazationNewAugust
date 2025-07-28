import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Calendar, Download, RefreshCw, Eye, Edit, CheckCircle, Clock, Info } from "lucide-react";
import type { Rep, Outlet, Schedule } from "@shared/schema";
import ScheduleViewModal from "./schedule-view-modal";

// Territory colors for rep avatars
const TERRITORY_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
];

const territoryColors = [
  "bg-red-500",
  "bg-blue-500", 
  "bg-green-500",
  "bg-yellow-500",
  "bg-purple-500",
  "bg-pink-500",
  "bg-indigo-500",
  "bg-cyan-500"
];

export default function RepScheduleTable() {
  const { data: metrics } = useQuery<{ totalOutlets: number; activeReps: number; recommendedReps: number }>({
    queryKey: ["/api/dashboard/metrics"],
  });
  const [selectedRepId, setSelectedRepId] = useState<string | null>(null);
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);

  const { data: reps = [], isLoading } = useQuery<Rep[]>({
    queryKey: ["/api/reps"],
  });

  const { data: outlets = [] } = useQuery<Outlet[]>({
    queryKey: ["/api/outlets"],
  });

  const handleViewSchedule = (repId: string) => {
    setSelectedRepId(repId);
    setIsEditMode(false);
    setIsScheduleModalOpen(true);
  };

  const handleEditSchedule = (repId: string) => {
    setSelectedRepId(repId);
    setIsEditMode(true);
    setIsScheduleModalOpen(true);
  };

  // Get all schedules
  const { data: schedules = [] } = useQuery<Schedule[]>({
    queryKey: ["/api/schedules"],
  });

  // Calculate rep statistics
  const repsWithStats = reps.map((rep, index) => {
    // Count unique zones for this rep
    const repSchedules = schedules.filter(s => s.repId === rep.id);
    const uniqueZones = new Set<string>();
    
    repSchedules.forEach(schedule => {
      if (Array.isArray(schedule.outletIds) && schedule.outletIds.length > 0) {
        const firstOutletId = schedule.outletIds[0];
        const outlet = outlets.find(o => o.id === firstOutletId);
        if (outlet?.territory) {
          uniqueZones.add(outlet.territory);
        }
      }
    });

    return {
      ...rep,
      totalZones: uniqueZones.size,
      weeklyZones: Math.min(5, uniqueZones.size), // 5 zones per week max
      avatarColor: territoryColors[index % territoryColors.length],
      initials: rep.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2),
      status: uniqueZones.size > 0 ? 'optimized' : 'pending'
    };
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
            <span className="ml-2 text-sm text-gray-600">Loading schedules...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle className="flex items-center">
            <Calendar className="mr-2 h-5 w-5 text-primary" />
            Rep Scheduling Overview
          </CardTitle>

          <div className="flex items-center space-x-3">
            {metrics && metrics.activeReps > 0 && (
              <div className="bg-green-50 border border-green-200 px-3 py-1 rounded-lg">
                <span className="text-sm font-medium text-green-800">
                  Final Recommendation: {metrics.activeReps} Reps
                </span>
              </div>
            )}
            <Button variant="outline" size="sm">
              <Download className="mr-2 h-4 w-4" />
              Export Schedules
            </Button>
            <Button size="sm">
              <RefreshCw className="mr-2 h-4 w-4" />
              Regenerate
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {/* Schedule Pattern Info */}
        <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 mb-6">
          <div className="flex items-center">
            <Info className="h-5 w-5 text-primary mr-3" />
            <div>
              <h4 className="text-sm font-semibold text-primary">Schedule Pattern</h4>
              <p className="text-sm text-primary/80">
                Week 1 = Week 3, Week 2 = Week 4. Each rep visits one complete zone per day (approximately 25 outlets), visiting 10 unique zones over 2 weeks.
              </p>
            </div>
          </div>
        </div>

        {/* Rep Schedule Table */}
        {repsWithStats.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-gray-500">No routes available. Upload outlet data and run optimization to generate route schedules.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead className="font-semibold">Rep Name</TableHead>
                  <TableHead className="font-semibold">Territory</TableHead>
                  <TableHead className="text-center font-semibold">Total Zones</TableHead>
                  <TableHead className="text-center font-semibold">Zones/Week</TableHead>
                  <TableHead className="text-center font-semibold">Working Days</TableHead>
                  <TableHead className="text-center font-semibold">Coverage</TableHead>
                  <TableHead className="text-center font-semibold">Status</TableHead>
                  <TableHead className="text-center font-semibold">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repsWithStats.map((rep) => (
                  <TableRow key={rep.id} className="hover:bg-gray-50">
                    <TableCell>
                      <div className="flex items-center">
                        <div className={`w-8 h-8 ${rep.avatarColor} rounded-full flex items-center justify-center text-white text-sm font-medium mr-3`}>
                          {rep.initials}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{rep.name}</p>
                          <p className="text-sm text-gray-500">{rep.code}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {rep.territory}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <span className="text-lg font-semibold text-gray-900">
                        {rep.totalZones}
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      <span className="text-lg font-semibold text-gray-900">
                        {rep.weeklyZones}
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      <span className="text-sm text-gray-600">{rep.workingDaysPerWeek} days</span>
                    </TableCell>
                    <TableCell className="text-center">
                      <span className="text-sm text-gray-600">{rep.totalZones > 0 ? '100%' : '0%'}</span>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge 
                        variant={rep.status === 'optimized' ? 'default' : 'secondary'}
                        className={rep.status === 'optimized' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}
                      >
                        {rep.status === 'optimized' ? (
                          <>
                            <CheckCircle className="mr-1 h-3 w-3" />
                            Optimized
                          </>
                        ) : (
                          <>
                            <Clock className="mr-1 h-3 w-3" />
                            Pending
                          </>
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center space-x-2">
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => handleViewSchedule(rep.id)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => handleEditSchedule(rep.id)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination */}
        {repsWithStats.length > 0 && (
          <div className="flex items-center justify-between mt-6 pt-4 border-t">
            <p className="text-sm text-gray-700">
              Showing <span className="font-medium">1</span> to{" "}
              <span className="font-medium">{Math.min(repsWithStats.length, 10)}</span> of{" "}
              <span className="font-medium">{repsWithStats.length}</span> results
            </p>
            <div className="flex space-x-2">
              <Button variant="outline" size="sm" disabled>
                Previous
              </Button>
              <Button variant="outline" size="sm" className="bg-primary text-white">
                1
              </Button>
              <Button variant="outline" size="sm" disabled>
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      {/* Schedule Modal */}
      {selectedRepId && (
        <ScheduleViewModal
          repId={selectedRepId}
          isOpen={isScheduleModalOpen}
          onClose={() => {
            setIsScheduleModalOpen(false);
            setSelectedRepId(null);
          }}
          isEditMode={isEditMode}
        />
      )}
    </Card>
  );
}
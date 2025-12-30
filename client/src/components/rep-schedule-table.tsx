import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";
import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar, Download, RefreshCw, Eye, Edit, CheckCircle, Clock, Info, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Rep, Outlet, Schedule, RoleHierarchy, RoleSchedule } from "@shared/schema";
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
  const { toast } = useToast();
  const { data: metrics } = useQuery<{ totalOutlets: number; activeReps: number; recommendedReps: number }>({
    queryKey: ["/api/dashboard/metrics"],
  });
  const [selectedRepId, setSelectedRepId] = useState<string | null>(null);
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedRole, setSelectedRole] = useState<string>('rep');

  const { data: reps = [], isLoading } = useQuery<Rep[]>({
    queryKey: ["/api/reps"],
  });

  const { data: outlets = [] } = useQuery<Outlet[]>({
    queryKey: ["/api/outlets"],
  });

  const { data: roleHierarchies = [] } = useQuery<RoleHierarchy[]>({
    queryKey: ["/api/role-hierarchies"],
  });

  const { data: roleSchedules = [] } = useQuery<RoleSchedule[]>({
    queryKey: ["/api/role-schedules"],
  });

  // Get available roles from hierarchies (exclude template and config entries)
  const availableRoles = useMemo(() => {
    const roleMap = new Map<string, { role: string; roleName: string; colorHex: string }>();
    roleMap.set('rep', { role: 'rep', roleName: 'Sales Rep', colorHex: '#3B82F6' });
    
    roleHierarchies.forEach(h => {
      if (h.role !== 'rep' && h.role !== '_config' && h.isActive && h.repId !== 'template') {
        roleMap.set(h.role, { role: h.role, roleName: h.roleName, colorHex: h.colorHex });
      }
    });
    
    return Array.from(roleMap.values());
  }, [roleHierarchies]);

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

  // Export mutation - includes all roles
  const exportMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/export/role-schedules', {
        method: 'GET',
      });
      
      if (!response.ok) {
        throw new Error('Failed to export schedules');
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `all_role_schedules_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    },
    onSuccess: () => {
      toast({
        title: "Export successful",
        description: "Schedules have been exported to Excel",
      });
    },
    onError: () => {
      toast({
        title: "Export failed",
        description: "Failed to export schedules. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Get all schedules
  const { data: schedules = [], refetch: refetchSchedules } = useQuery<Schedule[]>({
    queryKey: ["/api/schedules"],
  });

  // Force refetch when reps change
  useEffect(() => {
    if (reps.length > 0) {
      refetchSchedules();
    }
  }, [reps.length, refetchSchedules]);

  // Calculate rep statistics based on selected role
  const repsWithStats = reps.map((rep, index) => {
    let totalZones = 0;
    let weeklyZones = 0;
    
    if (selectedRole === 'rep') {
      // Use regular schedules for Sales Rep
      const repScheduleList = schedules.filter(s => s.repId === rep.id);
      const week1Schedules = repScheduleList.filter(s => s.week === 1).length;
      const week2Schedules = repScheduleList.filter(s => s.week === 2).length;
      totalZones = week1Schedules + week2Schedules;
      weeklyZones = Math.max(week1Schedules, week2Schedules);
    } else {
      // Use role schedules for other roles
      const roleScheduleList = roleSchedules.filter(
        rs => rs.repId === rep.id && rs.role === selectedRole
      );
      const week1Schedules = roleScheduleList.filter(s => s.week === 1).length;
      const week2Schedules = roleScheduleList.filter(s => s.week === 2).length;
      totalZones = week1Schedules + week2Schedules;
      weeklyZones = Math.max(week1Schedules, week2Schedules);
    }

    return {
      ...rep,
      totalZones: totalZones,
      weeklyZones: weeklyZones,
      avatarColor: territoryColors[index % territoryColors.length],
      initials: rep.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2),
      status: totalZones > 0 ? 'optimized' : 'pending'
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
          <div className="flex items-center gap-4">
            <CardTitle className="flex items-center">
              <Calendar className="mr-2 h-5 w-5 text-primary" />
              Scheduling Overview
            </CardTitle>
            
            {/* Role Selector */}
            {availableRoles.length > 1 && (
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-gray-500" />
                <div className="flex gap-1">
                  {availableRoles.map((role) => (
                    <button
                      key={role.role}
                      onClick={() => setSelectedRole(role.role)}
                      className={`
                        px-3 py-1 rounded-full text-xs font-medium transition-all border-2
                        ${selectedRole === role.role 
                          ? 'text-white shadow-sm' 
                          : 'hover:opacity-80'
                        }
                      `}
                      style={{ 
                        backgroundColor: selectedRole === role.role ? role.colorHex : `${role.colorHex}20`,
                        borderColor: role.colorHex,
                        color: selectedRole === role.role ? 'white' : role.colorHex
                      }}
                      data-testid={`btn-role-filter-${role.role}`}
                    >
                      {role.roleName}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center space-x-3">
            {metrics && metrics.activeReps > 0 && (
              <div className="bg-green-50 border border-green-200 px-3 py-1 rounded-lg">
                <span className="text-sm font-medium text-green-800">
                  Final Recommendation: {metrics.activeReps} Reps
                </span>
              </div>
            )}
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => exportMutation.mutate()}
              disabled={exportMutation.isPending || reps.length === 0}
            >
              {exportMutation.isPending ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2"></div>
                  Exporting...
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  Export All Roles
                </>
              )}
            </Button>
            <Button 
              size="sm"
              onClick={() => {
                window.location.reload();
              }}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh Page
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
              <h4 className="text-sm font-semibold text-primary">
                {selectedRole === 'rep' ? 'Schedule Pattern' : `${availableRoles.find(r => r.role === selectedRole)?.roleName || 'Role'} Schedule`}
              </h4>
              <p className="text-sm text-primary/80">
                {selectedRole === 'rep' 
                  ? 'Week 1 = Week 3, Week 2 = Week 4. Each rep visits one complete zone per day (approximately 25 outlets), visiting 10 unique zones over 2 weeks.'
                  : `Follows the Sales Rep route with a day offset. The ${availableRoles.find(r => r.role === selectedRole)?.roleName || 'role'} visits the same outlets in the same order, shifted by the configured day offset.`
                }
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
                      <Select value={rep.territory} disabled>
                        <SelectTrigger className="w-[200px] h-8 text-sm">
                          <SelectValue placeholder="Select territory" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={rep.territory}>{rep.territory}</SelectItem>
                        </SelectContent>
                      </Select>
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
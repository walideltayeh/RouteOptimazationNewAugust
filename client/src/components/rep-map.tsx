import { useState, useMemo, useRef, useEffect } from "react";
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Check, ChevronsUpDown, Zap, Save, Download, GripVertical, Edit2, Trash2, RefreshCw, MapPin, Upload, BarChart3, Search, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import RouteOrderEditor from "@/components/route-order-editor";
import type { Rep, Outlet, Schedule, RoleHierarchy, RoleSchedule } from "@shared/schema";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || import.meta.env.VITE_MAPBOX_PUBLIC_KEY;
if (MAPBOX_TOKEN && MAPBOX_TOKEN !== 'demo_token' && !MAPBOX_TOKEN.includes('your_') && MAPBOX_TOKEN.length > 10) {
  mapboxgl.accessToken = MAPBOX_TOKEN;
}

// Color palette for different days
const DAY_COLORS = [
  '#FF6B6B', // Monday - Red
  '#4ECDC4', // Tuesday - Teal
  '#45B7D1', // Wednesday - Blue
  '#FED766', // Thursday - Yellow
  '#2AB7CA', // Friday - Light Blue
  '#FE4A49', // Saturday - Pink
  '#6C5CE7'  // Sunday - Purple
];

const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const ZONE_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
  '#E74C3C', '#2ECC71', '#3498DB', '#9B59B6', '#F39C12'
];

// Visit Frequency colors. Cool→warm ramp matches frequency intensity:
// VF1 monthly (low) → slate, VF2 biweekly → blue, VF3 3-of-4 → amber,
// VF4 weekly (high) → brand dark red.
const VF_COLORS: Record<number, string> = {
  1: '#94A3B8',
  2: '#3B82F6',
  3: '#F59E0B',
  4: '#8B0000',
};
const VF_LABELS: Record<number, string> = {
  1: 'VF1 · Monthly',
  2: 'VF2 · Biweekly',
  3: 'VF3 · 3 of 4 weeks',
  4: 'VF4 · Weekly',
};
const vfColor = (vf: number | null | undefined) => VF_COLORS[vf ?? 1] || VF_COLORS[1];

export function RepMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const [selectedReps, setSelectedReps] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'schedule' | 'universe'>('schedule'); // Schedule view or Universe (all zones) view
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]); // Default to weekdays
  const [selectedWeeks, setSelectedWeeks] = useState<number[]>([1, 2, 3, 4]); // Default to all weeks so VF1/VF2 outlets are visible
  const [selectedRoles, setSelectedRoles] = useState<string[]>(['rep']); // Default to Sales Rep, now multi-select
  const [selectedVfs, setSelectedVfs] = useState<number[]>([1, 2, 3, 4]); // VF filter
  const [colorBy, setColorBy] = useState<'day' | 'vf'>('day'); // Marker coloring mode
  const [showAllLinkedRoles, setShowAllLinkedRoles] = useState(false); // Show rep + all linked role routes
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<{ schedule: Schedule; rep: Rep } | null>(null);
  const [editingOutlet, setEditingOutlet] = useState<{
    id: string;
    name: string;
    territory: string;
    currentRepId: string | null;
    lat: number;
    lng: number;
  } | null>(null);
  const [newZone, setNewZone] = useState<string>('');
  const [newRepId, setNewRepId] = useState<string>('');
  // Rep reassignments queued on the map; nothing executes until the user
  // hits "Apply & Reoptimize", then affected reps' schedules rework in one
  // batch instead of once per edited outlet.
  const [pendingReassignments, setPendingReassignments] = useState<Record<string, { name: string; toRepId: string; toRepName: string }>>({});
  const [needsReoptimization, setNeedsReoptimization] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [outletSearchOpen, setOutletSearchOpen] = useState(false);
  const [outletSearchQuery, setOutletSearchQuery] = useState("");
  const mapContainerWrapperRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  // Track GeoJSON layer IDs for cleanup
  const geoJSONLayersRef = useRef<{ circleLayerId: string; handlers: { click: any; mouseenter: any; mouseleave: any } }[]>([]);
  const createdLayersRef = useRef<Set<string>>(new Set());
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: reps = [] } = useQuery<Rep[]>({ 
    queryKey: ["/api/reps"] 
  });

  // Auto-select the first rep when reps load so the map isn't blank after
  // upload+optimize. Selecting ALL reps by default painted thousands of
  // markers in 28+ colors at once - unreadable and slow; "Select All"
  // remains one click away for whoever wants the full picture.
  useEffect(() => {
    if (reps.length > 0 && selectedReps.length === 0) {
      setSelectedReps([reps[0].id]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reps.length]);

  const { data: outlets = [] } = useQuery<Outlet[]>({ 
    queryKey: ["/api/outlets"] 
  });

  const { data: schedules = [], isLoading: schedulesLoading, refetch: refetchSchedules } = useQuery<Schedule[]>({ 
    queryKey: ["/api/schedules"] 
  });

  const { data: roleHierarchies = [] } = useQuery<RoleHierarchy[]>({
    queryKey: ["/api/role-hierarchies"]
  });

  const { data: roleSchedules = [] } = useQuery<RoleSchedule[]>({
    queryKey: ["/api/role-schedules"]
  });
  
  // Force refetch schedules when component mounts
  useEffect(() => {
    refetchSchedules();
  }, []);

  // Get unique roles from hierarchies and role schedules for the filter dropdown
  const availableRoles = useMemo(() => {
    const roleMap = new Map<string, { role: string; roleName: string; colorHex: string }>();
    roleMap.set('rep', { role: 'rep', roleName: 'Sales Rep', colorHex: '#3B82F6' });
    
    // Check role hierarchies - include both template (global) and rep-specific hierarchies
    roleHierarchies.forEach(h => {
      // Exclude 'rep' base role and '_config' entries, include all active roles
      if (h.role !== 'rep' && h.role !== '_config' && h.isActive) {
        // If already exists, prefer rep-specific over template
        if (!roleMap.has(h.role) || h.repId !== 'template') {
          roleMap.set(h.role, { role: h.role, roleName: h.roleName, colorHex: h.colorHex });
        }
      }
    });
    
    // Also check role schedules for roles that might not be in hierarchies
    roleSchedules.forEach(rs => {
      if (rs.role !== 'rep' && !roleMap.has(rs.role)) {
        // Get color from template hierarchies if available
        const template = roleHierarchies.find(h => h.repId === 'template' && h.role === rs.role);
        roleMap.set(rs.role, { 
          role: rs.role, 
          roleName: rs.roleName || rs.role, 
          colorHex: template?.colorHex || '#3B82F6' 
        });
      }
    });
    
    return Array.from(roleMap.values());
  }, [roleHierarchies, roleSchedules]);


  // Filter schedules for selected reps, days, weeks, and roles (now multi-select)
  const filteredSchedules = useMemo(() => {
    const allSchedules: (Schedule & { _role?: string })[] = [];
    
    // If Sales Rep is selected, include regular schedules
    if (selectedRoles.includes('rep')) {
      const repSchedulesFiltered = schedules.filter(schedule => {
        if (!selectedReps.includes(schedule.repId)) return false;
        if (!selectedDays.includes(schedule.dayOfWeek)) return false;
        
        const matchingWeeks = selectedWeeks.some(selectedWeek => {
          const sourceWeek = selectedWeek <= 2 ? selectedWeek : selectedWeek - 2;
          return schedule.week === sourceWeek;
        });
        return matchingWeeks;
      });
      allSchedules.push(...repSchedulesFiltered.map(s => ({ ...s, _role: 'rep' })));
    }
    
    // Include other selected roles from role schedules
    const otherRoles = selectedRoles.filter(r => r !== 'rep');
    if (otherRoles.length > 0) {
      
      const filteredRoleSchedules = roleSchedules.filter(rs => {
        if (!otherRoles.includes(rs.role)) return false;
        if (!selectedReps.includes(rs.repId)) return false;
        if (!selectedDays.includes(rs.dayOfWeek)) return false;
        
        const matchingWeeks = selectedWeeks.some(selectedWeek => {
          if (rs.week === selectedWeek) return true;
          if (selectedWeek > 2) {
            const mirrorWeek = selectedWeek - 2;
            return rs.week === mirrorWeek;
          }
          return false;
        });
        return matchingWeeks;
      });
      
      allSchedules.push(...filteredRoleSchedules.map(rs => ({
        id: rs.id,
        repId: rs.repId,
        week: rs.week,
        dayOfWeek: rs.dayOfWeek,
        outletIds: rs.outletIds,
        routeOrder: rs.routeOrder,
        totalDistance: rs.totalDistance,
        estimatedDuration: rs.estimatedDuration,
        createdAt: rs.createdAt,
        _role: rs.role
      } as Schedule & { _role?: string })));
    }
    
    return allSchedules;
  }, [schedules, roleSchedules, selectedReps, selectedDays, selectedWeeks, selectedRoles]);

  // Filter all linked role schedules for "Show All Linked Roles" mode (when only 'rep' selected)
  const linkedRoleSchedules = useMemo(() => {
    // Only show linked roles when exclusively 'rep' is selected and checkbox is checked
    if (!showAllLinkedRoles || selectedRoles.length !== 1 || !selectedRoles.includes('rep')) {
      return [];
    }
    
    return roleSchedules.filter(rs => {
      if (rs.role === 'rep') return false;
      if (!selectedReps.includes(rs.repId)) return false;
      if (!selectedDays.includes(rs.dayOfWeek)) return false;
      
      const matchingWeeks = selectedWeeks.some(selectedWeek => {
        if (rs.week === selectedWeek) return true;
        if (selectedWeek > 2) {
          const mirrorWeek = selectedWeek - 2;
          return rs.week === mirrorWeek;
        }
        return false;
      });
      return matchingWeeks;
    });
  }, [roleSchedules, selectedReps, selectedDays, selectedWeeks, showAllLinkedRoles, selectedRoles]);

  // Group outlets by rep, day, and week for the selected days
  const repDayOutlets = useMemo(() => {
    const result: Record<string, { 
      rep: Rep; 
      daySchedules: Record<string, { 
        outlets: Outlet[]; 
        color: string; 
        dayOfWeek: number;
        week: number;
        schedule: Schedule;
        roleName?: string;
      }> 
    }> = {};
    
    if (schedulesLoading || !outlets.length) {
      return result;
    }

    const outletMap = new Map(outlets.map(o => [o.id, o]));
    
    // Check if we have any relevant data
    const hasRepRole = selectedRoles.includes('rep');
    const hasOtherRoles = selectedRoles.some(r => r !== 'rep');
    
    if (hasOtherRoles && roleSchedules.length === 0 && !hasRepRole) {
      return result;
    }
    
    if (hasRepRole && schedules.length === 0 && !hasOtherRoles) {
      return result;
    }
    
    filteredSchedules.forEach(schedule => {
      const rep = reps.find(r => r.id === schedule.repId);
      if (!rep) {
        return;
      }

      // Check if outletIds is an array or needs parsing
      const outletIdArray = Array.isArray(schedule.outletIds) 
        ? schedule.outletIds 
        : typeof schedule.outletIds === 'string' 
          ? JSON.parse(schedule.outletIds as string)
          : [];
      
      const scheduleOutlets = outletIdArray
        .map((id: string) => outletMap.get(id))
        .filter((o: Outlet | undefined): o is Outlet => o !== undefined)
        .filter((o: Outlet) => selectedVfs.includes(o.visitFrequency ?? 1));

      // If the VF filter eliminated every outlet on this schedule, skip it.
      if (scheduleOutlets.length === 0) return;

      if (!result[rep.id]) {
        result[rep.id] = {
          rep,
          daySchedules: {}
        };
      }

      // Get role from extended schedule object
      const scheduleRole = (schedule as Schedule & { _role?: string })._role || 'rep';
      const roleInfo = availableRoles.find(r => r.role === scheduleRole);
      
      // Create a unique key for each day-week-role combination
      const scheduleKey = `${schedule.dayOfWeek}-${schedule.week}-${scheduleRole}`;
      
      // Use role-specific color or day color based on role
      const displayColor = scheduleRole === 'rep' 
        ? DAY_COLORS[(schedule.dayOfWeek - 1) % DAY_COLORS.length]
        : (availableRoles.find(r => r.role === scheduleRole)?.colorHex || '#3B82F6');
      
      result[rep.id].daySchedules[scheduleKey] = {
        outlets: scheduleOutlets,
        color: displayColor,
        dayOfWeek: schedule.dayOfWeek,
        week: schedule.week,
        schedule,
        roleName: roleInfo?.roleName
      };
    });

    // If showing all linked roles, also add those schedules (only when exclusively rep is selected)
    if (showAllLinkedRoles && selectedRoles.length === 1 && selectedRoles.includes('rep')) {
      linkedRoleSchedules.forEach(roleSchedule => {
        const rep = reps.find(r => r.id === roleSchedule.repId);
        if (!rep) return;

        const outletIdArray = Array.isArray(roleSchedule.outletIds) 
          ? roleSchedule.outletIds 
          : typeof roleSchedule.outletIds === 'string' 
            ? JSON.parse(roleSchedule.outletIds as string)
            : [];
        
        const scheduleOutlets = outletIdArray
          .map((id: string) => outletMap.get(id))
          .filter((o: Outlet | undefined): o is Outlet => o !== undefined)
          .filter((o: Outlet) => selectedVfs.includes(o.visitFrequency ?? 1));

        if (scheduleOutlets.length === 0) return;

        if (!result[rep.id]) {
          result[rep.id] = {
            rep,
            daySchedules: {}
          };
        }

        // Create unique key including role to distinguish from rep schedule
        const scheduleKey = `${roleSchedule.dayOfWeek}-${roleSchedule.week}-${roleSchedule.role}`;
        
        // Get color from role hierarchy
        const roleColorInfo = availableRoles.find(r => r.role === roleSchedule.role);
        
        result[rep.id].daySchedules[scheduleKey] = {
          outlets: scheduleOutlets,
          color: roleColorInfo?.colorHex || '#9CA3AF',
          dayOfWeek: roleSchedule.dayOfWeek,
          week: roleSchedule.week,
          schedule: {
            id: roleSchedule.id,
            repId: roleSchedule.repId,
            week: roleSchedule.week,
            dayOfWeek: roleSchedule.dayOfWeek,
            outletIds: roleSchedule.outletIds,
            routeOrder: roleSchedule.routeOrder,
            totalDistance: roleSchedule.totalDistance,
            estimatedDuration: roleSchedule.estimatedDuration,
            createdAt: roleSchedule.createdAt
          } as Schedule,
          roleName: roleSchedule.roleName || roleSchedule.role
        };
      });
    }

    return result;
  }, [filteredSchedules, reps, outlets, selectedRoles, availableRoles, roleSchedules, schedules, schedulesLoading, showAllLinkedRoles, linkedRoleSchedules, selectedVfs]);

  const routeStats = useMemo(() => {
    let totalOutlets = 0;
    let totalDistance = 0;
    let totalDuration = 0;
    Object.values(repDayOutlets).forEach(repData => {
      Object.values(repData.daySchedules).forEach(dayData => {
        totalOutlets += dayData.outlets.length;
        if (dayData.schedule.totalDistance) totalDistance += dayData.schedule.totalDistance;
        if (dayData.schedule.estimatedDuration) totalDuration += dayData.schedule.estimatedDuration;
      });
    });
    return { totalOutlets, totalDistance, totalDuration };
  }, [repDayOutlets]);

  const filteredSearchOutlets = useMemo(() => {
    if (!outletSearchQuery.trim()) return [];
    const q = outletSearchQuery.toLowerCase();
    return outlets.filter(o => o.name.toLowerCase().includes(q)).slice(0, 20);
  }, [outlets, outletSearchQuery]);

  // Universe view: Group all outlets by zone for selected reps
  const universeViewData = useMemo(() => {
    if (viewMode !== 'universe' || selectedReps.length === 0) return null;
    
    // Get all outlets that belong to selected reps (via schedules)
    const repOutletIds = new Set<string>();
    schedules.forEach(schedule => {
      if (selectedReps.includes(schedule.repId)) {
        const ids = Array.isArray(schedule.outletIds) 
          ? schedule.outletIds 
          : typeof schedule.outletIds === 'string' 
            ? JSON.parse(schedule.outletIds as string)
            : [];
        ids.forEach((id: string) => repOutletIds.add(id));
      }
    });
    
    // Get outlet objects and group by territory (filtered by VF)
    const repOutlets = outlets
      .filter(o => repOutletIds.has(o.id))
      .filter(o => selectedVfs.includes(o.visitFrequency ?? 1));
    const zoneGroups: Record<string, { outlets: Outlet[]; color: string }> = {};
    const zoneList: string[] = [];
    
    repOutlets.forEach(outlet => {
      const zone = outlet.territory || 'Unassigned';
      if (!zoneGroups[zone]) {
        zoneList.push(zone);
        zoneGroups[zone] = {
          outlets: [],
          color: ZONE_COLORS[zoneList.length % ZONE_COLORS.length]
        };
      }
      zoneGroups[zone].outlets.push(outlet);
    });
    
    return { zoneGroups, zoneList, totalOutlets: repOutlets.length };
  }, [viewMode, selectedReps, schedules, outlets, selectedVfs]);

  // Get all unique zones from outlets
  const allZones = useMemo(() => {
    const zones = new Set<string>();
    outlets.forEach(o => {
      if (o.territory) zones.add(o.territory);
    });
    return Array.from(zones).sort();
  }, [outlets]);

  // Calculate zone centers for recommendations
  const zoneCenters = useMemo(() => {
    const centers: Record<string, { lat: number; lng: number; outlets: number }> = {};
    outlets.forEach(o => {
      if (!o.territory) return;
      if (!centers[o.territory]) {
        centers[o.territory] = { lat: 0, lng: 0, outlets: 0 };
      }
      centers[o.territory].lat += o.latitude;
      centers[o.territory].lng += o.longitude;
      centers[o.territory].outlets += 1;
    });
    Object.keys(centers).forEach(zone => {
      const c = centers[zone];
      c.lat = c.lat / c.outlets;
      c.lng = c.lng / c.outlets;
    });
    return centers;
  }, [outlets]);

  // Get rep territories (zones assigned to each rep via schedules)
  const repTerritories = useMemo(() => {
    const outletMap = new Map(outlets.map(o => [o.id, o]));
    const repZones: Record<string, Set<string>> = {};
    schedules.forEach(schedule => {
      if (!repZones[schedule.repId]) {
        repZones[schedule.repId] = new Set();
      }
      const outletIds = Array.isArray(schedule.outletIds) 
        ? schedule.outletIds 
        : typeof schedule.outletIds === 'string' 
          ? JSON.parse(schedule.outletIds as string)
          : [];
      outletIds.forEach((id: string) => {
        const outlet = outletMap.get(id);
        if (outlet?.territory) {
          repZones[schedule.repId].add(outlet.territory);
        }
      });
    });
    return repZones;
  }, [schedules, outlets]);

  // Recommendation algorithm: find closest zones and reps
  const getRecommendations = useMemo(() => {
    if (!editingOutlet) return { zones: [], reps: [] };

    const outletLat = editingOutlet.lat;
    const outletLng = editingOutlet.lng;

    const calcDistance = (lat1: number, lng1: number, lat2: number, lng2: number) => {
      const dLat = lat2 - lat1;
      const dLng = lng2 - lng1;
      return Math.sqrt(dLat * dLat + dLng * dLng);
    };

    // Sort zones by distance
    const zonesWithDistance = allZones
      .filter(zone => zone !== editingOutlet.territory)
      .map(zone => {
        const center = zoneCenters[zone];
        const distance = center ? calcDistance(outletLat, outletLng, center.lat, center.lng) : Infinity;
        return { zone, distance };
      })
      .sort((a, b) => a.distance - b.distance);

    // Sort reps by distance to their zone centers (filter out reps with no territories)
    const repsWithDistance = reps
      .filter(rep => rep.id !== editingOutlet.currentRepId)
      .map(rep => {
        const repZoneSet = repTerritories[rep.id] || new Set();
        let minDistance = Infinity;
        repZoneSet.forEach(zone => {
          const center = zoneCenters[zone];
          if (center) {
            const dist = calcDistance(outletLat, outletLng, center.lat, center.lng);
            if (dist < minDistance) minDistance = dist;
          }
        });
        return { rep, distance: minDistance };
      })
      .filter(r => r.distance !== Infinity) // Only include reps with valid territories
      .sort((a, b) => a.distance - b.distance);

    return {
      zones: zonesWithDistance.slice(0, 2).map(z => z.zone),
      reps: repsWithDistance.slice(0, 2).map(r => r.rep.id)
    };
  }, [editingOutlet, allZones, zoneCenters, reps, repTerritories]);

  // Reassignment mutation
  const reassignMutation = useMutation({
    mutationFn: async (data: { outletId: string; newTerritory: string; newRepId?: string }) => {
      await apiRequest("POST", "/api/outlets/bulk-reassign", { 
        updates: [{
          id: data.outletId,
          territory: data.newTerritory,
          repId: data.newRepId || null
        }]
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      toast({ title: "Success", description: "Outlet reassigned successfully" });
      setEditingOutlet(null);
      setNewZone('');
      setNewRepId('');
      setNeedsReoptimization(true);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to reassign outlet", variant: "destructive" });
    }
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
      setEditingOutlet(null);
      setShowDeleteConfirm(false);
      setNeedsReoptimization(true);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete outlet", variant: "destructive" });
    }
  });

  const handleDeleteOutlet = () => {
    if (!editingOutlet) return;
    deleteMutation.mutate(editingOutlet.id);
  };

  const handleReassignOutlet = () => {
    if (!editingOutlet || !newZone) return;
    // Handle "keep-current" sentinel: undefined means don't change rep
    const resolvedRepId = newRepId === 'keep-current' || newRepId === '' ? undefined : newRepId;
    reassignMutation.mutate({
      outletId: editingOutlet.id,
      newTerritory: newZone,
      newRepId: resolvedRepId
    });
  };

  // --- Rep reassignment queue + misfit detection ---

  const haversineKm = (lat1: number, lng1: number, lat2: number, lng2: number) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  // Territory centers per rep (mean of owned outlets)
  const repCentroids = useMemo(() => {
    const acc = new Map<string, { lat: number; lng: number; n: number }>();
    for (const o of outlets) {
      if (!o.repId || o.territory === 'Excluded') continue;
      const c = acc.get(o.repId) || { lat: 0, lng: 0, n: 0 };
      c.lat += o.latitude; c.lng += o.longitude; c.n++;
      acc.set(o.repId, c);
    }
    const out = new Map<string, { lat: number; lng: number }>();
    acc.forEach((c, id) => out.set(id, { lat: c.lat / c.n, lng: c.lng / c.n }));
    return out;
  }, [outlets]);

  // Reps ranked by distance from the outlet being edited - answers "which
  // rep's territory is this outlet actually closest to?" with numbers.
  const rankedRepOptions = useMemo(() => {
    if (!editingOutlet) return [];
    return reps
      .map(rep => {
        const c = repCentroids.get(rep.id);
        return { rep, distKm: c ? haversineKm(editingOutlet.lat, editingOutlet.lng, c.lat, c.lng) : Infinity };
      })
      .filter(r => r.distKm !== Infinity)
      .sort((a, b) => a.distKm - b.distKm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingOutlet, reps, repCentroids]);

  interface MisfitOutlet {
    outletId: string; name: string;
    currentRepId: string; currentRepName: string; distCurrentKm: number;
    suggestedRepId: string; suggestedRepName: string; distSuggestedKm: number;
    savingsKm: number;
  }
  const { data: misfitData } = useQuery<{ misfits: MisfitOutlet[]; total: number }>({
    queryKey: ["/api/reps/misfit-outlets"],
    enabled: reps.length > 0,
  });
  const misfits = (misfitData?.misfits || []).filter(m => !pendingReassignments[m.outletId]);

  const queueReassignment = (outletId: string, name: string, toRepId: string) => {
    const toRep = reps.find(r => r.id === toRepId);
    if (!toRep) return;
    setPendingReassignments(prev => ({ ...prev, [outletId]: { name, toRepId, toRepName: toRep.name } }));
  };

  const handleQueueFromDialog = () => {
    if (!editingOutlet || !newRepId || newRepId === 'keep-current') return;
    queueReassignment(editingOutlet.id, editingOutlet.name, newRepId);
    toast({ title: "Queued", description: `${editingOutlet.name} → ${reps.find(r => r.id === newRepId)?.name}. Apply & Reoptimize when ready.` });
    setEditingOutlet(null);
    setNewZone('');
    setNewRepId('');
  };

  // Execute the whole queue: one reassignment call per target rep, so the
  // affected reps' schedules rework once each instead of per outlet.
  const applyPendingMutation = useMutation({
    mutationFn: async () => {
      const byRep = new Map<string, string[]>();
      Object.entries(pendingReassignments).forEach(([outletId, p]) => {
        if (!byRep.has(p.toRepId)) byRep.set(p.toRepId, []);
        byRep.get(p.toRepId)!.push(outletId);
      });
      const warnings: string[] = [];
      let moved = 0;
      for (const [toRepId, outletIds] of Array.from(byRep.entries())) {
        const res = await apiRequest("POST", "/api/reps/reassign-outlets", { outletIds, toRepId });
        if (!res.ok) throw new Error((await res.json()).message || "Reassignment failed");
        const data = await res.json();
        moved += data.movedOutlets;
        warnings.push(...(data.warnings || []));
      }
      return { moved, warnings };
    },
    onSuccess: (r) => {
      setPendingReassignments({});
      queryClient.invalidateQueries({ queryKey: ['/api/outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      queryClient.invalidateQueries({ queryKey: ['/api/reps'] });
      queryClient.invalidateQueries({ queryKey: ['/api/reps/misfit-outlets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard/metrics'] });
      toast({
        title: "Reoptimized",
        description: `${r.moved} outlet(s) moved and schedules reworked.${r.warnings.length > 0 ? ' ' + r.warnings.join(' ') : ''}`,
        variant: r.warnings.length > 0 ? "destructive" : "default",
      });
    },
    onError: (e: Error) => toast({ title: "Apply failed", description: e.message, variant: "destructive" }),
  });

  const pendingCount = Object.keys(pendingReassignments).length;

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || !MAPBOX_TOKEN || map.current) return;

    try {
      const mapInstance = new mapboxgl.Map({
        container: mapContainer.current,
        style: 'mapbox://styles/mapbox/light-v11',
        center: [35.8623, 33.8547], // Lebanon center
        zoom: 8
      });

      mapInstance.on('load', () => {
        setIsMapLoaded(true);
      });

      map.current = mapInstance;
    } catch (error) {
      console.error('Error initializing map:', error);
    }

    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      setIsFullscreen(!!document.fullscreenElement);
      // Call map.resize when fullscreen state changes
      setTimeout(() => { map.current?.resize(); }, 100);
    };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggleFullscreen = () => {
    if (!mapContainerWrapperRef.current) return;
    if (!document.fullscreenElement) {
      mapContainerWrapperRef.current.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
    // Call map.resize after fullscreen state change
    setTimeout(() => { map.current?.resize(); }, 100);
  };

  const handleOutletSearch = (outlet: Outlet) => {
    if (map.current) {
      map.current.flyTo({ center: [outlet.longitude, outlet.latitude], zoom: 15 });
    }
    setOutletSearchOpen(false);
    setOutletSearchQuery("");
  };

  // Update map when data changes
  useEffect(() => {
    if (!map.current || !isMapLoaded) return;

    // Clear existing markers
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];
    
    // Clean up GeoJSON layer event handlers before removing layers
    geoJSONLayersRef.current.forEach(({ circleLayerId, handlers }) => {
      if (map.current && map.current.getLayer(circleLayerId)) {
        map.current.off('click', circleLayerId, handlers.click);
        map.current.off('mouseenter', circleLayerId, handlers.mouseenter);
        map.current.off('mouseleave', circleLayerId, handlers.mouseleave);
      }
    });
    geoJSONLayersRef.current = [];

    // Clean up only previously created layers and sources (tracked via ref)
    // Remove layers first, then sources (sources can't be removed while layers reference them)
    createdLayersRef.current.forEach(id => {
      if (map.current?.getLayer(id)) map.current.removeLayer(id);
    });
    createdLayersRef.current.forEach(id => {
      if (map.current?.getSource(id)) map.current.removeSource(id);
    });
    createdLayersRef.current.clear();
    
    // UNIVERSE VIEW: Show all outlets grouped by zones
    if (viewMode === 'universe' && universeViewData) {
      
      Object.entries(universeViewData.zoneGroups).forEach(([zoneName, zoneData], idx) => {
        const safeZone = zoneName.replace(/[^a-zA-Z0-9]/g, '_');
        const sourceId = `universe-zone-${safeZone}`;
        const circleLayerId = `universe-circles-${safeZone}`;
        const labelLayerId = `universe-labels-${safeZone}`;
        
        const features = zoneData.outlets.map((outlet, i) => ({
          type: 'Feature' as const,
          geometry: {
            type: 'Point' as const,
            coordinates: [outlet.longitude, outlet.latitude]
          },
          properties: {
            id: outlet.id,
            name: outlet.name,
            address: outlet.address || '',
            zone: zoneName,
            color: zoneData.color,
            vf: outlet.visitFrequency || 1,
            order: i + 1,
            lat: outlet.latitude,
            lng: outlet.longitude,
            repId: outlet.repId || ''
          }
        }));
        
        if (!map.current!.getSource(sourceId)) {
          map.current!.addSource(sourceId, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features }
          });
          createdLayersRef.current.add(sourceId);
          
          map.current!.addLayer({
            id: circleLayerId,
            type: 'circle',
            source: sourceId,
            paint: {
              'circle-radius': 10,
              'circle-color': colorBy === 'vf'
                ? ['match', ['get', 'vf'],
                    1, VF_COLORS[1],
                    2, VF_COLORS[2],
                    3, VF_COLORS[3],
                    4, VF_COLORS[4],
                    VF_COLORS[1]
                  ] as any
                : zoneData.color,
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff'
            }
          });
          createdLayersRef.current.add(circleLayerId);
          
          map.current!.addLayer({
            id: labelLayerId,
            type: 'symbol',
            source: sourceId,
            layout: {
              'text-field': ['get', 'order'],
              'text-size': 10,
              'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
              'text-allow-overlap': true
            },
            paint: { 'text-color': '#ffffff' }
          });
          createdLayersRef.current.add(labelLayerId);
          
          const universeClickHandler = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] }) => {
            if (!e.features?.[0]) return;
            const props = e.features[0].properties;
            const coords = (e.features[0].geometry as GeoJSON.Point).coordinates;
            
            const popup = new mapboxgl.Popup({ offset: 15 })
              .setLngLat([coords[0], coords[1]])
              .setHTML(`
                <div>
                  <strong>${props?.name}</strong><br/>
                  ${props?.address ? `${props.address}<br/>` : ''}
                  <span style="color: ${props?.color}">Zone: ${props?.zone}</span><br/>
                  <span>Visit Frequency: VF${props?.vf}</span><br/>
                  <button id="reassign-btn-${props?.id}" class="reassign-outlet-btn" style="margin-top: 8px; padding: 4px 12px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                    Reassign
                  </button>
                </div>
              `)
              .addTo(map.current!);
            
            setTimeout(() => {
              const btn = popup.getElement()?.querySelector(`#reassign-btn-${props?.id}`);
              if (btn) {
                btn.addEventListener('click', () => {
                  setEditingOutlet({
                    id: props?.id,
                    name: props?.name,
                    territory: props?.zone,
                    currentRepId: props?.repId || null,
                    lat: props?.lat,
                    lng: props?.lng
                  });
                  setNewRepId('keep-current');
                  popup.remove();
                });
              }
            }, 100);
          };
          
          const universeMouseenterHandler = () => {
            if (map.current) map.current.getCanvas().style.cursor = 'pointer';
          };
          const universeMouseleaveHandler = () => {
            if (map.current) map.current.getCanvas().style.cursor = '';
          };

          map.current!.on('click', circleLayerId, universeClickHandler);
          map.current!.on('mouseenter', circleLayerId, universeMouseenterHandler);
          map.current!.on('mouseleave', circleLayerId, universeMouseleaveHandler);

          geoJSONLayersRef.current.push({
            circleLayerId,
            handlers: { click: universeClickHandler, mouseenter: universeMouseenterHandler, mouseleave: universeMouseleaveHandler }
          });
        }
      });
      
      // Fit bounds to all universe outlets
      const allOutlets = Object.values(universeViewData.zoneGroups).flatMap(z => z.outlets);
      if (allOutlets.length > 0) {
        const bounds = new mapboxgl.LngLatBounds();
        allOutlets.forEach(outlet => bounds.extend([outlet.longitude, outlet.latitude]));
        map.current.fitBounds(bounds, { padding: 50 });
      }
      
      return; // Skip schedule view rendering
    }

    // Add markers and routes for each selected rep and day
    // OPTIMIZED: Use GeoJSON layers for large datasets (faster than individual markers)
    const totalOutlets = Object.values(repDayOutlets).reduce(
      (sum, r) => sum + Object.values(r.daySchedules).reduce((s, d) => s + d.outlets.length, 0), 0
    );
    const useGeoJSONRendering = totalOutlets > 100; // Use optimized rendering for 100+ outlets
    
    Object.entries(repDayOutlets).forEach(([repId, repData]) => {
      Object.entries(repData.daySchedules).forEach(([scheduleKey, dayData]) => {
        if (useGeoJSONRendering && map.current) {
          // OPTIMIZED: Use GeoJSON circle layer for fast rendering
          const pointSourceId = `points-${repId}-${scheduleKey}`;
          const circleLayerId = `circles-${repId}-${scheduleKey}`;
          const labelLayerId = `labels-${repId}-${scheduleKey}`;
          
          // Create GeoJSON features for all outlets
          const features = dayData.outlets.map((outlet, idx) => ({
            type: 'Feature' as const,
            geometry: {
              type: 'Point' as const,
              coordinates: [outlet.longitude, outlet.latitude]
            },
            properties: {
              id: outlet.id,
              name: outlet.name,
              address: outlet.address,
              territory: outlet.territory || '',
              repId: repId,
              repName: repData.rep.name,
              dayName: daysOfWeek[dayData.dayOfWeek - 1] || `Day ${dayData.dayOfWeek}`,
              week: dayData.week,
              color: dayData.color,
              vf: outlet.visitFrequency ?? 1,
              order: idx + 1,
              orderStr: (idx + 1).toString(),
              lat: outlet.latitude,
              lng: outlet.longitude
            }
          }));
          
          // Add GeoJSON source
          if (!map.current.getSource(pointSourceId)) {
            map.current.addSource(pointSourceId, {
              type: 'geojson',
              data: {
                type: 'FeatureCollection',
                features
              }
            });
            createdLayersRef.current.add(pointSourceId);
            
            // Add circle layer (faster than DOM markers)
            map.current.addLayer({
              id: circleLayerId,
              type: 'circle',
              source: pointSourceId,
              paint: {
                'circle-radius': 12,
                'circle-color': colorBy === 'vf'
                  ? ['match', ['get', 'vf'],
                      1, VF_COLORS[1],
                      2, VF_COLORS[2],
                      3, VF_COLORS[3],
                      4, VF_COLORS[4],
                      VF_COLORS[1]
                    ] as any
                  : dayData.color,
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff'
              }
            });
            createdLayersRef.current.add(circleLayerId);
            
            // Add label layer for outlet order numbers
            map.current.addLayer({
              id: labelLayerId,
              type: 'symbol',
              source: pointSourceId,
              layout: {
                'text-field': ['get', 'orderStr'],
                'text-size': 11,
                'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
                'text-allow-overlap': true
              },
              paint: {
                'text-color': '#ffffff'
              }
            });
            createdLayersRef.current.add(labelLayerId);
            
            // Store handlers for later cleanup
            const clickHandler = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] }) => {
              if (!e.features?.[0]) return;
              const props = e.features[0].properties;
              const coords = (e.features[0].geometry as GeoJSON.Point).coordinates;
              
              const popup = new mapboxgl.Popup({ offset: 15 })
                .setLngLat([coords[0], coords[1]])
                .setHTML(`
                  <div>
                    <strong>${props?.name}</strong><br/>
                    ${props?.address}<br/>
                    <span style="color: ${props?.color}">${props?.repName} - ${props?.dayName} (Week ${props?.week})</span><br/>
                    <span style="color: ${vfColor(props?.vf)}; font-weight: 600;">${VF_LABELS[props?.vf] || `VF${props?.vf}`}</span><br/>
                    ${props?.territory ? `<span>Zone: ${props?.territory}</span><br/>` : ''}
                    <button id="reassign-sched-btn-${props?.id}" class="reassign-outlet-btn" style="margin-top: 8px; padding: 4px 12px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                      Reassign
                    </button>
                  </div>
                `)
                .addTo(map.current!);
              
              setTimeout(() => {
                const btn = popup.getElement()?.querySelector(`#reassign-sched-btn-${props?.id}`);
                if (btn) {
                  btn.addEventListener('click', () => {
                    setEditingOutlet({
                      id: props?.id,
                      name: props?.name,
                      territory: props?.territory || '',
                      currentRepId: props?.repId || null,
                      lat: props?.lat,
                      lng: props?.lng
                    });
                    setNewRepId('keep-current'); // Default to keep current rep
                    popup.remove();
                  });
                }
              }, 100);
            };
            
            const mouseenterHandler = () => {
              if (map.current) map.current.getCanvas().style.cursor = 'pointer';
            };
            
            const mouseleaveHandler = () => {
              if (map.current) map.current.getCanvas().style.cursor = '';
            };
            
            // Add event handlers
            map.current.on('click', circleLayerId, clickHandler);
            map.current.on('mouseenter', circleLayerId, mouseenterHandler);
            map.current.on('mouseleave', circleLayerId, mouseleaveHandler);
            
            // Store for cleanup
            geoJSONLayersRef.current.push({
              circleLayerId,
              handlers: { click: clickHandler, mouseenter: mouseenterHandler, mouseleave: mouseleaveHandler }
            });
          }
        } else {
          // Original DOM marker rendering for small datasets
          dayData.outlets.forEach((outlet, idx) => {
            const el = document.createElement('div');
            el.className = 'rep-marker';
            el.style.width = '30px';
            el.style.height = '30px';
            el.style.backgroundColor = colorBy === 'vf' ? vfColor(outlet.visitFrequency) : dayData.color;
            el.style.borderRadius = '50%';
            el.style.border = '2px solid white';
            el.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';
            el.style.display = 'flex';
            el.style.alignItems = 'center';
            el.style.justifyContent = 'center';
            el.style.color = 'white';
            el.style.fontWeight = 'bold';
            el.style.fontSize = '12px';
            el.innerHTML = (idx + 1).toString();

            const popup = new mapboxgl.Popup({ offset: 25 })
              .setHTML(`
                <div>
                  <strong>${outlet.name}</strong><br/>
                  ${outlet.address}<br/>
                  <span style="color: ${dayData.color}">${repData.rep.name} - ${daysOfWeek[dayData.dayOfWeek - 1] || `Day ${dayData.dayOfWeek}`} (Week ${dayData.week})</span><br/>
                  <span style="color: ${vfColor(outlet.visitFrequency)}; font-weight: 600;">${VF_LABELS[outlet.visitFrequency ?? 1] || `VF${outlet.visitFrequency}`}</span><br/>
                  ${outlet.territory ? `<span>Zone: ${outlet.territory}</span><br/>` : ''}
                  <button id="reassign-dom-btn-${outlet.id}" style="margin-top: 8px; padding: 4px 12px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                    Reassign
                  </button>
                </div>
              `);
            
            popup.on('open', () => {
              setTimeout(() => {
                const btn = popup.getElement()?.querySelector(`#reassign-dom-btn-${outlet.id}`);
                if (btn) {
                  btn.addEventListener('click', () => {
                    setEditingOutlet({
                      id: outlet.id,
                      name: outlet.name,
                      territory: outlet.territory || '',
                      currentRepId: repId,
                      lat: outlet.latitude,
                      lng: outlet.longitude
                    });
                    setNewRepId('keep-current'); // Default to keep current rep
                    popup.remove();
                  });
                }
              }, 100);
            });
            
            const marker = new mapboxgl.Marker(el)
              .setLngLat([outlet.longitude, outlet.latitude])
              .setPopup(popup)
              .addTo(map.current!);

            markersRef.current.push(marker);
          });
        }

        // Draw route lines for each day separately
        if (dayData.outlets.length > 1 && map.current) {
          // Use route order if available, otherwise use outlet order
          const orderedOutlets = dayData.schedule.routeOrder 
            ? (dayData.schedule.routeOrder as string[]).map(id => 
                dayData.outlets.find(o => o.id === id)!
              ).filter(Boolean)
            : dayData.outlets;
            
          const routeCoordinates = orderedOutlets.map(o => [o.longitude, o.latitude]);
          
          // Add source and layer for this rep's route on this specific day and week
          const sourceId = `route-${repId}-${dayData.dayOfWeek}-${dayData.week}`;
          const layerId = `route-layer-${repId}-${dayData.dayOfWeek}-${dayData.week}`;

          if (!map.current.getSource(sourceId)) {
            map.current.addSource(sourceId, {
              type: 'geojson',
              data: {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: routeCoordinates
                }
              }
            });
            createdLayersRef.current.add(sourceId);

            map.current.addLayer({
              id: layerId,
              type: 'line',
              source: sourceId,
              layout: {
                'line-join': 'round',
                'line-cap': 'round'
              },
              paint: {
                'line-color': dayData.color,
                'line-width': 3,
                'line-opacity': 0.6,
                // Different dash patterns for different weeks
                'line-dasharray': dayData.week === 1 || dayData.week === 3 ? [1, 0] : [2, 2]
              }
            });
            createdLayersRef.current.add(layerId);
          }
        }
      });
    });

    // Fit bounds to show all outlets
    if (Object.keys(repDayOutlets).length > 0) {
      const allOutlets = Object.values(repDayOutlets).flatMap(r => 
        Object.values(r.daySchedules).flatMap(d => d.outlets)
      );
      if (allOutlets.length > 0) {
        const bounds = new mapboxgl.LngLatBounds();
        allOutlets.forEach(outlet => {
          bounds.extend([outlet.longitude, outlet.latitude]);
        });
        map.current.fitBounds(bounds, { padding: 50 });
      }
    }
  }, [repDayOutlets, isMapLoaded, reps, selectedDays, viewMode, universeViewData, colorBy]);

  const toggleRep = (repId: string) => {
    setSelectedReps(prev => 
      prev.includes(repId) 
        ? prev.filter(id => id !== repId)
        : [...prev, repId]
    );
  };

  // Optimize route mutation
  const optimizeRouteMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/optimize-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repIds: selectedReps,
          days: selectedDays
        })
      });
      if (!response.ok) throw new Error('Failed to optimize routes');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/schedules'] });
      toast({
        title: "Routes Optimized!",
        description: "The selected routes have been further optimized for efficiency.",
      });
      setIsOptimizing(false);
    },
    onError: () => {
      toast({
        title: "Optimization Failed",
        description: "There was an error optimizing the routes. Please try again.",
        variant: "destructive",
      });
      setIsOptimizing(false);
    }
  });

  // Save routes mutation
  const saveRoutesMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/save-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repIds: selectedReps,
          days: selectedDays
        })
      });
      if (!response.ok) throw new Error('Failed to save routes');
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Routes Saved!",
        description: "The optimized routes have been saved successfully.",
      });
      setIsSaving(false);
    },
    onError: () => {
      toast({
        title: "Save Failed",
        description: "There was an error saving the routes. Please try again.",
        variant: "destructive",
      });
      setIsSaving(false);
    }
  });

  // Export to Excel
  const handleExport = async () => {
    setIsExporting(true);
    try {
      const response = await fetch('/api/export/schedules');

      if (!response.ok) throw new Error('Failed to export routes');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `route_schedules_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: "Export Successful!",
        description: "Routes have been exported to Excel.",
      });
    } catch (error) {
      toast({
        title: "Export Failed",
        description: "There was an error exporting the routes.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };



  if (!MAPBOX_TOKEN) {
    return (
      <Card className="h-full">
        <CardHeader>
          <CardTitle>Rep Map</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            Map cannot be displayed. Mapbox token is not configured.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-4">
        <CardTitle>Sales Rep Routes</CardTitle>
        {/* Action Buttons */}
        {selectedReps.length > 0 && (
          <div className="flex gap-2 mt-4">
            <Button
              onClick={() => {
                setIsOptimizing(true);
                optimizeRouteMutation.mutate();
              }}
              disabled={isOptimizing || selectedReps.length === 0}
              size="sm"
            >
              {isOptimizing ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
              ) : (
                <Zap className="h-4 w-4 mr-2" />
              )}
              Optimize Routes
            </Button>
            <Button
              onClick={() => {
                setIsSaving(true);
                saveRoutesMutation.mutate();
              }}
              disabled={isSaving || selectedReps.length === 0}
              variant="secondary"
              size="sm"
            >
              {isSaving ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-800 mr-2"></div>
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save
            </Button>
            <Button
              onClick={handleExport}
              disabled={isExporting || selectedReps.length === 0}
              variant="outline"
              size="sm"
            >
              {isExporting ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-800 mr-2"></div>
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              Export to Excel
            </Button>
          </div>
        )}
        
        {/* Pending rep reassignments queued from the map */}
        {pendingCount > 0 && (
          <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800" data-testid="pending-reassignments">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-blue-900 dark:text-blue-200 min-w-0">
                <span className="font-semibold">{pendingCount} outlet{pendingCount === 1 ? '' : 's'} queued for reassignment.</span>{' '}
                <span className="text-blue-700 dark:text-blue-300 truncate">
                  {Object.values(pendingReassignments).slice(0, 3).map(p => `${p.name} → ${p.toRepName}`).join(' · ')}
                  {pendingCount > 3 ? ` · +${pendingCount - 3} more` : ''}
                </span>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button variant="outline" size="sm" onClick={() => setPendingReassignments({})} disabled={applyPendingMutation.isPending} data-testid="button-discard-pending">
                  Discard
                </Button>
                <Button size="sm" onClick={() => applyPendingMutation.mutate()} disabled={applyPendingMutation.isPending} data-testid="button-apply-reoptimize">
                  {applyPendingMutation.isPending ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  Apply & Reoptimize
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Misfit detection: outlets probably assigned to the wrong rep */}
        {misfits.length > 0 && (
          <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-800" data-testid="misfit-outlets">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                {misfitData?.total} outlet{(misfitData?.total || 0) === 1 ? ' looks' : 's look'} closer to another rep's territory
              </p>
              <Button
                variant="outline" size="sm" className="border-amber-400 text-amber-900"
                onClick={() => misfits.forEach(m => queueReassignment(m.outletId, m.name, m.suggestedRepId))}
                data-testid="button-queue-all-misfits"
              >
                Queue all fixes
              </Button>
            </div>
            <div className="space-y-1 max-h-36 overflow-y-auto">
              {misfits.slice(0, 8).map(m => (
                <div key={m.outletId} className="flex items-center justify-between text-xs text-amber-800 dark:text-amber-300 gap-2">
                  <span className="truncate" title={m.name}>
                    {m.name} — {m.distCurrentKm}km from {m.currentRepName}, {m.distSuggestedKm}km from {m.suggestedRepName}
                  </span>
                  <Button
                    variant="ghost" size="sm" className="h-6 px-2 text-amber-900 shrink-0"
                    onClick={() => queueReassignment(m.outletId, m.name, m.suggestedRepId)}
                  >
                    Queue → {m.suggestedRepName}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reoptimize Button - appears after changes */}
        {needsReoptimization && (
          <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-800">
            <div className="flex items-center justify-between">
              <p className="text-sm text-amber-800 dark:text-amber-200">
                Changes detected. Reoptimize to update all routes and schedules.
              </p>
              <Button
                onClick={() => {
                  setIsOptimizing(true);
                  optimizeRouteMutation.mutate();
                  setNeedsReoptimization(false);
                }}
                disabled={isOptimizing}
                size="sm"
                className="ml-4"
              >
                {isOptimizing ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Reoptimize All Routes
              </Button>
            </div>
          </div>
        )}
        
        <div className="flex flex-col gap-4 mt-4">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={open}
                className="w-full justify-between"
              >
                {selectedReps.length === 0
                  ? "Select reps..."
                  : `${selectedReps.length} rep${selectedReps.length === 1 ? "" : "s"} selected`}
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[300px] p-0">
              <Command>
                <CommandInput placeholder="Search reps..." />
                <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b">
                  <span className="text-xs text-muted-foreground">
                    {selectedReps.length} of {reps.length} selected
                  </span>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => setSelectedReps(reps.map(r => r.id))}
                      data-testid="button-reps-select-all"
                    >
                      Select all
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => setSelectedReps([])}
                      data-testid="button-reps-select-none"
                    >
                      Select none
                    </Button>
                  </div>
                </div>
                <CommandEmpty>No rep found.</CommandEmpty>
                <CommandGroup className="max-h-[300px] overflow-y-auto">
                  {reps.map((rep) => {
                    return (
                      <CommandItem
                        key={rep.id}
                        value={rep.name}
                        onSelect={() => toggleRep(rep.id)}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            selectedReps.includes(rep.id) ? "opacity-100" : "opacity-0"
                          )}
                        />
                        <div className="flex items-center gap-2 flex-1">
                          <span>{rep.name} - {rep.territory}</span>
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </Command>
            </PopoverContent>
          </Popover>

          {selectedReps.length > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium">View Mode</label>
              <div className="flex gap-2">
                <Button
                  variant={viewMode === 'schedule' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setViewMode('schedule')}
                  className="flex-1"
                >
                  Schedule View
                </Button>
                <Button
                  variant={viewMode === 'universe' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setViewMode('universe')}
                  className="flex-1"
                >
                  Universe View
                </Button>
              </div>
              {viewMode === 'universe' && (
                <p className="text-xs text-muted-foreground">
                  Shows all outlets grouped by zones (ignores day/week filters)
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Select Roles</label>
            <div className="grid grid-cols-2 gap-2">
              {availableRoles.map((role) => (
                <label key={role.role} className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={selectedRoles.includes(role.role)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedRoles([...selectedRoles, role.role]);
                      } else {
                        // Don't allow deselecting if it's the last role
                        if (selectedRoles.length > 1) {
                          setSelectedRoles(selectedRoles.filter(r => r !== role.role));
                        }
                      }
                      // Disable show all linked roles when selecting multiple roles
                      if (selectedRoles.length > 1 || !selectedRoles.includes('rep')) {
                        setShowAllLinkedRoles(false);
                      }
                    }}
                    className="rounded border-gray-300"
                    data-testid={`checkbox-role-${role.role}`}
                  />
                  <div className="flex items-center gap-1">
                    <div 
                      className="w-3 h-3 rounded-full" 
                      style={{ backgroundColor: role.colorHex }}
                    />
                    <span className="text-sm">{role.roleName}</span>
                  </div>
                </label>
              ))}
            </div>
            {selectedRoles.length === 1 && selectedRoles.includes('rep') && availableRoles.length > 1 && (
              <label className="flex items-center space-x-2 mt-2">
                <input
                  type="checkbox"
                  checked={showAllLinkedRoles}
                  onChange={(e) => setShowAllLinkedRoles(e.target.checked)}
                  className="rounded border-gray-300"
                  data-testid="checkbox-show-all-roles"
                />
                <span className="text-sm">Show all linked role routes (with day offsets)</span>
              </label>
            )}
            {availableRoles.length === 1 && (
              <p className="text-xs text-muted-foreground">
                Configure role hierarchies to see other roles
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Select Days</label>
            <div className="grid grid-cols-2 gap-2">
              {daysOfWeek.map((day, index) => {
                const dayNumber = index + 1; // Convert 0-based index to 1-based dayOfWeek
                return (
                  <label key={day} className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={selectedDays.includes(dayNumber)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedDays([...selectedDays, dayNumber]);
                        } else {
                          setSelectedDays(selectedDays.filter(d => d !== dayNumber));
                        }
                      }}
                      className="rounded border-gray-300"
                    />
                    <div className="flex items-center gap-1">
                      <div 
                        className="w-3 h-3 rounded-full" 
                        style={{ backgroundColor: DAY_COLORS[index] }}
                      />
                      <span className="text-sm">{day}</span>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Select Weeks</label>
            <div className="grid grid-cols-2 gap-2">
              {[1, 2, 3, 4].map((week) => (
                <label key={week} className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={selectedWeeks.includes(week)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedWeeks([...selectedWeeks, week]);
                      } else {
                        setSelectedWeeks(selectedWeeks.filter(w => w !== week));
                      }
                    }}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm">Week {week}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-2 text-xs text-muted-foreground">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedWeeks([1, 3])}
                className="h-6 px-2"
              >
                Select Week 1/3
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedWeeks([2, 4])}
                className="h-6 px-2"
              >
                Select Week 2/4
              </Button>
            </div>
          </div>

          {/* Visit Frequency Filter */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Visit Frequency</label>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedVfs([1, 2, 3, 4])}
                  className="h-6 px-2 text-xs"
                  data-testid="button-vf-all"
                >
                  All
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedVfs([])}
                  className="h-6 px-2 text-xs"
                  data-testid="button-vf-none"
                >
                  None
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[1, 2, 3, 4].map((vf) => (
                <label key={vf} className="flex items-center space-x-2" data-testid={`checkbox-vf-${vf}`}>
                  <input
                    type="checkbox"
                    checked={selectedVfs.includes(vf)}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedVfs([...selectedVfs, vf].sort());
                      else setSelectedVfs(selectedVfs.filter(x => x !== vf));
                    }}
                    className="rounded border-gray-300"
                  />
                  <div className="flex items-center gap-1.5">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: VF_COLORS[vf] }}
                    />
                    <span className="text-sm">{VF_LABELS[vf]}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Color By toggle */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Color outlets by</label>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={colorBy === 'day' ? 'default' : 'outline'}
                onClick={() => setColorBy('day')}
                className="flex-1"
                data-testid="button-color-by-day"
              >
                Day
              </Button>
              <Button
                size="sm"
                variant={colorBy === 'vf' ? 'default' : 'outline'}
                onClick={() => setColorBy('vf')}
                className="flex-1"
                data-testid="button-color-by-vf"
              >
                Visit Frequency
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 p-4">
        {/* Outlet Search */}
        <div className="mb-3">
          <Popover open={outletSearchOpen} onOpenChange={setOutletSearchOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-full justify-start text-muted-foreground">
                <Search className="mr-2 h-4 w-4" />
                Search outlets...
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[400px] p-0" align="start">
              <Command>
                <CommandInput
                  placeholder="Type outlet name..."
                  value={outletSearchQuery}
                  onValueChange={setOutletSearchQuery}
                />
                <CommandEmpty>No outlet found.</CommandEmpty>
                <CommandGroup className="max-h-[200px] overflow-y-auto">
                  {filteredSearchOutlets.map((outlet) => (
                    <CommandItem
                      key={outlet.id}
                      value={outlet.name}
                      onSelect={() => handleOutletSearch(outlet)}
                    >
                      <MapPin className="mr-2 h-4 w-4 text-muted-foreground" />
                      <div className="flex flex-col">
                        <span className="text-sm">{outlet.name}</span>
                        <span className="text-xs text-muted-foreground">{outlet.territory || 'No zone'}</span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </Command>
            </PopoverContent>
          </Popover>
        </div>

        {/* Map Container with fullscreen and loading overlay */}
        <div
          ref={mapContainerWrapperRef}
          className={cn("relative", isFullscreen ? "fixed inset-0 z-50 bg-white" : "")}
        >
          <div ref={mapContainer} className={cn("rounded-lg overflow-hidden border", isFullscreen ? "h-full" : "h-full min-h-[400px]")} />

          {/* Fullscreen Toggle */}
          <Button
            variant="secondary"
            size="icon"
            className="absolute top-3 right-3 z-10 shadow-md"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>

          {/* Loading Skeleton */}
          {(schedulesLoading || !isMapLoaded) && (
            <div className="absolute inset-0 bg-white/80 dark:bg-gray-900/80 flex flex-col items-center justify-center rounded-lg z-20">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary mb-3"></div>
              <div className="animate-pulse space-y-2 text-center">
                <p className="text-sm font-medium text-muted-foreground">Loading map data...</p>
              </div>
            </div>
          )}
        </div>

        {/* Help message when nothing is selected */}
        {selectedReps.length === 0 && (
          <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg text-center">
            <p className="text-sm text-gray-600">
              Select reps, days, and weeks from the filters above to view their routes on the map
            </p>
          </div>
        )}

        {/* Empty state when no reps or schedules exist */}
        {reps.length === 0 || schedules.length === 0 ? (
          <div className="mt-4 p-6 bg-gray-50 border border-dashed border-gray-300 rounded-lg text-center space-y-4">
            <MapPin className="h-10 w-10 text-gray-400 mx-auto" />
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-1">No route data available</h4>
              <p className="text-xs text-gray-500">Get started by uploading outlet data and running route optimization.</p>
            </div>
            <div className="flex items-center justify-center gap-6 text-xs text-gray-500">
              <div className="flex items-center gap-1.5">
                <Upload className="h-4 w-4" />
                <span>Upload outlets</span>
              </div>
              <div className="flex items-center gap-1.5">
                <BarChart3 className="h-4 w-4" />
                <span>Run optimization</span>
              </div>
            </div>
          </div>
        ) : null}

        {/* Route Statistics Summary Bar */}
        {selectedReps.length > 0 && routeStats.totalOutlets > 0 && (
          <div className="mt-3 px-4 py-2.5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg flex items-center justify-between">
            <div className="flex items-center gap-6 text-sm">
              <div className="flex items-center gap-1.5">
                <MapPin className="h-4 w-4 text-blue-600" />
                <span className="font-semibold text-blue-900 dark:text-blue-200">{routeStats.totalOutlets}</span>
                <span className="text-blue-700 dark:text-blue-300">outlets</span>
              </div>
              <div className="flex items-center gap-1.5">
                <BarChart3 className="h-4 w-4 text-blue-600" />
                <span className="font-semibold text-blue-900 dark:text-blue-200">{routeStats.totalDistance.toFixed(1)}</span>
                <span className="text-blue-700 dark:text-blue-300">km</span>
              </div>
              {routeStats.totalDuration > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-blue-900 dark:text-blue-200">{Math.round(routeStats.totalDuration)}</span>
                  <span className="text-blue-700 dark:text-blue-300">min est.</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* VF Color Legend (shown when coloring by VF) */}
        {colorBy === 'vf' && selectedReps.length > 0 && (
          <div className="mt-4 p-3 border rounded-lg bg-gray-50 dark:bg-gray-900/30">
            <h4 className="font-semibold mb-2 text-sm">Visit Frequency Legend</h4>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {[1, 2, 3, 4].map((vf) => (
                <div key={vf} className="flex items-center gap-1.5">
                  <div
                    className="w-3.5 h-3.5 rounded-full border border-white shadow-sm"
                    style={{ backgroundColor: VF_COLORS[vf] }}
                  />
                  <span className="text-xs">{VF_LABELS[vf]}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Legend - Schedule View */}
        {selectedReps.length > 0 && viewMode === 'schedule' && (
          <div className="mt-4 p-3 border rounded-lg">
            <h4 className="font-semibold mb-2 text-sm">Selected Routes</h4>
            <div className="space-y-2.5">
              {Object.entries(repDayOutlets).map(([repId, repData]) => {
                return Object.entries(repData.daySchedules).map(([scheduleKey, dayData]) => {
                  return (
                    <div key={`${repId}-${scheduleKey}`} className="flex items-center gap-2.5">
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <div 
                          className="w-3.5 h-3.5 rounded-full" 
                          style={{ backgroundColor: dayData.color }}
                        />
                        <div
                          className="w-5 h-0.5 rounded"
                          style={{ backgroundColor: dayData.color }}
                        />
                      </div>
                      <span className="text-sm truncate flex-1">
                        <span className="font-medium">{repData.rep.name}</span>
                        {dayData.roleName ? ` · ${dayData.roleName}` : ''}
                        {' · '}{daysOfWeek[dayData.dayOfWeek - 1] || `Day ${dayData.dayOfWeek}`} (W{dayData.week})
                        {' · '}{dayData.outlets.length} outlets
                        {dayData.schedule.totalDistance && (
                          <> · <span className="font-bold">{dayData.schedule.totalDistance.toFixed(1)} km</span></>
                        )}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => setEditingSchedule({ schedule: dayData.schedule, rep: repData.rep })}
                        title="Edit visit order"
                        data-testid={`button-edit-route-${dayData.schedule.id}`}
                      >
                        <GripVertical className="h-3 w-3" />
                      </Button>
                    </div>
                  );
                });
              })}
            </div>
          </div>
        )}

        {/* Legend - Universe View */}
        {selectedReps.length > 0 && viewMode === 'universe' && universeViewData && (
          <div className="mt-4 p-3 border rounded-lg">
            <h4 className="font-semibold mb-2 text-sm">
              Universe: {universeViewData.totalOutlets} outlets across {universeViewData.zoneList.length} zones
            </h4>
            <div className="space-y-1 max-h-[200px] overflow-y-auto">
              {Object.entries(universeViewData.zoneGroups).map(([zoneName, zoneData]) => (
                <div key={zoneName} className="flex items-center gap-2">
                  <div 
                    className="w-3 h-3 rounded-full flex-shrink-0" 
                    style={{ backgroundColor: zoneData.color }}
                  />
                  <span className="text-xs truncate flex-1">
                    {zoneName} - {zoneData.outlets.length} outlets
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Route Order Editor */}
        {editingSchedule && (
          <RouteOrderEditor
            schedule={editingSchedule.schedule}
            outlets={outlets}
            isOpen={!!editingSchedule}
            onClose={() => setEditingSchedule(null)}
            repName={editingSchedule.rep.name}
          />
        )}

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
                <Badge variant="outline">{editingOutlet?.territory || 'Unassigned'}</Badge>
              </div>
              <div>
                <p className="text-sm text-gray-600">Current Rep:</p>
                <Badge variant="outline">
                  {editingOutlet?.currentRepId 
                    ? reps.find(r => r.id === editingOutlet.currentRepId)?.name || 'Unknown'
                    : 'Unassigned'}
                </Badge>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-2">New Zone:</p>
                <Select value={newZone} onValueChange={setNewZone}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select new zone" />
                  </SelectTrigger>
                  <SelectContent>
                    {allZones
                      .filter(zone => zone !== editingOutlet?.territory)
                      .map(zone => (
                        <SelectItem key={zone} value={zone}>
                          {getRecommendations.zones.includes(zone) ? `Recommended - ${zone}` : zone}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-2">Reassign to Rep (sorted by distance to this outlet):</p>
                <Select value={newRepId} onValueChange={setNewRepId}>
                  <SelectTrigger data-testid="select-reassign-rep">
                    <SelectValue placeholder="Keep current rep or select new" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="keep-current">Keep Current Rep</SelectItem>
                    {rankedRepOptions
                      .filter(({ rep }) => rep.id !== editingOutlet?.currentRepId)
                      .map(({ rep, distKm }, idx) => (
                        <SelectItem key={rep.id} value={rep.id}>
                          {rep.name} — {distKm.toFixed(1)} km{idx === 0 ? ' (closest)' : ''}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500 mt-1">
                  Rep changes are queued — hit "Apply &amp; Reoptimize" on the map when you're done editing.
                </p>
              </div>
            </div>
            <DialogFooter className="flex justify-between sm:justify-between">
              <Button
                variant="destructive"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Outlet
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => { setEditingOutlet(null); setNewZone(''); setNewRepId(''); setShowDeleteConfirm(false); }}>
                  Cancel
                </Button>
                {newRepId && newRepId !== 'keep-current' ? (
                  <Button onClick={handleQueueFromDialog} data-testid="button-queue-reassign">
                    Queue Reassignment
                  </Button>
                ) : (
                  <Button
                    onClick={handleReassignOutlet}
                    disabled={!newZone || reassignMutation.isPending}
                  >
                    {reassignMutation.isPending ? "Reassigning..." : "Move Zone"}
                  </Button>
                )}
              </div>
            </DialogFooter>
            
            {/* Delete Confirmation */}
            {showDeleteConfirm && (
              <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
                <p className="text-sm text-red-800 dark:text-red-200 mb-3">
                  Are you sure you want to delete this outlet? This action cannot be undone.
                </p>
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" size="sm" onClick={() => setShowDeleteConfirm(false)}>
                    No, Keep It
                  </Button>
                  <Button 
                    variant="destructive" 
                    size="sm" 
                    onClick={handleDeleteOutlet}
                    disabled={deleteMutation.isPending}
                  >
                    {deleteMutation.isPending ? "Deleting..." : "Yes, Delete"}
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
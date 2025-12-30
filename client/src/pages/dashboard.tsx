import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import FileUpload from "@/components/file-upload";
import RepScheduleTable from "@/components/rep-schedule-table";
import OptimizationSettings from "@/components/optimization-settings";
import AnalyticsCharts from "@/components/analytics-charts";
import MLInsights from "@/components/ml-insights";
import TerritoryMap from "@/components/territory-map-new";
import TerritoryCustomization from "@/components/territory-customization";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ArrowUp, Store, Users, CalendarCheck, TrendingUp, Download, Plus, Brain, Trash2, Map, Edit3, ChevronDown, ChevronRight, UserCog, ArrowDown, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { DashboardMetrics, Rep, Outlet, Schedule, RoleHierarchy } from "@shared/schema";

interface RoleConfig {
  role: string;
  roleName: string;
  offsetDays: number;
  colorHex: string;
  isActive: boolean;
}

type OffsetMode = 'global' | 'custom';

const DEFAULT_ROLES: RoleConfig[] = [
  { role: 'rep', roleName: 'Sales Rep', offsetDays: 0, colorHex: '#3B82F6', isActive: true },
  { role: 'merchandiser', roleName: 'Merchandiser', offsetDays: 1, colorHex: '#10B981', isActive: true },
  { role: 'collection_agent', roleName: 'Collection Agent', offsetDays: 2, colorHex: '#F59E0B', isActive: true },
];

export default function Dashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showTerritoryCustomization, setShowTerritoryCustomization] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [roleHierarchyExpanded, setRoleHierarchyExpanded] = useState(false);
  const [roles, setRoles] = useState<RoleConfig[]>(DEFAULT_ROLES);
  const [hierarchySaved, setHierarchySaved] = useState(false);
  const [offsetMode, setOffsetMode] = useState<OffsetMode>('global');
  const [selectedRepIds, setSelectedRepIds] = useState<string[]>([]);

  const { data: metrics, isLoading } = useQuery<DashboardMetrics>({
    queryKey: ["/api/dashboard/metrics"],
  });

  const { data: reps = [] } = useQuery<Rep[]>({
    queryKey: ["/api/reps"],
  });

  const { data: outlets = [] } = useQuery<Outlet[]>({
    queryKey: ["/api/outlets"],
  });

  const { data: schedules = [] } = useQuery<Schedule[]>({
    queryKey: ["/api/schedules"],
  });

  const { data: existingHierarchies = [] } = useQuery<RoleHierarchy[]>({
    queryKey: ["/api/role-hierarchies"],
  });

  // Determine current step based on data state
  const hasOutlets = outlets.length > 0;
  const hasOptimization = reps.length > 0 && schedules.length > 0;
  const hasRoleHierarchy = existingHierarchies.length > 0 || hierarchySaved;

  // Save role hierarchy configuration mutation
  const saveRoleHierarchyMutation = useMutation({
    mutationFn: async (payload: { roles: RoleConfig[], mode: OffsetMode, selectedRepIds?: string[] }) => {
      const response = await apiRequest("POST", "/api/role-hierarchies/template", payload);
      return response.json();
    },
    onSuccess: () => {
      setHierarchySaved(true);
      queryClient.invalidateQueries({ queryKey: ["/api/role-hierarchies"] });
      toast({
        title: "Role hierarchy saved",
        description: offsetMode === 'global' 
          ? "Global day offsets will apply to all roles and reps."
          : "Custom configuration saved. You can override per rep if needed.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to save",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleRoleChange = (index: number, field: keyof RoleConfig, value: string | number | boolean) => {
    const newRoles = [...roles];
    (newRoles[index] as any)[field] = value;
    setRoles(newRoles);
  };

  const handleAddRole = () => {
    setRoles([
      ...roles,
      {
        role: `custom_role_${Date.now()}`,
        roleName: 'Custom Role',
        offsetDays: roles.length,
        colorHex: '#9333EA',
        isActive: true,
      },
    ]);
  };

  const handleRemoveRole = (index: number) => {
    if (roles[index].role !== 'rep') {
      setRoles(roles.filter((_, i) => i !== index));
    }
  };

  const handleSaveRoleHierarchy = () => {
    saveRoleHierarchyMutation.mutate({ 
      roles, 
      mode: offsetMode,
      selectedRepIds: offsetMode === 'custom' ? selectedRepIds : undefined
    });
  };

  const clearAllMutation = useMutation({
    mutationFn: () => fetch("/api/clear", { method: "DELETE" }).then(res => res.json()),
    onSuccess: () => {
      // Invalidate all queries to refresh the data
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/outlets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/schedules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/analysis"] });
      
      toast({
        title: "Success!",
        description: "All data cleared successfully. Ready for new optimization.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to clear data. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleNewOptimization = () => {
    clearAllMutation.mutate();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="mt-2 text-sm text-gray-600">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <header className="bg-white shadow-sm border-b border-gray-200 px-6 py-4 rounded-lg">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Route Optimization Dashboard</h2>
              <p className="text-sm text-gray-600 mt-1">Manage your sales rep territories and optimize routes</p>
            </div>
            <div className="flex items-center space-x-4">
              <Button 
                className="bg-primary hover:bg-primary/90"
                onClick={handleNewOptimization}
                disabled={clearAllMutation.isPending}
              >
                {clearAllMutation.isPending ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                ) : (
                  <Plus className="mr-2 h-4 w-4" />
                )}
                New Optimization
              </Button>
              <Button variant="outline">
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
            </div>
          </div>
        </header>

        {/* Key Metrics Cards - Only show after optimization */}
        {hasOptimization && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <Card className="metric-card">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Total Outlets</p>
                  <p className="text-3xl font-bold text-gray-900 mt-1">
                    {metrics?.totalOutlets.toLocaleString() || 0}
                  </p>
                  <p className="text-sm text-green-600 mt-2 flex items-center">
                    <ArrowUp className="mr-1 h-3 w-3" />
                    12% vs last month
                  </p>
                </div>
                <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center">
                  <Store className="h-6 w-6 text-primary" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="metric-card">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Active Reps</p>
                  <p className="text-3xl font-bold text-gray-900 mt-1">
                    {metrics?.activeReps || 0}
                  </p>
                  <p className="text-sm text-gray-500 mt-2">
                    Recommended: <span className="font-semibold">{metrics?.recommendedReps || 0}</span>
                  </p>
                </div>
                <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
                  <Users className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="metric-card">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Avg Daily Visits</p>
                  <p className="text-3xl font-bold text-gray-900 mt-1">
                    {metrics?.avgDailyVisits || 0}
                  </p>
                  <p className="text-sm text-gray-500 mt-2">
                    Range: <span className="font-semibold">25-30</span> per rep
                  </p>
                </div>
                <div className="w-12 h-12 bg-yellow-100 rounded-xl flex items-center justify-center">
                  <CalendarCheck className="h-6 w-6 text-yellow-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="metric-card">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Territory Balance</p>
                  <p className="text-3xl font-bold text-gray-900 mt-1">
                    {metrics?.territoryBalance || 95}%
                  </p>
                  <p className="text-sm text-green-600 mt-2 flex items-center">
                    <ArrowUp className="mr-1 h-3 w-3" />
                    Optimized zones
                  </p>
                </div>
                <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
                  <TrendingUp className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          </div>
        )}

        {/* Step-by-step process */}
        <div className="space-y-6">
          {/* Step 1: File Upload */}
          <FileUpload />

          {/* File Analysis Summary (shown after upload) */}
          {hasOutlets && (
            <div className="animate-in fade-in slide-in-from-bottom-3 duration-500">
              <Card>
                <CardHeader>
                  <CardTitle>File Analysis Summary</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-4 gap-4">
                    <div className="text-center p-4 bg-gray-50 rounded-lg">
                      <p className="text-sm text-gray-600">Total Outlets</p>
                      <p className="text-2xl font-bold text-gray-900">{outlets.length}</p>
                    </div>
                    <div className="text-center p-4 bg-green-50 rounded-lg border border-green-200">
                      <p className="text-sm text-green-600">VF1 (Monthly)</p>
                      <p className="text-2xl font-bold text-green-700">
                        {outlets.filter(o => o.visitFrequency === 1).length}
                      </p>
                    </div>
                    <div className="text-center p-4 bg-orange-50 rounded-lg border border-orange-200">
                      <p className="text-sm text-orange-600">VF2 (Bi-weekly)</p>
                      <p className="text-2xl font-bold text-orange-700">
                        {outlets.filter(o => o.visitFrequency === 2).length}
                      </p>
                    </div>
                    <div className="text-center p-4 bg-red-50 rounded-lg border border-red-200">
                      <p className="text-sm text-red-600">VF4 (Weekly)</p>
                      <p className="text-2xl font-bold text-red-700">
                        {outlets.filter(o => o.visitFrequency === 4).length}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Step 2: Initial Optimization */}
          <div className={`${!hasOutlets ? 'opacity-50 pointer-events-none' : 'animate-in fade-in slide-in-from-bottom-3 duration-500'}`}>
            <OptimizationSettings disabled={!hasOutlets} />
          </div>

          {/* Initial Optimization Result (shown after optimization) */}
          {hasOptimization && (
            <div className="animate-in fade-in slide-in-from-bottom-3 duration-500">
              <Card className="border-blue-200 bg-blue-50">
                <CardContent className="p-6">
                  <div className="flex items-center space-x-4">
                    <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
                      <Users className="h-6 w-6 text-blue-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-blue-900">Initial Optimization Complete</p>
                      <p className="text-3xl font-bold text-blue-700">{reps.length} Sales Reps Required</p>
                      <p className="text-sm text-blue-600 mt-1">Now configure which reps should have role hierarchy applied</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Step 3: Role Hierarchy Configuration (shown AFTER initial optimization) */}
          {hasOptimization && (
            <div className="animate-in fade-in slide-in-from-bottom-3 duration-500">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                        <UserCog className="h-5 w-5 text-purple-600" />
                      </div>
                      <div>
                        <CardTitle>Step 3: Configure Role Hierarchy</CardTitle>
                        <CardDescription>
                          Define how Merchandisers and Collection Agents follow Sales Rep routes
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {hasRoleHierarchy && (
                        <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                          Configured
                        </Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRoleHierarchyExpanded(!roleHierarchyExpanded)}
                        data-testid="btn-toggle-hierarchy"
                      >
                        {roleHierarchyExpanded ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                
                {roleHierarchyExpanded && (
                  <CardContent className="space-y-4">
                    <div className="p-3 bg-blue-50 rounded-lg border border-blue-200 text-sm text-blue-800">
                      <strong>How it works:</strong> Sales Reps visit outlets first. Other roles (Merchandiser, Collection Agent) 
                      automatically follow the same route on subsequent days based on the day offset you configure.
                    </div>
                    
                    {/* Mode Selector */}
                    <div className="p-4 bg-gray-50 rounded-lg border">
                      <Label className="text-sm font-medium mb-3 block">Configuration Mode</Label>
                      <div className="flex gap-3">
                        <button
                          onClick={() => setOffsetMode('global')}
                          className={`flex-1 p-3 rounded-lg border-2 transition-all text-left ${
                            offsetMode === 'global' 
                              ? 'border-primary bg-primary/5' 
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                          data-testid="btn-mode-global"
                        >
                          <div className="font-medium text-sm">Global (Organization-wide)</div>
                          <div className="text-xs text-gray-500 mt-1">
                            Same day offsets apply to all roles and reps uniformly
                          </div>
                        </button>
                        <button
                          onClick={() => {
                            setOffsetMode('custom');
                            // Pre-select all reps when switching to custom mode
                            if (selectedRepIds.length === 0 && reps.length > 0) {
                              setSelectedRepIds(reps.map(r => r.id));
                            }
                          }}
                          className={`flex-1 p-3 rounded-lg border-2 transition-all text-left ${
                            offsetMode === 'custom' 
                              ? 'border-primary bg-primary/5' 
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                          data-testid="btn-mode-custom"
                        >
                          <div className="font-medium text-sm">Custom (Selected Reps Only)</div>
                          <div className="text-xs text-gray-500 mt-1">
                            Apply role hierarchy only to selected reps
                          </div>
                        </button>
                      </div>
                      {offsetMode === 'custom' && (
                        <div className="mt-4 space-y-3">
                          <div className="p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                            Select which reps should have the role hierarchy applied. Unselected reps will only have Sales Rep schedules.
                          </div>
                          <div className="border rounded-lg p-3 max-h-48 overflow-y-auto">
                            <div className="flex items-center justify-between mb-2">
                              <Label className="text-xs text-gray-500">Select Reps</Label>
                              <div className="flex gap-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 text-xs"
                                  onClick={() => setSelectedRepIds(reps.map(r => r.id))}
                                >
                                  Select All
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 text-xs"
                                  onClick={() => setSelectedRepIds([])}
                                >
                                  Clear
                                </Button>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                              {reps.map((rep) => (
                                <label
                                  key={rep.id}
                                  className={`flex items-center gap-2 p-2 rounded border cursor-pointer transition-all ${
                                    selectedRepIds.includes(rep.id)
                                      ? 'bg-primary/10 border-primary'
                                      : 'bg-white border-gray-200 hover:border-gray-300'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedRepIds.includes(rep.id)}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setSelectedRepIds([...selectedRepIds, rep.id]);
                                      } else {
                                        setSelectedRepIds(selectedRepIds.filter(id => id !== rep.id));
                                      }
                                    }}
                                    className="rounded"
                                    data-testid={`checkbox-rep-${rep.id}`}
                                  />
                                  <span className="text-sm truncate">{rep.name}</span>
                                </label>
                              ))}
                            </div>
                            {reps.length > 0 && (
                              <p className="text-xs text-gray-500 mt-2">
                                {selectedRepIds.length} of {reps.length} reps selected
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                    
                    <div className="space-y-3">
                      {roles.map((role, index) => (
                        <div key={index}>
                          <div
                            className="flex items-center gap-4 p-3 rounded-lg border bg-white"
                            style={{ borderLeftColor: role.colorHex, borderLeftWidth: '4px' }}
                          >
                            <div className="flex-1 grid grid-cols-1 md:grid-cols-4 gap-3">
                              <div>
                                <Label className="text-xs text-gray-500">Role Name</Label>
                                <Input
                                  value={role.roleName}
                                  onChange={(e) => handleRoleChange(index, 'roleName', e.target.value)}
                                  disabled={role.role === 'rep'}
                                  className="h-9"
                                  data-testid={`input-role-name-${index}`}
                                />
                              </div>
                              <div>
                                <Label className="text-xs text-gray-500">Day Offset</Label>
                                <div className="flex items-center gap-2">
                                  <Input
                                    type="number"
                                    value={role.offsetDays}
                                    onChange={(e) => handleRoleChange(index, 'offsetDays', parseInt(e.target.value) || 0)}
                                    min={0}
                                    max={10}
                                    disabled={role.role === 'rep'}
                                    className="h-9 w-20"
                                    data-testid={`input-offset-${index}`}
                                  />
                                  <span className="text-xs text-gray-500">
                                    {role.offsetDays === 0 ? '(Same day)' : `(+${role.offsetDays} day${role.offsetDays > 1 ? 's' : ''})`}
                                  </span>
                                </div>
                              </div>
                              <div>
                                <Label className="text-xs text-gray-500">Color</Label>
                                <div className="flex items-center gap-2">
                                  <input
                                    type="color"
                                    value={role.colorHex}
                                    onChange={(e) => handleRoleChange(index, 'colorHex', e.target.value)}
                                    className="w-9 h-9 rounded border cursor-pointer"
                                    data-testid={`input-color-${index}`}
                                  />
                                </div>
                              </div>
                              <div className="flex items-end gap-3">
                                <div className="flex items-center gap-2">
                                  <Switch
                                    checked={role.isActive}
                                    onCheckedChange={(checked) => handleRoleChange(index, 'isActive', checked)}
                                    disabled={role.role === 'rep'}
                                    data-testid={`switch-active-${index}`}
                                  />
                                  <Label className="text-xs">Active</Label>
                                </div>
                                {role.role !== 'rep' && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                                    onClick={() => handleRemoveRole(index)}
                                    data-testid={`btn-remove-role-${index}`}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                          {index < roles.length - 1 && (
                            <div className="flex justify-center py-1">
                              <ArrowDown className="h-4 w-4 text-gray-400" />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    
                    <div className="flex justify-between pt-3 border-t">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleAddRole}
                        data-testid="btn-add-custom-role"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Add Custom Role
                      </Button>
                      <Button
                        onClick={handleSaveRoleHierarchy}
                        disabled={saveRoleHierarchyMutation.isPending}
                        data-testid="btn-save-hierarchy"
                      >
                        {saveRoleHierarchyMutation.isPending ? (
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                        ) : (
                          <Save className="h-4 w-4 mr-2" />
                        )}
                        Save Configuration
                      </Button>
                    </div>
                  </CardContent>
                )}
                
                {!roleHierarchyExpanded && (
                  <CardContent>
                    <div className="flex items-center gap-3 mb-2">
                      <Badge variant="outline" className={`${offsetMode === 'global' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                        {offsetMode === 'global' ? 'Global Mode' : 'Custom Mode'}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {roles.filter(r => r.isActive).map((role, index) => (
                        <Badge
                          key={index}
                          variant="outline"
                          className="px-3 py-1"
                          style={{ backgroundColor: `${role.colorHex}20`, borderColor: role.colorHex, color: role.colorHex }}
                        >
                          {role.roleName} (+{role.offsetDays} day{role.offsetDays !== 1 ? 's' : ''})
                        </Badge>
                      ))}
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      Click to expand and customize role hierarchy
                    </p>
                  </CardContent>
                )}
              </Card>
            </div>
          )}

          {/* Step 4: Territory Maps & Schedules (shown after role hierarchy is configured) */}
          {hasOptimization && hasRoleHierarchy && (
            <div className="animate-in fade-in slide-in-from-bottom-3 duration-500">
              <Card>
                <CardHeader>
                  <CardTitle>Step 4: View Results - Maps, Territories & Schedules</CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  {/* Main Dashboard Tabs */}
                  <Tabs defaultValue="map" className="space-y-6">
                <TabsList className="grid w-full grid-cols-4">
                  <TabsTrigger value="map" className="flex items-center space-x-2">
                    <Map className="h-4 w-4" />
                    <span>Territory Map</span>
                  </TabsTrigger>
                  <TabsTrigger value="schedules">Schedules</TabsTrigger>
                  <TabsTrigger value="analytics">Analytics</TabsTrigger>
                  <TabsTrigger value="ml-insights" className="flex items-center space-x-2">
                    <Brain className="h-4 w-4" />
                    <span>ML Insights</span>
                  </TabsTrigger>
                </TabsList>

            <TabsContent value="map" className="space-y-6">
              {/* Full-width Territory Map */}
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle>Territory Map - Zone Visualization</CardTitle>
                  {outlets.length > 0 && (
                    <Button
                      onClick={() => setShowTerritoryCustomization(!showTerritoryCustomization)}
                      variant={showTerritoryCustomization ? "secondary" : "outline"}
                      size="sm"
                    >
                      <Edit3 className="h-4 w-4 mr-2" />
                      {showTerritoryCustomization ? "Close Customization" : "Customize Territories"}
                    </Button>
                  )}
                </CardHeader>
                <CardContent className="p-0">
                  {showTerritoryCustomization ? (
                    <TerritoryCustomization onClose={() => setShowTerritoryCustomization(false)} />
                  ) : (
                    <div className="h-[600px] w-full">
                      <TerritoryMap className="h-full w-full" />
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Zone details table below map */}
              <RepScheduleTable />
            </TabsContent>

            <TabsContent value="schedules">
              <RepScheduleTable />
            </TabsContent>

            <TabsContent value="analytics">
              <AnalyticsCharts />
            </TabsContent>

            <TabsContent value="ml-insights">
              <MLInsights outlets={outlets} reps={reps} schedules={schedules} />
            </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
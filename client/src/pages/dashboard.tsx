import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import FileUpload from "@/components/file-upload";
import RepScheduleTable from "@/components/rep-schedule-table";
import OptimizationSettings from "@/components/optimization-settings";
import AnalyticsCharts from "@/components/analytics-charts";
import MLInsights from "@/components/ml-insights";
import TerritoryMap from "@/components/territory-map";
import TerritoryCustomization from "@/components/territory-customization";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ArrowUp, Store, Users, CalendarCheck, TrendingUp, Download, Plus, Brain, Trash2, Map, Edit3, ChevronDown, ChevronRight, UserCog, ArrowDown, Save, RotateCcw, GitCompare } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { DashboardMetrics, Rep, Outlet, Schedule, RoleHierarchy } from "@shared/schema";

interface AuthStatus {
  isAuthenticated: boolean;
  isSuperuser: boolean;
}

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
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetScenariosToo, setResetScenariosToo] = useState(false);
  // Bumped on a full reset so <FileUpload /> remounts and drops its own
  // "last upload" state along with the server data.
  const [resetNonce, setResetNonce] = useState(0);
  const [, setLocation] = useLocation();
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

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
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

  // Full reset: clears outlets, reps, schedules and role hierarchies on the
  // server, then puts the dashboard back to its first-run state so the next
  // optimization genuinely starts from scratch.
  const resetAllMutation = useMutation({
    mutationFn: async (includeScenarios: boolean) => {
      const response = await apiRequest("POST", "/api/reset", { includeScenarios });
      return response.json() as Promise<{ success: boolean; scenariosRemoved: number }>;
    },
    onSuccess: (data) => {
      // Reset every piece of dashboard-local wizard state too, otherwise the
      // page keeps showing role config and territory panels from the old plan.
      setCurrentStep(1);
      setRoles(DEFAULT_ROLES);
      setHierarchySaved(false);
      setShowTerritoryCustomization(false);
      setSelectedRepIds([]);
      setOffsetMode('global');
      setRoleHierarchyExpanded(false);
      setResetNonce(n => n + 1);

      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/outlets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/schedules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/analysis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/role-hierarchies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/plan/kpis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scenarios"] });

      window.scrollTo({ top: 0, behavior: "smooth" });

      toast({
        title: "Ready for a new optimization",
        description: data.scenariosRemoved > 0
          ? `Everything cleared, including ${data.scenariosRemoved} saved scenario${data.scenariosRemoved === 1 ? "" : "s"}. Upload a file to begin.`
          : "Everything cleared. Upload a file to begin. Saved scenarios were kept.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to reset. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Re-running on the same data belongs on the Scenarios page: it keeps the
  // previous plan alongside the new one and shows the KPI differences, instead
  // of silently replacing what you already have. (Every run is captured either way.)
  const handleCompareScenarios = () => {
    setLocation("/scenarios");
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
        <header className="bg-white dark:bg-[#1c1c1e] shadow-apple border border-[#e5e5e5] dark:border-[#38383a] px-6 py-4 rounded-2xl">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-2xl font-bold text-[#1d1d1f] dark:text-white">Route Optimization Dashboard</h2>
              <p className="text-sm text-[#86868b] mt-1">Manage your sales rep territories and optimize routes</p>
            </div>
            <div className="flex items-center space-x-4">
              {authStatus?.isSuperuser && (hasOutlets || hasOptimization) && (
                <Button
                  onClick={() => { setResetScenariosToo(false); setShowResetConfirm(true); }}
                  disabled={resetAllMutation.isPending}
                  data-testid="button-new-optimization"
                >
                  {resetAllMutation.isPending ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  ) : (
                    <RotateCcw className="mr-2 h-4 w-4" />
                  )}
                  Start New Optimization
                </Button>
              )}
              {authStatus?.isSuperuser && hasOutlets && (
                <Button variant="outline" onClick={handleCompareScenarios} data-testid="button-compare-scenarios">
                  <GitCompare className="mr-2 h-4 w-4" />
                  Re-run &amp; Compare
                </Button>
              )}
              {hasOptimization && (
                <Button 
                  variant="outline"
                  onClick={async () => {
                    try {
                      const response = await fetch('/api/export/territories');
                      if (!response.ok) throw new Error('Export failed');
                      const blob = await response.blob();
                      const url = window.URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `territories_${new Date().toISOString().split('T')[0]}.xlsx`;
                      document.body.appendChild(a);
                      a.click();
                      window.URL.revokeObjectURL(url);
                      document.body.removeChild(a);
                      toast({
                        title: "Export successful",
                        description: "Territories exported to Excel",
                      });
                    } catch (error) {
                      toast({
                        title: "Export failed",
                        description: "Failed to export territories",
                        variant: "destructive",
                      });
                    }
                  }}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Export Territories
                </Button>
              )}
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
                  <p className="text-sm text-gray-500 mt-2">
                    Across <span className="font-semibold">{metrics?.activeReps || 0}</span> territories
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
                    Target: <span className="font-semibold">{metrics?.minDailyVisits || 0}-{metrics?.maxDailyVisits || 0}</span> per rep
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
                    {metrics?.territoryBalance ?? 0}%
                  </p>
                  <p className="text-sm text-gray-500 mt-2">
                    Workload evenness across reps
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
          <FileUpload key={resetNonce} />

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
          <div id="optimization-settings" className={`transition-all ${!hasOutlets ? 'opacity-50 pointer-events-none' : 'animate-in fade-in slide-in-from-bottom-3 duration-500'}`}>
            <OptimizationSettings disabled={!hasOutlets} />
          </div>

          {/* Initial Optimization Result (shown after optimization) */}
          {hasOptimization && (
            <div className="animate-in fade-in slide-in-from-bottom-3 duration-500">
              <Card className="border-[#e5e5e5] dark:border-[#38383a] bg-white dark:bg-[#1c1c1e]">
                <CardContent className="p-6">
                  <div className="flex items-center space-x-4">
                    <div className="w-12 h-12 bg-[#f5f5f7] dark:bg-[#2c2c2e] rounded-xl flex items-center justify-center">
                      <Users className="h-6 w-6 text-[#1d1d1f] dark:text-white" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[#1d1d1f] dark:text-white">Initial Optimization Complete</p>
                      <p className="text-3xl font-bold text-[#1d1d1f] dark:text-white">{reps.length} Sales Reps Required</p>
                      <p className="text-sm text-[#86868b] mt-1">Now configure which reps should have role hierarchy applied</p>
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
                      <div className="w-10 h-10 bg-[#f5f5f7] dark:bg-[#2c2c2e] rounded-lg flex items-center justify-center">
                        <UserCog className="h-5 w-5 text-[#1d1d1f] dark:text-white" />
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
                    <div className="p-3 bg-[#f5f5f7] dark:bg-[#2c2c2e] rounded-xl border border-[#e5e5e5] dark:border-[#38383a] text-sm text-[#1d1d1f] dark:text-white">
                      <strong>How it works:</strong> Sales Reps visit outlets first. Other roles (Merchandiser, Collection Agent) 
                      automatically follow the same route on subsequent days based on the day offset you configure.
                    </div>
                    
                    {/* Mode Selector */}
                    <div className="p-4 bg-[#f5f5f7] dark:bg-[#2c2c2e] rounded-xl border border-[#e5e5e5] dark:border-[#38383a]">
                      <Label className="text-sm font-medium mb-3 block text-[#1d1d1f] dark:text-white">Configuration Mode</Label>
                      <div className="flex gap-3">
                        <button
                          onClick={() => setOffsetMode('global')}
                          className={`flex-1 p-3 rounded-xl border-2 transition-all text-left ${
                            offsetMode === 'global' 
                              ? 'border-[#1d1d1f] bg-white dark:bg-[#1c1c1e]' 
                              : 'border-[#d2d2d7] dark:border-[#424245] hover:border-[#86868b]'
                          }`}
                          data-testid="btn-mode-global"
                        >
                          <div className="font-medium text-sm text-[#1d1d1f] dark:text-white">Global (Organization-wide)</div>
                          <div className="text-xs text-[#86868b] mt-1">
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
                          className={`flex-1 p-3 rounded-xl border-2 transition-all text-left ${
                            offsetMode === 'custom' 
                              ? 'border-[#1d1d1f] bg-white dark:bg-[#1c1c1e]' 
                              : 'border-[#d2d2d7] dark:border-[#424245] hover:border-[#86868b]'
                          }`}
                          data-testid="btn-mode-custom"
                        >
                          <div className="font-medium text-sm text-[#1d1d1f] dark:text-white">Custom (Selected Reps Only)</div>
                          <div className="text-xs text-[#86868b] mt-1">
                            Apply role hierarchy only to selected reps
                          </div>
                        </button>
                      </div>
                      {offsetMode === 'custom' && (
                        <div className="mt-4 space-y-3">
                          <div className="p-2 bg-[#f5f5f7] dark:bg-[#2c2c2e] border border-[#e5e5e5] dark:border-[#38383a] rounded-xl text-xs text-[#1d1d1f] dark:text-white">
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
                      <Badge variant="outline" className={`${offsetMode === 'global' ? 'bg-[#f5f5f7] text-[#1d1d1f] border-[#d2d2d7]' : 'bg-[#f5f5f7] text-[#1d1d1f] border-[#d2d2d7]'}`}>
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

      <Dialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start a new optimization from scratch?</DialogTitle>
            <DialogDescription>
              This permanently deletes {outlets.length.toLocaleString()} outlet{outlets.length === 1 ? "" : "s"}
              {hasOptimization ? `, ${reps.length} rep${reps.length === 1 ? "" : "s"}, every schedule and the role hierarchy` : ""}, and
              returns the dashboard to Step 1 so you can upload a new file. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-start space-x-3 rounded-lg border border-[#e5e5e5] dark:border-[#38383a] p-3">
            <Checkbox
              id="reset-scenarios"
              checked={resetScenariosToo}
              onCheckedChange={(checked) => setResetScenariosToo(checked === true)}
              data-testid="checkbox-reset-scenarios"
            />
            <div className="space-y-1">
              <Label htmlFor="reset-scenarios" className="text-sm font-medium cursor-pointer">
                Also delete saved scenarios
              </Label>
              <p className="text-xs text-[#86868b]">
                Leave this off to keep your saved runs on the Scenarios page, so you can still
                compare the new plan against the old KPIs.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowResetConfirm(false)}>Cancel</Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => { setShowResetConfirm(false); resetAllMutation.mutate(resetScenariosToo); }}
              data-testid="button-confirm-reset"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Yes, start from scratch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
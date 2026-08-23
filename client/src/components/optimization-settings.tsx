import { useState, useMemo, useCallback, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Settings, Play, AlertCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Alert, AlertDescription } from "@/components/ui/alert";
import OptimizationProgressModal from "./optimization-progress-modal";

interface FileAnalysis {
  outlets: number;
  vf1: number;
  vf2: number;
  vf4: number;
  recommendedReps?: number;
}

interface DashboardMetrics {
  totalOutlets: number;
  activeReps: number;
  recommendedReps: number;
}

interface OptimizationSettingsProps {
  disabled?: boolean;
}

type WeightMode = 'isolation' | 'vf' | 'value';

interface CoverageSuggestion {
  territory: string;
  outletCount: number;
  monthlyVisits: number;
  isolationKm: number;
  costPerVisitKm: number;
  outletIds: string[];
  sampleOutlets: string[];
  reason: string;
}

interface TerritoryBalance {
  targetPerRep: number;
  tolerancePct: number;
  maxDeviationPct: number;
  withinTolerance: boolean;
  perRep: { name: string; code: string; monthlyVisits: number; uniqueOutlets: number; deviationPct: number }[];
}

interface GeoOutlier {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
}

export default function OptimizationSettings({ disabled = false }: OptimizationSettingsProps) {
  // Daily visit targets (actual visits per rep per day)
  const [minVisitsPerDay, setMinVisitsPerDay] = useState(25);
  const [maxVisitsPerDay, setMaxVisitsPerDay] = useState(30);

  // Coverage weighting for area-removal suggestions
  const [weightMode, setWeightMode] = useState<WeightMode>('isolation');
  const [distanceMode, setDistanceMode] = useState<'haversine' | 'road'>('haversine');
  const [coverageSuggestions, setCoverageSuggestions] = useState<CoverageSuggestion[]>([]);
  const [territoryBalance, setTerritoryBalance] = useState<TerritoryBalance | null>(null);
  const [weightModeUsed, setWeightModeUsed] = useState<string>('');
  const [selectedExclusions, setSelectedExclusions] = useState<Set<string>>(new Set());
  const [geoOutliers, setGeoOutliers] = useState<GeoOutlier[]>([]);
  const [selectedGeoExclusions, setSelectedGeoExclusions] = useState<Set<string>>(new Set());
  const [activeExcludedIds, setActiveExcludedIds] = useState<string[]>([]);

  // Common settings
  const [workingDaysPerWeek, setWorkingDaysPerWeek] = useState(5);
  
  // Progress modal state
  const [showProgressModal, setShowProgressModal] = useState(false);
  const [progressId, setProgressId] = useState('');
  const optimizationStartedRef = useRef(false);
  const pendingSettingsRef = useRef<{
    minVisitsPerDay: number;
    maxVisitsPerDay: number;
    workingDaysPerWeek: number;
    weightMode: WeightMode;
    distanceMode: 'haversine' | 'road';
    excludedOutletIds?: string[];
    progressId: string;
  } | null>(null);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: analysis } = useQuery<FileAnalysis>({
    queryKey: ["/api/analysis"],
  });

  const { data: metrics } = useQuery<DashboardMetrics>({
    queryKey: ["/api/dashboard/metrics"],
  });

  // Show initial estimate from file upload analysis
  const estimatedReps = analysis?.recommendedReps || 0;

  // Show estimated calculation based on user parameters
  const feasibilityCheck = useMemo(() => {
    if (!analysis || !metrics) return { feasible: true, message: "", warning: false };
    
    const totalOutlets = analysis.outlets;
    
    if (totalOutlets === 0) return { feasible: true, message: "", warning: false };
    
    // Actual visits per week: vf is visits per 4-week cycle (VF4 weekly,
    // VF2 biweekly, VF1 monthly), so weekly load is the monthly total / 4.
    const totalWeeklyVisits = Math.ceil(((analysis.vf1 || 0) + (analysis.vf2 * 2) + (analysis.vf4 * 4)) / 4);
    
    const maxWeeklyCapacityPerRep = workingDaysPerWeek * maxVisitsPerDay;
    const estimatedRepsNeeded = Math.ceil(totalWeeklyVisits / maxWeeklyCapacityPerRep);

    return {
      feasible: true,
      message: `Will create ~${estimatedRepsNeeded} routes (${minVisitsPerDay}-${maxVisitsPerDay} visits/day, ${workingDaysPerWeek} days/week)`,
      warning: false
    };
  }, [analysis, metrics, workingDaysPerWeek, minVisitsPerDay, maxVisitsPerDay]);

  const optimizationMutation = useMutation({
    mutationFn: async (settings: {
      minVisitsPerDay: number;
      maxVisitsPerDay: number;
      workingDaysPerWeek: number;
      weightMode?: WeightMode;
      distanceMode?: 'haversine' | 'road';
      excludedOutletIds?: string[];
      progressId?: string;
    }) => {
      const response = await apiRequest("POST", "/api/optimize", settings);
      return response.json();
    },
    onSuccess: (data) => {
      setCoverageSuggestions(data.coverageSuggestions || []);
      setTerritoryBalance(data.territoryBalance || null);
      setWeightModeUsed(data.coverageWeightModeUsed || '');
      setGeoOutliers(data.geoOutliers || []);
      setSelectedExclusions(new Set());
      setSelectedGeoExclusions(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/reps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/outlets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/schedules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/role-hierarchies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/role-schedules"] });
    },
    onError: (error: Error) => {
      setShowProgressModal(false);
      toast({
        title: "Optimization failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  
  const handleProgressComplete = useCallback(() => {
    setShowProgressModal(false);
    optimizationStartedRef.current = false;
    pendingSettingsRef.current = null;
    queryClient.invalidateQueries({ queryKey: ["/api/reps"] });
    queryClient.invalidateQueries({ queryKey: ["/api/outlets"] });
    queryClient.invalidateQueries({ queryKey: ["/api/schedules"] });
    toast({
      title: "Optimization completed",
      description: "Your routes have been optimized successfully!",
    });
  }, [queryClient, toast]);
  
  const handleProgressError = useCallback((message: string) => {
    setShowProgressModal(false);
    optimizationStartedRef.current = false;
    pendingSettingsRef.current = null;
    toast({
      title: "Optimization failed",
      description: message,
      variant: "destructive",
    });
  }, [toast]);
  
  const handleSSEReady = useCallback(() => {
    if (pendingSettingsRef.current && !optimizationStartedRef.current) {
      optimizationStartedRef.current = true;
      optimizationMutation.mutate(pendingSettingsRef.current);
    }
  }, [optimizationMutation]);

  const handleOptimization = (excludedOutletIds: string[] = activeExcludedIds) => {
    if (minVisitsPerDay >= maxVisitsPerDay) {
      toast({
        title: "Invalid settings",
        description: "Minimum visits must be less than maximum visits",
        variant: "destructive",
      });
      return;
    }

    // Reset refs for new optimization
    optimizationStartedRef.current = false;

    const newProgressId = `opt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    pendingSettingsRef.current = {
      minVisitsPerDay,
      maxVisitsPerDay,
      workingDaysPerWeek,
      weightMode,
      distanceMode,
      excludedOutletIds: excludedOutletIds.length > 0 ? excludedOutletIds : undefined,
      progressId: newProgressId,
    };

    setProgressId(newProgressId);
    setShowProgressModal(true);
  };

  // Re-run without the areas/outlets the user ticked in the suggestion and
  // geo-outlier lists.
  const handleExcludeAndRerun = () => {
    const ids: string[] = [];
    for (const s of coverageSuggestions) {
      if (selectedExclusions.has(s.territory)) ids.push(...s.outletIds);
    }
    ids.push(...Array.from(selectedGeoExclusions));
    const combined = Array.from(new Set([...activeExcludedIds, ...ids]));
    setActiveExcludedIds(combined);
    handleOptimization(combined);
  };

  const toggleExclusion = (territory: string) => {
    setSelectedExclusions(prev => {
      const next = new Set(prev);
      if (next.has(territory)) next.delete(territory);
      else next.add(territory);
      return next;
    });
  };

  const toggleGeoExclusion = (outletId: string) => {
    setSelectedGeoExclusions(prev => {
      const next = new Set(prev);
      if (next.has(outletId)) next.delete(outletId);
      else next.add(outletId);
      return next;
    });
  };

  const totalSelectedExclusions = selectedExclusions.size + selectedGeoExclusions.size;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center">
          <Settings className="mr-2 h-5 w-5 text-[#1d1d1f] dark:text-white" />
          Step 3: Optimization Settings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4 p-4 bg-gray-50 rounded-lg">
          <h4 className="font-medium text-gray-700">Daily Visit Targets</h4>
          <p className="text-xs text-gray-500">Actual outlets a rep visits each day - zones are sized automatically from these and each outlet's visit frequency.</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="minVisits">Min Outlets/Day</Label>
              <Input
                id="minVisits"
                type="number"
                value={minVisitsPerDay}
                onChange={(e) => setMinVisitsPerDay(parseInt(e.target.value) || 15)}
                min="1"
                max="50"
                className="mt-1"
                disabled={disabled}
                data-testid="input-min-visits"
              />
            </div>
            <div>
              <Label htmlFor="maxVisits">Max Outlets/Day</Label>
              <Input
                id="maxVisits"
                type="number"
                value={maxVisitsPerDay}
                onChange={(e) => setMaxVisitsPerDay(parseInt(e.target.value) || 25)}
                min="1"
                max="50"
                className="mt-1"
                disabled={disabled}
                data-testid="input-max-visits"
              />
            </div>
          </div>
        </div>

        <div>
          <Label htmlFor="workingDays">Working Days/Week</Label>
          <Select
            value={workingDaysPerWeek.toString()}
            onValueChange={(value) => setWorkingDaysPerWeek(parseInt(value))}
            disabled={disabled}
          >
            <SelectTrigger className="mt-1" disabled={disabled} data-testid="select-working-days">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5">5 Days</SelectItem>
              <SelectItem value="6">6 Days</SelectItem>
              <SelectItem value="7">7 Days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="weightMode">Coverage Weighting (for area suggestions)</Label>
          <Select
            value={weightMode}
            onValueChange={(value) => setWeightMode(value as WeightMode)}
            disabled={disabled}
          >
            <SelectTrigger className="mt-1" disabled={disabled} data-testid="select-weight-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="isolation">Geographic isolation (no extra data needed)</SelectItem>
              <SelectItem value="vf">Visit frequency weighted</SelectItem>
              <SelectItem value="value">Commercial value (VC/volume column in file)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-gray-500 mt-1">
            Decides how areas are judged when suggesting low-worth pockets to move to indirect coverage. Suggestions never remove anything automatically.
          </p>
        </div>

        <div>
          <Label htmlFor="distanceMode">Distance Model</Label>
          <Select
            value={distanceMode}
            onValueChange={(value) => setDistanceMode(value as 'haversine' | 'road')}
            disabled={disabled}
          >
            <SelectTrigger className="mt-1" disabled={disabled} data-testid="select-distance-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="haversine">Straight-line (fastest)</SelectItem>
              <SelectItem value="road">Road-aware (urban detours + river crossings)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-gray-500 mt-1">
            Road-aware mode penalizes routes that cross major barriers (e.g. the Tigris) and approximates real driving distance; connects to an OSRM server for true road distances when configured.
          </p>
        </div>

        {feasibilityCheck.message && (
          <Alert className={feasibilityCheck.warning ? "border-red-200 bg-red-50" : "border-green-200 bg-green-50"}>
            <AlertCircle className={`h-4 w-4 ${feasibilityCheck.warning ? "text-red-600" : "text-green-600"}`} />
            <AlertDescription className={feasibilityCheck.warning ? "text-red-800" : "text-green-800"}>
              {feasibilityCheck.message}
            </AlertDescription>
          </Alert>
        )}

        {analysis && analysis.outlets > 0 && (
          <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
            <h4 className="font-semibold text-blue-900 mb-2">Data Summary</h4>
            <div className="text-sm text-blue-800 space-y-1">
              <div>Total Outlets: <span className="font-medium">{analysis.outlets}</span></div>
              <div>VF1 (Monthly): <span className="font-medium">{analysis.vf1 || 0}</span></div>
              <div>VF2 (Bi-weekly): <span className="font-medium">{analysis.vf2}</span></div>
              <div>VF4 (Weekly): <span className="font-medium">{analysis.vf4}</span></div>
              <div className="pt-2 border-t border-blue-300">
                <strong>Initial Estimate: ~{estimatedReps} reps</strong>
                <p className="text-xs mt-1">Final recommendation after optimization</p>
              </div>
            </div>
          </div>
        )}

        <Button
          onClick={() => handleOptimization()}
          disabled={disabled || optimizationMutation.isPending}
          className="w-full"
          data-testid="button-run-optimization"
        >
          <Play className="mr-2 h-4 w-4" />
          {optimizationMutation.isPending ? (
            "Running..."
          ) : !feasibilityCheck.feasible ? (
            "Cannot Optimize - Adjust Settings"
          ) : (
            "Run Optimization"
          )}
        </Button>

        {activeExcludedIds.length > 0 && (
          <Alert className="border-gray-300 bg-gray-50">
            <AlertCircle className="h-4 w-4 text-gray-600" />
            <AlertDescription className="text-gray-700 flex items-center justify-between gap-2">
              <span>{activeExcludedIds.length} outlets are excluded from optimization (indirect coverage).</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setActiveExcludedIds([]); }}
                data-testid="button-clear-exclusions"
              >
                Clear
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {territoryBalance && (
          <Alert className={territoryBalance.withinTolerance ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}>
            <AlertCircle className={`h-4 w-4 ${territoryBalance.withinTolerance ? "text-green-600" : "text-amber-600"}`} />
            <AlertDescription className={territoryBalance.withinTolerance ? "text-green-800" : "text-amber-800"}>
              <strong>Territory balance:</strong> target ~{territoryBalance.targetPerRep} visits/month per rep,
              max deviation {territoryBalance.maxDeviationPct}% (band ±{territoryBalance.tolerancePct}%).
              {!territoryBalance.withinTolerance && " Residual imbalance kept to avoid forcing long drives between disconnected regions."}
            </AlertDescription>
          </Alert>
        )}

        {coverageSuggestions.length > 0 && (
          <div className="p-4 bg-amber-50 rounded-lg border border-amber-200 space-y-3" data-testid="coverage-suggestions">
            <h4 className="font-semibold text-amber-900">
              Suggested areas for indirect coverage ({weightModeUsed})
            </h4>
            <p className="text-xs text-amber-800">
              These pockets cost disproportionate driving for the visits they generate. Tick the ones to drop and re-run — nothing is removed unless you choose to.
            </p>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {coverageSuggestions.map((s) => (
                <label key={s.territory} className="flex items-start gap-2 text-sm text-amber-900 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selectedExclusions.has(s.territory)}
                    onChange={() => toggleExclusion(s.territory)}
                    data-testid={`checkbox-exclude-${s.territory.replace(/\s+/g, '-').toLowerCase()}`}
                  />
                  <span>
                    <strong>{s.territory}</strong> — {s.outletCount} outlet{s.outletCount === 1 ? '' : 's'}, {s.monthlyVisits} visits/mo,
                    ~{s.costPerVisitKm}km drive per visit (e.g. {s.sampleOutlets.join(', ')})
                    <span className="block text-xs text-amber-700">{s.reason}</span>
                  </span>
                </label>
              ))}
            </div>
            <Button
              variant="outline"
              className="w-full border-amber-400 text-amber-900"
              disabled={disabled || optimizationMutation.isPending || totalSelectedExclusions === 0}
              onClick={handleExcludeAndRerun}
              data-testid="button-exclude-rerun"
            >
              Re-optimize without {totalSelectedExclusions} selected item{totalSelectedExclusions === 1 ? '' : 's'}
            </Button>
          </div>
        )}

        {geoOutliers.length > 0 && (
          <div className="p-4 bg-red-50 rounded-lg border border-red-200 space-y-3" data-testid="geo-outliers">
            <h4 className="font-semibold text-red-900">
              Outlets outside the core coverage area ({geoOutliers.length})
            </h4>
            <p className="text-xs text-red-800">
              These outlets sit far outside the market and its rural belt — usually wrong GPS data or outlets that belong to another region. Review them before deciding: tick the ones to exclude and re-run.
            </p>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {geoOutliers.map((g) => (
                <label key={g.id} className="flex items-start gap-2 text-sm text-red-900 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selectedGeoExclusions.has(g.id)}
                    onChange={() => toggleGeoExclusion(g.id)}
                    data-testid={`checkbox-geo-${g.id}`}
                  />
                  <span>
                    <strong>{g.name}</strong> — {g.distanceKm}km from the core area
                    <span className="block text-xs text-red-700">({g.latitude.toFixed(4)}, {g.longitude.toFixed(4)})</span>
                  </span>
                </label>
              ))}
            </div>
            <Button
              variant="outline"
              className="w-full border-red-400 text-red-900"
              disabled={disabled || optimizationMutation.isPending || totalSelectedExclusions === 0}
              onClick={handleExcludeAndRerun}
              data-testid="button-geo-exclude-rerun"
            >
              Re-optimize without {totalSelectedExclusions} selected item{totalSelectedExclusions === 1 ? '' : 's'}
            </Button>
          </div>
        )}
      </CardContent>
      
      <OptimizationProgressModal
        isOpen={showProgressModal}
        progressId={progressId}
        onReady={handleSSEReady}
        onComplete={handleProgressComplete}
        onError={handleProgressError}
      />
    </Card>
  );
}
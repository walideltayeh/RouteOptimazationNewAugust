import { useState, useMemo, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import { Settings, Play, AlertCircle, Clock, Calculator } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Alert, AlertDescription } from "@/components/ui/alert";
import OptimizationProgressModal from "./optimization-progress-modal";

interface FileAnalysis {
  outlets: number;
  vf1: number;
  vf2: number;
  vf4: number;
  recommendedReps?: number;
  avgTimePerVisit?: number;
}

interface DashboardMetrics {
  totalOutlets: number;
  activeReps: number;
  recommendedReps: number;
  routeEfficiency: number;
}

interface OptimizationSettingsProps {
  disabled?: boolean;
}

type CalculationMode = 'manual' | 'time-based';

export default function OptimizationSettings({ disabled = false }: OptimizationSettingsProps) {
  const [calculationMode, setCalculationMode] = useState<CalculationMode>('manual');
  
  // Manual mode settings
  const [minVisitsPerDay, setMinVisitsPerDay] = useState(25);
  const [maxVisitsPerDay, setMaxVisitsPerDay] = useState(30);
  
  // Time-based mode settings
  const [maxTimePerOutlet, setMaxTimePerOutlet] = useState(45); // minutes
  const [maxWorkingHoursPerDay, setMaxWorkingHoursPerDay] = useState(8); // hours
  
  // Common settings
  const [workingDaysPerWeek, setWorkingDaysPerWeek] = useState(5);
  
  // Progress modal state
  const [showProgressModal, setShowProgressModal] = useState(false);
  const [progressId, setProgressId] = useState('');

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: analysis } = useQuery<FileAnalysis>({
    queryKey: ["/api/analysis"],
  });

  const { data: metrics } = useQuery<DashboardMetrics>({
    queryKey: ["/api/dashboard/metrics"],
  });

  // Calculate estimated outlets per day for time-based mode
  const calculatedOutletsPerDay = useMemo(() => {
    if (calculationMode !== 'time-based') return null;
    
    const avgTravelTime = 10; // minutes between outlets
    const maxWorkingMinutes = maxWorkingHoursPerDay * 60;
    const effectiveTimePerOutlet = maxTimePerOutlet + avgTravelTime;
    const maxOutlets = Math.floor(maxWorkingMinutes / effectiveTimePerOutlet);
    const minOutlets = Math.max(1, Math.floor(maxOutlets * 0.8));
    
    return { min: minOutlets, max: maxOutlets };
  }, [calculationMode, maxTimePerOutlet, maxWorkingHoursPerDay]);

  // Show initial estimate from file upload analysis
  const estimatedReps = analysis?.recommendedReps || 0;

  // Show estimated calculation based on user parameters
  const feasibilityCheck = useMemo(() => {
    if (!analysis || !metrics) return { feasible: true, message: "", warning: false };
    
    const totalOutlets = analysis.outlets;
    
    if (totalOutlets === 0) return { feasible: true, message: "", warning: false };
    
    // Calculate based on user's parameters
    const totalWeeklyVisits = (analysis.vf1 || 0) + (analysis.vf2 * 2) + (analysis.vf4 * 4);
    
    let effectiveMax: number;
    let effectiveMin: number;
    
    if (calculationMode === 'time-based' && calculatedOutletsPerDay) {
      effectiveMax = calculatedOutletsPerDay.max;
      effectiveMin = calculatedOutletsPerDay.min;
    } else {
      effectiveMax = maxVisitsPerDay;
      effectiveMin = minVisitsPerDay;
    }
    
    const maxWeeklyCapacityPerRep = workingDaysPerWeek * effectiveMax;
    const estimatedRepsNeeded = Math.ceil(totalWeeklyVisits / maxWeeklyCapacityPerRep);
    
    const modeLabel = calculationMode === 'time-based' 
      ? `(${maxTimePerOutlet} min/outlet, ${maxWorkingHoursPerDay}h/day = ${effectiveMin}-${effectiveMax} visits/day)`
      : `(${effectiveMin}-${effectiveMax} visits/day, ${workingDaysPerWeek} days/week)`;
    
    return {
      feasible: true,
      message: `Will create ~${estimatedRepsNeeded} routes ${modeLabel}`,
      warning: false
    };
  }, [analysis, metrics, workingDaysPerWeek, minVisitsPerDay, maxVisitsPerDay, calculationMode, maxTimePerOutlet, maxWorkingHoursPerDay, calculatedOutletsPerDay]);

  const optimizationMutation = useMutation({
    mutationFn: async (settings: { 
      minVisitsPerDay: number; 
      maxVisitsPerDay: number; 
      workingDaysPerWeek: number;
      calculationMode: CalculationMode;
      maxTimePerOutlet?: number;
      maxWorkingHoursPerDay?: number;
      progressId?: string;
    }) => {
      const response = await apiRequest("POST", "/api/optimize", settings);
      return response.json();
    },
    onSuccess: (data) => {
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
    toast({
      title: "Optimization failed",
      description: message,
      variant: "destructive",
    });
  }, [toast]);

  const handleOptimization = () => {
    if (calculationMode === 'manual' && minVisitsPerDay >= maxVisitsPerDay) {
      toast({
        title: "Invalid settings",
        description: "Minimum visits must be less than maximum visits",
        variant: "destructive",
      });
      return;
    }

    // Generate a unique progress ID
    const newProgressId = `opt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    setProgressId(newProgressId);
    setShowProgressModal(true);

    optimizationMutation.mutate({
      minVisitsPerDay,
      maxVisitsPerDay,
      workingDaysPerWeek,
      calculationMode,
      maxTimePerOutlet: calculationMode === 'time-based' ? maxTimePerOutlet : undefined,
      maxWorkingHoursPerDay: calculationMode === 'time-based' ? maxWorkingHoursPerDay : undefined,
      progressId: newProgressId,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center">
          <Settings className="mr-2 h-5 w-5 text-primary" />
          Step 3: Optimization Settings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <Label className="text-base font-semibold">Calculation Mode</Label>
          <RadioGroup
            value={calculationMode}
            onValueChange={(value) => setCalculationMode(value as CalculationMode)}
            className="grid grid-cols-1 gap-3"
            disabled={disabled}
          >
            <div className="flex items-start space-x-3 p-3 border rounded-lg hover:bg-gray-50 cursor-pointer" data-testid="radio-manual-mode">
              <RadioGroupItem value="manual" id="manual" className="mt-1" />
              <div className="flex-1">
                <Label htmlFor="manual" className="flex items-center gap-2 cursor-pointer font-medium">
                  <Calculator className="h-4 w-4" />
                  Manual: Min/Max Outlets per Day
                </Label>
                <p className="text-sm text-gray-500 mt-1">
                  Specify the minimum and maximum number of outlets a rep should visit each day.
                </p>
              </div>
            </div>
            <div className="flex items-start space-x-3 p-3 border rounded-lg hover:bg-gray-50 cursor-pointer" data-testid="radio-time-mode">
              <RadioGroupItem value="time-based" id="time-based" className="mt-1" />
              <div className="flex-1">
                <Label htmlFor="time-based" className="flex items-center gap-2 cursor-pointer font-medium">
                  <Clock className="h-4 w-4" />
                  Time-Based: Auto-Calculate from Working Hours
                </Label>
                <p className="text-sm text-gray-500 mt-1">
                  System calculates outlets per day based on max time per outlet and working hours.
                </p>
              </div>
            </div>
          </RadioGroup>
        </div>

        {calculationMode === 'manual' ? (
          <div className="space-y-4 p-4 bg-gray-50 rounded-lg">
            <h4 className="font-medium text-gray-700">Manual Settings</h4>
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
        ) : (
          <div className="space-y-4 p-4 bg-blue-50 rounded-lg">
            <h4 className="font-medium text-blue-700">Time-Based Settings</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="maxTimePerOutlet">Max Time per Outlet (min)</Label>
                <Input
                  id="maxTimePerOutlet"
                  type="number"
                  value={maxTimePerOutlet}
                  onChange={(e) => setMaxTimePerOutlet(parseInt(e.target.value) || 30)}
                  min="5"
                  max="120"
                  className="mt-1"
                  disabled={disabled}
                  data-testid="input-max-time"
                />
              </div>
              <div>
                <Label htmlFor="maxWorkingHours">Max Working Hours/Day</Label>
                <Input
                  id="maxWorkingHours"
                  type="number"
                  value={maxWorkingHoursPerDay}
                  onChange={(e) => setMaxWorkingHoursPerDay(parseFloat(e.target.value) || 8)}
                  min="1"
                  max="12"
                  step="0.5"
                  className="mt-1"
                  disabled={disabled}
                  data-testid="input-max-hours"
                />
              </div>
            </div>
            {calculatedOutletsPerDay && (
              <div className="mt-3 p-3 bg-white rounded border border-blue-200">
                <p className="text-sm text-blue-800">
                  <strong>Calculated:</strong> {calculatedOutletsPerDay.min}-{calculatedOutletsPerDay.max} outlets/day
                  <span className="text-xs block text-gray-500 mt-1">
                    ({maxWorkingHoursPerDay * 60} min / ({maxTimePerOutlet} min visit + ~10 min travel))
                  </span>
                </p>
              </div>
            )}
          </div>
        )}

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
              {analysis.avgTimePerVisit && (
                <div>Avg Time/Visit: <span className="font-medium">{analysis.avgTimePerVisit} min</span></div>
              )}
              <div className="pt-2 border-t border-blue-300">
                <strong>Initial Estimate: ~{estimatedReps} reps</strong>
                <p className="text-xs mt-1">Final recommendation after optimization</p>
              </div>
            </div>
          </div>
        )}

        <Button 
          onClick={handleOptimization} 
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
      </CardContent>
      
      <OptimizationProgressModal
        isOpen={showProgressModal}
        progressId={progressId}
        onComplete={handleProgressComplete}
        onError={handleProgressError}
      />
    </Card>
  );
}
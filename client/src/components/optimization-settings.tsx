import { useState, useMemo } from "react";
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

interface FileAnalysis {
  outlets: number;
  vf2: number;
  vf4: number;
  recommendedReps?: number;
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

export default function OptimizationSettings({ disabled = false }: OptimizationSettingsProps) {
  const [minVisitsPerDay, setMinVisitsPerDay] = useState(25);
  const [maxVisitsPerDay, setMaxVisitsPerDay] = useState(30);
  const [workingDaysPerWeek, setWorkingDaysPerWeek] = useState(5);

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
    
    // Calculate based on user's parameters
    const totalWeeklyVisits = (analysis.vf2 * 2) + (analysis.vf4 * 4);
    const maxWeeklyCapacityPerRep = workingDaysPerWeek * maxVisitsPerDay;
    const estimatedRepsNeeded = Math.ceil(totalWeeklyVisits / maxWeeklyCapacityPerRep);
    
    return {
      feasible: true, // Always allow optimization with user parameters
      message: `Will create ~${estimatedRepsNeeded} routes based on your settings (${minVisitsPerDay}-${maxVisitsPerDay} visits/day, ${workingDaysPerWeek} days/week)`,
      warning: false
    };
  }, [analysis, metrics, workingDaysPerWeek, minVisitsPerDay, maxVisitsPerDay]);

  const optimizationMutation = useMutation({
    mutationFn: async (settings: { 
      minVisitsPerDay: number; 
      maxVisitsPerDay: number; 
      workingDaysPerWeek: number; 
    }) => {
      const response = await apiRequest("POST", "/api/optimize", settings);
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Optimization completed",
        description: `${data.message} (${data.assignedOutlets || 0} outlets assigned)`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/reps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/outlets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/schedules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Optimization failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleOptimization = () => {
    if (minVisitsPerDay >= maxVisitsPerDay) {
      toast({
        title: "Invalid settings",
        description: "Minimum visits must be less than maximum visits",
        variant: "destructive",
      });
      return;
    }

    optimizationMutation.mutate({
      minVisitsPerDay,
      maxVisitsPerDay,
      workingDaysPerWeek,
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
      <CardContent className="space-y-4">
        <div>
          <Label htmlFor="minVisits">Min Unique Visits/Day</Label>
          <Input
            id="minVisits"
            type="number"
            value={minVisitsPerDay}
            onChange={(e) => setMinVisitsPerDay(parseInt(e.target.value) || 15)}
            min="1"
            max="50"
            className="mt-1"
            disabled={disabled}
          />
        </div>

        <div>
          <Label htmlFor="maxVisits">Max Unique Visits/Day</Label>
          <Input
            id="maxVisits"
            type="number"
            value={maxVisitsPerDay}
            onChange={(e) => setMaxVisitsPerDay(parseInt(e.target.value) || 25)}
            min="1"
            max="50"
            className="mt-1"
            disabled={disabled}
          />
        </div>

        <div>
          <Label htmlFor="workingDays">Working Days/Week</Label>
          <Select 
            value={workingDaysPerWeek.toString()} 
            onValueChange={(value) => setWorkingDaysPerWeek(parseInt(value))}
            disabled={disabled}
          >
            <SelectTrigger className="mt-1" disabled={disabled}>
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
            <h4 className="font-semibold text-blue-900 mb-2">Initial Estimate</h4>
            <div className="text-sm text-blue-800 space-y-1">
              <div>Total Outlets: <span className="font-medium">{analysis.outlets}</span></div>
              <div>VF2 Outlets: <span className="font-medium">{analysis.vf2}</span></div>
              <div>VF4 Outlets: <span className="font-medium">{analysis.vf4}</span></div>
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
        >
          <Play className="mr-2 h-4 w-4" />
          {optimizationMutation.isPending ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
              Optimizing...
            </>
          ) : !feasibilityCheck.feasible ? (
            "Cannot Optimize - Adjust Settings"
          ) : (
            "Run Optimization"
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
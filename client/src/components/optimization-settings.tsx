import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Settings, Play } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

export default function OptimizationSettings() {
  const [minVisitsPerDay, setMinVisitsPerDay] = useState(15);
  const [maxVisitsPerDay, setMaxVisitsPerDay] = useState(25);
  const [workingDaysPerWeek, setWorkingDaysPerWeek] = useState(5);
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

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
          Optimization Settings
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
          />
        </div>
        
        <div>
          <Label htmlFor="workingDays">Working Days/Week</Label>
          <Select 
            value={workingDaysPerWeek.toString()} 
            onValueChange={(value) => setWorkingDaysPerWeek(parseInt(value))}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5">5 Days</SelectItem>
              <SelectItem value="6">6 Days</SelectItem>
              <SelectItem value="7">7 Days</SelectItem>
            </SelectContent>
          </Select>
        </div>
        
        <Button 
          onClick={handleOptimization}
          disabled={optimizationMutation.isPending}
          className="w-full"
        >
          <Play className="mr-2 h-4 w-4" />
          {optimizationMutation.isPending ? "Running..." : "Run Optimization"}
        </Button>
      </CardContent>
    </Card>
  );
}

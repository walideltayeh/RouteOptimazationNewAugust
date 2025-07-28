import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { 
  Brain, 
  TrendingUp, 
  Target, 
  AlertTriangle, 
  CheckCircle, 
  Activity,
  BarChart3,
  Zap,
  Calendar,
  Users
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { mlEngine } from "@/lib/ml-forecasting";
import type { Rep, Outlet, Schedule } from "@shared/schema";

interface MLInsightsProps {
  outlets: Outlet[];
  reps: Rep[];
  schedules: Schedule[];
}

export default function MLInsights({ outlets, reps, schedules }: MLInsightsProps) {
  const { toast } = useToast();
  const [isTraining, setIsTraining] = useState(false);
  const [forecasts, setForecasts] = useState<any[]>([]);
  const [optimizationResults, setOptimizationResults] = useState<any>(null);
  const [modelMetrics, setModelMetrics] = useState<any>(null);

  useEffect(() => {
    if (outlets.length > 0 && schedules.length > 0) {
      initializeML();
    }
  }, [outlets, schedules]);

  const initializeML = async () => {
    setIsTraining(true);
    
    try {
      // Initialize ML engine with historical data
      mlEngine.initializeHistoricalData(schedules, outlets);
      
      // Generate demand forecasts
      const demandForecasts = mlEngine.generateDemandForecasts(outlets, 30);
      setForecasts(demandForecasts);
      
      // Run territory optimization
      const optimization = mlEngine.optimizeTerritories(outlets, reps, demandForecasts, schedules);
      setOptimizationResults(optimization);
      
      // Get model performance metrics
      const metrics = mlEngine.getModelMetrics();
      setModelMetrics(metrics);
      
      toast({
        title: "ML Analysis Complete",
        description: `Analyzed ${outlets.length} outlets with ${metrics.totalModels} predictive models.`,
      });
    } catch (error) {
      toast({
        title: "ML Training Error",
        description: "Failed to initialize machine learning models.",
        variant: "destructive",
      });
    } finally {
      setIsTraining(false);
    }
  };

  const applyOptimizationMutation = useMutation({
    mutationFn: async (recommendations: any[]) => {
      // Apply the recommended territory changes
      for (const rec of recommendations) {
        await apiRequest("PUT", `/api/outlets/${rec.outletId}`, {
          repId: rec.recommendedRepId
        });
      }
    },
    onSuccess: () => {
      toast({
        title: "Optimization Applied",
        description: "Territory assignments have been updated based on ML recommendations.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/outlets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reps"] });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to apply territory optimization.",
        variant: "destructive",
      });
    },
  });

  if (outlets.length === 0) {
    return (
      <Card>
        <CardContent className="text-center py-8">
          <Brain className="mx-auto h-12 w-12 text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No Data Available</h3>
          <p className="text-gray-500">Upload outlet data to enable ML insights and forecasting.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* ML Status Header */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <Brain className="h-6 w-6 text-purple-600" />
              </div>
              <div>
                <CardTitle className="text-xl">ML Insights & Forecasting</CardTitle>
                <p className="text-sm text-gray-600">
                  AI-powered demand prediction and territory optimization
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-3">
              {isTraining && (
                <div className="flex items-center space-x-2">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-purple-600"></div>
                  <span className="text-sm text-gray-600">Training models...</span>
                </div>
              )}
              <Button onClick={initializeML} disabled={isTraining}>
                <Zap className="mr-2 h-4 w-4" />
                {isTraining ? 'Training...' : 'Retrain Models'}
              </Button>
            </div>
          </div>
        </CardHeader>
        
        {modelMetrics && (
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-blue-50 p-4 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-blue-900">Model Accuracy</p>
                    <p className="text-2xl font-bold text-blue-600">
                      {(modelMetrics.avgAccuracy * 100).toFixed(1)}%
                    </p>
                  </div>
                  <BarChart3 className="h-8 w-8 text-blue-500" />
                </div>
                <Progress value={modelMetrics.avgAccuracy * 100} className="mt-2" />
              </div>
              
              <div className="bg-green-50 p-4 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-green-900">Active Models</p>
                    <p className="text-2xl font-bold text-green-600">{modelMetrics.totalModels}</p>
                  </div>
                  <Target className="h-8 w-8 text-green-500" />
                </div>
                <p className="text-xs text-green-700 mt-1">Covering {outlets.length} outlets</p>
              </div>
              
              <div className="bg-purple-50 p-4 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-purple-900">Coverage</p>
                    <p className="text-2xl font-bold text-purple-600">
                      {(modelMetrics.coverage * 100).toFixed(0)}%
                    </p>
                  </div>
                  <Activity className="h-8 w-8 text-purple-500" />
                </div>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Insights Tabs */}
      <Tabs defaultValue="forecasts" className="space-y-4">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="forecasts" className="flex items-center space-x-2">
            <Calendar className="h-4 w-4" />
            <span>Demand Forecasts</span>
          </TabsTrigger>
          <TabsTrigger value="optimization" className="flex items-center space-x-2">
            <Target className="h-4 w-4" />
            <span>Route Optimization</span>
          </TabsTrigger>
          <TabsTrigger value="insights" className="flex items-center space-x-2">
            <TrendingUp className="h-4 w-4" />
            <span>Insights</span>
          </TabsTrigger>
        </TabsList>

        {/* Demand Forecasts Tab */}
        <TabsContent value="forecasts">
          <Card>
            <CardHeader>
              <CardTitle>30-Day Demand Forecasts</CardTitle>
              <p className="text-sm text-gray-600">
                ML predictions for outlet visit requirements
              </p>
            </CardHeader>
            <CardContent>
              {forecasts.length > 0 ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                    <div className="bg-blue-50 p-3 rounded-lg">
                      <p className="text-sm font-medium text-blue-900">High Demand</p>
                      <p className="text-xl font-bold text-blue-600">
                        {forecasts.filter(f => f.predictedVisits > 12).length}
                      </p>
                      <p className="text-xs text-blue-700">outlets predicted</p>
                    </div>
                    <div className="bg-green-50 p-3 rounded-lg">
                      <p className="text-sm font-medium text-green-900">Stable Demand</p>
                      <p className="text-xl font-bold text-green-600">
                        {forecasts.filter(f => f.predictedVisits >= 6 && f.predictedVisits <= 12).length}
                      </p>
                      <p className="text-xs text-green-700">outlets predicted</p>
                    </div>
                    <div className="bg-yellow-50 p-3 rounded-lg">
                      <p className="text-sm font-medium text-yellow-900">Low Demand</p>
                      <p className="text-xl font-bold text-yellow-600">
                        {forecasts.filter(f => f.predictedVisits < 6).length}
                      </p>
                      <p className="text-xs text-yellow-700">outlets predicted</p>
                    </div>
                    <div className="bg-purple-50 p-3 rounded-lg">
                      <p className="text-sm font-medium text-purple-900">Avg Confidence</p>
                      <p className="text-xl font-bold text-purple-600">
                        {forecasts.length > 0 ? 
                          (forecasts.reduce((sum, f) => sum + f.confidence, 0) / forecasts.length * 100).toFixed(1) : 0}%
                      </p>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Outlet</TableHead>
                          <TableHead className="text-center">Current Frequency</TableHead>
                          <TableHead className="text-center">Predicted Visits</TableHead>
                          <TableHead className="text-center">Confidence</TableHead>
                          <TableHead className="text-center">Trend</TableHead>
                          <TableHead className="text-center">Seasonal Factor</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {forecasts
                          .sort((a, b) => b.predictedVisits - a.predictedVisits)
                          .slice(0, 20)
                          .map((forecast) => {
                          const outlet = outlets.find(o => o.id === forecast.outletId);
                          if (!outlet) return null;
                          
                          return (
                            <TableRow key={forecast.outletId}>
                              <TableCell>
                                <div>
                                  <div className="font-medium">{outlet.name}</div>
                                  <div className="text-sm text-gray-500">VF{outlet.visitFrequency}</div>
                                </div>
                              </TableCell>
                              <TableCell className="text-center">
                                <Badge variant="outline">
                                  {outlet.visitFrequency}/week
                                </Badge>
                              </TableCell>
                              <TableCell className="text-center">
                                <span className="font-semibold">
                                  {forecast.predictedVisits.toFixed(1)}
                                </span>
                              </TableCell>
                              <TableCell className="text-center">
                                <Badge 
                                  variant={forecast.confidence > 0.7 ? "default" : 
                                          forecast.confidence > 0.5 ? "secondary" : "destructive"}
                                >
                                  {(forecast.confidence * 100).toFixed(0)}%
                                </Badge>
                              </TableCell>
                              <TableCell className="text-center">
                                <div className="flex items-center justify-center">
                                  {forecast.trendFactor > 1.05 ? (
                                    <TrendingUp className="h-4 w-4 text-green-500" />
                                  ) : forecast.trendFactor < 0.95 ? (
                                    <TrendingUp className="h-4 w-4 text-red-500 transform rotate-180" />
                                  ) : (
                                    <span className="text-gray-400">—</span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-center">
                                <span className={
                                  forecast.seasonalFactor > 1.1 ? "text-green-600 font-medium" :
                                  forecast.seasonalFactor < 0.9 ? "text-red-600 font-medium" :
                                  "text-gray-600"
                                }>
                                  {forecast.seasonalFactor.toFixed(2)}x
                                </span>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8">
                  <Activity className="mx-auto h-12 w-12 text-gray-400 mb-4" />
                  <p className="text-gray-500">No forecasts generated yet.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Territory Optimization Tab */}
        <TabsContent value="optimization">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>ML Route Optimization</CardTitle>
                  <p className="text-sm text-gray-600">
                    AI-recommended route reassignments for better efficiency
                  </p>
                </div>
                {optimizationResults?.recommendedChanges?.length > 0 && (
                  <Button 
                    onClick={() => applyOptimizationMutation.mutate(optimizationResults.recommendedChanges)}
                    disabled={applyOptimizationMutation.isPending}
                  >
                    <CheckCircle className="mr-2 h-4 w-4" />
                    Apply Recommendations
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {optimizationResults ? (
                <div className="space-y-6">
                  {/* Key Metrics */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-green-50 p-4 rounded-lg">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-green-900">Efficiency Gain</p>
                          <p className="text-2xl font-bold text-green-600">
                            +{(optimizationResults.efficiencyGain * 100).toFixed(1)}%
                          </p>
                        </div>
                        <TrendingUp className="h-8 w-8 text-green-500" />
                      </div>
                    </div>
                    
                    <div className="bg-blue-50 p-4 rounded-lg">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-blue-900">Workload Balance</p>
                          <p className="text-2xl font-bold text-blue-600">
                            {(optimizationResults.workloadBalance * 100).toFixed(1)}%
                          </p>
                        </div>
                        <Users className="h-8 w-8 text-blue-500" />
                      </div>
                    </div>
                  </div>

                  {/* Recommendations */}
                  {optimizationResults.recommendedChanges.length > 0 ? (
                    <div>
                      <h3 className="text-lg font-medium mb-4">
                        Recommended Changes ({optimizationResults.recommendedChanges.length})
                      </h3>
                      
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Outlet</TableHead>
                              <TableHead>Current Route</TableHead>
                              <TableHead>Recommended Route</TableHead>
                              <TableHead>Reason</TableHead>
                              <TableHead className="text-center">Expected Impact</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {optimizationResults.recommendedChanges.map((change: any, index: number) => {
                              const outlet = outlets.find(o => o.id === change.outletId);
                              const currentRep = reps.find(r => r.id === change.currentRepId);
                              const recommendedRep = reps.find(r => r.id === change.recommendedRepId);
                              
                              return (
                                <TableRow key={index}>
                                  <TableCell>
                                    <div className="font-medium">{outlet?.name || 'Unknown'}</div>
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant="outline">
                                      {currentRep?.name || 'Unknown'}
                                    </Badge>
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant="default">
                                      {recommendedRep?.name || 'Unknown'}
                                    </Badge>
                                  </TableCell>
                                  <TableCell>
                                    <span className="text-sm text-gray-600">
                                      {change.reason}
                                    </span>
                                  </TableCell>
                                  <TableCell className="text-center">
                                    <span className="text-green-600 font-medium">
                                      +{change.expectedImprovement.toFixed(1)}
                                    </span>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-8">
                      <CheckCircle className="mx-auto h-12 w-12 text-green-400 mb-4" />
                      <h3 className="text-lg font-medium text-gray-900 mb-2">Routes Optimized</h3>
                      <p className="text-gray-500">Current route assignments are already optimal.</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-8">
                  <Target className="mx-auto h-12 w-12 text-gray-400 mb-4" />
                  <p className="text-gray-500">Run ML analysis to see optimization recommendations.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Insights Tab */}
        <TabsContent value="insights">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Key Insights</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-start space-x-3">
                    <AlertTriangle className="h-5 w-5 text-yellow-500 mt-0.5" />
                    <div>
                      <p className="font-medium">Seasonal Demand Patterns</p>
                      <p className="text-sm text-gray-600">
                        {forecasts.filter(f => f.seasonalFactor > 1.2).length} outlets show strong seasonal growth
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex items-start space-x-3">
                    <TrendingUp className="h-5 w-5 text-green-500 mt-0.5" />
                    <div>
                      <p className="font-medium">Growth Opportunities</p>
                      <p className="text-sm text-gray-600">
                        {forecasts.filter(f => f.trendFactor > 1.1).length} outlets predicted to increase demand
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex items-start space-x-3">
                    <Users className="h-5 w-5 text-blue-500 mt-0.5" />
                    <div>
                      <p className="font-medium">Workload Distribution</p>
                      <p className="text-sm text-gray-600">
                        {optimizationResults ? 
                          `${(optimizationResults.workloadBalance * 100).toFixed(0)}% balanced across territories`
                          : 'Analysis pending'
                        }
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Model Performance</CardTitle>
              </CardHeader>
              <CardContent>
                {modelMetrics ? (
                  <div className="space-y-4">
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span>Prediction Accuracy</span>
                        <span>{(modelMetrics.avgAccuracy * 100).toFixed(1)}%</span>
                      </div>
                      <Progress value={modelMetrics.avgAccuracy * 100} />
                    </div>
                    
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span>Data Coverage</span>
                        <span>{(modelMetrics.coverage * 100).toFixed(0)}%</span>
                      </div>
                      <Progress value={modelMetrics.coverage * 100} />
                    </div>
                    
                    <div className="pt-2 border-t">
                      <p className="text-sm text-gray-600">
                        <strong>{modelMetrics.totalModels}</strong> predictive models trained on historical patterns
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <BarChart3 className="mx-auto h-12 w-12 text-gray-400 mb-4" />
                    <p className="text-gray-500">Initialize ML models to view performance metrics.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
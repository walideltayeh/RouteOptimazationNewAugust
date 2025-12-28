import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Car, 
  ArrowLeft,
  AlertTriangle, 
  Wrench, 
  Gauge,
  Calendar,
  TrendingUp,
  Activity,
  Bell,
  CheckCircle,
  Clock,
  AlertCircle,
  Download,
  RefreshCw,
  User,
  Heart,
  ShieldAlert,
  Zap,
  Target,
  DollarSign
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { VehicleFullDashboard, MaintenanceForecast } from "@shared/schema";

export default function VehicleDetailPage() {
  const params = useParams();
  const vehicleId = params.id as string;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: dashboard, isLoading, error } = useQuery<VehicleFullDashboard>({
    queryKey: ["/api/vehicles", vehicleId, "dashboard"],
    enabled: !!vehicleId,
  });

  const calculateForecastsMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/vehicles/${vehicleId}/calculate-forecasts`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vehicles", vehicleId, "dashboard"] });
      toast({ title: "Success", description: "Maintenance forecasts recalculated" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to recalculate forecasts", variant: "destructive" });
    }
  });

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return 'bg-red-500';
      case 'high': return 'bg-orange-500';
      case 'medium': return 'bg-yellow-500';
      default: return 'bg-green-500';
    }
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case 'critical': return <Badge className="bg-red-100 text-red-800 border-red-200">Critical</Badge>;
      case 'high': return <Badge className="bg-orange-100 text-orange-800 border-orange-200">High</Badge>;
      case 'medium': return <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200">Medium</Badge>;
      default: return <Badge className="bg-green-100 text-green-800 border-green-200">Low</Badge>;
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'overdue': return <AlertCircle className="h-5 w-5 text-red-500" />;
      case 'due': return <Clock className="h-5 w-5 text-yellow-500" />;
      default: return <CheckCircle className="h-5 w-5 text-green-500" />;
    }
  };

  const getIntensityBadge = (intensity: string) => {
    switch (intensity) {
      case 'heavy': return <Badge className="bg-red-100 text-red-800">Heavy Usage</Badge>;
      case 'medium': return <Badge className="bg-yellow-100 text-yellow-800">Medium Usage</Badge>;
      default: return <Badge className="bg-green-100 text-green-800">Light Usage</Badge>;
    }
  };

  const getComparisonBadge = (comparison: string) => {
    switch (comparison) {
      case 'above': return <Badge variant="outline" className="border-red-300 text-red-700">Above Fleet Avg</Badge>;
      case 'below': return <Badge variant="outline" className="border-green-300 text-green-700">Below Fleet Avg</Badge>;
      default: return <Badge variant="outline" className="border-blue-300 text-blue-700">Fleet Average</Badge>;
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-2 text-blue-500" />
          <p className="text-gray-500">Loading vehicle dashboard...</p>
        </div>
      </div>
    );
  }

  if (error || !dashboard) {
    return (
      <div className="p-6">
        <Link href="/vehicles">
          <Button variant="ghost" className="mb-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Vehicles
          </Button>
        </Link>
        <Card className="bg-red-50 border-red-200">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="h-12 w-12 mx-auto mb-4 text-red-500" />
            <h2 className="text-xl font-semibold text-red-800">Vehicle Not Found</h2>
            <p className="text-red-600 mt-2">The requested vehicle could not be found.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { overview, usage, maintenance, recommendations, alerts } = dashboard;

  return (
    <div className="p-6 space-y-6" data-testid="vehicle-detail-page">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/vehicles">
            <Button variant="ghost" data-testid="btn-back-vehicles">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-vehicle-title">
              <Car className="h-6 w-6" />
              {overview.plateNumber}
            </h1>
            <p className="text-gray-500">{overview.model} ({overview.year})</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            onClick={() => calculateForecastsMutation.mutate()}
            disabled={calculateForecastsMutation.isPending}
            data-testid="btn-recalculate-forecasts"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${calculateForecastsMutation.isPending ? 'animate-spin' : ''}`} />
            Recalculate Forecasts
          </Button>
          <Button 
            variant="outline" 
            onClick={() => {
              window.open(`/api/vehicles/${vehicleId}/export`, '_blank');
            }}
            data-testid="btn-export-summary"
          >
            <Download className="h-4 w-4 mr-2" />
            Export Summary
          </Button>
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="grid w-full grid-cols-6">
          <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
          <TabsTrigger value="health" data-testid="tab-health">
            Health Score
            {dashboard.healthScore && dashboard.healthScore.riskLevel !== 'low' && (
              <Badge className={`ml-2 ${
                dashboard.healthScore.riskLevel === 'critical' ? 'bg-red-500' : 
                dashboard.healthScore.riskLevel === 'high' ? 'bg-orange-500' : 'bg-yellow-500'
              } text-white`}>!</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="usage" data-testid="tab-usage">Usage</TabsTrigger>
          <TabsTrigger value="maintenance" data-testid="tab-maintenance">Maintenance</TabsTrigger>
          <TabsTrigger value="recommendations" data-testid="tab-recommendations">Plan</TabsTrigger>
          <TabsTrigger value="alerts" data-testid="tab-alerts">
            Alerts
            {alerts.length > 0 && (
              <Badge className="ml-2 bg-red-500 text-white">{alerts.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card data-testid="card-vehicle-id">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Vehicle ID</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{overview.plateNumber}</p>
                <p className="text-sm text-gray-500">{overview.model}</p>
              </CardContent>
            </Card>

            <Card data-testid="card-assigned-rep">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Assigned Rep</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <User className="h-5 w-5 text-blue-500" />
                  <p className="text-xl font-bold">{overview.assignedRepName || 'Unassigned'}</p>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="card-current-odometer">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Current Odometer</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <Gauge className="h-5 w-5 text-green-500" />
                  <p className="text-2xl font-bold">{overview.currentMileage.toLocaleString()} km</p>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="card-lifetime-km">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Total Lifetime KM</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{overview.lifetimeKm.toLocaleString()} km</p>
                <p className="text-sm text-gray-500">Since vehicle added</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card data-testid="card-monthly-km">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">This Month</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-blue-600">{overview.monthlyKm.toLocaleString()} km</p>
              </CardContent>
            </Card>

            <Card data-testid="card-quarterly-km">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">This Quarter</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-purple-600">{overview.quarterlyKm.toLocaleString()} km</p>
              </CardContent>
            </Card>

            <Card data-testid="card-status">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Vehicle Status</CardTitle>
              </CardHeader>
              <CardContent>
                <Badge className={overview.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}>
                  {overview.status.charAt(0).toUpperCase() + overview.status.slice(1)}
                </Badge>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="health" className="space-y-4">
          {dashboard.healthScore && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <Card data-testid="card-health-score" className={`border-l-4 ${
                  dashboard.healthScore.healthScore >= 80 ? 'border-l-green-500' :
                  dashboard.healthScore.healthScore >= 60 ? 'border-l-yellow-500' :
                  dashboard.healthScore.healthScore >= 40 ? 'border-l-orange-500' : 'border-l-red-500'
                }`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
                      <Heart className="h-4 w-4" />
                      Vehicle Health Score
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-4">
                      <div className={`text-4xl font-bold ${
                        dashboard.healthScore.healthScore >= 80 ? 'text-green-600' :
                        dashboard.healthScore.healthScore >= 60 ? 'text-yellow-600' :
                        dashboard.healthScore.healthScore >= 40 ? 'text-orange-600' : 'text-red-600'
                      }`}>
                        {dashboard.healthScore.healthScore}
                      </div>
                      <div className="text-sm text-gray-500">/ 100</div>
                    </div>
                    <Progress 
                      value={dashboard.healthScore.healthScore} 
                      className={`h-2 mt-2 ${
                        dashboard.healthScore.healthScore >= 80 ? '[&>div]:bg-green-500' :
                        dashboard.healthScore.healthScore >= 60 ? '[&>div]:bg-yellow-500' :
                        dashboard.healthScore.healthScore >= 40 ? '[&>div]:bg-orange-500' : '[&>div]:bg-red-500'
                      }`}
                    />
                  </CardContent>
                </Card>

                <Card data-testid="card-risk-level">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
                      <ShieldAlert className="h-4 w-4" />
                      Risk Level
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Badge className={`text-lg px-3 py-1 ${
                      dashboard.healthScore.riskLevel === 'low' ? 'bg-green-100 text-green-800' :
                      dashboard.healthScore.riskLevel === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                      dashboard.healthScore.riskLevel === 'high' ? 'bg-orange-100 text-orange-800' : 'bg-red-100 text-red-800'
                    }`}>
                      {dashboard.healthScore.riskLevel.toUpperCase()}
                    </Badge>
                  </CardContent>
                </Card>

                <Card data-testid="card-breakdown-probability">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
                      <Zap className="h-4 w-4" />
                      Breakdown Probability
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className={`text-2xl font-bold ${
                      dashboard.healthScore.breakdownProbability <= 20 ? 'text-green-600' :
                      dashboard.healthScore.breakdownProbability <= 40 ? 'text-yellow-600' :
                      dashboard.healthScore.breakdownProbability <= 60 ? 'text-orange-600' : 'text-red-600'
                    }`}>
                      {dashboard.healthScore.breakdownProbability.toFixed(1)}%
                    </p>
                    <p className="text-sm text-gray-500">Probability of issues</p>
                  </CardContent>
                </Card>

                <Card data-testid="card-wear-acceleration">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
                      <Target className="h-4 w-4" />
                      Wear Acceleration
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className={`text-2xl font-bold ${
                      dashboard.healthScore.wearAccelerationFactor <= 1.0 ? 'text-green-600' :
                      dashboard.healthScore.wearAccelerationFactor <= 1.2 ? 'text-yellow-600' : 'text-red-600'
                    }`}>
                      {dashboard.healthScore.wearAccelerationFactor.toFixed(1)}x
                    </p>
                    <p className="text-sm text-gray-500">
                      {dashboard.healthScore.wearAccelerationFactor <= 1.0 ? 'Normal wear' :
                       dashboard.healthScore.wearAccelerationFactor <= 1.2 ? 'Slightly accelerated' : 'Heavy wear'}
                    </p>
                  </CardContent>
                </Card>
              </div>

              <Card data-testid="card-health-factors">
                <CardHeader>
                  <CardTitle>Health Factor Breakdown</CardTitle>
                  <CardDescription>Components contributing to overall vehicle health score</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Mileage Health</span>
                        <span className="font-medium">{dashboard.healthScore.healthFactors.mileageHealth}%</span>
                      </div>
                      <Progress value={dashboard.healthScore.healthFactors.mileageHealth} className="h-2" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Maintenance Compliance</span>
                        <span className="font-medium">{dashboard.healthScore.healthFactors.maintenanceCompliance}%</span>
                      </div>
                      <Progress value={dashboard.healthScore.healthFactors.maintenanceCompliance} className="h-2" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Usage Pattern</span>
                        <span className="font-medium">{dashboard.healthScore.healthFactors.usagePattern}%</span>
                      </div>
                      <Progress value={dashboard.healthScore.healthFactors.usagePattern} className="h-2" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Age Condition</span>
                        <span className="font-medium">{dashboard.healthScore.healthFactors.ageCondition}%</span>
                      </div>
                      <Progress value={dashboard.healthScore.healthFactors.ageCondition} className="h-2" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {dashboard.monthlyPlan && (
                <Card data-testid="card-monthly-plan">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <DollarSign className="h-5 w-5" />
                      Monthly Maintenance Plan
                    </CardTitle>
                    <CardDescription>Projected maintenance for {dashboard.monthlyPlan.month}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                      <div className="bg-blue-50 p-4 rounded-lg">
                        <p className="text-sm text-blue-600">Projected KM</p>
                        <p className="text-xl font-bold text-blue-800">{dashboard.monthlyPlan.projectedKm.toLocaleString()} km</p>
                      </div>
                      <div className="bg-green-50 p-4 rounded-lg">
                        <p className="text-sm text-green-600">Estimated Cost</p>
                        <p className="text-xl font-bold text-green-800">${dashboard.monthlyPlan.estimatedCost.toFixed(2)}</p>
                      </div>
                      <div className="bg-purple-50 p-4 rounded-lg">
                        <p className="text-sm text-purple-600">Scheduled Items</p>
                        <p className="text-xl font-bold text-purple-800">{dashboard.monthlyPlan.scheduledItems.length}</p>
                      </div>
                    </div>
                    {dashboard.monthlyPlan.scheduledItems.length > 0 && (
                      <div className="space-y-2">
                        {dashboard.monthlyPlan.scheduledItems.map((item, idx) => (
                          <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                            <div>
                              <p className="font-medium">{item.maintenanceType.replace('_', ' ')}</p>
                              <p className="text-sm text-gray-500">
                                Est. {new Date(item.estimatedDate).toLocaleDateString()}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="font-medium">${item.estimatedCost}</p>
                              {getSeverityBadge(item.priority)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="usage" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card data-testid="card-avg-daily-km">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-blue-500" />
                  Average Daily KM
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{usage.avgDailyKm.toFixed(1)} km/day</p>
                <div className="mt-2">
                  {getIntensityBadge(usage.routeIntensity)}
                </div>
              </CardContent>
            </Card>

            <Card data-testid="card-fleet-comparison">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-green-500" />
                  Fleet Comparison
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-lg">Fleet Average: <span className="font-bold">{usage.fleetAvgDailyKm.toFixed(1)} km/day</span></p>
                <div className="mt-2">
                  {getComparisonBadge(usage.comparedToFleet)}
                </div>
              </CardContent>
            </Card>

            <Card data-testid="card-route-intensity">
              <CardHeader>
                <CardTitle>Route Intensity</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Light</span>
                    <span>Heavy</span>
                  </div>
                  <Progress 
                    value={usage.routeIntensity === 'heavy' ? 100 : usage.routeIntensity === 'medium' ? 60 : 30} 
                    className={`h-3 ${usage.routeIntensity === 'heavy' ? '[&>div]:bg-red-500' : usage.routeIntensity === 'medium' ? '[&>div]:bg-yellow-500' : '[&>div]:bg-green-500'}`}
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="maintenance" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card data-testid="card-last-maintenance">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wrench className="h-5 w-5" />
                  Last Maintenance
                </CardTitle>
              </CardHeader>
              <CardContent>
                {maintenance.lastMaintenanceDate ? (
                  <div className="space-y-2">
                    <p className="text-lg font-semibold">{maintenance.lastMaintenanceType?.replace('_', ' ')}</p>
                    <p className="text-gray-500">
                      <Calendar className="h-4 w-4 inline mr-1" />
                      {new Date(maintenance.lastMaintenanceDate).toLocaleDateString()}
                    </p>
                    <p className="text-gray-500">
                      <Gauge className="h-4 w-4 inline mr-1" />
                      {maintenance.lastMaintenanceKm?.toLocaleString()} km
                    </p>
                  </div>
                ) : (
                  <p className="text-gray-500">No maintenance records yet</p>
                )}
              </CardContent>
            </Card>

            <Card data-testid="card-next-service">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="h-5 w-5" />
                  Next Service
                </CardTitle>
              </CardHeader>
              <CardContent>
                {maintenance.kmToNextService !== null ? (
                  <div className="space-y-2">
                    <p className="text-2xl font-bold text-blue-600">{maintenance.kmToNextService.toLocaleString()} km</p>
                    {maintenance.daysToNextService && (
                      <p className="text-gray-500">~{maintenance.daysToNextService} days</p>
                    )}
                  </div>
                ) : (
                  <p className="text-gray-500">No upcoming services scheduled</p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card data-testid="card-upcoming-maintenance">
            <CardHeader>
              <CardTitle>Upcoming Maintenance</CardTitle>
              <CardDescription>Predicted maintenance based on mileage and time</CardDescription>
            </CardHeader>
            <CardContent>
              {maintenance.upcomingMaintenance.length > 0 ? (
                <div className="space-y-3">
                  {maintenance.upcomingMaintenance.map((item: MaintenanceForecast) => (
                    <div key={item.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg" data-testid={`maintenance-item-${item.id}`}>
                      <div className="flex items-center gap-3">
                        {getStatusIcon(item.status)}
                        <div>
                          <p className="font-medium">{item.maintenanceType.replace('_', ' ')}</p>
                          <p className="text-sm text-gray-500">{item.recommendation}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        {getSeverityBadge(item.severity)}
                        <p className="text-sm text-gray-500 mt-1">{item.remainingKm.toFixed(0)} km remaining</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-center py-4">No upcoming maintenance scheduled</p>
              )}
            </CardContent>
          </Card>

          {maintenance.overdueItems.length > 0 && (
            <Card className="border-red-200 bg-red-50" data-testid="card-overdue-maintenance">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-red-700">
                  <AlertTriangle className="h-5 w-5" />
                  Overdue Maintenance
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {maintenance.overdueItems.map((item: MaintenanceForecast) => (
                    <div key={item.id} className="flex items-center justify-between p-3 bg-red-100 rounded-lg">
                      <div className="flex items-center gap-3">
                        <AlertCircle className="h-5 w-5 text-red-600" />
                        <div>
                          <p className="font-medium text-red-800">{item.maintenanceType.replace('_', ' ')}</p>
                          <p className="text-sm text-red-600">{item.recommendation}</p>
                        </div>
                      </div>
                      <Badge className="bg-red-600 text-white">OVERDUE</Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="recommendations" className="space-y-4">
          <Card data-testid="card-recommendations">
            <CardHeader>
              <CardTitle>System Recommendations</CardTitle>
              <CardDescription>Prioritized maintenance recommendations based on vehicle analysis</CardDescription>
            </CardHeader>
            <CardContent>
              {recommendations.length > 0 ? (
                <div className="space-y-4">
                  {recommendations
                    .sort((a, b) => {
                      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
                      return priorityOrder[a.priority] - priorityOrder[b.priority];
                    })
                    .map((rec) => (
                      <div 
                        key={rec.id} 
                        className={`p-4 rounded-lg border-l-4 ${
                          rec.priority === 'critical' ? 'border-l-red-500 bg-red-50' :
                          rec.priority === 'high' ? 'border-l-orange-500 bg-orange-50' :
                          rec.priority === 'medium' ? 'border-l-yellow-500 bg-yellow-50' :
                          'border-l-green-500 bg-green-50'
                        }`}
                        data-testid={`recommendation-${rec.id}`}
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              {getSeverityBadge(rec.priority)}
                              <span className="font-semibold">{rec.maintenanceType.replace('_', ' ')}</span>
                            </div>
                            <p className="text-sm text-gray-700">{rec.recommendation}</p>
                            <p className="text-xs text-gray-500 mt-1">{rec.reason}</p>
                          </div>
                          <div className="text-right text-sm text-gray-500">
                            {rec.estimatedDueKm && <p>{rec.estimatedDueKm.toLocaleString()} km</p>}
                            {rec.estimatedDueDate && <p>{new Date(rec.estimatedDueDate).toLocaleDateString()}</p>}
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  <CheckCircle className="h-12 w-12 mx-auto mb-2 text-green-500" />
                  <p>No maintenance recommendations at this time</p>
                  <p className="text-sm">Vehicle is in good condition</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="alerts" className="space-y-4">
          <Card data-testid="card-alerts">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bell className="h-5 w-5" />
                Alerts & Notifications
              </CardTitle>
              <CardDescription>Automatic alerts for maintenance thresholds and usage anomalies</CardDescription>
            </CardHeader>
            <CardContent>
              {alerts.length > 0 ? (
                <div className="space-y-3">
                  {alerts.map((alert) => (
                    <div 
                      key={alert.id}
                      className={`p-4 rounded-lg flex items-start gap-3 ${
                        alert.severity === 'critical' ? 'bg-red-100 border border-red-200' :
                        alert.severity === 'warning' ? 'bg-yellow-100 border border-yellow-200' :
                        'bg-blue-100 border border-blue-200'
                      }`}
                      data-testid={`alert-${alert.id}`}
                    >
                      {alert.severity === 'critical' ? (
                        <AlertCircle className="h-5 w-5 text-red-600 mt-0.5" />
                      ) : alert.severity === 'warning' ? (
                        <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
                      ) : (
                        <Bell className="h-5 w-5 text-blue-600 mt-0.5" />
                      )}
                      <div className="flex-1">
                        <p className={`font-medium ${
                          alert.severity === 'critical' ? 'text-red-800' :
                          alert.severity === 'warning' ? 'text-yellow-800' :
                          'text-blue-800'
                        }`}>{alert.title}</p>
                        <p className={`text-sm ${
                          alert.severity === 'critical' ? 'text-red-600' :
                          alert.severity === 'warning' ? 'text-yellow-600' :
                          'text-blue-600'
                        }`}>{alert.message}</p>
                        <p className="text-xs text-gray-500 mt-1">
                          {new Date(alert.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  <CheckCircle className="h-12 w-12 mx-auto mb-2 text-green-500" />
                  <p>No active alerts</p>
                  <p className="text-sm">Vehicle is operating within normal parameters</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

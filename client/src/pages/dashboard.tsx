import { useQuery } from "@tanstack/react-query";
import FileUpload from "@/components/file-upload";
import RepScheduleTable from "@/components/rep-schedule-table";
import OptimizationSettings from "@/components/optimization-settings";
import AnalyticsCharts from "@/components/analytics-charts";
import MLInsights from "@/components/ml-insights";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowUp, Store, Users, CalendarCheck, TrendingUp, Download, Plus, Brain } from "lucide-react";
import type { DashboardMetrics, Rep, Outlet, Schedule } from "@shared/schema";

export default function Dashboard() {
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
              <Button className="bg-primary hover:bg-primary/90">
                <Plus className="mr-2 h-4 w-4" />
                New Optimization
              </Button>
              <Button variant="outline">
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
            </div>
          </div>
        </header>

        {/* Key Metrics Cards */}
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
                    Range: <span className="font-semibold">15-25</span> per rep
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
                  <p className="text-sm font-medium text-gray-600">Route Efficiency</p>
                  <p className="text-3xl font-bold text-gray-900 mt-1">
                    {metrics?.routeEfficiency || 0}%
                  </p>
                  <p className="text-sm text-green-600 mt-2 flex items-center">
                    <ArrowUp className="mr-1 h-3 w-3" />
                    5% improvement
                  </p>
                </div>
                <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
                  <TrendingUp className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main Dashboard Tabs */}
        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="schedules">Schedules</TabsTrigger>
            <TabsTrigger value="ml-insights" className="flex items-center space-x-2">
              <Brain className="h-4 w-4" />
              <span>ML Insights</span>
            </TabsTrigger>
            <TabsTrigger value="optimization">Optimization</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* File Upload & Settings */}
              <div className="space-y-6">
                <FileUpload />
                <OptimizationSettings />
              </div>

              {/* Analytics Charts */}
              <div>
                <AnalyticsCharts />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="schedules">
            <RepScheduleTable />
          </TabsContent>

          <TabsContent value="ml-insights">
            <MLInsights outlets={outlets} reps={reps} schedules={schedules} />
          </TabsContent>

          <TabsContent value="optimization">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <OptimizationSettings />
              <AnalyticsCharts />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
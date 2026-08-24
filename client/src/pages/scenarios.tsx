import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { FlaskConical, Play, Check, Trash2, AlertCircle } from "lucide-react";

interface Kpis {
  outlets: number; activeOutlets: number; coveragePct: number; unscheduledOutlets: number;
  reps: number; dayRoutes: number; medianVisitsPerDay: number; avgVisitsPerDay: number;
  daysInTargetBandPct: number; medianRouteDiameterKm: number; maxRouteDiameterKm: number;
  routesOver15kmPct: number; workloadDeviationPct: number; totalDriveKmPerCycle: number;
  excludedOutlets: number;
}
interface ScenarioSummary {
  id: string; name: string; createdAt: string;
  params: Record<string, any>; kpis: Kpis;
}

// Each KPI with the direction that counts as better, so the winning value in
// every row can be highlighted rather than left for the reader to work out.
const METRICS: { key: keyof Kpis; label: string; better: "high" | "low"; suffix?: string }[] = [
  { key: "coveragePct", label: "Coverage", better: "high", suffix: "%" },
  { key: "unscheduledOutlets", label: "Unscheduled outlets", better: "low" },
  { key: "reps", label: "Reps required", better: "low" },
  { key: "medianVisitsPerDay", label: "Visits/day (median)", better: "high" },
  { key: "daysInTargetBandPct", label: "Days in target band", better: "high", suffix: "%" },
  { key: "medianRouteDiameterKm", label: "Route diameter (median)", better: "low", suffix: " km" },
  { key: "maxRouteDiameterKm", label: "Route diameter (worst)", better: "low", suffix: " km" },
  { key: "routesOver15kmPct", label: "Routes over 15 km", better: "low", suffix: "%" },
  { key: "workloadDeviationPct", label: "Workload deviation", better: "low", suffix: "%" },
  { key: "totalDriveKmPerCycle", label: "Total drive (4 weeks)", better: "low", suffix: " km" },
  { key: "excludedOutlets", label: "Excluded outlets", better: "low" },
];

export default function ScenariosPage() {
  const [name, setName] = useState("");
  const [workingDaysPerWeek, setWorkingDaysPerWeek] = useState(6);
  const [minVisitsPerDay, setMinVisitsPerDay] = useState(20);
  const [maxVisitsPerDay, setMaxVisitsPerDay] = useState(25);
  const [maxZoneRadiusKm, setMaxZoneRadiusKm] = useState(15);
  const [distanceMode, setDistanceMode] = useState<"haversine" | "road">("haversine");
  const [busy, setBusy] = useState(false);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Always refetch on mount: the global query config caches with
  // staleTime Infinity, so a list fetched before the first run (empty) would
  // otherwise stay empty forever - including after optimizations started from
  // the Dashboard, which cannot know to invalidate this page's query.
  const { data: scenarios = [] } = useQuery<ScenarioSummary[]>({
    queryKey: ["/api/scenarios"],
    staleTime: 0,
    refetchOnMount: "always",
  });

  // Run the optimizer with these parameters, then capture the resulting plan
  // and its KPIs as a scenario. The live plan is left showing the last run.
  const runScenario = async () => {
    setBusy(true);
    try {
      const params = { workingDaysPerWeek, minVisitsPerDay, maxVisitsPerDay, maxZoneRadiusKm, distanceMode };
      // The server captures every optimization as a scenario automatically,
      // so running one here is all that is needed. A custom name, if given,
      // is applied to the run it just created.
      const opt = await apiRequest("POST", "/api/optimize", { ...params, weightMode: "isolation" });
      if (!opt.ok) throw new Error((await opt.json()).message || "Optimization failed");
      const { capturedScenarioId } = await opt.json();
      if (name && capturedScenarioId) {
        await apiRequest("PATCH", `/api/scenarios/${capturedScenarioId}`, { name });
      }
      setName("");
      queryClient.invalidateQueries({ queryKey: ["/api/scenarios"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/schedules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/outlets"] });
      toast({ title: "Scenario captured", description: "Compare it against the others below." });
    } catch (e) {
      toast({ title: "Scenario failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const applyMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/scenarios/${id}/apply`, {});
      if (!res.ok) throw new Error((await res.json()).message || "Apply failed");
      return res.json();
    },
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: ["/api/reps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/schedules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/outlets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      toast({ title: "Plan applied", description: `"${d.applied}" is now the live plan.` });
    },
    onError: (e: Error) => toast({ title: "Apply failed", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/scenarios/${id}`); },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/scenarios"] }),
  });

  // Winning value per metric, for highlighting
  const best = (key: keyof Kpis, better: "high" | "low") => {
    if (scenarios.length === 0) return null;
    const vals = scenarios.map(s => s.kpis?.[key]).filter(v => typeof v === "number") as number[];
    if (vals.length === 0) return null;
    return better === "high" ? Math.max(...vals) : Math.min(...vals);
  };

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FlaskConical className="h-6 w-6" /> Scenarios
          </h1>
          <p className="text-gray-500 mt-1">
            Run the same outlet data under different parameters, compare the plans on real quality metrics, then apply the one you want.
          </p>
        </header>

        <Card className="mb-6">
          <CardHeader className="pb-3"><CardTitle className="text-base">Run a scenario</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
              <div className="col-span-2">
                <Label htmlFor="sc-name">Name (optional)</Label>
                <Input id="sc-name" value={name} onChange={e => setName(e.target.value)}
                  placeholder="e.g. 5 days, tight routes" className="mt-1" data-testid="input-scenario-name" />
              </div>
              <div>
                <Label htmlFor="sc-days">Days/week</Label>
                <Select value={String(workingDaysPerWeek)} onValueChange={v => setWorkingDaysPerWeek(parseInt(v))}>
                  <SelectTrigger id="sc-days" className="mt-1" data-testid="select-scenario-days"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">5</SelectItem>
                    <SelectItem value="6">6</SelectItem>
                    <SelectItem value="7">7</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="sc-min">Min/day</Label>
                <Input id="sc-min" type="number" min="1" max="60" value={minVisitsPerDay}
                  onChange={e => setMinVisitsPerDay(parseInt(e.target.value) || 20)} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="sc-max">Max/day</Label>
                <Input id="sc-max" type="number" min="2" max="60" value={maxVisitsPerDay}
                  onChange={e => setMaxVisitsPerDay(parseInt(e.target.value) || 25)} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="sc-radius">Compactness</Label>
                <Select value={String(maxZoneRadiusKm)} onValueChange={v => setMaxZoneRadiusKm(parseInt(v))}>
                  <SelectTrigger id="sc-radius" className="mt-1" data-testid="select-scenario-radius"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">5 km</SelectItem>
                    <SelectItem value="10">10 km</SelectItem>
                    <SelectItem value="15">15 km</SelectItem>
                    <SelectItem value="25">25 km</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center gap-3 mt-4">
              <Select value={distanceMode} onValueChange={v => setDistanceMode(v as "haversine" | "road")}>
                <SelectTrigger className="w-64" data-testid="select-scenario-distance"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="haversine">Straight-line distance</SelectItem>
                  <SelectItem value="road">Road-aware distance</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={runScenario} disabled={busy || minVisitsPerDay >= maxVisitsPerDay} data-testid="button-run-scenario">
                {busy ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" /> : <Play className="h-4 w-4 mr-2" />}
                {busy ? "Running…" : "Run & capture"}
              </Button>
              {minVisitsPerDay >= maxVisitsPerDay && (
                <span className="text-sm text-red-600">Min must be below max.</span>
              )}
            </div>
          </CardContent>
        </Card>

        {scenarios.length === 0 ? (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              No scenarios yet. Run two or three with different settings — for example 6 days vs 5 days, or 15 km vs 10 km compactness — and the trade-offs become visible side by side.
            </AlertDescription>
          </Alert>
        ) : (
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">Comparison</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr>
                    <th className="text-left py-2 pr-4 font-medium text-gray-600 sticky left-0 bg-white dark:bg-transparent">Metric</th>
                    {scenarios.map(s => (
                      <th key={s.id} className="text-left py-2 px-3 font-semibold min-w-[150px] align-bottom">
                        <div className="truncate" title={s.name}>{s.name}</div>
                        <div className="text-xs font-normal text-gray-500">
                          {s.params?.workingDaysPerWeek}d · {s.params?.minVisitsPerDay}-{s.params?.maxVisitsPerDay}/day · {s.params?.maxZoneRadiusKm}km
                          {s.params?.distanceMode === "road" ? " · road" : ""}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {METRICS.map(m => {
                    const b = best(m.key, m.better);
                    return (
                      <tr key={m.key} className="border-t">
                        <td className="py-2 pr-4 text-gray-600 sticky left-0 bg-white dark:bg-transparent">{m.label}</td>
                        {scenarios.map(s => {
                          const v = s.kpis?.[m.key];
                          const isBest = typeof v === "number" && v === b && scenarios.length > 1;
                          return (
                            <td key={s.id} className={`py-2 px-3 tabular-nums ${isBest ? "font-semibold text-green-700 dark:text-green-400" : ""}`}>
                              {typeof v === "number" ? `${v}${m.suffix || ""}` : "—"}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  <tr className="border-t">
                    <td className="py-3 pr-4 sticky left-0 bg-white dark:bg-transparent"></td>
                    {scenarios.map(s => (
                      <td key={s.id} className="py-3 px-3">
                        <div className="flex gap-1">
                          <Button size="sm" variant="outline"
                            onClick={() => applyMutation.mutate(s.id)}
                            disabled={applyMutation.isPending}
                            data-testid={`button-apply-${s.id}`}>
                            <Check className="h-3 w-3 mr-1" /> Apply
                          </Button>
                          <Button size="sm" variant="ghost" className="px-2"
                            onClick={() => deleteMutation.mutate(s.id)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
              <p className="text-xs text-gray-500 mt-3">
                Best value in each row is highlighted. "Apply" restores that plan — its rep assignments and schedules — as the live plan across the app.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

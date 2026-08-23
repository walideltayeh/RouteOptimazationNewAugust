import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { CalendarDays, ArrowRightLeft, AlertCircle } from "lucide-react";
import type { Rep, Outlet, Schedule } from "@shared/schema";

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

interface ReassignResult {
  movedOutlets: number;
  toRep: { id: string; name: string };
  repsReworked: { repId: string; name: string; outlets: number; monthlyVisits: number; overCapacity: boolean }[];
  warnings: string[];
  suggestedCascade: {
    outletId: string; outletName: string; monthlyVisits: number;
    fromRep: string; toRepId: string; toRepName: string; distanceKm: number;
  }[];
}

export default function SchedulesPage() {
  const [selectedRepId, setSelectedRepId] = useState<string>("");
  const [selectedOutlets, setSelectedOutlets] = useState<Set<string>>(new Set());
  const [targetRepId, setTargetRepId] = useState<string>("");
  const [lastResult, setLastResult] = useState<ReassignResult | null>(null);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: reps = [] } = useQuery<Rep[]>({ queryKey: ["/api/reps"] });
  const { data: outlets = [] } = useQuery<Outlet[]>({ queryKey: ["/api/outlets"] });
  const { data: schedules = [] } = useQuery<Schedule[]>({ queryKey: ["/api/schedules"] });

  const repId = selectedRepId || reps[0]?.id || "";
  const rep = reps.find(r => r.id === repId);

  const outletById = useMemo(() => {
    const m = new Map<string, Outlet>();
    outlets.forEach(o => m.set(o.id, o));
    return m;
  }, [outlets]);

  // The selected rep's plan: dayOfWeek -> outletId -> weeks visited
  const plan = useMemo(() => {
    const days = new Map<number, Map<string, number[]>>();
    for (const s of schedules) {
      if (s.repId !== repId) continue;
      if (!days.has(s.dayOfWeek)) days.set(s.dayOfWeek, new Map());
      const day = days.get(s.dayOfWeek)!;
      for (const id of (s.outletIds as string[])) {
        if (!day.has(id)) day.set(id, []);
        day.get(id)!.push(s.week);
      }
    }
    return new Map(Array.from(days.entries()).sort((a, b) => a[0] - b[0]));
  }, [schedules, repId]);

  const repStats = useMemo(() => {
    const owned = outlets.filter(o => o.repId === repId && o.territory !== "Excluded");
    const monthlyVisits = owned.reduce((s, o) => s + (o.visitFrequency ?? 1), 0);
    const capacity = rep ? (rep.workingDaysPerWeek || 5) * 4 * (rep.maxDailyVisits || 25) : 0;
    return { outlets: owned.length, monthlyVisits, capacity };
  }, [outlets, repId, rep]);

  const reassignMutation = useMutation({
    mutationFn: async (payload: { outletIds: string[]; toRepId: string }) => {
      const res = await apiRequest("POST", "/api/reps/reassign-outlets", payload);
      if (!res.ok) throw new Error((await res.json()).message || "Reassignment failed");
      return res.json() as Promise<ReassignResult>;
    },
    onSuccess: (data) => {
      setLastResult(data);
      setSelectedOutlets(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/outlets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/schedules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/metrics"] });
      toast({ title: "Outlets moved", description: data.warnings.length > 0 ? data.warnings.join(" ") : `Schedules reworked for ${data.repsReworked.length} rep(s).` });
    },
    onError: (e: Error) => toast({ title: "Reassignment failed", description: e.message, variant: "destructive" }),
  });

  const toggleOutlet = (id: string) => {
    setSelectedOutlets(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleMove = () => {
    if (selectedOutlets.size === 0 || !targetRepId || targetRepId === repId) return;
    reassignMutation.mutate({ outletIds: Array.from(selectedOutlets), toRepId: targetRepId });
  };

  const applyCascade = (toRepId: string, outletIds: string[]) => {
    reassignMutation.mutate({ outletIds, toRepId });
  };

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarDays className="h-6 w-6" /> Schedules
          </h1>
          <p className="text-gray-500 mt-1">Review each rep's weekly plan and move outlets between reps — schedules rework automatically.</p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-gray-600">Rep</CardTitle></CardHeader>
            <CardContent>
              <Select value={repId} onValueChange={(v) => { setSelectedRepId(v); setSelectedOutlets(new Set()); }}>
                <SelectTrigger data-testid="select-schedule-rep"><SelectValue placeholder="Select a rep" /></SelectTrigger>
                <SelectContent>
                  {reps.map(r => <SelectItem key={r.id} value={r.id}>{r.name} ({r.code})</SelectItem>)}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-gray-600">Workload</CardTitle></CardHeader>
            <CardContent className="text-sm space-y-1">
              <div><span className="font-semibold">{repStats.outlets}</span> outlets · <span className="font-semibold">{repStats.monthlyVisits}</span> visits/month</div>
              <div className="text-gray-500">Capacity {repStats.capacity} visits/month
                {repStats.capacity > 0 && (
                  <span className={repStats.monthlyVisits > repStats.capacity ? " text-red-600 font-semibold" : " text-green-600"}>
                    {" "}({Math.round((repStats.monthlyVisits / repStats.capacity) * 100)}% used)
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-gray-600">Move selected outlets</CardTitle></CardHeader>
            <CardContent className="flex gap-2 items-center">
              <Select value={targetRepId} onValueChange={setTargetRepId}>
                <SelectTrigger className="flex-1" data-testid="select-target-rep"><SelectValue placeholder="Target rep" /></SelectTrigger>
                <SelectContent>
                  {reps.filter(r => r.id !== repId).map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button
                onClick={handleMove}
                disabled={selectedOutlets.size === 0 || !targetRepId || reassignMutation.isPending}
                data-testid="button-move-outlets"
              >
                <ArrowRightLeft className="h-4 w-4 mr-1" />
                Move {selectedOutlets.size > 0 ? selectedOutlets.size : ""}
              </Button>
            </CardContent>
          </Card>
        </div>

        {lastResult && lastResult.warnings.length > 0 && (
          <Alert className="mb-4 border-amber-200 bg-amber-50">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-800">
              <div className="font-semibold mb-1">{lastResult.warnings.join(" ")}</div>
              {lastResult.suggestedCascade.length > 0 && (
                <div className="space-y-1">
                  <div>Suggested moves to restore capacity:</div>
                  {Object.entries(
                    lastResult.suggestedCascade.reduce<Record<string, { name: string; ids: string[]; count: number }>>((acc, c) => {
                      if (!acc[c.toRepId]) acc[c.toRepId] = { name: c.toRepName, ids: [], count: 0 };
                      acc[c.toRepId].ids.push(c.outletId);
                      acc[c.toRepId].count++;
                      return acc;
                    }, {})
                  ).map(([toId, g]) => (
                    <Button key={toId} size="sm" variant="outline" className="mr-2 border-amber-400 text-amber-900"
                      disabled={reassignMutation.isPending}
                      onClick={() => applyCascade(toId, g.ids)}>
                      Move {g.count} outlet{g.count === 1 ? "" : "s"} → {g.name}
                    </Button>
                  ))}
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}

        {plan.size === 0 ? (
          <Card><CardContent className="p-8 text-center text-gray-500">No schedules for this rep yet — run an optimization first.</CardContent></Card>
        ) : (
          <div className="space-y-4">
            {Array.from(plan.entries()).map(([day, outletWeeks]) => {
              const ids = Array.from(outletWeeks.keys());
              return (
                <Card key={day}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center justify-between">
                      <span>{DAY_NAMES[day] || `Day ${day}`}</span>
                      <span className="text-sm font-normal text-gray-500">{ids.length} outlets in rotation</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-1">
                      {ids.map(id => {
                        const o = outletById.get(id);
                        if (!o) return null;
                        const weeks = outletWeeks.get(id) || [];
                        return (
                          <label key={id} className="flex items-center gap-2 text-sm py-1 px-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedOutlets.has(id)}
                              onChange={() => toggleOutlet(id)}
                              data-testid={`checkbox-outlet-${id}`}
                            />
                            <span className="flex-1 truncate" title={o.name}>{o.name}</span>
                            <Badge variant="outline" className="text-xs shrink-0">VF{o.visitFrequency}</Badge>
                            <span className="text-xs text-gray-400 shrink-0">wk {weeks.slice().sort((a: number, b: number) => a - b).join(",")}</span>
                          </label>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

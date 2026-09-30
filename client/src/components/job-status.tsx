import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Job } from "@/lib/jobs";

const PLAN_QUERIES = ["/api/outlets", "/api/reps", "/api/schedules", "/api/plan-settings", "/api/scenarios",
  "/api/dashboard/metrics", "/api/outlets/duplicates", "/api/outlets/excluded", "/api/reps/misfit-outlets",
  "/api/role-hierarchies", "/api/role-schedules"];

/**
 * The running optimization, wherever the user is. Polls the active job;
 * when it finishes every plan query is refreshed and a toast says so, so a
 * run started on the dashboard can be watched from the map and lands there.
 */
export default function JobStatus() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const lastSeen = useRef<Job | null>(null);

  const { data: active } = useQuery<Job | null>({
    queryKey: ["/api/jobs/active"],
    queryFn: async () => {
      const res = await fetch("/api/jobs/active", { credentials: "include" });
      return res.ok ? res.json() : null;
    },
    refetchInterval: (q) => (q.state.data ? 1000 : 4000),
    staleTime: 0,
    retry: false,
  });

  // A job we watched has gone from the active slot: fetch its outcome.
  useEffect(() => {
    if (active) { lastSeen.current = active; return; }
    const prev = lastSeen.current;
    if (!prev) return;
    lastSeen.current = null;
    (async () => {
      try {
        const res = await fetch(`/api/jobs/${prev.id}`, { credentials: "include" });
        const job: Job = res.ok ? await res.json() : { ...prev, status: "done" };
        PLAN_QUERIES.forEach(k => queryClient.invalidateQueries({ queryKey: [k] }));
        if (job.status === "failed") {
          toast({ title: prev.kind === "optimize" ? "Optimization failed" : "Rebuild failed", description: job.error || "See the server log.", variant: "destructive" });
        } else {
          toast({ title: prev.kind === "optimize" ? "New plan ready" : "Routes rebuilt", description: job.progress?.detail || "Every page now shows the new plan." });
        }
      } catch { /* the pages refetch on their own */ }
    })();
  }, [active, queryClient, toast]);

  if (!active) return null;
  const pct = Math.max(0, Math.min(100, Math.round(active.progress?.percent ?? 0)));
  const label = active.kind === "optimize" ? "Optimizing" : "Rebuilding routes";
  return (
    <div className="flex items-center gap-2 rounded-full border border-[#e5e5e5] bg-white px-3 py-1 text-xs text-[#1d1d1f] shadow-sm dark:border-[#38383a] dark:bg-[#2c2c2e] dark:text-white" data-testid="job-status" title={active.progress?.detail || ""}>
      {active.status === "failed" ? <XCircle className="h-3.5 w-3.5 text-red-500" /> : active.status === "done" ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600" /> : <Loader2 className="h-3.5 w-3.5 animate-spin text-[#8B0000]" />}
      <span className="font-medium">{label}</span>
      <span className="text-[#86868b]">{pct}%{active.progress?.stage ? ` · ${active.progress.stage}` : ""}</span>
      <span className="ml-1 hidden h-1.5 w-24 overflow-hidden rounded-full bg-[#e8e8ed] sm:block dark:bg-[#3a3a3c]">
        <span className="block h-full bg-[#8B0000] transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

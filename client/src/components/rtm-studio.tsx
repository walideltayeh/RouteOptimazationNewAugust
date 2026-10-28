import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { runJob, type JobProgress } from "@/lib/jobs";
import {
  CloudUpload, Check, CheckCircle2, AlertTriangle, XCircle, Sparkles, MapPinned, Download, RotateCcw,
  Users, Store, CalendarDays, Route, Clock, Layers, Scale, ChevronDown, ChevronUp, Loader2, Map as MapIcon,
} from "lucide-react";

// ---- shapes of the server's blueprint and scorecard (server/blueprint.ts, server/scorecard.ts)
type Status = "pass" | "warn" | "fail";
interface Check { id: string; status: Status; title: string; detail?: string }
interface HeadcountOption { reps: number; visitsPerDay: number; fits: boolean }
interface Blueprint {
  market: { outlets: number; active: number; heldForReview: number; country: string | null; radiusKm: number; neighbourKm: number; character: string };
  frequency: { vf1: number; vf2: number; vf3: number; vf4: number; monthlyVisits: number; assumedRows: number };
  channels: { key: string; label: string; count: number; callMinutes: number }[];
  call: { avgMinutes: number; source: string };
  workload: { callMinutes: number; travelMinutesPerCall: number; sustainableCallsPerDay: number; dayHoursAtBand: number; shiftHours: number };
  setup: {
    workingDays: number[]; weekLabel: string; weekSource: string; cycleWorkingDays: number; cycleMode: "fixed" | "calendarMonth";
    minVisitsPerDay: number; maxVisitsPerDay: number; bandSource: string; maxHopKm: number;
    distanceMode: "road" | "haversine"; balanceBy: "visits" | "time"; balanceReason: string;
  };
  headcount: HeadcountOption & { options: HeadcountOption[]; reason: string };
  checks: Check[];
}
interface RepScore {
  repId: string; name: string; outlets: number; monthlyVisits: number;
  visitsPerDay: { min: number; avg: number; max: number };
  kmPerMonth: number; kmPerDay: number; hoursPerDay: number; maxHoursPerDay: number; longHops: number; overlapPct: number;
}
interface Scorecard {
  grade: "A" | "B" | "C" | "D"; score: number; headline: string;
  kpis: {
    reps: number; dayRoutes: number; outlets: number; planned: number; heldForReview: number; unplanned: number; coveragePct: number;
    visitsPerDay: { min: number; avg: number; max: number }; daysInBandPct: number; kmPerDay: number; kmPerMonth: number;
    drivingHoursPerDay: number; callHoursPerDay: number; workdayHours: number; maxWorkdayHours: number; overloadedDays: number; shiftHours: number;
    routeOverlapPct: number; territoryOverlapPct: number; repBalancePct: number; longHops: number; longestHopKm: number;
    kmBasis: string; evenDaysPct: number; balanceBy: "visits" | "time";
  };
  checks: Check[];
  perRep: RepScore[];
}

const WEEK = [
  { iso: 6, short: "Sat" }, { iso: 7, short: "Sun" }, { iso: 1, short: "Mon" }, { iso: 2, short: "Tue" },
  { iso: 3, short: "Wed" }, { iso: 4, short: "Thu" }, { iso: 5, short: "Fri" },
];
const fmt = (n: number) => n.toLocaleString("en-US");
const GRADE_STYLE: Record<Scorecard["grade"], string> = {
  A: "from-emerald-500 to-emerald-700 shadow-[0_10px_24px_-10px_rgba(5,150,105,0.7)]",
  B: "from-lime-500 to-green-700 shadow-[0_10px_24px_-10px_rgba(77,124,15,0.7)]",
  C: "from-amber-400 to-orange-600 shadow-[0_10px_24px_-10px_rgba(217,119,6,0.7)]",
  D: "from-rose-500 to-red-700 shadow-[0_10px_24px_-10px_rgba(220,38,38,0.7)]",
};

function StatusIcon({ s }: { s: Status }) {
  if (s === "pass") return <CheckCircle2 className="mt-px h-4 w-4 shrink-0 text-success" aria-label="OK" />;
  if (s === "warn") return <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-warning" aria-label="Review" />;
  return <XCircle className="mt-px h-4 w-4 shrink-0 text-destructive" aria-label="Problem" />;
}

function CheckList({ checks, testid }: { checks: Check[]; testid: string }) {
  return (
    <ul className="divide-y rounded-xl border bg-card" data-testid={testid}>
      {checks.map(c => (
        <li key={c.id} className="flex gap-2.5 px-3.5 py-2.5 text-sm">
          <StatusIcon s={c.status} />
          <div className="min-w-0">
            <p className="leading-snug text-foreground">{c.title}</p>
            {c.detail && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{c.detail}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Tile({ icon: Icon, label, value, sub, testid }: { icon: typeof Users; label: string; value: string; sub?: string; testid?: string }) {
  return (
    <div className="rounded-xl border bg-card p-3.5 shadow-xs" data-testid={testid}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Icon className="h-3.5 w-3.5" />{label}</div>
      <div className="mt-2 text-[22px] font-semibold leading-none tracking-tight tabular-nums text-foreground">{value}</div>
      {sub && <div className="mt-1.5 text-xs leading-snug text-muted-foreground">{sub}</div>}
    </div>
  );
}

function StepDot({ n, label, state }: { n: number; label: string; state: "done" | "active" | "todo" }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
        state === "done" ? "bg-success text-white" : state === "active" ? "bg-primary text-white ring-4 ring-primary/15" : "bg-muted text-muted-foreground ring-1 ring-inset ring-border"}`}>
        {state === "done" ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : n}
      </span>
      <span className={`text-sm ${state === "todo" ? "text-muted-foreground" : "font-medium text-foreground"}`}>{label}</span>
    </div>
  );
}

async function downloadFile(url: string, fallbackName: string) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Download failed");
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") || "";
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] || fallbackName;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

/**
 * RTM Studio: the plan in two clicks. Drop the outlet list (click one) and
 * the blueprint appears - what the data says, what to fix, and the setup the
 * planner would choose. Build my RTM (click two) runs the whole engine and
 * returns a graded plan with its findings and the journey plan to download.
 */
export default function RtmStudio({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<{ pct: number; stage: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [building, setBuilding] = useState<JobProgress | null>(null);
  const [replan, setReplan] = useState(false);
  const [showReps, setShowReps] = useState(false);
  // The planner's edits to the blueprint, applied as overrides on Build.
  const [edits, setEdits] = useState<Partial<{ reps: number; workingDays: number[]; minVisitsPerDay: number; maxVisitsPerDay: number; balanceBy: "visits" | "time"; maxHopKm: number }>>({});

  const { data: outlets = [] } = useQuery<{ id: string }[]>({ queryKey: ["/api/outlets"] });
  const { data: schedules = [] } = useQuery<{ id: string }[]>({ queryKey: ["/api/schedules"] });
  const hasOutlets = outlets.length > 0;
  const hasPlan = schedules.length > 0;
  // The blueprint is recomputed with the planner's edits (all but the team
  // size, which is chosen from what it offers), a moment after they stop typing.
  const choiceQs = useMemo(() => {
    const q = new URLSearchParams();
    if (edits.workingDays) q.set("days", edits.workingDays.join(","));
    if (edits.minVisitsPerDay || edits.maxVisitsPerDay) {
      q.set("min", String(edits.minVisitsPerDay ?? "")); q.set("max", String(edits.maxVisitsPerDay ?? ""));
    }
    if (edits.balanceBy) q.set("balanceBy", edits.balanceBy);
    if (edits.maxHopKm) q.set("hop", String(edits.maxHopKm));
    return q.toString();
  }, [edits.workingDays, edits.minVisitsPerDay, edits.maxVisitsPerDay, edits.balanceBy, edits.maxHopKm]);
  const [debouncedQs, setDebouncedQs] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebouncedQs(choiceQs), 400); return () => clearTimeout(t); }, [choiceQs]);
  const { data: blueprint, isFetching: bpLoading } = useQuery<Blueprint>({
    queryKey: ["/api/rtm/blueprint", debouncedQs],
    queryFn: async () => {
      const res = await fetch(`/api/rtm/blueprint${debouncedQs ? `?${debouncedQs}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Could not read the outlets");
      return res.json();
    },
    enabled: hasOutlets, staleTime: 0, placeholderData: keepPreviousData,
  });
  const { data: scorecard } = useQuery<Scorecard>({ queryKey: ["/api/plan/scorecard"], enabled: hasPlan, staleTime: 0 });

  const setup = useMemo(() => blueprint ? {
    reps: edits.reps ?? blueprint.headcount.reps,
    workingDays: edits.workingDays ?? blueprint.setup.workingDays,
    minVisitsPerDay: edits.minVisitsPerDay ?? blueprint.setup.minVisitsPerDay,
    maxVisitsPerDay: edits.maxVisitsPerDay ?? blueprint.setup.maxVisitsPerDay,
    balanceBy: edits.balanceBy ?? blueprint.setup.balanceBy,
    maxHopKm: edits.maxHopKm ?? blueprint.setup.maxHopKm,
  } : null, [blueprint, edits]);

  const refreshAll = () => {
    for (const key of ["/api/outlets", "/api/schedules", "/api/reps", "/api/dashboard/metrics", "/api/analysis", "/api/rtm/blueprint",
      "/api/plan/scorecard", "/api/plan/kpis", "/api/scenarios", "/api/outlets/excluded", "/api/outlets/duplicates", "/api/role-hierarchies", "/api/role-schedules"]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };

  // ---- click one: upload
  const upload = (file: File) => {
    if (!canEdit) return;
    const form = new FormData();
    form.append("file", file);
    setUploading({ pct: 0, stage: "Uploading" });
    const xhr = new XMLHttpRequest();
    xhr.withCredentials = true;
    xhr.upload.onprogress = e => { if (e.lengthComputable) setUploading({ pct: Math.round((e.loaded / e.total) * 100), stage: "Uploading" }); };
    xhr.upload.onloadend = () => setUploading({ pct: 100, stage: "Reading outlets and checking the data" });
    xhr.onload = () => {
      setUploading(null);
      let data: any = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status >= 400 || !data?.success) {
        toast({ title: "Upload failed", description: data?.message || "The file could not be read.", variant: "destructive" });
        return;
      }
      setReplan(true);
      setEdits({});
      refreshAll();
      toast({ title: `${fmt(data.analysis?.outlets ?? 0)} outlets loaded`, description: "Your RTM blueprint is ready below." });
    };
    xhr.onerror = () => { setUploading(null); toast({ title: "Upload failed", description: "Network error.", variant: "destructive" }); };
    xhr.open("POST", "/api/upload");
    xhr.send(form);
  };

  // ---- click two: build
  const build = async () => {
    if (!blueprint || !setup) return;
    setBuilding({ percent: 0, stage: "Starting", detail: "" });
    // Everything on screen, the team size included: the blueprint the planner
    // is looking at already carries their edits.
    const overrides: Record<string, unknown> = {
      workingDays: setup.workingDays, workingDaysPerWeek: setup.workingDays.length,
      minVisitsPerDay: Math.min(setup.minVisitsPerDay, setup.maxVisitsPerDay), maxVisitsPerDay: Math.max(setup.minVisitsPerDay, setup.maxVisitsPerDay),
      balanceBy: setup.balanceBy, maxHopKm: setup.maxHopKm, reps: setup.reps,
      cycleMode: blueprint.setup.cycleMode, cycleWorkingDays: blueprint.setup.cycleWorkingDays,
    };
    try {
      const result: any = await runJob("/api/rtm/autopilot", { overrides }, p => setBuilding(p));
      if (result && (result.success === false || result.message?.startsWith?.("Failed"))) throw new Error(result.message);
      setReplan(false);
      refreshAll();
      const sc = result?.scorecard as Scorecard | undefined;
      toast({ title: sc ? `RTM built: grade ${sc.grade}` : "RTM built", description: sc?.headline });
    } catch (err) {
      toast({ title: "The plan could not be built", description: (err as Error).message, variant: "destructive" });
    } finally {
      setBuilding(null);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) upload(f);
  };

  const showBlueprint = hasOutlets && (!hasPlan || replan) && !building;
  const showResult = hasPlan && !replan && !building && !!scorecard;
  const stage = !hasOutlets ? 1 : !hasPlan || replan ? 2 : 3;

  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-apple" data-testid="rtm-studio">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-gradient-to-r from-primary/[0.04] via-transparent to-transparent px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[hsl(var(--brand-from))] to-[hsl(var(--brand-to))] shadow-[0_6px_16px_-6px_hsl(var(--primary)/0.6)]"><Sparkles className="h-5 w-5 text-white" /></div>
          <div>
            <h2 className="text-[17px] font-semibold tracking-tight text-foreground">RTM Studio</h2>
            <p className="text-sm text-muted-foreground">Your route-to-market plan in two clicks: drop the outlet list, then build.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <StepDot n={1} label="Upload" state={stage > 1 ? "done" : "active"} />
          <span className={`hidden h-px w-6 sm:block ${stage > 1 ? "bg-success/50" : "bg-border"}`} aria-hidden />
          <StepDot n={2} label="Build" state={stage > 2 ? "done" : stage === 2 ? "active" : "todo"} />
          <span className={`hidden h-px w-6 sm:block ${stage > 2 ? "bg-success/50" : "bg-border"}`} aria-hidden />
          <StepDot n={3} label="Roll out" state={stage === 3 ? "active" : "todo"} />
        </div>
      </div>

      <div className="p-5">
        {/* ---------- empty: drop zone ---------- */}
        {!hasOutlets && (
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => canEdit && !uploading && fileInput.current?.click()}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-14 text-center transition ${
              dragOver ? "border-primary bg-primary/5" : "border-input bg-muted/40 hover:border-primary/50 hover:bg-primary/[0.03]"}`}
            data-testid="rtm-dropzone"
          >
            {uploading ? (
              <div className="w-full max-w-sm">
                <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-primary" />
                <p className="text-sm font-medium">{uploading.stage}…</p>
                <Progress value={uploading.pct} className="mt-3" />
              </div>
            ) : (
              <>
                <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border bg-card shadow-apple-md">
                  <CloudUpload className="h-6 w-6 text-primary" />
                </span>
                <p className="text-base font-semibold text-foreground">Drop your outlet list here</p>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  CSV or Excel with outlet name, latitude and longitude. Visit frequency, channel and call time are used when the file has them.
                </p>
                {canEdit ? <Button variant="brand" className="mt-5" data-testid="rtm-choose-file">Choose file</Button>
                  : <p className="mt-3 text-xs text-muted-foreground">Your account can view plans but not upload.</p>}
              </>
            )}
          </div>
        )}
        <input ref={fileInput} type="file" accept=".csv,.xlsx,.xls" className="hidden" data-testid="rtm-file-input"
          onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />

        {/* ---------- building ---------- */}
        {building && (
          <div className="mx-auto max-w-xl py-10 text-center" data-testid="rtm-building">
            <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-primary" />
            <p className="text-base font-semibold">Building your RTM</p>
            <p className="mt-1 text-sm text-muted-foreground">{building.stage}{building.detail ? ` · ${building.detail}` : ""}</p>
            <Progress value={building.percent} className="mt-4" />
            <p className="mt-3 text-xs text-muted-foreground">Territories, days, weeks and the driving order of every route. Large universes take a few minutes.</p>
          </div>
        )}

        {/* ---------- blueprint ---------- */}
        {showBlueprint && (
          !blueprint ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Reading your outlets…</div>
          ) : (
            <div className="grid gap-5 lg:grid-cols-5" data-testid="rtm-blueprint">
              <div className="space-y-4 lg:col-span-2">
                <div>
                  <p className="eyebrow">Your market</p>
                  <p className="mt-1.5 text-[15px] leading-relaxed text-foreground" data-testid="rtm-market">
                    <strong>{fmt(blueprint.market.active)} outlets</strong>
                    {blueprint.market.country ? ` in ${blueprint.market.country}` : ""}, a {blueprint.market.character} market
                    {` reaching about ${Math.round(blueprint.market.radiusKm)} km from its centre`}. {fmt(blueprint.frequency.monthlyVisits)} visits a month.
                  </p>
                  {blueprint.channels.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {blueprint.channels.slice(0, 6).map(c => (
                        <span key={c.key} className="rounded-md border bg-card px-2 py-0.5 text-xs text-foreground shadow-xs">
                          {c.label} {fmt(c.count)} · {c.callMinutes} min
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <p className="eyebrow mb-2">Data checks</p>
                  <CheckList checks={blueprint.checks} testid="rtm-blueprint-checks" />
                </div>
              </div>

              <div className="space-y-4 lg:col-span-3">
                <p className="eyebrow">Recommended setup <span className="font-normal normal-case tracking-normal">· change anything before you build</span></p>

                {/* team size */}
                <div className="rounded-xl border bg-card p-3.5 shadow-xs">
                  <div className="flex items-center gap-2 text-sm font-medium"><Users className="h-4 w-4 text-muted-foreground" /> Team size</div>
                  <div className="mt-2 flex flex-wrap gap-2" data-testid="rtm-headcount-options">
                    {blueprint.headcount.options.map(o => (
                      <button key={o.reps} type="button" onClick={() => setEdits(e => ({ ...e, reps: o.reps }))}
                        className={`rounded-lg border px-3 py-1.5 text-left text-sm transition ${setup!.reps === o.reps ? "border-primary bg-primary/[0.06] font-semibold text-foreground ring-2 ring-primary/15" : "border-border bg-card hover:border-input hover:bg-muted/50"}`}
                        data-testid={`rtm-reps-${o.reps}`}>
                        {o.reps} rep{o.reps === 1 ? "" : "s"}
                        <span className="block text-xs font-normal text-muted-foreground">{o.visitsPerDay} visits a day{o.reps === blueprint.headcount.reps ? " · recommended" : ""}</span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{blueprint.headcount.reason}</p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {/* working week */}
                  <div className="rounded-xl border bg-card p-3.5 shadow-xs">
                    <div className="flex items-center gap-2 text-sm font-medium"><CalendarDays className="h-4 w-4 text-muted-foreground" /> Working week</div>
                    <div className="mt-2 flex flex-wrap gap-1" data-testid="rtm-week">
                      {WEEK.map(d => {
                        const on = setup!.workingDays.includes(d.iso);
                        return (
                          <button key={d.iso} type="button"
                            onClick={() => setEdits(e => {
                              const cur = e.workingDays ?? blueprint.setup.workingDays;
                              const next = on ? cur.filter(x => x !== d.iso) : [...cur, d.iso];
                              const ordered = WEEK.map(w => w.iso).filter(x => next.includes(x));
                              return ordered.length ? { ...e, workingDays: ordered } : e;
                            })}
                            className={`h-7 w-9 rounded-md text-xs font-medium ${on ? "bg-foreground text-card shadow-xs" : "bg-muted text-muted-foreground hover:text-foreground"}`}>
                            {d.short}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{blueprint.setup.weekLabel}, {blueprint.setup.weekSource}.</p>
                  </div>

                  {/* visits band */}
                  <div className="rounded-xl border bg-card p-3.5 shadow-xs">
                    <div className="flex items-center gap-2 text-sm font-medium"><Store className="h-4 w-4 text-muted-foreground" /> Visits a day</div>
                    <div className="mt-2 flex items-center gap-2 text-sm">
                      <input type="number" min={1} max={80} value={setup!.minVisitsPerDay} aria-label="Minimum visits a day"
                        onChange={e => setEdits(x => ({ ...x, minVisitsPerDay: Math.max(1, Number(e.target.value) || 1) }))}
                        className="h-9 w-16 rounded-lg border border-input bg-card px-2.5 tabular-nums shadow-xs focus:border-primary/60 focus:outline-none focus:ring-4 focus:ring-primary/10" data-testid="rtm-min-visits" />
                      <span>to</span>
                      <input type="number" min={1} max={80} value={setup!.maxVisitsPerDay} aria-label="Maximum visits a day"
                        onChange={e => setEdits(x => ({ ...x, maxVisitsPerDay: Math.max(1, Number(e.target.value) || 1) }))}
                        className="h-9 w-16 rounded-lg border border-input bg-card px-2.5 tabular-nums shadow-xs focus:border-primary/60 focus:outline-none focus:ring-4 focus:ring-primary/10" data-testid="rtm-max-visits" />
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {blueprint.setup.bandSource === "workload"
                        ? `From the workload: about ${blueprint.workload.sustainableCallsPerDay} calls fit an ${blueprint.workload.shiftHours}-hour day.`
                        : "As in your last plan."}
                    </p>
                  </div>

                  {/* balance */}
                  <div className="rounded-xl border bg-card p-3.5 shadow-xs sm:col-span-2">
                    <div className="flex items-center gap-2 text-sm font-medium"><Scale className="h-4 w-4 text-muted-foreground" /> Balance days by</div>
                    <div className="mt-2 inline-flex rounded-lg bg-muted p-1" data-testid="rtm-balance">
                      {(["time", "visits"] as const).map(b => (
                        <button key={b} type="button" onClick={() => setEdits(e => ({ ...e, balanceBy: b }))}
                          className={`rounded-md px-3 py-1 text-sm ${setup!.balanceBy === b ? "bg-card font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}>
                          {b === "time" ? "Working time" : "Visit count"}
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{blueprint.setup.balanceReason}</p>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-xl border border-primary/15 bg-primary/[0.04] px-4 py-3 text-sm leading-relaxed" data-testid="rtm-workday">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span>
                    A typical day: <strong>{blueprint.headcount.visitsPerDay}</strong> calls of about {Math.round(blueprint.workload.callMinutes)} min, plus driving,
                    is about <strong>{blueprint.workload.dayHoursAtBand} h</strong> of an {blueprint.workload.shiftHours}-hour shift.
                    {" "}Distances: {blueprint.setup.distanceMode === "road" ? "real roads" : "straight line"}; longest drive between calls {setup!.maxHopKm} km.
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="brand" size="lg" className="px-6" onClick={build} disabled={!canEdit || bpLoading || choiceQs !== debouncedQs} data-testid="rtm-build">
                    <Sparkles className="h-4 w-4" /> Build my RTM
                  </Button>
                  {hasPlan && <Button variant="ghost" className="" onClick={() => setReplan(false)}>Back to the current plan</Button>}
                  {canEdit && <Button variant="ghost" className="" onClick={() => fileInput.current?.click()}>Upload a different file</Button>}
                </div>
              </div>
            </div>
          )
        )}

        {/* ---------- result ---------- */}
        {showResult && scorecard && (
          <div className="space-y-5" data-testid="rtm-result">
            <div className="flex flex-wrap items-center gap-4">
              <div className={`flex h-16 w-16 flex-col items-center justify-center rounded-2xl bg-gradient-to-br text-white ring-1 ring-inset ring-white/20 ${GRADE_STYLE[scorecard.grade]}`} data-testid="rtm-grade">
                <span className="text-3xl font-semibold leading-none tracking-tight">{scorecard.grade}</span>
                <span className="mt-1 text-[10px] font-medium tabular-nums opacity-90">{scorecard.score}/100</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="eyebrow">Your RTM</p>
                <p className="mt-1 text-[15px] font-medium leading-snug text-foreground" data-testid="rtm-headline">{scorecard.headline}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="brand" data-testid="rtm-download-pjp"
                  onClick={() => downloadFile("/api/export/pjp", "journey_plan.xlsx").catch(e => toast({ title: "Download failed", description: (e as Error).message, variant: "destructive" }))}>
                  <Download className="h-4 w-4" /> Download journey plan
                </Button>
                <Link href="/rep-map"><Button variant="outline" className=""><MapPinned className="h-4 w-4" /> Rep Map</Button></Link>
                <Link href="/territories"><Button variant="outline" className=""><MapIcon className="h-4 w-4" /> Territory Map</Button></Link>
                {canEdit && <Button variant="ghost" className="" onClick={() => setReplan(true)} data-testid="rtm-replan"><RotateCcw className="h-4 w-4" /> Re-plan</Button>}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
              <Tile icon={Users} label="Reps" value={fmt(scorecard.kpis.reps)} sub={`${fmt(scorecard.kpis.dayRoutes)} day routes`} testid="rtm-kpi-reps" />
              <Tile icon={Store} label="Outlets planned" value={`${scorecard.kpis.coveragePct}%`} sub={`${fmt(scorecard.kpis.planned)}${scorecard.kpis.heldForReview ? ` · ${scorecard.kpis.heldForReview} held` : ""}`} testid="rtm-kpi-coverage" />
              <Tile icon={CalendarDays} label="Visits a day" value={`${scorecard.kpis.visitsPerDay.avg}`} sub={`${scorecard.kpis.visitsPerDay.min} to ${scorecard.kpis.visitsPerDay.max}`} />
              <Tile icon={Route} label="Km a day" value={`${scorecard.kpis.kmPerDay}`} sub={`${fmt(scorecard.kpis.kmPerMonth)} a month · ${scorecard.kpis.kmBasis === "road" ? "road" : "straight line"}`} />
              <Tile icon={Clock} label="Workday" value={`${scorecard.kpis.workdayHours} h`} sub={`longest ${scorecard.kpis.maxWorkdayHours} h of ${scorecard.kpis.shiftHours}`} />
              <Tile icon={Layers} label="Overlap" value={`${scorecard.kpis.routeOverlapPct}%`} sub={`territories ${scorecard.kpis.territoryOverlapPct}%`} />
              <Tile icon={Scale} label="Balance" value={`±${(scorecard.kpis.repBalancePct / 2).toFixed(1)}%`} sub={scorecard.kpis.balanceBy === "time" ? "by working time" : "by visits"} />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <p className="eyebrow mb-2">Checks before roll-out</p>
                <CheckList checks={scorecard.checks} testid="rtm-checks" />
              </div>
              <div>
                <button type="button" className="eyebrow mb-2 flex items-center gap-1 hover:text-foreground" onClick={() => setShowReps(v => !v)} data-testid="rtm-toggle-reps">
                  Reps ({scorecard.perRep.length}) {showReps ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
                <div className={`overflow-auto rounded-xl border bg-card ${showReps ? "max-h-[420px]" : "max-h-[248px]"}`}>
                  <table className="w-full text-sm" data-testid="rtm-rep-table">
                    <thead className="sticky top-0 z-10 bg-muted/90 text-[11px] uppercase tracking-[0.05em] text-muted-foreground backdrop-blur">
                      <tr>
                        <th className="px-3 py-2.5 text-left font-semibold">Rep</th>
                        <th className="px-2 py-2.5 text-right font-semibold">Outlets</th>
                        <th className="px-2 py-2.5 text-right font-semibold">Visits/day</th>
                        <th className="px-2 py-2.5 text-right font-semibold">Km/day</th>
                        <th className="px-2 py-2.5 text-right font-semibold">Hours/day</th>
                        <th className="px-3 py-2.5 text-right font-semibold">Long drives</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scorecard.perRep.map(r => (
                        <tr key={r.repId} className="border-t hover:bg-muted/40">
                          <td className="px-3 py-2 font-medium">{r.name}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{fmt(r.outlets)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{r.visitsPerDay.avg} <span className="text-xs text-muted-foreground">({r.visitsPerDay.min}-{r.visitsPerDay.max})</span></td>
                          <td className="px-2 py-2 text-right tabular-nums">{r.kmPerDay}</td>
                          <td className={`px-2 py-2 text-right tabular-nums ${r.maxHoursPerDay > scorecard.kpis.shiftHours + 0.25 ? "text-warning" : ""}`}>{r.hoursPerDay} <span className="text-xs text-muted-foreground">(max {r.maxHoursPerDay})</span></td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.longHops}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {hasPlan && !replan && !building && !scorecard && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Scoring the plan…</div>
        )}
      </div>
    </section>
  );
}

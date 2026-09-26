import { useState, useMemo, useCallback, useRef } from "react";
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
import OptimizationProgressModal from "./optimization-progress-modal";
import { cn } from "@/lib/utils";

// ISO weekday numbers, shown in the order a picker reads best. Sunday and
// Saturday sit at the ends because whichever one a business starts on, it is
// the boundary of its week.
const WEEK_PICKER: { iso: number; label: string }[] = [
  { iso: 7, label: 'Sun' }, { iso: 1, label: 'Mon' }, { iso: 2, label: 'Tue' },
  { iso: 3, label: 'Wed' }, { iso: 4, label: 'Thu' }, { iso: 5, label: 'Fri' },
  { iso: 6, label: 'Sat' },
];
const WEEKDAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Orders the ticked days so the week starts after the longest break. */
function orderedWeek(days: number[]): number[] {
  const sorted = Array.from(new Set(days)).sort((a, b) => a - b);
  if (sorted.length < 2) return sorted;
  let startAt = 0, widest = -1;
  for (let i = 0; i < sorted.length; i++) {
    const prev = sorted[(i - 1 + sorted.length) % sorted.length];
    const gap = ((sorted[i] - prev) + 7) % 7;
    if (gap > widest) { widest = gap; startAt = i; }
  }
  return [...sorted.slice(startAt), ...sorted.slice(0, startAt)];
}

const isoWeekday = (d: Date) => (d.getDay() === 0 ? 7 : d.getDay());
const nextMonthKey = () => {
  const t = new Date();
  const y = t.getMonth() === 11 ? t.getFullYear() + 1 : t.getFullYear();
  const m = t.getMonth() === 11 ? 1 : t.getMonth() + 2;
  return `${y}-${String(m).padStart(2, '0')}`;
};
const shortDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * The working dates of one calendar month, mirroring the server so the form
 * can say "Sat 3 Oct to Thu 29 Oct, 24 working days" before the run.
 */
function monthPlan(key: string, days: number[], edges: 'wholeWeeks' | 'allDays') {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m || days.length === 0) return null;
  const year = Number(m[1]), month = Number(m[2]);
  const inWeek = new Set(days);
  const all: Date[] = [];
  for (let d = new Date(year, month - 1, 1); d.getMonth() === month - 1; d.setDate(d.getDate() + 1)) all.push(new Date(d));
  const working = all.filter(d => inWeek.has(isoWeekday(d)));
  if (working.length === 0) return null;
  let start = working[0], end = working[working.length - 1];
  if (edges === 'wholeWeeks') {
    const s = all.find(d => isoWeekday(d) === days[0]);
    const e = [...all].reverse().find(d => isoWeekday(d) === days[days.length - 1]);
    if (s && e && s <= e) { start = s; end = e; }
  }
  const dates = working.filter(d => d >= start && d <= end);
  const leftOut = working.length - dates.length;
  return { start, end, count: dates.length, leftOut };
}

/** "Sunday to Thursday - 5 days a week, Friday and Saturday off." */
function describeWeek(days: number[]): string {
  const week = orderedWeek(days);
  if (week.length === 0) return 'No working days selected.';
  const off = [1, 2, 3, 4, 5, 6, 7].filter(d => !week.includes(d)).map(d => WEEKDAY_LABELS[d - 1]);
  const span = week.length === 1
    ? WEEKDAY_LABELS[week[0] - 1]
    : `${WEEKDAY_LABELS[week[0] - 1]} to ${WEEKDAY_LABELS[week[week.length - 1] - 1]}`;
  const offText = off.length === 0 ? 'no days off'
    : `${off.slice(0, -1).join(', ')}${off.length > 1 ? ' and ' : ''}${off[off.length - 1]} off`;
  return `${span} — ${week.length} day${week.length === 1 ? '' : 's'} a week, ${offText}.`;
}

interface FileAnalysis {
  outlets: number;
  vf1: number;
  vf2: number;
  vf4: number;
  recommendedReps?: number;
}

interface DashboardMetrics {
  totalOutlets: number;
  activeReps: number;
  recommendedReps: number;
}

interface OptimizationSettingsProps {
  disabled?: boolean;
}

type WeightMode = 'isolation' | 'vf' | 'value';

interface CoverageSuggestion {
  territory: string;
  outletCount: number;
  monthlyVisits: number;
  isolationKm: number;
  costPerVisitKm: number;
  outletIds: string[];
  sampleOutlets: string[];
  reason: string;
}

interface TerritoryBalance {
  targetPerRep: number;
  tolerancePct: number;
  maxDeviationPct: number;
  withinTolerance: boolean;
  perRep: { name: string; code: string; monthlyVisits: number; uniqueOutlets: number; deviationPct: number }[];
}

interface GeoOutlier {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
}

type DistanceModel = 'haversine' | 'grid' | 'road';

export default function OptimizationSettings({ disabled = false }: OptimizationSettingsProps) {
  // Daily visit targets (actual visits per rep per day)
  const [minVisitsPerDay, setMinVisitsPerDay] = useState(25);
  const [maxVisitsPerDay, setMaxVisitsPerDay] = useState(30);

  // Coverage weighting for area-removal suggestions
  const [weightMode, setWeightMode] = useState<WeightMode>('isolation');
  const [distanceMode, setDistanceMode] = useState<DistanceModel>('haversine');
  // Route compactness: the max radius a day-zone may span. Lower = tighter
  // routes but fewer visits per day in sparse markets (more reps needed);
  // higher = fuller days over more ground.
  const [maxZoneRadiusKm, setMaxZoneRadiusKm] = useState(15);
  // Longest drive allowed between two consecutive stops on a day-route, km.
  const [maxHopKm, setMaxHopKm] = useState(4);
  const [coverageSuggestions, setCoverageSuggestions] = useState<CoverageSuggestion[]>([]);
  const [territoryBalance, setTerritoryBalance] = useState<TerritoryBalance | null>(null);
  const [weightModeUsed, setWeightModeUsed] = useState<string>('');
  const [selectedExclusions, setSelectedExclusions] = useState<Set<string>>(new Set());
  const [geoOutliers, setGeoOutliers] = useState<GeoOutlier[]>([]);
  const [capacityWarning, setCapacityWarning] = useState<{
    projectedVisitsPerDay: number;
    minVisitsPerDay: number;
    supportedWorkingDays: number;
    message: string;
  } | null>(null);
  const [selectedGeoExclusions, setSelectedGeoExclusions] = useState<Set<string>>(new Set());
  const [activeExcludedIds, setActiveExcludedIds] = useState<string[]>([]);

  // Common settings
  // The weekdays the reps work, ISO numbers (1 = Monday ... 7 = Sunday), in the
  // order the week runs. A count alone could not express a week that starts on
  // Saturday or Sunday, which is how much of the region works.
  const [workingDays, setWorkingDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const workingDaysPerWeek = workingDays.length;
  // Length of one journey-plan cycle, in working days. 0 = four weeks, which is
  // what the app always assumed. A business that plans a 26-day cycle (13
  // day-routes driven twice) gets days sized for 26, not 24.
  const [cycleWorkingDays, setCycleWorkingDays] = useState(0);
  // A cycle can be one real calendar month instead of a fixed length: the
  // plan then runs on that month's dates and the working-day count comes from
  // the calendar. "month" in the cycle select switches it on.
  const [planMonth, setPlanMonth] = useState(nextMonthKey());
  const [monthEdges, setMonthEdges] = useState<'wholeWeeks' | 'allDays'>('wholeWeeks');
  const cycleMode = cycleWorkingDays === -1 ? 'calendarMonth' : 'fixed';
  const monthSummary = useMemo(
    () => (cycleMode === 'calendarMonth' ? monthPlan(planMonth, orderedWeek(workingDays), monthEdges) : null),
    [cycleMode, planMonth, workingDays, monthEdges],
  );
  
  // Progress modal state
  const [showProgressModal, setShowProgressModal] = useState(false);
  const [progressId, setProgressId] = useState('');
  const optimizationStartedRef = useRef(false);
  const pendingSettingsRef = useRef<{
    minVisitsPerDay: number;
    maxVisitsPerDay: number;
    workingDaysPerWeek: number;
    workingDays: number[];
    cycleWorkingDays: number;
    cycleMode: 'fixed' | 'calendarMonth';
    planMonth: string;
    monthEdges: 'wholeWeeks' | 'allDays';
    weightMode: WeightMode;
    distanceMode: DistanceModel;
    maxZoneRadiusKm: number;
    maxHopKm: number;
    excludedOutletIds?: string[];
    progressId: string;
  } | null>(null);

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
    
    // Visits per cycle, spread over the day-slots one rep has in that cycle.
    // This used to divide by a hardcoded four-week month, which over-counted
    // every day's load on any cycle that is not exactly four weeks.
    const totalCycleVisits = (analysis.vf1 || 0) + (analysis.vf2 * 2) + (analysis.vf4 * 4);
    const cycleDays = monthSummary ? monthSummary.count : cycleWorkingDays > 0 ? cycleWorkingDays : workingDaysPerWeek * 4;
    const estimatedRepsNeeded = Math.max(1, Math.ceil(totalCycleVisits / (cycleDays * maxVisitsPerDay)));

    return {
      feasible: true,
      message: `Will create ~${estimatedRepsNeeded} routes (${minVisitsPerDay}-${maxVisitsPerDay} visits/day over a ${cycleDays}-working-day cycle)`,
      warning: false
    };
  }, [analysis, metrics, workingDaysPerWeek, cycleWorkingDays, monthSummary, minVisitsPerDay, maxVisitsPerDay]);

  const optimizationMutation = useMutation({
    mutationFn: async (settings: {
      minVisitsPerDay: number;
      maxVisitsPerDay: number;
      workingDaysPerWeek: number;
      workingDays?: number[];
      cycleWorkingDays?: number;
      cycleMode?: 'fixed' | 'calendarMonth';
      planMonth?: string;
      monthEdges?: 'wholeWeeks' | 'allDays';
      weightMode?: WeightMode;
      distanceMode?: DistanceModel;
      maxZoneRadiusKm?: number;
      maxHopKm?: number;
      excludedOutletIds?: string[];
      progressId?: string;
    }) => {
      const response = await apiRequest("POST", "/api/optimize", settings);
      return response.json();
    },
    onSuccess: (data) => {
      setCoverageSuggestions(data.coverageSuggestions || []);
      setTerritoryBalance(data.territoryBalance || null);
      setWeightModeUsed(data.coverageWeightModeUsed || '');
      setGeoOutliers(data.geoOutliers || []);
      setCapacityWarning(data.capacityWarning || null);
      setSelectedExclusions(new Set());
      setSelectedGeoExclusions(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/scenarios"] });
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
    optimizationStartedRef.current = false;
    pendingSettingsRef.current = null;
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
    optimizationStartedRef.current = false;
    pendingSettingsRef.current = null;
    toast({
      title: "Optimization failed",
      description: message,
      variant: "destructive",
    });
  }, [toast]);
  
  const handleSSEReady = useCallback(() => {
    if (pendingSettingsRef.current && !optimizationStartedRef.current) {
      optimizationStartedRef.current = true;
      optimizationMutation.mutate(pendingSettingsRef.current);
    }
  }, [optimizationMutation]);

  const handleOptimization = (excludedOutletIds: string[] = activeExcludedIds) => {
    if (minVisitsPerDay >= maxVisitsPerDay) {
      toast({
        title: "Invalid settings",
        description: "Minimum visits must be less than maximum visits",
        variant: "destructive",
      });
      return;
    }

    // Reset refs for new optimization
    optimizationStartedRef.current = false;

    const newProgressId = `opt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    pendingSettingsRef.current = {
      minVisitsPerDay,
      maxVisitsPerDay,
      workingDaysPerWeek,
      workingDays: orderedWeek(workingDays),
      cycleWorkingDays: cycleMode === 'calendarMonth' ? 0 : cycleWorkingDays,
      cycleMode,
      planMonth,
      monthEdges,
      weightMode,
      distanceMode,
      maxZoneRadiusKm,
      maxHopKm,
      excludedOutletIds: excludedOutletIds.length > 0 ? excludedOutletIds : undefined,
      progressId: newProgressId,
    };

    setProgressId(newProgressId);
    setShowProgressModal(true);
  };

  // Re-run without the areas/outlets the user ticked in the suggestion and
  // geo-outlier lists.
  const handleExcludeAndRerun = () => {
    const ids: string[] = [];
    for (const s of coverageSuggestions) {
      if (selectedExclusions.has(s.territory)) ids.push(...s.outletIds);
    }
    ids.push(...Array.from(selectedGeoExclusions));
    const combined = Array.from(new Set([...activeExcludedIds, ...ids]));
    setActiveExcludedIds(combined);
    handleOptimization(combined);
  };

  const toggleExclusion = (territory: string) => {
    setSelectedExclusions(prev => {
      const next = new Set(prev);
      if (next.has(territory)) next.delete(territory);
      else next.add(territory);
      return next;
    });
  };

  const toggleGeoExclusion = (outletId: string) => {
    setSelectedGeoExclusions(prev => {
      const next = new Set(prev);
      if (next.has(outletId)) next.delete(outletId);
      else next.add(outletId);
      return next;
    });
  };

  const totalSelectedExclusions = selectedExclusions.size + selectedGeoExclusions.size;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center">
          <Settings className="mr-2 h-5 w-5 text-[#1d1d1f] dark:text-white" />
          Step 3: Optimization Settings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4 p-4 bg-gray-50 rounded-lg">
          <h4 className="font-medium text-gray-700">Daily Visit Targets</h4>
          <p className="text-xs text-gray-500">Actual outlets a rep visits each day - zones are sized automatically from these and each outlet's visit frequency.</p>
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

        <div>
          <Label>Working Days</Label>
          <p className="text-xs text-gray-500 mt-1 mb-2">
            Tick the days the reps work. The first and last ticked days are the start
            and end of their week; the rest are days off.
          </p>
          <div className="flex flex-wrap gap-1.5" data-testid="picker-working-days">
            {WEEK_PICKER.map(({ iso, label }) => {
              const on = workingDays.includes(iso);
              return (
                <button
                  key={iso}
                  type="button"
                  disabled={disabled}
                  aria-pressed={on}
                  data-testid={`chip-workday-${iso}`}
                  onClick={() => setWorkingDays(prev => {
                    const next = on ? prev.filter(d => d !== iso) : [...prev, iso];
                    // Never leave the plan with no days to schedule onto.
                    return next.length === 0 ? prev : next;
                  })}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
                    on
                      ? "border-transparent bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                      : "border-gray-300 text-gray-500 hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-800",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <span data-testid="text-week-summary">{describeWeek(workingDays)}</span>
            <span>·</span>
            <button type="button" className="underline hover:text-gray-700 dark:hover:text-gray-300"
              disabled={disabled} onClick={() => setWorkingDays([1, 2, 3, 4, 5])}>Mon–Fri</button>
            <button type="button" className="underline hover:text-gray-700 dark:hover:text-gray-300"
              disabled={disabled} onClick={() => setWorkingDays([1, 2, 3, 4, 5, 6])}>Mon–Sat</button>
            <button type="button" className="underline hover:text-gray-700 dark:hover:text-gray-300"
              disabled={disabled} onClick={() => setWorkingDays([7, 1, 2, 3, 4])}>Sun–Thu</button>
            <button type="button" className="underline hover:text-gray-700 dark:hover:text-gray-300"
              disabled={disabled} onClick={() => setWorkingDays([6, 7, 1, 2, 3])}>Sat–Wed</button>
          </div>
        </div>

        <div>
          <Label htmlFor="cycleDays">Cycle Length</Label>
          <Select
            value={cycleWorkingDays.toString()}
            onValueChange={(value) => setCycleWorkingDays(parseInt(value))}
            disabled={disabled}
          >
            <SelectTrigger className="mt-1" disabled={disabled} data-testid="select-cycle-days">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="-1">Calendar month — the working days of a real month</SelectItem>
              <SelectItem value="0">4 weeks ({workingDaysPerWeek * 4} working days)</SelectItem>
              <SelectItem value="20">20 working days (10 routes x 2)</SelectItem>
              <SelectItem value="22">22 working days (11 routes x 2)</SelectItem>
              <SelectItem value="24">24 working days (6 routes x 4)</SelectItem>
              <SelectItem value="26">26 working days (13 routes x 2)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-gray-500 mt-1">
            How many working days one full journey plan covers before it repeats. A
            26-day cycle is 13 distinct day-routes, each driven twice, 13 working
            days apart - the daily load is sized for 26 days, not 24.
          </p>
          {cycleMode === 'calendarMonth' && (
            <div className="mt-3 space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid="panel-plan-month">
              <div className="flex flex-wrap items-center gap-3">
                <div>
                  <Label htmlFor="planMonth" className="text-xs">Month</Label>
                  <Input id="planMonth" type="month" value={planMonth} min="2020-01"
                    onChange={(e) => setPlanMonth(e.target.value || nextMonthKey())}
                    className="mt-1 w-44" disabled={disabled} data-testid="input-plan-month" />
                </div>
                <div>
                  <Label className="text-xs">Month edges</Label>
                  <Select value={monthEdges} onValueChange={(v) => setMonthEdges(v as 'wholeWeeks' | 'allDays')} disabled={disabled}>
                    <SelectTrigger className="mt-1 w-64" disabled={disabled} data-testid="select-month-edges">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="wholeWeeks">Whole weeks only (first {WEEKDAY_LABELS[orderedWeek(workingDays)[0] - 1]} to last {WEEKDAY_LABELS[orderedWeek(workingDays)[orderedWeek(workingDays).length - 1] - 1]})</SelectItem>
                      <SelectItem value="allDays">Every working day of the month</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {monthSummary ? (
                <p className="text-sm" data-testid="text-plan-month-summary">
                  <span className="font-medium">{shortDate(monthSummary.start)} → {shortDate(monthSummary.end)}</span>
                  {' '}— <span className="font-medium">{monthSummary.count} working days</span>.
                  {monthSummary.leftOut > 0 && (
                    <span className="text-amber-700 dark:text-amber-300">
                      {' '}{monthSummary.leftOut} working day{monthSummary.leftOut === 1 ? '' : 's'} at the edges of the month fall outside the plan.
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-sm text-red-600">No working days in that month for the selected working week.</p>
              )}
            </div>
          )}
        </div>

        <div>
          <Label htmlFor="weightMode">Coverage Weighting (for area suggestions)</Label>
          <Select
            value={weightMode}
            onValueChange={(value) => setWeightMode(value as WeightMode)}
            disabled={disabled}
          >
            <SelectTrigger className="mt-1" disabled={disabled} data-testid="select-weight-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="isolation">Geographic isolation (no extra data needed)</SelectItem>
              <SelectItem value="vf">Visit frequency weighted</SelectItem>
              <SelectItem value="value">Commercial value (VC/volume column in file)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-gray-500 mt-1">
            Decides how areas are judged when suggesting low-worth pockets to move to indirect coverage. Suggestions never remove anything automatically.
          </p>
        </div>

        <div>
          <Label htmlFor="distanceMode">Distance Model</Label>
          <Select
            value={distanceMode}
            onValueChange={(value) => setDistanceMode(value as DistanceModel)}
            disabled={disabled}
          >
            <SelectTrigger className="mt-1" disabled={disabled} data-testid="select-distance-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="haversine">Straight-line (recommended)</SelectItem>
              <SelectItem value="grid">Street-grid (for grid-planned cities)</SelectItem>
              <SelectItem value="road">Road-aware (river/barrier crossings)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-gray-500 mt-1">
            Straight-line suits most markets. Street-grid charges diagonal moves at the cost of going round the block, which helps in grid-planned cities but tested worse on Damascus's organic street layout. Road-aware only changes grouping where a barrier (e.g. the Tigris) is configured, or when an OSRM server supplies true road distances — a flat detour factor alone rescales every pair equally and so leaves the grouping unchanged.
          </p>
        </div>

        <div>
          <Label htmlFor="compactness">Route Compactness</Label>
          <Select
            value={String(maxZoneRadiusKm)}
            onValueChange={(v) => setMaxZoneRadiusKm(parseInt(v))}
            disabled={disabled}
          >
            <SelectTrigger className="mt-1" disabled={disabled} data-testid="select-compactness">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5">Very tight — 5 km max zone radius</SelectItem>
              <SelectItem value="10">Tight — 10 km</SelectItem>
              <SelectItem value="15">Balanced — 15 km (default)</SelectItem>
              <SelectItem value="25">Wide — 25 km</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-gray-500 mt-1">
            In dense cities you can keep routes very tight and still fill each day. In sparse markets the two pull against each other: tighter routes mean fewer visits per day and more reps. Loosen this if days come out under target.
          </p>
        </div>

        <div>
          <Label htmlFor="maxHop">Max Drive Between Stops</Label>
          <div className="mt-1 flex items-center gap-2">
            <Input
              id="maxHop"
              type="number"
              value={maxHopKm}
              onChange={(e) => setMaxHopKm(Math.max(0, parseFloat(e.target.value) || 0))}
              min="0"
              max="50"
              step="0.5"
              className="w-28"
              disabled={disabled}
              data-testid="input-max-hop"
            />
            <span className="text-sm text-gray-600">km</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            The longest single drive allowed from one stop to the next inside a day. Any hop
            over this is penalised heavily, so the grouping will spend a little total distance to
            avoid one long jump. An outlet with no neighbour at all within this range still has
            to be reached; the console lists those. 0 turns it off.
          </p>
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
              <div className="pt-2 border-t border-blue-300">
                <strong>Initial Estimate: ~{estimatedReps} reps</strong>
                <p className="text-xs mt-1">Final recommendation after optimization</p>
              </div>
            </div>
          </div>
        )}

        <Button
          onClick={() => handleOptimization()}
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

        {activeExcludedIds.length > 0 && (
          <Alert className="border-gray-300 bg-gray-50">
            <AlertCircle className="h-4 w-4 text-gray-600" />
            <AlertDescription className="text-gray-700 flex items-center justify-between gap-2">
              <span>{activeExcludedIds.length} outlets are excluded from optimization (indirect coverage).</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setActiveExcludedIds([]); }}
                data-testid="button-clear-exclusions"
              >
                Clear
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {territoryBalance && (
          <Alert className={territoryBalance.withinTolerance ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}>
            <AlertCircle className={`h-4 w-4 ${territoryBalance.withinTolerance ? "text-green-600" : "text-amber-600"}`} />
            <AlertDescription className={territoryBalance.withinTolerance ? "text-green-800" : "text-amber-800"}>
              <strong>Territory balance:</strong> target ~{territoryBalance.targetPerRep} visits/month per rep,
              max deviation {territoryBalance.maxDeviationPct}% (band ±{territoryBalance.tolerancePct}%).
              {!territoryBalance.withinTolerance && " Residual imbalance kept to avoid forcing long drives between disconnected regions."}
            </AlertDescription>
          </Alert>
        )}

        {coverageSuggestions.length > 0 && (
          <div className="p-4 bg-amber-50 rounded-lg border border-amber-200 space-y-3" data-testid="coverage-suggestions">
            <h4 className="font-semibold text-amber-900">
              Suggested areas for indirect coverage ({weightModeUsed})
            </h4>
            <p className="text-xs text-amber-800">
              These pockets cost disproportionate driving for the visits they generate. Tick the ones to drop and re-run — nothing is removed unless you choose to.
            </p>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {coverageSuggestions.map((s) => (
                <label key={s.territory} className="flex items-start gap-2 text-sm text-amber-900 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selectedExclusions.has(s.territory)}
                    onChange={() => toggleExclusion(s.territory)}
                    data-testid={`checkbox-exclude-${s.territory.replace(/\s+/g, '-').toLowerCase()}`}
                  />
                  <span>
                    <strong>{s.territory}</strong> — {s.outletCount} outlet{s.outletCount === 1 ? '' : 's'}, {s.monthlyVisits} visits/mo,
                    ~{s.costPerVisitKm}km drive per visit (e.g. {s.sampleOutlets.join(', ')})
                    <span className="block text-xs text-amber-700">{s.reason}</span>
                  </span>
                </label>
              ))}
            </div>
            <Button
              variant="outline"
              className="w-full border-amber-400 text-amber-900"
              disabled={disabled || optimizationMutation.isPending || totalSelectedExclusions === 0}
              onClick={handleExcludeAndRerun}
              data-testid="button-exclude-rerun"
            >
              Re-optimize without {totalSelectedExclusions} selected item{totalSelectedExclusions === 1 ? '' : 's'}
            </Button>
          </div>
        )}

        {capacityWarning && (
          <div className="p-4 bg-amber-50 rounded-lg border border-amber-200 space-y-2" data-testid="capacity-warning">
            <h4 className="font-semibold text-amber-900">Not enough work to fill the week</h4>
            <p className="text-sm text-amber-900">{capacityWarning.message}</p>
            <p className="text-xs text-amber-800">
              Days will come out at roughly {capacityWarning.projectedVisitsPerDay} visits instead of{" "}
              {capacityWarning.minVisitsPerDay}. This volume supports about{" "}
              <strong>{capacityWarning.supportedWorkingDays} working day
              {capacityWarning.supportedWorkingDays === 1 ? "" : "s"} per week</strong> at your minimum -
              either lower the working days, lower the minimum visits/day, or add more outlets.
            </p>
          </div>
        )}

        {geoOutliers.length > 0 && (
          <div className="p-4 bg-red-50 rounded-lg border border-red-200 space-y-3" data-testid="geo-outliers">
            <h4 className="font-semibold text-red-900">
              Outlets outside the core coverage area ({geoOutliers.length})
            </h4>
            <p className="text-xs text-red-800">
              These outlets sit far outside the market and its rural belt — usually wrong GPS data or outlets that belong to another region. They are <strong>held out of the day-routes</strong> so one bad coordinate cannot turn a rep's day into a cross-country drive; nothing has been deleted. Fix their coordinates, or tick the ones to remove for good and re-run.
            </p>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {geoOutliers.map((g) => (
                <label key={g.id} className="flex items-start gap-2 text-sm text-red-900 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selectedGeoExclusions.has(g.id)}
                    onChange={() => toggleGeoExclusion(g.id)}
                    data-testid={`checkbox-geo-${g.id}`}
                  />
                  <span>
                    <strong>{g.name}</strong> — {g.distanceKm}km from the core area
                    <span className="block text-xs text-red-700">({g.latitude.toFixed(4)}, {g.longitude.toFixed(4)})</span>
                  </span>
                </label>
              ))}
            </div>
            <Button
              variant="outline"
              className="w-full border-red-400 text-red-900"
              disabled={disabled || optimizationMutation.isPending || totalSelectedExclusions === 0}
              onClick={handleExcludeAndRerun}
              data-testid="button-geo-exclude-rerun"
            >
              Re-optimize without {totalSelectedExclusions} selected item{totalSelectedExclusions === 1 ? '' : 's'}
            </Button>
          </div>
        )}
      </CardContent>
      
      <OptimizationProgressModal
        isOpen={showProgressModal}
        progressId={progressId}
        onReady={handleSSEReady}
        onComplete={handleProgressComplete}
        onError={handleProgressError}
      />
    </Card>
  );
}
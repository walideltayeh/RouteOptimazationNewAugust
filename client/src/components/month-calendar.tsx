import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface CalendarDay {
  week: number; dayOfWeek: number; date: string | null;
  calls: number; km: number; callMinutes: number; driveMinutes: number; minutes: number;
}
export interface PlanCalendar {
  shiftMinutes: number; graceMinutes: number; workingDays: number[]; dated: boolean;
  band: { min: number; max: number } | null; kmBasis: "road" | "straight-line";
  reps: { repId: string; name: string; days: CalendarDay[] }[];
}

const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hours = (minutes: number) => (minutes / 60).toFixed(1);
const dayOfMonth = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

/**
 * A rep's month at a glance: one cell per route, by week and weekday, with
 * its calls, its length against the shift and its kilometres. Days over the
 * shift, and days outside the visits band, stand out without reading a
 * number. Clicking a cell asks the page to show that weekday.
 */
export default function MonthCalendar({ repId, onPickDay }: { repId: string; onPickDay?: (dayOfWeek: number) => void }) {
  const { data, refetch } = useQuery<PlanCalendar>({ queryKey: ["/api/plan/calendar"], retry: false });
  // The calendar is read off the routes: whenever they are loaded again
  // (a re-plan, a move, a delete), so is it.
  const { dataUpdatedAt: routesLoadedAt } = useQuery<unknown[]>({ queryKey: ["/api/schedules"] });
  useEffect(() => { if (routesLoadedAt) refetch(); }, [routesLoadedAt, refetch]);
  const rep = data?.reps.find(r => r.repId === repId);

  const view = useMemo(() => {
    if (!data || !rep || rep.days.length === 0) return null;
    const weeks = Array.from(new Set(rep.days.map(d => d.week))).sort((a, b) => a - b);
    const cell = new Map(rep.days.map(d => [`${d.week}:${d.dayOfWeek}`, d]));
    const limit = data.shiftMinutes + data.graceMinutes;
    const over = rep.days.filter(d => d.minutes > limit).length;
    const offBand = data.band ? rep.days.filter(d => d.calls < data.band!.min || d.calls > data.band!.max).length : 0;
    const mean = rep.days.reduce((s, d) => s + d.minutes, 0) / rep.days.length;
    const longest = rep.days.reduce((m, d) => Math.max(m, d.minutes), 0);
    const km = rep.days.reduce((s, d) => s + d.km, 0);
    return { weeks, cell, limit, over, offBand, mean, longest, km };
  }, [data, rep]);

  if (!data || !rep || !view) return null;
  const shift = data.shiftMinutes;

  return (
    <Card className="mb-6" data-testid="month-calendar">
      <CardHeader className="border-b px-5 py-3.5">
        <CardTitle className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[15px]">
          <span>{rep.name}'s month</span>
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-normal text-muted-foreground">
            <span><strong className="font-semibold tabular-nums text-foreground">{rep.days.length}</strong> routes</span>
            <span>average <strong className="font-semibold tabular-nums text-foreground">{hours(view.mean)} h</strong></span>
            <span>longest <strong className={`font-semibold tabular-nums ${view.longest > view.limit ? "text-destructive" : "text-foreground"}`}>{hours(view.longest)} h</strong> of {hours(shift)}</span>
            <span><strong className="font-semibold tabular-nums text-foreground">{Math.round(view.km).toLocaleString()}</strong> km{data.kmBasis === "road" ? " by road" : ""}</span>
            {view.over > 0 && <span className="rounded-md bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive" data-testid="calendar-over">{view.over} over the shift</span>}
            {view.offBand > 0 && <span className="rounded-md bg-warning/15 px-1.5 py-0.5 font-medium text-warning">{view.offBand} outside {data.band!.min}-{data.band!.max} visits</span>}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-4">
        <div className="grid min-w-[560px] gap-1.5" style={{ gridTemplateColumns: `3.25rem repeat(${data.workingDays.length}, minmax(0, 1fr))` }}>
          <span />
          {data.workingDays.map(d => (
            <span key={d} className="pb-1 text-center text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{DAY_SHORT[d] ?? d}</span>
          ))}
          {view.weeks.map(w => [
            <span key={`w${w}`} className="self-center text-xs font-medium text-muted-foreground">Week {w}</span>,
            ...data.workingDays.map(d => {
              const c = view.cell.get(`${w}:${d}`);
              if (!c) return <span key={`${w}:${d}`} className="rounded-lg border border-dashed border-border/70 bg-muted/30" aria-hidden />;
              const over = c.minutes > view.limit;
              const tight = !over && c.minutes > shift;
              const offBand = !!data.band && (c.calls < data.band.min || c.calls > data.band.max);
              const fill = Math.min(100, Math.round((c.minutes / shift) * 100));
              return (
                <button
                  key={`${w}:${d}`}
                  type="button"
                  onClick={() => onPickDay?.(d)}
                  title={`${c.calls} calls · ${hours(c.callMinutes)} h in outlets · ${hours(c.driveMinutes)} h driving · ${c.km} km`}
                  className={`rounded-lg border px-2.5 py-2 text-left transition-colors hover:border-primary/50 hover:bg-primary/[0.04] ${over ? "border-destructive/40 bg-destructive/[0.06]" : "border-border bg-card"}`}
                  data-testid={`calendar-cell-${w}-${d}`}
                >
                  <span className="flex items-baseline justify-between gap-1">
                    <span className={`text-[15px] font-semibold tabular-nums leading-5 ${offBand ? "text-warning" : ""}`}>{c.calls}<span className="ml-1 text-[11px] font-normal text-muted-foreground">calls</span></span>
                    {data.dated && c.date && <span className="text-[11px] tabular-nums text-muted-foreground">{dayOfMonth(c.date)}</span>}
                  </span>
                  <span className="mt-0.5 block text-[11px] tabular-nums text-muted-foreground">
                    <span className={over ? "font-semibold text-destructive" : tight ? "font-medium text-foreground" : ""}>{hours(c.minutes)} h</span> · {c.km} km
                  </span>
                  <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-muted">
                    <span className={`block h-full rounded-full ${over ? "bg-destructive" : tight ? "bg-warning" : "bg-success"}`} style={{ width: `${fill}%` }} />
                  </span>
                </button>
              );
            }),
          ])}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          The bar is the day against the {hours(shift)}-hour shift: calls, driving, commute and break. Red is more than {data.graceMinutes} minutes over.
        </p>
      </CardContent>
    </Card>
  );
}

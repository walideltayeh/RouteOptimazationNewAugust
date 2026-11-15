import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { ArrowLeft, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Rep } from "@shared/schema";

interface SheetStop {
  seq: number; id: string; code: string; name: string; address: string; channel: string;
  visitFrequency: number; callMinutes: number; legKm: number; latitude: number; longitude: number;
}
interface SheetDay {
  week: number; dayOfWeek: number; date: string | null;
  calls: number; km: number; callMinutes: number; driveMinutes: number; minutes: number; stops: SheetStop[];
}
interface RouteSheet {
  shiftMinutes: number; graceMinutes: number; workingDays: number[]; dated: boolean; kmBasis: "road" | "straight-line";
  rep: { id: string; name: string; code: string; territory: string };
  days: SheetDay[];
}

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const hours = (minutes: number) => (minutes / 60).toFixed(1);
const longDate = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/**
 * A rep's routes as sheets to hand out: one route to a page, every stop in
 * the order it is driven, with a box to tick and room for a note. The page
 * prints as it reads; the controls and the app's frame stay off the paper.
 */
export default function RouteSheetsPage() {
  const search = useSearch();
  const { data: reps = [] } = useQuery<Rep[]>({ queryKey: ["/api/reps"] });
  const [picked, setPicked] = useState<string>(() => new URLSearchParams(search).get("rep") ?? "");
  const [week, setWeek] = useState<string>("all");
  const repId = picked || reps[0]?.id || "";
  const { data: sheet, isLoading } = useQuery<RouteSheet>({ queryKey: [`/api/plan/route-sheet?repId=${repId}`], enabled: !!repId, retry: false });

  const weeks = useMemo(() => Array.from(new Set((sheet?.days ?? []).map(d => d.week))).sort((a, b) => a - b), [sheet]);
  const days = (sheet?.days ?? []).filter(d => week === "all" || String(d.week) === week);

  return (
    <div className="route-sheets px-4 py-5 md:px-8 md:py-7">
      <div className="mx-auto max-w-5xl">
        <div className="no-print mb-5 flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="h-9 text-muted-foreground">
            <Link href="/schedules"><ArrowLeft className="h-4 w-4" />Schedules</Link>
          </Button>
          <Select value={repId} onValueChange={v => { setPicked(v); setWeek("all"); }}>
            <SelectTrigger className="h-9 w-[220px]" data-testid="select-sheet-rep"><SelectValue placeholder="Select a rep" /></SelectTrigger>
            <SelectContent>{reps.map(r => <SelectItem key={r.id} value={r.id}>{r.name} ({r.code})</SelectItem>)}</SelectContent>
          </Select>
          <Select value={week} onValueChange={setWeek}>
            <SelectTrigger className="h-9 w-[150px]" data-testid="select-sheet-week"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All weeks</SelectItem>
              {weeks.map(w => <SelectItem key={w} value={String(w)}>Week {w}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">{days.length} route{days.length === 1 ? "" : "s"}, one to a page</span>
          <Button size="sm" className="ml-auto h-9" onClick={() => window.print()} disabled={days.length === 0} data-testid="button-print-sheets">
            <Printer className="h-4 w-4" />Print
          </Button>
        </div>

        {!repId || (!sheet && !isLoading) ? (
          <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">No routes yet — build the plan first.</p>
        ) : !sheet ? null : days.map(d => (
          <section key={`${d.week}:${d.dayOfWeek}`} className="route-sheet mb-6 overflow-hidden rounded-xl border bg-card shadow-xs" data-testid={`sheet-${d.week}-${d.dayOfWeek}`}>
            <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b px-5 py-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{sheet.rep.name}{sheet.rep.code ? ` · ${sheet.rep.code}` : ""}{sheet.rep.territory ? ` · ${sheet.rep.territory}` : ""}</p>
                <h2 className="mt-0.5 text-lg font-semibold tracking-tight">
                  {sheet.dated && d.date ? longDate(d.date) : `Week ${d.week} · ${DAY_NAMES[d.dayOfWeek] ?? `Day ${d.dayOfWeek}`}`}
                </h2>
                {sheet.dated && d.date && <p className="text-xs text-muted-foreground">Week {d.week} of the plan</p>}
              </div>
              <dl className="flex gap-6 text-sm">
                {[
                  ["Calls", String(d.calls)],
                  ["In outlets", `${hours(d.callMinutes)} h`],
                  ["Driving", `${hours(d.driveMinutes)} h`],
                  [sheet.kmBasis === "road" ? "Km by road" : "Km", String(d.km)],
                  ["Day", `${hours(d.minutes)} h`],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
                    <dd className={`font-semibold tabular-nums ${label === "Day" && d.minutes > sheet.shiftMinutes + sheet.graceMinutes ? "text-destructive" : ""}`}>{value}</dd>
                  </div>
                ))}
              </dl>
            </header>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                  <th className="w-10 px-3 py-2 text-right font-semibold">#</th>
                  <th className="px-3 py-2 font-semibold">Outlet</th>
                  <th className="px-3 py-2 font-semibold">Address</th>
                  <th className="w-14 px-3 py-2 text-right font-semibold" title="Minutes in the outlet">Min</th>
                  <th className="w-14 px-3 py-2 text-right font-semibold" title="Kilometres from the stop before, in a straight line">Km</th>
                  <th className="w-12 px-3 py-2 text-center font-semibold">Done</th>
                  <th className="w-[22%] px-3 py-2 font-semibold">Note</th>
                </tr>
              </thead>
              <tbody>
                {d.stops.map(s => (
                  <tr key={s.id} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{s.seq}</td>
                    <td className="px-3 py-1.5">
                      <span className="font-medium">{s.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{[s.code, s.channel].filter(Boolean).join(" · ")}</span>
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">{s.address}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{s.callMinutes}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{s.seq === 1 ? "" : s.legKm.toFixed(1)}</td>
                    <td className="px-3 py-1.5 text-center"><span className="inline-block h-3.5 w-3.5 rounded-[3px] border border-foreground/40 align-middle" /></td>
                    <td className="px-3 py-1.5"><span className="block h-4 border-b border-dotted border-foreground/25" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}

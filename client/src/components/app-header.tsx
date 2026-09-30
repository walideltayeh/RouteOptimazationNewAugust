import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Menu, PanelLeftClose, PanelLeftOpen, Store, Users, CalendarRange, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import JobStatus from "@/components/job-status";
import type { Rep } from "@shared/schema";

const TITLES: Record<string, { title: string; blurb: string }> = {
  "/": { title: "Dashboard", blurb: "Upload outlets, set the plan, optimize" },
  "/territories": { title: "Territory Map", blurb: "Who covers what, and where" },
  "/rep-map": { title: "Rep Map", blurb: "Day routes, one rep at a time" },
  "/schedules": { title: "Schedules", blurb: "Each rep's month, day by day" },
  "/scenarios": { title: "Scenarios", blurb: "Compare plans before you commit" },
  "/users": { title: "Accounts", blurb: "Who can sign in, and what they may do" },
};

type PlanSettings = { configured: boolean; minVisitsPerDay?: number; maxVisitsPerDay?: number; workingDayNames?: string[]; planStart?: string | null; planEnd?: string | null; cycleDays?: number };

function Chip({ icon: Icon, children, title }: { icon: any; children: React.ReactNode; title?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f5f5f7] px-2.5 py-1 text-xs text-[#1d1d1f] dark:bg-[#2c2c2e] dark:text-[#f5f5f7]" title={title}>
      <Icon className="h-3.5 w-3.5 text-[#86868b]" />
      {children}
    </span>
  );
}

const fmtDate = (d?: string | null) => d ? new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";

/**
 * One bar across the top of every page: where you are, the plan in a
 * glance (outlets, reps, dates, working week, visit band), and the running
 * optimization if there is one. Pages no longer repeat this.
 */
export default function AppHeader({ collapsed, onToggleCollapsed, onOpenMobile }: { collapsed: boolean; onToggleCollapsed: () => void; onOpenMobile: () => void }) {
  const [location] = useLocation();
  const page = TITLES[location] ?? { title: "RouteOptima", blurb: "" };
  const { data: health } = useQuery<{ outlets: number }>({ queryKey: ["/api/health"], queryFn: async () => (await fetch("/api/health", { credentials: "include" })).json(), staleTime: 15_000 });
  const { data: reps = [] } = useQuery<Rep[]>({ queryKey: ["/api/reps"] });
  const { data: plan } = useQuery<PlanSettings>({ queryKey: ["/api/plan-settings"] });

  const week = plan?.workingDayNames?.length ? `${plan.workingDayNames[0].slice(0, 3)}–${plan.workingDayNames[plan.workingDayNames.length - 1].slice(0, 3)}` : "";

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-[#e5e5e5] bg-white/90 px-3 backdrop-blur md:px-5 dark:border-[#38383a] dark:bg-[#1c1c1e]/90" data-testid="app-header">
      <Button variant="ghost" size="icon" className="h-9 w-9 md:hidden" onClick={onOpenMobile} aria-label="Open menu"><Menu className="h-5 w-5" /></Button>
      <Button variant="ghost" size="icon" className="hidden h-9 w-9 md:inline-flex" onClick={onToggleCollapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
        {collapsed ? <PanelLeftOpen className="h-5 w-5 text-[#86868b]" /> : <PanelLeftClose className="h-5 w-5 text-[#86868b]" />}
      </Button>
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold leading-tight text-[#1d1d1f] dark:text-white">{page.title}</h1>
        <p className="hidden truncate text-xs text-[#86868b] sm:block">{page.blurb}</p>
      </div>
      <div className="ml-auto flex items-center gap-2 overflow-hidden">
        <div className="hidden items-center gap-1.5 lg:flex" data-testid="plan-chips">
          {health && <Chip icon={Store} title="Outlets on file">{health.outlets.toLocaleString()} outlets</Chip>}
          {reps.length > 0 && <Chip icon={Users} title="Reps in the plan">{reps.length} reps</Chip>}
          {plan?.configured && plan.planStart && <Chip icon={CalendarRange} title={`${plan.cycleDays ?? ""} working days`}>{fmtDate(plan.planStart)} – {fmtDate(plan.planEnd)}{week ? ` · ${week}` : ""}</Chip>}
          {plan?.configured && <Chip icon={Gauge} title="Visits per day">{plan.minVisitsPerDay}–{plan.maxVisitsPerDay}/day</Chip>}
        </div>
        <JobStatus />
      </div>
    </header>
  );
}

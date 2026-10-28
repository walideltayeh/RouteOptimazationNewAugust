import { Link, useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useState } from "react";
import { BarChart3, Map, Route, CalendarDays, FlaskConical, Users, LogIn, LogOut, Shield, KeyRound, Pencil, Eye } from "lucide-react";
import LoginModal from "@/components/login-modal";
import ChangePasswordDialog from "@/components/change-password-dialog";
import { useAuth } from "@/hooks/use-auth";
import BrandMark from "@/components/brand-mark";

const navigation = [
  { name: "Dashboard", href: "/", icon: BarChart3 },
  { name: "Territory Map", href: "/territories", icon: Map },
  { name: "Rep Map", href: "/rep-map", icon: Route },
  { name: "Schedules", href: "/schedules", icon: CalendarDays },
  { name: "Scenarios", href: "/scenarios", icon: FlaskConical },
];

interface SidebarProps {
  collapsed?: boolean;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export default function Sidebar({ collapsed = false, mobileOpen = false, onMobileClose }: SidebarProps) {
  const [location] = useLocation();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { user, isAdmin } = useAuth();
  const roleLabel = user?.role === "admin" ? "Admin" : user?.role === "planner" ? "Planner" : "Viewer";
  const RoleIcon = user?.role === "admin" ? Shield : user?.role === "planner" ? Pencil : Eye;

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
      window.location.reload();
    }
  });

  // One markup for three shapes: full on desktop, icons-only when collapsed,
  // and a drawer over the page on a phone (the old fixed 288px column left
  // a phone a third of its width for the actual app).
  const showLabels = !collapsed || mobileOpen;
  const initials = (user?.name || "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join("") || "?";
  const navItem = (item: { name: string; href: string; icon: typeof Users }) => {
    const Icon = item.icon;
    const isActive = location === item.href;
    return (
      <Link
        key={item.name}
        href={item.href}
        title={item.name}
        onClick={onMobileClose}
        className={`group relative flex h-9 items-center ${showLabels ? "gap-3 px-2.5" : "justify-center"} rounded-lg text-[13.5px] font-medium
          ${isActive ? "bg-sidebar-accent text-white" : "text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-white"}`}
        aria-current={isActive ? "page" : undefined}
        data-testid={`nav-${item.href === '/' ? 'dashboard' : item.href.slice(1)}`}
      >
        {isActive && <span className={`absolute ${showLabels ? "-left-3" : "-left-2"} top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-sidebar-primary`} aria-hidden />}
        <Icon className={`h-[18px] w-[18px] shrink-0 ${isActive ? "text-white" : "text-sidebar-muted group-hover:text-white"}`} />
        {showLabels && <span className="truncate">{item.name}</span>}
      </Link>
    );
  };
  const body = (
    <>
      <div className={`flex h-14 shrink-0 items-center ${showLabels ? "gap-2.5 px-5" : "justify-center px-2"}`}>
        <BrandMark className="h-8 w-8 shrink-0 drop-shadow-[0_2px_6px_hsl(var(--primary)/0.4)]" />
        {showLabels && (
          <div className="min-w-0 leading-tight">
            <p className="truncate text-[15px] font-semibold tracking-tight text-white">RouteOptima</p>
            <p className="truncate text-[11px] text-sidebar-muted">Route-to-market planner</p>
          </div>
        )}
      </div>

      <nav className={`flex-1 overflow-y-auto ${showLabels ? "px-3" : "px-2"} pt-3`}>
        {showLabels && <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-sidebar-muted/70">Planning</p>}
        <div className="space-y-0.5">{navigation.map(navItem)}</div>
        {isAdmin && (
          <>
            {showLabels ? <p className="mb-1.5 mt-6 px-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-sidebar-muted/70">Admin</p> : <div className="mx-2 my-3 h-px bg-sidebar-border" />}
            <div className="space-y-0.5">{navItem({ name: "Accounts", href: "/users", icon: Users })}</div>
          </>
        )}
      </nav>

      <div className={`border-t border-sidebar-border ${showLabels ? "p-3" : "p-2"}`}>
        {user ? (
          <div className={`flex items-center ${showLabels ? "gap-2.5 rounded-lg px-1.5 py-1" : "flex-col gap-2"}`}>
            <div className="relative shrink-0" title={`${user.name} - ${roleLabel}`}>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-white/20 to-white/5 text-xs font-semibold text-white ring-1 ring-white/15">
                {initials}
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-sidebar ring-2 ring-sidebar">
                <RoleIcon className="h-2.5 w-2.5 text-sidebar-muted" />
              </span>
            </div>
            {showLabels && (
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-white" data-testid="text-user-name">{user.name}</p>
                <p className="truncate text-[11px] text-sidebar-muted" data-testid="text-user-role">{roleLabel}</p>
              </div>
            )}
            <div className={`flex shrink-0 ${showLabels ? "" : "flex-col"}`}>
              <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-sidebar-muted hover:bg-sidebar-accent hover:text-white" onClick={() => setShowPassword(true)} title="Change password" data-testid="button-change-password-open">
                <KeyRound className="h-4 w-4" />
              </button>
              <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-sidebar-muted hover:bg-sidebar-accent hover:text-white disabled:opacity-50" onClick={() => logoutMutation.mutate()} disabled={logoutMutation.isPending} title="Sign out" data-testid="button-logout">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={`flex h-9 w-full items-center ${showLabels ? "gap-2 px-2.5" : "justify-center"} rounded-lg text-sm font-medium text-sidebar-muted hover:bg-sidebar-accent hover:text-white`} onClick={() => setShowLoginModal(true)} title="Sign in">
            <LogIn className="h-4 w-4" />
            {showLabels && <span>Sign in</span>}
          </button>
        )}
      </div>

      <LoginModal isOpen={showLoginModal} onClose={() => setShowLoginModal(false)} onLoginSuccess={() => setShowLoginModal(false)} />
      <ChangePasswordDialog isOpen={showPassword} onClose={() => setShowPassword(false)} />
    </>
  );

  return (
    <>
      {/* Desktop column */}
      <aside className={`hidden md:flex ${collapsed ? "w-[68px]" : "w-64"} shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200`} data-testid="sidebar">
        {body}
      </aside>
      {/* Phone drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-foreground/50 backdrop-blur-[2px] dark:bg-black/70" onClick={onMobileClose} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-sidebar text-sidebar-foreground shadow-apple-xl">
            {body}
          </aside>
        </div>
      )}
    </>
  );
}

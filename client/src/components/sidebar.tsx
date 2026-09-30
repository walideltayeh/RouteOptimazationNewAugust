import { Link, useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useState } from "react";
import { 
  BarChart3, 
  Upload, 
  Settings, 
  Calendar, 
  Map, 
  FileText,
  Route,
  CalendarDays,
  FlaskConical,
  Users,
  LogIn,
  LogOut,
  Shield,
  KeyRound,
  Pencil,
  Eye
} from "lucide-react";
import { Button } from "@/components/ui/button";
import LoginModal from "@/components/login-modal";
import ChangePasswordDialog from "@/components/change-password-dialog";
import { useAuth } from "@/hooks/use-auth";
import pinLogo from "@assets/image_1769535972472.png";

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
  // Accounts is an admin's page; nobody else sees the link.
  const items = isAdmin ? [...navigation, { name: "Accounts", href: "/users", icon: Users }] : navigation;
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
  const body = (
    <>
      <div className={`${showLabels ? "p-5 pb-3" : "p-3 pb-2"}`}>
        <div className="flex items-center">
          <img src={pinLogo} alt="RouteOptima" className={`${showLabels ? "h-11 w-11" : "h-9 w-9"} object-contain`} />
          {showLabels && (
            <div className="ml-3">
              <h1 className="text-lg font-semibold text-[#1d1d1f] dark:text-white tracking-tight">RouteOptima</h1>
              <p className="text-xs text-[#86868b] dark:text-[#98989d]">Route Optimizer</p>
            </div>
          )}
        </div>
      </div>

      <nav className={`flex-1 ${showLabels ? "px-3" : "px-2"}`}>
        <div className="space-y-1">
          {items.map((item) => {
            const Icon = item.icon;
            const isActive = location === item.href;
            return (
              <Link
                key={item.name}
                href={item.href}
                title={item.name}
                onClick={onMobileClose}
                className={`group flex items-center ${showLabels ? "px-4" : "justify-center px-0"} py-2.5 text-sm font-medium rounded-full transition-all duration-200
                  ${isActive ? 'bg-[#1d1d1f] text-white shadow-sm' : 'text-[#1d1d1f] dark:text-[#f5f5f7] hover:bg-[#e8e8ed] dark:hover:bg-[#2c2c2e]'}`}
                data-testid={`nav-${item.href === '/' ? 'dashboard' : item.href.slice(1)}`}
              >
                <Icon className={`${showLabels ? "mr-3" : ""} h-5 w-5 flex-shrink-0 ${isActive ? 'text-white' : 'text-[#86868b] group-hover:text-[#1d1d1f] dark:group-hover:text-white'}`} />
                {showLabels && item.name}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className={`${showLabels ? "p-4 mx-3" : "p-2 mx-2"} mb-3 rounded-2xl bg-white dark:bg-[#2c2c2e] shadow-apple`}>
        {user ? (
          <div className={`flex items-center ${showLabels ? "justify-between" : "justify-center"}`}>
            <div className="flex min-w-0 items-center">
              <div className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center shadow-sm ${user.role === "admin" ? "bg-gradient-to-br from-green-500 to-green-600" : user.role === "planner" ? "bg-gradient-to-br from-blue-500 to-blue-600" : "bg-gradient-to-br from-gray-400 to-gray-500"}`} title={`${user.name} - ${roleLabel}`}>
                <RoleIcon className="h-4 w-4 text-white" />
              </div>
              {showLabels && (
                <div className="ml-3 min-w-0">
                  <p className="truncate text-sm font-medium text-[#1d1d1f] dark:text-white" data-testid="text-user-name">{user.name}</p>
                  <p className="text-xs text-[#86868b]" data-testid="text-user-role">{roleLabel}</p>
                </div>
              )}
            </div>
            {showLabels && (
              <div className="flex shrink-0">
                <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-[#f5f5f7] dark:hover:bg-[#3a3a3c]" onClick={() => setShowPassword(true)} title="Change password" data-testid="button-change-password-open">
                  <KeyRound className="h-4 w-4 text-[#86868b]" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-[#f5f5f7] dark:hover:bg-[#3a3a3c]" onClick={() => logoutMutation.mutate()} disabled={logoutMutation.isPending} title="Sign out" data-testid="button-logout">
                  <LogOut className="h-4 w-4 text-[#86868b]" />
                </Button>
              </div>
            )}
          </div>
        ) : (
          <Button variant="ghost" className={`${showLabels ? "w-full justify-start" : "w-full justify-center px-0"} h-10 text-[#1d1d1f] dark:text-white hover:bg-[#f5f5f7] dark:hover:bg-[#3a3a3c]`} onClick={() => setShowLoginModal(true)} title="Admin login">
            <LogIn className={`${showLabels ? "mr-2" : ""} h-4 w-4 text-[#86868b]`} />
            {showLabels && <span className="text-sm font-medium">Admin Login</span>}
          </Button>
        )}
      </div>

      <LoginModal isOpen={showLoginModal} onClose={() => setShowLoginModal(false)} onLoginSuccess={() => setShowLoginModal(false)} />
      <ChangePasswordDialog isOpen={showPassword} onClose={() => setShowPassword(false)} />
    </>
  );

  return (
    <>
      {/* Desktop column */}
      <aside className={`hidden md:flex ${collapsed ? "w-[68px]" : "w-64"} shrink-0 flex-col border-r border-[#e5e5e5] bg-[#fafafa] transition-[width] duration-200 dark:border-[#38383a] dark:bg-[#1c1c1e]`} data-testid="sidebar">
        {body}
      </aside>
      {/* Phone drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={onMobileClose} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-[#fafafa] shadow-xl dark:bg-[#1c1c1e]">
            {body}
          </aside>
        </div>
      )}
    </>
  );
}

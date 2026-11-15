import { lazy, Suspense, useEffect, useState } from "react";
import { Switch, Route, Router } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "@/components/sidebar";
import NotFound from "@/pages/not-found";
import ChangePasswordDialog from "@/components/change-password-dialog";
import LoginModal from "@/components/login-modal";
import PersistenceBanner from "@/components/persistence-banner";
import AppHeader from "@/components/app-header";
import BrandMark from "@/components/brand-mark";
import { useAuth } from "@/hooks/use-auth";

// Each screen loads when it is opened. The maps bring the map library with
// them (most of the app's weight), so signing in and the dashboard no longer
// wait for it, and the landing page is not shipped to someone signed in.
const Dashboard = lazy(() => import("@/pages/dashboard"));
const TerritoriesPage = lazy(() => import("@/pages/territories"));
const RepMapPage = lazy(() => import("@/pages/rep-map"));
const SchedulesPage = lazy(() => import("@/pages/schedules"));
const ScenariosPage = lazy(() => import("@/pages/scenarios"));
const UsersPage = lazy(() => import("@/pages/users"));
const RouteSheetsPage = lazy(() => import("@/pages/route-sheets"));
const LandingPage = lazy(() => import("@/components/landing-page"));

function ScreenLoading() {
  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center" data-testid="screen-loading">
      <BrandMark className="h-9 w-9 animate-pulse" />
    </div>
  );
}

function AppContent() {
  const { isAuthenticated, isLoading, refetch, user } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => { try { return localStorage.getItem("sidebar:collapsed") === "1"; } catch { return false; } });
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { try { localStorage.setItem("sidebar:collapsed", collapsed ? "1" : "0"); } catch {} }, [collapsed]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <BrandMark className="h-10 w-10 animate-pulse" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <>
        <Suspense fallback={<div className="min-h-screen bg-background"><ScreenLoading /></div>}>
          <LandingPage onAdminLogin={() => setShowLogin(true)} />
        </Suspense>
        <LoginModal
          isOpen={showLogin}
          onClose={() => setShowLogin(false)}
          onLoginSuccess={() => { setShowLogin(false); refetch(); }}
        />
      </>
    );
  }

  return (
    <div className="app-shell flex h-screen bg-background">
      <Sidebar collapsed={collapsed} mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader collapsed={collapsed} onToggleCollapsed={() => setCollapsed(v => !v)} onOpenMobile={() => setMobileOpen(true)} />
        <PersistenceBanner />
        <main className="app-main min-h-0 flex-1 overflow-auto">
        <Suspense fallback={<ScreenLoading />}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/territories" component={TerritoriesPage} />
          <Route path="/rep-map" component={RepMapPage} />
          <Route path="/schedules" component={SchedulesPage} />
          <Route path="/route-sheets" component={RouteSheetsPage} />
          <Route path="/scenarios" component={ScenariosPage} />
          <Route path="/users" component={UsersPage} />
          <Route component={NotFound} />
        </Switch>
        </Suspense>
        </main>
        {/* A password an admin set has to be replaced before anything else. */}
        <ChangePasswordDialog isOpen={!!user?.mustChangePassword} onClose={() => {}} required />
      </div>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router>
          <AppContent />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

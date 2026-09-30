import { useEffect, useState } from "react";
import { Switch, Route, Router } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "@/components/sidebar";
import Dashboard from "@/pages/dashboard";
import TerritoriesPage from "@/pages/territories";
import RepMapPage from "@/pages/rep-map";
import SchedulesPage from "@/pages/schedules";
import ScenariosPage from "@/pages/scenarios";
import NotFound from "@/pages/not-found";
import UsersPage from "@/pages/users";
import ChangePasswordDialog from "@/components/change-password-dialog";
import LandingPage from "@/components/landing-page";
import LoginModal from "@/components/login-modal";
import PersistenceBanner from "@/components/persistence-banner";
import AppHeader from "@/components/app-header";
import { useAuth } from "@/hooks/use-auth";

function AppContent() {
  const { isAuthenticated, isLoading, refetch, user } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => { try { return localStorage.getItem("sidebar:collapsed") === "1"; } catch { return false; } });
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { try { localStorage.setItem("sidebar:collapsed", collapsed ? "1" : "0"); } catch {} }, [collapsed]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="animate-pulse text-[#8B0000] text-xl font-semibold">RouteOptima</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <>
        <LandingPage onAdminLogin={() => setShowLogin(true)} />
        <LoginModal
          isOpen={showLogin}
          onClose={() => setShowLogin(false)}
          onLoginSuccess={() => { setShowLogin(false); refetch(); }}
        />
      </>
    );
  }

  return (
    <div className="flex h-screen bg-[#f5f5f7] dark:bg-black">
      <Sidebar collapsed={collapsed} mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader collapsed={collapsed} onToggleCollapsed={() => setCollapsed(v => !v)} onOpenMobile={() => setMobileOpen(true)} />
        <PersistenceBanner />
        <main className="min-h-0 flex-1 overflow-auto">
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/territories" component={TerritoriesPage} />
          <Route path="/rep-map" component={RepMapPage} />
          <Route path="/schedules" component={SchedulesPage} />
          <Route path="/scenarios" component={ScenariosPage} />
          <Route path="/users" component={UsersPage} />
          <Route component={NotFound} />
        </Switch>
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

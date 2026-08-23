import { useState } from "react";
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
import LandingPage from "@/components/landing-page";
import LoginModal from "@/components/login-modal";
import { useAuth } from "@/hooks/use-auth";

function AppContent() {
  const { isAuthenticated, isLoading, refetch } = useAuth();
  const [showLogin, setShowLogin] = useState(false);

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
    <div className="flex h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/territories" component={TerritoriesPage} />
          <Route path="/rep-map" component={RepMapPage} />
          <Route path="/schedules" component={SchedulesPage} />
          <Route path="/scenarios" component={ScenariosPage} />
          <Route component={NotFound} />
        </Switch>
      </main>
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

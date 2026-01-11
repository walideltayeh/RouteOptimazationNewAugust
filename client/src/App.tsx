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
import VehiclesPage from "@/pages/vehicles";
import VehicleDetailPage from "@/pages/vehicle-detail";
import NotFound from "@/pages/not-found";
import TrialOnboarding from "@/components/trial-onboarding";
import TrialBanner from "@/components/trial-banner";
import UpgradeModal from "@/components/upgrade-modal";
import { useTrial } from "@/hooks/use-trial";

function AppContent() {
  const { needsOnboarding, isTrialActive, isLoading, refetch, status } = useTrial();
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [onboardingComplete, setOnboardingComplete] = useState(false);

  const handleOnboardingComplete = () => {
    setOnboardingComplete(true);
    refetch();
  };

  const showOnboarding = needsOnboarding && !onboardingComplete && !isLoading;

  return (
    <>
      <TrialOnboarding 
        open={showOnboarding} 
        onComplete={handleOnboardingComplete} 
      />
      
      {isTrialActive && (
        <TrialBanner onUpgradeClick={() => setShowUpgradeModal(true)} />
      )}
      
      <UpgradeModal 
        isOpen={showUpgradeModal} 
        onClose={() => setShowUpgradeModal(false)}
        limitType="outlet"
        currentCount={status?.outletCount ?? 0}
        maxCount={status?.outletLimit ?? 100}
      />
      
      <div className={`flex h-screen bg-gray-50 ${isTrialActive ? 'pt-12' : ''}`}>
        <Sidebar />
        <main className="flex-1 overflow-auto">
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/territories" component={TerritoriesPage} />
            <Route path="/rep-map" component={RepMapPage} />
            <Route path="/vehicles" component={VehiclesPage} />
            <Route path="/vehicles/:id" component={VehicleDetailPage} />
            <Route component={NotFound} />
          </Switch>
        </main>
      </div>
    </>
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

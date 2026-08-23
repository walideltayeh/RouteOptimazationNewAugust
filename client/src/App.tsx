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
import TrialOnboarding from "@/components/trial-onboarding";
import TrialBanner from "@/components/trial-banner";
import UpgradeModal from "@/components/upgrade-modal";
import LoginModal from "@/components/login-modal";
import { useTrial } from "@/hooks/use-trial";

function AppContent() {
  const { needsOnboarding, isTrialActive, isLoading, refetch, status } = useTrial();
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [showLanding, setShowLanding] = useState(true);
  const [showTrialOnboarding, setShowTrialOnboarding] = useState(false);
  const [showAdminLogin, setShowAdminLogin] = useState(false);

  const handleOnboardingComplete = () => {
    setOnboardingComplete(true);
    setShowTrialOnboarding(false);
    setShowLanding(false);
    refetch();
  };

  const handleStartTrial = () => {
    setShowLanding(false);
    setShowTrialOnboarding(true);
  };

  const handleAdminLogin = () => {
    setShowAdminLogin(true);
  };

  const handleAdminLoginSuccess = () => {
    setShowAdminLogin(false);
    setShowLanding(false);
    setOnboardingComplete(true);
    refetch();
  };

  const showOnboarding = (needsOnboarding && !onboardingComplete && !isLoading) || showTrialOnboarding;

  // Show loading state while checking trial status to prevent flicker
  if (isLoading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="animate-pulse text-[#8B0000] text-xl font-semibold">RouteOptima</div>
      </div>
    );
  }

  if (showLanding && needsOnboarding) {
    return (
      <>
        <LandingPage 
          onStartTrial={handleStartTrial}
          onAdminLogin={handleAdminLogin}
        />
        <LoginModal 
          isOpen={showAdminLogin}
          onClose={() => setShowAdminLogin(false)}
          onLoginSuccess={handleAdminLoginSuccess}
        />
      </>
    );
  }

  return (
    <>
      <TrialOnboarding 
        open={showOnboarding && !showLanding} 
        onComplete={handleOnboardingComplete}
        onClose={() => { setShowTrialOnboarding(false); setShowLanding(true); }}
        skipWelcome={showTrialOnboarding}
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
            <Route path="/schedules" component={SchedulesPage} />
            <Route path="/scenarios" component={ScenariosPage} />
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

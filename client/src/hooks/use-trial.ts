import { useQuery } from "@tanstack/react-query";
import type { TrialStatus } from "@shared/schema";

export function useTrial() {
  const { data: status, isLoading, refetch } = useQuery<TrialStatus>({
    queryKey: ["/api/trial/status"],
  });

  const isTrialActive = status?.isTrialMode && !status?.isExpired && !status?.isBlocked;
  const needsOnboarding = !status?.isTrialMode;
  const canAddOutlet = (status?.outletsRemaining ?? 0) > 0;
  const canAddVehicle = (status?.vehiclesRemaining ?? 0) > 0;

  return {
    status,
    isLoading,
    isTrialActive,
    needsOnboarding,
    canAddOutlet,
    canAddVehicle,
    refetch,
  };
}

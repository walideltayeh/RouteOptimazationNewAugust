import { useQuery } from "@tanstack/react-query";

interface AuthStatus {
  isAuthenticated: boolean;
  isSuperuser: boolean;
}

export function useAuth() {
  const { data, isLoading, refetch } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });
  return { isAuthenticated: !!data?.isAuthenticated, isLoading, refetch };
}

import { useQuery } from "@tanstack/react-query";

export type Role = "admin" | "planner" | "viewer";
export interface AuthUser { id: string; email: string; name: string; role: Role; isActive: boolean; createdAt: string; lastLoginAt: string | null; mustChangePassword: boolean }
export interface AuthStatus {
  isAuthenticated: boolean;
  isSuperuser: boolean;
  canEdit: boolean;
  user: AuthUser | null;
  setupRequired: boolean;
  adminConfigured: boolean;
}

export function useAuth() {
  const { data, isLoading, refetch } = useQuery<AuthStatus>({ queryKey: ["/api/auth/status"] });
  return {
    isAuthenticated: !!data?.isAuthenticated,
    isLoading,
    refetch,
    user: data?.user ?? null,
    role: data?.user?.role,
    isAdmin: data?.user?.role === "admin",
    canEdit: !!data?.canEdit,
    setupRequired: !!data?.setupRequired,
  };
}

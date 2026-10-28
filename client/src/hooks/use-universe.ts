import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { saveResponseAsFile } from "@/lib/download";

export interface UniverseState {
  fileName: string | null;
  baseName: string;
  outlets: number;
  editsSinceSave: number;
  nextVersion: number;
  nextFileName: string;
  lastSaved: { fileName: string; version: number; at: string; outlets: number } | null;
}

// Under the "/api/outlets" key, so every outlet edit that refreshes the
// outlet list refreshes the unsaved-edit count with it.
export const UNIVERSE_KEY = ["/api/outlets", "universe"] as const;

export function useUniverse(enabled = true) {
  return useQuery<UniverseState>({
    queryKey: UNIVERSE_KEY,
    enabled,
    queryFn: async () => {
      const res = await fetch("/api/universe", { credentials: "include" });
      if (!res.ok) throw new Error("Could not read the universe");
      return res.json();
    },
  });
}

/** Save the universe as "<file> Universe Edited v.N.xlsx" and download it. */
export function useSaveUniverse() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fallbackName: string) => {
      const res = await apiRequest("POST", "/api/universe/save");
      return saveResponseAsFile(res, fallbackName);
    },
    onSuccess: (name) => {
      queryClient.invalidateQueries({ queryKey: UNIVERSE_KEY });
      toast({ title: "Universe saved", description: name });
    },
    onError: (e: Error) => toast({ title: "Could not save the universe", description: e.message, variant: "destructive" }),
  });
}

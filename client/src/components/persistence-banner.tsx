import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, X } from "lucide-react";

type Health = { instance: string; startedAt: string; persistence: string; outlets: number; env: string };

/**
 * Tells the user when the server cannot keep their changes.
 *
 * Symptoms this explains: an outlet "moves" but the map does not change, a
 * deleted duplicate comes back, the site opens on a months-old file. On a
 * Replit Autoscale deployment without a database every instance holds its
 * own copy of the data; a write lands on one, the next read is answered by
 * another, and the state is wiped whenever an instance restarts. The health
 * endpoint says which instance answered and where the state lives, and this
 * banner watches for more than one instance or for disk-only storage.
 */
export default function PersistenceBanner() {
  const [dismissed, setDismissed] = useState(false);
  const seen = useRef(new Set<string>());
  const [instanceCount, setInstanceCount] = useState(0);

  const { data } = useQuery<Health>({
    queryKey: ["/api/health"],
    queryFn: async () => {
      const res = await fetch("/api/health", { credentials: "include" });
      if (!res.ok) throw new Error("health check failed");
      const body = (await res.json()) as Health;
      const header = res.headers.get("X-App-Instance");
      if (header) body.instance = header;
      return body;
    },
    refetchInterval: 20_000,
    staleTime: 0,
    retry: false,
  });

  useEffect(() => {
    if (!data?.instance) return;
    if (!seen.current.has(data.instance)) {
      seen.current.add(data.instance);
      setInstanceCount(seen.current.size);
    }
  }, [data?.instance]);

  if (!data || dismissed) return null;
  const deployed = import.meta.env.PROD && !/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const multi = instanceCount > 1;
  const diskOnly = data.persistence !== "postgres";
  if (!multi && !(deployed && diskOnly)) return null;

  const failed = data.persistence === "disk-postgres-failed";
  return (
    <div
      className={`flex items-start gap-3 border-b px-4 py-2 text-sm ${multi ? "border-red-200 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}
      data-testid="persistence-banner"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
      <div className="flex-1">
        {multi ? (
          <p>
            <strong>{instanceCount} different server instances</strong> have answered this page since it opened, and they do not share a database.
            A change saved on one instance is invisible to the others: that is why a move or a delete can be confirmed and then not show on the map, and why old data comes back.
          </p>
        ) : (
          <p>
            <strong>This server keeps the app&apos;s data on its own disk</strong>{failed ? " because the database connection failed" : " (no DATABASE_URL)"}.
            On Replit Autoscale that data is lost on every restart and is not shared between instances.
          </p>
        )}
        <p className="mt-1 text-xs opacity-90">
          Fix: in Replit open Tools → Database, create a PostgreSQL database, make sure <code>DATABASE_URL</code> is available to the deployment (Deployments → Settings → Secrets), then redeploy. The deploy log should say “[persist] Using Postgres for app state”.
          {" "}Instance {data.instance}, {data.outlets.toLocaleString()} outlets loaded.
        </p>
      </div>
      <button type="button" className="rounded p-1 hover:bg-black/5" onClick={() => setDismissed(true)} aria-label="Dismiss">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

import { spawn } from "child_process";
import path from "path";
import type { Outlet } from "@shared/schema";

/**
 * Bridge to the OR-Tools grouping solver (server/balanced_assign.py).
 *
 * Grouping outlets into territories or day-routes is a capacitated clustering
 * problem. Every heuristic version of it placed outlets one at a time and never
 * reconsidered, which left a "leftover" group holding whatever the others had
 * no room for. Given centres, the assignment is a transportation problem that
 * min-cost flow solves exactly, so nothing is stranded by the order of
 * placement.
 *
 * The solver is optional. If Python or ortools is missing, or it takes too long
 * or returns anything unexpected, this returns null and the caller falls back to
 * the built-in partitioner. A plan that is merely good always beats no plan.
 */

const SOLVER = path.join(process.cwd(), "server", "balanced_assign.py");
const TIMEOUT_MS = 60_000;

let solverAvailable: boolean | null = null;

export function solverStatus(): boolean | null {
  return solverAvailable;
}

export async function solveBalancedGroups(
  outlets: Outlet[],
  k: number,
  /** Relative weight per outlet; must be a positive integer (flow is integral). */
  weightFn: (o: Outlet) => number,
  tolerance: number = 0.06,
): Promise<Outlet[][] | null> {
  if (k <= 1 || outlets.length <= k) return null;
  if (solverAvailable === false) return null;

  const payload = JSON.stringify({
    points: outlets.map(o => [o.latitude, o.longitude]),
    weights: outlets.map(o => Math.max(1, Math.round(weightFn(o)))),
    k,
    tolerance,
    iterations: 12,
  });

  const result = await new Promise<string | null>(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("python3", [SOLVER]);
    } catch {
      resolve(null);
      return;
    }
    let out = "", err = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(null); }, TIMEOUT_MS);

    child.stdout?.on("data", d => { out += d; });
    child.stderr?.on("data", d => { err += d; });
    child.on("error", () => { clearTimeout(timer); finish(null); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        if (solverAvailable === null) {
          console.warn(`[solver] OR-Tools unavailable, using the built-in partitioner. ${err.trim().split("\n").pop() || ""}`);
        }
        finish(null);
        return;
      }
      finish(out);
    });
    child.stdin?.on("error", () => { /* closed early; the close handler reports */ });
    child.stdin?.write(payload);
    child.stdin?.end();
  });

  if (result === null) { solverAvailable = false; return null; }

  try {
    const parsed = JSON.parse(result) as { groups?: number[]; error?: string };
    if (parsed.error || !Array.isArray(parsed.groups) || parsed.groups.length !== outlets.length) {
      solverAvailable = false;
      return null;
    }
    const groups: Outlet[][] = Array.from({ length: k }, () => []);
    parsed.groups.forEach((g, i) => {
      groups[g >= 0 && g < k ? g : 0].push(outlets[i]);
    });
    // A solver run that loses or duplicates an outlet is worse than no solver.
    const placed = groups.reduce((s, g) => s + g.length, 0);
    if (placed !== outlets.length) { solverAvailable = false; return null; }
    solverAvailable = true;
    return groups;
  } catch {
    solverAvailable = false;
    return null;
  }
}

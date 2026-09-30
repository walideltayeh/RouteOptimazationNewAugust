import { randomUUID } from "crypto";

/**
 * Background jobs for the long-running work: a full optimization on 9,000
 * outlets runs for minutes, and a request that long is cut off by most
 * hosting proxies. The HTTP handler now only starts the job and answers
 * 202 with an id; the work carries on here, the page polls /api/jobs/:id,
 * and a reload or another page picks the same job up from /api/jobs/active.
 *
 * Jobs live in this process's memory. On a deployment with several
 * instances a poll can land on an instance that never saw the job; the
 * persistence banner already flags that setup, and it needs the shared
 * database fixed before anything else does.
 */
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobProgress { percent: number; stage: string; detail: string }

export interface Job {
  id: string;
  kind: string;
  status: JobStatus;
  progress: JobProgress;
  /** The handler's JSON reply, once done (also on a 4xx it chose to send). */
  result?: unknown;
  statusCode?: number;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export type JobRunner = (report: (p: Partial<JobProgress>) => void) => Promise<{ statusCode: number; body: unknown }>;

const KEEP = 50;

class JobManager {
  private jobs = new Map<string, Job>();

  /** The job currently running or queued, if any. Only one runs at a time. */
  active(): Job | undefined {
    for (const j of Array.from(this.jobs.values())) if (j.status === "queued" || j.status === "running") return j;
    return undefined;
  }

  get(id: string): Job | undefined { return this.jobs.get(id); }

  list(limit = 20): Job[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  start(kind: string, runner: JobRunner): Job {
    const job: Job = {
      id: randomUUID(),
      kind,
      status: "queued",
      progress: { percent: 0, stage: "Queued", detail: "Starting…" },
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.trim();
    const report = (p: Partial<JobProgress>) => { job.progress = { ...job.progress, ...p }; };
    setImmediate(async () => {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      try {
        const { statusCode, body } = await runner(report);
        job.statusCode = statusCode;
        job.result = body;
        if (statusCode >= 400) {
          job.status = "failed";
          job.error = (body as any)?.message || `Failed with status ${statusCode}`;
          job.progress = { ...job.progress, stage: "Failed", detail: job.error! };
        } else {
          job.status = "done";
          job.progress = { percent: 100, stage: "Complete", detail: (body as any)?.message || "Finished" };
        }
      } catch (err) {
        job.status = "failed";
        job.error = (err as Error)?.message || String(err);
        job.progress = { ...job.progress, stage: "Failed", detail: job.error };
        console.error(`[jobs] ${kind} ${job.id} failed:`, err);
      } finally {
        job.finishedAt = new Date().toISOString();
      }
    });
    return job;
  }

  private trim() {
    if (this.jobs.size <= KEEP) return;
    const finished = Array.from(this.jobs.values())
      .filter(j => j.status === "done" || j.status === "failed")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const j of finished.slice(0, this.jobs.size - KEEP)) this.jobs.delete(j.id);
  }
}

export const jobs = new JobManager();

/**
 * Lets an existing (req, res) handler run as a job: it writes its reply
 * into this stand-in instead of a socket, and the job stores it.
 */
export function captureResponse() {
  const state = { code: 200, payload: undefined as unknown, sent: false };
  const res: any = {
    status(c: number) { state.code = c; return res; },
    json(p: unknown) { state.payload = p; state.sent = true; return res; },
    send(p: unknown) { state.payload = p; state.sent = true; return res; },
    setHeader() { return res; },
    get headersSent() { return state.sent; },
    on() { return res; },
  };
  return { res, state };
}

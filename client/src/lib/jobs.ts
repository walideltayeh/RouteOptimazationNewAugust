import { apiRequest } from "./queryClient";

export type JobStatus = "queued" | "running" | "done" | "failed";
export interface JobProgress { percent: number; stage: string; detail: string }
export interface Job<T = any> {
  id: string; kind: string; status: JobStatus; progress: JobProgress;
  result?: T; statusCode?: number; error?: string;
  createdAt: string; startedAt?: string; finishedAt?: string;
}

/** POST to a job-backed endpoint; the server answers 202 with the job. */
export async function startJob(url: string, body?: unknown): Promise<Job> {
  const res = await apiRequest("POST", url, body ?? {});
  const data = await res.json();
  if (!data?.jobId) throw new Error("The server did not start a background job");
  return { id: data.jobId, kind: data.kind, status: "queued", progress: { percent: 0, stage: "Queued", detail: "" }, createdAt: new Date().toISOString() };
}

export async function fetchJob<T = any>(id: string): Promise<Job<T>> {
  const res = await fetch(`/api/jobs/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(`Job ${id} not found`);
  return res.json();
}

/** Poll until the job finishes; resolves with the handler's result. */
export async function waitForJob<T = any>(id: string, onProgress?: (p: JobProgress) => void, intervalMs = 1000): Promise<T> {
  for (;;) {
    const job = await fetchJob<T>(id);
    onProgress?.(job.progress);
    if (job.status === "done") return job.result as T;
    if (job.status === "failed") throw new Error(job.error || "The job failed");
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

/** Start and wait: the drop-in for what used to be one long request. */
export async function runJob<T = any>(url: string, body?: unknown, onProgress?: (p: JobProgress) => void): Promise<T> {
  const job = await startJob(url, body);
  return waitForJob<T>(job.id, onProgress);
}

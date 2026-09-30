import { describe, it, expect } from "vitest";
import { jobs, captureResponse } from "../server/jobs";

const tick = () => new Promise(r => setTimeout(r, 15));
const settled = async (id: string) => {
  for (let i = 0; i < 200; i++) {
    const j = jobs.get(id)!;
    if (j.status === "done" || j.status === "failed") return j;
    await tick();
  }
  throw new Error("job never settled");
};

describe("background jobs", () => {
  it("runs the work detached and records the handler's reply", async () => {
    const job = jobs.start("optimize", async (report) => {
      report({ percent: 50, stage: "Halfway", detail: "" });
      return { statusCode: 200, body: { message: "ok", reps: 3 } };
    });
    expect(job.status).toBe("queued");
    expect(jobs.active()?.id).toBe(job.id);
    const done = await settled(job.id);
    expect(done.status).toBe("done");
    expect(done.result).toEqual({ message: "ok", reps: 3 });
    expect(done.progress.percent).toBe(100);
    expect(jobs.active()).toBeUndefined();
  });

  it("marks a 4xx reply as failed with the server's message", async () => {
    const job = jobs.start("optimize", async () => ({ statusCode: 400, body: { message: "No outlets" } }));
    const done = await settled(job.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("No outlets");
  });

  it("marks a thrown error as failed", async () => {
    const job = jobs.start("reoptimize", async () => { throw new Error("boom"); });
    const done = await settled(job.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("boom");
  });

  it("captures a handler's res.status().json() reply", () => {
    const { res, state } = captureResponse();
    res.status(404).json({ message: "gone" });
    expect(state.code).toBe(404);
    expect(state.payload).toEqual({ message: "gone" });
    expect(res.headersSent).toBe(true);
  });

  it("lists newest first", async () => {
    const a = jobs.start("optimize", async () => ({ statusCode: 200, body: {} }));
    await settled(a.id);
    expect(jobs.list(1)[0].id).toBe(a.id);
  });
});

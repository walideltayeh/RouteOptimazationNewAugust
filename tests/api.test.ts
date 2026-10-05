import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server } from "http";

/**
 * The app end to end on a free port with a temp data directory: first-run
 * setup, roles, upload, a background optimization, exports, and the
 * duplicate scan. Runs the real Express routes, not mocks.
 */
let server: Server;
let base = "";
const jars = new Map<string, string>();

async function call(who: string, method: string, url: string, body?: unknown, raw?: BodyInit) {
  const headers: Record<string, string> = {};
  if (jars.get(who)) headers.cookie = jars.get(who)!;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + url, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) jars.set(who, setCookie.split(";")[0]);
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : type.includes("spreadsheet") ? await res.arrayBuffer() : await res.text();
  return { status: res.status, data };
}

function sampleCsv(n = 120) {
  const lines = ["Outlet Code,Outlet Name,Address,Latitude,Longitude,Visit Frequency"];
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  for (let i = 0; i < n; i++) {
    // Three tight neighbourhoods a few km apart, so days cut cleanly.
    const c = i % 3;
    const lat = 33.50 + c * 0.03 + (rnd() - 0.5) * 0.012;
    const lng = 36.28 + c * 0.03 + (rnd() - 0.5) * 0.012;
    lines.push(`C${String(i).padStart(4, "0")},Outlet ${i},Damascus,${lat.toFixed(6)},${lng.toFixed(6)},${i % 5 === 0 ? 1 : 2}`);
  }
  // Two exact duplicates of outlet 3 (same spot, one Arabic-style variant name).
  const dup = lines[4].split(",");
  lines.push(`C9001,${dup[1]},Damascus,${dup[3]},${dup[4]},2`);
  lines.push(`C9002,${dup[1]} 2,Damascus,${dup[3]},${dup[4]},2`);
  return lines.join("\n");
}

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ro-api-"));
  process.env.NODE_ENV = "test";
  delete process.env.DATABASE_URL;
  delete process.env.SUPERUSER_EMAIL;
  delete process.env.SUPERUSER_PASSWORD;
  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const { storage } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  await storage.ready;
  app.get("/api/health", async (_req, res) => res.json({ instance: "test", persistence: "disk", outlets: (await storage.getOutlets()).length }));
  server = await registerRoutes(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe("first run and sign-in", () => {
  it("refuses everything until someone signs in, except health and status", async () => {
    expect((await call("anon", "GET", "/api/outlets")).status).toBe(401);
    expect((await call("anon", "GET", "/api/health")).status).toBe(200);
    const status = await call("anon", "GET", "/api/auth/status");
    expect(status.data.setupRequired).toBe(true);
  });
  it("the first visitor creates the admin, and only once", async () => {
    const r = await call("admin", "POST", "/api/auth/setup", { email: "owner@co.com", name: "Owner", password: "owner-pass-1" });
    expect(r.status).toBe(200);
    expect(r.data.user.role).toBe("admin");
    expect((await call("anon", "POST", "/api/auth/setup", { email: "x@co.com", name: "X", password: "xxxxxxxx" })).status).toBe(403);
    const status = await call("admin", "GET", "/api/auth/status");
    expect(status.data.user.email).toBe("owner@co.com");
    expect(status.data.canEdit).toBe(true);
  });
  it("admin adds a planner and a viewer; roles are enforced", async () => {
    expect((await call("admin", "POST", "/api/users", { email: "plan@co.com", name: "Planner", role: "planner", password: "planner-pass" })).status).toBe(201);
    expect((await call("admin", "POST", "/api/users", { email: "view@co.com", name: "Viewer", role: "viewer", password: "viewer-pass1" })).status).toBe(201);
    expect((await call("planner", "POST", "/api/auth/login", { email: "plan@co.com", password: "planner-pass" })).status).toBe(200);
    expect((await call("viewer", "POST", "/api/auth/login", { email: "view@co.com", password: "viewer-pass1" })).status).toBe(200);
    expect((await call("planner", "GET", "/api/users")).status).toBe(403);
    expect((await call("viewer", "GET", "/api/outlets")).status).toBe(200);
    const denied = await call("viewer", "POST", "/api/outlets/delete-many", { outletIds: ["x"] });
    expect(denied.status).toBe(403);
    expect(denied.data.message).toMatch(/view-only/);
  });
  it("wrong password is refused and the message is plain", async () => {
    const r = await call("anon", "POST", "/api/auth/login", { email: "plan@co.com", password: "nope-nope" });
    expect(r.status).toBe(401);
    expect(r.data.message).toBe("Wrong email or password");
  });
});

describe("plan lifecycle", () => {
  it("a planner uploads a file", async () => {
    const form = new FormData();
    form.append("file", new Blob([sampleCsv()], { type: "text/csv" }), "outlets.csv");
    const r = await call("planner", "POST", "/api/upload", undefined, form);
    expect(r.status).toBe(200);
    expect(r.data.analysis.outlets).toBe(122);
    expect((await call("viewer", "GET", "/api/outlets")).data.length).toBe(122);
  });
  it("the duplicate scan finds the planted pair", async () => {
    const r = await call("planner", "GET", "/api/outlets/duplicates?radiusM=10");
    expect(r.status).toBe(200);
    const clusters: any[] = r.data.clusters;
    const planted = clusters.find(c => (c.members || []).some((o: any) => o.code === "C9001" || o.name === "Outlet 3"));
    expect(planted, JSON.stringify(clusters).slice(0, 300)).toBeTruthy();
  });
  it("optimizes as a background job and builds a plan on the saved settings", async () => {
    const body = { workingDays: [6, 7, 1, 2, 3, 4], workingDaysPerWeek: 6, cycleMode: "calendarMonth", planMonth: "2026-10", monthEdges: "wholeWeeks", cycleWorkingDays: 0, minVisitsPerDay: 8, maxVisitsPerDay: 12, weightMode: "isolation", distanceMode: "haversine", maxZoneRadiusKm: 30, maxHopKm: 4 };
    const started = await call("planner", "POST", "/api/optimize", body);
    expect(started.status).toBe(202);
    expect(started.data.jobId).toBeTruthy();
    expect((await call("planner", "POST", "/api/reoptimize", {})).status).toBe(409); // one at a time
    let job: any;
    for (let i = 0; i < 600; i++) {
      job = (await call("planner", "GET", `/api/jobs/${started.data.jobId}`)).data;
      if (job.status === "done" || job.status === "failed") break;
      await new Promise(r => setTimeout(r, 200));
    }
    expect(job.status, job.error).toBe("done");
    expect(job.result.success).toBe(true);
    expect(job.result.requiredReps).toBeGreaterThanOrEqual(1);
    expect((await call("planner", "GET", "/api/jobs/active")).data).toBeNull();

    const settings = (await call("viewer", "GET", "/api/plan-settings")).data;
    expect(settings.configured).toBe(true);
    expect(settings.planStart).toBe("2026-10-03");
    expect(settings.planEnd).toBe("2026-10-29");
    expect(settings.cycleDays).toBe(24);
    expect(settings.workingDayNames[0]).toBe("Saturday");

    const schedules: any[] = (await call("viewer", "GET", "/api/schedules")).data;
    const reps: any[] = (await call("viewer", "GET", "/api/reps")).data;
    expect(reps.length).toBe(job.result.requiredReps);
    expect(schedules.length).toBe(reps.length * 24);
    // Every outlet's visits match its frequency (VF1 once, VF2 twice a month).
    const outlets: any[] = (await call("viewer", "GET", "/api/outlets")).data;
    const visits = new Map<string, number>();
    for (const c of schedules) for (const id of c.outletIds) visits.set(id, (visits.get(id) ?? 0) + 1);
    for (const o of outlets) if (o.repId) expect(visits.get(o.id), o.name).toBe(o.visitFrequency);
    // Nobody left without a rep except held-out duplicates.
    expect(outlets.filter(o => !o.repId && o.territory !== "Excluded").length).toBe(0);
  });
  it("a viewer can export, a planner can move an outlet to a route and it sticks", async () => {
    const xlsx = await call("viewer", "GET", "/api/export/territories");
    expect(xlsx.status).toBe(200);
    expect((xlsx.data as ArrayBuffer).byteLength).toBeGreaterThan(5000);

    const schedules: any[] = (await call("planner", "GET", "/api/schedules")).data;
    const outlets: any[] = (await call("planner", "GET", "/api/outlets")).data;
    const outlet = outlets.find(o => o.repId && o.visitFrequency === 2)!;
    const target = schedules.find(c => !c.outletIds.includes(outlet.id) && c.outletIds.length > 0)!;
    const moved = await call("planner", "POST", `/api/outlets/${outlet.id}/move-to-route`, { repId: target.repId, week: target.week, dayOfWeek: target.dayOfWeek });
    expect(moved.status).toBe(200);
    expect(moved.data.to.length).toBe(2);
    expect(moved.data.to.every((c: any) => c.repId === target.repId && c.dayOfWeek === target.dayOfWeek)).toBe(true);
    const after: any[] = (await call("planner", "GET", "/api/schedules")).data;
    const cells = after.filter(c => c.outletIds.includes(outlet.id));
    expect(cells.length).toBe(2);
    expect(cells.every(c => c.repId === target.repId && c.dayOfWeek === target.dayOfWeek)).toBe(true);
    expect((await call("viewer", "POST", `/api/outlets/${outlet.id}/move-to-route`, { repId: target.repId, week: 1, dayOfWeek: 6 })).status).toBe(403);
  });
  it("the plan survives a restart of the routes on the same data directory", async () => {
    const before = (await call("viewer", "GET", "/api/schedules")).data.length;
    const { storage } = await import("../server/storage");
    await storage.flush();
    const snapshot = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR!, "storage-snapshot.json"), "utf-8"));
    expect(snapshot.schedules.length).toBe(before);
    expect(fs.existsSync(path.join(process.env.DATA_DIR!, "auth.json"))).toBe(true);
    expect(fs.existsSync(path.join(process.env.DATA_DIR!, "plan-settings.json"))).toBe(true);
  });
});

describe("upload of a planner's workbook", () => {
  it("reads the sheet that has coordinates, names the others, and says what it assumed", async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    // A summary sheet first, as planners' workbooks usually open.
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Rep", "Stores"], ["TDR1", 290]]), "Route Summary");
    const rows: (string | number)[][] = [["Client Code", "Name", "Latitude", "Longitude"]];
    for (let i = 0; i < 30; i++) rows.push([`K${i}`, `Shop ${i}`, 33.50 + (i % 6) * 0.004, 36.28 + Math.floor(i / 6) * 0.004]);
    rows.push(["K99", "Tripoli in Libya", 32.8872, 13.1913]); // a geocoding mistake
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Outlets");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Working Day", "Date"], [1, "2026-10-03"]]), "Calendar");
    const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const form = new FormData();
    form.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "plan.xlsx");
    const r = await call("planner", "POST", "/api/upload", undefined, form);
    expect(r.status).toBe(200);
    expect(r.data.report.sheetUsed).toBe("Outlets");
    expect(r.data.report.otherSheets).toEqual(["Route Summary", "Calendar"]);
    expect(r.data.report.validOutlets).toBe(31);
    expect(r.data.report.rowsUsingDefaultVf).toBe(31);
    expect(r.data.report.geoOutliers).toBe(1);
    expect(r.data.report.geoOutlierDetails[0].name).toBe("Tripoli in Libya");
  });
});

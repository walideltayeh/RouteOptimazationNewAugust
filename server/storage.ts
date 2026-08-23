import { 
  type Outlet, 
  type InsertOutlet,
  type Rep,
  type InsertRep,
  type Schedule,
  type InsertSchedule,
  type OptimizationRun,
  type InsertOptimizationRun,
  type DashboardMetrics,
  type FileAnalysis,
  type RoleHierarchy,
  type InsertRoleHierarchy,
  type RoleSchedule,
  type InsertRoleSchedule,
} from "@shared/schema";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

// --- File-backed persistence for the in-memory store ---
// Every Map is wrapped so mutations bump a dirty counter; an autosave timer
// snapshots the full state to disk (atomic tmp+rename) whenever it changed,
// and the snapshot is restored on boot. Without this, every server restart
// (deploys, Replit autoscale) silently wiped all outlets, reps and
// schedules. Date fields come back as ISO strings after the JSON round
// trip - identical over the API, which serialized them anyway.
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const SNAPSHOT_PATH = path.join(DATA_DIR, "storage-snapshot.json");
const AUTOSAVE_INTERVAL_MS = 5000;

function trackedMap<K, V>(onMutate: () => void): Map<K, V> {
  const m = new Map<K, V>();
  const origSet = m.set.bind(m);
  const origDelete = m.delete.bind(m);
  const origClear = m.clear.bind(m);
  m.set = (k: K, v: V) => { onMutate(); return origSet(k, v); };
  m.delete = (k: K) => { onMutate(); return origDelete(k); };
  m.clear = () => { onMutate(); origClear(); };
  return m;
}

export interface IStorage {
  // Outlets
  getOutlets(): Promise<Outlet[]>;
  getOutletsByRepId(repId: string): Promise<Outlet[]>;
  getOutletsByTerritory(territory: string): Promise<Outlet[]>;
  createOutlet(outlet: InsertOutlet): Promise<Outlet>;
  createOutlets(outlets: InsertOutlet[]): Promise<Outlet[]>;
  updateOutlet(id: string, outlet: Partial<InsertOutlet>): Promise<Outlet | undefined>;
  updateOutlets(updates: { id: string; data: Partial<InsertOutlet> }[]): Promise<Outlet[]>;
  deleteOutlet(id: string): Promise<boolean>;
  deleteAllOutlets(): Promise<void>;

  // Reps
  getReps(): Promise<Rep[]>;
  getRep(id: string): Promise<Rep | undefined>;
  createRep(rep: InsertRep): Promise<Rep>;
  createRepWithId(rep: Rep): Promise<Rep>;
  updateRep(id: string, rep: Partial<InsertRep>): Promise<Rep | undefined>;
  deleteRep(id: string): Promise<void>;
  deleteAllReps(): Promise<void>;

  // Schedules
  getSchedules(): Promise<Schedule[]>;
  getSchedulesByRepId(repId: string): Promise<Schedule[]>;
  createSchedule(schedule: InsertSchedule): Promise<Schedule>;
  createSchedules(schedules: InsertSchedule[]): Promise<Schedule[]>;
  updateSchedule(id: string, schedule: Partial<InsertSchedule>): Promise<Schedule | undefined>;
  deleteSchedulesByRepId(repId: string): Promise<void>;
  clearSchedules(): Promise<void>;

  // Optimization Runs
  getOptimizationRuns(): Promise<OptimizationRun[]>;
  getOptimizationRun(id: string): Promise<OptimizationRun | undefined>;
  createOptimizationRun(run: InsertOptimizationRun): Promise<OptimizationRun>;
  updateOptimizationRun(id: string, run: Partial<InsertOptimizationRun>): Promise<OptimizationRun | undefined>;

  // Analytics
  getDashboardMetrics(): Promise<DashboardMetrics>;
  getFileAnalysis(): Promise<FileAnalysis>;

  // Role Hierarchies
  getRoleHierarchies(): Promise<RoleHierarchy[]>;
  getRoleHierarchiesByRepId(repId: string): Promise<RoleHierarchy[]>;
  getRoleHierarchy(id: string): Promise<RoleHierarchy | undefined>;
  createRoleHierarchy(hierarchy: InsertRoleHierarchy): Promise<RoleHierarchy>;
  createRoleHierarchies(hierarchies: InsertRoleHierarchy[]): Promise<RoleHierarchy[]>;
  updateRoleHierarchy(id: string, update: Partial<InsertRoleHierarchy>): Promise<RoleHierarchy | undefined>;
  deleteRoleHierarchy(id: string): Promise<void>;
  deleteRoleHierarchiesByRepId(repId: string): Promise<void>;

  // Role Schedules
  getRoleSchedules(): Promise<RoleSchedule[]>;
  getRoleSchedulesByRepId(repId: string): Promise<RoleSchedule[]>;
  getRoleSchedulesByRole(role: string): Promise<RoleSchedule[]>;
  createRoleSchedule(schedule: InsertRoleSchedule): Promise<RoleSchedule>;
  createRoleSchedules(schedules: InsertRoleSchedule[]): Promise<RoleSchedule[]>;
  deleteRoleSchedulesByRepId(repId: string): Promise<void>;
  deleteRoleSchedulesByHierarchyId(hierarchyId: string): Promise<void>;
  clearRoleSchedules(): Promise<void>;

  
  // Clear all data
  clearAll(): Promise<void>;
}

export class MemStorage implements IStorage {
  private outlets: Map<string, Outlet>;
  private reps: Map<string, Rep>;
  private schedules: Map<string, Schedule>;
  private optimizationRuns: Map<string, OptimizationRun>;
  private roleHierarchies: Map<string, RoleHierarchy>;
  private roleSchedules: Map<string, RoleSchedule>;

  private dirtyCount = 0;
  private savedCount = 0;
  private readonly markDirty = () => { this.dirtyCount++; };

  // Every persisted Map, by its snapshot key. Adding a new Map field to the
  // store means adding it here - nothing else.
  private persistedMaps(): Record<string, Map<string, any>> {
    return {
      outlets: this.outlets,
      reps: this.reps,
      schedules: this.schedules,
      roleHierarchies: this.roleHierarchies,
      roleSchedules: this.roleSchedules,
      optimizationRuns: this.optimizationRuns,
    };
  }

  constructor() {
    this.outlets = trackedMap(this.markDirty);
    this.reps = trackedMap(this.markDirty);
    this.schedules = trackedMap(this.markDirty);
    this.roleHierarchies = trackedMap(this.markDirty);
    this.roleSchedules = trackedMap(this.markDirty);
    this.optimizationRuns = trackedMap(this.markDirty);

    this.restoreFromDisk();

    this.startAutosave();
  }

  private restoreFromDisk(): void {
    try {
      if (!fs.existsSync(SNAPSHOT_PATH)) return;
      const raw = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf-8"));
      const maps = this.persistedMaps();
      let restored = 0;
      for (const [key, map] of Object.entries(maps)) {
        const entries = raw[key];
        if (!Array.isArray(entries)) continue;
        for (const [k, v] of entries) { map.set(k, v); restored++; }
      }
      this.savedCount = this.dirtyCount; // restoring is not a new change
      console.log(`[storage] Restored ${restored} records from ${SNAPSHOT_PATH}`);
    } catch (err) {
      console.error("[storage] Failed to restore snapshot (starting empty):", (err as Error).message);
    }
  }

  private saveToDisk(): void {
    try {
      const maps = this.persistedMaps();
      const snapshot: Record<string, [string, any][]> = {};
      for (const [key, map] of Object.entries(maps)) {
        snapshot[key] = Array.from(map.entries());
      }
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = SNAPSHOT_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, SNAPSHOT_PATH);
    } catch (err) {
      console.error("[storage] Snapshot save failed:", (err as Error).message);
    }
  }

  private startAutosave(): void {
    const timer = setInterval(() => {
      if (this.dirtyCount !== this.savedCount) {
        const at = this.dirtyCount;
        this.saveToDisk();
        this.savedCount = at;
      }
    }, AUTOSAVE_INTERVAL_MS);
    timer.unref(); // never keep the process alive just for autosave
    const flush = () => { if (this.dirtyCount !== this.savedCount) this.saveToDisk(); };
    // Signal handlers must still terminate the process - installing a
    // handler replaces Node's default exit-on-signal behavior, so without
    // the explicit exit a "killed" server would flush and keep running.
    const flushAndExit = () => { flush(); process.exit(0); };
    process.on("SIGTERM", flushAndExit);
    process.on("SIGINT", flushAndExit);
    process.on("beforeExit", flush);
  }

  // Outlets
  async getOutlets(): Promise<Outlet[]> {
    return Array.from(this.outlets.values());
  }

  async getOutletsByRepId(repId: string): Promise<Outlet[]> {
    return Array.from(this.outlets.values()).filter(outlet => outlet.repId === repId);
  }

  async getOutletsByTerritory(territory: string): Promise<Outlet[]> {
    return Array.from(this.outlets.values()).filter(outlet => outlet.territory === territory);
  }

  async createOutlet(insertOutlet: InsertOutlet): Promise<Outlet> {
    const id = randomUUID();
    const outlet: Outlet = { 
      ...insertOutlet,
      id, 
      createdAt: new Date(),
      repId: insertOutlet.repId || null,
      territory: insertOutlet.territory || null,
      cluster: insertOutlet.cluster || null,
      timePerVisit: insertOutlet.timePerVisit ?? 30,
      value: insertOutlet.value ?? null,
      geoStatus: insertOutlet.geoStatus ?? null
    };
    this.outlets.set(id, outlet);
    return outlet;
  }

  async createOutlets(insertOutlets: InsertOutlet[]): Promise<Outlet[]> {
    const outlets: Outlet[] = [];
    for (const insertOutlet of insertOutlets) {
      const outlet = await this.createOutlet(insertOutlet);
      outlets.push(outlet);
    }
    return outlets;
  }

  async updateOutlet(id: string, update: Partial<InsertOutlet>): Promise<Outlet | undefined> {
    const outlet = this.outlets.get(id);
    if (!outlet) return undefined;
    
    const updatedOutlet = { ...outlet, ...update };
    this.outlets.set(id, updatedOutlet);
    return updatedOutlet;
  }

  async updateOutlets(updates: { id: string; data: Partial<InsertOutlet> }[]): Promise<Outlet[]> {
    const results: Outlet[] = [];
    for (const { id, data } of updates) {
      const updated = await this.updateOutlet(id, data);
      if (updated) results.push(updated);
    }
    return results;
  }

  async deleteOutlet(id: string): Promise<boolean> {
    const existed = this.outlets.has(id);
    if (existed) {
      this.outlets.delete(id);
      // Also remove from any schedules - clean both outletIds and routeOrder,
      // and invalidate cached totalDistance / estimatedDuration so the next
      // optimize call recomputes them from scratch.
      const schedules = Array.from(this.schedules.values());
      for (const schedule of schedules) {
        const outletIds = (schedule.outletIds as string[]) || [];
        const routeOrder = (schedule.routeOrder as string[]) || [];
        const inOutletIds = outletIds.includes(id);
        const inRouteOrder = routeOrder.includes(id);
        if (inOutletIds || inRouteOrder) {
          const updatedOutletIds = outletIds.filter((oid: string) => oid !== id);
          const updatedRouteOrder = routeOrder.filter((oid: string) => oid !== id);
          this.schedules.set(schedule.id, {
            ...schedule,
            outletIds: updatedOutletIds,
            routeOrder: updatedRouteOrder,
            totalDistance: null,
            estimatedDuration: null,
          });
        }
      }
    }
    return existed;
  }

  async deleteAllOutlets(): Promise<void> {
    this.outlets.clear();
  }

  // Reps
  async getReps(): Promise<Rep[]> {
    return Array.from(this.reps.values());
  }

  async getRep(id: string): Promise<Rep | undefined> {
    return this.reps.get(id);
  }

  // Restores a rep under its original id - schedules reference reps by id,
  // so a restored plan must keep them.
  async createRepWithId(rep: Rep): Promise<Rep> {
    this.reps.set(rep.id, rep);
    return rep;
  }

  async createRep(insertRep: InsertRep): Promise<Rep> {
    const id = randomUUID();
    const rep: Rep = { 
      ...insertRep,
      id, 
      createdAt: new Date(),
      minDailyVisits: insertRep.minDailyVisits || 15,
      maxDailyVisits: insertRep.maxDailyVisits || 25,
      workingDaysPerWeek: insertRep.workingDaysPerWeek || 5,
      isActive: insertRep.isActive !== undefined ? insertRep.isActive : true
    };
    this.reps.set(id, rep);
    return rep;
  }

  async updateRep(id: string, update: Partial<InsertRep>): Promise<Rep | undefined> {
    const rep = this.reps.get(id);
    if (!rep) return undefined;
    
    const updatedRep = { ...rep, ...update };
    this.reps.set(id, updatedRep);
    return updatedRep;
  }

  async deleteRep(id: string): Promise<void> {
    this.reps.delete(id);
  }

  async deleteAllReps(): Promise<void> {
    this.reps.clear();
  }

  // Schedules
  async getSchedules(): Promise<Schedule[]> {
    return Array.from(this.schedules.values());
  }

  async getSchedulesByRepId(repId: string): Promise<Schedule[]> {
    return Array.from(this.schedules.values()).filter(schedule => schedule.repId === repId);
  }

  async createSchedule(insertSchedule: InsertSchedule): Promise<Schedule> {
    const id = randomUUID();
    const schedule: Schedule = { 
      ...insertSchedule,
      id, 
      createdAt: new Date(),
      totalDistance: insertSchedule.totalDistance || null,
      estimatedDuration: insertSchedule.estimatedDuration || null
    };
    this.schedules.set(id, schedule);
    return schedule;
  }

  async createSchedules(insertSchedules: InsertSchedule[]): Promise<Schedule[]> {
    const schedules: Schedule[] = [];
    for (const insertSchedule of insertSchedules) {
      const schedule = await this.createSchedule(insertSchedule);
      schedules.push(schedule);
    }
    return schedules;
  }

  async updateSchedule(id: string, update: Partial<InsertSchedule>): Promise<Schedule | undefined> {
    const schedule = this.schedules.get(id);
    if (!schedule) return undefined;
    
    const updatedSchedule = { ...schedule, ...update };
    this.schedules.set(id, updatedSchedule);
    return updatedSchedule;
  }

  async deleteSchedulesByRepId(repId: string): Promise<void> {
    const schedules = await this.getSchedulesByRepId(repId);
    schedules.forEach(schedule => this.schedules.delete(schedule.id));
  }

  async clearSchedules(): Promise<void> {
    this.schedules.clear();
  }

  // Optimization Runs
  async getOptimizationRuns(): Promise<OptimizationRun[]> {
    return Array.from(this.optimizationRuns.values());
  }

  async getOptimizationRun(id: string): Promise<OptimizationRun | undefined> {
    return this.optimizationRuns.get(id);
  }

  async createOptimizationRun(insertRun: InsertOptimizationRun): Promise<OptimizationRun> {
    const id = randomUUID();
    const run: OptimizationRun = { 
      ...insertRun,
      id, 
      createdAt: new Date(),
      status: insertRun.status || "pending",
      results: insertRun.results || null,
      vf1Outlets: insertRun.vf1Outlets || 0
    };
    this.optimizationRuns.set(id, run);
    return run;
  }

  async updateOptimizationRun(id: string, update: Partial<InsertOptimizationRun>): Promise<OptimizationRun | undefined> {
    const run = this.optimizationRuns.get(id);
    if (!run) return undefined;
    
    const updatedRun = { ...run, ...update };
    this.optimizationRuns.set(id, updatedRun);
    return updatedRun;
  }

  // Analytics
  async getDashboardMetrics(): Promise<DashboardMetrics> {
    const outlets = await this.getOutlets();
    const reps = await this.getReps();
    const schedules = await this.getSchedules();
    const activeReps = reps.filter(rep => rep.isActive);
    
    const totalOutlets = outlets.length;
    const vf1Count = outlets.filter(o => o.visitFrequency === 1).length;
    const vf2Count = outlets.filter(o => o.visitFrequency === 2).length;
    const vf4Count = outlets.filter(o => o.visitFrequency === 4).length;
    
    // Calculate total monthly visits: VF1*1 + VF2*2 + VF4*4
    const totalMonthlyVisits = (vf1Count * 1) + (vf2Count * 2) + (vf4Count * 4);
    const avgWorkingDays = activeReps.reduce((sum, rep) => sum + rep.workingDaysPerWeek, 0) / Math.max(activeReps.length, 1) || 5;
    const avgMaxDailyVisits = activeReps.reduce((sum, rep) => sum + rep.maxDailyVisits, 0) / Math.max(activeReps.length, 1) || 27;
    
    // Calculate based on monthly capacity (4 weeks)
    const monthlyCapacityPerRep = avgWorkingDays * 4 * avgMaxDailyVisits;
    const recommendedReps = Math.ceil(totalMonthlyVisits / monthlyCapacityPerRep);
    
    // Calculate actual avg daily visits from schedules
    let avgDailyVisits = 0;
    if (schedules.length > 0) {
      const totalVisits = schedules.reduce((sum, s) => sum + (s.outletIds as string[]).length, 0);
      avgDailyVisits = Math.round(totalVisits / schedules.length);
    }
    
    // Territory balance = how even the monthly-visit workload is across
    // reps (the same metric the optimizer's ±tolerance band uses), not
    // across zones - zones legitimately vary in size.
    let territoryBalance = 95;
    const visitsByRep = new Map<string, number>();
    outlets.forEach(o => {
      if (o.repId && o.territory !== 'Excluded') {
        visitsByRep.set(o.repId, (visitsByRep.get(o.repId) || 0) + (o.visitFrequency ?? 1));
      }
    });
    if (visitsByRep.size > 1) {
      const loads = Array.from(visitsByRep.values());
      const avgLoad = loads.reduce((a, b) => a + b, 0) / loads.length;
      const maxDeviationPct = Math.max(...loads.map(l => Math.abs(l - avgLoad) / avgLoad)) * 100;
      territoryBalance = Math.max(0, Math.round(100 - maxDeviationPct));
    }

    // Real total route distance from the generated schedules (km per 4-week cycle)
    const totalDistance = Math.round(schedules.reduce((sum, s) => sum + (s.totalDistance || 0), 0));

    return {
      totalOutlets,
      activeReps: activeReps.length,
      recommendedReps,
      avgDailyVisits,
      territoryBalance,
      totalDistance,
      minDailyVisits: activeReps.length > 0 ? Math.min(...activeReps.map(r => r.minDailyVisits)) : 0,
      maxDailyVisits: activeReps.length > 0 ? Math.max(...activeReps.map(r => r.maxDailyVisits)) : 0
    };
  }

  async getFileAnalysis(): Promise<FileAnalysis> {
    const outlets = await this.getOutlets();
    const vf1 = outlets.filter(o => o.visitFrequency === 1).length;
    const vf2 = outlets.filter(o => o.visitFrequency === 2).length;
    const vf4 = outlets.filter(o => o.visitFrequency === 4).length;

    // Total monthly visits
    const totalMonthlyVisits = (vf1 * 1) + (vf2 * 2) + (vf4 * 4);
    // Assuming 5 days/week * 4 weeks * 25 visits/day = 500 visits/month per rep
    const recommendedReps = Math.ceil(totalMonthlyVisits / (5 * 4 * 25));

    return {
      outlets: outlets.length,
      vf1,
      vf2,
      vf4,
      recommendedReps
    };
  }

  // Role Hierarchies
  async getRoleHierarchies(): Promise<RoleHierarchy[]> {
    return Array.from(this.roleHierarchies.values());
  }

  async getRoleHierarchiesByRepId(repId: string): Promise<RoleHierarchy[]> {
    return Array.from(this.roleHierarchies.values())
      .filter(h => h.repId === repId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async getRoleHierarchy(id: string): Promise<RoleHierarchy | undefined> {
    return this.roleHierarchies.get(id);
  }

  async createRoleHierarchy(hierarchy: InsertRoleHierarchy): Promise<RoleHierarchy> {
    const id = randomUUID();
    const roleHierarchy: RoleHierarchy = {
      ...hierarchy,
      id,
      offsetDays: hierarchy.offsetDays ?? 0,
      colorHex: hierarchy.colorHex ?? '#3B82F6',
      isActive: hierarchy.isActive ?? true,
      sortOrder: hierarchy.sortOrder ?? 0,
      createdAt: new Date()
    };
    this.roleHierarchies.set(id, roleHierarchy);
    return roleHierarchy;
  }

  async createRoleHierarchies(hierarchies: InsertRoleHierarchy[]): Promise<RoleHierarchy[]> {
    const results: RoleHierarchy[] = [];
    for (const hierarchy of hierarchies) {
      const created = await this.createRoleHierarchy(hierarchy);
      results.push(created);
    }
    return results;
  }

  async updateRoleHierarchy(id: string, update: Partial<InsertRoleHierarchy>): Promise<RoleHierarchy | undefined> {
    const hierarchy = this.roleHierarchies.get(id);
    if (!hierarchy) return undefined;
    const updated = { ...hierarchy, ...update };
    this.roleHierarchies.set(id, updated);
    return updated;
  }

  async deleteRoleHierarchy(id: string): Promise<void> {
    this.roleHierarchies.delete(id);
    // Also delete associated role schedules
    const scheduleEntries = Array.from(this.roleSchedules.entries());
    for (const [scheduleId, schedule] of scheduleEntries) {
      if (schedule.hierarchyId === id) {
        this.roleSchedules.delete(scheduleId);
      }
    }
  }

  async deleteRoleHierarchiesByRepId(repId: string): Promise<void> {
    const hierarchyEntries = Array.from(this.roleHierarchies.entries());
    for (const [id, hierarchy] of hierarchyEntries) {
      if (hierarchy.repId === repId) {
        await this.deleteRoleHierarchy(id);
      }
    }
  }

  // Role Schedules
  async getRoleSchedules(): Promise<RoleSchedule[]> {
    return Array.from(this.roleSchedules.values());
  }

  async getRoleSchedulesByRepId(repId: string): Promise<RoleSchedule[]> {
    return Array.from(this.roleSchedules.values()).filter(s => s.repId === repId);
  }

  async getRoleSchedulesByRole(role: string): Promise<RoleSchedule[]> {
    return Array.from(this.roleSchedules.values()).filter(s => s.role === role);
  }

  async createRoleSchedule(schedule: InsertRoleSchedule): Promise<RoleSchedule> {
    const id = randomUUID();
    const roleSchedule: RoleSchedule = {
      ...schedule,
      id,
      offsetDays: schedule.offsetDays ?? 0,
      totalDistance: schedule.totalDistance ?? null,
      estimatedDuration: schedule.estimatedDuration ?? null,
      createdAt: new Date()
    };
    this.roleSchedules.set(id, roleSchedule);
    return roleSchedule;
  }

  async createRoleSchedules(schedules: InsertRoleSchedule[]): Promise<RoleSchedule[]> {
    const results: RoleSchedule[] = [];
    for (const schedule of schedules) {
      const created = await this.createRoleSchedule(schedule);
      results.push(created);
    }
    return results;
  }

  async deleteRoleSchedulesByRepId(repId: string): Promise<void> {
    const entries = Array.from(this.roleSchedules.entries());
    for (const [id, schedule] of entries) {
      if (schedule.repId === repId) {
        this.roleSchedules.delete(id);
      }
    }
  }

  async deleteRoleSchedulesByHierarchyId(hierarchyId: string): Promise<void> {
    const entries = Array.from(this.roleSchedules.entries());
    for (const [id, schedule] of entries) {
      if (schedule.hierarchyId === hierarchyId) {
        this.roleSchedules.delete(id);
      }
    }
  }

  async clearRoleSchedules(): Promise<void> {
    this.roleSchedules.clear();
  }

  // Device Fingerprint Methods
  // Org Risk Profile Methods
  async clearAll(): Promise<void> {
    // Clear optimization-related data only
    this.outlets.clear();
    this.reps.clear();
    this.schedules.clear();
    this.optimizationRuns.clear();
    this.roleHierarchies.clear();
    this.roleSchedules.clear();
    //
  }

  private haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}

export const storage = new MemStorage();

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
  type FileAnalysis
} from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  // Outlets
  getOutlets(): Promise<Outlet[]>;
  getOutletsByRepId(repId: string): Promise<Outlet[]>;
  createOutlet(outlet: InsertOutlet): Promise<Outlet>;
  createOutlets(outlets: InsertOutlet[]): Promise<Outlet[]>;
  updateOutlet(id: string, outlet: Partial<InsertOutlet>): Promise<Outlet | undefined>;
  deleteAllOutlets(): Promise<void>;

  // Reps
  getReps(): Promise<Rep[]>;
  getRep(id: string): Promise<Rep | undefined>;
  createRep(rep: InsertRep): Promise<Rep>;
  updateRep(id: string, rep: Partial<InsertRep>): Promise<Rep | undefined>;
  deleteRep(id: string): Promise<void>;

  // Schedules
  getSchedules(): Promise<Schedule[]>;
  getSchedulesByRepId(repId: string): Promise<Schedule[]>;
  createSchedule(schedule: InsertSchedule): Promise<Schedule>;
  createSchedules(schedules: InsertSchedule[]): Promise<Schedule[]>;
  deleteSchedulesByRepId(repId: string): Promise<void>;

  // Optimization Runs
  getOptimizationRuns(): Promise<OptimizationRun[]>;
  getOptimizationRun(id: string): Promise<OptimizationRun | undefined>;
  createOptimizationRun(run: InsertOptimizationRun): Promise<OptimizationRun>;
  updateOptimizationRun(id: string, run: Partial<InsertOptimizationRun>): Promise<OptimizationRun | undefined>;

  // Analytics
  getDashboardMetrics(): Promise<DashboardMetrics>;
  getFileAnalysis(): Promise<FileAnalysis>;
}

export class MemStorage implements IStorage {
  private outlets: Map<string, Outlet>;
  private reps: Map<string, Rep>;
  private schedules: Map<string, Schedule>;
  private optimizationRuns: Map<string, OptimizationRun>;

  constructor() {
    this.outlets = new Map();
    this.reps = new Map();
    this.schedules = new Map();
    this.optimizationRuns = new Map();
  }

  // Outlets
  async getOutlets(): Promise<Outlet[]> {
    return Array.from(this.outlets.values());
  }

  async getOutletsByRepId(repId: string): Promise<Outlet[]> {
    return Array.from(this.outlets.values()).filter(outlet => outlet.repId === repId);
  }

  async createOutlet(insertOutlet: InsertOutlet): Promise<Outlet> {
    const id = randomUUID();
    const outlet: Outlet = { 
      ...insertOutlet,
      id, 
      createdAt: new Date(),
      repId: insertOutlet.repId || null,
      territory: insertOutlet.territory || null,
      cluster: insertOutlet.cluster || null
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

  async deleteSchedulesByRepId(repId: string): Promise<void> {
    const schedules = await this.getSchedulesByRepId(repId);
    schedules.forEach(schedule => this.schedules.delete(schedule.id));
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
      results: insertRun.results || null
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
    const activeReps = reps.filter(rep => rep.isActive);
    
    const totalOutlets = outlets.length;
    const vf2Count = outlets.filter(o => o.visitFrequency === 2).length;
    const vf4Count = outlets.filter(o => o.visitFrequency === 4).length;
    
    // Calculate recommended reps based on visit frequency and constraints
    const totalWeeklyVisits = (vf2Count * 2) + (vf4Count * 4);
    const avgWorkingDays = activeReps.reduce((sum, rep) => sum + rep.workingDaysPerWeek, 0) / Math.max(activeReps.length, 1) || 5;
    const avgMaxDailyVisits = activeReps.reduce((sum, rep) => sum + rep.maxDailyVisits, 0) / Math.max(activeReps.length, 1) || 25;
    const avgMinDailyVisits = activeReps.reduce((sum, rep) => sum + rep.minDailyVisits, 0) / Math.max(activeReps.length, 1) || 15;
    
    // Calculate based on max capacity per rep
    const maxWeeklyCapacityPerRep = avgWorkingDays * avgMaxDailyVisits;
    const recommendedReps = Math.ceil(totalWeeklyVisits / maxWeeklyCapacityPerRep);
    
    const avgDailyVisits = Math.round(totalWeeklyVisits / (activeReps.length * avgWorkingDays)) || 0;
    
    return {
      totalOutlets,
      activeReps: activeReps.length,
      recommendedReps,
      avgDailyVisits,
      routeEfficiency: 87, // This would be calculated from actual route data
      totalDistance: 342,
      avgTravelTime: 2.3,
      visitEfficiency: 94
    };
  }

  async getFileAnalysis(): Promise<FileAnalysis> {
    const outlets = await this.getOutlets();
    const vf2 = outlets.filter(o => o.visitFrequency === 2).length;
    const vf4 = outlets.filter(o => o.visitFrequency === 4).length;
    
    const totalWeeklyVisits = (vf2 * 2) + (vf4 * 4);
    const recommendedReps = Math.ceil(totalWeeklyVisits / (5 * 27)); // 5 days, 27 visits max
    
    return {
      outlets: outlets.length,
      vf2,
      vf4,
      recommendedReps
    };
  }
}

export const storage = new MemStorage();

import { 
  type Outlet, 
  type InsertOutlet,
  type Rep,
  type InsertRep,
  type Schedule,
  type InsertSchedule,
  type OptimizationRun,
  type InsertOptimizationRun,
  type Vehicle,
  type InsertVehicle,
  type VehicleMaintenance,
  type InsertVehicleMaintenance,
  type VehicleUsage,
  type InsertVehicleUsage,
  type MaintenancePolicy,
  type InsertMaintenancePolicy,
  type MaintenanceForecast,
  type InsertMaintenanceForecast,
  type VehicleMileageSnapshot,
  type InsertVehicleMileageSnapshot,
  type DashboardMetrics,
  type FileAnalysis,
  type VehicleAlert,
  type VehicleFullDashboard,
  type RoleHierarchy,
  type InsertRoleHierarchy,
  type RoleSchedule,
  type InsertRoleSchedule,
  type TrialAccount,
  type InsertTrialAccount,
  type TrialUsage,
  type InsertTrialUsage,
  type DeviceFingerprint,
  type InsertDeviceFingerprint,
  type FingerprintEvent,
  type InsertFingerprintEvent,
  type OrgRiskProfile,
  type InsertOrgRiskProfile,
  type TrialConversion,
  type InsertTrialConversion
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

  // Vehicles
  getVehicles(): Promise<Vehicle[]>;
  getVehicle(id: string): Promise<Vehicle | undefined>;
  createVehicle(vehicle: InsertVehicle): Promise<Vehicle>;
  updateVehicle(id: string, vehicle: Partial<InsertVehicle>): Promise<Vehicle | undefined>;
  deleteVehicle(id: string): Promise<void>;

  // Vehicle Maintenance
  getVehicleMaintenanceRecords(vehicleId?: string): Promise<VehicleMaintenance[]>;
  createVehicleMaintenanceRecord(record: InsertVehicleMaintenance): Promise<VehicleMaintenance>;
  updateVehicleMaintenanceRecord(id: string, record: Partial<InsertVehicleMaintenance>): Promise<VehicleMaintenance | undefined>;
  deleteVehicleMaintenanceRecord(id: string): Promise<void>;

  // Vehicle Usage
  getVehicleUsageRecords(vehicleId?: string): Promise<VehicleUsage[]>;
  createVehicleUsageRecord(record: InsertVehicleUsage): Promise<VehicleUsage>;
  getVehicleAlerts(): Promise<VehicleAlert[]>;

  // Maintenance Policies
  getMaintenancePolicies(): Promise<MaintenancePolicy[]>;
  getMaintenancePolicy(id: string): Promise<MaintenancePolicy | undefined>;
  createMaintenancePolicy(policy: InsertMaintenancePolicy): Promise<MaintenancePolicy>;
  updateMaintenancePolicy(id: string, policy: Partial<InsertMaintenancePolicy>): Promise<MaintenancePolicy | undefined>;
  deleteMaintenancePolicy(id: string): Promise<void>;

  // Maintenance Forecasts
  getMaintenanceForecasts(vehicleId?: string): Promise<MaintenanceForecast[]>;
  createMaintenanceForecast(forecast: InsertMaintenanceForecast): Promise<MaintenanceForecast>;
  updateMaintenanceForecast(id: string, forecast: Partial<InsertMaintenanceForecast>): Promise<MaintenanceForecast | undefined>;
  deleteMaintenanceForecastsByVehicle(vehicleId: string): Promise<void>;

  // Mileage Snapshots
  getVehicleMileageSnapshots(vehicleId: string): Promise<VehicleMileageSnapshot[]>;
  createVehicleMileageSnapshot(snapshot: InsertVehicleMileageSnapshot): Promise<VehicleMileageSnapshot>;
  getLatestMileageSnapshot(vehicleId: string): Promise<VehicleMileageSnapshot | undefined>;

  // Vehicle Dashboard
  getVehicleDashboard(vehicleId: string): Promise<VehicleFullDashboard | undefined>;

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

  // Trial Accounts
  createTrialAccount(data: InsertTrialAccount): Promise<TrialAccount>;
  getTrialAccount(id: string): Promise<TrialAccount | undefined>;
  getTrialAccountByEmail(email: string): Promise<TrialAccount | undefined>;
  updateTrialAccount(id: string, data: Partial<InsertTrialAccount>): Promise<TrialAccount | undefined>;
  getActiveTrialByOrgKey(orgKey: string): Promise<TrialAccount | undefined>;

  // Trial Usage
  createTrialUsage(trialId: string): Promise<TrialUsage>;
  getTrialUsage(trialId: string): Promise<TrialUsage | undefined>;
  incrementOutletCount(trialId: string, count?: number): Promise<TrialUsage | undefined>;
  incrementVehicleCount(trialId: string, count?: number): Promise<TrialUsage | undefined>;
  decrementOutletCount(trialId: string, count?: number): Promise<TrialUsage | undefined>;
  decrementVehicleCount(trialId: string, count?: number): Promise<TrialUsage | undefined>;
  setOutletCount(trialId: string, count: number): Promise<TrialUsage | undefined>;
  setVehicleCount(trialId: string, count: number): Promise<TrialUsage | undefined>;
  incrementOptimizationRuns(trialId: string): Promise<TrialUsage | undefined>;

  // Device Fingerprints
  createDeviceFingerprint(data: InsertDeviceFingerprint): Promise<DeviceFingerprint>;
  getDeviceFingerprintByHash(hash: string): Promise<DeviceFingerprint | undefined>;
  getDeviceFingerprintsByTrialId(trialId: string): Promise<DeviceFingerprint[]>;
  updateFingerprintTrustScore(id: string, score: number, anomalyFlags?: unknown): Promise<DeviceFingerprint | undefined>;
  createFingerprintEvent(data: InsertFingerprintEvent): Promise<FingerprintEvent>;

  // Org Risk Profiles
  createOrgRiskProfile(data: InsertOrgRiskProfile): Promise<OrgRiskProfile>;
  getOrgRiskProfileByKey(orgKey: string): Promise<OrgRiskProfile | undefined>;
  updateOrgRiskProfile(id: string, data: Partial<InsertOrgRiskProfile>): Promise<OrgRiskProfile | undefined>;
  incrementOrgTrialCount(orgKey: string): Promise<OrgRiskProfile | undefined>;

  // Trial Conversions
  createTrialConversion(data: InsertTrialConversion): Promise<TrialConversion>;
  
  // Clear all data
  clearAll(): Promise<void>;
}

export class MemStorage implements IStorage {
  private outlets: Map<string, Outlet>;
  private reps: Map<string, Rep>;
  private schedules: Map<string, Schedule>;
  private optimizationRuns: Map<string, OptimizationRun>;
  private vehicles: Map<string, Vehicle>;
  private vehicleMaintenanceRecords: Map<string, VehicleMaintenance>;
  private vehicleUsageRecords: Map<string, VehicleUsage>;
  private maintenancePolicies: Map<string, MaintenancePolicy>;
  private maintenanceForecasts: Map<string, MaintenanceForecast>;
  private vehicleMileageSnapshots: Map<string, VehicleMileageSnapshot>;
  private roleHierarchies: Map<string, RoleHierarchy>;
  private roleSchedules: Map<string, RoleSchedule>;
  private trialAccounts: Map<string, TrialAccount>;
  private trialUsages: Map<string, TrialUsage>;
  private deviceFingerprints: Map<string, DeviceFingerprint>;
  private fingerprintEvents: Map<string, FingerprintEvent>;
  private orgRiskProfiles: Map<string, OrgRiskProfile>;
  private trialConversions: Map<string, TrialConversion>;

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
      vehicles: this.vehicles,
      vehicleMaintenanceRecords: this.vehicleMaintenanceRecords,
      vehicleUsageRecords: this.vehicleUsageRecords,
      maintenancePolicies: this.maintenancePolicies,
      maintenanceForecasts: this.maintenanceForecasts,
      vehicleMileageSnapshots: this.vehicleMileageSnapshots,
      trialAccounts: this.trialAccounts,
      trialUsages: this.trialUsages,
      deviceFingerprints: this.deviceFingerprints,
      fingerprintEvents: this.fingerprintEvents,
      orgRiskProfiles: this.orgRiskProfiles,
      trialConversions: this.trialConversions,
    };
  }

  constructor() {
    this.outlets = trackedMap(this.markDirty);
    this.reps = trackedMap(this.markDirty);
    this.schedules = trackedMap(this.markDirty);
    this.roleHierarchies = trackedMap(this.markDirty);
    this.roleSchedules = trackedMap(this.markDirty);
    this.optimizationRuns = trackedMap(this.markDirty);
    this.vehicles = trackedMap(this.markDirty);
    this.vehicleMaintenanceRecords = trackedMap(this.markDirty);
    this.vehicleUsageRecords = trackedMap(this.markDirty);
    this.maintenancePolicies = trackedMap(this.markDirty);
    this.maintenanceForecasts = trackedMap(this.markDirty);
    this.vehicleMileageSnapshots = trackedMap(this.markDirty);
    this.trialAccounts = trackedMap(this.markDirty);
    this.trialUsages = trackedMap(this.markDirty);
    this.deviceFingerprints = trackedMap(this.markDirty);
    this.fingerprintEvents = trackedMap(this.markDirty);
    this.orgRiskProfiles = trackedMap(this.markDirty);
    this.trialConversions = trackedMap(this.markDirty);

    this.restoreFromDisk();

    // Initialize default maintenance policies (only on a fresh store -
    // restored snapshots already contain them)
    if (this.maintenancePolicies.size === 0) {
      this.initializeDefaultPolicies();
    }

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
    process.on("SIGTERM", flush);
    process.on("SIGINT", flush);
    process.on("beforeExit", flush);
  }

  private async initializeDefaultPolicies(): Promise<void> {
    const defaultPolicies: InsertMaintenancePolicy[] = [
      {
        name: 'Oil Change',
        maintenanceType: 'oil_change',
        intervalKm: 5000,
        intervalDays: 90,
        warningThresholdKm: 500,
        warningThresholdDays: 14,
        criticalThresholdKm: 1000,
        isActive: true
      },
      {
        name: 'Tire Replacement',
        maintenanceType: 'tire_change',
        intervalKm: 40000,
        intervalDays: 730,
        warningThresholdKm: 5000,
        warningThresholdDays: 60,
        criticalThresholdKm: 10000,
        isActive: true
      },
      {
        name: 'Brake Service',
        maintenanceType: 'brake_service',
        intervalKm: 30000,
        intervalDays: 365,
        warningThresholdKm: 3000,
        warningThresholdDays: 30,
        criticalThresholdKm: 5000,
        isActive: true
      },
      {
        name: 'General Service',
        maintenanceType: 'general_service',
        intervalKm: 10000,
        intervalDays: 180,
        warningThresholdKm: 1000,
        warningThresholdDays: 14,
        criticalThresholdKm: 2000,
        isActive: true
      }
    ];

    for (const policy of defaultPolicies) {
      await this.createMaintenancePolicy(policy);
    }
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

  async createRep(insertRep: InsertRep): Promise<Rep> {
    const id = randomUUID();
    const rep: Rep = { 
      ...insertRep,
      id, 
      createdAt: new Date(),
      minDailyVisits: insertRep.minDailyVisits || 15,
      maxDailyVisits: insertRep.maxDailyVisits || 25,
      workingDaysPerWeek: insertRep.workingDaysPerWeek || 5,
      isActive: insertRep.isActive !== undefined ? insertRep.isActive : true,
      vehicleId: insertRep.vehicleId || null
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

  // Vehicles
  async getVehicles(): Promise<Vehicle[]> {
    return Array.from(this.vehicles.values());
  }

  async getVehicle(id: string): Promise<Vehicle | undefined> {
    return this.vehicles.get(id);
  }

  async createVehicle(insertVehicle: InsertVehicle): Promise<Vehicle> {
    const id = randomUUID();
    const vehicle: Vehicle = {
      ...insertVehicle,
      id,
      createdAt: new Date(),
      status: insertVehicle.status || "active",
      assignedRepId: insertVehicle.assignedRepId || null
    };
    this.vehicles.set(id, vehicle);
    return vehicle;
  }

  async updateVehicle(id: string, update: Partial<InsertVehicle>): Promise<Vehicle | undefined> {
    const vehicle = this.vehicles.get(id);
    if (!vehicle) return undefined;
    
    const updatedVehicle = { ...vehicle, ...update };
    this.vehicles.set(id, updatedVehicle);
    return updatedVehicle;
  }

  async deleteVehicle(id: string): Promise<void> {
    this.vehicles.delete(id);
  }

  // Vehicle Maintenance
  async getVehicleMaintenanceRecords(vehicleId?: string): Promise<VehicleMaintenance[]> {
    const records = Array.from(this.vehicleMaintenanceRecords.values());
    if (vehicleId) {
      return records.filter(r => r.vehicleId === vehicleId);
    }
    return records;
  }

  async createVehicleMaintenanceRecord(insertRecord: InsertVehicleMaintenance): Promise<VehicleMaintenance> {
    const id = randomUUID();
    const record: VehicleMaintenance = {
      ...insertRecord,
      id,
      createdAt: new Date(),
      description: insertRecord.description || null,
      cost: insertRecord.cost || null,
      oilType: insertRecord.oilType || null,
      tireType: insertRecord.tireType || null,
      nextServiceMileage: insertRecord.nextServiceMileage || null,
      nextServiceDate: insertRecord.nextServiceDate || null,
      notes: insertRecord.notes || null
    };
    this.vehicleMaintenanceRecords.set(id, record);
    return record;
  }

  async updateVehicleMaintenanceRecord(id: string, update: Partial<InsertVehicleMaintenance>): Promise<VehicleMaintenance | undefined> {
    const record = this.vehicleMaintenanceRecords.get(id);
    if (!record) return undefined;
    
    const updatedRecord = { ...record, ...update };
    this.vehicleMaintenanceRecords.set(id, updatedRecord);
    return updatedRecord;
  }

  async deleteVehicleMaintenanceRecord(id: string): Promise<void> {
    this.vehicleMaintenanceRecords.delete(id);
  }

  // Vehicle Usage
  async getVehicleUsageRecords(vehicleId?: string): Promise<VehicleUsage[]> {
    const records = Array.from(this.vehicleUsageRecords.values());
    if (vehicleId) {
      return records.filter(r => r.vehicleId === vehicleId);
    }
    return records;
  }

  async createVehicleUsageRecord(insertRecord: InsertVehicleUsage): Promise<VehicleUsage> {
    const id = randomUUID();
    const record: VehicleUsage = {
      ...insertRecord,
      id,
      createdAt: new Date(),
      scheduleId: insertRecord.scheduleId || null
    };
    this.vehicleUsageRecords.set(id, record);

    // Update vehicle's current mileage
    const vehicle = await this.getVehicle(insertRecord.vehicleId);
    if (vehicle) {
      await this.updateVehicle(insertRecord.vehicleId, {
        currentMileage: insertRecord.endMileage
      });
    }

    return record;
  }

  // Vehicle Alerts
  async getVehicleAlerts(): Promise<VehicleAlert[]> {
    const alerts: VehicleAlert[] = [];
    const vehicles = await this.getVehicles();
    const now = new Date();

    for (const vehicle of vehicles) {
      const maintenanceRecords = await this.getVehicleMaintenanceRecords(vehicle.id);
      
      // Find latest oil change
      const latestOilChange = maintenanceRecords
        .filter(r => r.maintenanceType === 'oil_change')
        .sort((a, b) => new Date(b.serviceDate).getTime() - new Date(a.serviceDate).getTime())[0];

      if (latestOilChange) {
        // Check if oil change is due (typically every 5000 km or 3 months)
        const kmSinceOilChange = vehicle.currentMileage - latestOilChange.mileageAtService;
        const daysSinceOilChange = Math.floor((now.getTime() - new Date(latestOilChange.serviceDate).getTime()) / (1000 * 60 * 60 * 24));
        
        if (kmSinceOilChange >= 4500 || daysSinceOilChange >= 80) {
          alerts.push({
            vehicleId: vehicle.id,
            plateNumber: vehicle.plateNumber,
            alertType: 'oil_change_due',
            severity: kmSinceOilChange >= 5000 || daysSinceOilChange >= 90 ? 'high' : 'medium',
            message: `Oil change due. ${kmSinceOilChange.toFixed(0)} km since last change.`,
            dueMileage: latestOilChange.mileageAtService + 5000
          });
        }
      }

      // Find latest tire change
      const latestTireChange = maintenanceRecords
        .filter(r => r.maintenanceType === 'tire_change')
        .sort((a, b) => new Date(b.serviceDate).getTime() - new Date(a.serviceDate).getTime())[0];

      if (latestTireChange) {
        const kmSinceTireChange = vehicle.currentMileage - latestTireChange.mileageAtService;
        
        if (kmSinceTireChange >= 35000) {
          alerts.push({
            vehicleId: vehicle.id,
            plateNumber: vehicle.plateNumber,
            alertType: 'tire_change_due',
            severity: kmSinceTireChange >= 40000 ? 'high' : 'medium',
            message: `Tire inspection recommended. ${kmSinceTireChange.toFixed(0)} km since last change.`,
            dueMileage: latestTireChange.mileageAtService + 40000
          });
        }
      }

      // Find latest general service
      const latestService = maintenanceRecords
        .filter(r => r.maintenanceType === 'service')
        .sort((a, b) => new Date(b.serviceDate).getTime() - new Date(a.serviceDate).getTime())[0];

      if (latestService && latestService.nextServiceDate) {
        const daysUntilService = Math.floor((new Date(latestService.nextServiceDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        
        if (daysUntilService <= 14) {
          alerts.push({
            vehicleId: vehicle.id,
            plateNumber: vehicle.plateNumber,
            alertType: 'service_due',
            severity: daysUntilService <= 0 ? 'high' : daysUntilService <= 7 ? 'medium' : 'low',
            message: daysUntilService <= 0 
              ? `Service overdue by ${Math.abs(daysUntilService)} days` 
              : `Service due in ${daysUntilService} days`,
            dueDate: new Date(latestService.nextServiceDate)
          });
        }
      }

      // High mileage alert
      if (vehicle.currentMileage >= 150000) {
        alerts.push({
          vehicleId: vehicle.id,
          plateNumber: vehicle.plateNumber,
          alertType: 'high_mileage',
          severity: vehicle.currentMileage >= 200000 ? 'high' : 'medium',
          message: `High mileage vehicle: ${vehicle.currentMileage.toFixed(0)} km`,
          dueMileage: vehicle.currentMileage
        });
      }
    }

    return alerts;
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
      routeEfficiency: 87,
      territoryBalance,
      totalDistance,
      avgTravelTime: 2.3,
      visitEfficiency: 94
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

  // Maintenance Policies
  async getMaintenancePolicies(): Promise<MaintenancePolicy[]> {
    return Array.from(this.maintenancePolicies.values());
  }

  async getMaintenancePolicy(id: string): Promise<MaintenancePolicy | undefined> {
    return this.maintenancePolicies.get(id);
  }

  async createMaintenancePolicy(insertPolicy: InsertMaintenancePolicy): Promise<MaintenancePolicy> {
    const id = randomUUID();
    const policy: MaintenancePolicy = {
      ...insertPolicy,
      id,
      createdAt: new Date(),
      intervalDays: insertPolicy.intervalDays || null,
      warningThresholdDays: insertPolicy.warningThresholdDays || null,
      isActive: insertPolicy.isActive ?? true
    };
    this.maintenancePolicies.set(id, policy);
    return policy;
  }

  async updateMaintenancePolicy(id: string, update: Partial<InsertMaintenancePolicy>): Promise<MaintenancePolicy | undefined> {
    const policy = this.maintenancePolicies.get(id);
    if (!policy) return undefined;
    
    const updatedPolicy = { ...policy, ...update };
    this.maintenancePolicies.set(id, updatedPolicy);
    return updatedPolicy;
  }

  async deleteMaintenancePolicy(id: string): Promise<void> {
    this.maintenancePolicies.delete(id);
  }

  // Maintenance Forecasts
  async getMaintenanceForecasts(vehicleId?: string): Promise<MaintenanceForecast[]> {
    const forecasts = Array.from(this.maintenanceForecasts.values());
    if (vehicleId) {
      return forecasts.filter(f => f.vehicleId === vehicleId);
    }
    return forecasts;
  }

  async createMaintenanceForecast(insertForecast: InsertMaintenanceForecast): Promise<MaintenanceForecast> {
    const id = randomUUID();
    const forecast: MaintenanceForecast = {
      ...insertForecast,
      id,
      createdAt: new Date(),
      lastCalculatedAt: new Date(),
      policyId: insertForecast.policyId || null,
      estimatedDueDate: insertForecast.estimatedDueDate || null,
      remainingDays: insertForecast.remainingDays || null,
      severity: insertForecast.severity || 'low',
      status: insertForecast.status || 'upcoming',
      recommendation: insertForecast.recommendation || null
    };
    this.maintenanceForecasts.set(id, forecast);
    return forecast;
  }

  async updateMaintenanceForecast(id: string, update: Partial<InsertMaintenanceForecast>): Promise<MaintenanceForecast | undefined> {
    const forecast = this.maintenanceForecasts.get(id);
    if (!forecast) return undefined;
    
    const updatedForecast = { ...forecast, ...update, lastCalculatedAt: new Date() };
    this.maintenanceForecasts.set(id, updatedForecast);
    return updatedForecast;
  }

  async deleteMaintenanceForecastsByVehicle(vehicleId: string): Promise<void> {
    const entries = Array.from(this.maintenanceForecasts.entries());
    for (const [id, forecast] of entries) {
      if (forecast.vehicleId === vehicleId) {
        this.maintenanceForecasts.delete(id);
      }
    }
  }

  // Mileage Snapshots
  async getVehicleMileageSnapshots(vehicleId: string): Promise<VehicleMileageSnapshot[]> {
    return Array.from(this.vehicleMileageSnapshots.values())
      .filter(s => s.vehicleId === vehicleId)
      .sort((a, b) => new Date(b.snapshotDate).getTime() - new Date(a.snapshotDate).getTime());
  }

  async createVehicleMileageSnapshot(insertSnapshot: InsertVehicleMileageSnapshot): Promise<VehicleMileageSnapshot> {
    const id = randomUUID();
    const snapshot: VehicleMileageSnapshot = {
      ...insertSnapshot,
      id,
      createdAt: new Date(),
      dailyKm: insertSnapshot.dailyKm || 0,
      weeklyKm: insertSnapshot.weeklyKm || 0,
      monthlyKm: insertSnapshot.monthlyKm || 0,
      annualKm: insertSnapshot.annualKm || 0,
      lifetimeKm: insertSnapshot.lifetimeKm || 0,
      avgDailyKm: insertSnapshot.avgDailyKm || 0,
      routeIntensity: insertSnapshot.routeIntensity || 'light'
    };
    this.vehicleMileageSnapshots.set(id, snapshot);
    return snapshot;
  }

  async getLatestMileageSnapshot(vehicleId: string): Promise<VehicleMileageSnapshot | undefined> {
    const snapshots = await this.getVehicleMileageSnapshots(vehicleId);
    return snapshots[0];
  }

  // Vehicle Dashboard - comprehensive data for vehicle detail page
  async getVehicleDashboard(vehicleId: string): Promise<VehicleFullDashboard | undefined> {
    const vehicle = await this.getVehicle(vehicleId);
    if (!vehicle) return undefined;

    const reps = await this.getReps();
    const assignedRep = vehicle.assignedRepId ? reps.find(r => r.id === vehicle.assignedRepId) : null;
    const usageRecords = await this.getVehicleUsageRecords(vehicleId);
    const maintenanceRecords = await this.getVehicleMaintenanceRecords(vehicleId);
    const forecasts = await this.getMaintenanceForecasts(vehicleId);
    const snapshots = await this.getVehicleMileageSnapshots(vehicleId);
    const allVehicles = await this.getVehicles();
    const allOutlets = await this.getOutlets();

    // Calculate projected monthly KM from rep's scheduled routes
    let projectedMonthlyKmFromRoutes = 0;
    if (assignedRep) {
      const repSchedules = await this.getSchedulesByRepId(assignedRep.id);
      const weeklyKmByWeek: Record<number, number> = {};
      
      for (const schedule of repSchedules) {
        const outletIds = schedule.outletIds as string[];
        const scheduleOutlets = outletIds
          .map(id => allOutlets.find(o => o.id === id))
          .filter(Boolean);

        let routeDistance = 0;
        for (let i = 0; i < scheduleOutlets.length - 1; i++) {
          const from = scheduleOutlets[i];
          const to = scheduleOutlets[i + 1];
          if (from?.latitude && from?.longitude && to?.latitude && to?.longitude) {
            routeDistance += this.haversineDistance(
              from.latitude, from.longitude,
              to.latitude, to.longitude
            );
          }
        }
        weeklyKmByWeek[schedule.week] = (weeklyKmByWeek[schedule.week] || 0) + routeDistance;
      }

      // Calculate average weekly KM across all scheduled weeks
      const weeks = Object.keys(weeklyKmByWeek);
      const avgWeeklyKm = weeks.length > 0 
        ? Object.values(weeklyKmByWeek).reduce((sum, km) => sum + km, 0) / weeks.length 
        : 0;
      projectedMonthlyKmFromRoutes = avgWeeklyKm * 4;
    }

    // Calculate lifetime KM
    const lifetimeKm = vehicle.currentMileage - vehicle.startingMileage;

    const now = new Date();
    
    // Calculate "Actual This Month" based on schedule: 
    // How many working days have passed this month * daily avg from schedule
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const dayOfMonth = now.getDate();
    const workingDaysThisMonth = Math.round(dayOfMonth * 5 / 7); // Approx working days elapsed
    const avgWeeklyKmFromSchedule = projectedMonthlyKmFromRoutes / 4;
    const avgDailyKmFromSchedule = avgWeeklyKmFromSchedule / 5; // 5 working days
    const actualThisMonthKm = Math.round(workingDaysThisMonth * avgDailyKmFromSchedule);
    
    // Quarterly = 3 months of projected schedule KM (approximation based on schedule)
    const quarterlyKm = Math.round(projectedMonthlyKmFromRoutes * 3);

    // Calculate usage metrics based on schedule
    const avgDailyKm = avgDailyKmFromSchedule;
    
    // Calculate fleet average: use this vehicle's schedule average as baseline
    // For simplicity, use 50 km/day as fleet default if no schedule data
    const fleetAvgDailyKm = avgDailyKm > 0 ? avgDailyKm : 50;

    // Determine route intensity based on schedule-derived KM
    let routeIntensity: 'light' | 'medium' | 'heavy' = 'light';
    if (avgDailyKm > 150) routeIntensity = 'heavy';
    else if (avgDailyKm > 75) routeIntensity = 'medium';

    // Determine comparison to fleet
    let comparedToFleet: 'below' | 'average' | 'above' = 'average';
    if (avgDailyKm < fleetAvgDailyKm * 0.8) comparedToFleet = 'below';
    else if (avgDailyKm > fleetAvgDailyKm * 1.2) comparedToFleet = 'above';

    // Get daily and weekly KM history
    const dailyKmHistory = snapshots.slice(0, 30).map(s => ({
      date: s.snapshotDate,
      km: s.dailyKm
    }));

    const weeklyKmHistory = snapshots.filter((_, i) => i % 7 === 0).slice(0, 12).map(s => ({
      week: s.snapshotDate,
      km: s.weeklyKm
    }));

    // Get maintenance status
    const sortedMaintenance = [...maintenanceRecords].sort((a, b) => 
      new Date(b.serviceDate).getTime() - new Date(a.serviceDate).getTime()
    );
    const lastMaintenance = sortedMaintenance[0];

    const upcomingMaintenance = forecasts.filter(f => f.status === 'upcoming' || f.status === 'due');
    const overdueItems = forecasts.filter(f => f.status === 'overdue');

    // Calculate days/km to next service
    let daysToNextService: number | null = null;
    let kmToNextService: number | null = null;
    if (upcomingMaintenance.length > 0) {
      const nextItem = upcomingMaintenance.sort((a, b) => a.remainingKm - b.remainingKm)[0];
      kmToNextService = nextItem.remainingKm;
      daysToNextService = nextItem.remainingDays;
    }

    // Generate recommendations
    const recommendations = forecasts.map(f => ({
      id: f.id,
      maintenanceType: f.maintenanceType,
      priority: f.severity as 'low' | 'medium' | 'high' | 'critical',
      recommendation: f.recommendation || `Schedule ${f.maintenanceType.replace('_', ' ')}`,
      estimatedDueDate: f.estimatedDueDate,
      estimatedDueKm: f.dueMileage,
      reason: `${f.remainingKm.toFixed(0)} km remaining until service`
    }));

    // Generate alerts
    const alerts = [];
    
    for (const forecast of overdueItems) {
      alerts.push({
        id: randomUUID(),
        type: 'maintenance_overdue' as const,
        severity: 'critical' as const,
        title: `${forecast.maintenanceType.replace('_', ' ')} Overdue`,
        message: `Service was due ${Math.abs(forecast.remainingKm).toFixed(0)} km ago`,
        createdAt: new Date(),
        isRead: false
      });
    }

    for (const forecast of upcomingMaintenance) {
      if (forecast.remainingKm < 500 || (forecast.remainingDays && forecast.remainingDays < 7)) {
        alerts.push({
          id: randomUUID(),
          type: 'maintenance_approaching' as const,
          severity: 'warning' as const,
          title: `${forecast.maintenanceType.replace('_', ' ')} Due Soon`,
          message: `Only ${forecast.remainingKm.toFixed(0)} km remaining`,
          createdAt: new Date(),
          isRead: false
        });
      }
    }

    if (avgDailyKm > fleetAvgDailyKm * 1.5) {
      alerts.push({
        id: randomUUID(),
        type: 'usage_anomaly' as const,
        severity: 'info' as const,
        title: 'High Usage Detected',
        message: `Vehicle usage is ${((avgDailyKm / fleetAvgDailyKm) * 100 - 100).toFixed(0)}% above fleet average`,
        createdAt: new Date(),
        isRead: false
      });
    }

    // Calculate health score (0-100)
    const vehicleAge = now.getFullYear() - vehicle.year;
    const maxExpectedMileage = 200000; // Expected max lifetime mileage
    const mileageHealth = Math.max(0, 100 - (vehicle.currentMileage / maxExpectedMileage * 100));
    
    // Maintenance compliance - based on overdue items
    const maintenanceCompliance = overdueItems.length === 0 ? 100 : 
      Math.max(0, 100 - (overdueItems.length * 20));
    
    // Usage pattern score - penalize heavy usage
    const usagePattern = routeIntensity === 'heavy' ? 60 : 
      routeIntensity === 'medium' ? 80 : 100;
    
    // Age condition
    const ageCondition = Math.max(0, 100 - (vehicleAge * 10));
    
    // Weighted health score
    const healthScore = Math.round(
      mileageHealth * 0.3 + 
      maintenanceCompliance * 0.35 + 
      usagePattern * 0.15 + 
      ageCondition * 0.2
    );

    // Calculate wear acceleration factor
    const wearAccelerationFactor = routeIntensity === 'heavy' ? 1.5 : 
      routeIntensity === 'medium' ? 1.2 : 1.0;

    // Calculate breakdown probability
    const breakdownProbability = Math.max(0, Math.min(100, 
      (100 - healthScore) * 0.5 + 
      overdueItems.length * 10 + 
      (vehicleAge > 5 ? (vehicleAge - 5) * 5 : 0)
    ));

    // Determine risk level
    let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
    if (breakdownProbability > 60 || overdueItems.length > 2) riskLevel = 'critical';
    else if (breakdownProbability > 40 || overdueItems.length > 1) riskLevel = 'high';
    else if (breakdownProbability > 20 || overdueItems.length > 0) riskLevel = 'medium';

    // Usage intensity classification
    const usageIntensity: 'light' | 'normal' | 'heavy' = 
      routeIntensity === 'heavy' ? 'heavy' : 
      routeIntensity === 'medium' ? 'normal' : 'light';

    const healthScoreData = {
      healthScore,
      wearAccelerationFactor,
      breakdownProbability,
      riskLevel,
      usageIntensity,
      healthFactors: {
        mileageHealth: Math.round(mileageHealth),
        maintenanceCompliance,
        usagePattern,
        ageCondition
      }
    };

    // Generate monthly maintenance plan (simplified - next month projection)
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const safeAvgDailyKm = avgDailyKm > 0 ? avgDailyKm : 50; // Default to 50 km/day if no usage data
    const projectedMonthlyKm = safeAvgDailyKm * 22; // 22 working days
    const scheduledItems = forecasts
      .filter(f => f.remainingKm < projectedMonthlyKm)
      .map(f => {
        const daysUntilDue = safeAvgDailyKm > 0 ? Math.max(0, f.remainingKm / safeAvgDailyKm) : 30;
        return {
          maintenanceType: f.maintenanceType,
          estimatedDate: f.estimatedDueDate || new Date(now.getTime() + daysUntilDue * 24 * 60 * 60 * 1000),
          estimatedCost: f.maintenanceType === 'oil_change' ? 50 : 
            f.maintenanceType === 'tire_replacement' ? 400 : 
            f.maintenanceType === 'brake_service' ? 200 : 100,
          priority: f.severity
        };
      });

    const monthlyPlan = {
      month: nextMonth.toISOString().slice(0, 7),
      projectedKm: projectedMonthlyKm,
      estimatedCost: scheduledItems.reduce((sum, item) => sum + item.estimatedCost, 0),
      scheduledItems,
      status: 'planned' as const
    };

    return {
      overview: {
        vehicleId: vehicle.id,
        plateNumber: vehicle.plateNumber,
        model: vehicle.model,
        year: vehicle.year,
        assignedRepId: vehicle.assignedRepId,
        assignedRepName: assignedRep?.name || null,
        currentMileage: vehicle.currentMileage,
        lifetimeKm,
        monthlyKm: actualThisMonthKm,
        quarterlyKm,
        projectedMonthlyKm: Math.round(projectedMonthlyKmFromRoutes),
        status: vehicle.status
      },
      usage: {
        avgDailyKm,
        routeIntensity,
        fleetAvgDailyKm,
        comparedToFleet,
        dailyKmHistory,
        weeklyKmHistory
      },
      maintenance: {
        lastMaintenanceDate: lastMaintenance?.serviceDate || null,
        lastMaintenanceType: lastMaintenance?.maintenanceType || null,
        lastMaintenanceKm: lastMaintenance?.mileageAtService || null,
        upcomingMaintenance,
        overdueItems,
        daysToNextService,
        kmToNextService
      },
      healthScore: healthScoreData,
      recommendations,
      alerts,
      monthlyPlan: scheduledItems.length > 0 ? monthlyPlan : null
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

  // Trial Account Methods
  async createTrialAccount(data: InsertTrialAccount): Promise<TrialAccount> {
    const id = randomUUID();
    const now = new Date();
    const trialAccount: TrialAccount = {
      ...data,
      id,
      status: data.status || 'active',
      outletLimit: data.outletLimit ?? 100,
      vehicleLimit: data.vehicleLimit ?? 2,
      startDate: data.startDate || now,
      endDate: data.endDate || null,
      consentGiven: data.consentGiven ?? false,
      consentTimestamp: data.consentTimestamp || null,
      companyName: data.companyName || null,
      ipAddress: data.ipAddress || null,
      ipSubnet: data.ipSubnet || null,
      emailDomain: data.emailDomain || null,
      orgKey: data.orgKey || null,
      metadata: data.metadata || null,
      createdAt: now,
      updatedAt: now
    };
    this.trialAccounts.set(id, trialAccount);
    return trialAccount;
  }

  async getTrialAccount(id: string): Promise<TrialAccount | undefined> {
    return this.trialAccounts.get(id);
  }

  async getTrialAccountByEmail(email: string): Promise<TrialAccount | undefined> {
    return Array.from(this.trialAccounts.values()).find(t => t.email === email);
  }

  async updateTrialAccount(id: string, data: Partial<InsertTrialAccount>): Promise<TrialAccount | undefined> {
    const existing = this.trialAccounts.get(id);
    if (!existing) return undefined;
    
    const updated: TrialAccount = {
      ...existing,
      ...data,
      updatedAt: new Date()
    };
    this.trialAccounts.set(id, updated);
    return updated;
  }

  async getActiveTrialByOrgKey(orgKey: string): Promise<TrialAccount | undefined> {
    return Array.from(this.trialAccounts.values()).find(
      t => t.orgKey === orgKey && t.status === 'active'
    );
  }

  // Trial Usage Methods
  async createTrialUsage(trialId: string): Promise<TrialUsage> {
    const id = randomUUID();
    const now = new Date();
    const usage: TrialUsage = {
      id,
      trialId,
      outletCount: 0,
      vehicleCount: 0,
      optimizationRuns: 0,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now
    };
    this.trialUsages.set(trialId, usage);
    return usage;
  }

  async getTrialUsage(trialId: string): Promise<TrialUsage | undefined> {
    return this.trialUsages.get(trialId);
  }

  async incrementOutletCount(trialId: string, count: number = 1): Promise<TrialUsage | undefined> {
    const usage = this.trialUsages.get(trialId);
    if (!usage) return undefined;
    
    const updated: TrialUsage = {
      ...usage,
      outletCount: usage.outletCount + count,
      lastActivityAt: new Date(),
      updatedAt: new Date()
    };
    this.trialUsages.set(trialId, updated);
    return updated;
  }

  async incrementVehicleCount(trialId: string, count: number = 1): Promise<TrialUsage | undefined> {
    const usage = this.trialUsages.get(trialId);
    if (!usage) return undefined;
    
    const updated: TrialUsage = {
      ...usage,
      vehicleCount: usage.vehicleCount + count,
      lastActivityAt: new Date(),
      updatedAt: new Date()
    };
    this.trialUsages.set(trialId, updated);
    return updated;
  }

  async decrementOutletCount(trialId: string, count: number = 1): Promise<TrialUsage | undefined> {
    const usage = this.trialUsages.get(trialId);
    if (!usage) return undefined;
    
    const updated: TrialUsage = {
      ...usage,
      outletCount: Math.max(0, usage.outletCount - count),
      lastActivityAt: new Date(),
      updatedAt: new Date()
    };
    this.trialUsages.set(trialId, updated);
    return updated;
  }

  async decrementVehicleCount(trialId: string, count: number = 1): Promise<TrialUsage | undefined> {
    const usage = this.trialUsages.get(trialId);
    if (!usage) return undefined;
    
    const updated: TrialUsage = {
      ...usage,
      vehicleCount: Math.max(0, usage.vehicleCount - count),
      lastActivityAt: new Date(),
      updatedAt: new Date()
    };
    this.trialUsages.set(trialId, updated);
    return updated;
  }

  async setOutletCount(trialId: string, count: number): Promise<TrialUsage | undefined> {
    const usage = this.trialUsages.get(trialId);
    if (!usage) return undefined;
    
    const updated: TrialUsage = {
      ...usage,
      outletCount: count,
      lastActivityAt: new Date(),
      updatedAt: new Date()
    };
    this.trialUsages.set(trialId, updated);
    return updated;
  }

  async setVehicleCount(trialId: string, count: number): Promise<TrialUsage | undefined> {
    const usage = this.trialUsages.get(trialId);
    if (!usage) return undefined;
    
    const updated: TrialUsage = {
      ...usage,
      vehicleCount: count,
      lastActivityAt: new Date(),
      updatedAt: new Date()
    };
    this.trialUsages.set(trialId, updated);
    return updated;
  }

  async incrementOptimizationRuns(trialId: string): Promise<TrialUsage | undefined> {
    const usage = this.trialUsages.get(trialId);
    if (!usage) return undefined;
    
    const updated: TrialUsage = {
      ...usage,
      optimizationRuns: usage.optimizationRuns + 1,
      lastActivityAt: new Date(),
      updatedAt: new Date()
    };
    this.trialUsages.set(trialId, updated);
    return updated;
  }

  // Device Fingerprint Methods
  async createDeviceFingerprint(data: InsertDeviceFingerprint): Promise<DeviceFingerprint> {
    const id = randomUUID();
    const now = new Date();
    const fingerprint: DeviceFingerprint = {
      ...data,
      id,
      trustScore: data.trustScore ?? 100,
      anomalyFlags: data.anomalyFlags || null,
      userAgent: data.userAgent || null,
      platform: data.platform || null,
      language: data.language || null,
      languages: data.languages || null,
      timezone: data.timezone || null,
      timezoneOffset: data.timezoneOffset || null,
      screenWidth: data.screenWidth || null,
      screenHeight: data.screenHeight || null,
      screenColorDepth: data.screenColorDepth || null,
      devicePixelRatio: data.devicePixelRatio || null,
      hardwareConcurrency: data.hardwareConcurrency || null,
      deviceMemory: data.deviceMemory || null,
      maxTouchPoints: data.maxTouchPoints || null,
      canvasHash: data.canvasHash || null,
      webglVendor: data.webglVendor || null,
      webglRenderer: data.webglRenderer || null,
      webglHash: data.webglHash || null,
      audioHash: data.audioHash || null,
      fontsHash: data.fontsHash || null,
      ipAddress: data.ipAddress || null,
      ipSubnet: data.ipSubnet || null,
      connectionType: data.connectionType || null,
      localStorageId: data.localStorageId || null,
      sessionStorageId: data.sessionStorageId || null,
      cookieId: data.cookieId || null,
      firstSeenAt: data.firstSeenAt || now,
      lastSeenAt: data.lastSeenAt || now,
      createdAt: now
    };
    this.deviceFingerprints.set(id, fingerprint);
    return fingerprint;
  }

  async getDeviceFingerprintByHash(hash: string): Promise<DeviceFingerprint | undefined> {
    return Array.from(this.deviceFingerprints.values()).find(
      f => f.fingerprintHash === hash
    );
  }

  async getDeviceFingerprintsByTrialId(trialId: string): Promise<DeviceFingerprint[]> {
    return Array.from(this.deviceFingerprints.values()).filter(
      f => f.trialId === trialId
    );
  }

  async updateFingerprintTrustScore(id: string, score: number, anomalyFlags?: unknown): Promise<DeviceFingerprint | undefined> {
    const fingerprint = this.deviceFingerprints.get(id);
    if (!fingerprint) return undefined;
    
    const updated: DeviceFingerprint = {
      ...fingerprint,
      trustScore: score,
      anomalyFlags: anomalyFlags !== undefined ? anomalyFlags : fingerprint.anomalyFlags,
      lastSeenAt: new Date()
    };
    this.deviceFingerprints.set(id, updated);
    return updated;
  }

  async createFingerprintEvent(data: InsertFingerprintEvent): Promise<FingerprintEvent> {
    const id = randomUUID();
    const event: FingerprintEvent = {
      ...data,
      id,
      metadata: data.metadata || null,
      ipAddress: data.ipAddress || null,
      createdAt: new Date()
    };
    this.fingerprintEvents.set(id, event);
    return event;
  }

  // Org Risk Profile Methods
  async createOrgRiskProfile(data: InsertOrgRiskProfile): Promise<OrgRiskProfile> {
    const id = randomUUID();
    const now = new Date();
    const profile: OrgRiskProfile = {
      ...data,
      id,
      trialCount: data.trialCount ?? 0,
      activeTrialCount: data.activeTrialCount ?? 0,
      blockedTrialCount: data.blockedTrialCount ?? 0,
      riskLevel: data.riskLevel || 'low',
      riskScore: data.riskScore ?? 0,
      riskFactors: data.riskFactors || null,
      ipSubnet: data.ipSubnet || null,
      emailDomain: data.emailDomain || null,
      reverseDns: data.reverseDns || null,
      geoLocation: data.geoLocation || null,
      linkedTrialIds: data.linkedTrialIds || null,
      linkedFingerprints: data.linkedFingerprints || null,
      sharedSignals: data.sharedSignals || null,
      blockedUntil: data.blockedUntil || null,
      blockReason: data.blockReason || null,
      firstSeenAt: data.firstSeenAt || now,
      lastActivityAt: data.lastActivityAt || now,
      createdAt: now,
      updatedAt: now
    };
    this.orgRiskProfiles.set(id, profile);
    return profile;
  }

  async getOrgRiskProfileByKey(orgKey: string): Promise<OrgRiskProfile | undefined> {
    return Array.from(this.orgRiskProfiles.values()).find(
      p => p.orgKey === orgKey
    );
  }

  async updateOrgRiskProfile(id: string, data: Partial<InsertOrgRiskProfile>): Promise<OrgRiskProfile | undefined> {
    const profile = this.orgRiskProfiles.get(id);
    if (!profile) return undefined;
    
    const updated: OrgRiskProfile = {
      ...profile,
      ...data,
      updatedAt: new Date()
    };
    this.orgRiskProfiles.set(id, updated);
    return updated;
  }

  async incrementOrgTrialCount(orgKey: string): Promise<OrgRiskProfile | undefined> {
    const profile = await this.getOrgRiskProfileByKey(orgKey);
    if (!profile) return undefined;
    
    const updated: OrgRiskProfile = {
      ...profile,
      trialCount: profile.trialCount + 1,
      activeTrialCount: profile.activeTrialCount + 1,
      lastActivityAt: new Date(),
      updatedAt: new Date()
    };
    this.orgRiskProfiles.set(profile.id, updated);
    return updated;
  }

  // Trial Conversion Methods
  async createTrialConversion(data: InsertTrialConversion): Promise<TrialConversion> {
    const id = randomUUID();
    const now = new Date();
    const conversion: TrialConversion = {
      ...data,
      id,
      planType: data.planType || null,
      conversionValue: data.conversionValue || null,
      metadata: data.metadata || null,
      convertedAt: data.convertedAt || now,
      createdAt: now
    };
    this.trialConversions.set(id, conversion);
    return conversion;
  }

  async clearAll(): Promise<void> {
    // Clear optimization-related data only, preserve trial and vehicle data
    this.outlets.clear();
    this.reps.clear();
    this.schedules.clear();
    this.optimizationRuns.clear();
    this.maintenanceForecasts.clear();
    this.vehicleMileageSnapshots.clear();
    this.roleHierarchies.clear();
    this.roleSchedules.clear();
    // DO NOT clear trial-related data - preserve user's trial session
    // this.trialAccounts.clear();
    // this.trialUsages.clear();
    // this.deviceFingerprints.clear();
    // this.fingerprintEvents.clear();
    // this.orgRiskProfiles.clear();
    // this.trialConversions.clear();
    
    // Reset outlet count in trial usage for all active trials
    this.trialUsages.forEach((usage, trialId) => {
      this.trialUsages.set(trialId, {
        ...usage,
        outletCount: 0,
        lastActivityAt: new Date(),
        updatedAt: new Date()
      });
    });
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

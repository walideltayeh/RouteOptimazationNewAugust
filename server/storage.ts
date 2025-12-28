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
  type DashboardMetrics,
  type FileAnalysis,
  type VehicleAlert
} from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  // Outlets
  getOutlets(): Promise<Outlet[]>;
  getOutletsByRepId(repId: string): Promise<Outlet[]>;
  getOutletsByTerritory(territory: string): Promise<Outlet[]>;
  createOutlet(outlet: InsertOutlet): Promise<Outlet>;
  createOutlets(outlets: InsertOutlet[]): Promise<Outlet[]>;
  updateOutlet(id: string, outlet: Partial<InsertOutlet>): Promise<Outlet | undefined>;
  updateOutlets(updates: { id: string; data: Partial<InsertOutlet> }[]): Promise<Outlet[]>;
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

  // Analytics
  getDashboardMetrics(): Promise<DashboardMetrics>;
  getFileAnalysis(): Promise<FileAnalysis>;
  
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

  constructor() {
    this.outlets = new Map();
    this.reps = new Map();
    this.schedules = new Map();
    this.optimizationRuns = new Map();
    this.vehicles = new Map();
    this.vehicleMaintenanceRecords = new Map();
    this.vehicleUsageRecords = new Map();
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

  async updateOutlets(updates: { id: string; data: Partial<InsertOutlet> }[]): Promise<Outlet[]> {
    const results: Outlet[] = [];
    for (const { id, data } of updates) {
      const updated = await this.updateOutlet(id, data);
      if (updated) results.push(updated);
    }
    return results;
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
    
    // Calculate territory balance
    const territories = new Set(outlets.map(o => o.territory).filter(t => t));
    let territoryBalance = 95;
    if (territories.size > 1) {
      const outletsByTerritory = new Map<string, number>();
      outlets.forEach(o => {
        if (o.territory) {
          outletsByTerritory.set(o.territory, (outletsByTerritory.get(o.territory) || 0) + 1);
        }
      });
      const counts = Array.from(outletsByTerritory.values());
      const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length;
      const variance = counts.reduce((sum, c) => sum + Math.pow(c - avgCount, 2), 0) / counts.length;
      const stdDev = Math.sqrt(variance);
      territoryBalance = Math.max(50, Math.round(100 - (stdDev / avgCount) * 100));
    }
    
    return {
      totalOutlets,
      activeReps: activeReps.length,
      recommendedReps,
      avgDailyVisits,
      routeEfficiency: 87,
      territoryBalance,
      totalDistance: 342,
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

  async clearAll(): Promise<void> {
    this.outlets.clear();
    this.reps.clear();
    this.schedules.clear();
    this.optimizationRuns.clear();
  }
}

export const storage = new MemStorage();

import { sql } from "drizzle-orm";
import { pgTable, text, varchar, real, integer, boolean, timestamp, jsonb, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const outlets = pgTable("outlets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  address: text("address").notNull(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  visitFrequency: integer("visit_frequency").notNull(), // 1, 2, or 4 (VF1, VF2, VF4)
  territory: text("territory"),
  repId: varchar("rep_id"),
  cluster: integer("cluster"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const reps = pgTable("reps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  territory: text("territory").notNull(),
  minDailyVisits: integer("min_daily_visits").notNull().default(15),
  maxDailyVisits: integer("max_daily_visits").notNull().default(25),
  workingDaysPerWeek: integer("working_days_per_week").notNull().default(5),
  isActive: boolean("is_active").notNull().default(true),
  vehicleId: varchar("vehicle_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const schedules = pgTable("schedules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  repId: varchar("rep_id").notNull(),
  week: integer("week").notNull(), // 1, 2, 3, 4
  dayOfWeek: integer("day_of_week").notNull(), // 1-7
  outletIds: jsonb("outlet_ids").notNull(), // Array of outlet IDs
  routeOrder: jsonb("route_order").notNull(), // Optimized order of visits
  totalDistance: real("total_distance"),
  estimatedDuration: integer("estimated_duration"), // in minutes
  createdAt: timestamp("created_at").defaultNow(),
});

export const optimizationRuns = pgTable("optimization_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileName: text("file_name").notNull(),
  totalOutlets: integer("total_outlets").notNull(),
  vf1Outlets: integer("vf1_outlets").notNull().default(0),
  vf2Outlets: integer("vf2_outlets").notNull(),
  vf4Outlets: integer("vf4_outlets").notNull(),
  recommendedReps: integer("recommended_reps").notNull(),
  settings: jsonb("settings").notNull(), // optimization parameters
  status: text("status").notNull().default("pending"), // pending, processing, completed, failed
  results: jsonb("results"), // optimization results
  createdAt: timestamp("created_at").defaultNow(),
});

// Vehicle Management Tables
export const vehicles = pgTable("vehicles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  plateNumber: text("plate_number").notNull().unique(),
  model: text("model").notNull(),
  year: integer("year").notNull(),
  startingMileage: real("starting_mileage").notNull(),
  currentMileage: real("current_mileage").notNull(),
  status: text("status").notNull().default("active"), // active, maintenance, inactive
  assignedRepId: varchar("assigned_rep_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const vehicleMaintenanceRecords = pgTable("vehicle_maintenance_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vehicleId: varchar("vehicle_id").notNull(),
  maintenanceType: text("maintenance_type").notNull(), // oil_change, tire_change, service, other
  description: text("description"),
  mileageAtService: real("mileage_at_service").notNull(),
  serviceDate: timestamp("service_date").notNull(),
  cost: real("cost"),
  oilType: text("oil_type"),
  tireType: text("tire_type"),
  nextServiceMileage: real("next_service_mileage"),
  nextServiceDate: timestamp("next_service_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const vehicleUsageRecords = pgTable("vehicle_usage_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vehicleId: varchar("vehicle_id").notNull(),
  repId: varchar("rep_id").notNull(),
  scheduleId: varchar("schedule_id"),
  tripDate: timestamp("trip_date").notNull(),
  startMileage: real("start_mileage").notNull(),
  endMileage: real("end_mileage").notNull(),
  distance: real("distance").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Insert schemas
export const insertOutletSchema = createInsertSchema(outlets).omit({
  id: true,
  createdAt: true,
});

export const insertRepSchema = createInsertSchema(reps).omit({
  id: true,
  createdAt: true,
});

export const insertScheduleSchema = createInsertSchema(schedules).omit({
  id: true,
  createdAt: true,
});

export const insertOptimizationRunSchema = createInsertSchema(optimizationRuns).omit({
  id: true,
  createdAt: true,
});

export const insertVehicleSchema = createInsertSchema(vehicles).omit({
  id: true,
  createdAt: true,
});

export const insertVehicleMaintenanceSchema = createInsertSchema(vehicleMaintenanceRecords).omit({
  id: true,
  createdAt: true,
});

export const insertVehicleUsageSchema = createInsertSchema(vehicleUsageRecords).omit({
  id: true,
  createdAt: true,
});

// Types
export type InsertOutlet = z.infer<typeof insertOutletSchema>;
export type Outlet = typeof outlets.$inferSelect;

export type InsertRep = z.infer<typeof insertRepSchema>;
export type Rep = typeof reps.$inferSelect;

export type InsertSchedule = z.infer<typeof insertScheduleSchema>;
export type Schedule = typeof schedules.$inferSelect;

export type InsertOptimizationRun = z.infer<typeof insertOptimizationRunSchema>;
export type OptimizationRun = typeof optimizationRuns.$inferSelect;

export type InsertVehicle = z.infer<typeof insertVehicleSchema>;
export type Vehicle = typeof vehicles.$inferSelect;

export type InsertVehicleMaintenance = z.infer<typeof insertVehicleMaintenanceSchema>;
export type VehicleMaintenance = typeof vehicleMaintenanceRecords.$inferSelect;

export type InsertVehicleUsage = z.infer<typeof insertVehicleUsageSchema>;
export type VehicleUsage = typeof vehicleUsageRecords.$inferSelect;

// Analytics types
export interface DashboardMetrics {
  totalOutlets: number;
  activeReps: number;
  recommendedReps: number;
  avgDailyVisits: number;
  routeEfficiency: number;
  territoryBalance: number;
  totalDistance: number;
  avgTravelTime: number;
  visitEfficiency: number;
}

export interface FileAnalysis {
  outlets: number;
  vf1: number;
  vf2: number;
  vf4: number;
  recommendedReps: number;
}

export interface OptimizationSettings {
  minVisitsPerDay: number;
  maxVisitsPerDay: number;
  workingDaysPerWeek: number;
}

// Vehicle alert types
export interface VehicleAlert {
  vehicleId: string;
  plateNumber: string;
  alertType: 'oil_change_due' | 'tire_change_due' | 'service_due' | 'high_mileage';
  severity: 'low' | 'medium' | 'high';
  message: string;
  dueDate?: Date;
  dueMileage?: number;
}

// Advanced scheduling types
export interface ScheduleSlot {
  week: number; // 1-4
  dayOfWeek: number; // 1-5 (Mon-Fri)
  outletId: string;
  visitNumber: number; // 1, 2, 3, or 4 (which visit this month)
}

export interface MonthlySchedule {
  repId: string;
  territory: string;
  slots: ScheduleSlot[];
  dailyVisitCounts: Record<string, number>; // "week-day" -> count
  weeklyMileage: number[];
}

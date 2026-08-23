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
  visitFrequency: integer("visit_frequency").notNull(), // 1, 2, 3, or 4 (VF1=monthly, VF2=biweekly, VF3=3 of 4 weeks, VF4=weekly)
  timePerVisit: integer("time_per_visit").notNull().default(30), // minutes per visit
  value: real("value"), // commercial weight (VC / volume class / sales) when the source file provides one
  geoStatus: text("geo_status"), // 'offset' = geographically far outside the dataset's core coverage area; null = normal
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

export const roleHierarchies = pgTable("role_hierarchies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  repId: varchar("rep_id").notNull(), // The Sales Rep this hierarchy is linked to
  role: text("role").notNull(), // rep, merchandiser, collection_agent, etc.
  roleName: text("role_name").notNull(), // Display name: "Sales Rep", "Merchandiser", "Collection Agent"
  offsetDays: integer("offset_days").notNull().default(0), // Days after Rep visit (0 = same day as Rep)
  colorHex: text("color_hex").notNull().default("#3B82F6"), // Color for map/UI differentiation
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0), // Display order in hierarchy
  createdAt: timestamp("created_at").defaultNow(),
});

// Role Schedules - schedules generated for each role based on Rep's schedule
export const roleSchedules = pgTable("role_schedules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  hierarchyId: varchar("hierarchy_id").notNull(), // References roleHierarchies
  repId: varchar("rep_id").notNull(), // Original Sales Rep
  role: text("role").notNull(), // Role type: rep, merchandiser, collection_agent
  roleName: text("role_name").notNull(), // Display name
  week: integer("week").notNull(), // 1, 2, 3, 4
  dayOfWeek: integer("day_of_week").notNull(), // 1-7 (shifted by offsetDays)
  originalDayOfWeek: integer("original_day_of_week").notNull(), // Rep's original day
  outletIds: jsonb("outlet_ids").notNull(), // Same outlets as Rep
  routeOrder: jsonb("route_order").notNull(), // Same route order as Rep
  totalDistance: real("total_distance"),
  estimatedDuration: integer("estimated_duration"),
  offsetDays: integer("offset_days").notNull().default(0),
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

export const insertRoleHierarchySchema = createInsertSchema(roleHierarchies).omit({
  id: true,
  createdAt: true,
});

export const insertRoleScheduleSchema = createInsertSchema(roleSchedules).omit({
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

export type InsertRoleHierarchy = z.infer<typeof insertRoleHierarchySchema>;
export type RoleHierarchy = typeof roleHierarchies.$inferSelect;

export type InsertRoleSchedule = z.infer<typeof insertRoleScheduleSchema>;
export type RoleSchedule = typeof roleSchedules.$inferSelect;

// Role preset definitions
export const ROLE_PRESETS = [
  { role: 'rep', roleName: 'Sales Rep', offsetDays: 0, colorHex: '#3B82F6', sortOrder: 0 },
  { role: 'merchandiser', roleName: 'Merchandiser', offsetDays: 1, colorHex: '#10B981', sortOrder: 1 },
  { role: 'collection_agent', roleName: 'Collection Agent', offsetDays: 2, colorHex: '#F59E0B', sortOrder: 2 },
] as const;

export type RolePreset = typeof ROLE_PRESETS[number];

// Reassignment impact analysis interface
export interface MonthlyMaintenancePlanData {
  month: string;
  projectedKm: number;
  estimatedCost: number;
  scheduledItems: {
    maintenanceType: string;
    estimatedDate: Date;
    estimatedCost: number;
    priority: string;
  }[];
  status: 'planned' | 'in_progress' | 'completed';
}

// Analytics types
export interface DashboardMetrics {
  totalOutlets: number;
  activeReps: number;
  recommendedReps: number;
  avgDailyVisits: number;
  territoryBalance: number;
  totalDistance: number;
  minDailyVisits: number;
  maxDailyVisits: number;
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
  // Time-based calculation mode
  calculationMode: 'manual' | 'time-based';
  maxTimePerOutlet?: number; // max minutes per outlet (for time-based mode)
  maxWorkingHoursPerDay?: number; // max working hours per day (for time-based mode)
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

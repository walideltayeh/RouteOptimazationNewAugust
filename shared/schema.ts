import { sql } from "drizzle-orm";
import { pgTable, text, varchar, real, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const outlets = pgTable("outlets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  address: text("address").notNull(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  visitFrequency: integer("visit_frequency").notNull(), // 2 or 4 (VF2, VF4)
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
  vf2Outlets: integer("vf2_outlets").notNull(),
  vf4Outlets: integer("vf4_outlets").notNull(),
  recommendedReps: integer("recommended_reps").notNull(),
  settings: jsonb("settings").notNull(), // optimization parameters
  status: text("status").notNull().default("pending"), // pending, processing, completed, failed
  results: jsonb("results"), // optimization results
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

// Types
export type InsertOutlet = z.infer<typeof insertOutletSchema>;
export type Outlet = typeof outlets.$inferSelect;

export type InsertRep = z.infer<typeof insertRepSchema>;
export type Rep = typeof reps.$inferSelect;

export type InsertSchedule = z.infer<typeof insertScheduleSchema>;
export type Schedule = typeof schedules.$inferSelect;

export type InsertOptimizationRun = z.infer<typeof insertOptimizationRunSchema>;
export type OptimizationRun = typeof optimizationRuns.$inferSelect;

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
  vf2: number;
  vf4: number;
  recommendedReps: number;
}

export interface OptimizationSettings {
  minVisitsPerDay: number;
  maxVisitsPerDay: number;
  workingDaysPerWeek: number;
}

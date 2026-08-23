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

// ============================================
// TRIAL MANAGEMENT SYSTEM
// ============================================

// Trial account status enum values
export const TRIAL_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  CONVERTED: 'converted',
  BLOCKED: 'blocked',
  SUSPENDED: 'suspended'
} as const;

// Risk levels for organization detection
export const RISK_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  BLOCKED: 'blocked'
} as const;

// Trial limits
export const TRIAL_LIMITS = {
  MAX_OUTLETS: 100,  TRIAL_DURATION_DAYS: 14
} as const;

// Main trial accounts table
export const trialAccounts = pgTable("trial_accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  companyName: text("company_name"),
  status: text("status").notNull().default('active'), // active, expired, converted, blocked, suspended
  outletLimit: integer("outlet_limit").notNull().default(100),
  startDate: timestamp("start_date").notNull().defaultNow(),
  endDate: timestamp("end_date"), // Calculated: startDate + 14 days
  consentGiven: boolean("consent_given").notNull().default(false),
  consentTimestamp: timestamp("consent_timestamp"),
  ipAddress: text("ip_address"),
  ipSubnet: text("ip_subnet"), // /24 subnet for office detection
  emailDomain: text("email_domain"), // Extracted from email for office detection
  orgKey: text("org_key"), // Hashed combination for org detection
  metadata: jsonb("metadata"), // Additional context data
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Trial usage tracking
export const trialUsage = pgTable("trial_usage", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trialId: varchar("trial_id").notNull(),
  outletCount: integer("outlet_count").notNull().default(0),
  optimizationRuns: integer("optimization_runs").notNull().default(0),
  lastActivityAt: timestamp("last_activity_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Device fingerprints for anti-abuse detection
export const deviceFingerprints = pgTable("device_fingerprints", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trialId: varchar("trial_id").notNull(),
  fingerprintHash: text("fingerprint_hash").notNull(), // Hashed fingerprint
  
  // Browser & OS signals
  userAgent: text("user_agent"),
  platform: text("platform"),
  language: text("language"),
  languages: text("languages"), // All accepted languages
  timezone: text("timezone"),
  timezoneOffset: integer("timezone_offset"),
  
  // Screen & display
  screenWidth: integer("screen_width"),
  screenHeight: integer("screen_height"),
  screenColorDepth: integer("screen_color_depth"),
  devicePixelRatio: real("device_pixel_ratio"),
  
  // Hardware signals
  hardwareConcurrency: integer("hardware_concurrency"), // CPU cores
  deviceMemory: real("device_memory"), // GB of RAM
  maxTouchPoints: integer("max_touch_points"),
  
  // Canvas & WebGL fingerprints
  canvasHash: text("canvas_hash"),
  webglVendor: text("webgl_vendor"),
  webglRenderer: text("webgl_renderer"),
  webglHash: text("webgl_hash"),
  
  // Audio fingerprint
  audioHash: text("audio_hash"),
  
  // Font detection
  fontsHash: text("fonts_hash"),
  
  // Network signals
  ipAddress: text("ip_address"),
  ipSubnet: text("ip_subnet"), // /24 for grouping
  connectionType: text("connection_type"),
  
  // Persistent identifiers
  localStorageId: text("local_storage_id"),
  sessionStorageId: text("session_storage_id"),
  cookieId: text("cookie_id"),
  
  // Trust scoring
  trustScore: real("trust_score").notNull().default(100), // 0-100
  anomalyFlags: jsonb("anomaly_flags"), // Detected anomalies
  
  // Timestamps
  firstSeenAt: timestamp("first_seen_at").defaultNow(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Fingerprint events for audit trail
export const fingerprintEvents = pgTable("fingerprint_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fingerprintId: varchar("fingerprint_id").notNull(),
  trialId: varchar("trial_id").notNull(),
  eventType: text("event_type").notNull(), // created, matched, suspicious, blocked
  metadata: jsonb("metadata"), // Event-specific data
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Organization risk profiles for office-level detection
export const orgRiskProfiles = pgTable("org_risk_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgKey: text("org_key").notNull().unique(), // Hashed org identifier
  
  // Detection signals
  ipSubnet: text("ip_subnet"), // Primary IP subnet
  emailDomain: text("email_domain"), // Primary email domain
  reverseDns: text("reverse_dns"), // Reverse DNS lookup
  geoLocation: text("geo_location"), // City/Region
  
  // Risk assessment
  trialCount: integer("trial_count").notNull().default(0),
  activeTrialCount: integer("active_trial_count").notNull().default(0),
  blockedTrialCount: integer("blocked_trial_count").notNull().default(0),
  riskLevel: text("risk_level").notNull().default('low'), // low, medium, high, blocked
  riskScore: real("risk_score").notNull().default(0), // 0-100
  riskFactors: jsonb("risk_factors"), // Detailed risk breakdown
  
  // Related data
  linkedTrialIds: jsonb("linked_trial_ids"), // Array of trial IDs from this org
  linkedFingerprints: jsonb("linked_fingerprints"), // Array of fingerprint hashes
  sharedSignals: jsonb("shared_signals"), // Signals shared across trials
  
  // Blocking
  blockedUntil: timestamp("blocked_until"),
  blockReason: text("block_reason"),
  
  // Timestamps
  firstSeenAt: timestamp("first_seen_at").defaultNow(),
  lastActivityAt: timestamp("last_activity_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Trial conversion tracking
export const trialConversions = pgTable("trial_conversions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trialId: varchar("trial_id").notNull(),
  conversionType: text("conversion_type").notNull(), // upgrade, enterprise_contact
  planType: text("plan_type"), // basic, pro, enterprise
  conversionValue: real("conversion_value"),
  metadata: jsonb("metadata"),
  convertedAt: timestamp("converted_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Role Hierarchy - defines follow-up roles for Sales Reps
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

// Trial management insert schemas
export const insertTrialAccountSchema = createInsertSchema(trialAccounts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTrialUsageSchema = createInsertSchema(trialUsage).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertDeviceFingerprintSchema = createInsertSchema(deviceFingerprints).omit({
  id: true,
  createdAt: true,
});

export const insertFingerprintEventSchema = createInsertSchema(fingerprintEvents).omit({
  id: true,
  createdAt: true,
});

export const insertOrgRiskProfileSchema = createInsertSchema(orgRiskProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTrialConversionSchema = createInsertSchema(trialConversions).omit({
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

// Trial management types
export type InsertTrialAccount = z.infer<typeof insertTrialAccountSchema>;
export type TrialAccount = typeof trialAccounts.$inferSelect;

export type InsertTrialUsage = z.infer<typeof insertTrialUsageSchema>;
export type TrialUsage = typeof trialUsage.$inferSelect;

export type InsertDeviceFingerprint = z.infer<typeof insertDeviceFingerprintSchema>;
export type DeviceFingerprint = typeof deviceFingerprints.$inferSelect;

export type InsertFingerprintEvent = z.infer<typeof insertFingerprintEventSchema>;
export type FingerprintEvent = typeof fingerprintEvents.$inferSelect;

export type InsertOrgRiskProfile = z.infer<typeof insertOrgRiskProfileSchema>;
export type OrgRiskProfile = typeof orgRiskProfiles.$inferSelect;

export type InsertTrialConversion = z.infer<typeof insertTrialConversionSchema>;
export type TrialConversion = typeof trialConversions.$inferSelect;

// Trial status interface for frontend
export interface TrialStatus {
  isTrialMode: boolean;
  trialId: string | null;
  status: string;
  outletLimit: number;
  outletCount: number;
  outletsRemaining: number;
  daysRemaining: number;
  isExpired: boolean;
  isBlocked: boolean;
  blockReason?: string;
  upgradeRequired: boolean;
}

// Fingerprint signals collected from browser
export interface FingerprintSignals {
  // Browser & OS
  userAgent: string;
  platform: string;
  language: string;
  languages: string;
  timezone: string;
  timezoneOffset: number;
  
  // Screen
  screenWidth: number;
  screenHeight: number;
  screenColorDepth: number;
  devicePixelRatio: number;
  
  // Hardware
  hardwareConcurrency: number;
  deviceMemory: number | null;
  maxTouchPoints: number;
  
  // Canvas & WebGL
  canvasHash: string;
  webglVendor: string;
  webglRenderer: string;
  webglHash: string;
  
  // Audio
  audioHash: string;
  
  // Fonts
  fontsHash: string;
  
  // Network
  connectionType: string | null;
  
  // Persistent IDs
  localStorageId: string;
  sessionStorageId: string;
  cookieId: string;
}

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

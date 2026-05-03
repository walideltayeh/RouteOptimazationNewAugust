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

// Maintenance policies (configurable thresholds)
export const maintenancePolicies = pgTable("maintenance_policies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(), // e.g., "Oil Change", "Tire Replacement"
  maintenanceType: text("maintenance_type").notNull(), // oil_change, tire_change, brake_service, general_service
  intervalKm: real("interval_km").notNull(), // KM between services
  intervalDays: integer("interval_days"), // Days between services (optional)
  warningThresholdKm: real("warning_threshold_km").notNull(), // KM before due to trigger warning
  warningThresholdDays: integer("warning_threshold_days"), // Days before due to trigger warning
  criticalThresholdKm: real("critical_threshold_km").notNull(), // KM overdue to trigger critical alert
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// Maintenance forecasts (predicted upcoming maintenance)
export const maintenanceForecasts = pgTable("maintenance_forecasts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vehicleId: varchar("vehicle_id").notNull(),
  policyId: varchar("policy_id"),
  maintenanceType: text("maintenance_type").notNull(),
  currentMileage: real("current_mileage").notNull(),
  dueMileage: real("due_mileage").notNull(),
  estimatedDueDate: timestamp("estimated_due_date"),
  remainingKm: real("remaining_km").notNull(),
  remainingDays: integer("remaining_days"),
  severity: text("severity").notNull().default("low"), // low, medium, high, critical
  status: text("status").notNull().default("upcoming"), // upcoming, due, overdue
  recommendation: text("recommendation"),
  lastCalculatedAt: timestamp("last_calculated_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Mileage snapshots (aggregated KM data)
export const vehicleMileageSnapshots = pgTable("vehicle_mileage_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vehicleId: varchar("vehicle_id").notNull(),
  snapshotDate: date("snapshot_date").notNull(),
  dailyKm: real("daily_km").notNull().default(0),
  weeklyKm: real("weekly_km").notNull().default(0),
  monthlyKm: real("monthly_km").notNull().default(0),
  annualKm: real("annual_km").notNull().default(0),
  lifetimeKm: real("lifetime_km").notNull().default(0),
  avgDailyKm: real("avg_daily_km").notNull().default(0),
  routeIntensity: text("route_intensity").notNull().default("light"), // light, medium, heavy
  createdAt: timestamp("created_at").defaultNow(),
});

// Vehicle health metrics (predictive risk scoring)
export const vehicleHealthMetrics = pgTable("vehicle_health_metrics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vehicleId: varchar("vehicle_id").notNull(),
  healthScore: real("health_score").notNull().default(100), // 0-100
  wearAccelerationFactor: real("wear_acceleration_factor").notNull().default(1.0), // 1.0 = normal, >1.0 = accelerated
  breakdownProbability: real("breakdown_probability").notNull().default(0), // 0-100%
  riskLevel: text("risk_level").notNull().default("low"), // low, medium, high, critical
  usageIntensity: text("usage_intensity").notNull().default("normal"), // light, normal, heavy
  lastCalculatedAt: timestamp("last_calculated_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Smart recommendations (system-generated actions)
export const vehicleSmartRecommendations = pgTable("vehicle_smart_recommendations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vehicleId: varchar("vehicle_id").notNull(),
  recommendationType: text("recommendation_type").notNull(), // advance_maintenance, rotate_vehicle, reduce_route_density, adjust_schedule
  priority: text("priority").notNull().default("medium"), // low, medium, high, urgent
  title: text("title").notNull(),
  description: text("description").notNull(),
  reason: text("reason").notNull(),
  estimatedImpact: text("estimated_impact"), // e.g., "Extends service interval by 500km"
  actionRequired: boolean("action_required").notNull().default(true),
  isCompleted: boolean("is_completed").notNull().default(false),
  completedAt: timestamp("completed_at"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Odometer adjustments with audit logging
export const odometerAdjustments = pgTable("odometer_adjustments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vehicleId: varchar("vehicle_id").notNull(),
  previousMileage: real("previous_mileage").notNull(),
  newMileage: real("new_mileage").notNull(),
  adjustmentReason: text("adjustment_reason").notNull(),
  adjustedBy: text("adjusted_by").notNull(), // user or system identifier
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Monthly maintenance plan (auto-generated)
export const monthlyMaintenancePlans = pgTable("monthly_maintenance_plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vehicleId: varchar("vehicle_id").notNull(),
  planMonth: date("plan_month").notNull(), // First day of the month
  projectedKm: real("projected_km").notNull(),
  scheduledMaintenanceItems: jsonb("scheduled_maintenance_items").notNull(), // Array of maintenance items
  estimatedCost: real("estimated_cost").notNull().default(0),
  status: text("status").notNull().default("planned"), // planned, in_progress, completed
  createdAt: timestamp("created_at").defaultNow(),
});

// Vehicle reassignment history (impact analysis)
export const vehicleReassignmentHistory = pgTable("vehicle_reassignment_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vehicleId: varchar("vehicle_id").notNull(),
  fromRepId: varchar("from_rep_id"),
  toRepId: varchar("to_rep_id"),
  reassignmentDate: timestamp("reassignment_date").notNull(),
  previousAvgDailyKm: real("previous_avg_daily_km"),
  projectedAvgDailyKm: real("projected_avg_daily_km"),
  maintenanceImpact: text("maintenance_impact"), // accelerated, normal, delayed
  riskAssessment: text("risk_assessment"),
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
  MAX_OUTLETS: 100,
  MAX_VEHICLES: 2,
  TRIAL_DURATION_DAYS: 14
} as const;

// Main trial accounts table
export const trialAccounts = pgTable("trial_accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  companyName: text("company_name"),
  status: text("status").notNull().default('active'), // active, expired, converted, blocked, suspended
  outletLimit: integer("outlet_limit").notNull().default(100),
  vehicleLimit: integer("vehicle_limit").notNull().default(2),
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
  vehicleCount: integer("vehicle_count").notNull().default(0),
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

export const insertMaintenancePolicySchema = createInsertSchema(maintenancePolicies).omit({
  id: true,
  createdAt: true,
});

export const insertMaintenanceForecastSchema = createInsertSchema(maintenanceForecasts).omit({
  id: true,
  createdAt: true,
  lastCalculatedAt: true,
});

export const insertVehicleMileageSnapshotSchema = createInsertSchema(vehicleMileageSnapshots).omit({
  id: true,
  createdAt: true,
});

export const insertVehicleHealthMetricsSchema = createInsertSchema(vehicleHealthMetrics).omit({
  id: true,
  createdAt: true,
  lastCalculatedAt: true,
});

export const insertSmartRecommendationSchema = createInsertSchema(vehicleSmartRecommendations).omit({
  id: true,
  createdAt: true,
});

export const insertOdometerAdjustmentSchema = createInsertSchema(odometerAdjustments).omit({
  id: true,
  createdAt: true,
});

export const insertMonthlyMaintenancePlanSchema = createInsertSchema(monthlyMaintenancePlans).omit({
  id: true,
  createdAt: true,
});

export const insertVehicleReassignmentHistorySchema = createInsertSchema(vehicleReassignmentHistory).omit({
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

export type InsertVehicle = z.infer<typeof insertVehicleSchema>;
export type Vehicle = typeof vehicles.$inferSelect;

export type InsertVehicleMaintenance = z.infer<typeof insertVehicleMaintenanceSchema>;
export type VehicleMaintenance = typeof vehicleMaintenanceRecords.$inferSelect;

export type InsertVehicleUsage = z.infer<typeof insertVehicleUsageSchema>;
export type VehicleUsage = typeof vehicleUsageRecords.$inferSelect;

export type InsertMaintenancePolicy = z.infer<typeof insertMaintenancePolicySchema>;
export type MaintenancePolicy = typeof maintenancePolicies.$inferSelect;

export type InsertMaintenanceForecast = z.infer<typeof insertMaintenanceForecastSchema>;
export type MaintenanceForecast = typeof maintenanceForecasts.$inferSelect;

export type InsertVehicleMileageSnapshot = z.infer<typeof insertVehicleMileageSnapshotSchema>;
export type VehicleMileageSnapshot = typeof vehicleMileageSnapshots.$inferSelect;

export type InsertVehicleHealthMetrics = z.infer<typeof insertVehicleHealthMetricsSchema>;
export type VehicleHealthMetrics = typeof vehicleHealthMetrics.$inferSelect;

export type InsertSmartRecommendation = z.infer<typeof insertSmartRecommendationSchema>;
export type SmartRecommendation = typeof vehicleSmartRecommendations.$inferSelect;

export type InsertOdometerAdjustment = z.infer<typeof insertOdometerAdjustmentSchema>;
export type OdometerAdjustment = typeof odometerAdjustments.$inferSelect;

export type InsertMonthlyMaintenancePlan = z.infer<typeof insertMonthlyMaintenancePlanSchema>;
export type MonthlyMaintenancePlan = typeof monthlyMaintenancePlans.$inferSelect;

export type InsertVehicleReassignmentHistory = z.infer<typeof insertVehicleReassignmentHistorySchema>;
export type VehicleReassignmentHistory = typeof vehicleReassignmentHistory.$inferSelect;

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
  vehicleLimit: number;
  outletCount: number;
  vehicleCount: number;
  outletsRemaining: number;
  vehiclesRemaining: number;
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

// Vehicle Dashboard Types
export interface VehicleDashboardOverview {
  vehicleId: string;
  plateNumber: string;
  model: string;
  year: number;
  assignedRepId: string | null;
  assignedRepName: string | null;
  currentMileage: number;
  lifetimeKm: number;
  monthlyKm: number;
  quarterlyKm: number;
  projectedMonthlyKm: number;
  status: string;
}

export interface VehicleUsageMetrics {
  avgDailyKm: number;
  routeIntensity: 'light' | 'medium' | 'heavy';
  fleetAvgDailyKm: number;
  comparedToFleet: 'below' | 'average' | 'above';
  dailyKmHistory: { date: string; km: number }[];
  weeklyKmHistory: { week: string; km: number }[];
}

export interface VehicleMaintenanceStatus {
  lastMaintenanceDate: Date | null;
  lastMaintenanceType: string | null;
  lastMaintenanceKm: number | null;
  upcomingMaintenance: MaintenanceForecast[];
  overdueItems: MaintenanceForecast[];
  daysToNextService: number | null;
  kmToNextService: number | null;
}

export interface VehicleRecommendation {
  id: string;
  maintenanceType: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  recommendation: string;
  estimatedDueDate: Date | null;
  estimatedDueKm: number | null;
  reason: string;
}

export interface VehicleDashboardAlert {
  id: string;
  type: 'maintenance_approaching' | 'maintenance_overdue' | 'usage_anomaly' | 'critical_limit';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  createdAt: Date;
  isRead: boolean;
}

// Vehicle Health Score interface
export interface VehicleHealthScoreData {
  healthScore: number; // 0-100
  wearAccelerationFactor: number; // 1.0 = normal, >1.0 = accelerated
  breakdownProbability: number; // 0-100%
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  usageIntensity: 'light' | 'normal' | 'heavy';
  healthFactors: {
    mileageHealth: number;
    maintenanceCompliance: number;
    usagePattern: number;
    ageCondition: number;
  };
}

// Reassignment impact analysis interface
export interface VehicleReassignmentImpact {
  fromRepId: string | null;
  toRepId: string;
  fromRepName: string | null;
  toRepName: string;
  currentAvgDailyKm: number;
  projectedAvgDailyKm: number;
  kmChangePercent: number;
  maintenanceImpact: 'accelerated' | 'normal' | 'delayed';
  affectedMaintenanceItems: {
    maintenanceType: string;
    currentDueDate: Date | null;
    projectedDueDate: Date | null;
    daysDifference: number;
  }[];
  riskAssessment: {
    level: 'low' | 'medium' | 'high';
    reason: string;
  };
}

// Monthly maintenance plan interface
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

export interface VehicleFullDashboard {
  overview: VehicleDashboardOverview;
  usage: VehicleUsageMetrics;
  maintenance: VehicleMaintenanceStatus;
  healthScore: VehicleHealthScoreData;
  recommendations: VehicleRecommendation[];
  alerts: VehicleDashboardAlert[];
  monthlyPlan: MonthlyMaintenancePlanData | null;
}

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
  // Time-based calculation mode
  calculationMode: 'manual' | 'time-based';
  maxTimePerOutlet?: number; // max minutes per outlet (for time-based mode)
  maxWorkingHoursPerDay?: number; // max working hours per day (for time-based mode)
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

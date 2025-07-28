import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertOptimizationRunSchema, insertOutletSchema, insertRepSchema, insertScheduleSchema, type InsertSchedule, type Rep, type Outlet } from "@shared/schema";
import multer from "multer";
import * as XLSX from "xlsx";
import Papa from "papaparse";

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

const upload = multer({ storage: multer.memoryStorage() });

// Geographic clustering functions
function calculateHaversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

interface GeographicCluster {
  id: number;
  centroid: { lat: number; lng: number };
  outlets: Outlet[];
}

function performGeographicClustering(outlets: Outlet[], targetRepCount: number): GeographicCluster[] {
  if (outlets.length === 0) return [];
  
  // Calculate target cluster size (approximately 25 outlets per cluster)
  const targetClusterSize = 25;
  const optimalClusterCount = Math.max(1, Math.ceil(outlets.length / targetClusterSize));
  
  console.log(`Creating ${optimalClusterCount} geographic clusters for ${outlets.length} outlets (target: ~${targetClusterSize} outlets per cluster)`);
  
  // Step 1: Create compact geographic clusters using density-based approach
  const clusters = createCompactClusters(outlets, optimalClusterCount, targetClusterSize);
  
  // Step 2: Each cluster becomes a separate territory (no combining)
  const territories = assignClustersToReps(clusters, clusters.length);
  
  console.log(`Created ${territories.length} compact territories, each with ~${targetClusterSize} outlets`);
  return territories;
}

function createCompactClusters(outlets: Outlet[], maxClusters: number, targetSize: number): GeographicCluster[] {
  const clusters: GeographicCluster[] = [];
  const unassigned = [...outlets];
  let clusterIdCounter = 0;
  
  while (unassigned.length > 0 && clusters.length < maxClusters) {
    // Find the most central unassigned outlet as seed
    const seed = findMostCentralOutlet(unassigned);
    const cluster: GeographicCluster = {
      id: clusterIdCounter++,
      centroid: { lat: seed.latitude, lng: seed.longitude },
      outlets: [seed]
    };
    
    // Remove seed from unassigned
    const seedIndex = unassigned.findIndex(o => o.id === seed.id);
    unassigned.splice(seedIndex, 1);
    
    // Grow cluster by adding nearest outlets until target size or no more nearby outlets
    while (cluster.outlets.length < targetSize && unassigned.length > 0) {
      // Find nearest unassigned outlet to cluster centroid
      let nearestOutlet = null;
      let nearestDistance = Infinity;
      let nearestIndex = -1;
      
      unassigned.forEach((outlet, index) => {
        const distance = calculateHaversineDistance(
          outlet.latitude, outlet.longitude,
          cluster.centroid.lat, cluster.centroid.lng
        );
        
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestOutlet = outlet;
          nearestIndex = index;
        }
      });
      
      // Only add if within reasonable distance (prevents sprawling clusters)
      const maxClusterRadius = 5; // 5km max radius
      if (nearestOutlet && nearestDistance <= maxClusterRadius) {
        cluster.outlets.push(nearestOutlet);
        unassigned.splice(nearestIndex, 1);
        
        // Recalculate centroid
        cluster.centroid = {
          lat: cluster.outlets.reduce((sum, o) => sum + o.latitude, 0) / cluster.outlets.length,
          lng: cluster.outlets.reduce((sum, o) => sum + o.longitude, 0) / cluster.outlets.length
        };
      } else {
        // No more nearby outlets, stop growing this cluster
        break;
      }
    }
    
    clusters.push(cluster);
    console.log(`Cluster ${cluster.id}: ${cluster.outlets.length} outlets, radius: ${calculateClusterRadius(cluster).toFixed(2)}km`);
  }
  
  // Assign any remaining outlets to nearest existing clusters
  while (unassigned.length > 0) {
    const outlet = unassigned.pop()!;
    let nearestCluster = clusters[0];
    let nearestDistance = Infinity;
    
    clusters.forEach(cluster => {
      const distance = calculateHaversineDistance(
        outlet.latitude, outlet.longitude,
        cluster.centroid.lat, cluster.centroid.lng
      );
      
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestCluster = cluster;
      }
    });
    
    nearestCluster.outlets.push(outlet);
    // Recalculate centroid
    nearestCluster.centroid = {
      lat: nearestCluster.outlets.reduce((sum, o) => sum + o.latitude, 0) / nearestCluster.outlets.length,
      lng: nearestCluster.outlets.reduce((sum, o) => sum + o.longitude, 0) / nearestCluster.outlets.length
    };
  }
  
  return clusters;
}

function findMostCentralOutlet(outlets: Outlet[]): Outlet {
  if (outlets.length === 1) return outlets[0];
  
  // Calculate geographic center
  const center = {
    lat: outlets.reduce((sum, o) => sum + o.latitude, 0) / outlets.length,
    lng: outlets.reduce((sum, o) => sum + o.longitude, 0) / outlets.length
  };
  
  // Find outlet closest to center
  let centralOutlet = outlets[0];
  let minDistance = calculateHaversineDistance(
    outlets[0].latitude, outlets[0].longitude,
    center.lat, center.lng
  );
  
  outlets.forEach(outlet => {
    const distance = calculateHaversineDistance(
      outlet.latitude, outlet.longitude,
      center.lat, center.lng
    );
    
    if (distance < minDistance) {
      minDistance = distance;
      centralOutlet = outlet;
    }
  });
  
  return centralOutlet;
}

function calculateClusterRadius(cluster: GeographicCluster): number {
  if (cluster.outlets.length <= 1) return 0;
  
  const distances = cluster.outlets.map(outlet =>
    calculateHaversineDistance(
      outlet.latitude, outlet.longitude,
      cluster.centroid.lat, cluster.centroid.lng
    )
  );
  
  return Math.max(...distances);
}

function assignClustersToReps(clusters: GeographicCluster[], repCount: number): GeographicCluster[] {
  // Keep each cluster as a separate territory (one cluster = one rep)
  // This ensures each territory has ~25 outlets and is geographically compact
  
  console.log(`Assigning ${clusters.length} clusters as individual territories`);
  
  // Simply return all clusters as separate territories
  // Each cluster becomes a territory for one rep
  return clusters.map((cluster, index) => ({
    ...cluster,
    id: index
  }));
}

// Helper function to update territory names to be more descriptive
function updateTerritoryNames(reps: any[], clusters: GeographicCluster[]): void {
  reps.forEach((rep, index) => {
    if (index < clusters.length) {
      const cluster = clusters[index];
      const territorySize = cluster.outlets.length;
      const radius = calculateClusterRadius(cluster);
      
      // Create descriptive territory name based on cluster characteristics
      rep.territory = `Cluster ${index + 1} (${territorySize} outlets, ${radius.toFixed(1)}km radius)`;
    }
  });
}

// Helper function to generate weekly schedules for a rep
function generateWeeklySchedules(rep: Rep, outlets: Outlet[]): InsertSchedule[] {
  const schedules: InsertSchedule[] = [];
  const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const workingDays = daysOfWeek.slice(0, rep.workingDaysPerWeek);
  
  // Separate outlets by visit frequency
  const vf2Outlets = outlets.filter(o => o.visitFrequency === 2);
  const vf4Outlets = outlets.filter(o => o.visitFrequency === 4);
  
  // Generate schedules for Week 1 and Week 2 (which repeat)
  for (let week = 1; week <= 2; week++) {
    for (let dayIndex = 0; dayIndex < workingDays.length; dayIndex++) {
      const dayName = workingDays[dayIndex];
      const visitOrder: string[] = [];
      
      // Add VF4 outlets (visit every day they work)
      vf4Outlets.forEach((outlet, index) => {
        if (visitOrder.length < rep.maxDailyVisits) {
          visitOrder.push(outlet.id);
        }
      });
      
      // Add VF2 outlets (distribute across days)
      // For VF2: Week 1 visit on days 0,2,4... Week 2 visit on days 1,3,5...
      const vf2StartOffset = week === 1 ? 0 : 1;
      vf2Outlets.forEach((outlet, index) => {
        if (visitOrder.length < rep.maxDailyVisits) {
          // Distribute VF2 visits across working days
          const shouldVisitToday = (index + vf2StartOffset + (week - 1)) % rep.workingDaysPerWeek === dayIndex;
          if (shouldVisitToday) {
            visitOrder.push(outlet.id);
          }
        }
      });
      
      if (visitOrder.length > 0) {
        schedules.push({
          repId: rep.id,
          week: week,
          dayOfWeek: daysOfWeek.indexOf(dayName),
          outletIds: visitOrder,
          routeOrder: visitOrder
        });
      }
    }
  }
  
  return schedules;
}

export async function registerRoutes(app: Express): Promise<Server> {
  
  // Dashboard metrics
  app.get("/api/dashboard/metrics", async (_req, res) => {
    try {
      const metrics = await storage.getDashboardMetrics();
      res.json(metrics);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch dashboard metrics" });
    }
  });

  // File analysis
  app.get("/api/analysis", async (_req, res) => {
    try {
      const analysis = await storage.getFileAnalysis();
      res.json(analysis);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch file analysis" });
    }
  });

  // File upload and processing
  app.post("/api/upload", upload.single("file"), async (req: MulterRequest, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const { buffer, originalname, mimetype } = req.file;
      let data: any[] = [];

      // Parse file based on type
      if (mimetype === "text/csv" || originalname.endsWith(".csv")) {
        const csvText = buffer.toString("utf-8");
        console.log('CSV parsing - first 500 chars:', csvText.substring(0, 500));
        const parsed = Papa.parse(csvText, { 
          header: true, 
          skipEmptyLines: true,
          transformHeader: (header: string) => header.trim().toLowerCase()
        });
        data = parsed.data as any[];
        console.log('Parsed data sample:', data.slice(0, 3));
        console.log('Total parsed rows:', data.length);
      } else if (mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || originalname.endsWith(".xlsx")) {
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        data = XLSX.utils.sheet_to_json(worksheet);
      } else {
        return res.status(400).json({ message: "Unsupported file format. Please upload CSV or Excel files." });
      }

      if (data.length === 0) {
        return res.status(400).json({ message: "File is empty or could not be parsed" });
      }

      // Clear existing outlets
      await storage.deleteAllOutlets();

      // Process and validate data
      const outlets = [];
      for (const row of data) {
        try {
          const outlet: typeof insertOutletSchema._type = {
            name: row.outletname || row.name || row.Name || row.outlet_name || row["Outlet Name"] || `Outlet ${outlets.length + 1}`,
            address: `${row.District || ''} - ${row.Region || ''} - ${row.Area || ''}`.replace(/^- |- $|^-$/, '').trim() || row.address || row.Address || "",
            latitude: parseFloat(row.latitude || row.Latitude || row.lat || row.Lat || "0"),
            longitude: parseFloat(row.longitude || row.Longitude || row.lng || row.Lng || row.lon || row.Lon || "0"),
            visitFrequency: parseInt(row.vf || row.VF || row.visit_frequency || row["Visit Frequency"] || "2"),
            territory: row.District || row.territory || row.Territory || row.zone || row.Zone || null,
            repId: null,
            cluster: null
          };

          // Validate required fields
          if (outlet.latitude === 0 || outlet.longitude === 0) {
            console.warn(`Skipping outlet ${outlet.name} - invalid coordinates`);
            continue;
          }

          if (![2, 4].includes(outlet.visitFrequency)) {
            outlet.visitFrequency = 2; // Default to VF2
          }

          outlets.push(outlet);
        } catch (error) {
          console.warn(`Error processing row:`, row, error);
        }
      }

      if (outlets.length === 0) {
        return res.status(400).json({ message: "No valid outlets found in file" });
      }

      // Create outlets in storage
      await storage.createOutlets(outlets);

      // Calculate analysis
      const vf2Count = outlets.filter(o => o.visitFrequency === 2).length;
      const vf4Count = outlets.filter(o => o.visitFrequency === 4).length;
      const totalWeeklyVisits = (vf2Count * 2) + (vf4Count * 4);
      const recommendedReps = Math.ceil(totalWeeklyVisits / (5 * 25)); // 5 days, 25 visits max

      // Create optimization run record
      const optimizationRun = await storage.createOptimizationRun({
        fileName: originalname,
        totalOutlets: outlets.length,
        vf2Outlets: vf2Count,
        vf4Outlets: vf4Count,
        recommendedReps,
        settings: {
          minVisitsPerDay: 15,
          maxVisitsPerDay: 25,
          workingDaysPerWeek: 5
        },
        status: "completed",
        results: {
          outletsProcessed: outlets.length,
          clustering: null,
          scheduling: null
        }
      });

      res.json({
        success: true,
        runId: optimizationRun.id,
        analysis: {
          outlets: outlets.length,
          vf2: vf2Count,
          vf4: vf4Count,
          recommendedReps
        }
      });

    } catch (error) {
      console.error("File upload error:", error);
      res.status(500).json({ message: "Failed to process file" });
    }
  });

  // Outlets
  app.get("/api/outlets", async (_req, res) => {
    try {
      const outlets = await storage.getOutlets();
      res.json(outlets);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch outlets" });
    }
  });

  // Reps
  app.get("/api/reps", async (_req, res) => {
    try {
      const reps = await storage.getReps();
      res.json(reps);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch reps" });
    }
  });

  app.post("/api/reps", async (req, res) => {
    try {
      const repData = insertRepSchema.parse(req.body);
      const rep = await storage.createRep(repData);
      res.json(rep);
    } catch (error) {
      res.status(400).json({ message: "Invalid rep data" });
    }
  });

  // Schedules
  app.get("/api/schedules", async (_req, res) => {
    try {
      const schedules = await storage.getSchedules();
      res.json(schedules);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch schedules" });
    }
  });

  app.get("/api/schedules/rep/:repId", async (req, res) => {
    try {
      const schedules = await storage.getSchedulesByRepId(req.params.repId);
      res.json(schedules);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch rep schedules" });
    }
  });

  // Update schedule
  app.put("/api/schedules/:scheduleId", async (req, res) => {
    try {
      const schedule = await storage.getSchedules();
      const existing = schedule.find(s => s.id === req.params.scheduleId);
      if (!existing) {
        return res.status(404).json({ message: "Schedule not found" });
      }

      // Update the schedule with new route order
      const updateData = {
        routeOrder: req.body.routeOrder || existing.routeOrder,
        outletIds: req.body.outletIds || existing.outletIds
      };

      // Since we don't have updateSchedule method, we'll recreate it
      const updatedScheduleData = { 
        repId: existing.repId,
        week: existing.week,
        dayOfWeek: existing.dayOfWeek,
        outletIds: updateData.outletIds,
        routeOrder: updateData.routeOrder,
        totalDistance: existing.totalDistance,
        estimatedDuration: existing.estimatedDuration
      };
      const newSchedule = await storage.createSchedule(updatedScheduleData);
      
      res.json(newSchedule);
    } catch (error) {
      res.status(500).json({ message: "Failed to update schedule" });
    }
  });

  // Clear all data (New Optimization)
  app.delete("/api/clear", async (_req, res) => {
    try {
      await storage.clearAll();
      res.json({ 
        success: true, 
        message: "All data cleared successfully. Ready for new optimization." 
      });
    } catch (error) {
      console.error("Failed to clear data:", error);
      res.status(500).json({ message: "Failed to clear data" });
    }
  });

  // Route optimization
  app.post("/api/optimize", async (req, res) => {
    try {
      const outlets = await storage.getOutlets();
      if (outlets.length === 0) {
        return res.status(400).json({ message: "No outlets available for optimization" });
      }

      // Calculate total weekly visits required based on visit frequency
      const totalWeeklyVisits = outlets.reduce((sum, outlet) => sum + outlet.visitFrequency, 0);
      
      // Set default values for rep constraints (use body params if provided)
      const workingDaysPerWeek = req.body.workingDaysPerWeek || 5; // Monday to Friday
      const minVisitsPerDay = req.body.minVisitsPerDay || 25;   // Minimum visits per day per rep
      const maxVisitsPerDay = req.body.maxVisitsPerDay || 27;   // Maximum visits per day per rep
      
      // Calculate required reps based on daily visit constraints
      // Formula: Weekly visits / (working days * max visits per day)
      const maxWeeklyCapacityPerRep = workingDaysPerWeek * maxVisitsPerDay;
      const requiredReps = Math.ceil(totalWeeklyVisits / maxWeeklyCapacityPerRep);
      
      // Ensure we don't go below minimum daily visits requirement
      const minWeeklyCapacityPerRep = workingDaysPerWeek * minVisitsPerDay;
      
      // Use the calculated required reps (initial estimate)
      let finalRequiredReps = Math.max(1, requiredReps); // At least 1 rep needed

      // Clear existing reps first
      const existingReps = await storage.getReps();
      for (const rep of existingReps) {
        await storage.deleteRep(rep.id);
      }

      // Create territories based on geographic clusters (each cluster = one zone)
      console.log(`Creating zones based on geographic clustering for ${outlets.length} outlets`);
      
      // Perform geographic clustering first to determine how many zones we need
      const clusters = performGeographicClustering(outlets, outlets.length);
      const actualZoneCount = clusters.length;
      
      console.log(`Created ${actualZoneCount} geographic zones`);
      
      // Create representatives for each zone
      const allReps: Rep[] = [];
      for (let i = 0; i < actualZoneCount; i++) {
        const cluster = clusters[i];
        if (cluster.outlets.length === 0) continue;
        
        const clusterRadius = calculateClusterRadius(cluster);
        
        const newRep = await storage.createRep({
          name: `Rep ${i + 1}`,
          code: `REP${(i + 1).toString().padStart(3, '0')}`,
          territory: `Zone ${i + 1}`, // Zone 1, Zone 2, Zone 3, etc.
          maxDailyVisits: maxVisitsPerDay,
          minDailyVisits: minVisitsPerDay,
          workingDaysPerWeek,
          isActive: true
        });
        allReps.push(newRep);
        
        console.log(`Zone ${i + 1}: ${cluster.outlets.length} outlets, ${clusterRadius.toFixed(2)}km radius`);
        
        // Assign outlets to this rep
        for (const outlet of cluster.outlets) {
          await storage.updateOutlet(outlet.id, {
            repId: newRep.id,
            territory: newRep.territory,
            cluster: i
          });
        }
      }
      
      // Update final required reps to match actual zones created
      finalRequiredReps = allReps.length;

      // Generate schedules for each rep
      console.log('Generating schedules for', allReps.length, 'reps');
      for (const rep of allReps) {
        // Get updated outlets assigned to this rep
        const updatedOutlets = await storage.getOutlets();
        const repOutlets = updatedOutlets.filter(o => o.repId === rep.id);
        console.log(`Rep ${rep.name} has ${repOutlets.length} outlets`);
        
        if (repOutlets.length > 0) {
          const repSchedules = generateWeeklySchedules(rep, repOutlets);
          console.log(`Generated ${repSchedules.length} schedules for ${rep.name}`);
          for (const schedule of repSchedules) {
            await storage.createSchedule(schedule);
          }
        }
      }

      // Invalidate cache by refreshing data
      const updatedOutlets = await storage.getOutlets();
      const updatedReps = await storage.getReps();

      res.json({
        success: true,
        requiredReps: finalRequiredReps,
        assignedOutlets: updatedOutlets.filter(o => o.repId !== null).length,
        totalWeeklyVisits,
        maxWeeklyCapacityPerRep,
        minWeeklyCapacityPerRep,
        calculation: {
          totalOutlets: outlets.length,
          totalWeeklyVisits,
          workingDaysPerWeek,
          minVisitsPerDay,
          maxVisitsPerDay,
          estimatedReps: finalRequiredReps
        },
        message: `Optimization completed. ${finalRequiredReps} reps needed for ${totalWeeklyVisits} weekly visits (${minVisitsPerDay}-${maxVisitsPerDay} visits/day). ${outlets.length} outlets assigned.`
      });

    } catch (error) {
      console.error("Optimization error:", error);
      res.status(500).json({ message: "Failed to run optimization" });
    }
  });

  // Optimization runs
  app.get("/api/optimization-runs", async (_req, res) => {
    try {
      const runs = await storage.getOptimizationRuns();
      res.json(runs);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch optimization runs" });
    }
  });

  // ML forecasting endpoints
  app.post("/api/ml/forecast", async (req, res) => {
    try {
      const { outletIds, forecastDays = 30 } = req.body;
      
      // In a real implementation, this would use actual ML models
      const outlets = await storage.getOutlets();
      const filteredOutlets = outletIds 
        ? outlets.filter(o => outletIds.includes(o.id))
        : outlets;
      
      const forecasts = filteredOutlets.map(outlet => ({
        outletId: outlet.id,
        predictedVisits: Math.round((outlet.visitFrequency * forecastDays / 7) * (0.8 + Math.random() * 0.4)),
        confidence: 0.6 + Math.random() * 0.3,
        seasonalFactor: 0.9 + Math.random() * 0.3,
        trendFactor: 0.95 + Math.random() * 0.15
      }));
      
      res.json(forecasts);
    } catch (error) {
      res.status(500).json({ message: "Failed to generate ML forecasts" });
    }
  });

  app.post("/api/ml/optimize", async (req, res) => {
    try {
      const outlets = await storage.getOutlets();
      const reps = await storage.getReps();
      
      // Generate sample optimization recommendations
      const recommendations = [];
      const overloadedOutlets = outlets.filter(o => Math.random() > 0.8).slice(0, 3);
      
      for (const outlet of overloadedOutlets) {
        const currentRep = reps.find(r => r.id === outlet.repId);
        const alternativeReps = reps.filter(r => r.id !== outlet.repId);
        
        if (currentRep && alternativeReps.length > 0) {
          const recommendedRep = alternativeReps[Math.floor(Math.random() * alternativeReps.length)];
          
          recommendations.push({
            outletId: outlet.id,
            currentRepId: outlet.repId,
            recommendedRepId: recommendedRep.id,
            reason: `ML predicts ${(8 + Math.random() * 8).toFixed(1)} visits/month (${(70 + Math.random() * 25).toFixed(0)}% confidence)`,
            expectedImprovement: Math.random() * 5 + 2
          });
        }
      }
      
      res.json({
        recommendedChanges: recommendations,
        efficiencyGain: Math.random() * 0.15 + 0.05,
        workloadBalance: Math.random() * 0.2 + 0.75
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to run ML optimization" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

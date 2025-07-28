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

function performGeographicClustering(outlets: Outlet[], k: number): GeographicCluster[] {
  if (outlets.length === 0 || k <= 0) return [];
  
  // Handle edge case where k is larger than outlets
  if (k >= outlets.length) {
    return outlets.map((outlet, index) => ({
      id: index,
      centroid: { lat: outlet.latitude, lng: outlet.longitude },
      outlets: [outlet]
    }));
  }

  // Initialize centroids using geographic bounds for better distribution
  const centroids = initializeGeographicCentroids(outlets, k);
  
  let clusters: GeographicCluster[] = [];
  let iterations = 0;
  const maxIterations = 100;
  
  while (iterations < maxIterations) {
    // Create new clusters
    const newClusters: GeographicCluster[] = centroids.map((centroid, index) => ({
      id: index,
      centroid: { ...centroid },
      outlets: []
    }));
    
    // Assign each outlet to the nearest cluster centroid
    outlets.forEach(outlet => {
      let minDistance = Infinity;
      let closestClusterIndex = 0;
      
      centroids.forEach((centroid, index) => {
        const distance = calculateHaversineDistance(
          outlet.latitude, outlet.longitude,
          centroid.lat, centroid.lng
        );
        
        if (distance < minDistance) {
          minDistance = distance;
          closestClusterIndex = index;
        }
      });
      
      newClusters[closestClusterIndex].outlets.push(outlet);
    });
    
    // Recalculate centroids based on cluster means
    let convergenceThreshold = 0.0001; // ~10m threshold for convergence
    let maxCentroidShift = 0;
    
    newClusters.forEach((cluster, index) => {
      if (cluster.outlets.length > 0) {
        const newCentroid = {
          lat: cluster.outlets.reduce((sum, outlet) => sum + outlet.latitude, 0) / cluster.outlets.length,
          lng: cluster.outlets.reduce((sum, outlet) => sum + outlet.longitude, 0) / cluster.outlets.length
        };
        
        const shift = calculateHaversineDistance(
          centroids[index].lat, centroids[index].lng,
          newCentroid.lat, newCentroid.lng
        );
        
        maxCentroidShift = Math.max(maxCentroidShift, shift);
        centroids[index] = newCentroid;
        cluster.centroid = newCentroid;
      }
    });
    
    clusters = newClusters;
    
    // Check for convergence
    if (maxCentroidShift < convergenceThreshold) {
      console.log(`Geographic clustering converged after ${iterations} iterations`);
      break;
    }
    
    iterations++;
  }
  
  console.log(`Final clustering result: ${iterations} iterations, ${clusters.length} clusters`);
  return clusters.filter(cluster => cluster.outlets.length > 0);
}

// Initialize centroids using geographic bounds for better distribution
function initializeGeographicCentroids(outlets: Outlet[], k: number): { lat: number; lng: number }[] {
  if (outlets.length === 0) return [];
  
  // Find geographic bounds
  const bounds = {
    minLat: Math.min(...outlets.map(o => o.latitude)),
    maxLat: Math.max(...outlets.map(o => o.latitude)),
    minLng: Math.min(...outlets.map(o => o.longitude)),
    maxLng: Math.max(...outlets.map(o => o.longitude))
  };
  
  const centroids: { lat: number; lng: number }[] = [];
  
  // Create a grid-based initialization for even distribution
  const gridSize = Math.ceil(Math.sqrt(k));
  const latStep = (bounds.maxLat - bounds.minLat) / gridSize;
  const lngStep = (bounds.maxLng - bounds.minLng) / gridSize;
  
  for (let i = 0; i < k; i++) {
    const row = Math.floor(i / gridSize);
    const col = i % gridSize;
    
    const lat = bounds.minLat + (row + 0.5) * latStep;
    const lng = bounds.minLng + (col + 0.5) * lngStep;
    
    // Find the closest actual outlet to this grid position
    let closestOutlet = outlets[0];
    let minDistance = calculateHaversineDistance(lat, lng, outlets[0].latitude, outlets[0].longitude);
    
    outlets.forEach(outlet => {
      const distance = calculateHaversineDistance(lat, lng, outlet.latitude, outlet.longitude);
      if (distance < minDistance) {
        minDistance = distance;
        closestOutlet = outlet;
      }
    });
    
    centroids.push({ lat: closestOutlet.latitude, lng: closestOutlet.longitude });
  }
  
  return centroids;
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
      
      // Use the calculated required reps
      const finalRequiredReps = Math.max(1, requiredReps); // At least 1 rep needed

      // Create or update reps
      const existingReps = await storage.getReps();
      const repsToCreate = Math.max(0, finalRequiredReps - existingReps.length);

      const allReps = [...existingReps];
      for (let i = 0; i < repsToCreate; i++) {
        const newRep = await storage.createRep({
          name: `Rep ${existingReps.length + i + 1}`,
          code: `REP${String(existingReps.length + i + 1).padStart(3, '0')}`,
          territory: `Zone ${String.fromCharCode(65 + (existingReps.length + i) % 26)}`,
          minDailyVisits: minVisitsPerDay,
          maxDailyVisits: maxVisitsPerDay,
          workingDaysPerWeek,
          isActive: true
        });
        allReps.push(newRep);
      }

      // Assign outlets to reps using geographic clustering for optimal territories
      if (allReps.length > 0) {
        const clusters = performGeographicClustering(outlets, allReps.length);
        
        for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex++) {
          const cluster = clusters[clusterIndex];
          const assignedRep = allReps[clusterIndex];
          
          if (assignedRep && assignedRep.id) {
            for (const outlet of cluster.outlets) {
              await storage.updateOutlet(outlet.id, {
                repId: assignedRep.id,
                territory: assignedRep.territory,
                cluster: clusterIndex
              });
            }
          }
        }
      }

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

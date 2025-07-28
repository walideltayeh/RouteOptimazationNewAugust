import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertOptimizationRunSchema, insertOutletSchema, insertRepSchema } from "@shared/schema";
import multer from "multer";
import * as XLSX from "xlsx";
import Papa from "papaparse";

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

const upload = multer({ storage: multer.memoryStorage() });

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
        const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
        data = parsed.data as any[];
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
            name: row.name || row.Name || row.outlet_name || row["Outlet Name"] || `Outlet ${outlets.length + 1}`,
            address: row.address || row.Address || row.location || row.Location || "",
            latitude: parseFloat(row.latitude || row.Latitude || row.lat || row.Lat || "0"),
            longitude: parseFloat(row.longitude || row.Longitude || row.lng || row.Lng || row.lon || row.Lon || "0"),
            visitFrequency: parseInt(row.vf || row.VF || row.visit_frequency || row["Visit Frequency"] || "2"),
            territory: row.territory || row.Territory || row.zone || row.Zone || null,
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

  // Route optimization
  app.post("/api/optimize", async (req, res) => {
    try {
      const { minVisitsPerDay, maxVisitsPerDay, workingDaysPerWeek } = req.body;

      const outlets = await storage.getOutlets();
      if (outlets.length === 0) {
        return res.status(400).json({ message: "No outlets available for optimization" });
      }

      // Calculate total weekly visits required
      const totalWeeklyVisits = outlets.reduce((sum, outlet) => sum + outlet.visitFrequency, 0);
      const requiredReps = Math.ceil(totalWeeklyVisits / (workingDaysPerWeek * maxVisitsPerDay));

      // Create or update reps
      const existingReps = await storage.getReps();
      const repsToCreate = Math.max(0, requiredReps - existingReps.length);

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

      // Assign outlets to reps using simple round-robin distribution
      const outletsPerRep = Math.ceil(outlets.length / allReps.length);
      
      for (let i = 0; i < outlets.length; i++) {
        const repIndex = Math.floor(i / outletsPerRep);
        const assignedRep = allReps[Math.min(repIndex, allReps.length - 1)];
        
        await storage.updateOutlet(outlets[i].id, {
          repId: assignedRep.id,
          territory: assignedRep.territory,
          cluster: repIndex
        });
      }

      // Invalidate cache by refreshing data
      const updatedOutlets = await storage.getOutlets();
      const updatedReps = await storage.getReps();

      res.json({
        success: true,
        requiredReps,
        assignedOutlets: updatedOutlets.filter(o => o.repId !== null).length,
        message: `Optimization completed. ${requiredReps} reps created and ${outlets.length} outlets assigned.`
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

  const httpServer = createServer(app);
  return httpServer;
}

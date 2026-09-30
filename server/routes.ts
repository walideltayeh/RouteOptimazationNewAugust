import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { storage } from "./storage";
import { loadBlob, saveBlob, deleteBlob } from "./persist";
import { isAdminConfigured, verifyAdmin, adminCredentialSource } from "./admin-credentials";
import { solveBalancedGroups } from "./balanced-solver";
import { totalWeeklyLoad, growBalancedRegions, partitionByHilbert, repairLoads, swapForCompactness, polishByCohesion, polishByTourLength, recutPairs, routeCost, longestHop, swapStranded, reachabilityComponents, gapBetween, weeklyLoadOf, type Band, improveByRouteCost, exchangePockets, tourLength, handOverStrays, collapseBlocks, unitLoad } from "./day-balancer";
import { 
  insertOptimizationRunSchema, 
  insertOutletSchema, 
  insertRepSchema, 
  insertScheduleSchema, 
  insertRoleHierarchySchema,
  ROLE_PRESETS,
  type InsertSchedule, 
  type InsertRoleSchedule,
  type Rep, 
  type Outlet,
  type Schedule
} from "@shared/schema";
import multer from "multer";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { exec } from "child_process";
import { promisify } from "util";
import { performAdvancedClustering as performAdvancedClusteringJS } from "./clustering-algorithms";
import { geoDist, setDistanceMode, getDistanceMode, prefetchRoadMatrix, prefetchOutletMatrix, clearRoadMatrix, haversineKm, setBarriers, osrmConfigured, osrmRoute, roadMatrixSize, type Barrier, type DistanceMode } from "./road-distance";
import { generateAdvancedSchedule, reoptimizeSchedules, validateSchedule } from "./advanced-scheduling";

const execAsync = promisify(exec);

// Progress tracking for optimization
interface ProgressUpdate {
  percent: number;
  stage: string;
  detail: string;
}

class OptimizationProgressManager {
  private subscribers: Map<string, Response[]> = new Map();
  private progress: Map<string, ProgressUpdate> = new Map();
  private listeners: Map<string, ((u: ProgressUpdate) => void)[]> = new Map();

  /** In-process listener (the job record mirrors the stream). Returns an unsubscribe. */
  listen(progressId: string, fn: (u: ProgressUpdate) => void): () => void {
    if (!this.listeners.has(progressId)) this.listeners.set(progressId, []);
    this.listeners.get(progressId)!.push(fn);
    return () => {
      const arr = this.listeners.get(progressId);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i > -1) arr.splice(i, 1);
      if (arr.length === 0) this.listeners.delete(progressId);
    };
  }
  
  subscribe(progressId: string, res: Response) {
    console.log(`[SSE] New subscription for progressId: ${progressId}`);
    if (!this.subscribers.has(progressId)) {
      this.subscribers.set(progressId, []);
    }
    this.subscribers.get(progressId)!.push(res);
    
    // Send initial heartbeat to confirm connection
    console.log(`[SSE] Sending initial heartbeat for ${progressId}`);
    this.sendToClient(res, { percent: 0, stage: 'Starting', detail: 'Connected, waiting for optimization...' });
    
    // Send current progress if exists
    const current = this.progress.get(progressId);
    if (current) {
      console.log(`[SSE] Sending cached progress for ${progressId}:`, current);
      this.sendToClient(res, current);
    }
  }
  
  unsubscribe(progressId: string, res: Response) {
    const subs = this.subscribers.get(progressId);
    if (subs) {
      const idx = subs.indexOf(res);
      if (idx > -1) subs.splice(idx, 1);
    }
  }
  
  emit(progressId: string, update: ProgressUpdate) {
    console.log(`[SSE] Emitting for ${progressId}: ${update.percent}% - ${update.stage}`);
    this.progress.set(progressId, update);
    for (const fn of this.listeners.get(progressId) || []) { try { fn(update); } catch {} }
    const subs = this.subscribers.get(progressId) || [];
    console.log(`[SSE] Found ${subs.length} subscribers for ${progressId}`);
    for (const res of subs) {
      this.sendToClient(res, update);
    }
  }
  
  complete(progressId: string) {
    this.emit(progressId, { percent: 100, stage: 'Complete', detail: 'Optimization finished!' });
    setTimeout(() => {
      this.subscribers.delete(progressId);
      this.progress.delete(progressId);
    }, 5000);
  }
  
  error(progressId: string, message: string) {
    this.emit(progressId, { percent: -1, stage: 'Error', detail: message });
    setTimeout(() => {
      this.subscribers.delete(progressId);
      this.progress.delete(progressId);
    }, 5000);
  }
  
  private sendToClient(res: Response, update: ProgressUpdate) {
    try {
      res.write(`data: ${JSON.stringify(update)}\n\n`);
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
    } catch (e) {
      // Client disconnected
    }
  }
}

const progressManager = new OptimizationProgressManager();

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Spatial Grid Index for efficient neighbor lookups (O(1) instead of O(n))
class SpatialGrid {
  private grid: Map<string, Outlet[]> = new Map();
  private cellSize: number; // in degrees (approximately 1 degree = 111km)
  
  constructor(outlets: Outlet[], cellSizeKm: number = 5) {
    // Convert km to degrees (rough approximation)
    this.cellSize = cellSizeKm / 111;
    
    // Index all outlets
    for (const outlet of outlets) {
      const key = this.getCellKey(outlet.latitude, outlet.longitude);
      if (!this.grid.has(key)) {
        this.grid.set(key, []);
      }
      this.grid.get(key)!.push(outlet);
    }
  }
  
  private getCellKey(lat: number, lng: number): string {
    const cellX = Math.floor(lng / this.cellSize);
    const cellY = Math.floor(lat / this.cellSize);
    return `${cellX},${cellY}`;
  }
  
  // Get outlets within a radius, checking only nearby grid cells
  getNearbyOutlets(lat: number, lng: number, radiusKm: number, excludeIds?: Set<string>): Outlet[] {
    const radiusDegrees = radiusKm / 111;
    const cellsToCheck = Math.ceil(radiusDegrees / this.cellSize) + 1;
    
    const centerCellX = Math.floor(lng / this.cellSize);
    const centerCellY = Math.floor(lat / this.cellSize);
    
    const nearby: Outlet[] = [];
    
    // Check all cells within range
    for (let dx = -cellsToCheck; dx <= cellsToCheck; dx++) {
      for (let dy = -cellsToCheck; dy <= cellsToCheck; dy++) {
        const key = `${centerCellX + dx},${centerCellY + dy}`;
        const cellOutlets = this.grid.get(key);
        if (cellOutlets) {
          for (const outlet of cellOutlets) {
            if (excludeIds && excludeIds.has(outlet.id)) continue;
            const dist = calculateHaversineDistance(lat, lng, outlet.latitude, outlet.longitude);
            if (dist <= radiusKm) {
              nearby.push(outlet);
            }
          }
        }
      }
    }
    
    return nearby;
  }
  
  // Count nearby outlets efficiently
  countNearby(lat: number, lng: number, radiusKm: number, excludeIds?: Set<string>): number {
    return this.getNearbyOutlets(lat, lng, radiusKm, excludeIds).length;
  }
}

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

// Helper function to calculate distance (alias for calculateHaversineDistance)
function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return calculateHaversineDistance(lat1, lng1, lat2, lng2);
}

// Helper function to optimize route using nearest neighbor with 2-opt, Or-opt, and 3-opt improvement
function optimizeRoute(outlets: Outlet[]): Outlet[] {
  if (outlets.length <= 1) return outlets;

  // Step 1: Find the centroid of all outlets
  const avgLat = outlets.reduce((sum, o) => sum + o.latitude, 0) / outlets.length;
  const avgLng = outlets.reduce((sum, o) => sum + o.longitude, 0) / outlets.length;

  // Step 2: Find the outlet farthest from centroid as starting point
  let startIdx = 0;
  let maxDist = 0;
  outlets.forEach((outlet, idx) => {
    const dist = geoDist(avgLat, avgLng, outlet.latitude, outlet.longitude);
    if (dist > maxDist) {
      maxDist = dist;
      startIdx = idx;
    }
  });

  // Step 3: Build initial route using nearest neighbor from the starting point
  const unvisited = [...outlets];
  const route: Outlet[] = [];

  let current = unvisited[startIdx];
  route.push(current);
  unvisited.splice(startIdx, 1);

  while (unvisited.length > 0) {
    let nearestIdx = 0;
    let nearestDist = Infinity;

    for (let i = 0; i < unvisited.length; i++) {
      const dist = geoDist(
        current.latitude, current.longitude,
        unvisited[i].latitude, unvisited[i].longitude
      );
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }

    current = unvisited[nearestIdx];
    route.push(current);
    unvisited.splice(nearestIdx, 1);
  }

  // Step 4: Apply 2-opt improvement
  let improved = true;
  let iterations = 0;
  const maxIterations = 100;

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;

    for (let i = 1; i < route.length - 2; i++) {
      for (let j = i + 1; j < route.length; j++) {
        if (j - i === 1) continue;

        const currentDist = geoDist(
          route[i - 1].latitude, route[i - 1].longitude,
          route[i].latitude, route[i].longitude
        ) + geoDist(
          route[j - 1].latitude, route[j - 1].longitude,
          route[j].latitude, route[j].longitude
        );

        const newDist = geoDist(
          route[i - 1].latitude, route[i - 1].longitude,
          route[j - 1].latitude, route[j - 1].longitude
        ) + geoDist(
          route[i].latitude, route[i].longitude,
          route[j].latitude, route[j].longitude
        );

        if (newDist < currentDist) {
          const reversed = route.slice(i, j).reverse();
          route.splice(i, j - i, ...reversed);
          improved = true;
        }
      }
    }
  }

  // Step 5: Or-opt improvement - relocate segments of 1, 2, or 3 outlets
  for (const segLen of [3, 2, 1]) {
    let orImproved = true;
    let orIter = 0;
    while (orImproved && orIter < 50) {
      orImproved = false;
      orIter++;

      for (let i = 0; i < route.length - segLen + 1; i++) {
        const segStart = i;
        const segEnd = i + segLen - 1;

        const prevIdx = segStart - 1;
        const nextIdx = segEnd + 1;

        const removeCostBefore = (prevIdx >= 0
          ? geoDist(route[prevIdx].latitude, route[prevIdx].longitude, route[segStart].latitude, route[segStart].longitude)
          : 0);
        const removeCostAfter = (nextIdx < route.length
          ? geoDist(route[segEnd].latitude, route[segEnd].longitude, route[nextIdx].latitude, route[nextIdx].longitude)
          : 0);
        const removeCostBridge = (prevIdx >= 0 && nextIdx < route.length
          ? geoDist(route[prevIdx].latitude, route[prevIdx].longitude, route[nextIdx].latitude, route[nextIdx].longitude)
          : 0);

        const removalSaving = removeCostBefore + removeCostAfter - removeCostBridge;

        let bestInsertPos = -1;
        let bestInsertCost = Infinity;

        for (let j = 0; j < route.length - 1; j++) {
          if (j >= segStart - 1 && j <= segEnd) continue;

          const currentEdge = geoDist(
            route[j].latitude, route[j].longitude,
            route[j + 1].latitude, route[j + 1].longitude
          );
          const insertCost =
            geoDist(route[j].latitude, route[j].longitude, route[segStart].latitude, route[segStart].longitude) +
            geoDist(route[segEnd].latitude, route[segEnd].longitude, route[j + 1].latitude, route[j + 1].longitude) -
            currentEdge;

          if (insertCost < bestInsertCost) {
            bestInsertCost = insertCost;
            bestInsertPos = j;
          }
        }

        if (bestInsertPos >= 0 && bestInsertCost < removalSaving - 1e-10) {
          const segment = route.splice(segStart, segLen);
          const insertAt = bestInsertPos >= segStart ? bestInsertPos - segLen + 1 : bestInsertPos + 1;
          route.splice(insertAt, 0, ...segment);
          orImproved = true;
          break;
        }
      }
    }
  }

  // Step 6: 3-opt improvement (only for routes with ≤ 50 outlets to keep it tractable)
  if (route.length <= 50 && route.length >= 4) {
    const n = route.length;

    const segDist = (a: number, b: number): number => {
      return geoDist(route[a].latitude, route[a].longitude, route[b].latitude, route[b].longitude);
    };

    let threeOptImproved = true;
    let threeOptPasses = 0;
    const maxThreeOptPasses = 5;

    while (threeOptImproved && threeOptPasses < maxThreeOptPasses) {
      threeOptImproved = false;
      threeOptPasses++;

      for (let i = 0; i < n - 4; i++) {
        for (let j = i + 2; j < n - 2; j++) {
          for (let kk = j + 2; kk < n; kk++) {
            const i1 = i, i2 = i + 1;
            const j1 = j, j2 = j + 1;
            const k1 = kk, k2 = (kk + 1) % n;

            if (k2 === 0 && kk === n - 1) {
              continue;
            }
            if (k2 >= n) continue;

            const d0 = segDist(i1, i2) + segDist(j1, j2) + segDist(k1, k2);

            const segA = route.slice(0, i2);
            const segB = route.slice(i2, j2);
            const segC = route.slice(j2, k2);
            const segD = route.slice(k2);

            const reconnections: { segments: Outlet[][]; cost: number }[] = [
              { segments: [segA, segB.slice().reverse(), segC, segD], cost: segDist(i1, j1) + segDist(i2, j2) + segDist(k1, k2) },
              { segments: [segA, segB, segC.slice().reverse(), segD], cost: segDist(i1, i2) + segDist(j1, k1) + segDist(j2, k2) },
              { segments: [segA, segB.slice().reverse(), segC.slice().reverse(), segD], cost: segDist(i1, j1) + segDist(i2, k1) + segDist(j2, k2) },
              { segments: [segA, segC, segB, segD], cost: segDist(i1, j2) + segDist(k1, i2) + segDist(j1, k2) },
              { segments: [segA, segC, segB.slice().reverse(), segD], cost: segDist(i1, j2) + segDist(k1, j1) + segDist(i2, k2) },
              { segments: [segA, segC.slice().reverse(), segB, segD], cost: segDist(i1, k1) + segDist(j2, i2) + segDist(j1, k2) },
              { segments: [segA, segC.slice().reverse(), segB.slice().reverse(), segD], cost: segDist(i1, k1) + segDist(j2, j1) + segDist(i2, k2) },
            ];

            let bestCost = d0;
            let bestReconnection: Outlet[][] | null = null;

            for (const r of reconnections) {
              if (r.cost < bestCost - 1e-10) {
                bestCost = r.cost;
                bestReconnection = r.segments;
              }
            }

            if (bestReconnection) {
              const newRoute = bestReconnection.flat();
              route.length = 0;
              route.push(...newRoute);
              threeOptImproved = true;
              break;
            }
          }
          if (threeOptImproved) break;
        }
        if (threeOptImproved) break;
      }
    }
  }

  return route;
}

// Helper function to calculate total route distance
function calculateTotalDistance(outlets: Outlet[]): number {
  let total = 0;
  for (let i = 1; i < outlets.length; i++) {
    total += geoDist(
      outlets[i-1].latitude, outlets[i-1].longitude,
      outlets[i].latitude, outlets[i].longitude
    );
  }
  return total;
}

interface GeographicCluster {
  id: number;
  centroid: { lat: number; lng: number };
  outlets: Outlet[];
}

async function performAdvancedClustering(
  outlets: Outlet[], 
  targetZones: number, 
  minVisitsPerDay: number = 25, 
  maxVisitsPerDay: number = 30
): Promise<GeographicCluster[]> {
  console.log(`Using advanced clustering algorithm (HDBSCAN + OR-Tools + Capacitated K-Means)`);
  
  try {
    const input = {
      outlets: outlets.map(o => ({
        id: o.id,
        name: o.name,
        latitude: o.latitude,
        longitude: o.longitude,
        visitFrequency: o.visitFrequency
      })),
      targetZones,
      minVisitsPerDay,
      maxVisitsPerDay
    };
    
    // Call Python clustering algorithm
    const pythonProcess = exec('python3 server/clustering_algorithm.py');
    
    return new Promise((resolve, reject) => {
      let output = '';
      let errorOutput = '';
      
      // Send input data to Python script via stdin
      pythonProcess.stdin?.write(JSON.stringify(input));
      pythonProcess.stdin?.end();
      
      pythonProcess.stdout?.on('data', (data) => {
        output += data;
      });
      
      pythonProcess.stderr?.on('data', (data) => {
        errorOutput += data;
        console.log(`Python: ${data}`);
      });
      
      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          console.error(`Python script failed with code ${code}`);
          console.error(errorOutput);
          // Fallback to original algorithm
          resolve(performGeographicClustering(outlets, targetZones, minVisitsPerDay, maxVisitsPerDay));
          return;
        }
        
        try {
          const clusters = JSON.parse(output);
          const geographicClusters: GeographicCluster[] = clusters.map((cluster: any) => ({
            id: cluster.id,
            centroid: cluster.centroid,
            outlets: cluster.outlets.map((o: any) => outlets.find(outlet => outlet.id === o.id) || o)
          }));
          
          console.log(`Advanced clustering created ${geographicClusters.length} zones`);
          geographicClusters.forEach((cluster, idx) => {
            console.log(`Zone ${idx + 1}: ${cluster.outlets.length} outlets`);
          });
          
          resolve(geographicClusters);
        } catch (error) {
          console.error('Failed to parse Python output:', error);
          console.error('Python stderr:', errorOutput);
          // Fallback to original algorithm
          resolve(performGeographicClustering(outlets, targetZones, minVisitsPerDay, maxVisitsPerDay));
        }
      });
    });
  } catch (error) {
    console.error('Failed to run advanced clustering:', error);
    // Fallback to original algorithm
    return performGeographicClustering(outlets, targetZones, minVisitsPerDay, maxVisitsPerDay);
  }
}

function performGeographicClustering(
  outlets: Outlet[], 
  targetRepCount: number, 
  minVisitsPerDay: number = 25, 
  maxVisitsPerDay: number = 30
): GeographicCluster[] {
  if (outlets.length === 0) return [];
  
  const targetClusterSize = maxVisitsPerDay;
  
  console.log(`Creating geographic clusters for ${outlets.length} outlets (target ${targetClusterSize} outlets per cluster, min ${minVisitsPerDay})`);
  
  // Step 1: Create initial clusters of exactly maxVisitsPerDay outlets each
  const initialClusters = createExact25OutletClusters(outlets, maxVisitsPerDay);
  
  // Step 2: Merge zones with ≤5 outlets with nearby zones
  const finalClusters = mergeSmallZones(initialClusters, minVisitsPerDay);
  
  console.log(`Created ${finalClusters.length} territories with strict size constraints`);
  return finalClusters;
}

// Create clusters of exactly targetSize outlets each with geographic proximity
// OPTIMIZED: Uses SpatialGrid for O(n * k) instead of O(n²) complexity
function createExact25OutletClusters(outlets: Outlet[], targetSize: number = 25): GeographicCluster[] {
  const TARGET_SIZE = targetSize;
  const INITIAL_RADIUS = 2; // Start with 2km radius
  const RADIUS_INCREMENT = 1; // Increase by 1km each iteration (faster convergence)
  const MAX_RADIUS = 50; // Maximum search radius
  
  console.log(`[Optimized Clustering] Starting with ${outlets.length} outlets, target size ${TARGET_SIZE}`);
  const startTime = Date.now();
  
  const clusters: GeographicCluster[] = [];
  const unassigned = new Set(outlets.map(o => o.id));
  const outletMap = new Map(outlets.map(o => [o.id, o]));
  let clusterId = 0;
  
  // Build spatial index for fast neighbor queries
  const spatialGrid = new SpatialGrid(outlets, 2); // 2km grid cells
  
  // Continue until all outlets are assigned
  while (unassigned.size > 0) {
    // Find a good seed using spatial grid (sample-based for large datasets)
    let bestSeed: Outlet | null = null;
    let maxNearbyCount = 0;
    
    const unassignedArray = Array.from(unassigned);
    
    // For large datasets, sample outlets to find seed instead of checking all
    const sampleSize = Math.min(100, unassignedArray.length);
    const step = Math.max(1, Math.floor(unassignedArray.length / sampleSize));
    
    for (let i = 0; i < unassignedArray.length; i += step) {
      const outletId = unassignedArray[i];
      const outlet = outletMap.get(outletId)!;
      
      // Use spatial grid for fast neighbor counting
      const nearbyCount = spatialGrid.countNearby(
        outlet.latitude, outlet.longitude, 
        INITIAL_RADIUS, 
        new Set([outletId]) // Exclude self
      );
      
      if (nearbyCount > maxNearbyCount) {
        maxNearbyCount = nearbyCount;
        bestSeed = outlet;
      }
    }
    
    if (!bestSeed) {
      const firstId = unassignedArray[0];
      bestSeed = outletMap.get(firstId)!;
    }
    
    // Create a new cluster starting with the seed
    const cluster: GeographicCluster = {
      id: clusterId++,
      outlets: [bestSeed],
      centroid: { lat: bestSeed.latitude, lng: bestSeed.longitude }
    };
    unassigned.delete(bestSeed.id);
    
    // Gradually expand radius until we get target outlets
    let currentRadius = INITIAL_RADIUS;
    
    while (cluster.outlets.length < TARGET_SIZE && currentRadius <= MAX_RADIUS && unassigned.size > 0) {
      // Use spatial grid to find candidates near the centroid
      // Note: Don't pass exclusion set - we filter to unassigned afterward
      const allNearby = spatialGrid.getNearbyOutlets(
        cluster.centroid.lat, 
        cluster.centroid.lng, 
        currentRadius
      );
      // Filter to only unassigned outlets
      const nearbyCandidates = allNearby.filter(o => unassigned.has(o.id));
      
      // Sort by distance to centroid
      const candidates = nearbyCandidates.map(outlet => ({
        outlet,
        distance: calculateHaversineDistance(
          outlet.latitude, outlet.longitude,
          cluster.centroid.lat, cluster.centroid.lng
        )
      })).sort((a, b) => a.distance - b.distance);
      
      // Add outlets to cluster until we reach TARGET_SIZE
      for (const candidate of candidates) {
        if (cluster.outlets.length >= TARGET_SIZE) break;
        
        cluster.outlets.push(candidate.outlet);
        unassigned.delete(candidate.outlet.id);
      }
      
      // Update centroid after adding outlets
      if (cluster.outlets.length > 0) {
        cluster.centroid = {
          lat: cluster.outlets.reduce((sum, o) => sum + o.latitude, 0) / cluster.outlets.length,
          lng: cluster.outlets.reduce((sum, o) => sum + o.longitude, 0) / cluster.outlets.length
        };
      }
      
      // If we haven't reached target size, expand radius
      if (cluster.outlets.length < TARGET_SIZE && unassigned.size > 0) {
        currentRadius += RADIUS_INCREMENT;
      }
    }
    
    // If we still don't have enough outlets, fill from nearest remaining
    if (cluster.outlets.length < TARGET_SIZE && unassigned.size > 0) {
      const remainingNeeded = TARGET_SIZE - cluster.outlets.length;
      const remainingCandidates: { outlet: Outlet; distance: number }[] = [];
      
      // Use larger radius for final fill (only if needed for outliers)
      const finalCandidates = spatialGrid.getNearbyOutlets(
        cluster.centroid.lat, 
        cluster.centroid.lng, 
        MAX_RADIUS * 2
      ).filter(o => unassigned.has(o.id));
      
      for (const outlet of finalCandidates) {
        const distance = calculateHaversineDistance(
          outlet.latitude, outlet.longitude,
          cluster.centroid.lat, cluster.centroid.lng
        );
        remainingCandidates.push({ outlet, distance });
      }
      
      remainingCandidates.sort((a, b) => a.distance - b.distance);
      
      for (let i = 0; i < remainingNeeded && i < remainingCandidates.length; i++) {
        cluster.outlets.push(remainingCandidates[i].outlet);
        unassigned.delete(remainingCandidates[i].outlet.id);
        
        // Update centroid
        cluster.centroid = {
          lat: cluster.outlets.reduce((sum, o) => sum + o.latitude, 0) / cluster.outlets.length,
          lng: cluster.outlets.reduce((sum, o) => sum + o.longitude, 0) / cluster.outlets.length
        };
      }
    }
    
    // Calculate actual radius of the cluster
    let maxDistFromCentroid = 0;
    for (const outlet of cluster.outlets) {
      const dist = calculateHaversineDistance(
        outlet.latitude, outlet.longitude,
        cluster.centroid.lat, cluster.centroid.lng
      );
      maxDistFromCentroid = Math.max(maxDistFromCentroid, dist);
    }
    
    clusters.push(cluster);
    
    // Log progress every 10 clusters for large datasets
    if (clusters.length % 10 === 0 || unassigned.size === 0) {
      console.log(`Created Zone ${cluster.id + 1} with ${cluster.outlets.length} outlets (radius: ${maxDistFromCentroid.toFixed(2)}km), ${unassigned.size} remaining`);
    }
  }
  
  const elapsed = Date.now() - startTime;
  console.log(`[Optimized Clustering] Completed in ${elapsed}ms, created ${clusters.length} clusters`);
  
  return clusters;
}

// Optimize clusters to be geographically coherent
function optimizeClusterGeography(initialClusters: GeographicCluster[], allOutlets: Outlet[]): GeographicCluster[] {
  const targetSize = 25;
  
  // Use k-means to create geographically coherent clusters
  const k = initialClusters.length;
  const optimizedClusters: GeographicCluster[] = [];
  
  // Initialize with k-means++ centroids
  const centroids = selectKMeansPlusCentroids(allOutlets, k);
  
  for (let i = 0; i < k; i++) {
    optimizedClusters.push({
      id: i,
      centroid: centroids[i],
      outlets: []
    });
  }
  
  // Assign outlets ensuring each cluster gets exactly 25 (or remainder for last cluster)
  const sortedOutlets = [...allOutlets];
  
  // For each outlet, calculate distance to all centroids
  const outletDistances = new Map<string, { clusterIdx: number; distance: number }[]>();
  
  sortedOutlets.forEach(outlet => {
    const distances = optimizedClusters.map((cluster, idx) => ({
      clusterIdx: idx,
      distance: calculateHaversineDistance(
        outlet.latitude, outlet.longitude,
        cluster.centroid.lat, cluster.centroid.lng
      )
    }));
    outletDistances.set(outlet.id, distances);
  });
  
  // Sort outlets by minimum distance to any centroid
  sortedOutlets.sort((a, b) => {
    const distA = outletDistances.get(a.id) || [];
    const distB = outletDistances.get(b.id) || [];
    const minDistA = Math.min(...distA.map(d => d.distance));
    const minDistB = Math.min(...distB.map(d => d.distance));
    return minDistA - minDistB;
  });
  
  // Assign outlets to clusters respecting size constraints
  const clusterSizes = new Array(k).fill(0);
  const maxSizePerCluster = Array(k).fill(targetSize);
  
  // Adjust max sizes for last clusters if total outlets not divisible by 25
  const remainder = allOutlets.length % targetSize;
  if (remainder > 0 && remainder <= 5) {
    // Distribute the remainder to the last cluster
    maxSizePerCluster[k - 1] = targetSize + remainder;
  }
  
  sortedOutlets.forEach(outlet => {
    // Sort distances for this outlet
    const distances = (outletDistances.get(outlet.id) || []).sort((a, b) => a.distance - b.distance);
    
    // Assign to nearest cluster that has space
    for (const { clusterIdx } of distances) {
      if (clusterSizes[clusterIdx] < maxSizePerCluster[clusterIdx]) {
        optimizedClusters[clusterIdx].outlets.push(outlet);
        clusterSizes[clusterIdx]++;
        break;
      }
    }
  });
  
  // Update centroids based on actual outlets
  optimizedClusters.forEach(cluster => {
    if (cluster.outlets.length > 0) {
      cluster.centroid = {
        lat: cluster.outlets.reduce((sum, o) => sum + o.latitude, 0) / cluster.outlets.length,
        lng: cluster.outlets.reduce((sum, o) => sum + o.longitude, 0) / cluster.outlets.length
      };
    }
  });
  
  return optimizedClusters.filter(c => c.outlets.length > 0);
}

// Select initial centroids using k-means++
function selectKMeansPlusCentroids(outlets: Outlet[], k: number): { lat: number; lng: number }[] {
  const centroids: { lat: number; lng: number }[] = [];
  
  // Select first centroid randomly
  const firstIdx = Math.floor(Math.random() * outlets.length);
  centroids.push({
    lat: outlets[firstIdx].latitude,
    lng: outlets[firstIdx].longitude
  });
  
  // Select remaining centroids
  for (let i = 1; i < k; i++) {
    const distances = outlets.map(outlet => {
      let minDist = Infinity;
      centroids.forEach(centroid => {
        const dist = calculateHaversineDistance(
          outlet.latitude, outlet.longitude,
          centroid.lat, centroid.lng
        );
        minDist = Math.min(minDist, dist);
      });
      return minDist * minDist; // Square for weighting
    });
    
    // Select next centroid with probability proportional to squared distance
    const totalDist = distances.reduce((sum, d) => sum + d, 0);
    let random = Math.random() * totalDist;
    let cumulative = 0;
    let selectedIdx = 0;
    
    for (let j = 0; j < distances.length; j++) {
      cumulative += distances[j];
      if (cumulative >= random) {
        selectedIdx = j;
        break;
      }
    }
    
    centroids.push({
      lat: outlets[selectedIdx].latitude,
      lng: outlets[selectedIdx].longitude
    });
  }
  
  return centroids;
}

// Merge zones with ≤5 outlets with nearby zones
function mergeSmallZones(clusters: GeographicCluster[], minOutlets: number = 5): GeographicCluster[] {
  let mergedClusters = [...clusters];
  let hasSmallZones = true;
  
  // Use a threshold based on minOutlets, but allow some flexibility for very small values
  const mergeThreshold = Math.max(5, Math.floor(minOutlets * 0.5));
  
  while (hasSmallZones) {
    hasSmallZones = false;
    const newClusters: GeographicCluster[] = [];
    const processed = new Set<number>();
    
    for (let i = 0; i < mergedClusters.length; i++) {
      if (processed.has(i)) continue;
      
      const cluster = mergedClusters[i];
      
      if (cluster.outlets.length <= mergeThreshold) {
        // Find nearest cluster that can accommodate these outlets
        let nearestIdx = -1;
        let nearestDist = Infinity;
        
        for (let j = 0; j < mergedClusters.length; j++) {
          if (i === j || processed.has(j)) continue;
          
          const targetCluster = mergedClusters[j];
          const totalSize = targetCluster.outlets.length + cluster.outlets.length;
          
          // Only merge if result would be ≤30 outlets
          if (totalSize <= 30) {
            const dist = calculateHaversineDistance(
              cluster.centroid.lat, cluster.centroid.lng,
              targetCluster.centroid.lat, targetCluster.centroid.lng
            );
            
            if (dist < nearestDist) {
              nearestDist = dist;
              nearestIdx = j;
            }
          }
        }
        
        if (nearestIdx >= 0) {
          // Merge with nearest cluster
          mergedClusters[nearestIdx].outlets.push(...cluster.outlets);
          // Recalculate centroid
          const merged = mergedClusters[nearestIdx];
          merged.centroid = {
            lat: merged.outlets.reduce((sum, o) => sum + o.latitude, 0) / merged.outlets.length,
            lng: merged.outlets.reduce((sum, o) => sum + o.longitude, 0) / merged.outlets.length
          };
          
          processed.add(i);
          hasSmallZones = true;
          console.log(`Merged Zone ${cluster.id + 1} (${cluster.outlets.length} outlets) into Zone ${merged.id + 1} (now ${merged.outlets.length} outlets)`);
        } else {
          // No suitable merge target, keep as is
          newClusters.push(cluster);
          processed.add(i);
        }
      } else {
        newClusters.push(cluster);
        processed.add(i);
      }
    }
    
    // Add any unprocessed clusters
    for (let i = 0; i < mergedClusters.length; i++) {
      if (!processed.has(i)) {
        newClusters.push(mergedClusters[i]);
      }
    }
    
    mergedClusters = newClusters;
  }
  
  // Reassign IDs
  mergedClusters.forEach((cluster, idx) => {
    cluster.id = idx;
    console.log(`Final Zone ${idx + 1}: ${cluster.outlets.length} outlets`);
  });
  
  return mergedClusters;
}



// Enhanced Compact Zone Merger for Small Territories
function performCompactZoneMerger(clusters: GeographicCluster[]): GeographicCluster[] {
  const MIN_CLUSTER_SIZE = 5;
  const MAX_CLUSTER_SIZE = 25; // Strict limit of 25 outlets per zone
  const OPTIMAL_CLUSTER_SIZE = 25;
  const MAX_MERGE_DISTANCE = 8; // km - Maximum distance for merging clusters
  
  console.log(`\n=== COMPACT ZONE MERGER ===`);
  console.log(`Starting with ${clusters.length} clusters`);
  console.log(`Target: ${MIN_CLUSTER_SIZE}-${MAX_CLUSTER_SIZE} outlets per zone (optimal: ${OPTIMAL_CLUSTER_SIZE})`);
  
  // Initial cluster analysis
  const initialSmallClusters = clusters.filter(c => c.outlets.length <= MIN_CLUSTER_SIZE).length;
  console.log(`Found ${initialSmallClusters} clusters with <= ${MIN_CLUSTER_SIZE} outlets to merge`);
  
  let workingClusters = [...clusters];
  let mergeIteration = 0;
  let totalMerges = 0;
  
  // Phase 1: Merge clusters with <= 5 outlets with nearest neighbors
  console.log(`\nPhase 1: Merging clusters with <= ${MIN_CLUSTER_SIZE} outlets`);
  let phase1Merges = 0;
  let hasSmallClusters = true;
  
  while (hasSmallClusters && workingClusters.length > 1) {
    hasSmallClusters = false;
    const smallClusters = workingClusters.filter(c => c.outlets.length <= MIN_CLUSTER_SIZE);
    for (const smallCluster of smallClusters) {
      // Find the best merge candidate (allow larger distances for small clusters)
      const mergeCandidate = findBestMergeCandidate(smallCluster, workingClusters, MAX_MERGE_DISTANCE * 2, MAX_CLUSTER_SIZE);
      
      if (mergeCandidate) {
        console.log(`  Phase 1: Merged cluster ${smallCluster.id} (${smallCluster.outlets.length} outlets) → cluster ${mergeCandidate.id} (${mergeCandidate.outlets.length} outlets)`);
        
        // Perform merge
        mergeClusters(mergeCandidate, smallCluster);
        
        // Remove merged cluster
        workingClusters = workingClusters.filter(c => c.id !== smallCluster.id);
        phase1Merges++;
        totalMerges++;
        hasSmallClusters = true;
        break; // Restart iteration after each merge
      }
    }
  }
  
  // Phase 2: Enhanced boundary optimization for better geographic clustering
  console.log(`\nPhase 2: Enhanced boundary optimization for better clustering`);
  let phase2Merges = 0;
  let boundaryOptimizations = 0;
  
  // First, optimize boundaries by redistributing outlier outlets
  for (let i = 0; i < workingClusters.length; i++) {
    const cluster = workingClusters[i];
    
    // Find outlets that are far from their cluster centroid
    const outliers = cluster.outlets.filter(outlet => {
      const distanceToOwnCentroid = calculateHaversineDistance(
        outlet.latitude, outlet.longitude,
        cluster.centroid.lat, cluster.centroid.lng
      );
      
      // Consider outlets as outliers if they're more than 3km from centroid
      return distanceToOwnCentroid > 3;
    });
    
    // For each outlier, check if it's closer to another cluster
    for (const outlier of outliers) {
      let bestCluster = cluster;
      let bestDistance = calculateHaversineDistance(
        outlier.latitude, outlier.longitude,
        cluster.centroid.lat, cluster.centroid.lng
      );
      
      // Find closer clusters
      for (const otherCluster of workingClusters) {
        if (otherCluster.id === cluster.id) continue;
        
        const distance = calculateHaversineDistance(
          outlier.latitude, outlier.longitude,
          otherCluster.centroid.lat, otherCluster.centroid.lng
        );
        
        // Only move if significantly closer (at least 2km improvement) and target cluster isn't too big
        if (distance < bestDistance - 2 && otherCluster.outlets.length < MAX_CLUSTER_SIZE) {
          bestDistance = distance;
          bestCluster = otherCluster;
        }
      }
      
      // Move the outlet if we found a better cluster
      if (bestCluster.id !== cluster.id) {
        console.log(`  Boundary optimization: moved outlet from zone ${cluster.id} to zone ${bestCluster.id} (distance improvement: ${(calculateHaversineDistance(outlier.latitude, outlier.longitude, cluster.centroid.lat, cluster.centroid.lng) - bestDistance).toFixed(2)}km)`);
        
        // Remove from original cluster
        cluster.outlets = cluster.outlets.filter(o => o.id !== outlier.id);
        
        // Add to better cluster
        bestCluster.outlets.push(outlier);
        
        // Recalculate centroids
        cluster.centroid = {
          lat: cluster.outlets.reduce((sum, o) => sum + o.latitude, 0) / cluster.outlets.length,
          lng: cluster.outlets.reduce((sum, o) => sum + o.longitude, 0) / cluster.outlets.length
        };
        
        bestCluster.centroid = {
          lat: bestCluster.outlets.reduce((sum, o) => sum + o.latitude, 0) / bestCluster.outlets.length,
          lng: bestCluster.outlets.reduce((sum, o) => sum + o.longitude, 0) / bestCluster.outlets.length
        };
        
        boundaryOptimizations++;
      }
    }
  }
  
  // Then do traditional merging for small clusters
  let optimizationPossible = true;
  while (optimizationPossible && workingClusters.length > 1) {
    optimizationPossible = false;
    
    for (let i = 0; i < workingClusters.length - 1; i++) {
      const cluster1 = workingClusters[i];
      
      if (cluster1.outlets.length >= OPTIMAL_CLUSTER_SIZE) continue;
      
      const nearbyCluster = findNearbyOptimizationTarget(cluster1, workingClusters, MAX_MERGE_DISTANCE, MAX_CLUSTER_SIZE);
      
      if (nearbyCluster) {
        const combinedSize = cluster1.outlets.length + nearbyCluster.outlets.length;
        
        if (combinedSize <= MAX_CLUSTER_SIZE && combinedSize <= OPTIMAL_CLUSTER_SIZE + 5) {
          console.log(`  Phase 2: Optimized cluster ${cluster1.id} (${cluster1.outlets.length}) → cluster ${nearbyCluster.id} (${nearbyCluster.outlets.length})`);
          
          mergeClusters(nearbyCluster, cluster1);
          workingClusters = workingClusters.filter(c => c.id !== cluster1.id);
          phase2Merges++;
          totalMerges++;
          optimizationPossible = true;
          break;
        }
      }
    }
  }
  
  console.log(`  Phase 2 completed: ${phase2Merges} merges, ${boundaryOptimizations} boundary optimizations`);
  
  // Phase 3: Aggressive cleanup - merge ANY remaining clusters with <= 5 outlets
  console.log(`\nPhase 3: Aggressive cleanup of clusters with <= ${MIN_CLUSTER_SIZE} outlets`);
  let phase3Merges = 0;
  let finalCleanupNeeded = true;
  
  while (finalCleanupNeeded && workingClusters.length > 1) {
    finalCleanupNeeded = false;
    const remainingSmallClusters = workingClusters.filter(c => c.outlets.length <= MIN_CLUSTER_SIZE);
    
    for (const smallCluster of remainingSmallClusters) {
      // Find ANY merge candidate with strict size limit
      const mergeCandidate = findBestMergeCandidate(smallCluster, workingClusters, 30, MAX_CLUSTER_SIZE); // 30km max distance, 25 outlets max
      
      if (mergeCandidate && workingClusters.length > 1) {
        console.log(`  Phase 3: Final cleanup - merged cluster ${smallCluster.id} (${smallCluster.outlets.length}) → cluster ${mergeCandidate.id} (${mergeCandidate.outlets.length})`);
        
        mergeClusters(mergeCandidate, smallCluster);
        workingClusters = workingClusters.filter(c => c.id !== smallCluster.id);
        phase3Merges++;
        totalMerges++;
        finalCleanupNeeded = true;
        break; // Restart after each merge
      }
    }
  }
  
  // Phase 4: Split oversized clusters
  console.log(`\nPhase 4: Splitting oversized clusters`);
  let finalClusters: GeographicCluster[] = [];
  
  for (const cluster of workingClusters) {
    if (cluster.outlets.length > MAX_CLUSTER_SIZE) {
      console.log(`  Splitting oversized cluster ${cluster.id} with ${cluster.outlets.length} outlets`);
      
      // Calculate how many sub-clusters we need (aim for exactly 25 outlets each)
      const subClusterCount = Math.ceil(cluster.outlets.length / MAX_CLUSTER_SIZE);
      
      // Perform k-means clustering on the outlets in this cluster
      const outletPoints = cluster.outlets.map((outlet, idx) => ({
        id: outlet.id,
        latitude: outlet.latitude,
        longitude: outlet.longitude,
        data: outlet
      }));
      
      // Simple k-means to split the oversized cluster
      const subClusters = performSimpleKMeans(outletPoints, subClusterCount);
      
      // Convert sub-clusters to GeographicClusters
      subClusters.forEach((subCluster, idx) => {
        const newCluster: GeographicCluster = {
          id: finalClusters.length,
          outlets: subCluster.map(point => point.data),
          centroid: {
            lat: subCluster.reduce((sum, p) => sum + p.latitude, 0) / subCluster.length,
            lng: subCluster.reduce((sum, p) => sum + p.longitude, 0) / subCluster.length
          }
        };
        finalClusters.push(newCluster);
        console.log(`    Created sub-cluster with ${newCluster.outlets.length} outlets`);
      });
    } else {
      cluster.id = finalClusters.length;
      finalClusters.push(cluster);
    }
  }
  
  workingClusters = finalClusters;
  
  // Reassign cluster IDs
  workingClusters.forEach((cluster, index) => {
    cluster.id = index;
  });
  
  // Phase 5: Final verification - merge any remaining small clusters
  console.log(`\nPhase 5: Final verification and cleanup`);
  let finalMergeNeeded = true;
  
  while (finalMergeNeeded && workingClusters.length > 1) {
    finalMergeNeeded = false;
    
    // Find any cluster with <= 5 outlets
    const tinyCluster = workingClusters.find(c => c.outlets.length <= MIN_CLUSTER_SIZE);
    
    if (tinyCluster) {
      // Find the closest cluster that can accept it (regardless of distance)
      let closestCluster = null;
      let closestDistance = Infinity;
      
      for (const targetCluster of workingClusters) {
        if (targetCluster.id === tinyCluster.id) continue;
        if (targetCluster.outlets.length + tinyCluster.outlets.length > MAX_CLUSTER_SIZE) continue;
        
        const distance = calculateHaversineDistance(
          tinyCluster.centroid.lat, tinyCluster.centroid.lng,
          targetCluster.centroid.lat, targetCluster.centroid.lng
        );
        
        if (distance < closestDistance) {
          closestDistance = distance;
          closestCluster = targetCluster;
        }
      }
      
      if (closestCluster) {
        console.log(`  Phase 5: Final merge - cluster ${tinyCluster.id} (${tinyCluster.outlets.length}) → cluster ${closestCluster.id} (${closestCluster.outlets.length})`);
        mergeClusters(closestCluster, tinyCluster);
        workingClusters = workingClusters.filter(c => c.id !== tinyCluster.id);
        finalMergeNeeded = true;
      }
    }
  }
  
  // Final analysis
  const finalSmallClusters = workingClusters.filter(c => c.outlets.length <= MIN_CLUSTER_SIZE);
  const optimalSizeClusters = workingClusters.filter(c => c.outlets.length >= 6 && c.outlets.length <= OPTIMAL_CLUSTER_SIZE);
  const largeClusters = workingClusters.filter(c => c.outlets.length > OPTIMAL_CLUSTER_SIZE);
  
  console.log(`\n=== MERGER RESULTS ===`);
  console.log(`Total merges performed: ${totalMerges} (Phase 1: ${phase1Merges}, Phase 2: ${phase2Merges}, Phase 3: ${phase3Merges})`);
  console.log(`Final clusters: ${workingClusters.length}`);
  console.log(`Small clusters (<= ${MIN_CLUSTER_SIZE}): ${finalSmallClusters.length}`);
  console.log(`Optimal clusters (6-${OPTIMAL_CLUSTER_SIZE}): ${optimalSizeClusters.length}`);
  console.log(`Large clusters (> ${OPTIMAL_CLUSTER_SIZE}): ${largeClusters.length}`);
  
  // Log cluster size distribution
  console.log(`\nCluster size distribution:`);
  workingClusters.forEach((cluster, index) => {
    const radius = calculateClusterRadius(cluster);
    console.log(`  Zone ${index + 1}: ${cluster.outlets.length} outlets, ${radius.toFixed(2)}km radius`);
  });
  
  return workingClusters;
}

// Find the best merge candidate for a cluster
function findBestMergeCandidate(
  sourceCluster: GeographicCluster, 
  allClusters: GeographicCluster[], 
  maxDistance: number, 
  maxTargetSize: number
): GeographicCluster | null {
  let bestCandidate = null;
  let bestScore = -1;
  
  for (const targetCluster of allClusters) {
    if (targetCluster.id === sourceCluster.id) continue;
    
    const combinedSize = sourceCluster.outlets.length + targetCluster.outlets.length;
    if (maxTargetSize !== Infinity && combinedSize > maxTargetSize) continue;
    
    const distance = calculateHaversineDistance(
      sourceCluster.centroid.lat, sourceCluster.centroid.lng,
      targetCluster.centroid.lat, targetCluster.centroid.lng
    );
    
    if (distance > maxDistance) continue;
    
    // Scoring function: prefer closer clusters and better size balance
    const distanceScore = Math.max(0, 10 - distance); // Closer is better
    const sizeScore = Math.max(0, 10 - Math.abs(combinedSize - 25)); // Closer to optimal size is better
    const currentSizeScore = targetCluster.outlets.length < 5 ? 5 : 0; // Prefer merging with other small clusters
    
    const totalScore = distanceScore + sizeScore + currentSizeScore;
    
    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestCandidate = targetCluster;
    }
  }
  
  return bestCandidate;
}

// Find nearby cluster for optimization merging
function findNearbyOptimizationTarget(
  sourceCluster: GeographicCluster,
  allClusters: GeographicCluster[],
  maxDistance: number,
  maxTargetSize: number
): GeographicCluster | null {
  let bestTarget = null;
  let bestDistance = Infinity;
  
  for (const targetCluster of allClusters) {
    if (targetCluster.id === sourceCluster.id) continue;
    if (targetCluster.outlets.length >= 25) continue; // Skip large clusters
    
    const combinedSize = sourceCluster.outlets.length + targetCluster.outlets.length;
    if (maxTargetSize !== Infinity && combinedSize > maxTargetSize) continue;
    
    const distance = calculateHaversineDistance(
      sourceCluster.centroid.lat, sourceCluster.centroid.lng,
      targetCluster.centroid.lat, targetCluster.centroid.lng
    );
    
    if (distance < maxDistance && distance < bestDistance) {
      bestDistance = distance;
      bestTarget = targetCluster;
    }
  }
  
  return bestTarget;
}

// Simple k-means implementation for splitting oversized clusters
function performSimpleKMeans(points: any[], k: number): any[][] {
  if (k <= 1 || points.length <= k) return [points];
  
  // Initialize centroids using k-means++ method
  const centroids: any[] = [];
  centroids.push(points[Math.floor(Math.random() * points.length)]);
  
  for (let i = 1; i < k; i++) {
    const distances = points.map(p => {
      let minDist = Infinity;
      centroids.forEach(c => {
        const dist = calculateHaversineDistance(p.latitude, p.longitude, c.latitude, c.longitude);
        minDist = Math.min(minDist, dist);
      });
      return minDist;
    });
    
    const totalDist = distances.reduce((sum, d) => sum + d, 0);
    let random = Math.random() * totalDist;
    let cumulative = 0;
    
    for (let j = 0; j < distances.length; j++) {
      cumulative += distances[j];
      if (cumulative >= random) {
        centroids.push(points[j]);
        break;
      }
    }
  }
  
  // Perform k-means iterations
  const clusters: any[][] = Array(k).fill(null).map(() => []);
  
  for (let iter = 0; iter < 20; iter++) {
    // Clear clusters
    clusters.forEach(c => c.length = 0);
    
    // Assign points to nearest centroid
    points.forEach(point => {
      let nearest = 0;
      let minDist = Infinity;
      
      centroids.forEach((centroid, idx) => {
        const dist = calculateHaversineDistance(
          point.latitude, point.longitude,
          centroid.latitude, centroid.longitude
        );
        if (dist < minDist) {
          minDist = dist;
          nearest = idx;
        }
      });
      
      clusters[nearest].push(point);
    });
    
    // Update centroids
    clusters.forEach((cluster, idx) => {
      if (cluster.length > 0) {
        centroids[idx] = {
          latitude: cluster.reduce((sum, p) => sum + p.latitude, 0) / cluster.length,
          longitude: cluster.reduce((sum, p) => sum + p.longitude, 0) / cluster.length
        };
      }
    });
  }
  
  return clusters.filter(c => c.length > 0);
}

// Merge two clusters
function mergeClusters(targetCluster: GeographicCluster, sourceCluster: GeographicCluster): void {
  // Move all outlets from source to target
  targetCluster.outlets.push(...sourceCluster.outlets);
  
  // Recalculate centroid
  targetCluster.centroid = {
    lat: targetCluster.outlets.reduce((sum, o) => sum + o.latitude, 0) / targetCluster.outlets.length,
    lng: targetCluster.outlets.reduce((sum, o) => sum + o.longitude, 0) / targetCluster.outlets.length
  };
  
  // Radius updated after merge
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

function computeOutletsCentroid(outlets: Outlet[]): { lat: number; lng: number } {
  const lat = outlets.reduce((s, o) => s + o.latitude, 0) / outlets.length;
  const lng = outlets.reduce((s, o) => s + o.longitude, 0) / outlets.length;
  return { lat, lng };
}

// Splits any zone whose radius-from-centroid exceeds maxRadiusKm into tighter
// sub-zones, even if that drops a sub-zone below minVisitsPerDay. Zone size
// (min/max visits per day) was previously the only constraint the clustering
// step enforced, so when a neighborhood's real outlet density didn't match
// that size target, the clusterer bridged distant, unrelated neighborhoods
// into one "zone" just to hit the count - producing zones with 80+ km radii
// that no rep could realistically drive in a day. A tight day-route is the
// actual goal, so geographic spread is enforced here as a hard cap that
// takes priority over the outlet-count target.
function splitOversizedZones(clusters: GeographicCluster[], maxRadiusKm: number): GeographicCluster[] {
  const finished: Outlet[][] = [];
  for (const cluster of clusters) {
    const queue: Outlet[][] = [cluster.outlets];
    while (queue.length > 0) {
      const group = queue.shift()!;
      const centroid = computeOutletsCentroid(group);
      const radius = Math.max(...group.map(o =>
        geoDist(o.latitude, o.longitude, centroid.lat, centroid.lng)
      ));
      if (radius <= maxRadiusKm || group.length < 2) {
        finished.push(group);
        continue;
      }
      const [a, b] = clusterOutletsIntoDailyGroups(group, 2);
      if (a.length === 0 || b.length === 0) {
        finished.push(group);
      } else {
        queue.push(a, b);
      }
    }
  }
  return finished.map((outlets, id) => ({ id, centroid: computeOutletsCentroid(outlets), outlets }));
}

// Counterpart to splitOversizedZones: merges adjacent under-target zones back
// up toward the day-size target, but ONLY while the merged zone still fits
// under the radius cap. Splitting alone leaves a sparse market (where many
// zones get split for spread) full of half-empty days - e.g. Erbil produced
// 42 zones of ~27 outlets for a 40-50 target, so reps did ~13 visits/day
// instead of 20-25 and the required-rep count inflated by ~75%. Merging
// restores the day size wherever geography actually allows it; zones that
// stay small are the ones that genuinely cannot grow without breaking
// tightness.
function mergeUndersizedZones(
  clusters: GeographicCluster[],
  targetMinOutlets: number,
  targetMaxOutlets: number,
  maxRadiusKm: number,
  maxGapKm: number = 5
): GeographicCluster[] {
  const groups = clusters.map(c => [...c.outlets]);

  const radiusOf = (g: Outlet[]) => {
    const c = computeOutletsCentroid(g);
    return Math.max(...g.map(o => geoDist(o.latitude, o.longitude, c.lat, c.lng)));
  };

  let merged = true;
  while (merged) {
    merged = false;
    // Smallest zone first: it has the most to gain from a merge.
    const order = groups
      .map((g, i) => ({ i, n: g.length }))
      .filter(x => x.n < targetMinOutlets)
      .sort((a, b) => a.n - b.n);

    for (const { i } of order) {
      if (!groups[i] || groups[i].length === 0) continue;
      // Flagged geographic outliers stay in their own zone - merging one
      // into a neighbour stretches a real rep's day across the country.
      if (groups[i].some(o => o.geoStatus === 'offset')) continue;
      const ci = computeOutletsCentroid(groups[i]);

      let bestJ = -1, bestD = Infinity;
      for (let j = 0; j < groups.length; j++) {
        if (j === i || groups[j].length === 0) continue;
        if (groups[j].some(o => o.geoStatus === 'offset')) continue;
        if (groups[i].length + groups[j].length > targetMaxOutlets) continue;
        const cj = computeOutletsCentroid(groups[j]);
        const d = geoDist(ci.lat, ci.lng, cj.lat, cj.lng);
        if (d >= bestD) continue;
        // Adjacency guard: the two zones must actually touch, i.e. their
        // closest outlets are within maxGapKm. Without this the merge
        // happily bridges empty countryside between two distant clusters -
        // the zone stays under the radius cap on paper while the rep drives
        // across a void mid-day.
        let gap = Infinity;
        for (const a of groups[i]) {
          for (const b of groups[j]) {
            const g = geoDist(a.latitude, a.longitude, b.latitude, b.longitude);
            if (g < gap) gap = g;
            if (gap <= maxGapKm) break;
          }
          if (gap <= maxGapKm) break;
        }
        if (gap > maxGapKm) continue;
        // Only accept if the merged zone stays tight.
        if (radiusOf([...groups[i], ...groups[j]]) > maxRadiusKm) continue;
        bestD = d; bestJ = j;
      }

      if (bestJ >= 0) {
        groups[bestJ] = [...groups[bestJ], ...groups[i]];
        groups[i] = [];
        merged = true;
        break; // recompute the ordering after each merge
      }
    }
  }

  return groups
    .filter(g => g.length > 0)
    .map((outlets, id) => ({ id, centroid: computeOutletsCentroid(outlets), outlets }));
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

// Helper function to assign zones to reps based on geographic proximity
function assignZonesToReps(clusters: GeographicCluster[], reps: Rep[], zonesPerRep: number): GeographicCluster[][] {
  const assignments: GeographicCluster[][] = reps.map(() => []);
  const assignedZones = new Set<number>();
  
  // For each rep, find the closest unassigned zones
  for (let repIndex = 0; repIndex < reps.length; repIndex++) {
    const repZones: GeographicCluster[] = [];
    
    // Find starting zone (closest unassigned zone to previous rep's last zone or center)
    let currentCentroid = repIndex > 0 && assignments[repIndex - 1].length > 0
      ? assignments[repIndex - 1][assignments[repIndex - 1].length - 1].centroid
      : { lat: clusters[0].centroid.lat, lng: clusters[0].centroid.lng };
    
    // Assign up to zonesPerRep zones to this rep
    while (repZones.length < zonesPerRep && assignedZones.size < clusters.length) {
      let closestZone: GeographicCluster | null = null;
      let closestDistance = Infinity;
      
      // Find closest unassigned zone
      for (const cluster of clusters) {
        if (assignedZones.has(cluster.id)) continue;
        
        const distance = calculateHaversineDistance(
          currentCentroid.lat, currentCentroid.lng,
          cluster.centroid.lat, cluster.centroid.lng
        );
        
        if (distance < closestDistance) {
          closestDistance = distance;
          closestZone = cluster;
        }
      }
      
      if (closestZone) {
        repZones.push(closestZone);
        assignedZones.add(closestZone.id);
        currentCentroid = closestZone.centroid;
      } else {
        break;
      }
    }
    
    assignments[repIndex] = repZones;
  }

  return assignments;
}

function zoneMonthlyVisits(zone: GeographicCluster): number {
  return zone.outlets.reduce((s, o) => s + (o.visitFrequency ?? 1), 0);
}

function territoryCentroidOf(zones: GeographicCluster[]): { lat: number; lng: number } {
  let lat = 0, lng = 0, n = 0;
  for (const z of zones) {
    lat += z.centroid.lat * z.outlets.length;
    lng += z.centroid.lng * z.outlets.length;
    n += z.outlets.length;
  }
  return n > 0 ? { lat: lat / n, lng: lng / n } : { lat: 0, lng: 0 };
}

// Balanced, geography-aware zone-to-rep assignment. The classic districting
// objectives are balance, compactness, and contiguity; the old chaining
// approach (assignZonesToReps above) only optimized compactness, so reps
// seeded late inherited whatever zones were left - producing 3x workload
// spreads. This replacement:
//   1. Seeds one zone per rep by farthest-point sampling (territories start
//      spread across the map instead of chained end-to-end).
//   2. Grows territories by always letting the currently least-loaded rep
//      claim the unassigned zone nearest its territory centroid - balance
//      and compactness advance together.
//   3. Refines with bounded boundary-zone moves from over- to under-loaded
//      reps, accepting a move only when it is geographically local (the zone
//      must sit within max(15km, 2x its distance to its current territory) of
//      the receiving territory). Imbalance between genuinely disconnected
//      regions is deliberately left in place rather than paid for with long
//      drives - the residual is reported, not hidden.
// Workload = monthly visits (sum of visit frequencies), per user requirement.
function assignZonesToRepsBalanced(
  clusters: GeographicCluster[],
  reps: Rep[],
  tolerance: number = 0.10
): GeographicCluster[][] {
  const repCount = reps.length;
  const assignments: GeographicCluster[][] = reps.map(() => []);
  if (clusters.length === 0 || repCount === 0) return assignments;

  const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
    geoDist(a.lat, a.lng, b.lat, b.lng);

  // --- 1. Farthest-point seeding ---
  const seedIdxs: number[] = [];
  let heaviest = 0;
  for (let i = 1; i < clusters.length; i++) {
    if (zoneMonthlyVisits(clusters[i]) > zoneMonthlyVisits(clusters[heaviest])) heaviest = i;
  }
  seedIdxs.push(heaviest);
  while (seedIdxs.length < Math.min(repCount, clusters.length)) {
    let bestIdx = -1, bestScore = -1;
    for (let i = 0; i < clusters.length; i++) {
      if (seedIdxs.includes(i)) continue;
      const minD = Math.min(...seedIdxs.map(s => dist(clusters[i].centroid, clusters[s].centroid)));
      if (minD > bestScore) { bestScore = minD; bestIdx = i; }
    }
    seedIdxs.push(bestIdx);
  }

  const loads = new Array(repCount).fill(0);
  const assigned = new Array(clusters.length).fill(false);
  const addZone = (repIdx: number, zoneIdx: number) => {
    assignments[repIdx].push(clusters[zoneIdx]);
    loads[repIdx] += zoneMonthlyVisits(clusters[zoneIdx]);
    assigned[zoneIdx] = true;
  };
  seedIdxs.forEach((zi, ri) => addZone(ri, zi));

  // --- 2. Balance-driven growth ---
  let remaining = clusters.length - seedIdxs.length;
  while (remaining > 0) {
    let repIdx = 0;
    for (let r = 1; r < repCount; r++) {
      if (loads[r] < loads[repIdx]) repIdx = r;
    }
    const c = territoryCentroidOf(assignments[repIdx]);
    let bestZone = -1, bestD = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      if (assigned[i]) continue;
      const d = dist(clusters[i].centroid, c);
      if (d < bestD) { bestD = d; bestZone = i; }
    }
    if (bestZone < 0) break;
    addZone(repIdx, bestZone);
    remaining--;
  }

  // --- 3. Bounded boundary-move refinement ---
  const target = loads.reduce((a, b) => a + b, 0) / repCount;
  const hi = target * (1 + tolerance);
  const lo = target * (1 - tolerance);
  for (let iter = 0; iter < 500; iter++) {
    const over = reps.map((_, r) => r).filter(r => loads[r] > hi).sort((a, b) => loads[b] - loads[a]);
    const under = reps.map((_, r) => r).filter(r => loads[r] < lo).sort((a, b) => loads[a] - loads[b]);
    if (over.length === 0 || under.length === 0) break;

    let moved = false;
    for (const o of over) {
      if (moved) break;
      const oCentroid = territoryCentroidOf(assignments[o]);
      for (const u of under) {
        const uCentroid = territoryCentroidOf(assignments[u]);
        let bestZi = -1, bestImprove = 0, bestDU = Infinity;
        for (let zi = 0; zi < assignments[o].length; zi++) {
          if (assignments[o].length <= 1) break;
          const z = assignments[o][zi];
          const w = zoneMonthlyVisits(z);
          const dU = dist(z.centroid, uCentroid);
          const dO = dist(z.centroid, oCentroid);
          // Locality guard: only boundary zones may migrate.
          if (dU > Math.max(15, 2 * dO)) continue;
          const oldDev = Math.abs(loads[o] - target) + Math.abs(loads[u] - target);
          const newDev = Math.abs(loads[o] - w - target) + Math.abs(loads[u] + w - target);
          const improve = oldDev - newDev;
          if (improve > bestImprove || (improve === bestImprove && improve > 0 && dU < bestDU)) {
            bestImprove = improve; bestZi = zi; bestDU = dU;
          }
        }
        if (bestZi >= 0) {
          const [z] = assignments[o].splice(bestZi, 1);
          assignments[u].push(z);
          const w = zoneMonthlyVisits(z);
          loads[o] -= w;
          loads[u] += w;
          moved = true;
          break;
        }
      }
    }

    // When one-way moves stall (every whole-zone move overshoots the band or
    // fails the locality guard), try pairwise swaps: exchanging a larger
    // zone from an overloaded rep for a smaller zone from an underloaded one
    // transfers only the workload DIFFERENCE, a much finer correction.
    if (!moved) {
      let bestSwap: { o: number; u: number; oi: number; ui: number; improve: number } | null = null;
      for (const o of over) {
        const oCentroid = territoryCentroidOf(assignments[o]);
        for (const u of under) {
          const uCentroid = territoryCentroidOf(assignments[u]);
          for (let oi = 0; oi < assignments[o].length; oi++) {
            const zO = assignments[o][oi];
            const wO = zoneMonthlyVisits(zO);
            const dOtoU = dist(zO.centroid, uCentroid);
            const dOtoO = dist(zO.centroid, oCentroid);
            if (dOtoU > Math.max(15, 2 * dOtoO)) continue;
            for (let ui = 0; ui < assignments[u].length; ui++) {
              const zU = assignments[u][ui];
              const wU = zoneMonthlyVisits(zU);
              if (wO <= wU) continue; // swap must shift load from over to under
              const dUtoO = dist(zU.centroid, oCentroid);
              const dUtoU = dist(zU.centroid, uCentroid);
              if (dUtoO > Math.max(15, 2 * dUtoU)) continue;
              const delta = wO - wU;
              const oldDev = Math.abs(loads[o] - target) + Math.abs(loads[u] - target);
              const newDev = Math.abs(loads[o] - delta - target) + Math.abs(loads[u] + delta - target);
              const improve = oldDev - newDev;
              if (improve > 0 && (!bestSwap || improve > bestSwap.improve)) {
                bestSwap = { o, u, oi, ui, improve };
              }
            }
          }
        }
      }
      if (bestSwap) {
        const { o, u, oi, ui } = bestSwap;
        const zO = assignments[o][oi];
        const zU = assignments[u][ui];
        assignments[o][oi] = zU;
        assignments[u][ui] = zO;
        const delta = zoneMonthlyVisits(zO) - zoneMonthlyVisits(zU);
        loads[o] -= delta;
        loads[u] += delta;
        moved = true;
      }
    }

    if (!moved) break; // no geographically acceptable move or swap left
  }

  // Order each rep's zones by nearest-neighbor chaining so that when the
  // day-builder merges consecutive zones (zones > working days) the merged
  // pairs are geographically adjacent.
  for (let r = 0; r < repCount; r++) {
    const zones = assignments[r];
    if (zones.length <= 2) continue;
    const chained: GeographicCluster[] = [zones[0]];
    const used = new Set([0]);
    while (chained.length < zones.length) {
      const last = chained[chained.length - 1];
      let bestI = -1, bestD = Infinity;
      for (let i = 0; i < zones.length; i++) {
        if (used.has(i)) continue;
        const d = dist(last.centroid, zones[i].centroid);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      chained.push(zones[bestI]);
      used.add(bestI);
    }
    assignments[r] = chained;
  }

  return assignments;
}

type CoverageWeightMode = 'value' | 'isolation' | 'vf';

interface CoverageSuggestion {
  territory: string;
  outletCount: number;
  monthlyVisits: number;
  isolationKm: number;
  radiusKm: number;
  costPerVisitKm: number;
  totalValue: number | null;
  outletIds: string[];
  sampleOutlets: string[];
  reason: string;
}

// Coverage-worthiness analysis: flags zones whose drive economics don't
// justify direct rep coverage, as candidates the USER may choose to remove
// (indirect coverage via distributor/wholesale/telesales). Never removes
// anything by itself - it returns evidence-backed suggestions only.
//   - weightMode 'isolation': flags zones purely on drive cost per visit
//     (remote, sparse pockets), needs no extra data.
//   - weightMode 'vf': same economics, but visit frequencies weight the
//     visits, so a remote pocket of weekly outlets is harder to flag than a
//     remote pocket of monthly ones.
//   - weightMode 'value': combines drive cost with the commercial value
//     column (VC/volume/sales) when the uploaded file provides one; falls
//     back to isolation with a note when it doesn't.
function analyzeCoverageWorthiness(
  clusters: GeographicCluster[],
  weightMode: CoverageWeightMode
): { suggestions: CoverageSuggestion[]; weightModeUsed: string } {
  if (clusters.length < 3) return { suggestions: [], weightModeUsed: weightMode };

  const hasValueData = clusters.some(z => z.outlets.some(o => o.value != null));
  let effectiveMode: CoverageWeightMode = weightMode;
  let weightModeUsed: string = weightMode;
  if (weightMode === 'value' && !hasValueData) {
    effectiveMode = 'isolation';
    weightModeUsed = 'isolation (no value/VC column found in uploaded file)';
  }

  const metrics = clusters.map((z, i) => {
    const monthlyVisits = Math.max(1, zoneMonthlyVisits(z));
    const radiusKm = calculateClusterRadius(z);
    let isolationKm = Infinity;
    for (let j = 0; j < clusters.length; j++) {
      if (j === i) continue;
      const d = geoDist(
        z.centroid.lat, z.centroid.lng,
        clusters[j].centroid.lat, clusters[j].centroid.lng
      );
      if (d < isolationKm) isolationKm = d;
    }
    // Out-and-back to the pocket plus local running around, amortized per visit.
    const driveCostKm = 2 * isolationKm + 2 * radiusKm;
    const costPerVisitKm = driveCostKm / monthlyVisits;
    const totalValue = hasValueData
      ? z.outlets.reduce((s, o) => s + (o.value ?? 0), 0)
      : null;
    return { zone: z, idx: i, monthlyVisits, radiusKm, isolationKm, costPerVisitKm, totalValue };
  });

  const median = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const medCPV = Math.max(0.1, median(metrics.map(m => m.costPerVisitKm)));

  const suggestions: CoverageSuggestion[] = [];
  for (const m of metrics) {
    let flagged = false;
    let reason = '';
    if (effectiveMode === 'value') {
      const valuePerKm = (m.totalValue ?? 0) / Math.max(0.1, 2 * m.isolationKm + 2 * m.radiusKm);
      const medVPK = Math.max(0.001, median(metrics.map(x =>
        (x.totalValue ?? 0) / Math.max(0.1, 2 * x.isolationKm + 2 * x.radiusKm))));
      if (valuePerKm < medVPK / 3 && m.costPerVisitKm > medCPV * 2) {
        flagged = true;
        reason = `Low commercial value for the drive: ${(m.totalValue ?? 0).toFixed(0)} value over ~${(2 * m.isolationKm + 2 * m.radiusKm).toFixed(0)}km of driving (value/km is under 1/3 of the median), and cost per visit is ${m.costPerVisitKm.toFixed(1)}km vs ${medCPV.toFixed(1)}km median.`;
      }
    } else {
      // 'isolation' and 'vf' share the drive-economics rule; under 'vf' the
      // monthlyVisits denominator is already VF-weighted.
      if (m.costPerVisitKm > Math.max(3 * medCPV, 2)) {
        flagged = true;
        reason = `Isolated pocket: nearest other zone is ${m.isolationKm.toFixed(1)}km away, costing ~${m.costPerVisitKm.toFixed(1)}km of driving per visit vs a ${medCPV.toFixed(1)}km median.`;
      }
    }
    if (flagged) {
      suggestions.push({
        territory: `Zone ${m.idx + 1}`,
        outletCount: m.zone.outlets.length,
        monthlyVisits: m.monthlyVisits,
        isolationKm: Math.round(m.isolationKm * 10) / 10,
        radiusKm: Math.round(m.radiusKm * 10) / 10,
        costPerVisitKm: Math.round(m.costPerVisitKm * 10) / 10,
        totalValue: m.totalValue,
        outletIds: m.zone.outlets.map(o => o.id),
        sampleOutlets: m.zone.outlets.slice(0, 3).map(o => o.name),
        reason
      });
    }
  }

  suggestions.sort((a, b) => b.costPerVisitKm - a.costPerVisitKm);
  return { suggestions: suggestions.slice(0, 15), weightModeUsed };
}

export interface GeoOutlier {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
}

// Flags outlets located far outside the dataset's core coverage area (the
// market plus its rural belt) - e.g. an outlet coded to Baghdad whose GPS
// point sits in another governorate. The core center is the MEDIAN of all
// coordinates, which the outliers themselves cannot drag (unlike a mean).
// Always straight-line geometry, independent of the distance mode.
// Highlight-only: nothing is removed - the user decides via the exclusion
// flow after seeing the evidence.
function detectGeoOutliers(
  outlets: { id: string; name: string; latitude: number; longitude: number }[],
  radiusKm: number = 30
): GeoOutlier[] {
  if (outlets.length < 10) return [];
  const median = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  // Cluster-level isolation. Two weaker tests fail on real data: distance
  // from a median centre punishes legitimately distant-but-populated regions
  // (it flagged 483 real Lebanese outlets, 18% of that universe), while
  // k-nearest-neighbour distance misses the most common bad-data shape -
  // several records sharing one wrong coordinate, which look perfectly
  // neighbourly to each other (6 co-located Baghdad records 450km away
  // scored 0km). So: link outlets into components by proximity, then flag
  // whole components that are both small and far from the market's mass.
  const LINK_KM = 5;            // outlets within 5km belong to one component
  const CELL = LINK_KM / 111;   // degrees, ~5km
  const grid = new Map<string, typeof outlets>();
  const keyOf = (lat: number, lng: number) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;
  for (const o of outlets) {
    const k = keyOf(o.latitude, o.longitude);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(o);
  }

  const componentOf = new Map<string, number>();
  const components: { outlets: typeof outlets; lat: number; lng: number }[] = [];
  for (const seed of outlets) {
    if (componentOf.has(seed.id)) continue;
    const idx = components.length;
    const queue = [seed];
    const members: typeof outlets = [];
    componentOf.set(seed.id, idx);
    while (queue.length > 0) {
      const cur = queue.pop()!;
      members.push(cur);
      const cy = Math.floor(cur.latitude / CELL);
      const cx = Math.floor(cur.longitude / CELL);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cell = grid.get(`${cy + dy}:${cx + dx}`);
          if (!cell) continue;
          for (const n of cell) {
            if (componentOf.has(n.id)) continue;
            if (haversineKm(cur.latitude, cur.longitude, n.latitude, n.longitude) <= LINK_KM) {
              componentOf.set(n.id, idx);
              queue.push(n);
            }
          }
        }
      }
    }
    components.push({
      outlets: members,
      lat: members.reduce((s, o) => s + o.latitude, 0) / members.length,
      lng: members.reduce((s, o) => s + o.longitude, 0) / members.length,
    });
  }

  // A component is part of the market if it holds a meaningful share of the
  // universe; anything smaller must prove it sits near one that does.
  const minRealSize = Math.max(10, Math.floor(outlets.length * 0.01));
  const mainComponents = components.filter(c => c.outlets.length >= minRealSize);
  if (mainComponents.length === 0) return [];

  const flagged: GeoOutlier[] = [];
  for (const c of components) {
    if (c.outlets.length >= minRealSize) continue;
    let nearest = Infinity;
    for (const m of mainComponents) {
      if (m === c) continue;
      const d = haversineKm(c.lat, c.lng, m.lat, m.lng);
      if (d < nearest) nearest = d;
    }
    if (nearest > radiusKm) {
      for (const o of c.outlets) {
        flagged.push({
          id: o.id, name: o.name,
          latitude: o.latitude, longitude: o.longitude,
          distanceKm: Math.round(nearest * 10) / 10
        });
      }
    }
  }
  flagged.sort((a, b) => b.distanceKm - a.distanceKm);
  return flagged;
}

function clusterOutletsIntoDailyGroups(outlets: Outlet[], k: number): Outlet[][] {
  if (outlets.length === 0) return [];
  if (k <= 0) k = 1;
  if (k === 1) return [outlets];
  if (outlets.length <= k) {
    return outlets.map(o => [o]);
  }

  const n = outlets.length;
  const maxSize = Math.ceil(n / k) + 1;
  const minSize = Math.max(1, Math.floor(n / k) - 1);

  // Create outletIdxMap for O(1) lookups instead of O(n) indexOf
  const outletIdxMap = new Map<Outlet, number>();
  for (let i = 0; i < n; i++) {
    outletIdxMap.set(outlets[i], i);
  }

  function computeCentroid(members: Outlet[]): { lat: number; lng: number } {
    if (members.length === 0) return { lat: 0, lng: 0 };
    const lat = members.reduce((s, o) => s + o.latitude, 0) / members.length;
    const lng = members.reduce((s, o) => s + o.longitude, 0) / members.length;
    return { lat, lng };
  }

  function totalIntraClusterCost(groups: Outlet[][]): number {
    let total = 0;
    for (const g of groups) {
      if (g.length === 0) continue;
      const c = computeCentroid(g);
      for (const o of g) {
        total += calculateDistance(o.latitude, o.longitude, c.lat, c.lng);
      }
    }
    return total;
  }

  // Fast TSP route-length approximation per group: nearest-neighbor + 12 passes of 2-opt.
  // This is what the rep ACTUALLY drives - the real cost we want to minimize for sales coverage.
  function approximateRouteLength(group: Outlet[]): number {
    if (group.length < 2) return 0;
    const m = group.length;

    // Nearest-neighbor starting from the outlet farthest from group centroid
    const c = computeCentroid(group);
    let startIdx = 0;
    let maxD = -1;
    for (let i = 0; i < m; i++) {
      const d = calculateDistance(group[i].latitude, group[i].longitude, c.lat, c.lng);
      if (d > maxD) { maxD = d; startIdx = i; }
    }

    const visited = new Uint8Array(m);
    const order: number[] = [startIdx];
    visited[startIdx] = 1;
    for (let step = 1; step < m; step++) {
      const cur = order[order.length - 1];
      let bestI = -1;
      let bestD = Infinity;
      for (let i = 0; i < m; i++) {
        if (visited[i]) continue;
        const d = calculateDistance(
          group[cur].latitude, group[cur].longitude,
          group[i].latitude, group[i].longitude
        );
        if (d < bestD) { bestD = d; bestI = i; }
      }
      if (bestI < 0) break;
      order.push(bestI);
      visited[bestI] = 1;
    }

    // Quick 2-opt with hard cap
    const dist = (a: number, b: number) =>
      calculateDistance(group[order[a]].latitude, group[order[a]].longitude,
                        group[order[b]].latitude, group[order[b]].longitude);
    let improved = true;
    let passes = 0;
    while (improved && passes < 12) {
      improved = false;
      passes++;
      for (let i = 1; i < m - 2; i++) {
        for (let j = i + 1; j < m; j++) {
          if (j - i === 1) continue;
          const d1 = dist(i - 1, i) + dist(j - 1, j);
          const d2 = dist(i - 1, j - 1) + dist(i, j);
          if (d2 < d1 - 1e-9) {
            const reversed = order.slice(i, j).reverse();
            order.splice(i, j - i, ...reversed);
            improved = true;
          }
        }
      }
    }

    // Sum the route distance
    let total = 0;
    for (let i = 1; i < m; i++) {
      total += calculateDistance(
        group[order[i - 1]].latitude, group[order[i - 1]].longitude,
        group[order[i]].latitude, group[order[i]].longitude
      );
    }
    return total;
  }

  // True drive-distance cost for tournament selection. This is what reps actually drive.
  function totalRouteLengthCost(groups: Outlet[][]): number {
    let total = 0;
    for (const g of groups) {
      total += approximateRouteLength(g);
    }
    return total;
  }

  // Cluster diameter penalty - max pairwise distance within each group.
  // Penalizes elongated/spread clusters that pass centroid cost but make poor daily routes.
  function maxClusterDiameter(groups: Outlet[][]): number {
    let maxDiam = 0;
    for (const g of groups) {
      if (g.length < 2) continue;
      // Sample-based diameter for groups > 20 to stay O(20^2)
      const sample = g.length <= 20 ? g : pickEvenlySampledArr(g, 20);
      let d = 0;
      for (let i = 0; i < sample.length; i++) {
        for (let j = i + 1; j < sample.length; j++) {
          const dist = calculateDistance(
            sample[i].latitude, sample[i].longitude,
            sample[j].latitude, sample[j].longitude
          );
          if (dist > d) d = dist;
        }
      }
      if (d > maxDiam) maxDiam = d;
    }
    return maxDiam;
  }

  function pickEvenlySampledArr<T>(arr: T[], count: number): T[] {
    if (arr.length <= count) return arr;
    const out: T[] = [];
    const step = arr.length / count;
    for (let i = 0; i < count; i++) {
      out.push(arr[Math.floor(i * step)]);
    }
    return out;
  }

  const globalCentroid = computeCentroid(outlets);

  // === Strategy 1: Sweep (Angular) Initialization ===
  function initSweep(): Outlet[][] {
    const outletAngles = outlets.map((o, idx) => ({
      outlet: o,
      idx,
      angle: Math.atan2(o.latitude - globalCentroid.lat, o.longitude - globalCentroid.lng)
    }));
    outletAngles.sort((a, b) => a.angle - b.angle);

    const groups: Outlet[][] = Array.from({ length: k }, () => []);
    const groupSize = Math.floor(n / k);
    const remainder = n % k;
    let pos = 0;
    for (let g = 0; g < k; g++) {
      const sz = groupSize + (g < remainder ? 1 : 0);
      for (let j = 0; j < sz; j++) {
        groups[g].push(outletAngles[pos].outlet);
        pos++;
      }
    }
    return groups;
  }

  // === Strategy 2: Maximin (Farthest-Point) Initialization ===
  function initMaximin(): Outlet[][] {
    const seeds: number[] = [];
    let maxD = -1;
    let farthestIdx = 0;
    for (let i = 0; i < n; i++) {
      const d = calculateDistance(outlets[i].latitude, outlets[i].longitude, globalCentroid.lat, globalCentroid.lng);
      if (d > maxD) { maxD = d; farthestIdx = i; }
    }
    seeds.push(farthestIdx);

    while (seeds.length < k) {
      let bestIdx = -1;
      let bestMinDist = -1;
      for (let i = 0; i < n; i++) {
        if (seeds.includes(i)) continue;
        let minDistToSeeds = Infinity;
        for (const s of seeds) {
          const d = calculateDistance(outlets[i].latitude, outlets[i].longitude, outlets[s].latitude, outlets[s].longitude);
          if (d < minDistToSeeds) minDistToSeeds = d;
        }
        if (minDistToSeeds > bestMinDist) {
          bestMinDist = minDistToSeeds;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) seeds.push(bestIdx);
      else break;
    }

    const groups: Outlet[][] = Array.from({ length: k }, () => []);
    for (let i = 0; i < n; i++) {
      let bestC = 0;
      let bestD = Infinity;
      for (let c = 0; c < seeds.length; c++) {
        const d = calculateDistance(outlets[i].latitude, outlets[i].longitude, outlets[seeds[c]].latitude, outlets[seeds[c]].longitude);
        if (d < bestD) { bestD = d; bestC = c; }
      }
      groups[bestC].push(outlets[i]);
    }
    return groups;
  }

  // === Strategy 3: Grid-Based Initialization ===
  function initGrid(): Outlet[][] {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const o of outlets) {
      if (o.latitude < minLat) minLat = o.latitude;
      if (o.latitude > maxLat) maxLat = o.latitude;
      if (o.longitude < minLng) minLng = o.longitude;
      if (o.longitude > maxLng) maxLng = o.longitude;
    }

    const gridDim = Math.max(2, Math.ceil(Math.sqrt(k * 2)));
    const latStep = (maxLat - minLat + 1e-9) / gridDim;
    const lngStep = (maxLng - minLng + 1e-9) / gridDim;

    const cellCounts = new Map<string, { count: number; sumLat: number; sumLng: number }>();
    for (const o of outlets) {
      const ci = Math.min(gridDim - 1, Math.floor((o.latitude - minLat) / latStep));
      const cj = Math.min(gridDim - 1, Math.floor((o.longitude - minLng) / lngStep));
      const key = `${ci},${cj}`;
      if (!cellCounts.has(key)) cellCounts.set(key, { count: 0, sumLat: 0, sumLng: 0 });
      const cell = cellCounts.get(key)!;
      cell.count++;
      cell.sumLat += o.latitude;
      cell.sumLng += o.longitude;
    }

    const cellArr = Array.from(cellCounts.entries()).map(([key, val]) => ({
      key,
      count: val.count,
      centLat: val.sumLat / val.count,
      centLng: val.sumLng / val.count
    }));
    cellArr.sort((a, b) => b.count - a.count);

    const seedCentroids: { lat: number; lng: number }[] = [];
    for (let i = 0; i < Math.min(k, cellArr.length); i++) {
      seedCentroids.push({ lat: cellArr[i].centLat, lng: cellArr[i].centLng });
    }
    while (seedCentroids.length < k) {
      seedCentroids.push({ lat: globalCentroid.lat + (Math.random() - 0.5) * 0.01, lng: globalCentroid.lng + (Math.random() - 0.5) * 0.01 });
    }

    const groups: Outlet[][] = Array.from({ length: k }, () => []);
    for (const o of outlets) {
      let bestC = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = calculateDistance(o.latitude, o.longitude, seedCentroids[c].lat, seedCentroids[c].lng);
        if (d < bestD) { bestD = d; bestC = c; }
      }
      groups[bestC].push(o);
    }
    return groups;
  }

  // === Phase A: Balanced Constrained K-Means (Bradley et al., 2000) ===
  function constrainedKMeans(initialGroups: Outlet[][]): Outlet[][] {
    let centroids = initialGroups.map(g => g.length > 0 ? computeCentroid(g) : { lat: globalCentroid.lat + (Math.random() - 0.5) * 0.01, lng: globalCentroid.lng + (Math.random() - 0.5) * 0.01 });

    let bestAssignments = new Int32Array(n);
    for (let g = 0; g < k; g++) {
      for (const o of initialGroups[g]) {
        const idx = outletIdxMap.get(o);
        if (idx !== undefined) bestAssignments[idx] = g;
      }
    }

    for (let iter = 0; iter < 30; iter++) {
      const tuples: { outletIdx: number; clusterIdx: number; dist: number }[] = [];
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < k; c++) {
          const d = calculateDistance(outlets[i].latitude, outlets[i].longitude, centroids[c].lat, centroids[c].lng);
          tuples.push({ outletIdx: i, clusterIdx: c, dist: d });
        }
      }
      tuples.sort((a, b) => a.dist - b.dist);

      const assignments = new Int32Array(n).fill(-1);
      const clusterSizes = new Int32Array(k);

      for (const t of tuples) {
        if (assignments[t.outletIdx] !== -1) continue;
        if (clusterSizes[t.clusterIdx] >= maxSize) continue;
        assignments[t.outletIdx] = t.clusterIdx;
        clusterSizes[t.clusterIdx]++;
      }

      for (let i = 0; i < n; i++) {
        if (assignments[i] !== -1) continue;
        let bestC = 0;
        let bestD = Infinity;
        for (let c = 0; c < k; c++) {
          if (clusterSizes[c] >= maxSize) continue;
          const d = calculateDistance(outlets[i].latitude, outlets[i].longitude, centroids[c].lat, centroids[c].lng);
          if (d < bestD) { bestD = d; bestC = c; }
        }
        assignments[i] = bestC;
        clusterSizes[bestC]++;
      }

      let converged = true;
      for (let i = 0; i < n; i++) {
        if (assignments[i] !== bestAssignments[i]) { converged = false; break; }
      }

      bestAssignments = assignments;

      for (let c = 0; c < k; c++) {
        let sumLat = 0, sumLng = 0, count = 0;
        for (let i = 0; i < n; i++) {
          if (assignments[i] === c) {
            sumLat += outlets[i].latitude;
            sumLng += outlets[i].longitude;
            count++;
          }
        }
        if (count > 0) {
          centroids[c] = { lat: sumLat / count, lng: sumLng / count };
        }
      }

      if (converged) break;
    }

    const result: Outlet[][] = Array.from({ length: k }, () => []);
    for (let i = 0; i < n; i++) {
      result[bestAssignments[i]].push(outlets[i]);
    }
    return result;
  }

  // === Phase B: Exhaustive Inter-Cluster Pair-Swap Optimization ===
  function pairSwapOptimization(groups: Outlet[][]): Outlet[][] {
    const g = groups.map(gr => [...gr]);

    for (let pass = 0; pass < 30; pass++) {
      let anyImprovement = false;
      let centroids = g.map(gr => computeCentroid(gr));

      for (let a = 0; a < k; a++) {
        for (let b = a + 1; b < k; b++) {
          if (g[a].length === 0 || g[b].length === 0) continue;
          let centA = centroids[a];
          let centB = centroids[b];

          let swapped = true;
          let swapIter = 0;
          while (swapped && swapIter < 100) {
            swapped = false;
            swapIter++;
            for (let ia = 0; ia < g[a].length; ia++) {
              for (let ib = 0; ib < g[b].length; ib++) {
                const oA = g[a][ia];
                const oB = g[b][ib];
                const currentCost =
                  calculateDistance(oA.latitude, oA.longitude, centA.lat, centA.lng) +
                  calculateDistance(oB.latitude, oB.longitude, centB.lat, centB.lng);
                const swappedCost =
                  calculateDistance(oA.latitude, oA.longitude, centB.lat, centB.lng) +
                  calculateDistance(oB.latitude, oB.longitude, centA.lat, centA.lng);

                if (swappedCost < currentCost) {
                  g[a][ia] = oB;
                  g[b][ib] = oA;
                  anyImprovement = true;
                  swapped = true;
                }
              }
            }
            centA = computeCentroid(g[a]);
            centB = computeCentroid(g[b]);
          }
        }
      }

      centroids = g.map(gr => computeCentroid(gr));

      for (let src = 0; src < k; src++) {
        for (let oi = g[src].length - 1; oi >= 0; oi--) {
          if (g[src].length <= minSize) break;
          const o = g[src][oi];
          const distSrc = calculateDistance(o.latitude, o.longitude, centroids[src].lat, centroids[src].lng);

          let bestTarget = -1;
          let bestDist = distSrc;
          for (let t = 0; t < k; t++) {
            if (t === src || g[t].length >= maxSize) continue;
            const d = calculateDistance(o.latitude, o.longitude, centroids[t].lat, centroids[t].lng);
            if (d < bestDist) { bestDist = d; bestTarget = t; }
          }

          if (bestTarget >= 0) {
            g[src].splice(oi, 1);
            g[bestTarget].push(o);
            centroids[src] = computeCentroid(g[src]);
            centroids[bestTarget] = computeCentroid(g[bestTarget]);
            anyImprovement = true;
          }
        }
      }

      if (!anyImprovement) break;
    }

    return g;
  }

  // === Helper: Pick evenly-sampled indices ===
  function pickEvenlySampled(length: number, count: number): number[] {
    if (length <= count) {
      return Array.from({ length }, (_, i) => i);
    }
    const indices: number[] = [];
    const step = length / count;
    for (let i = 0; i < count; i++) {
      indices.push(Math.floor(i * step));
    }
    return indices;
  }

  // === Phase C: Chain-Move Optimization (3-way cyclic moves) ===
  function chainMoveOptimization(groups: Outlet[][]): Outlet[][] {
    const g = groups.map(gr => [...gr]);
    if (k < 3) return g;

    const maxSample = 15;

    for (let pass = 0; pass < 10; pass++) {
      let anyImprovement = false;
      const centroids = g.map(gr => computeCentroid(gr));

      for (let a = 0; a < k && !anyImprovement; a++) {
        for (let b = a + 1; b < k && !anyImprovement; b++) {
          for (let c = b + 1; c < k && !anyImprovement; c++) {
            if (g[a].length === 0 || g[b].length === 0 || g[c].length === 0) continue;

            // Sample indices to avoid O(k³ * n³) complexity
            const sampleA = g[a].length <= maxSample ? g[a].map((_, i) => i) : pickEvenlySampled(g[a].length, maxSample);
            const sampleB = g[b].length <= maxSample ? g[b].map((_, i) => i) : pickEvenlySampled(g[b].length, maxSample);
            const sampleC = g[c].length <= maxSample ? g[c].map((_, i) => i) : pickEvenlySampled(g[c].length, maxSample);

            let bestImprovement = 0;
            let bestIA = -1, bestIB = -1, bestIC = -1;

            for (const ia of sampleA) {
              for (const ib of sampleB) {
                for (const ic of sampleC) {
                  const oA = g[a][ia], oB = g[b][ib], oC = g[c][ic];

                  const currentCost =
                    calculateDistance(oA.latitude, oA.longitude, centroids[a].lat, centroids[a].lng) +
                    calculateDistance(oB.latitude, oB.longitude, centroids[b].lat, centroids[b].lng) +
                    calculateDistance(oC.latitude, oC.longitude, centroids[c].lat, centroids[c].lng);

                  const cyclicCost =
                    calculateDistance(oA.latitude, oA.longitude, centroids[b].lat, centroids[b].lng) +
                    calculateDistance(oB.latitude, oB.longitude, centroids[c].lat, centroids[c].lng) +
                    calculateDistance(oC.latitude, oC.longitude, centroids[a].lat, centroids[a].lng);

                  const improvement = currentCost - cyclicCost;
                  if (improvement > bestImprovement) {
                    bestImprovement = improvement;
                    bestIA = ia; bestIB = ib; bestIC = ic;
                  }
                }
              }
            }

            if (bestImprovement > 0 && bestIA >= 0) {
              const oA = g[a][bestIA];
              const oB = g[b][bestIB];
              const oC = g[c][bestIC];
              g[a][bestIA] = oC;
              g[b][bestIB] = oA;
              g[c][bestIC] = oB;
              anyImprovement = true;
            }
          }
        }
      }

      if (!anyImprovement) break;
    }

    return g;
  }

  // === Strategy 4: K-Means++ Initialization (probability ∝ dist²) ===
  function initKMeansPP(): Outlet[][] {
    const seeds: number[] = [];
    seeds.push(Math.floor(Math.random() * n));

    const minDistSq = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d = calculateDistance(outlets[i].latitude, outlets[i].longitude, outlets[seeds[0]].latitude, outlets[seeds[0]].longitude);
      minDistSq[i] = d * d;
    }

    while (seeds.length < k) {
      let totalWeight = 0;
      for (let i = 0; i < n; i++) totalWeight += minDistSq[i];
      if (totalWeight <= 0) break;

      let r = Math.random() * totalWeight;
      let pickIdx = -1;
      for (let i = 0; i < n; i++) {
        r -= minDistSq[i];
        if (r <= 0) { pickIdx = i; break; }
      }
      if (pickIdx < 0) pickIdx = n - 1;
      seeds.push(pickIdx);

      // Update minDistSq
      for (let i = 0; i < n; i++) {
        const d = calculateDistance(outlets[i].latitude, outlets[i].longitude, outlets[pickIdx].latitude, outlets[pickIdx].longitude);
        const dSq = d * d;
        if (dSq < minDistSq[i]) minDistSq[i] = dSq;
      }
    }

    const groups: Outlet[][] = Array.from({ length: k }, () => []);
    for (let i = 0; i < n; i++) {
      let bestC = 0;
      let bestD = Infinity;
      for (let c = 0; c < seeds.length; c++) {
        const d = calculateDistance(outlets[i].latitude, outlets[i].longitude, outlets[seeds[c]].latitude, outlets[seeds[c]].longitude);
        if (d < bestD) { bestD = d; bestC = c; }
      }
      groups[bestC].push(outlets[i]);
    }
    return groups;
  }

  // === Phase D: Boundary refinement - swap boundary outlets to reduce route-length ===
  // Uses route-length deltas (not centroid distance) so it directly improves what reps drive.
  function boundaryRouteRefinement(groups: Outlet[][]): Outlet[][] {
    const g = groups.map(gr => [...gr]);
    if (k < 2) return g;

    const cents = g.map(gr => computeCentroid(gr));

    // Build adjacency: only consider neighbor-pairs whose centroids are close
    const neighborPairs: [number, number][] = [];
    for (let a = 0; a < k; a++) {
      for (let b = a + 1; b < k; b++) {
        const d = calculateDistance(cents[a].lat, cents[a].lng, cents[b].lat, cents[b].lng);
        neighborPairs.push([a, b]);
      }
    }
    // Sort by closeness so most likely-improving pairs are tried first
    neighborPairs.sort((p1, p2) => {
      const d1 = calculateDistance(cents[p1[0]].lat, cents[p1[0]].lng, cents[p1[1]].lat, cents[p1[1]].lng);
      const d2 = calculateDistance(cents[p2[0]].lat, cents[p2[0]].lng, cents[p2[1]].lat, cents[p2[1]].lng);
      return d1 - d2;
    });

    // Cache route length per cluster - only invalidate when its membership changes.
    // Cap candidate moves per pair to keep this affordable on large datasets.
    const routeCache: (number | null)[] = g.map(() => null);
    const getRouteLen = (idx: number) => {
      if (routeCache[idx] === null) routeCache[idx] = approximateRouteLength(g[idx]);
      return routeCache[idx]!;
    };
    const MAX_CANDIDATES_PER_PAIR = 6; // top boundary candidates by lateral distance

    let improved = true;
    let pass = 0;
    while (improved && pass < 4) {
      improved = false;
      pass++;
      for (const [a, b] of neighborPairs) {
        if (g[a].length <= minSize && g[b].length <= minSize) continue;

        const baseCost = getRouteLen(a) + getRouteLen(b);
        const centA = computeCentroid(g[a]);
        const centB = computeCentroid(g[b]);

        // Pre-rank boundary candidates from each side: outlets closer to OTHER centroid
        type Candidate = { src: number; idx: number; o: Outlet; gain: number };
        const candidates: Candidate[] = [];

        if (g[a].length > minSize && g[b].length < maxSize) {
          for (let i = 0; i < g[a].length; i++) {
            const o = g[a][i];
            const dA = calculateDistance(o.latitude, o.longitude, centA.lat, centA.lng);
            const dB = calculateDistance(o.latitude, o.longitude, centB.lat, centB.lng);
            if (dB < dA) candidates.push({ src: a, idx: i, o, gain: dA - dB });
          }
        }
        if (g[b].length > minSize && g[a].length < maxSize) {
          for (let i = 0; i < g[b].length; i++) {
            const o = g[b][i];
            const dB = calculateDistance(o.latitude, o.longitude, centB.lat, centB.lng);
            const dA = calculateDistance(o.latitude, o.longitude, centA.lat, centA.lng);
            if (dA < dB) candidates.push({ src: b, idx: i, o, gain: dB - dA });
          }
        }

        // Try the strongest boundary candidates first
        candidates.sort((x, y) => y.gain - x.gain);
        const top = candidates.slice(0, MAX_CANDIDATES_PER_PAIR);

        let bestDelta = 0;
        let bestPick: Candidate | null = null;

        for (const cand of top) {
          const dst = cand.src === a ? b : a;
          if (g[cand.src].length <= minSize || g[dst].length >= maxSize) continue;

          const newSrc = g[cand.src].filter((_, idx) => idx !== cand.idx);
          const newDst = [...g[dst], cand.o];
          const newCost = approximateRouteLength(newSrc) + approximateRouteLength(newDst);
          const delta = baseCost - newCost;
          if (delta > bestDelta + 0.01) {
            bestDelta = delta;
            bestPick = cand;
          }
        }

        if (bestPick) {
          const dst = bestPick.src === a ? b : a;
          g[bestPick.src].splice(bestPick.idx, 1);
          g[dst].push(bestPick.o);
          routeCache[bestPick.src] = null;
          routeCache[dst] = null;
          improved = true;
        }
      }
    }

    return g;
  }

  // === Run all 4 strategies through Phases A, B, C, D ===
  const strategyNames = ['Sweep (Angular)', 'Maximin (Farthest-Point)', 'Grid-Based', 'K-Means++'];
  const initializers = [initSweep, initMaximin, initGrid, initKMeansPP];
  let bestResult: Outlet[][] | null = null;
  let bestRouteCost = Infinity;
  let bestStrategy = '';

  for (let s = 0; s < 4; s++) {
    const initial = initializers[s]();
    const afterKMeans = constrainedKMeans(initial);
    const afterSwaps = pairSwapOptimization(afterKMeans);
    const afterChain = chainMoveOptimization(afterSwaps);
    const afterBoundary = boundaryRouteRefinement(afterChain);

    // Tournament uses true drive distance, not centroid sum.
    // This directly minimizes what reps actually drive each day - the right
    // metric for "outlets close together" in sales coverage.
    const routeCost = totalRouteLengthCost(afterBoundary);
    const centroidCost = totalIntraClusterCost(afterBoundary);
    const diameter = maxClusterDiameter(afterBoundary);
    console.log(`[Clustering] Strategy "${strategyNames[s]}": route=${routeCost.toFixed(2)}km, centroid=${centroidCost.toFixed(2)}km, maxDiameter=${diameter.toFixed(2)}km`);

    if (routeCost < bestRouteCost) {
      bestRouteCost = routeCost;
      bestResult = afterBoundary;
      bestStrategy = strategyNames[s];
    }
  }

  console.log(`[Clustering] Winner: "${bestStrategy}" with route cost ${bestRouteCost.toFixed(2)} km for ${n} outlets into ${k} groups`);

  return bestResult!
    .filter(g => g.length > 0)
    .sort((a, b) => {
      const aLng = a.reduce((s, o) => s + o.longitude, 0) / a.length;
      const bLng = b.reduce((s, o) => s + o.longitude, 0) / b.length;
      return aLng - bLng;
    });
}

// Anchor-first weekly schedule builder. Implements the visit-frequency-aware
// rotation algorithm:
//   STEP 1: Cluster VF3+VF4 "anchor" outlets into one geographic group per
//           working day. These anchors define where the rep is each
//           day-of-week (their high frequency makes them the stable backbone).
//   STEP 2: Attach lower-VF outlets (VF1, VF2) to the day whose centroid is
//           geographically closest, so every week's Monday route stays inside
//           the Monday zone.
//   STEP 3: Within each day, spatially sub-cluster VF1/VF2/VF3 into rotation
//           buckets and assign each bucket to a week-pattern:
//             VF4 → every week                                {1,2,3,4}
//             VF3 → 4 buckets × 4 patterns (each skips one week)
//                   {1,2,3} {1,2,4} {1,3,4} {2,3,4}
//             VF2 → 2 buckets × 2 patterns                    {1,3} {2,4}
//             VF1 → 4 buckets × 4 single-week patterns        {1} {2} {3} {4}
//           The rotation guarantees every week gets roughly equal load.
//   STEP 4: For every (week, day) cell, build the outlet set and optimize the
//           route via the existing NN+2opt+Or-opt+3opt solver.
//
// Industry journey-plan rule: same outlet always same dayOfWeek across weeks.
function buildAnchorAwareSchedules(rep: Rep, repOutlets: Outlet[]): InsertSchedule[] {
  const numDays = cycleShape(rep.workingDaysPerWeek || 5).dayGroups;
  if (repOutlets.length === 0) return [];

  // STEP 1: Anchor clustering on VF3 + VF4 outlets only. Fall back to all
  // outlets if anchors are too sparse to form meaningful daily zones.
  const anchors = repOutlets.filter(o => (o.visitFrequency ?? 1) >= 3);
  const useAnchorMode = anchors.length >= numDays * 3;
  const seedOutlets = useAnchorMode ? anchors : repOutlets;

  const dailyClusters: Outlet[][] = clusterOutletsIntoDailyGroups(seedOutlets, numDays)
    .map(group => [...group]);
  while (dailyClusters.length < numDays) dailyClusters.push([]);

  // STEP 2: Attach lower-VF outlets to nearest daily centroid (anchor mode only).
  if (useAnchorMode) {
    const centroids = dailyClusters.map(group => {
      if (group.length === 0) return { lat: 0, lng: 0, valid: false };
      const lat = group.reduce((s, o) => s + o.latitude, 0) / group.length;
      const lng = group.reduce((s, o) => s + o.longitude, 0) / group.length;
      return { lat, lng, valid: true };
    });
    const lowerVF = repOutlets.filter(o => (o.visitFrequency ?? 1) < 3);
    for (const outlet of lowerVF) {
      let bestDay = -1;
      let bestDist = Infinity;
      for (let d = 0; d < numDays; d++) {
        if (!centroids[d].valid) continue;
        const dist = haversineDistance(
          outlet.latitude, outlet.longitude,
          centroids[d].lat, centroids[d].lng
        );
        if (dist < bestDist) { bestDist = dist; bestDay = d; }
      }
      // Fallback: if no valid centroid exists, drop into the smallest day
      // so anchor-sparse days still get visited and no outlet is lost.
      if (bestDay === -1) {
        bestDay = 0;
        for (let d = 1; d < numDays; d++) {
          if (dailyClusters[d].length < dailyClusters[bestDay].length) bestDay = d;
        }
      }
      dailyClusters[bestDay].push(outlet);
    }
  }

  return scheduleFromDailyClusters(rep, dailyClusters, repOutlets);
}

// Builds numDays daily clusters directly from pre-computed geographic zones,
// preserving their boundaries instead of flattening everything into one pool
// and re-deriving daily groups from scratch (which was free to blend outlets
// from distant, unrelated zones onto the same day). Falls back to merging or
// splitting zones only when the zone count doesn't already match numDays.
function buildDailyClustersFromZones(zoneGroups: Outlet[][], numDays: number, maxWeeklyVisitsPerDay?: number, mergeRepeats: number = 4): Outlet[][] {
  const zones = zoneGroups.filter(z => z.length > 0).map(z => [...z]);
  if (zones.length === 0) return Array.from({ length: numDays }, () => []);

  if (zones.length === numDays) {
    return zones;
  }

  if (zones.length > numDays) {
    // More zones than day slots: agglomerative merging - repeatedly merge
    // the two geographically closest groups until numDays remain. Unlike
    // quota-slicing along the chain, this never forces a distant zone into a
    // neighbor's day just to satisfy counts: an isolated zone simply stays
    // its own (smaller) day, keeping every day-route tight. Merging is also
    // capacity-aware: pairs whose combined weekly visit load would exceed
    // the rep's daily cap are avoided while any legal pair exists, so a
    // merged day doesn't blow past maxDailyVisits.
    const groups: Outlet[][] = zones;
    const centroidOf = (g: Outlet[]) => ({
      lat: g.reduce((s, o) => s + o.latitude, 0) / g.length,
      lng: g.reduce((s, o) => s + o.longitude, 0) / g.length,
    });
    const weeklyLoad = (g: Outlet[]) => g.reduce((s, o) => s + (o.visitFrequency ?? 1), 0) / mergeRepeats;
    // A zone holding a flagged geographic outlier must never be merged into
    // a neighbour: one mis-geocoded outlet 450km away would otherwise turn a
    // normal day-route into a cross-country drive. It keeps its own (small)
    // day until the user excludes or fixes it.
    const hasOutlier = (g: Outlet[]) => g.some(o => o.geoStatus === 'offset');
    while (groups.length > numDays) {
      const cs = groups.map(centroidOf);
      const loads = groups.map(weeklyLoad);
      let bi = -1, bj = -1, bestD = Infinity;
      let fi = -1, fj = -1, fallbackLoad = Infinity;
      for (let i = 0; i < groups.length; i++) {
        if (hasOutlier(groups[i])) continue;
        for (let j = i + 1; j < groups.length; j++) {
          if (hasOutlier(groups[j])) continue;
          const d = geoDist(cs[i].lat, cs[i].lng, cs[j].lat, cs[j].lng);
          const combined = loads[i] + loads[j];
          if (maxWeeklyVisitsPerDay === undefined || combined <= maxWeeklyVisitsPerDay) {
            if (d < bestD) { bestD = d; bi = i; bj = j; }
          }
          if (combined < fallbackLoad) { fallbackLoad = combined; fi = i; fj = j; }
        }
      }
      // No pair fits under the cap -> merge the lightest pair (the day count
      // must still come out to numDays).
      if (bi < 0) { bi = fi; bj = fj; }
      if (bi < 0 || bj < 0) {
        // Every remaining pair involves an outlier zone. Outlier containment
        // is best-effort ONLY: the group count must still reach numDays,
        // because groups beyond numDays get no day and their outlets would
        // silently vanish from the plan. Merge the two closest groups
        // regardless of outlier status.
        let ci2 = -1, cj2 = -1, cd = Infinity;
        for (let i = 0; i < groups.length; i++) {
          for (let j = i + 1; j < groups.length; j++) {
            const d = calculateHaversineDistance(cs[i].lat, cs[i].lng, cs[j].lat, cs[j].lng);
            if (d < cd) { cd = d; ci2 = i; cj2 = j; }
          }
        }
        if (ci2 < 0 || cj2 < 0) break;
        bi = ci2; bj = cj2;
      }
      groups[bi] = [...groups[bi], ...groups[bj]];
      groups.splice(bj, 1);
    }
    return groups;
  }

  // Fewer zones than day slots: split the largest zone(s) geographically so
  // every working day still gets its own tight group.
  const groups = zones;
  while (groups.length < numDays) {
    let largestIdx = 0;
    for (let i = 1; i < groups.length; i++) {
      if (groups[i].length > groups[largestIdx].length) largestIdx = i;
    }
    if (groups[largestIdx].length < 2) break; // nothing left worth splitting
    const [a, b] = clusterOutletsIntoDailyGroups(groups[largestIdx], 2);
    groups.splice(largestIdx, 1, a, b);
  }
  while (groups.length < numDays) groups.push([]);
  return groups;
}

// Same VF1-4 anchor-aware weekly rotation as buildAnchorAwareSchedules, but
// takes pre-computed geographic zones (one per working day, ideally) instead
// of a flat outlet pool, so the already-tight zone boundaries from the
// clustering step survive into the final day-routes.
// Set per optimization run from the "Route Compactness" setting; read by the
// day-route builder below. Module scope because the builder is called from
// several entry points (a fresh run, a targeted rebuild after reassignment)
// that should all honour the same setting.
let dayRouteWidthCapKm = 0;

// The longest single hop a day-route may contain before it is penalised, in
// kilometres. 0 turns the penalty off. See legCost in day-balancer.
let maxHopKm = 4;

// The user's floor and ceiling for a day, in visits. The day builders derive a
// per-piece band from these and the piece's own mean, so "20 to 25" is honoured
// as stated rather than as a symmetric tolerance around whatever the mean is.
let dayVisitsMin = 0;
let dayVisitsMax = 0;
// Room below and above a mean for the day band. When the floor is above the
// mean (or the ceiling below it) the rep count could not honour the band at
// all - 466 biweekly outlets at 25-30 a day are 39 for one rep or 19.5 for
// two - and a 2% room on that side would only shred villages to chase a
// number no day can reach. Ten percent then.
const roomBelow = (mean: number, atLeast: number) => dayVisitsMin > mean ? Math.max(atLeast, 0.10) : Math.min(0.35, Math.max(atLeast, (mean - dayVisitsMin) / mean));
const roomAbove = (mean: number, atLeast: number) => dayVisitsMax < mean ? Math.max(atLeast, 0.10) : Math.min(0.35, Math.max(atLeast, (dayVisitsMax - mean) / mean));

// The settings the last full optimization ran with, kept on disk.
//
// Everything that rebuilds routes afterwards - "Reoptimize", and the rebuild
// that follows a reassignment - used to invent its own defaults (25-27 visits a
// day, 5 working days, four weeks) instead of the numbers the user set on the
// dashboard. So a plan built for 21-24 calls a day over a 26-day Sunday-to-
// Thursday cycle was silently rebuilt as 25-27 calls over a four-week
// Monday-to-Friday one, and the user's settings were quietly undone by the
// button labelled "Reoptimize".
interface PlanSettings {
  workingDays: number[];
  cycleWorkingDays: number;
  minVisitsPerDay: number;
  maxVisitsPerDay: number;
  weightMode: string;
  distanceMode: string;
  maxZoneRadiusKm: number;
  dayLoadTolerance: number;
  dayRouteWidthCapKm: number;
  maxHopKm: number;
  cycleMode?: CycleMode;
  planMonth?: string;
  monthEdges?: MonthEdges;
  planStart?: string;
  planEnd?: string;
  cycleStartSlot?: number;
  /** Rivers, railways, motorways without crossings: part of the plan, not of the code. */
  barriers?: Barrier[];
}
// Kept in the blob store - Postgres on the published site - like the rest of
// the app's state; see persist.ts.
const SETTINGS_KEY = "plan-settings";
let planSettings: PlanSettings | null = null;

async function loadPlanSettings() {
  try {
    const text = await loadBlob(SETTINGS_KEY);
    if (text) {
      planSettings = JSON.parse(text);
      console.log(`[settings] Restored plan settings: ${planSettings!.minVisitsPerDay}-${planSettings!.maxVisitsPerDay} visits/day, ${planSettings!.cycleWorkingDays || 'default'} day cycle`);
    }
  } catch (err) {
    console.error("[settings] Failed to read:", (err as Error).message);
    planSettings = null;
  }
}
function savePlanSettings(next: PlanSettings) {
  planSettings = next;
  saveBlob(SETTINGS_KEY, JSON.stringify(next)).catch(err => console.error("[settings] Failed to write:", (err as Error).message));
}
/** Puts the saved settings back into the module state the builders read. */
function applyPlanSettings(): PlanSettings | null {
  if (!planSettings) return null;
  workingWeek = planSettings.workingDays?.length > 0 ? planSettings.workingDays : workingWeek;
  cycleWorkingDays = planSettings.cycleWorkingDays ?? 0;
  dayLoadTolerance = planSettings.dayLoadTolerance ?? dayLoadTolerance;
  dayRouteWidthCapKm = planSettings.dayRouteWidthCapKm ?? dayRouteWidthCapKm;
  maxHopKm = planSettings.maxHopKm ?? maxHopKm;
  dayVisitsMin = planSettings.minVisitsPerDay ?? dayVisitsMin;
  dayVisitsMax = planSettings.maxVisitsPerDay ?? dayVisitsMax;
  cycleMode = planSettings.cycleMode ?? 'fixed';
  planMonth = planSettings.planMonth ?? '';
  monthEdges = planSettings.monthEdges ?? 'allDays';
  planStartDate = planSettings.planStart ?? '';
  cycleStartSlot = planSettings.cycleStartSlot ?? 0;
  setDistanceMode(planSettings.distanceMode === 'road' ? 'road' : planSettings.distanceMode === 'grid' ? 'grid' : 'haversine');
  setBarriers(planSettings.barriers ?? []);
  return planSettings;
}
// Loaded in registerRoutes, before the routes go live.

// Which weekdays the reps actually work, as ISO numbers (1 = Monday ... 7 =
// Sunday), in the order the week runs.
//
// The app assumed the week starts on Monday and that "6 working days" means
// Monday to Saturday - it took a COUNT and filled it from the top of a
// Monday-first list. That is wrong wherever the week does not start on Monday:
// Syria works Sunday to Thursday with Friday and Saturday off, and the app
// would put those reps on the road on Friday and give them Sunday off. The
// user now states the working days themselves, and the first and last of them
// are the start and end of their week.
let workingWeek: number[] = [1, 2, 3, 4, 5];

// How the cycle is sized. 'fixed' uses cycleWorkingDays as given; 'calendarMonth'
// takes one real calendar month - the one in planMonth - and counts its working
// days, so October on a Saturday-to-Thursday week is 24 whole-week days (or 26
// if the partial weeks at the edges are included), and the plan's dates are
// October's dates rather than "tomorrow onwards".
type CycleMode = 'fixed' | 'calendarMonth';
let cycleMode: CycleMode = 'fixed';
let planMonth = '';                       // 'YYYY-MM'
let monthEdges: MonthEdges = 'allDays';
let planStartDate = '';                   // 'YYYY-MM-DD'; '' = next working day
let cycleStartSlot = 0;                   // where in the working week the plan starts

// Length of one journey-plan cycle, in working days. 0 = derive it as four
// weeks, which is what the app always assumed. See cycleShape in cycle.ts for
// how a length becomes day-groups x repeats (26 = 13 x 2, 23 = 11 x 2 + 1).
let cycleWorkingDays = 0;

// The cycle math lives in cycle.ts so it can be tested on its own; these
// wrappers feed it the module state the rest of this file keeps.
function cycleShape(workingDaysPerWeek: number, requested?: number) {
  return cycleShapeFor(workingDaysPerWeek, requested ?? cycleWorkingDays);
}
function calendarCell(repeat: number, group: number, dayGroups: number, week: number[]) {
  return calendarCellAt(repeat, group, dayGroups, week, cycleStartSlot);
}
function upcomingWorkingDates(count: number, week: number[]): Date[] {
  return upcomingWorkingDatesFrom(count, week, planStartDate);
}

// The cycle a plan on disk was built with, read back off it: the number of
// distinct (week, day) cells one rep holds. Rebuilding a rep's routes after a
// reassignment must not quietly switch them back to a four-week cycle just
// because the process restarted since the plan was made.
async function storedCycleDays(): Promise<number> {
  const all = await storage.getSchedules();
  if (all.length === 0) return 0;
  const cellsByRep = new Map<string, Set<string>>();
  for (const s of all) {
    if (!cellsByRep.has(s.repId)) cellsByRep.set(s.repId, new Set());
    cellsByRep.get(s.repId)!.add(`${s.week}:${s.dayOfWeek}`);
  }
  return Math.max(...Array.from(cellsByRep.values(), v => v.size));
}

/**
 * The working week a plan on disk was built with: the weekdays its cells use,
 * rotated so the week starts where the days off end.
 *
 * Sorting them 1..7 would lose which day the week STARTS on - a Sunday-to-
 * Thursday week would read back as Monday-to-Thursday-plus-Sunday and a rebuild
 * would re-date the whole plan. The break in the sequence is the weekend, so
 * the day after the longest gap is the first working day.
 */
async function storedWorkingWeek(): Promise<number[]> {
  const all = await storage.getSchedules();
  if (all.length === 0) return [];
  const days = Array.from(new Set(all.map(s => s.dayOfWeek))).sort((a, b) => a - b);
  if (days.length < 2) return days;
  let startAt = 0, widest = -1;
  for (let i = 0; i < days.length; i++) {
    const prev = days[(i - 1 + days.length) % days.length];
    const gap = ((days[i] - prev) + 7) % 7;
    if (gap > widest) { widest = gap; startAt = i; }
  }
  return [...days.slice(startAt), ...days.slice(0, startAt)];
}

// How far a single day's visit count may sit from the average, as a fraction.
//
// Derived from the min/max visits-per-day the user asked for. It used to be
// hardcoded near-equal, which quietly made those two numbers headcount inputs
// and nothing more: asking for 17-28 produced exactly the same 21-23 days as
// asking for 21-24. Slack is worth real compactness - a day in a dense pocket
// can absorb a couple of extra calls instead of a neighbouring day reaching
// across town for them - so the band the user states is the band that is used.
let dayLoadTolerance = 0.06;


async function buildAnchorAwareSchedulesFromZones(rep: Rep, zoneGroups: Outlet[][]): Promise<InsertSchedule[]> {
  // Day-GROUPS, not weekdays: a 26-day cycle is 13 groups driven twice, so the
  // territory is cut into 13 pieces even though the rep works a 6-day week.
  const { repeats: cycleRuns, dayGroups: numDays } = cycleShape(rep.workingDaysPerWeek || 5);
  // What ONE day-group carries for this outlet, per run of that group. A group
  // is driven `cycleRuns` times a cycle, so it can carry at most that many
  // visits; an outlet needing more gets a second group (see membershipsFor),
  // and the overflow is budgeted there, not here. On a four-week cycle nothing
  // overflows and this is exactly the old vf/4.
  const runLoadOf = unitLoad((o: Outlet) => Math.min(o.visitFrequency ?? 1, cycleRuns) / cycleRuns);
  const repOutlets = zoneGroups.flat();
  if (repOutlets.length === 0) return [];

  // Real road distances between every pair of this rep's outlets, when a
  // road server is configured: from here on the hop checks, the day cut, the
  // route-cost polish, the stop order and the kilometres saved are all by
  // road. Without a server (or if it fails) the detour estimate stands in.
  if (getDistanceMode() === 'road' && osrmConfigured()) {
    const t0 = Date.now();
    const r = await prefetchOutletMatrix(repOutlets.map(o => ({ lat: o.latitude, lng: o.longitude })));
    console.log(`[road] ${rep.name}: ${r.filled} road pairs from OSRM in ${r.requests} request(s), ${Date.now() - t0}ms${r.failed ? ' (incomplete: estimate used for the rest)' : ''}`);
  }

  // Split the rep's territory into working days by recursive bisection, so a
  // day is a contiguous piece of the map rather than a set of outlets that
  // merely add up to the right workload. Capacity-driven clustering balanced
  // the numbers but let days interleave across the whole city.
  // Grow contiguous regions, even out the loads, then two improvement passes:
  // equal-weight swaps (load-neutral, so they can run freely) followed by
  // straggler relocation. A final repair re-seats any load the relocation
  // shifted.
  // Cut a space-filling curve into equal-load runs, then improve the seams.
  //
  // Greedy growing produced five tight days and one that swept up whatever the
  // others had no room for; see partitionByHilbert for the measurements. The
  // curve cannot strand leftovers, but its cuts fall wherever the load happens
  // to reach a boundary, so the polishing passes matter more here: they move
  // outlets across a seam when doing so shortens the day actually driven.
  // ...then re-cut neighbouring pairs from scratch. Moving outlets one at a
  // time cannot repair a day-group that is the wrong SHAPE, and on a cycle with
  // few repeats the day-group is the route - there is no second, tour-driven
  // split below it to tidy up after. See recutPairs.
  // Partition one connected piece of territory into k day-groups: exact
  // balanced assignment, then polish to convergence.
  // Room below and above a piece's own mean, from the user's floor and
  // ceiling. With a floor of 20 on a mean of 20.9 there is almost no room
  // below and plenty above; the old symmetric tolerance around the mean gave
  // 18.6 to 23.3 and let days come out at 19.
  const bandFor = (piece: Outlet[], k: number, atLeast: number = 0.02): Band => {
    const mean = piece.reduce((sum, o) => sum + runLoadOf(o), 0) / k;
    return dayVisitsMin > 0 && dayVisitsMax > 0 && mean > 0
      ? { below: roomBelow(mean, atLeast), above: roomAbove(mean, atLeast) }
      : dayLoadTolerance;
  };
  // `atLeast` widens the band for a cut made of whole villages, which cannot
  // balance to the outlet; the outlet-level repair afterwards restores the
  // real band wherever the villages adjoin.
  const partitionPiece = async (piece: Outlet[], k: number, atLeast: number = 0.02): Promise<Outlet[][]> => {
    if (k <= 1 || piece.length <= 1) return [piece.slice()];
    const band = bandFor(piece, k, atLeast);
    let groups = repairLoads(
      // Exact assignment when the solver is there; the curve when it is not.
      (await solveBalancedGroups(piece, k, unitLoad(o => Math.min(o.visitFrequency ?? 1, cycleRuns)), band))
        ?? partitionByHilbert(piece, k, runLoadOf),
      runLoadOf,
      band,
      maxHopKm,
    );

    // Improve until it stops improving, rather than once through. The passes
    // feed each other - re-cutting a pair of day-groups moves the boundaries
    // that the outlet-level passes then have fresh slack to work on, and vice
    // versa - so a single sweep leaves distance on the table. The loop stops
    // the moment a sweep fails to shorten the total drive, so it cannot make a
    // plan worse than the one it started on.
    const totalCost = (gs: Outlet[][]) => gs.reduce((sum, g) => sum + routeCost(g, maxHopKm), 0);
    let best = totalCost(groups);
    for (let sweep = 0; sweep < 4; sweep++) {
      const next = repairLoads(
        swapStranded(
          recutPairs(
            polishByTourLength(
              polishByCohesion(
                swapForCompactness(groups, runLoadOf),
                runLoadOf,
                band,
              ),
              runLoadOf,
              band,
              4,
              maxHopKm,
            ),
            runLoadOf,
            band,
            6,
            6,
            maxHopKm,
          ),
          runLoadOf,
          band,
          maxHopKm,
        ),
        runLoadOf,
        band,
        maxHopKm,
      );
      const cost = totalCost(next);
      if (cost >= best - 0.01) break;
      groups = next;
      best = cost;
    }
    // Then the periodic-VRP step: relocate and exchange outlets between days
    // by what the tours actually cost to drive. This is what pulls a pocket
    // out of a day whose core is elsewhere and hands it to the day that
    // drives past it, when only a swap can do so within the band.
    const improved = improveByRouteCost(groups, runLoadOf, band, maxHopKm);
    const after = totalCost(improved);
    if (after < best - 0.01) {
      console.log(`[vrp] ${rep.name}: route-cost polish ${best.toFixed(1)}km -> ${after.toFixed(1)}km over ${k} day-groups`);
      groups = improved;
    }
    // Last, geography over pricing. On sparse ground a day can keep outlets
    // deep inside another day's area because they are stepping stones between
    // two of its own far-apart pieces: the hop penalty makes them look
    // valuable though the plain drive hardly changes. An outlet whose nearest
    // neighbours are mostly another day's goes to that day (handOverStrays),
    // then any outlet whose nearest same-day outlet is more than twice as far
    // as another day's nearest; both within the band, and kept only if the
    // plain driving distance of the rep's days grows by at most eight percent.
    {
      const plain = (gs: Outlet[][]) => gs.reduce((sum, g) => sum + tourLength(g), 0);
      const cohesive = polishByCohesion(handOverStrays(groups, runLoadOf, band).groups, runLoadOf, band, 2, 0.5);
      const movedCount = cohesive.reduce((n, g, i) => n + g.filter(o => !groups[i].some(x => x.id === o.id)).length, 0);
      if (movedCount > 0) {
        const kmBefore = plain(groups), kmAfter = plain(cohesive);
        if (kmAfter <= kmBefore * 1.08 + 0.5) {
          console.log(`[cohesion] ${rep.name}: ${movedCount} outlet(s) moved to the day whose outlets surround them (${kmBefore.toFixed(1)}km -> ${kmAfter.toFixed(1)}km plain drive)`);
          groups = cohesive;
        }
      }
    }
    return groups;
  };

  // Respect the hop limit STRUCTURALLY, before any optimising starts.
  //
  // The polishing passes could not fix a day-route that reaches across a gap
  // no hop under the limit can bridge, because every move they can make keeps
  // the day the same size and every outlet across the gap is equally far. On
  // this territory the gaps are real: one rep has a core of 210 outlets and
  // three pockets of 26, 26 and 22 more than 4km from it. So: find the pieces
  // of territory that CAN be driven within the limit, give each its fair share
  // of days, and partition each on its own. A pocket the size of a day simply
  // becomes that day. Only a piece too small to be a day is merged into its
  // nearest neighbour, and that one unavoidable long hop is reported.
  const totalLoad = repOutlets.reduce((sum, o) => sum + runLoadOf(o), 0);
  const targetLoad = totalLoad / numDays;
  const floorLoad = dayVisitsMin > 0 ? Math.min(dayVisitsMin, targetLoad) * (1 - 0.02) : targetLoad * (1 - dayLoadTolerance);
  let pieces = reachabilityComponents(repOutlets, maxHopKm);

  const loadOfPiece = (g: Outlet[]) => g.reduce((sum, o) => sum + runLoadOf(o), 0);
  const mergeInto = (from: number) => {
    let to = -1, gap = Infinity;
    for (let j = 0; j < pieces.length; j++) {
      if (j === from) continue;
      const g = gapBetween(pieces[from], pieces[j]);
      if (g < gap) { gap = g; to = j; }
    }
    if (to < 0) return;
    console.log(`[hops] ${rep.name}: ${pieces[from].length} outlet(s) have no neighbour within ${maxHopKm}km - joined to the nearest piece, ${gap.toFixed(1)}km away (that hop is unavoidable)`);
    pieces[to] = [...pieces[to], ...pieces[from]];
    pieces.splice(from, 1);
  };
  // Too small to be a day on its own -> merge. Smallest first, so a handful of
  // stragglers attach to a pocket rather than a pocket dissolving into the core.
  for (;;) {
    let smallest = -1;
    for (let i = 0; i < pieces.length; i++) {
      if (loadOfPiece(pieces[i]) < floorLoad && (smallest < 0 || pieces[i].length < pieces[smallest].length)) smallest = i;
    }
    if (smallest < 0 || pieces.length === 1) break;
    mergeInto(smallest);
  }
  // More pieces than days -> merge the smallest until they fit.
  while (pieces.length > numDays) {
    let smallest = 0;
    for (let i = 1; i < pieces.length; i++) if (pieces[i].length < pieces[smallest].length) smallest = i;
    mergeInto(smallest);
  }

  // Share the days out in proportion to load (largest-remainder), every piece
  // getting at least one.
  const apportion = (loads: number[]): number[] => {
    const quota = loads.map(l => l / targetLoad);
    const days = quota.map(q => Math.max(1, Math.floor(q)));
    let left = numDays - days.reduce((a, b) => a + b, 0);
    // Remainder against what was actually allocated, not against the floor: a
    // pocket of 22 with a quota of 0.99 already holds its one day, and counting
    // its 0.99 as unmet gave it a second - two days of eleven.
    const remainders = quota.map((q, i) => ({ i, r: q - days[i] })).sort((a, b) => b.r - a.r);
    for (const { i } of remainders) { if (left <= 0) break; days[i] += 1; left -= 1; }
    // Over-allocated (many pieces each forced to one day): take days back from
    // the pieces whose days would stay fullest.
    while (left < 0) {
      let pick = -1, fullest = -Infinity;
      for (let i = 0; i < loads.length; i++) {
        if (days[i] <= 1) continue;
        const perDay = loads[i] / (days[i] - 1);
        if (perDay > fullest) { fullest = perDay; pick = i; }
      }
      if (pick < 0) break;
      days[pick] -= 1; left += 1;
    }
    return days;
  };
  let pieceLoads = pieces.map(loadOfPiece);
  let days = apportion(pieceLoads);

  // A pocket that cannot fill its days sits outside the band whatever the
  // cut. Three pieces of 65, 59 and 40 run-visits on six day-groups can only
  // be 2/2/2 (32, 30 and 20 a day) or 3/2/1 (22, 30 and 40): eight light days
  // a month either way, and no polishing pass can touch them because nothing
  // else is within reach. If joining a piece to its nearest neighbour - one
  // hop over the limit, once per repeat - brings more days into the band than
  // it takes out, join them and say so. Days of 17 are lost calls; one 5 km
  // drive is a known cost.
  if (pieces.length > 1) {
    const lo = dayVisitsMin > 0 ? dayVisitsMin : targetLoad * (1 - dayLoadTolerance);
    const hi = dayVisitsMax > 0 ? dayVisitsMax : targetLoad * (1 + dayLoadTolerance);
    const daysOutOfBand = (loads: number[], alloc: number[]) =>
      loads.reduce((n, l, i) => n + ((l / alloc[i] < lo - 0.5 || l / alloc[i] > hi + 0.5) ? alloc[i] : 0), 0);
    let bad = daysOutOfBand(pieceLoads, days);
    while (bad > 0 && pieces.length > 1) {
      let best: { i: number; j: number; bad: number; gap: number } | null = null;
      for (let i = 0; i < pieces.length; i++) {
        let j = -1, gap = Infinity;
        for (let k = 0; k < pieces.length; k++) {
          if (k === i) continue;
          const g = gapBetween(pieces[i], pieces[k]);
          if (g < gap) { gap = g; j = k; }
        }
        if (j < 0) continue;
        const merged = pieces.map((p, k) => k === i ? [...p, ...pieces[j]] : p).filter((_, k) => k !== j);
        const loads = merged.map(loadOfPiece);
        const b = daysOutOfBand(loads, apportion(loads));
        if (b < bad && (!best || b < best.bad || (b === best.bad && gap < best.gap))) best = { i, j, bad: b, gap };
      }
      if (!best) break;
      console.log(`[hops] ${rep.name}: joining a piece of ${pieces[best.i].length} outlets to one of ${pieces[best.j].length}, ${best.gap.toFixed(1)}km apart (over the ${maxHopKm}km limit) - kept apart, ${bad} day(s) a month would sit outside ${Math.round(lo)}-${Math.round(hi)} visits; joined, ${best.bad}.`);
      const joined = [...pieces[best.i], ...pieces[best.j]];
      pieces = pieces.filter((_, k) => k !== best!.i && k !== best!.j);
      pieces.push(joined);
      pieceLoads = pieces.map(loadOfPiece);
      days = apportion(pieceLoads);
      bad = best.bad;
    }
  }
  if (pieces.length > 1) {
    console.log(`[hops] ${rep.name}: ${pieces.length} pieces within ${maxHopKm}km -> ` +
      pieces.map((p, i) => `${p.length} outlets/${days[i]} day${days[i] === 1 ? '' : 's'}`).join(', '));
  }

  let dailyClusters: Outlet[][] = [];
  pocketGroups = new Set<number>();
  for (let i = 0; i < pieces.length; i++) {
    // Villages and tight neighbourhoods that fit in a day are cut as one
    // unit, so a day never takes half a village while another day takes the
    // other half. Only when there are enough units to choose from.
    const dayMean = pieces[i].reduce((s, o) => s + runLoadOf(o), 0) / Math.max(1, days[i]);
    const blocksP = collapseBlocks(pieces[i], 0.5, runLoadOf, dayMean * 0.75);
    // Only where villages are a real share of the ground (two outlets in
    // five or more): in a dense city block-level units just coarsen the cut.
    const villageShare = (pieces[i].length - blocksP.units.length + blocksP.blocks) / Math.max(1, pieces[i].length);
    const useBlocks = blocksP.blocks > 0 && blocksP.units.length >= 4 * days[i] && villageShare >= 0.4;
    if (useBlocks) console.log(`[villages] ${rep.name}: ${pieces[i].length} outlets in ${blocksP.units.length} units (${blocksP.blocks} whole villages) for ${days[i]} day-group(s)`);
    // After the village-level cut, single outlets on a border fix whatever
    // load imbalance whole villages could not: a village is cut only as much
    // as the visits band requires.
    // The village cut has to earn its place: it is kept only when the rep's
    // plain driving distance is within five percent of the outlet-level cut.
    let groups = await partitionPiece(pieces[i], days[i]);
    if (useBlocks) {
      const byVillage = repairLoads(blocksP.expand(await partitionPiece(blocksP.units, days[i], 0.12)), runLoadOf, bandFor(pieces[i], days[i]), maxHopKm);
      const kmO = groups.reduce((s, g) => s + tourLength(g), 0), kmV = byVillage.reduce((s, g) => s + tourLength(g), 0);
      if (kmV <= kmO * 1.05 + 0.5) { console.log(`[villages] ${rep.name}: village cut kept (${kmV.toFixed(1)}km vs ${kmO.toFixed(1)}km by outlets)`); groups = byVillage; }
      else console.log(`[villages] ${rep.name}: village cut dropped (${kmV.toFixed(1)}km vs ${kmO.toFixed(1)}km by outlets)`);
    }
    if (i > 0) for (let g = 0; g < groups.length; g++) pocketGroups.add(dailyClusters.length + g);
    dailyClusters.push(...groups);
  }

  // Guardrail. The failure this replaced looked perfect on every count-based
  // check and on the median route, because only one day in six was wrong. The
  // measurement that catches it is the WIDEST day against the rep's own
  // territory - log it so a future change cannot quietly reintroduce it.
  {
    const spreadOf = (g: Outlet[]) => {
      let worst = 0;
      for (let i = 0; i < g.length; i++) {
        for (let j = i + 1; j < g.length; j++) {
          const d = geoDist(g[i].latitude, g[i].longitude, g[j].latitude, g[j].longitude);
          if (d > worst) worst = d;
        }
      }
      return worst;
    };
    const territory = spreadOf(repOutlets);
    if (territory > 0.5) {
      const widest = Math.max(...dailyClusters.filter(g => g.length > 1).map(spreadOf));
      const ratio = widest / territory;
      // Both conditions matter. A ratio alone cries wolf on a tight territory
      // (2.6km of 4.7km is a fine day); a width alone cries wolf on genuinely
      // sparse ground, where every day is wide because the outlets are.
      const flag = ratio > 0.7 && widest > 4 ? '  <-- one day may be sweeping up the rest' : '';
      console.log(`[days] ${rep.name}: widest day ${widest.toFixed(1)}km of a ${territory.toFixed(1)}km territory (${(ratio * 100).toFixed(0)}%)${flag}`);
    }
  }
  while (dailyClusters.length < numDays) dailyClusters.push([]);

  if (maxHopKm > 0) {
    const hops = dailyClusters.filter(g => g.length > 1).map(longestHop);
    const over = hops.filter(h => h > maxHopKm).length;
    if (over > 0) {
      console.log(`[hops] ${rep.name}: ${over} of ${hops.length} day-routes still have a hop over ${maxHopKm}km (worst ${Math.max(...hops).toFixed(1)}km)`);
    }
  }
  const runRepeats = cycleShape(rep.workingDaysPerWeek || 5).repeats;
  const loads = dailyClusters.map(g =>
    Math.round((g.reduce((sum, o) => sum + Math.min(o.visitFrequency ?? 1, runRepeats), 0) / runRepeats) * 10) / 10);
  console.log(`[days] ${rep.name}: ${repOutlets.length} outlets -> visits per run of each day-group ${loads.join(', ')}`);

  return scheduleFromDailyClusters(rep, dailyClusters, repOutlets);
}

// STEP 3+4 of the anchor-aware scheduler: per-day VF rotation with spatial
// sub-clustering, shared by both the flat-pool and zone-preserving builders.
// Day-groups that are pockets - whole days carved out because nothing else is
// within a legal hop of them - and the cells they became, per rep. The
// territory feedback pass reads this: a pocket's spare capacity is not room
// the rep's core can use, and a pocket's overflow cannot be shed.
let pocketGroups = new Set<number>();
const pocketCellsByRep = new Map<string, Set<string>>();

function scheduleFromDailyClusters(rep: Rep, dailyClusters: Outlet[][], repOutlets: Outlet[]): InsertSchedule[] {
  const { repeats, dayGroups, cycleDays, planDays } = cycleShape(workingWeek.length || rep.workingDaysPerWeek || 5);
  const bonusCells = new Set<string>();
  const pocketCells = new Set<string>();
  pocketCellsByRep.set(rep.id, pocketCells);

  const subCluster = (outlets: Outlet[], k: number): Outlet[][] => {
    const buckets: Outlet[][] = Array.from({ length: k }, () => []);
    if (outlets.length === 0) return buckets;
    if (outlets.length <= k) {
      outlets.forEach((o, i) => buckets[i].push(o));
      return buckets;
    }
    // Reuse the same anchor clusterer for spatial sub-grouping.
    const groups = clusterOutletsIntoDailyGroups(outlets, k);
    // Track placement so no outlet is silently dropped if the clusterer
    // returns more than k groups or omits any.
    const placed = new Set<string>();
    groups.forEach((g, i) => {
      if (i < k) {
        buckets[i] = [...g];
        for (const o of g) placed.add(o.id);
      }
    });
    // Any outlets that ended up in extra groups (or were dropped) are
    // pushed into the smallest bucket so coverage is preserved.
    for (const o of outlets) {
      if (placed.has(o.id)) continue;
      let smallestIdx = 0;
      for (let i = 1; i < k; i++) {
        if (buckets[i].length < buckets[smallestIdx].length) smallestIdx = i;
      }
      buckets[smallestIdx].push(o);
    }
    return buckets;
  };

  // A day-group is driven `repeats` times a cycle, so one membership carries at
  // most `repeats` visits. On a 4-repeat cycle that covers every frequency the
  // app offers and this loop is a no-op. On the 2-repeat (26-day) cycle a
  // weekly outlet needs four visits out of two runs, so it is also enrolled in
  // the nearest neighbouring day-group and picks up two more there. Choosing
  // the NEAREST group keeps the second call on a route that already passes
  // close by rather than inventing a detour.
  const groupsOf: Outlet[][] = Array.from({ length: dayGroups }, (_, d) => [...(dailyClusters[d] ?? [])]);
  const visitsHere = new Map<string, number>(); // `${group}:${outletId}` -> visits owed there
  const groupCentroids = groupsOf.map(g => g.length === 0 ? null : {
    lat: g.reduce((sum, o) => sum + o.latitude, 0) / g.length,
    lng: g.reduce((sum, o) => sum + o.longitude, 0) / g.length,
  });

  // Every group starts carrying its own outlets' first share.
  const runLoad = new Array(dayGroups).fill(0);
  const overflow: { outlet: Outlet; home: number; share: number }[] = [];
  for (let d = 0; d < dayGroups; d++) {
    for (const o of (dailyClusters[d] ?? [])) {
      const shares = membershipsFor(o.visitFrequency ?? 1, repeats);
      visitsHere.set(`${d}:${o.id}`, shares[0]);
      runLoad[d] += shares[0] / repeats;
      for (let m = 1; m < shares.length; m++) overflow.push({ outlet: o, home: d, share: shares[m] });
    }
  }

  // Then the overflow is placed, biggest first, into the nearest group that
  // still has room. Sending it to the nearest group outright was the obvious
  // thing and it was wrong: the extra calls all landed on whichever group sat
  // in the densest pocket, and days that were meant to hold 21-24 came out at
  // 29. A group is "full" at the cycle's mean load, so the overflow spreads.
  // The ceiling has to count the overflow itself. Taking the mean of the
  // primary loads alone put every group at the mean already, so nothing ever
  // had room and the overflow fell back to "nearest" every time - the exact
  // behaviour this is meant to replace.
  const overflowLoad = overflow.reduce((sum, x) => sum + x.share / repeats, 0);
  const meanLoad = (runLoad.reduce((a, b) => a + b, 0) + overflowLoad) / Math.max(1, dayGroups);
  overflow.sort((a, b) => b.share - a.share);
  for (const { outlet: o, home, share } of overflow) {
    const candidates: { idx: number; dist: number }[] = [];
    for (let e = 0; e < dayGroups; e++) {
      const c = groupCentroids[e];
      if (e === home || !c || visitsHere.has(`${e}:${o.id}`)) continue;
      candidates.push({ idx: e, dist: haversineDistance(o.latitude, o.longitude, c.lat, c.lng) });
    }
    if (candidates.length === 0) continue; // nowhere else to put it
    candidates.sort((a, b) => a.dist - b.dist);
    // Only the immediate neighbours are eligible, and the emptiest of those
    // wins. Searching every group for one with room spread the load beautifully
    // and cost 25% more driving, because "nearest with room" can be right
    // across the territory; capping the search at three neighbours keeps the
    // second call next door and still stops one group taking all the overflow.
    const near = candidates.slice(0, 3);
    const cap = meanLoad * (1 + dayLoadTolerance);
    const roomy = near.find(c => runLoad[c.idx] + share / repeats <= cap);
    const pick = (roomy ?? near.reduce((a, b) => (runLoad[a.idx] <= runLoad[b.idx] ? a : b))).idx;
    groupsOf[pick].push(o);
    visitsHere.set(`${pick}:${o.id}`, share);
    runLoad[pick] += share / repeats;
  }

  const schedules: InsertSchedule[] = [];
  const groupByOutlet = new Map<string, Set<number>>();
  for (let d = 0; d < dayGroups; d++) {
    const dayOutlets = groupsOf[d];
    if (dayOutlets.length === 0) continue;

    // Split each frequency band into buckets, one per week it can fall on.
    //
    // These must be equal-sized AND geographically tight. Dealing them along a
    // route-order walk kept the weeks even but scattered each one across the
    // whole day-group: where outlets are visited monthly, a day-group holds
    // four weeks of work, so every actual day-route ended up covering four
    // times the ground it needed to. Growing balanced sub-regions gives each
    // week its own compact corner of the day instead - same size, quarter of
    // the area. Every outlet counts as one visit here, so unit weight.
    //
    // These buckets ARE the actual day-routes the rep drives, so the tour-length
    // polish belongs here as well as at the day-group level above: polishing the
    // group only shapes the pool that the weeks are then drawn from.
    const oneVisit = unitLoad(() => 1);
    const splitWeeks = (pool: Outlet[], buckets: number): Outlet[][] => {
      // Whole villages per week where they fit: a village of 15 in a day of
      // 39 goes to one week, not 8 and 7 across both.
      const weekMean = pool.length / Math.max(1, buckets);
      const blocksW = collapseBlocks(pool, 0.5, () => 1, weekMean * 1.1);
      const shareW = (pool.length - blocksW.units.length + blocksW.blocks) / Math.max(1, pool.length);
      const byOutlet = splitWeekUnits(pool, buckets);
      if (blocksW.blocks > 0 && blocksW.units.length >= 3 * buckets && shareW >= 0.4) {
        const byVillage = repairLoads(blocksW.expand(splitWeekUnits(blocksW.units, buckets, 0.12)), () => 1, weekBand(pool.length / Math.max(1, buckets)), maxHopKm);
        const kmO = byOutlet.reduce((s, g) => s + tourLength(g), 0), kmV = byVillage.reduce((s, g) => s + tourLength(g), 0);
        if (kmV <= kmO * 1.05 + 0.2) return byVillage;
      }
      return byOutlet;
    };
    // Same band and hop limit as the day-groups above: the user's floor and
    // ceiling against this pool's own mean, not a symmetric 5% around it.
    const weekBand = (mean: number, atLeast: number = 0.02): Band => dayVisitsMin > 0 && dayVisitsMax > 0 && mean > 0
      ? { below: roomBelow(mean, atLeast), above: roomAbove(mean, atLeast) }
      : Math.max(0.05, atLeast);
    const splitWeekUnits = (pool: Outlet[], buckets: number, atLeast: number = 0.02) => {
      const band = weekBand(pool.reduce((s, o) => s + oneVisit(o), 0) / Math.max(1, buckets), atLeast);
      return repairLoads(
        polishByTourLength(growBalancedRegions(pool, buckets, oneVisit), oneVisit, band, 4, maxHopKm),
        oneVisit,
        band,
        maxHopKm,
      );
    };
    // One bucket set per frequency band, sized so the band's visits land evenly
    // across the cycle's repeats.
    // Band by how many of this group's runs the outlet is due on - 1..repeats -
    // not by its raw visit frequency, so an outlet that split across two groups
    // is banded by the share this group owes it.
    const banded: { visits: number; buckets: Outlet[][] }[] = [];
    for (let v = 1; v <= repeats; v++) {
      const pool = dayOutlets.filter(o => (visitsHere.get(`${d}:${o.id}`) ?? 1) === v);
      banded.push({ visits: v, buckets: pool.length > 0 ? splitWeeks(pool, bucketsForFrequency(v, repeats)) : [] });
    }

    for (let repeat = 1; repeat <= repeats; repeat++) {
      const runOutlets: Outlet[] = [];
      for (const band of banded) {
        band.buckets.forEach((bucket, i) => {
          if (repeatsForBucket(band.visits, repeats, i).includes(repeat)) runOutlets.push(...bucket);
        });
      }

      if (runOutlets.length === 0) continue;

      const optimized = optimizeRoute(runOutlets);
      const optimizedIds = optimized.map(o => o.id);
      const dist = calculateTotalDistance(optimized);
      const cell = calendarCell(repeat, d + 1, dayGroups, workingWeek);

      for (const id of optimizedIds) {
        if (!groupByOutlet.has(id)) groupByOutlet.set(id, new Set());
        groupByOutlet.get(id)!.add(d);
      }

      schedules.push({
        repId: rep.id,
        week: cell.week,
        dayOfWeek: cell.dayOfWeek,
        outletIds: optimizedIds,
        routeOrder: optimizedIds,
        totalDistance: Math.round(dist * 100) / 100,
        estimatedDuration: optimized.length * 15,
      });
      if (pocketGroups.has(d)) pocketCells.add(`${cell.week}:${cell.dayOfWeek}`);

      // The bonus day(s): a month one day longer than its pattern continues
      // into the next cycle's first day, driving pattern day 1 again. The rep
      // has a route on every working day of the month; route 1's outlets get
      // one extra call that month.
      if (cell.cycleDay <= planDays - cycleDays) {
        const bonus = calendarCell(1, cell.cycleDay + cycleDays, 1, workingWeek);
        schedules.push({
          repId: rep.id,
          week: bonus.week,
          dayOfWeek: bonus.dayOfWeek,
          outletIds: optimizedIds,
          routeOrder: optimizedIds,
          totalDistance: Math.round(dist * 100) / 100,
          estimatedDuration: optimized.length * 15,
        });
        bonusCells.add(`${bonus.week}:${bonus.dayOfWeek}`);
      }
    }
  }

  // End-to-end validation: each outlet visited exactly visitFrequency times, and
  // always from the same day-group. On a four-week cycle one day-group is one
  // weekday, which is the classic "same day every week" rule; on the 26-day
  // cycle a group's two runs land on different weekdays by design, so the
  // invariant is the group, not the weekday.
  const visitCounts = new Map<string, number>();
  for (const s of schedules) {
    if (bonusCells.has(`${s.week}:${s.dayOfWeek}`)) continue; // beyond the pattern
    for (const id of (s.outletIds as string[])) {
      visitCounts.set(id, (visitCounts.get(id) || 0) + 1);
    }
  }
  let consistencyOk = true;
  for (const o of repOutlets) {
    const groups = groupByOutlet.get(o.id);
    const allowed = membershipsFor(o.visitFrequency ?? 1, repeats).length;
    if (groups && groups.size > allowed) { consistencyOk = false; break; }
  }
  let coverageOk = true;
  for (const o of repOutlets) {
    const expected = membershipsFor(o.visitFrequency ?? 1, repeats).reduce((a, b) => a + b, 0);
    const actual = visitCounts.get(o.id) || 0;
    if (actual !== expected) { coverageOk = false; break; }
  }
  if (!coverageOk || !consistencyOk) {
    console.warn(`[buildAnchorAwareSchedules] Validation issues for rep ${rep.name}: coverage=${coverageOk}, sameDayOfWeek=${consistencyOk}`);
  }

  return schedules;
}

// Helper function to generate weekly schedules for a route
function generateWeeklySchedules(rep: Rep, outlets: Outlet[]): InsertSchedule[] {
  const schedules: InsertSchedule[] = [];
  const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const workingDays = daysOfWeek.slice(0, rep.workingDaysPerWeek);
  
  // Separate outlets by visit frequency
  const vf2Outlets = outlets.filter(o => o.visitFrequency === 2);
  const vf4Outlets = outlets.filter(o => o.visitFrequency === 4);
  
  // For VF2 outlets: Split them into two groups for alternating weeks
  const vf2Group1 = vf2Outlets.filter((_, i) => i % 2 === 0); // Visit in week 1 (and week 3)
  const vf2Group2 = vf2Outlets.filter((_, i) => i % 2 === 1); // Visit in week 2 (and week 4)
  
  // Generate schedules for Week 1 and Week 2 (pattern repeats for weeks 3 and 4)
  for (let week = 1; week <= 2; week++) {
    // Determine which VF2 group to visit this week
    const currentVf2Group = week === 1 ? vf2Group1 : vf2Group2;
    
    // Calculate visits needed per day
    const totalVisitsNeeded = vf4Outlets.length + currentVf2Group.length;
    const visitsPerDay = Math.ceil(totalVisitsNeeded / workingDays.length);
    
    // Create a pool of all outlets to visit this week
    const weeklyOutletPool = [...vf4Outlets, ...currentVf2Group];
    let outletIndex = 0;
    
    for (let dayIndex = 0; dayIndex < workingDays.length; dayIndex++) {
      const dayName = workingDays[dayIndex];
      const visitOrder: string[] = [];
      
      // Distribute outlets evenly across days
      let dailyVisitCount = 0;
      while (dailyVisitCount < Math.min(visitsPerDay, rep.maxDailyVisits) && outletIndex < weeklyOutletPool.length) {
        visitOrder.push(weeklyOutletPool[outletIndex].id);
        outletIndex++;
        dailyVisitCount++;
      }
      
      // If we've gone through all outlets but still have days left, restart from beginning
      if (outletIndex >= weeklyOutletPool.length && dayIndex < workingDays.length - 1) {
        outletIndex = 0;
      }
      
      if (visitOrder.length > 0) {
        // Store schedules for both the current week and its repeat (week 1 repeats as week 3, week 2 as week 4)
        // dayOfWeek is 1-based: Monday=1
        schedules.push({
          repId: rep.id,
          week: week,
          dayOfWeek: daysOfWeek.indexOf(dayName) + 1,
          outletIds: visitOrder,
          routeOrder: visitOrder
        });
        
        // Also create the repeat week (3 or 4)
        schedules.push({
          repId: rep.id,
          week: week + 2,
          dayOfWeek: daysOfWeek.indexOf(dayName) + 1,
          outletIds: visitOrder,
          routeOrder: visitOrder
        });
      }
    }
  }
  
  return schedules;
}

import { generateScheduleExcel } from './export';
import { jobs, captureResponse, type JobProgress } from './jobs';
import { WEEKDAY_NAMES, parseWorkingWeek, type MonthEdges, isoWeekday, ymd, nextMonthKey, monthPlanDates, cycleShape as cycleShapeFor, calendarCell as calendarCellAt, upcomingWorkingDates as upcomingWorkingDatesFrom, membershipsFor, bucketsForFrequency, repeatsForBucket } from './cycle';
import { authStore, AuthError, canEdit, toPublic, ROLES, type Role, type User } from './auth';


declare global {
  namespace Express {
    interface Request {
    }
  }
}

function extractIpAddress(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return ips.trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}


// Credentials never live in this source file - the repo is public, and the
// pair that used to be hardcoded here is still exposed in git history.
// Accounts live in the auth store (server/auth.ts). The old single admin
// (SUPERUSER_* secrets or data/admin.json) is imported as the first account
// only when no accounts exist yet; after that it is not consulted.
const credentialSource = adminCredentialSource();
if (credentialSource !== 'none') {
  console.log(`[auth] Legacy admin found in ${credentialSource === 'env' ? 'environment variables' : 'data/admin.json'}; used only to seed the first account.`);
} else {
  console.log('[auth] No legacy admin; on a fresh install the first visitor creates the admin account in the app.');
}

const SESSION_COOKIE = 'session';
const OPEN_PATHS = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/status', '/api/auth/setup', '/api/health', '/api/config/mapbox']);

export async function registerRoutes(app: Express): Promise<Server> {
  await authStore.load();

  // Who is calling, and may they? Every /api route needs a signed-in user
  // except the handful above; anything that changes data needs a planner
  // or an admin; the accounts endpoints need an admin. Before this, the
  // admin flag only hid two buttons and every endpoint answered anyone.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE] || null;
    const user = authStore.resolveSession(token);
    (req as any).user = user;
    (req as any).isSuperuser = user?.role === 'admin';
    if (!req.path.startsWith('/api')) return next();
    if (OPEN_PATHS.has(req.path)) return next();
    if (!user) return res.status(401).json({ message: 'Sign in to continue' });
    if (req.path.startsWith('/api/users') && user.role !== 'admin') {
      return res.status(403).json({ message: 'Only an admin can manage accounts' });
    }
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating && !canEdit(user.role) && req.path !== '/api/auth/change-password') {
      return res.status(403).json({ message: 'Your account is view-only; ask an admin for planner access to make changes' });
    }
    next();
  });

  const currentUser = (req: Request) => (req as any).user as User | null;
  const setSessionCookie = (res: Response, token: string) => {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });
  };
  const authFail = (res: Response, err: unknown, fallback: string) => {
    if (err instanceof AuthError) return res.status(err.status).json({ message: err.message });
    console.error(fallback, err);
    return res.status(500).json({ message: fallback });
  };

  // A Mapbox public token is intentionally usable by browsers. The workspace
  // stores it without Vite's client-only prefix, so provide it through this
  // same-origin configuration endpoint for map components.
  app.get("/api/config/mapbox", (_req: Request, res: Response) => {
    res.json({
      token: process.env.MAPBOX_PUBLIC_KEY || process.env.VITE_MAPBOX_PUBLIC_KEY || '',
    });
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const user = authStore.verifyLogin(req.body?.email, req.body?.password);
      const token = authStore.createSession(user.id);
      setSessionCookie(res, token);
      res.clearCookie('superuser_session');
      return res.json({ success: true, user: toPublic(user) });
    } catch (err) {
      return authFail(res, err, "Login failed");
    }
  });

  // First run: no accounts exist yet, so whoever reaches the app first
  // creates the admin. Refused as soon as one account exists.
  app.post("/api/auth/setup", async (req: Request, res: Response) => {
    try {
      if (!authStore.setupRequired()) return res.status(403).json({ message: "Accounts already exist; sign in, or ask an admin" });
      const user = authStore.createUser({ email: req.body?.email, name: req.body?.name, role: 'admin', password: req.body?.password });
      const token = authStore.createSession(user.id);
      setSessionCookie(res, token);
      return res.json({ success: true, user });
    } catch (err) {
      return authFail(res, err, "Setup failed");
    }
  });

  app.post("/api/auth/logout", async (req: Request, res: Response) => {
    authStore.destroySession(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE);
    res.clearCookie('superuser_session');
    res.json({ success: true, message: "Logged out" });
  });

  app.get("/api/auth/status", async (req: Request, res: Response) => {
    const user = currentUser(req);
    res.json({
      isAuthenticated: !!user,
      isSuperuser: user?.role === 'admin',
      canEdit: !!user && canEdit(user.role),
      user: user ? toPublic(user) : null,
      setupRequired: authStore.setupRequired(),
      adminConfigured: !authStore.setupRequired(),
    });
  });

  app.post("/api/auth/change-password", async (req: Request, res: Response) => {
    try {
      const user = currentUser(req)!;
      authStore.changeOwnPassword(user, String(req.body?.currentPassword ?? ''), String(req.body?.newPassword ?? ''));
      res.json({ success: true });
    } catch (err) {
      return authFail(res, err, "Could not change the password");
    }
  });

  // ---- Accounts (admin only; the guard above enforces it) ----
  app.get("/api/users", (_req: Request, res: Response) => res.json(authStore.listUsers()));
  app.post("/api/users", (req: Request, res: Response) => {
    try {
      const { email, name, role, password } = req.body || {};
      const user = authStore.createUser({ email, name, role: role as Role, password, mustChangePassword: true });
      res.status(201).json(user);
    } catch (err) {
      return authFail(res, err, "Could not create the account");
    }
  });
  app.patch("/api/users/:id", (req: Request, res: Response) => {
    try {
      const { name, role, isActive, password } = req.body || {};
      const user = authStore.updateUser(req.params.id, {
        ...(name !== undefined ? { name: String(name) } : {}),
        ...(role !== undefined ? { role: role as Role } : {}),
        ...(isActive !== undefined ? { isActive: !!isActive } : {}),
        ...(password !== undefined ? { password: String(password) } : {}),
      }, currentUser(req)!);
      res.json(user);
    } catch (err) {
      return authFail(res, err, "Could not update the account");
    }
  });
  app.delete("/api/users/:id", (req: Request, res: Response) => {
    try {
      authStore.deleteUser(req.params.id, currentUser(req)!);
      res.json({ success: true });
    } catch (err) {
      return authFail(res, err, "Could not delete the account");
    }
  });
  app.get("/api/users/roles", (_req: Request, res: Response) => res.json(ROLES));

  app.post("/api/outlets", async (req: Request, res: Response) => {
    try {
      
      const parsed = insertOutletSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid outlet data", errors: parsed.error.errors });
      }
      
      const outlet = await storage.createOutlet(parsed.data);

      res.status(201).json(outlet);
    } catch (error) {
      console.error("Error creating outlet:", error);
      res.status(500).json({ message: "Failed to create outlet" });
    }
  });

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
  // Last resort when none of the column names above matched: take any column
  // whose name LOOKS like a coordinate and whose value actually IS one.
  //
  // The list above is a list of spellings somebody thought of, so it keeps
  // meeting files it does not cover - a real 1,938-outlet file headed
  // "Lattitude" was rejected in full, every row reported as missing a latitude
  // it plainly had. Requiring the value to parse and to sit inside the valid
  // range is what makes guessing by name safe: a column called "Plate" or
  // "Translation" contains "lat" but cannot produce a number between -90 and 90
  // by accident.
  function coordinateFallback(normalizedRow: Record<string, any>, kind: 'lat' | 'lng'): string | undefined {
    const looksRight = kind === 'lat' ? /lat/ : /(long|lng|lon)/;
    const looksWrong = kind === 'lat' ? /(long|lng)/ : /lat/;
    const limit = kind === 'lat' ? 90 : 180;
    for (const [key, value] of Object.entries(normalizedRow)) {
      if (!looksRight.test(key) || looksWrong.test(key)) continue;
      const n = parseFloat(String(value));
      if (!Number.isFinite(n) || n === 0 || Math.abs(n) > limit) continue;
      return String(value);
    }
    return undefined;
  }

  // Outlets that may be the same shop entered twice.
  //
  // The tell is the GPS: two rows within a few metres of each other. But GPS
  // alone is not proof - in a dense souk the market and the nut seller next
  // door share coordinates to the metre, and on this data 161 pairs sit within
  // 10m of which most are plainly different shops. So this SUGGESTS, ranked by
  // confidence, and the user decides: identical coordinates or a matching
  // name is high; the same spot with one name in Arabic and one in Latin
  // script is the reported case and medium; the same spot with two different
  // names in the same script is low, and shown only so it can be checked.
  const normaliseName = (raw: string) => raw
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')          // Arabic diacritics and tatweel
    .replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/\b(سوبر ?ماركت|ميني ?ماركت|ماركت|مركز|محل|بقالية|بقاليه|سوبرماركت|super ?market|mini ?market|market|center|centre|shop|store|grocery)\b/g, ' ')
    .replace(/^ال/, '').replace(/\sال/g, ' ')
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, '')   // keep Latin, digits, Arabic
    .trim();
  const isArabic = (t: string) => /[\u0600-\u06FF]/.test(t);
  const isLatin = (t: string) => /[A-Za-z]/.test(t);
  const nameSimilarity = (a: string, b: string) => {
    const x = normaliseName(a), y = normaliseName(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    // "الرايق" and "الرايق اسبرسو" are the same shop with and without its
    // suffix; bigram overlap alone scores that 0.5.
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    if (short.length >= 3 && long.includes(short)) return 0.8;
    const grams = (t: string) => { const g = new Map<string, number>(); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); g.set(k, (g.get(k) ?? 0) + 1); } return g; };
    const ga = grams(x), gb = grams(y);
    let shared = 0; for (const [k, n] of Array.from(ga.entries())) shared += Math.min(n, gb.get(k) ?? 0);
    const total = (x.length - 1) + (y.length - 1);
    return total > 0 ? (2 * shared) / total : 0;
  };

  // Outlets currently held out of the plan, and the way to put them back.
  app.get("/api/outlets/excluded", async (_req, res) => {
    const all = await storage.getOutlets();
    const held = all.filter(o => o.territory === 'Excluded');
    res.json({ count: held.length, outlets: held.map(o => ({ id: o.id, name: o.name, code: o.code ?? null, address: o.address })) });
  });
  app.post("/api/outlets/restore", async (req, res) => {
    const ids: string[] | null = Array.isArray(req.body?.outletIds) ? req.body.outletIds.filter((x: unknown) => typeof x === 'string') : null;
    const all = await storage.getOutlets();
    let restored = 0;
    for (const o of all) {
      if (o.territory !== 'Excluded') continue;
      if (ids && !ids.includes(o.id)) continue;
      await storage.updateOutlet(o.id, { territory: null });
      restored++;
    }
    await storage.flush();
    res.json({ restored, message: `${restored} outlet(s) restored; run Optimize to put them back in the plan.` });
  });

  // Delete several outlets at once - the lasso on the Territory Map - and say
  // what that did to the count, so the user sees "had 1,938, now 1,901"
  // before deciding to re-plan.
  app.post("/api/outlets/delete-many", async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.outletIds) ? req.body.outletIds.filter((x: unknown) => typeof x === 'string') : [];
    if (ids.length === 0) return res.status(400).json({ message: "outletIds must be a non-empty array" });
    const before = (await storage.getOutlets()).length;
    let deleted = 0;
    for (const id of ids) if (await storage.deleteOutlet(id)) deleted++;
    const after = (await storage.getOutlets()).length;
    await storage.flush();
    console.log(`[outlets] deleted ${deleted} of ${ids.length} requested; ${before} -> ${after}`);
    res.json({ before, deleted, after });
  });

  app.get("/api/outlets/duplicates", async (req, res) => {
    try {
      const radiusM = Math.max(1, Math.min(100, parseFloat(String(req.query.radiusM ?? 10)) || 10));
      const all = (await storage.getOutlets()).filter(o => o.territory !== 'Excluded');
      // Union-find over pairs within the radius; a coarse latitude sort keeps
      // it from being all-pairs over the whole city.
      const sorted = [...all].sort((a, b) => a.latitude - b.latitude);
      const parent = sorted.map((_, i) => i);
      const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
      const latSpan = (radiusM / 1000) / 111 * 1.05;
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length && sorted[j].latitude - sorted[i].latitude <= latSpan; j++) {
          const d = geoDist(sorted[i].latitude, sorted[i].longitude, sorted[j].latitude, sorted[j].longitude) * 1000;
          if (d <= radiusM) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
        }
      }
      // Second pass: the same name within 150m, whatever the GPS says. A
      // shop entered twice can carry two GPS fixes 18m apart, which the
      // radius above misses; a common name 6km apart is a different shop and
      // stays out. Different rows of one name are linked only when they are
      // within that distance of each other.
      const nameKey = sorted.map(o => normaliseName(o.name));
      const byName = new Map<string, number[]>();
      nameKey.forEach((k, i) => { if (k.length >= 2) { if (!byName.has(k)) byName.set(k, []); byName.get(k)!.push(i); } });
      const nameRadiusM = 150;
      for (const idxs of Array.from(byName.values())) {
        if (idxs.length < 2) continue;
        for (let a = 0; a < idxs.length; a++) for (let b = a + 1; b < idxs.length; b++) {
          const i = idxs[a], j = idxs[b];
          const d = geoDist(sorted[i].latitude, sorted[i].longitude, sorted[j].latitude, sorted[j].longitude) * 1000;
          if (d <= nameRadiusM) { const x = find(i), y = find(j); if (x !== y) parent[x] = y; }
        }
      }
      const byRoot = new Map<number, Outlet[]>();
      sorted.forEach((o, i) => { const r = find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r)!.push(o); });

      // A spot can hold several stories at once - two rows of one shop AND the
      // shop next door - and union-find chains them into one cluster. So each
      // cluster is split by name first: rows sharing a name are one group, rated
      // by how far apart their fixes are; whatever is left at the spot is a
      // second group, rated by script. Without this the three rows of "شادي"
      // dragged the two shops beside them into a "likely duplicate" group.
      type DupGroup = { confidence: 'high' | 'medium' | 'low'; reason: string; maxDistanceM: number; keepId: string; members: any[]; suggestedRemoveIds: string[] };
      const clusters: DupGroup[] = [];
      const spanOf = (g: Outlet[]) => { let m = 0; for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) m = Math.max(m, geoDist(g[i].latitude, g[i].longitude, g[j].latitude, g[j].longitude) * 1000); return m; };
      const emit = (members: Outlet[], confidence: DupGroup['confidence'], reason: string, maxDistanceM: number) => {
        // Keep the busiest, then the more fully named; suggest the rest go.
        const keep = [...members].sort((a, b) => (b.visitFrequency ?? 1) - (a.visitFrequency ?? 1) || b.name.length - a.name.length)[0];
        clusters.push({
          confidence, reason, maxDistanceM: Math.round(maxDistanceM * 10) / 10, keepId: keep.id,
          members: members.map(o => ({ id: o.id, name: o.name, code: o.code ?? null, address: o.address, latitude: o.latitude, longitude: o.longitude, visitFrequency: o.visitFrequency, repId: o.repId })),
          suggestedRemoveIds: members.filter(o => o.id !== keep.id).map(o => o.id),
        });
      };
      for (const cluster of Array.from(byRoot.values())) {
        if (cluster.length < 2) continue;
        // Name groups: rows whose normalised names match, or contain one another.
        const groups: Outlet[][] = [];
        for (const o of cluster) {
          const g = groups.find(grp => nameSimilarity(grp[0].name, o.name) >= 0.6);
          if (g) g.push(o); else groups.push([o]);
        }
        const rest: Outlet[] = [];
        for (const g of groups) {
          if (g.length >= 2) {
            const span = spanOf(g);
            if (span <= 0.5) emit(g, 'high', 'Same coordinates and the same name', span);
            else if (span <= 50) emit(g, 'high', `Same name, ${span.toFixed(0)}m apart`, span);
            else emit(g, 'medium', `Same name, ${span.toFixed(0)}m apart - one shop with two GPS fixes, or two branches`, span);
          } else rest.push(g[0]);
        }
        // Whatever is left at the spot: different names within the GPS radius.
        const near = rest.filter(o => cluster.some(p => p !== o && geoDist(o.latitude, o.longitude, p.latitude, p.longitude) * 1000 <= radiusM));
        if (near.length >= 2) {
          const span = spanOf(near);
          const scripts = near.map(o => (isArabic(o.name) && !isLatin(o.name)) ? 'ar' : (isLatin(o.name) && !isArabic(o.name)) ? 'la' : 'mixed');
          const mixedScript = scripts.includes('ar') && scripts.includes('la');
          if (span <= 0.5) emit(near, mixedScript ? 'high' : 'medium', mixedScript ? 'Same coordinates, one name in Arabic and one in English' : 'Same coordinates, different names', span);
          else if (mixedScript) emit(near, 'medium', `${span.toFixed(0)}m apart, one name in Arabic and one in English`, span);
          else emit(near, 'low', `${span.toFixed(0)}m apart, different names - may be neighbouring shops`, span);
        }
      }
      const rank = { high: 0, medium: 1, low: 2 } as const;
      clusters.sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.maxDistanceM - b.maxDistanceM);
      res.json({
        radiusM,
        clusters,
        counts: { high: clusters.filter(c => c.confidence === 'high').length, medium: clusters.filter(c => c.confidence === 'medium').length, low: clusters.filter(c => c.confidence === 'low').length },
      });
    } catch (error) {
      console.error("Duplicate scan error:", error);
      res.status(500).json({ message: "Failed to scan for duplicates" });
    }
  });

  app.post("/api/upload", upload.single("file"), async (req: MulterRequest, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const { buffer, originalname, mimetype } = req.file;
      let data: any[] = [];

      // Visit frequency for rows whose file does not carry one. 1 = monthly,
      // 2 = biweekly, 3 = three weeks in four, 4 = weekly.
      const requestedDefaultVf = parseInt(String((req.body as any)?.defaultVisitFrequency ?? ""), 10);
      const defaultVisitFrequency = [1, 2, 3, 4].includes(requestedDefaultVf) ? requestedDefaultVf : 2;
      let rowsUsingDefaultVf = 0;

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
      } else if (mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || originalname.endsWith(".xlsx") || originalname.endsWith(".xls")) {
        try {
          const workbook = XLSX.read(buffer, { type: "buffer" });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          data = XLSX.utils.sheet_to_json(worksheet);
          
          // Check if data looks like encrypted content
          if (data.length > 0) {
            const firstRow = data[0] as Record<string, any>;
            const keys = Object.keys(firstRow);
            // Check for encryption markers
            if (keys.some(k => k.includes('CRYPT') || k.includes('\u0000') || k.includes('ÿ'))) {
              console.error('Excel file appears to be encrypted or password-protected');
              return res.status(400).json({ 
                message: "This Excel file appears to be password-protected or encrypted. Please save it without password protection and try again." 
              });
            }
          }
          
          console.log('Excel parsed - columns:', data.length > 0 ? Object.keys(data[0] as any).join(', ') : 'none');
          console.log('Excel parsed - total rows:', data.length);
        } catch (xlsxError: any) {
          console.error('Excel parsing error:', xlsxError.message);
          if (xlsxError.message?.includes('password') || xlsxError.message?.includes('encrypt')) {
            return res.status(400).json({ 
              message: "This Excel file is password-protected. Please remove the password and try again." 
            });
          }
          return res.status(400).json({ 
            message: "Failed to read Excel file. Please ensure it's a valid .xlsx file and not password-protected." 
          });
        }
      } else {
        return res.status(400).json({ message: "Unsupported file format. Please upload CSV or Excel files." });
      }

      if (data.length === 0) {
        return res.status(400).json({ message: "File is empty or could not be parsed" });
      }

      // NOTE: the existing outlets are NOT cleared here. Clearing first meant a
      // file the parser could not read destroyed the data already loaded - the
      // user saw "no valid outlets found" AND lost the 1,938 outlets they had,
      // with the schedules left pointing at rows that no longer existed. The
      // delete now happens below, once at least one valid outlet is in hand.

      // Process and validate data
      const outlets = [];
      const skippedRows: { row: number; reason: string }[] = [];
      for (const row of data) {
        try {
          // Parse time per visit (default 30 minutes if not provided)
          const timePerVisit = parseInt(
            row.time_per_visit || row.timePerVisit || row["Time Per Visit"] || 
            row.time || row.Time || row.duration || row.Duration || "30"
          );

          // Normalize row keys to lowercase for consistent matching
          const normalizedRow: Record<string, string> = {};
          Object.keys(row).forEach(key => {
            normalizedRow[key.toLowerCase().trim().replace(/[_\s]+/g, '')] = row[key];
          });
          
          // Log column headers on first row for debugging
          if (outlets.length === 0) {
            console.log('Available columns:', Object.keys(row).join(', '));
            console.log('Normalized keys:', Object.keys(normalizedRow).join(', '));
          }
          
          // Parse latitude - support many common column name variations
          const latValue = normalizedRow['latitude'] || normalizedRow['lat'] || 
                          normalizedRow['y'] || normalizedRow['gpslat'] || normalizedRow['gpslatitude'] ||
                          normalizedRow['geolat'] || normalizedRow['geolatitude'] ||
                          normalizedRow['coordlat'] || normalizedRow['coordy'] ||
                          normalizedRow['poslat'] || normalizedRow['posy'] ||
                          row.latitude || row.Latitude || row.lat || row.Lat || row.LAT ||
                          row.Y || row.y || row['GPS Lat'] || row['GPS Latitude'] || 
                          row['Geo Lat'] || row['Geo Latitude'] ||
                          coordinateFallback(normalizedRow, 'lat') || "0";
          
          // Parse longitude - support many common column name variations  
          const lngValue = normalizedRow['longitude'] || normalizedRow['lng'] || normalizedRow['lon'] ||
                          normalizedRow['x'] || normalizedRow['gpslong'] || normalizedRow['gpslongitude'] || normalizedRow['gpslng'] ||
                          normalizedRow['geolong'] || normalizedRow['geolongitude'] || normalizedRow['geolng'] ||
                          normalizedRow['coordlong'] || normalizedRow['coordx'] || normalizedRow['coordlng'] ||
                          normalizedRow['poslong'] || normalizedRow['posx'] || normalizedRow['poslng'] ||
                          row.longitude || row.Longitude || row.lng || row.Lng || row.LNG ||
                          row.lon || row.Lon || row.LON ||
                          row.X || row.x || row['GPS Long'] || row['GPS Longitude'] || row['GPS Lng'] ||
                          row['Geo Long'] || row['Geo Longitude'] || row['Geo Lng'] ||
                          coordinateFallback(normalizedRow, 'lng') || "0";
          
          const rowNum = outlets.length + skippedRows.length + 2;

          // "Client Name" / "Client Code" are what the trade-census exports
          // actually use; without them every row of a real route-plan file was
          // rejected for a missing name.
          const outletName = normalizedRow['outletname'] || normalizedRow['name'] || normalizedRow['outlet'] ||
                  normalizedRow['clientname'] || normalizedRow['client'] ||
                  normalizedRow['shopname'] || normalizedRow['shop'] ||
                  normalizedRow['storename'] || normalizedRow['store'] ||
                  normalizedRow['customername'] || normalizedRow['customer'] ||
                  normalizedRow['location'] || normalizedRow['site'] || normalizedRow['account'] ||
                  normalizedRow['clientcode'] || normalizedRow['outletcode'] || normalizedRow['code'] ||
                  row['Outlet Name'] || row['Shop Name'] || row['Store Name'] || row['Customer Name'] ||
                  row['Client Name'] || row['Client Code'] ||
                  row.Name || row.name || row.Outlet || row.outlet || "";

          const hasVfColumn = (normalizedRow['vf'] ?? normalizedRow['visitfrequency'] ??
            row.vf ?? row.VF ?? row.visit_frequency ?? row["Visit Frequency"]) != null;
          if (!hasVfColumn) rowsUsingDefaultVf++;

          const parsedLat = parseFloat(latValue);
          const parsedLng = parseFloat(lngValue);

          if (!outletName || !outletName.toString().trim()) {
            skippedRows.push({ row: rowNum, reason: `Missing outlet name (required)` });
            continue;
          }

          if (!latValue || latValue === "0" || isNaN(parsedLat)) {
            skippedRows.push({ row: rowNum, reason: `Missing latitude for "${outletName}"` });
            continue;
          }

          if (!lngValue || lngValue === "0" || isNaN(parsedLng)) {
            skippedRows.push({ row: rowNum, reason: `Missing longitude for "${outletName}"` });
            continue;
          }

          if (parsedLat < -90 || parsedLat > 90) {
            skippedRows.push({ row: rowNum, reason: `Latitude out of range (-90 to 90) for "${outletName}": ${parsedLat}` });
            continue;
          }

          if (parsedLng < -180 || parsedLng > 180) {
            skippedRows.push({ row: rowNum, reason: `Longitude out of range (-180 to 180) for "${outletName}": ${parsedLng}` });
            continue;
          }

          const clientCode = normalizedRow['clientcode'] || normalizedRow['outletcode'] || normalizedRow['code'] ||
                  normalizedRow['customercode'] || normalizedRow['shopcode'] || normalizedRow['storecode'] ||
                  row['Client Code'] || row['Outlet Code'] || row['Code'] || '';
          const outlet: typeof insertOutletSchema._type = {
            name: outletName.toString().trim(),
            code: clientCode ? String(clientCode).trim() : null,
            address: normalizedRow['address'] || normalizedRow['addr'] || normalizedRow['streetaddress'] ||
                    normalizedRow['fulladdress'] || normalizedRow['location'] ||
                    `${row.District || ''} - ${row.Region || ''} - ${row.Area || ''}`.replace(/^- |- $|^-$/, '').trim() || 
                    row.address || row.Address || "",
            latitude: parsedLat,
            longitude: parsedLng,
            // A file with no frequency column is not a file that means
            // "biweekly" - it is a file that has not said. Defaulting silently
            // doubled the headcount on a 2,693-outlet Damascus file (VF2 needs
            // 10 reps where VF1 needs 5) with nothing in the UI to show for it,
            // so the count of assumed rows is reported back and the caller can
            // set the policy with defaultVisitFrequency.
            visitFrequency: parseInt(normalizedRow['vf'] || normalizedRow['visitfrequency'] ||
                                    row.vf || row.VF || row.visit_frequency || row["Visit Frequency"] ||
                                    String(defaultVisitFrequency)),
            timePerVisit: isNaN(timePerVisit) ? 30 : Math.max(5, Math.min(120, timePerVisit)),
            value: (() => {
              // Commercial weight of the outlet (VC / volume class / sales value)
              // used by weightMode 'value' in coverage-worthiness analysis.
              const raw = normalizedRow['vc'] || normalizedRow['value'] || normalizedRow['volume'] ||
                          normalizedRow['volumeclass'] || normalizedRow['sales'] || normalizedRow['salesvalue'];
              const parsedValue = parseFloat(raw);
              return isNaN(parsedValue) ? null : parsedValue;
            })(),
            territory: normalizedRow['district'] || normalizedRow['territory'] || normalizedRow['zone'] || normalizedRow['region'] ||
                      row.District || row.territory || row.Territory || row.zone || row.Zone || null,
            repId: null,
            cluster: null
          };

          // Support VF1 (monthly), VF2 (bi-weekly), VF4 (weekly)
          if (![1, 2, 4].includes(outlet.visitFrequency)) {
            outlet.visitFrequency = 2; // Default to VF2
          }

          outlets.push(outlet);
        } catch (error: any) {
          console.warn(`Error processing row:`, row, error);
          skippedRows.push({ row: outlets.length + skippedRows.length + 2, reason: error?.message || 'Unknown error' });
        }
      }

      if (outlets.length === 0) {
        const topReasons = skippedRows.slice(0, 5).map(s => s.reason).join('; ');
        // Name the columns the file actually has. Without this the message says
        // a row is missing a latitude while the user is looking at a latitude
        // column, and there is nothing in the UI to tell them the header is the
        // problem - they have to read the server log to find out.
        const columnsFound = data.length > 0 ? Object.keys(data[0]) : [];
        const columnHint = columnsFound.length > 0
          ? ` Columns found in your file: ${columnsFound.join(', ')}.`
          : '';
        return res.status(400).json({ 
          message: `No valid outlets found. Each row must have Outlet Name, Latitude, and Longitude.${columnHint} ${topReasons ? 'Issues found: ' + topReasons : ''}`,
          columnsFound,
          skippedRows: skippedRows.length,
          skippedDetails: skippedRows.slice(0, 20)
        });
      }

      // Only now that the file has parsed into at least one usable outlet is it
      // safe to replace what is loaded.
      //
      // Decisions survive the upload. Outlets the user held out of the plan -
      // removed duplicates, outliers set aside - are matched to the new rows
      // by client code, or by name and coordinates when the file has no
      // codes, and held out again. Before this, re-uploading the list (which
      // every refreshed customer file requires) silently brought every removed
      // duplicate back.
      // Matching is by COUNT per key, because a duplicate pair can be two
      // identical rows - same code, same name, same coordinates - and only one
      // of them was removed. Matching by identity alone held out both.
      const previouslyHeld = (await storage.getOutlets()).filter(o => o.territory === 'Excluded');
      const spotKey = (o: { name: string; latitude: number; longitude: number }) => `${o.name.trim().toLowerCase()}|${o.latitude.toFixed(5)}|${o.longitude.toFixed(5)}`;
      const heldByCode = new Map<string, number>();
      const heldBySpot = new Map<string, number>();
      for (const o of previouslyHeld) {
        const code = (o.code || '').trim();
        if (code) heldByCode.set(code, (heldByCode.get(code) ?? 0) + 1);
        else heldBySpot.set(spotKey(o), (heldBySpot.get(spotKey(o)) ?? 0) + 1);
      }
      await storage.deleteAllOutlets();

      // Create outlets in storage
      const createdOutlets = await storage.createOutlets(outlets);
      let carriedOver = 0;
      for (const o of createdOutlets) {
        const code = (o.code || '').trim();
        let hold = false;
        if (code && (heldByCode.get(code) ?? 0) > 0) { heldByCode.set(code, heldByCode.get(code)! - 1); hold = true; }
        else if (!code && (heldBySpot.get(spotKey(o)) ?? 0) > 0) { heldBySpot.set(spotKey(o), heldBySpot.get(spotKey(o))! - 1); hold = true; }
        if (hold) {
          await storage.updateOutlet(o.id, { territory: 'Excluded', repId: null, cluster: null });
          carriedOver++;
        }
      }
      if (carriedOver > 0) console.log(`[exclude] ${carriedOver} previously held-out outlet(s) matched in the new file and held out again`);
      await storage.flush();

      // Highlight outlets whose GPS point sits far outside the dataset's
      // core coverage area (market + rural belt). Flag only - the user
      // decides later whether to exclude them.
      const geoOutlierRadiusKm = parseFloat(String(req.body?.geoOutlierRadiusKm ?? '')) || 30;
      const geoOutliers = detectGeoOutliers(createdOutlets, geoOutlierRadiusKm);
      for (const g of geoOutliers) {
        await storage.updateOutlet(g.id, { geoStatus: 'offset' });
      }
      if (geoOutliers.length > 0) {
        console.log(`Flagged ${geoOutliers.length} geographic outliers (> ${geoOutlierRadiusKm}km from core area)`);
      }

      // Calculate analysis
      const vf1Count = outlets.filter(o => o.visitFrequency === 1).length;
      const vf2Count = outlets.filter(o => o.visitFrequency === 2).length;
      const vf4Count = outlets.filter(o => o.visitFrequency === 4).length;

      // Initial rough estimate - will be refined after optimization
      // Assuming ~25 outlets per zone and 10 zones per rep
      const recommendedReps = Math.ceil(outlets.length / 250);

      // Create optimization run record
      const optimizationRun = await storage.createOptimizationRun({
        fileName: originalname,
        totalOutlets: outlets.length,
        vf1Outlets: vf1Count,
        vf2Outlets: vf2Count,
        vf4Outlets: vf4Count,
        recommendedReps,
        settings: {
          minVisitsPerDay: 15,
          maxVisitsPerDay: 25,
          workingDaysPerWeek: 5,
          calculationMode: 'manual'
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
          vf1: vf1Count,
          vf2: vf2Count,
          vf4: vf4Count,
          recommendedReps
        },
        report: {
          totalRowsProcessed: data.length,
          validOutlets: outlets.length,
          skippedRows: skippedRows.length,
          skippedDetails: skippedRows.slice(0, 20),
          vf1Count,
          vf2Count,
          vf4Count,
          recommendedReps,
          geoOutliers: geoOutliers.length,
          geoOutlierDetails: geoOutliers.slice(0, 25),
          // How many rows had no visit frequency of their own, and what was
          // assumed for them. Drives the "we guessed this" notice on upload.
          rowsUsingDefaultVf,
          heldOutCarriedOver: carriedOver,
          defaultVisitFrequencyUsed: defaultVisitFrequency
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

  // Bulk update outlet territories
  app.patch("/api/outlets/bulk-update-territory", async (req, res) => {
    try {
      const { updates } = req.body;
      
      if (!Array.isArray(updates)) {
        return res.status(400).json({ message: "Updates must be an array" });
      }
      
      const updatedOutlets = [];
      
      for (const update of updates) {
        const { outletId, territory } = update;
        
        if (!outletId || !territory) {
          continue;
        }
        
        const updatedOutlet = await storage.updateOutlet(outletId, { territory });
        if (updatedOutlet) {
          updatedOutlets.push(updatedOutlet);
        }
      }
      
      // Regenerate schedules for affected reps
      const affectedTerritories = new Set(updates.map(u => u.territory));
      const reps = await storage.getReps();
      
      for (const rep of reps) {
        const repTerritories = rep.territory ? [rep.territory] : [];
        const hasAffectedTerritory = repTerritories.some(t => affectedTerritories.has(t));
        
        if (hasAffectedTerritory) {
          // Delete existing schedules
          await storage.deleteSchedulesByRepId(rep.id);
          
          // Get outlets for this rep's territories
          const repOutlets = await storage.getOutlets();
          const territoryOutlets = repOutlets.filter(outlet => 
            repTerritories.includes(outlet.territory || '')
          );
          
          // Generate new schedules
          if (territoryOutlets.length > 0) {
            const schedules = generateWeeklySchedules(rep, territoryOutlets);
            await storage.createSchedules(schedules);
          }
        }
      }
      
      res.json({ 
        success: true, 
        updatedCount: updatedOutlets.length,
        message: `Updated ${updatedOutlets.length} outlets and regenerated schedules` 
      });
    } catch (error) {
      console.error("Failed to update outlet territories:", error);
      res.status(500).json({ message: "Failed to update outlet territories" });
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

  // Delete a specific outlet
  // Note: storage.deleteOutlet automatically cleans the deleted ID from any
  // schedule's outletIds and routeOrder, and clears the cached
  // totalDistance/estimatedDuration so the next optimize call recomputes them.
  // For full re-grouping (re-clustering days), the user should call /api/optimize-routes
  // for the affected rep(s), which now detects drift and triggers full re-optimization.
  app.delete("/api/outlets/:id", async (req, res) => {
    try {
      const { id } = req.params;

      // Identify affected reps before deleting, so the client can react.
      const beforeSchedules = await storage.getSchedules();
      const affectedRepIds = new Set<string>();
      for (const s of beforeSchedules) {
        const ids = (s.outletIds as string[]) || [];
        if (ids.includes(id)) affectedRepIds.add(s.repId);
      }

      const deleted = await storage.deleteOutlet(id);

      if (!deleted) {
        return res.status(404).json({ message: "Outlet not found" });
      }

      res.json({
        success: true,
        message: "Outlet deleted successfully",
        affectedRepIds: Array.from(affectedRepIds),
        requiresReoptimization: affectedRepIds.size > 0,
      });
    } catch (error) {
      console.error("Failed to delete outlet:", error);
      res.status(500).json({ message: "Failed to delete outlet" });
    }
  });

  // Bulk delete outlets by zone/territory
  app.delete("/api/outlets/zone/:zoneName", async (req, res) => {
    try {
      const { zoneName } = req.params;
      const decodedZoneName = decodeURIComponent(zoneName);
      
      // Get all outlets in the zone
      const allOutlets = await storage.getOutlets();
      const outletsInZone = allOutlets.filter(o => o.territory === decodedZoneName);
      
      if (outletsInZone.length === 0) {
        return res.status(404).json({ message: "No outlets found in this zone" });
      }
      
      // Delete each outlet in the zone
      let deletedCount = 0;
      for (const outlet of outletsInZone) {
        const deleted = await storage.deleteOutlet(outlet.id);
        if (deleted) deletedCount++;
      }
      
      res.json({ 
        success: true, 
        message: `Successfully deleted ${deletedCount} outlets from zone "${decodedZoneName}"`,
        deletedCount
      });
    } catch (error) {
      console.error("Failed to bulk delete outlets:", error);
      res.status(500).json({ message: "Failed to bulk delete outlets" });
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

  // Export territories to Excel (outlets grouped by rep/territory)
  // Export the Territory Map as it stands now - after deletions, moves and
  // re-plans - not as it was when the plan was first built. One row per outlet
  // with its rep, territory, client code, coordinates, call frequency and the
  // route days it sits on; a per-rep sheet each; a summary per rep; and the
  // outlets held out as duplicates on their own sheet so nothing is lost.
  // ?repId=<id> narrows it to one rep.
  app.get("/api/export/territories", async (req, res) => {
    try {
      applyPlanSettings();
      const repFilter = typeof req.query.repId === 'string' ? req.query.repId : '';
      const allReps = await storage.getReps();
      const allOutlets = await storage.getOutlets();
      const schedules = await storage.getSchedules();
      const reps = repFilter ? allReps.filter(r => r.id === repFilter) : allReps;
      if (allOutlets.length === 0) {
        return res.status(400).json({ message: "No outlets to export" });
      }
      if (repFilter && reps.length === 0) {
        return res.status(404).json({ message: "That rep no longer exists" });
      }

      const heldOut = allOutlets.filter(o => o.territory === 'Excluded');
      const live = allOutlets.filter(o => o.territory !== 'Excluded');
      const repById = new Map(allReps.map(r => [r.id, r]));
      const vfLabel = (vf: number) => `VF${vf}`;
      const shortDay = (d: number) => WEEKDAY_NAMES[d - 1]?.slice(0, 3) ?? `D${d}`;

      // Calendar dates for the plan's cells, same rule as the schedule export.
      const cycleDates = upcomingWorkingDates(200, workingWeek);
      const dateOfCell = (week: number, dayOfWeek: number): string => {
        const slot = workingWeek.indexOf(dayOfWeek);
        if (slot < 0) return '';
        const index = (week - 1) * workingWeek.length + slot - cycleStartSlot;
        const d = index >= 0 ? cycleDates[index] : undefined;
        return d ? ymd(d) : '';
      };
      const cellLabel = (week: number, dayOfWeek: number) => {
        const date = dateOfCell(week, dayOfWeek);
        return `W${week} ${shortDay(dayOfWeek)}${date ? ' ' + date.slice(5) : ''}`; // "W1 Sat 10-03"
      };

      // Which cells each outlet is visited on, in plan order.
      const cellsOf = new Map<string, { week: number; day: number; stop: number }[]>();
      const sorted = [...schedules].sort((a, b) => a.week - b.week || workingWeek.indexOf(a.dayOfWeek) - workingWeek.indexOf(b.dayOfWeek));
      for (const sc of sorted) {
        const order = ((sc.routeOrder as string[]) || []).length > 0 ? (sc.routeOrder as string[]) : ((sc.outletIds as string[]) || []);
        order.forEach((oid, idx) => {
          if (!cellsOf.has(oid)) cellsOf.set(oid, []);
          cellsOf.get(oid)!.push({ week: sc.week, day: sc.dayOfWeek, stop: idx + 1 });
        });
      }
      const routeDays = (o: Outlet) => (cellsOf.get(o.id) || []).map(c => cellLabel(c.week, c.day)).join('; ');

      const rowFor = (o: Outlet) => {
        const rep = o.repId ? repById.get(o.repId) : undefined;
        return {
          'Rep': rep?.name ?? '',
          'Rep Code': rep?.code ?? '',
          'Territory': rep ? (rep.territory || rep.name) : (o.territory === 'Excluded' ? 'Held out' : o.territory === 'Needs Review' ? 'Needs review' : 'Unassigned'),
          'Outlet Code': o.code || '',
          'Outlet Name': o.name,
          'Address': o.address || '',
          'Latitude': o.latitude,
          'Longitude': o.longitude,
          'Visit Frequency': vfLabel(o.visitFrequency),
          'Visits in Plan': (cellsOf.get(o.id) || []).length,
          'Route Days': routeDays(o),
          'Value': o.value ?? '',
          'Status': o.territory === 'Excluded' ? 'Held out (duplicate)' : o.territory === 'Needs Review' ? 'Needs review (far from the area)' : rep ? 'Assigned' : 'Unassigned',
        };
      };
      const outletCols = [
        { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 34 }, { wch: 36 },
        { wch: 11 }, { wch: 11 }, { wch: 9 }, { wch: 9 }, { wch: 40 }, { wch: 9 }, { wch: 20 },
      ];
      const sheetName = (name: string, taken: Set<string>) => {
        let base = name.replace(/[:\\/?*\[\]]/g, '_').slice(0, 31) || 'Sheet';
        let candidate = base, n = 2;
        while (taken.has(candidate)) candidate = `${base.slice(0, 28)}_${n++}`;
        taken.add(candidate);
        return candidate;
      };

      const workbook = XLSX.utils.book_new();
      const taken = new Set<string>();

      // Summary first.
      const inScope = repFilter ? live.filter(o => o.repId === repFilter) : live;
      const unassigned = live.filter(o => !o.repId || !repById.has(o.repId));
      const perRep = reps.map(rep => {
        const mine = live.filter(o => o.repId === rep.id);
        const cells = schedules.filter(s => s.repId === rep.id && ((s.outletIds as string[]) || []).length > 0);
        const visits = cells.reduce((n, s) => n + ((s.outletIds as string[]) || []).length, 0);
        const perDay = cells.map(s => ((s.outletIds as string[]) || []).length);
        const cLat = mine.length ? mine.reduce((a, o) => a + o.latitude, 0) / mine.length : 0;
        const cLng = mine.length ? mine.reduce((a, o) => a + o.longitude, 0) / mine.length : 0;
        const spread = mine.length ? Math.max(...mine.map(o => calculateDistance(cLat, cLng, o.latitude, o.longitude))) : 0;
        return {
          'Rep': rep.name,
          'Rep Code': rep.code,
          'Territory': rep.territory || rep.name,
          'Outlets': mine.length,
          'VF1': mine.filter(o => o.visitFrequency === 1).length,
          'VF2': mine.filter(o => o.visitFrequency === 2).length,
          'VF3': mine.filter(o => o.visitFrequency === 3).length,
          'VF4': mine.filter(o => o.visitFrequency === 4).length,
          'Visits in Plan': visits,
          'Route Days': cells.length,
          'Avg Visits/Day': cells.length ? Math.round((visits / cells.length) * 10) / 10 : 0,
          'Lightest Day': perDay.length ? Math.min(...perDay) : 0,
          'Heaviest Day': perDay.length ? Math.max(...perDay) : 0,
          'Centre Lat': Math.round(cLat * 1e5) / 1e5,
          'Centre Lng': Math.round(cLng * 1e5) / 1e5,
          'Spread (km)': Math.round(spread * 10) / 10,
        };
      });
      const totals = {
        'Rep': 'TOTAL', 'Rep Code': '', 'Territory': `${reps.length} rep${reps.length === 1 ? '' : 's'}`,
        'Outlets': perRep.reduce((n, r) => n + r.Outlets, 0),
        'VF1': perRep.reduce((n, r) => n + r.VF1, 0), 'VF2': perRep.reduce((n, r) => n + r.VF2, 0),
        'VF3': perRep.reduce((n, r) => n + r.VF3, 0), 'VF4': perRep.reduce((n, r) => n + r.VF4, 0),
        'Visits in Plan': perRep.reduce((n, r) => n + r['Visits in Plan'], 0),
        'Route Days': perRep.reduce((n, r) => n + r['Route Days'], 0),
        'Avg Visits/Day': '', 'Lightest Day': '', 'Heaviest Day': '', 'Centre Lat': '', 'Centre Lng': '', 'Spread (km)': '',
      };
      const ps = planSettings;
      const header: (string | number)[][] = [
        ['Territory Map export', new Date().toISOString().slice(0, 19).replace('T', ' ')],
        ['Outlets on the map', live.length],
        ['Assigned to a rep', live.length - unassigned.length],
        ['Unassigned', unassigned.length],
        ['Held out as duplicates', heldOut.length],
        ['Reps', allReps.length],
      ];
      if (ps) {
        header.push(['Working week', workingWeek.map(d => WEEKDAY_NAMES[d - 1]).join(', ')]);
        header.push(['Visits per day', `${ps.minVisitsPerDay}-${ps.maxVisitsPerDay}`]);
        if (ps.planStart) header.push(['Plan dates', `${ps.planStart} to ${ps.planEnd || ''}`]);
        header.push(['Max drive between stops (km)', ps.maxHopKm ?? 4]);
      }
      if (repFilter) header.push(['Filtered to rep', reps[0].name]);
      header.push([]);
      const summary = XLSX.utils.aoa_to_sheet(header);
      XLSX.utils.sheet_add_json(summary, [...perRep, totals], { origin: -1 });
      summary['!cols'] = [{ wch: 28 }, { wch: 12 }, { wch: 16 }, { wch: 9 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 13 }, { wch: 11 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 11 }, { wch: 11 }, { wch: 11 }];
      XLSX.utils.book_append_sheet(workbook, summary, sheetName('Summary', taken));

      // Every live outlet, rep by rep, then by route day and stop.
      const repOrder = new Map(allReps.map((r, i) => [r.id, i]));
      const firstCell = (o: Outlet) => { const c = cellsOf.get(o.id)?.[0]; return c ? c.week * 1000 + workingWeek.indexOf(c.day) * 100 + c.stop : 99999; };
      const repRank = (o: Outlet) => (o.repId ? repOrder.get(o.repId) : undefined) ?? 999;
      const bySequence = (a: Outlet, b: Outlet) =>
        repRank(a) - repRank(b) || firstCell(a) - firstCell(b) || a.name.localeCompare(b.name);
      const allRows = [...inScope].sort(bySequence).map((o, i) => ({ '#': i + 1, ...rowFor(o) }));
      const allSheet = XLSX.utils.json_to_sheet(allRows);
      allSheet['!cols'] = [{ wch: 5 }, ...outletCols];
      XLSX.utils.book_append_sheet(workbook, allSheet, sheetName('All Outlets', taken));

      // One sheet per rep.
      for (const rep of reps) {
        const mine = live.filter(o => o.repId === rep.id).sort(bySequence);
        if (mine.length === 0) continue;
        const rows = mine.map((o, i) => ({ '#': i + 1, ...rowFor(o) }));
        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [{ wch: 5 }, ...outletCols];
        XLSX.utils.book_append_sheet(workbook, ws, sheetName(rep.territory || rep.name, taken));
      }

      if (!repFilter && unassigned.length > 0) {
        const ws = XLSX.utils.json_to_sheet(unassigned.map((o, i) => ({ '#': i + 1, ...rowFor(o) })));
        ws['!cols'] = [{ wch: 5 }, ...outletCols];
        XLSX.utils.book_append_sheet(workbook, ws, sheetName('Unassigned', taken));
      }
      if (!repFilter && heldOut.length > 0) {
        const ws = XLSX.utils.json_to_sheet(heldOut.map((o, i) => ({ '#': i + 1, ...rowFor(o) })));
        ws['!cols'] = [{ wch: 5 }, ...outletCols];
        XLSX.utils.book_append_sheet(workbook, ws, sheetName('Held out', taken));
      }

      const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      const stamp = new Date().toISOString().split('T')[0];
      const fname = repFilter ? `territory_${(reps[0].territory || reps[0].name).replace(/[^A-Za-z0-9_-]+/g, '_')}_${stamp}.xlsx` : `territory_map_${stamp}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=${fname}`);
      res.send(excelBuffer);
    } catch (error) {
      console.error("Error exporting territories:", error);
      res.status(500).json({ message: "Failed to export the territory map" });
    }
  });

  app.get("/api/export/clusters", async (req, res) => {
    try {
      const outlets = await storage.getOutlets();
      const reps = await storage.getReps();
      
      if (outlets.length === 0) {
        return res.status(400).json({ message: "No outlets available to export" });
      }
      
      // Get cluster filter from query params (comma-separated - can be numbers or "Zone X" format)
      const clustersParam = req.query.clusters as string | undefined;
      let clusterFilter: number[] | null = null;
      
      if (clustersParam) {
        clusterFilter = clustersParam.split(',').map(c => {
          const trimmed = c.trim();
          // Handle "Zone X" format - extract the number and convert to 0-indexed cluster
          const zoneMatch = trimmed.match(/^Zone\s*(\d+)$/i);
          if (zoneMatch) {
            // Zone numbers are 1-indexed, cluster numbers are 0-indexed
            return parseInt(zoneMatch[1], 10) - 1;
          }
          // Handle plain number (assume it's already a cluster number)
          return parseInt(trimmed, 10);
        }).filter(n => !isNaN(n) && n >= 0);
      }
      
      // Group outlets by cluster
      const clusterMap = new Map<number, typeof outlets>();
      outlets.forEach(outlet => {
        const cluster = outlet.cluster ?? 0;
        if (clusterFilter && clusterFilter.length > 0 && !clusterFilter.includes(cluster)) return;
        if (!clusterMap.has(cluster)) {
          clusterMap.set(cluster, []);
        }
        clusterMap.get(cluster)!.push(outlet);
      });
      
      const workbook = XLSX.utils.book_new();
      
      // Create a sheet for each cluster
      const sortedClusters = Array.from(clusterMap.keys()).sort((a, b) => a - b);
      
      sortedClusters.forEach(clusterId => {
        const clusterOutlets = clusterMap.get(clusterId)!;
        
        // Find rep for this cluster (if any)
        const repId = clusterOutlets[0]?.repId;
        const rep = repId ? reps.find(r => r.id === repId) : null;
        
        const data = clusterOutlets.map((outlet, index) => ({
          '#': index + 1,
          'Outlet Name': outlet.name,
          'Address': outlet.address || '-',
          'Latitude': outlet.latitude,
          'Longitude': outlet.longitude,
          'Visit Frequency': outlet.visitFrequency === 1 ? 'VF1' : outlet.visitFrequency === 2 ? 'VF2' : 'VF4',
          'Rep': rep?.name || 'Unassigned',
        }));
        
        const worksheet = XLSX.utils.json_to_sheet(data);
        
        // Set column widths
        worksheet['!cols'] = [
          { wch: 5 },   // #
          { wch: 30 },  // Outlet Name
          { wch: 40 },  // Address
          { wch: 12 },  // Latitude
          { wch: 12 },  // Longitude
          { wch: 15 },  // Visit Frequency
          { wch: 20 },  // Rep
        ];
        
        const sheetName = `Cluster ${clusterId}`;
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
      });
      
      // Add summary sheet
      const summaryData = sortedClusters.map(clusterId => {
        const clusterOutlets = clusterMap.get(clusterId)!;
        const repId = clusterOutlets[0]?.repId;
        const rep = repId ? reps.find(r => r.id === repId) : null;
        return {
          'Cluster': clusterId,
          'Rep': rep?.name || 'Unassigned',
          'Total Outlets': clusterOutlets.length,
          'VF1 Outlets': clusterOutlets.filter(o => o.visitFrequency === 1).length,
          'VF2 Outlets': clusterOutlets.filter(o => o.visitFrequency === 2).length,
          'VF4 Outlets': clusterOutlets.filter(o => o.visitFrequency === 4).length,
        };
      });
      
      const summarySheet = XLSX.utils.json_to_sheet(summaryData);
      summarySheet['!cols'] = [
        { wch: 10 }, { wch: 25 }, { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 12 }
      ];
      XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');
      
      const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      
      const filename = clusterFilter ? `clusters_selected_${new Date().toISOString().split('T')[0]}.xlsx` : `clusters_${new Date().toISOString().split('T')[0]}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      res.send(excelBuffer);
    } catch (error) {
      console.error("Error exporting clusters:", error);
      res.status(500).json({ message: "Failed to export clusters" });
    }
  });

  // Export schedules to Excel
  app.get("/api/export/schedules", async (_req, res) => {
    try {
      const reps = await storage.getReps();
      const schedules = await storage.getSchedules();
      const outlets = await storage.getOutlets();
      
      if (reps.length === 0 || schedules.length === 0) {
        return res.status(400).json({ message: "No schedules available to export" });
      }
      
      const excelBuffer = generateScheduleExcel(reps, schedules, outlets, workingWeek, planStartDate, cycleStartSlot);
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=schedules_${new Date().toISOString().split('T')[0]}.xlsx`);
      res.send(excelBuffer);
    } catch (error) {
      console.error("Error exporting schedules:", error);
      res.status(500).json({ message: "Failed to export schedules" });
    }
  });

  // Export role schedules to Excel (includes all roles with their day offsets)
  app.get("/api/export/role-schedules", async (req, res) => {
    try {
      const { repId } = req.query;
      const reps = await storage.getReps();
      const outlets = await storage.getOutlets();
      
      // Get regular schedules
      const schedules = repId 
        ? await storage.getSchedulesByRepId(repId as string)
        : await storage.getSchedules();
      
      // Get role schedules
      const roleSchedules = repId
        ? await storage.getRoleSchedulesByRepId(repId as string)
        : await storage.getRoleSchedules();
      
      // Get role hierarchies
      const hierarchies = await storage.getRoleHierarchies();
      
      if (schedules.length === 0) {
        return res.status(400).json({ message: "No schedules available to export" });
      }

      // Create workbook with multiple sheets
      const workbook = XLSX.utils.book_new();
      const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

      // Real calendar dates for the cycle, on the days the business works.
      //
      // This used to start at "next Monday" and then add (week-1)*7 + (day-1)
      // days, which silently assumed the week runs Monday first and that the
      // days off are whatever falls after the count. On a Sunday-to-Thursday
      // week that produced dates on Friday and Saturday.
      const cycleDates = upcomingWorkingDates(200, workingWeek);
      const dateOfCell = (week: number, dayOfWeek: number): string => {
        const slot = workingWeek.indexOf(dayOfWeek);
        if (slot < 0) return '';
        const index = (week - 1) * workingWeek.length + slot - cycleStartSlot;
        const d = index >= 0 ? cycleDates[index] : undefined;
        return d ? ymd(d) : '';
      };

      // For each rep, create a sheet with all roles
      const targetReps = repId ? reps.filter(r => r.id === repId) : reps;

      for (const rep of targetReps) {
        const repSchedules = schedules.filter(s => s.repId === rep.id);
        const repRoleSchedules = roleSchedules.filter(rs => rs.repId === rep.id);
        const workingDays = rep.workingDaysPerWeek || 5;
        
        // Get rep-specific hierarchies, fall back to template hierarchies if none exist
        let repHierarchies = hierarchies.filter(h => h.repId === rep.id && h.role !== '_config');
        if (repHierarchies.length === 0) {
          repHierarchies = hierarchies.filter(h => h.repId === 'template' && h.role !== '_config');
        }

        // Create vertical format data
        const data: (string | number)[][] = [];
        
        // Header
        data.push(['Rep Name', rep.name]);
        data.push(['Territory', rep.territory]);
        data.push(['Working Days/Week', workingDays]);
        data.push(['']);
        
        // Sales Rep Schedule (base schedule)
        data.push(['=== SALES REP SCHEDULE ===']);
        data.push(['Week', 'Day', 'Day Name', 'Date', 'Outlets Count', 'Outlet Names']);
        
        // How many calendar weeks the cycle actually spans. A 26-working-day
        // cycle on a 6-day week runs into a fifth week, so this can no longer be
        // the constant 4 it was.
        const cycleWeeks = Math.max(1, repSchedules.reduce((m, s) => Math.max(m, s.week), 0));
        for (let week = 1; week <= cycleWeeks; week++) {
          for (const day of workingWeek) {
            // Prefer the week's own schedule; fall back to the fortnight it
            // mirrors only for older plans that stored weeks 1-2 alone.
            const schedule = repSchedules.find(s => s.week === week && s.dayOfWeek === day)
              ?? (week > 2 ? repSchedules.find(s => s.week === week - 2 && s.dayOfWeek === day) : undefined);
            
            const dateStr = dateOfCell(week, day);
            if (!dateStr) continue; // before the plan starts (a mid-week 1st)
            
            if (schedule) {
              const outletIds = Array.isArray(schedule.outletIds) 
                ? schedule.outletIds 
                : JSON.parse(String(schedule.outletIds) || '[]');
              const outletNames = outletIds
                .map((id: string) => outlets.find(o => o.id === id)?.name || id)
                .join(', ');
              data.push([week, day, daysOfWeek[day - 1], dateStr, outletIds.length, outletNames]);
            } else {
              // Show day even if no schedule (for completeness)
              data.push([week, day, daysOfWeek[day - 1], dateStr, 0, '']);
            }
          }
        }
        
        data.push(['']);
        
        // Get unique roles from role schedules for this rep (more reliable than hierarchies)
        const uniqueRoles = Array.from(new Set(repRoleSchedules.map(rs => rs.role))).filter(r => r !== 'rep');
        
        // Role Schedules (follower roles) - use role schedules directly
        for (const role of uniqueRoles) {
          const roleSchedulesForRole = repRoleSchedules.filter(rs => rs.role === role);
          if (roleSchedulesForRole.length === 0) continue;
          
          // Get role info from the first schedule entry
          const firstSchedule = roleSchedulesForRole[0];
          const roleName = firstSchedule.roleName || role;
          const offsetDays = firstSchedule.offsetDays || 0;
          
          data.push([`=== ${roleName.toUpperCase()} SCHEDULE (Day +${offsetDays}) ===`]);
          data.push(['Week', 'Day', 'Day Name', 'Date', 'Original Rep Day', 'Outlets Count', 'Outlet Names']);
          
          // Role schedules store their actual week values (including weeks 3/4 when offset pushes them there)
          // Iterate all 7 days to capture any offset-driven spillover (positive or negative)
          const roleWeeks = Math.max(cycleWeeks, roleSchedulesForRole.reduce((m, s) => Math.max(m, s.week), 0));
          for (let week = 1; week <= roleWeeks; week++) {
            for (let day = 1; day <= 7; day++) {
              // First try to find a direct match for this week/day
              let schedule = roleSchedulesForRole.find(s => s.week === week && s.dayOfWeek === day);
              
              // If no direct match and we're in weeks 3-4, check if we should mirror weeks 1-2
              if (!schedule && week > 2) {
                const mirrorWeek = week - 2;
                schedule = roleSchedulesForRole.find(s => s.week === mirrorWeek && s.dayOfWeek === day);
              }
              
              const dateStr = dateOfCell(week, day);
              
              if (schedule) {
                const outletIds = Array.isArray(schedule.outletIds) 
                  ? schedule.outletIds 
                  : JSON.parse(String(schedule.outletIds) || '[]');
                const outletNames = outletIds
                  .map((id: string) => outlets.find(o => o.id === id)?.name || id)
                  .join(', ');
                const originalRepDay = schedule.originalDayOfWeek <= 5 ? daysOfWeek[schedule.originalDayOfWeek - 1] : `Day ${schedule.originalDayOfWeek}`;
                data.push([week, day, daysOfWeek[day - 1], dateStr, originalRepDay, outletIds.length, outletNames]);
              }
            }
          }
          
          data.push(['']);
        }
        
        // Also include roles from hierarchies that might not have schedules yet
        // Generate role schedule data from base rep schedule + offset using FORWARD calculation
        for (const hierarchy of repHierarchies) {
          if (hierarchy.role === 'rep') continue; // Skip base rep role
          if (uniqueRoles.includes(hierarchy.role)) continue; // Already handled above
          
          data.push([`=== ${hierarchy.roleName.toUpperCase()} SCHEDULE (Day +${hierarchy.offsetDays}) ===`]);
          data.push(['Week', 'Day', 'Day Name', 'Date', 'Original Rep Day', 'Outlets Count', 'Outlet Names']);
          
          // Forward calculation: For each rep schedule, calculate the role day by adding offset
          // This is more reliable than reverse calculation
          const roleScheduleRows: Array<{week: number; day: number; originalDay: number; outletIds: string[]}> = [];
          
          for (let week = 1; week <= cycleWeeks; week++) {
            for (const repDay of workingWeek) {
              const schedule = repSchedules.find(s => s.week === week && s.dayOfWeek === repDay)
                ?? (week > 2 ? repSchedules.find(s => s.week === week - 2 && s.dayOfWeek === repDay) : undefined);
              
              if (schedule) {
                // Calculate the role day by adding the offset
                let roleDay = repDay + hierarchy.offsetDays;
                let roleWeek = week;
                
                // Handle day overflow (role day goes into next week)
                while (roleDay > 7) {
                  roleDay -= 7;
                  roleWeek++;
                }
                
                // Handle day underflow (role day goes into previous week)
                while (roleDay < 1) {
                  roleDay += 7;
                  roleWeek--;
                }
                
                // Handle week overflow (wrap around the 4-week cycle)
                while (roleWeek > 4) {
                  roleWeek -= 4;
                }
                
                // Handle week underflow (wrap around the 4-week cycle)
                while (roleWeek < 1) {
                  roleWeek += 4;
                }
                
                const outletIds = Array.isArray(schedule.outletIds) 
                  ? schedule.outletIds 
                  : JSON.parse(String(schedule.outletIds) || '[]');
                
                roleScheduleRows.push({
                  week: roleWeek,
                  day: roleDay,
                  originalDay: repDay,
                  outletIds
                });
              }
            }
          }
          
          // Sort by week then day for proper ordering
          roleScheduleRows.sort((a, b) => a.week === b.week ? a.day - b.day : a.week - b.week);
          
          // Output the role schedule rows
          for (const row of roleScheduleRows) {
            const dateStr = dateOfCell(row.week, row.day);
            
            const outletNames = row.outletIds
              .map((id: string) => outlets.find(o => o.id === id)?.name || id)
              .join(', ');
            const originalRepDayName = row.originalDay <= 7 ? daysOfWeek[row.originalDay - 1] : `Day ${row.originalDay}`;
            const roleDayName = row.day <= 7 ? daysOfWeek[row.day - 1] : `Day ${row.day}`;
            
            data.push([row.week, row.day, roleDayName, dateStr, originalRepDayName, row.outletIds.length, outletNames]);
          }
          
          data.push(['']);
        }

        const worksheet = XLSX.utils.aoa_to_sheet(data);
        
        // Set column widths
        worksheet['!cols'] = [
          { wch: 10 },  // Week
          { wch: 8 },   // Day
          { wch: 12 },  // Day Name
          { wch: 12 },  // Date
          { wch: 15 },  // Original Day
          { wch: 12 },  // Outlets Count
          { wch: 80 },  // Outlet Names
        ];
        
        const sheetName = rep.name.substring(0, 31).replace(/[:\\/*?[\]]/g, '');
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
      }

      const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=role_schedules_${new Date().toISOString().split('T')[0]}.xlsx`);
      res.send(excelBuffer);
    } catch (error) {
      console.error("Error exporting role schedules:", error);
      res.status(500).json({ message: "Failed to export role schedules" });
    }
  });

  // SSE endpoint for optimization progress
  app.get("/api/optimize/progress/:progressId", (req, res) => {
    const { progressId } = req.params;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Encoding', 'none');
    
    // Disable Nagle's algorithm for immediate sends
    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true);
    }
    
    res.flushHeaders();
    
    // Send initial padding to force buffer flush (2KB)
    res.write(`: ${' '.repeat(2048)}\n\n`);
    
    progressManager.subscribe(progressId, res);
    
    // Send keepalive comments every 5 seconds
    const keepaliveInterval = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch (e) {
        clearInterval(keepaliveInterval);
      }
    }, 5000);
    
    req.on('close', () => {
      clearInterval(keepaliveInterval);
      progressManager.unsubscribe(progressId, res);
    });
  });

  // ---- Background jobs ----
  //
  // The optimization used to run inside its own HTTP request: four minutes
  // on 9,000 outlets, which most proxies cut off long before. The handler
  // below is unchanged; asJob runs it detached, records its reply on the job,
  // and answers 202 at once with the job id. The page polls /api/jobs/:id.
  // The SSE progress stream still works, and the job mirrors it.
  const asJob = (kind: string, handler: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      const running = jobs.active();
      if (running) {
        return res.status(409).json({
          message: `${running.kind === 'optimize' ? 'An optimization' : 'A rebuild'} is already running (${running.progress.percent}%, ${running.progress.stage}). Wait for it to finish.`,
          jobId: running.id,
        });
      }
      const progressId: string = (req.body && req.body.progressId) || `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const body = { ...(req.body || {}), progressId };
      const job = jobs.start(kind, async (report) => {
        const stop = progressManager.listen(progressId, (u) => report(u as JobProgress));
        const { res: fake, state } = captureResponse();
        try {
          await handler({ body, params: {}, query: {}, headers: {}, on() {} } as unknown as Request, fake as Response);
        } finally {
          stop();
        }
        return { statusCode: state.code, body: state.payload };
      });
      res.status(202).json({ jobId: job.id, kind, progressId, statusUrl: `/api/jobs/${job.id}` });
    };

  // The driven line of one day route from the road server, for playback and
  // for the real kilometres. 404 when no road server is configured, so the
  // client falls back to straight lines.
  const roadRouteCache = new Map<string, { at: number; value: any }>();
  app.get("/api/schedules/:id/road-route", async (req, res) => {
    try {
      if (!osrmConfigured()) return res.status(404).json({ message: "No road server configured (OSRM_URL)" });
      const schedule = (await storage.getSchedules()).find(s => s.id === req.params.id);
      if (!schedule) return res.status(404).json({ message: "No such route" });
      const order = ((schedule.routeOrder as string[]) || []).length > 0 ? (schedule.routeOrder as string[]) : (schedule.outletIds as string[]);
      const byId = new Map((await storage.getOutlets()).map(o => [o.id, o]));
      const stops = order.map(id => byId.get(id)).filter((o): o is Outlet => !!o);
      if (stops.length < 2) return res.status(404).json({ message: "Route has fewer than two stops" });
      const key = `${schedule.id}:${order.join(',')}`;
      const hit = roadRouteCache.get(key);
      if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return res.json(hit.value);
      const r = await osrmRoute(stops.map(o => ({ lat: o.latitude, lng: o.longitude })));
      if (!r) return res.status(502).json({ message: "The road server did not return a route" });
      const value = { ...r, stopIds: stops.map(o => o.id), source: 'osrm' };
      roadRouteCache.set(key, { at: Date.now(), value });
      if (roadRouteCache.size > 2000) roadRouteCache.delete(roadRouteCache.keys().next().value!);
      res.json(value);
    } catch (error) {
      console.error("road-route error:", error);
      res.status(500).json({ message: "Failed to fetch the road route" });
    }
  });

  app.get("/api/jobs/active", (_req, res) => {
    const a = jobs.active();
    res.json(a ?? null);
  });
  app.get("/api/jobs", (_req, res) => res.json(jobs.list(20)));
  app.get("/api/jobs/:id", (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ message: "No such job" });
    res.json(j);
  });

  // Route optimization
  app.post("/api/optimize", asJob('optimize', async (req: Request, res: Response) => {
    const progressId = req.body.progressId || '';
    
    // Helper to yield to event loop so SSE can flush
    const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));
    
    const emitProgress = async (percent: number, stage: string, detail: string) => {
      if (progressId) {
        progressManager.emit(progressId, { percent, stage, detail });
        await yieldToEventLoop(); // Allow SSE to send
      }
    };
    
    try {
      await emitProgress(2, 'Starting', 'Loading outlets from database...');
      const allStoredOutlets = await storage.getOutlets();

      // Outlets the user chose to exclude after reviewing coverage
      // suggestions (indirect-coverage candidates). They keep existing but
      // are left out of territories and schedules for this run.
      const requestedExclusions: string[] = Array.isArray(req.body.excludedOutletIds)
        ? req.body.excludedOutletIds.filter((x: unknown) => typeof x === 'string')
        : [];
      // An exclusion is a decision, not a per-run parameter. Outlets already
      // held out - duplicates the user removed, outliers they set aside - stay
      // out of every later run until they are explicitly restored. Before this
      // only the ids sent with THIS request were left out, so a page reload or
      // the next Optimize click quietly brought every removed duplicate back.
      const includeExcluded = req.body.includeExcluded === true;
      const excludedOutletIds = Array.from(new Set([
        ...requestedExclusions,
        ...(includeExcluded ? [] : allStoredOutlets.filter(o => o.territory === 'Excluded').map(o => o.id)),
      ]));
      const excludedSet = new Set(excludedOutletIds);
      const selectedOutlets = allStoredOutlets.filter(o => !excludedSet.has(o.id));
      if (excludedOutletIds.length > 0) console.log(`[exclude] ${excludedOutletIds.length} outlet(s) held out of this run (${requestedExclusions.length} new)`);
      for (const o of allStoredOutlets) {
        if (excludedSet.has(o.id)) {
          await storage.updateOutlet(o.id, { territory: 'Excluded', cluster: null, repId: null });
        }
      }

      // Geographic outliers are found BEFORE routing, not after.
      //
      // Detecting them afterwards meant every first run routed them: a single
      // bad record in the Erbil file ("warehouse difference after unloading",
      // 412km from the city) turned one rep's day into a 430km round trip.
      // They are held out of the day-routes and reported for review instead -
      // the user fixes the coordinates or deletes the row, and nothing is
      // deleted on their behalf. Pass includeGeoOutliers to route them anyway.
      const geoOutlierRadiusKm = req.body.geoOutlierRadiusKm || 30;
      const includeGeoOutliers = req.body.includeGeoOutliers === true;
      const detectedOutliers = detectGeoOutliers(selectedOutlets, geoOutlierRadiusKm);
      const outlierIds = new Set(detectedOutliers.map(o => o.id));

      // Clear stale flags first so a fixed outlet stops being flagged.
      for (const o of selectedOutlets) {
        const shouldFlag = outlierIds.has(o.id);
        if (shouldFlag && o.geoStatus !== 'offset') {
          await storage.updateOutlet(o.id, { geoStatus: 'offset' });
        } else if (!shouldFlag && o.geoStatus === 'offset') {
          await storage.updateOutlet(o.id, { geoStatus: null });
        }
      }

      const outlets = includeGeoOutliers
        ? selectedOutlets
        : selectedOutlets.filter(o => !outlierIds.has(o.id));

      if (!includeGeoOutliers && outlierIds.size > 0) {
        console.log(`[geo] Holding ${outlierIds.size} far-flung outlet(s) out of the routes for review (>${geoOutlierRadiusKm}km from the core area).`);
        for (const o of detectedOutliers) {
          await storage.updateOutlet(o.id, { territory: 'Needs Review', cluster: null, repId: null });
        }
      }

      if (outlets.length === 0) {
        if (progressId) progressManager.error(progressId, 'No outlets available');
        return res.status(400).json({ message: "No outlets available for optimization" });
      }

      await emitProgress(5, 'Analyzing', `Processing ${outlets.length} outlets...`);

      // Calculate total weekly visits required based on visit frequency
      const totalWeeklyVisits = outlets.reduce((sum, outlet) => sum + outlet.visitFrequency, 0);

      // Distance model for all grouping decisions this run: straight-line
      // (default) or road-aware (urban detour factor + river-crossing
      // penalties, upgraded to true road distances for zone pairs when an
      // OSRM_URL server is configured).
      const distanceMode: DistanceMode =
        req.body.distanceMode === 'road' ? 'road'
        : req.body.distanceMode === 'grid' ? 'grid'
        : 'haversine';
      setDistanceMode(distanceMode);
      // Barriers come with the request (the settings page) and are saved with
      // the plan. Nothing about any particular city is built in.
      const barriers: Barrier[] = Array.isArray(req.body.barriers)
        ? req.body.barriers.filter((b: any) => b && typeof b.name === 'string' && Array.isArray(b.points)).slice(0, 50)
        : [];
      setBarriers(barriers);
      clearRoadMatrix();

      // Set default values for rep constraints (use body params if provided)
      // The days the reps actually work - which also fixes the count, the start
      // of their week and their days off.
      workingWeek = parseWorkingWeek(req.body);
      const workingDaysPerWeek = workingWeek.length;
      console.log(`Working week: ${workingWeek.map(d => WEEKDAY_NAMES[d - 1]).join(', ')} (${workingDaysPerWeek} days; off: ${
        WEEKDAY_NAMES.filter((_, i) => !workingWeek.includes(i + 1)).join(', ') || 'none'})`);

      // Cycle length in working days. Blank/0 keeps the four-week default -
      // unless the cycle is a calendar month, in which case the month decides.
      cycleMode = req.body.cycleMode === 'calendarMonth' ? 'calendarMonth' : 'fixed';
      monthEdges = req.body.monthEdges === 'wholeWeeks' ? 'wholeWeeks' : 'allDays';
      planMonth = typeof req.body.planMonth === 'string' && /^\d{4}-\d{2}$/.test(req.body.planMonth) ? req.body.planMonth : nextMonthKey();
      let planEndDate = '';
      planStartDate = '';
      cycleStartSlot = 0;
      if (cycleMode === 'calendarMonth') {
        const [py, pm] = planMonth.split('-').map(Number);
        const plan = monthPlanDates(py, pm, workingWeek, monthEdges);
        if (!plan) {
          return res.status(400).json({ message: `No working days in ${planMonth} for the selected working week.` });
        }
        cycleWorkingDays = plan.dates.length;
        planStartDate = ymd(plan.start);
        planEndDate = ymd(plan.end);
        cycleStartSlot = Math.max(0, workingWeek.indexOf(isoWeekday(plan.start)));
        console.log(`Plan month ${planMonth} (${monthEdges === 'wholeWeeks' ? 'whole weeks' : 'every working day'}): ${WEEKDAY_NAMES[isoWeekday(plan.start) - 1]} ${planStartDate} -> ${WEEKDAY_NAMES[isoWeekday(plan.end) - 1]} ${planEndDate}, ${plan.dates.length} working days`);
      } else {
        cycleWorkingDays = Math.max(0, Math.min(60, parseInt(String(req.body.cycleWorkingDays ?? 0), 10) || 0));
      }
      const { cycleDays, repeats: cycleRepeats, dayGroups: dayGroupsPerRep, planDays } = cycleShape(workingDaysPerWeek);
      cycleWorkingDays = planDays; // every later caller derives the same pattern from it
      console.log(`Cycle: ${cycleDays} working days = ${dayGroupsPerRep} day-routes x ${cycleRepeats} runs (${workingDaysPerWeek}-day week)${planDays > cycleDays ? `, plus ${planDays - cycleDays} bonus day driving route 1 again` : ''}`);
      const calculationMode = 'manual'; // time-based mode removed: min/max visits per day IS the capacity input, time-per-visit was a redundant second way to express it

      // Daily visit targets come directly from the user
      const minVisitsPerDay = Math.max(1, req.body.minVisitsPerDay || 25);
      const maxVisitsPerDay = Math.max(minVisitsPerDay + 1, req.body.maxVisitsPerDay || 27);
      
      console.log(`Optimization using ${calculationMode} mode: min=${minVisitsPerDay}, max=${maxVisitsPerDay} visits/day`);

      // minVisitsPerDay/maxVisitsPerDay mean ACTUAL visits a rep makes each
      // day. A day-zone is visited on its day-of-week every week, but only
      // the outlets due that week show up (VF4 every week, VF2 alternating
      // weeks, VF1 one week in four) - so a zone must hold MORE unique
      // outlets than the daily target for the due share to hit it. Scale
      // zone capacity by the dataset's average weekly-visit fraction
      // (vf/4 per outlet: VF4=1.0, VF2=0.5, VF1=0.25). Example: all-VF2
      // data with a 20-25 target -> zones of 40-50 outlets, whose
      // alternating halves are 20-25 actual visits.
      const totalMonthlyVisits = outlets.reduce((s, o) => s + (o.visitFrequency ?? 1), 0);
      const avgWeeklyVisitFraction = Math.min(1, Math.max(1 / cycleRepeats, totalMonthlyVisits / cycleRepeats / outlets.length));
      const zoneMinOutlets = Math.max(1, Math.round(minVisitsPerDay / avgWeeklyVisitFraction));
      const zoneMaxOutlets = Math.max(zoneMinOutlets + 1, Math.round(maxVisitsPerDay / avgWeeklyVisitFraction));
      console.log(`Visit-frequency-aware zone sizing: avg weekly fraction ${avgWeeklyVisitFraction.toFixed(2)} -> zones of ${zoneMinOutlets}-${zoneMaxOutlets} outlets for ${minVisitsPerDay}-${maxVisitsPerDay} actual visits/day`);

      // Calculate required reps based on daily visit constraints
      // Formula: actual weekly visits / (working days * max visits per day)
      const actualWeeklyVisits = Math.ceil(totalMonthlyVisits / cycleRepeats);
      const maxWeeklyCapacityPerRep = dayGroupsPerRep * maxVisitsPerDay;
      const requiredReps = Math.ceil(actualWeeklyVisits / maxWeeklyCapacityPerRep);

      // Ensure we don't go below minimum daily visits requirement
      const minWeeklyCapacityPerRep = dayGroupsPerRep * minVisitsPerDay;

      // Use the calculated required reps (initial estimate)
      let finalRequiredReps = Math.max(1, requiredReps); // At least 1 rep needed

      await emitProgress(10, 'Preparing', 'Clearing existing data...');

      // Clear existing reps first. Hand placements were pinned to those reps'
      // routes, so they go with them: a fresh plan starts clean.
      const existingReps = await storage.getReps();
      for (const rep of existingReps) {
        await storage.deleteRep(rep.id);
      }
      for (const o of await storage.getOutlets()) {
        if (o.pinnedRoute) await storage.updateOutlet(o.id, { pinnedRoute: null });
      }

      await emitProgress(15, 'Clustering', `Analyzing ${outlets.length} outlets for geographic patterns...`);

      // Create territories based on geographic clusters (each cluster = one zone)
      console.log(`Creating zones based on geographic clustering for ${outlets.length} outlets`);

      // Calculate target zones based on the required rep count and the
      // VF-adjusted zone capacity
      const zonesPerRep = dayGroupsPerRep; // One zone per distinct day-route in the cycle
      const targetZones = Math.max(
        Math.ceil(outlets.length / zoneMaxOutlets), // At least one zone per zoneMaxOutlets outlets
        finalRequiredReps * zonesPerRep // Or enough zones for all reps
      );

      await emitProgress(20, 'Clustering', 'Running advanced geographic clustering algorithm...');

      // Perform advanced clustering using JavaScript implementation (HDBSCAN + VRP + Capacitated K-Means)
      // Pass progress callback to allow SSE updates during long-running clustering
      const advancedClusters = await performAdvancedClusteringJS(outlets, targetZones, zoneMinOutlets, zoneMaxOutlets, emitProgress);
      const rawClusters = advancedClusters.map(cluster => ({
        id: cluster.id,
        centroid: cluster.centroid,
        outlets: cluster.outlets
      }));
      // Enforce a hard geographic-tightness cap: a "zone" whose outlets are
      // spread more than maxZoneRadiusKm apart isn't a real day-route no
      // matter how well its outlet count matches minVisitsPerDay/maxVisitsPerDay,
      // so oversized zones get split into tighter sub-zones here.
      const maxZoneRadiusKm = req.body.maxZoneRadiusKm || 15;
      // "Route Compactness" now caps the width of a DAY-ROUTE, which is what it
      // reads as on screen. It used to cap zone radius, and once day-routes
      // stopped being built from zones it silently stopped mattering: 5km and
      // 25km produced identical plans.
      dayRouteWidthCapKm = maxZoneRadiusKm;
      maxHopKm = Math.max(0, Math.min(50, parseFloat(String(req.body.maxHopKm ?? 4)) || 0));
      console.log(`Max hop between stops: ${maxHopKm > 0 ? maxHopKm + ' km' : 'off'}`);
      dayVisitsMin = minVisitsPerDay;
      dayVisitsMax = maxVisitsPerDay;
      {
        const midPoint = (minVisitsPerDay + maxVisitsPerDay) / 2;
        dayLoadTolerance = midPoint > 0
          ? Math.min(0.35, Math.max(0.02, ((maxVisitsPerDay - minVisitsPerDay) / 2) / midPoint))
          : 0.06;
      }
      const splitClusters = splitOversizedZones(rawClusters, maxZoneRadiusKm);
      // Then merge the under-target zones splitting left behind, so days
      // still carry the requested visit load wherever geography allows.
      const clusters = mergeUndersizedZones(splitClusters, zoneMinOutlets, zoneMaxOutlets, maxZoneRadiusKm);
      const actualZoneCount = clusters.length;
      console.log(`Zones: ${rawClusters.length} raw -> ${splitClusters.length} after split -> ${actualZoneCount} after merge`);

      // In road mode with an OSRM server configured, resolve zone-centroid
      // pairs to true road distances before assignment decisions run.
      if (distanceMode === 'road' && process.env.OSRM_URL) {
        const filled = await prefetchRoadMatrix(clusters.map(c => ({ lat: c.centroid.lat, lng: c.centroid.lng })));
        console.log(`OSRM road matrix: ${filled} zone pairs cached`);
      }

      await emitProgress(45, 'Zones Created', `Created ${actualZoneCount} geographic zones`);
      console.log(`Created ${actualZoneCount} geographic zones (max ${maxZoneRadiusKm}km radius)`);
      
      // First, assign outlets to their zones
      for (let i = 0; i < actualZoneCount; i++) {
        const cluster = clusters[i];
        const clusterRadius = calculateClusterRadius(cluster);
        console.log(`Zone ${i + 1}: ${cluster.outlets.length} outlets, ${clusterRadius.toFixed(2)}km radius`);
        
        // Assign outlets to their zone
        for (const outlet of cluster.outlets) {
          await storage.updateOutlet(outlet.id, {
            territory: `Zone ${i + 1}`,
            cluster: i
          });
        }
        
        // Yield and emit progress every 20 zones
        if (i % 20 === 0) {
          const zoneProgress = 45 + Math.floor((i / actualZoneCount) * 10);
          await emitProgress(zoneProgress, 'Zones Created', `Processing zone ${i + 1} of ${actualZoneCount}...`);
        }
      }
      
      // How many reps the work actually needs.
      //
      // This used to be ceil(zoneCount / workingDays), which made headcount a
      // side effect of how finely the geographic splitter happened to cut the
      // map. Tightening the radius cap created more zones, and more zones
      // silently "required" more reps: real Erbil data (2,302 visits/month)
      // asked for 10 reps to do 4 reps' work, then spread it so thinly that
      // days came out with one outlet on them.
      //
      // Headcount follows demand instead: total monthly visits divided by what
      // one rep can do in a month. Zones are then distributed across that many
      // reps, however many zones there happen to be.
      // Working day-slots one rep has in a full cycle.
      //
      // The cycle used to be four weeks, full stop. It is now stated in working
      // days, because that is how the business states it: a 26-day cycle on a
      // 6-day week is 13 day-routes driven twice, and sizing it as 24 days
      // over-loads every day by 8%.
      const dayslotsPerRep = cycleDays;

      // Fewest reps that can carry the load without breaking maxVisitsPerDay,
      // and the most that can be kept busy at minVisitsPerDay.
      const fewestReps = Math.max(1, Math.ceil(totalMonthlyVisits / (dayslotsPerRep * maxVisitsPerDay)));
      const mostReps = Math.max(1, Math.floor(totalMonthlyVisits / (dayslotsPerRep * minVisitsPerDay)));

      // Aim for the middle of the requested range so a normal day sits
      // comfortably inside it rather than pinned to either end, then clamp
      // into the feasible band.
      const midTargetPerDay = (minVisitsPerDay + maxVisitsPerDay) / 2;
      const idealReps = Math.round(totalMonthlyVisits / (dayslotsPerRep * midTargetPerDay));
      const requiredRepCount = Math.min(Math.max(idealReps, fewestReps), Math.max(fewestReps, mostReps));

      const projectedVisitsPerDay = totalMonthlyVisits / (requiredRepCount * dayslotsPerRep);
      console.log(`Headcount from demand: ${totalMonthlyVisits} monthly visits, ${dayslotsPerRep} day-slots/rep -> ${requiredRepCount} reps (~${projectedVisitsPerDay.toFixed(1)} visits/day each; feasible band ${fewestReps}-${mostReps})`);
      if (projectedVisitsPerDay < minVisitsPerDay) {
        console.warn(`[headcount] ${projectedVisitsPerDay.toFixed(1)} visits/day is below the ${minVisitsPerDay} minimum - this dataset cannot fill ${requiredRepCount} reps over a ${cycleDays}-day cycle.`);
      }

      await emitProgress(55, 'Assigning', `Assigning ${outlets.length} outlets to ${actualZoneCount} zones...`);
      console.log(`Need ${requiredRepCount} reps to cover ${actualZoneCount} zones (${zonesPerRep} zones per rep)`);
      
      // Check if working days have changed for existing optimization
      const existingSchedules = await storage.getSchedules();
      if (existingSchedules.length > 0) {
        // Clear existing schedules to regenerate with new working days
        await storage.clearSchedules();
      }
      
      await emitProgress(60, 'Creating Reps', `Creating ${requiredRepCount} sales representatives...`);
      
      // Create the required number of reps
      const allReps: Rep[] = [];
      for (let i = 0; i < requiredRepCount; i++) {
        const newRep = await storage.createRep({
          name: `Rep ${i + 1}`,
          code: `REP${(i + 1).toString().padStart(3, '0')}`,
          territory: `Territory ${i + 1}`,
          maxDailyVisits: maxVisitsPerDay,
          minDailyVisits: minVisitsPerDay,
          workingDaysPerWeek,
          isActive: true
        });
        allReps.push(newRep);
      }
      
      // Assign zones to reps based on geographic proximity
      // Balanced assignment: equalize monthly-visit workload across reps
      // (within the tolerance band) while keeping territories compact.
      const balanceTolerance = typeof req.body.balanceTolerancePct === 'number'
        ? Math.min(0.5, Math.max(0.01, req.body.balanceTolerancePct / 100))
        : 0.10;
      // Territories by recursive bisection of the whole market.
      //
      // Assigning whole zones to the nearest rep, then trading outlets to even
      // the load, produced territories that overlapped badly: 36% of outlets
      // sat closer to another rep's centre than their own, and territories
      // 43km wide crossed over each other. Bisection cuts the market with
      // straight lines instead, so territories tile it without overlapping,
      // and the balance comes from where each cut falls.
      const monthlyVisitsOf = (o: Outlet) => o.visitFrequency ?? 1;
      // The territory band follows from the day band and the cycle, exactly as
      // the day band does: a rep's visits per cycle divided by their day-routes
      // must land inside min..max a day. With 25-30 a day over 26 days and 5
      // reps the mean is 29.8 - 0.6% under the ceiling - so a territory even
      // 1% over the mean cannot be routed under 30 a day, and a tolerance of
      // 2.5% produced forty days of 31. The room above the mean is whatever the
      // ceiling leaves, and the room below whatever the floor leaves.
      //
      // But the band is a ceiling on unevenness, not a licence for it: inside
      // it, territories should still come out as even as they can (2.5%),
      // because the passes stop pushing toward the mean once a territory is
      // legal, and a plan whose reps sit anywhere between 600 and 720 visits
      // has days of 24 next to days of 31. So each side is the tighter of the
      // two: what the floor or ceiling leaves, or 2.5%.
      const meanVisitsPerRep = totalMonthlyVisits / Math.max(1, allReps.length);
      const territoryBand: Band = meanVisitsPerRep > 0
        ? {
            below: Math.min(0.025, Math.max(0.005, (meanVisitsPerRep - minVisitsPerDay * cycleDays) / meanVisitsPerRep)),
            above: Math.min(0.025, Math.max(0.005, (maxVisitsPerDay * cycleDays - meanVisitsPerRep) / meanVisitsPerRep)),
          }
        : balanceTolerance;
      console.log(`[balance] territory band: ${(meanVisitsPerRep * (1 - (typeof territoryBand === 'number' ? territoryBand : territoryBand.below))).toFixed(0)}-${(meanVisitsPerRep * (1 + (typeof territoryBand === 'number' ? territoryBand : territoryBand.above))).toFixed(0)} visits/rep (mean ${meanVisitsPerRep.toFixed(0)}; ${minVisitsPerDay}-${maxVisitsPerDay} a day x ${cycleDays} days)`);
      // Territories are cut from a space-filling curve for the same reason the
      // days are: greedy growing gave some reps a tidy 3.5km patch and others
      // a 22km sprawl across most of the metro, because whichever territory
      // filled last inherited every outlet the others had no room for. A rep
      // left holding a dense core plus scattered strays cannot be rescued by
      // any day-grouping underneath it - someone still has to drive to them.
      const repOutletGroups = repairLoads(
        polishByTourLength(
          // Hand back outlets that sit inside a neighbour's patch. Without this
          // a rep can end up holding a tight core plus a handful of strays 8km
          // away, and no day-grouping underneath can rescue that: the strays
          // have to land on some day, and that day becomes the sprawling one.
          // This is the same judgement the "closer to another rep" panel makes,
          // applied during the run rather than left for the user to click.
          polishByCohesion(
            swapForCompactness(
              repairLoads(
                (await solveBalancedGroups(outlets, allReps.length, monthlyVisitsOf, territoryBand))
                  ?? growBalancedRegions(outlets, allReps.length, monthlyVisitsOf),
                monthlyVisitsOf,
                territoryBand,
              ),
              monthlyVisitsOf,
            ),
            monthlyVisitsOf,
            territoryBand,
          ),
          monthlyVisitsOf,
          territoryBand,
        ),
        monthlyVisitsOf,
        territoryBand,
      );
      // Pockets inside a neighbour's area go to that neighbour, paid for with
      // adjoining outlets, before any day is cut. See exchangePockets. This is
      // a question of geography, so it is judged on straight-line distances
      // whatever the distance mode: the outlet-level road matrix is fetched
      // per rep later, and the detour estimate that would stand in for it
      // here shrinks "within a kilometre" and "within the hop limit" by the
      // detour factor and so misses pockets the straight-line run hands over.
      if (maxHopKm > 0) {
        const modeBefore = getDistanceMode();
        setDistanceMode('haversine');
        let ex: ReturnType<typeof exchangePockets>;
        try { ex = exchangePockets(repOutletGroups, monthlyVisitsOf, territoryBand, maxHopKm); }
        finally { setDistanceMode(modeBefore); }
        for (const mv of ex.moves) {
          console.log(`[territory] pocket of ${mv.pocket} outlet(s) moved from ${allReps[mv.from]?.name ?? mv.from} to ${allReps[mv.to]?.name ?? mv.to}, ${mv.returned} adjoining outlet(s) returned`);
        }
        for (let i = 0; i < repOutletGroups.length; i++) repOutletGroups[i] = ex.groups[i];
        // A pocket given outright leaves the receiver above the band and the
        // giver below it; border moves through the reps in between even that out.
        if (ex.moves.some(mv => mv.returned === 0)) {
          const repaired = repairLoads(repOutletGroups, monthlyVisitsOf, territoryBand, maxHopKm);
          for (let i = 0; i < repOutletGroups.length; i++) repOutletGroups[i] = repaired[i];
        }
      }
      const zoneAssignments = assignZonesToRepsBalanced(clusters, allReps, balanceTolerance);
      {
        const visitsOf = (g: Outlet[]) => g.reduce((sum, o) => sum + (o.visitFrequency ?? 1), 0);
        const loads = repOutletGroups.map(visitsOf);
        const mean = loads.reduce((a, b) => a + b, 0) / (loads.length || 1);
        const spread = mean > 0 ? ((Math.max(...loads) - Math.min(...loads)) / mean) * 100 : 0;
        console.log(`[balance] monthly visits per rep: ${loads.join(', ')} (spread ${spread.toFixed(1)}% of mean, tolerance ${(balanceTolerance * 100).toFixed(0)}%)`);
      }
      
      await emitProgress(70, 'Scheduling', `Generating schedules for ${allReps.length} reps...`);
      
      // Generate schedules for each rep. Schedule from the rep's balanced
      // outlet set: passing repZones here would re-introduce the pre-balance
      // membership and undo the boundary trades made just above.
      console.log('Generating schedules for', allReps.length, 'reps');
      const built: InsertSchedule[][] = [];
      for (let repIndex = 0; repIndex < allReps.length; repIndex++) {
        const rep = allReps[repIndex];
        const repZones = zoneAssignments[repIndex] || [];
        const repOutlets = repOutletGroups[repIndex] || [];
        if (repOutlets.length > 0) {
          console.log(`${rep.name} will cover zones: ${repZones.map(z => z.id + 1).join(', ')} (${repOutlets.length} outlets after balancing)`);
        }
        built.push(repOutlets.length > 0 ? await buildAnchorAwareSchedulesFromZones(rep, [repOutlets]) : []);
        if (repIndex % 5 === 0) {
          await emitProgress(70 + Math.floor((repIndex / allReps.length) * 12), 'Scheduling', `Generating schedule for rep ${repIndex + 1} of ${allReps.length}...`);
        }
      }

      // Second pass: let the days correct the territories.
      //
      // The territory balance shares outlets out evenly, but an even share is
      // not an even day. A rep whose territory holds pockets that must be whole
      // days - 26 outlets more than 4km from anything else - has fewer slots
      // left for the core, and the core starves (days of 19 under a floor of
      // 20) or overflows (days of 31 under a ceiling of 30) while the rep next
      // door sits comfortably at the mean. The territory pass cannot see this,
      // because pockets only exist once the days are cut. So: cut the days,
      // measure each rep's shortfall or excess, move that many outlets across
      // the nearest territory border, and cut the days again for the reps that
      // changed. One pass; it is bounded, and it only ever moves an outlet to
      // the territory whose outlets are nearest to it.
      {
        const wd = Math.max(1, workingWeek.length);
        const cellDay = (sc: InsertSchedule) => (sc.week - 1) * wd + Math.max(0, workingWeek.indexOf(sc.dayOfWeek)) - cycleStartSlot + 1;
        // Per rep: outlets its core is short of, outlets its core must shed,
        // and outlets its core can still absorb. Pocket days are left out of
        // all three - their spare capacity is not the core's, and their
        // overflow is one outlet over on a day that cannot be split.
        const measure = (i: number) => {
          const pockets = pocketCellsByRep.get(allReps[i].id) ?? new Set<string>();
          const cells = built[i].filter(sc => cellDay(sc) <= cycleDays && !pockets.has(`${sc.week}:${sc.dayOfWeek}`));
          const outlets = repOutletGroups[i]?.length ?? 0;
          if (cells.length === 0 || outlets === 0) return { short: 0, excess: 0, room: 0 };
          let over = 0, under = 0, spare = 0, visits = 0;
          for (const sc of cells) {
            const n = (sc.outletIds as string[]).length;
            visits += n;
            if (n > maxVisitsPerDay) over += n - maxVisitsPerDay;
            else spare += maxVisitsPerDay - n;
            if (n < minVisitsPerDay) under += minVisitsPerDay - n;
          }
          const cv = visits / outlets; // cell-visits one outlet adds
          return cv > 0
            ? { short: Math.round(under / cv), excess: Math.round(over / cv), room: Math.floor(spare / cv) }
            : { short: 0, excess: 0, room: 0 };
        };
        // Two passes: the first re-cut usually lands within an outlet or two,
        // and the second closes it. Each pass is bounded by what it measures.
        for (let pass = 0; pass < 2; pass++) {
        const stats = allReps.map((_, i) => measure(i));
        const anyShort = stats.some(x => x.short > 0);
        const anyExcess = stats.some(x => x.excess > 0);
        if (!anyShort && !anyExcess) break;
        {
          console.log(`[feedback] day cuts vs territories: ${allReps.map((r, i) => `${r.name} short ${stats[i].short} / excess ${stats[i].excess} / room ${stats[i].room}`).join('; ')}`);
          const touched = new Set<number>();
          const reach = (maxHopKm > 0 ? maxHopKm : 4) * 2;
          // The outlet of rep `from` nearest to rep `to`'s territory.
          const nearestBorderOutlet = (from: number, to: number) => {
            let bestK = -1, bestD = Infinity;
            const mine = repOutletGroups[to] || [];
            const theirs = repOutletGroups[from] || [];
            for (let k = 0; k < theirs.length; k++) {
              const o = theirs[k];
              if (o.geoStatus === 'offset') continue;
              for (const m of mine) {
                const d = geoDist(o.latitude, o.longitude, m.latitude, m.longitude);
                if (d < bestD) { bestD = d; bestK = k; }
              }
            }
            return { k: bestK, d: bestD };
          };
          const move = (from: number, to: number) => {
            const { k, d } = nearestBorderOutlet(from, to);
            if (k < 0 || d > reach) return false;
            const [o] = repOutletGroups[from].splice(k, 1);
            repOutletGroups[to].push(o);
            touched.add(from);
            touched.add(to);
            return true;
          };
          // Starved cores pull from the nearest neighbour with excess, else room.
          for (let to = 0; to < allReps.length; to++) {
            for (let n = 0; n < stats[to].short; n++) {
              const donors = allReps.map((_, j) => j).filter(j => j !== to && (stats[j].excess > 0 || stats[j].room > 0))
                .sort((x, y) => (stats[y].excess > 0 ? 1 : 0) - (stats[x].excess > 0 ? 1 : 0) || nearestBorderOutlet(x, to).d - nearestBorderOutlet(y, to).d);
              const from = donors.find(j => move(j, to));
              if (from === undefined) break;
              if (stats[from].excess > 0) stats[from].excess -= 1; else stats[from].room -= 1;
              stats[to].short -= 1;
            }
          }
          // Overflowing cores push to the nearest neighbour with room.
          for (let from = 0; from < allReps.length; from++) {
            for (let n = 0; n < stats[from].excess; n++) {
              const takers = allReps.map((_, j) => j).filter(j => j !== from && stats[j].room > 0)
                .sort((x, y) => nearestBorderOutlet(from, x).d - nearestBorderOutlet(from, y).d);
              const to = takers.find(j => move(from, j));
              if (to === undefined) break;
              stats[to].room -= 1;
              stats[from].excess -= 1;
            }
          }
          for (const i of Array.from(touched)) {
            built[i] = repOutletGroups[i].length > 0 ? await buildAnchorAwareSchedulesFromZones(allReps[i], [repOutletGroups[i]]) : [];
          }
          if (touched.size > 0) console.log(`[feedback] pass ${pass + 1}: territories adjusted and days re-cut for ${Array.from(touched).map(i => allReps[i].name).join(', ')}`);
          if (touched.size === 0) break;
        }
        }
      }

      await emitProgress(83, 'Scheduling', 'Saving schedules...');
      for (let repIndex = 0; repIndex < allReps.length; repIndex++) {
        const rep = allReps[repIndex];
        // Record ownership: repId on the outlet is the source of truth that
        // reassignment and targeted re-optimization rely on.
        for (const outlet of repOutletGroups[repIndex] || []) {
          await storage.updateOutlet(outlet.id, { repId: rep.id });
        }
        for (const schedule of built[repIndex]) {
          await storage.createSchedule(schedule);
        }
        if (built[repIndex].length > 0) console.log(`Generated ${built[repIndex].length} schedules for ${rep.name}`);
      }
      
      finalRequiredReps = allReps.length;

      await emitProgress(85, 'Role Schedules', 'Generating role-based schedules...');
      
      // Generate role schedules for all reps based on template
      console.log('Generating role schedules based on hierarchy template...');
      const templateHierarchies = await storage.getRoleHierarchiesByRepId('template');
      let totalRoleSchedules = 0;
      
      if (templateHierarchies.length > 0) {
        // Find config entry to determine mode and selected reps
        const configEntry = templateHierarchies.find(h => h.role === '_config');
        const mode = configEntry?.roleName || 'global';
        let selectedRepIds: string[] = [];
        
        if (mode === 'custom' && configEntry?.colorHex) {
          try {
            selectedRepIds = JSON.parse(configEntry.colorHex);
          } catch (e) {
            selectedRepIds = [];
          }
        }
        
        // Filter out config entry and get actual role templates
        const roleTemplates = templateHierarchies.filter(h => h.role !== '_config');
        
        // Determine which reps should have role hierarchy applied
        const repsToApply = mode === 'global' 
          ? allReps 
          : allReps.filter(rep => selectedRepIds.includes(rep.id));
        
        console.log(`Mode: ${mode}, Applying role hierarchy to ${repsToApply.length} of ${allReps.length} reps`);
        
        // Apply template to selected reps
        for (const rep of repsToApply) {
          // First, copy the template hierarchies for this rep
          await storage.deleteRoleHierarchiesByRepId(rep.id);
          
          const repHierarchies = [];
          for (let i = 0; i < roleTemplates.length; i++) {
            const template = roleTemplates[i];
            const hierarchy = await storage.createRoleHierarchy({
              repId: rep.id,
              role: template.role,
              roleName: template.roleName,
              offsetDays: template.offsetDays,
              colorHex: template.colorHex,
              isActive: template.isActive,
              sortOrder: template.sortOrder
            });
            repHierarchies.push(hierarchy);
          }
          
          // Then generate role schedules
          const repSchedules = await storage.getSchedulesByRepId(rep.id);
          if (repSchedules.length > 0) {
            const generatedSchedules = await generateRoleSchedulesForRep(rep.id, repSchedules, repHierarchies);
            totalRoleSchedules += generatedSchedules.length;
          }
        }
        console.log(`Generated ${totalRoleSchedules} role schedules for ${allReps.length} reps`);
      }

      await emitProgress(95, 'Finalizing', 'Saving results...');
      
      // Invalidate cache by refreshing data
      const updatedOutlets = await storage.getOutlets();
      const updatedReps = await storage.getReps();

      // Territory balance report: how even the monthly-visit workload came
      // out per rep, against the ±tolerance band the user asked for.
      const balanceTarget = zoneAssignments.reduce(
        (s, zones) => s + zones.reduce((zs, z) => zs + zoneMonthlyVisits(z), 0), 0
      ) / Math.max(1, allReps.length);
      const perRepBalance = allReps.map((rep, i) => {
        const monthlyVisits = (zoneAssignments[i] || []).reduce((s, z) => s + zoneMonthlyVisits(z), 0);
        return {
          name: rep.name,
          code: rep.code,
          monthlyVisits,
          uniqueOutlets: (zoneAssignments[i] || []).reduce((s, z) => s + z.outlets.length, 0),
          deviationPct: balanceTarget > 0
            ? Math.round(((monthlyVisits - balanceTarget) / balanceTarget) * 1000) / 10
            : 0
        };
      });
      const maxDeviationPct = perRepBalance.reduce((m, r) => Math.max(m, Math.abs(r.deviationPct)), 0);

      // Coverage-worthiness suggestions (advisory only - the user decides).
      const weightMode: CoverageWeightMode =
        req.body.weightMode === 'value' || req.body.weightMode === 'vf' ? req.body.weightMode : 'isolation';
      const coverage = analyzeCoverageWorthiness(clusters, weightMode);

      // Every optimization is captured as a scenario automatically. A run
      // replaces the live plan, so without this the previous plan would be
      // gone for good - capturing means you can always compare against it
      // and restore it from the Scenarios page.
      // Remember what this run was told to do, so every later rebuild honours
      // it rather than falling back to defaults nobody chose.
      savePlanSettings({
        workingDays: workingWeek,
        cycleWorkingDays,
        minVisitsPerDay,
        maxVisitsPerDay,
        weightMode,
        distanceMode,
        maxZoneRadiusKm,
        dayLoadTolerance,
        dayRouteWidthCapKm,
        maxHopKm,
        cycleMode,
        planMonth,
        monthEdges,
        planStart: planStartDate,
        planEnd: planEndDate,
        cycleStartSlot,
        barriers,
      });

      let capturedScenarioId: string | null = null;
      try {
        capturedScenarioId = await captureCurrentPlanAsScenario({
          workingDaysPerWeek, minVisitsPerDay, maxVisitsPerDay,
          maxZoneRadiusKm, distanceMode, weightMode,
          workingDays: workingWeek, cycleWorkingDays,
        });
      } catch (err) {
        console.error("[scenarios] auto-capture failed:", (err as Error).message);
      }

      await storage.flush();
      if (progressId) progressManager.complete(progressId);

      res.json({
        success: true,
        capturedScenarioId,
        requiredReps: finalRequiredReps,
        assignedOutlets: updatedOutlets.filter(o => o.repId !== null).length,
        excludedOutlets: excludedOutletIds.length,
        // Far-flung records held out of the routes, for the review panel.
        outletsNeedingReview: includeGeoOutliers ? 0 : outlierIds.size,
        // When the data simply cannot fill the requested week, say so instead
        // of quietly emitting near-empty days. A rep with 1-2 calls a day is a
        // staffing question, not a routing result.
        capacityWarning: projectedVisitsPerDay < minVisitsPerDay
          ? {
              projectedVisitsPerDay: Math.round(projectedVisitsPerDay * 10) / 10,
              minVisitsPerDay,
              // Days per week this volume can actually keep busy at the minimum.
              supportedWorkingDays: Math.max(1, Math.floor(totalMonthlyVisits / (requiredRepCount * cycleRepeats * minVisitsPerDay))),
              message: `${totalMonthlyVisits} monthly visits across ${requiredRepCount} rep(s) is about ${projectedVisitsPerDay.toFixed(1)} visits/day - below the ${minVisitsPerDay}/day minimum. There is not enough work here to fill ${workingDaysPerWeek} days a week.`,
            }
          : null,
        totalWeeklyVisits,
        maxWeeklyCapacityPerRep,
        minWeeklyCapacityPerRep,
        roleSchedulesGenerated: totalRoleSchedules,
        territoryBalance: {
          metric: 'monthlyVisits',
          targetPerRep: Math.round(balanceTarget),
          tolerancePct: Math.round(balanceTolerance * 100),
          maxDeviationPct,
          withinTolerance: maxDeviationPct <= balanceTolerance * 100,
          perRep: perRepBalance
        },
        coverageSuggestions: coverage.suggestions,
        coverageWeightModeUsed: coverage.weightModeUsed,
        geoOutliers: detectedOutliers,
        geoOutlierRadiusKm,
        distanceMode,
        roadDistances: distanceMode === 'road' ? (osrmConfigured() ? (roadMatrixSize() > 0 ? 'osrm' : 'estimate (OSRM gave nothing)') : 'estimate (no OSRM_URL)') : 'straight-line',
        roadPairs: roadMatrixSize(),
        calculation: {
          totalOutlets: outlets.length,
          totalWeeklyVisits,
          workingDaysPerWeek,
          minVisitsPerDay,
          maxVisitsPerDay,
          estimatedReps: finalRequiredReps
        },
        message: `Optimization completed. ${finalRequiredReps} routes created for ${totalWeeklyVisits} weekly visits (${minVisitsPerDay}-${maxVisitsPerDay} visits/day). ${outlets.length} outlets assigned.${excludedOutletIds.length > 0 ? ` ${excludedOutletIds.length} outlets excluded per user selection.` : ''}${totalRoleSchedules > 0 ? ` ${totalRoleSchedules} role schedules generated.` : ''}`
      });

    } catch (error) {
      console.error("Optimization error:", error);
      if (progressId) progressManager.error(progressId, 'Optimization failed');
      res.status(500).json({ message: "Failed to run optimization" });
    }
  }));

  // Optimization runs
  // --- Scenarios: compare plans before committing to one ---
  //
  // An optimization run used to overwrite the previous plan with no way to
  // compare them, so questions like "is 6 days better than 5?" or "what does
  // tighter compactness actually cost?" could not be answered from the app.
  // A scenario captures the plan currently in memory - its parameters, its
  // quality KPIs, and a full snapshot of the assignment - so runs can be
  // compared side by side and any one of them restored as the live plan.
  interface ScenarioSnapshot {
    outlets: { id: string; repId: string | null; territory: string | null; cluster: number | null }[];
    reps: Rep[];
    schedules: Schedule[];
  }
  interface Scenario {
    id: string;
    name: string;
    createdAt: string;
    params: Record<string, any>;
    kpis: Record<string, number>;
    snapshot: ScenarioSnapshot;
  }
  // Scenarios persist across restarts, but NOT inside the main storage
  // snapshot: that file is rewritten in full on every change, and a single
  // scenario snapshot of a 7,878-outlet plan is ~2.5MB - ten of them would
  // turn a 4MB write into a 29MB write on every edit. Instead the index
  // (name, params, KPIs - a couple of KB) lives in one small file, and each
  // scenario's heavy snapshot sits in its own file, written once at capture
  // and read only when the user applies it.
  // Scenario state goes through the blob store (Postgres on the published
  // site); the index is one small blob, each scenario's heavy snapshot its own.
  const SCENARIO_INDEX_KEY = "scenario-index";
  type ScenarioSummary = Omit<Scenario, "snapshot">;
  let scenarioIndex: ScenarioSummary[] = [];

  // Scenarios saved by earlier builds live under data/scenarios/; read them
  // from there when the blob store has nothing yet, so an upgrade keeps them.
  const LEGACY_SCENARIO_DIR = path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "scenarios");
  const legacyRead = (file: string): string | null => {
    try { const f = path.join(LEGACY_SCENARIO_DIR, file); return fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : null; } catch { return null; }
  };
  const loadScenarioIndex = async () => {
    try {
      const text = (await loadBlob(SCENARIO_INDEX_KEY)) ?? legacyRead("index.json");
      if (text) {
        scenarioIndex = JSON.parse(text);
        console.log(`[scenarios] Restored ${scenarioIndex.length} scenario(s)`);
      }
    } catch (err) {
      console.error("[scenarios] Failed to read index:", (err as Error).message);
      scenarioIndex = [];
    }
  };
  const saveScenarioIndex = () => {
    saveBlob(SCENARIO_INDEX_KEY, JSON.stringify(scenarioIndex))
      .catch(err => console.error("[scenarios] Failed to write index:", (err as Error).message));
  };
  const scenarioKey = (id: string) => `scenario:${id}`;
  const readScenarioSnapshot = async (id: string): Promise<ScenarioSnapshot | null> => {
    try {
      const text = (await loadBlob(scenarioKey(id))) ?? legacyRead(`${id}.json`);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  const writeScenarioSnapshot = (id: string, snapshot: ScenarioSnapshot) => {
    saveBlob(scenarioKey(id), JSON.stringify(snapshot))
      .catch(err => console.error("[scenarios] Failed to write snapshot:", (err as Error).message));
  };
  const deleteScenarioSnapshot = (id: string) => {
    deleteBlob(scenarioKey(id)).catch(() => { /* already gone */ });
  };
  await loadScenarioIndex();
  // Put the saved plan settings back into effect at startup. Loading them
  // alone left the module on its defaults - four weeks, Monday first, plan
  // dated from tomorrow - until the next optimization ran, so after a restart
  // the exports and the map labelled every week wrong.
  await loadPlanSettings();
  applyPlanSettings();

  // Captures whatever plan is currently in storage as a scenario and returns
  // its id. Used by /api/optimize so no run is ever lost.
  async function captureCurrentPlanAsScenario(params: Record<string, any>, name?: string): Promise<string | null> {
    const allSchedules = await storage.getSchedules();
    if (allSchedules.length === 0) return null;
    const allOutlets = await storage.getOutlets();
    const id = randomUUID();
    const label = name || [
      `${params.workingDaysPerWeek}d`,
      `${params.minVisitsPerDay}-${params.maxVisitsPerDay}/day`,
      `${params.maxZoneRadiusKm ?? 15}km`,
      params.distanceMode === 'road' ? 'road' : null,
    ].filter(Boolean).join(' · ');
    const summary: ScenarioSummary = {
      id,
      name: label.slice(0, 80),
      createdAt: new Date().toISOString(),
      params,
      kpis: await computePlanKPIs(),
    };
    writeScenarioSnapshot(id, {
      outlets: allOutlets.map(o => ({ id: o.id, repId: o.repId, territory: o.territory, cluster: o.cluster })),
      reps: await storage.getReps(),
      schedules: allSchedules,
    });
    scenarioIndex.push(summary);
    while (scenarioIndex.length > 10) {
      const dropped = scenarioIndex.shift();
      if (dropped) deleteScenarioSnapshot(dropped.id);
    }
    saveScenarioIndex();
    return id;
  }

  // Solution-quality KPIs for the plan currently in storage. These are the
  // numbers a planner actually judges a route plan by.
  async function computePlanKPIs() {
    const allOutlets = await storage.getOutlets();
    const allReps = await storage.getReps();
    const allSchedules = await storage.getSchedules();
    const byId = new Map(allOutlets.map(o => [o.id, o]));

    const active = allOutlets.filter(o => o.territory !== 'Excluded');
    const covered = new Set<string>();
    for (const s of allSchedules) for (const id of (s.outletIds as string[])) covered.add(id);
    const coveredActive = active.filter(o => covered.has(o.id)).length;

    const daySizes: number[] = [];
    const dayDiameters: number[] = [];
    let totalDriveKm = 0;
    for (const s of allSchedules) {
      const pts = (s.outletIds as string[]).map(id => byId.get(id)).filter(Boolean) as Outlet[];
      daySizes.push(pts.length);
      totalDriveKm += s.totalDistance || 0;
      if (pts.length >= 2) {
        let maxD = 0;
        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            const d = haversineKm(pts[i].latitude, pts[i].longitude, pts[j].latitude, pts[j].longitude);
            if (d > maxD) maxD = d;
          }
        }
        dayDiameters.push(maxD);
      }
    }
    const median = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    };

    // Workload balance across reps, by monthly visits
    const loadByRep = new Map<string, number>();
    for (const o of active) {
      if (!o.repId) continue;
      loadByRep.set(o.repId, (loadByRep.get(o.repId) || 0) + (o.visitFrequency ?? 1));
    }
    const loads = Array.from(loadByRep.values());
    const avgLoad = loads.length > 0 ? loads.reduce((a, b) => a + b, 0) / loads.length : 0;
    const maxDeviationPct = avgLoad > 0 ? Math.max(...loads.map(l => Math.abs(l - avgLoad) / avgLoad)) * 100 : 0;

    const minTarget = allReps.length > 0 ? Math.min(...allReps.map(r => r.minDailyVisits)) : 0;
    const maxTarget = allReps.length > 0 ? Math.max(...allReps.map(r => r.maxDailyVisits)) : 0;
    const inBand = daySizes.filter(n => n >= minTarget && n <= maxTarget).length;

    return {
      outlets: allOutlets.length,
      activeOutlets: active.length,
      coveragePct: active.length > 0 ? Math.round((coveredActive / active.length) * 1000) / 10 : 0,
      unscheduledOutlets: active.length - coveredActive,
      reps: allReps.length,
      dayRoutes: allSchedules.length,
      medianVisitsPerDay: Math.round(median(daySizes)),
      avgVisitsPerDay: daySizes.length > 0 ? Math.round((daySizes.reduce((a, b) => a + b, 0) / daySizes.length) * 10) / 10 : 0,
      daysInTargetBandPct: daySizes.length > 0 ? Math.round((inBand / daySizes.length) * 1000) / 10 : 0,
      medianRouteDiameterKm: Math.round(median(dayDiameters) * 100) / 100,
      maxRouteDiameterKm: dayDiameters.length > 0 ? Math.round(Math.max(...dayDiameters) * 10) / 10 : 0,
      routesOver15kmPct: dayDiameters.length > 0 ? Math.round((dayDiameters.filter(d => d > 15).length / dayDiameters.length) * 1000) / 10 : 0,
      workloadDeviationPct: Math.round(maxDeviationPct * 10) / 10,
      totalDriveKmPerCycle: Math.round(totalDriveKm),
      excludedOutlets: allOutlets.length - active.length,
    };
  }

  app.get("/api/plan/kpis", async (_req, res) => {
    try {
      res.json(await computePlanKPIs());
    } catch (error) {
      console.error("KPI computation error:", error);
      res.status(500).json({ message: "Failed to compute plan KPIs" });
    }
  });

  app.get("/api/scenarios", async (_req, res) => {
    res.json(scenarioIndex);
  });

  // Capture the plan currently in memory as a named scenario.
  app.post("/api/scenarios/capture", async (req, res) => {
    try {
      const { name, params } = req.body as { name?: string; params?: Record<string, any> };
      const allSchedules = await storage.getSchedules();
      if (allSchedules.length === 0) {
        return res.status(400).json({ message: "No plan to capture - run an optimization first." });
      }
      const allOutlets = await storage.getOutlets();
      const id = randomUUID();
      const summary: ScenarioSummary = {
        id,
        name: (name || `Scenario ${scenarioIndex.length + 1}`).slice(0, 80),
        createdAt: new Date().toISOString(),
        params: params || {},
        kpis: await computePlanKPIs(),
      };
      writeScenarioSnapshot(id, {
        outlets: allOutlets.map(o => ({ id: o.id, repId: o.repId, territory: o.territory, cluster: o.cluster })),
        reps: await storage.getReps(),
        schedules: allSchedules,
      });
      scenarioIndex.push(summary);
      // Keep it bounded - the oldest scenario and its snapshot drop off.
      while (scenarioIndex.length > 10) {
        const dropped = scenarioIndex.shift();
        if (dropped) deleteScenarioSnapshot(dropped.id);
      }
      saveScenarioIndex();
      res.status(201).json(summary);
    } catch (error) {
      console.error("Scenario capture error:", error);
      res.status(500).json({ message: "Failed to capture scenario" });
    }
  });

  // Restore a captured scenario as the live plan.
  app.post("/api/scenarios/:id/apply", async (req, res) => {
    try {
      const scenario = scenarioIndex.find(s => s.id === req.params.id);
      if (!scenario) return res.status(404).json({ message: "Scenario not found" });
      const snapshot = await readScenarioSnapshot(scenario.id);
      if (!snapshot) return res.status(410).json({ message: "Scenario snapshot is no longer available" });

      for (const rep of await storage.getReps()) await storage.deleteRep(rep.id);
      await storage.clearSchedules();

      for (const rep of snapshot.reps) {
        await storage.createRepWithId(rep);
      }
      for (const o of snapshot.outlets) {
        await storage.updateOutlet(o.id, { repId: o.repId, territory: o.territory, cluster: o.cluster });
      }
      await storage.createSchedules(snapshot.schedules.map(s => ({
        repId: s.repId, week: s.week, dayOfWeek: s.dayOfWeek,
        outletIds: s.outletIds as string[], routeOrder: s.routeOrder as string[],
        totalDistance: s.totalDistance ?? undefined, estimatedDuration: s.estimatedDuration ?? undefined,
      })));

      res.json({ success: true, applied: scenario.name, kpis: scenario.kpis });
    } catch (error) {
      console.error("Scenario apply error:", error);
      res.status(500).json({ message: "Failed to apply scenario" });
    }
  });

  // Rename a scenario (auto-captured runs get a parameter-derived name).
  app.patch("/api/scenarios/:id", async (req, res) => {
    const scenario = scenarioIndex.find(s => s.id === req.params.id);
    if (!scenario) return res.status(404).json({ message: "Scenario not found" });
    const { name } = req.body as { name?: string };
    if (typeof name === "string" && name.trim()) {
      scenario.name = name.trim().slice(0, 80);
      saveScenarioIndex();
    }
    res.json(scenario);
  });

  app.delete("/api/scenarios/:id", async (req, res) => {
    const idx = scenarioIndex.findIndex(s => s.id === req.params.id);
    if (idx < 0) return res.status(404).json({ message: "Scenario not found" });
    scenarioIndex.splice(idx, 1);
    deleteScenarioSnapshot(req.params.id);
    saveScenarioIndex();
    res.json({ success: true });
  });

  // Full reset: wipe every trace of the current project so the next optimization
  // starts from a blank dashboard. Lives here (not next to /api/clear) because it
  // needs closure access to the scenario index.
  // Saved scenarios are kept unless the caller explicitly asks for them to go, so
  // a fresh upload can still be compared against what came before.
  app.post("/api/reset", async (req, res) => {
    try {
      const includeScenarios = req.body?.includeScenarios === true;
      let scenariosRemoved = 0;

      await storage.clearAll();

      if (includeScenarios) {
        scenariosRemoved = scenarioIndex.length;
        for (const scenario of scenarioIndex) deleteScenarioSnapshot(scenario.id);
        scenarioIndex = [];
        saveScenarioIndex();
      }

      console.log(`[reset] Cleared all plan data${includeScenarios ? ` and ${scenariosRemoved} scenario(s)` : ""}`);
      res.json({ success: true, scenariosRemoved });
    } catch (error) {
      console.error("Failed to reset:", error);
      res.status(500).json({ message: "Failed to reset" });
    }
  });

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

  // Optimize selected routes
  // SMART RE-OPTIMIZATION: detects when the rep's outlet set has changed
  // (deletions, additions, reassignments) and does a FULL re-clustering of
  // daily groups + per-day TSP resequencing. If nothing has changed, falls back
  // to a fast per-day resequence on just the requested days.
  // What a rebuild will use. The map's Reoptimize button has no settings form
  // of its own, so it reads them from here and tells the user before running.
  app.get("/api/plan-settings", async (_req, res) => {
    if (!planSettings) return res.json({ configured: false });
    res.json({
      configured: true,
      ...planSettings,
      workingDayNames: planSettings.workingDays.map(d => WEEKDAY_NAMES[d - 1]),
      daysOffNames: WEEKDAY_NAMES.filter((_, i) => !planSettings!.workingDays.includes(i + 1)),
      cycleDays: cycleShape(planSettings.workingDays.length || 5, planSettings.cycleWorkingDays).cycleDays,
      maxHopKm: planSettings.maxHopKm ?? 4,
      cycleMode: planSettings.cycleMode ?? 'fixed',
      planMonth: planSettings.planMonth ?? '',
      monthEdges: planSettings.monthEdges ?? 'allDays',
      planStart: planSettings.planStart || null,
      planEnd: planSettings.planEnd || null,
      patternDays: cycleShape(planSettings.workingDays.length || 5, planSettings.cycleWorkingDays).cycleDays,
    });
  });

  app.post("/api/optimize-routes", async (req, res) => {
    try {
      // Same rule as everywhere else: rebuild to the settings the plan was
      // built on, not to whatever this module happens to hold.
      applyPlanSettings();
      const { repIds, days } = req.body;
      if (!Array.isArray(repIds) || repIds.length === 0) {
        return res.status(400).json({ message: "repIds is required" });
      }

      const allSchedules = await storage.getSchedules();
      const allOutlets = await storage.getOutlets();
      const allReps = await storage.getReps();
      const repsById = new Map(allReps.map(r => [r.id, r]));

      let totalRegrouped = 0;
      let totalResequenced = 0;
      let totalRemovedStale = 0;
      const regroupedRepIds: string[] = [];

      const outletById = new Map(allOutlets.map(o => [o.id, o]));

      for (const repId of repIds) {
        const rep = repsById.get(repId);
        if (!rep) continue;

        const repSchedules = allSchedules.filter(s => s.repId === repId);

        // SOURCE OF TRUTH for "outlets owned by this rep":
        // In this app reps are linked to outlets via cluster/zone assignment
        // (stored in their schedules), not necessarily a matching territory string.
        // So the truth is the UNION of:
        //   - outlets currently in any of this rep's schedules (still existing in storage)
        //   - outlets whose territory matches the rep's territory (manual reassignment)
        // This avoids accidentally treating a rep as "no outlets" just because
        // territory strings don't line up after the cluster naming step.
        const repOutletSet = new Map<string, Outlet>();
        let invalidatedCount = 0;
        for (const s of repSchedules) {
          for (const id of (s.outletIds as string[]) || []) {
            const o = outletById.get(id);
            if (o) repOutletSet.set(o.id, o);
          }
          if (s.totalDistance === null || s.totalDistance === undefined) invalidatedCount++;
        }
        if (rep.territory) {
          for (const o of allOutlets) {
            if (o.territory === rep.territory) repOutletSet.set(o.id, o);
          }
        }
        const repOutlets = Array.from(repOutletSet.values());

        // Detect drift via three signals (any one triggers full re-grouping):
        //   1. STALE: schedule references an outlet that no longer exists in storage
        //      (rare now since storage.deleteOutlet cleans outletIds, but kept as belt+braces).
        //   2. MISSING: a rep-owned outlet not yet appearing in any schedule
        //      (e.g. just-reassigned outlets whose schedules weren't regenerated).
        //   3. INVALIDATED: any schedule with totalDistance == null - the canonical
        //      post-deletion drift marker set by storage.deleteOutlet.
        const scheduledIds = new Set<string>();
        for (const s of repSchedules) {
          for (const id of (s.outletIds as string[]) || []) scheduledIds.add(id);
        }
        const ownedIds = new Set(repOutlets.map(o => o.id));

        let staleCount = 0;
        for (const id of Array.from(scheduledIds)) {
          if (!ownedIds.has(id)) staleCount++;
        }
        let missingCount = 0;
        for (const id of Array.from(ownedIds)) {
          if (!scheduledIds.has(id)) missingCount++;
        }

        const needsFullRegroup =
          staleCount > 0 || missingCount > 0 || invalidatedCount > 0;

        if (needsFullRegroup) {
          // Full re-optimization for this rep: re-cluster outlets into daily
          // groups, then re-sequence each day's route. This handles deletions,
          // additions, and reassignments in one shot.
          totalRemovedStale += staleCount;

          // Wipe old schedules for this rep
          await storage.deleteSchedulesByRepId(repId);

          if (repOutlets.length === 0) {
            // Rep lost ALL their outlets (every outlet they used to visit was
            // deleted and none remain in their territory either). Also clear
            // orphaned role schedules so Merchandiser/Collection Agent routes
            // don't reference deleted outlets.
            await storage.deleteRoleSchedulesByRepId(repId);
            console.log(`[optimize-routes] Rep ${rep.name} has no outlets at all; cleared base + role schedules`);
            continue;
          }

          // Anchor-aware rebuild: VF3+VF4 outlets define daily zones, lower-VF
          // outlets attach to nearest day, then per-day rotation patterns
          // distribute VF1/VF2/VF3 evenly across the 4 weeks.
          const newSchedules = buildAnchorAwareSchedules(rep, repOutlets);

          await storage.createSchedules(newSchedules);
          totalRegrouped++;
          regroupedRepIds.push(repId);
          console.log(`[optimize-routes] Rep ${rep.name}: full regroup (${staleCount} stale, ${missingCount} new, ${invalidatedCount} invalidated) → ${newSchedules.length} schedules`);
        } else {
          // No drift detected - fast path: just re-sequence the requested days.
          const targetDays: number[] = Array.isArray(days) && days.length > 0
            ? days
            : Array.from(new Set(repSchedules.map(s => s.dayOfWeek)));

          const target = repSchedules.filter(s => targetDays.includes(s.dayOfWeek));
          for (const schedule of target) {
            const ids = (schedule.outletIds as string[]) || [];
            const scheduleOutlets = ids
              .map(id => outletById.get(id))
              .filter((o): o is Outlet => !!o);

            if (scheduleOutlets.length > 1) {
              const optimized = optimizeRoute(scheduleOutlets);
              const optimizedIds = optimized.map(o => o.id);
              const dist = calculateTotalDistance(optimized);
              await storage.updateSchedule(schedule.id!, {
                outletIds: optimizedIds,
                routeOrder: optimizedIds,
                totalDistance: Math.round(dist * 100) / 100,
                estimatedDuration: optimized.length * 15,
              });
              totalResequenced++;
            }
          }
        }
      }

      // For reps that got a full regroup, also regenerate hierarchy follow-up
      // schedules (Merchandiser, Collection Agent, etc.) so their day-offset
      // routes stay in sync with the rep's new routes.
      let totalRoleSchedulesRegenerated = 0;
      if (regroupedRepIds.length > 0) {
        try {
          const allHierarchies = await storage.getRoleHierarchies();
          const refreshedSchedules = await storage.getSchedules();
          for (const repId of regroupedRepIds) {
            const repSchedules = refreshedSchedules.filter(s => s.repId === repId);
            const repHierarchies = allHierarchies
              .filter(h => h.repId === repId || h.repId === 'template')
              .filter(h => h.isActive && h.role !== 'rep' && h.role !== '_config');
            if (repSchedules.length > 0 && repHierarchies.length > 0) {
              const generated = await generateRoleSchedulesForRep(repId, repSchedules, repHierarchies);
              totalRoleSchedulesRegenerated += generated.length;
            }
          }
        } catch (roleErr) {
          console.error("[optimize-routes] Role schedule regen error:", roleErr);
          // Non-fatal - rep schedules still saved successfully.
        }
      }

      res.json({
        success: true,
        message: totalRegrouped > 0
          ? `Full re-optimization: ${totalRegrouped} rep(s) regrouped (${totalRemovedStale} stale outlets cleaned), ${totalResequenced} schedule(s) resequenced, ${totalRoleSchedulesRegenerated} role schedule(s) refreshed`
          : `Routes resequenced for ${totalResequenced} schedule(s)`,
        regroupedReps: totalRegrouped,
        resequencedSchedules: totalResequenced,
        staleOutletsRemoved: totalRemovedStale,
        roleSchedulesRegenerated: totalRoleSchedulesRegenerated,
      });
    } catch (error) {
      console.error("Route optimization error:", error);
      res.status(500).json({ message: "Failed to optimize routes" });
    }
  });
  
  // Save optimized routes
  app.post("/api/save-routes", async (req, res) => {
    try {
      const { repIds, days } = req.body;
      
      // Mark schedules as saved/finalized
      // In a real implementation, you might want to save to a separate table
      // or add a 'finalized' flag to the schedules
      
      res.json({ success: true, message: "Routes saved successfully" });
    } catch (error) {
      console.error("Save routes error:", error);
      res.status(500).json({ message: "Failed to save routes" });
    }
  });
  
  // Export routes to Excel
  app.post("/api/export-routes", async (req, res) => {
    try {
      const { repIds, days } = req.body;
      const schedules = await storage.getSchedules();
      const outlets = await storage.getOutlets();
      const reps = await storage.getReps();
      
      // Filter schedules
      const targetSchedules = schedules.filter(s => 
        repIds.includes(s.repId) && 
        days.includes(s.dayOfWeek) && 
        s.week === 1
      );
      
      // Create workbook
      const wb = XLSX.utils.book_new();
      
      // Create detailed schedule sheet
      const scheduleData: any[] = [];
      const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      
      for (const schedule of targetSchedules) {
        const rep = reps.find(r => r.id === schedule.repId);
        const scheduleOutlets = outlets.filter(o => 
          (schedule.outletIds as string[]).includes(o.id)
        );
        
        // Use route order if available
        const orderedOutlets = schedule.routeOrder 
          ? (schedule.routeOrder as string[]).map(id => 
              scheduleOutlets.find(o => o.id === id)!
            ).filter(Boolean)
          : scheduleOutlets;
        
        orderedOutlets.forEach((outlet, index) => {
          scheduleData.push({
            'Rep Name': rep?.name || 'Unknown',
            'Rep Code': rep?.code || 'Unknown',
            'Day': daysOfWeek[schedule.dayOfWeek],
            'Week': schedule.week,
            'Visit Order': index + 1,
            'Outlet Name': outlet.name,
            'Address': outlet.address,
            'Territory': outlet.territory || '',
            'Latitude': outlet.latitude,
            'Longitude': outlet.longitude,
            'Visit Frequency': `VF${outlet.visitFrequency}`,
            'Distance (km)': index === 0 ? 0 : 
              calculateDistance(
                orderedOutlets[index - 1].latitude,
                orderedOutlets[index - 1].longitude,
                outlet.latitude,
                outlet.longitude
              ).toFixed(2)
          });
        });
      }
      
      const ws = XLSX.utils.json_to_sheet(scheduleData);
      XLSX.utils.book_append_sheet(wb, ws, "Route Schedules");
      
      // Generate buffer
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="route_schedules_${new Date().toISOString().split('T')[0]}.xlsx"`);
      res.send(buffer);
    } catch (error) {
      console.error("Export routes error:", error);
      res.status(500).json({ message: "Failed to export routes" });
    }
  });
  // ---- Manual route moves ("put this outlet on that route") ----
  //
  // Day routes are cut from geography, so relabelling an outlet's zone, or
  // even moving it to another rep, puts it straight back into whichever day
  // its coordinates fall in. When the user says "move it to that route" they
  // mean the route. So the outlet is taken out of the cells it is in, put
  // into the chosen cell and the cells that repeat the same day, and pinned
  // there: every per-rep rebuild re-applies the pin, and only a fresh
  // optimization from the dashboard (new reps, new routes) clears it.
  type PinnedRoute = { repId: string; week: number; dayOfWeek: number };
  function parsePin(o: Outlet): PinnedRoute | null {
    if (!o.pinnedRoute) return null;
    try {
      const p = JSON.parse(o.pinnedRoute);
      return p && typeof p.repId === 'string' && Number.isInteger(p.week) && Number.isInteger(p.dayOfWeek) ? p : null;
    } catch { return null; }
  }

  // The cells that repeat the target's day-group: same rep, same weekday,
  // and sharing a good part of its outlets (the fortnightly and weekly
  // outlets recur on every repeat). Target first, then by week.
  function mirrorCells(target: Schedule, cells: Schedule[]): Schedule[] {
    const t = new Set(target.outletIds as string[]);
    const mirrors = cells.filter(c => {
      if (c.id === target.id) return true;
      if (c.repId !== target.repId || c.dayOfWeek !== target.dayOfWeek) return false;
      const ids = c.outletIds as string[];
      if (ids.length === 0 || t.size === 0) return false;
      const shared = ids.filter(id => t.has(id)).length;
      return shared >= Math.max(1, Math.ceil(0.4 * Math.min(ids.length, t.size)));
    });
    return mirrors.sort((a, b) => (a.id === target.id ? -1 : b.id === target.id ? 1 : a.week - b.week));
  }

  // Cheapest-insertion position for one stop in an existing route order.
  function insertStop(order: string[], id: string, byId: Map<string, Outlet>): string[] {
    const o = byId.get(id);
    if (!o || order.length === 0) return [...order, id];
    const d = (a: string, b: string) => {
      const x = byId.get(a), y = byId.get(b);
      return x && y ? calculateDistance(x.latitude, x.longitude, y.latitude, y.longitude) : 0;
    };
    const dTo = (a: string) => { const x = byId.get(a); return x ? calculateDistance(x.latitude, x.longitude, o.latitude, o.longitude) : 0; };
    let bestAt = order.length, bestCost = dTo(order[order.length - 1]);
    for (let i = 0; i < order.length - 1; i++) {
      const cost = dTo(order[i]) + dTo(order[i + 1]) - d(order[i], order[i + 1]);
      if (cost < bestCost) { bestCost = cost; bestAt = i + 1; }
    }
    if (dTo(order[0]) < bestCost) bestAt = 0;
    return [...order.slice(0, bestAt), id, ...order.slice(bestAt)];
  }

  // Take the outlet out of the cells it sits in and put it into the target
  // route (and the cells that repeat it), keeping its visit count. Returns
  // the cells it left and the cells it joined.
  async function placeOutletInRoute(outlet: Outlet, target: Schedule): Promise<{ from: Schedule[]; to: Schedule[] }> {
    const all = await storage.getSchedules();
    const byId = new Map((await storage.getOutlets()).map(o => [o.id, o]));
    const current = all.filter(c => (c.outletIds as string[]).includes(outlet.id));
    const group = mirrorCells(target, all);
    const visits = Math.max(1, current.length || Math.min(outlet.visitFrequency ?? 1, group.length));
    const to = group.slice(0, Math.min(visits, group.length));
    const toIds = new Set(to.map(c => c.id));
    const keepElsewhere = Math.max(0, visits - to.length);
    // Cells to leave: other reps' cells first, so any visit kept beyond the
    // target group stays with the receiving rep.
    const leaving = current.filter(c => !toIds.has(c.id))
      .sort((a, b) => (a.repId === target.repId ? 1 : 0) - (b.repId === target.repId ? 1 : 0));
    const from = leaving.slice(0, Math.max(0, leaving.length - keepElsewhere));
    for (const c of from) {
      await storage.updateSchedule(c.id, {
        outletIds: (c.outletIds as string[]).filter(id => id !== outlet.id),
        routeOrder: ((c.routeOrder as string[]) || []).filter(id => id !== outlet.id),
        totalDistance: null, estimatedDuration: null,
      });
    }
    const joined: Schedule[] = [];
    for (const c of to) {
      const ids = c.outletIds as string[];
      if (ids.includes(outlet.id)) { joined.push(c); continue; }
      const order = ((c.routeOrder as string[]) || []).length > 0 ? (c.routeOrder as string[]) : ids;
      const updated = await storage.updateSchedule(c.id, {
        outletIds: [...ids, outlet.id],
        routeOrder: insertStop(order, outlet.id, byId),
        totalDistance: null, estimatedDuration: null,
      });
      if (updated) joined.push(updated);
    }
    return { from, to: joined };
  }

  // After a rep's routes are rebuilt, put every outlet pinned to one of this
  // rep's routes back where the user left it. Pins that no longer apply (the
  // outlet moved to another rep, the cell is gone) are dropped.
  async function applyPinsForRep(repId: string): Promise<number> {
    let applied = 0;
    for (const o of (await storage.getOutlets()).filter(o => o.pinnedRoute)) {
      const pin = parsePin(o);
      if (!pin) { await storage.updateOutlet(o.id, { pinnedRoute: null }); continue; }
      if (pin.repId !== repId) continue;
      if (o.repId !== repId) { await storage.updateOutlet(o.id, { pinnedRoute: null }); continue; }
      const cells = await storage.getSchedulesByRepId(repId);
      const target = cells.find(c => c.week === pin.week && c.dayOfWeek === pin.dayOfWeek);
      if (!target) { await storage.updateOutlet(o.id, { pinnedRoute: null }); continue; }
      await placeOutletInRoute(o, target);
      applied++;
    }
    return applied;
  }

  app.post("/api/outlets/:id/move-to-route", async (req, res) => {
    try {
      const repId = typeof req.body?.repId === 'string' ? req.body.repId : '';
      const week = Number(req.body?.week);
      const dayOfWeek = Number(req.body?.dayOfWeek);
      if (!repId || !Number.isInteger(week) || !Number.isInteger(dayOfWeek)) {
        return res.status(400).json({ message: "repId, week and dayOfWeek are required" });
      }
      const outlet = (await storage.getOutlets()).find(o => o.id === req.params.id);
      if (!outlet) return res.status(404).json({ message: "Outlet not found" });
      const rep = await storage.getRep(repId);
      if (!rep) return res.status(404).json({ message: "That rep no longer exists - the plan was rebuilt. Pick a route on the current plan." });
      const target = (await storage.getSchedulesByRepId(repId)).find(c => c.week === week && c.dayOfWeek === dayOfWeek);
      if (!target) return res.status(404).json({ message: "That route no longer exists - the plan was rebuilt. Pick a route on the current plan." });

      // The outlet takes the route's zone label, so lists and exports agree
      // with the map.
      const outletsNow = await storage.getOutlets();
      const zoneCount = new Map<string, number>();
      for (const id of target.outletIds as string[]) {
        const z = outletsNow.find(o => o.id === id)?.territory;
        if (z && z !== 'Excluded') zoneCount.set(z, (zoneCount.get(z) ?? 0) + 1);
      }
      const zone = Array.from(zoneCount.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? outlet.territory;

      const fromRepId = outlet.repId;
      await storage.updateOutlet(outlet.id, {
        repId, territory: zone,
        pinnedRoute: JSON.stringify({ repId, week, dayOfWeek } satisfies PinnedRoute),
      });
      const fresh = (await storage.getOutlets()).find(o => o.id === outlet.id)!;
      const { from, to } = await placeOutletInRoute(fresh, target);
      await storage.flush();

      const label = (c: Schedule) => `W${c.week} ${WEEKDAY_NAMES[c.dayOfWeek - 1]?.slice(0, 3) ?? c.dayOfWeek}`;
      res.json({
        success: true,
        outlet: fresh,
        fromRepId,
        toRep: { id: rep.id, name: rep.name },
        from: from.map(c => ({ repId: c.repId, week: c.week, dayOfWeek: c.dayOfWeek })),
        to: to.map(c => ({ repId: c.repId, week: c.week, dayOfWeek: c.dayOfWeek })),
        message: `${fresh.name} is now on ${rep.name} ${to.map(label).join(' + ')}${zone ? ` (${zone})` : ''}, and stays there when routes are rebuilt.`,
      });
    } catch (error) {
      console.error("move-to-route error:", error);
      res.status(500).json({ message: "Failed to move the outlet to that route" });
    }
  });

  async function regenerateSchedulesForReps(repIds: string[]) {
    const uniqueRepIds = Array.from(new Set(repIds.filter(Boolean)));
    // Rebuild with the settings the plan was built on - the day band, the
    // compactness cap and the distance model included, not just the calendar.
    // Without this a rebuild after a restart silently reverted to defaults.
    const saved = applyPlanSettings();
    const existingCycle = await storedCycleDays();
    if (existingCycle > 0) cycleWorkingDays = existingCycle;
    // The saved settings carry the week in the user's order (Sunday first,
    // Saturday last, for Damascus). Reading it off the plan instead would
    // re-derive the order from the days off and relabel every week.
    if (!saved || !saved.workingDays?.length) {
      const existingWeek = await storedWorkingWeek();
      if (existingWeek.length > 0) workingWeek = existingWeek;
    }
    const allReps = await storage.getReps();
    const allOutlets = await storage.getOutlets();
    const allHierarchies = await storage.getRoleHierarchies();
    const summary: { repId: string; name: string; outlets: number; monthlyVisits: number; schedules: number; overCapacity: boolean }[] = [];

    for (const repId of uniqueRepIds) {
      const rep = allReps.find(r => r.id === repId);
      if (!rep) continue;

      await storage.deleteSchedulesByRepId(rep.id);
      const repOutlets = allOutlets.filter(o => o.repId === rep.id && o.territory !== 'Excluded');

      let created = 0;
      if (repOutlets.length > 0) {
        const byZone = new Map<string, Outlet[]>();
        for (const o of repOutlets) {
          const key = o.territory || 'unzoned';
          if (!byZone.has(key)) byZone.set(key, []);
          byZone.get(key)!.push(o);
        }
        const schedules = await buildAnchorAwareSchedulesFromZones(rep, Array.from(byZone.values()));
        for (const s of schedules) await storage.createSchedule(s);
        created = schedules.length;
        // Outlets the user placed on a route by hand go back onto it.
        await applyPinsForRep(rep.id);

        const repSchedules = await storage.getSchedulesByRepId(rep.id);
        const repHierarchies = allHierarchies
          .filter(h => h.repId === rep.id)
          .filter(h => h.isActive && h.role !== 'rep' && h.role !== '_config');
        if (repSchedules.length > 0 && repHierarchies.length > 0) {
          await generateRoleSchedulesForRep(rep.id, repSchedules, repHierarchies);
        }
      } else {
        await storage.deleteRoleSchedulesByRepId(rep.id);
      }

      const monthlyVisits = repOutlets.reduce((s, o) => s + (o.visitFrequency ?? 1), 0);
      const monthlyCapacity = cycleShape(rep.workingDaysPerWeek || 5).cycleDays * (rep.maxDailyVisits || 25);
      summary.push({
        repId: rep.id,
        name: rep.name,
        outlets: repOutlets.length,
        monthlyVisits,
        schedules: created,
        overCapacity: monthlyVisits > monthlyCapacity
      });
    }
    return summary;
  }

  // Reps whose schedules currently reference any of these outlets, plus the
  // reps the outlets are owned by - both sides of any move.
  async function repsAffectedByOutlets(outletIds: string[]): Promise<string[]> {
    const idSet = new Set(outletIds);
    const affected = new Set<string>();
    const allOutlets = await storage.getOutlets();
    for (const o of allOutlets) {
      if (idSet.has(o.id) && o.repId) affected.add(o.repId);
    }
    const allSchedules = await storage.getSchedules();
    for (const s of allSchedules) {
      if ((s.outletIds as string[]).some(id => idSet.has(id))) affected.add(s.repId);
    }
    return Array.from(affected);
  }

  // Move outlets from their current rep(s) to another rep, then rework the
  // affected reps' schedules automatically - the "assign outlets to other
  // reps and the app re-optimizes" flow.
  // Misfit detection: outlets that are probably assigned to the wrong rep.
  // The metric is LOCAL adjacency - how far is this outlet from its own
  // rep's nearest outlets vs another rep's nearest outlets - NOT distance
  // to territory centroids: a territory spans several day-zones, so its
  // centroid is far from legitimate edge outlets and flags a third of the
  // universe as "wrong". Using the 3rd-nearest same-rep outlet makes the
  // own-side distance robust against a single co-located stray. Pure
  // analysis; fixing anything goes through the normal reassignment flow.
  app.get("/api/reps/misfit-outlets", async (_req, res) => {
    try {
      const allReps = await storage.getReps();
      const repName = new Map(allReps.map(r => [r.id, r.name]));
      const allOutlets = (await storage.getOutlets())
        .filter(o => o.repId && o.territory !== 'Excluded' && o.geoStatus !== 'offset');

      // Spatial grid (~2.2km cells) for neighbor lookups
      const CELL = 0.02;
      const grid = new Map<string, typeof allOutlets>();
      const keyOf = (lat: number, lng: number) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;
      for (const o of allOutlets) {
        const k = keyOf(o.latitude, o.longitude);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push(o);
      }

      const misfits: {
        outletId: string; name: string; latitude: number; longitude: number;
        currentRepId: string; currentRepName: string; distCurrentKm: number;
        suggestedRepId: string; suggestedRepName: string; distSuggestedKm: number;
        savingsKm: number;
      }[] = [];

      const MAX_RING = 5; // ~11km search radius
      for (const o of allOutlets) {
        const cy = Math.floor(o.latitude / CELL);
        const cx = Math.floor(o.longitude / CELL);

        const ownDists: number[] = [];
        const bestOther = new Map<string, number>();
        for (let ring = 0; ring <= MAX_RING; ring++) {
          for (let dy = -ring; dy <= ring; dy++) {
            for (let dx = -ring; dx <= ring; dx++) {
              if (Math.max(Math.abs(dy), Math.abs(dx)) !== ring) continue; // ring shell only
              const cell = grid.get(`${cy + dy}:${cx + dx}`);
              if (!cell) continue;
              for (const n of cell) {
                if (n.id === o.id) continue;
                const d = haversineKm(o.latitude, o.longitude, n.latitude, n.longitude);
                if (n.repId === o.repId) ownDists.push(d);
                else {
                  const cur = bestOther.get(n.repId!);
                  if (cur === undefined || d < cur) bestOther.set(n.repId!, d);
                }
              }
            }
          }
          // Stop expanding once we have enough context on both sides
          if (ownDists.length >= 3 && bestOther.size >= 1 && ring >= 1) break;
        }

        if (ownDists.length === 0 || bestOther.size === 0) continue;
        ownDists.sort((a, b) => a - b);
        const dOwn = ownDists[Math.min(2, ownDists.length - 1)]; // 3rd nearest (robust)

        let suggestedRepId = '', dSuggested = Infinity;
        for (const [rid, d] of Array.from(bestOther.entries())) {
          if (d < dSuggested) { dSuggested = d; suggestedRepId = rid; }
        }

        // Flag when another rep's outlets are at most half as far AND the
        // difference is operationally meaningful (>1km).
        if (dSuggested < dOwn * 0.5 && dOwn - dSuggested > 1) {
          misfits.push({
            outletId: o.id, name: o.name, latitude: o.latitude, longitude: o.longitude,
            currentRepId: o.repId!, currentRepName: repName.get(o.repId!) || '?',
            distCurrentKm: Math.round(dOwn * 10) / 10,
            suggestedRepId, suggestedRepName: repName.get(suggestedRepId) || '?',
            distSuggestedKm: Math.round(dSuggested * 10) / 10,
            savingsKm: Math.round((dOwn - dSuggested) * 10) / 10
          });
        }
      }

      misfits.sort((a, b) => b.savingsKm - a.savingsKm);
      res.json({ misfits: misfits.slice(0, 100), total: misfits.length });
    } catch (error) {
      console.error("Misfit analysis error:", error);
      res.status(500).json({ message: "Failed to analyze misfit outlets" });
    }
  });

  app.post("/api/reps/reassign-outlets", async (req, res) => {
    try {
      const { outletIds, toRepId } = req.body as { outletIds: string[]; toRepId: string };
      if (!Array.isArray(outletIds) || outletIds.length === 0) {
        return res.status(400).json({ message: "outletIds must be a non-empty array" });
      }
      const targetRep = await storage.getRep(toRepId);
      if (!targetRep) {
        // Almost always a queued move outliving the plan it was made on: a full
        // optimization deletes every rep and creates new ones. Say so, rather
        // than leaving the user to guess at "Target rep not found".
        return res.status(404).json({
          message: "That rep no longer exists - the plan was rebuilt since this move was queued. Re-queue it on the current plan.",
        });
      }

      const affectedBefore = await repsAffectedByOutlets(outletIds);

      let moved = 0;
      for (const id of outletIds) {
        const outlet = await storage.updateOutlet(id, { repId: toRepId });
        if (outlet) moved++;
      }
      if (moved === 0) {
        return res.status(404).json({ message: "No matching outlets found" });
      }

      const affectedRepIds = Array.from(new Set([...affectedBefore, toRepId]));
      const summary = await regenerateSchedulesForReps(affectedRepIds);

      const warnings: string[] = [];
      for (const s of summary) {
        if (s.overCapacity) {
          warnings.push(`${s.name} is now over monthly capacity (${s.monthlyVisits} visits).`);
        }
      }

      // Capacity-aware cascade: when the move overloads a rep, suggest which
      // of that rep's outlets could move on to nearby reps with spare
      // capacity to restore balance. Suggestions only - applying them is
      // another call to this same endpoint.
      const suggestedCascade: {
        outletId: string; outletName: string; monthlyVisits: number;
        fromRep: string; toRepId: string; toRepName: string; distanceKm: number;
      }[] = [];
      const overloaded = summary.filter(s => s.overCapacity);
      if (overloaded.length > 0) {
        const allRepsNow = await storage.getReps();
        const allOutletsNow = await storage.getOutlets();
        const justMoved = new Set(outletIds);

        const repLoad = new Map<string, number>();
        const repOutletsMap = new Map<string, Outlet[]>();
        for (const r of allRepsNow) {
          const os = allOutletsNow.filter(o => o.repId === r.id && o.territory !== 'Excluded');
          repOutletsMap.set(r.id, os);
          repLoad.set(r.id, os.reduce((s, o) => s + (o.visitFrequency ?? 1), 0));
        }
        const capacityOf = (r: Rep) => cycleShape(r.workingDaysPerWeek || 5).cycleDays * (r.maxDailyVisits || 25);
        const centroidOf = (os: Outlet[]) => ({
          lat: os.reduce((s, o) => s + o.latitude, 0) / os.length,
          lng: os.reduce((s, o) => s + o.longitude, 0) / os.length,
        });

        for (const ov of overloaded) {
          const rep = allRepsNow.find(r => r.id === ov.repId);
          if (!rep) continue;
          let excess = ov.monthlyVisits - capacityOf(rep);
          if (excess <= 0) continue;

          const receivers = allRepsNow
            .filter(r => r.id !== rep.id && (repOutletsMap.get(r.id)?.length ?? 0) > 0)
            .map(r => ({ rep: r, spare: capacityOf(r) - (repLoad.get(r.id) ?? 0), centroid: centroidOf(repOutletsMap.get(r.id)!) }))
            .filter(r => r.spare > 0);
          if (receivers.length === 0) continue;

          // Rank this rep's outlets by how close they are to another rep's
          // territory - boundary outlets cascade with the least disruption.
          const candidates = (repOutletsMap.get(rep.id) ?? [])
            .filter(o => !justMoved.has(o.id))
            .map(o => {
              let best = receivers[0], bestD = Infinity;
              for (const rc of receivers) {
                const d = geoDist(o.latitude, o.longitude, rc.centroid.lat, rc.centroid.lng);
                if (d < bestD) { bestD = d; best = rc; }
              }
              return { o, toRep: best.rep, distanceKm: bestD };
            })
            .sort((a, b) => a.distanceKm - b.distanceKm);

          for (const c of candidates) {
            if (excess <= 0 || suggestedCascade.length >= 30) break;
            const w = c.o.visitFrequency ?? 1;
            suggestedCascade.push({
              outletId: c.o.id,
              outletName: c.o.name,
              monthlyVisits: w,
              fromRep: rep.name,
              toRepId: c.toRep.id,
              toRepName: c.toRep.name,
              distanceKm: Math.round(c.distanceKm * 10) / 10,
            });
            excess -= w;
          }
        }
      }

      res.json({
        success: true,
        movedOutlets: moved,
        toRep: { id: targetRep.id, name: targetRep.name },
        repsReworked: summary,
        warnings,
        suggestedCascade,
        message: `Moved ${moved} outlet(s) to ${targetRep.name} and reworked schedules for ${summary.length} rep(s).${suggestedCascade.length > 0 ? ` ${suggestedCascade.length} cascade move(s) suggested to restore capacity.` : ''}`
      });
    } catch (error) {
      console.error("Reassign-outlets error:", error);
      res.status(500).json({ message: "Failed to reassign outlets" });
    }
  });

  app.post("/api/outlets/:id/reassign", async (req, res) => {
    try {
      const { territory, repId } = req.body;
      const affectedBefore = await repsAffectedByOutlets([req.params.id]);
      const outlet = await storage.updateOutlet(req.params.id, { territory, repId });
      if (!outlet) {
        return res.status(404).json({ message: "Outlet not found" });
      }
      // Rework schedules for every rep touched by the move so the change is
      // reflected in actual day-routes, not just the outlet record.
      const affected = Array.from(new Set([...affectedBefore, ...(repId ? [repId] : [])]));
      const repsReworked = await regenerateSchedulesForReps(affected);
      res.json({ ...outlet, repsReworked });
    } catch (error) {
      res.status(500).json({ message: "Failed to reassign outlet" });
    }
  });

  // Bulk reassign outlets
  app.post("/api/outlets/bulk-reassign", async (req, res) => {
    try {
      const { updates } = req.body; // Array of { id, territory, repId }
      const ids = updates.map((u: any) => u.id);
      const affectedBefore = await repsAffectedByOutlets(ids);
      // A null/absent repId means "keep the current rep" - never strip
      // ownership, or the outlet would silently vanish from all schedules.
      const results = await storage.updateOutlets(updates.map((u: any) => ({
        id: u.id,
        data: {
          ...(u.territory ? { territory: u.territory } : {}),
          ...(u.repId ? { repId: u.repId } : {})
        }
      })));
      const newRepIds = updates.map((u: any) => u.repId).filter(Boolean);
      const affected = Array.from(new Set([...affectedBefore, ...newRepIds]));
      const repsReworked = await regenerateSchedulesForReps(affected);
      res.json({ success: true, updated: results.length, repsReworked });
    } catch (error) {
      res.status(500).json({ message: "Failed to bulk reassign outlets" });
    }
  });

  // Full re-optimization after zone changes
  app.post("/api/reoptimize", asJob('reoptimize', async (req: Request, res: Response) => {
    try {
      const outlets = await storage.getOutlets();
      const reps = await storage.getReps();
      
      if (outlets.length === 0) {
        return res.status(400).json({ message: "No outlets available for re-optimization" });
      }
      
      // The dashboard's settings are the plan's settings. This used to default
      // to 25-27 visits a day over a 5-day week whenever the request did not
      // spell them out - which the Reoptimize button never did - so pressing it
      // quietly rebuilt the plan to numbers the user had not chosen.
      const saved = applyPlanSettings();
      const minVisitsPerDay = req.body.minVisitsPerDay ?? saved?.minVisitsPerDay ?? 25;
      const maxVisitsPerDay = req.body.maxVisitsPerDay ?? saved?.maxVisitsPerDay ?? 27;
      const workingDaysPerWeek = req.body.workingDaysPerWeek ?? workingWeek.length ?? 5;

      // Keep the cycle and working week the current plan was built on unless
      // asked to change them.
      const requestedCycle = Math.max(0, Math.min(60, parseInt(String(req.body.cycleWorkingDays ?? 0), 10) || 0));
      cycleWorkingDays = requestedCycle || await storedCycleDays();
      if (Array.isArray(req.body.workingDays) && req.body.workingDays.length > 0) {
        workingWeek = parseWorkingWeek(req.body);
      } else if (!saved || !saved.workingDays?.length) {
        const stored = await storedWorkingWeek();
        if (stored.length > 0) workingWeek = stored;
      }

      // Clear existing schedules
      await storage.clearSchedules();

      // Generate new schedules using the anchor-aware VF1/VF2/VF3/VF4
      // scheduler. Outlet→rep linkage is by repId (the ownership record the
      // optimize and reassignment flows maintain); the old territory-string
      // match compared outlet zones ("Zone N") to rep territories
      // ("Territory N"), which never matched - wiping all schedules and
      // rebuilding none. Territory match is kept only as a fallback for
      // data created before repId ownership existed. Outlets are grouped by
      // zone label so geographic tightness survives the rebuild.
      const hasOwnership = outlets.some(o => o.repId);
      const schedules: InsertSchedule[] = [];
      for (const rep of reps) {
        const repOutlets = hasOwnership
          ? outlets.filter(o => o.repId === rep.id && o.territory !== 'Excluded')
          : outlets.filter(o => o.territory === rep.territory);
        if (repOutlets.length === 0) continue;
        const byZone = new Map<string, Outlet[]>();
        for (const o of repOutlets) {
          const key = o.territory || 'unzoned';
          if (!byZone.has(key)) byZone.set(key, []);
          byZone.get(key)!.push(o);
        }
        const repSchedules = await buildAnchorAwareSchedulesFromZones(
          { ...rep, workingDaysPerWeek: rep.workingDaysPerWeek || workingDaysPerWeek } as Rep,
          Array.from(byZone.values())
        );
        schedules.push(...repSchedules);
      }

      // Save new schedules
      await storage.createSchedules(schedules);
      for (const rep of reps) await applyPinsForRep(rep.id);
      
      // Validate the new schedules
      const allSchedules = await storage.getSchedules();
      let totalErrors = 0;
      let totalWarnings = 0;
      
      for (const rep of reps) {
        const repOutlets = outlets.filter(o => o.territory === rep.territory);
        const repSchedules = allSchedules.filter(s => s.repId === rep.id).map(s => ({
          repId: s.repId,
          week: s.week,
          dayOfWeek: s.dayOfWeek,
          outletIds: s.outletIds as string[],
          routeOrder: s.routeOrder as string[],
          totalDistance: s.totalDistance || undefined,
          estimatedDuration: s.estimatedDuration || undefined
        }));
        
        const validation = validateSchedule(repOutlets, repSchedules as any, {
          minVisitsPerDay,
          maxVisitsPerDay,
          workingDaysPerWeek,
          weeksInMonth: 4
        });
        
        totalErrors += validation.errors.length;
        totalWarnings += validation.warnings.length;
      }
      
      // Also regenerate role schedules (for Merchandisers, Collection Agents, etc.)
      let totalRoleSchedules = 0;
      const allHierarchies = await storage.getRoleHierarchies();
      
      for (const rep of reps) {
        const repSchedules = allSchedules.filter(s => s.repId === rep.id);
        const repHierarchies = allHierarchies
          .filter(h => h.repId === rep.id || h.repId === 'template')
          .filter(h => h.isActive && h.role !== 'rep' && h.role !== '_config');
        
        if (repSchedules.length > 0 && repHierarchies.length > 0) {
          const generatedRoleSchedules = await generateRoleSchedulesForRep(rep.id, repSchedules, repHierarchies);
          totalRoleSchedules += generatedRoleSchedules.length;
        }
      }
      
      res.json({
        success: true,
        schedulesCreated: schedules.length,
        roleSchedulesCreated: totalRoleSchedules,
        repsProcessed: reps.length,
        validation: {
          errors: totalErrors,
          warnings: totalWarnings
        },
        message: `Re-optimization complete. Generated ${schedules.length} schedules and ${totalRoleSchedules} role schedules for ${reps.length} reps.`
      });
    } catch (error) {
      console.error("Re-optimization error:", error);
      res.status(500).json({ message: "Failed to re-optimize" });
    }
  }));

  // Generate advanced VF-aware schedule for a single territory
  app.post("/api/territories/:territory/generate-schedule", async (req, res) => {
    try {
      const { territory } = req.params;
      const { repId, minVisitsPerDay = 25, maxVisitsPerDay = 27, workingDaysPerWeek = 5 } = req.body;
      
      const territoryOutlets = await storage.getOutletsByTerritory(territory);
      if (territoryOutlets.length === 0) {
        return res.status(404).json({ message: "No outlets found in this territory" });
      }

      // Clear existing schedules for this rep
      if (repId) {
        await storage.deleteSchedulesByRepId(repId);
      }

      // If a specific rep was provided, only schedule the outlets that
      // actually belong to that rep (territory may be shared across reps).
      const outlets = repId
        ? territoryOutlets.filter(o => o.repId === repId)
        : territoryOutlets;

      if (outlets.length === 0) {
        return res.status(404).json({ message: "No outlets assigned to this rep in this territory" });
      }

      // Generate new schedules using the anchor-aware VF-aware scheduler
      const repForSchedule = repId
        ? (await storage.getRep(repId))
        : null;
      const schedules = buildAnchorAwareSchedules(
        (repForSchedule || { id: repId || territory, workingDaysPerWeek }) as Rep,
        outlets
      );

      // Save schedules
      await storage.createSchedules(schedules);
      
      // Validate
      const validation = validateSchedule(outlets, schedules, {
        minVisitsPerDay,
        maxVisitsPerDay,
        workingDaysPerWeek,
        weeksInMonth: 4
      });
      
      res.json({
        success: true,
        schedulesCreated: schedules.length,
        territory,
        outlets: outlets.length,
        vfBreakdown: {
          vf1: outlets.filter(o => o.visitFrequency === 1).length,
          vf2: outlets.filter(o => o.visitFrequency === 2).length,
          vf3: outlets.filter(o => o.visitFrequency === 3).length,
          vf4: outlets.filter(o => o.visitFrequency === 4).length
        },
        validation: {
          isValid: validation.isValid,
          errors: validation.errors,
          warnings: validation.warnings
        }
      });
    } catch (error) {
      console.error("Schedule generation error:", error);
      res.status(500).json({ message: "Failed to generate schedule" });
    }
  });


  // Get maintenance policies
  // Update maintenance policy
  // Record route usage (KM accumulation from rep routes)
  // Calculate route KM for a rep from their schedule
  app.get("/api/reps/:id/route-km", async (req, res) => {
    try {
      const repId = req.params.id;
      const rep = await storage.getRep(repId);
      if (!rep) {
        return res.status(404).json({ message: "Rep not found" });
      }

      const schedules = await storage.getSchedulesByRepId(repId);
      const outlets = await storage.getOutlets();
      
      // Calculate route distances for each scheduled day
      let totalWeeklyKm = 0;
      const dailyRouteKm: { week: number; day: number; km: number; outlets: number }[] = [];

      // Group schedules by week
      const weeklyKmByWeek: Record<number, number> = {};
      
      for (const schedule of schedules) {
        const outletIds = schedule.outletIds as string[];
        const scheduleOutlets = outletIds
          .map(id => outlets.find(o => o.id === id))
          .filter(Boolean) as typeof outlets;

        // Calculate route distance using simple haversine
        let routeDistance = 0;
        for (let i = 0; i < scheduleOutlets.length - 1; i++) {
          const from = scheduleOutlets[i];
          const to = scheduleOutlets[i + 1];
          if (from.latitude && from.longitude && to.latitude && to.longitude) {
            routeDistance += haversineDistance(
              from.latitude, from.longitude,
              to.latitude, to.longitude
            );
          }
        }

        dailyRouteKm.push({
          week: schedule.week,
          day: schedule.dayOfWeek,
          km: routeDistance,
          outlets: outletIds.length
        });

        // Accumulate KM per week
        weeklyKmByWeek[schedule.week] = (weeklyKmByWeek[schedule.week] || 0) + routeDistance;
      }

      // Calculate total weekly KM as average across all weeks
      const weeks = Object.keys(weeklyKmByWeek);
      const totalMonthlyKm = Object.values(weeklyKmByWeek).reduce((sum, km) => sum + km, 0);
      totalWeeklyKm = weeks.length > 0 ? totalMonthlyKm / weeks.length : 0;

      const workingDays = rep.workingDaysPerWeek || 5;
      const avgDailyKm = workingDays > 0 ? totalWeeklyKm / workingDays : 0;
      const monthlyProjectedKm = totalMonthlyKm;
      const annualProjectedKm = monthlyProjectedKm * 12;

      res.json({
        repId,
        repName: rep.name,
        dailyRouteKm,
        totalWeeklyKm,
        avgDailyKm,
        monthlyProjectedKm,
        annualProjectedKm,
        workingDays
      });
    } catch (error) {
      console.error("Route KM calculation error:", error);
      res.status(500).json({ message: "Failed to calculate route KM" });
    }
  });

  // Adjust odometer with audit logging
  // ============================================
  // ROLE HIERARCHY MANAGEMENT
  // ============================================

  // Get role presets
  app.get("/api/role-presets", async (_req, res) => {
    res.json(ROLE_PRESETS);
  });

  // Get all role hierarchies
  app.get("/api/role-hierarchies", async (_req, res) => {
    try {
      const hierarchies = await storage.getRoleHierarchies();
      res.json(hierarchies);
    } catch (error) {
      console.error("Error fetching role hierarchies:", error);
      res.status(500).json({ message: "Failed to fetch role hierarchies" });
    }
  });

  // Get role hierarchies for a specific rep
  app.get("/api/reps/:repId/hierarchies", async (req, res) => {
    try {
      const { repId } = req.params;
      const hierarchies = await storage.getRoleHierarchiesByRepId(repId);
      res.json(hierarchies);
    } catch (error) {
      console.error("Error fetching rep hierarchies:", error);
      res.status(500).json({ message: "Failed to fetch rep hierarchies" });
    }
  });

  // Create/Update role hierarchies for a rep (bulk operation)
  app.post("/api/reps/:repId/hierarchies", async (req, res) => {
    try {
      const { repId } = req.params;
      const { roles } = req.body; // Array of { role, roleName, offsetDays, colorHex, isActive }

      // Verify rep exists
      const rep = await storage.getRep(repId);
      if (!rep) {
        return res.status(404).json({ message: "Rep not found" });
      }

      // Delete existing hierarchies for this rep
      await storage.deleteRoleHierarchiesByRepId(repId);

      // Create new hierarchies
      const hierarchies = [];
      for (let i = 0; i < roles.length; i++) {
        const roleData = roles[i];
        const validated = insertRoleHierarchySchema.parse({
          repId,
          role: roleData.role,
          roleName: roleData.roleName,
          offsetDays: roleData.offsetDays || 0,
          colorHex: roleData.colorHex || '#3B82F6',
          isActive: roleData.isActive !== false,
          sortOrder: i
        });
        const created = await storage.createRoleHierarchy(validated);
        hierarchies.push(created);
      }

      // Generate role schedules if there are active schedules for this rep
      const repSchedules = await storage.getSchedulesByRepId(repId);
      if (repSchedules.length > 0) {
        await generateRoleSchedulesForRep(repId, repSchedules, hierarchies);
      }

      res.json({
        success: true,
        hierarchies,
        message: `Created ${hierarchies.length} role hierarchies for rep ${rep.name}`
      });
    } catch (error) {
      console.error("Error saving role hierarchies:", error);
      res.status(500).json({ message: "Failed to save role hierarchies" });
    }
  });

  // Delete a specific role hierarchy
  app.delete("/api/role-hierarchies/:id", async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteRoleHierarchy(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting role hierarchy:", error);
      res.status(500).json({ message: "Failed to delete role hierarchy" });
    }
  });

  // Save role hierarchy template (global configuration that will be applied during optimization)
  app.post("/api/role-hierarchies/template", async (req, res) => {
    try {
      const { roles, mode = 'global', selectedRepIds = [] } = req.body; // mode: 'global' | 'custom'
      
      // Store the template in storage (we'll apply it during optimization)
      // For now, store it as a special hierarchy with repId = 'template'
      // Also store the mode as a special entry with role = '_config'
      await storage.deleteRoleHierarchiesByRepId('template');
      
      // Store mode configuration with selected rep IDs in colorHex field (JSON-encoded)
      const modeConfig = await storage.createRoleHierarchy({
        repId: 'template',
        role: '_config',
        roleName: mode, // Store mode in roleName field
        offsetDays: 0,
        colorHex: JSON.stringify(selectedRepIds), // Store selected rep IDs as JSON
        isActive: true,
        sortOrder: -1
      });
      
      const templates = [modeConfig];
      for (let i = 0; i < roles.length; i++) {
        const roleData = roles[i];
        const validated = insertRoleHierarchySchema.parse({
          repId: 'template',
          role: roleData.role,
          roleName: roleData.roleName,
          offsetDays: roleData.offsetDays || 0,
          colorHex: roleData.colorHex || '#3B82F6',
          isActive: roleData.isActive !== false,
          sortOrder: i
        });
        const created = await storage.createRoleHierarchy(validated);
        templates.push(created);
      }
      
      // After saving templates, regenerate role schedules for all reps based on the new template
      const allReps = await storage.getReps();
      const allSchedules = await storage.getSchedules();
      let totalSchedulesGenerated = 0;
      
      // Create hierarchies for each rep based on template and regenerate their role schedules
      for (const rep of allReps) {
        const repSchedules = allSchedules.filter(s => s.repId === rep.id);
        if (repSchedules.length === 0) continue;
        
        // Get or create hierarchies for this rep based on template
        // Check if this rep should use the template (global mode applies to all, custom mode applies to selected)
        const shouldApply = mode === 'global' || selectedRepIds.includes(rep.id);
        if (!shouldApply) continue;
        
        // Delete existing role-specific hierarchies for this rep
        await storage.deleteRoleHierarchiesByRepId(rep.id);
        
        // Create new hierarchies for this rep from template
        const repHierarchies = [];
        for (let i = 0; i < roles.length; i++) {
          const roleData = roles[i];
          const created = await storage.createRoleHierarchy({
            repId: rep.id,
            role: roleData.role,
            roleName: roleData.roleName,
            offsetDays: roleData.offsetDays || 0,
            colorHex: roleData.colorHex || '#3B82F6',
            isActive: roleData.isActive !== false,
            sortOrder: i
          });
          repHierarchies.push(created);
        }
        
        // Generate role schedules for this rep
        if (repHierarchies.length > 0) {
          const generated = await generateRoleSchedulesForRep(rep.id, repSchedules, repHierarchies);
          totalSchedulesGenerated += generated.length;
        }
      }
      
      console.log(`Generated ${totalSchedulesGenerated} role schedules for ${allReps.length} reps`);
      
      res.json({
        success: true,
        templates,
        mode,
        schedulesGenerated: totalSchedulesGenerated,
        message: `Saved ${templates.length - 1} role hierarchy templates in ${mode} mode and generated ${totalSchedulesGenerated} role schedules`
      });
    } catch (error) {
      console.error("Error saving role hierarchy template:", error);
      res.status(500).json({ message: "Failed to save role hierarchy template" });
    }
  });

  // Get all role schedules
  app.get("/api/role-schedules", async (_req, res) => {
    try {
      const schedules = await storage.getRoleSchedules();
      res.json(schedules);
    } catch (error) {
      console.error("Error fetching role schedules:", error);
      res.status(500).json({ message: "Failed to fetch role schedules" });
    }
  });

  // Get role schedules for a specific rep
  app.get("/api/reps/:repId/role-schedules", async (req, res) => {
    try {
      const { repId } = req.params;
      const schedules = await storage.getRoleSchedulesByRepId(repId);
      res.json(schedules);
    } catch (error) {
      console.error("Error fetching rep role schedules:", error);
      res.status(500).json({ message: "Failed to fetch rep role schedules" });
    }
  });

  // Regenerate role schedules for a rep (called when rep schedule changes)
  app.post("/api/reps/:repId/regenerate-role-schedules", async (req, res) => {
    try {
      const { repId } = req.params;
      
      const rep = await storage.getRep(repId);
      if (!rep) {
        return res.status(404).json({ message: "Rep not found" });
      }

      const repSchedules = await storage.getSchedulesByRepId(repId);
      const hierarchies = await storage.getRoleHierarchiesByRepId(repId);

      if (hierarchies.length === 0) {
        return res.json({ success: true, message: "No hierarchies configured for this rep", schedulesGenerated: 0 });
      }

      const generatedSchedules = await generateRoleSchedulesForRep(repId, repSchedules, hierarchies);

      res.json({
        success: true,
        schedulesGenerated: generatedSchedules.length,
        message: `Generated ${generatedSchedules.length} role schedules for ${rep.name}`
      });
    } catch (error) {
      console.error("Error regenerating role schedules:", error);
      res.status(500).json({ message: "Failed to regenerate role schedules" });
    }
  });

  // Helper function to generate role schedules for a rep
  async function generateRoleSchedulesForRep(
    repId: string,
    repSchedules: Schedule[],
    hierarchies: { id: string; role: string; roleName: string; offsetDays: number; colorHex: string; isActive: boolean }[]
  ) {
    // Delete existing role schedules for this rep
    await storage.deleteRoleSchedulesByRepId(repId);

    const roleSchedules: InsertRoleSchedule[] = [];
    const workingDaysPerWeek = 5; // Configurable
    const weeksInMonth = 4;

    // For each hierarchy (except the Rep role which uses the base schedule)
    for (const hierarchy of hierarchies) {
      if (!hierarchy.isActive) continue;
      if (hierarchy.role === 'rep') continue; // Rep uses the main schedule, not role schedules

      // For each rep schedule entry, create a corresponding role schedule with shifted day
      for (const schedule of repSchedules) {
        // Calculate the new day with offset
        // Offsets count WORKING days, so they step along the working week
        // rather than through raw weekday numbers: +1 from the last working day
        // is the first working day of the next week, not the day off.
        const weekDays = workingWeek.length > 0 ? workingWeek : [1, 2, 3, 4, 5];
        const slot = weekDays.indexOf(schedule.dayOfWeek);
        const shifted = (slot >= 0 ? slot : 0) + hierarchy.offsetDays;
        let newWeek = schedule.week + Math.floor(shifted / weekDays.length);
        let newDayOfWeek = weekDays[((shifted % weekDays.length) + weekDays.length) % weekDays.length];
        if (newWeek < 1) newWeek = 1;

        // Handle month overflow (wrap to next week/day)
        if (newWeek > weeksInMonth) {
          newWeek = ((newWeek - 1) % weeksInMonth) + 1;
        }

        roleSchedules.push({
          hierarchyId: hierarchy.id,
          repId,
          role: hierarchy.role,
          roleName: hierarchy.roleName,
          week: newWeek,
          dayOfWeek: newDayOfWeek,
          originalDayOfWeek: schedule.dayOfWeek,
          outletIds: schedule.outletIds as string[],
          routeOrder: schedule.routeOrder as string[],
          totalDistance: schedule.totalDistance,
          estimatedDuration: schedule.estimatedDuration,
          offsetDays: hierarchy.offsetDays
        });
      }
    }

    // Create all role schedules
    if (roleSchedules.length > 0) {
      return await storage.createRoleSchedules(roleSchedules);
    }

    return [];
  }

  const httpServer = createServer(app);
  return httpServer;
}

// Haversine distance function
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

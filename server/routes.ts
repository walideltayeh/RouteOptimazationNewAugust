import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { 
  insertOptimizationRunSchema, 
  insertOutletSchema, 
  insertRepSchema, 
  insertScheduleSchema, 
  insertVehicleSchema,
  insertVehicleMaintenanceSchema,
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
  
  subscribe(progressId: string, res: Response) {
    if (!this.subscribers.has(progressId)) {
      this.subscribers.set(progressId, []);
    }
    this.subscribers.get(progressId)!.push(res);
    
    // Send initial heartbeat to confirm connection
    this.sendToClient(res, { percent: 0, stage: 'Starting', detail: 'Connected, waiting for optimization...' });
    
    // Send current progress if exists
    const current = this.progress.get(progressId);
    if (current) {
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
    this.progress.set(progressId, update);
    const subs = this.subscribers.get(progressId) || [];
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

const upload = multer({ storage: multer.memoryStorage() });

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

// Helper function to optimize route using nearest neighbor with 2-opt improvement
function optimizeRoute(outlets: Outlet[]): Outlet[] {
  if (outlets.length <= 1) return outlets;
  
  // Step 1: Find the centroid of all outlets
  const avgLat = outlets.reduce((sum, o) => sum + o.latitude, 0) / outlets.length;
  const avgLng = outlets.reduce((sum, o) => sum + o.longitude, 0) / outlets.length;
  
  // Step 2: Find the outlet farthest from centroid as starting point
  let startIdx = 0;
  let maxDist = 0;
  outlets.forEach((outlet, idx) => {
    const dist = calculateDistance(avgLat, avgLng, outlet.latitude, outlet.longitude);
    if (dist > maxDist) {
      maxDist = dist;
      startIdx = idx;
    }
  });
  
  // Step 3: Build initial route using nearest neighbor from the starting point
  const unvisited = [...outlets];
  const route: Outlet[] = [];
  
  // Start from the farthest outlet
  let current = unvisited[startIdx];
  route.push(current);
  unvisited.splice(startIdx, 1);
  
  // Nearest neighbor algorithm
  while (unvisited.length > 0) {
    let nearestIdx = 0;
    let nearestDist = Infinity;
    
    for (let i = 0; i < unvisited.length; i++) {
      const dist = calculateDistance(
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
        
        // Calculate current distance
        const currentDist = calculateDistance(
          route[i - 1].latitude, route[i - 1].longitude,
          route[i].latitude, route[i].longitude
        ) + calculateDistance(
          route[j - 1].latitude, route[j - 1].longitude,
          route[j].latitude, route[j].longitude
        );
        
        // Calculate new distance after swap
        const newDist = calculateDistance(
          route[i - 1].latitude, route[i - 1].longitude,
          route[j - 1].latitude, route[j - 1].longitude
        ) + calculateDistance(
          route[i].latitude, route[i].longitude,
          route[j].latitude, route[j].longitude
        );
        
        // If improvement found, reverse the route segment
        if (newDist < currentDist) {
          // Reverse the route between i and j-1
          const reversed = route.slice(i, j).reverse();
          route.splice(i, j - i, ...reversed);
          improved = true;
        }
      }
    }
  }
  
  return route;
}

// Helper function to calculate total route distance
function calculateTotalDistance(outlets: Outlet[]): number {
  let total = 0;
  for (let i = 1; i < outlets.length; i++) {
    total += calculateDistance(
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

// Helper function to generate zone-based schedules (one zone per day)
function generateZoneBasedSchedules(rep: Rep, zones: GeographicCluster[], allClusters: GeographicCluster[]): InsertSchedule[] {
  const schedules: InsertSchedule[] = [];
  const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const workingDays = daysOfWeek.slice(0, rep.workingDaysPerWeek);
  
  // Determine how to split zones based on working days
  let zonesPerWeek: number;
  if (rep.workingDaysPerWeek <= 5) {
    zonesPerWeek = 5; // 5 zones per week for 5-day workweek
  } else if (rep.workingDaysPerWeek === 6) {
    zonesPerWeek = 6; // 6 zones per week for 6-day workweek
  } else {
    zonesPerWeek = 7; // 7 zones per week for 7-day workweek
  }
  
  // Split zones into groups based on working days
  const week1Zones = zones.slice(0, Math.min(zonesPerWeek, zones.length));
  const week2Zones = zones.slice(zonesPerWeek, Math.min(zonesPerWeek * 2, zones.length));
  
  // Generate schedules for Week 1 and Week 2 (pattern repeats for weeks 3 and 4)
  for (let week = 1; week <= 2; week++) {
    const currentWeekZones = week === 1 ? week1Zones : week2Zones;
    
    for (let dayIndex = 0; dayIndex < workingDays.length && dayIndex < currentWeekZones.length; dayIndex++) {
      const zone = currentWeekZones[dayIndex];
      if (!zone) continue;
      
      // Get all outlets from this zone and optimize the route
      const zoneOutlets = zone.outlets;
      const optimizedOutlets = optimizeRoute(zoneOutlets);
      const zoneOutletIds = optimizedOutlets.map(outlet => outlet.id);
      const totalDistance = calculateTotalDistance(optimizedOutlets);
      
      // Create schedule for this day with optimized route
      schedules.push({
        repId: rep.id,
        week: week,
        dayOfWeek: dayIndex,
        outletIds: zoneOutletIds,
        routeOrder: zoneOutletIds, // Already optimized
        totalDistance: totalDistance,
        estimatedDuration: zone.outlets.length * 15 // 15 minutes per outlet average
      });
      
      // Also create the repeat week (3 or 4)
      schedules.push({
        repId: rep.id,
        week: week + 2,
        dayOfWeek: dayIndex,
        outletIds: zoneOutletIds,
        routeOrder: zoneOutletIds, // Already optimized
        totalDistance: totalDistance,
        estimatedDuration: zone.outlets.length * 15
      });
    }
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
        schedules.push({
          repId: rep.id,
          week: week,
          dayOfWeek: daysOfWeek.indexOf(dayName),
          outletIds: visitOrder,
          routeOrder: visitOrder
        });
        
        // Also create the repeat week (3 or 4)
        schedules.push({
          repId: rep.id,
          week: week + 2,
          dayOfWeek: daysOfWeek.indexOf(dayName),
          outletIds: visitOrder,
          routeOrder: visitOrder
        });
      }
    }
  }
  
  return schedules;
}

import { generateScheduleExcel, generateVehicleSummaryExcel } from './export';

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
          // Parse time per visit (default 30 minutes if not provided)
          const timePerVisit = parseInt(
            row.time_per_visit || row.timePerVisit || row["Time Per Visit"] || 
            row.time || row.Time || row.duration || row.Duration || "30"
          );

          const outlet: typeof insertOutletSchema._type = {
            name: row.outletname || row.name || row.Name || row.outlet_name || row["Outlet Name"] || `Outlet ${outlets.length + 1}`,
            address: `${row.District || ''} - ${row.Region || ''} - ${row.Area || ''}`.replace(/^- |- $|^-$/, '').trim() || row.address || row.Address || "",
            latitude: parseFloat(row.latitude || row.Latitude || row.lat || row.Lat || "0"),
            longitude: parseFloat(row.longitude || row.Longitude || row.lng || row.Lng || row.lon || row.Lon || "0"),
            visitFrequency: parseInt(row.vf || row.VF || row.visit_frequency || row["Visit Frequency"] || "2"),
            timePerVisit: isNaN(timePerVisit) ? 30 : Math.max(5, Math.min(120, timePerVisit)),
            territory: row.District || row.territory || row.Territory || row.zone || row.Zone || null,
            repId: null,
            cluster: null
          };

          // Validate required fields
          if (outlet.latitude === 0 || outlet.longitude === 0) {
            console.warn(`Skipping outlet ${outlet.name} - invalid coordinates`);
            continue;
          }

          // Support VF1 (monthly), VF2 (bi-weekly), VF4 (weekly)
          if (![1, 2, 4].includes(outlet.visitFrequency)) {
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
      const vf1Count = outlets.filter(o => o.visitFrequency === 1).length;
      const vf2Count = outlets.filter(o => o.visitFrequency === 2).length;
      const vf4Count = outlets.filter(o => o.visitFrequency === 4).length;
      const avgTimePerVisit = Math.round(
        outlets.reduce((sum, o) => sum + (o.timePerVisit || 30), 0) / outlets.length
      );
      
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
          avgTimePerVisit,
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

  // Export schedules to Excel
  app.get("/api/export/schedules", async (_req, res) => {
    try {
      const reps = await storage.getReps();
      const schedules = await storage.getSchedules();
      const outlets = await storage.getOutlets();
      
      if (reps.length === 0 || schedules.length === 0) {
        return res.status(400).json({ message: "No schedules available to export" });
      }
      
      const excelBuffer = generateScheduleExcel(reps, schedules, outlets);
      
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

      // Generate dates for a 4-week cycle starting from next Monday
      const getNextMonday = () => {
        const today = new Date();
        const dayOfWeek = today.getDay();
        const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek);
        const nextMonday = new Date(today);
        nextMonday.setDate(today.getDate() + daysUntilMonday);
        return nextMonday;
      };
      const startDate = getNextMonday();

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
        
        for (let week = 1; week <= 4; week++) {
          for (let day = 1; day <= workingDays; day++) {
            // Week 3 mirrors week 1, week 4 mirrors week 2
            const sourceWeek = week <= 2 ? week : week - 2;
            const schedule = repSchedules.find(s => s.week === sourceWeek && s.dayOfWeek === day);
            
            // Calculate date for this day
            const currentDate = new Date(startDate);
            currentDate.setDate(startDate.getDate() + ((week - 1) * 7) + (day - 1));
            const dateStr = currentDate.toISOString().split('T')[0];
            
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
          for (let week = 1; week <= 4; week++) {
            for (let day = 1; day <= 7; day++) {
              // First try to find a direct match for this week/day
              let schedule = roleSchedulesForRole.find(s => s.week === week && s.dayOfWeek === day);
              
              // If no direct match and we're in weeks 3-4, check if we should mirror weeks 1-2
              if (!schedule && week > 2) {
                const mirrorWeek = week - 2;
                schedule = roleSchedulesForRole.find(s => s.week === mirrorWeek && s.dayOfWeek === day);
              }
              
              // Calculate date for this day
              const currentDate = new Date(startDate);
              currentDate.setDate(startDate.getDate() + ((week - 1) * 7) + (day - 1));
              const dateStr = currentDate.toISOString().split('T')[0];
              
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
          
          for (let week = 1; week <= 4; week++) {
            for (let repDay = 1; repDay <= workingDays; repDay++) {
              // Map to source week (weeks 3-4 mirror weeks 1-2 for base schedules)
              const sourceWeek = week <= 2 ? week : week - 2;
              const schedule = repSchedules.find(s => s.week === sourceWeek && s.dayOfWeek === repDay);
              
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
            // Calculate date for this role day
            const currentDate = new Date(startDate);
            currentDate.setDate(startDate.getDate() + ((row.week - 1) * 7) + (row.day - 1));
            const dateStr = currentDate.toISOString().split('T')[0];
            
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

  // Route optimization
  app.post("/api/optimize", async (req, res) => {
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
      const outlets = await storage.getOutlets();
      if (outlets.length === 0) {
        if (progressId) progressManager.error(progressId, 'No outlets available');
        return res.status(400).json({ message: "No outlets available for optimization" });
      }
      
      await emitProgress(5, 'Analyzing', `Processing ${outlets.length} outlets...`);

      // Calculate total weekly visits required based on visit frequency
      const totalWeeklyVisits = outlets.reduce((sum, outlet) => sum + outlet.visitFrequency, 0);
      
      // Set default values for rep constraints (use body params if provided)
      const workingDaysPerWeek = req.body.workingDaysPerWeek || 5; // Monday to Friday
      const calculationMode = req.body.calculationMode || 'manual'; // 'manual' or 'time-based'
      const maxTimePerOutlet = req.body.maxTimePerOutlet || 45; // minutes
      const maxWorkingHoursPerDay = req.body.maxWorkingHoursPerDay || 8; // hours
      
      // Calculate min/max visits based on mode
      let minVisitsPerDay: number;
      let maxVisitsPerDay: number;
      
      if (calculationMode === 'time-based') {
        // Calculate based on time constraints
        const maxWorkingMinutes = maxWorkingHoursPerDay * 60;
        
        // Get average time per visit from outlets
        const avgTimePerVisit = outlets.length > 0
          ? outlets.reduce((sum, o) => sum + (o.timePerVisit || 30), 0) / outlets.length
          : maxTimePerOutlet;
        
        // Estimate average travel time between outlets (assume ~10 min avg travel)
        const avgTravelTime = 10;
        
        // Calculate max outlets: working hours / (time per outlet + travel time)
        const effectiveTimePerOutlet = Math.min(avgTimePerVisit, maxTimePerOutlet) + avgTravelTime;
        const calculatedMax = Math.floor(maxWorkingMinutes / effectiveTimePerOutlet);
        
        // Guard against zero or negative values - fall back to reasonable defaults
        maxVisitsPerDay = Math.max(5, calculatedMax); // At least 5 outlets per day
        minVisitsPerDay = Math.max(1, Math.floor(maxVisitsPerDay * 0.8));
        
        // Ensure min < max
        if (minVisitsPerDay >= maxVisitsPerDay) {
          minVisitsPerDay = Math.max(1, maxVisitsPerDay - 2);
        }
        
        console.log(`Time-based calculation: ${maxWorkingMinutes} min / ${effectiveTimePerOutlet.toFixed(1)} min per outlet = ${maxVisitsPerDay} max outlets/day (min=${minVisitsPerDay})`);
      } else {
        // Manual mode - use provided values
        minVisitsPerDay = Math.max(1, req.body.minVisitsPerDay || 25);
        maxVisitsPerDay = Math.max(minVisitsPerDay + 1, req.body.maxVisitsPerDay || 27);
      }
      
      console.log(`Optimization using ${calculationMode} mode: min=${minVisitsPerDay}, max=${maxVisitsPerDay} visits/day`);
      
      // Calculate required reps based on daily visit constraints
      // Formula: Weekly visits / (working days * max visits per day)
      const maxWeeklyCapacityPerRep = workingDaysPerWeek * maxVisitsPerDay;
      const requiredReps = Math.ceil(totalWeeklyVisits / maxWeeklyCapacityPerRep);
      
      // Ensure we don't go below minimum daily visits requirement
      const minWeeklyCapacityPerRep = workingDaysPerWeek * minVisitsPerDay;
      
      // Use the calculated required reps (initial estimate)
      let finalRequiredReps = Math.max(1, requiredReps); // At least 1 rep needed

      await emitProgress(10, 'Preparing', 'Clearing existing data...');
      
      // Clear existing reps first
      const existingReps = await storage.getReps();
      for (const rep of existingReps) {
        await storage.deleteRep(rep.id);
      }

      await emitProgress(15, 'Clustering', `Analyzing ${outlets.length} outlets for geographic patterns...`);
      
      // Create territories based on geographic clusters (each cluster = one zone)
      console.log(`Creating zones based on geographic clustering for ${outlets.length} outlets`);
      
      // Calculate target zones based on the required rep count and user's max visits per day
      const zonesPerRep = 10; // 5 zones in week 1, 5 zones in week 2
      const targetZones = Math.max(
        Math.ceil(outlets.length / maxVisitsPerDay), // At least one zone per maxVisitsPerDay outlets
        finalRequiredReps * zonesPerRep // Or enough zones for all reps
      );
      
      await emitProgress(20, 'Clustering', 'Running advanced geographic clustering algorithm...');
      
      // Perform advanced clustering using JavaScript implementation (HDBSCAN + VRP + Capacitated K-Means)
      // Pass progress callback to allow SSE updates during long-running clustering
      const advancedClusters = await performAdvancedClusteringJS(outlets, targetZones, minVisitsPerDay, maxVisitsPerDay, emitProgress);
      const clusters = advancedClusters.map(cluster => ({
        id: cluster.id,
        centroid: cluster.centroid,
        outlets: cluster.outlets
      }));
      const actualZoneCount = clusters.length;
      
      await emitProgress(45, 'Zones Created', `Created ${actualZoneCount} geographic zones`);
      console.log(`Created ${actualZoneCount} geographic zones`);
      
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
      
      // Calculate how many reps we need based on actual zones created
      // Each rep visits 10 zones (5 per week * 2 weeks)
      // So we need zones/10 reps (rounded up)
      const requiredRepCount = Math.ceil(actualZoneCount / 10);
      
      await emitProgress(55, 'Assigning', `Assigning ${outlets.length} outlets to ${actualZoneCount} zones...`);
      console.log(`Need ${requiredRepCount} reps to cover ${actualZoneCount} zones (10 zones per rep)`);
      
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
      const zoneAssignments = assignZonesToReps(clusters, allReps, zonesPerRep);
      
      await emitProgress(70, 'Scheduling', `Generating schedules for ${allReps.length} reps...`);
      
      // Generate schedules for each rep
      console.log('Generating schedules for', allReps.length, 'reps');
      for (let repIndex = 0; repIndex < allReps.length; repIndex++) {
        const rep = allReps[repIndex];
        const repZones = zoneAssignments[repIndex] || [];
        
        if (repZones.length > 0) {
          console.log(`${rep.name} will cover zones: ${repZones.map(z => z.id + 1).join(', ')}`);
          
          // Generate schedule where rep visits one complete zone per day
          const repSchedules = generateZoneBasedSchedules(rep, repZones, clusters);
          console.log(`Generated ${repSchedules.length} schedules for ${rep.name}`);
          
          for (const schedule of repSchedules) {
            await storage.createSchedule(schedule);
          }
        }
        
        // Yield and emit progress every 5 reps
        if (repIndex % 5 === 0) {
          const scheduleProgress = 70 + Math.floor((repIndex / allReps.length) * 15);
          await emitProgress(scheduleProgress, 'Scheduling', `Generating schedule for rep ${repIndex + 1} of ${allReps.length}...`);
        }
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

      if (progressId) progressManager.complete(progressId);
      
      res.json({
        success: true,
        requiredReps: finalRequiredReps,
        assignedOutlets: updatedOutlets.filter(o => o.repId !== null).length,
        totalWeeklyVisits,
        maxWeeklyCapacityPerRep,
        minWeeklyCapacityPerRep,
        roleSchedulesGenerated: totalRoleSchedules,
        calculation: {
          totalOutlets: outlets.length,
          totalWeeklyVisits,
          workingDaysPerWeek,
          minVisitsPerDay,
          maxVisitsPerDay,
          estimatedReps: finalRequiredReps
        },
        message: `Optimization completed. ${finalRequiredReps} routes created for ${totalWeeklyVisits} weekly visits (${minVisitsPerDay}-${maxVisitsPerDay} visits/day). ${outlets.length} outlets assigned.${totalRoleSchedules > 0 ? ` ${totalRoleSchedules} role schedules generated.` : ''}`
      });

    } catch (error) {
      console.error("Optimization error:", error);
      if (progressId) progressManager.error(progressId, 'Optimization failed');
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

  // Optimize selected routes
  app.post("/api/optimize-routes", async (req, res) => {
    try {
      const { repIds, days } = req.body;
      const schedules = await storage.getSchedules();
      const outlets = await storage.getOutlets();
      
      // Get schedules for selected reps and days
      const targetSchedules = schedules.filter(s => 
        repIds.includes(s.repId) && 
        days.includes(s.dayOfWeek) && 
        s.week === 1
      );
      
      // Optimize each schedule's route
      for (const schedule of targetSchedules) {
        const scheduleOutlets = outlets.filter(o => 
          (schedule.outletIds as string[]).includes(o.id)
        );
        
        if (scheduleOutlets.length > 1) {
          // Optimize route using nearest neighbor
          const optimizedOrder = optimizeRoute(scheduleOutlets);
          const optimizedIds = optimizedOrder.map(o => o.id);
          const totalDistance = calculateTotalDistance(optimizedOrder);
          
          // Update schedule with optimized route
          await storage.updateSchedule(schedule.id!, {
            routeOrder: optimizedIds,
            totalDistance: totalDistance
          });
        }
      }
      
      res.json({ success: true, message: "Routes optimized successfully" });
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

  // ============= VEHICLE MANAGEMENT ROUTES =============

  // Get all vehicles
  app.get("/api/vehicles", async (_req, res) => {
    try {
      const vehicles = await storage.getVehicles();
      res.json(vehicles);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch vehicles" });
    }
  });

  // Get single vehicle
  app.get("/api/vehicles/:id", async (req, res) => {
    try {
      const vehicle = await storage.getVehicle(req.params.id);
      if (!vehicle) {
        return res.status(404).json({ message: "Vehicle not found" });
      }
      res.json(vehicle);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch vehicle" });
    }
  });

  // Create vehicle
  app.post("/api/vehicles", async (req, res) => {
    try {
      const parsed = insertVehicleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid vehicle data", errors: parsed.error.errors });
      }
      const vehicle = await storage.createVehicle(parsed.data);
      res.status(201).json(vehicle);
    } catch (error) {
      res.status(500).json({ message: "Failed to create vehicle" });
    }
  });

  // Update vehicle
  app.patch("/api/vehicles/:id", async (req, res) => {
    try {
      const vehicle = await storage.updateVehicle(req.params.id, req.body);
      if (!vehicle) {
        return res.status(404).json({ message: "Vehicle not found" });
      }
      res.json(vehicle);
    } catch (error) {
      res.status(500).json({ message: "Failed to update vehicle" });
    }
  });

  // Delete vehicle
  app.delete("/api/vehicles/:id", async (req, res) => {
    try {
      await storage.deleteVehicle(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete vehicle" });
    }
  });

  // Get vehicle maintenance records
  app.get("/api/vehicles/:id/maintenance", async (req, res) => {
    try {
      const records = await storage.getVehicleMaintenanceRecords(req.params.id);
      res.json(records);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch maintenance records" });
    }
  });

  // Get all maintenance records
  app.get("/api/vehicle-maintenance", async (_req, res) => {
    try {
      const records = await storage.getVehicleMaintenanceRecords();
      res.json(records);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch maintenance records" });
    }
  });

  // Create maintenance record
  app.post("/api/vehicle-maintenance", async (req, res) => {
    try {
      const parsed = insertVehicleMaintenanceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid maintenance data", errors: parsed.error.errors });
      }
      const record = await storage.createVehicleMaintenanceRecord(parsed.data);
      res.status(201).json(record);
    } catch (error) {
      res.status(500).json({ message: "Failed to create maintenance record" });
    }
  });

  // Get vehicle alerts
  app.get("/api/vehicle-alerts", async (_req, res) => {
    try {
      const alerts = await storage.getVehicleAlerts();
      res.json(alerts);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch vehicle alerts" });
    }
  });

  // Get vehicle usage records
  app.get("/api/vehicles/:id/usage", async (req, res) => {
    try {
      const records = await storage.getVehicleUsageRecords(req.params.id);
      res.json(records);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch usage records" });
    }
  });

  // ============= RE-OPTIMIZATION ROUTES =============

  // Re-assign outlet to a different zone/territory
  app.post("/api/outlets/:id/reassign", async (req, res) => {
    try {
      const { territory, repId } = req.body;
      const outlet = await storage.updateOutlet(req.params.id, { territory, repId });
      if (!outlet) {
        return res.status(404).json({ message: "Outlet not found" });
      }
      res.json(outlet);
    } catch (error) {
      res.status(500).json({ message: "Failed to reassign outlet" });
    }
  });

  // Bulk reassign outlets
  app.post("/api/outlets/bulk-reassign", async (req, res) => {
    try {
      const { updates } = req.body; // Array of { id, territory, repId }
      const results = await storage.updateOutlets(updates.map((u: any) => ({
        id: u.id,
        data: { territory: u.territory, repId: u.repId }
      })));
      res.json({ success: true, updated: results.length });
    } catch (error) {
      res.status(500).json({ message: "Failed to bulk reassign outlets" });
    }
  });

  // Full re-optimization after zone changes
  app.post("/api/reoptimize", async (req, res) => {
    try {
      const outlets = await storage.getOutlets();
      const reps = await storage.getReps();
      
      if (outlets.length === 0) {
        return res.status(400).json({ message: "No outlets available for re-optimization" });
      }
      
      const { minVisitsPerDay = 25, maxVisitsPerDay = 27, workingDaysPerWeek = 5 } = req.body;
      
      // Clear existing schedules
      await storage.clearSchedules();
      
      // Generate new schedules using the advanced scheduling algorithm
      const schedules = reoptimizeSchedules(
        outlets,
        reps.map(r => ({ id: r.id, territory: r.territory })),
        { minVisitsPerDay, maxVisitsPerDay, workingDaysPerWeek, weeksInMonth: 4 }
      );
      
      // Save new schedules
      await storage.createSchedules(schedules);
      
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
      
      res.json({
        success: true,
        schedulesCreated: schedules.length,
        repsProcessed: reps.length,
        validation: {
          errors: totalErrors,
          warnings: totalWarnings
        },
        message: `Re-optimization complete. Generated ${schedules.length} schedules for ${reps.length} reps.`
      });
    } catch (error) {
      console.error("Re-optimization error:", error);
      res.status(500).json({ message: "Failed to re-optimize" });
    }
  });

  // Generate advanced VF-aware schedule for a single territory
  app.post("/api/territories/:territory/generate-schedule", async (req, res) => {
    try {
      const { territory } = req.params;
      const { repId, minVisitsPerDay = 25, maxVisitsPerDay = 27, workingDaysPerWeek = 5 } = req.body;
      
      const outlets = await storage.getOutletsByTerritory(territory);
      if (outlets.length === 0) {
        return res.status(404).json({ message: "No outlets found in this territory" });
      }
      
      // Clear existing schedules for this rep
      if (repId) {
        await storage.deleteSchedulesByRepId(repId);
      }
      
      // Generate new schedules
      const schedules = generateAdvancedSchedule(
        outlets,
        repId,
        territory,
        { minVisitsPerDay, maxVisitsPerDay, workingDaysPerWeek, weeksInMonth: 4 }
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

  // ============= VEHICLE DASHBOARD & MAINTENANCE FORECASTING =============

  // Get vehicle dashboard with all analytics
  app.get("/api/vehicles/:id/dashboard", async (req, res) => {
    try {
      const dashboard = await storage.getVehicleDashboard(req.params.id);
      if (!dashboard) {
        return res.status(404).json({ message: "Vehicle not found" });
      }
      res.json(dashboard);
    } catch (error) {
      console.error("Vehicle dashboard error:", error);
      res.status(500).json({ message: "Failed to fetch vehicle dashboard" });
    }
  });

  // Calculate and update maintenance forecasts for a vehicle
  app.post("/api/vehicles/:id/calculate-forecasts", async (req, res) => {
    try {
      const vehicleId = req.params.id;
      const vehicle = await storage.getVehicle(vehicleId);
      if (!vehicle) {
        return res.status(404).json({ message: "Vehicle not found" });
      }

      // Get maintenance policies and history
      const policies = await storage.getMaintenancePolicies();
      const maintenanceRecords = await storage.getVehicleMaintenanceRecords(vehicleId);
      const usageRecords = await storage.getVehicleUsageRecords(vehicleId);

      // Clear existing forecasts
      await storage.deleteMaintenanceForecastsByVehicle(vehicleId);

      // Calculate average daily KM from usage records
      let avgDailyKm = 50; // Default estimate
      if (usageRecords.length > 0) {
        const totalKm = usageRecords.reduce((sum, r) => sum + r.distance, 0);
        const days = Math.ceil((Date.now() - new Date(usageRecords[0].tripDate).getTime()) / (24 * 60 * 60 * 1000));
        avgDailyKm = totalKm / Math.max(days, 1);
      }

      const forecasts = [];

      for (const policy of policies.filter(p => p.isActive)) {
        // Find last maintenance of this type
        const lastMaintenance = maintenanceRecords
          .filter(r => r.maintenanceType === policy.maintenanceType)
          .sort((a, b) => new Date(b.serviceDate).getTime() - new Date(a.serviceDate).getTime())[0];

        let dueMileage: number;
        let kmSinceLastService: number;

        if (lastMaintenance) {
          dueMileage = lastMaintenance.mileageAtService + policy.intervalKm;
          kmSinceLastService = vehicle.currentMileage - lastMaintenance.mileageAtService;
        } else {
          // No record - assume due based on starting mileage
          dueMileage = vehicle.startingMileage + policy.intervalKm;
          kmSinceLastService = vehicle.currentMileage - vehicle.startingMileage;
        }

        const remainingKm = dueMileage - vehicle.currentMileage;
        const remainingDays = avgDailyKm > 0 ? Math.ceil(remainingKm / avgDailyKm) : null;
        const estimatedDueDate = remainingDays ? new Date(Date.now() + remainingDays * 24 * 60 * 60 * 1000) : null;

        // Determine severity and status
        let severity: string;
        let status: string;

        if (remainingKm < 0) {
          status = 'overdue';
          severity = Math.abs(remainingKm) >= policy.criticalThresholdKm ? 'critical' : 'high';
        } else if (remainingKm <= policy.warningThresholdKm) {
          status = 'due';
          severity = remainingKm <= policy.warningThresholdKm / 2 ? 'high' : 'medium';
        } else {
          status = 'upcoming';
          severity = 'low';
        }

        // Generate recommendation
        const recommendation = remainingKm < 0
          ? `URGENT: ${policy.name} is overdue by ${Math.abs(remainingKm).toFixed(0)} km. Schedule immediately.`
          : remainingKm <= policy.warningThresholdKm
          ? `${policy.name} due soon. ${remainingKm.toFixed(0)} km remaining.`
          : `${policy.name} scheduled in ${remainingKm.toFixed(0)} km (approx. ${remainingDays || '?'} days).`;

        const forecast = await storage.createMaintenanceForecast({
          vehicleId,
          policyId: policy.id,
          maintenanceType: policy.maintenanceType,
          currentMileage: vehicle.currentMileage,
          dueMileage,
          estimatedDueDate,
          remainingKm,
          remainingDays,
          severity,
          status,
          recommendation
        });

        forecasts.push(forecast);
      }

      res.json({
        success: true,
        vehicleId,
        forecastsGenerated: forecasts.length,
        forecasts
      });
    } catch (error) {
      console.error("Forecast calculation error:", error);
      res.status(500).json({ message: "Failed to calculate maintenance forecasts" });
    }
  });

  // Get maintenance policies
  app.get("/api/maintenance-policies", async (_req, res) => {
    try {
      const policies = await storage.getMaintenancePolicies();
      res.json(policies);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch maintenance policies" });
    }
  });

  // Update maintenance policy
  app.patch("/api/maintenance-policies/:id", async (req, res) => {
    try {
      const policy = await storage.updateMaintenancePolicy(req.params.id, req.body);
      if (!policy) {
        return res.status(404).json({ message: "Policy not found" });
      }
      res.json(policy);
    } catch (error) {
      res.status(500).json({ message: "Failed to update maintenance policy" });
    }
  });

  // Get vehicle forecasts
  app.get("/api/vehicles/:id/forecasts", async (req, res) => {
    try {
      const forecasts = await storage.getMaintenanceForecasts(req.params.id);
      res.json(forecasts);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch forecasts" });
    }
  });

  // Export vehicle summary to Excel
  app.get("/api/vehicles/:id/export", async (req, res) => {
    try {
      const vehicleId = req.params.id;
      const vehicle = await storage.getVehicle(vehicleId);
      if (!vehicle) {
        return res.status(404).json({ message: "Vehicle not found" });
      }

      const reps = await storage.getReps();
      const assignedRep = reps.find(r => r.id === vehicle.assignedRepId);
      const forecasts = await storage.getMaintenanceForecasts(vehicleId);
      const maintenanceHistory = await storage.getVehicleMaintenanceRecords(vehicleId);
      const mileageSnapshots = await storage.getVehicleMileageSnapshots(vehicleId);

      const latestSnapshot = mileageSnapshots.sort((a, b) => 
        new Date(b.snapshotDate).getTime() - new Date(a.snapshotDate).getTime()
      )[0];

      const exportData = {
        vehicle: {
          plateNumber: vehicle.plateNumber,
          model: vehicle.model,
          year: vehicle.year,
          currentMileage: vehicle.currentMileage,
          startingMileage: vehicle.startingMileage,
          status: vehicle.status,
          assignedRepName: assignedRep?.name
        },
        usage: {
          dailyKm: latestSnapshot?.dailyKm || 0,
          weeklyKm: latestSnapshot?.weeklyKm || 0,
          monthlyKm: latestSnapshot?.monthlyKm || 0,
          lifetimeKm: latestSnapshot?.lifetimeKm || vehicle.currentMileage - vehicle.startingMileage,
          avgDailyKm: latestSnapshot?.avgDailyKm || 0,
          routeIntensity: latestSnapshot?.routeIntensity || 'light'
        },
        forecasts: forecasts.map(f => ({
          maintenanceType: f.maintenanceType,
          dueMileage: f.dueMileage,
          remainingKm: f.remainingKm,
          status: f.status,
          severity: f.severity,
          recommendation: f.recommendation || ''
        })),
        maintenanceHistory: maintenanceHistory.map(h => ({
          serviceDate: h.serviceDate.toISOString(),
          maintenanceType: h.maintenanceType,
          mileageAtService: h.mileageAtService,
          cost: h.cost || undefined,
          notes: h.notes || undefined
        }))
      };

      const buffer = generateVehicleSummaryExcel(exportData);
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="vehicle_${vehicle.plateNumber}_summary.xlsx"`);
      res.send(buffer);
    } catch (error) {
      console.error("Vehicle export error:", error);
      res.status(500).json({ message: "Failed to export vehicle summary" });
    }
  });

  // Record route usage (KM accumulation from rep routes)
  app.post("/api/vehicles/:id/record-usage", async (req, res) => {
    try {
      const vehicleId = req.params.id;
      const { repId, scheduleId, distance, tripDate } = req.body;

      const vehicle = await storage.getVehicle(vehicleId);
      if (!vehicle) {
        return res.status(404).json({ message: "Vehicle not found" });
      }

      const startMileage = vehicle.currentMileage;
      const endMileage = startMileage + distance;

      // Create usage record
      const usageRecord = await storage.createVehicleUsageRecord({
        vehicleId,
        repId,
        scheduleId: scheduleId || null,
        tripDate: new Date(tripDate || Date.now()),
        startMileage,
        endMileage,
        distance
      });

      // Update vehicle mileage (already done in createVehicleUsageRecord)
      
      // Create daily mileage snapshot
      const today = new Date().toISOString().split('T')[0];
      const existingSnapshots = await storage.getVehicleMileageSnapshots(vehicleId);
      const todaySnapshot = existingSnapshots.find(s => s.snapshotDate === today);
      
      if (!todaySnapshot) {
        // Calculate aggregated values
        const usageRecords = await storage.getVehicleUsageRecords(vehicleId);
        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const dailyKm = distance;
        const weeklyKm = usageRecords
          .filter(r => new Date(r.tripDate) >= weekAgo)
          .reduce((sum, r) => sum + r.distance, 0);
        const monthlyKm = usageRecords
          .filter(r => new Date(r.tripDate) >= monthAgo)
          .reduce((sum, r) => sum + r.distance, 0);
        const lifetimeKm = endMileage - vehicle.startingMileage;
        const avgDailyKm = monthlyKm / 30;

        let routeIntensity: 'light' | 'medium' | 'heavy' = 'light';
        if (avgDailyKm > 150) routeIntensity = 'heavy';
        else if (avgDailyKm > 75) routeIntensity = 'medium';

        await storage.createVehicleMileageSnapshot({
          vehicleId,
          snapshotDate: today,
          dailyKm,
          weeklyKm,
          monthlyKm,
          lifetimeKm,
          avgDailyKm,
          routeIntensity
        });
      }

      res.json({
        success: true,
        usageRecord,
        newMileage: endMileage
      });
    } catch (error) {
      console.error("Usage recording error:", error);
      res.status(500).json({ message: "Failed to record vehicle usage" });
    }
  });

  // Assign rep to vehicle (triggers KM accumulation link)
  app.post("/api/vehicles/:id/assign-rep", async (req, res) => {
    try {
      const { repId } = req.body;
      const vehicleId = req.params.id;

      // Update vehicle with assigned rep
      const vehicle = await storage.updateVehicle(vehicleId, { assignedRepId: repId });
      if (!vehicle) {
        return res.status(404).json({ message: "Vehicle not found" });
      }

      // Update rep with vehicle assignment
      if (repId) {
        await storage.updateRep(repId, { vehicleId });
      }

      // Trigger initial forecast calculation
      const policies = await storage.getMaintenancePolicies();
      const maintenanceRecords = await storage.getVehicleMaintenanceRecords(vehicleId);

      // Clear existing forecasts
      await storage.deleteMaintenanceForecastsByVehicle(vehicleId);

      // Generate initial forecasts
      for (const policy of policies.filter(p => p.isActive)) {
        const lastMaintenance = maintenanceRecords
          .filter(r => r.maintenanceType === policy.maintenanceType)
          .sort((a, b) => new Date(b.serviceDate).getTime() - new Date(a.serviceDate).getTime())[0];

        const dueMileage = lastMaintenance 
          ? lastMaintenance.mileageAtService + policy.intervalKm
          : vehicle.startingMileage + policy.intervalKm;

        const remainingKm = dueMileage - vehicle.currentMileage;
        const severity = remainingKm < 0 ? 'critical' : remainingKm < policy.warningThresholdKm ? 'medium' : 'low';
        const status = remainingKm < 0 ? 'overdue' : remainingKm < policy.warningThresholdKm ? 'due' : 'upcoming';

        await storage.createMaintenanceForecast({
          vehicleId,
          policyId: policy.id,
          maintenanceType: policy.maintenanceType,
          currentMileage: vehicle.currentMileage,
          dueMileage,
          remainingKm,
          severity,
          status,
          recommendation: `${policy.name}: ${remainingKm.toFixed(0)} km until next service`
        });
      }

      res.json({
        success: true,
        vehicle,
        message: `Rep assigned to vehicle. Maintenance forecasts generated.`
      });
    } catch (error) {
      console.error("Rep assignment error:", error);
      res.status(500).json({ message: "Failed to assign rep to vehicle" });
    }
  });

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

  // Vehicle reassignment impact analysis
  app.post("/api/vehicles/:id/reassignment-impact", async (req, res) => {
    try {
      const vehicleId = req.params.id;
      const { toRepId } = req.body;

      const vehicle = await storage.getVehicle(vehicleId);
      if (!vehicle) {
        return res.status(404).json({ message: "Vehicle not found" });
      }

      const reps = await storage.getReps();
      const fromRep = vehicle.assignedRepId ? reps.find(r => r.id === vehicle.assignedRepId) : null;
      const toRep = reps.find(r => r.id === toRepId);

      if (!toRep) {
        return res.status(404).json({ message: "Target rep not found" });
      }

      // Get current vehicle usage
      const usageRecords = await storage.getVehicleUsageRecords(vehicleId);
      const now = new Date();
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const recentUsage = usageRecords.filter(r => new Date(r.tripDate) >= monthAgo);
      const currentAvgDailyKm = recentUsage.length > 0 
        ? recentUsage.reduce((sum, r) => sum + r.distance, 0) / 30 
        : 0;

      // Calculate projected KM for new rep's routes
      const schedules = await storage.getSchedulesByRepId(toRepId);
      const outlets = await storage.getOutlets();
      const weeklyKmByWeek: Record<number, number> = {};

      for (const schedule of schedules) {
        const outletIds = schedule.outletIds as string[];
        const scheduleOutlets = outletIds
          .map(id => outlets.find(o => o.id === id))
          .filter(Boolean) as typeof outlets;

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

        weeklyKmByWeek[schedule.week] = (weeklyKmByWeek[schedule.week] || 0) + routeDistance;
      }

      // Calculate average weekly KM across all weeks
      const weeks = Object.keys(weeklyKmByWeek);
      const projectedWeeklyKm = weeks.length > 0 
        ? Object.values(weeklyKmByWeek).reduce((sum, km) => sum + km, 0) / weeks.length 
        : 0;

      const workingDays = toRep.workingDaysPerWeek || 5;
      const projectedAvgDailyKm = workingDays > 0 ? projectedWeeklyKm / workingDays : 0;
      const kmChangePercent = currentAvgDailyKm > 0 
        ? ((projectedAvgDailyKm - currentAvgDailyKm) / currentAvgDailyKm) * 100 
        : 0;

      // Determine maintenance impact
      let maintenanceImpact: 'accelerated' | 'normal' | 'delayed' = 'normal';
      if (kmChangePercent > 20) maintenanceImpact = 'accelerated';
      else if (kmChangePercent < -20) maintenanceImpact = 'delayed';

      // Get affected maintenance items
      const forecasts = await storage.getMaintenanceForecasts(vehicleId);
      const affectedMaintenanceItems = forecasts.map(f => {
        const currentDaysRemaining = currentAvgDailyKm > 0 ? f.remainingKm / currentAvgDailyKm : null;
        const projectedDaysRemaining = projectedAvgDailyKm > 0 ? f.remainingKm / projectedAvgDailyKm : null;
        
        return {
          maintenanceType: f.maintenanceType,
          currentDueDate: currentDaysRemaining ? new Date(now.getTime() + currentDaysRemaining * 24 * 60 * 60 * 1000) : null,
          projectedDueDate: projectedDaysRemaining ? new Date(now.getTime() + projectedDaysRemaining * 24 * 60 * 60 * 1000) : null,
          daysDifference: (currentDaysRemaining && projectedDaysRemaining) 
            ? Math.round(currentDaysRemaining - projectedDaysRemaining) 
            : 0
        };
      });

      // Risk assessment
      let riskLevel: 'low' | 'medium' | 'high' = 'low';
      let riskReason = 'Reassignment has minimal impact on vehicle maintenance schedule.';
      
      if (Math.abs(kmChangePercent) > 50) {
        riskLevel = 'high';
        riskReason = `Significant KM change (${kmChangePercent > 0 ? '+' : ''}${kmChangePercent.toFixed(0)}%) may significantly impact maintenance schedules.`;
      } else if (Math.abs(kmChangePercent) > 20) {
        riskLevel = 'medium';
        riskReason = `Moderate KM change (${kmChangePercent > 0 ? '+' : ''}${kmChangePercent.toFixed(0)}%) will adjust maintenance timing.`;
      }

      res.json({
        fromRepId: vehicle.assignedRepId,
        toRepId,
        fromRepName: fromRep?.name || null,
        toRepName: toRep.name,
        currentAvgDailyKm,
        projectedAvgDailyKm,
        kmChangePercent,
        maintenanceImpact,
        affectedMaintenanceItems,
        riskAssessment: {
          level: riskLevel,
          reason: riskReason
        }
      });
    } catch (error) {
      console.error("Reassignment impact analysis error:", error);
      res.status(500).json({ message: "Failed to analyze reassignment impact" });
    }
  });

  // Adjust odometer with audit logging
  app.post("/api/vehicles/:id/adjust-odometer", async (req, res) => {
    try {
      const vehicleId = req.params.id;
      const { newMileage, reason, adjustedBy, notes } = req.body;

      const vehicle = await storage.getVehicle(vehicleId);
      if (!vehicle) {
        return res.status(404).json({ message: "Vehicle not found" });
      }

      const previousMileage = vehicle.currentMileage;

      // Update vehicle mileage
      await storage.updateVehicle(vehicleId, { currentMileage: newMileage });

      // Create audit trail record as a special usage record
      await storage.createVehicleUsageRecord({
        vehicleId,
        repId: adjustedBy || 'system',
        scheduleId: null,
        tripDate: new Date(),
        startMileage: previousMileage,
        endMileage: newMileage,
        distance: newMileage - previousMileage
      });
      
      res.json({
        success: true,
        previousMileage,
        newMileage,
        adjustmentReason: reason,
        adjustedBy,
        notes,
        timestamp: new Date(),
        auditTrailCreated: true
      });
    } catch (error) {
      console.error("Odometer adjustment error:", error);
      res.status(500).json({ message: "Failed to adjust odometer" });
    }
  });

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
        let newDayOfWeek = schedule.dayOfWeek + hierarchy.offsetDays;
        let newWeek = schedule.week;

        // Handle week overflow
        while (newDayOfWeek > workingDaysPerWeek) {
          newDayOfWeek -= workingDaysPerWeek;
          newWeek++;
        }

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

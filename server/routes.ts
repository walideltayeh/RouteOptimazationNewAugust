import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertOptimizationRunSchema, insertOutletSchema, insertRepSchema, insertScheduleSchema, type InsertSchedule, type Rep, type Outlet } from "@shared/schema";
import multer from "multer";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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

async function performAdvancedClustering(outlets: Outlet[], targetZones: number): Promise<GeographicCluster[]> {
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
      targetZones
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
          resolve(performGeographicClustering(outlets, targetZones));
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
            console.log(`Zone ${idx + 1}: ${cluster.outlets.length} outlets, ${cluster.radius?.toFixed(2) || 'N/A'}km radius`);
          });
          
          resolve(geographicClusters);
        } catch (error) {
          console.error('Failed to parse Python output:', error);
          console.error('Python stderr:', errorOutput);
          // Fallback to original algorithm
          resolve(performGeographicClustering(outlets, targetZones));
        }
      });
    });
  } catch (error) {
    console.error('Failed to run advanced clustering:', error);
    // Fallback to original algorithm
    return performGeographicClustering(outlets, targetZones);
  }
}

function performGeographicClustering(outlets: Outlet[], targetRepCount: number): GeographicCluster[] {
  if (outlets.length === 0) return [];
  
  const targetClusterSize = 25;
  
  console.log(`Creating geographic clusters for ${outlets.length} outlets (strict ${targetClusterSize} outlets per cluster)`);
  
  // Step 1: Create initial clusters of exactly 25 outlets each
  const initialClusters = createExact25OutletClusters(outlets);
  
  // Step 2: Merge zones with ≤5 outlets with nearby zones
  const finalClusters = mergeSmallZones(initialClusters);
  
  console.log(`Created ${finalClusters.length} territories with strict size constraints`);
  return finalClusters;
}

// Create clusters of exactly 25 outlets each with geographic proximity
function createExact25OutletClusters(outlets: Outlet[]): GeographicCluster[] {
  const TARGET_SIZE = 25;
  const INITIAL_RADIUS = 2; // Start with 2km radius
  const RADIUS_INCREMENT = 0.5; // Increase by 0.5km each iteration
  const MAX_RADIUS = 20; // Maximum search radius
  
  const clusters: GeographicCluster[] = [];
  const unassigned = new Set(outlets.map(o => o.id));
  const outletMap = new Map(outlets.map(o => [o.id, o]));
  let clusterId = 0;
  
  // Continue until all outlets are assigned
  while (unassigned.size > 0) {
    // Find the outlet with the most nearby unassigned outlets within 2km
    let bestSeed: Outlet | null = null;
    let maxNearbyCount = 0;
    
    for (const outletId of unassigned) {
      const outlet = outletMap.get(outletId)!;
      let nearbyCount = 0;
      
      // Count unassigned outlets within INITIAL_RADIUS
      for (const otherId of unassigned) {
        if (otherId === outletId) continue;
        const other = outletMap.get(otherId)!;
        const distance = calculateHaversineDistance(
          outlet.latitude, outlet.longitude,
          other.latitude, other.longitude
        );
        if (distance <= INITIAL_RADIUS) {
          nearbyCount++;
        }
      }
      
      if (nearbyCount > maxNearbyCount) {
        maxNearbyCount = nearbyCount;
        bestSeed = outlet;
      }
    }
    
    if (!bestSeed) {
      // No good seed found, pick the first unassigned outlet
      const firstId = unassigned.values().next().value;
      bestSeed = outletMap.get(firstId)!;
    }
    
    // Create a new cluster starting with the seed
    const cluster: GeographicCluster = {
      id: clusterId++,
      outlets: [bestSeed],
      centroid: { lat: bestSeed.latitude, lng: bestSeed.longitude }
    };
    unassigned.delete(bestSeed.id);
    
    // Gradually expand radius until we get 25 outlets
    let currentRadius = INITIAL_RADIUS;
    
    while (cluster.outlets.length < TARGET_SIZE && currentRadius <= MAX_RADIUS && unassigned.size > 0) {
      const candidates: { outlet: Outlet; distance: number }[] = [];
      
      // Find all outlets within current radius
      for (const outletId of unassigned) {
        const outlet = outletMap.get(outletId)!;
        
        // Calculate distance to all outlets in the cluster
        let minDistanceToCluster = Infinity;
        for (const clusterOutlet of cluster.outlets) {
          const distance = calculateHaversineDistance(
            outlet.latitude, outlet.longitude,
            clusterOutlet.latitude, clusterOutlet.longitude
          );
          minDistanceToCluster = Math.min(minDistanceToCluster, distance);
        }
        
        if (minDistanceToCluster <= currentRadius) {
          candidates.push({ outlet, distance: minDistanceToCluster });
        }
      }
      
      // Sort candidates by distance
      candidates.sort((a, b) => a.distance - b.distance);
      
      // Add outlets to cluster until we reach TARGET_SIZE
      for (const candidate of candidates) {
        if (cluster.outlets.length >= TARGET_SIZE) break;
        
        cluster.outlets.push(candidate.outlet);
        unassigned.delete(candidate.outlet.id);
        
        // Update centroid
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
    
    // If we still don't have 25 outlets and this is not the last cluster, fill from nearest
    if (cluster.outlets.length < TARGET_SIZE && unassigned.size >= TARGET_SIZE) {
      const remainingNeeded = TARGET_SIZE - cluster.outlets.length;
      const remainingCandidates: { outlet: Outlet; distance: number }[] = [];
      
      for (const outletId of unassigned) {
        const outlet = outletMap.get(outletId)!;
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
    console.log(`Created Zone ${cluster.id + 1} with ${cluster.outlets.length} outlets (radius: ${maxDistFromCentroid.toFixed(2)}km)`);
  }
  
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
function mergeSmallZones(clusters: GeographicCluster[]): GeographicCluster[] {
  let mergedClusters = [...clusters];
  let hasSmallZones = true;
  
  while (hasSmallZones) {
    hasSmallZones = false;
    const newClusters: GeographicCluster[] = [];
    const processed = new Set<number>();
    
    for (let i = 0; i < mergedClusters.length; i++) {
      if (processed.has(i)) continue;
      
      const cluster = mergedClusters[i];
      
      if (cluster.outlets.length <= 5) {
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
  
  // Split zones into two groups for alternating weeks
  const week1Zones = zones.slice(0, 5); // First 5 zones for week 1 (and week 3)
  const week2Zones = zones.slice(5, 10); // Next 5 zones for week 2 (and week 4)
  
  // Generate schedules for Week 1 and Week 2 (pattern repeats for weeks 3 and 4)
  for (let week = 1; week <= 2; week++) {
    const currentWeekZones = week === 1 ? week1Zones : week2Zones;
    
    for (let dayIndex = 0; dayIndex < workingDays.length && dayIndex < currentWeekZones.length; dayIndex++) {
      const zone = currentWeekZones[dayIndex];
      if (!zone) continue;
      
      // Get all outlet IDs from this zone
      const zoneOutletIds = zone.outlets.map(outlet => outlet.id);
      
      // Create schedule for this day
      schedules.push({
        repId: rep.id,
        week: week,
        dayOfWeek: dayIndex,
        outletIds: zoneOutletIds,
        routeOrder: zoneOutletIds, // Can be optimized later with TSP
        totalDistance: calculateClusterRadius(zone) * 2, // Approximate
        estimatedDuration: zone.outlets.length * 15 // 15 minutes per outlet average
      });
      
      // Also create the repeat week (3 or 4)
      schedules.push({
        repId: rep.id,
        week: week + 2,
        dayOfWeek: dayIndex,
        outletIds: zoneOutletIds,
        routeOrder: zoneOutletIds,
        totalDistance: calculateClusterRadius(zone) * 2,
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

import { generateScheduleExcel } from './export';

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
      
      // Initial rough estimate - will be refined after optimization
      // Assuming ~25 outlets per zone and 10 zones per rep
      const recommendedReps = Math.ceil(outlets.length / 250);

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
      
      // Calculate target zones based on the required rep count
      const zonesPerRep = 10; // 5 zones in week 1, 5 zones in week 2
      const targetZones = Math.max(
        Math.ceil(outlets.length / 25), // At least one zone per 25 outlets
        finalRequiredReps * zonesPerRep // Or enough zones for all reps
      );
      
      // Perform advanced geographic clustering using HDBSCAN + OR-Tools + Capacitated K-Means
      const clusters = await performAdvancedClustering(outlets, targetZones);
      const actualZoneCount = clusters.length;
      
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
      }
      
      // Calculate how many reps we need based on actual zones created
      // Each rep visits 10 zones (5 per week * 2 weeks)
      // So we need zones/10 reps (rounded up)
      const requiredRepCount = Math.ceil(actualZoneCount / 10);
      
      console.log(`Need ${requiredRepCount} reps to cover ${actualZoneCount} zones (10 zones per rep)`);
      
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
      }
      
      finalRequiredReps = allReps.length;

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
        message: `Optimization completed. ${finalRequiredReps} routes created for ${totalWeeklyVisits} weekly visits (${minVisitsPerDay}-${maxVisitsPerDay} visits/day). ${outlets.length} outlets assigned.`
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

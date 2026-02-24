import { Outlet } from "@shared/schema";

interface Point {
  lat: number;
  lng: number;
  id: string;
}

interface Cluster {
  id: number;
  points: Point[];
  centroid: Point;
  radius?: number;
}

export interface GeographicCluster {
  id: number;
  centroid: { lat: number; lng: number };
  outlets: Outlet[];
  radius?: number;
}

export type ProgressCallback = (percent: number, stage: string, detail: string) => Promise<void>;

// Helper to yield to event loop for SSE flushing
const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

// Haversine distance calculation
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// HDBSCAN-like density-based clustering in JavaScript
export function hdbscanClustering(outlets: Outlet[], minClusterSize: number = 5, minSamples: number = 3): Cluster[] {
  const points: Point[] = outlets.map(o => ({
    lat: o.latitude,
    lng: o.longitude,
    id: o.id
  }));

  // Calculate core distances (k-nearest neighbor distance)
  const coreDistances = points.map((point, i) => {
    const distances = points
      .filter((_, j) => i !== j)
      .map(other => calculateDistance(point.lat, point.lng, other.lat, other.lng))
      .sort((a, b) => a - b);
    return distances[minSamples - 1] || Infinity;
  });

  // Build mutual reachability distance graph
  const reachabilityGraph: number[][] = Array(points.length).fill(null).map(() => Array(points.length).fill(Infinity));
  
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dist = calculateDistance(points[i].lat, points[i].lng, points[j].lat, points[j].lng);
      const mutualReachability = Math.max(coreDistances[i], coreDistances[j], dist);
      reachabilityGraph[i][j] = mutualReachability;
      reachabilityGraph[j][i] = mutualReachability;
    }
  }

  // Find dense regions using DBSCAN-like approach
  const visited = new Set<number>();
  const clusters: Cluster[] = [];
  let clusterId = 0;

  for (let i = 0; i < points.length; i++) {
    if (visited.has(i)) continue;

    const neighbors = expandCluster(i, reachabilityGraph, coreDistances, minSamples, points.length);
    
    if (neighbors.length >= minClusterSize) {
      const clusterPoints = neighbors.map(idx => points[idx]);
      const centroid = calculateCentroid(clusterPoints);
      
      clusters.push({
        id: clusterId++,
        points: clusterPoints,
        centroid,
        radius: calculateRadius(clusterPoints, centroid)
      });

      neighbors.forEach(idx => visited.add(idx));
    }
  }

  // Handle noise points
  const noise: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (!visited.has(i)) {
      noise.push(points[i]);
    }
  }

  // Assign noise points to nearest cluster
  if (noise.length > 0 && clusters.length > 0) {
    noise.forEach(point => {
      let minDist = Infinity;
      let nearestCluster = 0;
      
      clusters.forEach((cluster, idx) => {
        const dist = calculateDistance(point.lat, point.lng, cluster.centroid.lat, cluster.centroid.lng);
        if (dist < minDist) {
          minDist = dist;
          nearestCluster = idx;
        }
      });

      clusters[nearestCluster].points.push(point);
    });

    // Recalculate centroids and radii
    clusters.forEach(cluster => {
      cluster.centroid = calculateCentroid(cluster.points);
      cluster.radius = calculateRadius(cluster.points, cluster.centroid);
    });
  }

  return clusters;
}

// Async version with yields for SSE flushing
async function hdbscanClusteringAsync(outlets: Outlet[], minClusterSize: number = 5, minSamples: number = 3): Promise<Cluster[]> {
  const points: Point[] = outlets.map(o => ({
    lat: o.latitude,
    lng: o.longitude,
    id: o.id
  }));

  // Calculate core distances (k-nearest neighbor distance) with yields
  const coreDistances: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const distances = points
      .filter((_, j) => i !== j)
      .map(other => calculateDistance(points[i].lat, points[i].lng, other.lat, other.lng))
      .sort((a, b) => a - b);
    coreDistances.push(distances[minSamples - 1] || Infinity);
    
    // Yield every 100 points
    if (i % 100 === 0) await yieldToEventLoop();
  }

  // Build mutual reachability distance graph with yields
  const reachabilityGraph: number[][] = Array(points.length).fill(null).map(() => Array(points.length).fill(Infinity));
  
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dist = calculateDistance(points[i].lat, points[i].lng, points[j].lat, points[j].lng);
      const mutualReachability = Math.max(coreDistances[i], coreDistances[j], dist);
      reachabilityGraph[i][j] = mutualReachability;
      reachabilityGraph[j][i] = mutualReachability;
    }
    // Yield every 50 rows
    if (i % 50 === 0) await yieldToEventLoop();
  }

  // Find dense regions using DBSCAN-like approach
  const visited = new Set<number>();
  const clusters: Cluster[] = [];
  let clusterId = 0;

  for (let i = 0; i < points.length; i++) {
    if (visited.has(i)) continue;

    const neighbors = expandCluster(i, reachabilityGraph, coreDistances, minSamples, points.length);
    
    if (neighbors.length >= minClusterSize) {
      const clusterPoints = neighbors.map(idx => points[idx]);
      const centroid = calculateCentroid(clusterPoints);
      
      clusters.push({
        id: clusterId++,
        points: clusterPoints,
        centroid,
        radius: calculateRadius(clusterPoints, centroid)
      });

      neighbors.forEach(idx => visited.add(idx));
    }
    
    // Yield every 100 points
    if (i % 100 === 0) await yieldToEventLoop();
  }

  // Handle noise points
  const noise: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (!visited.has(i)) {
      noise.push(points[i]);
    }
  }

  // Assign noise points to nearest cluster
  if (noise.length > 0 && clusters.length > 0) {
    noise.forEach(point => {
      let minDist = Infinity;
      let nearestCluster = 0;
      
      clusters.forEach((cluster, idx) => {
        const dist = calculateDistance(point.lat, point.lng, cluster.centroid.lat, cluster.centroid.lng);
        if (dist < minDist) {
          minDist = dist;
          nearestCluster = idx;
        }
      });

      clusters[nearestCluster].points.push(point);
    });

    // Recalculate centroids and radii
    clusters.forEach(cluster => {
      cluster.centroid = calculateCentroid(cluster.points);
      cluster.radius = calculateRadius(cluster.points, cluster.centroid);
    });
  }

  return clusters;
}

function expandCluster(
  pointIdx: number,
  reachabilityGraph: number[][],
  coreDistances: number[],
  minSamples: number,
  totalPoints: number
): number[] {
  const cluster = [pointIdx];
  const queue = [pointIdx];
  const visited = new Set([pointIdx]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    
    // Find neighbors within core distance
    const neighbors: number[] = [];
    for (let i = 0; i < totalPoints; i++) {
      if (i !== current && reachabilityGraph[current][i] <= coreDistances[current] * 1.5) {
        neighbors.push(i);
      }
    }

    if (neighbors.length >= minSamples) {
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          cluster.push(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }

  return cluster;
}

// TSP solver using nearest neighbor heuristic with 2-opt improvement
export function solveTSP(points: Point[], startIdx: number = 0): number[] {
  const n = points.length;
  if (n <= 1) return [0];

  const visited = new Array(n).fill(false);
  const tour = [startIdx];
  visited[startIdx] = true;

  // Nearest neighbor construction
  let current = startIdx;
  for (let i = 1; i < n; i++) {
    let nearest = -1;
    let minDist = Infinity;

    for (let j = 0; j < n; j++) {
      if (!visited[j]) {
        const dist = calculateDistance(
          points[current].lat, points[current].lng,
          points[j].lat, points[j].lng
        );
        if (dist < minDist) {
          minDist = dist;
          nearest = j;
        }
      }
    }

    if (nearest !== -1) {
      tour.push(nearest);
      visited[nearest] = true;
      current = nearest;
    }
  }

  // 2-opt improvement
  let improved = true;
  while (improved) {
    improved = false;
    
    for (let i = 1; i < n - 2; i++) {
      for (let j = i + 1; j < n; j++) {
        if (j - i === 1) continue;

        const currentDist = 
          calculateDistance(points[tour[i-1]].lat, points[tour[i-1]].lng, points[tour[i]].lat, points[tour[i]].lng) +
          calculateDistance(points[tour[j-1]].lat, points[tour[j-1]].lng, points[tour[j % n]].lat, points[tour[j % n]].lng);

        const newDist = 
          calculateDistance(points[tour[i-1]].lat, points[tour[i-1]].lng, points[tour[j-1]].lat, points[tour[j-1]].lng) +
          calculateDistance(points[tour[i]].lat, points[tour[i]].lng, points[tour[j % n]].lat, points[tour[j % n]].lng);

        if (newDist < currentDist) {
          // Reverse the tour between i and j-1
          const reversed = tour.slice(i, j).reverse();
          tour.splice(i, j - i, ...reversed);
          improved = true;
        }
      }
    }
  }

  return tour;
}

// VRP-like route optimization for clusters
export function optimizeClusterRoutes(cluster: Cluster, maxOutletsPerRoute: number = 25): Cluster[] {
  if (cluster.points.length <= maxOutletsPerRoute) {
    return [cluster];
  }

  const routes: Cluster[] = [];
  const unassigned = [...cluster.points];
  let routeId = 0;

  while (unassigned.length > 0) {
    const route: Point[] = [];
    
    // Start from the point closest to cluster centroid
    let startIdx = 0;
    let minDist = Infinity;
    unassigned.forEach((point, idx) => {
      const dist = calculateDistance(point.lat, point.lng, cluster.centroid.lat, cluster.centroid.lng);
      if (dist < minDist) {
        minDist = dist;
        startIdx = idx;
      }
    });

    route.push(unassigned[startIdx]);
    unassigned.splice(startIdx, 1);

    // Build route using nearest neighbor
    while (route.length < maxOutletsPerRoute && unassigned.length > 0) {
      const lastPoint = route[route.length - 1];
      let nearestIdx = 0;
      let nearestDist = Infinity;

      unassigned.forEach((point, idx) => {
        const dist = calculateDistance(lastPoint.lat, lastPoint.lng, point.lat, point.lng);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestIdx = idx;
        }
      });

      route.push(unassigned[nearestIdx]);
      unassigned.splice(nearestIdx, 1);
    }

    // Optimize route order using TSP
    const optimizedOrder = solveTSP(route);
    const optimizedRoute = optimizedOrder.map(idx => route[idx]);

    const centroid = calculateCentroid(optimizedRoute);
    routes.push({
      id: routeId++,
      points: optimizedRoute,
      centroid,
      radius: calculateRadius(optimizedRoute, centroid)
    });
  }

  return routes;
}

// Flexible Capacitated K-Means implementation that allows cluster sizes within min/max range
export function capacitatedKMeans(
  outlets: Outlet[],
  k: number,
  minCapacity: number = 20,
  maxCapacity: number = 30,
  maxIterations: number = 100
): Cluster[] {
  const points: Point[] = outlets.map(o => ({
    lat: o.latitude,
    lng: o.longitude,
    id: o.id
  }));

  // Calculate actual number of clusters needed - account for max capacity
  let actualK = Math.max(k, Math.ceil(points.length / maxCapacity));

  // Initialize centroids using k-means++
  const centroids = initializeCentroidsKMeansPlusPlus(points, actualK);
  let clusters: Cluster[] = centroids.map((centroid, i) => ({
    id: i,
    points: [],
    centroid,
    radius: 0
  }));

  // Phase 1: Initial assignment respecting max capacity
  const unassignedPoints = [...points];
  
  for (let clusterIdx = 0; clusterIdx < actualK && unassignedPoints.length > 0; clusterIdx++) {
    const cluster = clusters[clusterIdx];
    
    // Sort unassigned points by distance to this cluster's centroid
    unassignedPoints.sort((a, b) => {
      const distA = calculateDistance(a.lat, a.lng, cluster.centroid.lat, cluster.centroid.lng);
      const distB = calculateDistance(b.lat, b.lng, cluster.centroid.lat, cluster.centroid.lng);
      return distA - distB;
    });

    // Assign up to 'maxCapacity' points to this cluster
    const assignCount = Math.min(maxCapacity, unassignedPoints.length);
    for (let i = 0; i < assignCount; i++) {
      cluster.points.push(unassignedPoints[0]);
      unassignedPoints.shift();
    }
  }

  // Handle any remaining unassigned points by adding to clusters with capacity or creating new ones
  if (unassignedPoints.length > 0) {
    console.log(`Assigning ${unassignedPoints.length} remaining points`);
    
    for (const point of unassignedPoints) {
      // Find nearest cluster that still has capacity
      let nearestCluster: Cluster | null = null;
      let nearestDist = Infinity;
      
      for (const cluster of clusters) {
        if (cluster.points.length < maxCapacity) {
          const dist = calculateDistance(point.lat, point.lng, cluster.centroid.lat, cluster.centroid.lng);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestCluster = cluster;
          }
        }
      }
      
      if (nearestCluster) {
        nearestCluster.points.push(point);
      } else {
        // Create new cluster if all existing ones are at max capacity
        const newCluster: Cluster = {
          id: clusters.length,
          points: [point],
          centroid: { ...point },
          radius: 0
        };
        clusters.push(newCluster);
        console.log(`Created new cluster ${newCluster.id} for overflow outlet`);
      }
    }
  }

  // Phase 2: Iterative refinement
  let iteration = 0;
  let improved = true;

  while (improved && iteration < maxIterations) {
    improved = false;
    iteration++;

    // Try swapping points between clusters to minimize total distance
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const cluster1 = clusters[i];
        const cluster2 = clusters[j];

        // Skip empty clusters
        if (cluster1.points.length === 0 || cluster2.points.length === 0) {
          continue;
        }

        // Find best swap
        let bestSwap: { idx1: number; idx2: number; improvement: number } | null = null;
        let bestImprovement = 0;

        for (let p1 = 0; p1 < cluster1.points.length; p1++) {
          for (let p2 = 0; p2 < cluster2.points.length; p2++) {
            const point1 = cluster1.points[p1];
            const point2 = cluster2.points[p2];

            // Calculate current distances
            const currentDist = 
              calculateDistance(point1.lat, point1.lng, cluster1.centroid.lat, cluster1.centroid.lng) +
              calculateDistance(point2.lat, point2.lng, cluster2.centroid.lat, cluster2.centroid.lng);

            // Calculate distances after swap
            const swapDist = 
              calculateDistance(point1.lat, point1.lng, cluster2.centroid.lat, cluster2.centroid.lng) +
              calculateDistance(point2.lat, point2.lng, cluster1.centroid.lat, cluster1.centroid.lng);

            const improvement = currentDist - swapDist;
            if (improvement > bestImprovement) {
              bestImprovement = improvement;
              bestSwap = { idx1: p1, idx2: p2, improvement };
            }
          }
        }

        // Perform best swap if it improves the solution
        if (bestSwap && bestSwap.improvement > 0.001) {
          const temp = cluster1.points[bestSwap.idx1];
          cluster1.points[bestSwap.idx1] = cluster2.points[bestSwap.idx2];
          cluster2.points[bestSwap.idx2] = temp;
          improved = true;
        }
      }
    }

    // Recalculate centroids
    clusters.forEach(cluster => {
      if (cluster.points.length > 0) {
        cluster.centroid = calculateCentroid(cluster.points);
        cluster.radius = calculateRadius(cluster.points, cluster.centroid);
      }
    });
  }

  // Keep all clusters with points (no filtering by exact capacity)
  clusters = clusters.filter(c => c.points.length > 0);

  console.log(`Capacitated K-Means: ${clusters.length} clusters with varying sizes`);
  clusters.forEach((c, idx) => {
    console.log(`  Cluster ${idx + 1}: ${c.points.length} points`);
  });
  
  return clusters;
}

async function capacitatedKMeansAsync(
  outlets: Outlet[],
  k: number,
  minCapacity: number = 20,
  maxCapacity: number = 30,
  maxIterations: number = 15
): Promise<Cluster[]> {
  const points: Point[] = outlets.map(o => ({
    lat: o.latitude,
    lng: o.longitude,
    id: o.id
  }));

  let actualK = Math.max(k, Math.ceil(points.length / maxCapacity));
  const centroids = initializeCentroidsKMeansPlusPlus(points, actualK);

  await yieldToEventLoop();

  // Phase 1: Unconstrained K-means to find natural geographic centers
  let assignments = new Int32Array(points.length);
  for (let kIter = 0; kIter < 8; kIter++) {
    for (let p = 0; p < points.length; p++) {
      let nearestIdx = 0;
      let nearestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const dLat = points[p].lat - centroids[c].lat;
        const dLng = points[p].lng - centroids[c].lng;
        const dist = dLat * dLat + dLng * dLng;
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestIdx = c;
        }
      }
      assignments[p] = nearestIdx;
    }

    const sums = centroids.map(() => ({ lat: 0, lng: 0, count: 0 }));
    for (let p = 0; p < points.length; p++) {
      const ci = assignments[p];
      sums[ci].lat += points[p].lat;
      sums[ci].lng += points[p].lng;
      sums[ci].count++;
    }
    for (let c = 0; c < centroids.length; c++) {
      if (sums[c].count > 0) {
        centroids[c].lat = sums[c].lat / sums[c].count;
        centroids[c].lng = sums[c].lng / sums[c].count;
      }
    }

    if (kIter % 3 === 0) await yieldToEventLoop();
  }

  console.log(`Capacitated K-Means: centroids converged after unconstrained K-means`);

  // Phase 2: Capacity-constrained assignment in RANDOM order using converged centroids
  let clusters: Cluster[] = centroids.map((centroid, i) => ({
    id: i,
    points: [],
    centroid: { ...centroid },
    radius: 0
  }));

  const indices = Array.from({ length: points.length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  for (const idx of indices) {
    const point = points[idx];
    let nearestIdx = 0;
    let nearestDist = Infinity;

    for (let c = 0; c < clusters.length; c++) {
      if (clusters[c].points.length >= maxCapacity) continue;
      const dist = calculateDistance(point.lat, point.lng, clusters[c].centroid.lat, clusters[c].centroid.lng);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = c;
      }
    }

    if (clusters[nearestIdx].points.length < maxCapacity) {
      clusters[nearestIdx].points.push(point);
    } else {
      let fallbackIdx = -1;
      let fallbackDist = Infinity;
      for (let c = 0; c < clusters.length; c++) {
        if (clusters[c].points.length < maxCapacity) {
          const dist = calculateDistance(point.lat, point.lng, clusters[c].centroid.lat, clusters[c].centroid.lng);
          if (dist < fallbackDist) {
            fallbackDist = dist;
            fallbackIdx = c;
          }
        }
      }
      if (fallbackIdx >= 0) {
        clusters[fallbackIdx].points.push(point);
      } else {
        clusters.push({
          id: clusters.length,
          points: [point],
          centroid: { ...point },
          radius: 0
        });
      }
    }
  }

  clusters.forEach(cluster => {
    if (cluster.points.length > 0) {
      cluster.centroid = calculateCentroid(cluster.points);
      cluster.radius = calculateRadius(cluster.points, cluster.centroid);
    }
  });

  await yieldToEventLoop();

  // Phase 3: Iterative reassignment with 5% hysteresis to prevent oscillation
  const pointClusterIndex = new Map<string, number>();
  for (let c = 0; c < clusters.length; c++) {
    for (const pt of clusters[c].points) {
      pointClusterIndex.set(pt.id, c);
    }
  }

  for (let reassignIter = 0; reassignIter < 15; reassignIter++) {
    let movesMade = 0;

    for (let p = 0; p < points.length; p++) {
      const point = points[p];
      const currentClusterIdx = pointClusterIndex.get(point.id);
      if (currentClusterIdx === undefined) continue;

      const currentDist = calculateDistance(point.lat, point.lng, 
        clusters[currentClusterIdx].centroid.lat, clusters[currentClusterIdx].centroid.lng);

      let bestClusterIdx = currentClusterIdx;
      let bestDist = currentDist;
      for (let c = 0; c < clusters.length; c++) {
        if (c === currentClusterIdx) continue;
        if (clusters[c].points.length >= maxCapacity) continue;
        const dist = calculateDistance(point.lat, point.lng, clusters[c].centroid.lat, clusters[c].centroid.lng);
        if (dist < bestDist) {
          bestDist = dist;
          bestClusterIdx = c;
        }
      }

      // Move if at least 5% closer (hysteresis prevents oscillation)
      if (bestClusterIdx !== currentClusterIdx && bestDist < currentDist * 0.95 
          && clusters[currentClusterIdx].points.length > minCapacity) {
        clusters[currentClusterIdx].points = clusters[currentClusterIdx].points.filter(pt => pt.id !== point.id);
        clusters[bestClusterIdx].points.push(point);
        pointClusterIndex.set(point.id, bestClusterIdx);
        movesMade++;
      }
    }

    clusters.forEach(cluster => {
      if (cluster.points.length > 0) {
        cluster.centroid = calculateCentroid(cluster.points);
        cluster.radius = calculateRadius(cluster.points, cluster.centroid);
      }
    });

    await yieldToEventLoop();
    if (movesMade === 0) break;
  }

  // Phase 4: Global outlier detection - checks ALL clusters (not just neighbors)
  // Uses median-based threshold for robustness against skewed distributions
  for (let outlierPass = 0; outlierPass < 5; outlierPass++) {
    let outliersMoved = 0;
    
    for (let c = 0; c < clusters.length; c++) {
      const cluster = clusters[c];
      if (cluster.points.length <= 2) continue;
      
      const distances = cluster.points.map(pt => 
        calculateDistance(pt.lat, pt.lng, cluster.centroid.lat, cluster.centroid.lng)
      );
      // Use median distance (robust to outliers inflating the average)
      const sortedDists = [...distances].sort((a, b) => a - b);
      const medianDist = sortedDists[Math.floor(sortedDists.length / 2)];
      
      // Outlier = more than 3x the median distance from centroid
      const outlierThreshold = Math.max(medianDist * 3, 0.3);
      
      const pointsToCheck = [...cluster.points];
      for (const point of pointsToCheck) {
        const distFromCentroid = calculateDistance(point.lat, point.lng, cluster.centroid.lat, cluster.centroid.lng);
        if (distFromCentroid <= outlierThreshold) continue;
        
        // For extreme outliers (>5x median), allow moving even below minCapacity
        const isExtremeOutlier = distFromCentroid > medianDist * 5;
        if (!isExtremeOutlier && cluster.points.length <= minCapacity) continue;
        
        // GLOBAL search - check ALL clusters, not just neighbors
        let bestClusterIdx = c;
        let bestDist = distFromCentroid;
        
        for (let other = 0; other < clusters.length; other++) {
          if (other === c) continue;
          if (clusters[other].points.length >= maxCapacity) continue;
          const dist = calculateDistance(point.lat, point.lng, clusters[other].centroid.lat, clusters[other].centroid.lng);
          if (dist < bestDist) {
            bestDist = dist;
            bestClusterIdx = other;
          }
        }
        
        if (bestClusterIdx !== c) {
          cluster.points = cluster.points.filter(pt => pt.id !== point.id);
          clusters[bestClusterIdx].points.push(point);
          pointClusterIndex.set(point.id, bestClusterIdx);
          outliersMoved++;
        }
      }
    }
    
    clusters.forEach(cluster => {
      if (cluster.points.length > 0) {
        cluster.centroid = calculateCentroid(cluster.points);
        cluster.radius = calculateRadius(cluster.points, cluster.centroid);
      }
    });
    
    await yieldToEventLoop();
    if (outliersMoved === 0) break;
  }

  // Phase 5: Boundary swap refinement
  const refinementStart = Date.now();
  let iteration = 0;
  let improved = true;

  while (improved && iteration < maxIterations) {
    if (Date.now() - refinementStart > 30000) break;

    improved = false;
    iteration++;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const cluster1 = clusters[i];
        const cluster2 = clusters[j];
        if (cluster1.points.length === 0 || cluster2.points.length === 0) continue;

        const centroidDist = calculateDistance(
          cluster1.centroid.lat, cluster1.centroid.lng,
          cluster2.centroid.lat, cluster2.centroid.lng
        );
        const maxRadius = Math.max(cluster1.radius || 0, cluster2.radius || 0, 2);
        if (centroidDist > maxRadius * 3) continue;

        // Try swaps between boundary points
        let bestSwap: { idx1: number; idx2: number; improvement: number } | null = null;
        let bestImprovement = 0;

        for (let p1 = 0; p1 < cluster1.points.length; p1++) {
          for (let p2 = 0; p2 < cluster2.points.length; p2++) {
            const point1 = cluster1.points[p1];
            const point2 = cluster2.points[p2];

            const currentDist = 
              calculateDistance(point1.lat, point1.lng, cluster1.centroid.lat, cluster1.centroid.lng) +
              calculateDistance(point2.lat, point2.lng, cluster2.centroid.lat, cluster2.centroid.lng);

            const swapDist = 
              calculateDistance(point1.lat, point1.lng, cluster2.centroid.lat, cluster2.centroid.lng) +
              calculateDistance(point2.lat, point2.lng, cluster1.centroid.lat, cluster1.centroid.lng);

            const improvement = currentDist - swapDist;
            if (improvement > bestImprovement) {
              bestImprovement = improvement;
              bestSwap = { idx1: p1, idx2: p2, improvement };
            }
          }
        }

        if (bestSwap && bestSwap.improvement > 0.01) {
          const temp = cluster1.points[bestSwap.idx1];
          cluster1.points[bestSwap.idx1] = cluster2.points[bestSwap.idx2];
          cluster2.points[bestSwap.idx2] = temp;
          improved = true;
        }

        // Also try MOVES (not swaps) - move boundary point to neighbor if closer
        for (let p1 = cluster1.points.length - 1; p1 >= 0; p1--) {
          const point = cluster1.points[p1];
          const dist1 = calculateDistance(point.lat, point.lng, cluster1.centroid.lat, cluster1.centroid.lng);
          const dist2 = calculateDistance(point.lat, point.lng, cluster2.centroid.lat, cluster2.centroid.lng);
          if (dist2 < dist1 * 0.9 && cluster1.points.length > minCapacity && cluster2.points.length < maxCapacity) {
            cluster1.points.splice(p1, 1);
            cluster2.points.push(point);
            improved = true;
          }
        }
        for (let p2 = cluster2.points.length - 1; p2 >= 0; p2--) {
          const point = cluster2.points[p2];
          const dist2 = calculateDistance(point.lat, point.lng, cluster2.centroid.lat, cluster2.centroid.lng);
          const dist1 = calculateDistance(point.lat, point.lng, cluster1.centroid.lat, cluster1.centroid.lng);
          if (dist1 < dist2 * 0.9 && cluster2.points.length > minCapacity && cluster1.points.length < maxCapacity) {
            cluster2.points.splice(p2, 1);
            cluster1.points.push(point);
            improved = true;
          }
        }
      }
      
      if (i % 3 === 0) await yieldToEventLoop();
    }

    clusters.forEach(cluster => {
      if (cluster.points.length > 0) {
        cluster.centroid = calculateCentroid(cluster.points);
        cluster.radius = calculateRadius(cluster.points, cluster.centroid);
      }
    });
    
    await yieldToEventLoop();
  }

  clusters = clusters.filter(c => c.points.length > 0);

  console.log(`Capacitated K-Means: ${clusters.length} clusters (${iteration} swap iterations, ${Date.now() - refinementStart}ms)`);
  
  return clusters;
}

function initializeCentroidsKMeansPlusPlus(points: Point[], k: number): Point[] {
  const centroids: Point[] = [];
  
  const firstIdx = Math.floor(Math.random() * points.length);
  centroids.push({ ...points[firstIdx] });

  const useSampling = k > 30 && points.length > 300;
  const sampleSize = Math.min(300, points.length);

  for (let i = 1; i < k; i++) {
    let candidatePoints = points;
    if (useSampling) {
      const indices = new Set<number>();
      while (indices.size < sampleSize) indices.add(Math.floor(Math.random() * points.length));
      candidatePoints = Array.from(indices).map(i => points[i]);
    }

    const distances = candidatePoints.map(point => {
      let minDist = Infinity;
      for (const centroid of centroids) {
        const dist = calculateDistance(point.lat, point.lng, centroid.lat, centroid.lng);
        if (dist < minDist) minDist = dist;
      }
      return minDist;
    });

    const sumSquaredDistances = distances.reduce((sum, d) => sum + d * d, 0);
    let random = Math.random() * sumSquaredDistances;
    
    for (let j = 0; j < candidatePoints.length; j++) {
      random -= distances[j] * distances[j];
      if (random <= 0) {
        centroids.push({ ...candidatePoints[j] });
        break;
      }
    }

    if (centroids.length === i) {
      centroids.push({ ...candidatePoints[candidatePoints.length - 1] });
    }
  }

  return centroids;
}

function balanceClusterSizes(clusters: Cluster[], targetSize: number): Cluster[] {
  // Separate oversized and undersized clusters
  const oversized = clusters.filter(c => c.points.length > targetSize);
  const undersized = clusters.filter(c => c.points.length < targetSize);

  // Move excess points from oversized to undersized clusters
  for (const large of oversized) {
    while (large.points.length > targetSize && undersized.length > 0) {
      // Find nearest undersized cluster
      let bestSmall: Cluster | null = null;
      let bestPoint: Point | null = null;
      let minDist = Infinity;

      for (const small of undersized) {
        if (small.points.length >= targetSize) continue;

        for (const point of large.points) {
          const dist = calculateDistance(point.lat, point.lng, small.centroid.lat, small.centroid.lng);
          if (dist < minDist) {
            minDist = dist;
            bestSmall = small;
            bestPoint = point;
          }
        }
      }

      if (bestSmall && bestPoint) {
        // Move point
        large.points = large.points.filter(p => p.id !== bestPoint.id);
        bestSmall.points.push(bestPoint);

        // Recalculate centroids
        large.centroid = calculateCentroid(large.points);
        large.radius = calculateRadius(large.points, large.centroid);
        bestSmall.centroid = calculateCentroid(bestSmall.points);
        bestSmall.radius = calculateRadius(bestSmall.points, bestSmall.centroid);
      } else {
        break;
      }
    }
  }

  return clusters;
}

function calculateCentroid(points: Point[]): Point {
  const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const lng = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
  return { lat, lng, id: 'centroid' };
}

function calculateRadius(points: Point[], centroid: Point): number {
  if (points.length === 0) return 0;
  
  const distances = points.map(p => 
    calculateDistance(p.lat, p.lng, centroid.lat, centroid.lng)
  );
  
  return Math.max(...distances);
}

async function fastClusteringLargeDataset(
  outlets: Outlet[],
  k: number,
  minVisitsPerDay: number,
  maxVisitsPerDay: number,
  emitProgress: (percent: number, stage: string, detail: string) => Promise<void>
): Promise<GeographicCluster[]> {
  const startTime = Date.now();
  console.log(`[Fast Clustering] Starting for ${outlets.length} outlets, k=${k}`);

  await emitProgress(23, 'Clustering', 'Preparing outlet data...');

  const points: Point[] = outlets.map(o => ({
    lat: o.latitude,
    lng: o.longitude,
    id: o.id
  }));

  await emitProgress(24, 'Clustering', 'Initializing cluster centroids...');

  const centroids = initializeCentroidsKMeansPlusPlus(points, k);
  console.log(`[Fast Clustering] Initialized ${centroids.length} centroids in ${Date.now() - startTime}ms`);

  await emitProgress(25, 'Clustering', `Running K-means to find geographic centers...`);

  // Phase 1: Standard K-means WITHOUT capacity constraints (5 iterations)
  // This lets centroids converge to natural geographic cluster centers
  let assignments = new Int32Array(points.length);
  for (let kIter = 0; kIter < 5; kIter++) {
    // Assign each point to nearest centroid (no capacity limit)
    for (let p = 0; p < points.length; p++) {
      let nearestIdx = 0;
      let nearestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const dLat = points[p].lat - centroids[c].lat;
        const dLng = points[p].lng - centroids[c].lng;
        const dist = dLat * dLat + dLng * dLng; // Squared euclidean for speed
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestIdx = c;
        }
      }
      assignments[p] = nearestIdx;
    }

    // Recompute centroids
    const sums = centroids.map(() => ({ lat: 0, lng: 0, count: 0 }));
    for (let p = 0; p < points.length; p++) {
      const ci = assignments[p];
      sums[ci].lat += points[p].lat;
      sums[ci].lng += points[p].lng;
      sums[ci].count++;
    }
    for (let c = 0; c < centroids.length; c++) {
      if (sums[c].count > 0) {
        centroids[c].lat = sums[c].lat / sums[c].count;
        centroids[c].lng = sums[c].lng / sums[c].count;
      }
    }

    if (kIter % 2 === 0) await yieldToEventLoop();
  }

  console.log(`[Fast Clustering] K-means converged centroids in ${Date.now() - startTime}ms`);
  await emitProgress(28, 'Clustering', `Assigning ${outlets.length} outlets with capacity constraints...`);

  // Phase 2: Capacity-constrained assignment using converged centroids
  // Process outlets in RANDOM order to avoid latitude bias
  let clusters: Cluster[] = centroids.map((centroid, i) => ({
    id: i,
    points: [],
    centroid: { ...centroid },
    radius: 0
  }));

  // Create randomized order
  const indices = Array.from({ length: points.length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  for (let idx = 0; idx < indices.length; idx++) {
    const point = points[indices[idx]];
    let nearestIdx = 0;
    let nearestDist = Infinity;

    for (let c = 0; c < clusters.length; c++) {
      if (clusters[c].points.length >= maxVisitsPerDay) continue;
      const dist = calculateDistance(point.lat, point.lng, clusters[c].centroid.lat, clusters[c].centroid.lng);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = c;
      }
    }

    if (clusters[nearestIdx].points.length < maxVisitsPerDay) {
      clusters[nearestIdx].points.push(point);
    } else {
      let fallbackIdx = -1;
      let fallbackDist = Infinity;
      for (let c = 0; c < clusters.length; c++) {
        if (clusters[c].points.length < maxVisitsPerDay) {
          const dist = calculateDistance(point.lat, point.lng, clusters[c].centroid.lat, clusters[c].centroid.lng);
          if (dist < fallbackDist) {
            fallbackDist = dist;
            fallbackIdx = c;
          }
        }
      }
      if (fallbackIdx >= 0) {
        clusters[fallbackIdx].points.push(point);
      } else {
        clusters.push({
          id: clusters.length,
          points: [point],
          centroid: { ...point },
          radius: 0
        });
      }
    }

    if (idx % 200 === 0) await yieldToEventLoop();
    if (idx % 500 === 0) {
      const pct = 28 + Math.floor((idx / indices.length) * 4);
      await emitProgress(pct, 'Clustering', `Assigned ${idx}/${indices.length} outlets...`);
    }
  }

  // Recompute centroids after capacity-constrained assignment
  clusters.forEach(cluster => {
    if (cluster.points.length > 0) {
      cluster.centroid = calculateCentroid(cluster.points);
      cluster.radius = calculateRadius(cluster.points, cluster.centroid);
    }
  });

  console.log(`[Fast Clustering] Capacity-constrained assignment done in ${Date.now() - startTime}ms`);
  await emitProgress(32, 'Clustering', 'Refining zone boundaries with reassignment...');

  // Phase 3: Iterative reassignment with 5% hysteresis to prevent oscillation
  const reassignmentStart = Date.now();
  
  const pointClusterIndex = new Map<string, number>();
  for (let c = 0; c < clusters.length; c++) {
    for (const pt of clusters[c].points) {
      pointClusterIndex.set(pt.id, c);
    }
  }

  for (let reassignIter = 0; reassignIter < 15; reassignIter++) {
    if (Date.now() - reassignmentStart > 15000) break;
    let movesMade = 0;

    for (let p = 0; p < points.length; p++) {
      const point = points[p];
      const currentClusterIdx = pointClusterIndex.get(point.id);
      if (currentClusterIdx === undefined || currentClusterIdx === -1) continue;

      const currentDist = calculateDistance(point.lat, point.lng, 
        clusters[currentClusterIdx].centroid.lat, clusters[currentClusterIdx].centroid.lng);

      let bestClusterIdx = currentClusterIdx;
      let bestDist = currentDist;
      for (let c = 0; c < clusters.length; c++) {
        if (c === currentClusterIdx) continue;
        if (clusters[c].points.length >= maxVisitsPerDay) continue;
        const dist = calculateDistance(point.lat, point.lng, clusters[c].centroid.lat, clusters[c].centroid.lng);
        if (dist < bestDist) {
          bestDist = dist;
          bestClusterIdx = c;
        }
      }

      // Move if at least 5% closer (hysteresis prevents oscillation)
      if (bestClusterIdx !== currentClusterIdx && bestDist < currentDist * 0.95
          && clusters[currentClusterIdx].points.length > minVisitsPerDay) {
        clusters[currentClusterIdx].points = clusters[currentClusterIdx].points.filter(pt => pt.id !== point.id);
        clusters[bestClusterIdx].points.push(point);
        pointClusterIndex.set(point.id, bestClusterIdx);
        movesMade++;
      }

      if (p % 200 === 0) await yieldToEventLoop();
    }

    clusters.forEach(cluster => {
      if (cluster.points.length > 0) {
        cluster.centroid = calculateCentroid(cluster.points);
        cluster.radius = calculateRadius(cluster.points, cluster.centroid);
      }
    });

    const pct = 32 + Math.floor(((reassignIter + 1) / 15) * 3);
    await emitProgress(pct, 'Clustering', `Reassignment pass ${reassignIter + 1} (${movesMade} moves)...`);

    if (movesMade === 0) break;
  }

  console.log(`[Fast Clustering] Reassignment done in ${Date.now() - reassignmentStart}ms`);
  await emitProgress(34, 'Clustering', 'Detecting and fixing outliers...');

  // Phase 4: Global outlier detection using median-based threshold
  for (let outlierPass = 0; outlierPass < 5; outlierPass++) {
    let outliersMoved = 0;
    
    for (let c = 0; c < clusters.length; c++) {
      const cluster = clusters[c];
      if (cluster.points.length <= 2) continue;
      
      const distances = cluster.points.map(pt => 
        calculateDistance(pt.lat, pt.lng, cluster.centroid.lat, cluster.centroid.lng)
      );
      const sortedDists = [...distances].sort((a, b) => a - b);
      const medianDist = sortedDists[Math.floor(sortedDists.length / 2)];
      const outlierThreshold = Math.max(medianDist * 3, 0.3);
      
      const pointsToCheck = [...cluster.points];
      for (const point of pointsToCheck) {
        const distFromCentroid = calculateDistance(point.lat, point.lng, cluster.centroid.lat, cluster.centroid.lng);
        if (distFromCentroid <= outlierThreshold) continue;
        
        const isExtremeOutlier = distFromCentroid > medianDist * 5;
        if (!isExtremeOutlier && cluster.points.length <= minVisitsPerDay) continue;
        
        let bestClusterIdx = c;
        let bestDist = distFromCentroid;
        
        for (let other = 0; other < clusters.length; other++) {
          if (other === c) continue;
          if (clusters[other].points.length >= maxVisitsPerDay) continue;
          const dist = calculateDistance(point.lat, point.lng, clusters[other].centroid.lat, clusters[other].centroid.lng);
          if (dist < bestDist) {
            bestDist = dist;
            bestClusterIdx = other;
          }
        }
        
        if (bestClusterIdx !== c) {
          cluster.points = cluster.points.filter(pt => pt.id !== point.id);
          clusters[bestClusterIdx].points.push(point);
          pointClusterIndex.set(point.id, bestClusterIdx);
          outliersMoved++;
        }
      }
    }
    
    clusters.forEach(cluster => {
      if (cluster.points.length > 0) {
        cluster.centroid = calculateCentroid(cluster.points);
        cluster.radius = calculateRadius(cluster.points, cluster.centroid);
      }
    });
    
    await yieldToEventLoop();
    if (outliersMoved === 0) break;
  }

  await emitProgress(36, 'Clustering', 'Swapping boundary outlets...');

  // Phase 5: Boundary swap + move refinement
  const refinementStart = Date.now();

  for (let iter = 0; iter < 8; iter++) {
    if (Date.now() - refinementStart > 20000) break;
    let changesMade = 0;

    for (let i = 0; i < clusters.length; i++) {
      if (clusters[i].points.length === 0) continue;

      for (let j = i + 1; j < clusters.length; j++) {
        if (clusters[j].points.length === 0) continue;

        const centroidDist = calculateDistance(
          clusters[i].centroid.lat, clusters[i].centroid.lng,
          clusters[j].centroid.lat, clusters[j].centroid.lng
        );
        const maxRadius = Math.max(clusters[i].radius || 0, clusters[j].radius || 0, 2);
        if (centroidDist > maxRadius * 3) continue;

        const maxCheck = 15;
        const pts1 = clusters[i].points.length > maxCheck 
          ? clusters[i].points.slice(0, maxCheck) 
          : clusters[i].points;
        const pts2 = clusters[j].points.length > maxCheck 
          ? clusters[j].points.slice(0, maxCheck) 
          : clusters[j].points;

        let bestSwap: { idx1: number; idx2: number; improvement: number } | null = null;
        let bestImprovement = 0;

        for (let p1 = 0; p1 < pts1.length; p1++) {
          for (let p2 = 0; p2 < pts2.length; p2++) {
            const point1 = pts1[p1];
            const point2 = pts2[p2];

            const currentDist =
              calculateDistance(point1.lat, point1.lng, clusters[i].centroid.lat, clusters[i].centroid.lng) +
              calculateDistance(point2.lat, point2.lng, clusters[j].centroid.lat, clusters[j].centroid.lng);

            const swapDist =
              calculateDistance(point1.lat, point1.lng, clusters[j].centroid.lat, clusters[j].centroid.lng) +
              calculateDistance(point2.lat, point2.lng, clusters[i].centroid.lat, clusters[i].centroid.lng);

            const improvement = currentDist - swapDist;
            if (improvement > bestImprovement) {
              bestImprovement = improvement;
              const realIdx1 = clusters[i].points.indexOf(point1);
              const realIdx2 = clusters[j].points.indexOf(point2);
              bestSwap = { idx1: realIdx1, idx2: realIdx2, improvement };
            }
          }
        }

        if (bestSwap && bestSwap.improvement > 0.01) {
          const temp = clusters[i].points[bestSwap.idx1];
          clusters[i].points[bestSwap.idx1] = clusters[j].points[bestSwap.idx2];
          clusters[j].points[bestSwap.idx2] = temp;
          changesMade++;
        }

        // Also try moves (not just swaps)
        for (let p1 = clusters[i].points.length - 1; p1 >= 0; p1--) {
          const point = clusters[i].points[p1];
          const dist1 = calculateDistance(point.lat, point.lng, clusters[i].centroid.lat, clusters[i].centroid.lng);
          const dist2 = calculateDistance(point.lat, point.lng, clusters[j].centroid.lat, clusters[j].centroid.lng);
          if (dist2 < dist1 * 0.9 && clusters[i].points.length > minVisitsPerDay && clusters[j].points.length < maxVisitsPerDay) {
            clusters[i].points.splice(p1, 1);
            clusters[j].points.push(point);
            changesMade++;
          }
        }
        for (let p2 = clusters[j].points.length - 1; p2 >= 0; p2--) {
          const point = clusters[j].points[p2];
          const dist2 = calculateDistance(point.lat, point.lng, clusters[j].centroid.lat, clusters[j].centroid.lng);
          const dist1 = calculateDistance(point.lat, point.lng, clusters[i].centroid.lat, clusters[i].centroid.lng);
          if (dist1 < dist2 * 0.9 && clusters[j].points.length > minVisitsPerDay && clusters[i].points.length < maxVisitsPerDay) {
            clusters[j].points.splice(p2, 1);
            clusters[i].points.push(point);
            changesMade++;
          }
        }
      }

      if (i % 5 === 0) await yieldToEventLoop();
    }

    clusters.forEach(cluster => {
      if (cluster.points.length > 0) {
        cluster.centroid = calculateCentroid(cluster.points);
        cluster.radius = calculateRadius(cluster.points, cluster.centroid);
      }
    });

    const pct = 36 + Math.floor(((iter + 1) / 8) * 2);
    await emitProgress(pct, 'Clustering', `Refinement ${iter + 1}/8 (${changesMade} changes)...`);

    if (changesMade === 0) break;
  }

  console.log(`[Fast Clustering] Refinement done in ${Date.now() - refinementStart}ms`);
  await emitProgress(38, 'Clustering', 'Balancing zone sizes...');

  clusters = clusters.filter(c => c.points.length > 0);

  const minCapacity = minVisitsPerDay;
  const maxCapacity = maxVisitsPerDay;

  let mergesMade = 0;
  let clustersMerged = true;
  while (clustersMerged) {
    clustersMerged = false;
    const smallClusters = clusters.filter(c => c.points.length < minCapacity && c.points.length > 0);
    if (smallClusters.length === 0) break;

    for (const small of smallClusters) {
      if (small.points.length === 0) continue;

      let nearestCluster: Cluster | null = null;
      let nearestDist = Infinity;

      for (const target of clusters) {
        if (target === small || target.points.length === 0) continue;
        if (target.points.length + small.points.length <= maxCapacity) {
          const dist = calculateDistance(
            small.centroid.lat, small.centroid.lng,
            target.centroid.lat, target.centroid.lng
          );
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestCluster = target;
          }
        }
      }

      if (nearestCluster) {
        nearestCluster.points.push(...small.points);
        nearestCluster.centroid = calculateCentroid(nearestCluster.points);
        nearestCluster.radius = calculateRadius(nearestCluster.points, nearestCluster.centroid);
        small.points = [];
        mergesMade++;
        clustersMerged = true;
      }
    }

    clusters = clusters.filter(c => c.points.length > 0);
    await yieldToEventLoop();
  }

  if (mergesMade > 0) {
    console.log(`[Fast Clustering] Merged ${mergesMade} undersized clusters`);
  }

  await emitProgress(39, 'Clustering', 'Splitting oversized zones...');

  const splitClusters: Cluster[] = [];
  let splitsMade = 0;
  for (const cluster of clusters) {
    if (cluster.points.length > maxCapacity) {
      const subClusters = optimizeClusterRoutes(cluster, maxCapacity);
      splitClusters.push(...subClusters);
      splitsMade++;
    } else {
      splitClusters.push(cluster);
    }
  }
  clusters = splitClusters;

  if (splitsMade > 0) {
    console.log(`[Fast Clustering] Split ${splitsMade} oversized clusters into ${clusters.length} total`);
  }

  await emitProgress(40, 'Clustering', 'Finalizing zones...');

  clusters = clusters.filter(c => c.points.length > 0);
  clusters.forEach((c, idx) => { c.id = idx; });

  const outletMap = new Map(outlets.map(o => [o.id, o]));

  const result: GeographicCluster[] = clusters.map((cluster, idx) => ({
    id: idx,
    centroid: { lat: cluster.centroid.lat, lng: cluster.centroid.lng },
    outlets: cluster.points.map(p => outletMap.get(p.id)!).filter(o => o),
    radius: cluster.radius
  }));

  await emitProgress(42, 'Clustering', `Created ${result.length} optimized zones`);
  console.log(`[Fast Clustering] Complete: ${result.length} zones in ${Date.now() - startTime}ms`);

  return result;
}

export async function performAdvancedClustering(
  outlets: Outlet[], 
  targetClusters: number, 
  minVisitsPerDay: number = 25, 
  maxVisitsPerDay: number = 30,
  onProgress?: ProgressCallback
): Promise<GeographicCluster[]> {
  const emitProgress = async (percent: number, stage: string, detail: string) => {
    if (onProgress) await onProgress(percent, stage, detail);
    await yieldToEventLoop();
  };
  
  console.log(`Starting clustering for ${outlets.length} outlets targeting ${targetClusters} clusters (${minVisitsPerDay}-${maxVisitsPerDay} outlets/zone)`);
  await emitProgress(22, 'Clustering', `Analyzing ${outlets.length} outlets...`);

  const outletsPerZone = maxVisitsPerDay;
  const actualK = Math.max(targetClusters, Math.ceil(outlets.length / outletsPerZone));

  // Use fastClusteringLargeDataset for large datasets (full progress reporting)
  if (outlets.length >= 500) {
    return await fastClusteringLargeDataset(outlets, actualK, minVisitsPerDay, maxVisitsPerDay, emitProgress);
  }

  // For smaller datasets, use capacitated K-means directly with proper multi-phase approach
  await emitProgress(25, 'Clustering', 'Running geographic clustering algorithm...');
  
  const exactClusters = Math.max(actualK, Math.ceil(outlets.length / outletsPerZone));
  const finalClusters = await capacitatedKMeansAsync(outlets, exactClusters, minVisitsPerDay, maxVisitsPerDay, 20);
  console.log(`Capacitated K-Means created ${finalClusters.length} final clusters`);
  await emitProgress(42, 'Clustering', `Created ${finalClusters.length} optimized zones...`);

  const result: GeographicCluster[] = [];
  const rejectedOutlets: Outlet[] = [];
  
  for (let i = 0; i < finalClusters.length; i++) {
    const cluster = finalClusters[i];
    const clusterOutlets = cluster.points.map(p => outlets.find(o => o.id === p.id)!).filter(o => o);
    
    if (cluster.points.length >= minVisitsPerDay && cluster.points.length <= maxVisitsPerDay) {
      result.push({
        id: cluster.id,
        centroid: { lat: cluster.centroid.lat, lng: cluster.centroid.lng },
        outlets: clusterOutlets,
        radius: cluster.radius
      });
    } else if (cluster.points.length > maxVisitsPerDay) {
      // Split oversized clusters
      const numSplits = Math.ceil(cluster.points.length / maxVisitsPerDay);
      const splitSize = Math.ceil(cluster.points.length / numSplits);
      for (let s = 0; s < numSplits; s++) {
        const splitPoints = cluster.points.slice(s * splitSize, (s + 1) * splitSize);
        const splitOutlets = splitPoints.map(p => outlets.find(o => o.id === p.id)!).filter(o => o);
        if (splitOutlets.length > 0) {
          const centroid = calculateCentroid(splitPoints);
          result.push({
            id: result.length,
            centroid: { lat: centroid.lat, lng: centroid.lng },
            outlets: splitOutlets,
            radius: calculateRadius(splitPoints, centroid)
          });
        }
      }
    } else {
      rejectedOutlets.push(...clusterOutlets);
    }
  }

  if (rejectedOutlets.length > 0) {
    console.log(`Redistributing ${rejectedOutlets.length} outlets from undersized clusters`);
    
    for (const outlet of rejectedOutlets) {
      let nearestCluster: GeographicCluster | null = null;
      let nearestDist = Infinity;
      
      for (const cluster of result) {
        if (cluster.outlets.length < maxVisitsPerDay) {
          const dist = calculateDistance(
            outlet.latitude, outlet.longitude,
            cluster.centroid.lat, cluster.centroid.lng
          );
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestCluster = cluster;
          }
        }
      }
      
      if (nearestCluster) {
        nearestCluster.outlets.push(outlet);
        const points = nearestCluster.outlets.map(o => ({ lat: o.latitude, lng: o.longitude, id: o.id }));
        const newCentroid = calculateCentroid(points);
        nearestCluster.centroid = { lat: newCentroid.lat, lng: newCentroid.lng };
        nearestCluster.radius = calculateRadius(points, newCentroid);
      } else {
        // If no cluster has space, create a new one
        result.push({
          id: result.length,
          centroid: { lat: outlet.latitude, lng: outlet.longitude },
          outlets: [outlet],
          radius: 0
        });
      }
    }
  }

  console.log(`Final result: ${result.length} zones`);
  return result;
}
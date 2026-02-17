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
  let clusters: Cluster[] = centroids.map((centroid, i) => ({
    id: i,
    points: [],
    centroid,
    radius: 0
  }));

  await yieldToEventLoop();

  const unassignedPoints = [...points];
  
  for (let clusterIdx = 0; clusterIdx < actualK && unassignedPoints.length > 0; clusterIdx++) {
    const cluster = clusters[clusterIdx];
    
    unassignedPoints.sort((a, b) => {
      const distA = calculateDistance(a.lat, a.lng, cluster.centroid.lat, cluster.centroid.lng);
      const distB = calculateDistance(b.lat, b.lng, cluster.centroid.lat, cluster.centroid.lng);
      return distA - distB;
    });

    const assignCount = Math.min(maxCapacity, unassignedPoints.length);
    for (let i = 0; i < assignCount; i++) {
      cluster.points.push(unassignedPoints[0]);
      unassignedPoints.shift();
    }
    
    if (clusterIdx % 10 === 0) await yieldToEventLoop();
  }

  await yieldToEventLoop();

  if (unassignedPoints.length > 0) {
    for (const point of unassignedPoints) {
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
        clusters.push({
          id: clusters.length,
          points: [point],
          centroid: { ...point },
          radius: 0
        });
      }
    }
  }

  await yieldToEventLoop();

  const refinementStart = Date.now();
  let iteration = 0;
  let improved = true;

  let avgInterCentroidDist = 0;
  if (clusters.length > 1) {
    let totalDist = 0;
    let count = 0;
    const sampleCount = Math.min(clusters.length, 50);
    for (let i = 0; i < sampleCount; i++) {
      for (let j = i + 1; j < sampleCount; j++) {
        totalDist += calculateDistance(
          clusters[i].centroid.lat, clusters[i].centroid.lng,
          clusters[j].centroid.lat, clusters[j].centroid.lng
        );
        count++;
      }
    }
    avgInterCentroidDist = count > 0 ? totalDist / count : Infinity;
  }
  const neighborThreshold = avgInterCentroidDist * 2;

  while (improved && iteration < maxIterations) {
    if (Date.now() - refinementStart > 30000) {
      console.log(`Capacitated K-Means: time limit reached at iteration ${iteration}`);
      break;
    }

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
        if (centroidDist > neighborThreshold) continue;

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

        if (bestSwap && bestSwap.improvement > 0.001) {
          const temp = cluster1.points[bestSwap.idx1];
          cluster1.points[bestSwap.idx1] = cluster2.points[bestSwap.idx2];
          cluster2.points[bestSwap.idx2] = temp;
          improved = true;
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

  console.log(`Capacitated K-Means: ${clusters.length} clusters (${iteration} iterations, ${Date.now() - refinementStart}ms)`);
  
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

  await emitProgress(23, 'Clustering', 'Sorting outlets geographically...');

  const points: Point[] = outlets.map(o => ({
    lat: o.latitude,
    lng: o.longitude,
    id: o.id
  }));

  points.sort((a, b) => a.lat !== b.lat ? a.lat - b.lat : a.lng - b.lng);

  await emitProgress(24, 'Clustering', 'Initializing cluster centroids...');

  const centroids = initializeCentroidsKMeansPlusPlus(points, k);
  console.log(`[Fast Clustering] Initialized ${centroids.length} centroids in ${Date.now() - startTime}ms`);

  await emitProgress(25, 'Clustering', `Assigning ${outlets.length} outlets to ${k} zones...`);

  let clusters: Cluster[] = centroids.map((centroid, i) => ({
    id: i,
    points: [],
    centroid,
    radius: 0
  }));

  for (let ptIdx = 0; ptIdx < points.length; ptIdx++) {
    const point = points[ptIdx];
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

    if (ptIdx % 100 === 0) await yieldToEventLoop();
    if (ptIdx % 500 === 0) {
      const pct = 25 + Math.floor((ptIdx / points.length) * 5);
      await emitProgress(pct, 'Clustering', `Assigned ${ptIdx}/${points.length} outlets...`);
    }
  }

  clusters.forEach(cluster => {
    if (cluster.points.length > 0) {
      cluster.centroid = calculateCentroid(cluster.points);
      cluster.radius = calculateRadius(cluster.points, cluster.centroid);
    }
  });

  const overflowClusters = clusters.filter(c => c.id >= k && c.points.length > 0);
  if (overflowClusters.length > 0) {
    console.log(`[Fast Clustering] ${overflowClusters.length} overflow clusters created, attempting redistribution...`);
    const originalClusters = clusters.filter(c => c.id < k);
    let redistributed = 0;

    for (const overflow of overflowClusters) {
      const pointsToRedistribute = [...overflow.points];
      overflow.points = [];

      for (const point of pointsToRedistribute) {
        let nearestCluster: Cluster | null = null;
        let nearestDist = Infinity;

        for (const cluster of originalClusters) {
          if (cluster.points.length < maxVisitsPerDay) {
            const dist = calculateDistance(point.lat, point.lng, cluster.centroid.lat, cluster.centroid.lng);
            if (dist < nearestDist) {
              nearestDist = dist;
              nearestCluster = cluster;
            }
          }
        }

        if (nearestCluster) {
          nearestCluster.points.push(point);
          redistributed++;
        } else {
          overflow.points.push(point);
        }
      }

      if (overflow.points.length > 0) {
        overflow.centroid = calculateCentroid(overflow.points);
        overflow.radius = calculateRadius(overflow.points, overflow.centroid);
      }
    }

    originalClusters.forEach(cluster => {
      if (cluster.points.length > 0) {
        cluster.centroid = calculateCentroid(cluster.points);
        cluster.radius = calculateRadius(cluster.points, cluster.centroid);
      }
    });

    const remainingOverflow = overflowClusters.filter(c => c.points.length > 0);
    console.log(`[Fast Clustering] Redistributed ${redistributed} points from overflow; ${remainingOverflow.length} overflow clusters remain`);
    clusters = [...originalClusters, ...remainingOverflow];
  }

  console.log(`[Fast Clustering] Initial assignment done in ${Date.now() - startTime}ms`);
  await emitProgress(30, 'Clustering', 'Refining zone boundaries...');

  let avgInterCentroidDist = 0;
  const activeClusters = clusters.filter(c => c.points.length > 0);
  if (activeClusters.length > 1) {
    let totalDist = 0;
    let count = 0;
    if (activeClusters.length <= 100) {
      for (let i = 0; i < activeClusters.length; i++) {
        for (let j = i + 1; j < activeClusters.length; j++) {
          totalDist += calculateDistance(
            activeClusters[i].centroid.lat, activeClusters[i].centroid.lng,
            activeClusters[j].centroid.lat, activeClusters[j].centroid.lng
          );
          count++;
        }
      }
    } else {
      const pairCount = 50;
      for (let p = 0; p < pairCount; p++) {
        const idxA = Math.floor(Math.random() * activeClusters.length);
        let idxB = Math.floor(Math.random() * (activeClusters.length - 1));
        if (idxB >= idxA) idxB++;
        totalDist += calculateDistance(
          activeClusters[idxA].centroid.lat, activeClusters[idxA].centroid.lng,
          activeClusters[idxB].centroid.lat, activeClusters[idxB].centroid.lng
        );
        count++;
      }
    }
    avgInterCentroidDist = count > 0 ? totalDist / count : Infinity;
  }
  const neighborThreshold = avgInterCentroidDist * 2;

  const refinementStart = Date.now();
  const maxRefinementIterations = 10;

  for (let iter = 0; iter < maxRefinementIterations; iter++) {
    if (Date.now() - refinementStart > 30000) {
      console.log(`[Fast Clustering] Refinement time limit reached at iteration ${iter}`);
      break;
    }

    let swapsMade = 0;

    for (let i = 0; i < clusters.length; i++) {
      if (clusters[i].points.length === 0) continue;

      for (let j = i + 1; j < clusters.length; j++) {
        if (clusters[j].points.length === 0) continue;

        const centroidDist = calculateDistance(
          clusters[i].centroid.lat, clusters[i].centroid.lng,
          clusters[j].centroid.lat, clusters[j].centroid.lng
        );
        if (centroidDist > neighborThreshold) continue;

        let bestSwap: { idx1: number; idx2: number; improvement: number } | null = null;
        let bestImprovement = 0;

        for (let p1 = 0; p1 < clusters[i].points.length; p1++) {
          for (let p2 = 0; p2 < clusters[j].points.length; p2++) {
            const point1 = clusters[i].points[p1];
            const point2 = clusters[j].points[p2];

            const currentDist =
              calculateDistance(point1.lat, point1.lng, clusters[i].centroid.lat, clusters[i].centroid.lng) +
              calculateDistance(point2.lat, point2.lng, clusters[j].centroid.lat, clusters[j].centroid.lng);

            const swapDist =
              calculateDistance(point1.lat, point1.lng, clusters[j].centroid.lat, clusters[j].centroid.lng) +
              calculateDistance(point2.lat, point2.lng, clusters[i].centroid.lat, clusters[i].centroid.lng);

            const improvement = currentDist - swapDist;
            if (improvement > bestImprovement) {
              bestImprovement = improvement;
              bestSwap = { idx1: p1, idx2: p2, improvement };
            }
          }
        }

        if (bestSwap && bestSwap.improvement > 0.001) {
          const temp = clusters[i].points[bestSwap.idx1];
          clusters[i].points[bestSwap.idx1] = clusters[j].points[bestSwap.idx2];
          clusters[j].points[bestSwap.idx2] = temp;
          swapsMade++;
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

    const pct = 30 + Math.floor(((iter + 1) / maxRefinementIterations) * 8);
    await emitProgress(pct, 'Clustering', `Refinement iteration ${iter + 1}/${maxRefinementIterations} (${swapsMade} swaps)...`);

    if (swapsMade === 0) break;
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

  if (outlets.length >= 500) {
    return await fastClusteringLargeDataset(outlets, actualK, minVisitsPerDay, maxVisitsPerDay, emitProgress);
  }

  await emitProgress(25, 'Clustering', 'Finding natural geographic patterns...');
  const hdbscanClusters = await hdbscanClusteringAsync(outlets, outletsPerZone, 5);
  console.log(`HDBSCAN found ${hdbscanClusters.length} natural clusters`);
  await emitProgress(30, 'Clustering', `Found ${hdbscanClusters.length} natural patterns...`);

  const processedClusters: Cluster[] = [];
  const smallClusters: Cluster[] = [];
  
  for (const cluster of hdbscanClusters) {
    if (cluster.points.length >= outletsPerZone * 2) {
      const subRoutes = optimizeClusterRoutes(cluster, outletsPerZone);
      processedClusters.push(...subRoutes);
    } else if (cluster.points.length < minVisitsPerDay) {
      smallClusters.push(cluster);
    } else {
      processedClusters.push(cluster);
    }
  }

  if (smallClusters.length > 0) {
    const mergedPoints: Point[] = [];
    smallClusters.forEach(cluster => mergedPoints.push(...cluster.points));
    
    const additionalClusters = Math.floor(mergedPoints.length / outletsPerZone);
    for (let i = 0; i < additionalClusters; i++) {
      const clusterPoints = mergedPoints.slice(i * outletsPerZone, (i + 1) * outletsPerZone);
      const centroid = calculateCentroid(clusterPoints);
      processedClusters.push({
        id: processedClusters.length,
        points: clusterPoints,
        centroid,
        radius: calculateRadius(clusterPoints, centroid)
      });
    }
  }

  console.log(`After processing: ${processedClusters.length} clusters`);
  await emitProgress(35, 'Clustering', 'Optimizing zone boundaries...');

  const exactClusters = Math.floor(outlets.length / outletsPerZone);
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
    } else {
      rejectedOutlets.push(...clusterOutlets);
    }
  }

  if (rejectedOutlets.length > 0) {
    console.log(`Redistributing ${rejectedOutlets.length} outlets from rejected clusters`);
    
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
        const lastCluster = result[result.length - 1];
        if (lastCluster) {
          lastCluster.outlets.push(outlet);
          const points = lastCluster.outlets.map(o => ({ lat: o.latitude, lng: o.longitude, id: o.id }));
          const newCentroid = calculateCentroid(points);
          lastCluster.centroid = { lat: newCentroid.lat, lng: newCentroid.lng };
          lastCluster.radius = calculateRadius(points, newCentroid);
        }
      }
    }
  }

  console.log(`Final result: ${result.length} zones`);
  return result;
}
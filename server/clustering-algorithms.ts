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

// Capacitated K-Means implementation with strict 25-outlet enforcement
export function capacitatedKMeans(
  outlets: Outlet[],
  k: number,
  capacity: number = 25,
  maxIterations: number = 100
): Cluster[] {
  const points: Point[] = outlets.map(o => ({
    lat: o.latitude,
    lng: o.longitude,
    id: o.id
  }));

  // Ensure we have enough outlets
  if (points.length < k * capacity) {
    console.warn(`Not enough outlets (${points.length}) for ${k} clusters of ${capacity} each`);
    k = Math.floor(points.length / capacity);
  }

  // Initialize centroids using k-means++
  const centroids = initializeCentroidsKMeansPlusPlus(points, k);
  let clusters: Cluster[] = centroids.map((centroid, i) => ({
    id: i,
    points: [],
    centroid,
    radius: 0
  }));

  // Phase 1: Initial assignment with strict capacity
  const unassignedPoints = [...points];
  
  for (let clusterIdx = 0; clusterIdx < k; clusterIdx++) {
    const cluster = clusters[clusterIdx];
    
    // Sort unassigned points by distance to this cluster's centroid
    unassignedPoints.sort((a, b) => {
      const distA = calculateDistance(a.lat, a.lng, cluster.centroid.lat, cluster.centroid.lng);
      const distB = calculateDistance(b.lat, b.lng, cluster.centroid.lat, cluster.centroid.lng);
      return distA - distB;
    });

    // Assign exactly 'capacity' points to this cluster
    const assignCount = Math.min(capacity, unassignedPoints.length);
    for (let i = 0; i < assignCount; i++) {
      cluster.points.push(unassignedPoints[0]);
      unassignedPoints.shift();
    }
  }

  // Phase 2: Iterative refinement while maintaining capacity constraints
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

        // Skip if clusters don't have exactly 'capacity' points
        if (cluster1.points.length !== capacity || cluster2.points.length !== capacity) {
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

  // Final validation: ensure each cluster has exactly 'capacity' outlets
  clusters = clusters.filter(c => c.points.length === capacity);

  console.log(`Capacitated K-Means: ${clusters.length} clusters, each with ${capacity} outlets`);
  
  return clusters;
}

function initializeCentroidsKMeansPlusPlus(points: Point[], k: number): Point[] {
  const centroids: Point[] = [];
  
  // Choose first centroid randomly
  const firstIdx = Math.floor(Math.random() * points.length);
  centroids.push({ ...points[firstIdx] });

  // Choose remaining centroids
  for (let i = 1; i < k; i++) {
    const distances = points.map(point => {
      let minDist = Infinity;
      centroids.forEach(centroid => {
        const dist = calculateDistance(point.lat, point.lng, centroid.lat, centroid.lng);
        minDist = Math.min(minDist, dist);
      });
      return minDist;
    });

    // Choose point with probability proportional to squared distance
    const sumSquaredDistances = distances.reduce((sum, d) => sum + d * d, 0);
    let random = Math.random() * sumSquaredDistances;
    
    for (let j = 0; j < points.length; j++) {
      random -= distances[j] * distances[j];
      if (random <= 0) {
        centroids.push({ ...points[j] });
        break;
      }
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

// Main clustering algorithm combining all three approaches
export function performAdvancedClustering(outlets: Outlet[], targetClusters: number): GeographicCluster[] {
  console.log(`Starting advanced clustering for ${outlets.length} outlets targeting ${targetClusters} clusters`);

  // Calculate the exact number of clusters needed (each with 25 outlets)
  const outletsPerZone = 25;
  const exactClusters = Math.floor(outlets.length / outletsPerZone);
  const remainingOutlets = outlets.length % outletsPerZone;
  
  console.log(`Creating ${exactClusters} zones of ${outletsPerZone} outlets each (${remainingOutlets} outlets remaining)`);

  // Step 1: Use HDBSCAN to find natural geographic clusters
  const hdbscanClusters = hdbscanClustering(outlets, outletsPerZone, 5);
  console.log(`HDBSCAN found ${hdbscanClusters.length} natural clusters`);

  // Step 2: Apply VRP optimization to large clusters and merge small ones
  const processedClusters: Cluster[] = [];
  const smallClusters: Cluster[] = [];
  
  for (const cluster of hdbscanClusters) {
    if (cluster.points.length >= outletsPerZone * 2) {
      // Split large clusters using VRP
      const subRoutes = optimizeClusterRoutes(cluster, outletsPerZone);
      processedClusters.push(...subRoutes);
    } else if (cluster.points.length < outletsPerZone) {
      // Collect small clusters for merging
      smallClusters.push(cluster);
    } else {
      // Keep clusters that are close to the target size
      processedClusters.push(cluster);
    }
  }

  // Merge small clusters
  if (smallClusters.length > 0) {
    const mergedPoints: Point[] = [];
    smallClusters.forEach(cluster => mergedPoints.push(...cluster.points));
    
    // Create new clusters from merged points
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

  // Step 3: Use Capacitated K-Means to get exactly the right number of clusters with 25 outlets each
  const finalClusters = capacitatedKMeans(outlets, exactClusters, outletsPerZone);
  console.log(`Capacitated K-Means created ${finalClusters.length} final clusters`);

  // Ensure each cluster has exactly 25 outlets (except possibly the last one)
  const result: GeographicCluster[] = [];
  for (let i = 0; i < finalClusters.length; i++) {
    const cluster = finalClusters[i];
    if (cluster.points.length === outletsPerZone || (i === finalClusters.length - 1 && remainingOutlets > 0)) {
      result.push({
        id: cluster.id,
        centroid: { lat: cluster.centroid.lat, lng: cluster.centroid.lng },
        outlets: cluster.points.map(p => outlets.find(o => o.id === p.id)!).filter(o => o),
        radius: cluster.radius
      });
    }
  }

  // Handle remaining outlets
  if (remainingOutlets > 0) {
    const assignedOutletIds = new Set(result.flatMap(c => c.outlets.map(o => o.id)));
    const unassignedOutlets = outlets.filter(o => !assignedOutletIds.has(o.id));
    
    if (unassignedOutlets.length > 0) {
      const lastCluster = result[result.length - 1];
      if (lastCluster) {
        lastCluster.outlets.push(...unassignedOutlets);
        // Recalculate centroid and radius
        const points = lastCluster.outlets.map(o => ({ lat: o.latitude, lng: o.longitude, id: o.id }));
        lastCluster.centroid = calculateCentroid(points);
        lastCluster.radius = calculateRadius(points, lastCluster.centroid);
      }
    }
  }

  console.log(`Final result: ${result.length} zones`);
  result.forEach((zone, idx) => {
    console.log(`Zone ${idx + 1}: ${zone.outlets.length} outlets`);
  });

  return result;
}
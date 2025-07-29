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

// Capacitated K-Means implementation
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

  // Initialize centroids using k-means++
  const centroids = initializeCentroidsKMeansPlusPlus(points, k);
  let clusters: Cluster[] = centroids.map((centroid, i) => ({
    id: i,
    points: [],
    centroid,
    radius: 0
  }));

  let iteration = 0;
  let changed = true;

  while (changed && iteration < maxIterations) {
    changed = false;
    iteration++;

    // Clear current assignments
    clusters.forEach(c => c.points = []);

    // Create distance matrix
    const distances: { pointIdx: number; clusterIdx: number; distance: number }[] = [];
    
    points.forEach((point, pIdx) => {
      clusters.forEach((cluster, cIdx) => {
        distances.push({
          pointIdx: pIdx,
          clusterIdx: cIdx,
          distance: calculateDistance(point.lat, point.lng, cluster.centroid.lat, cluster.centroid.lng)
        });
      });
    });

    // Sort by distance
    distances.sort((a, b) => a.distance - b.distance);

    // Assign points to clusters with capacity constraints
    const assigned = new Set<number>();
    const clusterSizes = new Array(k).fill(0);

    for (const { pointIdx, clusterIdx, distance } of distances) {
      if (assigned.has(pointIdx)) continue;
      if (clusterSizes[clusterIdx] >= capacity) continue;

      clusters[clusterIdx].points.push(points[pointIdx]);
      clusterSizes[clusterIdx]++;
      assigned.add(pointIdx);
      changed = true;
    }

    // Handle unassigned points (assign to nearest cluster with space or create overflow)
    const unassignedPoints = points.filter((_, idx) => !assigned.has(idx));
    for (const point of unassignedPoints) {
      let bestCluster = 0;
      let minDist = Infinity;

      clusters.forEach((cluster, idx) => {
        const dist = calculateDistance(point.lat, point.lng, cluster.centroid.lat, cluster.centroid.lng);
        if (dist < minDist && clusterSizes[idx] < capacity * 1.2) { // Allow 20% overflow
          minDist = dist;
          bestCluster = idx;
        }
      });

      clusters[bestCluster].points.push(point);
      clusterSizes[bestCluster]++;
    }

    // Recalculate centroids
    clusters.forEach(cluster => {
      if (cluster.points.length > 0) {
        cluster.centroid = calculateCentroid(cluster.points);
        cluster.radius = calculateRadius(cluster.points, cluster.centroid);
      }
    });
  }

  // Post-process to ensure capacity constraints
  return balanceClusterSizes(clusters, capacity);
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

  // Step 1: Use HDBSCAN to find natural geographic clusters
  const hdbscanClusters = hdbscanClustering(outlets, 15, 5);
  console.log(`HDBSCAN found ${hdbscanClusters.length} natural clusters`);

  // Step 2: Apply VRP optimization to large clusters
  const optimizedClusters: Cluster[] = [];
  for (const cluster of hdbscanClusters) {
    if (cluster.points.length > 25) {
      const subRoutes = optimizeClusterRoutes(cluster, 25);
      optimizedClusters.push(...subRoutes);
    } else {
      optimizedClusters.push(cluster);
    }
  }
  console.log(`After VRP optimization: ${optimizedClusters.length} clusters`);

  // Step 3: Use Capacitated K-Means to get exactly the target number of clusters
  const finalClusters = capacitatedKMeans(outlets, targetClusters, 25);
  console.log(`Capacitated K-Means created ${finalClusters.length} final clusters`);

  // Convert back to outlet format
  return finalClusters.map(cluster => ({
    id: cluster.id,
    centroid: { lat: cluster.centroid.lat, lng: cluster.centroid.lng },
    outlets: cluster.points.map(p => outlets.find(o => o.id === p.id)!).filter(o => o),
    radius: cluster.radius
  }));
}
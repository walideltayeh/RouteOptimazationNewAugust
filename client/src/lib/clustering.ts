// K-means clustering algorithm for GPS-based outlet grouping
export interface Point {
  id: string;
  latitude: number;
  longitude: number;
  data?: any;
}

export interface Cluster {
  id: number;
  centroid: { latitude: number; longitude: number };
  points: Point[];
}

// Calculate distance between two GPS points using Haversine formula
export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

// K-means clustering implementation
export function kMeansClustering(points: Point[], k: number, maxIterations: number = 100): Cluster[] {
  if (points.length === 0 || k <= 0) return [];
  
  // Use K-means++ initialization for better initial centroids
  const clusters: Cluster[] = [];
  
  // Choose first centroid randomly
  const firstPoint = points[Math.floor(Math.random() * points.length)];
  clusters.push({
    id: 0,
    centroid: { latitude: firstPoint.latitude, longitude: firstPoint.longitude },
    points: []
  });
  
  // Choose remaining centroids using K-means++ method
  for (let i = 1; i < k; i++) {
    const distances: number[] = [];
    let totalDistance = 0;
    
    // Calculate distance to nearest centroid for each point
    points.forEach(point => {
      let minDistance = Infinity;
      clusters.forEach(cluster => {
        const distance = calculateDistance(
          point.latitude,
          point.longitude,
          cluster.centroid.latitude,
          cluster.centroid.longitude
        );
        minDistance = Math.min(minDistance, distance);
      });
      distances.push(minDistance * minDistance); // Square the distance
      totalDistance += minDistance * minDistance;
    });
    
    // Choose next centroid with probability proportional to squared distance
    const random = Math.random() * totalDistance;
    let cumulative = 0;
    let selectedIndex = 0;
    
    for (let j = 0; j < distances.length; j++) {
      cumulative += distances[j];
      if (cumulative >= random) {
        selectedIndex = j;
        break;
      }
    }
    
    clusters.push({
      id: i,
      centroid: { 
        latitude: points[selectedIndex].latitude, 
        longitude: points[selectedIndex].longitude 
      },
      points: []
    });
  }

  let iteration = 0;
  let converged = false;

  while (iteration < maxIterations && !converged) {
    // Clear previous assignments
    clusters.forEach(cluster => cluster.points = []);

    // Assign each point to the nearest centroid
    points.forEach(point => {
      let minDistance = Infinity;
      let closestCluster = 0;

      clusters.forEach((cluster, index) => {
        const distance = calculateDistance(
          point.latitude,
          point.longitude,
          cluster.centroid.latitude,
          cluster.centroid.longitude
        );

        if (distance < minDistance) {
          minDistance = distance;
          closestCluster = index;
        }
      });

      clusters[closestCluster].points.push(point);
    });

    // Update centroids
    converged = true;
    clusters.forEach(cluster => {
      if (cluster.points.length === 0) return;

      const newCentroid = {
        latitude: cluster.points.reduce((sum, p) => sum + p.latitude, 0) / cluster.points.length,
        longitude: cluster.points.reduce((sum, p) => sum + p.longitude, 0) / cluster.points.length
      };

      // Check if centroid moved significantly
      const movement = calculateDistance(
        cluster.centroid.latitude,
        cluster.centroid.longitude,
        newCentroid.latitude,
        newCentroid.longitude
      );

      if (movement > 0.001) { // 1 meter threshold for better precision
        converged = false;
      }

      cluster.centroid = newCentroid;
    });

    iteration++;
  }

  return clusters.filter(cluster => cluster.points.length > 0);
}

// Enhanced K-means with multiple runs to find best clustering
export function enhancedKMeansClustering(points: Point[], k: number, runs: number = 5): Cluster[] {
  if (points.length === 0 || k <= 0) return [];
  
  let bestClusters: Cluster[] = [];
  let bestScore = Infinity;
  
  // Run K-means multiple times and pick the best result
  for (let run = 0; run < runs; run++) {
    const clusters = kMeansClustering(points, k);
    const score = calculateClusteringScore(clusters);
    
    if (score < bestScore) {
      bestScore = score;
      bestClusters = clusters;
    }
  }
  
  return bestClusters;
}

// Calculate optimal number of reps based on visit frequency requirements
export function calculateOptimalReps(outlets: any[], minVisitsPerDay: number = 6, maxVisitsPerDay: number = 12): number {
  if (outlets.length === 0) return 1;
  
  // Calculate total visits required per week
  const totalWeeklyVisits = outlets.reduce((total, outlet) => {
    return total + (outlet.visitFrequency || 2); // Default to VF2 if not specified
  }, 0);
  
  // Calculate visits per rep per week (assuming 5 working days)
  const avgVisitsPerDay = (minVisitsPerDay + maxVisitsPerDay) / 2;
  const visitsPerRepPerWeek = avgVisitsPerDay * 5;
  
  // Calculate required reps
  const requiredReps = Math.ceil(totalWeeklyVisits / visitsPerRepPerWeek);
  
  return Math.max(1, requiredReps);
}

// Workload-aware clustering that considers visit frequency
export function workloadBasedClustering(points: Point[], targetReps?: number, minVisitsPerDay: number = 6, maxVisitsPerDay: number = 12): Cluster[] {
  if (points.length === 0) return [];
  
  // Calculate optimal number of reps if not provided
  const optimalReps = targetReps || calculateOptimalReps(points.map(p => p.data));
  
  // Start with enhanced K-means clustering
  let clusters = enhancedKMeansClustering(points, optimalReps, 10);
  
  // Balance workload across clusters
  clusters = balanceClusterWorkload(clusters, minVisitsPerDay, maxVisitsPerDay);
  
  return clusters;
}

// Balance workload across clusters by redistributing outlets
function balanceClusterWorkload(clusters: Cluster[], minVisitsPerDay: number, maxVisitsPerDay: number): Cluster[] {
  const maxIterations = 10;
  let iteration = 0;
  
  while (iteration < maxIterations) {
    let improved = false;
    
    // Calculate workload for each cluster
    const clusterWorkloads = clusters.map(cluster => ({
      cluster,
      weeklyVisits: cluster.points.reduce((sum, point) => sum + (point.data?.visitFrequency || 2), 0),
      dailyVisits: cluster.points.reduce((sum, point) => sum + (point.data?.visitFrequency || 2), 0) / 5
    }));
    
    // Find overloaded and underloaded clusters
    const overloaded = clusterWorkloads.filter(c => c.dailyVisits > maxVisitsPerDay);
    const underloaded = clusterWorkloads.filter(c => c.dailyVisits < minVisitsPerDay);
    
    // Try to redistribute outlets from overloaded to underloaded clusters
    for (const overloadedCluster of overloaded) {
      for (const underloadedCluster of underloaded) {
        if (overloadedCluster.dailyVisits <= maxVisitsPerDay) break;
        
        // Find outlet in overloaded cluster that's closest to underloaded cluster
        let bestOutlet: Point | null = null;
        let bestDistance = Infinity;
        
        overloadedCluster.cluster.points.forEach(point => {
          const distance = calculateDistance(
            point.latitude,
            point.longitude,
            underloadedCluster.cluster.centroid.latitude,
            underloadedCluster.cluster.centroid.longitude
          );
          if (distance < bestDistance) {
            bestDistance = distance;
            bestOutlet = point;
          }
        });
        
        if (bestOutlet && underloadedCluster.dailyVisits + (bestOutlet.data?.visitFrequency || 2) / 5 <= maxVisitsPerDay) {
          // Move outlet
          overloadedCluster.cluster.points = overloadedCluster.cluster.points.filter(p => p.id !== bestOutlet!.id);
          underloadedCluster.cluster.points.push(bestOutlet);
          
          // Update workloads
          const outletVisits = (bestOutlet.data?.visitFrequency || 2) / 5;
          overloadedCluster.dailyVisits -= outletVisits;
          underloadedCluster.dailyVisits += outletVisits;
          
          improved = true;
        }
      }
    }
    
    if (!improved) break;
    iteration++;
  }
  
  // Recalculate centroids
  clusters.forEach(cluster => {
    if (cluster.points.length > 0) {
      cluster.centroid = {
        latitude: cluster.points.reduce((sum, p) => sum + p.latitude, 0) / cluster.points.length,
        longitude: cluster.points.reduce((sum, p) => sum + p.longitude, 0) / cluster.points.length
      };
    }
  });
  
  return clusters.filter(cluster => cluster.points.length > 0);
}

// Calculate clustering quality score (lower is better)
function calculateClusteringScore(clusters: Cluster[]): number {
  let totalScore = 0;
  
  clusters.forEach(cluster => {
    cluster.points.forEach(point => {
      const distance = calculateDistance(
        point.latitude,
        point.longitude,
        cluster.centroid.latitude,
        cluster.centroid.longitude
      );
      totalScore += distance * distance;
    });
  });
  
  return totalScore;
}

// DBSCAN clustering alternative for density-based clustering
export function dbscanClustering(points: Point[], epsilon: number = 0.5, minPoints: number = 3): Cluster[] {
  const clusters: Cluster[] = [];
  const visited = new Set<string>();
  const clustered = new Set<string>();
  let clusterId = 0;

  points.forEach(point => {
    if (visited.has(point.id)) return;
    visited.add(point.id);

    const neighbors = getNeighbors(point, points, epsilon);
    
    if (neighbors.length < minPoints) {
      // Point is noise - could be handled separately
      return;
    }

    // Create new cluster
    const cluster: Cluster = {
      id: clusterId++,
      centroid: { latitude: point.latitude, longitude: point.longitude },
      points: [point]
    };
    clustered.add(point.id);

    // Expand cluster
    const queue = [...neighbors];
    while (queue.length > 0) {
      const currentPoint = queue.shift()!;
      
      if (!visited.has(currentPoint.id)) {
        visited.add(currentPoint.id);
        const currentNeighbors = getNeighbors(currentPoint, points, epsilon);
        
        if (currentNeighbors.length >= minPoints) {
          queue.push(...currentNeighbors);
        }
      }

      if (!clustered.has(currentPoint.id)) {
        cluster.points.push(currentPoint);
        clustered.add(currentPoint.id);
      }
    }

    // Update centroid
    cluster.centroid = {
      latitude: cluster.points.reduce((sum, p) => sum + p.latitude, 0) / cluster.points.length,
      longitude: cluster.points.reduce((sum, p) => sum + p.longitude, 0) / cluster.points.length
    };

    clusters.push(cluster);
  });

  return clusters;
}

function getNeighbors(point: Point, points: Point[], epsilon: number): Point[] {
  return points.filter(p => {
    if (p.id === point.id) return false;
    const distance = calculateDistance(point.latitude, point.longitude, p.latitude, p.longitude);
    return distance <= epsilon;
  });
}

// Utility function to determine optimal number of clusters using elbow method
export function findOptimalClusters(points: Point[], maxK: number = 10): number {
  if (points.length <= 1) return 1;
  
  const wcss: number[] = []; // Within-cluster sum of squares
  
  for (let k = 1; k <= Math.min(maxK, points.length); k++) {
    const clusters = kMeansClustering(points, k);
    let totalWCSS = 0;
    
    clusters.forEach(cluster => {
      cluster.points.forEach(point => {
        const distance = calculateDistance(
          point.latitude,
          point.longitude,
          cluster.centroid.latitude,
          cluster.centroid.longitude
        );
        totalWCSS += distance * distance;
      });
    });
    
    wcss.push(totalWCSS);
  }
  
  // Find elbow point (simplified)
  let optimalK = 1;
  let maxImprovement = 0;
  
  for (let i = 1; i < wcss.length - 1; i++) {
    const improvement = wcss[i - 1] - wcss[i];
    const nextImprovement = wcss[i] - wcss[i + 1];
    const elbowStrength = improvement - nextImprovement;
    
    if (elbowStrength > maxImprovement) {
      maxImprovement = elbowStrength;
      optimalK = i + 1;
    }
  }
  
  return optimalK;
}

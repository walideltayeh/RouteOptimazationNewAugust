
// Enhanced clustering algorithms for optimal territory grouping
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
  workload: number;
  efficiency: number;
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

// Advanced K-means++ initialization with spatial awareness
export function kMeansClustering(points: Point[], k: number, maxIterations: number = 200): Cluster[] {
  if (points.length === 0 || k <= 0) return [];
  if (k >= points.length) {
    return points.map((point, index) => ({
      id: index,
      centroid: { latitude: point.latitude, longitude: point.longitude },
      points: [point],
      workload: point.data?.visitFrequency || 2,
      efficiency: 1.0
    }));
  }
  
  const clusters: Cluster[] = [];
  
  // Choose first centroid from the most central point
  const center = {
    lat: points.reduce((sum, p) => sum + p.latitude, 0) / points.length,
    lng: points.reduce((sum, p) => sum + p.longitude, 0) / points.length
  };
  
  let firstPoint = points[0];
  let minDistToCenter = Infinity;
  points.forEach(point => {
    const dist = calculateDistance(point.latitude, point.longitude, center.lat, center.lng);
    if (dist < minDistToCenter) {
      minDistToCenter = dist;
      firstPoint = point;
    }
  });
  
  clusters.push({
    id: 0,
    centroid: { latitude: firstPoint.latitude, longitude: firstPoint.longitude },
    points: [],
    workload: 0,
    efficiency: 0
  });
  
  // K-means++ for remaining centroids with workload consideration
  for (let i = 1; i < k; i++) {
    const distances: number[] = [];
    let totalWeightedDistance = 0;
    
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
      
      // Weight by visit frequency to encourage balanced workload
      const weight = Math.sqrt(point.data?.visitFrequency || 2);
      const weightedDistance = minDistance * minDistance * weight;
      distances.push(weightedDistance);
      totalWeightedDistance += weightedDistance;
    });
    
    const random = Math.random() * totalWeightedDistance;
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
      points: [],
      workload: 0,
      efficiency: 0
    });
  }

  let iteration = 0;
  let converged = false;
  let lastTotalInertia = Infinity;

  while (iteration < maxIterations && !converged) {
    // Clear previous assignments
    clusters.forEach(cluster => {
      cluster.points = [];
      cluster.workload = 0;
    });

    // Advanced assignment with workload balancing
    points.forEach(point => {
      let bestCluster = 0;
      let bestScore = Infinity;

      clusters.forEach((cluster, index) => {
        const distance = calculateDistance(
          point.latitude,
          point.longitude,
          cluster.centroid.latitude,
          cluster.centroid.longitude
        );
        
        // Calculate workload penalty
        const avgWorkload = points.reduce((sum, p) => sum + (p.data?.visitFrequency || 2), 0) / k;
        const workloadPenalty = Math.max(0, (cluster.workload - avgWorkload) / avgWorkload) * 2;
        
        // Combined score: distance + workload penalty
        const score = distance * (1 + workloadPenalty);

        if (score < bestScore) {
          bestScore = score;
          bestCluster = index;
        }
      });

      clusters[bestCluster].points.push(point);
      clusters[bestCluster].workload += point.data?.visitFrequency || 2;
    });

    // Update centroids with geometric median for better robustness
    let totalInertia = 0;
    clusters.forEach(cluster => {
      if (cluster.points.length === 0) return;

      const newCentroid = calculateGeometricMedian(cluster.points);
      
      // Calculate movement and inertia
      const movement = calculateDistance(
        cluster.centroid.latitude,
        cluster.centroid.longitude,
        newCentroid.latitude,
        newCentroid.longitude
      );

      cluster.points.forEach(point => {
        const dist = calculateDistance(
          point.latitude,
          point.longitude,
          newCentroid.latitude,
          newCentroid.longitude
        );
        totalInertia += dist * dist;
      });

      cluster.centroid = newCentroid;
      cluster.efficiency = cluster.points.length > 0 ? 
        1.0 / (1.0 + calculateClusterSpread(cluster)) : 0;
    });

    // Check for convergence
    const inertiaImprovement = (lastTotalInertia - totalInertia) / lastTotalInertia;
    converged = inertiaImprovement < 0.001; // 0.1% improvement threshold
    lastTotalInertia = totalInertia;

    iteration++;
  }

  return clusters.filter(cluster => cluster.points.length > 0);
}

// Calculate geometric median for more robust centroid calculation
function calculateGeometricMedian(points: Point[]): { latitude: number; longitude: number } {
  if (points.length === 1) {
    return { latitude: points[0].latitude, longitude: points[0].longitude };
  }
  
  // Start with centroid
  let medianLat = points.reduce((sum, p) => sum + p.latitude, 0) / points.length;
  let medianLng = points.reduce((sum, p) => sum + p.longitude, 0) / points.length;
  
  // Iterative improvement using Weiszfeld's algorithm
  for (let iter = 0; iter < 10; iter++) {
    let weightSum = 0;
    let weightedLatSum = 0;
    let weightedLngSum = 0;
    
    points.forEach(point => {
      const dist = calculateDistance(point.latitude, point.longitude, medianLat, medianLng);
      const weight = dist > 0 ? 1 / dist : 1000; // Avoid division by zero
      
      weightSum += weight;
      weightedLatSum += weight * point.latitude;
      weightedLngSum += weight * point.longitude;
    });
    
    if (weightSum > 0) {
      const newLat = weightedLatSum / weightSum;
      const newLng = weightedLngSum / weightSum;
      
      // Check for convergence
      const movement = calculateDistance(medianLat, medianLng, newLat, newLng);
      if (movement < 0.001) break;
      
      medianLat = newLat;
      medianLng = newLng;
    }
  }
  
  return { latitude: medianLat, longitude: medianLng };
}

// Calculate cluster spread for efficiency metric
function calculateClusterSpread(cluster: Cluster): number {
  if (cluster.points.length <= 1) return 0;
  
  const distances = cluster.points.map(point => 
    calculateDistance(
      point.latitude,
      point.longitude,
      cluster.centroid.latitude,
      cluster.centroid.longitude
    )
  );
  
  return distances.reduce((sum, d) => sum + d, 0) / distances.length;
}

// Enhanced clustering with multiple algorithms and selection
export function enhancedKMeansClustering(points: Point[], k: number, runs: number = 10): Cluster[] {
  if (points.length === 0 || k <= 0) return [];
  
  let bestClusters: Cluster[] = [];
  let bestScore = Infinity;
  
  // Multiple runs with different initializations
  for (let run = 0; run < runs; run++) {
    const clusters = kMeansClustering(points, k);
    const score = calculateAdvancedClusteringScore(clusters);
    
    if (score < bestScore) {
      bestScore = score;
      bestClusters = clusters;
    }
  }
  
  return bestClusters;
}

// Advanced scoring that considers multiple factors
function calculateAdvancedClusteringScore(clusters: Cluster[]): number {
  let totalScore = 0;
  
  // Factor 1: Spatial compactness
  let spatialScore = 0;
  clusters.forEach(cluster => {
    cluster.points.forEach(point => {
      const distance = calculateDistance(
        point.latitude,
        point.longitude,
        cluster.centroid.latitude,
        cluster.centroid.longitude
      );
      spatialScore += distance * distance;
    });
  });
  
  // Factor 2: Workload balance
  const avgWorkload = clusters.reduce((sum, c) => sum + c.workload, 0) / clusters.length;
  let workloadScore = 0;
  clusters.forEach(cluster => {
    const deviation = Math.abs(cluster.workload - avgWorkload) / avgWorkload;
    workloadScore += deviation * deviation;
  });
  
  // Factor 3: Silhouette coefficient for cluster quality
  let silhouetteScore = calculateSilhouetteCoefficient(clusters);
  
  // Combined score (lower is better)
  totalScore = spatialScore + workloadScore * 100 + (1 - silhouetteScore) * 50;
  
  return totalScore;
}

// Calculate silhouette coefficient for cluster quality assessment
function calculateSilhouetteCoefficient(clusters: Cluster[]): number {
  if (clusters.length <= 1) return 1;
  
  let totalSilhouette = 0;
  let pointCount = 0;
  
  clusters.forEach(cluster => {
    cluster.points.forEach(point => {
      // a: average distance to points in same cluster
      let a = 0;
      if (cluster.points.length > 1) {
        cluster.points.forEach(otherPoint => {
          if (point.id !== otherPoint.id) {
            a += calculateDistance(
              point.latitude, point.longitude,
              otherPoint.latitude, otherPoint.longitude
            );
          }
        });
        a /= (cluster.points.length - 1);
      }
      
      // b: minimum average distance to points in other clusters
      let b = Infinity;
      clusters.forEach(otherCluster => {
        if (otherCluster.id !== cluster.id && otherCluster.points.length > 0) {
          let avgDist = 0;
          otherCluster.points.forEach(otherPoint => {
            avgDist += calculateDistance(
              point.latitude, point.longitude,
              otherPoint.latitude, otherPoint.longitude
            );
          });
          avgDist /= otherCluster.points.length;
          b = Math.min(b, avgDist);
        }
      });
      
      // Silhouette coefficient for this point
      const silhouette = b === Infinity ? 0 : (b - a) / Math.max(a, b);
      totalSilhouette += silhouette;
      pointCount++;
    });
  });
  
  return pointCount > 0 ? totalSilhouette / pointCount : 0;
}

// Calculate optimal number of reps with more sophisticated analysis
export function calculateOptimalReps(outlets: any[], minVisitsPerDay: number = 6, maxVisitsPerDay: number = 12): number {
  if (outlets.length === 0) return 1;
  
  // Calculate total visits required per week
  const totalWeeklyVisits = outlets.reduce((total, outlet) => {
    return total + (outlet.visitFrequency || 2);
  }, 0);
  
  // Calculate geographic spread to adjust for travel time
  const points = outlets.map(o => ({ latitude: o.latitude, longitude: o.longitude }));
  const spread = calculateGeographicSpread(points);
  
  // Adjust visits per day based on geographic spread
  const spreadPenalty = Math.min(0.3, spread / 50); // Max 30% reduction for very spread out areas
  const adjustedMaxVisits = maxVisitsPerDay * (1 - spreadPenalty);
  const adjustedMinVisits = minVisitsPerDay * (1 - spreadPenalty);
  
  // Calculate visits per rep per week (assuming 5 working days)
  const avgVisitsPerDay = (adjustedMinVisits + adjustedMaxVisits) / 2;
  const visitsPerRepPerWeek = avgVisitsPerDay * 5;
  
  // Calculate required reps with buffer for efficiency
  const baseReps = Math.ceil(totalWeeklyVisits / visitsPerRepPerWeek);
  const efficiency = 0.85; // Account for travel time and inefficiencies
  const requiredReps = Math.ceil(baseReps / efficiency);
  
  return Math.max(1, Math.min(requiredReps, Math.ceil(outlets.length / 3))); // Max one rep per 3 outlets
}

// Calculate geographic spread of points
function calculateGeographicSpread(points: { latitude: number; longitude: number }[]): number {
  if (points.length <= 1) return 0;
  
  // Find bounding box
  const minLat = Math.min(...points.map(p => p.latitude));
  const maxLat = Math.max(...points.map(p => p.latitude));
  const minLng = Math.min(...points.map(p => p.longitude));
  const maxLng = Math.max(...points.map(p => p.longitude));
  
  // Calculate diagonal distance of bounding box
  const diagonal = calculateDistance(minLat, minLng, maxLat, maxLng);
  
  return diagonal;
}

// Advanced workload-based clustering with multiple optimization passes
export function workloadBasedClustering(
  points: Point[], 
  targetReps?: number, 
  minVisitsPerDay: number = 6, 
  maxVisitsPerDay: number = 12
): Cluster[] {
  if (points.length === 0) return [];
  
  // Calculate optimal number of reps if not provided
  const optimalReps = targetReps || calculateOptimalReps(points.map(p => p.data), minVisitsPerDay, maxVisitsPerDay);
  
  // Start with enhanced K-means clustering
  let clusters = enhancedKMeansClustering(points, optimalReps, 15);
  
  // Multiple optimization passes
  for (let pass = 0; pass < 3; pass++) {
    clusters = balanceClusterWorkload(clusters, minVisitsPerDay, maxVisitsPerDay);
    clusters = optimizeClusterBoundaries(clusters);
    clusters = redistributeOutliers(clusters);
  }
  
  // Final quality check and adjustment
  clusters = ensureMinimumViability(clusters, minVisitsPerDay);
  
  return clusters;
}

// Optimize cluster boundaries by swapping border points
function optimizeClusterBoundaries(clusters: Cluster[]): Cluster[] {
  const improved = [...clusters];
  let madeChanges = true;
  let iterations = 0;
  
  while (madeChanges && iterations < 10) {
    madeChanges = false;
    iterations++;
    
    for (let i = 0; i < improved.length; i++) {
      for (let j = i + 1; j < improved.length; j++) {
        const cluster1 = improved[i];
        const cluster2 = improved[j];
        
        // Find boundary points (points close to other cluster centroids)
        const boundaryPoints1 = cluster1.points.filter(point => {
          const distToOwn = calculateDistance(
            point.latitude, point.longitude,
            cluster1.centroid.latitude, cluster1.centroid.longitude
          );
          const distToOther = calculateDistance(
            point.latitude, point.longitude,
            cluster2.centroid.latitude, cluster2.centroid.longitude
          );
          return Math.abs(distToOwn - distToOther) < 2; // Within 2km difference
        });
        
        const boundaryPoints2 = cluster2.points.filter(point => {
          const distToOwn = calculateDistance(
            point.latitude, point.longitude,
            cluster2.centroid.latitude, cluster2.centroid.longitude
          );
          const distToOther = calculateDistance(
            point.latitude, point.longitude,
            cluster1.centroid.latitude, cluster1.centroid.longitude
          );
          return Math.abs(distToOwn - distToOther) < 2;
        });
        
        // Try swapping boundary points
        for (const point1 of boundaryPoints1.slice(0, 2)) { // Limit to avoid excessive computation
          for (const point2 of boundaryPoints2.slice(0, 2)) {
            if (wouldImproveSwap(cluster1, cluster2, point1, point2)) {
              // Perform the swap
              cluster1.points = cluster1.points.filter(p => p.id !== point1.id);
              cluster1.points.push(point2);
              cluster2.points = cluster2.points.filter(p => p.id !== point2.id);
              cluster2.points.push(point1);
              
              // Update workloads
              cluster1.workload = cluster1.workload - (point1.data?.visitFrequency || 2) + (point2.data?.visitFrequency || 2);
              cluster2.workload = cluster2.workload - (point2.data?.visitFrequency || 2) + (point1.data?.visitFrequency || 2);
              
              madeChanges = true;
            }
          }
        }
        
        // Recalculate centroids if changes were made
        if (madeChanges) {
          if (cluster1.points.length > 0) {
            cluster1.centroid = calculateGeometricMedian(cluster1.points);
          }
          if (cluster2.points.length > 0) {
            cluster2.centroid = calculateGeometricMedian(cluster2.points);
          }
        }
      }
    }
  }
  
  return improved;
}

// Check if swapping two points would improve clustering
function wouldImproveSwap(cluster1: Cluster, cluster2: Cluster, point1: Point, point2: Point): boolean {
  // Calculate current distances
  const currentDist1 = calculateDistance(
    point1.latitude, point1.longitude,
    cluster1.centroid.latitude, cluster1.centroid.longitude
  );
  const currentDist2 = calculateDistance(
    point2.latitude, point2.longitude,
    cluster2.centroid.latitude, cluster2.centroid.longitude
  );
  
  // Calculate distances after swap
  const newDist1 = calculateDistance(
    point1.latitude, point1.longitude,
    cluster2.centroid.latitude, cluster2.centroid.longitude
  );
  const newDist2 = calculateDistance(
    point2.latitude, point2.longitude,
    cluster1.centroid.latitude, cluster1.centroid.longitude
  );
  
  // Check if total distance improves
  const currentTotal = currentDist1 + currentDist2;
  const newTotal = newDist1 + newDist2;
  
  return newTotal < currentTotal * 0.95; // Require 5% improvement to avoid minor swaps
}

// Redistribute outlier points to better clusters
function redistributeOutliers(clusters: Cluster[]): Cluster[] {
  const improved = [...clusters];
  
  improved.forEach(cluster => {
    const outliers = cluster.points.filter(point => {
      const distToCentroid = calculateDistance(
        point.latitude, point.longitude,
        cluster.centroid.latitude, cluster.centroid.longitude
      );
      
      // Consider point an outlier if it's much farther from centroid than average
      const avgDistance = cluster.points.reduce((sum, p) => {
        return sum + calculateDistance(
          p.latitude, p.longitude,
          cluster.centroid.latitude, cluster.centroid.longitude
        );
      }, 0) / cluster.points.length;
      
      return distToCentroid > avgDistance * 2; // More than 2x average distance
    });
    
    outliers.forEach(outlier => {
      // Find the best cluster for this outlier
      let bestCluster = cluster;
      let bestDistance = calculateDistance(
        outlier.latitude, outlier.longitude,
        cluster.centroid.latitude, cluster.centroid.longitude
      );
      
      improved.forEach(otherCluster => {
        if (otherCluster.id !== cluster.id) {
          const distance = calculateDistance(
            outlier.latitude, outlier.longitude,
            otherCluster.centroid.latitude, otherCluster.centroid.longitude
          );
          
          if (distance < bestDistance * 0.7) { // Significant improvement required
            bestCluster = otherCluster;
            bestDistance = distance;
          }
        }
      });
      
      // Move outlier to better cluster
      if (bestCluster.id !== cluster.id) {
        cluster.points = cluster.points.filter(p => p.id !== outlier.id);
        cluster.workload -= outlier.data?.visitFrequency || 2;
        
        bestCluster.points.push(outlier);
        bestCluster.workload += outlier.data?.visitFrequency || 2;
      }
    });
  });
  
  // Recalculate centroids
  improved.forEach(cluster => {
    if (cluster.points.length > 0) {
      cluster.centroid = calculateGeometricMedian(cluster.points);
    }
  });
  
  return improved.filter(cluster => cluster.points.length > 0);
}

// Enhanced workload balancing with smarter redistribution
function balanceClusterWorkload(clusters: Cluster[], minVisitsPerDay: number, maxVisitsPerDay: number): Cluster[] {
  const maxIterations = 20;
  let iteration = 0;
  
  while (iteration < maxIterations) {
    let improved = false;
    
    // Calculate workload statistics
    const workloads = clusters.map(c => c.workload / 5); // Daily visits
    const avgWorkload = workloads.reduce((sum, w) => sum + w, 0) / workloads.length;
    
    // Identify problematic clusters
    const overloaded = clusters.filter(c => c.workload / 5 > maxVisitsPerDay * 1.1);
    const underloaded = clusters.filter(c => c.workload / 5 < minVisitsPerDay * 0.9);
    
    // Smart redistribution
    for (const overloadedCluster of overloaded) {
      if (overloadedCluster.workload / 5 <= maxVisitsPerDay) break;
      
      // Find best candidates for redistribution
      const candidates = overloadedCluster.points
        .map(point => ({
          point,
          workload: point.data?.visitFrequency || 2,
          distanceToCurrentCentroid: calculateDistance(
            point.latitude, point.longitude,
            overloadedCluster.centroid.latitude, overloadedCluster.centroid.longitude
          )
        }))
        .sort((a, b) => b.distanceToCurrentCentroid - a.distanceToCurrentCentroid) // Farthest first
        .slice(0, 5); // Consider only top 5 candidates
      
      for (const candidate of candidates) {
        if (overloadedCluster.workload / 5 <= maxVisitsPerDay) break;
        
        // Find best destination cluster
        let bestDestination: Cluster | null = null;
        let bestScore = Infinity;
        
        for (const cluster of clusters) {
          if (cluster.id === overloadedCluster.id) continue;
          
          const newWorkload = (cluster.workload + candidate.workload) / 5;
          if (newWorkload > maxVisitsPerDay * 1.2) continue; // Too much workload
          
          const distance = calculateDistance(
            candidate.point.latitude, candidate.point.longitude,
            cluster.centroid.latitude, cluster.centroid.longitude
          );
          
          // Score based on distance and workload balance improvement
          const workloadImprovement = Math.abs(cluster.workload / 5 - avgWorkload) - 
                                    Math.abs(newWorkload - avgWorkload);
          const score = distance - workloadImprovement * 2; // Favor workload balance
          
          if (score < bestScore) {
            bestScore = score;
            bestDestination = cluster;
          }
        }
        
        // Move point if beneficial
        if (bestDestination && bestScore < candidate.distanceToCurrentCentroid * 0.8) {
          overloadedCluster.points = overloadedCluster.points.filter(p => p.id !== candidate.point.id);
          overloadedCluster.workload -= candidate.workload;
          
          bestDestination.points.push(candidate.point);
          bestDestination.workload += candidate.workload;
          
          improved = true;
        }
      }
    }
    
    // Fill underloaded clusters
    for (const underloadedCluster of underloaded) {
      if (underloadedCluster.workload / 5 >= minVisitsPerDay) break;
      
      // Find nearby points from other clusters
      const nearbyPoints: Array<{point: Point, sourceCluster: Cluster, distance: number, workload: number}> = [];
      
      clusters.forEach(sourceCluster => {
        if (sourceCluster.id === underloadedCluster.id) continue;
        if (sourceCluster.workload / 5 <= minVisitsPerDay * 1.1) return; // Don't take from balanced clusters
        
        sourceCluster.points.forEach(point => {
          const distance = calculateDistance(
            point.latitude, point.longitude,
            underloadedCluster.centroid.latitude, underloadedCluster.centroid.longitude
          );
          
          if (distance < 15) { // Within 15km
            nearbyPoints.push({
              point,
              sourceCluster,
              distance,
              workload: point.data?.visitFrequency || 2
            });
          }
        });
      });
      
      // Sort by distance and try to move points
      nearbyPoints.sort((a, b) => a.distance - b.distance);
      
      for (const nearby of nearbyPoints.slice(0, 3)) {
        const newWorkload = (underloadedCluster.workload + nearby.workload) / 5;
        const sourceNewWorkload = (nearby.sourceCluster.workload - nearby.workload) / 5;
        
        if (newWorkload <= maxVisitsPerDay && sourceNewWorkload >= minVisitsPerDay * 0.8) {
          // Move the point
          nearby.sourceCluster.points = nearby.sourceCluster.points.filter(p => p.id !== nearby.point.id);
          nearby.sourceCluster.workload -= nearby.workload;
          
          underloadedCluster.points.push(nearby.point);
          underloadedCluster.workload += nearby.workload;
          
          improved = true;
          break;
        }
      }
    }
    
    if (!improved) break;
    
    // Recalculate centroids
    clusters.forEach(cluster => {
      if (cluster.points.length > 0) {
        cluster.centroid = calculateGeometricMedian(cluster.points);
      }
    });
    
    iteration++;
  }
  
  return clusters.filter(cluster => cluster.points.length > 0);
}

// Ensure all clusters meet minimum viability requirements
function ensureMinimumViability(clusters: Cluster[], minVisitsPerDay: number): Cluster[] {
  const viable = clusters.filter(cluster => {
    const dailyVisits = cluster.workload / 5;
    return dailyVisits >= minVisitsPerDay * 0.5 && cluster.points.length >= 1;
  });
  
  // Redistribute points from non-viable clusters
  const nonViable = clusters.filter(cluster => {
    const dailyVisits = cluster.workload / 5;
    return dailyVisits < minVisitsPerDay * 0.5 || cluster.points.length === 0;
  });
  
  nonViable.forEach(cluster => {
    cluster.points.forEach(point => {
      // Find closest viable cluster
      let closestCluster = viable[0];
      let closestDistance = Infinity;
      
      viable.forEach(viableCluster => {
        const distance = calculateDistance(
          point.latitude, point.longitude,
          viableCluster.centroid.latitude, viableCluster.centroid.longitude
        );
        
        if (distance < closestDistance) {
          closestDistance = distance;
          closestCluster = viableCluster;
        }
      });
      
      if (closestCluster) {
        closestCluster.points.push(point);
        closestCluster.workload += point.data?.visitFrequency || 2;
      }
    });
  });
  
  // Recalculate centroids for viable clusters
  viable.forEach(cluster => {
    if (cluster.points.length > 0) {
      cluster.centroid = calculateGeometricMedian(cluster.points);
    }
  });
  
  return viable;
}

// DBSCAN clustering for density-based grouping (kept for compatibility)
export function dbscanClustering(points: Point[], epsilon: number = 0.5, minPoints: number = 3): Cluster[] {
  const clusters: Cluster[] = [];
  const visited = new Set<string>();
  const clustered = new Set<string>();
  let clusterId = 0;

  points.forEach(point => {
    if (visited.has(point.id)) return;
    visited.add(point.id);

    const neighbors = getNeighbors(point, points, epsilon);
    
    if (neighbors.length < minPoints) return;

    const cluster: Cluster = {
      id: clusterId++,
      centroid: { latitude: point.latitude, longitude: point.longitude },
      points: [point],
      workload: point.data?.visitFrequency || 2,
      efficiency: 0
    };
    clustered.add(point.id);

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
        cluster.workload += currentPoint.data?.visitFrequency || 2;
        clustered.add(currentPoint.id);
      }
    }

    cluster.centroid = calculateGeometricMedian(cluster.points);
    cluster.efficiency = 1.0 / (1.0 + calculateClusterSpread(cluster));
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

// Enhanced elbow method with multiple metrics
export function findOptimalClusters(points: Point[], maxK: number = 10): number {
  if (points.length <= 1) return 1;
  
  const scores: Array<{k: number, inertia: number, silhouette: number, workloadBalance: number}> = [];
  
  for (let k = 1; k <= Math.min(maxK, points.length); k++) {
    const clusters = enhancedKMeansClustering(points, k, 5);
    
    // Calculate inertia (WCSS)
    let inertia = 0;
    clusters.forEach(cluster => {
      cluster.points.forEach(point => {
        const distance = calculateDistance(
          point.latitude, point.longitude,
          cluster.centroid.latitude, cluster.centroid.longitude
        );
        inertia += distance * distance;
      });
    });
    
    // Calculate silhouette coefficient
    const silhouette = calculateSilhouetteCoefficient(clusters);
    
    // Calculate workload balance
    const workloads = clusters.map(c => c.workload);
    const avgWorkload = workloads.reduce((sum, w) => sum + w, 0) / workloads.length;
    const workloadBalance = workloads.reduce((sum, w) => sum + Math.abs(w - avgWorkload), 0) / workloads.length;
    
    scores.push({ k, inertia, silhouette, workloadBalance });
  }
  
  // Find optimal k using multiple criteria
  let optimalK = 1;
  let bestScore = -Infinity;
  
  for (let i = 1; i < scores.length; i++) {
    const score = scores[i];
    
    // Composite score: high silhouette, low workload variance, reasonable inertia reduction
    const normalizedSilhouette = score.silhouette;
    const normalizedWorkloadBalance = 1 / (1 + score.workloadBalance / 10);
    const elbowStrength = i > 0 ? (scores[i-1].inertia - score.inertia) / scores[0].inertia : 0;
    
    const compositeScore = normalizedSilhouette * 0.4 + normalizedWorkloadBalance * 0.3 + elbowStrength * 0.3;
    
    if (compositeScore > bestScore) {
      bestScore = compositeScore;
      optimalK = score.k;
    }
  }
  
  return optimalK;
}

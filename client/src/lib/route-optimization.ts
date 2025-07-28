import { calculateDistance } from "./clustering";

export interface RoutePoint {
  id: string;
  latitude: number;
  longitude: number;
  visitFrequency: number;
  name: string;
  timeWindow?: {
    start: number; // Hour of day (0-23)
    end: number;   // Hour of day (0-23)
  };
}

export interface OptimizedRoute {
  points: RoutePoint[];
  totalDistance: number;
  estimatedDuration: number; // in minutes
  efficiency: number;
}

// Traveling Salesman Problem solver using nearest neighbor heuristic
export function solveTSP(points: RoutePoint[], startPoint?: RoutePoint): OptimizedRoute {
  if (points.length === 0) {
    return { points: [], totalDistance: 0, estimatedDuration: 0, efficiency: 0 };
  }

  if (points.length === 1) {
    return { 
      points: points, 
      totalDistance: 0, 
      estimatedDuration: 30, // 30 minutes for single visit
      efficiency: 100 
    };
  }

  const unvisited = [...points];
  const route: RoutePoint[] = [];
  let totalDistance = 0;

  // Start from specified point or first point
  let currentPoint = startPoint || unvisited[0];
  route.push(currentPoint);
  unvisited.splice(unvisited.indexOf(currentPoint), 1);

  // Nearest neighbor algorithm
  while (unvisited.length > 0) {
    let nearestPoint = unvisited[0];
    let nearestDistance = calculateDistance(
      currentPoint.latitude,
      currentPoint.longitude,
      nearestPoint.latitude,
      nearestPoint.longitude
    );

    // Find the nearest unvisited point
    for (let i = 1; i < unvisited.length; i++) {
      const distance = calculateDistance(
        currentPoint.latitude,
        currentPoint.longitude,
        unvisited[i].latitude,
        unvisited[i].longitude
      );

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPoint = unvisited[i];
      }
    }

    route.push(nearestPoint);
    totalDistance += nearestDistance;
    currentPoint = nearestPoint;
    unvisited.splice(unvisited.indexOf(nearestPoint), 1);
  }

  // Calculate estimated duration (travel time + visit time)
  const avgVisitTime = 30; // 30 minutes per visit
  const avgTravelSpeed = 40; // 40 km/h average speed
  const travelTime = (totalDistance / avgTravelSpeed) * 60; // Convert to minutes
  const visitTime = route.length * avgVisitTime;
  const estimatedDuration = Math.round(travelTime + visitTime);

  // Calculate efficiency (simple metric based on distance vs straight-line distance)
  const straightLineDistance = points.length > 1 ? 
    calculateDistance(
      points[0].latitude,
      points[0].longitude,
      points[points.length - 1].latitude,
      points[points.length - 1].longitude
    ) : 0;
  
  const efficiency = straightLineDistance > 0 ? 
    Math.min(100, Math.round((straightLineDistance / totalDistance) * 100)) : 100;

  return {
    points: route,
    totalDistance: Math.round(totalDistance * 100) / 100,
    estimatedDuration,
    efficiency
  };
}

// 2-opt improvement algorithm
export function improve2Opt(route: RoutePoint[], maxIterations: number = 100): OptimizedRoute {
  let bestRoute = [...route];
  let bestDistance = calculateRouteDistance(bestRoute);
  let improved = true;
  let iteration = 0;

  while (improved && iteration < maxIterations) {
    improved = false;
    iteration++;

    for (let i = 1; i < bestRoute.length - 2; i++) {
      for (let j = i + 1; j < bestRoute.length; j++) {
        if (j - i === 1) continue; // Skip adjacent edges

        const newRoute = twoOptSwap(bestRoute, i, j);
        const newDistance = calculateRouteDistance(newRoute);

        if (newDistance < bestDistance) {
          bestRoute = newRoute;
          bestDistance = newDistance;
          improved = true;
        }
      }
    }
  }

  return solveTSP(bestRoute); // Recalculate metrics
}

function twoOptSwap(route: RoutePoint[], i: number, j: number): RoutePoint[] {
  const newRoute = [...route];
  
  // Reverse the segment between i and j
  const segment = newRoute.slice(i, j + 1).reverse();
  return [
    ...newRoute.slice(0, i),
    ...segment,
    ...newRoute.slice(j + 1)
  ];
}

function calculateRouteDistance(route: RoutePoint[]): number {
  let totalDistance = 0;
  
  for (let i = 0; i < route.length - 1; i++) {
    totalDistance += calculateDistance(
      route[i].latitude,
      route[i].longitude,
      route[i + 1].latitude,
      route[i + 1].longitude
    );
  }
  
  return totalDistance;
}

// Generate optimized schedules for multiple reps
export interface RepSchedule {
  repId: string;
  dailyRoutes: {
    dayOfWeek: number;
    week: number;
    route: OptimizedRoute;
  }[];
  weeklyStats: {
    totalDistance: number;
    totalVisits: number;
    avgEfficiency: number;
  };
}

export function generateRepSchedules(
  points: RoutePoint[],
  repCount: number,
  settings: {
    minVisitsPerDay: number;
    maxVisitsPerDay: number;
    workingDaysPerWeek: number;
  }
): RepSchedule[] {
  const schedules: RepSchedule[] = [];
  const pointsPerRep = Math.ceil(points.length / repCount);
  
  for (let repIndex = 0; repIndex < repCount; repIndex++) {
    const repId = `rep-${repIndex + 1}`;
    const repPoints = points.slice(repIndex * pointsPerRep, (repIndex + 1) * pointsPerRep);
    
    if (repPoints.length === 0) continue;

    // Calculate weekly visit requirements
    const totalWeeklyVisits = repPoints.reduce((sum, point) => sum + point.visitFrequency, 0);
    const visitsPerDay = Math.ceil(totalWeeklyVisits / (settings.workingDaysPerWeek * 2)); // 2 weeks cycle
    
    // Generate daily routes for 2-week cycle (Week 1 = Week 3, Week 2 = Week 4)
    const dailyRoutes = [];
    let remainingPoints = [...repPoints];
    
    for (let week = 1; week <= 2; week++) {
      for (let day = 1; day <= settings.workingDaysPerWeek; day++) {
        const dailyPoints = [];
        let dailyVisitCount = 0;
        
        // Select points for this day based on visit frequency and constraints
        const availablePoints = remainingPoints.filter(point => {
          const requiredVisitsThisWeek = point.visitFrequency >= 4 ? 2 : 1;
          return dailyVisitCount < settings.maxVisitsPerDay;
        });
        
        while (dailyVisitCount < settings.maxVisitsPerDay && availablePoints.length > 0) {
          const point = availablePoints.shift()!;
          dailyPoints.push(point);
          dailyVisitCount++;
          
          // Remove point from remaining if it's been scheduled enough times
          const timesScheduled = dailyRoutes.filter(route => 
            route.route.points.some(p => p.id === point.id)
          ).length + 1;
          
          const requiredVisits = point.visitFrequency >= 4 ? 2 : 1;
          if (timesScheduled >= requiredVisits) {
            remainingPoints = remainingPoints.filter(p => p.id !== point.id);
          }
        }
        
        const route = solveTSP(dailyPoints);
        dailyRoutes.push({
          dayOfWeek: day,
          week,
          route
        });
      }
    }
    
    // Calculate weekly stats
    const weeklyStats = {
      totalDistance: dailyRoutes.reduce((sum, dr) => sum + dr.route.totalDistance, 0),
      totalVisits: dailyRoutes.reduce((sum, dr) => sum + dr.route.points.length, 0),
      avgEfficiency: Math.round(
        dailyRoutes.reduce((sum, dr) => sum + dr.route.efficiency, 0) / Math.max(dailyRoutes.length, 1)
      )
    };
    
    schedules.push({
      repId,
      dailyRoutes,
      weeklyStats
    });
  }
  
  return schedules;
}

// Validate route constraints
export function validateRoute(route: OptimizedRoute, constraints: {
  maxDistance?: number;
  maxDuration?: number;
  maxVisits?: number;
}): { isValid: boolean; violations: string[] } {
  const violations: string[] = [];
  
  if (constraints.maxDistance && route.totalDistance > constraints.maxDistance) {
    violations.push(`Route distance (${route.totalDistance} km) exceeds maximum (${constraints.maxDistance} km)`);
  }
  
  if (constraints.maxDuration && route.estimatedDuration > constraints.maxDuration) {
    violations.push(`Route duration (${route.estimatedDuration} min) exceeds maximum (${constraints.maxDuration} min)`);
  }
  
  if (constraints.maxVisits && route.points.length > constraints.maxVisits) {
    violations.push(`Route visits (${route.points.length}) exceed maximum (${constraints.maxVisits})`);
  }
  
  return {
    isValid: violations.length === 0,
    violations
  };
}

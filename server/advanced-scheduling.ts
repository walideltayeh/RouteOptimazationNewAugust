import type { Outlet, Schedule, InsertSchedule } from "@shared/schema";

interface SchedulingOutlet extends Outlet {
  scheduledVisits: number[];  // Array of day numbers (1-20 for a 4-week month)
}

interface DaySlot {
  week: number;
  dayOfWeek: number;
  dayNumber: number; // 1-20 for 4 weeks * 5 days
  outlets: string[];
  visitCount: number;
}

interface SchedulingSettings {
  minVisitsPerDay: number;
  maxVisitsPerDay: number;
  workingDaysPerWeek: number;
  weeksInMonth: number;
}

function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function optimizeRouteOrder(outlets: Outlet[]): Outlet[] {
  if (outlets.length <= 1) return outlets;
  
  const unvisited = [...outlets];
  const route: Outlet[] = [];
  
  // Start from the outlet closest to the centroid
  const avgLat = outlets.reduce((sum, o) => sum + o.latitude, 0) / outlets.length;
  const avgLng = outlets.reduce((sum, o) => sum + o.longitude, 0) / outlets.length;
  
  let startIdx = 0;
  let minDist = Infinity;
  outlets.forEach((outlet, idx) => {
    const dist = calculateDistance(avgLat, avgLng, outlet.latitude, outlet.longitude);
    if (dist < minDist) {
      minDist = dist;
      startIdx = idx;
    }
  });
  
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
  
  // 2-opt improvement
  let improved = true;
  let iterations = 0;
  while (improved && iterations < 50) {
    improved = false;
    iterations++;
    
    for (let i = 1; i < route.length - 2; i++) {
      for (let j = i + 1; j < route.length; j++) {
        if (j - i === 1) continue;
        
        const d1 = calculateDistance(
          route[i - 1].latitude, route[i - 1].longitude,
          route[i].latitude, route[i].longitude
        ) + calculateDistance(
          route[j - 1].latitude, route[j - 1].longitude,
          route[j].latitude, route[j].longitude
        );
        
        const d2 = calculateDistance(
          route[i - 1].latitude, route[i - 1].longitude,
          route[j - 1].latitude, route[j - 1].longitude
        ) + calculateDistance(
          route[i].latitude, route[i].longitude,
          route[j].latitude, route[j].longitude
        );
        
        if (d2 < d1) {
          const reversed = route.slice(i, j).reverse();
          route.splice(i, j - i, ...reversed);
          improved = true;
        }
      }
    }
  }
  
  return route;
}

function calculateRouteDistance(outlets: Outlet[]): number {
  let total = 0;
  for (let i = 1; i < outlets.length; i++) {
    total += calculateDistance(
      outlets[i - 1].latitude, outlets[i - 1].longitude,
      outlets[i].latitude, outlets[i].longitude
    );
  }
  return total;
}

export function generateAdvancedSchedule(
  outlets: Outlet[],
  repId: string,
  territory: string,
  settings: SchedulingSettings
): InsertSchedule[] {
  const { minVisitsPerDay, maxVisitsPerDay, workingDaysPerWeek, weeksInMonth } = settings;
  const totalDaysInMonth = workingDaysPerWeek * weeksInMonth;
  
  // Initialize day slots
  const daySlots: DaySlot[] = [];
  for (let week = 1; week <= weeksInMonth; week++) {
    for (let day = 1; day <= workingDaysPerWeek; day++) {
      daySlots.push({
        week,
        dayOfWeek: day,
        dayNumber: (week - 1) * workingDaysPerWeek + day,
        outlets: [],
        visitCount: 0
      });
    }
  }
  
  // Separate outlets by visit frequency
  const vf4Outlets = outlets.filter(o => o.visitFrequency === 4);
  const vf2Outlets = outlets.filter(o => o.visitFrequency === 2);
  const vf1Outlets = outlets.filter(o => o.visitFrequency === 1);
  
  console.log(`Scheduling for ${territory}: VF4=${vf4Outlets.length}, VF2=${vf2Outlets.length}, VF1=${vf1Outlets.length}`);
  
  // Schedule VF4 outlets first (weekly visits - 4 times per month)
  // Each VF4 outlet should be visited once per week, spread across different days
  for (const outlet of vf4Outlets) {
    // Find the best day in each week that minimizes daily load imbalance
    for (let week = 1; week <= weeksInMonth; week++) {
      const weekSlots = daySlots.filter(s => s.week === week);
      // Find the slot with the fewest visits that hasn't exceeded max
      const availableSlots = weekSlots.filter(s => s.visitCount < maxVisitsPerDay);
      if (availableSlots.length > 0) {
        // Prefer days that don't already have this outlet from previous weeks
        const sortedSlots = availableSlots.sort((a, b) => a.visitCount - b.visitCount);
        const bestSlot = sortedSlots[0];
        bestSlot.outlets.push(outlet.id);
        bestSlot.visitCount++;
      }
    }
  }
  
  // Schedule VF2 outlets (bi-weekly visits - 2 times per month)
  // Should be spread at least 2 weeks apart
  for (const outlet of vf2Outlets) {
    // Visit in week 1 and week 3 (or 2 and 4)
    const weekPairs = [[1, 3], [2, 4]];
    
    // Choose the pair that results in more balanced daily loads
    let bestPair = weekPairs[0];
    let bestImbalance = Infinity;
    
    for (const pair of weekPairs) {
      let imbalance = 0;
      for (const week of pair) {
        const weekSlots = daySlots.filter(s => s.week === week);
        const minLoad = Math.min(...weekSlots.map(s => s.visitCount));
        const maxLoad = Math.max(...weekSlots.map(s => s.visitCount));
        imbalance += maxLoad - minLoad;
      }
      if (imbalance < bestImbalance) {
        bestImbalance = imbalance;
        bestPair = pair;
      }
    }
    
    // Schedule in the chosen weeks
    for (const week of bestPair) {
      const weekSlots = daySlots.filter(s => s.week === week);
      const availableSlots = weekSlots.filter(s => s.visitCount < maxVisitsPerDay);
      if (availableSlots.length > 0) {
        const sortedSlots = availableSlots.sort((a, b) => a.visitCount - b.visitCount);
        const bestSlot = sortedSlots[0];
        bestSlot.outlets.push(outlet.id);
        bestSlot.visitCount++;
      }
    }
  }
  
  // Schedule VF1 outlets (monthly visits - 1 time per month)
  // Distribute evenly across all weeks and days
  // Sort VF1 outlets by location to cluster nearby outlets on the same day
  const sortedVF1 = [...vf1Outlets].sort((a, b) => {
    // Sort by latitude first, then longitude for geographic clustering
    if (Math.abs(a.latitude - b.latitude) > 0.01) {
      return a.latitude - b.latitude;
    }
    return a.longitude - b.longitude;
  });
  
  // Distribute VF1 outlets across all days, prioritizing days with fewer visits
  for (const outlet of sortedVF1) {
    // Find the day with the fewest visits that hasn't exceeded max
    const availableSlots = daySlots
      .filter(s => s.visitCount < maxVisitsPerDay)
      .sort((a, b) => a.visitCount - b.visitCount);
    
    if (availableSlots.length > 0) {
      const bestSlot = availableSlots[0];
      bestSlot.outlets.push(outlet.id);
      bestSlot.visitCount++;
    }
  }
  
  // Balance the schedule to ensure min visits per day where possible
  // Move outlets from overloaded days to underloaded days
  let rebalanceIterations = 0;
  const maxRebalanceIterations = 10;
  
  while (rebalanceIterations < maxRebalanceIterations) {
    const underloadedSlots = daySlots.filter(s => s.visitCount < minVisitsPerDay && s.visitCount > 0);
    const overloadedSlots = daySlots.filter(s => s.visitCount > maxVisitsPerDay - 2);
    
    if (underloadedSlots.length === 0 || overloadedSlots.length === 0) break;
    
    let moved = false;
    for (const overSlot of overloadedSlots) {
      for (const underSlot of underloadedSlots) {
        // Only move if they're in different weeks to maintain VF constraints
        if (overSlot.week === underSlot.week) continue;
        
        // Find a VF1 outlet to move (VF1 outlets are most flexible)
        const movableOutletId = overSlot.outlets.find(id => {
          const outlet = outlets.find(o => o.id === id);
          return outlet && outlet.visitFrequency === 1;
        });
        
        if (movableOutletId && underSlot.visitCount < maxVisitsPerDay) {
          // Move the outlet
          overSlot.outlets = overSlot.outlets.filter(id => id !== movableOutletId);
          overSlot.visitCount--;
          underSlot.outlets.push(movableOutletId);
          underSlot.visitCount++;
          moved = true;
          break;
        }
      }
      if (moved) break;
    }
    
    if (!moved) break;
    rebalanceIterations++;
  }
  
  // Generate schedules with optimized route order
  const schedules: InsertSchedule[] = [];
  const outletMap = new Map(outlets.map(o => [o.id, o]));
  
  for (const slot of daySlots) {
    if (slot.outlets.length === 0) continue;
    
    // Get the actual outlet objects for route optimization
    const slotOutlets = slot.outlets
      .map(id => outletMap.get(id))
      .filter((o): o is Outlet => o !== undefined);
    
    // Optimize the route order
    const optimizedOutlets = optimizeRouteOrder(slotOutlets);
    const totalDistance = calculateRouteDistance(optimizedOutlets);
    
    // Estimate duration (30 min per visit + travel time at 40 km/h)
    const visitTime = optimizedOutlets.length * 30;
    const travelTime = (totalDistance / 40) * 60;
    const estimatedDuration = Math.round(visitTime + travelTime);
    
    schedules.push({
      repId,
      week: slot.week,
      dayOfWeek: slot.dayOfWeek,
      outletIds: optimizedOutlets.map(o => o.id),
      routeOrder: optimizedOutlets.map(o => o.id),
      totalDistance: Math.round(totalDistance * 100) / 100,
      estimatedDuration
    });
  }
  
  // Log schedule summary
  console.log(`Generated ${schedules.length} daily schedules for ${territory}`);
  const visitCounts = schedules.map(s => (s.outletIds as string[]).length);
  console.log(`Daily visits: min=${Math.min(...visitCounts)}, max=${Math.max(...visitCounts)}, avg=${(visitCounts.reduce((a, b) => a + b, 0) / visitCounts.length).toFixed(1)}`);
  
  return schedules;
}

export function validateSchedule(
  outlets: Outlet[],
  schedules: InsertSchedule[],
  settings: SchedulingSettings
): { isValid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Count visits per outlet
  const visitCounts = new Map<string, number>();
  for (const schedule of schedules) {
    const outletIds = schedule.outletIds as string[];
    for (const id of outletIds) {
      visitCounts.set(id, (visitCounts.get(id) || 0) + 1);
    }
  }
  
  // Validate each outlet gets correct number of visits
  for (const outlet of outlets) {
    const actualVisits = visitCounts.get(outlet.id) || 0;
    const expectedVisits = outlet.visitFrequency;
    
    if (actualVisits !== expectedVisits) {
      errors.push(`Outlet ${outlet.name} (VF${outlet.visitFrequency}): expected ${expectedVisits} visits, got ${actualVisits}`);
    }
  }
  
  // Validate daily visit constraints
  for (const schedule of schedules) {
    const outletIds = schedule.outletIds as string[];
    if (outletIds.length > settings.maxVisitsPerDay) {
      errors.push(`Week ${schedule.week} Day ${schedule.dayOfWeek}: ${outletIds.length} visits exceeds max ${settings.maxVisitsPerDay}`);
    }
    if (outletIds.length < settings.minVisitsPerDay && outletIds.length > 0) {
      warnings.push(`Week ${schedule.week} Day ${schedule.dayOfWeek}: ${outletIds.length} visits below min ${settings.minVisitsPerDay}`);
    }
  }
  
  // Validate VF4 outlets are spread across weeks
  const vf4Outlets = outlets.filter(o => o.visitFrequency === 4);
  for (const outlet of vf4Outlets) {
    const weeksWithVisit = new Set<number>();
    for (const schedule of schedules) {
      if ((schedule.outletIds as string[]).includes(outlet.id)) {
        weeksWithVisit.add(schedule.week);
      }
    }
    if (weeksWithVisit.size !== 4) {
      warnings.push(`VF4 outlet ${outlet.name}: visits in ${weeksWithVisit.size} weeks instead of 4`);
    }
  }
  
  // Validate VF2 outlets are properly spaced
  const vf2Outlets = outlets.filter(o => o.visitFrequency === 2);
  for (const outlet of vf2Outlets) {
    const visitWeeks: number[] = [];
    for (const schedule of schedules) {
      if ((schedule.outletIds as string[]).includes(outlet.id)) {
        visitWeeks.push(schedule.week);
      }
    }
    if (visitWeeks.length === 2) {
      const weekGap = Math.abs(visitWeeks[1] - visitWeeks[0]);
      if (weekGap < 2) {
        warnings.push(`VF2 outlet ${outlet.name}: visits only ${weekGap} week(s) apart`);
      }
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

export function reoptimizeSchedules(
  outlets: Outlet[],
  reps: { id: string; territory: string }[],
  settings: SchedulingSettings
): InsertSchedule[] {
  const allSchedules: InsertSchedule[] = [];
  
  // Group outlets by territory
  const outletsByTerritory = new Map<string, Outlet[]>();
  for (const outlet of outlets) {
    const territory = outlet.territory || 'unassigned';
    if (!outletsByTerritory.has(territory)) {
      outletsByTerritory.set(territory, []);
    }
    outletsByTerritory.get(territory)!.push(outlet);
  }
  
  // Generate schedules for each rep/territory
  for (const rep of reps) {
    const territoryOutlets = outletsByTerritory.get(rep.territory) || [];
    if (territoryOutlets.length === 0) continue;
    
    const repSchedules = generateAdvancedSchedule(
      territoryOutlets,
      rep.id,
      rep.territory,
      settings
    );
    
    allSchedules.push(...repSchedules);
  }
  
  return allSchedules;
}

import type { Outlet, Rep, Schedule } from "@shared/schema";

// Simple linear regression for demand forecasting
interface LinearRegressionModel {
  slope: number;
  intercept: number;
  rSquared: number;
}

interface DemandForecast {
  outletId: string;
  predictedVisits: number;
  confidence: number;
  seasonalFactor: number;
  trendFactor: number;
}

interface TerritoryOptimizationResult {
  recommendedChanges: Array<{
    outletId: string;
    currentRepId: string;
    recommendedRepId: string;
    reason: string;
    expectedImprovement: number;
  }>;
  efficiencyGain: number;
  workloadBalance: number;
}

// Historical data structure for ML training
interface HistoricalData {
  outletId: string;
  date: Date;
  actualVisits: number;
  dayOfWeek: number;
  month: number;
  seasonalIndex: number;
  repId: string;
  travelTime: number;
  visitDuration: number;
}

export class MLForecastingEngine {
  private historicalData: HistoricalData[] = [];
  private demandModels: Map<string, LinearRegressionModel> = new Map();
  private seasonalFactors: Map<string, number[]> = new Map(); // 12 months
  private trendAnalysis: Map<string, { growth: number; volatility: number }> = new Map();

  // Initialize with historical visit data
  public initializeHistoricalData(schedules: Schedule[], outlets: Outlet[]): void {
    console.log('Initializing ML forecasting with historical data...');
    
    // Simulate historical data based on current outlet and schedule patterns
    this.historicalData = this.generateHistoricalData(schedules, outlets);
    
    // Train demand forecasting models
    this.trainDemandModels();
    
    // Analyze seasonal patterns
    this.analyzeSeasonalPatterns();
    
    // Calculate trend factors
    this.calculateTrendFactors();
    
    console.log(`Trained ML models for ${this.demandModels.size} outlets`);
  }

  // Generate synthetic historical data for training (in real app, this would come from database)
  private generateHistoricalData(schedules: Schedule[], outlets: Outlet[]): HistoricalData[] {
    const historical: HistoricalData[] = [];
    const now = new Date();
    
    // Generate 12 months of historical data
    for (let monthBack = 12; monthBack >= 1; monthBack--) {
      const targetDate = new Date(now);
      targetDate.setMonth(now.getMonth() - monthBack);
      
      outlets.forEach(outlet => {
        // Find schedules for this outlet
        const relevantSchedules = schedules.filter(schedule => 
          Array.isArray(schedule.outletIds) && 
          (schedule.outletIds as string[]).includes(outlet.id)
        );
        
        if (relevantSchedules.length === 0) return;
        
        const repId = relevantSchedules[0].repId;
        
        // Generate weekly patterns
        for (let week = 0; week < 4; week++) {
          const weekDate = new Date(targetDate);
          weekDate.setDate(targetDate.getDate() + (week * 7));
          
          for (let day = 0; day < 7; day++) {
            const dayDate = new Date(weekDate);
            dayDate.setDate(weekDate.getDate() + day);
            
            // Calculate expected visits based on visit frequency and seasonal factors
            const baseVisits = outlet.visitFrequency === 2 ? 0.4 : 0.8; // VF2 = 2/5 days, VF4 = 4/5 days
            const seasonalMultiplier = this.getSeasonalMultiplier(dayDate.getMonth(), outlet.id);
            const randomVariation = 0.8 + (Math.random() * 0.4); // ±20% variation
            
            const actualVisits = Math.round(baseVisits * seasonalMultiplier * randomVariation);
            
            if (actualVisits > 0) {
              historical.push({
                outletId: outlet.id,
                date: dayDate,
                actualVisits,
                dayOfWeek: dayDate.getDay(),
                month: dayDate.getMonth(),
                seasonalIndex: seasonalMultiplier,
                repId,
                travelTime: 15 + Math.random() * 30, // 15-45 minutes travel
                visitDuration: 20 + Math.random() * 40 // 20-60 minutes visit
              });
            }
          }
        }
      });
    }
    
    return historical;
  }

  private getSeasonalMultiplier(month: number, outletId: string): number {
    // Simulate seasonal patterns (holiday seasons, weather, etc.)
    const basePattern = [0.85, 0.9, 1.0, 1.1, 1.15, 1.2, 1.1, 1.05, 1.0, 1.1, 1.25, 1.3]; // Dec-Nov
    const outletVariation = (parseInt(outletId.slice(-2), 16) % 20) / 100; // 0-0.19 variation
    return basePattern[month] + outletVariation;
  }

  // Train linear regression models for each outlet
  private trainDemandModels(): void {
    const outletGroups = this.groupBy(this.historicalData, 'outletId');
    
    outletGroups.forEach((data, outletId) => {
      if (data.length < 10) return; // Need minimum data points
      
      // Prepare features (time-based)
      const features = data.map((d, index) => ({
        x: index, // Time index
        y: d.actualVisits,
        month: d.month,
        dayOfWeek: d.dayOfWeek
      }));
      
      // Simple linear regression on time series
      const model = this.linearRegression(features.map(f => f.x), features.map(f => f.y));
      this.demandModels.set(outletId, model);
    });
  }

  private linearRegression(x: number[], y: number[]): LinearRegressionModel {
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Calculate R-squared
    const yMean = sumY / n;
    const totalSumSquares = y.reduce((sum, yi) => sum + Math.pow(yi - yMean, 2), 0);
    const residualSumSquares = y.reduce((sum, yi, i) => {
      const predicted = slope * x[i] + intercept;
      return sum + Math.pow(yi - predicted, 2);
    }, 0);
    
    const rSquared = 1 - (residualSumSquares / totalSumSquares);
    
    return { slope, intercept, rSquared: Math.max(0, rSquared) };
  }

  private analyzeSeasonalPatterns(): void {
    const outletGroups = this.groupBy(this.historicalData, 'outletId');
    
    outletGroups.forEach((data, outletId) => {
      const monthlyAvg = new Array(12).fill(0);
      const monthlyCount = new Array(12).fill(0);
      
      data.forEach(record => {
        monthlyAvg[record.month] += record.actualVisits;
        monthlyCount[record.month]++;
      });
      
      // Calculate average visits per month
      const seasonalPattern = monthlyAvg.map((sum, month) => 
        monthlyCount[month] > 0 ? sum / monthlyCount[month] : 0
      );
      
      this.seasonalFactors.set(outletId, seasonalPattern);
    });
  }

  private calculateTrendFactors(): void {
    const outletGroups = this.groupBy(this.historicalData, 'outletId');
    
    outletGroups.forEach((data, outletId) => {
      if (data.length < 20) return;
      
      // Sort by date
      const sortedData = data.sort((a, b) => a.date.getTime() - b.date.getTime());
      
      // Calculate growth trend (first half vs second half)
      const midPoint = Math.floor(sortedData.length / 2);
      const firstHalf = sortedData.slice(0, midPoint);
      const secondHalf = sortedData.slice(midPoint);
      
      const firstAvg = firstHalf.reduce((sum, d) => sum + d.actualVisits, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((sum, d) => sum + d.actualVisits, 0) / secondHalf.length;
      
      const growth = (secondAvg - firstAvg) / firstAvg;
      
      // Calculate volatility (coefficient of variation)
      const mean = sortedData.reduce((sum, d) => sum + d.actualVisits, 0) / sortedData.length;
      const variance = sortedData.reduce((sum, d) => sum + Math.pow(d.actualVisits - mean, 2), 0) / sortedData.length;
      const volatility = Math.sqrt(variance) / mean;
      
      this.trendAnalysis.set(outletId, { growth, volatility });
    });
  }

  // Generate demand forecasts for next period
  public generateDemandForecasts(outlets: Outlet[], forecastDays: number = 30): DemandForecast[] {
    const forecasts: DemandForecast[] = [];
    const today = new Date();
    
    outlets.forEach(outlet => {
      const model = this.demandModels.get(outlet.id);
      const seasonalPattern = this.seasonalFactors.get(outlet.id);
      const trend = this.trendAnalysis.get(outlet.id);
      
      if (!model || !seasonalPattern || !trend) {
        // Fallback prediction based on visit frequency
        forecasts.push({
          outletId: outlet.id,
          predictedVisits: outlet.visitFrequency * forecastDays / 7,
          confidence: 0.5,
          seasonalFactor: 1.0,
          trendFactor: 1.0
        });
        return;
      }
      
      // Predict based on trend line
      const timeIndex = this.historicalData.filter(d => d.outletId === outlet.id).length;
      const basePrediction = model.slope * (timeIndex + forecastDays) + model.intercept;
      
      // Apply seasonal adjustment
      const currentMonth = today.getMonth();
      const seasonalFactor = seasonalPattern[currentMonth] || 1.0;
      
      // Apply trend factor
      const trendFactor = 1 + (trend.growth * forecastDays / 365); // Annualized growth
      
      const predictedVisits = Math.max(0, basePrediction * seasonalFactor * trendFactor);
      
      // Confidence based on model accuracy and volatility
      const confidence = Math.min(0.95, model.rSquared * (1 - trend.volatility));
      
      forecasts.push({
        outletId: outlet.id,
        predictedVisits: Math.round(predictedVisits),
        confidence,
        seasonalFactor,
        trendFactor
      });
    });
    
    return forecasts;
  }

  // ML-based territory optimization
  public optimizeTerritories(
    outlets: Outlet[],
    reps: Rep[],
    forecasts: DemandForecast[],
    currentSchedules: Schedule[]
  ): TerritoryOptimizationResult {
    console.log('Running ML-based territory optimization...');
    
    const recommendations: TerritoryOptimizationResult['recommendedChanges'] = [];
    
    // Calculate current workload distribution
    const repWorkloads = new Map<string, { current: number; predicted: number; outlets: string[] }>();
    
    reps.forEach(rep => {
      repWorkloads.set(rep.id, { current: 0, predicted: 0, outlets: [] });
    });
    
    // Calculate current and predicted workloads
    outlets.forEach(outlet => {
      if (!outlet.repId) return;
      
      const repData = repWorkloads.get(outlet.repId);
      if (!repData) return;
      
      const forecast = forecasts.find(f => f.outletId === outlet.id);
      const currentWorkload = outlet.visitFrequency;
      const predictedWorkload = forecast ? forecast.predictedVisits / 4 : currentWorkload; // Weekly average
      
      repData.current += currentWorkload;
      repData.predicted += predictedWorkload;
      repData.outlets.push(outlet.id);
    });
    
    // Identify optimization opportunities
    const overloadedReps = Array.from(repWorkloads.entries())
      .filter(([_, data]) => data.predicted > 25) // Max daily visits exceeded
      .sort((a, b) => b[1].predicted - a[1].predicted);
    
    const underloadedReps = Array.from(repWorkloads.entries())
      .filter(([_, data]) => data.predicted < 12) // Min daily visits not met
      .sort((a, b) => a[1].predicted - b[1].predicted);
    
    // Generate transfer recommendations
    for (const [overloadedRepId, overloadedData] of overloadedReps) {
      const excessWorkload = overloadedData.predicted - 20; // Target workload
      
      if (excessWorkload <= 0) continue;
      
      // Find outlets to transfer (prefer high-growth, distant outlets)
      const transferCandidates = overloadedData.outlets
        .map(outletId => {
          const outlet = outlets.find(o => o.id === outletId)!;
          const forecast = forecasts.find(f => f.outletId === outletId)!;
          const trend = this.trendAnalysis.get(outletId);
          
          return {
            outlet,
            forecast,
            growthScore: trend ? trend.growth : 0,
            workload: forecast.predictedVisits / 4
          };
        })
        .sort((a, b) => (b.growthScore + b.workload) - (a.growthScore + a.workload))
        .slice(0, Math.ceil(excessWorkload / 3));
      
      // Find best target reps for each candidate
      for (const candidate of transferCandidates) {
        let bestTarget: string | null = null;
        let bestScore = Infinity;
        
        for (const [underloadedRepId, underloadedData] of underloadedReps) {
          if (underloadedData.predicted + candidate.workload > 23) continue;
          
          const targetRep = reps.find(r => r.id === underloadedRepId)!;
          const sourceRep = reps.find(r => r.id === overloadedRepId)!;
          
          // Calculate distance score (simplified)
          const distanceScore = Math.abs(
            parseInt(targetRep.territory.slice(-1)) - parseInt(sourceRep.territory.slice(-1))
          );
          
          const workloadBalance = Math.abs(20 - (underloadedData.predicted + candidate.workload));
          const score = distanceScore + workloadBalance;
          
          if (score < bestScore) {
            bestScore = score;
            bestTarget = underloadedRepId;
          }
        }
        
        if (bestTarget) {
          const expectedImprovement = candidate.workload * candidate.forecast.confidence;
          
          recommendations.push({
            outletId: candidate.outlet.id,
            currentRepId: overloadedRepId,
            recommendedRepId: bestTarget,
            reason: `ML predicts ${candidate.forecast.predictedVisits.toFixed(1)} visits/month (${(candidate.forecast.confidence * 100).toFixed(1)}% confidence)`,
            expectedImprovement
          });
          
          // Update workload tracking
          const targetData = repWorkloads.get(bestTarget)!;
          targetData.predicted += candidate.workload;
          overloadedData.predicted -= candidate.workload;
        }
      }
    }
    
    // Calculate overall metrics
    const currentImbalance = this.calculateWorkloadImbalance(Array.from(repWorkloads.values()).map(d => d.current));
    const projectedImbalance = this.calculateWorkloadImbalance(Array.from(repWorkloads.values()).map(d => d.predicted));
    
    const efficiencyGain = Math.max(0, (currentImbalance - projectedImbalance) / currentImbalance);
    const workloadBalance = 1 - projectedImbalance;
    
    console.log(`Generated ${recommendations.length} ML-based recommendations`);
    console.log(`Projected efficiency gain: ${(efficiencyGain * 100).toFixed(1)}%`);
    
    return {
      recommendedChanges: recommendations,
      efficiencyGain,
      workloadBalance
    };
  }

  private calculateWorkloadImbalance(workloads: number[]): number {
    if (workloads.length === 0) return 0;
    
    const mean = workloads.reduce((sum, w) => sum + w, 0) / workloads.length;
    const variance = workloads.reduce((sum, w) => sum + Math.pow(w - mean, 2), 0) / workloads.length;
    
    return Math.sqrt(variance) / mean; // Coefficient of variation
  }

  // Utility function to group array by key
  private groupBy<T>(array: T[], key: keyof T): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    
    array.forEach(item => {
      const groupKey = String(item[key]);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(item);
    });
    
    return groups;
  }

  // Get model performance metrics
  public getModelMetrics(): { totalModels: number; avgAccuracy: number; coverage: number } {
    const accuracies = Array.from(this.demandModels.values()).map(model => model.rSquared);
    const avgAccuracy = accuracies.length > 0 ? accuracies.reduce((sum, acc) => sum + acc, 0) / accuracies.length : 0;
    
    return {
      totalModels: this.demandModels.size,
      avgAccuracy,
      coverage: this.demandModels.size / (this.demandModels.size || 1)
    };
  }
}

// Singleton instance
export const mlEngine = new MLForecastingEngine();
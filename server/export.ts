import * as XLSX from 'xlsx';
import type { Rep, Schedule, Outlet } from '../shared/schema';

interface CalendarEntry {
  Date: string;
  Day: string;
  'Outlet Name': string;
  'Outlet Code': string;
  'Visit Frequency': string;
  Zone: string;
}

export function generateScheduleExcel(reps: Rep[], schedules: Schedule[], outlets: Outlet[]): Buffer {
  const workbook = XLSX.utils.book_new();
  
  // Create overview sheet
  const overviewData = reps.map(rep => {
    const repSchedules = schedules.filter(s => s.repId === rep.id);
    const totalZones = new Set(repSchedules.filter(s => s.week <= 2).map(s => `week${s.week}-day${s.dayOfWeek}`)).size;
    
    return {
      'Rep Name': rep.name,
      'Rep Code': rep.code,
      'Territory': rep.territory,
      'Total Zones': totalZones,
      'Working Days': rep.workingDaysPerWeek,
      'Min Visits/Day': rep.minDailyVisits,
      'Max Visits/Day': rep.maxDailyVisits
    };
  });
  
  const overviewSheet = XLSX.utils.json_to_sheet(overviewData);
  XLSX.utils.book_append_sheet(workbook, overviewSheet, 'Overview');
  
  // Create calendar-style schedule sheets for each rep
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  
  // Generate dates for a 4-week cycle starting from next Monday
  const getNextMonday = () => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek);
    const nextMonday = new Date(today);
    nextMonday.setDate(today.getDate() + daysUntilMonday);
    return nextMonday;
  };
  
  const startDate = getNextMonday();
  
  reps.forEach(rep => {
    const repSchedules = schedules.filter(s => s.repId === rep.id);
    const calendarData: CalendarEntry[] = [];
    
    const weeks = [1, 2, 3, 4];
    
    weeks.forEach(week => {
      days.slice(0, rep.workingDaysPerWeek).forEach((day, dayIndex) => {
        const daySchedule = repSchedules.find(s => s.week === week && s.dayOfWeek === dayIndex);
        
        if (daySchedule) {
          const outletIds = daySchedule.outletIds as string[];
          
          // Calculate the actual date for this day
          const currentDate = new Date(startDate);
          currentDate.setDate(startDate.getDate() + ((week - 1) * 7) + dayIndex);
          const dateStr = currentDate.toISOString().split('T')[0];
          
          // Add each outlet as a separate row in calendar format
          outletIds.forEach((outletId: string, index: number) => {
            const outlet = outlets.find(o => o.id === outletId);
            if (outlet) {
              const vfLabel = outlet.visitFrequency === 1 ? 'VF1' : 
                              outlet.visitFrequency === 2 ? 'VF2' : 'VF4';
              
              calendarData.push({
                'Date': index === 0 ? dateStr : '', // Only show date on first row
                'Day': index === 0 ? day : '', // Only show day on first row
                'Outlet Name': outlet.name,
                'Outlet Code': outlet.id,
                'Visit Frequency': vfLabel,
                'Zone': outlet.territory || 'Unassigned'
              });
            }
          });
          
          // Add empty row between days for readability
          if (outletIds.length > 0) {
            calendarData.push({
              'Date': '',
              'Day': '',
              'Outlet Name': '',
              'Outlet Code': '',
              'Visit Frequency': '',
              'Zone': ''
            });
          }
        }
      });
    });
    
    // Create sheet with calendar data
    const repSheet = XLSX.utils.json_to_sheet(calendarData);
    
    // Add column widths for better readability
    repSheet['!cols'] = [
      { wch: 12 }, // Date
      { wch: 10 }, // Day
      { wch: 30 }, // Outlet Name
      { wch: 15 }, // Outlet Code
      { wch: 15 }, // Visit Frequency
      { wch: 15 }  // Zone
    ];
    
    const sheetName = `${rep.name} - ${rep.territory}`.substring(0, 31); // Excel sheet name limit
    XLSX.utils.book_append_sheet(workbook, repSheet, sheetName);
  });
  
  // Create VF Summary sheet
  const vfSummaryData = [
    {
      'Visit Frequency': 'VF1',
      'Description': 'Monthly (1 visit per cycle)',
      'Total Outlets': outlets.filter(o => o.visitFrequency === 1).length,
      'Color Code': 'Green'
    },
    {
      'Visit Frequency': 'VF2',
      'Description': 'Bi-weekly (2 visits per cycle)',
      'Total Outlets': outlets.filter(o => o.visitFrequency === 2).length,
      'Color Code': 'Orange'
    },
    {
      'Visit Frequency': 'VF4',
      'Description': 'Weekly (4 visits per cycle)',
      'Total Outlets': outlets.filter(o => o.visitFrequency === 4).length,
      'Color Code': 'Red'
    }
  ];
  
  const vfSheet = XLSX.utils.json_to_sheet(vfSummaryData);
  XLSX.utils.book_append_sheet(workbook, vfSheet, 'VF Legend');
  
  // Create zones summary sheet - show all weeks and all reps
  const zonesData: any[] = [];
  
  // Group schedules by rep, week, day for proper summary
  reps.forEach(rep => {
    const repSchedules = schedules.filter(s => s.repId === rep.id);
    
    // Sort by week then day
    repSchedules.sort((a, b) => {
      if (a.week !== b.week) return a.week - b.week;
      return a.dayOfWeek - b.dayOfWeek;
    });
    
    repSchedules.forEach(schedule => {
      const outletIds = schedule.outletIds as string[];
      if (outletIds && outletIds.length > 0) {
        const outletNames = outletIds.map((id: string) => {
          const outlet = outlets.find(o => o.id === id);
          return outlet ? outlet.name : 'Unknown';
        });
        
        const vf1Count = outletIds.filter((id: string) => {
          const o = outlets.find(outlet => outlet.id === id);
          return o?.visitFrequency === 1;
        }).length;
        const vf2Count = outletIds.filter((id: string) => {
          const o = outlets.find(outlet => outlet.id === id);
          return o?.visitFrequency === 2;
        }).length;
        const vf4Count = outletIds.filter((id: string) => {
          const o = outlets.find(outlet => outlet.id === id);
          return o?.visitFrequency === 4;
        }).length;
        
        const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        
        zonesData.push({
          'Rep': rep.name,
          'Week': schedule.week,
          'Day': days[schedule.dayOfWeek] || `Day ${schedule.dayOfWeek + 1}`,
          'Total Outlets': outletIds.length,
          'VF1 (Monthly)': vf1Count,
          'VF2 (Bi-weekly)': vf2Count,
          'VF4 (Weekly)': vf4Count,
          'Outlets': outletNames.slice(0, 10).join(', ') + (outletNames.length > 10 ? '...' : '')
        });
      }
    });
  });
  
  const zonesSheet = XLSX.utils.json_to_sheet(zonesData);
  XLSX.utils.book_append_sheet(workbook, zonesSheet, 'Zones Summary');
  
  // Generate buffer
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
  return Buffer.from(buffer);
}

interface VehicleSummaryData {
  vehicle: {
    plateNumber: string;
    model: string;
    year: number;
    currentMileage: number;
    startingMileage: number;
    status: string;
    assignedRepName?: string;
  };
  usage: {
    dailyKm: number;
    weeklyKm: number;
    monthlyKm: number;
    lifetimeKm: number;
    avgDailyKm: number;
    routeIntensity: string;
  };
  forecasts: Array<{
    maintenanceType: string;
    dueMileage: number;
    remainingKm: number;
    status: string;
    severity: string;
    recommendation: string;
  }>;
  maintenanceHistory: Array<{
    serviceDate: string;
    maintenanceType: string;
    mileageAtService: number;
    cost?: number;
    notes?: string;
  }>;
}

export function generateVehicleSummaryExcel(data: VehicleSummaryData): Buffer {
  const workbook = XLSX.utils.book_new();
  
  // Vehicle Overview sheet
  const overviewData = [
    { 'Property': 'Plate Number', 'Value': data.vehicle.plateNumber },
    { 'Property': 'Model', 'Value': data.vehicle.model },
    { 'Property': 'Year', 'Value': data.vehicle.year.toString() },
    { 'Property': 'Current Mileage (km)', 'Value': data.vehicle.currentMileage.toLocaleString() },
    { 'Property': 'Starting Mileage (km)', 'Value': data.vehicle.startingMileage.toLocaleString() },
    { 'Property': 'Status', 'Value': data.vehicle.status },
    { 'Property': 'Assigned Rep', 'Value': data.vehicle.assignedRepName || 'Unassigned' },
    { 'Property': '', 'Value': '' },
    { 'Property': 'Average Daily KM', 'Value': data.usage.avgDailyKm.toFixed(1) },
    { 'Property': 'Weekly KM', 'Value': data.usage.weeklyKm.toLocaleString() },
    { 'Property': 'Monthly KM', 'Value': data.usage.monthlyKm.toLocaleString() },
    { 'Property': 'Lifetime KM', 'Value': data.usage.lifetimeKm.toLocaleString() },
    { 'Property': 'Route Intensity', 'Value': data.usage.routeIntensity },
  ];
  const overviewSheet = XLSX.utils.json_to_sheet(overviewData);
  XLSX.utils.book_append_sheet(workbook, overviewSheet, 'Vehicle Overview');

  // Maintenance Forecasts sheet
  if (data.forecasts.length > 0) {
    const forecastsData = data.forecasts.map(f => ({
      'Maintenance Type': f.maintenanceType.replace('_', ' '),
      'Due At (km)': f.dueMileage.toLocaleString(),
      'Remaining (km)': f.remainingKm.toFixed(0),
      'Status': f.status,
      'Severity': f.severity,
      'Recommendation': f.recommendation
    }));
    const forecastsSheet = XLSX.utils.json_to_sheet(forecastsData);
    XLSX.utils.book_append_sheet(workbook, forecastsSheet, 'Maintenance Forecasts');
  }

  // Maintenance History sheet
  if (data.maintenanceHistory.length > 0) {
    const historyData = data.maintenanceHistory.map(h => ({
      'Date': new Date(h.serviceDate).toLocaleDateString(),
      'Type': h.maintenanceType.replace('_', ' '),
      'Mileage (km)': h.mileageAtService.toLocaleString(),
      'Cost': h.cost ? `$${h.cost.toFixed(2)}` : 'N/A',
      'Notes': h.notes || ''
    }));
    const historySheet = XLSX.utils.json_to_sheet(historyData);
    XLSX.utils.book_append_sheet(workbook, historySheet, 'Maintenance History');
  }

  // Generate buffer
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
  return Buffer.from(buffer);
}

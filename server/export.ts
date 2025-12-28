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
  
  // Create zones summary sheet
  const zonesData: any[] = [];
  const processedZones = new Set<string>();
  
  schedules.forEach(schedule => {
    if (schedule.week <= 2) {
      const outletIds = schedule.outletIds as string[];
      if (outletIds && outletIds.length > 0) {
        const zoneKey = `week${schedule.week}-day${schedule.dayOfWeek}`;
        if (!processedZones.has(zoneKey)) {
          processedZones.add(zoneKey);
          
          const rep = reps.find(r => r.id === schedule.repId);
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
          
          zonesData.push({
            'Zone': `Week ${schedule.week} - Day ${schedule.dayOfWeek + 1}`,
            'Rep': rep ? rep.name : 'Unknown',
            'Total Outlets': outletIds.length,
            'VF1 (Monthly)': vf1Count,
            'VF2 (Bi-weekly)': vf2Count,
            'VF4 (Weekly)': vf4Count,
            'Outlets': outletNames.slice(0, 10).join(', ') + (outletNames.length > 10 ? '...' : '')
          });
        }
      }
    }
  });
  
  const zonesSheet = XLSX.utils.json_to_sheet(zonesData);
  XLSX.utils.book_append_sheet(workbook, zonesSheet, 'Zones Summary');
  
  // Generate buffer
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
  return Buffer.from(buffer);
}

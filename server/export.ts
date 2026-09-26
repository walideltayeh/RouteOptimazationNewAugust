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

export function generateScheduleExcel(
  reps: Rep[],
  schedules: Schedule[],
  outlets: Outlet[],
  workingWeek: number[] = [1, 2, 3, 4, 5],
  planStart: string = '',
  startSlot: number = 0,
): Buffer {
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
  
  // Real calendar dates on the days the business works. Starting at "next
  // Monday" and adding (week-1)*7 + dayIndex assumed a Monday-first week with
  // the days off at the end of it, and dated a Sunday-to-Thursday plan onto
  // Fridays.
  const week = workingWeek.length > 0 ? workingWeek : [1, 2, 3, 4, 5];
  const workingDates: Date[] = [];
  {
    const cursor = planStart ? new Date(planStart + 'T00:00:00') : new Date();
    cursor.setHours(0, 0, 0, 0);
    if (!planStart) cursor.setDate(cursor.getDate() + 1);
    const wanted = new Set(week);
    for (let guard = 0; guard < 400 && workingDates.length < 200; guard++) {
      const iso = cursor.getDay() === 0 ? 7 : cursor.getDay();
      if (wanted.has(iso)) workingDates.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  
  reps.forEach(rep => {
    const repSchedules = schedules.filter(s => s.repId === rep.id);
    const calendarData: CalendarEntry[] = [];
    
    // Weeks the cycle actually spans. This was the constant [1, 2, 3, 4]; a
    // 26-working-day cycle on a 6-day week runs into a fifth week, and a
    // shorter cycle into fewer, so it has to come from the schedule itself.
    const lastWeek = repSchedules.reduce((m, s) => Math.max(m, s.week), 0);
    const weeks = Array.from({ length: Math.max(1, lastWeek) }, (_, i) => i + 1);
    
    weeks.forEach(weekNo => {
      week.forEach((dayOfWeek, dayIndex) => {
        const day = days[dayOfWeek - 1];
        const daySchedule = repSchedules.find(s => s.week === weekNo && s.dayOfWeek === dayOfWeek);
        
        if (daySchedule) {
          const outletIds = daySchedule.outletIds as string[];
          
          const dateIndex = (weekNo - 1) * week.length + dayIndex - startSlot;
          const scheduledDate = dateIndex >= 0 ? workingDates[dateIndex] : undefined;
          if (!scheduledDate) return; // before the plan starts
          const dateStr = `${scheduledDate.getFullYear()}-${String(scheduledDate.getMonth() + 1).padStart(2, '0')}-${String(scheduledDate.getDate()).padStart(2, '0')}`;
          
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

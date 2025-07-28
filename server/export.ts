import * as XLSX from 'xlsx';
import type { Rep, Schedule, Outlet } from '../shared/schema';

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
      'Min Visits/Day': rep.minVisitsPerDay,
      'Max Visits/Day': rep.maxVisitsPerDay
    };
  });
  
  const overviewSheet = XLSX.utils.json_to_sheet(overviewData);
  XLSX.utils.book_append_sheet(workbook, overviewSheet, 'Overview');
  
  // Create detailed schedule sheets for each rep
  reps.forEach(rep => {
    const repSchedules = schedules.filter(s => s.repId === rep.id);
    const scheduleData: any[] = [];
    
    const weeks = [1, 2, 3, 4];
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    
    weeks.forEach(week => {
      days.slice(0, rep.workingDaysPerWeek).forEach((day, dayIndex) => {
        const daySchedule = repSchedules.find(s => s.week === week && s.dayOfWeek === dayIndex);
        
        if (daySchedule) {
          const outletNames = daySchedule.outletIds.map(id => {
            const outlet = outlets.find(o => o.id === id);
            return outlet ? outlet.name : 'Unknown';
          });
          
          scheduleData.push({
            'Week': week,
            'Day': day,
            'Zone': `Zone ${dayIndex + 1}`,
            'Total Outlets': daySchedule.outletIds.length,
            'Outlets': outletNames.join(', '),
            'Estimated Duration': `${daySchedule.estimatedDuration || 0} minutes`,
            'Total Distance': `${daySchedule.totalDistance?.toFixed(2) || 0} km`
          });
        }
      });
    });
    
    const repSheet = XLSX.utils.json_to_sheet(scheduleData);
    XLSX.utils.book_append_sheet(workbook, repSheet, `Rep ${rep.code}`);
  });
  
  // Create zones summary sheet
  const zonesData: any[] = [];
  const processedZones = new Set<string>();
  
  schedules.forEach(schedule => {
    if (schedule.week <= 2 && schedule.outletIds.length > 0) {
      const zoneKey = `week${schedule.week}-day${schedule.dayOfWeek}`;
      if (!processedZones.has(zoneKey)) {
        processedZones.add(zoneKey);
        
        const rep = reps.find(r => r.id === schedule.repId);
        const outletNames = schedule.outletIds.map(id => {
          const outlet = outlets.find(o => o.id === id);
          return outlet ? outlet.name : 'Unknown';
        });
        
        zonesData.push({
          'Zone': `Week ${schedule.week} - Day ${schedule.dayOfWeek + 1}`,
          'Rep': rep ? rep.name : 'Unknown',
          'Total Outlets': schedule.outletIds.length,
          'Outlets': outletNames.join(', ')
        });
      }
    }
  });
  
  const zonesSheet = XLSX.utils.json_to_sheet(zonesData);
  XLSX.utils.book_append_sheet(workbook, zonesSheet, 'Zones Summary');
  
  // Generate buffer
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
  return Buffer.from(buffer);
}
// File parsing utilities for CSV and Excel files
export interface ParsedOutlet {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  visitFrequency: number;
  territory?: string;
  district?: string;
  region?: string;
  area?: string;
  outletType?: string;
}

export interface FileParseResult {
  success: boolean;
  data: ParsedOutlet[];
  errors: string[];
  summary: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
  };
}

// CSV parsing using Papa Parse (would be loaded dynamically)
export async function parseCSVFile(file: File): Promise<FileParseResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      const csvText = e.target?.result as string;
      
      // Load Papa Parse dynamically
      loadPapaParse().then((Papa) => {
        const parsed = Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
          transformHeader: (header: string) => header.trim().toLowerCase()
        });
        
        const result = processParseResults(parsed.data as any[], parsed.errors);
        resolve(result);
      });
    };
    
    reader.onerror = () => {
      resolve({
        success: false,
        data: [],
        errors: ['Failed to read file'],
        summary: { totalRows: 0, validRows: 0, invalidRows: 0 }
      });
    };
    
    reader.readAsText(file);
  });
}

// Excel parsing using SheetJS (would be loaded dynamically)
export async function parseExcelFile(file: File): Promise<FileParseResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      const arrayBuffer = e.target?.result as ArrayBuffer;
      
      loadSheetJS().then((XLSX) => {
        try {
          const workbook = XLSX.read(arrayBuffer, { type: 'buffer' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { 
            header: 1,
            defval: ''
          });
          
          // Convert to object format with headers
          if (jsonData.length === 0) {
            resolve({
              success: false,
              data: [],
              errors: ['Excel file is empty'],
              summary: { totalRows: 0, validRows: 0, invalidRows: 0 }
            });
            return;
          }
          
          const headers = (jsonData[0] as string[]).map(h => h.toString().trim().toLowerCase());
          const rows = jsonData.slice(1) as any[][];
          
          const objectData = rows.map(row => {
            const obj: any = {};
            headers.forEach((header, index) => {
              obj[header] = row[index]?.toString()?.trim() || '';
            });
            return obj;
          });
          
          const result = processParseResults(objectData, []);
          resolve(result);
          
        } catch (error) {
          resolve({
            success: false,
            data: [],
            errors: [`Failed to parse Excel file: ${error}`],
            summary: { totalRows: 0, validRows: 0, invalidRows: 0 }
          });
        }
      });
    };
    
    reader.onerror = () => {
      resolve({
        success: false,
        data: [],
        errors: ['Failed to read Excel file'],
        summary: { totalRows: 0, validRows: 0, invalidRows: 0 }
      });
    };
    
    reader.readAsArrayBuffer(file);
  });
}

// Process parsed data and validate
function processParseResults(data: any[], parseErrors: any[]): FileParseResult {
  const outlets: ParsedOutlet[] = [];
  const errors: string[] = [...parseErrors.map(e => e.message || 'Parse error')];
  let validRows = 0;
  let invalidRows = 0;
  
  data.forEach((row, index) => {
    try {
      const outlet = extractOutletData(row);
      if (validateOutletData(outlet)) {
        outlets.push(outlet);
        validRows++;
      } else {
        invalidRows++;
        errors.push(`Row ${index + 2}: Invalid outlet data`);
      }
    } catch (error) {
      invalidRows++;
      errors.push(`Row ${index + 2}: ${error}`);
    }
  });
  
  return {
    success: outlets.length > 0,
    data: outlets,
    errors,
    summary: {
      totalRows: data.length,
      validRows,
      invalidRows
    }
  };
}

// Extract outlet data from various possible column names
function extractOutletData(row: any): ParsedOutlet {
  // Common column name variations - Lebanese outlet format
  const nameFields = ['outletname', 'name', 'outlet_name', 'outlet name', 'store_name', 'store name', 'client'];
  const addressFields = ['address', 'location', 'addr', 'full_address', 'district', 'region', 'area'];
  const latFields = ['latitude', 'lat'];
  const lngFields = ['longitude', 'lng', 'lon', 'long'];
  const vfFields = ['vf', 'visit_frequency', 'visit frequency', 'frequency'];
  const territoryFields = ['district', 'territory', 'zone', 'area', 'region'];
  
  const name = findFieldValue(row, nameFields) || `Outlet ${Date.now()}`;
  const address = findFieldValue(row, addressFields) || '';
  const latStr = findFieldValue(row, latFields);
  const lngStr = findFieldValue(row, lngFields);
  const vfStr = findFieldValue(row, vfFields) || '2';
  const territory = findFieldValue(row, territoryFields);
  
  if (!latStr || !lngStr) {
    throw new Error('Missing latitude or longitude');
  }
  
  const latitude = parseFloat(latStr);
  const longitude = parseFloat(lngStr);
  const visitFrequency = parseInt(vfStr);
  
  if (isNaN(latitude) || isNaN(longitude)) {
    throw new Error('Invalid coordinates');
  }
  
  if (isNaN(visitFrequency) || ![2, 4].includes(visitFrequency)) {
    // Default to VF2 if invalid
    return {
      name,
      address,
      latitude,
      longitude,
      visitFrequency: 2,
      territory
    };
  }
  
  return {
    name,
    address,
    latitude,
    longitude,
    visitFrequency,
    territory
  };
}

// Find field value from various possible column names
function findFieldValue(row: any, possibleFields: string[]): string | undefined {
  for (const field of possibleFields) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
      return row[field].toString().trim();
    }
  }
  return undefined;
}

// Validate outlet data
function validateOutletData(outlet: ParsedOutlet): boolean {
  return !!(
    outlet.name &&
    outlet.latitude >= -90 && outlet.latitude <= 90 &&
    outlet.longitude >= -180 && outlet.longitude <= 180 &&
    [2, 4].includes(outlet.visitFrequency)
  );
}

// Dynamic loading functions
async function loadPapaParse(): Promise<any> {
  if ((window as any).Papa) {
    return (window as any).Papa;
  }
  
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js';
    script.onload = () => resolve((window as any).Papa);
    document.head.appendChild(script);
  });
}

async function loadSheetJS(): Promise<any> {
  if ((window as any).XLSX) {
    return (window as any).XLSX;
  }
  
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    script.onload = () => resolve((window as any).XLSX);
    document.head.appendChild(script);
  });
}

// File type detection
export function detectFileType(file: File): 'csv' | 'excel' | 'unknown' {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  
  if (name.endsWith('.csv') || type === 'text/csv') {
    return 'csv';
  }
  
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || 
      type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      type === 'application/vnd.ms-excel') {
    return 'excel';
  }
  
  return 'unknown';
}

// File validation
export function validateFile(file: File): { isValid: boolean; error?: string } {
  const maxSize = 50 * 1024 * 1024; // 50MB
  const fileType = detectFileType(file);
  
  if (fileType === 'unknown') {
    return { isValid: false, error: 'Unsupported file type. Please upload CSV or Excel files.' };
  }
  
  if (file.size > maxSize) {
    return { isValid: false, error: 'File size exceeds 50MB limit.' };
  }
  
  return { isValid: true };
}

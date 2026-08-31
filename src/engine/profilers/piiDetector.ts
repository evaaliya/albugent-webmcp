export interface PIIField {
    columnName: string;
    piiType: 'SSN' | 'EMAIL' | 'NAME' | 'CARD' | 'UNKNOWN';
    severity: 'HIGH' | 'MEDIUM' | 'LOW';
  }
  
  export function detectPII(columns: string[]): PIIField[] {
    const piiFields: PIIField[] = [];
  
    for (const col of columns) {
      const lower = col.toLowerCase();
      
      if (lower.includes('ssn') || lower.includes('social') || lower.includes('passport')) {
        piiFields.push({ columnName: col, piiType: 'SSN', severity: 'HIGH' });
      } else if (lower.includes('card') || lower.includes('credit')) {
        piiFields.push({ columnName: col, piiType: 'CARD', severity: 'HIGH' });
      } else if (lower.includes('email') || lower.includes('phone')) {
        piiFields.push({ columnName: col, piiType: 'EMAIL', severity: 'MEDIUM' });
      } else if (lower.includes('name') || lower.includes('patient')) {
        piiFields.push({ columnName: col, piiType: 'NAME', severity: 'LOW' });
      }
    }
  
    return piiFields;
  }
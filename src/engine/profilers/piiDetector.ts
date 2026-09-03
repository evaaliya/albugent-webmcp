// src/engine/profilers/piiDetector.ts

export interface PIIField {
  columnName: string;
  piiType: 'SSN' | 'CARD' | 'EMAIL' | 'NAME' | 'DOB' | 'LOCATION' | 'MEDICAL' | 'FINANCIAL' | 'UNKNOWN';
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
}
//function for status check
function isColumnMasked(columnName: string, rows?: any[]): boolean {
  if (!rows || rows.length === 0) return false;
//checking all tables statuses
  const values = rows
    .map((r) => r[columnName])
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '');

  if (values.length === 0) return false;
//if all not empty tables contain '***' or '[MASKED]' - table is masked!
  return values.every((v) => {
    const str = String(v).trim();
    return str === '***' || str.startsWith('[MASKED]') || str.includes('***');
  });
}

export function detectPII(columns: string[], rows?: any[]): PIIField[] {
  const piiFields: PIIField[] = [];

  for (const col of columns) {
//if masked- pass!
    if (isColumnMasked(col, rows)) {
      continue; 
    }
    const lower = col.toLowerCase();
   
    if (lower.includes('ssn') || lower.includes('social') || lower.includes('passport') || lower.includes('mrn') || lower.includes('medical_record')) {
      piiFields.push({ columnName: col, piiType: 'SSN', severity: 'HIGH' });
    } else if (lower.includes('card') || lower.includes('credit') || lower.includes('account_number') || lower.includes('iban')) {
      piiFields.push({ columnName: col, piiType: 'CARD', severity: 'HIGH' });
    } else if (lower.includes('email') || lower.includes('phone')) {
      piiFields.push({ columnName: col, piiType: 'EMAIL', severity: 'MEDIUM' });
    } else if (lower.includes('name') || lower.includes('patient')) {
      // Direct identifier — upgraded from LOW to MEDIUM so it actually
      // contributes to the risk score (see riskEvaluator.ts).
      piiFields.push({ columnName: col, piiType: 'NAME', severity: 'MEDIUM' });
    } else if (lower.includes('dob') || lower.includes('birth')) {
      piiFields.push({ columnName: col, piiType: 'DOB', severity: 'MEDIUM' });
    } else if (lower.includes('address') || lower.includes('zip') || lower.includes('location')) {
      piiFields.push({ columnName: col, piiType: 'LOCATION', severity: 'MEDIUM' });
    } else if (
      // Healthcare-specific PHI (HIPAA): quasi-identifiers that become
      // sensitive when combined with other fields in the same row.
      lower.includes('medical') ||
      lower.includes('diagnosis') ||
      lower.includes('condition') ||
      lower.includes('test_result') ||
      lower.includes('medication') ||
      lower.includes('blood_type') ||
      lower.includes('admission') ||
      lower.includes('discharge') ||
      lower.includes('doctor') ||
      lower.includes('hospital') ||
      lower.includes('insurance')
    ) {
      piiFields.push({ columnName: col, piiType: 'MEDICAL', severity: 'MEDIUM' });
    } else if (lower.includes('billing') || lower.includes('amount') || lower.includes('salary') || lower.includes('income')) {
      piiFields.push({ columnName: col, piiType: 'FINANCIAL', severity: 'LOW' });
    }
  }

  return piiFields;
}
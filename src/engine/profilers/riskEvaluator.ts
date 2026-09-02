// src/engine/profilers/riskEvaluator.ts

import type { PIIField } from './piiDetector';

export interface RiskAssessment {
  riskScore: number;
  riskLevel: 'CRITICAL' | 'WARNING' | 'SAFE';
  riskFactors: string[];
}

const NULL_DENSITY_THRESHOLD = 20;

export function computeRiskScore(
  piiFields: PIIField[],
  columns: { columnName: string; nullPercentage: number }[]
): RiskAssessment {
  let riskScore = 0;
  const riskFactors: string[] = [];

  if (piiFields.some((p) => p.severity === 'HIGH')) {
    riskScore += 45;
    riskFactors.push('Unmasked HIGH-severity PII detected (SSN/National ID/Financial account)');
  }
  if (piiFields.some((p) => p.severity === 'MEDIUM')) {
    riskScore += 25;
    riskFactors.push('Unmasked MEDIUM-severity PII detected (Name/Contact/Medical attributes)');
  }
  // NEW: LOW-severity PII now contributes a small amount instead of
  // being invisible to the score — previously any dataset with only
  // LOW findings (e.g. a single financial field) scored 0 and showed
  // as "Healthy" regardless of how much PII was actually present.
  if (piiFields.some((p) => p.severity === 'LOW')) {
    riskScore += 10;
    riskFactors.push('LOW-severity PII detected (Financial/Other identifiers)');
  }

  const highNullCols = columns.filter((c) => c.nullPercentage > NULL_DENSITY_THRESHOLD);
  if (highNullCols.length > 0) {
    riskScore += 20;
    riskFactors.push(`High NULL density (>${NULL_DENSITY_THRESHOLD}%) in columns: ${highNullCols.map((c) => c.columnName).join(', ')}`);
  }

  riskScore = Math.min(riskScore, 100);
  const riskLevel: RiskAssessment['riskLevel'] = riskScore > 60 ? 'CRITICAL' : riskScore > 30 ? 'WARNING' : 'SAFE';

  return { riskScore, riskLevel, riskFactors };
}
// src/engine/profilers/riskEvaluator.ts

// ============================================================
// PURPOSE
// ============================================================
// Single shared risk-scoring formula. Used by both the assess_risk
// WebMCP tool (single dataset, on demand) and the worker's aggregate
// GET_GOVERNANCE_SUMMARY (all datasets, for the dashboard KPIs) — so
// the two never drift into different scoring logic.
// ============================================================

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
    riskFactors.push('Unmasked HIGH-severity PII detected (SSN/National ID)');
  }
  if (piiFields.some((p) => p.severity === 'MEDIUM')) {
    riskScore += 25;
    riskFactors.push('Unmasked MEDIUM-severity PII detected (Email/Contact Info)');
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
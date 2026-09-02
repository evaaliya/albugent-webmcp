// src/webmcp/anomalyToolMap.ts

// ============================================================
// PURPOSE
// ============================================================
// Single source of truth for "which anomaly type nudges the agent
// toward which WebMCP tool(s)". Empty relevantTools = the fact is
// already fully computed on the client — the question states the
// known facts directly instead of calling a tool.
//
// IMPORTANT: every buildQuestion that references "these columns" or
// similar must actually LIST the columns in the question text. Saying
// "these columns were flagged" without naming them leaves the model
// free to guess — which it will, and it will guess wrong (this was a
// real bug: the agent once claimed all 15 columns were PII when only
// 1 had actually been flagged).
// ============================================================

export type AnomalyType = 'NULL_DENSITY' | 'PII_EXPOSURE' | 'RISK_SCORE' | 'LINEAGE_CONTEXT';

export interface AnomalyToolBinding {
  label: string;
  relevantTools: string[];
  buildQuestion: (urn: string, context?: Record<string, any>) => string;
}

export const ANOMALY_TOOL_MAP: Record<AnomalyType, AnomalyToolBinding> = {
  NULL_DENSITY: {
    label: 'High NULL density',
    relevantTools: ['profile_dataset'],
    buildQuestion: (urn) =>
      `Using the profile_dataset tool, explain the NULL density anomaly for ${urn} and tell me whether remediation is needed.`
  },

  PII_EXPOSURE: {
    label: 'PII exposure',
    relevantTools: [],
    buildQuestion: (urn, context) => {
      const fields = context?.piiFields as { columnName: string; piiType: string; severity: string }[] | undefined;
      const list = fields && fields.length > 0
        ? fields.map((f) => `${f.columnName} (${f.piiType}, ${f.severity} severity)`).join(', ')
        : 'none';
      return `In ${urn}, exactly these columns were deterministically flagged as PII: ${list}. Only discuss the columns listed here — do not assume any other column is PII. Should any of them be masked, and why?`;
    }
  },

  RISK_SCORE: {
    label: 'Elevated risk score',
    relevantTools: ['assess_risk'],
    buildQuestion: (urn) =>
      `Using the assess_risk tool, break down why ${urn} has this risk score and suggest next steps.`
  },

  LINEAGE_CONTEXT: {
    label: 'Lineage relationships',
    relevantTools: [],
    buildQuestion: (urn, context) => {
      const upstream = context?.upstream?.length ? context.upstream.join(', ') : 'none detected';
      const downstream = context?.downstream?.length ? context.downstream.join(', ') : 'none detected';
      return `${urn} has upstream table(s): ${upstream}, and downstream table(s): ${downstream} (inferred from naming convention). If this dataset changes or gets remediated, what should I check downstream, and does anything upstream need review first?`;
    }
  }
};
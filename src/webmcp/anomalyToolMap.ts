// src/webmcp/anomalyToolMap.ts

// ============================================================
// PURPOSE
// ============================================================
// Single source of truth for "which anomaly type nudges the agent
// toward which WebMCP tool(s)". The agent always keeps free choice
// (tool_choice='auto') — but the pre-filled question text names the
// relevant tool(s) explicitly, so in practice it reliably picks the
// right one. Some entries deliberately have an empty tool list: when
// the fact is already fully known/computed on the client (PII tags,
// naming-convention lineage), forcing a tool call adds latency and
// hallucination risk for zero benefit — the question just states the
// known facts directly.
//
// Today there are only 2 real detector tools (profile_dataset,
// assess_risk). As more deterministic detectors are added, just add
// an entry here — no changes needed elsewhere. See README.md section
// "Agent Tool Routing".
// ============================================================

export type AnomalyType = 'NULL_DENSITY' | 'PII_EXPOSURE' | 'RISK_SCORE' | 'LINEAGE_CONTEXT';

export interface AnomalyToolBinding {
  label: string;
  relevantTools: string[];
  // context carries extra known facts (e.g. lineage neighbors) that get
  // embedded directly into the question text — no tool call needed for those.
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
    // Deliberately empty — PII columns are already shown on screen via
    // deterministic pattern matching (piiDetector.ts). No tool call needed.
    relevantTools: [],
    buildQuestion: (urn) =>
      `These columns in ${urn} were flagged as PII. Should any of them be masked, and why?`
  },

  RISK_SCORE: {
    label: 'Elevated risk score',
    relevantTools: ['assess_risk'],
    buildQuestion: (urn) =>
      `Using the assess_risk tool, break down why ${urn} has this risk score and suggest next steps.`
  },

  LINEAGE_CONTEXT: {
    label: 'Lineage relationships',
    // Deliberately empty — the upstream/downstream neighbors are computed
    // deterministically client-side (see lineageHeuristics.ts) from naming
    // conventions, and handed to the agent directly in the question text.
    relevantTools: [],
    buildQuestion: (urn, context) => {
      const upstream = context?.upstream?.length ? context.upstream.join(', ') : 'none detected';
      const downstream = context?.downstream?.length ? context.downstream.join(', ') : 'none detected';
      return `${urn} has upstream table(s): ${upstream}, and downstream table(s): ${downstream} (inferred from naming convention). If this dataset changes or gets remediated, what should I check downstream, and does anything upstream need review first?`;
    }
  }
};
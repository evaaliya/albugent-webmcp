// src/webmcp/toolRegistry.ts

// ============================================================
// SECTION: Imports
// ============================================================
import { detectPII, type PIIField } from '../engine/profilers/piiDetector';
import { computeRiskScore } from '../engine/profilers/riskEvaluator';
import { inferLineageNeighbors } from '../engine/profilers/lineageHeuristics';

// ============================================================
// SECTION: Types
// ============================================================
export interface RemediationProposal {
  proposalId: string;
  datasetUrn: string;
  actionType: 'MASK_PII' | 'REMEDIATE_NULLS' | 'CIRCUIT_BREAK';
  description: string;
  sqlSnippet: string;
  approved: boolean;
}

export const pendingProposalsMap = new Map<string, RemediationProposal>();

// ============================================================
// SECTION: Tool registration
// ============================================================
export function registerGovernanceTools(
  callWorker: (type: string, payload?: any) => Promise<any>,
  onProposalCreated?: (proposal: RemediationProposal) => void
) {
  const modelContext = (document as any).modelContext;
  if (!modelContext) return;

  // ------------------------------------------------------------
  // TOOL 1: list_available_datasets
  // ------------------------------------------------------------
  modelContext.registerTool({
    name: 'list_available_datasets',
    description: 'Returns a list of all DataHub dataset URNs available for audit.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      try {
        const datasets = await callWorker('SCAN_DATASETS');
        return { content: [{ type: 'text', text: JSON.stringify(datasets, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Failed to scan datasets: ${err.message}` }], isError: true };
      }
    }
  });

  // ------------------------------------------------------------
  // TOOL 2: inspect_dataset_schema
  // ------------------------------------------------------------
  modelContext.registerTool({
    name: 'inspect_dataset_schema',
    description: 'Inspects metadata and columns for a given dataset URN.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetUrn: { type: 'string', description: 'The exact URN string returned by list_available_datasets.' }
      },
      required: ['datasetUrn']
    },
    execute: async (args: { datasetUrn: string }) => {
      try {
        const schema = await callWorker('GET_SCHEMA', { urn: args.datasetUrn });
        return { content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error inspecting schema: ${err.message}` }], isError: true };
      }
    }
  });

  // ------------------------------------------------------------
  // TOOL 3: profile_dataset
  // ------------------------------------------------------------
  modelContext.registerTool({
    name: 'profile_dataset',
    description: 'Calculates statistical metrics (null rates, uniqueness) for a dataset.',
    inputSchema: {
      type: 'object',
      properties: { datasetUrn: { type: 'string' } },
      required: ['datasetUrn']
    },
    execute: async (args: { datasetUrn: string }) => {
      try {
        const report = await callWorker('GET_PROFILE_METRICS', { urn: args.datasetUrn });
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Failed to profile dataset: ${err.message}` }], isError: true };
      }
    }
  });

  // ------------------------------------------------------------
  // TOOL 4: assess_risk
  // Uses the shared computeRiskScore helper — same formula as the
  // dashboard's aggregate GET_GOVERNANCE_SUMMARY, so numbers never drift.
  // ------------------------------------------------------------
  modelContext.registerTool({
    name: 'assess_risk',
    description: 'Calculates overall data governance risk score (0-100) based on PII density and anomalies.',
    inputSchema: {
      type: 'object',
      properties: { datasetUrn: { type: 'string' } },
      required: ['datasetUrn']
    },
    execute: async (args: { datasetUrn: string }) => {
      try {
        const profile = await callWorker('GET_PROFILE_METRICS', { urn: args.datasetUrn });
        const columnNames = profile.columns.map((c: any) => c.columnName);
        const piiFields: PIIField[] = detectPII(columnNames);

        const { riskScore, riskLevel, riskFactors } = computeRiskScore(piiFields, profile.columns);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              datasetUrn: args.datasetUrn,
              riskScore,
              riskLevel,
              piiFields,
              riskFactors
            }, null, 2)
          }]
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Failed to assess risk: ${err.message}` }], isError: true };
      }
    }
  });

  // ------------------------------------------------------------
  // TOOL 5: inspect_lineage
  // Re-enabled: runs entirely client-side via naming-convention
  // heuristics (see lineageHeuristics.ts) — no worker message type
  // needed, so it can never hang like the old GET_LINEAGE_IMPACT did.
  // ------------------------------------------------------------
  modelContext.registerTool({
    name: 'inspect_lineage',
    description: 'Infers upstream/downstream table relationships for a dataset from its naming convention (raw -> staging -> mart pipeline pattern).',
    inputSchema: {
      type: 'object',
      properties: { datasetUrn: { type: 'string' } },
      required: ['datasetUrn']
    },
    execute: async (args: { datasetUrn: string }) => {
      try {
        const allDatasets = await callWorker('SCAN_DATASETS');
        const target = allDatasets.find((d: any) => d.urn === args.datasetUrn);
        if (!target) {
          return { content: [{ type: 'text', text: `Dataset ${args.datasetUrn} not found in registry.` }], isError: true };
        }

        const siblingTableNames = allDatasets
          .filter((d: any) => d.domain === target.domain)
          .map((d: any) => d.table);

        const lineage = inferLineageNeighbors(target.table, siblingTableNames);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              datasetUrn: args.datasetUrn,
              table: target.table,
              pipelineStage: lineage.stage,
              upstream: lineage.upstream,
              downstream: lineage.downstream,
              note: 'Lineage inferred deterministically from table naming convention, not a live dependency graph.'
            }, null, 2)
          }]
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Failed to inspect lineage: ${err.message}` }], isError: true };
      }
    }
  });

  // ------------------------------------------------------------
  // TOOL 6: propose_remediation
  // ------------------------------------------------------------
  modelContext.registerTool({
    name: 'propose_remediation',
    description: 'Proposes a remediation action for human approval.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetUrn: { type: 'string' },
        actionType: { type: 'string', enum: ['MASK_PII', 'REMEDIATE_NULLS', 'CIRCUIT_BREAK'] }
      },
      required: ['datasetUrn', 'actionType']
    },
    execute: async (args: { datasetUrn: string; actionType: 'MASK_PII' | 'REMEDIATE_NULLS' | 'CIRCUIT_BREAK' }) => {
      const match = args.datasetUrn.match(/,[^,]+\.([^,]+),PROD\)/);
      const tableName = match ? match[1] : args.datasetUrn;

      const proposalId = `prop_${Math.random().toString(36).substring(2, 8)}`;
      let sqlSnippet = '';
      let description = '';

      if (args.actionType === 'MASK_PII') {
        sqlSnippet = `UPDATE "${tableName}" SET email = '***@masked.com' WHERE email IS NOT NULL;`;
        description = `Apply MASK_PII transformation on table ${tableName}`;
      } else {
        sqlSnippet = `-- Action ${args.actionType} execution logic`;
        description = `Execute ${args.actionType} on table ${tableName}`;
      }

      const proposal: RemediationProposal = {
        proposalId,
        datasetUrn: args.datasetUrn,
        actionType: args.actionType,
        description,
        sqlSnippet,
        approved: false
      };

      pendingProposalsMap.set(proposalId, proposal);
      if (onProposalCreated) onProposalCreated(proposal);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            proposalId,
            status: 'PENDING_HUMAN_APPROVAL',
            message: 'Remediation proposal generated. A human operator must approve this action in the UI before calling apply_remediation.'
          }, null, 2)
        }]
      };
    }
  });

  // ------------------------------------------------------------
  // TOOL 7: apply_remediation
  // ------------------------------------------------------------
  modelContext.registerTool({
    name: 'apply_remediation',
    description: 'Executes an approved remediation proposal.',
    inputSchema: {
      type: 'object',
      properties: { proposalId: { type: 'string' } },
      required: ['proposalId']
    },
    execute: async (args: { proposalId: string }) => {
      const proposal = pendingProposalsMap.get(args.proposalId);

      if (!proposal) {
        return { content: [{ type: 'text', text: `ERROR: Proposal ${args.proposalId} not found.` }], isError: true };
      }
      if (!proposal.approved) {
        return { content: [{ type: 'text', text: `REJECTED: Proposal ${args.proposalId} has NOT been approved by human operator.` }], isError: true };
      }

      try {
        await callWorker('APPLY_REMEDIATION', { sql: proposal.sqlSnippet });
        pendingProposalsMap.delete(args.proposalId);
        return { content: [{ type: 'text', text: `SUCCESS: Remediation ${args.proposalId} applied successfully.` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `SQL Execution Failed: ${err.message}` }], isError: true };
      }
    }
  });

  // ------------------------------------------------------------
  // select_database intentionally omitted — redundant, since all 3
  // domains are already eager-loaded at INIT.
  // ------------------------------------------------------------
}
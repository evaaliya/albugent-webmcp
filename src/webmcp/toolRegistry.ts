// src/webmcp/toolRegistry.ts

// ============================================================
// SECTION: Imports
// ============================================================
import { detectPII, type PIIField } from '../engine/profilers/piiDetector';
import { computeRiskScore } from '../engine/profilers/riskEvaluator';
import { inferLineageNeighbors } from '../engine/profilers/lineageHeuristics';
import { addProposal, getProposal, removeProposal, type RemediationProposal } from './proposalStore';
import { calculateBlastRadius } from '../engine/profilers/lineageEngine';

export type { RemediationProposal };

// ============================================================
// SECTION: Tool registration
// ============================================================
export function registerGovernanceTools(
  callWorker: (type: string, payload?: any) => Promise<any>
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
    annotations: { readOnlyHint: true, untrustedContentHint: false },
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
    annotations: { readOnlyHint: true, untrustedContentHint: false },
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
    annotations: { readOnlyHint: true, untrustedContentHint: false },
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
  // ------------------------------------------------------------
  modelContext.registerTool({
    name: 'assess_risk',
    description: 'Calculates overall data governance risk score (0-100) based on PII density and anomalies.',
    inputSchema: {
      type: 'object',
      properties: { datasetUrn: { type: 'string' } },
      required: ['datasetUrn']
    },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
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
  // ------------------------------------------------------------
    // ------------------------------------------------------------
  // TOOL 5: inspect_lineage
  // Naming-convention lineage (client-side heuristic) PLUS a real
  // blast-radius severity score computed by lineageEngine.ts — this
  // reuses code that already existed but was never wired in.
  // ------------------------------------------------------------
  modelContext.registerTool({
    name: 'inspect_lineage',
    description: 'Infers upstream/downstream table relationships for a dataset from its naming convention (raw -> staging -> mart pipeline pattern), and scores the blast radius of changing it.',
    inputSchema: {
      type: 'object',
      properties: { datasetUrn: { type: 'string' } },
      required: ['datasetUrn']
    },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
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

        // Build a naming-convention-derived dependency map across the whole
        // domain: fkMap[table] = tables it depends on (its upstream).
        // calculateBlastRadius then finds every table that depends on the
        // target — i.e. what would be affected if the target changes.
        const fkMap: Record<string, string[]> = {};
        for (const t of siblingTableNames) {
          fkMap[t] = inferLineageNeighbors(t, siblingTableNames).upstream;
        }
        const blastRadius = calculateBlastRadius(target.table, fkMap);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              datasetUrn: args.datasetUrn,
              table: target.table,
              pipelineStage: lineage.stage,
              upstream: lineage.upstream,
              downstream: lineage.downstream,
              blastRadiusScore: blastRadius.blastRadiusScore,
              dependentTables: blastRadius.dependentTables,
              note: 'Lineage and blast radius inferred deterministically from table naming convention, not a live foreign-key dependency graph.'
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
  // Now reasons about whether masking is actually warranted, instead
  // of blindly creating a proposal whenever any PII column exists.
  // If the dataset's overall risk is SAFE, it returns an advisory
  // instead of a proposal, so the agent can genuinely push back
  // ("this table looks healthy, are you sure?") rather than silently
  // complying — and rather than inventing a fake explanation later.
  // ------------------------------------------------------------
  modelContext.registerTool({
    name: 'propose_remediation',
    description: 'Proposes a remediation action for human approval. Checks overall risk first — if the dataset is SAFE, it will explain why masking may not be warranted instead of creating a proposal, unless force is set to true.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetUrn: { type: 'string' },
        actionType: { type: 'string', enum: ['MASK_PII', 'REMEDIATE_NULLS', 'CIRCUIT_BREAK'] },
        force: { type: 'boolean', description: 'Set true only if the human has explicitly confirmed they want to proceed despite a low risk score.' }
      },
      required: ['datasetUrn', 'actionType']
    },
    execute: async (args: { datasetUrn: string; actionType: 'MASK_PII' | 'REMEDIATE_NULLS' | 'CIRCUIT_BREAK'; force?: boolean }) => {
      const match = args.datasetUrn.match(/,[^,]+\.([^,]+),PROD\)/);
      const tableName = match ? match[1] : args.datasetUrn;

      if (args.actionType === 'MASK_PII') {
        try {
          const profile = await callWorker('GET_PROFILE_METRICS', { urn: args.datasetUrn });
          const columnNames = profile.columns.map((c: any) => c.columnName);
          const piiFields: PIIField[] = detectPII(columnNames);

          if (piiFields.length === 0) {
            return {
              content: [{ type: 'text', text: `No PII columns were detected for ${args.datasetUrn}. Nothing to mask — no proposal was created.` }],
              isError: true
            };
          }

          const { riskScore, riskLevel } = computeRiskScore(piiFields, profile.columns);

          // Real check, not a fabricated one: SAFE risk level genuinely
          // means low priority. Push back instead of complying blindly.
          if (riskLevel === 'SAFE' && !args.force) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'ADVISORY_NOT_PROPOSED',
                  datasetUrn: args.datasetUrn,
                  riskScore,
                  riskLevel,
                  piiFieldsFound: piiFields.map((f) => f.columnName),
                  message: `This dataset's overall risk score is ${riskScore}/100 (SAFE). The PII columns found (${piiFields.map((f) => f.columnName).join(', ')}) are present but not currently contributing to elevated risk. Masking is not clearly justified here. Ask the human if they still want to proceed — if so, call this tool again with force=true.`
                }, null, 2)
              }]
            };
          }

          const setClauses = piiFields.map((f) => `"${f.columnName}" = '***MASKED***'`).join(', ');
          const sqlSnippet = `UPDATE "${tableName}" SET ${setClauses};`;
          const description = `Mask ${piiFields.length} PII column(s) in ${tableName}: ${piiFields.map((f) => f.columnName).join(', ')}`;

          const proposalId = `prop_${Math.random().toString(36).substring(2, 8)}`;
          const proposal: RemediationProposal = {
            proposalId,
            datasetUrn: args.datasetUrn,
            actionType: args.actionType,
            description,
            sqlSnippet,
            approved: false
          };

          addProposal(proposal);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                proposalId,
                status: 'PENDING_HUMAN_APPROVAL',
                riskScore,
                riskLevel,
                description,
                sqlSnippet,
                message: 'Remediation proposal generated. A human operator must approve this in the chat before it is applied.'
              }, null, 2)
            }]
          };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Failed to evaluate dataset risk: ${err.message}` }], isError: true };
        }
      }

      // Non-MASK_PII actions unchanged — not yet fully implemented.
      const proposalId = `prop_${Math.random().toString(36).substring(2, 8)}`;
      const proposal: RemediationProposal = {
        proposalId,
        datasetUrn: args.datasetUrn,
        actionType: args.actionType,
        description: `Execute ${args.actionType} on table ${tableName}`,
        sqlSnippet: `-- Action ${args.actionType} execution logic (not yet implemented)`,
        approved: false
      };
      addProposal(proposal);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            proposalId,
            status: 'PENDING_HUMAN_APPROVAL',
            message: 'Remediation proposal generated. A human operator must approve this in the chat before it is applied.'
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
      const proposal = getProposal(args.proposalId);

      if (!proposal) {
        return { content: [{ type: 'text', text: `ERROR: Proposal ${args.proposalId} not found.` }], isError: true };
      }
      if (!proposal.approved) {
        return { content: [{ type: 'text', text: `REJECTED: Proposal ${args.proposalId} has NOT been approved by human operator.` }], isError: true };
      }

      try {
        await callWorker('APPLY_REMEDIATION', { urn: proposal.datasetUrn, sql: proposal.sqlSnippet });
        removeProposal(args.proposalId);
        return { content: [{ type: 'text', text: `SUCCESS: Remediation ${args.proposalId} applied successfully.` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `SQL Execution Failed: ${err.message}` }], isError: true };
      }
    }
  });
}
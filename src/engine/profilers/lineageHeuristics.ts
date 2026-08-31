// src/engine/lineageHeuristics.ts

// ============================================================
// PURPOSE
// ============================================================
// Deterministic, naming-convention-based lineage inference.
// No worker call, no LLM — this is pure string parsing over the dataset
// list we already have in memory. It's a stand-in for a real lineage
// graph (see lineageEngine.ts) until GET_LINEAGE_IMPACT exists in the
// worker. It works because this project's tables follow a clear
// raw -> staging -> mart pipeline naming pattern (with a parallel
// cleaned_ prefix variant).
// ============================================================

export interface LineageNeighbors {
    stage: string | null;
    isCleaned: boolean;
    baseName: string;
    upstream: string[];
    downstream: string[];
  }
  
  const STAGE_ORDER = ['raw', 'staging', 'mart'];
  
  function parseTableName(tableName: string): { isCleaned: boolean; stage: string | null; baseName: string } {
    const isCleaned = tableName.startsWith('cleaned_');
    const rest = isCleaned ? tableName.slice('cleaned_'.length) : tableName;
    const stage = STAGE_ORDER.find((s) => rest.startsWith(s + '_')) ?? null;
    const baseName = stage ? rest.slice(stage.length + 1) : rest;
    return { isCleaned, stage, baseName };
  }
  
  // Given one table and the full list of table names in the same domain,
  // finds the naming-convention neighbor one stage before/after.
  export function inferLineageNeighbors(
    tableName: string,
    allTablesInDomain: string[]
  ): LineageNeighbors {
    const { isCleaned, stage, baseName } = parseTableName(tableName);
  
    if (!stage) {
      return { stage: null, isCleaned, baseName, upstream: [], downstream: [] };
    }
  
    const stageIndex = STAGE_ORDER.indexOf(stage);
    const prefix = isCleaned ? 'cleaned_' : '';
    const upstream: string[] = [];
    const downstream: string[] = [];
  
    if (stageIndex > 0) {
      const upName = `${prefix}${STAGE_ORDER[stageIndex - 1]}_${baseName}`;
      if (allTablesInDomain.includes(upName)) upstream.push(upName);
    }
    if (stageIndex < STAGE_ORDER.length - 1) {
      const downName = `${prefix}${STAGE_ORDER[stageIndex + 1]}_${baseName}`;
      if (allTablesInDomain.includes(downName)) downstream.push(downName);
    }
  
    return { stage, isCleaned, baseName, upstream, downstream };
  }
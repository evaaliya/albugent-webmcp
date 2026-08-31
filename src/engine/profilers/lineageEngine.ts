export interface LineageImpact {
    targetTable: string;
    dependentTables: string[];
    blastRadiusScore: 'HIGH' | 'MEDIUM' | 'LOW';
  }
  
  export function calculateBlastRadius(
    targetTable: string, 
    fkMap: Record<string, string[]> = {}
  ): LineageImpact {
    const dependentTables: string[] = [];
  
    for (const [table, references] of Object.entries(fkMap)) {
      if (references.includes(targetTable) && table !== targetTable) {
        dependentTables.push(table);
      }
    }
  
    const count = dependentTables.length;
    const blastRadiusScore = count > 2 ? 'HIGH' : count > 0 ? 'MEDIUM' : 'LOW';
  
    return {
      targetTable,
      dependentTables,
      blastRadiusScore
    };
  }
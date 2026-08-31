export interface ColumnProfile {
    columnName: string;
    totalRows: number;
    nullCount: number;
    nullPercentage: number;
    uniqueCount: number;
    isUnique: boolean;
  }
  
  export interface DatasetProfile {
    tableName: string;
    datasetUrn: string;
    totalRows: number;
    columns: ColumnProfile[];
    generatedAt: string;
  }
  
  export function analyzeAnomalies(
    tableName: string,
    rows: any[],
    cols: { name: string; type: string }[]
  ): DatasetProfile {
    const totalRows = rows.length;
    const columnProfiles: ColumnProfile[] = [];
  
    for (const col of cols) {
      const colName = col.name;
      let nullCount = 0;
      const uniqueValues = new Set();
  
      for (const row of rows) {
        const val = row[colName];
        if (val === null || val === undefined) {
          nullCount++;
        } else {
          uniqueValues.add(val);
        }
      }
  
      const uniqueCount = uniqueValues.size;
  
      columnProfiles.push({
        columnName: colName,
        totalRows,
        nullCount,
        nullPercentage: totalRows > 0 ? Number(((nullCount / totalRows) * 100).toFixed(2)) : 0,
        uniqueCount,
        isUnique: uniqueCount === totalRows && totalRows > 0
      });
    }
  
    return {
      tableName,
      datasetUrn: `urn:sqlite:local:${tableName}`,
      totalRows,
      columns: columnProfiles,
      generatedAt: new Date().toISOString()
    };
  }
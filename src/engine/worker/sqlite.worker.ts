// src/engine/worker/sqlite.worker.ts

// ============================================================
// SECTION: Imports
// ============================================================
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { analyzeAnomalies } from '../profilers/anomalyProfiler';
import { detectPII } from '../profilers/piiDetector';
import { computeRiskScore } from '../profilers/riskEvaluator';

// ============================================================
// SECTION: Types
// ============================================================
export interface DatasetMeta {
  urn: string;
  domain: string;
  table: string;
  dbPath: string;
  status: 'AVAILABLE' | 'ERROR';
}

// ============================================================
// SECTION: In-memory state
// ============================================================
let sqlite3: any = null;
const dbConnections: Map<string, any> = new Map();
const datasetRegistry: Map<string, DatasetMeta> = new Map();
const TARGET_DOMAINS = ['healthcare', 'fiction-retail', 'nyc-taxi'];

const DOMAIN_FILE_MAP: Record<string, string> = {
  'healthcare': 'healthcare.db',
  'fiction-retail': 'fiction-retail.db',
  'nyc-taxi': 'nyc_taxi_pipeline.db',
};

// ============================================================
// SECTION: SQLite WASM bootstrap
// ============================================================
async function initSqlite() {
  if (!sqlite3) {
    sqlite3 = await sqlite3InitModule({
      print: console.log,
      printErr: console.error,
    });
  }
}

function isValidSqliteHeader(buffer: ArrayBuffer): boolean {
  const header = new Uint8Array(buffer.slice(0, 16));
  const magic = 'SQLite format 3\0';
  for (let i = 0; i < magic.length; i++) {
    if (header[i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

async function loadDomainDatabase(domain: string): Promise<any> {
  if (dbConnections.has(domain)) {
    return dbConnections.get(domain);
  }

  const fileName = DOMAIN_FILE_MAP[domain] ?? `${domain}.db`;
  const path = `/datasets/${fileName}`;

  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Database file for domain '${domain}' not found at ${path} (HTTP ${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();

  if (!isValidSqliteHeader(arrayBuffer)) {
    throw new Error(
      `Path ${path} did not return a valid SQLite file (got ${arrayBuffer.byteLength} bytes). ` +
      `This usually means Vite served an HTML fallback because the path is wrong.`
    );
  }

  const byteArray = new Uint8Array(arrayBuffer);
  const p = sqlite3.wasm.allocFromTypedArray(byteArray);
  const db = new sqlite3.oo1.DB();
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer,
    'main',
    p,
    byteArray.byteLength,
    byteArray.byteLength,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
  );
  if (rc !== 0) {
    throw new Error(`Failed to deserialize DB for domain ${domain} (code ${rc})`);
  }

  dbConnections.set(domain, db);
  return db;
}

// ============================================================
// SECTION: Dataset discovery
// ============================================================
async function scanEnterpriseDatasets(): Promise<DatasetMeta[]> {
  datasetRegistry.clear();

  for (const domain of TARGET_DOMAINS) {
    try {
      const db = await loadDomainDatabase(domain);
      const tables: string[] = [];

      db.exec({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
        rowMode: 'object',
        callback: (row: any) => tables.push(row.name)
      });

      for (const table of tables) {
        const urn = `urn:li:dataset:(urn:li:dataPlatform:sqlite,${domain}.${table},PROD)`;
        const meta: DatasetMeta = {
          urn,
          domain,
          table,
          dbPath: `/datasets/${DOMAIN_FILE_MAP[domain] ?? `${domain}.db`}`,
          status: 'AVAILABLE'
        };
        datasetRegistry.set(urn, meta);
      }
    } catch (err) {
      console.warn(`[Scan] Domain '${domain}' could not be loaded:`, err);
    }
  }

  return Array.from(datasetRegistry.values());
}

// ============================================================
// SECTION: Message handler
// ============================================================
self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data;

  try {
    if (type === 'INIT') {
      await initSqlite();
      const discoveredDatasets = await scanEnterpriseDatasets();
      self.postMessage({ id, success: true, data: { initialized: true, datasets: discoveredDatasets } });
      return;
    }

    if (type === 'SCAN_DATASETS') {
      const datasets = await scanEnterpriseDatasets();
      self.postMessage({ id, success: true, data: datasets });
      return;
    }

    if (type === 'GET_SCHEMA') {
      const { urn } = payload;
      const meta = datasetRegistry.get(urn);
      if (!meta) throw new Error(`URN ${urn} not found in registry`);

      const db = dbConnections.get(meta.domain);
      const columns: any[] = [];
      db.exec({
        sql: `PRAGMA table_info("${meta.table}");`,
        rowMode: 'object',
        callback: (col: any) => columns.push({ name: col.name, type: col.type, notNull: col.notnull === 1 })
      });

      self.postMessage({ id, success: true, data: { urn, domain: meta.domain, table: meta.table, columns } });
      return;
    }

    if (type === 'GET_PROFILE_METRICS') {
      const { urn } = payload;
      const meta = datasetRegistry.get(urn);
      if (!meta) throw new Error(`URN ${urn} not found in registry`);

      const db = dbConnections.get(meta.domain);
      const cols: any[] = [];
      db.exec({
        sql: `PRAGMA table_info("${meta.table}");`,
        rowMode: 'object',
        callback: (col: any) => cols.push({ name: col.name, type: col.type })
      });

      const rows: any[] = [];
      db.exec({
        sql: `SELECT * FROM "${meta.table}" LIMIT 1000;`,
        rowMode: 'object',
        callback: (r: any) => rows.push(r)
      });

      const profile = analyzeAnomalies(meta.table, rows, cols);

      self.postMessage({ id, success: true, data: { urn, ...profile } });
      return;
    }

    if (type === 'GET_PII_COLUMNS') {
      const { urn } = payload;
      const meta = datasetRegistry.get(urn);
      if (!meta) throw new Error(`URN ${urn} not found in registry`);

      const db = dbConnections.get(meta.domain);
      const columnNames: string[] = [];
      db.exec({
        sql: `PRAGMA table_info("${meta.table}");`,
        rowMode: 'object',
        callback: (col: any) => columnNames.push(col.name)
      });

      const piiFields = detectPII(columnNames);

      self.postMessage({ id, success: true, data: { urn, piiFields } });
      return;
    }

    // ------------------------------------------------------------
    // GET_GOVERNANCE_SUMMARY — aggregate across ALL registered datasets.
    // perDataset now also carries hasPII / piiMaxSeverity / hasHighNull
    // as independent boolean facts, separate from the blended riskScore —
    // so the UI can flag PII presence even when it barely moves the
    // aggregate score.
    // ------------------------------------------------------------
    if (type === 'GET_GOVERNANCE_SUMMARY') {
      const datasets = Array.from(datasetRegistry.values());
      let totalPiiFields = 0;
      let totalRiskScore = 0;
      let datasetsScored = 0;

      const piiSeverityBreakdown = { HIGH: 0, MEDIUM: 0, LOW: 0 };
      const riskLevelBreakdown = { CRITICAL: 0, WARNING: 0, SAFE: 0 };
      const perDataset: Array<{
        urn: string;
        riskLevel: 'CRITICAL' | 'WARNING' | 'SAFE';
        riskScore: number;
        hasPII: boolean;
        piiMaxSeverity: 'HIGH' | 'MEDIUM' | 'LOW' | null;
        hasHighNull: boolean;
      }> = [];

      const anomalies: Array<{
        urn: string;
        domain: string;
        table: string;
        severity: 'CRITICAL' | 'WARNING';
        message: string;
        timestamp: string;
      }> = [];

      for (const meta of datasets) {
        try {
          const db = dbConnections.get(meta.domain);
          if (!db) continue;

          const cols: any[] = [];
          db.exec({
            sql: `PRAGMA table_info("${meta.table}");`,
            rowMode: 'object',
            callback: (col: any) => cols.push({ name: col.name, type: col.type })
          });

          const rows: any[] = [];
          db.exec({
            sql: `SELECT * FROM "${meta.table}" LIMIT 1000;`,
            rowMode: 'object',
            callback: (r: any) => rows.push(r)
          });

          const profile = analyzeAnomalies(meta.table, rows, cols);
          const piiFields = detectPII(cols.map((c) => c.name));

          totalPiiFields += piiFields.length;
          piiFields.forEach((p) => { piiSeverityBreakdown[p.severity]++; });

          const { riskScore, riskLevel } = computeRiskScore(piiFields, profile.columns);
          totalRiskScore += riskScore;
          datasetsScored++;
          riskLevelBreakdown[riskLevel]++;

          const hasPII = piiFields.length > 0;
          const piiMaxSeverity: 'HIGH' | 'MEDIUM' | 'LOW' | null = hasPII
            ? (piiFields.some((f) => f.severity === 'HIGH') ? 'HIGH'
              : piiFields.some((f) => f.severity === 'MEDIUM') ? 'MEDIUM'
              : 'LOW')
            : null;
          const hasHighNull = profile.columns.some((c) => c.nullPercentage > 20);

          perDataset.push({ urn: meta.urn, riskLevel, riskScore, hasPII, piiMaxSeverity, hasHighNull });

          if (riskLevel !== 'SAFE') {
            const highNull = profile.columns.filter((c) => c.nullPercentage > 20);
            let message: string;
            if (piiFields.some((p) => p.severity === 'HIGH')) {
              message = `Unmasked high-severity PII in ${meta.table}`;
            } else if (highNull.length > 0) {
              message = `High NULL density in ${meta.table}: ${highNull.map((c) => c.columnName).join(', ')}`;
            } else {
              message = `Elevated risk detected in ${meta.table}`;
            }
            anomalies.push({
              urn: meta.urn,
              domain: meta.domain,
              table: meta.table,
              severity: riskLevel === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
              message,
              timestamp: new Date().toISOString()
            });
          }
        } catch (err) {
          console.warn(`[GovernanceSummary] Failed to score ${meta.urn}:`, err);
        }
      }

      anomalies.sort((a, b) => (a.severity === 'CRITICAL' ? 0 : 1) - (b.severity === 'CRITICAL' ? 0 : 1));

      const avgRiskScore01 = datasetsScored > 0 ? totalRiskScore / datasetsScored / 100 : 0;

      self.postMessage({
        id,
        success: true,
        data: {
          datasetsScored,
          totalPiiFields,
          avgRiskScore: Number(avgRiskScore01.toFixed(3)),
          anomalies: anomalies.slice(0, 10),
          piiSeverityBreakdown,
          riskLevelBreakdown,
          perDataset
        }
      });
      return;
    }

    if (type === 'APPLY_REMEDIATION') {
      const { urn, sql } = payload;
      const meta = datasetRegistry.get(urn);
      if (!meta) throw new Error(`URN ${urn} not found in registry`);

      const db = dbConnections.get(meta.domain);
      if (!db) throw new Error(`No open database connection for domain ${meta.domain}`);

      db.exec({ sql });

      self.postMessage({ id, success: true, data: { applied: true, sql } });
      return;
    }

  } catch (err: any) {
    self.postMessage({ id, success: false, error: err.message });
  }
};
// src/App.tsx

// ============================================================
// SECTION: Imports
// ============================================================
import React, { useState, useEffect, useCallback } from 'react';
import { callWorker } from './engine/workerClient';
import { detectPII } from './engine/profilers/piiDetector';
import { ANOMALY_TOOL_MAP } from './webmcp/anomalyToolMap';
import { inferLineageNeighbors } from './engine/profilers/lineageHeuristics';
import ChatWidget from './components/ChatWidget';
import KPIModal, { type KPIModalKind } from './components/KPIModal';
import AnomalyIcons from './components/AnomalyIcons';
import { subscribeToProposals, markApproved, removeProposal, type RemediationProposal } from './webmcp/proposalStore';

// ============================================================
// SECTION: Types
// ============================================================
interface DatasetItem {
  urn: string;
  domain: string;
  table_name: string;
  status: 'Healthy' | 'Warning' | 'Critical';
  hasPII: boolean;
  piiMaxSeverity: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  hasHighNull: boolean;
}

interface ColumnProfile {
  columnName: string;
  totalRows: number;
  nullCount: number;
  nullPercentage: number;
  uniqueCount: number;
  isUnique: boolean;
}

interface DatasetProfile {
  tableName: string;
  datasetUrn: string;
  totalRows: number;
  columns: ColumnProfile[];
  generatedAt: string;
}

interface GovernanceAnomaly {
  urn: string;
  domain: string;
  table: string;
  severity: 'CRITICAL' | 'WARNING';
  message: string;
  timestamp: string;
}

interface PerDatasetRisk {
  urn: string;
  riskLevel: 'CRITICAL' | 'WARNING' | 'SAFE';
  riskScore: number;
  hasPII: boolean;
  piiMaxSeverity: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  hasHighNull: boolean;
}

interface GovernanceSummary {
  datasetsScored: number;
  totalPiiFields: number;
  avgRiskScore: number;
  anomalies: GovernanceAnomaly[];
  piiSeverityBreakdown: { HIGH: number; MEDIUM: number; LOW: number };
  riskLevelBreakdown: { CRITICAL: number; WARNING: number; SAFE: number };
  perDataset: PerDatasetRisk[];
}

const NULL_DENSITY_THRESHOLD = 20;

function formatRiskScore(score01: number): string {
  const s = score01.toFixed(3);
  return s.startsWith('0.') ? s.slice(1) : s;
}

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function riskLevelToStatus(level: 'CRITICAL' | 'WARNING' | 'SAFE'): DatasetItem['status'] {
  if (level === 'CRITICAL') return 'Critical';
  if (level === 'WARNING') return 'Warning';
  return 'Healthy';
}

export default function App() {
  // ============================================================
  // SECTION: Component state
  // ============================================================
  const [activeTab, setActiveTab] = useState<'datasets' | 'detail'>('datasets');
  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [selectedUrn, setSelectedUrn] = useState<string | null>(null);

  const [detailProfile, setDetailProfile] = useState<DatasetProfile | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [governanceSummary, setGovernanceSummary] = useState<GovernanceSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const [activeModal, setActiveModal] = useState<KPIModalKind | null>(null);

  const [proposals, setProposals] = useState<RemediationProposal[]>([]);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const [chatPresetQuery, setChatPresetQuery] = useState('');
  const [chatPresetTrigger, setChatPresetTrigger] = useState(0);

  const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY || '';

  // ============================================================
  // SECTION: Data loading
  // ============================================================
  const refreshGovernanceData = useCallback(async () => {
    try {
      const result = await callWorker('SCAN_DATASETS');
      let mapped: DatasetItem[] = [];
      if (Array.isArray(result)) {
        mapped = result.map((d: any) => ({
          urn: d.urn,
          domain: d.domain,
          table_name: d.table,
          status: 'Healthy',
          hasPII: false,
          piiMaxSeverity: null,
          hasHighNull: false
        }));
      }

      setSummaryLoading(true);
      const summary: GovernanceSummary = await callWorker('GET_GOVERNANCE_SUMMARY');
      setGovernanceSummary(summary);

      const riskMap = new Map(summary.perDataset.map((d) => [d.urn, d]));
      setDatasets(
        mapped.map((d) => {
          const info = riskMap.get(d.urn);
          if (!info) return d;
          return {
            ...d,
            status: riskLevelToStatus(info.riskLevel),
            hasPII: info.hasPII,
            piiMaxSeverity: info.piiMaxSeverity,
            hasHighNull: info.hasHighNull
          };
        })
      );

      if (selectedUrn) {
        try {
          const profile = await callWorker('GET_PROFILE_METRICS', { urn: selectedUrn });
          setDetailProfile(profile);
        } catch {
          // non-fatal
        }
      }
    } catch (err) {
      console.error('Error refreshing governance data:', err);
    } finally {
      setSummaryLoading(false);
    }
  }, [selectedUrn]);

  useEffect(() => {
    const unsubscribe = subscribeToProposals(setProposals);
    return unsubscribe;
  }, []);

  useEffect(() => {
    refreshGovernanceData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============================================================
  // SECTION: Data loading — dataset detail (column profile)
  // ============================================================
  useEffect(() => {
    if (activeTab !== 'detail' || !selectedUrn) return;

    let cancelled = false;

    async function loadDetail() {
      setDetailLoading(true);
      setDetailError(null);
      setDetailProfile(null);
      try {
        const profile = await callWorker('GET_PROFILE_METRICS', { urn: selectedUrn });
        if (!cancelled) setDetailProfile(profile);
      } catch (err: any) {
        if (!cancelled) setDetailError(err.message);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }

    loadDetail();
    return () => { cancelled = true; };
  }, [activeTab, selectedUrn]);

  // ============================================================
  // SECTION: Event handlers
  // ============================================================
  const handleAskAgent = (question: string) => {
    setChatPresetQuery(question);
    setChatPresetTrigger((n) => n + 1);
  };

  const handleNavigateToTable = (tableName: string, domain: string) => {
    const target = datasets.find((d) => d.domain === domain && d.table_name === tableName);
    if (target) {
      setSelectedUrn(target.urn);
      setActiveTab('detail');
    }
  };

  const handleNavigateToUrn = (urn: string) => {
    setSelectedUrn(urn);
    setActiveTab('detail');
  };

  const handleApproveProposal = async (proposalId: string) => {
    const proposal = proposals.find((p) => p.proposalId === proposalId);
    if (!proposal) return;

    setApplyingId(proposalId);
    markApproved(proposalId);

    try {
      await callWorker('APPLY_REMEDIATION', { urn: proposal.datasetUrn, sql: proposal.sqlSnippet });
      removeProposal(proposalId);
      await refreshGovernanceData();
    } catch (err: any) {
      alert(`Failed to apply proposal: ${err.message}`);
    } finally {
      setApplyingId(null);
    }
  };

  const handleRejectProposal = (proposalId: string) => {
    removeProposal(proposalId);
  };

  // ============================================================
  // SECTION: Derived data
  // ============================================================
  const piiFields = detailProfile
    ? detectPII(detailProfile.columns.map((c) => c.columnName))
    : [];

  const highNullColumns = detailProfile
    ? detailProfile.columns.filter((c) => c.nullPercentage > NULL_DENSITY_THRESHOLD)
    : [];

  const selectedDataset = datasets.find((d) => d.urn === selectedUrn);
  const siblingTableNames = selectedDataset
    ? datasets.filter((d) => d.domain === selectedDataset.domain).map((d) => d.table_name)
    : [];
  const lineage = selectedDataset && detailProfile
    ? inferLineageNeighbors(detailProfile.tableName, siblingTableNames)
    : null;

  const datasetStatusCounts = {
    Healthy: datasets.filter((d) => d.status === 'Healthy').length,
    Warning: datasets.filter((d) => d.status === 'Warning').length,
    Critical: datasets.filter((d) => d.status === 'Critical').length
  };

  // ============================================================
  // SECTION: Render
  // ============================================================
  return (
    <div className="h-screen bg-[#060608] text-mono text-gray-200 font-mono flex flex-col overflow-hidden">

      <header className="border-b border-gray-800 px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-3">
          <div className="text-white font-bold tracking-widest flex items-center gap-2">
            <span className="text-xl">[]</span> ALBUGENT
          </div>
          <span className="text-xs bg-gray-900 text-gray-400 px-2 py-0.5 rounded border border-gray-800">
            v0.9.1-OBS
          </span>
        </div>

        <nav className="flex space-x-8 text-sm font-medium">
          <button
            onClick={() => setActiveTab('datasets')}
            className={`hover:text-white transition-colors ${activeTab === 'datasets' ? 'text-white border-b-2 border-white pb-1' : 'text-gray-500'}`}
          >
            Datasets
          </button>
          <button
            onClick={() => setActiveTab('detail')}
            className={`hover:text-white transition-colors ${activeTab === 'detail' ? 'text-white border-b-2 border-white pb-1' : 'text-gray-500'}`}
          >
            Dataset Detail
          </button>
        </nav>

        <div className="flex items-center space-x-4">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
        </div>
      </header>

      <main className="flex-1 p-6 flex flex-col gap-6 overflow-hidden">

        {activeTab === 'datasets' && (
          <>
            <div className="relative h-48 bg-black border border-gray-800 rounded-lg overflow-hidden flex items-center justify-around p-4 shrink-0">
              <div className="absolute inset-0 bg-[radial-gradient(#1f2937_1px,transparent_1px)] [background-size:16px_16px] opacity-40"></div>

              <button
                onClick={() => setActiveModal('datasets')}
                className="z-10 bg-black/80 border border-gray-800 hover:border-gray-600 p-4 rounded text-center min-w-[160px] cursor-pointer transition-colors"
              >
                <div className="text-xs text-gray-400 flex items-center justify-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> DATASETS MONITORED
                </div>
                <div className="text-2xl font-bold mt-1">{datasets.length}</div>
              </button>

              <button
                onClick={() => setActiveModal('pii')}
                className="z-10 bg-black/80 border border-gray-800 hover:border-gray-600 p-4 rounded text-center min-w-[160px] cursor-pointer transition-colors"
              >
                <div className="text-xs text-gray-400 flex items-center justify-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span> PII DETECTED
                </div>
                <div className="text-2xl font-bold mt-1 text-amber-400">
                  {summaryLoading ? '...' : `${governanceSummary?.totalPiiFields ?? 0} Fields`}
                </div>
              </button>

              <button
                onClick={() => setActiveModal('risk')}
                className="z-10 bg-black/80 border border-gray-800 hover:border-gray-600 p-4 rounded text-center min-w-[160px] cursor-pointer transition-colors"
              >
                <div className="text-xs text-gray-400 flex items-center justify-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span> RISK SCORE
                </div>
                <div className="text-2xl font-bold mt-1 text-red-400">
                  {summaryLoading ? '...' : formatRiskScore(governanceSummary?.avgRiskScore ?? 0)}
                </div>
              </button>
            </div>

            <div className="grid grid-cols-12 gap-6 flex-1 min-h-0">

              <div className="col-span-4 bg-[#0a0a0f] border border-gray-800 rounded-lg p-4 flex flex-col overflow-hidden">
                <h3 className="text-xs text-gray-400 font-semibold mb-4 tracking-wider uppercase">ACTIVE GOVERNANCE RUNS</h3>
                <div className="space-y-2 overflow-y-auto flex-1 pr-1">
                  {datasets.map((d) => (
                    <div
                      key={d.urn}
                      onClick={() => { setSelectedUrn(d.urn); setActiveTab('detail'); }}
                      className="flex items-center justify-between gap-2 p-3 bg-black border border-gray-900 rounded hover:border-gray-700 cursor-pointer transition-colors"
                    >
                      <span className="text-sm font-medium text-gray-300 min-w-0 truncate">
                        {d.table_name}
                      </span>
                      <AnomalyIcons
                        hasPII={d.hasPII}
                        piiMaxSeverity={d.piiMaxSeverity}
                        hasHighNull={d.hasHighNull}
                      />
                      <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${
                        d.status === 'Healthy' ? 'text-emerald-400 bg-emerald-950/40 border border-emerald-900' :
                        d.status === 'Critical' ? 'text-red-400 bg-red-950/40 border border-red-900' : 'text-amber-400 bg-amber-950/40'
                      }`}>
                        {d.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="col-span-4 bg-[#0a0a0f] border border-gray-800 rounded-lg p-4 flex flex-col overflow-hidden">
                <h3 className="text-xs text-gray-400 font-semibold mb-4 tracking-wider uppercase">RECENT ANOMALIES</h3>
                <div className="space-y-3 overflow-y-auto flex-1 pr-1">
                  {summaryLoading && (
                    <div className="text-xs text-gray-600">Scanning all datasets...</div>
                  )}
                  {!summaryLoading && (governanceSummary?.anomalies.length ?? 0) === 0 && (
                    <div className="text-xs text-gray-600">No anomalies above threshold detected.</div>
                  )}
                  {governanceSummary?.anomalies.map((a) => (
                    <div
                      key={a.urn}
                      onClick={() => handleNavigateToUrn(a.urn)}
                      className={`p-3 bg-black border rounded cursor-pointer hover:border-gray-600 transition-colors ${
                        a.severity === 'CRITICAL' ? 'border-red-900/40' : 'border-amber-900/40'
                      }`}
                    >
                      <div className="flex justify-between text-xs text-gray-500 mb-1">
                        <span>{formatTime(a.timestamp)}</span>
                        <span className={`font-bold px-1 rounded border ${
                          a.severity === 'CRITICAL'
                            ? 'text-red-400 bg-red-950/60 border-red-800'
                            : 'text-amber-400 bg-amber-950/60 border-amber-800'
                        }`}>
                          {a.severity}
                        </span>
                      </div>
                      <div className="text-xs text-gray-300">{a.message}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="col-span-4 bg-[#0a0a0f] border border-gray-800 rounded-lg p-4 flex flex-col overflow-hidden">
                <h3 className="text-xs text-gray-400 font-semibold mb-4 tracking-wider uppercase">REMEDIATION QUEUE (PENDING APPROVAL)</h3>
                {proposals.length === 0 ? (
                  <div className="text-xs text-gray-600 text-center py-8">
                    No pending action proposals. Ask the agent to propose a remediation
                    (e.g. "propose masking PII in ...") to see it appear here.
                  </div>
                ) : (
                  <div className="space-y-3 overflow-y-auto flex-1 pr-1">
                    {proposals.map((prop) => (
                      <div key={prop.proposalId} className="p-3 bg-black border border-gray-800 rounded space-y-2">
                        <div className="text-xs font-bold text-gray-200">{prop.actionType}</div>
                        <div className="text-[11px] text-gray-500">{prop.description}</div>
                        <div className="text-[11px] text-gray-400 font-mono bg-gray-900 p-1.5 rounded break-all">
                          {prop.sqlSnippet}
                        </div>
                        <div className="flex space-x-2 pt-1">
                          <button
                            onClick={() => handleApproveProposal(prop.proposalId)}
                            disabled={applyingId === prop.proposalId}
                            className="flex-1 bg-emerald-950 hover:bg-emerald-900 disabled:opacity-50 border border-emerald-700 text-emerald-300 text-xs py-1 rounded font-bold transition-colors"
                          >
                            {applyingId === prop.proposalId ? 'Applying...' : 'APPROVE'}
                          </button>
                          <button
                            onClick={() => handleRejectProposal(prop.proposalId)}
                            disabled={applyingId === prop.proposalId}
                            className="flex-1 bg-red-950 hover:bg-red-900 disabled:opacity-50 border border-red-700 text-red-300 text-xs py-1 rounded font-bold transition-colors"
                          >
                            REJECT
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {activeTab === 'detail' && (
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <div className="bg-[#0a0a0f] border border-gray-800 rounded-lg p-6 flex-1 min-h-0 flex flex-col overflow-hidden">
              <h2 className="text-xl font-bold text-white mb-1 break-all shrink-0">
                {selectedUrn || 'No dataset selected'}
              </h2>
              <div className="text-xs text-gray-500 mb-6 shrink-0">
                SOURCE: SQLite WASM // {detailProfile ? `${detailProfile.totalRows} rows scanned` : 'loading...'}
              </div>

              {!selectedUrn && (
                <div className="text-sm text-gray-600">
                  Select a dataset from the Datasets tab to see its profile.
                </div>
              )}
              {detailLoading && <div className="text-sm text-gray-500">Profiling dataset...</div>}
              {detailError && <div className="text-sm text-red-400">Failed to load profile: {detailError}</div>}

              {detailProfile && !detailLoading && !detailError && (
                <div className="grid grid-cols-2 gap-8 flex-1 min-h-0 overflow-hidden">

                  <div className="flex flex-col min-h-0 overflow-hidden">
                    <h4 className="text-xs text-gray-400 uppercase mb-3 shrink-0">Column Profile</h4>
                    <div className="space-y-3 overflow-y-auto flex-1 pr-2">
                      {detailProfile.columns.map((col) => (
                        <div key={col.columnName}>
                          <div className="flex justify-between text-xs text-gray-300 mb-1">
                            <span className="truncate">{col.columnName}</span>
                            <span className={col.nullPercentage > NULL_DENSITY_THRESHOLD ? 'text-red-400' : ''}>
                              {col.nullPercentage}% NULL
                            </span>
                          </div>
                          <div className="h-1.5 bg-gray-900 rounded-full overflow-hidden">
                            <div
                              className={`h-full ${col.nullPercentage > NULL_DENSITY_THRESHOLD ? 'bg-red-500' : 'bg-emerald-500'}`}
                              style={{ width: `${Math.max(col.nullPercentage, 2)}%` }}
                            ></div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <h4 className="text-xs text-gray-400 uppercase mt-6 mb-3 shrink-0">PII Detection Results</h4>
                    {piiFields.length === 0 ? (
                      <div className="text-xs text-gray-600 shrink-0">No PII columns detected.</div>
                    ) : (
                      <div className="flex flex-wrap gap-2 shrink-0 max-h-24 overflow-y-auto">
                        {piiFields.map((p) => (
                          <span
                            key={p.columnName}
                            className={`text-xs bg-gray-900 border px-2 py-1 rounded ${
                              p.severity === 'HIGH' ? 'border-red-900 text-red-300' : 'border-amber-900 text-amber-300'
                            }`}
                          >
                            {p.columnName}{' '}
                            <span className={`text-[10px] px-1 rounded ml-1 ${
                              p.severity === 'HIGH' ? 'bg-red-950 text-red-500' : 'bg-amber-950 text-amber-500'
                            }`}>
                              {p.piiType}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="border-l border-gray-800 pl-8 space-y-4 overflow-y-auto min-h-0">
                    <h4 className="text-xs text-gray-400 uppercase mb-3">Anomaly Actions</h4>

                    {highNullColumns.length > 0 && (
                      <div className="p-3 bg-black border border-red-900/40 rounded space-y-2">
                        <div className="text-xs font-bold text-red-300">
                          {ANOMALY_TOOL_MAP.NULL_DENSITY.label}
                        </div>
                        <div className="text-[11px] text-gray-400">
                          {highNullColumns.length} column(s) above {NULL_DENSITY_THRESHOLD}% NULL:{' '}
                          {highNullColumns.map((c) => c.columnName).join(', ')}
                        </div>
                        <button
                          onClick={() => handleAskAgent(ANOMALY_TOOL_MAP.NULL_DENSITY.buildQuestion(selectedUrn!))}
                          className="text-xs bg-gray-900 hover:bg-gray-800 border border-gray-700 text-gray-200 px-2 py-1 rounded transition-colors"
                        >
                          Ask agent
                        </button>
                      </div>
                    )}

                    {piiFields.length > 0 && (
                      <div className="p-3 bg-black border border-amber-900/40 rounded space-y-2">
                        <div className="text-xs font-bold text-amber-300">
                          {ANOMALY_TOOL_MAP.PII_EXPOSURE.label}
                        </div>
                        <div className="text-[11px] text-gray-400">
                          Already shown above — no agent call needed for detection itself.
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleAskAgent(
                              ANOMALY_TOOL_MAP.PII_EXPOSURE.buildQuestion(selectedUrn!, { piiFields })
                            )}
                            className="text-xs bg-gray-900 hover:bg-gray-800 border border-gray-700 text-gray-200 px-2 py-1 rounded transition-colors"
                          >
                            Ask about masking
                          </button>
                          <button
                            onClick={() => handleAskAgent(
                              `Propose a MASK_PII remediation for ${selectedUrn}.`
                            )}
                            className="text-xs bg-amber-950 hover:bg-amber-900 border border-amber-700 text-amber-300 px-2 py-1 rounded transition-colors"
                          >
                            Propose masking fix
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="p-3 bg-black border border-gray-800 rounded space-y-2">
                      <div className="text-xs font-bold text-gray-200">
                        {ANOMALY_TOOL_MAP.RISK_SCORE.label}
                      </div>
                      <div className="text-[11px] text-gray-400">
                        Ask the agent to compute a full risk score for this dataset.
                      </div>
                      <button
                        onClick={() => handleAskAgent(ANOMALY_TOOL_MAP.RISK_SCORE.buildQuestion(selectedUrn!))}
                        className="text-xs bg-gray-900 hover:bg-gray-800 border border-gray-700 text-gray-200 px-2 py-1 rounded transition-colors"
                      >
                        Ask agent
                      </button>
                    </div>

                    {lineage && lineage.stage && (
                      <div className="p-3 bg-black border border-gray-800 rounded space-y-2">
                        <div className="text-xs font-bold text-gray-200">
                          {ANOMALY_TOOL_MAP.LINEAGE_CONTEXT.label}
                        </div>
                        <div className="flex items-center gap-2 text-xs flex-wrap">
                          {lineage.upstream.length > 0 ? (
                            lineage.upstream.map((t) => (
                              <button
                                key={t}
                                onClick={() => handleNavigateToTable(t, selectedDataset!.domain)}
                                className="text-gray-400 hover:text-white hover:underline"
                              >
                                {t}
                              </button>
                            ))
                          ) : (
                            <span className="text-gray-600">no upstream</span>
                          )}
                          <span className="text-gray-600">➔</span>
                          <span className="text-amber-400 font-bold">{detailProfile.tableName}</span>
                          <span className="text-gray-600">➔</span>
                          {lineage.downstream.length > 0 ? (
                            lineage.downstream.map((t) => (
                              <button
                                key={t}
                                onClick={() => handleNavigateToTable(t, selectedDataset!.domain)}
                                className="text-emerald-400 hover:text-white hover:underline"
                              >
                                {t}
                              </button>
                            ))
                          ) : (
                            <span className="text-gray-600">no downstream</span>
                          )}
                        </div>
                        <button
                          onClick={() => handleAskAgent(
                            ANOMALY_TOOL_MAP.LINEAGE_CONTEXT.buildQuestion(selectedUrn!, {
                              upstream: lineage.upstream,
                              downstream: lineage.downstream
                            })
                          )}
                          className="text-xs bg-gray-900 hover:bg-gray-800 border border-gray-700 text-gray-200 px-2 py-1 rounded transition-colors"
                        >
                          Ask agent
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {activeModal && (
        <KPIModal
          kind={activeModal}
          onClose={() => setActiveModal(null)}
          datasetStatusCounts={datasetStatusCounts}
          piiSeverityBreakdown={governanceSummary?.piiSeverityBreakdown ?? { HIGH: 0, MEDIUM: 0, LOW: 0 }}
          riskLevelBreakdown={governanceSummary?.riskLevelBreakdown ?? { CRITICAL: 0, WARNING: 0, SAFE: 0 }}
          avgRiskScore={governanceSummary?.avgRiskScore ?? 0}
        />
      )}

      <ChatWidget
        groqApiKey={GROQ_API_KEY}
        presetQuery={chatPresetQuery}
        presetTrigger={chatPresetTrigger}
        onRemediationApplied={refreshGovernanceData}
      />
    </div>
  );
}
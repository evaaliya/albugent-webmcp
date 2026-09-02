// src/components/KPIModal.tsx

// ============================================================
// PURPOSE
// ============================================================
// Lightweight, dependency-free charts (no recharts/d3 needed) shown
// when a user clicks a top KPI card. Bar charts are plain divs; the
// risk donut uses a CSS conic-gradient, matching the donut style in
// the design reference.
// ============================================================

import React from 'react';

export type KPIModalKind = 'datasets' | 'pii' | 'risk';

interface KPIModalProps {
  kind: KPIModalKind;
  onClose: () => void;
  datasetStatusCounts: { Healthy: number; Warning: number; Critical: number };
  piiSeverityBreakdown: { HIGH: number; MEDIUM: number; LOW: number };
  riskLevelBreakdown: { CRITICAL: number; WARNING: number; SAFE: number };
  avgRiskScore: number; // 0-1
}

// ------------------------------------------------------------
// Simple horizontal bar chart
// ------------------------------------------------------------
function BarChart({ data }: { data: { label: string; value: number; color: string }[] }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="space-y-3">
      {data.map((d) => (
        <div key={d.label}>
          <div className="flex justify-between text-xs text-gray-300 mb-1">
            <span>{d.label}</span>
            <span className="font-bold">{d.value}</span>
          </div>
          <div className="h-3 bg-gray-900 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${(d.value / max) * 100}%`, backgroundColor: d.color }}
            ></div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------
// Donut chart via CSS conic-gradient — no SVG library needed
// ------------------------------------------------------------
function DonutChart({
  segments,
  centerLabel,
  centerValue
}: {
  segments: { label: string; value: number; color: string }[];
  centerLabel: string;
  centerValue: string;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;
  let cursor = 0;
  const stops = segments.map((s) => {
    const start = (cursor / total) * 360;
    cursor += s.value;
    const end = (cursor / total) * 360;
    return `${s.color} ${start}deg ${end}deg`;
  });

  return (
    <div className="flex items-center gap-6">
      <div
        className="relative w-36 h-36 rounded-full shrink-0"
        style={{ background: `conic-gradient(${stops.join(', ')})` }}
      >
        <div className="absolute inset-3 rounded-full bg-[#0a0a0f] flex flex-col items-center justify-center">
          <span className="text-xl font-bold text-white">{centerValue}</span>
          <span className="text-[10px] text-gray-500">{centerLabel}</span>
        </div>
      </div>
      <div className="space-y-2">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }}></span>
            <span className="text-gray-300">{s.label}</span>
            <span className="text-gray-500">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function KPIModal({
  kind,
  onClose,
  datasetStatusCounts,
  piiSeverityBreakdown,
  riskLevelBreakdown,
  avgRiskScore
}: KPIModalProps) {
  const titles: Record<KPIModalKind, string> = {
    datasets: 'Datasets by Status',
    pii: 'PII Fields by Severity',
    risk: 'Risk Level Distribution'
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-[#0a0a0f] border border-gray-800 rounded-lg p-6 w-full max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider">{titles[kind]}</h3>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-200 rounded"
          >
            ×
          </button>
        </div>

        {kind === 'datasets' && (
          <BarChart
            data={[
              { label: 'Healthy', value: datasetStatusCounts.Healthy, color: '#34d399' },
              { label: 'Warning', value: datasetStatusCounts.Warning, color: '#fbbf24' },
              { label: 'Critical', value: datasetStatusCounts.Critical, color: '#f87171' }
            ]}
          />
        )}

        {kind === 'pii' && (
          <BarChart
            data={[
              { label: 'High severity', value: piiSeverityBreakdown.HIGH, color: '#f87171' },
              { label: 'Medium severity', value: piiSeverityBreakdown.MEDIUM, color: '#fbbf24' },
              { label: 'Low severity', value: piiSeverityBreakdown.LOW, color: '#60a5fa' }
            ]}
          />
        )}

        {kind === 'risk' && (
          <DonutChart
            centerLabel="Avg Score"
            centerValue={avgRiskScore.toFixed(2)}
            segments={[
              { label: 'Critical', value: riskLevelBreakdown.CRITICAL, color: '#f87171' },
              { label: 'Warning', value: riskLevelBreakdown.WARNING, color: '#fbbf24' },
              { label: 'Safe', value: riskLevelBreakdown.SAFE, color: '#34d399' }
            ]}
          />
        )}
      </div>
    </div>
  );
}
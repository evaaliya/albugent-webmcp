// src/components/AnomalyIcons.tsx

// ============================================================
// PURPOSE
// ============================================================
// Per-anomaly-type warning icons, shown next to each dataset in the
// list. Unlike the aggregate risk score (which blends PII + NULL
// density + other factors into one number), these icons are driven
// by raw boolean facts — PII presence in particular is ALWAYS shown
// if even one PII column exists, regardless of how it affects the
// blended risk score. Compliance exposure doesn't average away.
// ============================================================

import React from 'react';

interface AnomalyIconsProps {
  hasPII: boolean;
  piiMaxSeverity: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  hasHighNull: boolean;
}

function ShieldIcon({ className }: { className: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2L4 5v6c0 5 3.5 9.7 8 11 4.5-1.3 8-6 8-11V5l-8-3zm0 2.2l6 2.25v4.55c0 4.02-2.76 7.83-6 8.9-3.24-1.07-6-4.88-6-8.9V6.45l6-2.25z" />
    </svg>
  );
}

function NullIcon({ className }: { className: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2L1 21h22L12 2zm0 6.5L18.5 19h-13L12 8.5zM11 12v4h2v-4h-2zm0 5.5v2h2v-2h-2z" />
    </svg>
  );
}

export default function AnomalyIcons({ hasPII, piiMaxSeverity, hasHighNull }: AnomalyIconsProps) {
  if (!hasPII && !hasHighNull) return null;

  const piiColor =
    piiMaxSeverity === 'HIGH' ? 'text-red-400' :
    piiMaxSeverity === 'MEDIUM' ? 'text-amber-400' :
    'text-sky-400';

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {hasPII && (
        <span
          title={`PII exposure detected (${piiMaxSeverity} severity). Shown regardless of overall risk score — presence of PII is a compliance concern on its own.`}
        >
          <ShieldIcon className={piiColor} />
        </span>
      )}
      {hasHighNull && (
        <span title="High NULL density detected in one or more columns.">
          <NullIcon className="text-orange-400" />
        </span>
      )}
    </div>
  );
}
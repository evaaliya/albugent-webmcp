// src/components/ChatWidget.tsx

// ============================================================
// PURPOSE
// ============================================================
// Floating chat widget. Now also detects when a tool result contains a
// pending remediation proposal (from propose_remediation) and renders
// inline Approve/Reject buttons directly under that turn — the whole
// propose -> approve -> apply cycle can happen without leaving the chat.
// ============================================================

import React, { useState, useEffect, useRef } from 'react';
import { runAgentCycle } from '../engine/agentService';
import { callWorker } from '../engine/workerClient';
import { subscribeToProposals, getProposal, markApproved, removeProposal, type RemediationProposal } from '../webmcp/proposalStore';

interface LogEntry {
  sender: string;
  text: string;
}

interface ChatTurn {
  id: number;
  userText: string;
  trace: LogEntry[];
  agentText?: string;
  isError?: boolean;
  pendingProposalId: string | null;
}

interface ChatWidgetProps {
  groqApiKey: string;
  presetQuery: string;
  presetTrigger: number;
  onRemediationApplied?: () => void;
}

type PanelState = 'closed' | 'minimized' | 'open';
type ProposalOutcome = 'applying' | 'approved' | 'rejected' | 'error';

// ============================================================
// SECTION: Log grouping
// ============================================================
function extractProposalId(trace: LogEntry[]): string | null {
  for (const t of trace) {
    if (t.sender !== 'TOOL_RESULT') continue;
    try {
      const parsed = JSON.parse(t.text);
      if (parsed && typeof parsed.proposalId === 'string' && parsed.status === 'PENDING_HUMAN_APPROVAL') {
        return parsed.proposalId;
      }
    } catch {
      // not JSON, ignore
    }
  }
  return null;
}

function groupLogsIntoTurns(logs: LogEntry[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let current: ChatTurn | null = null;

  for (const log of logs) {
    if (log.sender === 'USER') {
      current = { id: turns.length, userText: log.text, trace: [], pendingProposalId: null };
      turns.push(current);
      continue;
    }
    if (!current) continue;

    if (log.sender === 'ALBUGENT_CORE_AGENT_01') {
      current.agentText = log.text;
    } else if (log.sender === 'SYSTEM_ERROR') {
      current.agentText = log.text;
      current.isError = true;
    } else {
      current.trace.push(log);
    }
  }

  for (const turn of turns) {
    turn.pendingProposalId = extractProposalId(turn.trace);
  }

  return turns;
}

// ============================================================
// SECTION: Tiny markdown renderer (unchanged from before)
// ============================================================
function renderInlineBold(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${keyPrefix}-b-${i}`} className="text-white font-bold">{part.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={`${keyPrefix}-t-${i}`}>{part}</React.Fragment>;
  });
}

function isTableSeparatorRow(line: string): boolean {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(line.trim());
}

function renderMarkdown(text: string): React.ReactNode {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
      const headerCells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        const cells = lines[j].split('|').map((c) => c.trim()).filter((c) => c.length > 0);
        if (cells.length > 0) rows.push(cells);
        j++;
      }
      blocks.push(
        <table key={`tbl-${blockKey++}`} className="w-full text-[11px] border-collapse my-2">
          <thead>
            <tr>
              {headerCells.map((h, hi) => (
                <th key={hi} className="border border-gray-800 bg-gray-900 px-2 py-1 text-left text-gray-300">
                  {renderInlineBold(h, `th-${hi}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci} className="border border-gray-800 px-2 py-1 text-gray-300 align-top">
                    {renderInlineBold(c, `td-${ri}-${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
      i = j;
      continue;
    }

    if (/^[-*]\s+/.test(line.trim())) {
      const items: string[] = [];
      let j = i;
      while (j < lines.length && /^[-*]\s+/.test(lines[j].trim())) {
        items.push(lines[j].trim().replace(/^[-*]\s+/, ''));
        j++;
      }
      blocks.push(
        <ul key={`ul-${blockKey++}`} className="list-disc list-inside my-1 space-y-0.5">
          {items.map((it, ii) => (
            <li key={ii}>{renderInlineBold(it, `li-${ii}`)}</li>
          ))}
        </ul>
      );
      i = j;
      continue;
    }

    if (line.trim().length === 0) {
      i++;
      continue;
    }
    blocks.push(
      <p key={`p-${blockKey++}`} className="my-1">
        {renderInlineBold(line, `p-${blockKey}`)}
      </p>
    );
    i++;
  }

  return <>{blocks}</>;
}

export default function ChatWidget({ groqApiKey, presetQuery, presetTrigger, onRemediationApplied }: ChatWidgetProps) {
  const [panelState, setPanelState] = useState<PanelState>('closed');
  const [inputValue, setInputValue] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [expandedTrace, setExpandedTrace] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Live view of the proposal store — tells us whether a proposal
  // referenced in a chat turn is still pending.
  const [liveProposals, setLiveProposals] = useState<RemediationProposal[]>([]);
  // Final outcome per proposalId, once the human acts on it in this chat.
  const [proposalOutcomes, setProposalOutcomes] = useState<Record<string, ProposalOutcome>>({});

  useEffect(() => {
    const unsubscribe = subscribeToProposals(setLiveProposals);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (presetTrigger > 0) {
      setPanelState('open');
      setInputValue(presetQuery);
    }
  }, [presetTrigger]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [logs, isSending, panelState, proposalOutcomes]);

  const turns = groupLogsIntoTurns(logs);

  const toggleTrace = (id: number) => {
    setExpandedTrace((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSend = async () => {
    const text = inputValue.trim();
    if (!text || isSending) return;

    if (!groqApiKey) {
      setLogs((prev) => [
        ...prev,
        { sender: 'USER', text },
        { sender: 'SYSTEM_ERROR', text: 'Groq API Key not found! Check VITE_GROQ_API_KEY in your .env file.' }
      ]);
      setInputValue('');
      return;
    }

    setInputValue('');
    setIsSending(true);
    await runAgentCycle(text, groqApiKey, (log) => {
      setLogs((prev) => [...prev, log]);
    });
    setIsSending(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSend();
  };

  // ------------------------------------------------------------
  // Inline proposal actions — the whole propose/approve/apply cycle
  // can now happen without leaving the chat panel.
  // ------------------------------------------------------------
  const handleApproveInChat = async (proposalId: string) => {
    const proposal = getProposal(proposalId);
    if (!proposal) return;

    setProposalOutcomes((prev) => ({ ...prev, [proposalId]: 'applying' }));
    markApproved(proposalId);

    try {
      await callWorker('APPLY_REMEDIATION', { urn: proposal.datasetUrn, sql: proposal.sqlSnippet });
      removeProposal(proposalId);
      setProposalOutcomes((prev) => ({ ...prev, [proposalId]: 'approved' }));
      onRemediationApplied?.();
    } catch (err: any) {
      setProposalOutcomes((prev) => ({ ...prev, [proposalId]: 'error' }));
      setLogs((prev) => [...prev, { sender: 'SYSTEM_ERROR', text: `Failed to apply remediation: ${err.message}` }]);
    }
  };

  const handleRejectInChat = (proposalId: string) => {
    removeProposal(proposalId);
    setProposalOutcomes((prev) => ({ ...prev, [proposalId]: 'rejected' }));
  };

  // ------------------------------------------------------------
  // STATE: closed
  // ------------------------------------------------------------
  if (panelState === 'closed') {
    return (
      <button
        onClick={() => setPanelState('open')}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg flex items-center justify-center text-xl font-bold transition-colors"
        aria-label="Open governance agent chat"
      >
        ⌘
      </button>
    );
  }

  // ------------------------------------------------------------
  // STATE: minimized
  // ------------------------------------------------------------
  if (panelState === 'minimized') {
    return (
      <button
        onClick={() => setPanelState('open')}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 bg-[#0a0a0f] border border-gray-800 rounded-full px-4 py-2.5 shadow-lg hover:border-gray-700 transition-colors"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
        <span className="text-xs text-gray-200 font-medium">Governance Agent</span>
      </button>
    );
  }

  // ------------------------------------------------------------
  // STATE: open — panel enlarged per user request (was 380x560)
  // ------------------------------------------------------------
  return (
    <div className="fixed bottom-6 right-6 z-50 w-[520px] max-w-[calc(100vw-2rem)] h-[min(760px,calc(100vh-3rem))] bg-[#0a0a0f] border border-gray-800 rounded-lg shadow-2xl flex flex-col overflow-hidden">

      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
          <span className="text-sm font-bold text-white">Governance Agent</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPanelState('minimized')}
            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-200 rounded transition-colors"
            aria-label="Minimize"
            title="Minimize"
          >
            −
          </button>
          <button
            onClick={() => setPanelState('closed')}
            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-200 rounded transition-colors"
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-4">
        {turns.length === 0 && (
          <div className="text-xs text-gray-600 text-center mt-8">
            Ask about a dataset, or click "Ask agent" on any anomaly card.
          </div>
        )}

        {turns.map((turn) => {
          const outcome = turn.pendingProposalId ? proposalOutcomes[turn.pendingProposalId] : undefined;
          const isStillPending = turn.pendingProposalId
            ? liveProposals.some((p) => p.proposalId === turn.pendingProposalId)
            : false;

          return (
            <div key={turn.id} className="space-y-2">
              <div className="flex justify-end">
                <div className="max-w-[85%] bg-emerald-900/40 border border-emerald-800 text-emerald-100 text-xs rounded-lg px-3 py-2 break-words">
                  {turn.userText}
                </div>
              </div>

              {turn.trace.length > 0 && (
                <div className="flex justify-start">
                  <button
                    onClick={() => toggleTrace(turn.id)}
                    className="text-[10px] text-gray-500 hover:text-gray-300 underline"
                  >
                    {expandedTrace.has(turn.id) ? 'Hide tool trace' : `Show tool trace (${turn.trace.length})`}
                  </button>
                </div>
              )}
              {expandedTrace.has(turn.id) && (
                <div className="bg-black border border-gray-900 rounded p-2 space-y-1 max-h-40 overflow-y-auto overflow-x-hidden">
                  {turn.trace.map((t, i) => (
                    <div key={i} className="text-[10px] font-mono text-gray-500 whitespace-pre-wrap break-words">
                      <span className="text-gray-600">[{t.sender}]</span> {t.text}
                    </div>
                  ))}
                </div>
              )}

              {turn.agentText && (
                <div className="flex justify-start">
                  <div className={`max-w-[90%] text-xs rounded-lg px-3 py-2 break-words overflow-x-auto ${
                    turn.isError
                      ? 'bg-red-950/40 border border-red-900 text-red-300'
                      : 'bg-gray-900 border border-gray-800 text-gray-200'
                  }`}>
                    {turn.isError ? turn.agentText : renderMarkdown(turn.agentText)}
                  </div>
                </div>
              )}

              {/* --- Inline proposal approve/reject — the core UX ask --- */}
              {turn.pendingProposalId && (
                <div className="flex justify-start">
                  {outcome === 'approved' && (
                    <div className="text-xs text-emerald-400">✓ Applied to the database.</div>
                  )}
                  {outcome === 'rejected' && (
                    <div className="text-xs text-gray-500">Rejected — no changes made.</div>
                  )}
                  {outcome === 'error' && (
                    <div className="text-xs text-red-400">✗ Failed to apply — see message above.</div>
                  )}
                  {outcome === 'applying' && (
                    <div className="text-xs text-gray-500 italic">Applying...</div>
                  )}
                  {!outcome && isStillPending && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleApproveInChat(turn.pendingProposalId!)}
                        className="text-xs bg-emerald-950 hover:bg-emerald-900 border border-emerald-700 text-emerald-300 px-3 py-1 rounded font-bold transition-colors"
                      >
                        APPROVE
                      </button>
                      <button
                        onClick={() => handleRejectInChat(turn.pendingProposalId!)}
                        className="text-xs bg-red-950 hover:bg-red-900 border border-red-700 text-red-300 px-3 py-1 rounded font-bold transition-colors"
                      >
                        REJECT
                      </button>
                    </div>
                  )}
                  {!outcome && !isStillPending && (
                    <div className="text-xs text-gray-600">Handled outside this chat.</div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {isSending && (
          <div className="flex justify-start">
            <div className="text-xs text-gray-500 italic">Agent is thinking...</div>
          </div>
        )}
      </div>

      <div className="p-3 border-t border-gray-800 flex gap-2 shrink-0">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask the governance agent..."
          className="flex-1 min-w-0 bg-black border border-gray-800 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-gray-600"
        />
        <button
          onClick={handleSend}
          disabled={isSending}
          className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs rounded shrink-0"
        >
          Send
        </button>
      </div>
    </div>
  );
}
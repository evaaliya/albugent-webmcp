// src/webmcp/proposalStore.ts

// ============================================================
// PURPOSE
// ============================================================
// registerGovernanceTools() runs in main.tsx BEFORE React even renders
// <App/>, so there's no component state to hand it a setState callback
// into. This tiny pub/sub store is the single source of truth for
// pending remediation proposals — toolRegistry.ts writes to it when
// propose_remediation/apply_remediation run, and App.tsx subscribes to
// it in a useEffect to mirror it into UI state.
// ============================================================

export interface RemediationProposal {
    proposalId: string;
    datasetUrn: string;
    actionType: 'MASK_PII' | 'REMEDIATE_NULLS' | 'CIRCUIT_BREAK';
    description: string;
    sqlSnippet: string;
    approved: boolean;
  }
  
  type Listener = (proposals: RemediationProposal[]) => void;
  
  const proposals = new Map<string, RemediationProposal>();
  const listeners = new Set<Listener>();
  
  function notify() {
    const list = Array.from(proposals.values());
    listeners.forEach((l) => l(list));
  }
  
  export function addProposal(p: RemediationProposal) {
    proposals.set(p.proposalId, p);
    notify();
  }
  
  export function getProposal(id: string): RemediationProposal | undefined {
    return proposals.get(id);
  }
  
  export function markApproved(id: string) {
    const p = proposals.get(id);
    if (p) {
      p.approved = true;
      notify();
    }
  }
  
  export function removeProposal(id: string) {
    proposals.delete(id);
    notify();
  }
  
  // Called from App.tsx: useEffect(() => subscribeToProposals(setProposals), [])
  export function subscribeToProposals(listener: Listener): () => void {
    listeners.add(listener);
    listener(Array.from(proposals.values())); // fire immediately with current state
    return () => listeners.delete(listener);
  }
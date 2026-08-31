// src/engine/workerClient.ts

// ============================================================
// SECTION: Worker instance
// ============================================================
const worker = new Worker(
  new URL('./worker/sqlite.worker.ts', import.meta.url),
  { type: 'module' }
);

// ============================================================
// SECTION: Constants
// ============================================================
// Safety net: if the worker never replies (e.g. an unhandled message type,
// or a genuinely stuck query), callWorker must fail loudly instead of
// hanging the whole agent cycle silently forever.
const WORKER_TIMEOUT_MS = 8000;

// ============================================================
// SECTION: Pending request tracking
// ============================================================
interface PendingRequest {
  resolve: (val: any) => void;
  reject: (err: any) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();

// ============================================================
// SECTION: Message handler — resolves/rejects the matching promise
// ============================================================
worker.onmessage = (event: MessageEvent) => {
  const { id, success, data, error } = event.data;
  const pending = pendingRequests.get(id);
  if (!pending) return; // already timed out and cleaned up, or unknown id

  clearTimeout(pending.timeoutId);
  pendingRequests.delete(id);

  if (success) {
    pending.resolve(data);
  } else {
    pending.reject(new Error(error || 'Worker execution failed'));
  }
};

// ============================================================
// SECTION: Public API
// ============================================================
export function callWorker(type: string, payload?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).substring(2, 9);

    // If the worker never answers this id within WORKER_TIMEOUT_MS,
    // reject with a clear, actionable error instead of hanging forever.
    const timeoutId = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(
          new Error(
            `Worker timeout after ${WORKER_TIMEOUT_MS}ms for message type "${type}". ` +
            `This usually means sqlite.worker.ts has no matching handler for this type.`
          )
        );
      }
    }, WORKER_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timeoutId });
    worker.postMessage({ id, type, payload });
  });
}
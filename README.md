# Albugent WebMCP

**Deterministic data governance for a browser-native, human + agent workflow — built for the WebMCP Challenge.**

Albugent is a client-side data governance dashboard that discovers, profiles, and audits tables across three simulated enterprise domains (healthcare, fiction-retail, and an NYC taxi data pipeline), stored as SQLite files and loaded entirely in-browser via SQLite WASM. A person sees a live dashboard. An AI agent, through WebMCP tools registered directly on the page, can inspect the exact same computed data and — with explicit human approval — propose and apply real remediations, such as masking detected PII columns.

No backend server. No data leaves the browser. The agent never computes anything itself — it only reads results a deterministic engine already produced.

---

## Why WebMCP, specifically

The core idea this project tests: instead of an agent scraping a dashboard's UI and guessing what a button does, the dashboard and the agent read from **one shared, typed computation layer**. `document.modelContext.registerTool` lets the page expose that layer directly, so:

- The agent's tool results are the same JSON the dashboard renders — there is exactly one source of truth for every number on screen, whether a person or an LLM is looking at it.
- Tool calls execute instantly, client-side, with no network round trip to a remote MCP server.
- The agent can only act within the exact boundaries the page author defined — it cannot invent an action, and every state-changing action (masking data) requires an explicit human approval step surfaced inline in the chat.

## Architecture

```
src/
  engine/
    worker/
      sqlite.worker.ts       # Owns all in-memory SQLite DB connections. Never sends raw
                              # rows anywhere except for human-facing detail views.
    profilers/
      anomalyProfiler.ts      # Deterministic NULL-density / column stats
      piiDetector.ts          # Pattern-based PII/PHI column classification
      riskEvaluator.ts        # Single shared risk-scoring formula
    workerClient.ts           # postMessage RPC wrapper with request timeouts
    agentService.ts           # Groq tool-calling loop (max 1 tool call/turn)
    lineageHeuristics.ts       # Client-side, naming-convention-based lineage inference
  webmcp/
    toolRegistry.ts            # Registers all WebMCP tools via document.modelContext
    proposalStore.ts           # Pub/sub store bridging tool calls (in main.tsx, pre-React)
                                # and React UI state (in App.tsx / ChatWidget.tsx)
    anomalyToolMap.ts           # Anomaly type -> relevant tool(s) -> pre-filled question text
  components/
    ChatWidget.tsx              # Floating chat; collapsible tool trace; inline
                                 # Approve/Reject buttons for pending proposals
    KPIModal.tsx                 # Dependency-free bar/donut charts for KPI drill-down
    AnomalyIcons.tsx              # Always-visible PII/NULL compliance icons
  App.tsx
  main.tsx
```

## Deterministic core vs. agent — the design rule

This project was built as a direct correction to a real failure mode observed in an earlier, unrelated hackathon project: an autonomous agent chaining dozens of tool calls and trying to synthesize one giant report at the end, which produced constant hallucinations.

The rule enforced throughout this codebase:

> All computation — anomaly detection, PII scanning, risk scoring, remediation SQL generation — happens in deterministic TypeScript inside the Web Worker. The agent never computes anything; it only reads results and talks about them.

Concretely:
- The agent may call **at most one tool per user message.** The finalizing completion request is made with no `tools` key in the request body at all, so the model structurally cannot re-attempt a tool call, regardless of what it saw earlier in the same turn (see *Known issues fixed* below for why a `tool_choice: 'none'` parameter alone was not sufficient).
- Every tool is scoped to either one dataset URN or a small, explicitly pre-filtered list (e.g. currently-halted datasets) — never "return everything about every table."
- Tool output is truncated to a fixed character budget before being sent back to the model, and the model's own completion is capped at a fixed token budget, so a single conversation turn cannot exhaust the API rate limit.

## WebMCP tools registered

| Tool | Scope | Returns |
|---|---|---|
| `list_available_datasets` | all datasets | URN + domain + table name only — small, bounded |
| `inspect_dataset_schema` | one URN | Column names, types, nullability |
| `profile_dataset` | one URN | NULL-density / uniqueness profile per column |
| `assess_risk` | one URN | Computed risk score (0–100), risk level, PII fields, contributing factors |
| `inspect_lineage` | one URN | Upstream/downstream tables, inferred from naming convention (`raw_` → `staging_` → `mart_`, with a parallel `cleaned_` variant) |
| `propose_remediation` | one URN + action type | Re-checks the dataset's real risk score before creating anything; refuses (with real numbers) if risk is low, unless `force: true` is explicitly requested |
| `apply_remediation` | one proposal ID | Executes the approved proposal's SQL against the in-memory database; refuses if the human has not approved it |

`ANOMALY_TOOL_MAP` (in `src/webmcp/anomalyToolMap.ts`) is the single place mapping each anomaly type to its relevant tool(s) and a pre-filled (human-editable) question that names the tool and the real data explicitly — this is what keeps the agent from guessing at "which columns were flagged" instead of being told outright.

## Privacy / trust boundary

Raw row data (`SELECT * FROM table`) is read inside the Web Worker for two purposes only:
1. To compute an aggregated, human-facing profile (NULL rates, uniqueness) — the rows themselves never leave the worker.
2. To render the human-facing "Column Profile" view directly in the dashboard UI — a person looking at their own data on their own screen.

Anything a WebMCP tool returns to the agent is always an aggregate or a small, explicit list (column names, a risk score, an SQL snippet a human must approve) — never raw row contents.

## Human-in-the-loop remediation flow

1. A person clicks **"Propose masking fix"** next to a table with detected PII. This pre-fills (but does not send) a chat message naming the real dataset URN — no manual copy-pasting of identifiers.
2. The agent calls `propose_remediation`. The tool independently re-evaluates the dataset's real risk score. If risk is low, it explains why in plain terms and offers to proceed only with explicit `force=true` confirmation from the human.
3. If a proposal is created, **Approve / Reject buttons render inline, directly under that message in the chat** — not hidden in a separate silent panel.
4. Approving executes the actual `UPDATE` statement (built dynamically from the real PII columns detected for that specific table — never a hardcoded column name) against the in-memory SQLite database, then refreshes the dashboard's KPIs and per-table status live.

## Running locally

```bash
npm install
npm run dev
```

Create a `.env` file with:

```
VITE_GROQ_API_KEY=your_groq_api_key
```

Open the printed `localhost` URL in Chrome with `chrome://flags/#enable-webmcp-testing` enabled, or in ChatGPT's in-app browser (WebMCP support built in).

## Known issues fixed during development (kept here for transparency)

- **Worker MIME-type / 404 masquerading as HTML.** Vite's SPA fallback served `index.html` for a mistyped worker path and a mistyped database path, producing confusing `non-JavaScript MIME type` and `SQLITE_NOTADB` errors instead of a clean 404.
- **`tool_choice: 'none'` was not a hard guarantee.** The model sometimes still attempted a tool call after seeing itself call one earlier in the same turn, and Groq rejected the whole request rather than ignoring the attempt. The real fix: the finalizing request is made with no `tools` key present at all.
- **A hardcoded masking column (`email`).** An early version of `propose_remediation` always generated `SET email = ...` regardless of the target table's actual schema, failing on any table without that column. Fixed by having the tool query the real PII columns for that specific dataset before building SQL.
- **An LLM fabricating a nonexistent internal mechanism.** Asked why it had applied a remediation, the agent invented a plausible-sounding "risk-assessment engine" that does not exist in the code. Fixed by having `propose_remediation` genuinely evaluate risk before acting, and by explicitly instructing the agent never to invent explanations for behavior it has no real record of.
- **PII detection under-covering healthcare data.** The original pattern set missed most HIPAA-relevant quasi-identifiers (`medical_condition`, `hospital`, `blood_type`, etc.), letting a table full of protected health information score as low-risk. Detection was expanded, and PII presence is now surfaced as an independent, always-visible icon rather than only folded into the blended numeric score.

## What's next

- Numeric-outlier and date-logic anomaly detectors (today: NULL-density and PII/PHI only).
- A real column-level lineage graph, replacing the current naming-convention heuristic.
- `REMEDIATE_NULLS` and `CIRCUIT_BREAK` action types generating real SQL (currently placeholders — only `MASK_PII` is fully implemented).
- Multi-candidate tool routing per anomaly type as more detectors are added, with the agent choosing between candidates via `tool_choice: 'auto'` rather than the app restricting it programmatically.

## License

See `LICENSE`.
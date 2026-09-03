# Albugent WebMCP

**Deterministic data governance for a browser-native, human + agent workflow — built for the WebMCP Challenge.**

Albugent is a client-side data governance dashboard that discovers, profiles, and audits tables across three simulated enterprise domains (healthcare, fiction-retail, and an NYC taxi data pipeline), stored as SQLite files and loaded entirely in-browser via SQLite WASM. A person sees a live dashboard. An AI agent, through WebMCP tools registered directly on the page, can inspect the exact same computed data and — with explicit human approval — propose and apply real remediations, such as masking detected PII columns.

No backend server. No data leaves the browser. Every state-changing action requires an explicit human approval step surfaced inline in chat.

---

## Why WebMCP, specifically

The core idea this project tests: instead of an agent scraping a dashboard's UI and guessing what a button does, the dashboard and the agent read from **one shared, typed computation layer**. `document.modelContext.registerTool` lets the page expose that layer directly, so:

- The agent's tool results are the same JSON the dashboard renders — there is exactly one source of truth for every number on screen, whether a person or an LLM is looking at it.
- Tool calls execute instantly, client-side, with no network round trip to a remote MCP server.
- The agent can only act within the exact boundaries the page author defined — it cannot invent an action, and every state-changing action requires explicit human approval.

## The agent's real role — what it decides vs. what the engine computes

The agent makes real decisions: it chooses which tool to call, forms the call's arguments, and reasons about the result — including pushing back on a human's request when a tool's deterministic evaluation says an action isn't justified (see `propose_remediation` below). What the agent does **not** do is the arithmetic itself: risk scores, PII column detection, blast-radius severity, and the exact SQL text are always computed by deterministic TypeScript in the Web Worker, and only executed after the agent has walked the human through an explicit approval step.

The split is: **the agent decides and explains; the engine computes and executes.**

## Architecture

This tree reflects what's actually wired in and imported 

```
src/
  engine/
    worker/
      sqlite.worker.ts        # Owns all in-memory SQLite DB connections. Never sends raw
                               # rows anywhere except for human-facing detail views.
    profilers/
      anomalyProfiler.ts       # Deterministic NULL-density / column stats
      piiDetector.ts           # Pattern-based PII/PHI column classification
      riskEvaluator.ts         # Single shared risk-scoring formula
      lineageEngine.ts          # calculateBlastRadius(): scores how many other tables
                                 # would be affected by changing a given table. Wired
                                 # into the inspect_lineage tool.
    workerClient.ts             # postMessage RPC wrapper with request timeouts
    agentService.ts             # Groq tool-calling loop (max 1 tool call/turn)
    lineageHeuristics.ts         # Client-side, naming-convention-based lineage inference
                                  # (raw_ -> staging_ -> mart_, plus a parallel cleaned_ variant)
  webmcp/
    toolRegistry.ts              # Registers all WebMCP tools via document.modelContext
    proposalStore.ts             # Pub/sub store bridging tool calls (registered in main.tsx,
                                  # before React mounts) and React UI state (App.tsx / ChatWidget.tsx)
    anomalyToolMap.ts             # Anomaly type -> relevant tool(s) -> pre-filled question text
    polyfill.ts                   # WebMCP polyfill, imported in main.tsx, for browsers/agents
                                   # without native document.modelContext support
  components/
    ChatWidget.tsx                # Floating chat; collapsible tool trace; inline
                                   # Approve/Reject buttons for pending proposals
    KPIModal.tsx                   # Dependency-free bar/donut charts for KPI drill-down
    AnomalyIcons.tsx                # Always-visible PII/NULL compliance icons
  App.tsx
  main.tsx

public/
  datasets/
    healthcare.db                 # Trimmed to ~2,000 rows/table for a fast production deploy
    fiction-retail.db
    nyc_taxi_pipeline.db
```



## Deterministic core vs. agent — the design rule

This project was built as a direct correction to a real failure mode observed in an earlier, unrelated hackathon project: an autonomous agent chaining dozens of tool calls and trying to synthesize one giant report at the end, which produced constant hallucinations.

The rule enforced throughout this codebase:

> All computation — anomaly detection, PII scanning, risk scoring, blast-radius severity, remediation SQL generation — happens in deterministic TypeScript inside the Web Worker. The agent never computes anything; it decides, explains, and asks — it does not calculate.

Concretely:
- The agent may call **at most one tool per user message.** The finalizing completion request is made with no `tools` key in the request body at all, so the model structurally cannot re-attempt a tool call, regardless of what it saw earlier in the same turn (see *Known issues fixed* below for why a `tool_choice: 'none'` parameter alone was not sufficient).
- Every tool is scoped to either one dataset URN or a small, explicitly pre-filtered list — never "return everything about every table."
- Tool output is truncated to a fixed character budget before being sent back to the model, and the model's own completion is capped at a fixed token budget, so a single conversation turn cannot exhaust the API rate limit.
- Read-only tools carry `readOnlyHint: true` (per [Chrome's WebMCP tool-security guidance](https://developer.chrome.com/docs/ai/webmcp/secure-tools)), so an agent implementation can use that signal to decide when a confirmation step is actually necessary.

## WebMCP tools registered

| Tool | Scope | Read-only? | Returns |
|---|---|---|---|
| `list_available_datasets` | all datasets | yes | URN + domain + table name only — small, bounded |
| `inspect_dataset_schema` | one URN | yes | Column names, types, nullability |
| `profile_dataset` | one URN | yes | NULL-density / uniqueness profile per column |
| `assess_risk` | one URN | yes | Computed risk score (0–100), risk level, PII fields, contributing factors |
| `inspect_lineage` | one URN | yes | Upstream/downstream tables (naming-convention heuristic) **plus** a HIGH/MEDIUM/LOW blast-radius score for how many other tables would be affected by a change |
| `propose_remediation` | one URN + action type | no | Re-checks the dataset's real risk score before creating anything; refuses (with real numbers) if risk is low, unless `force: true` is explicitly requested |
| `apply_remediation` | one proposal ID | no | Executes the approved proposal's SQL against the in-memory database; refuses if the human has not approved it |

`ANOMALY_TOOL_MAP` (in `src/webmcp/anomalyToolMap.ts`) is the single place mapping each anomaly type to its relevant tool(s) and a pre-filled (human-editable) question that names the tool and the real data explicitly — this is what keeps the agent from guessing at "which columns were flagged" instead of being told outright.

**Honesty note on `propose_remediation`'s `actionType`:** the agent genuinely chooses between `MASK_PII`, `REMEDIATE_NULLS`, and `CIRCUIT_BREAK` when forming the tool call — this is a real decision the model makes, not something the app picks for it. However, only `MASK_PII` is fully implemented end-to-end: it looks up the dataset's actual PII columns and builds real, executable SQL. `REMEDIATE_NULLS` and `CIRCUIT_BREAK` are accepted by the schema and will create a proposal, but the generated SQL is currently a placeholder comment, not a working fix.

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
- **A worker-initialization race condition in production.** `main.tsx`'s `INIT` call and `App.tsx`'s independent `SCAN_DATASETS` call on mount could both reach the worker before the SQLite WASM module had finished loading — more likely on a real deployment, where the WASM fetch is slower than on localhost. Fixed with a single shared init promise that every message type awaits first, regardless of arrival order.
- **`tool_choice: 'none'` was not a hard guarantee.** The model sometimes still attempted a tool call after seeing itself call one earlier in the same turn, and Groq rejected the whole request rather than ignoring the attempt. The real fix: the finalizing request is made with no `tools` key present at all.
- **A hardcoded masking column (`email`).** An early version of `propose_remediation` always generated `SET email = ...` regardless of the target table's actual schema, failing on any table without that column. Fixed by having the tool query the real PII columns for that specific dataset before building SQL.
- **An LLM fabricating a nonexistent internal mechanism.** Asked why it had applied a remediation, the agent invented a plausible-sounding "risk-assessment engine" that does not exist in the code. Fixed by having `propose_remediation` genuinely evaluate risk before acting, and by explicitly instructing the agent never to invent explanations for behavior it has no real record of.
- **PII detection under-covering healthcare data.** The original pattern set missed most HIPAA-relevant quasi-identifiers (`medical_condition`, `hospital`, `blood_type`, etc.), letting a table full of protected health information score as low-risk. Detection was expanded, and PII presence is now surfaced as an independent, always-visible icon rather than only folded into the blended numeric score.
- **300MB of source SQLite files made production deploys impractical.** Since every query is already capped at `LIMIT 1000`, the full row counts were never actually used. Datasets were trimmed to ~2,000 rows per table (a few hundred KB–2MB per file), keeping the schema and data shape intact for a fast, reliable deploy.

## Gaps against official WebMCP guidance (not yet implemented)

Reviewed against Chrome's [WebMCP use-cases](https://developer.chrome.com/docs/ai/webmcp/use-cases), tool-security, and build-tools framework documentation. Honestly listing what we did apply, and what we did not get to:

**Since addressed:**
- **`readOnlyHint` / `untrustedContentHint` annotations** are now set on all five read-only tools (`list_available_datasets`, `inspect_dataset_schema`, `profile_dataset`, `assess_risk`, `inspect_lineage`), per the tool-security guidance's recommendation that this signal helps an agent decide when a confirmation step is actually necessary.
- **`inspect_lineage` now also computes a real blast-radius score** (`lineageEngine.ts`'s `calculateBlastRadius` — written earlier in development but never wired into any tool until this pass) on top of the naming-convention heuristic, so a human or agent asking about lineage gets both the inferred pipeline relationships and a HIGH/MEDIUM/LOW severity for how many other tables would be affected by a change.

**Not yet done:**
- **Context-aware recovery guidance in tool error messages.** The build-tools framework recommends errors like *"No flight search results found. Search for flights first."* instead of raw exceptions. Our tools mostly return the raw thrown error message from a failed worker call — functional, but not written to actively guide the agent toward a fix.
- **No structured handling of ambiguous requests.** The framework recommends tools be designed so the agent can ask for missing parameters rather than guess. Our tool schemas require an exact `datasetUrn` string per call; if a user's phrasing is vague ("check the patient table"), the agent has no structured way to ask "which one, exactly?" beyond its own general language ability.
- **No evaluation suite.** The docs recommend eval-driven development — defining expected tool-selection and parameter-extraction outcomes and testing against them, since LLM behavior is probabilistic. All testing here was manual, interactive debugging.
- **No production telemetry loop.** The docs recommend analyzing real interaction logs post-launch to find where agents deviate from expected paths — out of scope for a hackathon build with no real users yet.
- **`REMEDIATE_NULLS` and `CIRCUIT_BREAK` are accepted by the tool schema but not functionally implemented** — the agent can select either as an `actionType` when calling `propose_remediation`, and a proposal will be created, but the generated SQL is a placeholder comment, not a real fix. Only `MASK_PII` performs a real, executable remediation.
- **Tool descriptions were not audited against the recommended character budgets** (500 chars/description, 150/parameter, 30/name). Tool *output* is enforced at a 1.5K character limit (matching the guidance), but description/parameter text length was never explicitly checked.

## What's next

- Numeric-outlier and date-logic anomaly detectors (today: NULL-density and PII/PHI only).
- A real column-level lineage graph, replacing the current naming-convention heuristic with actual foreign-key relationships.
- Real SQL generation for `REMEDIATE_NULLS` and `CIRCUIT_BREAK`, matching what `MASK_PII` already does.
- Context-aware tool error messages and structured clarification requests, per Chrome's build-tools framework.
- A small eval suite for tool-selection and parameter-extraction consistency.
- Multi-candidate tool routing per anomaly type as more detectors are added, with the agent choosing between candidates via `tool_choice: 'auto'` rather than the app restricting it programmatically.

## License

See `LICENSE`.
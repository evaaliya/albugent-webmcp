// src/engine/agentService.ts

// ============================================================
// SECTION: Types
// ============================================================
interface WebMCPTool {
  name: string;
  description: string;
  inputSchema?: any;
  execute: (args: any) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

// ============================================================
// SECTION: Constants
// ============================================================
const MAX_TOOL_ROUNDS = 1;
const TOOL_OUTPUT_CHAR_LIMIT = 1500;
const MAX_COMPLETION_TOKENS = 600;

// ============================================================
// SECTION: Helpers
// ============================================================
function truncateToolResult(text: string): string {
  if (text.length <= TOOL_OUTPUT_CHAR_LIMIT) return text;
  return (
    text.slice(0, TOOL_OUTPUT_CHAR_LIMIT) +
    `\n...[truncated, ${text.length - TOOL_OUTPUT_CHAR_LIMIT} more characters omitted]`
  );
}

async function callGroq(
  groqApiKey: string,
  model: string,
  messages: any[],
  tools: any[],
  toolChoice: 'auto' | 'none'
) {
  const body: any = {
    model,
    messages,
    temperature: 0.1,
    max_tokens: MAX_COMPLETION_TOKENS
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${groqApiKey}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (data.error) {
    const isRateLimit = response.status === 429 || /rate limit/i.test(data.error.message || '');
    if (isRateLimit) {
      throw new Error(`RATE_LIMIT: ${data.error.message}`);
    }
    throw new Error(data.error.message);
  }

  return data;
}

// ============================================================
// SECTION: Main entry point
// ============================================================
export async function runAgentCycle(
  userPrompt: string,
  groqApiKey: string,
  onLog: (log: { sender: string; text: string; proposal?: any }) => void
) {
  onLog({ sender: 'USER', text: userPrompt });

  const modelContext = (document as any).modelContext;
  const registeredTools: WebMCPTool[] = modelContext && modelContext.tools
    ? Array.from(modelContext.tools.values())
    : [];

  const formattedTools = registeredTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema || { type: 'object', properties: {} }
    }
  }));

  // NOTE: sender is WEBMCP_ENGINE (not ALBUGENT_CORE_AGENT_01) — this is internal
  // telemetry, not a conversational reply. Keeping the sender distinct lets the
  // ChatWidget cleanly separate "trace" logs from the actual chat bubble text.
  onLog({
    sender: 'WEBMCP_ENGINE',
    text: `Connecting to Groq LPU Core... Dispatching ${formattedTools.length} WebMCP tools.`
  });

  const selectedModel = 'openai/gpt-oss-120b';

  const messages: any[] = [
    {
      role: 'system',
      content: `You are ALBUGENT, an Enterprise Data Governance AI Agent operating via WebMCP standards inside the browser.
Your job is to help the human navigate and understand governance data that a deterministic backend has already computed. You do not investigate on your own initiative.

STRICT OPERATIONAL RULES:
1. You may call AT MOST ONE tool per user message. After receiving a tool result, you MUST reply in plain text using that result — never request a second tool call in the same turn.
2. If fully answering would need more data, answer with what you have and tell the user exactly what to ask next.
3. Never guess schemas, contents, or scores — report only what a tool actually returned, or facts already given to you in the question.
4. Keep answers concise and focused on what was asked.`
    },
    { role: 'user', content: userPrompt }
  ];

  onLog({ sender: 'WEBMCP_ENGINE', text: `Active Groq Model connected: [${selectedModel}]` });

  let toolRoundsUsed = 0;

  for (let step = 0; step <= MAX_TOOL_ROUNDS; step++) {
    const toolChoice: 'auto' | 'none' = toolRoundsUsed < MAX_TOOL_ROUNDS ? 'auto' : 'none';

    let data;
    try {
      data = await callGroq(groqApiKey, selectedModel, messages, formattedTools, toolChoice);
    } catch (err: any) {
      if (typeof err.message === 'string' && err.message.startsWith('RATE_LIMIT:')) {
        onLog({
          sender: 'SYSTEM_ERROR',
          text: `Groq rate limit reached. Stopped instead of retrying blindly — wait a few seconds and try a narrower question.`
        });
      } else {
        onLog({ sender: 'SYSTEM_ERROR', text: `Agent cycle error: ${err.message}` });
      }
      return;
    }

    const assistantMessage = data.choices[0].message;
    messages.push(assistantMessage);

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0 && toolRoundsUsed < MAX_TOOL_ROUNDS) {
      toolRoundsUsed++;

      for (const call of assistantMessage.tool_calls) {
        const toolName = call.function.name;
        let toolArgs = {};
        try {
          toolArgs = JSON.parse(call.function.arguments || '{}');
        } catch {
          toolArgs = {};
        }

        onLog({
          sender: 'WEBMCP_ENGINE',
          text: `Executing WebMCP tool [${toolName}] with args: ${JSON.stringify(toolArgs)}`
        });

        const targetTool = registeredTools.find((t) => t.name === toolName);
        let toolResultText = '';

        if (targetTool) {
          const result = await targetTool.execute(toolArgs);
          toolResultText =
            result && result.content && result.content[0] && result.content[0].text
              ? result.content[0].text
              : JSON.stringify(result);
        } else {
          toolResultText = `Error: Tool [${toolName}] is not registered.`;
        }

        const truncated = truncateToolResult(toolResultText);
        onLog({ sender: 'TOOL_RESULT', text: truncated });

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: truncated
        });
      }
      continue;
    }

    if (assistantMessage.content) {
      onLog({ sender: 'ALBUGENT_CORE_AGENT_01', text: assistantMessage.content });
    }
    return;
  }
}
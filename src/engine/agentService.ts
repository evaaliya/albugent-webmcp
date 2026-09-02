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

// Bare-bones Groq call. `tools` is optional — when omitted, the request
// body has no function-calling shape at all, so the model structurally
// cannot return tool_calls (unlike tool_choice:'none', which some models
// ignore and Groq then rejects the whole request for).
async function callGroq(
  groqApiKey: string,
  model: string,
  messages: any[],
  tools?: any[]
) {
  const body: any = {
    model,
    messages,
    temperature: 0.0,
    max_tokens: MAX_COMPLETION_TOKENS
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
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

  onLog({
    sender: 'WEBMCP_ENGINE',
    text: `Connecting to Groq LPU Core... Dispatching ${formattedTools.length} WebMCP tools.`
  });

  const selectedModel = 'openai/gpt-oss-120b';

  const systemPrompt = `You are ALBUGENT, an Enterprise Data Governance AI Agent operating via WebMCP standards inside the browser.
  Your job is to help the human navigate and understand governance data that a deterministic backend has already computed.
  
  STRICT OPERATIONAL RULES:
  1. You may call AT MOST ONE tool for this question.
  2. Never guess schemas, contents, or scores — report only what a tool actually returned, or facts already given to you in the question.
  3. Keep answers concise and focused on what was asked.
  4. If a tool result says a proposal was NOT created (status "ADVISORY_NOT_PROPOSED"), relay that assessment honestly to the human and ask whether they want to proceed anyway — do not create the proposal yourself without their confirmation.
  5. NEVER invent explanations for system behavior, internal mechanisms, or "engines" that were not literally described in a tool result. If you don't know why something happened (e.g. a past action you have no record of), say plainly that you don't have that information, instead of fabricating a plausible-sounding technical explanation.`;

  onLog({ sender: 'WEBMCP_ENGINE', text: `Active Groq Model connected: [${selectedModel}]` });

  // --- STEP 1: first call, tools available, model may call at most one ---
  const firstMessages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  let firstData;
  try {
    firstData = await callGroq(groqApiKey, selectedModel, firstMessages, formattedTools);
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

  const firstMessage = firstData.choices[0].message;

  // --- CASE A: model answered directly, no tool needed ---
  if (!firstMessage.tool_calls || firstMessage.tool_calls.length === 0) {
    if (firstMessage.content) {
      onLog({ sender: 'ALBUGENT_CORE_AGENT_01', text: firstMessage.content });
    }
    return;
  }

  // --- CASE B: model called (at most) one tool — execute it/them ---
  const toolResultTexts: string[] = [];

  for (const call of firstMessage.tool_calls) {
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
    toolResultTexts.push(`Tool "${toolName}" returned:\n${truncated}`);
  }

  // --- STEP 2: finalize the answer with a PLAIN completion call ---
  // No `tools` key at all in this request — the model is not given the
  // function-calling shape, so it structurally cannot emit tool_calls
  // here, regardless of what it saw in step 1.
  const finalMessages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
    {
      role: 'user',
      content: `${toolResultTexts.join('\n\n')}\n\nUsing only the tool result(s) above, answer my original question in plain text. Do not attempt to call any tool.`
    }
  ];

  let finalData;
  try {
    finalData = await callGroq(groqApiKey, selectedModel, finalMessages);
  } catch (err: any) {
    if (typeof err.message === 'string' && err.message.startsWith('RATE_LIMIT:')) {
      onLog({
        sender: 'SYSTEM_ERROR',
        text: `Groq rate limit reached while finalizing the answer. The tool result above is still valid — try asking again in a few seconds.`
      });
    } else {
      onLog({ sender: 'SYSTEM_ERROR', text: `Agent cycle error: ${err.message}` });
    }
    return;
  }

  const finalMessage = finalData.choices[0].message;
  if (finalMessage.content) {
    onLog({ sender: 'ALBUGENT_CORE_AGENT_01', text: finalMessage.content });
  }
}
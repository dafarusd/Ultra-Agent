import type { ModelRouter } from './ModelRouter';
import type { TaskExecutor } from './TaskExecutor';
import type { ConversationManager } from '../services/ConversationManager';
import type { UltraExecutionResult } from '../types/ultra';
import { UltraDevLog as DebugLog } from '../utils/UltraDevLog';

// ─────────────────────────────────────────────────────────────────────────────
// DESTRUCTIVE TOOLS — require explicit user confirmation before executing
// These tools make real-world changes the user cannot undo easily:
// sending messages, making calls, deleting files, making purchases
// ─────────────────────────────────────────────────────────────────────────────
const DESTRUCTIVE_TOOLS = new Set([
  'sms_send',
  'file_delete',
]);

// app_launch is destructive only when it's a phone call
function isDestructiveLaunch(params: Record<string, any>): boolean {
  const action = (params.action || '').toLowerCase();
  return action === 'android.intent.action.call' || action === 'android.intent.action.dial';
}

function requiresConfirmation(tool: string, params: Record<string, any>): boolean {
  if (DESTRUCTIVE_TOOLS.has(tool)) return true;
  if (tool === 'app_launch' && isDestructiveLaunch(params)) return true;
  return false;
}

function describeAction(tool: string, params: Record<string, any>): string {
  if (tool === 'sms_send') {
    return `Send a text message to ${params.to || 'unknown'}: "${params.message || ''}"`;
  }
  if (tool === 'file_delete') {
    return `Delete file: ${params.filename || params.path || 'unknown'}`;
  }
  if (tool === 'app_launch' && isDestructiveLaunch(params)) {
    const number = params.data?.replace('tel:', '') || params.extras?._contactName || 'unknown';
    return `Call ${number}`;
  }
  return `Execute ${tool}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────
const TOOLS = `
app_launch        - Just open an app or website (open only, no interaction). params: {target}
react_navigate    - Open an app/website AND do things inside it (tap, type, scroll, find, click). USE THIS when the user wants to DO something inside an app or site. params: {goal, appHint}
web_search        - Search the internet for information. Returns text only. Does NOT open or interact with sites. Never put a URL here. params: {query}
web_research      - Deep research a topic, return summary. params: {query}
weather           - Get weather. params: {city?, use_current_location?, date?}
device_location   - Get GPS coordinates and city name. params: {}
device_info       - Get battery, RAM, storage, device model. params: {}
system_info       - Get CPU temp, processes, system stats. params: {}
contacts_read     - Read contacts from address book. params: {name?}
sms_send          - Send a text message. params: {to, message}
sms_read          - Read messages from inbox. params: {limit?, filter?}
sms_conversation  - Read SMS thread with a contact. params: {address, limit?}
camera_capture    - Take a photo. params: {}
screenshot        - Take a screenshot. params: {}
note_create       - Create a note. params: {content}
alarm_set         - Set an alarm. params: {time, label?}
timer_set         - Set a timer. params: {duration, label?}
reminder_create   - Create a reminder. params: {text, time?}
file_read         - Read a file or list directory. params: {path}
file_write        - Write content to a file and save it. params: {filename, content}
volume_set        - Set volume. params: {level?, direction?, type?}
brightness_set    - Set screen brightness. params: {level?, direction?}
flashlight_toggle - Toggle flashlight. params: {state?}
read_text_on_screen - Read all visible text on screen. params: {}
describe_screen   - Describe what is on screen. params: {}
notification_read - Read recent notifications. params: {}
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  return `You are Agent Ultra, an AI assistant running directly on an Android phone. You have real tools that control the phone. Use them.

TODAY: ${dateStr} at ${timeStr}

WHEN THE USER ASKS YOU TO DO SOMETHING:
Respond with ONLY a JSON tool call — no explanation, no preamble:
{"tool":"tool_name","params":{"key":"value"}}

WHEN YOU ARE DONE OR WANT TO TALK:
Respond with plain text. Be direct and brief.

CRITICAL RULES:
- Only send messages (sms_send) or make calls when the user EXPLICITLY asks you to.
- Do NOT send messages as a "helpful" follow-up. Do NOT reply to SMS threads you read.
- Do NOT call numbers you find in the inbox. Reading SMS is for information only.
- Always USE tools to do things. Never say "I would" or "I can" — just do it.
- If a tool fails, tell the user what went wrong.

AVAILABLE TOOLS:
${TOOLS}

TOOL SELECTION:
- "Open X and do Y inside it" = react_navigate (goal=Y, appHint=X)
- "Go to site X and click/find/search Y" = react_navigate (goal=Y, appHint=X)  
- "Open X" with nothing else to do = app_launch (target=X)
- "Search for info about X" = web_search (query=X)
- NEVER put a URL into web_search. URLs go to app_launch or react_navigate.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function uid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function parseToolCall(text: string): { tool: string; params: Record<string, any> } | null {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    if (obj?.tool && typeof obj.tool === 'string') {
      return { tool: obj.tool, params: obj.params || {} };
    }
  } catch {}
  return null;
}

function formatToolResult(result: any): string {
  if (!result) return 'No result returned.';
  if (typeof result === 'string') return result;
  if (result.error) return `Error: ${result.error}`;
  if (result.summary) return result.summary;
  try {
    const str = JSON.stringify(result);
    return str.length > 1500 ? str.slice(0, 1500) + '...' : str;
  } catch {
    return String(result);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BRAIN EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────
export class BrainExecutor {
  constructor(
    private ai: ModelRouter,
    private executor: TaskExecutor,
    private conversations: ConversationManager,
  ) {}

  async execute(
    userInput: string,
    conversationId: string,
    taskId: string,
    approvedAction?: boolean,
    pendingState?: { messages: Array<{ role: string; content: string }>; toolCall: { tool: string; params: Record<string, any> } },
  ): Promise<UltraExecutionResult> {
    DebugLog.systemEvent('BrainExecutor', `START input="${userInput.slice(0, 80)}" approved=${!!approvedAction}`);

    // ── RESUME PATH: user approved a pending destructive action ──────────
    if (approvedAction && pendingState) {
      DebugLog.systemEvent('BrainExecutor', `RESUMING from pending: ${pendingState.toolCall.tool}`);
      const { messages, toolCall } = pendingState;

      let toolResult: any;
      try {
        toolResult = await (this.executor as any).execWithParams(toolCall.tool, toolCall.params, userInput, taskId);
      } catch (e: any) {
        toolResult = { error: e.message };
      }
      const resultText = formatToolResult(toolResult);
      DebugLog.systemEvent('BrainExecutor', `RESUME TOOL RESULT: ${resultText.slice(0, 120)}`);

      // Continue the loop with the result
      messages.push({ role: 'assistant', content: JSON.stringify({ tool: toolCall.tool, params: toolCall.params }) });
      messages.push({ role: 'user', content: `Tool result for ${toolCall.tool}:\n${resultText}\n\nNow respond to the user or call another tool.` });

      return this.runLoop(userInput, conversationId, taskId, messages, 1);
    }

    // ── NORMAL PATH: save user message and build fresh context ───────────
    await this.conversations.addMessage(conversationId, {
      id: uid(),
      role: 'user',
      content: userInput,
      createdAt: Date.now(),
    });

    const systemPrompt = buildSystemPrompt();
    const { payload } = await this.buildContextFromConversation(conversationId, systemPrompt);
    return this.runLoop(userInput, conversationId, taskId, payload, 0);
  }

  private async runLoop(
    userInput: string,
    conversationId: string,
    taskId: string,
    messages: Array<{ role: string; content: string }>,
    resumeTurn: number,
  ): Promise<UltraExecutionResult> {
    const MAX_TOOL_TURNS = 12;
    let finalText = '';
    let lastCapability = '';

    for (let turn = resumeTurn; turn < MAX_TOOL_TURNS; turn++) {
      DebugLog.systemEvent('BrainExecutor', `AI turn ${turn + 1}`);

      const aiResult = await this.ai.completeWithConversation(messages, {
        taskId,
        agentId: 'brain',
        maxTokens: 1500,
        temperature: 0.2,
      });

      const rawResponse = aiResult.content.trim();
      DebugLog.systemEvent('BrainExecutor', `AI response (${rawResponse.length} chars): ${rawResponse.slice(0, 120)}`);

      const toolCall = parseToolCall(rawResponse);
      console.warn('[BRAIN] tool_selected:', toolCall ? toolCall.tool : 'NONE (plain text)');

      if (!toolCall) {
        finalText = rawResponse;
        DebugLog.systemEvent('BrainExecutor', `TEXT response, done after ${turn + 1} turns`);
        break;
      }

      // ── CONFIRMATION GATE ─────────────────────────────────────────────
      if (requiresConfirmation(toolCall.tool, toolCall.params)) {
        const description = describeAction(toolCall.tool, toolCall.params);
        DebugLog.systemEvent('BrainExecutor', `CONFIRMATION REQUIRED: ${description}`);

        // Save state so we can resume exactly here if approved
        const pendingState = {
          messages: [...messages, { role: 'assistant', content: rawResponse }],
          toolCall,
        };

        return {
          type: 'approval_required',
          message: `Agent Ultra wants to: **${description}**\n\nAllow this action?`,
          taskId,
          data: {
            replayUserInput: userInput,
            pendingState,
          },
        };
      }

      // ── EXECUTE TOOL ──────────────────────────────────────────────────
      DebugLog.systemEvent('BrainExecutor', `TOOL CALL: ${toolCall.tool} params=${JSON.stringify(toolCall.params).slice(0, 120)}`);
      lastCapability = toolCall.tool;

      let toolResult: any;
      try {
        toolResult = await (this.executor as any).execWithParams(toolCall.tool, toolCall.params, userInput, taskId);
      } catch (e: any) {
        toolResult = { error: e.message };
      }

      const resultText = formatToolResult(toolResult);
      DebugLog.systemEvent('BrainExecutor', `TOOL RESULT: ${resultText.slice(0, 120)}`);

      messages.push({ role: 'assistant', content: rawResponse });

      // Stuck detector: if the same tool fails twice in a row, stop and report honestly
      const isFailure = resultText.startsWith('Error:') || resultText.startsWith('Could not');
      if (isFailure) {
        const prevMsg = messages.length >= 4 ? messages[messages.length - 3].content : '';
        const prevWasSameTool = prevMsg.includes(`"tool":"${toolCall.tool}"`);
        if (prevWasSameTool) {
          finalText = `I wasn't able to complete that. ${toolCall.tool} failed twice: ${resultText}. Please try rephrasing or check if the required app or permission is available.`;
          DebugLog.systemEvent('BrainExecutor', `STUCK STOP: ${toolCall.tool} failed twice, stopping`);
          break;
        }
      }

      messages.push({
        role: 'user',
        content: `Tool result for ${toolCall.tool}:\n${resultText}\n\nNow respond to the user or call another tool.`,
      });

      if (turn === MAX_TOOL_TURNS - 1) {
        finalText = `Ran ${toolCall.tool}: ${resultText}`;
      }
    }

    if (finalText) {
      await this.conversations.addMessage(conversationId, {
        id: uid(),
        role: 'assistant',
        content: finalText,
        createdAt: Date.now(),
        source: 'ultra',
        meta: { capability: lastCapability || undefined },
      });
    }

    DebugLog.systemEvent('BrainExecutor', `DONE taskId=${taskId}`);
    return { type: 'action_result', message: finalText || 'Done.', taskId };
  }

  private async buildContextFromConversation(
    conversationId: string,
    systemPrompt: string,
  ): Promise<{ payload: Array<{ role: string; content: string }> }> {
    const conv = await this.conversations.loadConversation(conversationId);
    const msgs = conv
      ? conv.messages.slice(-20).map((m: any) => ({ role: m.role, content: m.content }))
      : [];
    return { payload: [{ role: 'system', content: systemPrompt }, ...msgs] };
  }
}

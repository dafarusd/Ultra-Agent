import type { ModelRouter } from './ModelRouter';
import type { TaskExecutor } from './TaskExecutor';
import type { ConversationManager } from '../services/ConversationManager';
import type { UltraExecutionResult } from '../types/ultra';
import { UltraDevLog as DebugLog } from '../utils/UltraDevLog';

// ─────────────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS
// The AI sees exactly this. Compact, unambiguous, complete.
// ─────────────────────────────────────────────────────────────────────────────
const TOOLS = `
app_launch        - Open an app or website. params: {target, action?, data?, extras?}
react_navigate    - Open app then interact with UI to complete a goal. params: {goal, appHint}
web_search        - Search the internet. params: {query}
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

RULES:
- Always USE tools to do things. Never say "I would" or "I can" — just do it.
- If a tool fails, tell the user what went wrong and what to try next.
- You can call multiple tools in sequence by using tool calls one at a time.
- For tasks that require navigating a phone UI (search something in an app, scroll, tap), use react_navigate.
- For opening an app or URL, use app_launch.
- Never make up information. If you don't know, use web_search.

AVAILABLE TOOLS:
${TOOLS}`;
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

  // Extract first balanced JSON object
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
  // Compact JSON for structured results
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
  ): Promise<UltraExecutionResult> {
    DebugLog.systemEvent('BrainExecutor', `START input="${userInput.slice(0, 80)}"`);

    // ── 1. Save user message ──────────────────────────────────────────────
    await this.conversations.addMessage(conversationId, {
      id: uid(),
      role: 'user',
      content: userInput,
      createdAt: Date.now(),
    });

    // ── 2. Build conversation payload with full history ───────────────────
    const systemPrompt = buildSystemPrompt();
    const { payload } = await (this as any).buildContextFromConversation(
      conversationId, systemPrompt, 2000,
    );

    // ── 3. Tool-calling loop ──────────────────────────────────────────────
    const MAX_TOOL_TURNS = 12;
    const messages: Array<{ role: string; content: string }> = [...payload];
    let finalText = '';
    let lastCapability = '';

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      DebugLog.systemEvent('BrainExecutor', `AI turn ${turn + 1}`);

      const aiResult = await this.ai.completeWithConversation(messages, {
        taskId,
        agentId: 'brain',
        maxTokens: 1500,
        temperature: 0.2,
      });

      const rawResponse = aiResult.content.trim();
      DebugLog.systemEvent('BrainExecutor', `AI response (${rawResponse.length} chars): ${rawResponse.slice(0, 120)}`);

      // Try to parse as tool call
      const toolCall = parseToolCall(rawResponse);

      if (!toolCall) {
        // Plain text response — done
        finalText = rawResponse;
        DebugLog.systemEvent('BrainExecutor', `TEXT response, done after ${turn + 1} turns`);
        break;
      }

      // ── Execute the tool ──────────────────────────────────────────────
      DebugLog.systemEvent('BrainExecutor', `TOOL CALL: ${toolCall.tool} params=${JSON.stringify(toolCall.params).slice(0, 120)}`);
      lastCapability = toolCall.tool;

      let toolResult: any;
      try {
        toolResult = await (this.executor as any).execWithParams(
          toolCall.tool,
          toolCall.params,
          userInput,
          taskId,
        );
      } catch (e: any) {
        toolResult = { error: e.message };
      }

      const resultText = formatToolResult(toolResult);
      DebugLog.systemEvent('BrainExecutor', `TOOL RESULT: ${resultText.slice(0, 120)}`);

      // ── Add tool call + result to messages and loop ───────────────────
      messages.push({ role: 'assistant', content: rawResponse });
      messages.push({
        role: 'user',
        content: `Tool result for ${toolCall.tool}:\n${resultText}\n\nNow respond to the user or call another tool.`,
      });

      // If last turn and no text yet, force text response
      if (turn === MAX_TOOL_TURNS - 1) {
        finalText = `Ran ${toolCall.tool}: ${resultText}`;
        DebugLog.systemEvent('BrainExecutor', 'MAX TURNS reached, using last tool result');
      }
    }

    // ── 4. Save assistant response ────────────────────────────────────────
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
    return {
      type: 'action_result',
      message: finalText || 'Done.',
      taskId,
    };
  }

  // Builds payload from conversation history
  private async buildContextFromConversation(
    conversationId: string,
    systemPrompt: string,
    responseMaxTokens: number,
  ): Promise<{ payload: Array<{ role: string; content: string }> }> {
    const conv = await this.conversations.loadConversation(conversationId);
    const msgs = conv
      ? conv.messages.slice(-20).map((m: any) => ({ role: m.role, content: m.content }))
      : [];
    return {
      payload: [{ role: 'system', content: systemPrompt }, ...msgs],
    };
  }
}

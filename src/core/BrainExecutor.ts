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
app_launch        - Open an app, website, or settings screen (open only, no interaction). params: {target}
react_navigate    - Open an app/website AND do things inside it (tap, type, scroll, find, click). USE THIS when the user wants to DO something inside an app or site. params: {goal, appHint}
web_search        - Search the internet for information. Returns text only. params: {query}
web_research      - Deep research a topic, return summary. params: {query}
weather           - Get weather. params: {location?, use_current_location?, date?}
news_headlines    - Get latest news headlines. params: {topic?}
device_location   - Get GPS coordinates and city name. params: {}
device_info       - Get battery, RAM, storage, device model. params: {focus?}
system_info       - Get CPU temp, processes, system stats. params: {}
battery_status    - Get battery level and charging state. params: {}
contacts_read     - Read contacts from address book. params: {name?}
sms_send          - Send a text message. params: {to, message}
sms_read          - Read messages from inbox. params: {limit?, filter?}
sms_conversation  - Read SMS thread with a contact. params: {address, limit?}
camera_capture    - Take a photo. params: {}
screenshot        - Take a screenshot and save to gallery. params: {}
screen_record_start - Start screen recording. params: {}
note_create       - Create a note. params: {content}
alarm_set         - Set an alarm. params: {time, label?}
timer_set         - Set a timer. params: {duration, label?}
reminder_create   - Create a reminder. params: {text, time?}
calendar_create   - Create a calendar event. params: {title, details?, startMs?, endMs?}
file_read         - Read a file or list directory. params: {path}
file_write        - Write content to a file. params: {filename, content}
file_open         - Open a file with the default app. params: {path, mimeType?}
open_url          - Open a URL in the browser. params: {url}
share_content     - Share text via Android share sheet. params: {content, subject?}
app_info          - Show app info/settings for an app. params: {target}
clipboard_write   - Copy text to clipboard. params: {text}
clipboard_read    - Read text from clipboard. params: {}
volume_set        - Set volume. params: {level?, direction?, type?}
brightness_set    - Set screen brightness. params: {level?, direction?}
flashlight_toggle - Toggle flashlight. params: {state?}
wifi_toggle       - Toggle Wi-Fi on/off via Quick Settings. params: {}
bluetooth_toggle  - Toggle Bluetooth on/off via Quick Settings. params: {}
airplane_mode     - Toggle airplane mode on/off via Quick Settings. params: {}
do_not_disturb    - Toggle Do Not Disturb on/off via Quick Settings. params: {}
media_play        - Play/pause media. params: {action?}
media_next        - Skip to next track. params: {}
image_generate    - Generate an image from a text prompt. params: {prompt}
tts               - Convert text to speech audio. params: {text, voice?}
read_text_on_screen - Read all visible text on screen. params: {}
describe_screen   - Describe what is on screen. params: {}
notification_read - Read recent notifications. params: {}
memory_recall     - Recall something the agent learned about the user. params: {query}
knowledge_query   - Query the agent's knowledge graph. params: {query}
set_user_name     - Tell the agent your name. params: {name}
set_user_info     - Store user profile info (email, phone, address). params: {email?, phone?, address?}
install_app       - Search Play Store and install an app to gain new capabilities. params: {appName}
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────
async function buildSystemPrompt(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  // Build environment snapshot — phone state + connected devices
  let envSnapshot = '';
  try {
    const { Platform } = require('react-native');
    if (Platform.OS === 'android') {
      const parts: string[] = [];
      try {
        const Battery = require('expo-battery');
        const level = await Battery.getBatteryLevelAsync();
        const state = await Battery.getBatteryStateAsync();
        const charging = state === 2 ? ' (charging)' : '';
        parts.push(`Battery: ${Math.round(level * 100)}%${charging}`);
      } catch {}
      try {
        const AgentNative = (await import('../native/AgentNative')).default;
        const apps = await AgentNative.getInstalledApps();
        parts.push(`${apps.length} apps installed`);
        // Connected Bluetooth devices
        const btDevices = await AgentNative.getConnectedBluetoothDevices();
        if (btDevices.length > 0) parts.push(`BT devices: ${btDevices.join(', ')}`);
        // WiFi network
        const ssid = await AgentNative.getWifiSSID();
        if (ssid) parts.push(`WiFi: ${ssid}`);
      } catch {}
      try {
        const AppCtrl = require('../native/AppController').default;
        const state = await AppCtrl.getSystemStateSnapshot();
        const parsed = JSON.parse(state);
        if (parsed.wifi) parts.push(`WiFi radio: ${parsed.wifi}`);
        if (parsed.bluetooth) parts.push(`BT radio: ${parsed.bluetooth}`);
      } catch {}
      if (parts.length > 0) envSnapshot = `\nPHONE STATE: ${parts.join(' | ')}`;
    }
  } catch {}

  // Load learned knowledge summary — user profile + people + devices + preferences
  let knowledgeSummary = '';
  try {
    const { getAgentCoreInstance } = await import('./AgentCore');
    const core = getAgentCoreInstance();
    const graph = core?.getCortex()?.getKnowledgeGraph();
    const vault = core?.getVault?.();
    if (graph) {
      const items: string[] = [];
      // User profile
      const userName = vault ? await vault.get('user_preferred_name').catch(() => null) : null;
      const userEmail = vault ? await vault.get('user_email').catch(() => null) : null;
      const userPhone = vault ? await vault.get('user_phone').catch(() => null) : null;
      if (userName) items.push(`User: ${userName}`);
      if (userEmail) items.push(`Email: ${userEmail}`);
      if (userPhone) items.push(`Phone: ${userPhone}`);
      // Known people
      const people = graph.getByType('person');
      for (const p of people.slice(0, 5)) {
        const rels = graph.getRelations(p.id);
        const nums = rels.filter(r => r.relation.type === 'has_number').map(r => r.targetEntity.name);
        const emails = rels.filter(r => r.relation.type === 'has_email').map(r => r.targetEntity.name);
        const detail = nums.length ? nums[0] : emails.length ? emails[0] : '';
        items.push(`${p.name}${detail ? ' (' + detail + ')' : ''}`);
      }
      // Known devices
      const devices = graph.getByType('device' as any);
      for (const d of devices.slice(0, 3)) items.push(`Device: ${d.name}${d.properties?.type ? ' (' + d.properties.type + ')' : ''}`);
      // Preferences
      const prefs = graph.getByType('preference');
      for (const pref of prefs.slice(0, 3)) items.push(`Prefers: ${pref.name}`);
      if (items.length > 0) knowledgeSummary = `\nKNOWN ABOUT USER: ${items.join(', ')}`;
    }
    // Check for proactive suggestions — things the agent noticed
    const proactive = core?.getProactiveEngine?.();
    if (proactive) {
      const active = proactive.getActive().filter((s: any) => s.urgency === 'high' || s.urgency === 'medium');
      if (active.length > 0) {
        const notices = active.slice(0, 2).map((s: any) => s.title).join('; ');
        knowledgeSummary += `\nNOTICED: ${notices}`;
      }
    }
  } catch {}

  return `You are Ultra — a capable, concise AI agent with full control of this Android phone. You solve problems, not describe solutions. You speak like a sharp assistant: confident, brief, slightly warm. Never robotic. Never verbose. Just get it done and say what happened in one sentence.

TODAY: ${dateStr} at ${timeStr}${envSnapshot}${knowledgeSummary}

HOW YOU THINK:
1. Understand what the user actually WANTS (not just what they said)
2. Break the problem into concrete steps
3. Execute each step with a tool call
4. OBSERVE the result — read what happened, what's on screen
5. REASON about what to do next based on what you learned
6. Continue until the problem is SOLVED, not just attempted
7. If something fails, try a different approach — don't give up

RESPONSE FORMAT:
- To use a tool: {"tool":"name","params":{...}}
- To talk to the user: plain text (no JSON)
- ONE tool call per response. You will see the result and can continue.

PROBLEM-SOLVING RULES:
- You have up to 12 tool calls per task. Use them wisely.
- IMPORTANT: When web_search returns actual text results, READ THEM and answer the user directly. Do NOT open a browser or call react_navigate to "see" results you already have as text.
- After react_navigate, you'll see what's on the screen. Use that information to decide your next step.
- If a tool fails, try an alternative (different app, different approach, different query).
- If you need information to solve the problem, GATHER it first (web_search, read_text_on_screen, device_info).
- Don't stop at "I opened the page" — read the results, extract the answer, tell the user.
- When you have enough information to answer, STOP calling tools and respond with a clear, complete answer.
- 1-2 web searches is usually enough. Don't keep searching if you already have good results.

CROSS-APP DATA FLOW:
- You can read what's on screen (read_text_on_screen) and use that information in your next tool call
- Example: user says "send mom the address of this restaurant" → read_text_on_screen → extract address → sms_send
- Example: user says "what's this?" → read_text_on_screen → analyze and explain what you see
- After react_navigate, you'll see screen content in the result — use it to answer questions or take next actions

VERIFICATION:
- After any action that changes the screen, check if it actually worked
- Don't assume success — verify by reading the result
- If react_navigate returns goalAchieved=false, read what's on screen and explain what happened
- If a search returned results, READ them and give the user the actual answer

BLOCKERS:
- If you encounter a login screen, captcha, or permission dialog: STOP and tell the user "I need you to sign in / grant permission. Let me know when you're done."
- Don't try to bypass authentication — ask the user to handle it
- If an app crashes or closes unexpectedly, try an alternative approach

SELF-EVOLUTION:
- You can install new apps to gain capabilities you don't have (install_app)
- If the user asks for something that requires an app you don't have (e.g. "order an Uber", "play Spotify"), install it
- You learn from every interaction — names, preferences, contacts are remembered for next time
- You know what apps are installed on this phone — use that to choose the best tool for each task
- If you've seen an app's UI before, you know how to navigate it faster

AUTO-FILL & FORMS:
- You know the user's name, email, phone, and address (if they've told you via set_user_info)
- When react_navigate encounters a sign-up form, use the stored profile to fill fields
- Read field labels ("Name", "Email", "Phone") via accessibility and type the matching stored value
- If you don't have info needed for a form, ASK the user — then save it with set_user_info for next time

DEVICE AWARENESS:
- You can see connected Bluetooth devices and WiFi networks in the PHONE STATE above
- Learn which devices belong to the user: "Play music on my speaker" → you know which BT device is the speaker
- Devices like headphones, speakers, smartwatches, cars, TVs can be referenced by name
- If the user says "send this to my laptop", check BT devices or use share_content

SAFETY:
- NEVER send messages (sms_send) or make calls unless the user EXPLICITLY asks
- Do NOT reply to SMS threads you read or call numbers you find

TOOLS:
${TOOLS}

IMPORTANT: After a toggle or simple action succeeds, STOP and tell the user it's done. Do NOT call react_navigate or app_launch to "verify" — the tool already confirmed success.

TOOL ROUTING (use the most direct tool available):
- Toggle wifi/bluetooth/airplane/DND/flashlight → use the dedicated toggle tool (NOT react_navigate, NOT app_launch)
- Set volume/brightness → volume_set / brightness_set
- Play/pause/skip music → media_play / media_next
- Open a settings screen → app_launch with the settings name (e.g. target="wifi settings")
- Open an app AND interact with it → react_navigate (goal=what to do, appHint=app name)
- Just open an app → app_launch
- Open a URL → open_url
- Search the internet for information → web_search
- Copy/paste → clipboard_write / clipboard_read
- Screenshot/photo → screenshot / camera_capture
- Create event → calendar_create
- Generate image → image_generate
- Read aloud → tts
- "My name is X" → set_user_name
- "Install X" / "Download X" / "Get X app" → install_app
- If a task needs an app you don't have → install_app first, then use it
- NEVER put a URL into web_search
- NEVER invent or guess URLs for react_navigate appHint — use app names (e.g. "chrome", "settings"), not domains
- For web browsing tasks, set appHint to "chrome" and put the search query in goal`;
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
    // Read the current screen so the brain knows what the user is looking at
    let screenContext = '';
    try {
      const { Platform } = require('react-native');
      if (Platform.OS === 'android') {
        const AppCtrl = require('../native/AppController').default;
        if (AppCtrl.isAvailable()) {
          const flat = await AppCtrl.getScreenContentFlat();
          const nodes = JSON.parse(flat);
          if (Array.isArray(nodes) && nodes.length > 0) {
            const labels = nodes
              .filter((n: any) => (n.t || n.d || '').trim())
              .slice(0, 15)
              .map((n: any) => (n.t || n.d || '').trim());
            if (labels.length > 0) {
              const pkg = await AppCtrl.getActivePackage().catch(() => 'unknown');
              screenContext = `\n[Current screen: ${pkg} — ${labels.join(' | ')}]`;
            }
          }
        }
      }
    } catch {}

    await this.conversations.addMessage(conversationId, {
      id: uid(),
      role: 'user',
      content: userInput,
      createdAt: Date.now(),
    });

    const systemPrompt = await buildSystemPrompt();
    const { payload } = await this.buildContextFromConversation(conversationId, systemPrompt);
    // Inject screen context + knowledge into the last user message
    let knowledgeContext = '';
    try {
      const { getAgentCoreInstance: getCore } = await import('./AgentCore');
      const coreInst = getCore();
      const graph = coreInst?.getCortex()?.getKnowledgeGraph();
      if (graph) {
        const resolved = graph.resolve(userInput);
        if (resolved.entity) {
          const relStr = resolved.relations.slice(0, 5).map(r => `${r.relation.type}: ${r.targetEntity.name}`).join(', ');
          knowledgeContext = `\n[Known: ${resolved.entity.name} (${resolved.entity.type})${relStr ? ' — ' + relStr : ''}]`;
        }
      }
    } catch {}
    const extraContext = screenContext + knowledgeContext;
    if (extraContext && payload.length > 0) {
      const lastMsg = payload[payload.length - 1];
      if (lastMsg.role === 'user') {
        lastMsg.content = lastMsg.content + extraContext;
      }
    }
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
    let lastToolResult: any = undefined;

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

      lastToolResult = toolResult;
      const resultText = formatToolResult(toolResult);
      DebugLog.systemEvent('BrainExecutor', `TOOL RESULT: ${resultText.slice(0, 120)}`);

      // Learn from every interaction — build persistent knowledge
      try {
        const { getAgentCoreInstance } = await import('./AgentCore');
        const core = getAgentCoreInstance();
        const graph = core?.getCortex()?.getKnowledgeGraph();
        if (graph) {
          graph.learnFromInteraction(userInput, toolCall.tool, resultText.slice(0, 300)).catch(() => {});
        }
      } catch {}

      messages.push({ role: 'assistant', content: rawResponse });

      // Stuck detector: if the same tool fails twice in a row, stop and report honestly
      const isFailure = resultText.startsWith('Error:') || resultText.startsWith('Could not');
      if (isFailure) {
        const prevMsg = messages.length >= 4 ? messages[messages.length - 3].content : '';
        const prevWasSameTool = prevMsg.includes(`"tool":"${toolCall.tool}"`);
        if (prevWasSameTool) {
          finalText = `That didn't work — ${toolCall.tool} failed twice. ${resultText.slice(0, 150)}`;
          DebugLog.systemEvent('BrainExecutor', `STUCK STOP: ${toolCall.tool} failed twice, stopping`);
          break;
        }
      }

      const isSearchResult = toolCall.tool === 'web_search' && resultText.includes('Search results');
      const followUp = isSearchResult
        ? `\n\nYou have the search results above. Answer the user's question directly using this information. Do NOT open a browser or call react_navigate.`
        : `\n\nContinue solving the user's request. Call another tool if needed, or give your final answer. Be concise.`;
      messages.push({
        role: 'user',
        content: `[Tool result: ${toolCall.tool}]\n${resultText}${followUp}`,
      });

      if (turn === MAX_TOOL_TURNS - 1) {
        finalText = `Ran ${toolCall.tool}: ${resultText}`;
      }
    }

    if (finalText) {
      // Extract image path from the last tool result if present
      let lastToolData: any = undefined;
      if (lastToolResult && typeof lastToolResult === 'object' && lastToolResult.path) {
        lastToolData = { path: lastToolResult.path };
      }
      await this.conversations.addMessage(conversationId, {
        id: uid(),
        role: 'assistant',
        content: finalText,
        createdAt: Date.now(),
        source: 'ultra',
        meta: { capability: lastCapability || undefined, data: lastToolData },
      });
    }

    DebugLog.systemEvent('BrainExecutor', `DONE taskId=${taskId}`);
    return { type: 'action_result', message: finalText || 'Done.', taskId, data: lastToolResult && typeof lastToolResult === 'object' ? { path: lastToolResult.path } : undefined };
  }

  private async buildContextFromConversation(
    conversationId: string,
    systemPrompt: string,
  ): Promise<{ payload: Array<{ role: string; content: string }> }> {
    const conv = await this.conversations.loadConversation(conversationId);
    // Keep last 6 messages, then trim total payload to ~8KB of conversation
    // (system prompt is separate ~8KB, total target <16KB to keep LLM response <3s)
    let msgs = conv
      ? conv.messages.slice(-6).map((m: any) => ({ role: m.role, content: m.content }))
      : [];
    // Trim from oldest if conversation content exceeds 8KB
    const MAX_CONV_CHARS = 8000;
    let totalChars = msgs.reduce((sum, m) => sum + m.content.length, 0);
    while (totalChars > MAX_CONV_CHARS && msgs.length > 2) {
      totalChars -= msgs[0].content.length;
      msgs = msgs.slice(1);
    }
    // Truncate individual messages that are too long (e.g. huge tool results)
    msgs = msgs.map(m => ({
      role: m.role,
      content: m.content.length > 2000 ? m.content.slice(0, 2000) + '...(truncated)' : m.content,
    }));
    return { payload: [{ role: 'system', content: systemPrompt }, ...msgs] };
  }
}

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
- To use a tool: respond with ONLY a JSON object: {"tool":"name","params":{...}}
- To talk to the user: respond with plain text (no JSON)
- ONE tool call per response. You will see the result and can continue.
- ALWAYS use a tool when the user asks you to DO something (toggle, search, set, open, send, etc.)
- Only respond with plain text for greetings, questions you can answer from context, or after a tool result.

EXAMPLES:
User: "turn on the flashlight" → {"tool":"flashlight_toggle","params":{"state":"on"}}
User: "what's the weather" → {"tool":"weather","params":{}}
User: "set volume to 50" → {"tool":"volume_set","params":{"level":50}}
User: "search for pizza near me" → {"tool":"web_search","params":{"query":"pizza near me"}}
User: "open chrome" → {"tool":"app_launch","params":{"target":"chrome"}}
User: "hello" → Hello! How can I help you?

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

CRITICAL RULES:
- After calling a toggle tool (wifi_toggle, bluetooth_toggle, flashlight_toggle, etc.), your NEXT response MUST be plain text confirming the action. Do NOT call any more tools. The toggle already worked.
- After calling volume_set, brightness_set, or any simple action tool, your NEXT response MUST be plain text. Do NOT call react_navigate or app_launch to "check" or "verify".
- NEVER use react_navigate to go to Settings. Use the dedicated tools instead.

TOOL ROUTING (use the most direct tool available):
- Toggle wifi/bluetooth/airplane/DND/flashlight → use the dedicated toggle tool (NOT react_navigate, NOT app_launch, NOT settings)
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
// TOOL INFERENCE — when the model responds as plain text instead of JSON,
// detect common action patterns from the user's original request and
// synthesize the appropriate tool call.
// ─────────────────────────────────────────────────────────────────────────────
function inferToolFromText(userInput: string): { tool: string; params: Record<string, any> } | null {
  const u = userInput.toLowerCase().trim();
  const raw = userInput.trim();

  // ── TOGGLES ──────────────────────────────────────────────────────────
  if (/\b(flashlight|torch|flash)\b/.test(u)) {
    const state = /\b(off|disable)\b/.test(u) ? 'off' : /\b(on|enable)\b/.test(u) ? 'on' : undefined;
    return { tool: 'flashlight_toggle', params: state ? { state } : {} };
  }
  if (/\b(wi-?fi|wifi)\b/.test(u) && /\b(toggle|turn|switch|enable|disable|on|off)\b/.test(u)) {
    return { tool: 'wifi_toggle', params: {} };
  }
  if (/\bbluetooth\b/.test(u) && /\b(toggle|turn|switch|enable|disable|on|off)\b/.test(u)) {
    return { tool: 'bluetooth_toggle', params: {} };
  }
  if (/\b(airplane|flight)\s*mode\b/.test(u) && /\b(toggle|turn|switch|enable|disable|on|off)\b/.test(u)) {
    return { tool: 'airplane_mode', params: {} };
  }
  if (/\b(do not disturb|dnd|don'?t disturb)\b/.test(u)) {
    return { tool: 'do_not_disturb', params: {} };
  }

  // ── VOLUME / BRIGHTNESS ──────────────────────────────────────────────
  const volMatch = u.match(/\bvolume\b.*?(\d+)/);
  if (volMatch) return { tool: 'volume_set', params: { level: parseInt(volMatch[1], 10) } };
  if (/\bvolume\s+(up|down)\b/.test(u)) return { tool: 'volume_set', params: { direction: u.includes('up') ? 'up' : 'down' } };
  if (/\b(mute|unmute|silence)\b/.test(u)) return { tool: 'volume_set', params: { level: 0 } };
  const brightMatch = u.match(/\bbright(ness)?\b.*?(\d+)/);
  if (brightMatch) return { tool: 'brightness_set', params: { level: parseInt(brightMatch[2], 10) } };
  if (/\bbright(ness)?\s+(up|down|higher|lower)\b/.test(u)) return { tool: 'brightness_set', params: { direction: /up|higher/.test(u) ? 'up' : 'down' } };

  // ── MEDIA ────────────────────────────────────────────────────────────
  if (/\b(play|pause|resume)\s*(music|song|audio|media|track)?\b/.test(u) && !/\bplay\s*store\b/.test(u)) return { tool: 'media_play', params: {} };
  if (/\b(next|skip)\s*(track|song)?\b/.test(u)) return { tool: 'media_next', params: {} };

  // ── WEATHER ──────────────────────────────────────────────────────────
  if (/\b(weather|forecast|temperature outside|how (hot|cold|warm))\b/.test(u)) {
    const locMatch = raw.match(/(?:weather|forecast|temperature)\s+(?:in|at|for|near)\s+(.+)/i);
    return { tool: 'weather', params: locMatch ? { location: locMatch[1].trim() } : {} };
  }

  // ── WEB SEARCH ───────────────────────────────────────────────────────
  if (/\b(search|google|look\s*up|search\s*the\s*web)\b/.test(u) && /\b(for|web|internet|online|about)\b/.test(u)) {
    const queryMatch = raw.match(/(?:search|google|look\s*up)\s+(?:the\s+)?(?:web\s+)?(?:for\s+|about\s+)?(.+)/i);
    return { tool: 'web_search', params: { query: queryMatch ? queryMatch[1].trim() : userInput } };
  }

  // ── NEWS ─────────────────────────────────────────────────────────────
  if (/\b(news|headlines|what'?s happening)\b/.test(u)) {
    const topicMatch = raw.match(/\bnews\s+(?:about|on|for)\s+(.+)/i);
    return { tool: 'news_headlines', params: topicMatch ? { topic: topicMatch[1].trim() } : {} };
  }

  // ── DEVICE INFO / BATTERY / LOCATION ─────────────────────────────────
  if (/\bbatter(y|ies)\b/.test(u)) return { tool: 'battery_status', params: {} };
  if (/\b(device|phone|model|what am i using)\b/.test(u) && /\b(info|name|what|which|am i|specs?)\b/.test(u)) return { tool: 'device_info', params: {} };
  if (/\b(system|cpu|ram|memory|storage)\b/.test(u) && /\b(info|status|usage|how much|free)\b/.test(u)) return { tool: 'system_info', params: {} };
  if (/\b(location|where am i|gps|coordinates)\b/.test(u)) return { tool: 'device_location', params: {} };

  // ── COMMUNICATION ────────────────────────────────────────────────────
  const smsMatch = raw.match(/\b(?:send|text)\s+(?:a\s+)?(?:message|text|sms)\s+to\s+(.+?)(?:\s+(?:saying|that says|:)\s+(.+))?$/i)
    || raw.match(/\btext\s+(.+?)\s+(?:saying|that says|:)\s+(.+)$/i);
  if (smsMatch) return { tool: 'sms_send', params: { to: smsMatch[1].trim(), message: (smsMatch[2] || '').trim() } };
  if (/\b(read|show|check)\s*(my\s+)?(messages?|texts?|sms|inbox)\b/.test(u)) return { tool: 'sms_read', params: { limit: 10 } };
  if (/\b(messages?|texts?|conversation)\s+(?:with|from)\s+(.+)/i.test(u)) {
    const convMatch = raw.match(/(?:messages?|texts?|conversation)\s+(?:with|from)\s+(.+)/i);
    return { tool: 'sms_conversation', params: { address: convMatch ? convMatch[1].trim() : '' } };
  }
  if (/\b(contacts?|address\s*book|phone\s*book)\b/.test(u) && /\b(read|show|list|find|search|who)\b/.test(u)) {
    const nameMatch = raw.match(/(?:contact|find)\s+(.+)/i);
    return { tool: 'contacts_read', params: nameMatch ? { name: nameMatch[1].trim() } : {} };
  }

  // ── SCREEN READING (before clipboard — "read" must not match clipboard_read) ──
  if (/\b(what'?s?\s+on\s+(?:the\s+)?screen|read\s+(?:the\s+)?screen|what\s+(?:do\s+)?(?:i|you)\s+see)\b/.test(u)) return { tool: 'read_text_on_screen', params: {} };
  if (/\b(describe|what'?s\s+showing|what\s+is\s+this)\b/.test(u) && /\bscreen\b/.test(u)) return { tool: 'describe_screen', params: {} };

  // ── CLIPBOARD ────────────────────────────────────────────────────────
  if (/\b(copy|clipboard)\b/.test(u) && /\b(to clipboard|copy)\b/.test(u)) {
    const textMatch = raw.match(/(?:copy)\s+(?:this\s+)?(?:to\s+clipboard\s*:?\s*)?(.+?)(?:\s+to\s+clipboard)?$/i);
    return { tool: 'clipboard_write', params: { text: textMatch ? textMatch[1].trim() : '' } };
  }
  if (/\b(paste|what'?s\s+(?:on|in)\s+(?:the\s+)?clipboard)\b/.test(u)) return { tool: 'clipboard_read', params: {} };

  // ── FILES ────────────────────────────────────────────────────────────
  if (/\b(read|show|cat|view)\s+(?:the\s+)?(?:file|document)\b/.test(u)) {
    const pathMatch = raw.match(/(?:read|show|view)\s+(?:the\s+)?(?:file\s+)?(.+)/i);
    return { tool: 'file_read', params: { path: pathMatch ? pathMatch[1].trim() : '' } };
  }
  if (/\b(write|save|create)\s+(?:a\s+)?(?:file|note|document)\b/.test(u)) {
    const writeMatch = raw.match(/(?:write|save|create)\s+(?:a\s+)?(?:file|note|document)\s+(?:called\s+)?(.+?)(?:\s+(?:with|containing|:)\s+(.+))?$/i);
    return { tool: 'file_write', params: { filename: writeMatch ? writeMatch[1].trim() : 'note.txt', content: writeMatch?.[2]?.trim() || '' } };
  }
  if (/\bshare\b/.test(u)) {
    const shareMatch = raw.match(/share\s+(.+)/i);
    return { tool: 'share_content', params: { content: shareMatch ? shareMatch[1].trim() : '' } };
  }

  // ── ALARMS / TIMERS / REMINDERS / CALENDAR ───────────────────────────
  if (/\b(alarm)\b/.test(u)) {
    const timeMatch = raw.match(/(?:alarm)\s+(?:for|at)\s+(.+)/i) || raw.match(/(?:set|create)\s+(?:an?\s+)?alarm\s+(.+)/i);
    return { tool: 'alarm_set', params: { time: timeMatch ? timeMatch[1].trim() : '' } };
  }
  if (/\btimer\b/.test(u)) {
    const durMatch = raw.match(/(?:timer)\s+(?:for|of)\s+(.+)/i) || raw.match(/(?:set|start)\s+(?:a\s+)?timer\s+(.+)/i);
    return { tool: 'timer_set', params: { duration: durMatch ? durMatch[1].trim() : '' } };
  }
  if (/\bremind(er)?\b/.test(u)) {
    const remMatch = raw.match(/remind\s+(?:me\s+)?(?:to\s+)?(.+)/i);
    return { tool: 'reminder_create', params: { text: remMatch ? remMatch[1].trim() : userInput } };
  }
  if (/\b(calendar|event|schedule|appointment)\b/.test(u) && /\b(create|add|schedule|new|set)\b/.test(u)) {
    const evtMatch = raw.match(/(?:create|add|schedule)\s+(?:a\s+)?(?:calendar\s+)?(?:event\s+)?(?:for\s+|called\s+)?(.+)/i);
    return { tool: 'calendar_create', params: { title: evtMatch ? evtMatch[1].trim() : '' } };
  }

  // ── NOTES ────────────────────────────────────────────────────────────
  if (/\b(note|write\s+down|jot\s+down)\b/.test(u)) {
    const noteMatch = raw.match(/(?:note|write down|jot down)\s*:?\s*(.+)/i) || raw.match(/(?:create|make)\s+(?:a\s+)?note\s*:?\s*(.+)/i);
    return { tool: 'note_create', params: { content: noteMatch ? noteMatch[1].trim() : userInput } };
  }

  // ── CAMERA / SCREENSHOT / SCREEN RECORD ──────────────────────────────
  if (/\bscreenshot\b/.test(u)) return { tool: 'screenshot', params: {} };
  if (/\b(take\s+a\s+photo|take\s+a\s+picture|camera|selfie|capture\s+photo)\b/.test(u)) return { tool: 'camera_capture', params: {} };
  if (/\b(screen\s*record|record\s+(?:the\s+)?screen|start\s+recording)\b/.test(u)) return { tool: 'screen_record_start', params: {} };

  // ── IMAGE / TTS / VIDEO ──────────────────────────────────────────────
  if (/\b(generate|create|make|draw)\s+(?:an?\s+)?(?:image|picture|art|illustration)\b/.test(u)) {
    const promptMatch = raw.match(/(?:generate|create|make|draw)\s+(?:an?\s+)?(?:image|picture|art|illustration)\s+(?:of\s+)?(.+)/i);
    return { tool: 'image_generate', params: { prompt: promptMatch ? promptMatch[1].trim() : userInput } };
  }
  if (/\b(read\s+aloud|say\s+this|speak|text\s+to\s+speech|tts)\b/.test(u)) {
    const ttsMatch = raw.match(/(?:read aloud|say|speak)\s+(.+)/i);
    return { tool: 'tts', params: { text: ttsMatch ? ttsMatch[1].trim() : userInput } };
  }

  // (screen reading moved above clipboard)

  // ── NOTIFICATIONS ────────────────────────────────────────────────────
  if (/\b(notification|notifications)\b/.test(u) && /\b(read|show|check|any|what)\b/.test(u)) return { tool: 'notification_read', params: {} };

  // ── USER PROFILE / MEMORY ────────────────────────────────────────────
  const nameMatch = raw.match(/\bmy\s+name\s+is\s+(.+)/i) || raw.match(/\bcall\s+me\s+(.+)/i);
  if (nameMatch) return { tool: 'set_user_name', params: { name: nameMatch[1].trim() } };
  if (/\bmy\s+(email|phone|address)\s+is\s+/i.test(u)) {
    const infoMatch = raw.match(/my\s+(email|phone|address)\s+is\s+(.+)/i);
    if (infoMatch) return { tool: 'set_user_info', params: { [infoMatch[1].toLowerCase()]: infoMatch[2].trim() } };
  }
  if (/\b(remember|recall|what\s+do\s+you\s+know\s+about|do\s+you\s+know)\b/.test(u)) {
    const memMatch = raw.match(/(?:remember|recall|know about)\s+(.+)/i);
    return { tool: 'memory_recall', params: { query: memMatch ? memMatch[1].trim() : userInput } };
  }
  if (/\bknowledge\b/.test(u) && /\b(query|what|search)\b/.test(u)) {
    const kgMatch = raw.match(/knowledge\s+(?:query\s+)?(.+)/i);
    return { tool: 'knowledge_query', params: { query: kgMatch ? kgMatch[1].trim() : userInput } };
  }

  // ── APP MANAGEMENT ───────────────────────────────────────────────────
  if (/\b(install|download|get)\s+(?:the\s+)?(.+?)(?:\s+app)?\s*$/i.test(u)) {
    const installMatch = raw.match(/(?:install|download|get)\s+(?:the\s+)?(.+?)(?:\s+app)?\s*$/i);
    return { tool: 'install_app', params: { appName: installMatch ? installMatch[1].trim() : '' } };
  }
  if (/\b(app\s*info|info\s+(?:about|for|on)\s+(?:the\s+)?app)\b/.test(u)) {
    const appInfoMatch = raw.match(/(?:app\s*info|info\s+(?:about|for|on))\s+(?:the\s+)?(.+)/i);
    return { tool: 'app_info', params: { target: appInfoMatch ? appInfoMatch[1].trim() : '' } };
  }

  // ── URL ──────────────────────────────────────────────────────────────
  const urlMatch = u.match(/\b(?:open|go to|visit|navigate to)\s+(https?:\/\/\S+)/i)
    || u.match(/\b(?:open|go to|visit)\s+([\w-]+\.(?:com|org|net|io|co|ai|dev|gov|edu)\S*)/i);
  if (urlMatch) {
    const url = urlMatch[1].startsWith('http') ? urlMatch[1] : `https://${urlMatch[1]}`;
    return { tool: 'open_url', params: { url } };
  }

  // ── REACT NAVIGATE (do something inside an app) ──────────────────────
  const reactMatch = raw.match(/\b(?:search|find|look for|order|book|buy|play)\s+(.+?)\s+(?:on|in|using|with)\s+(.+)/i);
  if (reactMatch) {
    return { tool: 'react_navigate', params: { goal: `${reactMatch[1].trim()}`, appHint: reactMatch[2].trim() } };
  }

  // ── APP LAUNCH (simple "open X" — must be last, catches broadly) ─────
  const openMatch = raw.match(/\b(?:open|launch|start|run)\s+(?:the\s+)?(.+)/i);
  if (openMatch) {
    const target = openMatch[1].trim();
    // Don't match if it's a URL (handled above) or a file
    if (!/^https?:\/\//.test(target) && !/\.\w{2,4}$/.test(target)) {
      return { tool: 'app_launch', params: { target } };
    }
  }

  return null;
}

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

      let toolCall = parseToolCall(rawResponse);

      // ── INFERENCE-FIRST: on turn 0, use deterministic intent detection from the
      // user's original request. This overrides the model's tool choice because
      // models frequently select the wrong tool (e.g. web_search for "open calculator").
      // On subsequent turns (tool result follow-ups), trust the model's choice.
      if (turn === 0) {
        const inferred = inferToolFromText(userInput);
        if (inferred) {
          if (toolCall && toolCall.tool !== inferred.tool) {
            console.warn('[BRAIN] tool_override:', toolCall.tool, '→', inferred.tool, '(inference takes priority on turn 0)');
          } else if (!toolCall) {
            console.warn('[BRAIN] tool_inferred:', inferred.tool, 'from user input (model returned plain text)');
          }
          toolCall = inferred;
        }
      }

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
    // IMPORTANT: Filter out plain-text assistant replies from context — they teach the
    // model to respond as text instead of using tools. Only keep tool-call exchanges.
    let msgs = conv
      ? conv.messages.slice(-6)
          .filter((m: any) => {
            // Always keep user messages
            if (m.role === 'user') return true;
            // Keep assistant messages that contain tool JSON or tool results
            if (m.role === 'assistant' && m.content && (m.content.includes('"tool"') || m.content.includes('[Tool result'))) return true;
            // Keep the very last assistant message (the most recent response)
            return false;
          })
          .map((m: any) => ({ role: m.role, content: m.content }))
      : [];
    // Trim from oldest if conversation content exceeds 8KB
    const MAX_CONV_CHARS = 8000;
    let totalChars = msgs.reduce((sum, m) => sum + m.content.length, 0);
    while (totalChars > MAX_CONV_CHARS && msgs.length > 2) {
      totalChars -= msgs[0].content.length;
      msgs = msgs.slice(1);
    }
    // Ensure proper role alternation (merge consecutive same-role messages)
    const merged: typeof msgs = [];
    for (const m of msgs) {
      if (merged.length > 0 && merged[merged.length - 1].role === m.role) {
        merged[merged.length - 1].content += '\n' + m.content;
      } else {
        merged.push({ ...m });
      }
    }
    msgs = merged;
    // Truncate individual messages that are too long (e.g. huge tool results)
    msgs = msgs.map(m => ({
      role: m.role,
      content: m.content.length > 2000 ? m.content.slice(0, 2000) + '...(truncated)' : m.content,
    }));
    return { payload: [{ role: 'system', content: systemPrompt }, ...msgs] };
  }
}

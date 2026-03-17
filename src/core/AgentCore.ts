import { SecureVault } from '../security/SecureVault';
import { ModelRouter } from './ModelRouter';
import { CapabilityRegistry } from './CapabilityRegistry';
import { PermissionBroker } from './PermissionBroker';
import { DebugEngine } from './DebugEngine';
import { BuildSystem } from './BuildSystem';
import { TaskExecutor } from './TaskExecutor';
import { Orchestrator } from './Orchestrator';
import { PreferenceLearner } from '../utils/PreferenceLearner';
import { CostTracker } from '../services/CostTracker';
import { StorageManager } from '../services/StorageManager';
import { ConversationManager } from '../services/ConversationManager';
import { ExecutionLedger } from '../services/ExecutionLedger';
import { SafetyChecker } from './SafetyChecker';
import { CommandParser } from './CommandParser';
import { validatePlan } from './CapabilitySchemas';
import { Logger } from '../utils/Logger';
import { UltraDevLog as DebugLog } from '../utils/UltraDevLog';
import { MemoryManager } from './MemoryManager';
import { EventMonitor } from '../services/EventMonitor';
import type {
  ChatMessage,
  UltraExecutionResult,
  ActionPlan,
  PromptTrace,
  ExecutionResultType,
  ExecutionStep,
  TraceLedgerEvent,
} from '../types/ultra';

class SimpleEmitter {
  private listeners: Map<string, Array<(...args: any[]) => void>> = new Map();
  on(event: string, fn: (...args: any[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(fn);
    return this;
  }
  emit(event: string, ...args: any[]): boolean {
    const fns = this.listeners.get(event);
    if (!fns) return false;
    fns.forEach(fn => { try { fn(...args); } catch {} });
    return true;
  }
  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  }
}

type Mode = 'command' | 'conversation' | 'ai_instruction';

function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

function uid(prefix = 'msg'): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

export interface ExecuteArgs {
  conversationId: string;
  userInput: string;
  replay?: boolean;
  approvedModel?: string;
  approvedAction?: boolean;
  skipModelSwitchPrompt?: boolean;
}

export class AgentCore extends SimpleEmitter {
  private vault: SecureVault;
  private ai: ModelRouter;
  private caps: CapabilityRegistry;
  private perms: PermissionBroker;
  private debugEngine: DebugEngine;
  private buildSystem: BuildSystem;
  private executor: TaskExecutor;
  private orchestrator: Orchestrator;
  private learner: PreferenceLearner;
  private costTracker: CostTracker;
  private storage: StorageManager;
  private conversations: ConversationManager;
  private ledger: ExecutionLedger;
  private safety: SafetyChecker;
  private parser: CommandParser;
  private memory: MemoryManager;
  private eventMonitor: EventMonitor | null = null;
  private logger: Logger;
  private ready: boolean;
  private instanceId: string;

  constructor(vault: SecureVault, cb: (msg: string, type: string) => void) {
    super();
    this.instanceId = DebugLog.coreCreated('initial_mount');
    this.vault = vault;
    this.logger = new Logger('AgentCore');
    this.costTracker = new CostTracker(vault);
    this.storage = new StorageManager(500);
    this.ai = new ModelRouter(vault, this.costTracker);
    this.caps = new CapabilityRegistry();
    this.perms = new PermissionBroker();
    this.learner = new PreferenceLearner(vault);
    this.debugEngine = new DebugEngine(this.ai, this.learner);
    this.buildSystem = new BuildSystem(this.ai, this.debugEngine, this.storage);
    this.executor = new TaskExecutor(this.buildSystem, this.debugEngine, this.caps, this.perms, this.ai);
    this.orchestrator = new Orchestrator(this.ai, this.costTracker);
    this.conversations = new ConversationManager();
    this.ledger = new ExecutionLedger();
    this.safety = new SafetyChecker();
    this.parser = new CommandParser();
    this.memory = new MemoryManager(vault);
    this.ready = false;
    this.on('log', cb);
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  destroy(reason: string = 'cleanup'): void {
    DebugLog.coreDestroyed(this.instanceId, reason);
    this.removeAllListeners();
  }

  async initialize(): Promise<void> {
    if (this.ready) return;
    this.emit('log', 'Initializing systems...', 'system');
    DebugLog.agentInitStart();
    const initStart = Date.now();

    const safeInit = async (name: string, fn: () => Promise<void>): Promise<void> => {
      const t0 = Date.now();
      try {
        await fn();
        DebugLog.agentInitSubsystem(name, true, Date.now() - t0);
      } catch (err: any) {
        DebugLog.agentInitSubsystem(name, false, Date.now() - t0, err.message);
        console.warn(`[AgentCore] ${name} init failed: ${err.message}`);
      }
    };

    await Promise.all([
      safeInit('CostTracker', () => this.costTracker.initialize()),
      safeInit('Storage', () => this.storage.initialize()),
      safeInit('Capabilities', () => this.caps.initialize()),
      safeInit('Permissions', () => this.perms.initialize()),
      safeInit('Learner', () => this.learner.initialize()),
      safeInit('Ledger', () => this.ledger.initialize()),
      safeInit('MemoryManager', () => this.memory.initialize()),
    ]);

    await safeInit('ModelRouter', () => this.ai.initialize());
    await safeInit('DebugEngine', () => this.debugEngine.initialize());
    await safeInit('BuildSystem', () => this.buildSystem.initialize());
    await safeInit('TaskExecutor', () => this.executor.initialize());
    await safeInit('StorageBudget', () => this.storage.enforceBudget());
    await safeInit('LogCleanup', async () => { await Logger.cleanOldLogs(7); });
    await safeInit('DebugLogCleanup', async () => { await DebugLog.cleanOldLogs(7); });
    await safeInit('CostCleanup', () => this.costTracker.cleanup(30));
    DebugLog.agentInitComplete(Date.now() - initStart);

    this.ready = true;

    try {
      this.eventMonitor = new EventMonitor(this.executor, this.memory, this.ai);
      await this.eventMonitor.start();
      DebugLog.systemEvent('AgentCore', 'EventMonitor started');
    } catch (evErr: any) {
      DebugLog.error('EventMonitor', `Failed to start: ${evErr.message}`);
    }

    this.emit('log', 'All systems online', 'agent');
  }

  private detectMode(input: string): Mode {
    const t = input.toLowerCase().trim();
    if (t.startsWith('ask the ai') || t.startsWith('use ai to') || t.includes('when you ask the ai') || t.includes('when you talk to ai')) {
      return 'ai_instruction';
    }
    const genomePatterns = /^(improve\s+yourself|self[\s-]?improve|evolve|mutate|upgrade\s+yourself|replicate|self[\s-]?replicate|reproduce|clone\s+yourself|spawn\s+offspring)\b/i;
    if (genomePatterns.test(t)) return 'command';
    const imperative = /^(open|send|read|delete|find|show|create|build|run|execute|launch|call|write|list|take|share|pick|choose|select|where|get|text|make|start|switch|generate|play|schedule|email|mail|dial|navigate|directions?|timer|map|turn|set|search|google|look|flash|torch|flashlight|mute|unmute|silence|dim|brighten|copy|paste|capture|grab|clip|notify|check|battery|network|storage|ram|memory|disk|space|wifi|bluetooth|system|device|status|info|phone|cpu|temp|weather|remind|wake|alarm|volume|ringer|brightness|screenshot|record|scan|download|upload|install|uninstall|update|sync|pair|connect|disconnect|reset|clear|lock|unlock|enable|disable|activate|deactivate|toggle|browse|visit|go|stop|pause|resume|skip|next|previous|repeat|shuffle|queue|bookmark|save|note|jot|remember|forget|recall|settings|camera|contacts|messages|photos|gallery|apps|calendar|maps|clock|calculator)\b/i.test(t);
    if (imperative) return 'command';
    if (/^(gps|my\s+(?:location|coordinates|gps))\b/i.test(t)) return 'command';
    const ultraCommand = /^ultra[\s,]+(?:open|send|read|delete|find|show|create|build|run|execute|launch|call|write|list|take|share|pick|choose|select|where|what|how|get|text|make|start|switch|generate|play|schedule|email|mail|dial|navigate|directions?|timer|map|turn|set|search|google|look|flash|torch|mute|unmute|silence|dim|brighten|copy|paste|capture|grab|check|battery|network|storage|ram|memory|disk|space|wifi|system|device|status|info|weather|remind|wake|alarm|volume|ringer|brightness|screenshot|record|scan|download|upload|install|uninstall|update|sync|pair|connect|disconnect|reset|clear|lock|unlock|enable|disable|activate|deactivate|toggle|browse|visit|go|stop|pause|resume|skip|next|previous|repeat|shuffle|queue|bookmark|save|note|jot|remember|forget|recall)\b/i;
    if (ultraCommand.test(t)) return 'command';
    return 'conversation';
  }

  private buildDynamicPrompt(params: {
    mode: Mode;
    userInput: string;
    summary: string;
    capabilities: string[];
  }): string {
    const permReport = this.perms.getStatusReport();
    let behavior: string;

    if (params.mode === 'command') {
      behavior = 'You MUST return ONLY a JSON action plan: {"capability":"...", "params": {...}, "reason":"..."}. Do NOT return natural language, code, or markdown. ONLY valid JSON.';
    } else if (params.mode === 'ai_instruction') {
      behavior = 'The user is giving you meta-instructions about how to handle their request. Follow their instructions precisely while answering the target request. Return natural language.';
    } else {
      behavior = `Return a natural language response. Be precise, concise, and helpful.

ABSOLUTE RULES IN CONVERSATION MODE — VIOLATION IS A CRITICAL FAILURE:
1. You CANNOT execute device actions. You have no hands in this mode.
2. NEVER say "Done", "Alarm set", "Sent", "Opened", "Completed", "I've set", "I've sent" or any confirmation of an action you did not execute.
3. NEVER fabricate device data: battery level, storage, RAM, temperature, network status, location, weather, contacts, or any sensor reading.
4. NEVER say your location is anywhere. You do not know the user's location in this mode.
5. NEVER say "I'll check" then provide made-up data.
6. If the user wants an action: respond with exactly — "Use the command: [exact phrasing]" — nothing else.
7. If asked for device data: respond with exactly — "Use the command: device status" or the specific command.
8. You may answer general knowledge questions, do math, explain things, have a conversation.
9. You may NOT pretend to have executed anything. Ever.`;
    }

    const persona = `You are Ultra, an autonomous AI agent running directly on an Android device. You have full access to this phone — its apps, settings, contacts, messages, files, camera, sensors, and system state. You are not a chatbot. You are an agent with hands.

When the user gives you a task, you execute it using the device's capabilities. You do not ask for permission unless you genuinely need to resolve ambiguity (like which contact to text). You do not explain what you are about to do before doing it. You do not say "I'll try to..." or "I'm attempting to...". You act, then report the result in one concise sentence.

Your responses are direct and human. You speak in first person. You never list steps or number your actions. You never say "As an AI" or "I'm sorry, I can't". If something fails, you say what failed and what you'll try next. If something works, you confirm it simply.

You can: open any app, read and send messages, make calls, control media, toggle device settings, read device status, create notes, set alarms, search the web, open URLs, manage files, take screenshots, read notifications, and execute multi-step tasks across multiple apps.

When a task spans multiple steps, you execute them in sequence. When you need to know something (like which Mike Smith), you ask once, clearly. You remember context within the conversation.

You are always on. Always capable. Always direct.`;

    return [
      persona,
      `Mode: ${params.mode}`,
      `Available capabilities: ${params.capabilities.join(', ')}`,
      `Device permissions: ${permReport}`,
      params.summary ? `Conversation memory: ${params.summary}` : '',
      behavior,
    ].filter(Boolean).join('\n');
  }

  private async buildContext(
    conversationId: string,
    systemPrompt: string,
    responseMaxTokens: number,
    model: string
  ): Promise<{
    payload: Array<{ role: string; content: string }>;
    summary: string;
    requiredContextTokens: number;
  }> {
    const conv = await this.conversations.loadConversation(conversationId);
    if (!conv) throw new Error('Conversation not found');

    const contextWindow = this.ai.getContextWindow(model);
    const budget = Math.max(1000, contextWindow - responseMaxTokens - estimateTokens(systemPrompt) - 300);

    const msgs = conv.messages.map(m => ({ role: m.role, content: m.content }));

    // Cap history to prevent context bloat — keep system message + last 20 exchanges
    const MAX_HISTORY_MESSAGES = 20;
    if (msgs.length > MAX_HISTORY_MESSAGES) {
      msgs.splice(0, msgs.length - MAX_HISTORY_MESSAGES);
    }

    const recent: Array<{ role: string; content: string }> = [];
    let used = 0;

    for (let i = msgs.length - 1; i >= 0; i--) {
      const c = msgs[i].content || '';
      const t = estimateTokens(c);
      if (used + t > Math.floor(budget * 0.6)) break;
      recent.unshift({ role: msgs[i].role, content: c });
      used += t;
    }

    const older = msgs.slice(0, Math.max(0, msgs.length - recent.length));
    if (older.length > 0 && (!conv.summary || (conv.messageCountSinceSummary ?? 0) >= 15)) {
      const olderText = older.map(m => `[${m.role}] ${m.content}`).join('\n');
      await this.summarizeOlderMessages(conversationId, olderText);
    }

    const refreshed = await this.conversations.loadConversation(conversationId);
    const summary = refreshed?.summary || '';

    const payload = [
      { role: 'system', content: systemPrompt },
      ...(summary ? [{ role: 'system', content: `Conversation memory:\n${summary}` }] : []),
      ...recent,
    ];

    return {
      payload,
      summary,
      requiredContextTokens: estimateTokens(JSON.stringify(payload)) + responseMaxTokens,
    };
  }

  private async summarizeOlderMessages(conversationId: string, olderText: string): Promise<void> {
    try {
      const taskId = Date.now().toString(36);
      const result = await this.ai.complete(
        olderText.slice(0, 24000),
        {
          systemPrompt: 'Summarize the key facts, decisions, constraints, and open tasks from this conversation in 2-3 short paragraphs. Be factual and concise.',
          taskId,
          agentId: 'summarizer',
          maxTokens: 500,
          temperature: 0.3,
        }
      );
      await this.conversations.updateSummary(conversationId, result.content);
    } catch (err: any) {
      this.logger.warn('Summarization failed: ' + err.message);
    }
  }

  private parseActionPlan(text: string): ActionPlan | null {
    const fenced = text.match(/```json\s*([\s\S]*?)```/i);
    const raw = fenced ? fenced[1] : text;
    try {
      const cleaned = raw.trim();
      const obj = JSON.parse(cleaned);
      if (!obj?.capability) return null;
      return { capability: obj.capability, params: obj.params || {}, reason: obj.reason, raw: text };
    } catch {
      return null;
    }
  }

  async execute(args: ExecuteArgs): Promise<UltraExecutionResult> {
    if (!this.ready) return { type: 'error', message: 'Agent not initialized', taskId: '' };

    const { conversationId, userInput } = args;
    const taskId = Date.now().toString(36);
    const startTime = Date.now();
    const steps: ExecutionStep[] = [];
    let execError: string | null = null;
    DebugLog.taskCoreStamp(taskId, this.instanceId);
    DebugLog.agentExecuteStart(taskId, conversationId, userInput.length, !!args.replay);

    const step = (name: string, detail: string, success: boolean) => {
      steps.push({ step: name, timestamp: Date.now(), detail, success });
      DebugLog.agentStep(taskId, name, detail.slice(0, 500), success);
    };

    // === STEP 1: INGEST ===
    DebugLog.executePhase(taskId, 'INGEST');
    DebugLog.userMessage(conversationId, userInput);
    step('INTAKE', `Received user input: "${userInput.slice(0, 200)}"${args.replay ? ' (replay)' : ''}`, true);
    await this.ledger.logEvent({
      phase: 'INTAKE',
      inputSummary: userInput.slice(0, 200),
      outputSummary: '',
      success: true,
      conversationId,
    });

    if (!args.replay) {
      const userMsg: ChatMessage = {
        id: uid('msg'),
        role: 'user',
        content: userInput,
        createdAt: Date.now(),
        source: 'system',
        meta: {},
      };
      await this.conversations.addMessage(conversationId, userMsg);
    }

    // === STEP 2: ROUTE ===
    DebugLog.executePhase(taskId, 'ROUTE');
    const mode = this.detectMode(userInput);
    DebugLog.modeDetected(taskId, mode, userInput);
    step('ROUTE', `Detected mode: ${mode}`, true);

    // === STEP 3: PLAN ===
    DebugLog.executePhase(taskId, 'PLAN');
    const capList = this.caps.getAll().map(c => c.id);
    let plan: ActionPlan | null = null;

    const relevantMemory = await this.memory.retrieveRelevant(userInput, 5);
    if (relevantMemory.length > 0) {
      DebugLog.systemEvent('AgentCore', `Memory retrieved: ${relevantMemory.length} relevant entries`);
    }

    const multiStepConnectors = /\b(then|and then|after that|followed by|next|afterwards|subsequently|once done|when done|after which|and also)\b/i;
    const isMultiStep = mode === 'command' && multiStepConnectors.test(userInput);
    if (isMultiStep) {
      DebugLog.systemEvent('AgentCore', `Multi-step task detected: "${userInput.slice(0, 100)}"`);
      const rawSteps = userInput.split(multiStepConnectors);
      const multiSteps = rawSteps
        .map(s => s.trim())
        .filter(s => s.length > 3 && !multiStepConnectors.test(s.trim()));
      if (multiSteps.length > 1) {
        const results: string[] = [];
        let allSucceeded = true;
        for (const stepInput of multiSteps) {
          DebugLog.systemEvent('AgentCore', `Multi-step executing: "${stepInput}"`);
          const stepPlan = this.parser.parse(stepInput);
          if (stepPlan) {
            try {
              const stepResult = await this.executor.runWithPlan(stepPlan, taskId);
              results.push(stepResult.summary || `${stepInput}: done`);
              if (!stepResult.success) allSucceeded = false;
            } catch (e: any) {
              results.push(`${stepInput}: failed — ${e.message}`);
              allSucceeded = false;
            }
          } else {
            results.push(`${stepInput}: could not parse`);
            allSucceeded = false;
          }
        }
        const summary = results.join(' → ');
        const multiMsg: ChatMessage = {
          id: uid('msg'),
          role: 'assistant',
          content: summary,
          createdAt: Date.now(),
          source: 'ultra',
          meta: { mode: 'command', multiStep: true, stepCount: multiSteps.length },
        };
        await this.conversations.addMessage(conversationId, multiMsg);
        await this.learner.learnFromExecution(userInput, ['multi_step'], summary, allSucceeded);
        return { type: 'action_result', message: summary, taskId };
      }
    }

    let planFromParser = false;
    if (mode === 'command') {
      plan = this.parser.parse(userInput);
      if (plan) planFromParser = true;

      if (!plan) {
        if (!this.ai.hasApiKey()) {
          step('PLAN', 'No deterministic match and no API key configured', false);
          const errMsg: ChatMessage = {
            id: uid('msg'),
            role: 'assistant',
            content: 'I understood that as a command but couldn\'t match it to a specific action. Configure your Venice API key in Settings to enable AI-assisted command routing.',
            createdAt: Date.now(),
            source: 'system',
            meta: {},
          };
          await this.conversations.addMessage(conversationId, errMsg);
          return { type: 'error', message: errMsg.content, taskId };
        }
        this.emit('log', 'Analyzing command...', 'system');
        const systemPrompt = this.buildDynamicPrompt({
          mode,
          userInput,
          summary: '',
          capabilities: capList,
        });
        const { payload } = await this.buildContext(conversationId, systemPrompt, 1200, this.ai.getDefaultModel());
        const framedUserMessage = userInput;
        const finalMessages = [...payload, { role: 'user', content: framedUserMessage }];

        try {
          const aiResult = await this.ai.completeWithConversation(finalMessages, {
            taskId,
            agentId: 'planner',
            maxTokens: 1200,
            temperature: 0.3,
          });

          plan = this.parseActionPlan(aiResult.content);

          if (!plan) {
            step('PLAN', `AI routing failed to produce valid plan. AI response: ${aiResult.content.slice(0, 500)}`, false);
            const promptTrace = this.buildPromptTrace(this.ai.getDefaultModel(), systemPrompt, framedUserMessage, finalMessages);
            promptTrace.executionSteps = steps;
            promptTrace.mode = mode;
            promptTrace.taskId = taskId;
            promptTrace.deterministic = false;
            promptTrace.permissionState = this.perms.getStatusReport();
            promptTrace.durationMs = Date.now() - startTime;
            const errMsg: ChatMessage = {
              id: uid('msg'),
              role: 'assistant',
              content: 'I understood that as a command, but couldn\'t determine a specific action. Could you rephrase?',
              createdAt: Date.now(),
              source: 'ultra',
              meta: { mode: 'command', promptTrace },
            };
            await this.conversations.addMessage(conversationId, errMsg);
            return { type: 'clarify', message: errMsg.content, taskId, data: { promptTrace } };
          }
        } catch (err: any) {
          const stack = err.stack || err.message;
          step('PLAN', `AI routing threw error: ${stack}`, false);
          return { type: 'error', message: 'Failed to analyze command: ' + err.message, taskId };
        }
        DebugLog.planResult(taskId, plan.capability, plan.params, false);
        step('PLAN', `AI routed to capability: ${plan.capability} — params: ${JSON.stringify(plan.params).slice(0, 300)}`, true);
      } else {
        DebugLog.planResult(taskId, plan.capability, plan.params, true);
        step('PLAN', `Deterministic parse matched capability: ${plan.capability} — params: ${JSON.stringify(plan.params).slice(0, 300)}`, true);
      }

      await this.ledger.logEvent({
        phase: 'PLAN',
        capability: plan.capability,
        inputSummary: userInput.slice(0, 200),
        outputSummary: JSON.stringify(plan).slice(0, 200),
        success: true,
        conversationId,
      });

      // === STEP 4: VERIFY ===
      DebugLog.executePhase(taskId, 'VERIFY');
      const schemaResult = validatePlan(plan);
      if (!schemaResult.valid) {
        step('VERIFY', `Schema validation failed: ${schemaResult.errors.join(', ')}`, false);
        const msg = `Invalid action parameters: ${schemaResult.errors.join(', ')}`;
        const errMsg: ChatMessage = {
          id: uid('msg'),
          role: 'assistant',
          content: msg,
          createdAt: Date.now(),
          source: 'ultra',
          meta: { mode: 'command', capability: plan.capability },
        };
        await this.conversations.addMessage(conversationId, errMsg);
        return { type: 'error', message: msg, taskId };
      }

      const safetyResult = this.safety.check(userInput, plan);
      DebugLog.safetyCheck(taskId, safetyResult.risk, safetyResult.allowed, safetyResult.reasons);
      step('VERIFY', `Safety check: risk=${safetyResult.risk}, allowed=${safetyResult.allowed}, reasons=[${safetyResult.reasons.join('; ')}]`, safetyResult.allowed);

      await this.ledger.logEvent({
        phase: 'VERIFY',
        capability: plan.capability,
        inputSummary: `risk=${safetyResult.risk}`,
        outputSummary: safetyResult.reasons.join('; ').slice(0, 200),
        success: safetyResult.allowed,
        conversationId,
      });

      if (!safetyResult.allowed) {
        const msg = `Blocked: ${safetyResult.reasons.join(' | ')}`;
        const blockedMsg: ChatMessage = {
          id: uid('msg'),
          role: 'assistant',
          content: msg,
          createdAt: Date.now(),
          source: 'ultra',
          meta: { mode: 'command', capability: plan.capability, risk: 'blocked' },
        };
        await this.conversations.addMessage(conversationId, blockedMsg);
        return { type: 'blocked', message: msg, taskId, data: { safety: safetyResult, plan } };
      }

      // === STEP 5: APPROVE ===
      DebugLog.executePhase(taskId, 'APPROVE');
      const budgetCheck = await this.ledger.checkBudget();
      if (!budgetCheck.allowed) {
        step('APPROVE', `Budget exceeded: ${budgetCheck.reason}`, false);
        const msg = `Action blocked by autonomy budget: ${budgetCheck.reason}`;
        const budgetMsg: ChatMessage = {
          id: uid('msg'),
          role: 'assistant',
          content: msg,
          createdAt: Date.now(),
          source: 'ultra',
          meta: { mode: 'command', capability: plan.capability },
        };
        await this.conversations.addMessage(conversationId, budgetMsg);
        return { type: 'blocked', message: msg, taskId };
      }

      if (safetyResult.risk === 'dangerous' && !args.approvedAction) {
        DebugLog.watchdogArm(taskId, 'APPROVE', 10000);
        step('APPROVE', `Dangerous action requires user approval: ${safetyResult.reasons.join('; ')}`, false);
        await this.ledger.logEvent({
          phase: 'APPROVE',
          capability: plan.capability,
          inputSummary: 'Awaiting user approval',
          outputSummary: `Dangerous: ${safetyResult.reasons.join('; ')}`,
          success: false,
          conversationId,
        });
        DebugLog.watchdogDisarm(taskId, 'APPROVE');
        const approvalMsg = `Approval required for ${plan.capability}: ${plan.reason || safetyResult.reasons.join(' | ')}`;
        const approvalChatMsg: ChatMessage = {
          id: uid('msg'),
          role: 'assistant',
          content: approvalMsg,
          createdAt: Date.now(),
          source: 'ultra',
          meta: { mode: 'command', capability: plan.capability, risk: 'dangerous' },
        };
        await this.conversations.addMessage(conversationId, approvalChatMsg);
        return {
          type: 'approval_required',
          message: approvalMsg,
          taskId,
          data: { plan, safety: safetyResult, replayUserInput: userInput },
        };
      }

      step('APPROVE', args.approvedAction ? 'User pre-approved this action' : `Auto-approved (risk=${safetyResult.risk})`, true);

      // Model switch recommendation (only for non-replay, non-skip)
      if (!args.skipModelSwitchPrompt && !args.approvedModel) {
        const model = this.ai.getDefaultModel();
        const recommendation = this.ai.recommendModel({
          taskType: 'agent_action',
          requiredContextTokens: 2000,
          currentModel: model,
        });
        if (recommendation) {
          const switchMsg = `I recommend switching to ${recommendation.recommended}. ${recommendation.reason}`;
          const switchChatMsg: ChatMessage = {
            id: uid('msg'),
            role: 'assistant',
            content: switchMsg,
            createdAt: Date.now(),
            source: 'ultra',
            meta: { mode: 'command' },
          };
          await this.conversations.addMessage(conversationId, switchChatMsg);
          return {
            type: 'model_switch_request',
            message: switchMsg,
            taskId,
            data: {
              recommendedModel: recommendation.recommended,
              reason: recommendation.reason,
              currentModel: model,
              replayUserInput: userInput,
            },
          };
        }
      }

      // === STEP 6: EXECUTE ===
      DebugLog.executePhase(taskId, 'EXECUTE');
      const REPEATABLE_CAPABILITIES = new Set(['app_launch', 'camera_capture', 'media_access', 'device_location', 'contacts_read']);
      const idempotencyKey = `${conversationId}:${plan.capability}:${JSON.stringify(plan.params)}`;
      if (!REPEATABLE_CAPABILITIES.has(plan.capability)) {
        const isDuplicate = await this.ledger.checkIdempotency(idempotencyKey);
        if (isDuplicate) {
          return { type: 'action_result', message: 'This action was already executed (duplicate prevented).', taskId };
        }
      }

      this.emit('log', `Executing ${plan.capability}...`, 'system');
      DebugLog.watchdogArm(taskId, 'EXECUTE', 90000);

      let execResult: any;
      const progressLog: string[] = [];
      try {
        if (plan.capability === 'app_build') {
          execResult = await this.buildSystem.buildApp(
            plan.params.description || userInput,
            taskId,
            (progress) => {
              const entry = `[${progress.phase}] ${progress.message}`;
              progressLog.push(entry);
              this.emit('log', entry, 'build_progress');
            }
          );
        } else if (plan.capability === 'self_modify' || plan.capability === 'self_replicate') {
          this.executor.setGenomeProgressCallback((phase, msg) => {
            const entry = `[${phase}] ${msg}`;
            progressLog.push(entry);
            this.emit('log', entry, 'genome_progress');
          });
          execResult = await this.executor.runWithPlan(plan, taskId);
          this.executor.setGenomeProgressCallback(null);
        } else {
          execResult = await this.executor.runWithPlan(plan, taskId);
        }
        DebugLog.watchdogDisarm(taskId, 'EXECUTE');
        const rawStr = JSON.stringify(execResult).slice(0, 1000);
        DebugLog.execResult(taskId, plan.capability, execResult?.success !== false, rawStr);
        step('EXECUTE', `${plan.capability} completed. Result: ${rawStr}${progressLog.length > 0 ? '\nProgress (' + progressLog.length + ' entries):\n' + progressLog.join('\n') : ''}`, execResult?.success !== false);
      } catch (err: any) {
        DebugLog.watchdogDisarmAll(taskId);
        const stack = err.stack || err.message;
        execResult = { success: false, error: err.message, stack };
        execError = stack;
        DebugLog.error('EXECUTE', err.message, stack);
        step('EXECUTE', `${plan.capability} threw exception:\n${stack}`, false);
        this.executor.setGenomeProgressCallback(null);
      }

      if (progressLog.length > 0) {
        const logMsg: ChatMessage = {
          id: uid('msg'),
          role: 'assistant',
          content: progressLog.join('\n'),
          createdAt: Date.now(),
          source: 'ultra',
          meta: { mode: 'command', capability: plan.capability, isBuildLog: true },
        };
        await this.conversations.addMessage(conversationId, logMsg);
      }

      await this.ledger.logEvent({
        phase: 'EXECUTE',
        capability: plan.capability,
        inputSummary: safetyResult.risk === 'dangerous' ? `[dangerous] ${userInput.slice(0, 150)}` : userInput.slice(0, 200),
        outputSummary: JSON.stringify(execResult).slice(0, 200),
        model: args.approvedModel || this.ai.getDefaultModel(),
        cost: this.costTracker.getTaskSpend(taskId),
        idempotencyKey,
        success: execResult?.success !== false,
        conversationId,
      });

      // === STEP 7: VERIFY RESULT ===
      DebugLog.executePhase(taskId, 'VERIFY_RESULT');
      const verification = this.safety.verifyResult(plan, execResult);
      DebugLog.verification(taskId, verification.verified, verification.issues);
      step('VERIFY_RESULT', `verified=${verification.verified}${verification.issues.length > 0 ? ', issues: ' + verification.issues.join('; ') : ', no issues'}`, verification.verified);

      await this.ledger.logEvent({
        phase: 'VERIFY_RESULT',
        capability: plan.capability,
        inputSummary: `verified=${verification.verified}`,
        outputSummary: verification.issues.join('; ').slice(0, 200),
        success: verification.verified,
        conversationId,
      });

      const resultSummary = await this.summarizeResult(plan.capability, execResult, userInput, verification);

      // === STEP 8: WRITE MEMORY ===
      DebugLog.executePhase(taskId, 'WRITE_MEMORY');
      step('WRITE_MEMORY', `Summary generated (${resultSummary.length} chars). Writing to conversation history.`, true);

      const systemPromptForTrace = this.buildDynamicPrompt({
        mode, userInput, summary: '', capabilities: capList,
      });

      const ledgerEvents = await this.ledger.getEvents({ conversationId });
      const traceLedger: TraceLedgerEvent[] = ledgerEvents.map(e => ({
        phase: e.phase,
        capability: e.capability,
        inputSummary: e.inputSummary,
        outputSummary: e.outputSummary,
        success: e.success,
        timestamp: e.timestamp,
      }));

      const promptTrace: PromptTrace = {
        model: args.approvedModel || this.ai.getDefaultModel(),
        systemPrompt: planFromParser ? '(deterministic parse — no AI call)' : systemPromptForTrace,
        framedUserMessage: userInput,
        includedMessages: [],
        createdAt: Date.now(),
        executionSteps: steps,
        plan: { capability: plan.capability, params: plan.params, reason: plan.reason },
        rawResult: JSON.stringify(execResult),
        safetyCheck: { risk: safetyResult.risk, allowed: safetyResult.allowed, reasons: safetyResult.reasons },
        verification: { verified: verification.verified, issues: verification.issues },
        permissionState: this.perms.getStatusReport(),
        error: execError,
        durationMs: Date.now() - startTime,
        taskId,
        mode,
        deterministic: planFromParser,
        ledgerEvents: traceLedger,
      };

      const resultMsg: ChatMessage = {
        id: uid('msg'),
        role: 'assistant',
        content: resultSummary.slice(0, 4000),
        createdAt: Date.now(),
        source: 'ultra',
        meta: {
          mode: 'command',
          capability: plan.capability,
          risk: safetyResult.risk as any,
          promptTrace,
        },
      };
      await this.conversations.addMessage(conversationId, resultMsg);

      // === STEP 9: ADAPT ===
      DebugLog.executePhase(taskId, 'ADAPT');
      await this.learner.learnFromExecution(
        userInput,
        [plan.capability],
        resultSummary,
        verification.verified
      );
      if (verification.verified && execResult?.success !== false) {
        await this.memory.storeSession(userInput, plan.capability, resultSummary);
        await this.memory.promoteLongterm(userInput, plan.capability, resultSummary);
      }
      step('ADAPT', `Learned from execution: verified=${verification.verified}`, true);

      await this.ledger.logEvent({
        phase: 'LEARN',
        capability: plan.capability,
        inputSummary: userInput.slice(0, 200),
        outputSummary: `verified=${verification.verified}`,
        success: true,
        conversationId,
      });

      return {
        type: 'action_result',
        message: resultSummary.slice(0, 4000),
        taskId,
        data: { result: execResult, promptTrace },
      };
    }

    // === CONVERSATION / AI_INSTRUCTION MODE ===
    step('PLAN', `Conversation/AI instruction mode — no capability plan needed`, true);
    step('VERIFY', 'N/A — no capability action to verify in conversation mode', true);
    step('APPROVE', 'N/A — no approval required for conversation mode', true);
    if (!this.ai.hasApiKey()) {
      const errMsg: ChatMessage = {
        id: uid('msg'),
        role: 'assistant',
        content: 'Venice API key not configured. Open Settings to add your key.',
        createdAt: Date.now(),
        source: 'system',
        meta: {},
      };
      await this.conversations.addMessage(conversationId, errMsg);
      return { type: 'error', message: 'Venice API key not configured. Open Settings.', taskId };
    }
    this.emit('log', 'Thinking...', 'system');

    const model = args.approvedModel || this.ai.getDefaultModel();
    const conv = await this.conversations.loadConversation(conversationId);
    const summary = conv?.summary || '';

    const systemPrompt = this.buildDynamicPrompt({
      mode,
      userInput,
      summary,
      capabilities: capList,
    });

    const { payload, requiredContextTokens } = await this.buildContext(
      conversationId, systemPrompt, 4000, model
    );

    if (!args.skipModelSwitchPrompt && !args.approvedModel) {
      const taskType = userInput.toLowerCase().includes('code') ? 'code' as const : 'conversation' as const;
      const recommendation = this.ai.recommendModel({
        taskType,
        requiredContextTokens,
        currentModel: model,
      });
      if (recommendation) {
        const switchMsg = `I recommend switching to ${recommendation.recommended}. ${recommendation.reason}`;
        const switchChatMsg: ChatMessage = {
          id: uid('msg'),
          role: 'assistant',
          content: switchMsg,
          createdAt: Date.now(),
          source: 'ultra',
          meta: { mode },
        };
        await this.conversations.addMessage(conversationId, switchChatMsg);
        return {
          type: 'model_switch_request',
          message: switchMsg,
          taskId,
          data: {
            recommendedModel: recommendation.recommended,
            reason: recommendation.reason,
            currentModel: model,
            replayUserInput: userInput,
          },
        };
      }
    }

    const framedUserMessage = mode === 'ai_instruction'
      ? `User meta-instruction mode. Follow the user's instruction while answering:\n${userInput}`
      : userInput;

    const finalMessages = [...payload, { role: 'user', content: framedUserMessage }];

    try {
      const aiResult = await this.ai.completeWithConversation(finalMessages, {
        model: args.approvedModel || model,
        taskId,
        agentId: 'chat',
        maxTokens: 4000,
      });

      DebugLog.aiResponse(conversationId, aiResult.model, aiResult.content, aiResult.cost);
      step('EXECUTE', `AI response received (${aiResult.content.length} chars, model=${aiResult.model}, cost=${aiResult.cost ?? 0})`, true);
      step('VERIFY_RESULT', 'N/A — no capability result to verify in conversation mode', true);
      step('WRITE_MEMORY', 'AI response written to conversation history', true);
      step('ADAPT', 'N/A — no adaptation needed for conversation mode', true);

      const filteredForTrace = finalMessages.filter(m => {
        if (m.role === 'system' && m.content === systemPrompt) return false;
        if (m.role === 'user' && m.content === framedUserMessage) return false;
        return true;
      });
      const promptTrace: PromptTrace = {
        model: aiResult.model,
        systemPrompt,
        framedUserMessage,
        includedMessages: filteredForTrace.map(m => ({ role: m.role as any, content: m.content })),
        createdAt: Date.now(),
        executionSteps: steps,
        rawResult: aiResult.content.slice(0, 2000),
        permissionState: this.perms.getStatusReport(),
        durationMs: Date.now() - startTime,
        taskId,
        mode,
        deterministic: false,
      };

      const aiMsg: ChatMessage = {
        id: uid('msg'),
        role: 'assistant',
        content: aiResult.content,
        createdAt: Date.now(),
        source: 'model',
        meta: { mode, promptTrace },
      };
      await this.conversations.addMessage(conversationId, aiMsg);

      return {
        type: 'text',
        message: aiResult.content,
        taskId,
        data: { promptTrace, cost: aiResult.cost },
      };
    } catch (err: any) {
      const stack = err.stack || err.message;
      DebugLog.error('AI_REQUEST', err.message, stack);
      step('EXECUTE', `AI request failed: ${stack}`, false);
      return { type: 'error', message: 'AI request failed: ' + err.message, taskId };
    }
  }

  async handleConfirmation(confirmed: boolean, originalRequest: string, conversationId: string): Promise<UltraExecutionResult> {
    if (!confirmed) {
      const cancelMsg: ChatMessage = {
        id: uid('msg'),
        role: 'assistant',
        content: 'Cancelled.',
        createdAt: Date.now(),
        source: 'ultra',
      };
      await this.conversations.addMessage(conversationId, cancelMsg);
      return { type: 'action_result', message: 'Cancelled.' };
    }
    return this.execute({
      conversationId,
      userInput: originalRequest,
      replay: true,
      approvedAction: true,
    });
  }

  getConversationManager(): ConversationManager {
    return this.conversations;
  }

  getExecutionLedger(): ExecutionLedger {
    return this.ledger;
  }

  private buildPromptTrace(
    model: string,
    systemPrompt: string,
    framedUserMessage: string,
    messages: Array<{ role: string; content: string }>
  ): PromptTrace {
    const filtered = messages.filter(m => {
      if (m.role === 'system' && m.content === systemPrompt) return false;
      if (m.role === 'user' && m.content === framedUserMessage) return false;
      return true;
    });
    return {
      model,
      systemPrompt,
      framedUserMessage,
      includedMessages: filtered.map(m => ({ role: m.role as any, content: m.content })),
      createdAt: Date.now(),
    };
  }

  private async summarizeResult(
    capability: string,
    execResult: any,
    userInput: string,
    verification: { verified: boolean; issues: string[] }
  ): Promise<string> {
    const result = execResult?.data ?? execResult;

    if (result?.success === false && (result?.error || execResult?.summary)) {
      const errMsg = result?.error || execResult?.summary;
      if (capability === 'app_build') {
        return `Build failed: ${errMsg}\n\nNote: Building apps requires an Android device with the standalone APK installed. On web preview, the build system is unavailable.`;
      }
      return `I tried to run ${capability} but encountered an error: ${errMsg}`;
    }

    if (capability === 'app_build' && result?.success) {
      const parts = [`App built successfully!`];
      if (result.spec?.appName) parts.push(`Name: ${result.spec.appName}`);
      if (result.apkPath) parts.push(`APK: ${result.apkPath}`);
      if (result.spec?.files?.length) parts.push(`Files: ${result.spec.files.length} source files`);
      if (result.debugAttempts) parts.push(`Debug iterations: ${result.debugAttempts}`);
      return parts.join('\n');
    }

    if (capability === 'self_modify' && result?.type === 'evolution') {
      const parts = [`Evolution complete.`];
      parts.push(`Cycles: ${result.totalCycles}, Improvements: ${result.totalImprovements}`);
      parts.push(`Generation: ${result.generation}`);
      if (result.fitness !== null) parts.push(`Fitness: ${result.fitness}/100`);
      if (result.taskSummary) parts.push(result.taskSummary);
      if (result.report) parts.push(`\n${result.report}`);
      return parts.join('\n');
    }

    if (capability === 'self_replicate' && result?.type === 'replication') {
      const parts = [`Offspring created successfully!`];
      parts.push(`Generation: ${result.offspringGeneration}`);
      parts.push(`Parent ID: ${result.parentId}`);
      if (result.apkPath) parts.push(`APK: ${result.apkPath}`);
      if (result.packageName) parts.push(`Package: ${result.packageName}`);
      return parts.join('\n');
    }

    if (typeof result === 'string') {
      return result.length > 2000 ? result.slice(0, 2000) + '…' : result;
    }

    if (!verification.verified) {
      const raw = typeof result === 'object' ? JSON.stringify(result) : String(result);
      return `${capability} completed with issues: ${verification.issues.join(', ')}. Result: ${raw.slice(0, 500)}`;
    }

    try {
      const raw = typeof result === 'object' ? JSON.stringify(result) : String(result);
      if (raw.length < 200) {
        return `Done. ${raw}`;
      }
      const taskId = Date.now().toString(36);
      const aiSummary = await this.ai.complete(
        `Capability: ${capability}\nUser request: ${userInput}\nRaw result:\n${raw.slice(0, 6000)}`,
        {
          systemPrompt: 'Summarize this agent action result in 1-3 short sentences for the user. Be specific about what happened. Do not mention JSON or raw data. Speak naturally.',
          taskId,
          agentId: 'summarizer',
          maxTokens: 300,
          temperature: 0.3,
        }
      );
      return aiSummary.content || `Done. ${raw.slice(0, 500)}`;
    } catch {
      const raw = typeof result === 'object' ? JSON.stringify(result) : String(result);
      return `Done. ${raw.slice(0, 500)}`;
    }
  }

  abortCurrentRequest(): void { this.ai.abortCurrentRequest(); }
  hasApiKey(): boolean { return this.ai.hasApiKey(); }
  async refreshApiKey(): Promise<void> { await this.ai.refreshApiKey(); }
  getAvailableModels() { return this.ai.getAvailableModels(); }
  async setApiBaseUrl(url: string) { await this.ai.setBaseUrl(url); }
  getApiBaseUrl() { return this.ai.getBaseUrl(); }
  getDefaultModel() { return this.ai.getDefaultModel(); }
  async setDefaultModel(modelId: string) { await this.ai.setDefaultModel(modelId); }
  getModelRouter() { return this.ai; }
  getCostSummary() { return this.costTracker.getSummary(); }
  async getStorageBreakdown() { return this.storage.getBreakdown(); }
  getDebugStats() { return this.debugEngine.getStats(); }
  getLearnedPatterns() { return this.learner.getTopPatterns(); }
  killSwarm(): void { this.orchestrator.killAll(); }
}

let _agentCoreInstance: AgentCore | null = null;
export function setAgentCoreInstance(core: AgentCore) { _agentCoreInstance = core; }
export function getAgentCoreInstance(): AgentCore | null { return _agentCoreInstance; }

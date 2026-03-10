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
import type {
  ChatMessage,
  UltraExecutionResult,
  ActionPlan,
  PromptTrace,
  ExecutionResultType,
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
  private logger: Logger;
  private ready: boolean;

  constructor(vault: SecureVault, cb: (msg: string, type: string) => void) {
    super();
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
    this.ready = false;
    this.on('log', cb);
  }

  async initialize(): Promise<void> {
    if (this.ready) return;
    this.emit('log', 'Initializing systems...', 'system');

    const safeInit = async (name: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (err: any) {
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
    ]);

    await safeInit('ModelRouter', () => this.ai.initialize());
    await safeInit('DebugEngine', () => this.debugEngine.initialize());
    await safeInit('BuildSystem', () => this.buildSystem.initialize());
    await safeInit('TaskExecutor', () => this.executor.initialize());
    await safeInit('StorageBudget', () => this.storage.enforceBudget());
    await safeInit('LogCleanup', async () => { await Logger.cleanOldLogs(7); });
    await safeInit('CostCleanup', () => this.costTracker.cleanup(30));

    this.ready = true;
    this.emit('log', 'All systems online', 'agent');
  }

  private detectMode(input: string): Mode {
    const t = input.toLowerCase().trim();
    if (t.startsWith('ask the ai') || t.startsWith('use ai to') || t.includes('when you ask the ai') || t.includes('when you talk to ai')) {
      return 'ai_instruction';
    }
    const genomePatterns = /^(improve\s+yourself|self[\s-]?improve|evolve|mutate|upgrade\s+yourself|replicate|self[\s-]?replicate|reproduce|clone\s+yourself|spawn\s+offspring)\b/i;
    if (genomePatterns.test(t)) return 'command';
    const imperative = /^(open|send|read|delete|find|show|create|build|run|execute|launch|call|write|list|take)\b/i.test(t);
    if (t.includes('ultra')) return 'command';
    if (imperative) return 'command';
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
      behavior = 'Return a natural language response. Be precise, concise, and helpful.';
    }

    return [
      'You are Agent Ultra, an autonomous AI agent running on an Android device.',
      'You execute actions through a deterministic capability system — never return code for the user to paste.',
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
    if (!this.ready) return { type: 'error', message: 'Agent not initialized' };

    const { conversationId, userInput } = args;
    const taskId = Date.now().toString(36);

    // === STEP 1: INGEST ===
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
      return { type: 'error', message: 'Venice API key not configured. Open Settings.' };
    }

    // === STEP 2: ROUTE ===
    const mode = this.detectMode(userInput);

    // === STEP 3: PLAN ===
    const capList = this.caps.getAll().map(c => c.id);
    let plan: ActionPlan | null = null;

    if (mode === 'command') {
      plan = this.parser.parse(userInput);

      if (!plan) {
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
            const promptTrace = this.buildPromptTrace(this.ai.getDefaultModel(), systemPrompt, framedUserMessage, finalMessages);
            const errMsg: ChatMessage = {
              id: uid('msg'),
              role: 'assistant',
              content: 'I understood that as a command, but couldn\'t determine a specific action. Could you rephrase?',
              createdAt: Date.now(),
              source: 'ultra',
              meta: { mode: 'command', promptTrace },
            };
            await this.conversations.addMessage(conversationId, errMsg);
            return { type: 'clarify', message: errMsg.content, data: { promptTrace } };
          }
        } catch (err: any) {
          return { type: 'error', message: 'Failed to analyze command: ' + err.message };
        }
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
      const schemaResult = validatePlan(plan);
      if (!schemaResult.valid) {
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
        return { type: 'error', message: msg };
      }

      const safetyResult = this.safety.check(userInput, plan);

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
        return { type: 'blocked', message: msg, data: { safety: safetyResult, plan } };
      }

      // === STEP 5: APPROVE ===
      const budgetCheck = await this.ledger.checkBudget();
      if (!budgetCheck.allowed) {
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
        return { type: 'blocked', message: msg };
      }

      if (safetyResult.risk === 'dangerous' && !args.approvedAction) {
        await this.ledger.logEvent({
          phase: 'APPROVE',
          capability: plan.capability,
          inputSummary: 'Awaiting user approval',
          outputSummary: `Dangerous: ${safetyResult.reasons.join('; ')}`,
          success: false,
          conversationId,
        });
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
          data: { plan, safety: safetyResult, replayUserInput: userInput },
        };
      }

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
      const idempotencyKey = `${conversationId}:${plan.capability}:${JSON.stringify(plan.params)}`;
      const isDuplicate = await this.ledger.checkIdempotency(idempotencyKey);
      if (isDuplicate) {
        return { type: 'action_result', message: 'This action was already executed (duplicate prevented).' };
      }

      this.emit('log', `Executing ${plan.capability}...`, 'system');

      let execResult: any;
      try {
        if (plan.capability === 'app_build') {
          execResult = await this.buildSystem.buildApp(
            plan.params.description || userInput,
            taskId,
            (progress) => {
              this.emit('log', `[${progress.phase}] ${progress.message}`, 'build_progress');
            }
          );
        } else if (plan.capability === 'self_modify' || plan.capability === 'self_replicate') {
          this.executor.setGenomeProgressCallback((phase, msg) => {
            this.emit('log', `[${phase}] ${msg}`, 'genome_progress');
          });
          execResult = await this.executor.runWithPlan(plan, taskId);
          this.executor.setGenomeProgressCallback(null);
        } else {
          execResult = await this.executor.runWithPlan(plan, taskId);
        }
      } catch (err: any) {
        execResult = { success: false, error: err.message };
        this.executor.setGenomeProgressCallback(null);
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
      const verification = this.safety.verifyResult(plan, execResult);

      await this.ledger.logEvent({
        phase: 'VERIFY_RESULT',
        capability: plan.capability,
        inputSummary: `verified=${verification.verified}`,
        outputSummary: verification.issues.join('; ').slice(0, 200),
        success: verification.verified,
        conversationId,
      });

      const resultSummary = verification.verified
        ? `Executed ${plan.capability}: ${typeof execResult === 'string' ? execResult : JSON.stringify(execResult)}`
        : `${plan.capability} completed with issues: ${verification.issues.join(', ')}. Raw: ${JSON.stringify(execResult)}`;

      // === STEP 8: WRITE MEMORY ===
      const systemPromptForTrace = this.buildDynamicPrompt({
        mode, userInput, summary: '', capabilities: capList,
      });
      const promptTrace: PromptTrace = {
        model: args.approvedModel || this.ai.getDefaultModel(),
        systemPrompt: plan === this.parser.parse(userInput) ? '(deterministic parse — no AI call)' : systemPromptForTrace,
        framedUserMessage: userInput,
        includedMessages: [],
        createdAt: Date.now(),
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
      await this.learner.learnFromExecution(
        userInput,
        [plan.capability],
        resultSummary,
        verification.verified
      );

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
        data: { result: execResult, promptTrace },
      };
    }

    // === CONVERSATION / AI_INSTRUCTION MODE ===
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

      const promptTrace: PromptTrace = {
        model: aiResult.model,
        systemPrompt,
        framedUserMessage,
        includedMessages: finalMessages.map(m => ({ role: m.role as any, content: m.content })),
        createdAt: Date.now(),
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
        data: { promptTrace, cost: aiResult.cost },
      };
    } catch (err: any) {
      return { type: 'error', message: 'AI request failed: ' + err.message };
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

  private buildPromptTrace(
    model: string,
    systemPrompt: string,
    framedUserMessage: string,
    messages: Array<{ role: string; content: string }>
  ): PromptTrace {
    return {
      model,
      systemPrompt,
      framedUserMessage,
      includedMessages: messages.map(m => ({ role: m.role as any, content: m.content })),
      createdAt: Date.now(),
    };
  }

  hasApiKey(): boolean { return this.ai.hasApiKey(); }
  async refreshApiKey(): Promise<void> { await this.ai.refreshApiKey(); }
  getAvailableModels() { return this.ai.getAvailableModels(); }
  getDefaultModel() { return this.ai.getDefaultModel(); }
  async setDefaultModel(modelId: string) { await this.ai.setDefaultModel(modelId); }
  getCostSummary() { return this.costTracker.getSummary(); }
  async getStorageBreakdown() { return this.storage.getBreakdown(); }
  getDebugStats() { return this.debugEngine.getStats(); }
  getLearnedPatterns() { return this.learner.getTopPatterns(); }
  killSwarm(): void { this.orchestrator.killAll(); }
}

let _agentCoreInstance: AgentCore | null = null;
export function setAgentCoreInstance(core: AgentCore) { _agentCoreInstance = core; }
export function getAgentCoreInstance(): AgentCore | null { return _agentCoreInstance; }

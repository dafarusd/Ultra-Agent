import { SecureVault } from '../security/SecureVault';

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
import { Logger } from '../utils/Logger';

export interface ExecutionResult {
  type: 'result' | 'clarify' | 'confirm' | 'error';
  summary?: string;
  question?: string;
  warning?: string;
  error?: string;
  cost?: number;
  agentCount?: number;
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
  private logger: Logger;
  private history: Array<{ role: string; content: string }>;
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
    this.history = [];
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
    ]);

    await safeInit('ModelRouter', () => this.ai.initialize());
    await safeInit('DebugEngine', () => this.debugEngine.initialize());
    await safeInit('BuildSystem', () => this.buildSystem.initialize());
    await safeInit('TaskExecutor', () => this.executor.initialize());
    await safeInit('StorageBudget', () => this.storage.enforceBudget());
    await safeInit('LogCleanup', () => Logger.cleanOldLogs(7));
    await safeInit('CostCleanup', () => this.costTracker.cleanup(30));

    this.ready = true;
    this.emit('log', 'All systems online', 'agent');
  }

  private isSimpleChat(request: string): boolean {
    const actionKeywords = [
      'build', 'compile', 'file', 'read', 'write', 'delete', 'contact',
      'sms', 'text ', 'send', 'install', 'launch', 'open ', 'camera',
      'photo', 'media', 'organize', 'share', 'network', 'fetch', 'http',
      'download', 'generate code', 'create app', 'make app',
      'call ', 'email', 'remind', 'alarm', 'timer', 'lookup', 'search',
      'navigate', 'scan', 'record', 'upload', 'apk', 'run ',
    ];
    const lower = request.toLowerCase().trim();
    return lower.length < 80 && !actionKeywords.some((k) => lower.includes(k));
  }

  private buildConversationMessages(): Array<{ role: string; content: string }> {
    const systemMsg = {
      role: 'system',
      content: "You are Agent Ultra, an autonomous AI agent on a user's Android phone. You have device access including file system, contacts, SMS, camera, media, and can build Android apps on-device. Be helpful, conversational, and concise. When asked about yourself, explain your capabilities.",
    };
    const recent = this.history.slice(-20);
    return [systemMsg, ...recent];
  }

  async execute(request: string): Promise<ExecutionResult> {
    if (!this.ready) return { type: 'error', error: 'Agent not initialized' };
    if (!this.ai.hasApiKey()) return { type: 'error', error: 'Venice API key not configured. Open Settings.' };
    const taskId = Date.now().toString(36);
    this.history.push({ role: 'user', content: request });
    try {
      if (this.isSimpleChat(request)) {
        this.emit('log', 'Thinking...', 'system');
        const messages = this.buildConversationMessages();
        const r = await this.ai.completeWithConversation(messages, { taskId, agentId: 'chat' });
        this.history.push({ role: 'assistant', content: r.content });
        return { type: 'result', summary: r.content, cost: r.cost };
      }

      this.emit('log', 'Analyzing...', 'system');
      const intent = await this.analyzeIntent(request, taskId);
      if (intent.needsClarification) return { type: 'clarify', question: intent.clarification, cost: intent.cost };
      if (intent.isComplex) {
        this.emit('log', 'Complex task. Deploying swarm...', 'system');
        return this.swarmExecute(request, taskId);
      }
      return this.singleExecute(request, intent, taskId);
    } catch (e: any) {
      return { type: 'error', error: e.message };
    }
  }

  private async analyzeIntent(request: string, taskId: string): Promise<any> {
    const ctx = this.learner.getContextForAI();
    const prompt = `Analyze request, respond JSON only.\n\nRequest: "${request}"\n\n${ctx ? `User context:\n${ctx}\n\n` : ''}Capabilities:\n${this.caps.getCapabilityList()}\n\nPermissions:\n${this.perms.getStatusReport()}\n\nJSON format:\n{"clear":true,"clarification":"","capabilities":["id"],"isComplex":false,"isBuildRequest":false,"riskLevel":"safe","summary":"one line"}`;
    const r = await this.ai.complete(prompt, { taskId, agentId: 'intent', temperature: 0.3, maxTokens: 1000 });
    try {
      const p = JSON.parse(r.content);
      return {
        needsClarification: !p.clear,
        clarification: p.clarification,
        capabilities: p.capabilities || [],
        isComplex: p.isComplex || false,
        isBuildRequest: p.isBuildRequest || false,
        riskLevel: p.riskLevel || 'safe',
        summary: p.summary,
        cost: r.cost,
      };
    } catch {
      return { needsClarification: false, capabilities: ['ai_query'], isComplex: false, isBuildRequest: false, riskLevel: 'safe', summary: request, cost: r.cost };
    }
  }

  private async singleExecute(request: string, intent: any, taskId: string): Promise<ExecutionResult> {
    if (intent.riskLevel === 'dangerous') {
      return { type: 'confirm', warning: `DANGEROUS: ${intent.summary}. Caps: ${intent.capabilities.join(', ')}. Reply "yes" to proceed.`, cost: intent.cost };
    }
    if (intent.riskLevel === 'sensitive') this.emit('log', 'Sensitive operation detected.', 'system');
    if (intent.isBuildRequest) {
      this.emit('log', 'Build request. Starting pipeline...', 'system');
      const br = await this.buildSystem.buildApp(request, taskId);
      if (br.success) return { type: 'result', summary: `App built! APK: ${br.apkPath}${br.debugAttempts ? ` (${br.debugAttempts} debug rounds)` : ''}. Say "install" to install.`, cost: br.totalCost };
      return { type: 'error', error: `Build failed: ${br.error}${br.debugAttempts ? ` after ${br.debugAttempts} attempts` : ''}`, cost: br.totalCost };
    }
    const caps = intent.capabilities || [];
    if (caps.length === 1 && caps[0] === 'ai_query') {
      const messages = this.buildConversationMessages();
      const r = await this.ai.completeWithConversation(messages, { taskId, agentId: 'chat' });
      this.history.push({ role: 'assistant', content: r.content });
      return { type: 'result', summary: r.content, cost: this.costTracker.getTaskSpend(taskId) };
    }
    const result = await this.executor.run(caps, request, taskId);
    await this.learner.learnFromExecution(request, caps, result.summary, result.success);
    return { type: 'result', summary: result.summary, cost: this.costTracker.getTaskSpend(taskId) };
  }

  private async swarmExecute(request: string, taskId: string): Promise<ExecutionResult> {
    const { results, graph, totalCost } = await this.orchestrator.orchestrate(request, taskId);
    const count = graph.getSize();
    const failed = graph.getAllNodes().filter((n) => n.status === 'failed').length;
    const sr = await this.ai.complete(
      `Summarize multi-agent results in 2-3 sentences:\nRequest: "${request}"\nResults: ${JSON.stringify(results, null, 2)}`,
      { taskId, agentId: 'summarizer', maxTokens: 300 }
    );
    await this.learner.learnFromExecution(request, graph.getAllNodes().map((n) => n.description), sr.content, failed === 0);
    return { type: 'result', summary: sr.content + (failed > 0 ? ` (${failed}/${count} subtasks had issues)` : ''), cost: totalCost + sr.cost, agentCount: count };
  }

  async handleConfirmation(confirmed: boolean, originalRequest: string): Promise<ExecutionResult> {
    if (!confirmed) return { type: 'result', summary: 'Cancelled.' };
    const taskId = Date.now().toString(36);
    const intent = await this.analyzeIntent(originalRequest, taskId);
    return this.singleExecute(originalRequest, { ...intent, riskLevel: 'safe' }, taskId);
  }

  hasApiKey(): boolean { return this.ai.hasApiKey(); }

  async refreshApiKey(): Promise<void> {
    await this.ai.refreshApiKey();
  }

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

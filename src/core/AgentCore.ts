import { EventEmitter } from 'events';
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

export class AgentCore extends EventEmitter {
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
    await Promise.all([
      this.costTracker.initialize(),
      this.storage.initialize(),
      this.caps.initialize(),
      this.perms.initialize(),
      this.learner.initialize(),
    ]);
    await this.ai.initialize();
    await this.debugEngine.initialize();
    await this.buildSystem.initialize();
    await this.executor.initialize();
    await this.storage.enforceBudget();
    await Logger.cleanOldLogs(7);
    await this.costTracker.cleanup(30);
    this.ready = true;
    this.emit('log', 'All systems online', 'agent');
  }

  async execute(request: string): Promise<ExecutionResult> {
    if (!this.ready) return { type: 'error', error: 'Agent not initialized' };
    if (!this.ai.hasApiKey()) return { type: 'error', error: 'Venice API key not configured. Open Settings.' };
    const taskId = Date.now().toString(36);
    this.history.push({ role: 'user', content: request });
    try {
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
    const result = await this.executor.run(intent.capabilities, request, taskId);
    await this.learner.learnFromExecution(request, intent.capabilities, result.summary, result.success);
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

  getCostSummary() { return this.costTracker.getSummary(); }
  async getStorageBreakdown() { return this.storage.getBreakdown(); }
  getDebugStats() { return this.debugEngine.getStats(); }
  getLearnedPatterns() { return this.learner.getTopPatterns(); }
  killSwarm(): void { this.orchestrator.killAll(); }
}

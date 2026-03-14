import { SecureVault } from '../security/SecureVault';
import { Logger } from '../utils/Logger';
import { UltraDevLog as DebugLog } from '../utils/UltraDevLog';

interface CostEntry {
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  taskId: string;
  agentId: string;
}

interface CostSummary {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCalls: number;
  costByModel: Record<string, number>;
  callsByModel: Record<string, number>;
  costByDay: Record<string, number>;
}

export class CostTracker {
  private vault: SecureVault;
  private logger: Logger;
  private entries: CostEntry[];
  private dailyLimit: number;
  private taskLimit: number;
  private static readonly STORAGE_KEY = 'cost_history';
  private static readonly MAX_ENTRIES = 1000;

  constructor(vault: SecureVault) {
    this.vault = vault;
    this.logger = new Logger('CostTracker');
    this.entries = [];
    this.dailyLimit = 0;
    this.taskLimit = 0;
  }

  async initialize(): Promise<void> {
    try {
      const stored = await this.vault.get(CostTracker.STORAGE_KEY);
      if (stored) this.entries = JSON.parse(stored);
      const limit = await this.vault.get('daily_cost_limit');
      if (limit) this.dailyLimit = parseFloat(limit);
      const tLimit = await this.vault.get('task_cost_limit');
      if (tLimit) this.taskLimit = parseFloat(tLimit);
      this.logger.info(`CostTracker initialized. Daily limit: $${this.dailyLimit}`);
      DebugLog.systemEvent('CostTracker', `Initialized with ${this.entries.length} entries, daily limit $${this.dailyLimit}`);
    } catch (error: any) {
      DebugLog.error('CostTracker', 'init failed: ' + error.message);
      this.logger.error('CostTracker init failed: ' + error.message);
    }
  }

  async record(
    model: string,
    inputTokens: number,
    outputTokens: number,
    taskId: string,
    agentId: string
  ): Promise<number> {
    const rates = this.getModelRates(model);
    const cost =
      (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output;
    const entry: CostEntry = {
      timestamp: Date.now(),
      model,
      inputTokens,
      outputTokens,
      cost,
      taskId,
      agentId,
    };
    this.entries.unshift(entry);
    if (this.entries.length > CostTracker.MAX_ENTRIES) {
      this.entries = this.entries.slice(0, CostTracker.MAX_ENTRIES);
    }
    await this.persist();
    DebugLog.costRecord(model, cost, taskId);
    this.logger.debug(`Recorded: $${cost.toFixed(6)} for ${model} (task: ${taskId})`);
    return cost;
  }

  getDailySpend(): number {
    const today = new Date().toDateString();
    return this.entries
      .filter((e) => new Date(e.timestamp).toDateString() === today)
      .reduce((sum, e) => sum + e.cost, 0);
  }

  getTaskSpend(taskId: string): number {
    return this.entries
      .filter((e) => e.taskId === taskId)
      .reduce((sum, e) => sum + e.cost, 0);
  }

  isWithinDailyLimit(): boolean {
    if (this.dailyLimit <= 0) return true;
    const spent = this.getDailySpend();
    const allowed = spent < this.dailyLimit;
    DebugLog.costLimitCheck('daily', this.dailyLimit, spent, allowed);
    return allowed;
  }

  isWithinTaskLimit(taskId: string): boolean {
    if (this.taskLimit <= 0) return true;
    const spent = this.getTaskSpend(taskId);
    const allowed = spent < this.taskLimit;
    DebugLog.costLimitCheck('task', this.taskLimit, spent, allowed);
    return allowed;
  }

  getRemainingDailyBudget(): number {
    return Math.max(0, this.dailyLimit - this.getDailySpend());
  }

  getSummary(): CostSummary {
    const costByModel: Record<string, number> = {};
    const callsByModel: Record<string, number> = {};
    const costByDay: Record<string, number> = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    for (const entry of this.entries) {
      totalCost += entry.cost;
      totalInput += entry.inputTokens;
      totalOutput += entry.outputTokens;
      costByModel[entry.model] = (costByModel[entry.model] || 0) + entry.cost;
      callsByModel[entry.model] = (callsByModel[entry.model] || 0) + 1;
      const day = new Date(entry.timestamp).toDateString();
      costByDay[day] = (costByDay[day] || 0) + entry.cost;
    }
    return { totalCost, totalInputTokens: totalInput, totalOutputTokens: totalOutput, totalCalls: this.entries.length, costByModel, callsByModel, costByDay };
  }

  async setDailyLimit(limit: number): Promise<void> {
    this.dailyLimit = limit;
    await this.vault.set('daily_cost_limit', limit.toString());
    DebugLog.systemEvent('CostTracker', `Daily limit set to $${limit}`);
  }

  async setTaskLimit(limit: number): Promise<void> {
    this.taskLimit = limit;
    await this.vault.set('task_cost_limit', limit.toString());
    DebugLog.systemEvent('CostTracker', `Task limit set to $${limit}`);
  }

  private modelRatesCache: Record<string, { input: number; output: number }> = {};

  setModelRates(model: string, input: number, output: number): void {
    this.modelRatesCache[model] = { input, output };
  }

  private getModelRates(model: string): { input: number; output: number } {
    if (this.modelRatesCache[model]) return this.modelRatesCache[model];
    return { input: 0.01, output: 0.01 };
  }

  private async persist(): Promise<void> {
    try {
      await this.vault.set(CostTracker.STORAGE_KEY, JSON.stringify(this.entries));
    } catch (error: any) {
      DebugLog.error('CostTracker', 'persist failed: ' + error.message);
      this.logger.error('Failed to persist cost data: ' + error.message);
    }
  }

  async cleanup(maxAgeDays: number = 30): Promise<void> {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.timestamp > cutoff);
    if (this.entries.length < before) {
      await this.persist();
      DebugLog.systemEvent('CostTracker', `Cleaned ${before - this.entries.length} old entries`);
      this.logger.info(`Cleaned ${before - this.entries.length} old cost entries`);
    }
  }
}

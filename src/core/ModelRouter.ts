import { SecureVault } from '../security/SecureVault';
import { CostTracker } from '../services/CostTracker';
import { Logger } from '../utils/Logger';

export interface ModelDef {
  id: string;
  costPer1kInput: number;
  costPer1kOutput: number;
  maxTokens: number;
  tier: 'low' | 'medium' | 'high';
  strengths: string[];
}

interface CompletionResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

const VENICE_BASE_URL = 'https://api.venice.ai/api/v1';
const REQUEST_TIMEOUT = 60000;

export class ModelRouter {
  private vault: SecureVault;
  private costTracker: CostTracker;
  private logger: Logger;
  private apiKey: string | null = null;
  private models: Map<string, ModelDef>;
  private defaultModel: string;

  constructor(vault: SecureVault, costTracker: CostTracker) {
    this.vault = vault;
    this.costTracker = costTracker;
    this.logger = new Logger('ModelRouter');
    this.models = new Map();
    this.defaultModel = 'llama-3.3-70b';
    this.registerModel({
      id: 'llama-3.3-70b',
      costPer1kInput: 0.01,
      costPer1kOutput: 0.01,
      maxTokens: 8192,
      tier: 'high',
      strengths: ['general', 'code', 'reasoning', 'conversation'],
    });
  }

  private registerModel(m: ModelDef): void {
    this.models.set(m.id, m);
  }

  async initialize(): Promise<void> {
    await this.refreshApiKey();
  }

  async refreshApiKey(): Promise<void> {
    this.apiKey = await this.vault.get('venice_api_key');
    if (!this.apiKey) {
      const envKey = process.env.EXPO_PUBLIC_VENICE_API_KEY || null;
      if (envKey) {
        this.apiKey = envKey;
        await this.vault.set('venice_api_key', envKey);
      }
    }
    if (!this.apiKey) {
      this.logger.warn('No Venice API key configured');
    } else {
      this.logger.info('ModelRouter initialized with API key');
      await this.discoverModels();
    }
    const savedModel = await this.vault.get('preferred_model');
    if (savedModel) {
      if (this.models.has(savedModel)) {
        this.defaultModel = savedModel;
        this.logger.info(`Using preferred model: ${savedModel}`);
      } else {
        this.registerModel({
          id: savedModel,
          costPer1kInput: 0.01,
          costPer1kOutput: 0.01,
          maxTokens: 4096,
          tier: 'medium',
          strengths: [],
        });
        this.defaultModel = savedModel;
        this.logger.info(`Using saved model (not yet discovered): ${savedModel}`);
      }
    }
  }

  private async discoverModels(): Promise<void> {
    if (!this.apiKey) return;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(`${VENICE_BASE_URL}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data?.data) {
        for (const m of data.data) {
          if (!this.models.has(m.id)) {
            this.registerModel({
              id: m.id,
              costPer1kInput: 0.01,
              costPer1kOutput: 0.01,
              maxTokens: 4096,
              tier: 'medium',
              strengths: [],
            });
          }
        }
        this.logger.info(`Discovered ${data.data.length} models`);
      }
    } catch (error: any) {
      this.logger.warn('Model discovery failed: ' + error.message);
    }
  }

  selectModel(taskType: string, budget?: number): string {
    if (budget !== undefined && budget < 0.01) return this.getCheapestModel();
    const codeTypes = ['code', 'build', 'compile', 'debug', 'fix', 'write', 'create', 'develop'];
    const simpleTypes = ['classify', 'format', 'name', 'list', 'summarize', 'simple'];
    if (codeTypes.some((t) => taskType.toLowerCase().includes(t))) {
      return this.getModelByTier('high') || this.defaultModel;
    }
    if (simpleTypes.some((t) => taskType.toLowerCase().includes(t))) {
      return this.getCheapestModel();
    }
    return this.defaultModel;
  }

  private getModelByTier(tier: string): string | null {
    for (const [id, m] of this.models) {
      if (m.tier === tier) return id;
    }
    return null;
  }

  private getCheapestModel(): string {
    let cheapest = this.defaultModel;
    let lowest = Infinity;
    for (const [id, m] of this.models) {
      const avg = (m.costPer1kInput + m.costPer1kOutput) / 2;
      if (avg < lowest) {
        lowest = avg;
        cheapest = id;
      }
    }
    return cheapest;
  }

  async complete(
    prompt: string,
    options: {
      model?: string;
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
      taskId?: string;
      agentId?: string;
    } = {}
  ): Promise<CompletionResult> {
    if (!this.apiKey) {
      throw new Error('Venice API key not configured. Open Settings to add it.');
    }
    const model = options.model || this.defaultModel;
    const taskId = options.taskId || 'default';
    const agentId = options.agentId || 'main';
    if (!this.costTracker.isWithinDailyLimit()) {
      throw new Error('Daily cost limit reached. Increase in Settings or wait until tomorrow.');
    }
    if (!this.costTracker.isWithinTaskLimit(taskId)) {
      throw new Error('Task cost limit reached.');
    }
    const systemPrompt =
      options.systemPrompt ||
      "You are Agent Ultra, an autonomous AI agent on a user's Android phone. You have device access including file system, contacts, SMS, camera, media, and can build Android apps on-device. Be precise, concise, action-oriented. When generating code, provide complete compilable code with no omissions.";
    try {
      const startTime = Date.now();
      this.logger.info(`Sending request to ${model}...`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const resp = await fetch(`${VENICE_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 4000,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        if (resp.status === 401) throw new Error('Invalid Venice API key.');
        if (resp.status === 429) throw new Error('Rate limited. Wait before retrying.');
        throw new Error(`Venice API error: HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const content = data.choices[0].message.content;
      const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
      const cost = await this.costTracker.record(model, usage.prompt_tokens, usage.completion_tokens, taskId, agentId);
      this.logger.info(`${model} responded in ${Date.now() - startTime}ms, cost: $${cost.toFixed(6)}`);
      return { content, model, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, cost };
    } catch (error: any) {
      if (error.name === 'AbortError') throw new Error('Request timed out after 60s. Check your connection and try again.');
      if (error.message.includes('Venice API') || error.message.includes('Invalid') || error.message.includes('Rate limited')) throw error;
      throw new Error('AI request failed: ' + error.message);
    }
  }

  async completeWithConversation(
    messages: Array<{ role: string; content: string }>,
    options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      taskId?: string;
      agentId?: string;
    } = {}
  ): Promise<CompletionResult> {
    if (!this.apiKey) throw new Error('Venice API key not configured.');
    const model = options.model || this.defaultModel;
    const taskId = options.taskId || 'default';
    const agentId = options.agentId || 'main';
    if (!this.costTracker.isWithinDailyLimit()) throw new Error('Daily cost limit reached.');
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const resp = await fetch(`${VENICE_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 4000,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error(`Venice API error: HTTP ${resp.status}`);
      const data = await resp.json();
      const content = data.choices[0].message.content;
      const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
      const cost = await this.costTracker.record(model, usage.prompt_tokens, usage.completion_tokens, taskId, agentId);
      return { content, model, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, cost };
    } catch (error: any) {
      if (error.name === 'AbortError') throw new Error('Request timed out after 60s. Check your connection and try again.');
      throw new Error('AI conversation failed: ' + error.message);
    }
  }

  hasApiKey(): boolean {
    return this.apiKey !== null;
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async setDefaultModel(modelId: string): Promise<void> {
    if (!this.models.has(modelId)) {
      throw new Error(`Model ${modelId} not available`);
    }
    this.defaultModel = modelId;
    await this.vault.set('preferred_model', modelId);
    this.logger.info(`Default model set to: ${modelId}`);
  }

  getAvailableModels(): ModelDef[] {
    return Array.from(this.models.values());
  }
}

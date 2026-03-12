import { SecureVault } from '../security/SecureVault';
import { CostTracker } from '../services/CostTracker';
import { Logger } from '../utils/Logger';
import type { UltraModelDef } from '../types/ultra';

export interface ModelDef {
  id: string;
  name: string;
  description: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'embedding';
  costPer1kInput: number;
  costPer1kOutput: number;
  maxTokens: number;
  contextWindow: number;
  speedTier: 'fast' | 'balanced' | 'heavy';
  capabilities: {
    supportsVision: boolean;
    supportsReasoning: boolean;
    supportsFunctionCalling: boolean;
    supportsWebSearch: boolean;
    supportsMultipleImages: boolean;
    isUncensored: boolean;
  };
  offline: boolean;
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
  private baseUrl: string;

  constructor(vault: SecureVault, costTracker: CostTracker) {
    this.vault = vault;
    this.costTracker = costTracker;
    this.logger = new Logger('ModelRouter');
    this.models = new Map();
    this.defaultModel = 'llama-3.3-70b';
    this.baseUrl = VENICE_BASE_URL;
    this.registerModel({
      id: 'llama-3.3-70b',
      name: 'Llama 3.3 70B',
      description: 'Balanced performance for most use cases',
      type: 'text',
      costPer1kInput: 0.00088,
      costPer1kOutput: 0.00088,
      maxTokens: 8192,
      contextWindow: 131072,
      speedTier: 'heavy',
      capabilities: {
        supportsVision: false,
        supportsReasoning: false,
        supportsFunctionCalling: true,
        supportsWebSearch: true,
        supportsMultipleImages: false,
        isUncensored: false,
      },
      offline: false,
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
    // Load custom base URL if saved
    const savedUrl = await this.vault.get('api_base_url');
    if (savedUrl) this.baseUrl = savedUrl;

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
          name: savedModel,
          description: '',
          type: 'text',
          costPer1kInput: 0.01,
          costPer1kOutput: 0.01,
          maxTokens: 4096,
          contextWindow: 8192,
          speedTier: this.inferSpeed(savedModel),
          capabilities: {
            supportsVision: false,
            supportsReasoning: false,
            supportsFunctionCalling: false,
            supportsWebSearch: false,
            supportsMultipleImages: false,
            isUncensored: false,
          },
          offline: false,
        });
        this.defaultModel = savedModel;
        this.logger.info(`Using saved model (not yet discovered): ${savedModel}`);
      }
    }
  }

  private inferSpeed(id: string): 'fast' | 'balanced' | 'heavy' {
    const m = id.toLowerCase();
    if (m.includes('70b') || m.includes('405b') || m.includes('72b')) return 'heavy';
    if (m.includes('8b') || m.includes('mini') || m.includes('small') || m.includes('7b')) return 'fast';
    return 'balanced';
  }

  private async discoverModels(): Promise<void> {
    if (!this.apiKey) return;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
      for (const m of list) {
        const spec = m.model_spec || {};
        const caps = spec.capabilities || {};
        const pricing = spec.pricing || {};
        const validModelTypes: ModelDef['type'][] = ['text', 'image', 'video', 'audio', 'embedding'];
        const rawType = m.type || 'text';
        const modelType: ModelDef['type'] = validModelTypes.includes(rawType as ModelDef['type'])
          ? (rawType as ModelDef['type'])
          : 'text';
        const contextWindow = Number(spec.availableContextTokens ?? m.context_length ?? 8192) || 8192;
        const inputPrice = pricing.input?.usd ?? 0.01;
        const outputPrice = pricing.output?.usd ?? 0.01;
        const isUncensored = (m.id || '').toLowerCase().includes('uncensored') ||
          (m.id || '').toLowerCase().includes('role-play') ||
          (spec.privacy === 'unfiltered');

        const def: ModelDef = {
          id: m.id,
          name: spec.name || m.id,
          description: spec.description || '',
          type: modelType,
          costPer1kInput: inputPrice,
          costPer1kOutput: outputPrice,
          maxTokens: Math.min(contextWindow, 4096),
          contextWindow,
          speedTier: this.inferSpeed(m.id),
          capabilities: {
            supportsVision: caps.supportsVision ?? false,
            supportsReasoning: caps.supportsReasoning ?? false,
            supportsFunctionCalling: caps.supportsFunctionCalling ?? false,
            supportsWebSearch: caps.supportsWebSearch ?? false,
            supportsMultipleImages: caps.supportsMultipleImages ?? false,
            isUncensored,
          },
          offline: spec.offline ?? false,
        };

        this.models.set(m.id, def);
      }
      this.logger.info(`Discovered ${list.length} models`);
    } catch (error: any) {
      this.logger.warn('Model discovery failed: ' + error.message);
    }
  }

  selectModel(_taskType: string, _budget?: number): string {
    return this.defaultModel;
  }

  getModel(modelId: string): UltraModelDef | undefined {
    const m = this.models.get(modelId);
    if (!m) return undefined;
    return {
      id: m.id,
      contextWindow: m.contextWindow,
      speedTier: m.speedTier,
      strengths: [],
    };
  }

  getContextWindow(modelId?: string): number {
    const id = modelId || this.defaultModel;
    const m = this.models.get(id);
    return m?.contextWindow ?? 8192;
  }

  recommendModel(_input: any): null {
    return null;
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
      timeout?: number;
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
      const timeout = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT);
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
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
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
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

  async setBaseUrl(url: string): Promise<void> {
    this.baseUrl = url.replace(/\/+$/, '');
    await this.vault.set('api_base_url', this.baseUrl);
    this.logger.info(`API base URL set to: ${this.baseUrl}`);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getModelsByType(type: string): ModelDef[] {
    return Array.from(this.models.values()).filter(m => m.type === type);
  }

  async generateImage(
    prompt: string,
    options: {
      model?: string;
      width?: number;
      height?: number;
      steps?: number;
      stylePreset?: string;
      negativePrompt?: string;
      taskId?: string;
    } = {}
  ): Promise<{ images: string[]; model: string; cost: number }> {
    if (!this.apiKey) throw new Error('API key not configured.');
    const model = options.model || 'fluently-xl';
    const taskId = options.taskId || 'image';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      let resp: Response;
      try {
        resp = await fetch(`${this.baseUrl}/image/generate`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            prompt,
            width: options.width || 1024,
            height: options.height || 1024,
            steps: options.steps,
            style_preset: options.stylePreset,
            negative_prompt: options.negativePrompt,
            return_binary: false,
            safe_mode: false,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!resp!.ok) throw new Error(`Image generation failed: HTTP ${resp!.status}`);
      const data = await resp!.json();
      const images = data.images || [];
      const cost = await this.costTracker.record(model, 0, 0, taskId, 'image');
      return { images, model, cost };
    } catch (error: any) {
      if (error.name === 'AbortError') throw new Error('Image generation timed out.');
      throw new Error('Image generation failed: ' + error.message);
    }
  }
}

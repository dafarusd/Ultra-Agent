import { SecureVault } from '../security/SecureVault';
import { CostTracker } from '../services/CostTracker';
import { Logger } from '../utils/Logger';
import { UltraDevLog as DebugLog } from '../utils/UltraDevLog';
import { classifyModelType } from '../utils/classifyModelType';
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
  private activeController: AbortController | null = null;
  private hasDiscoveredModels = false;

  constructor(vault: SecureVault, costTracker: CostTracker) {
    this.vault = vault;
    this.costTracker = costTracker;
    this.logger = new Logger('ModelRouter');
    this.models = new Map();
    this.defaultModel = '';
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
    const savedUrl = await this.vault.get('api_base_url');
    if (savedUrl) this.baseUrl = savedUrl;

    if (!this.apiKey) {
      this.logger.warn('No Venice API key configured');
    } else {
      this.logger.info('ModelRouter initialized with API key');
      DebugLog.systemEvent('ModelRouter', 'Initialized with API key');
      if (!this.hasDiscoveredModels) {
        await this.discoverModels();
        this.hasDiscoveredModels = true;
      }
    }
    const savedModel = await this.vault.get('preferred_model');
    if (savedModel) {
      if (this.models.has(savedModel)) {
        const prev = this.defaultModel;
        this.defaultModel = savedModel;
        DebugLog.modelSetDefault(savedModel, prev, 'vault_restore');
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
        const prev = this.defaultModel;
        this.defaultModel = savedModel;
        DebugLog.modelSetDefault(savedModel, prev, 'vault_restore_undiscovered');
        this.logger.info(`Using saved model (not yet discovered): ${savedModel}`);
      }
    }
    if (!this.defaultModel && this.hasDiscoveredModels) {
      const textModels = [...this.models.values()].filter(m => m.type === 'text');
      if (textModels.length > 0) {
        this.defaultModel = textModels[0].id;
        DebugLog.modelSetDefault(textModels[0].id, '', 'auto_pick_first');
        this.logger.info(`Auto-picked default model: ${textModels[0].id}`);
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
    DebugLog.modelDiscoveryStart(this.baseUrl);
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
        const rawApiType = m.type || spec.type || '';
        const classifiedType = classifyModelType(m.id, m.name || m.id, rawApiType);
        const modelType: ModelDef['type'] = (classifiedType && validModelTypes.includes(classifiedType as ModelDef['type']))
          ? (classifiedType as ModelDef['type'])
          : validModelTypes.includes(rawType as ModelDef['type'])
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

      // Log classification breakdown using classifyModelType
      const breakdown: Record<string, number> = {};
      for (const [, model] of this.models) {
        const cat = classifyModelType(model.id, model.name, model.type);
        breakdown[cat] = (breakdown[cat] || 0) + 1;
      }
      DebugLog.modelState('picker_classification', breakdown);

      DebugLog.modelDiscoveryResult(list.length, list.map((m: any) => m.id));
      DebugLog.modelState("post_discovery", {
        discoveredCount: this.models.size,
        defaultModel: this.defaultModel,
        hasApiKey: !!this.apiKey,
        baseUrl: this.baseUrl,
        modelIds: Array.from(this.models.keys()).slice(0, 20),
      });
    } catch (error: any) {
      DebugLog.modelDiscoveryError(error.message);
      DebugLog.modelState("discovery_failed", {
        discoveredCount: this.models.size,
        defaultModel: this.defaultModel,
        hasApiKey: !!this.apiKey,
        baseUrl: this.baseUrl,
      });
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
    if (!options.model && !this.defaultModel) {
      const textModels = [...this.models.values()].filter(m => m.type === 'text');
      if (textModels.length > 0) {
        this.defaultModel = textModels[0].id;
        DebugLog.modelSetDefault(textModels[0].id, '', 'auto_pick_complete');
      } else {
        throw new Error('No model selected. Open Settings > API Setup to configure a model.');
      }
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

    const promptTokens = Math.ceil((prompt.length + systemPrompt.length) / 4);
    DebugLog.modelApiRequest(model, taskId, promptTokens, options.maxTokens ?? 4000);
    DebugLog.convContextSent(taskId, model, {
      system_prompt_chars: systemPrompt.length,
      history_message_count: 0,
      history_chars: 0,
      capability_context_chars: 0,
      user_message_chars: prompt.length,
      estimated_total_tokens: promptTokens,
    });
    const startTime = Date.now();
    try {
      this.logger.info(`Sending request to ${model}...`);
      const controller = new AbortController();
      this.activeController = controller;
      const timeout = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT);
      const apiPayload = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4000,
      };
      DebugLog.systemEvent('ModelRouter.complete', `API_PAYLOAD model=${model} task=${taskId} system_chars=${systemPrompt.length} user_chars=${prompt.length} temp=${apiPayload.temperature} max_tokens=${apiPayload.max_tokens}`);
      const fetchStartMs = Date.now();
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(apiPayload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      this.activeController = null;
      if (!resp.ok) {
        if (resp.status === 401) throw new Error('Invalid Venice API key.');
        if (resp.status === 429) throw new Error('Rate limited. Wait before retrying.');
        throw new Error(`Venice API error: HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const content = data.choices[0].message.content;
      const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
      const cost = await this.costTracker.record(model, usage.prompt_tokens, usage.completion_tokens, taskId, agentId);
      const durationMs = Date.now() - startTime;
      const fetchDurationMs = Date.now() - fetchStartMs;
      DebugLog.modelApiResponse(model, taskId, usage.prompt_tokens, usage.completion_tokens, cost, durationMs);
      DebugLog.push('NET_DETAIL', { method: 'POST', url: '/chat/completions', status: resp.status, durationMs: fetchDurationMs, bodyBytes: JSON.stringify(apiPayload).length, model, taskId });
      this.logger.info(`${model} responded in ${durationMs}ms, cost: $${cost.toFixed(6)}`);
      return { content, model, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, cost };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      DebugLog.modelApiError(model, taskId, error.message, durationMs);
      if (error.name === 'AbortError') {
        if (this.activeController === null) {
          throw new Error('Request stopped by user.');
        }
        throw new Error('Request timed out after 60s. Check your connection and try again.');
      }
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

    const totalChars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
    const systemMsgs = messages.filter(m => m.role === 'system');
    const historyMsgs = messages.filter(m => m.role !== 'system');
    const systemChars = systemMsgs.reduce((s, m) => s + (m.content?.length ?? 0), 0);
    const historyChars = historyMsgs.reduce((s, m) => s + (m.content?.length ?? 0), 0);
    DebugLog.modelApiRequest(model, taskId, Math.ceil(totalChars / 4), options.maxTokens ?? 4000);
    DebugLog.convContextSent(taskId, model, {
      system_prompt_chars: systemChars,
      history_message_count: historyMsgs.length,
      history_chars: historyChars,
      capability_context_chars: 0,
      user_message_chars: historyMsgs.length > 0 ? (historyMsgs[historyMsgs.length - 1].content?.length ?? 0) : 0,
      estimated_total_tokens: Math.ceil(totalChars / 4),
    });
    const callStart = Date.now();
    try {
      const controller = new AbortController();
      this.activeController = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const convPayload = {
        model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4000,
      };
      DebugLog.systemEvent('ModelRouter.completeWithConversation', `API_PAYLOAD model=${model} task=${taskId} msg_count=${messages.length} total_chars=${totalChars} temp=${convPayload.temperature} max_tokens=${convPayload.max_tokens}`);
      const convFetchStartMs = Date.now();
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(convPayload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      this.activeController = null;
      if (!resp.ok) throw new Error(`Venice API error: HTTP ${resp.status}`);
      const data = await resp.json();
      const content = data.choices[0].message.content;
      const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
      const cost = await this.costTracker.record(model, usage.prompt_tokens, usage.completion_tokens, taskId, agentId);
      const durationMs = Date.now() - callStart;
      const convFetchDurationMs = Date.now() - convFetchStartMs;
      DebugLog.modelApiResponse(model, taskId, usage.prompt_tokens, usage.completion_tokens, cost, durationMs);
      DebugLog.push('NET_DETAIL', { method: 'POST', url: '/chat/completions', status: resp.status, durationMs: convFetchDurationMs, bodyBytes: JSON.stringify(convPayload).length, model, taskId });
      return { content, model, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, cost };
    } catch (error: any) {
      const durationMs = Date.now() - callStart;
      DebugLog.modelApiError(model, taskId, error.message, durationMs);
      if (error.name === 'AbortError') {
        if (this.activeController === null) {
          throw new Error('Request stopped by user.');
        }
        throw new Error('Request timed out after 60s. Check your connection and try again.');
      }
      throw new Error('AI conversation failed: ' + error.message);
    }
  }

  abortCurrentRequest(): void {
    if (this.activeController) {
      const model = this.defaultModel;
      this.activeController.abort();
      this.activeController = null;
      DebugLog.modelAbort(model);
      this.logger.info('Request aborted by user');
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
      DebugLog.modelSetDefaultError(modelId, 'Model not available');
      throw new Error(`Model ${modelId} not available`);
    }
    const prev = this.defaultModel;
    this.defaultModel = modelId;
    await this.vault.set('preferred_model', modelId);
    DebugLog.modelSetDefault(modelId, prev, 'setDefaultModel');
    this.logger.info(`Default model set to: ${modelId}`);
  }

  getAvailableModels(): ModelDef[] {
    return Array.from(this.models.values());
  }

  canHandleLocally(taskType: string): boolean {
    const local = Array.from(this.models.values()).filter(m => m.offline);
    if (local.length === 0) return false;
    const t = taskType.toLowerCase();
    if (t === 'text' || t === 'conversation' || t === 'chat') {
      return local.some(m => m.type === 'text');
    }
    return local.some(m => m.type === t);
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
    DebugLog.modelImageRequest(model, prompt.length);
    const startTime = Date.now();
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
      DebugLog.modelImageResponse(model, images.length, cost, Date.now() - startTime);
      return { images, model, cost };
    } catch (error: any) {
      DebugLog.modelImageError(model, error.message);
      if (error.name === 'AbortError') throw new Error('Image generation timed out.');
      throw new Error('Image generation failed: ' + error.message);
    }
  }
}

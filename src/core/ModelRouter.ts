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

export interface ModelRecommendation {
  recommended: string;
  reason: string;
}

interface CompletionResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

const REQUEST_TIMEOUT = 60000;

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  categories: string[];
  isActive: boolean;
  models: ModelDef[];
}

interface CategoryDefault {
  modelId: string;
  providerId: string;
}


interface RouteResolution {
  modelId: string;
  apiKey: string;
  baseUrl: string;
}


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
  private providers: Map<string, ProviderConfig> = new Map();
  private categoryDefaults: Map<string, CategoryDefault> = new Map();

  constructor(vault: SecureVault, costTracker: CostTracker) {
    this.vault = vault;
    this.costTracker = costTracker;
    this.logger = new Logger('ModelRouter');
    this.models = new Map();
    this.defaultModel = '';
    this.baseUrl = '';
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
    // Load from first active provider in the provider list
    const savedApis = await this.vault.get('saved_apis').catch(() => null);
    if (savedApis) {
      try {
        const providers: Array<{ id: string; apiKey?: string; baseUrl?: string; isActive?: boolean }> = JSON.parse(savedApis);
        const active = providers.find(p => p.isActive !== false && p.apiKey);
        if (active) {
          this.apiKey = active.apiKey || null;
          if (active.baseUrl) this.baseUrl = this.normalizeBaseUrl(active.baseUrl);
        }
      } catch {}
    }
    const savedUrl = await this.vault.get('api_base_url');
    if (savedUrl) this.baseUrl = this.normalizeBaseUrl(savedUrl);

    if (!this.apiKey) {
      this.logger.warn('No AI provider API key configured');
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

  async loadProviders(): Promise<void> {
    try {
      const savedApis = await this.vault.get('saved_apis');
      if (!savedApis) return;
      const providers: Array<{
        id: string; name: string; baseUrl: string; apiKey: string;
        categories: string[]; isActive: boolean;
      }> = JSON.parse(savedApis);

      for (const p of providers) {
        if (!p.isActive || !p.apiKey) continue;
        const config: ProviderConfig = {
          id: p.id, name: p.name, baseUrl: p.baseUrl,
          apiKey: p.apiKey, categories: p.categories || ['text'],
          isActive: true, models: [],
        };
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 12000);
          const resp = await fetch(`${p.baseUrl}/models`, {
            headers: { 'Authorization': `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (resp.ok) {
            const data = await resp.json();
            const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
            for (const m of list) {
              const spec = m.model_spec || {};
              const caps = spec.capabilities || {};
              const pricing = spec.pricing || {};
              const rawType = m.type || spec.type || 'text';
              const classifiedType = classifyModelType(m.id, m.name || m.id, rawType, caps);
              const validTypes: ModelDef['type'][] = ['text', 'image', 'video', 'audio', 'embedding'];
              const modelType: ModelDef['type'] = validTypes.includes(classifiedType as any) ? classifiedType as ModelDef['type'] : validTypes.includes(rawType as any) ? rawType as ModelDef['type'] : 'text';
              const def: ModelDef = {
                id: m.id, name: spec.name || m.name || m.id, description: spec.description || '',
                type: modelType, costPer1kInput: pricing.input?.usd ?? 0.01, costPer1kOutput: pricing.output?.usd ?? 0.01,
                maxTokens: Math.min(Number(spec.availableContextTokens ?? m.context_length ?? 8192) || 8192, 4096),
                contextWindow: Number(spec.availableContextTokens ?? m.context_length ?? 8192) || 8192,
                speedTier: this.inferSpeed(m.id),
                capabilities: {
                  supportsVision: caps.supportsVision ?? false, supportsReasoning: caps.supportsReasoning ?? false,
                  supportsFunctionCalling: caps.supportsFunctionCalling ?? false, supportsWebSearch: caps.supportsWebSearch ?? false,
                  supportsMultipleImages: caps.supportsMultipleImages ?? false,
                  isUncensored: (m.id || '').toLowerCase().includes('uncensored') || spec.privacy === 'unfiltered',
                },
                offline: spec.offline ?? false,
              };
              config.models.push(def);
              this.models.set(m.id, def);
            }
          }
          DebugLog.push('SYSTEM' as any, { event: 'provider_discovered', provider: p.name, models: config.models.length });
        } catch (e: any) {
          DebugLog.error('ModelRouter', `Provider ${p.name} discovery failed: ${e.message}`);
        }
        this.providers.set(p.id, config);
      }

      DebugLog.push('SYSTEM' as any, { event: 'providers_loaded', count: this.providers.size, totalModels: this.models.size });
    } catch (e: any) {
      DebugLog.error('ModelRouter', `loadProviders failed: ${e.message}`);
    }
  }

  private findProviderForModel(modelId: string): ProviderConfig | null {
    for (const [, p] of this.providers) {
      if (p.models.some(m => m.id === modelId)) return p;
    }
    return null;
  }

  getModelForCategory(category: string): { modelId: string; baseUrl: string; apiKey: string } | null {
    const catDefault = this.categoryDefaults.get(category);
    if (catDefault) {
      const provider = this.providers.get(catDefault.providerId);
      if (provider && provider.isActive && provider.apiKey) {
        return { modelId: catDefault.modelId, baseUrl: provider.baseUrl, apiKey: provider.apiKey };
      }
    }
    if (this.apiKey && this.defaultModel) {
      return { modelId: this.defaultModel, baseUrl: this.baseUrl, apiKey: this.apiKey };
    }
    return null;
  }

  getAllModelsWithProvider(): Array<ModelDef & { providerId: string; providerName: string }> {
    const result: Array<ModelDef & { providerId: string; providerName: string }> = [];
    for (const [, p] of this.providers) {
      for (const m of p.models) result.push({ ...m, providerId: p.id, providerName: p.name });
    }
    if (result.length === 0) {
      for (const [, m] of this.models) result.push({ ...m, providerId: 'primary', providerName: 'Primary' });
    }
    return result;
  }

  getProviders(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  private async discoverModels(): Promise<void> {
    if (!this.apiKey) return;
    DebugLog.modelDiscoveryStart(this.baseUrl);
    try {
      const effectiveApiKey = this.apiKey!;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${effectiveApiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const sample = (Array.isArray(data?.data) ? data.data : []).slice(0, 3).map((m: any) => ({
        id: m.id,
        type: m.type,
        object: m.object,
        specType: m.model_spec?.type,
        specName: m.model_spec?.name,
        caps: m.model_spec?.capabilities ? Object.fromEntries(Object.entries(m.model_spec.capabilities).filter(([_, v]) => v === true)) : null,
        pricing: m.model_spec?.pricing,
      }));
      DebugLog.push('NET_MODELS_RAW', { totalCount: (data?.data || []).length, sample });
      const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
      for (const m of list) {
        const spec = m.model_spec || {};
        const caps = spec.capabilities || {};
        const pricing = spec.pricing || {};
        const validModelTypes: ModelDef['type'][] = ['text', 'image', 'video', 'audio', 'embedding'];
        const rawType = m.type || 'text';
        const rawApiType = m.type || spec.type || '';
        const classifiedType = classifyModelType(m.id, m.name || m.id, rawApiType, caps);
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

      // Log per-model classification detail
      const classificationLog: Array<{ id: string; apiType: string; classified: string; caps: string }> = [];
      for (const [modelId, model] of this.models) {
        classificationLog.push({
          id: modelId,
          apiType: model.type,
          classified: classifyModelType(modelId, model.name, model.type, model.capabilities),
          caps: Object.entries(model.capabilities).filter(([_, v]) => v === true).map(([k]) => k).join(','),
        });
      }
      DebugLog.push('MODEL_DISCOVERY_DETAIL', { models: classificationLog });

      // Log classification breakdown using classifyModelType
      const breakdown: Record<string, number> = {};
      for (const [, model] of this.models) {
        const cat = classifyModelType(model.id, model.name, model.type, model.capabilities);
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


  private isValidHttpUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }


  private normalizeBaseUrl(url: string | null | undefined): string {
    if (!this.isValidHttpUrl(url)) return '';
    return String(url).replace(/\/+$/, '');
  }


  private normalizeCategory(category: string | undefined | null): string {
    if (!category) return '';
    const raw = category.toLowerCase();
    if (raw === 'conversation' || raw === 'chat' || raw === 'text') return 'chat';
    if (raw === 'agent_action') return 'reasoning';
    return raw;
  }


  private getCategoryForAgent(agentId: string | undefined, explicitCategory?: string): string {
    const normalizedExplicit = this.normalizeCategory(explicitCategory);
    if (normalizedExplicit) return normalizedExplicit;
    const agentCategoryMap: Record<string, string> = {
      cortex_planner: 'reasoning',
      cortex_reasoner: 'reasoning',
      multistep_planner: 'reasoning',
      context_analyst: 'chat',
      diagnostician: 'chat',
      app_intel: 'chat',
      app_extractor: 'chat',
      vision: 'chat',
      kg_extractor: 'chat',
      intent_parser: 'chat',
      proactive: 'chat',
      correction: 'chat',
      chat: 'chat',
      main: 'chat',
      codegen: 'reasoning',
    };
    return agentId ? (agentCategoryMap[agentId] || '') : '';
  }


  private findRoutingForModel(modelId: string): RouteResolution | null {
    const provider = this.findProviderForModel(modelId);
    if (!provider) return null;
    return {
      modelId,
      apiKey: provider.apiKey,
      baseUrl: this.normalizeBaseUrl(provider.baseUrl),
    };
  }


  private resolveRoute(options: { requestedModel?: string; category?: string; agentId?: string }): RouteResolution {
    const requestedModel = options.requestedModel || '';
    if (requestedModel) {
      const explicit = this.findRoutingForModel(requestedModel);
      if (explicit) return explicit;
      return { modelId: requestedModel, apiKey: this.apiKey || '', baseUrl: this.baseUrl };
    }

    const category = this.getCategoryForAgent(options.agentId, options.category);
    if (category) {
      const catRoute = this.getModelForCategory(category);
      if (catRoute) {
        return {
          modelId: catRoute.modelId,
          apiKey: catRoute.apiKey,
          baseUrl: this.normalizeBaseUrl(catRoute.baseUrl),
        };
      }
    }

    const fallbackModel = this.defaultModel || requestedModel;
    const discoveredFallback = fallbackModel ? this.findRoutingForModel(fallbackModel) : null;
    if (discoveredFallback) return discoveredFallback;
    return {
      modelId: fallbackModel,
      apiKey: this.apiKey || '',
      baseUrl: this.baseUrl,
    };
  }


  private getCandidateTextModels(): ModelDef[] {
    return [...this.models.values()].filter(m => m.type === 'text');
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


  recommendModel(input: { taskType?: string; requiredContextTokens?: number; currentModel?: string }): ModelRecommendation | null {
    const textModels = this.getCandidateTextModels();
    if (textModels.length === 0) return null;

    const currentModelId = input.currentModel || this.defaultModel;
    const current = currentModelId ? this.models.get(currentModelId) : undefined;
    const taskType = (input.taskType || 'conversation').toLowerCase();
    const requiredContextTokens = Math.max(0, Number(input.requiredContextTokens || 0));

    let target: ModelDef | undefined = current && current.type === 'text' ? current : undefined;
    let reason = '';

    if (requiredContextTokens > 0) {
      const contextEligible = textModels
        .filter(m => m.contextWindow >= requiredContextTokens)
        .sort((a, b) => a.contextWindow - b.contextWindow || a.maxTokens - b.maxTokens);
      if (contextEligible.length > 0) {
        const bestFit = contextEligible[0];
        if (!target || target.contextWindow < requiredContextTokens || target.contextWindow > bestFit.contextWindow * 2) {
          target = bestFit;
          reason = `It better matches the required context window (${requiredContextTokens} tokens).`;
        }
      }
    }

    if (taskType === 'code' || taskType === 'agent_action' || taskType === 'reasoning') {
      const reasoningModel = textModels
        .filter(m => m.capabilities.supportsReasoning)
        .sort((a, b) => b.contextWindow - a.contextWindow || b.maxTokens - a.maxTokens)[0];
      if (reasoningModel && reasoningModel.id !== currentModelId) {
        if (!target || !target.capabilities.supportsReasoning) {
          target = reasoningModel;
          reason = 'It is better suited for structured reasoning and multi-step work.';
        }
      }
    }

    if (taskType === 'image') {
      const uncensoredTextModel = textModels.find(m => m.capabilities.isUncensored) || textModels.find(m => m.capabilities.supportsFunctionCalling);
      if (uncensoredTextModel && uncensoredTextModel.id !== currentModelId) {
        if (!target || target.type !== 'text') {
          target = uncensoredTextModel;
        }
        reason = reason || 'It is a safer text-model choice for planning image generation prompts.';
      }
    }

    if (!target) {
      target = textModels.sort((a, b) => b.contextWindow - a.contextWindow || b.maxTokens - a.maxTokens)[0];
      reason = reason || 'It is the strongest available general text model.';
    }

    if (!target || !currentModelId || target.id === currentModelId) return null;
    return { recommended: target.id, reason };
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
      category?: string;
    } = {}
  ): Promise<CompletionResult> {
    if (!this.apiKey) {
      throw new Error('No AI provider configured. Open Settings → AI Providers to add one.');
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
    const route = this.resolveRoute({ requestedModel: options.model || model, category: options.category, agentId });
    const effectiveModel = route.modelId || model;
    const effectiveApiKey = route.apiKey || this.apiKey;
    const effectiveBaseUrl = route.baseUrl || this.baseUrl;

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
    DebugLog.modelApiRequest(effectiveModel, taskId, promptTokens, options.maxTokens ?? 4000);
    DebugLog.convContextSent(taskId, effectiveModel, {
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
        model: effectiveModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4000,
      };
      DebugLog.systemEvent('ModelRouter.complete', `API_PAYLOAD model=${effectiveModel} task=${taskId} system_chars=${systemPrompt.length} user_chars=${prompt.length} temp=${apiPayload.temperature} max_tokens=${apiPayload.max_tokens}`);
      const fetchStartMs = Date.now();
      const resp = await fetch(`${effectiveBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${effectiveApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(apiPayload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      this.activeController = null;
      if (!resp.ok) {
        if (resp.status === 401) throw new Error('Invalid API key. Check your provider settings.');
        if (resp.status === 429) throw new Error('Rate limited. Wait before retrying.');
        throw new Error(`AI provider error: HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const content = data.choices[0].message.content;
      const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
      const cost = await this.costTracker.record(effectiveModel, usage.prompt_tokens, usage.completion_tokens, taskId, agentId);
      const durationMs = Date.now() - startTime;
      const fetchDurationMs = Date.now() - fetchStartMs;
      DebugLog.modelApiResponse(effectiveModel, taskId, usage.prompt_tokens, usage.completion_tokens, cost, durationMs);
      DebugLog.push('NET_DETAIL', { method: 'POST', url: '/chat/completions', status: resp.status, durationMs: fetchDurationMs, bodyBytes: JSON.stringify(apiPayload).length, model: effectiveModel, taskId });
      this.logger.info(`${effectiveModel} responded in ${durationMs}ms, cost: $${cost.toFixed(6)}`);
      return { content, model: effectiveModel, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, cost };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      DebugLog.modelApiError(effectiveModel, taskId, error.message, durationMs);
      if (error.name === 'AbortError') {
        if (this.activeController === null) {
          throw new Error('Request stopped by user.');
        }
        throw new Error('Request timed out after 60s. Check your connection and try again.');
      }
      if (error.message.includes('AI provider') || error.message.includes('Invalid') || error.message.includes('Rate limited')) throw error;
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
      category?: string;
    } = {}
  ): Promise<CompletionResult> {
    if (!this.apiKey) throw new Error('No AI provider configured. Open Settings → AI Providers to add one.');
    const taskId = options.taskId || 'default';
    const agentId = options.agentId || 'main';
    if (!this.costTracker.isWithinDailyLimit()) throw new Error('Daily cost limit reached.');
    const route = this.resolveRoute({ requestedModel: options.model || this.defaultModel, category: options.category, agentId });
    const model = route.modelId || options.model || this.defaultModel;
    const effectiveApiKey = route.apiKey || this.apiKey;
    const effectiveBaseUrl = route.baseUrl || this.baseUrl;

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
      const resp = await fetch(`${effectiveBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${effectiveApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(convPayload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      this.activeController = null;
      if (!resp.ok) {
        if (resp.status === 401) throw new Error('Invalid API key. Check your provider settings.');
        if (resp.status === 429) throw new Error('Rate limited. Wait before retrying.');
        throw new Error(`AI provider error: HTTP ${resp.status}`);
      }
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
      if (error.message.includes('AI provider') || error.message.includes('Invalid') || error.message.includes('Rate limited')) throw error;
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

  async completeWithVision(
    textPrompt: string,
    imageBase64: string,
    mimeType: string = 'image/jpeg',
    options: {
      model?: string;
      maxTokens?: number;
      taskId?: string;
      agentId?: string;
    } = {}
  ): Promise<CompletionResult> {
    if (!this.apiKey) throw new Error('No AI provider configured. Open Settings → AI Providers to add one.');

    let model = options.model || '';
    if (!model) {
      const visionModels = [...this.models.values()].filter(m => m.capabilities.supportsVision && m.type === 'text');
      if (visionModels.length > 0) {
        model = visionModels[0].id;
      } else {
        model = this.defaultModel;
      }
    }

    const taskId = options.taskId || 'vision';
    const agentId = options.agentId || 'vision';
    DebugLog.systemEvent('ModelRouter', `Vision request: model=${model} imageSize=${imageBase64.length} prompt="${textPrompt.slice(0, 80)}"`);

    const messages = [
      { role: 'system', content: 'You are Agent Ultra, an autonomous AI agent. Analyze the image and respond to the user\'s request precisely and concisely.' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          { type: 'text', text: textPrompt || 'What do you see in this image?' },
        ],
      },
    ];

    const callStart = Date.now();
    try {
      const controller = new AbortController();
      this.activeController = controller;
      const timeout = setTimeout(() => controller.abort(), 90000);
      const payload = {
        model,
        messages,
        temperature: 0.4,
        max_tokens: options.maxTokens ?? 2000,
      };
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      this.activeController = null;
      if (!resp.ok) throw new Error(`Vision API error: HTTP ${resp.status}`);
      const data = await resp.json();
      const content = data.choices[0].message.content;
      const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
      const cost = await this.costTracker.record(model, usage.prompt_tokens, usage.completion_tokens, taskId, agentId);
      DebugLog.modelApiResponse(model, taskId, usage.prompt_tokens, usage.completion_tokens, cost, Date.now() - callStart);
      return { content, model, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, cost };
    } catch (error: any) {
      DebugLog.modelApiError(model, taskId, error.message, Date.now() - callStart);
      throw new Error('Vision request failed: ' + error.message);
    }
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
    this.baseUrl = this.normalizeBaseUrl(url);
    if (this.baseUrl) {
      await this.vault.set('api_base_url', this.baseUrl);
    } else {
      await this.vault.delete('api_base_url').catch(() => {});
    }
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

// AiService — all AI/media operations route through TaskDefaultsManager + AdapterRegistry
// Replaces GroupRouter-based routing with fail-closed task-default routing.

import type {
  AllowedOperation,
  NormalizedAiResponse,
  NormalizedImageResponse,
  NormalizedAudioResponse,
  NormalizedVideoJob,
  NormalizedVideoResult,
  NormalizedEmbeddingsResponse,
  AdapterResult,
  ResolvedRoute,
  ApiProvider,
} from '../../types/provider';
import type { ProviderManager } from './ProviderManager';
import type { TaskDefaultsManager, TaskModelCandidate } from './TaskDefaultsManager';
import { getAdapterRegistry } from './AdapterRegistry';
import type {
  ChatMessage,
  ChatOptions,
  ImageOptions,
  SpeechOptions,
  VideoOptions,
  EmbeddingsOptions,
} from './CapabilityAdapters';
import { UltraDevLog } from '../../utils/UltraDevLog';

const FAIL_CLOSED_MSG =
  'No model is configured for this task. Open Settings → AI Providers → Task Defaults and assign a provider + model.';

function routeLogFields(route: ResolvedRoute): Record<string, unknown> {
  return {
    providerId: route.providerId,
    providerName: route.providerName,
    modelId: route.modelId,
    adapterId: route.adapterId,
    operation: route.operation,
  };
}

export interface TextCompletionInput {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  conversationId?: string;
  groupId?: string; // legacy field — ignored, kept for API compat
  tags?: string[];
  taskId?: string;
  agentId?: string;
}

export interface ImageGenerationInput {
  prompt: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  negativePrompt?: string;
  stylePreset?: string;
  conversationId?: string;
  groupId?: string;
  tags?: string[];
  taskId?: string;
}

export interface SpeechInput {
  text: string;
  model?: string;
  voice?: string;
  conversationId?: string;
  groupId?: string;
  tags?: string[];
  taskId?: string;
}

export interface VideoInput {
  prompt: string;
  model?: string;
  imageBase64?: string;
  duration?: number;
  conversationId?: string;
  groupId?: string;
  tags?: string[];
  taskId?: string;
}

export interface EmbeddingsInput {
  input: string | string[];
  model?: string;
  conversationId?: string;
  groupId?: string;
  tags?: string[];
  taskId?: string;
}

export class AiService {
  private providerManager: ProviderManager;
  private taskDefaults: TaskDefaultsManager;

  constructor(providerManager: ProviderManager, taskDefaults: TaskDefaultsManager) {
    this.providerManager = providerManager;
    this.taskDefaults = taskDefaults;
  }

  getTaskDefaultsManager(): TaskDefaultsManager {
    return this.taskDefaults;
  }

  // Build a ResolvedRoute for the given provider + model + operation.
  // Returns null if the provider lacks a valid adapter or API key.
  private async buildRoute(
    provider: ApiProvider,
    modelId: string,
    operation: AllowedOperation
  ): Promise<ResolvedRoute | null> {
    const apiKey = await this.providerManager.getApiKey(provider);
    if (!apiKey && provider.authMode !== 'none') return null;
    const password = provider.authMode === 'basic'
      ? await this.providerManager.getPassword(provider)
      : null;
    const registry = getAdapterRegistry();
    const adapter = registry.getForOperation(provider.capabilities.adapterIds, operation);
    if (!adapter) return null;
    return {
      providerId: provider.id,
      providerName: provider.name,
      modelId,
      adapterId: adapter.id,
      operation,
      selectionStrategy: 'priority',
      apiKey: apiKey ?? '',
      baseUrl: provider.baseUrl,
      authMode: provider.authMode,
      customAuthHeaderName: provider.customAuthHeaderName,
      customAuthHeaderPrefix: provider.customAuthHeaderPrefix,
      password,
    };
  }

  // Resolve a route for the given operation. Resolution order:
  //   1. Manual model override (input.model) → find provider that has this model
  //   2. Task defaults primary candidate
  //   3. Task defaults fallback candidates (in order)
  //   4. Fail closed — throw visible error
  private async resolveRoute(
    operation: AllowedOperation,
    opts: { manualModelId?: string; conversationId?: string }
  ): Promise<ResolvedRoute> {
    const activeProviders = this.providerManager.getActive();
    if (activeProviders.length === 0) {
      throw new Error(
        'No active providers configured. Open Settings → AI Providers and add a provider with an API key.'
      );
    }

    // Path A — manual model override (selected via chat picker)
    if (opts.manualModelId) {
      for (const provider of activeProviders) {
        const discoveredModels = this.providerManager.getModelsForProvider(provider.id);
        const hasModel =
          discoveredModels.some(m => m.id === opts.manualModelId) ||
          (provider.manualModelIds ?? []).includes(opts.manualModelId!);
        if (!hasModel) continue;
        const route = await this.buildRoute(provider, opts.manualModelId, operation);
        if (route) {
          UltraDevLog.push('ROUTE', {
            event: 'route_resolved',
            step: 'manual_override',
            ...routeLogFields(route),
          });
          return route;
        }
      }
      // Manual model not found in any provider — fall through to task defaults
      UltraDevLog.push('ROUTE', {
        event: 'manual_model_not_matched',
        manualModelId: opts.manualModelId,
        operation,
        note: 'falling through to task defaults',
      });
    }

    // Path B — task defaults (primary + fallbacks)
    const candidates: TaskModelCandidate[] = this.taskDefaults.getCandidates(operation);
    UltraDevLog.push('ROUTE', {
      event: 'route_attempt_task_defaults',
      operation,
      candidateCount: candidates.length,
      candidates: candidates.map(c => `${c.providerId}/${c.modelId}`),
    });

    for (const candidate of candidates) {
      const provider = activeProviders.find(p => p.id === candidate.providerId);
      if (!provider) {
        UltraDevLog.push('ROUTE', {
          event: 'candidate_skip',
          reason: 'provider_not_active',
          ...candidate,
          operation,
        });
        continue;
      }
      const route = await this.buildRoute(provider, candidate.modelId, operation);
      if (route) {
        UltraDevLog.push('ROUTE', {
          event: 'route_resolved',
          step: 'task_default',
          ...routeLogFields(route),
        });
        return route;
      }
      UltraDevLog.push('ROUTE', {
        event: 'candidate_skip',
        reason: 'no_adapter_or_key',
        ...candidate,
        operation,
      });
    }

    // Fail closed
    UltraDevLog.push('ROUTE', {
      event: 'route_fail_closed',
      operation,
      candidateCount: candidates.length,
      activeProviderCount: activeProviders.length,
    });
    throw new Error(FAIL_CLOSED_MSG);
  }

  async completeText(input: TextCompletionInput): Promise<NormalizedAiResponse> {
    const route = await this.resolveRoute('chat', {
      manualModelId: input.model,
      conversationId: input.conversationId,
    });
    const registry = getAdapterRegistry();
    const adapter = registry.get(route.adapterId);
    if (!adapter) throw new Error(`Adapter '${route.adapterId}' not found`);
    const model = input.model ?? route.modelId;
    const opts: ChatOptions = {
      model,
      messages: input.messages,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      taskId: input.taskId,
      agentId: input.agentId,
    };
    UltraDevLog.push('AI_REQUEST', { event: 'ai_text_start', ...routeLogFields(route), model });
    const t0 = Date.now();
    const result: AdapterResult<NormalizedAiResponse> = await adapter.invokeChat(route, opts);
    if (!result.ok) {
      UltraDevLog.push('ERROR', {
        event: 'ai_text_failed',
        ...routeLogFields(route),
        error: result.error.message,
        code: result.error.code,
      });
      throw new Error(`AI request failed [${result.error.code}]: ${result.error.message}`);
    }
    UltraDevLog.push('AI_RESPONSE', {
      event: 'ai_text_done',
      ...routeLogFields(route),
      model,
      inputTokens: result.value.inputTokens,
      outputTokens: result.value.outputTokens,
      latencyMs: Date.now() - t0,
    });
    return result.value;
  }

  async completeConversation(input: TextCompletionInput): Promise<NormalizedAiResponse> {
    return this.completeText(input);
  }

  async generateImage(input: ImageGenerationInput): Promise<NormalizedImageResponse> {
    const route = await this.resolveRoute('image_generate', {
      conversationId: input.conversationId,
    });
    const registry = getAdapterRegistry();
    const adapter = registry.get(route.adapterId);
    if (!adapter) throw new Error(`Adapter '${route.adapterId}' not found`);
    const model = input.model ?? route.modelId;
    const opts: ImageOptions = {
      model,
      prompt: input.prompt,
      width: input.width,
      height: input.height,
      steps: input.steps,
      negativePrompt: input.negativePrompt,
      stylePreset: input.stylePreset,
      taskId: input.taskId,
    };
    UltraDevLog.push('AI_REQUEST', {
      event: 'ai_image_start',
      ...routeLogFields(route),
      model,
      promptLen: input.prompt.length,
    });
    const result: AdapterResult<NormalizedImageResponse> = await adapter.invokeImage(route, opts);
    if (!result.ok) {
      UltraDevLog.push('ERROR', {
        event: 'ai_image_failed',
        ...routeLogFields(route),
        error: result.error.message,
      });
      throw new Error(`Image generation failed [${result.error.code}]: ${result.error.message}`);
    }
    UltraDevLog.push('AI_RESPONSE', {
      event: 'ai_image_done',
      ...routeLogFields(route),
      model,
      count: result.value.images.length,
    });
    return result.value;
  }

  async generateSpeech(input: SpeechInput): Promise<NormalizedAudioResponse> {
    const route = await this.resolveRoute('audio_generate', {
      conversationId: input.conversationId,
    });
    const registry = getAdapterRegistry();
    const adapter = registry.get(route.adapterId);
    if (!adapter) throw new Error(`Adapter '${route.adapterId}' not found`);
    const model = input.model ?? route.modelId;
    const opts: SpeechOptions = { model, text: input.text, voice: input.voice, taskId: input.taskId };
    UltraDevLog.push('AI_REQUEST', {
      event: 'ai_speech_start',
      ...routeLogFields(route),
      model,
      textLen: input.text.length,
    });
    const result: AdapterResult<NormalizedAudioResponse> = await adapter.invokeAudio(route, opts);
    if (!result.ok) {
      UltraDevLog.push('ERROR', {
        event: 'ai_speech_failed',
        ...routeLogFields(route),
        error: result.error.message,
      });
      throw new Error(`Speech generation failed [${result.error.code}]: ${result.error.message}`);
    }
    UltraDevLog.push('AI_RESPONSE', { event: 'ai_speech_done', ...routeLogFields(route), model });
    return result.value;
  }

  async generateVideo(input: VideoInput): Promise<NormalizedVideoResult> {
    const route = await this.resolveRoute('video_generate', {
      conversationId: input.conversationId,
    });
    const registry = getAdapterRegistry();
    const adapter = registry.get(route.adapterId);
    if (!adapter) throw new Error(`Adapter '${route.adapterId}' not found`);
    const model = input.model ?? route.modelId;
    const opts: VideoOptions = {
      model,
      prompt: input.prompt,
      imageBase64: input.imageBase64,
      duration: input.duration,
      taskId: input.taskId,
    };
    UltraDevLog.push('AI_REQUEST', { event: 'ai_video_start', ...routeLogFields(route), model });
    const jobResult: AdapterResult<NormalizedVideoJob> = await adapter.invokeVideoQueue(route, opts);
    if (!jobResult.ok) {
      UltraDevLog.push('ERROR', {
        event: 'ai_video_queue_failed',
        ...routeLogFields(route),
        error: jobResult.error.message,
      });
      throw new Error(`Video queue failed [${jobResult.error.code}]: ${jobResult.error.message}`);
    }
    const { jobId } = jobResult.value;
    UltraDevLog.push('SYSTEM', { event: 'ai_video_queued', ...routeLogFields(route), jobId });
    const pollResult: AdapterResult<NormalizedVideoResult> = await adapter.invokeVideoPoll(route, jobId);
    if (!pollResult.ok) {
      UltraDevLog.push('ERROR', {
        event: 'ai_video_poll_failed',
        ...routeLogFields(route),
        jobId,
        error: pollResult.error.message,
      });
      throw new Error(
        `Video polling failed [${pollResult.error.code}]: ${pollResult.error.message}`
      );
    }
    UltraDevLog.push('AI_RESPONSE', {
      event: 'ai_video_done',
      ...routeLogFields(route),
      model,
      jobId,
    });
    return pollResult.value;
  }

  async embed(input: EmbeddingsInput): Promise<NormalizedEmbeddingsResponse> {
    const route = await this.resolveRoute('embeddings', {
      conversationId: input.conversationId,
    });
    const registry = getAdapterRegistry();
    const adapter = registry.get(route.adapterId);
    if (!adapter) throw new Error(`Adapter '${route.adapterId}' not found`);
    const model = input.model ?? route.modelId;
    const opts: EmbeddingsOptions = { model, input: input.input, taskId: input.taskId };
    const result: AdapterResult<NormalizedEmbeddingsResponse> = await adapter.invokeEmbeddings(
      route,
      opts
    );
    if (!result.ok)
      throw new Error(`Embeddings failed [${result.error.code}]: ${result.error.message}`);
    return result.value;
  }

  async transcribeAudio(_input: {
    audioUri: string;
    model?: string;
    taskId?: string;
  }): Promise<string> {
    throw new Error(
      'Audio transcription: configure a task default for audio_transcribe and ensure the provider has a transcription adapter.'
    );
  }
}

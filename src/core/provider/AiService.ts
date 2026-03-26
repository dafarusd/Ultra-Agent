// AiService — all AI/media operations route through GroupRouter + AdapterRegistry

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
} from '../../types/provider';
import type { ProviderManager } from './ProviderManager';
import type { GroupManager } from './GroupManager';
import type { RouteHistoryStore } from './RouteHistoryStore';
import { GroupRouter, type RouterContext } from './GroupRouter';
import { getAdapterRegistry } from './AdapterRegistry';
import type {
  ChatMessage,
  ChatOptions,
  ImageOptions,
  SpeechOptions,
  VideoOptions,
  EmbeddingsOptions,
} from './CapabilityAdapters';
import { RouteToast } from './RouteToast';
import { UltraDevLog } from '../../utils/UltraDevLog';

function routeLogFields(route: ResolvedRoute): Record<string, unknown> {
  return {
    providerId: route.providerId,
    providerName: route.providerName,
    groupId: route.groupId,
    groupName: route.groupName,
    modelId: route.modelId,
    adapterId: route.adapterId,
    operation: route.operation,
    selectionStrategy: route.selectionStrategy,
  };
}

export interface TextCompletionInput {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  conversationId?: string;
  groupId?: string;
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
  private router: GroupRouter;
  private routeHistory: RouteHistoryStore;
  private groupManager: GroupManager;
  private userDefaultsGetter: () => { notifyOnRouteSwitch: boolean };
  private lastRouteByConversation: Map<string, ResolvedRoute> = new Map();

  constructor(
    providerManager: ProviderManager,
    groupManager: GroupManager,
    routeHistory: RouteHistoryStore
  ) {
    this.router = new GroupRouter(providerManager, groupManager, routeHistory);
    this.routeHistory = routeHistory;
    this.groupManager = groupManager;
    this.userDefaultsGetter = () => groupManager.getUserDefaults();
  }

  getOperationMapping(): Record<string, string> {
    return { ...this.groupManager.getUserDefaults().groupAssignments };
  }

  async setOperationGroup(op: AllowedOperation, groupId: string | null): Promise<void> {
    const defaults = this.groupManager.getUserDefaults();
    const updated: Record<string, string> = { ...defaults.groupAssignments };
    if (groupId === null) {
      delete updated[op];
    } else {
      const group = this.groupManager.getAll().find(g => g.id === groupId);
      if (!group) throw new Error(`Group '${groupId}' not found`);
      if (!group.isActive) throw new Error(`Group '${group.name}' is disabled`);
      if (!group.members.some(m => m.isEnabled && (m.allowedOperations.length === 0 || m.allowedOperations.includes(op)))) {
        throw new Error(`Group '${group.name}' has no enabled member that supports '${op}'`);
      }
      updated[op] = groupId;
    }
    await this.groupManager.saveUserDefaults({ groupAssignments: updated });
    UltraDevLog.push('SYSTEM', { event: 'operation_group_set', op, groupId });
  }

  private async resolveRoute(
    operation: AllowedOperation,
    opts: { conversationId?: string; groupId?: string; tags?: string[] }
  ): Promise<ResolvedRoute> {
    const ctx: RouterContext = {
      operation,
      conversationId: opts.conversationId,
      requestedGroupId: opts.groupId,
      requestedTags: opts.tags,
    };
    const result = await this.router.resolve(ctx);
    if (!result.ok) {
      throw new Error(result.error.userMessage);
    }
    const route = result.route;
    // Notify on route switch
    const defaults = this.userDefaultsGetter();
    if (defaults.notifyOnRouteSwitch && opts.conversationId) {
      const prev = this.lastRouteByConversation.get(opts.conversationId ?? '') ?? null;
      RouteToast.notify(prev, route);
      this.lastRouteByConversation.set(opts.conversationId ?? '', route);
    }
    // Update route history
    if (opts.conversationId) {
      await this.routeHistory.update(opts.conversationId, route).catch(() => {});
    }
    return route;
  }

  async completeText(input: TextCompletionInput): Promise<NormalizedAiResponse> {
    const route = await this.resolveRoute('chat', { conversationId: input.conversationId, groupId: input.groupId, tags: input.tags });
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
      UltraDevLog.push('ERROR', { event: 'ai_text_failed', ...routeLogFields(route), error: result.error.message, code: result.error.code });
      throw new Error(`AI request failed [${result.error.code}]: ${result.error.message}`);
    }
    UltraDevLog.push('AI_RESPONSE', { event: 'ai_text_done', ...routeLogFields(route), model, inputTokens: result.value.inputTokens, outputTokens: result.value.outputTokens, latencyMs: Date.now() - t0 });
    return result.value;
  }

  async completeConversation(input: TextCompletionInput): Promise<NormalizedAiResponse> {
    return this.completeText(input);
  }

  async generateImage(input: ImageGenerationInput): Promise<NormalizedImageResponse> {
    const route = await this.resolveRoute('image_generate', { conversationId: input.conversationId, groupId: input.groupId, tags: input.tags });
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
    UltraDevLog.push('AI_REQUEST', { event: 'ai_image_start', ...routeLogFields(route), model, promptLen: input.prompt.length });
    const result: AdapterResult<NormalizedImageResponse> = await adapter.invokeImage(route, opts);
    if (!result.ok) {
      UltraDevLog.push('ERROR', { event: 'ai_image_failed', ...routeLogFields(route), error: result.error.message });
      throw new Error(`Image generation failed [${result.error.code}]: ${result.error.message}`);
    }
    UltraDevLog.push('AI_RESPONSE', { event: 'ai_image_done', ...routeLogFields(route), model, count: result.value.images.length });
    return result.value;
  }

  async generateSpeech(input: SpeechInput): Promise<NormalizedAudioResponse> {
    const route = await this.resolveRoute('audio_generate', { conversationId: input.conversationId, groupId: input.groupId, tags: input.tags });
    const registry = getAdapterRegistry();
    const adapter = registry.get(route.adapterId);
    if (!adapter) throw new Error(`Adapter '${route.adapterId}' not found`);
    const model = input.model ?? route.modelId;
    const opts: SpeechOptions = { model, text: input.text, voice: input.voice, taskId: input.taskId };
    UltraDevLog.push('AI_REQUEST', { event: 'ai_speech_start', ...routeLogFields(route), model, textLen: input.text.length });
    const result: AdapterResult<NormalizedAudioResponse> = await adapter.invokeAudio(route, opts);
    if (!result.ok) {
      UltraDevLog.push('ERROR', { event: 'ai_speech_failed', ...routeLogFields(route), error: result.error.message });
      throw new Error(`Speech generation failed [${result.error.code}]: ${result.error.message}`);
    }
    UltraDevLog.push('AI_RESPONSE', { event: 'ai_speech_done', ...routeLogFields(route), model });
    return result.value;
  }

  async generateVideo(input: VideoInput): Promise<NormalizedVideoResult> {
    const route = await this.resolveRoute('video_generate', { conversationId: input.conversationId, groupId: input.groupId, tags: input.tags });
    const registry = getAdapterRegistry();
    const adapter = registry.get(route.adapterId);
    if (!adapter) throw new Error(`Adapter '${route.adapterId}' not found`);
    const model = input.model ?? route.modelId;
    const opts: VideoOptions = { model, prompt: input.prompt, imageBase64: input.imageBase64, duration: input.duration, taskId: input.taskId };
    UltraDevLog.push('AI_REQUEST', { event: 'ai_video_start', ...routeLogFields(route), model });
    const jobResult: AdapterResult<NormalizedVideoJob> = await adapter.invokeVideoQueue(route, opts);
    if (!jobResult.ok) {
      UltraDevLog.push('ERROR', { event: 'ai_video_queue_failed', ...routeLogFields(route), error: jobResult.error.message });
      throw new Error(`Video queue failed [${jobResult.error.code}]: ${jobResult.error.message}`);
    }
    const { jobId } = jobResult.value;
    UltraDevLog.push('SYSTEM', { event: 'ai_video_queued', ...routeLogFields(route), jobId });
    const pollResult: AdapterResult<NormalizedVideoResult> = await adapter.invokeVideoPoll(route, jobId);
    if (!pollResult.ok) {
      UltraDevLog.push('ERROR', { event: 'ai_video_poll_failed', ...routeLogFields(route), jobId, error: pollResult.error.message });
      throw new Error(`Video polling failed [${pollResult.error.code}]: ${pollResult.error.message}`);
    }
    UltraDevLog.push('AI_RESPONSE', { event: 'ai_video_done', ...routeLogFields(route), model, jobId });
    return pollResult.value;
  }

  async embed(input: EmbeddingsInput): Promise<NormalizedEmbeddingsResponse> {
    const route = await this.resolveRoute('embeddings', { conversationId: input.conversationId, groupId: input.groupId, tags: input.tags });
    const registry = getAdapterRegistry();
    const adapter = registry.get(route.adapterId);
    if (!adapter) throw new Error(`Adapter '${route.adapterId}' not found`);
    const model = input.model ?? route.modelId;
    const opts: EmbeddingsOptions = { model, input: input.input, taskId: input.taskId };
    const result: AdapterResult<NormalizedEmbeddingsResponse> = await adapter.invokeEmbeddings(route, opts);
    if (!result.ok) throw new Error(`Embeddings failed [${result.error.code}]: ${result.error.message}`);
    return result.value;
  }

  async transcribeAudio(_input: { audioUri: string; model?: string; taskId?: string }): Promise<string> {
    throw new Error('Audio transcription: assign a model to an active group with audio_transcribe operation allowed, then configure a transcription adapter.');
  }
}

import { UltraDevLog } from './UltraDevLog';

export type PickerCategory = "text" | "image" | "code" | "video" | "audio" | "reasoning";

export interface ModelCapabilities {
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  optimizedForCode?: boolean;
  supportsFunctionCalling?: boolean;
  supportsWebSearch?: boolean;
  supportsMultipleImages?: boolean;
  isUncensored?: boolean;
  // Provider-backed capability fields
  supportsImageGeneration?: boolean;
  supportsAudioGeneration?: boolean;
  supportsVideoGeneration?: boolean;
  supportsEmbeddings?: boolean;
  supportsReasoningHints?: boolean;
  supportsToolCalls?: boolean;
}

const IMAGE_PATTERNS = ["flux", "stable-diffusion", "sdxl", "dall-e", "imagen", "pony-realism", "z-image", "qwen-image", "qwen-edit", "image-turbo", "nano-banana"];
const VIDEO_PATTERNS = ["wan-", "luma", "runway", "minimax-video", "kling", "genmo", "preview-image-to-video", "preview-t2v"];
const AUDIO_PATTERNS = ["tts-", "kokoro", "parakeet", "whisper", "speech"];
const CODE_PATTERNS = ["coder", "codestral", "deepseek-coder"];
const REASONING_PATTERNS = ["reason", "qwq", "deepseek-r1", "o1-", "o3-", "o4-mini"];

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((p) => value.includes(p));
}

export function classifyModelType(
  id: string,
  name: string,
  rawType?: string,
  capabilities?: ModelCapabilities | null,
): PickerCategory {
  let result: PickerCategory;
  let matchedRule: string;

  if (rawType === "image") { result = "image"; matchedRule = "rawType:image"; }
  else if (rawType === "video") { result = "video"; matchedRule = "rawType:video"; }
  else if (rawType === "audio") { result = "audio"; matchedRule = "rawType:audio"; }
  else if (rawType === "embedding") { result = "text"; matchedRule = "rawType:embedding→text"; }
  else if (capabilities?.supportsImageGeneration) { result = "image"; matchedRule = "capability:supportsImageGeneration"; }
  else if (capabilities?.supportsVideoGeneration) { result = "video"; matchedRule = "capability:supportsVideoGeneration"; }
  else if (capabilities?.supportsAudioGeneration) { result = "audio"; matchedRule = "capability:supportsAudioGeneration"; }
  else if (capabilities?.supportsEmbeddings) { result = "text"; matchedRule = "capability:supportsEmbeddings→text"; }
  else if (capabilities?.supportsReasoning || capabilities?.supportsReasoningHints) { result = "reasoning"; matchedRule = "capability:supportsReasoning"; }
  else if (capabilities?.optimizedForCode) { result = "code"; matchedRule = "capability:optimizedForCode"; }
  else {
    const idLower = (id || "").toLowerCase();
    const nameLower = (name || "").toLowerCase();

    if (matchesAny(idLower, IMAGE_PATTERNS) || matchesAny(nameLower, IMAGE_PATTERNS)) { result = "image"; matchedRule = "pattern:image"; }
    else if (matchesAny(idLower, VIDEO_PATTERNS) || nameLower.includes("video gen")) { result = "video"; matchedRule = "pattern:video"; }
    else if (matchesAny(idLower, AUDIO_PATTERNS) || matchesAny(nameLower, AUDIO_PATTERNS)) { result = "audio"; matchedRule = "pattern:audio"; }
    else if (matchesAny(idLower, CODE_PATTERNS) || matchesAny(nameLower, CODE_PATTERNS)) { result = "code"; matchedRule = "pattern:code"; }
    else if (matchesAny(idLower, REASONING_PATTERNS) || matchesAny(nameLower, REASONING_PATTERNS)) { result = "reasoning"; matchedRule = "pattern:reasoning"; }
    else { result = "text"; matchedRule = "default_text_fallback"; }
  }

  UltraDevLog.push('SYSTEM', {
    event: 'classify_model_type',
    modelId: id,
    modelName: name,
    rawType: rawType ?? null,
    capabilityFlags: capabilities ? {
      supportsImageGeneration: capabilities.supportsImageGeneration,
      supportsVideoGeneration: capabilities.supportsVideoGeneration,
      supportsAudioGeneration: capabilities.supportsAudioGeneration,
      supportsEmbeddings: capabilities.supportsEmbeddings,
      supportsReasoning: capabilities.supportsReasoning,
      supportsReasoningHints: capabilities.supportsReasoningHints,
      optimizedForCode: capabilities.optimizedForCode,
    } : null,
    matchedRule,
    result,
  });

  return result;
}

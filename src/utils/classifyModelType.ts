export type PickerCategory = "text" | "image" | "code" | "video" | "audio" | "reasoning";

export interface ModelCapabilities {
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  optimizedForCode?: boolean;
  supportsFunctionCalling?: boolean;
  supportsWebSearch?: boolean;
  supportsMultipleImages?: boolean;
  isUncensored?: boolean;
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
  if (rawType === "image") return "image";
  if (rawType === "video") return "video";
  if (rawType === "audio") return "audio";
  if (rawType === "embedding") return "text";

  if (capabilities) {
    if (capabilities.supportsReasoning) return "reasoning";
    if (capabilities.optimizedForCode) return "code";
  }

  const idLower = (id || "").toLowerCase();
  const nameLower = (name || "").toLowerCase();

  if (matchesAny(idLower, IMAGE_PATTERNS) || matchesAny(nameLower, IMAGE_PATTERNS)) return "image";
  if (matchesAny(idLower, VIDEO_PATTERNS) || nameLower.includes("video gen")) return "video";
  if (matchesAny(idLower, AUDIO_PATTERNS) || matchesAny(nameLower, AUDIO_PATTERNS)) return "audio";
  if (matchesAny(idLower, CODE_PATTERNS) || matchesAny(nameLower, CODE_PATTERNS)) return "code";
  if (matchesAny(idLower, REASONING_PATTERNS) || matchesAny(nameLower, REASONING_PATTERNS)) return "reasoning";

  return "text";
}

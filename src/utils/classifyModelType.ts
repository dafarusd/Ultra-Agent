export type PickerCategory = "text" | "image" | "code" | "video" | "embedding" | "reasoning";

const IMAGE_PATTERNS = [
  "flux", "fluently", "stable-diffusion", "sdxl", "dall-e", "imagen",
  "pony-realism", "venice-sd", "nano-banana", "midjourney",
];

const VIDEO_PATTERNS = [
  "wan-", "luma", "runway", "minimax-video", "kling", "genmo",
];

const CODE_PATTERNS = [
  "code", "codestral", "deepseek-coder",
];

const REASONING_PATTERNS = [
  "reason", "qwq", "deepseek-r1", "o1-", "o3-", "o4-mini",
];

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((p) => value.includes(p));
}

export function classifyModelType(
  id: string,
  name: string,
  rawType?: string,
): PickerCategory {
  if (rawType === "image") return "image";
  if (rawType === "video") return "video";
  if (rawType === "embedding") return "embedding";

  const idLower = (id || "").toLowerCase();
  const nameLower = (name || "").toLowerCase();

  if (matchesAny(idLower, IMAGE_PATTERNS) || matchesAny(nameLower, IMAGE_PATTERNS)) {
    return "image";
  }

  if (matchesAny(idLower, VIDEO_PATTERNS) || nameLower.includes("video gen")) {
    return "video";
  }

  if (matchesAny(idLower, CODE_PATTERNS) || matchesAny(nameLower, CODE_PATTERNS)) {
    return "code";
  }

  if (matchesAny(idLower, REASONING_PATTERNS) || matchesAny(nameLower, REASONING_PATTERNS)) {
    return "reasoning";
  }

  return "text";
}

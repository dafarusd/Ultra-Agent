import { SecureVault } from '../security/SecureVault';
import { Logger } from '../utils/Logger';
import { UltraDevLog } from '../utils/UltraDevLog';

const VENICE_BASE = 'https://api.venice.ai/api/v1';

export interface VeniceImageResult {
  images: string[];
  model: string;
  timingMs: number;
}

export interface VeniceTtsResult {
  audioBase64: string;
  timingMs: number;
}

export interface VeniceVideoJob {
  jobId: string;
  model: string;
}

export class VeniceService {
  private vault: SecureVault;
  private logger: Logger;
  private apiKey: string | null = null;

  constructor(vault: SecureVault) {
    this.vault = vault;
    this.logger = new Logger('VeniceService');
  }

  async initialize(): Promise<void> {
    this.apiKey = await this.vault.get('venice_api_key');
    if (!this.apiKey) {
      const envKey = process.env.EXPO_PUBLIC_VENICE_API_KEY || null;
      if (envKey) this.apiKey = envKey;
    }
    if (this.apiKey) {
      this.logger.info('VeniceService initialized with API key');
    } else {
      this.logger.warn('VeniceService: no API key found');
    }
  }

  private getKey(): string {
    if (!this.apiKey) throw new Error('Venice API key not configured. Open Settings to add it.');
    return this.apiKey;
  }

  async generateImage(
    prompt: string,
    opts: { model?: string; width?: number; height?: number } = {}
  ): Promise<VeniceImageResult> {
    const t0 = Date.now();
    const model = opts.model || 'z-image-turbo';
    UltraDevLog.push('SYSTEM', { event: 'venice_image_start', model, prompt: prompt.slice(0, 100), width: opts.width ?? 1024, height: opts.height ?? 1024 });
    const body = {
      prompt,
      model,
      width: opts.width ?? 1024,
      height: opts.height ?? 1024,
      steps: 20,
      return_binary: false,
    };
    const res = await fetch(`${VENICE_BASE}/image/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.getKey()}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      UltraDevLog.push('SYSTEM', { event: 'venice_image_error', model, status: res.status, error: text.slice(0, 100) });
      throw new Error(`Venice image: ${res.status} ${text.slice(0, 120)}`);
    }
    const json = await res.json();
    const images: string[] = (json.images ?? []).map((img: any) =>
      typeof img === 'string' ? img : img.b64_json ?? img.url ?? ''
    );
    UltraDevLog.push('SYSTEM', { event: 'venice_image_done', model, imageCount: images.length, timingMs: Date.now() - t0 });
    return { images, model, timingMs: Date.now() - t0 };
  }

  async textToSpeech(
    text: string,
    opts: { voice?: string; speed?: number } = {}
  ): Promise<VeniceTtsResult> {
    const t0 = Date.now();
    UltraDevLog.push('SYSTEM', { event: 'venice_tts_start', textLen: text.length, voice: opts.voice ?? 'af_sky' });
    const body = {
      model: 'tts-kokoro',
      input: text.slice(0, 4096),
      voice: opts.voice ?? 'af_sky',
      speed: opts.speed ?? 1.0,
      response_format: 'mp3',
    };
    const res = await fetch(`${VENICE_BASE}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.getKey()}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      UltraDevLog.push('SYSTEM', { event: 'venice_tts_error', status: res.status, error: errText.slice(0, 100) });
      throw new Error(`Venice TTS: ${res.status} ${errText.slice(0, 120)}`);
    }
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    const audioBase64 = btoa(binary);
    UltraDevLog.push('SYSTEM', { event: 'venice_tts_done', audioBytes: bytes.byteLength, timingMs: Date.now() - t0 });
    return { audioBase64, timingMs: Date.now() - t0 };
  }

  async generateVideo(
    prompt: string,
    opts: { model?: string; duration?: number; aspectRatio?: string; resolution?: string } = {}
  ): Promise<VeniceVideoJob> {
    const body = {
      prompt,
      model: opts.model ?? 'wan-2.5-preview-image-to-video',
      duration: opts.duration ? `${opts.duration}s` : '5s',
      aspect_ratio: opts.aspectRatio ?? '16:9',
      resolution: opts.resolution ?? '480p',
    };
    UltraDevLog.push('SYSTEM', { event: 'venice_video_start', model: opts.model ?? 'wan-2.5-preview-image-to-video', prompt: prompt.slice(0, 100) });
    const res = await fetch(`${VENICE_BASE}/video/queue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.getKey()}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Venice video: ${res.status} ${text.slice(0, 120)}`);
    }
    const json = await res.json();
    UltraDevLog.push('SYSTEM', { event: 'venice_video_queued', jobId: json.queue_id, model: opts.model ?? 'wan-2.5-preview-image-to-video' });
    return { jobId: json.queue_id ?? '', model: opts.model ?? 'wan-2.5-preview-image-to-video' };
  }

  async pollVideoJob(jobId: string, maxWaitMs: number = 90_000): Promise<{ videoBase64: string }> {
    const deadline = Date.now() + maxWaitMs;
    UltraDevLog.push('SYSTEM', { event: 'venice_video_poll_start', jobId, maxWaitMs });
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const res = await fetch(`${VENICE_BASE}/video/retrieve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.getKey()}`,
        },
        body: JSON.stringify({ queue_id: jobId }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.status === 'completed' || json.status === 'succeeded') {
        UltraDevLog.push('SYSTEM', { event: 'venice_video_complete', jobId, timingMs: Date.now() - (deadline - maxWaitMs) });
        const videoUrl: string = json.video_url ?? json.url ?? '';
        if (!videoUrl) throw new Error('Venice video: job completed but no URL');
        const vidRes = await fetch(videoUrl);
        const buf = await vidRes.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return { videoBase64: btoa(binary) };
      }
      if (json.status === 'failed' || json.status === 'error') {
        UltraDevLog.push('SYSTEM', { event: 'venice_video_failed', jobId, error: json.error ?? json.message ?? 'unknown' });
        throw new Error(`Venice video job failed: ${json.error ?? json.message ?? 'unknown'}`);
      }
    }
    throw new Error('Venice video: timed out waiting for job completion');
  }
}

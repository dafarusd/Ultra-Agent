import { SecureVault } from '../security/SecureVault';
import { UltraDevLog as DebugLog } from '../utils/UltraDevLog';

// ═══════════════════════════════════════════════════════
// THREE PATHS TO AI:
//   1. Pro subscription — AI via your backend (you pay Venice)
//   2. BYO API — user's own key (they pay their provider)
//   3. Free — NO AI, agent-only, deterministic commands only
//
// The agent itself IS the free product:
//   App launching, settings toggles, calls, SMS send/read,
//   camera, screenshots, flashlight, volume, bluetooth, DND,
//   alarms, timers, file ops, clipboard, contacts, device info
//   All via CommandParser, zero LLM calls
// ═══════════════════════════════════════════════════════

export type UserTier = 'free' | 'pro' | 'byo' | 'dev';

export const AGENT_ONLY_CAPABILITIES = new Set([
  'app_launch', 'camera_capture', 'media_access', 'flashlight_toggle',
  'wifi_toggle', 'bluetooth_toggle', 'airplane_mode', 'do_not_disturb',
  'volume_set', 'brightness', 'screen_rotate', 'phone_call',
  'sms_send', 'sms_read', 'sms_conversation', 'contacts_read',
  'device_info', 'battery_status', 'system_info', 'device_location',
  'open_url', 'web_search', 'clipboard_read', 'clipboard_write',
  'screenshot', 'alarm_set', 'timer_set', 'file_read', 'file_write',
  'file_delete', 'file_list', 'note_create', 'notification_read',
  'media_play', 'media_pause', 'media_next', 'media_previous', 'open_settings',
]);

export const AI_REQUIRED_CAPABILITIES = new Set([
  'conversation', 'ai_instruction', 'image_generate', 'video_generate',
  'tts', 'code_generate', 'app_build', 'self_modify', 'self_replicate',
  'react_navigate', 'app_control', 'app_test',
]);

const PRO_ALLOWED_MODELS = [
  'qwen3-5-9b', 'mistral-small-3-2-24b-instruct', 'openai-gpt-oss-120b',
  'zai-org-glm-4.7-flash', 'zai-org-glm-4.7', 'llama-3.3-70b',
  'kimi-k2.5', 'venice-uncensored', 'qwen3-coder-480b-a35b-instruct-turbo',
  'flux-2-pro', 'qwen-image-2', 'tts-kokoro',
];

const CREDIT_ONLY_PATTERNS = [/gpt-5/i, /claude/i, /wan-.*video/i, /flux/i, /qwen-image/i];

export interface UsageRecord {
  date: string;
  messageCount: number;
  aiCallCount: number;
  creditsUsed: number;
  modelUsage: Record<string, number>;
}

export interface CreditBalance {
  included: number;
  purchased: number;
  totalUsed: number;
}

export class TierService {
  private vault: SecureVault;
  private tier: UserTier = 'free';
  private usage: UsageRecord = { date: '', messageCount: 0, aiCallCount: 0, creditsUsed: 0, modelUsage: {} };
  private credits: CreditBalance = { included: 0, purchased: 0, totalUsed: 0 };
  private initialized = false;

  constructor(vault: SecureVault) { this.vault = vault; }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const savedTier = await this.vault.get('user_tier');
    if (savedTier === 'dev' || savedTier === 'pro' || savedTier === 'byo' || savedTier === 'free') {
      this.tier = savedTier;
    }

    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      const devMode = await AsyncStorage.getItem('dev_mode_enabled');
      if (devMode === '1') this.tier = 'dev';
    } catch {}

    // BYO auto-detect: user has their own API key
    if (this.tier === 'free') {
      const apiKey = await this.vault.get('venice_api_key');
      if (apiKey && apiKey.length > 0) {
        this.tier = 'byo';
        await this.vault.set('user_tier', 'byo');
      }
    }

    await this.loadTodayUsage();
    await this.loadCredits();

    // ══════════════════════════════════════════════════════
    // BACKEND SYNC POINT: Verify subscription with server
    //
    // const backend = require('./BackendService').getInstance();
    // if (backend.isActive()) {
    //   const status = await backend.verifySubscription();
    //   if (status) {
    //     this.tier = status.tier;
    //     this.credits = status.creditBalance;
    //     await this.vault.set('user_tier', this.tier);
    //   }
    // }
    // ══════════════════════════════════════════════════════

    this.initialized = true;
    DebugLog.systemEvent('TierService', `Initialized: tier=${this.tier} msgs=${this.usage.messageCount} ai=${this.usage.aiCallCount}`);
  }

  getTier(): UserTier { return this.tier; }
  getCredits(): CreditBalance { return { ...this.credits }; }
  getUsage(): UsageRecord { return { ...this.usage }; }

  async setTier(tier: UserTier): Promise<void> {
    this.tier = tier;
    await this.vault.set('user_tier', tier);
    DebugLog.systemEvent('TierService', `Tier set: ${tier}`);
  }

  hasAiAccess(): boolean {
    return this.tier === 'dev' || this.tier === 'byo' || this.tier === 'pro';
  }

  canUseCapability(capability: string): { allowed: boolean; reason: string; needsUpgrade: boolean } {
    if (AGENT_ONLY_CAPABILITIES.has(capability)) {
      return { allowed: true, reason: '', needsUpgrade: false };
    }
    if (!this.hasAiAccess()) {
      return {
        allowed: false, needsUpgrade: true,
        reason: 'This feature requires AI. Upgrade to Pro ($9.99/mo) or add your own API key in Settings.',
      };
    }
    if (this.tier === 'pro' && capability === 'video_generate') {
      if (this.credits.included + this.credits.purchased <= 0) {
        return { allowed: false, reason: 'Video generation requires credits. Purchase a top-up.', needsUpgrade: false };
      }
    }
    return { allowed: true, reason: '', needsUpgrade: false };
  }

  canSendMessage(needsAi: boolean): { allowed: boolean; reason: string; needsUpgrade: boolean } {
    if (!needsAi) return { allowed: true, reason: '', needsUpgrade: false };
    if (!this.hasAiAccess()) {
      return {
        allowed: false, needsUpgrade: true,
        reason: 'AI chat requires Pro or your own API key.\n\nThe agent still works! Try commands like:\n• "Open camera"\n• "Turn on flashlight"\n• "Call Mom"\n• "Read my texts"',
      };
    }
    if (this.tier === 'pro' && this.usage.aiCallCount >= 200) {
      if (this.credits.included + this.credits.purchased > 0) return { allowed: true, reason: '', needsUpgrade: false };
      return { allowed: false, reason: 'Daily AI limit reached (200). Purchase credits for more.', needsUpgrade: false };
    }
    return { allowed: true, reason: '', needsUpgrade: false };
  }

  isModelAllowed(modelId: string): boolean {
    if (this.tier === 'dev' || this.tier === 'byo') return true;
    if (this.tier === 'pro') {
      if (PRO_ALLOWED_MODELS.includes(modelId)) return true;
      const id = modelId.toLowerCase();
      return id.includes('qwen') || id.includes('mistral') || id.includes('llama') ||
        id.includes('glm') || id.includes('kimi') || id.includes('venice') ||
        id.includes('flux') || id.includes('kokoro') || id.includes('openai-gpt-oss');
    }
    return false; // free: no models
  }

  doesModelRequireCredits(modelId: string): boolean {
    if (this.tier === 'dev' || this.tier === 'byo') return false;
    return CREDIT_ONLY_PATTERNS.some(p => p.test(modelId));
  }

  filterModelsForTier(allModels: Array<{ id: string; [key: string]: any }>): Array<{ id: string; [key: string]: any }> {
    if (this.tier === 'dev' || this.tier === 'byo') return allModels;
    if (this.tier === 'free') return [];
    return allModels.filter(m => this.isModelAllowed(m.id));
  }

  async recordMessage(modelId: string, wasAiCall: boolean, creditsUsed: number = 0): Promise<void> {
    await this.ensureTodayUsage();
    this.usage.messageCount++;
    if (wasAiCall) {
      this.usage.aiCallCount++;
      this.usage.modelUsage[modelId] = (this.usage.modelUsage[modelId] || 0) + 1;
    }
    if (creditsUsed > 0) {
      this.usage.creditsUsed += creditsUsed;
      if (this.credits.included >= creditsUsed) { this.credits.included -= creditsUsed; }
      else { const r = creditsUsed - this.credits.included; this.credits.included = 0; this.credits.purchased -= r; }
      this.credits.totalUsed += creditsUsed;
      await this.saveCredits();
    }
    await this.saveUsage();
  }

  async addCredits(amount: number, source: 'included' | 'purchased'): Promise<void> {
    if (source === 'included') this.credits.included += amount;
    else this.credits.purchased += amount;
    await this.saveCredits();
  }

  private todayKey(): string { return new Date().toISOString().slice(0, 10); }
  private async loadTodayUsage(): Promise<void> {
    try { const raw = await this.vault.get('tier_usage_today'); if (raw) { const p = JSON.parse(raw); if (p.date === this.todayKey()) { this.usage = p; return; } } } catch {}
    this.usage = { date: this.todayKey(), messageCount: 0, aiCallCount: 0, creditsUsed: 0, modelUsage: {} };
  }
  private async ensureTodayUsage(): Promise<void> { if (this.usage.date !== this.todayKey()) this.usage = { date: this.todayKey(), messageCount: 0, aiCallCount: 0, creditsUsed: 0, modelUsage: {} }; }
  private async saveUsage(): Promise<void> { try { await this.vault.set('tier_usage_today', JSON.stringify(this.usage)); } catch (e: any) { DebugLog.error('TierService', e.message); } }
  private async loadCredits(): Promise<void> {
    try { const raw = await this.vault.get('tier_credits'); if (raw) { this.credits = JSON.parse(raw); return; } } catch {}
    if (this.tier === 'dev') this.credits = { included: 999999, purchased: 0, totalUsed: 0 };
    else if (this.tier === 'pro') this.credits = { included: 500, purchased: 0, totalUsed: 0 };
    else this.credits = { included: 0, purchased: 0, totalUsed: 0 };
  }
  private async saveCredits(): Promise<void> { try { await this.vault.set('tier_credits', JSON.stringify(this.credits)); } catch (e: any) { DebugLog.error('TierService', e.message); } }
}

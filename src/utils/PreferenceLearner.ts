import { SecureVault } from '../security/SecureVault';
import { Logger } from './Logger';

interface Pattern {
  id: string;
  trigger: string;
  capabilities: string[];
  outcome: string;
  success: boolean;
  confidence: number;
  usageCount: number;
  lastUsed: number;
  createdAt: number;
}

interface UserPreference {
  key: string;
  value: string;
  source: string;
  confidence: number;
  updatedAt: number;
}

export class PreferenceLearner {
  private vault: SecureVault;
  private logger: Logger;
  private patterns: Pattern[];
  private preferences: Map<string, UserPreference>;
  private static readonly PATTERNS_KEY = 'learned_patterns';
  private static readonly PREFS_KEY = 'user_preferences';
  private static readonly MAX_PATTERNS = 200;

  constructor(vault: SecureVault) {
    this.vault = vault;
    this.logger = new Logger('PreferenceLearner');
    this.patterns = [];
    this.preferences = new Map();
  }

  async initialize(): Promise<void> {
    try {
      const pd = await this.vault.get(PreferenceLearner.PATTERNS_KEY);
      if (pd) this.patterns = JSON.parse(pd);
      const prd = await this.vault.get(PreferenceLearner.PREFS_KEY);
      if (prd) {
        const prefs: UserPreference[] = JSON.parse(prd);
        for (const p of prefs) this.preferences.set(p.key, p);
      }
      this.logger.info(`Loaded ${this.patterns.length} patterns, ${this.preferences.size} preferences`);
    } catch (error: any) {
      this.logger.error('Init failed: ' + error.message);
    }
  }

  async learnFromExecution(
    request: string,
    capabilities: string[],
    outcome: string,
    success: boolean
  ): Promise<void> {
    const existing = this.findPattern(request);
    if (existing) {
      existing.usageCount++;
      existing.lastUsed = Date.now();
      existing.confidence = success
        ? Math.min(1.0, existing.confidence + 0.1)
        : Math.max(0.0, existing.confidence - 0.2);
      existing.success = success;
    } else {
      const pattern: Pattern = {
        id: Date.now().toString(36),
        trigger: request.toLowerCase().trim(),
        capabilities,
        outcome,
        success,
        confidence: success ? 0.5 : 0.1,
        usageCount: 1,
        lastUsed: Date.now(),
        createdAt: Date.now(),
      };
      this.patterns.unshift(pattern);
      if (this.patterns.length > PreferenceLearner.MAX_PATTERNS) {
        this.patterns = this.patterns
          .sort((a, b) => b.confidence * b.usageCount - a.confidence * a.usageCount)
          .slice(0, PreferenceLearner.MAX_PATTERNS);
      }
    }
    await this.persist();
  }

  async learnPackage(trigger: string, packageName: string): Promise<void> {
    const existing = this.patterns.find(
      p => p.trigger === trigger.toLowerCase().trim() &&
           p.capabilities.includes('app_launch')
    );
    if (existing) {
      existing.confidence = 1.0;
      existing.outcome = packageName;
      existing.lastUsed = Date.now();
    } else {
      this.patterns.unshift({
        id: Date.now().toString(36),
        trigger: trigger.toLowerCase().trim(),
        capabilities: ['app_launch'],
        outcome: packageName,
        success: true,
        confidence: 1.0,
        usageCount: 1,
        lastUsed: Date.now(),
        createdAt: Date.now(),
      });
      if (this.patterns.length > PreferenceLearner.MAX_PATTERNS) {
        this.patterns = this.patterns
          .sort((a, b) => b.confidence * b.usageCount - a.confidence * a.usageCount)
          .slice(0, PreferenceLearner.MAX_PATTERNS);
      }
    }
    await this.persist();
  }

  findPattern(request: string): Pattern | null {
    const words = request.toLowerCase().split(/\s+/);
    let bestMatch: Pattern | null = null;
    let bestScore = 0;
    for (const pattern of this.patterns) {
      const pw = pattern.trigger.split(/\s+/);
      const common = words.filter((w) => pw.includes(w));
      const score = (common.length / Math.max(words.length, pw.length)) * pattern.confidence;
      if (score > bestScore && score > 0.3) {
        bestScore = score;
        bestMatch = pattern;
      }
    }
    return bestMatch;
  }

  async setPreference(key: string, value: string, source: string): Promise<void> {
    this.preferences.set(key, { key, value, source, confidence: 1.0, updatedAt: Date.now() });
    await this.persist();
  }

  getPreference(key: string): string | null {
    const p = this.preferences.get(key);
    return p ? p.value : null;
  }

  getAllPreferences(): UserPreference[] {
    return Array.from(this.preferences.values());
  }

  getTopPatterns(limit: number = 10): Pattern[] {
    return this.patterns
      .sort((a, b) => b.confidence * b.usageCount - a.confidence * a.usageCount)
      .slice(0, limit);
  }

  getContextForAI(): string {
    const prefs = this.getAllPreferences()
      .map((p) => `${p.key}: ${p.value}`)
      .join('\n');
    const pats = this.getTopPatterns(5)
      .map((p) => `When asked "${p.trigger}", used [${p.capabilities.join(', ')}] -> ${p.outcome}`)
      .join('\n');
    let ctx = '';
    if (prefs) ctx += `User preferences:\n${prefs}\n\n`;
    if (pats) ctx += `Successful past patterns:\n${pats}\n`;
    return ctx;
  }

  private async persist(): Promise<void> {
    try {
      await this.vault.set(PreferenceLearner.PATTERNS_KEY, JSON.stringify(this.patterns));
      await this.vault.set(PreferenceLearner.PREFS_KEY, JSON.stringify(Array.from(this.preferences.values())));
    } catch (error: any) {
      this.logger.error('Persist failed: ' + error.message);
    }
  }

  async cleanup(): Promise<void> {
    const before = this.patterns.length;
    this.patterns = this.patterns.filter((p) => p.confidence > 0.1 || p.usageCount > 2);
    if (this.patterns.length < before) {
      await this.persist();
      this.logger.info(`Cleaned ${before - this.patterns.length} low-confidence patterns`);
    }
  }
}

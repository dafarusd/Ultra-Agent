// TaskDefaultsManager — persisted task-level model defaults (primary + fallbacks)
// Replaces GroupManager-based operation routing.
// Storage key: task_defaults_v1
// Migration key: task_defaults_migration_v1 (one-time from groupAssignments → this format)

import { AppStorage } from '../../utils/AppStorage';
import { UltraDevLog } from '../../utils/UltraDevLog';

export interface TaskModelCandidate {
  providerId: string;
  modelId: string;
}

export interface TaskDefault {
  primary: TaskModelCandidate | null;
  fallbacks: TaskModelCandidate[];
}

interface TaskDefaultsStorage {
  version: 1;
  updatedAt: number;
  entries: Record<string, TaskDefault>;
}

const STORAGE_KEY = 'task_defaults_v1';
const MIGRATION_KEY = 'task_defaults_migration_v1';

// ── Normalization helpers ─────────────────────────────────────────────────────

function candidateKey(candidate: TaskModelCandidate): string {
  return `${candidate.providerId || '(any)'}::${candidate.modelId}`;
}

function normalizeCandidate(raw: unknown): TaskModelCandidate | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const modelId = raw.trim();
    if (!modelId) return null;
    return { providerId: '', modelId };
  }
  if (typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const modelId = typeof rec.modelId === 'string' ? rec.modelId.trim() : '';
  const providerId = typeof rec.providerId === 'string' ? rec.providerId.trim() : '';
  if (!modelId) return null;
  return { providerId, modelId };
}

function normalizeCandidateList(raw: unknown): TaskModelCandidate[] {
  const items = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const result: TaskModelCandidate[] = [];
  for (const item of items) {
    const candidate = normalizeCandidate(item);
    if (!candidate) continue;
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function normalizeTaskDefault(raw: unknown): TaskDefault | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const primary = normalizeCandidate(rec.primary);
  const fallbacks = normalizeCandidateList(rec.fallbacks);
  const filteredFallbacks = primary
    ? fallbacks.filter((candidate) => candidateKey(candidate) !== candidateKey(primary))
    : fallbacks;
  if (!primary && filteredFallbacks.length === 0) return { primary: null, fallbacks: [] };
  return { primary, fallbacks: filteredFallbacks };
}

// ── Class ─────────────────────────────────────────────────────────────────────

export class TaskDefaultsManager {
  private entries: Record<string, TaskDefault> = {};
  private initialized = false;

  async initialize(): Promise<void> {
    await this.load();
    this.initialized = true;
    UltraDevLog.push('SYSTEM', {
      event: 'task_defaults_initialized',
      taskCount: Object.keys(this.entries).length,
      tasks: Object.keys(this.entries),
    });
  }

  getDefault(operation: string): TaskDefault | null {
    return this.entries[operation] ?? null;
  }

  // Returns [primary, ...fallbacks] — the full ordered candidate list for routing.
  getCandidates(operation: string): TaskModelCandidate[] {
    const def = this.entries[operation];
    if (!def) return [];
    const result: TaskModelCandidate[] = [];
    if (def.primary) result.push(def.primary);
    result.push(...(def.fallbacks ?? []));
    return result;
  }

  getAllDefaults(): Record<string, TaskDefault> {
    return { ...this.entries };
  }

  async setDefault(
    operation: string,
    primary: TaskModelCandidate | null,
    fallbacks: TaskModelCandidate[] = []
  ): Promise<void> {
    const normalizedPrimary = normalizeCandidate(primary);
    const normalizedFallbacks = normalizeCandidateList(fallbacks).filter((candidate) => {
      return !normalizedPrimary || candidateKey(candidate) !== candidateKey(normalizedPrimary);
    });
    this.entries[operation] = { primary: normalizedPrimary, fallbacks: normalizedFallbacks };
    await this.save();
    UltraDevLog.push('SYSTEM', {
      event: 'task_default_set',
      operation,
      primary: normalizedPrimary,
      fallbackCount: normalizedFallbacks.length,
    });
    UltraDevLog.push('SETTINGS_SAVE', {
      event: 'task_default_write_result',
      operation,
      success: true,
      primary: normalizedPrimary ? `${normalizedPrimary.providerId || '(any)'}/${normalizedPrimary.modelId}` : null,
      fallbackCount: normalizedFallbacks.length,
    });
  }

  async clearDefault(operation: string): Promise<void> {
    delete this.entries[operation];
    await this.save();
    UltraDevLog.push('SYSTEM', { event: 'task_default_cleared', operation });
    UltraDevLog.push('SETTINGS_SAVE', {
      event: 'task_default_write_result',
      operation,
      success: true,
      primary: null,
      fallbackCount: 0,
      note: 'cleared',
    });
  }

  // One-time migration: reads groupAssignments from a GroupManager and populates task defaults.
  // Safe to call multiple times — subsequent calls are no-ops.
  async runMigrationIfNeeded(groupManager: any): Promise<void> {
    try {
      const migrated = await AppStorage.get(MIGRATION_KEY);
      if (migrated === '1') return;
      if (!groupManager) {
        await AppStorage.set(MIGRATION_KEY, '1');
        return;
      }
      let defaults: any = null;
      try { defaults = groupManager.getUserDefaults?.(); } catch {}
      const groupAssignments: Record<string, string> = defaults?.groupAssignments ?? {};
      if (Object.keys(groupAssignments).length === 0) {
        await AppStorage.set(MIGRATION_KEY, '1');
        return;
      }
      let migratedCount = 0;
      for (const [operation, groupId] of Object.entries(groupAssignments)) {
        if (!groupId) continue;
        let group: any = null;
        try { group = groupManager.getById?.(groupId); } catch {}
        if (!group?.members?.length) continue;
        const enabled = (group.members as any[]).filter(m => m.enabled !== false);
        if (!enabled.length) continue;
        const existing = this.entries[operation];
        if (existing?.primary) continue; // never overwrite user-set defaults
        const [first, ...rest] = enabled;
        this.entries[operation] = {
          primary: { providerId: first.providerId, modelId: first.modelId },
          fallbacks: rest.map(m => ({ providerId: m.providerId, modelId: m.modelId })),
        };
        migratedCount++;
      }
      if (migratedCount > 0) await this.save();
      await AppStorage.set(MIGRATION_KEY, '1');
      UltraDevLog.push('SYSTEM', {
        event: 'task_defaults_migration_complete',
        migratedOps: migratedCount,
        totalAssignments: Object.keys(groupAssignments).length,
      });
    } catch (err: any) {
      UltraDevLog.push('SYSTEM', { event: 'task_defaults_migration_error', error: err?.message });
      try { await AppStorage.set(MIGRATION_KEY, '1'); } catch {}
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = await AppStorage.get(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as TaskDefaultsStorage | Record<string, unknown>;
      const sourceEntries =
        parsed && typeof parsed === 'object' && 'entries' in parsed && typeof parsed.entries === 'object'
          ? parsed.entries as Record<string, unknown>
          : {};
      let normalizedCount = 0;
      let droppedCount = 0;
      const nextEntries: Record<string, TaskDefault> = {};
      for (const [operation, value] of Object.entries(sourceEntries)) {
        const normalized = normalizeTaskDefault(value);
        if (!normalized) {
          droppedCount++;
          continue;
        }
        const keyBefore = JSON.stringify(value);
        const keyAfter = JSON.stringify(normalized);
        if (keyBefore !== keyAfter) normalizedCount++;
        nextEntries[operation] = normalized;
      }
      this.entries = nextEntries;
      if (normalizedCount > 0 || droppedCount > 0) {
        await this.save();
        UltraDevLog.push('SYSTEM', {
          event: 'task_defaults_storage_normalized',
          normalizedCount,
          droppedCount,
          taskCount: Object.keys(this.entries).length,
        });
      }
    } catch {
      this.entries = {};
    }
  }

  private async save(): Promise<void> {
    const data: TaskDefaultsStorage = {
      version: 1,
      updatedAt: Date.now(),
      entries: this.getAllDefaults(),
    };
    await AppStorage.set(STORAGE_KEY, JSON.stringify(data));
  }
}

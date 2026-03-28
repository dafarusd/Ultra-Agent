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
    this.entries[operation] = { primary, fallbacks: fallbacks ?? [] };
    await this.save();
    UltraDevLog.push('SYSTEM', {
      event: 'task_default_set',
      operation,
      primary,
      fallbackCount: fallbacks.length,
    });
  }

  async clearDefault(operation: string): Promise<void> {
    delete this.entries[operation];
    await this.save();
    UltraDevLog.push('SYSTEM', { event: 'task_default_cleared', operation });
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
      const parsed: TaskDefaultsStorage = JSON.parse(raw);
      if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        this.entries = { ...parsed.entries };
      }
    } catch {
      this.entries = {};
    }
  }

  private async save(): Promise<void> {
    const data: TaskDefaultsStorage = {
      version: 1,
      updatedAt: Date.now(),
      entries: this.entries,
    };
    await AppStorage.set(STORAGE_KEY, JSON.stringify(data));
  }
}

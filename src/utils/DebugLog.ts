import { Platform } from 'react-native';
import * as ExpoFileSystem from 'expo-file-system/legacy';

const FileSystem: any = Platform.OS !== 'web' ? ExpoFileSystem : null;

export interface DebugEntry {
  ts: string;
  t: number;
  cat: string;
  data: Record<string, unknown>;
}

export class DebugLog {
  private static entries: DebugEntry[] = [];
  private static readonly MAX_MEMORY = 2000;
  private static writing = false;
  private static pendingFlush = false;
  private static sessionId = Date.now().toString(36);

  private static push(cat: string, data: Record<string, unknown>) {
    const entry: DebugEntry = {
      ts: new Date().toISOString(),
      t: Date.now(),
      cat,
      data,
    };
    DebugLog.entries.push(entry);
    if (DebugLog.entries.length > DebugLog.MAX_MEMORY) {
      DebugLog.entries = DebugLog.entries.slice(-DebugLog.MAX_MEMORY);
    }
    DebugLog.scheduleFlush();
  }

  static userMessage(conversationId: string, content: string) {
    DebugLog.push('USER_MSG', { conversationId, content });
  }

  static aiResponse(conversationId: string, model: string, content: string, cost: number | undefined, tokens?: { input?: number; output?: number }) {
    DebugLog.push('AI_RESPONSE', { conversationId, model, content, cost, tokens });
  }

  static agentStep(taskId: string, phase: string, detail: string, success: boolean) {
    DebugLog.push('AGENT_STEP', { taskId, phase, detail, success });
  }

  static modeDetected(taskId: string, mode: string, userInput: string) {
    DebugLog.push('MODE', { taskId, mode, inputPreview: userInput.slice(0, 500) });
  }

  static planResult(taskId: string, capability: string | null, params: Record<string, unknown> | null, deterministic: boolean) {
    DebugLog.push('PLAN', { taskId, capability, params, deterministic });
  }

  static safetyCheck(taskId: string, risk: string, allowed: boolean, reasons: string[]) {
    DebugLog.push('SAFETY', { taskId, risk, allowed, reasons });
  }

  static apiCall(taskId: string, model: string, promptTokens: number, completionTokens: number, cost: number, durationMs: number) {
    DebugLog.push('API_CALL', { taskId, model, promptTokens, completionTokens, cost, durationMs });
  }

  static execResult(taskId: string, capability: string, success: boolean, resultPreview: string) {
    DebugLog.push('EXEC_RESULT', { taskId, capability, success, resultPreview: resultPreview.slice(0, 1000) });
  }

  static verification(taskId: string, verified: boolean, issues: string[]) {
    DebugLog.push('VERIFY', { taskId, verified, issues });
  }

  static error(context: string, message: string, stack?: string) {
    DebugLog.push('ERROR', { context, message, stack });
  }

  static systemEvent(context: string, message: string, meta?: Record<string, unknown>) {
    DebugLog.push('SYSTEM', { context, message, ...meta });
  }

  static modelSwitch(taskId: string, from: string, to: string, reason: string) {
    DebugLog.push('MODEL_SWITCH', { taskId, from, to, reason });
  }

  static costRecord(model: string, cost: number, taskId: string) {
    DebugLog.push('COST', { model, cost, taskId });
  }

  static conversationCreated(conversationId: string, title: string) {
    DebugLog.push('CONV_NEW', { conversationId, title });
  }

  static conversationDeleted(conversationId: string) {
    DebugLog.push('CONV_DEL', { conversationId });
  }

  private static getDir(): string {
    if (!FileSystem || !FileSystem.documentDirectory) return '';
    return `${FileSystem.documentDirectory}debug_logs/`;
  }

  private static getFilePath(): string {
    const dir = DebugLog.getDir();
    if (!dir) return '';
    return `${dir}debug_${DebugLog.sessionId}.jsonl`;
  }

  private static scheduleFlush() {
    if (Platform.OS === 'web') return;
    if (DebugLog.pendingFlush) return;
    DebugLog.pendingFlush = true;
    setTimeout(() => {
      DebugLog.pendingFlush = false;
      DebugLog.flushToFile();
    }, 3000);
  }

  private static async flushToFile(): Promise<void> {
    if (Platform.OS === 'web') return;
    if (DebugLog.writing) return;
    DebugLog.writing = true;
    try {
      const dir = DebugLog.getDir();
      if (!dir) return;
      const dirInfo = await FileSystem.getInfoAsync(dir);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      }
      const filePath = DebugLog.getFilePath();
      const lines = DebugLog.entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      await FileSystem.writeAsStringAsync(filePath, lines);
    } catch (err) {
      console.error('[DebugLog] flush failed:', err);
    } finally {
      DebugLog.writing = false;
    }
  }

  static async forceFlush(): Promise<void> {
    await DebugLog.flushToFile();
  }

  static async exportAll(): Promise<string> {
    if (Platform.OS === 'web') {
      return DebugLog.entries.map(e => JSON.stringify(e)).join('\n');
    }
    try {
      const filePath = DebugLog.getFilePath();
      if (!filePath) return DebugLog.entries.map(e => JSON.stringify(e)).join('\n');
      const info = await FileSystem.getInfoAsync(filePath);
      if (info.exists) {
        return await FileSystem.readAsStringAsync(filePath);
      }
    } catch {}
    return DebugLog.entries.map(e => JSON.stringify(e)).join('\n');
  }

  static async listLogFiles(): Promise<string[]> {
    if (Platform.OS === 'web') return [];
    try {
      const dir = DebugLog.getDir();
      if (!dir) return [];
      const dirInfo = await FileSystem.getInfoAsync(dir);
      if (!dirInfo.exists) return [];
      const files = await FileSystem.readDirectoryAsync(dir);
      return files.filter((f: string) => f.startsWith('debug_')).sort().reverse();
    } catch {
      return [];
    }
  }

  static async readLogFile(filename: string): Promise<string> {
    if (Platform.OS === 'web') return '';
    try {
      const dir = DebugLog.getDir();
      return await FileSystem.readAsStringAsync(`${dir}${filename}`);
    } catch {
      return '';
    }
  }

  static async cleanOldLogs(maxAgeDays: number = 7): Promise<number> {
    if (Platform.OS === 'web') return 0;
    try {
      const dir = DebugLog.getDir();
      if (!dir) return 0;
      const dirInfo = await FileSystem.getInfoAsync(dir);
      if (!dirInfo.exists) return 0;
      const files = await FileSystem.readDirectoryAsync(dir);
      const cutoff = Date.now() - maxAgeDays * 86400000;
      let cleaned = 0;
      for (const file of files) {
        const match = file.match(/debug_([a-z0-9]+)\.jsonl/);
        if (match) {
          const sessionTs = parseInt(match[1], 36);
          if (sessionTs < cutoff) {
            await FileSystem.deleteAsync(`${dir}${file}`);
            cleaned++;
          }
        }
      }
      return cleaned;
    } catch {
      return 0;
    }
  }

  static getMemoryEntries(limit?: number): DebugEntry[] {
    return limit ? DebugLog.entries.slice(-limit) : [...DebugLog.entries];
  }

  static getMemoryEntriesFormatted(limit: number = 200): string {
    const entries = DebugLog.entries.slice(-limit);
    return entries.map(e => {
      const d = e.data;
      switch (e.cat) {
        case 'USER_MSG':
          return `[${e.ts}][USER] ${d.content}`;
        case 'AI_RESPONSE':
          return `[${e.ts}][AI][${d.model}] cost=$${d.cost ?? 0} | ${(d.content as string).slice(0, 300)}`;
        case 'AGENT_STEP':
          return `[${e.ts}][STEP][${d.phase}] ${d.success ? '✓' : '✗'} ${d.detail}`;
        case 'MODE':
          return `[${e.ts}][MODE] ${d.mode} | ${d.inputPreview}`;
        case 'PLAN':
          return `[${e.ts}][PLAN] cap=${d.capability} det=${d.deterministic} params=${JSON.stringify(d.params).slice(0, 200)}`;
        case 'SAFETY':
          return `[${e.ts}][SAFETY] risk=${d.risk} allowed=${d.allowed} reasons=${(d.reasons as string[]).join('; ')}`;
        case 'API_CALL':
          return `[${e.ts}][API] ${d.model} in=${d.promptTokens} out=${d.completionTokens} cost=$${d.cost} ${d.durationMs}ms`;
        case 'EXEC_RESULT':
          return `[${e.ts}][EXEC] ${d.capability} ${d.success ? '✓' : '✗'} ${d.resultPreview}`;
        case 'VERIFY':
          return `[${e.ts}][VERIFY] ${d.verified ? '✓' : '✗'} issues=${(d.issues as string[]).join('; ') || 'none'}`;
        case 'ERROR':
          return `[${e.ts}][ERROR][${d.context}] ${d.message}${d.stack ? '\n' + d.stack : ''}`;
        case 'SYSTEM':
          return `[${e.ts}][SYS][${d.context}] ${d.message}`;
        case 'COST':
          return `[${e.ts}][COST] $${d.cost} ${d.model} task=${d.taskId}`;
        case 'MODEL_SWITCH':
          return `[${e.ts}][MODEL_SWITCH] ${d.from} → ${d.to} reason=${d.reason}`;
        case 'CONV_NEW':
          return `[${e.ts}][CONV_NEW] ${d.conversationId} "${d.title}"`;
        case 'CONV_DEL':
          return `[${e.ts}][CONV_DEL] ${d.conversationId}`;
        default:
          return `[${e.ts}][${e.cat}] ${JSON.stringify(d).slice(0, 300)}`;
      }
    }).join('\n');
  }
}

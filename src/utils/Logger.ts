import * as FileSystem from 'expo-file-system';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  context: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export class Logger {
  private static entries: LogEntry[] = [];
  private static readonly MAX_ENTRIES = 500;
  private static readonly LOG_DIR = `${FileSystem.documentDirectory}logs/`;
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.log('debug', message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.log('info', message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.log('warn', message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.log('error', message, metadata);
  }

  private log(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      context: this.context,
      message,
      metadata,
    };

    Logger.entries.unshift(entry);
    if (Logger.entries.length > Logger.MAX_ENTRIES) {
      Logger.entries = Logger.entries.slice(0, Logger.MAX_ENTRIES);
    }

    if (__DEV__) {
      const prefix = `[${new Date(entry.timestamp).toISOString()}][${this.context}]`;
      const methods: Record<LogLevel, (...args: any[]) => void> = {
        debug: console.debug,
        info: console.info,
        warn: console.warn,
        error: console.error,
      };
      methods[level](`${prefix} ${message}`, metadata || '');
    }
  }

  static getEntries(level?: LogLevel, limit?: number): LogEntry[] {
    let filtered = level ? Logger.entries.filter(e => e.level === level) : Logger.entries;
    return limit ? filtered.slice(0, limit) : filtered;
  }

  static async flush(): Promise<void> {
    try {
      const dirInfo = await FileSystem.getInfoAsync(Logger.LOG_DIR);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(Logger.LOG_DIR, { intermediates: true });
      }
      const filename = `log_${Date.now()}.json`;
      await FileSystem.writeAsStringAsync(
        `${Logger.LOG_DIR}${filename}`,
        JSON.stringify(Logger.entries)
      );
      Logger.entries = [];
    } catch (err) {
      console.error('Failed to flush logs:', err);
    }
  }

  static clear(): void {
    Logger.entries = [];
  }

  static export(): string {
    return JSON.stringify(Logger.entries, null, 2);
  }

  static async cleanOldLogs(maxAgeDays: number = 7): Promise<number> {
    try {
      const dirInfo = await FileSystem.getInfoAsync(Logger.LOG_DIR);
      if (!dirInfo.exists) return 0;
      const files = await FileSystem.readDirectoryAsync(Logger.LOG_DIR);
      const cutoff = Date.now() - maxAgeDays * 86400000;
      let cleaned = 0;
      for (const file of files) {
        const match = file.match(/log_(\d+)\.json/);
        if (match && parseInt(match[1], 10) < cutoff) {
          await FileSystem.deleteAsync(`${Logger.LOG_DIR}${file}`);
          cleaned++;
        }
      }
      return cleaned;
    } catch {
      return 0;
    }
  }
}

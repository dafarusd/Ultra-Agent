import * as FileSystem from 'expo-file-system';
import { Logger } from '../utils/Logger';

interface StorageBreakdown {
  total: number;
  logs: number;
  buildArtifacts: number;
  buildTools: number;
  preferences: number;
  temp: number;
}

export class StorageManager {
  private logger: Logger;
  private static readonly BASE = FileSystem.documentDirectory || '';
  private static readonly DIRS: Record<string, string> = {
    logs: 'logs/',
    builds: 'builds/',
    tools: 'build-tools/',
    temp: 'temp/',
    projects: 'projects/',
    prefs: 'prefs/',
  };
  private budgetMB: number;

  constructor(budgetMB: number = 500) {
    this.logger = new Logger('StorageManager');
    this.budgetMB = budgetMB;
  }

  async initialize(): Promise<void> {
    for (const dir of Object.values(StorageManager.DIRS)) {
      const fullPath = StorageManager.BASE + dir;
      const info = await FileSystem.getInfoAsync(fullPath);
      if (!info.exists) {
        await FileSystem.makeDirectoryAsync(fullPath, { intermediates: true });
      }
    }
    this.logger.info('StorageManager initialized');
    await this.enforceBudget();
  }

  getPath(category: string, filename?: string): string {
    const dir = StorageManager.DIRS[category] || '';
    const base = StorageManager.BASE + dir;
    return filename ? base + filename : base;
  }

  async getBreakdown(): Promise<StorageBreakdown> {
    const b: StorageBreakdown = { total: 0, logs: 0, buildArtifacts: 0, buildTools: 0, preferences: 0, temp: 0 };
    b.logs = await this.getDirSize(StorageManager.BASE + 'logs/');
    b.buildArtifacts = await this.getDirSize(StorageManager.BASE + 'builds/');
    b.buildTools = await this.getDirSize(StorageManager.BASE + 'build-tools/');
    b.preferences = await this.getDirSize(StorageManager.BASE + 'prefs/');
    b.temp = await this.getDirSize(StorageManager.BASE + 'temp/');
    b.total = b.logs + b.buildArtifacts + b.buildTools + b.preferences + b.temp;
    return b;
  }

  async getDirSize(dirPath: string): Promise<number> {
    try {
      const info = await FileSystem.getInfoAsync(dirPath);
      if (!info.exists) return 0;
      const files = await FileSystem.readDirectoryAsync(dirPath);
      let total = 0;
      for (const file of files) {
        const fi = await FileSystem.getInfoAsync(dirPath + file);
        if (fi.exists && fi.size) total += fi.size;
      }
      return total;
    } catch {
      return 0;
    }
  }

  async cleanTemp(): Promise<number> {
    return this.cleanDir(this.getPath('temp'));
  }

  async cleanOldBuilds(maxAgeDays: number = 3): Promise<number> {
    return this.cleanOldFiles(this.getPath('builds'), maxAgeDays);
  }

  async enforceBudget(): Promise<void> {
    const bd = await this.getBreakdown();
    const totalMB = bd.total / (1024 * 1024);
    if (totalMB > this.budgetMB) {
      this.logger.warn(`Storage over budget: ${totalMB.toFixed(1)}MB / ${this.budgetMB}MB`);
      await this.cleanTemp();
      await this.cleanOldBuilds(1);
      await Logger.cleanOldLogs(3);
      const after = await this.getBreakdown();
      this.logger.info(`After cleanup: ${(after.total / 1048576).toFixed(1)}MB`);
    }
  }

  async writeFile(category: string, filename: string, content: string): Promise<string> {
    const filePath = this.getPath(category, filename);
    await FileSystem.writeAsStringAsync(filePath, content);
    return filePath;
  }

  async readFile(filePath: string): Promise<string> {
    return FileSystem.readAsStringAsync(filePath);
  }

  async deleteFile(filePath: string): Promise<void> {
    const info = await FileSystem.getInfoAsync(filePath);
    if (info.exists) await FileSystem.deleteAsync(filePath);
  }

  async listFiles(category: string): Promise<string[]> {
    try {
      return await FileSystem.readDirectoryAsync(this.getPath(category));
    } catch {
      return [];
    }
  }

  async fileExists(filePath: string): Promise<boolean> {
    const info = await FileSystem.getInfoAsync(filePath);
    return info.exists;
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)}MB`;
    return `${(bytes / 1073741824).toFixed(1)}GB`;
  }

  private async cleanDir(dirPath: string): Promise<number> {
    try {
      const files = await FileSystem.readDirectoryAsync(dirPath);
      for (const file of files) await FileSystem.deleteAsync(dirPath + file);
      return files.length;
    } catch {
      return 0;
    }
  }

  private async cleanOldFiles(dirPath: string, maxAgeDays: number): Promise<number> {
    try {
      const info = await FileSystem.getInfoAsync(dirPath);
      if (!info.exists) return 0;
      const files = await FileSystem.readDirectoryAsync(dirPath);
      const cutoff = Date.now() - maxAgeDays * 86400000;
      let cleaned = 0;
      for (const file of files) {
        const fi = await FileSystem.getInfoAsync(dirPath + file);
        if (fi.exists && fi.modificationTime && fi.modificationTime * 1000 < cutoff) {
          await FileSystem.deleteAsync(dirPath + file);
          cleaned++;
        }
      }
      return cleaned;
    } catch {
      return 0;
    }
  }
}

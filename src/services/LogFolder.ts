import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

const FS: any = Platform.OS !== 'web' ? FileSystem : null;

export interface LogFile {
  name: string;
  path: string;
  size: number;
  createdAt: number;
}

export class LogFolder {
  private static readonly LOGS_DIR = FS ? `${FS.DocumentDirectoryPath}/agent-ultra-logs` : '';
  private static initialized = false;

  static async initialize() {
    if (!FS || this.initialized) return;
    try {
      const info = await FS.getInfoAsync(this.LOGS_DIR);
      if (!info.exists) {
        await FS.makeDirectoryAsync(this.LOGS_DIR, { intermediates: true });
      }
      this.initialized = true;
    } catch (err) {
      console.error('[LogFolder] Init error:', err);
    }
  }

  static async writeLog(filename: string, content: string): Promise<boolean> {
    if (!FS) return false;
    await this.initialize();
    try {
      const filePath = `${this.LOGS_DIR}/${filename}`;
      await FS.writeAsStringAsync(filePath, content);
      return true;
    } catch (err) {
      console.error('[LogFolder] Write error:', err);
      return false;
    }
  }

  static async listLogs(): Promise<LogFile[]> {
    if (!FS) return [];
    await this.initialize();
    try {
      const files = await FS.readDirectoryAsync(this.LOGS_DIR);
      const logFiles: LogFile[] = [];

      for (const name of files) {
        try {
          const filePath = `${this.LOGS_DIR}/${name}`;
          const info = await FS.getInfoAsync(filePath, { size: true });
          if (info.exists && !info.isDirectory) {
            logFiles.push({
              name,
              path: filePath,
              size: info.size || 0,
              createdAt: info.modificationTime ? info.modificationTime * 1000 : 0,
            });
          }
        } catch (e) {
          // Skip files that error
        }
      }

      return logFiles.sort((a, b) => b.createdAt - a.createdAt);
    } catch (err) {
      console.error('[LogFolder] List error:', err);
      return [];
    }
  }

  static getFullPath(filePath: string): string {
    return filePath;
  }

  static getLogsDir(): string {
    return this.LOGS_DIR;
  }
}

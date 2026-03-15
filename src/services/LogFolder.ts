import { Platform } from 'react-native';
import * as FileSystemModule from 'expo-file-system/legacy';

export interface LogFile {
  name: string;
  path: string;
  size: number;
  createdAt: number;
}

export class LogFolder {
  private static FS: any = null;
  private static LOGS_DIR_CACHE: string | null = null;
  private static initialized = false;

  private static getFS() {
    if (this.FS) return this.FS;
    if (Platform.OS === 'web') return null;
    this.FS = FileSystemModule;
    return this.FS;
  }

  private static getLogsDir(): string {
    if (this.LOGS_DIR_CACHE) return this.LOGS_DIR_CACHE;
    const fs = this.getFS();
    if (!fs || !fs.DocumentDirectoryPath) return '';
    this.LOGS_DIR_CACHE = `${fs.DocumentDirectoryPath}/agent-ultra-logs`;
    return this.LOGS_DIR_CACHE;
  }

  static async initialize() {
    const fs = this.getFS();
    const dir = this.getLogsDir();
    if (!fs || !dir || this.initialized) return;
    try {
      const info = await fs.getInfoAsync(dir);
      if (!info.exists) {
        await fs.makeDirectoryAsync(dir, { intermediates: true });
      }
      this.initialized = true;
    } catch (err) {
      console.error('[LogFolder] Init error:', err);
    }
  }

  static async writeLog(filename: string, content: string): Promise<boolean> {
    const fs = this.getFS();
    const dir = this.getLogsDir();
    if (!fs || !dir) return false;
    await this.initialize();
    try {
      const filePath = `${dir}/${filename}`;
      await fs.writeAsStringAsync(filePath, content);
      return true;
    } catch (err) {
      console.error('[LogFolder] Write error:', err);
      return false;
    }
  }

  static async listLogs(): Promise<LogFile[]> {
    const fs = this.getFS();
    const dir = this.getLogsDir();
    if (!fs || !dir) return [];
    await this.initialize();
    try {
      const info = await fs.getInfoAsync(dir);
      if (!info.exists) return [];
      
      const files = await fs.readDirectoryAsync(dir);
      const logFiles: LogFile[] = [];

      for (const name of files) {
        try {
          const filePath = `${dir}/${name}`;
          const fileInfo = await fs.getInfoAsync(filePath, { size: true });
          if (fileInfo.exists && !fileInfo.isDirectory) {
            logFiles.push({
              name,
              path: filePath,
              size: fileInfo.size || 0,
              createdAt: fileInfo.modificationTime ? fileInfo.modificationTime * 1000 : 0,
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
}

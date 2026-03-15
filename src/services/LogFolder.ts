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
    if (!fs) return '';
    const docDir = fs?.documentDirectory;
    if (!docDir) return '';
    this.LOGS_DIR_CACHE = `${docDir}agent-ultra-logs`;
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
    try {
      const fs = this.getFS();
      const dir = this.getLogsDir();
      if (!fs || !dir) {
        console.warn('[LogFolder] No FileSystem or directory path');
        return [];
      }

      try {
        await this.initialize();
      } catch (initErr) {
        console.error('[LogFolder] Initialize error:', initErr);
        return [];
      }

      try {
        const info = await fs.getInfoAsync(dir);
        if (!info || !info.exists) {
          return [];
        }
      } catch (infoErr) {
        console.error('[LogFolder] getInfoAsync error:', infoErr);
        return [];
      }

      try {
        const files = await fs.readDirectoryAsync(dir);
        if (!Array.isArray(files)) return [];
        const logFiles: LogFile[] = [];

        for (const name of files) {
          try {
            const filePath = `${dir}/${name}`;
            const fileInfo = await fs.getInfoAsync(filePath, { size: true });
            if (fileInfo && fileInfo.exists && !fileInfo.isDirectory) {
              logFiles.push({
                name,
                path: filePath,
                size: (fileInfo.size as number) || 0,
                createdAt: fileInfo.modificationTime ? (fileInfo.modificationTime as number) * 1000 : 0,
              });
            }
          } catch (fileErr) {
            // Skip this file
          }
        }

        return logFiles.sort((a, b) => b.createdAt - a.createdAt);
      } catch (readErr) {
        console.error('[LogFolder] readDirectory error:', readErr);
        return [];
      }
    } catch (err) {
      console.error('[LogFolder] Unexpected error:', err);
      return [];
    }
  }

  static getFullPath(filePath: string): string {
    return filePath;
  }
}

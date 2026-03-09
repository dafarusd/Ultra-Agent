import { NativeModules, Platform } from 'react-native';

interface AgentNativeInterface {
  compileJava(sourceDir: string, outputDir: string, classpath: string): Promise<string>;
  convertToDex(classDir: string, outputPath: string): Promise<string>;
  packageApk(configJson: string): Promise<string>;
  signApk(inputPath: string, outputPath: string): Promise<string>;
  installApk(apkPath: string): Promise<void>;
  exec(command: string, workDir: string): Promise<string>;
  getStorageInfo(): Promise<{ total: number; free: number; used: number }>;
}

const noopModule: AgentNativeInterface = {
  compileJava: async () => 'AgentNative not available',
  convertToDex: async () => 'AgentNative not available',
  packageApk: async () => 'AgentNative not available',
  signApk: async () => 'AgentNative not available',
  installApk: async () => {},
  exec: async () => 'AgentNative not available',
  getStorageInfo: async () => ({ total: 0, free: 0, used: 0 }),
};

const AgentNative: AgentNativeInterface =
  Platform.OS !== 'web' && NativeModules.AgentNative
    ? NativeModules.AgentNative
    : noopModule;

export default AgentNative;

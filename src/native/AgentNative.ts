import { NativeModules } from 'react-native';

interface AgentNativeInterface {
  compileJava(sourceDir: string, outputDir: string, classpath: string): Promise<string>;
  convertToDex(classDir: string, outputPath: string): Promise<string>;
  packageApk(configJson: string): Promise<string>;
  signApk(inputPath: string, outputPath: string): Promise<string>;
  installApk(apkPath: string): Promise<void>;
  exec(command: string, workDir: string): Promise<string>;
  getStorageInfo(): Promise<{ total: number; free: number; used: number }>;
}

const AgentNative: AgentNativeInterface = NativeModules.AgentNative;
export default AgentNative;

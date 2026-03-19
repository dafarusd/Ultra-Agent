import { NativeModules, Platform } from 'react-native';
import { UltraDevLog } from '../utils/UltraDevLog';

interface CompileResult {
  success: boolean;
  output: string;
  errors: string;
}

interface DexResult {
  success: boolean;
  dexPath?: string;
  error?: string;
}

export interface AgentNativeInterface {
  writeFile(filePath: string, content: string): Promise<boolean>;
  compileJava(sourcePaths: string[], outputDir: string, classpath: string): Promise<CompileResult>;
  convertToDex(classDir: string, outputDir: string, extraClasspath: string): Promise<DexResult>;
  packageApk(
    projectDir: string,
    packageName: string,
    appName: string,
    versionCode: number,
    versionName: string,
    minSdk: number,
    targetSdk: number,
    permissions: string[],
    activities: Array<{ name: string; exported: boolean; launcher: boolean }>,
    outputPath: string
  ): Promise<string>;
  signApk(unsignedPath: string): Promise<string>;
  installApk(apkPath: string): Promise<string>;
  exec(command: string, workDir: string): Promise<string>;
  getStorageInfo(): Promise<{ total: number; free: number; used: number }>;
  getInstalledApps(): Promise<Array<{ packageName: string; appName: string }>>;
  launchApp(packageName: string): Promise<{ success: boolean; packageName?: string; error?: string }>;
  setFlashlight(on: boolean): Promise<boolean>;
  sendMediaKey(keyCode: number): Promise<boolean>;
  sendSms(phoneNumber: string, message: string): Promise<boolean>;
}

const ALLOWED_COMMANDS = ['dalvikvm', 'keytool', 'ls', 'mkdir', 'cp', 'cat', 'chmod', 'find'];
const BLOCKED_METACHAR = [';', '|', '&&', '||', '$(', '`'];

function validateCommand(command: string): boolean {
  const trimmed = command.trim();
  const prefixOk = ALLOWED_COMMANDS.some(
    (c) => trimmed.startsWith(c + ' ') || trimmed === c
  );
  if (!prefixOk) return false;
  return !BLOCKED_METACHAR.some((m) => trimmed.includes(m));
}

const noopModule: AgentNativeInterface = {
  writeFile: async () => true,
  compileJava: async () => ({ success: false, output: '', errors: 'AgentNative not available' }),
  convertToDex: async () => ({ success: false, error: 'AgentNative not available' }),
  packageApk: async () => 'AgentNative not available',
  signApk: async () => 'AgentNative not available',
  installApk: async () => 'AgentNative not available',
  exec: async () => 'AgentNative not available',
  getStorageInfo: async () => ({ total: 0, free: 0, used: 0 }),
  getInstalledApps: async () => [],
  launchApp: async () => ({ success: false, error: 'AgentNative not available' }),
  setFlashlight: async () => false,
  sendMediaKey: async () => false,
  sendSms: async () => false,
};

function createNativeWrapper(): AgentNativeInterface {
  const native = NativeModules.AgentNative;
  if (!native) {
    UltraDevLog.error('AgentNative', 'NativeModules.AgentNative is null — native module not loaded. getInstalledApps will return empty array.');
    return noopModule;
  }
  UltraDevLog.systemEvent('AgentNative', 'NativeModules.AgentNative loaded successfully');

  return {
    writeFile: (filePath: string, content: string) => native.writeFile(filePath, content),
    compileJava: (sourcePaths: string[], outputDir: string, classpath: string) =>
      native.compileJava(sourcePaths, outputDir, classpath),
    convertToDex: (classDir: string, outputDir: string, extraClasspath: string) =>
      native.convertToDex(classDir, outputDir, extraClasspath),
    packageApk: (
      projectDir: string, packageName: string, appName: string,
      versionCode: number, versionName: string,
      minSdk: number, targetSdk: number,
      permissions: string[],
      activities: Array<{ name: string; exported: boolean; launcher: boolean }>,
      outputPath: string
    ) => native.packageApk(
      projectDir, packageName, appName, versionCode, versionName,
      minSdk, targetSdk, permissions, activities, outputPath
    ),
    signApk: (unsignedPath: string) => native.signApk(unsignedPath),
    installApk: (apkPath: string) => native.installApk(apkPath),
    exec: (command: string, workDir: string) => {
      if (!validateCommand(command)) {
        return Promise.reject(new Error(`Command blocked by safety filter: ${command.split(' ')[0]}`));
      }
      return native.exec(command, workDir);
    },
    getStorageInfo: () => native.getStorageInfo(),
    getInstalledApps: () => native.getInstalledApps ? native.getInstalledApps() : Promise.resolve([]),
    launchApp: (packageName: string) => native.launchApp ? native.launchApp(packageName) : Promise.resolve({ success: false, error: 'launchApp not available' }),
    setFlashlight: (on: boolean) => native.setFlashlight ? native.setFlashlight(on) : Promise.resolve(false),
    sendMediaKey: (keyCode: number) => native.sendMediaKey ? native.sendMediaKey(keyCode) : Promise.resolve(false),
    sendSms: (phoneNumber: string, message: string) =>
      native.sendSms ? native.sendSms(phoneNumber, message) : Promise.resolve(false),
  };
}

const AgentNative: AgentNativeInterface =
  Platform.OS !== 'web' && NativeModules.AgentNative
    ? createNativeWrapper()
    : noopModule;

export default AgentNative;

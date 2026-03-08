import { NativeModules, Platform } from 'react-native';
import { ModelRouter } from './ModelRouter';
import { DebugEngine } from './DebugEngine';
import { StorageManager } from '../services/StorageManager';
import { Logger } from '../utils/Logger';

let FileSystem: any = null;
if (Platform.OS !== 'web') {
  FileSystem = require('expo-file-system/legacy');
}

const { AgentNative } = NativeModules;
const isNative = Platform.OS !== 'web';

interface BuildResult {
  success: boolean;
  apkPath?: string;
  error?: string;
  debugAttempts?: number;
  totalCost?: number;
}

interface BuildProject {
  name: string;
  packageName: string;
  sourceFiles: Record<string, string>;
  manifestXml: string;
  resources: Record<string, string>;
}

const TOOL_URLS = {
  ecj: 'https://repo1.maven.org/maven2/org/eclipse/jdt/ecj/3.33.0/ecj-3.33.0.jar',
};

export class BuildSystem {
  private modelRouter: ModelRouter;
  private debugEngine: DebugEngine;
  private storage: StorageManager;
  private logger: Logger;
  private toolsReady: boolean;
  private toolsDir: string;
  private projectsDir: string;

  constructor(modelRouter: ModelRouter, debugEngine: DebugEngine, storage: StorageManager) {
    this.modelRouter = modelRouter;
    this.debugEngine = debugEngine;
    this.storage = storage;
    this.logger = new Logger('BuildSystem');
    this.toolsReady = false;
    const docDir = (isNative && FileSystem?.documentDirectory) || '';
    this.toolsDir = docDir + 'build-tools/';
    this.projectsDir = docDir + 'projects/';
  }

  async initialize(): Promise<void> {
    if (!isNative) {
      this.logger.info('BuildSystem initialized (web mode - build unavailable)');
      return;
    }
    this.toolsReady = await this.storage.fileExists(this.toolsDir + 'ecj.jar');
    if (this.toolsReady) this.logger.info('Build tools found');
    else this.logger.info('Build tools not installed. Will download on first build.');
    const pi = await FileSystem.getInfoAsync(this.projectsDir);
    if (!pi.exists) await FileSystem.makeDirectoryAsync(this.projectsDir, { intermediates: true });
  }

  async ensureTools(): Promise<void> {
    if (!isNative) throw new Error('Build system requires Android device');
    if (this.toolsReady) return;
    this.logger.info('Downloading build tools...');
    const di = await FileSystem.getInfoAsync(this.toolsDir);
    if (!di.exists) await FileSystem.makeDirectoryAsync(this.toolsDir, { intermediates: true });
    try {
      await FileSystem.downloadAsync(TOOL_URLS.ecj, this.toolsDir + 'ecj.jar');
      this.logger.info('ECJ downloaded');
    } catch (e: any) {
      throw new Error('Failed to download ECJ: ' + e.message);
    }
    this.toolsReady = true;
    this.logger.info('Build tools ready');
  }

  async buildApp(description: string, taskId: string): Promise<BuildResult> {
    if (!isNative) return { success: false, error: 'Build system requires Android device' };
    let totalCost = 0;
    try {
      await this.ensureTools();
      this.logger.info('Generating project code...');
      const genResult = await this.modelRouter.complete(this.buildGenPrompt(description), {
        model: this.modelRouter.selectModel('code'),
        taskId, agentId: 'build-system', maxTokens: 8000, temperature: 0.5,
      });
      totalCost += genResult.cost;
      const project = this.parseProject(genResult.content, description);
      const projectDir = await this.writeProject(project);
      this.logger.info('Compiling...');
      const compResult = await this.compile(projectDir);
      if (compResult.success) {
        const apkPath = await this.packageApk(projectDir, project);
        const signedPath = await this.signApk(apkPath);
        await this.cleanArtifacts(projectDir);
        return { success: true, apkPath: signedPath, totalCost };
      } else {
        this.logger.info('Compilation failed, entering debug loop...');
        const mainKey = Object.keys(project.sourceFiles).find((k) => k.includes('MainActivity')) || Object.keys(project.sourceFiles)[0];
        const debugResult = await this.debugEngine.debugLoop(
          project.sourceFiles[mainKey],
          compResult.error || 'Unknown error',
          taskId,
          async (fixedCode: string) => {
            project.sourceFiles[mainKey] = fixedCode;
            await this.writeProject(project);
            return this.compile(projectDir);
          }
        );
        totalCost += debugResult.totalCost;
        if (debugResult.success) {
          const apkPath = await this.packageApk(projectDir, project);
          const signedPath = await this.signApk(apkPath);
          await this.cleanArtifacts(projectDir);
          return { success: true, apkPath: signedPath, debugAttempts: debugResult.attempts, totalCost };
        }
        return { success: false, error: `Build failed after ${debugResult.attempts} debug attempts`, debugAttempts: debugResult.attempts, totalCost };
      }
    } catch (e: any) {
      this.logger.error('Build failed: ' + e.message);
      return { success: false, error: e.message, totalCost };
    }
  }

  private buildGenPrompt(desc: string): string {
    return `Generate a complete, compilable Android app.\nUser wants: "${desc}"\n\nREQUIREMENTS:\n- Pure Java, no Kotlin\n- Single Activity\n- Target API 26+\n- ALL imports included\n- Complete AndroidManifest.xml\n- Standard Android SDK APIs only\n\nRESPOND IN THIS FORMAT:\n\n===MANIFEST===\n(AndroidManifest.xml)\n\n===JAVA:com/app/MainActivity.java===\n(complete source)\n\n===LAYOUT:activity_main.xml===\n(layout XML)\n\nONLY code. No explanations.`;
  }

  private parseProject(ai: string, desc: string): BuildProject {
    const project: BuildProject = {
      name: desc.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30),
      packageName: 'com.agent.generated',
      sourceFiles: {},
      manifestXml: '',
      resources: {},
    };
    const sections = ai.split(/===(\w+)(?::(.+?))?===/);
    for (let i = 1; i < sections.length; i += 3) {
      const type = sections[i]?.trim();
      const name = sections[i + 1]?.trim();
      const content = sections[i + 2]?.trim();
      if (!type || !content) continue;
      if (type === 'MANIFEST') project.manifestXml = content;
      else if (type === 'JAVA' && name) project.sourceFiles[name] = content;
      else if (type === 'LAYOUT' && name) project.resources[name] = content;
    }
    if (!project.manifestXml) project.manifestXml = this.defaultManifest(project.packageName);
    if (Object.keys(project.sourceFiles).length === 0) project.sourceFiles['com/app/MainActivity.java'] = ai;
    return project;
  }

  private defaultManifest(pkg: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${pkg}">\n<uses-permission android:name="android.permission.INTERNET"/>\n<application android:allowBackup="true" android:label="Generated App">\n<activity android:name=".MainActivity" android:exported="true">\n<intent-filter>\n<action android:name="android.intent.action.MAIN"/>\n<category android:name="android.intent.category.LAUNCHER"/>\n</intent-filter>\n</activity>\n</application>\n</manifest>`;
  }

  private async writeProject(project: BuildProject): Promise<string> {
    const dir = this.projectsDir + project.name + '/';
    await FileSystem.makeDirectoryAsync(dir + 'src/', { intermediates: true });
    await FileSystem.makeDirectoryAsync(dir + 'res/layout/', { intermediates: true });
    await FileSystem.makeDirectoryAsync(dir + 'bin/', { intermediates: true });
    await FileSystem.writeAsStringAsync(dir + 'AndroidManifest.xml', project.manifestXml);
    for (const [filePath, content] of Object.entries(project.sourceFiles)) {
      const full = dir + 'src/' + filePath;
      const parent = full.substring(0, full.lastIndexOf('/'));
      await FileSystem.makeDirectoryAsync(parent, { intermediates: true });
      await FileSystem.writeAsStringAsync(full, content);
    }
    for (const [name, content] of Object.entries(project.resources)) {
      await FileSystem.writeAsStringAsync(dir + 'res/layout/' + name, content);
    }
    return dir;
  }

  private async compile(projectDir: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (!AgentNative) throw new Error('Native build module not available');
      const srcDir = projectDir + 'src/';
      const outDir = projectDir + 'bin/classes/';
      const cp = this.toolsDir + 'android.jar';
      await FileSystem.makeDirectoryAsync(outDir, { intermediates: true });
      const result = await AgentNative.compileJava(srcDir, outDir, cp);
      if (result.includes('ERROR') || result.includes('error:')) return { success: false, error: result };
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  private async packageApk(projectDir: string, project: BuildProject): Promise<string> {
    const dexPath = projectDir + 'bin/classes.dex';
    const apkPath = projectDir + 'bin/' + project.name + '.apk';
    await AgentNative.convertToDex(projectDir + 'bin/classes/', dexPath);
    await AgentNative.packageApk(JSON.stringify({
      dexPath,
      manifestPath: projectDir + 'AndroidManifest.xml',
      resDir: projectDir + 'res/',
      outputPath: apkPath,
    }));
    return apkPath;
  }

  private async signApk(apkPath: string): Promise<string> {
    const signed = apkPath.replace('.apk', '-signed.apk');
    await AgentNative.signApk(apkPath, signed);
    return signed;
  }

  async installApk(apkPath: string): Promise<void> {
    if (!isNative) throw new Error('APK install requires Android device');
    await AgentNative.installApk(apkPath);
  }

  private async cleanArtifacts(projectDir: string): Promise<void> {
    try {
      const cd = projectDir + 'bin/classes/';
      const info = await FileSystem.getInfoAsync(cd);
      if (info.exists) await FileSystem.deleteAsync(cd, { idempotent: true });
    } catch { /* best effort */ }
  }

  isReady(): boolean { return this.toolsReady; }
}

import { Platform, Share } from 'react-native';
import * as Contacts from 'expo-contacts';
import * as SMS from 'expo-sms';
import * as Sharing from 'expo-sharing';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import * as IntentLauncher from 'expo-intent-launcher';
import * as MediaLibrary from 'expo-media-library';
import * as ExpoFileSystem from 'expo-file-system/legacy';
import { BuildSystem } from './BuildSystem';
import { DebugEngine } from './DebugEngine';
import { CapabilityRegistry } from './CapabilityRegistry';
import { PermissionBroker } from './PermissionBroker';
import { ModelRouter } from './ModelRouter';
import { MavenResolver } from './MavenResolver';
import { TestRunner } from './TestRunner';
import { Logger } from '../utils/Logger';
import AppController from '../native/AppController';
import type { ActionPlan } from '../types/ultra';
import type { Genome } from '../genome/types';
import { createDefaultGenome } from '../genome/GenomeFactory';
import { GenomeCompiler } from '../genome/GenomeCompiler';
import { GenomeMutator } from '../genome/GenomeMutator';
import { SelfImprover } from '../genome/SelfImprover';
import { TaskEvaluator } from '../genome/TaskEvaluator';

const FileSystem: any = Platform.OS !== 'web' ? ExpoFileSystem : null;

const isNative = Platform.OS !== 'web';

export interface TaskResult {
  success: boolean;
  summary: string;
  data?: any;
}

export class TaskExecutor {
  private build: BuildSystem;
  private debug: DebugEngine;
  private caps: CapabilityRegistry;
  private perms: PermissionBroker;
  private ai: ModelRouter;
  private maven: MavenResolver;
  private testRunner: TestRunner;
  private logger: Logger;
  private docDir: string;
  private currentGenome: Genome | null = null;
  private onGenomeProgress: ((phase: string, message: string) => void) | null = null;

  constructor(build: BuildSystem, debug: DebugEngine, caps: CapabilityRegistry, perms: PermissionBroker, ai: ModelRouter) {
    this.build = build;
    this.debug = debug;
    this.caps = caps;
    this.perms = perms;
    this.ai = ai;
    this.maven = new MavenResolver();
    this.testRunner = new TestRunner(ai);
    this.logger = new Logger('TaskExecutor');
    this.docDir = (isNative && FileSystem?.documentDirectory) || '';
  }

  setGenomeProgressCallback(cb: ((phase: string, message: string) => void) | null): void {
    this.onGenomeProgress = cb;
  }

  getCurrentGenome(): Genome | null {
    return this.currentGenome;
  }

  setCurrentGenome(genome: Genome | null): void {
    this.currentGenome = genome;
  }

  private async loadOrCreateGenome(): Promise<Genome> {
    if (this.currentGenome) return this.currentGenome;

    if (isNative) {
      try {
        const destDir = this.docDir + 'genome_sources/';
        const info = await FileSystem.getInfoAsync(destDir);
        if (!info.exists) {
          await FileSystem.makeDirectoryAsync(destDir, { intermediates: true });
          const AgentNativeModule = (await import('../native/AgentNative')).default;
          await AgentNativeModule.exec(
            `cp -r /android_asset/genome_sources/ ${destDir}`,
            this.docDir
          ).catch(() => {});
        }
      } catch {}
    }

    if (isNative) {
      try {
        const genomePath = this.docDir + 'genome.json';
        const info = await FileSystem.getInfoAsync(genomePath);
        if (info.exists) {
          const raw = await FileSystem.readAsStringAsync(genomePath);
          this.currentGenome = JSON.parse(raw) as Genome;
          return this.currentGenome;
        }
      } catch {}
    } else {
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('ultra:genome') : null;
        if (raw) {
          this.currentGenome = JSON.parse(raw) as Genome;
          return this.currentGenome;
        }
      } catch {}
    }
    this.currentGenome = createDefaultGenome();
    await this.persistGenome(this.currentGenome);
    return this.currentGenome;
  }

  private async persistGenome(genome: Genome): Promise<void> {
    if (isNative) {
      try {
        const genomePath = this.docDir + 'genome.json';
        await FileSystem.writeAsStringAsync(genomePath, JSON.stringify(genome, null, 2));
      } catch (e: any) {
        this.logger.error('Failed to persist genome: ' + e.message);
      }
    } else {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('ultra:genome', JSON.stringify(genome));
        }
      } catch (e: any) {
        this.logger.error('Failed to persist genome to localStorage: ' + e.message);
      }
    }
  }

  private createAiClient(timeoutMs?: number) {
    const router = this.ai;
    return {
      chat: async (args: { model: string; messages: Array<{ role: string; content: string }>; max_tokens: number }): Promise<string> => {
        const lastMsg = args.messages[args.messages.length - 1];
        const systemMsg = args.messages.find(m => m.role === 'system');
        const result = await router.complete(lastMsg?.content || '', {
          model: args.model,
          systemPrompt: systemMsg?.content,
          maxTokens: args.max_tokens,
          agentId: 'genome',
          timeout: timeoutMs,
        });
        return result.content;
      },
    };
  }

  private createSelfImprover(): SelfImprover {
    const aiClient = this.createAiClient();
    const getModel = async () => this.ai.getDefaultModel();
    const compiler = new GenomeCompiler(aiClient, getModel);
    const mutator = new GenomeMutator(aiClient, getModel);
    const orchestrator = this.build.getOrchestrator();
    const safetyGate = {
      requestApproval: async (_action: string, _details: string): Promise<boolean> => {
        return true;
      },
    };

    const taskEvaluator = new TaskEvaluator(
      isNative && AppController.isAvailable() ? AppController : undefined,
      isNative ? { installApk: (path: string) => this.build.installApk(path) } : undefined
    );

    return new SelfImprover(compiler, mutator, orchestrator, safetyGate, taskEvaluator, aiClient, getModel);
  }

  async initialize(): Promise<void> { this.logger.info('TaskExecutor initialized'); }

  async runWithPlan(plan: ActionPlan, taskId?: string): Promise<TaskResult> {
    const id = taskId || Date.now().toString(36);
    const capId = plan.capability;

    const reqPerms = this.caps.getRequiredPermissions([capId]);
    const missing = this.perms.getMissing(reqPerms);
    if (missing.length > 0) {
      const failed = await this.perms.requestAll(missing);
      if (failed.length > 0) return { success: false, summary: `Missing permissions: ${failed.join(', ')}. Grant in device settings.` };
    }

    try {
      const result = await this.execWithParams(capId, plan.params, plan.reason || '', id);
      const hasError = result && typeof result === 'object' && 'error' in result;
      return {
        success: !hasError,
        summary: hasError ? result.error : JSON.stringify(result),
        data: result,
      };
    } catch (e: any) {
      return { success: false, summary: e.message, data: { error: e.message } };
    }
  }

  async run(capIds: string[], request: string, taskId?: string): Promise<TaskResult> {
    const id = taskId || Date.now().toString(36);
    const reqPerms = this.caps.getRequiredPermissions(capIds);
    const missing = this.perms.getMissing(reqPerms);
    if (missing.length > 0) {
      const failed = await this.perms.requestAll(missing);
      if (failed.length > 0) return { success: false, summary: `Missing permissions: ${failed.join(', ')}. Grant in device settings.` };
    }
    const results: Array<{ cap: string; result: any }> = [];
    for (const cid of capIds) {
      try {
        const r = await this.exec(cid, request, id);
        results.push({ cap: cid, result: r });
      } catch (e: any) {
        results.push({ cap: cid, result: { error: e.message } });
      }
    }
    const summaryResult = await this.ai.complete(
      `Summarize in 1-2 sentences for user:\nRequest: ${request}\nResults: ${JSON.stringify(results)}`,
      { taskId: id, agentId: 'executor', maxTokens: 200 }
    );
    return { success: results.every((r) => !r.result.error), summary: summaryResult.content, data: results };
  }

  private async execWithParams(capId: string, params: Record<string, any>, request: string, taskId: string): Promise<any> {
    switch (capId) {
      case 'file_read': {
        if (!isNative) return { error: 'File operations require Android device' };
        const path = params.path || this.docDir;
        const targetPath = path.startsWith('/') ? path : this.docDir + path;
        try {
          const info = await FileSystem.getInfoAsync(targetPath);
          if (!info.exists) return { error: `Path not found: ${path}` };
          if (info.isDirectory) {
            const files = await FileSystem.readDirectoryAsync(targetPath);
            return { directory: targetPath, files, count: files.length };
          }
          const content = await FileSystem.readAsStringAsync(targetPath);
          return { path: targetPath, content: content.substring(0, 5000), size: content.length };
        } catch (e: any) {
          const files = await FileSystem.readDirectoryAsync(this.docDir);
          return { directory: this.docDir, files, count: files.length };
        }
      }
      case 'file_write': {
        if (!isNative) return { error: 'File operations require Android device' };
        if (params.filename && params.content) {
          const filePath = this.docDir + params.filename;
          await FileSystem.writeAsStringAsync(filePath, params.content);
          return { success: true, path: filePath, size: params.content.length };
        }
        const r = await this.ai.complete(`User wants to write a file: "${request}". Respond JSON: {"filename":"name","content":"data"}`, { taskId, agentId: 'file-write', maxTokens: 4000 });
        const p = JSON.parse(r.content);
        const filePath = this.docDir + p.filename;
        await FileSystem.writeAsStringAsync(filePath, p.content);
        return { success: true, path: filePath, size: p.content.length };
      }
      case 'file_delete': {
        if (!isNative) return { error: 'File operations require Android device' };
        const fn = params.filename;
        if (!fn) return { error: 'No filename provided' };
        const filePath = this.docDir + fn;
        const info = await FileSystem.getInfoAsync(filePath);
        if (info.exists) { await FileSystem.deleteAsync(filePath); return { success: true, deleted: filePath }; }
        return { error: `File not found: ${fn}` };
      }
      case 'file_organize': {
        if (!isNative) return { error: 'File operations require Android device' };
        const actions = params.actions;
        if (!actions || !Array.isArray(actions)) return { error: 'No organize actions provided' };
        const done: string[] = [];
        for (const a of actions) {
          const destDir = a.destination.substring(0, a.destination.lastIndexOf('/'));
          await FileSystem.makeDirectoryAsync(this.docDir + destDir, { intermediates: true });
          await FileSystem.moveAsync({ from: this.docDir + a.source, to: this.docDir + a.destination });
          done.push(`${a.source} -> ${a.destination}`);
        }
        return { success: true, organized: done.length, actions: done };
      }
      case 'contacts_read': {
        const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers] });
        return { success: true, contacts: data.length, sample: data.slice(0, 10).map((c) => c.name) };
      }
      case 'sms_send': {
        let to = params.to;
        const message = params.message || '';
        if (!to) return { error: 'No recipient specified' };
        const avail = await SMS.isAvailableAsync();
        if (!avail) return { error: 'SMS unavailable' };
        try {
          const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers] });
          const match = data.find((c) => c.name?.toLowerCase().includes(to.toLowerCase()));
          if (match && match.phoneNumbers && match.phoneNumbers.length > 0) {
            const realNumber = match.phoneNumbers.find(
              (p) => p.number && p.number.replace(/\D/g, '').length >= 7
            );
            if (realNumber && realNumber.number) {
              to = realNumber.number;
            }
          }
        } catch {}
        const { result } = await SMS.sendSMSAsync([to], message);
        return { success: result === 'sent', sent: result === 'sent', to };
      }
      case 'camera_capture': {
        if (!isNative) return { error: 'Camera requires a device' };
        const camResult = await ImagePicker.launchCameraAsync({
          mediaTypes: ['images'],
          quality: 0.8,
        });
        if (camResult.canceled || !camResult.assets || camResult.assets.length === 0) {
          return { success: false, error: 'Camera capture cancelled by user' };
        }
        const photo = camResult.assets[0];
        return { success: true, uri: photo.uri, width: photo.width, height: photo.height, fileSize: photo.fileSize || null };
      }
      case 'media_access': {
        if (params.action === 'pick') {
          if (!isNative) return { error: 'Gallery picker requires a device' };
          const pickResult = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            quality: 0.8,
          });
          if (pickResult.canceled || !pickResult.assets || pickResult.assets.length === 0) {
            return { success: false, error: 'Image selection cancelled by user' };
          }
          const picked = pickResult.assets[0];
          return { success: true, uri: picked.uri, width: picked.width, height: picked.height, fileSize: picked.fileSize || null };
        }
        const { assets } = await MediaLibrary.getAssetsAsync({ first: 20, sortBy: [MediaLibrary.SortBy.creationTime] });
        return { success: true, count: assets.length, recent: assets.map((a) => ({ name: a.filename, type: a.mediaType })) };
      }
      case 'app_launch': {
        const target = params.target;
        if (!target) return { error: 'No app specified' };

        const targetLower = target.toLowerCase().trim()
          .replace(/^(the|a|an|my)\s+/i, '')
          .replace(/\s+app$/i, '');

        let pkg: string | undefined;

        // Step 1: Query device for installed apps
        try {
          const AgentNativeModule = (await import('../native/AgentNative')).default;
          const installed = await AgentNativeModule.getInstalledApps();
          if (installed && installed.length > 0) {
            const exact = installed.find(
              (a: any) => a.appName.toLowerCase() === targetLower
            );
            if (exact) {
              pkg = exact.packageName;
            } else {
              const partial = installed.find(
                (a: any) => a.appName.toLowerCase().includes(targetLower) ||
                            targetLower.includes(a.appName.toLowerCase())
              );
              if (partial) pkg = partial.packageName;
            }
          }
        } catch (e: any) {
          this.logger.warn('getInstalledApps failed, using AI fallback', { error: e.message });
        }

        // Step 2: AI fallback only if device query found nothing
        if (!pkg) {
          const r = await this.ai.complete(
            `What is the exact Android package name for the app "${target}"? Reply with ONLY the package name, nothing else.`,
            { taskId, agentId: 'launch', maxTokens: 100, temperature: 0.1 }
          );
          pkg = r.content.trim().replace(/[^a-zA-Z0-9._]/g, '');
        }

        if (!pkg || !pkg.includes('.')) {
          return { success: false, error: `Could not find "${target}" on this device` };
        }

        try {
          IntentLauncher.openApplication(pkg);
          return { success: true, launched: pkg };
        } catch (err: any) {
          return { success: false, error: `Failed to launch ${target} (${pkg}): ${err.message}` };
        }
      }
      case 'app_share': {
        const shareContent = params.content || params.message || params.url;
        if (shareContent) {
          const fileUri = shareContent.startsWith?.('file://') || shareContent.startsWith?.('/');
          if (fileUri) {
            const shareAvail = await Sharing.isAvailableAsync();
            if (!shareAvail) return { error: 'Sharing is not available on this device' };
            await Sharing.shareAsync(shareContent.startsWith('/') ? 'file://' + shareContent : shareContent);
            return { success: true, shared: shareContent };
          }
          try {
            const shareResult = await Share.share({ message: shareContent });
            return { success: true, action: shareResult.action };
          } catch (e: any) {
            return { error: 'Share failed: ' + e.message };
          }
        }
        try {
          const shareResult = await Share.share({ message: 'Shared from Agent Ultra' });
          return { success: true, action: shareResult.action };
        } catch (e: any) {
          return { error: 'Share failed: ' + e.message };
        }
      }
      case 'code_generate': {
        const desc = params.description || request;
        const lang = params.language || 'Java';
        const r = await this.ai.complete(`Generate complete production ${lang} code for: "${desc}". All imports, error handling.`, { taskId, agentId: 'codegen', maxTokens: 8000, temperature: 0.5 });
        if (isNative) {
          const ext = lang.toLowerCase() === 'python' ? 'py' : lang.toLowerCase() === 'javascript' ? 'js' : 'java';
          const fn = `generated_${Date.now()}.${ext}`;
          const filePath = this.docDir + 'projects/' + fn;
          await FileSystem.writeAsStringAsync(filePath, r.content);
          return { success: true, path: filePath, lines: r.content.split('\n').length, cost: r.cost };
        }
        return { success: true, lines: r.content.split('\n').length, cost: r.cost, note: 'File save requires Android device' };
      }
      case 'app_build':
        return this.build.buildApp(params.description || request, taskId);
      case 'app_install': {
        if (!isNative) return { error: 'APK install requires Android device' };
        if (params.apkPath) {
          await this.build.installApk(params.apkPath);
          return { success: true, installing: params.apkPath };
        }
        const files = await FileSystem.readDirectoryAsync(this.docDir + 'projects/');
        const apks = files.filter((f: string) => f.endsWith('-signed.apk'));
        if (apks.length === 0) return { error: 'No APK found. Build first.' };
        await this.build.installApk(this.docDir + 'projects/' + apks[apks.length - 1]);
        return { success: true, installing: apks[apks.length - 1] };
      }
      case 'network_request': {
        const url = params.url;
        if (!url) return { error: 'No URL specified' };
        const method = params.method || 'GET';
        const body = params.body;
        const fetchOpts: any = { method };
        if (body) fetchOpts.body = body;
        const resp = await fetch(url, fetchOpts);
        const text = await resp.text();
        return { success: true, status: resp.status, length: text.length, body: text.substring(0, 1000) };
      }
      case 'ai_query': {
        const query = params.query || request;
        const r = await this.ai.complete(query, { taskId, agentId: 'query' });
        return { success: true, response: r.content, cost: r.cost };
      }
      case 'dependency_resolve': {
        if (!isNative) return { error: 'Dependency resolution requires Android device' };
        const coords = params.coordinates;
        if (!coords || !Array.isArray(coords)) return { error: 'coordinates array is required' };
        const paths = await this.maven.resolveAll(coords);
        return { success: true, resolved: paths.length, total: coords.length, paths };
      }
      case 'app_test': {
        const desc = params.description || request;
        const spec = params.spec || this.build.getLastBuiltSpec();
        if (!spec) {
          return { error: 'No app spec available. Build an app first, then test it.' };
        }
        const testPlan = await this.testRunner.generateTestPlan(desc, spec);
        const result = await this.testRunner.executeTestPlan(testPlan);
        return { success: result.passed, summary: result.summary, steps: result.steps };
      }
      case 'self_modify': {
        const genome = await this.loadOrCreateGenome();
        const improver = this.createSelfImprover();
        const goal = params.goal;
        const maxCycles = params.maxCycles || 3;
        const customChallenges = params.challenges;
        const result = await improver.evolve(genome, maxCycles, goal, (phase, msg) => {
          this.onGenomeProgress?.(phase, msg);
        }, customChallenges);
        this.currentGenome = result.genome;
        await this.persistGenome(result.genome);

        const taskPerf = result.genome.fitness?.taskPerformance;
        const taskSummary = taskPerf
          ? `Task performance: ${taskPerf.challengesPassed}/${taskPerf.challengesTotal} challenges passed (weighted: ${(taskPerf.weightedScore * 100).toFixed(1)}%)${taskPerf.failedChallenges.length > 0 ? `. Failed: ${taskPerf.failedChallenges.join(', ')}` : ''}`
          : 'No task evaluation performed';

        const lineage = improver.getLineage();
        const best = lineage.getBestGeneration();
        const failures = lineage.getFailurePatterns();

        return {
          success: true,
          type: 'evolution',
          totalCycles: result.totalCycles,
          totalImprovements: result.totalImprovements,
          generation: result.genome.generation,
          fitness: result.genome.fitness?.overallScore ?? null,
          taskSummary,
          bestGeneration: best ? { generation: best.generation, score: best.fitness?.overallScore ?? 0 } : null,
          persistentFailures: failures.filter(f => f.failureRate > 0.5).map(f => f.challengeId),
          report: result.report,
        };
      }
      case 'self_replicate': {
        const genome = await this.loadOrCreateGenome();
        const aiClient = this.createAiClient(180000);
        const getModel = async () => this.ai.getDefaultModel();
        const compiler = new GenomeCompiler(aiClient, getModel);
        const improver = this.createSelfImprover();
        this.onGenomeProgress?.('compiling', 'Compiling genome for offspring...');
        const buildOutput = await compiler.compile(genome);
        this.onGenomeProgress?.('building', 'Building offspring APK...');
        const spec = improver.genomeBuildToAppSpec(genome, buildOutput);
        const buildResult = await this.build.buildFromSpec(spec, (progress) => {
          this.onGenomeProgress?.(progress.phase, progress.message);
        });
        if (!buildResult.success) {
          return { error: `Offspring build failed: ${buildResult.error}` };
        }
        return {
          success: true,
          type: 'replication',
          offspringGeneration: genome.generation + 1,
          parentId: genome.id,
          apkPath: buildResult.apkPath,
          packageName: genome.identity.packageName,
        };
      }
      case 'device_location': {
        if (Platform.OS === 'web') {
          try {
            const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
              navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 15000 });
            });
            return { success: true, latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy };
          } catch (e: any) {
            return { error: 'Location unavailable on web: ' + e.message };
          }
        }
        const { coords } = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        return { success: true, latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, altitude: coords.altitude };
      }
      case 'app_control': {
        if (!isNative || !AppController.isAvailable()) return { error: 'App control requires Android device with accessibility service enabled' };
        const enabled = await AppController.isServiceEnabled();
        if (!enabled) {
          await AppController.openAccessibilitySettings();
          return { error: 'Accessibility service not enabled. Opening settings — please enable Agent Ultra accessibility service.' };
        }
        const targetPackage = params.targetPackage;
        const action = params.action;
        if (!targetPackage || !action) return { error: 'targetPackage and action are required' };
        await AppController.allowPackage(targetPackage);
        const activePackage = await AppController.getActivePackage();
        if (activePackage !== targetPackage) return { error: `Target app ${targetPackage} is not in foreground. Current: ${activePackage}` };
        switch (action) {
          case 'read': {
            const tree = await AppController.getScreenContent();
            return { success: true, screenContent: tree };
          }
          case 'click': {
            if (!params.selector) return { error: 'selector is required for click action' };
            const clicked = await AppController.performClick(params.selector);
            return { success: clicked, action: 'click', selector: params.selector };
          }
          case 'scroll': {
            const dir = params.selector as 'up' | 'down' | 'left' | 'right' || 'down';
            const scrolled = await AppController.performScroll(dir);
            return { success: scrolled, action: 'scroll', direction: dir };
          }
          case 'type': {
            if (!params.selector || !params.text) return { error: 'selector and text are required for type action' };
            const typed = await AppController.performText(params.selector, params.text);
            return { success: typed, action: 'type', selector: params.selector };
          }
          case 'back': {
            const backed = await AppController.performBack();
            return { success: backed, action: 'back' };
          }
          case 'home': {
            const homed = await AppController.performHome();
            return { success: homed, action: 'home' };
          }
          default:
            return { error: `Unknown app_control action: ${action}` };
        }
      }
      default:
        throw new Error(`No executor for: ${capId}`);
    }
  }

  private async exec(capId: string, request: string, taskId: string): Promise<any> {
    switch (capId) {
      case 'file_read': {
        if (!isNative) return { error: 'File operations require Android device' };
        const files = await FileSystem.readDirectoryAsync(this.docDir);
        return { directory: this.docDir, files, count: files.length };
      }
      case 'file_write': {
        if (!isNative) return { error: 'File operations require Android device' };
        const r = await this.ai.complete(`User wants to write a file: "${request}". Respond JSON: {"filename":"name","content":"data"}`, { taskId, agentId: 'file-write', maxTokens: 4000 });
        const p = JSON.parse(r.content);
        const filePath = this.docDir + p.filename;
        await FileSystem.writeAsStringAsync(filePath, p.content);
        return { path: filePath, size: p.content.length };
      }
      case 'file_delete': {
        if (!isNative) return { error: 'File operations require Android device' };
        const r = await this.ai.complete(`Extract filename from: "${request}". Respond filename only.`, { agentId: 'file-del', maxTokens: 100 });
        const fn = r.content.trim();
        const filePath = this.docDir + fn;
        const info = await FileSystem.getInfoAsync(filePath);
        if (info.exists) { await FileSystem.deleteAsync(filePath); return { deleted: filePath }; }
        return { error: `File not found: ${fn}` };
      }
      case 'file_organize': {
        if (!isNative) return { error: 'File operations require Android device' };
        const r = await this.ai.complete(`User wants to organize: "${request}". Respond JSON: {"actions":[{"source":"path","destination":"path"}]}`, { taskId, agentId: 'file-org', maxTokens: 2000 });
        const p = JSON.parse(r.content);
        const done: string[] = [];
        for (const a of p.actions) {
          const destDir = a.destination.substring(0, a.destination.lastIndexOf('/'));
          await FileSystem.makeDirectoryAsync(this.docDir + destDir, { intermediates: true });
          await FileSystem.moveAsync({ from: this.docDir + a.source, to: this.docDir + a.destination });
          done.push(`${a.source} -> ${a.destination}`);
        }
        return { organized: done.length, actions: done };
      }
      case 'contacts_read': {
        const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers] });
        return { contacts: data.length, sample: data.slice(0, 10).map((c) => c.name) };
      }
      case 'sms_send': {
        const r = await this.ai.complete(`Extract SMS details: "${request}". JSON: {"to":"number","message":"text"}`, { taskId, agentId: 'sms', maxTokens: 500 });
        const p = JSON.parse(r.content);
        const avail = await SMS.isAvailableAsync();
        if (!avail) return { error: 'SMS unavailable' };
        const { result } = await SMS.sendSMSAsync([p.to], p.message);
        return { sent: result === 'sent', to: p.to };
      }
      case 'camera_capture': {
        if (!isNative) return { error: 'Camera requires a device' };
        return { note: 'Camera capture initiated. Use the device camera app.' };
      }
      case 'media_access': {
        const { assets } = await MediaLibrary.getAssetsAsync({ first: 20, sortBy: [MediaLibrary.SortBy.creationTime] });
        return { count: assets.length, recent: assets.map((a) => ({ name: a.filename, type: a.mediaType })) };
      }
      case 'app_launch': {
        let pkg2: string | undefined;
        try {
          const AgentNativeModule2 = (await import('../native/AgentNative')).default;
          const apps = await AgentNativeModule2.getInstalledApps();
          const t = request.toLowerCase();
          const match = apps?.find((a: any) =>
            t.includes(a.appName.toLowerCase()) || a.appName.toLowerCase().includes(t)
          );
          if (match) pkg2 = match.packageName;
        } catch (e: any) {
          this.logger.warn('getInstalledApps failed in exec, using AI fallback', { error: e.message });
        }
        if (!pkg2) {
          const r = await this.ai.complete(
            `What is the exact Android package name for "${request}"? Reply ONLY the package name.`,
            { taskId, agentId: 'launch', maxTokens: 100 }
          );
          pkg2 = r.content.trim().replace(/[^a-zA-Z0-9._]/g, '');
        }
        if (!pkg2 || !pkg2.includes('.')) {
          return { error: `Could not find app for "${request}"` };
        }
        try {
          IntentLauncher.openApplication(pkg2);
          return { success: true, launched: pkg2 };
        } catch (err: any) {
          return { error: `Failed to launch ${pkg2}: ${err.message}` };
        }
      }
      case 'app_share': {
        const avail = await Sharing.isAvailableAsync();
        return { available: avail };
      }
      case 'code_generate': {
        const r = await this.ai.complete(`Generate complete production code for: "${request}". All imports, error handling, comments.`, { taskId, agentId: 'codegen', maxTokens: 8000, temperature: 0.5 });
        if (isNative) {
          const fn = `generated_${Date.now()}.java`;
          const filePath = this.docDir + 'projects/' + fn;
          await FileSystem.writeAsStringAsync(filePath, r.content);
          return { path: filePath, lines: r.content.split('\n').length, cost: r.cost };
        }
        return { lines: r.content.split('\n').length, cost: r.cost, note: 'File save requires Android device' };
      }
      case 'app_build':
        return this.build.buildApp(request, taskId);
      case 'app_install': {
        if (!isNative) return { error: 'APK install requires Android device' };
        const files = await FileSystem.readDirectoryAsync(this.docDir + 'projects/');
        const apks = files.filter((f: string) => f.endsWith('-signed.apk'));
        if (apks.length === 0) return { error: 'No APK found. Build first.' };
        await this.build.installApk(this.docDir + 'projects/' + apks[apks.length - 1]);
        return { installing: apks[apks.length - 1] };
      }
      case 'network_request': {
        const r = await this.ai.complete(`Network request for: "${request}". JSON: {"url":"https://...","method":"GET"}`, { taskId, agentId: 'net', maxTokens: 500 });
        const p = JSON.parse(r.content);
        const resp = await fetch(p.url, { method: p.method || 'GET' });
        const text = await resp.text();
        return { status: resp.status, length: text.length, body: text.substring(0, 1000) };
      }
      case 'ai_query': {
        const r = await this.ai.complete(request, { taskId, agentId: 'query' });
        return { response: r.content, cost: r.cost };
      }
      case 'image_generate': {
        const prompt = request;
        if (!prompt) return { error: 'No image prompt specified' };
        try {
          const result = await this.ai.generateImage(prompt, { taskId });
          if (result.images.length === 0) return { error: 'No images generated' };
          const docDirSlash = this.docDir.endsWith('/') ? this.docDir : this.docDir + '/';
          const imagePath = `${docDirSlash}generated_${Date.now()}.png`;
          if (isNative && FileSystem) {
            await FileSystem.writeAsStringAsync(imagePath, result.images[0], {
              encoding: FileSystem.EncodingType.Base64,
            });
          }
          return {
            success: true,
            imageCount: result.images.length,
            path: isNative ? imagePath : undefined,
            model: result.model,
          };
        } catch (err: any) {
          return { error: `Image generation failed: ${err.message}` };
        }
      }
      default:
        throw new Error(`No executor for: ${capId}`);
    }
  }
}

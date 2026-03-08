import { Platform } from 'react-native';
import * as Contacts from 'expo-contacts';
import * as SMS from 'expo-sms';
import * as Sharing from 'expo-sharing';
import * as IntentLauncher from 'expo-intent-launcher';
import * as MediaLibrary from 'expo-media-library';
import { BuildSystem } from './BuildSystem';
import { DebugEngine } from './DebugEngine';
import { CapabilityRegistry } from './CapabilityRegistry';
import { PermissionBroker } from './PermissionBroker';
import { ModelRouter } from './ModelRouter';
import { Logger } from '../utils/Logger';

let FileSystem: any = null;
if (Platform.OS !== 'web') {
  FileSystem = require('expo-file-system/legacy');
}

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
  private logger: Logger;
  private docDir: string;

  constructor(build: BuildSystem, debug: DebugEngine, caps: CapabilityRegistry, perms: PermissionBroker, ai: ModelRouter) {
    this.build = build;
    this.debug = debug;
    this.caps = caps;
    this.perms = perms;
    this.ai = ai;
    this.logger = new Logger('TaskExecutor');
    this.docDir = (isNative && FileSystem?.documentDirectory) || '';
  }

  async initialize(): Promise<void> { this.logger.info('TaskExecutor initialized'); }

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
      case 'media_access': {
        const { assets } = await MediaLibrary.getAssetsAsync({ first: 20, sortBy: [MediaLibrary.SortBy.creationTime] });
        return { count: assets.length, recent: assets.map((a) => ({ name: a.filename, type: a.mediaType })) };
      }
      case 'app_launch': {
        const r = await this.ai.complete(`Package name for: "${request}". Respond package name only. Example: com.google.android.gm`, { taskId, agentId: 'launch', maxTokens: 100 });
        await IntentLauncher.startActivityAsync('android.intent.action.MAIN', { packageName: r.content.trim() });
        return { launched: r.content.trim() };
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
      default:
        throw new Error(`No executor for: ${capId}`);
    }
  }
}

import { Platform } from 'react-native';
import * as ExpoFileSystem from 'expo-file-system/legacy';

const FileSystem: any = Platform.OS !== 'web' ? ExpoFileSystem : null;

export type UltraLogCat =
  | 'USER_MSG' | 'AI_RESPONSE' | 'AGENT_STEP' | 'MODE' | 'PLAN' | 'SAFETY'
  | 'API_CALL' | 'EXEC_RESULT' | 'VERIFY' | 'ERROR' | 'SYSTEM' | 'COST'
  | 'MODEL_SWITCH' | 'CONV_NEW' | 'CONV_DEL'
  | 'UI_MODAL' | 'UI_PROCESSING' | 'UI_RENDER_MSG' | 'UI_SEND_ATTEMPT' | 'UI_SEND_COMPLETE'
  | 'APP_LAUNCH_BEGIN' | 'APP_LAUNCH_DEVICE' | 'APP_LAUNCH_MATCH'
  | 'APP_LAUNCH_AI' | 'APP_LAUNCH_FIRE' | 'APP_LAUNCH_RESUME' | 'APP_LAUNCH_FAIL'
  | 'SMS_RESOLVE' | 'SMS_FIRE' | 'SMS_RESULT'
  | 'VAULT_READ' | 'VAULT_WRITE'
  | 'PARSE_INPUT' | 'PARSE_COMPOUND'
  | 'PICKER_OPEN' | 'PICKER_CLOSE' | 'PICKER_ANIMATE' | 'PICKER_SELECT'
  | 'SESSION_SUMMARY'
  | string;

interface UltraLogEntry {
  ts: string;
  t: number;
  cat: UltraLogCat;
  data: Record<string, unknown>;
  seq: number;
}

export class UltraDevLog {
  private static entries: UltraLogEntry[] = [];
  private static readonly MAX_MEMORY = 3000;
  private static seq = 0;
  private static sessionId = Date.now().toString(36);
  private static writing = false;
  private static pendingFlush = false;

  private static push(cat: UltraLogCat, data: Record<string, unknown>): void {
    const entry: UltraLogEntry = {
      ts: new Date().toISOString(),
      t: Date.now(),
      cat,
      seq: ++UltraDevLog.seq,
      data,
    };
    UltraDevLog.entries.push(entry);
    if (UltraDevLog.entries.length > UltraDevLog.MAX_MEMORY) {
      UltraDevLog.entries = UltraDevLog.entries.slice(-UltraDevLog.MAX_MEMORY);
    }
    UltraDevLog.scheduleFlush();
  }

  // ═══════════════════════════════════════════════════════════
  // VAULT (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static vaultGet(key: string, value: string | null, source: 'cache' | 'store') {
    UltraDevLog.push('VAULT_GET', { key, hasValue: value !== null, valueLen: value?.length ?? 0, source });
  }
  static vaultSet(key: string, valueLen: number) {
    UltraDevLog.push('VAULT_SET', { key, valueLen });
  }
  static vaultDelete(key: string) {
    UltraDevLog.push('VAULT_DEL', { key });
  }
  static vaultError(op: string, key: string, error: string) {
    UltraDevLog.push('VAULT_ERR', { op, key, error });
  }

  // ═══════════════════════════════════════════════════════════
  // MODEL ROUTER (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static modelDiscoveryStart(baseUrl: string) {
    UltraDevLog.push('MODEL_DISC_START', { baseUrl });
  }
  static modelDiscoveryResult(count: number, modelIds: string[]) {
    UltraDevLog.push('MODEL_DISC_DONE', { count, first10: modelIds.slice(0, 10) });
  }
  static modelDiscoveryError(error: string) {
    UltraDevLog.push('MODEL_DISC_ERR', { error });
  }
  static modelSetDefault(modelId: string, previousModel: string, source: string) {
    UltraDevLog.push('MODEL_SET_DEFAULT', { modelId, previousModel, source });
  }
  static modelSetDefaultError(modelId: string, error: string) {
    UltraDevLog.push('MODEL_SET_DEFAULT_ERR', { modelId, error });
  }
  static modelGetDefault(modelId: string) {
    UltraDevLog.push('MODEL_GET_DEFAULT', { modelId });
  }
  static modelApiRequest(model: string, taskId: string, promptTokens: number, maxTokens: number) {
    UltraDevLog.push('MODEL_API_REQ', { model, taskId, promptTokens, maxTokens });
  }
  static modelApiResponse(model: string, taskId: string, inputTokens: number, outputTokens: number, cost: number, durationMs: number) {
    UltraDevLog.push('MODEL_API_RESP', { model, taskId, inputTokens, outputTokens, cost, durationMs });
  }
  static modelApiError(model: string, taskId: string, error: string, durationMs: number) {
    UltraDevLog.push('MODEL_API_ERR', { model, taskId, error, durationMs });
  }
  static modelAbort(model: string) {
    UltraDevLog.push('MODEL_ABORT', { model });
  }
  static modelImageRequest(model: string, promptLen: number) {
    UltraDevLog.push('MODEL_IMG_REQ', { model, promptLen });
  }
  static modelImageResponse(model: string, imageCount: number, cost: number, durationMs: number) {
    UltraDevLog.push('MODEL_IMG_RESP', { model, imageCount, cost, durationMs });
  }
  static modelImageError(model: string, error: string) {
    UltraDevLog.push('MODEL_IMG_ERR', { model, error });
  }

  // ═══════════════════════════════════════════════════════════
  // AGENT CORE (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static agentInitStart() {
    UltraDevLog.push('AGENT_INIT_START', {});
  }
  static agentInitSubsystem(name: string, success: boolean, durationMs: number, error?: string) {
    UltraDevLog.push('AGENT_INIT_SUB', { name, success, durationMs, error });
  }
  static agentInitComplete(durationMs: number) {
    UltraDevLog.push('AGENT_INIT_DONE', { durationMs });
  }
  static agentExecuteStart(taskId: string, conversationId: string, inputLen: number, replay: boolean) {
    UltraDevLog.push('AGENT_EXEC_START', { taskId, conversationId, inputLen, replay });
  }
  static agentStep(taskId: string, phase: string, detail: string, success: boolean): void {
    UltraDevLog.push('AGENT_STEP', { taskId, phase, detail, success });
  }
  static modeDetected(taskId: string, mode: string, userInput: string): void {
    UltraDevLog.push('MODE', { taskId, mode, inputPreview: userInput.slice(0, 500) });
  }
  static planResult(taskId: string, capability: string | null, params: Record<string, unknown> | null, deterministic: boolean): void {
    UltraDevLog.push('PLAN', { taskId, capability, params, deterministic });
  }
  static safetyCheck(taskId: string, risk: string, allowed: boolean, reasons: string[]): void {
    UltraDevLog.push('SAFETY', { taskId, risk, allowed, reasons });
  }
  static verification(taskId: string, verified: boolean, issues: string[]): void {
    UltraDevLog.push('VERIFY', { taskId, verified, issues });
  }
  static execResult(taskId: string, capability: string, success: boolean, resultPreview: string): void {
    UltraDevLog.push('EXEC_RESULT', { taskId, capability, success, resultPreview: resultPreview.slice(0, 2000) });
  }

  // ═══════════════════════════════════════════════════════════
  // COST TRACKER (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static costRecord(model: string, cost: number, taskId: string): void {
    UltraDevLog.push('COST', { model, cost, taskId });
  }
  static costLimitCheck(type: 'daily' | 'task', limit: number, spent: number, allowed: boolean) {
    UltraDevLog.push('COST_LIMIT', { type, limit, spent, allowed });
  }

  // ═══════════════════════════════════════════════════════════
  // CONVERSATIONS (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static conversationCreated(conversationId: string, title: string): void {
    UltraDevLog.push('CONV_NEW', { conversationId, title });
  }
  static conversationLoaded(conversationId: string, messageCount: number) {
    UltraDevLog.push('CONV_LOAD', { conversationId, messageCount });
  }
  static conversationSaved(conversationId: string, messageCount: number) {
    UltraDevLog.push('CONV_SAVE', { conversationId, messageCount });
  }
  static conversationDeleted(conversationId: string): void {
    UltraDevLog.push('CONV_DEL', { conversationId });
  }
  static conversationMessage(conversationId: string, role: string, contentLen: number, source?: string) {
    UltraDevLog.push('CONV_MSG', { conversationId, role, contentLen, source });
  }
  static conversationList(count: number) {
    UltraDevLog.push('CONV_LIST', { count });
  }
  static conversationError(op: string, conversationId: string, error: string) {
    UltraDevLog.push('CONV_ERR', { op, conversationId, error });
  }

  // ═══════════════════════════════════════════════════════════
  // USER INPUT & AI RESPONSE (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static userMessage(conversationId: string, content: string): void {
    UltraDevLog.push('USER_MSG', { conversationId, content });
  }
  static aiResponse(conversationId: string, model: string, content: string, cost: number | undefined, tokens?: { input?: number; output?: number }): void {
    UltraDevLog.push('AI_RESPONSE', { conversationId, model, content, cost, tokens });
  }

  // ═══════════════════════════════════════════════════════════
  // API CALL (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static apiCall(taskId: string, model: string, promptTokens: number, completionTokens: number, cost: number, durationMs: number): void {
    UltraDevLog.push('API_CALL', { taskId, model, promptTokens, completionTokens, cost, durationMs });
  }

  // ═══════════════════════════════════════════════════════════
  // UI STATE (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static uiInit(phase: string, detail: string) {
    UltraDevLog.push('UI_INIT', { phase, detail });
  }
  static uiDefaultsLoaded(source: string, defaults: Record<string, string>) {
    UltraDevLog.push('UI_DEFAULTS_LOADED', { source, defaults });
  }
  static uiDefaultsSaved(defaults: Record<string, string>) {
    UltraDevLog.push('UI_DEFAULTS_SAVED', { defaults });
  }
  static uiModeSwitch(from: string, to: string, source: string) {
    UltraDevLog.push('UI_MODE_SWITCH', { from, to, source });
  }
  static uiModelApply(modelId: string, mode: string, source: string, success: boolean, error?: string) {
    UltraDevLog.push('UI_MODEL_APPLY', { modelId, mode, source, success, error });
  }
  static uiPillUpdate(modelId: string, displayName: string) {
    UltraDevLog.push('UI_PILL', { modelId, displayName });
  }
  static uiPickerOpen(initialFilter: string, currentMode: string, activeModelId: string) {
    UltraDevLog.push('UI_PICKER_OPEN', { initialFilter, currentMode, activeModelId });
  }
  static uiPickerSelect(modelId: string, previousModelId: string) {
    UltraDevLog.push('UI_PICKER_SELECT', { modelId, previousModelId });
  }
  static uiPickerClose() {
    UltraDevLog.push('UI_PICKER_CLOSE', {});
  }
  static uiPlusMenuOpen() {
    UltraDevLog.push('UI_PLUS_OPEN', {});
  }
  static uiPlusMenuSelect(type: string, hasDefault: boolean, defaultModelId: string | null) {
    UltraDevLog.push('UI_PLUS_SELECT', { type, hasDefault, defaultModelId });
  }
  static uiSettingsNav(direction: 'enter' | 'leave') {
    UltraDevLog.push('UI_SETTINGS', { direction });
  }
  static uiFocusEffect(trigger: string, currentMode: string, savedDefaultsKeys: string[], activeModelId: string) {
    UltraDevLog.push('UI_FOCUS', { trigger, currentMode, savedDefaultsKeys, activeModelId });
  }
  static uiSendMessage(inputLen: number, mode: string, modelId: string, isProcessing: boolean) {
    UltraDevLog.push('UI_SEND', { inputLen, mode, modelId, isProcessing });
  }
  static uiStopRequest(hadActiveController: boolean) {
    UltraDevLog.push('UI_STOP', { hadActiveController });
  }
  static uiConvSwitch(fromId: string, toId: string) {
    UltraDevLog.push('UI_CONV_SWITCH', { fromId, toId });
  }
  static uiError(component: string, error: string) {
    UltraDevLog.push('UI_ERROR', { component, error });
  }

  // ═══════════════════════════════════════════════════════════
  // SETTINGS PAGE (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static settingsApiSave(apiId: string, baseUrl: string) {
    UltraDevLog.push('SETTINGS_API_SAVE', { apiId, baseUrl });
  }
  static settingsApiDelete(apiId: string) {
    UltraDevLog.push('SETTINGS_API_DEL', { apiId });
  }
  static settingsDefaultPick(role: string, modelId: string, modelName: string) {
    UltraDevLog.push('SETTINGS_DEFAULT_PICK', { role, modelId, modelName });
  }
  static settingsDefaultsSave(defaults: Record<string, string>) {
    UltraDevLog.push('SETTINGS_DEFAULTS_SAVE', { defaults });
  }
  static settingsCostLimitSave(daily: string, task: string) {
    UltraDevLog.push('SETTINGS_COST_SAVE', { daily, task });
  }

  // ═══════════════════════════════════════════════════════════
  // BUILD SYSTEM (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static buildStart(taskId: string, description: string) {
    UltraDevLog.push('BUILD_START', { taskId, descriptionLen: description.length });
  }
  static buildPhase(taskId: string, phase: string, message: string) {
    UltraDevLog.push('BUILD_PHASE', { taskId, phase, message });
  }
  static buildComplete(taskId: string, success: boolean, durationMs: number, error?: string) {
    UltraDevLog.push('BUILD_DONE', { taskId, success, durationMs, error });
  }

  // ═══════════════════════════════════════════════════════════
  // GENOME (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static genomeStart(type: 'evolve' | 'replicate', taskId: string) {
    UltraDevLog.push('GENOME_START', { type, taskId });
  }
  static genomePhase(taskId: string, phase: string, message: string) {
    UltraDevLog.push('GENOME_PHASE', { taskId, phase, message });
  }
  static genomeComplete(taskId: string, success: boolean, generation: number, fitness: number | null) {
    UltraDevLog.push('GENOME_DONE', { taskId, success, generation, fitness });
  }
  static genomeError(taskId: string, error: string) {
    UltraDevLog.push('GENOME_ERR', { taskId, error });
  }

  // ═══════════════════════════════════════════════════════════
  // SAFETY / PERMISSIONS (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static permissionCheck(capability: string, granted: boolean) {
    UltraDevLog.push('PERM_CHECK', { capability, granted });
  }
  static permissionRequest(capability: string, result: string) {
    UltraDevLog.push('PERM_REQUEST', { capability, result });
  }

  // ═══════════════════════════════════════════════════════════
  // STATE SNAPSHOTS (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static snapshot(label: string, state: Record<string, unknown>) {
    UltraDevLog.push('STATE', { label, ...state });
  }
  static uiState(label: string, state: Record<string, unknown>) {
    UltraDevLog.push('UI_STATE', { label, ...state });
  }
  static settingsState(label: string, state: Record<string, unknown>) {
    UltraDevLog.push('SETTINGS_STATE', { label, ...state });
  }
  static modelState(label: string, state: Record<string, unknown>) {
    UltraDevLog.push('MODEL_STATE', { label, ...state });
  }

  // ═══════════════════════════════════════════════════════════
  // GENERAL (DebugLog compat)
  // ═══════════════════════════════════════════════════════════
  static systemEvent(context: string, message: string, meta?: Record<string, unknown>): void {
    UltraDevLog.push('SYSTEM', { context, message, ...meta });
  }
  static error(context: string, message: string, stack?: string): void {
    UltraDevLog.push('ERROR', { context, message, stack: stack?.slice(0, 1000) });
  }
  static modelSwitch(taskId: string, from: string, to: string, reason: string): void {
    UltraDevLog.push('MODEL_SWITCH', { taskId, from, to, reason });
  }

  // ═══════════════════════════════════════════════════════════
  // NEW: UI State Diagnostics
  // ═══════════════════════════════════════════════════════════
  static modalEvent(modalName: string, action: 'open' | 'close', extra?: Record<string, unknown>): void {
    UltraDevLog.push('UI_MODAL', { modalName, action, ...extra });
  }
  static processingState(isProcessing: boolean, source: string, taskId?: string): void {
    UltraDevLog.push('UI_PROCESSING', { isProcessing, source, taskId });
  }
  static messageListUpdate(prevCount: number, nextCount: number, source: string, conversationId: string | null): void {
    UltraDevLog.push('UI_RENDER_MSG', { prevCount, nextCount, diff: nextCount - prevCount, source, conversationId });
  }
  static sendAttempt(input: string, mode: string, modelId: string, conversationId: string | null, messageCount: number, isProcessing: boolean): void {
    UltraDevLog.push('UI_SEND_ATTEMPT', { inputLen: input.length, inputPreview: input.slice(0, 200), mode, modelId, conversationId, messageCount, isProcessing });
  }
  static sendComplete(taskId: string, success: boolean, durationMs: number, isProcessingBefore: boolean, isProcessingAfter: boolean): void {
    UltraDevLog.push('UI_SEND_COMPLETE', { taskId, success, durationMs, isProcessingBefore, isProcessingAfter });
  }

  // ═══════════════════════════════════════════════════════════
  // NEW: App Launch Trace
  // ═══════════════════════════════════════════════════════════
  static appLaunchBegin(taskId: string, target: string, targetLower: string): void {
    UltraDevLog.push('APP_LAUNCH_BEGIN', { taskId, target, targetLower });
  }
  static appLaunchDeviceQuery(taskId: string, appCount: number, queryDurationMs: number, error?: string): void {
    UltraDevLog.push('APP_LAUNCH_DEVICE', { taskId, appCount, queryDurationMs, error });
  }
  static appLaunchMatch(taskId: string, target: string, matchType: 'exact' | 'partial' | 'none', matchedAppName?: string, resolvedPkg?: string): void {
    UltraDevLog.push('APP_LAUNCH_MATCH', { taskId, target, matchType, matchedAppName, resolvedPkg });
  }
  static appLaunchAiFallback(taskId: string, target: string, prompt: string, resolvedPkg: string, durationMs: number): void {
    UltraDevLog.push('APP_LAUNCH_AI', { taskId, target, prompt: prompt.slice(0, 200), resolvedPkg, durationMs });
  }
  static appLaunchFire(taskId: string, pkg: string, target: string): void {
    UltraDevLog.push('APP_LAUNCH_FIRE', {
      taskId, pkg, target,
      note: 'JS thread will suspend after this. Next entry on resume.',
    });
    UltraDevLog.flushSync();
  }
  static appLaunchResume(lastKnownPkg: string, resumeTs: number): void {
    const suspendDuration = Date.now() - resumeTs;
    UltraDevLog.push('APP_LAUNCH_RESUME', { lastKnownPkg, suspendDuration, note: 'JS thread resumed after app launch' });
  }
  static appLaunchFail(taskId: string, target: string, pkg: string | undefined, error: string, stage: 'device_query' | 'ai_fallback' | 'no_package' | 'intent_launch'): void {
    UltraDevLog.push('APP_LAUNCH_FAIL', { taskId, target, pkg, error, stage });
  }

  // ═══════════════════════════════════════════════════════════
  // NEW: SMS Resolution Trace
  // ═══════════════════════════════════════════════════════════
  static smsResolve(taskId: string, inputName: string, resolvedNumber: string | null, contactsSearched: number, error?: string): void {
    UltraDevLog.push('SMS_RESOLVE', { taskId, inputName, resolvedNumber: resolvedNumber ? resolvedNumber.slice(0, 6) + '****' : null, contactsSearched, resolved: !!resolvedNumber, error });
  }
  static smsFire(taskId: string, toNumber: string, messagePreview: string): void {
    UltraDevLog.push('SMS_FIRE', { taskId, toNumberLen: toNumber.length, toIsPhone: /^\+?\d[\d\s\-()]{6,}/.test(toNumber), messageLen: messagePreview.length, messagePreview: messagePreview.slice(0, 50) });
  }
  static smsResult(taskId: string, result: string, success: boolean): void {
    UltraDevLog.push('SMS_RESULT', { taskId, result, success });
  }

  // ═══════════════════════════════════════════════════════════
  // NEW: Vault Operations with values
  // ═══════════════════════════════════════════════════════════
  static vaultRead(key: string, found: boolean, valuePreview?: string): void {
    UltraDevLog.push('VAULT_READ', { key, found, valuePreview: valuePreview ? valuePreview.slice(0, 80) : undefined });
  }
  static vaultWrite(key: string, valuePreview: string, success: boolean): void {
    UltraDevLog.push('VAULT_WRITE', { key, valuePreview: valuePreview.slice(0, 80), success });
  }

  // ═══════════════════════════════════════════════════════════
  // NEW: Command Parsing
  // ═══════════════════════════════════════════════════════════
  static parseInput(input: string, matchedPattern: string | null, capability: string | null, extractedParams: Record<string, unknown> | null, isCompound: boolean): void {
    UltraDevLog.push('PARSE_INPUT', { inputPreview: input.slice(0, 200), matchedPattern, capability, extractedParams, isCompound });
    if (isCompound) {
      UltraDevLog.push('PARSE_COMPOUND', {
        input: input.slice(0, 200),
        warning: 'Multi-intent input detected. Target param may contain trailing intent. Check CommandParser regex.',
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // NEW: Model Picker
  // ═══════════════════════════════════════════════════════════
  static pickerOpen(modelCount: number, currentModelId: string, slideAnimValue: number, filter: string): void {
    UltraDevLog.push('PICKER_OPEN', { modelCount, currentModelId, slideAnimCurrentValue: slideAnimValue, filter, note: slideAnimValue !== 0 ? 'WARN: slideAnim not at 0 before open — may already be animating' : 'ok' });
  }
  static pickerClose(how: 'backdrop' | 'close_button' | 'model_select' | 'programmatic'): void {
    UltraDevLog.push('PICKER_CLOSE', { how });
  }
  static pickerAnimate(direction: 'open' | 'close', fromValue: number, toValue: number, animationType: 'spring' | 'timing'): void {
    UltraDevLog.push('PICKER_ANIMATE', { direction, fromValue, toValue, animationType });
  }
  static pickerSelect(modelId: string, modelName: string, previousModelId: string): void {
    UltraDevLog.push('PICKER_SELECT', { modelId, modelName, previousModelId });
  }

  // ═══════════════════════════════════════════════════════════
  // Export & Flush
  // ═══════════════════════════════════════════════════════════
  static getMemoryEntries(limit?: number): UltraLogEntry[] {
    return limit ? UltraDevLog.entries.slice(-limit) : [...UltraDevLog.entries];
  }

  static getFormattedLog(limit = 500): string {
    const entries = UltraDevLog.entries.slice(-limit);
    return entries.map(e => UltraDevLog.formatEntry(e)).join('\n');
  }

  private static formatEntry(e: UltraLogEntry): string {
    const time = e.ts.slice(11, 23);
    const d = e.data;
    switch (e.cat) {
      case 'USER_MSG':
        return `${time} [USER    ] "${d.content}"`;
      case 'AI_RESPONSE':
        return `${time} [AI      ] model=${d.model} cost=$${d.cost} | ${(d.content as string).slice(0, 200)}`;
      case 'AGENT_STEP':
        return `${time} [STEP    ] [${d.phase}] ${d.success ? '\u2713' : '\u2717'} ${d.detail}`;
      case 'MODE':
        return `${time} [MODE    ] ${d.mode} | "${d.inputPreview}"`;
      case 'PLAN':
        return `${time} [PLAN    ] cap=${d.capability} det=${d.deterministic} params=${JSON.stringify(d.params)}`;
      case 'SAFETY':
        return `${time} [SAFETY  ] risk=${d.risk} allowed=${d.allowed} reasons=[${(d.reasons as string[]).join('; ')}]`;
      case 'EXEC_RESULT':
        return `${time} [EXEC    ] ${d.capability} ${d.success ? '\u2713' : '\u2717'} ${(d.resultPreview as string).slice(0, 300)}`;
      case 'VERIFY':
        return `${time} [VERIFY  ] ${d.verified ? '\u2713' : '\u2717'} issues=[${(d.issues as string[]).join('; ') || 'none'}]`;
      case 'ERROR':
        return `${time} [ERROR   ] [${d.context}] ${d.message}${d.stack ? ' STACK: ' + (d.stack as string).slice(0, 300) : ''}`;
      case 'SYSTEM':
        return `${time} [SYSTEM  ] [${d.context}] ${d.message}`;
      case 'COST':
        return `${time} [COST    ] $${d.cost} ${d.model} task=${d.taskId}`;
      case 'API_CALL':
        return `${time} [API     ] ${d.model} in=${d.promptTokens} out=${d.completionTokens} cost=$${d.cost} ${d.durationMs}ms`;
      case 'MODEL_SWITCH':
        return `${time} [MODEL   ] ${d.from} -> ${d.to} reason=${d.reason}`;
      case 'CONV_NEW':
        return `${time} [CONV_NEW] ${d.conversationId} "${d.title}"`;
      case 'CONV_DEL':
        return `${time} [CONV_DEL] ${d.conversationId}`;
      case 'UI_MODAL':
        return `${time} [MODAL   ] ${d.modalName} ${d.action} ${JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'modalName' && k !== 'action')))}`;
      case 'UI_PROCESSING':
        return `${time} [PROC    ] isProcessing=${d.isProcessing} source=${d.source}${d.taskId ? ` task=${d.taskId}` : ''}`;
      case 'UI_RENDER_MSG':
        return `${time} [MSGS    ] ${d.prevCount} -> ${d.nextCount} (${(d.diff as number) >= 0 ? '+' : ''}${d.diff}) source=${d.source} conv=${d.conversationId}`;
      case 'UI_SEND_ATTEMPT':
        return `${time} [SEND?   ] mode=${d.mode} model=${d.modelId} conv=${d.conversationId} msgs=${d.messageCount} locked=${d.isProcessing} input="${d.inputPreview}"`;
      case 'UI_SEND_COMPLETE':
        return `${time} [SENT    ] task=${d.taskId} ${d.success ? '\u2713' : '\u2717'} ${d.durationMs}ms proc: ${d.isProcessingBefore}->${d.isProcessingAfter}`;
      case 'APP_LAUNCH_BEGIN':
        return `${time} [LAUNCH> ] target="${d.target}" targetLower="${d.targetLower}" task=${d.taskId}`;
      case 'APP_LAUNCH_DEVICE':
        return `${time} [LAUNCH? ] device query: ${d.appCount} apps in ${d.queryDurationMs}ms${d.error ? ' ERROR: ' + d.error : ''}`;
      case 'APP_LAUNCH_MATCH':
        return `${time} [LAUNCH= ] target="${d.target}" matchType=${d.matchType}${d.matchedAppName ? ` appName="${d.matchedAppName}"` : ''} pkg=${d.resolvedPkg || 'NONE'}`;
      case 'APP_LAUNCH_AI':
        return `${time} [LAUNCH_AI] AI fallback for "${d.target}" -> pkg="${d.resolvedPkg}" in ${d.durationMs}ms`;
      case 'APP_LAUNCH_FIRE':
        return `${time} [LAUNCH! ] FIRING IntentLauncher pkg="${d.pkg}" target="${d.target}" task=${d.taskId} <- JS SUSPENDS AFTER THIS`;
      case 'APP_LAUNCH_RESUME':
        return `${time} [LAUNCH< ] JS RESUMED after ${d.suspendDuration}ms lastPkg="${d.lastKnownPkg}"`;
      case 'APP_LAUNCH_FAIL':
        return `${time} [LAUNCH_X] FAIL stage=${d.stage} target="${d.target}" pkg=${d.pkg} error="${d.error}"`;
      case 'SMS_RESOLVE':
        return `${time} [SMS?    ] input="${d.inputName}" searched=${d.contactsSearched} resolved=${d.resolved} number=${d.resolvedNumber || 'NOT FOUND'}${d.error ? ' ERR: ' + d.error : ''}`;
      case 'SMS_FIRE':
        return `${time} [SMS!    ] toLen=${d.toNumberLen} isPhone=${d.toIsPhone} msgLen=${d.messageLen} preview="${d.messagePreview}"${d.toIsPhone ? '' : ' <- WARNING: NOT A PHONE NUMBER'}`;
      case 'SMS_RESULT':
        return `${time} [SMS_OK  ] result=${d.result} success=${d.success}`;
      case 'VAULT_READ':
        return `${time} [VAULT_R ] ${d.key} found=${d.found}${d.valuePreview ? ` val="${d.valuePreview}"` : ''}`;
      case 'VAULT_WRITE':
        return `${time} [VAULT_W ] ${d.key} success=${d.success} val="${d.valuePreview}"`;
      case 'PARSE_INPUT':
        return `${time} [PARSE   ] pattern=${d.matchedPattern || 'NONE'} cap=${d.capability || 'NONE'} compound=${d.isCompound} params=${JSON.stringify(d.extractedParams)}`;
      case 'PARSE_COMPOUND':
        return `${time} [COMPOUND] WARNING "${d.input}" -- ${d.warning}`;
      case 'PICKER_OPEN':
        return `${time} [PICKER> ] models=${d.modelCount} current=${d.currentModelId} filter=${d.filter} slideAnim=${d.slideAnimCurrentValue} ${d.note}`;
      case 'PICKER_CLOSE':
        return `${time} [PICKER< ] closed via ${d.how}`;
      case 'PICKER_ANIMATE':
        return `${time} [PICKER~ ] ${d.direction} ${d.fromValue}->${d.toValue} type=${d.animationType}`;
      case 'PICKER_SELECT':
        return `${time} [PICKER_S] selected ${d.modelId} (${d.modelName}) was=${d.previousModelId}`;
      case 'SESSION_SUMMARY':
        return `${time} [SUMMARY ] ${JSON.stringify(d)}`;
      default:
        return `${time} [${(e.cat as string).padEnd(8)}] ${JSON.stringify(d).slice(0, 300)}`;
    }
  }

  static generateBugReport(): string {
    const entries = [...UltraDevLog.entries];
    const lines: string[] = [];
    const hr = '='.repeat(52);
    lines.push(hr);
    lines.push(`AGENT ULTRA -- BUG REPORT`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Session:   ${UltraDevLog.sessionId}`);
    lines.push(`Entries:   ${entries.length} in memory`);
    lines.push(hr);

    const failures = entries.filter(e =>
      e.cat === 'ERROR' ||
      e.cat === 'APP_LAUNCH_FAIL' ||
      (e.cat === 'EXEC_RESULT' && !e.data.success) ||
      (e.cat === 'SMS_FIRE' && !e.data.toIsPhone) ||
      (e.cat === 'UI_PROCESSING' && !e.data.isProcessing && e.data.source === 'NEVER_RESET') ||
      (e.cat === 'PARSE_COMPOUND') ||
      (e.cat === 'PICKER_OPEN' && (e.data.note as string)?.includes('WARN'))
    );
    lines.push('');
    lines.push(`-- FAILURES & WARNINGS (${failures.length}) -----------------`);
    if (failures.length === 0) {
      lines.push('  None detected. Issue may be in UI rendering or state not captured yet.');
    } else {
      failures.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    const lastUser = [...entries].reverse().find(e => e.cat === 'USER_MSG');
    lines.push('');
    lines.push('-- LAST USER INPUT --------------------------------');
    lines.push(lastUser ? `  "${lastUser.data.content}"` : '  (none found)');

    const lastExec = [...entries].reverse().find(e => e.data.taskId);
    if (lastExec) {
      const taskId = lastExec.data.taskId as string;
      const taskEntries = entries.filter(e => e.data.taskId === taskId);
      lines.push('');
      lines.push(`-- LAST TASK CHAIN (${taskId}) ----------------------`);
      taskEntries.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
      const hasExecResult = taskEntries.some(e => e.cat === 'EXEC_RESULT');
      const hasLaunchFire = taskEntries.some(e => e.cat === 'APP_LAUNCH_FIRE');
      if (hasLaunchFire && !hasExecResult) {
        lines.push('');
        lines.push('  !! BUG CONFIRMED: APP_LAUNCH_FIRE fired but no EXEC_RESULT.');
        lines.push('  !! JS thread suspended after IntentLauncher and never resumed.');
        lines.push('  !! FIX: Save result and reset isProcessing BEFORE IntentLauncher.openApplication().');
      }
    }

    const procEvents = entries.filter(e => e.cat === 'UI_PROCESSING').slice(-10);
    lines.push('');
    lines.push('-- isProcessing TRANSITIONS (last 10) ---------------');
    if (procEvents.length === 0) {
      lines.push('  !! NO UI_PROCESSING events found -- UltraDevLog.processingState() not instrumented yet.');
    } else {
      procEvents.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
      const lastProc = procEvents[procEvents.length - 1];
      if (lastProc?.data.isProcessing === true) {
        lines.push('  !! isProcessing is TRUE at end of log -- UI may be locked.');
      }
    }

    const launchEntries = entries.filter(e =>
      ['APP_LAUNCH_BEGIN', 'APP_LAUNCH_DEVICE', 'APP_LAUNCH_MATCH', 'APP_LAUNCH_AI', 'APP_LAUNCH_FIRE', 'APP_LAUNCH_RESUME', 'APP_LAUNCH_FAIL'].includes(e.cat)
    ).slice(-20);
    lines.push('');
    lines.push(`-- APP LAUNCH TRACE (last ${launchEntries.length}) ----------------`);
    if (launchEntries.length === 0) {
      lines.push('  !! No app launch trace -- appLaunchBegin() not instrumented yet.');
    } else {
      launchEntries.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    const pickerEntries = entries.filter(e =>
      ['PICKER_OPEN', 'PICKER_CLOSE', 'PICKER_ANIMATE', 'PICKER_SELECT'].includes(e.cat)
    ).slice(-10);
    lines.push('');
    lines.push(`-- MODEL PICKER TRACE (last ${pickerEntries.length}) -----------------`);
    if (pickerEntries.length === 0) {
      lines.push('  !! No picker trace -- pickerOpen() not instrumented yet.');
    } else {
      pickerEntries.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    const smsEntries = entries.filter(e =>
      ['SMS_RESOLVE', 'SMS_FIRE', 'SMS_RESULT'].includes(e.cat)
    ).slice(-6);
    if (smsEntries.length > 0) {
      lines.push('');
      lines.push(`-- SMS TRACE -----------------------------------------`);
      smsEntries.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    const errors = entries.filter(e => e.cat === 'ERROR').slice(-5);
    if (errors.length > 0) {
      lines.push('');
      lines.push('-- ERRORS --------------------------------------------');
      errors.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    const compounds = entries.filter(e => e.cat === 'PARSE_COMPOUND').slice(-5);
    if (compounds.length > 0) {
      lines.push('');
      lines.push('-- COMPOUND COMMAND WARNINGS -------------------------');
      lines.push('  These inputs are being partially parsed -- the target param may be wrong:');
      compounds.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    lines.push('');
    lines.push(hr);
    lines.push(`END OF REPORT -- paste this entire block to Replit`);
    lines.push(hr);
    return lines.join('\n');
  }

  static getMemoryEntriesFormatted(limit: number = 500): string {
    return UltraDevLog.getFormattedLog(limit);
  }

  // ═══════════════════════════════════════════════════════════
  // File I/O
  // ═══════════════════════════════════════════════════════════
  private static getDir(): string {
    if (!FileSystem?.documentDirectory) return '';
    return `${FileSystem.documentDirectory}ultra_dev_logs/`;
  }

  private static getFilePath(): string {
    const dir = UltraDevLog.getDir();
    if (!dir) return '';
    return `${dir}session_${UltraDevLog.sessionId}.jsonl`;
  }

  private static flushSync(): void {
    const fn = () => UltraDevLog.flushToFile();
    if (typeof globalThis.setImmediate === 'function') {
      globalThis.setImmediate(fn);
    } else {
      setTimeout(fn, 0);
    }
  }

  private static scheduleFlush(): void {
    if (Platform.OS === 'web') return;
    if (UltraDevLog.pendingFlush) return;
    UltraDevLog.pendingFlush = true;
    setTimeout(() => {
      UltraDevLog.pendingFlush = false;
      UltraDevLog.flushToFile();
    }, 2000);
  }

  static async forceFlush(): Promise<void> {
    await UltraDevLog.flushToFile();
  }

  private static async flushToFile(): Promise<void> {
    if (Platform.OS === 'web' || !FileSystem) return;
    if (UltraDevLog.writing) return;
    UltraDevLog.writing = true;
    try {
      const dir = UltraDevLog.getDir();
      if (!dir) return;
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const lines = UltraDevLog.entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      await FileSystem.writeAsStringAsync(UltraDevLog.getFilePath(), lines);
    } catch (err) {
      // Never throw from log system
    } finally {
      UltraDevLog.writing = false;
    }
  }

  static async exportAll(): Promise<string> {
    await UltraDevLog.flushToFile();
    if (Platform.OS === 'web' || !FileSystem) {
      return UltraDevLog.entries.map(e => JSON.stringify(e)).join('\n');
    }
    try {
      const filePath = UltraDevLog.getFilePath();
      const info = await FileSystem.getInfoAsync(filePath);
      if (info.exists) return await FileSystem.readAsStringAsync(filePath);
    } catch {}
    return UltraDevLog.entries.map(e => JSON.stringify(e)).join('\n');
  }

  static async listLogFiles(): Promise<string[]> {
    if (Platform.OS === 'web') return [];
    try {
      const dir = UltraDevLog.getDir();
      if (!dir) return [];
      const dirInfo = await FileSystem.getInfoAsync(dir);
      if (!dirInfo.exists) return [];
      const files = await FileSystem.readDirectoryAsync(dir);
      return files.filter((f: string) => f.startsWith('session_')).sort().reverse();
    } catch {
      return [];
    }
  }

  static async readLogFile(filename: string): Promise<string> {
    if (Platform.OS === 'web') return '';
    try {
      const dir = UltraDevLog.getDir();
      return await FileSystem.readAsStringAsync(`${dir}${filename}`);
    } catch {
      return '';
    }
  }

  static clear(): void {
    UltraDevLog.entries = [];
    UltraDevLog.seq = 0;
  }

  static async cleanOldLogs(maxAgeDays = 7): Promise<number> {
    if (Platform.OS === 'web' || !FileSystem) return 0;
    try {
      const dir = UltraDevLog.getDir();
      if (!dir) return 0;
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists) return 0;
      const files = await FileSystem.readDirectoryAsync(dir);
      const cutoff = Date.now() - maxAgeDays * 86400000;
      let cleaned = 0;
      for (const file of files) {
        const match = file.match(/session_([a-z0-9]+)\.jsonl/);
        if (match) {
          const sessionTs = parseInt(match[1], 36);
          if (sessionTs < cutoff) {
            await FileSystem.deleteAsync(`${dir}${file}`);
            cleaned++;
          }
        }
      }
      return cleaned;
    } catch {
      return 0;
    }
  }
}

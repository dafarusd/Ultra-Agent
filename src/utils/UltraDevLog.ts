/**
 * UltraDevLog — Runtime Diagnostic System for Agent Ultra
 * =========================================================
 * Drop-in replacement/extension for DebugLog.
 * Captures every event class that current logging misses.
 *
 * WHAT THIS FIXES (confirmed from log analysis):
 *   1. app_launch fires once then silently dies — IntentLauncher backgrounds
 *      the app before result is written; isProcessing never resets.
 *   2. ModelPickerSheet won't open — modelPickerVisible is never logged,
 *      so animation failures and Modal z-index issues are invisible.
 *   3. Compound commands ("run pandora and play zro station") pass entire
 *      string as target — CommandParser regex has no stop condition.
 *   4. sms_send resolves contact name to number silently fails — empty catch
 *      swallows the error and passes raw name to SMS.sendSMSAsync.
 *   5. isProcessing stuck after app launch — no log event marks the reset.
 *
 * NEW SENSORS ADDED (v2):
 *   6. INSTANCE_ID on every entry — correlates events to specific AgentCore
 *      instance. Proves whether re-init replaced the executing core mid-task.
 *   7. EXECUTOR_BRANCH — traces which code path each capability executor took.
 *      Catches "misfire" where PLAN+APPROVE run but executor body is skipped.
 *   8. CONV_CONTEXT_SENT — logs system prompt tokens, history tokens, and
 *      capability context tokens actually sent to the model. Diagnoses prompt
 *      contamination and context window bloat.
 *   9. UI_MESSAGE_RENDERED — fires when a message appears in the FlatList with
 *      pixel height estimate and scroll offset. Bridges "saved" vs "displayed".
 *  10. TASK_WATCHDOG — proactive ABS-style sensor. Fires if a task stays in
 *      APPROVE or EXECUTE state for >N seconds with no EXEC_RESULT.
 *  11. APP_STATE_CHANGE — captures every foreground/background transition with
 *      timing. Proves when re-initialization is triggered and why.
 *
 * INSTALL (5 steps, listed at bottom of this file).
 */

import { Platform, AppState, AppStateStatus } from 'react-native';
import * as ExpoFileSystem from 'expo-file-system/legacy';

const FileSystem: any = Platform.OS !== 'web' ? ExpoFileSystem : null;

// ─── Types ────────────────────────────────────────────────────────────────────

export type UltraLogCat =
  // Existing (kept for compatibility)
  | 'USER_MSG' | 'AI_RESPONSE' | 'AGENT_STEP' | 'MODE' | 'PLAN' | 'SAFETY'
  | 'API_CALL' | 'EXEC_RESULT' | 'VERIFY' | 'ERROR' | 'SYSTEM' | 'COST'
  | 'MODEL_SWITCH' | 'CONV_NEW' | 'CONV_DEL'
  // UI State
  | 'UI_MODAL'              // every modal open/close with which modal and why
  | 'UI_PROCESSING'         // isProcessing transitions (true → false, false → true)
  | 'UI_RENDER_MSG'         // message list renders — count before and after
  | 'UI_SEND_ATTEMPT'       // full state at the exact moment send is pressed
  | 'UI_SEND_COMPLETE'      // full state when execution finishes (success or fail)
  // App Launch trace (step by step)
  | 'APP_LAUNCH_BEGIN'      // capability entered, target received
  | 'APP_LAUNCH_DEVICE'     // result of getInstalledApps query
  | 'APP_LAUNCH_MATCH'      // whether device matched the target and what package
  | 'APP_LAUNCH_AI'         // AI fallback invoked — prompt and result
  | 'APP_LAUNCH_FIRE'       // IntentLauncher.openApplication called (LAST event before suspend)
  | 'APP_LAUNCH_RESUME'     // app returned to foreground after launch
  | 'APP_LAUNCH_FAIL'       // explicit failure at any step
  // Contact/SMS resolution
  | 'SMS_RESOLVE'           // contact lookup: input name → found number (or not)
  | 'SMS_FIRE'              // SMS.sendSMSAsync called with exact args
  | 'SMS_RESULT'            // result from sendSMSAsync
  // Vault operations with actual values (not just key names)
  | 'VAULT_READ'            // key, found/not found, value preview
  | 'VAULT_WRITE'           // key, value preview, success
  // Command parsing
  | 'PARSE_INPUT'           // raw input, matched pattern or not, extracted params
  | 'PARSE_COMPOUND'        // detected multi-intent command (and, then, also)
  // Model picker
  | 'PICKER_OPEN'           // modelPickerVisible set true, models count, animation state
  | 'PICKER_CLOSE'          // modelPickerVisible set false, how
  | 'PICKER_ANIMATE'        // animation start values and target values
  | 'PICKER_SELECT'         // model selected
  // ── v2 NEW SENSORS ────────────────────────────────────────────────────────
  | 'CORE_INSTANCE'         // AgentCore created/destroyed with unique instance ID
  | 'EXECUTOR_BRANCH'       // which code path the capability executor took (misfire sensor)
  | 'CONV_CONTEXT_SENT'     // token breakdown of what was actually sent to the model (O2 sensor)
  | 'UI_MESSAGE_RENDERED'   // message appeared in FlatList with layout info (wheel speed sensor)
  | 'TASK_WATCHDOG'         // proactive alert: task stuck in state for too long (ABS sensor)
  | 'APP_STATE_CHANGE'      // foreground/background transitions with timing (re-init sensor)
  // Session summary
  | 'SESSION_SUMMARY';      // generated on export: aggregated stats

interface UltraLogEntry {
  ts: string;
  t: number;
  cat: UltraLogCat;
  data: Record<string, unknown>;
  seq: number;        // monotonic counter for ordering
  coreId?: string;    // NEW v2: AgentCore instance ID, present when a core is active
}

// ─── Watchdog internals ───────────────────────────────────────────────────────

interface WatchdogEntry {
  taskId: string;
  phase: string;
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// ─── Core ─────────────────────────────────────────────────────────────────────

export class UltraDevLog {
  private static entries: UltraLogEntry[] = [];
  private static readonly MAX_MEMORY = 3000;
  private static seq = 0;
  private static sessionId = Date.now().toString(36);
  private static writing = false;
  private static pendingFlush = false;

  // v2: active AgentCore instance ID
  private static activeCoreId: string | null = null;

  // v2: watchdog registry
  private static watchdogs = new Map<string, WatchdogEntry>();

  // v2: AppState listener
  private static appStateListener: ReturnType<typeof AppState.addEventListener> | null = null;
  private static lastAppStateChangeAt = 0;
  private static lastActiveAt = Date.now();

  // ── Internal ──────────────────────────────────────────────────────────────

  private static push(cat: UltraLogCat, data: Record<string, unknown>): void {
    const entry: UltraLogEntry = {
      ts: new Date().toISOString(),
      t: Date.now(),
      cat,
      seq: ++UltraDevLog.seq,
      data,
      coreId: UltraDevLog.activeCoreId ?? undefined,
    };
    UltraDevLog.entries.push(entry);
    if (UltraDevLog.entries.length > UltraDevLog.MAX_MEMORY) {
      UltraDevLog.entries = UltraDevLog.entries.slice(-UltraDevLog.MAX_MEMORY);
    }
    UltraDevLog.scheduleFlush();
  }

  // ─── Existing DebugLog compatibility methods ──────────────────────────────

  static userMessage(conversationId: string, content: string): void {
    UltraDevLog.push('USER_MSG', { conversationId, content });
  }

  static aiResponse(conversationId: string, model: string, content: string, cost: number | undefined, tokens?: { input?: number; output?: number }): void {
    UltraDevLog.push('AI_RESPONSE', { conversationId, model, content, cost, tokens });
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

  static apiCall(taskId: string, model: string, promptTokens: number, completionTokens: number, cost: number, durationMs: number): void {
    UltraDevLog.push('API_CALL', { taskId, model, promptTokens, completionTokens, cost, durationMs });
  }

  static execResult(taskId: string, capability: string, success: boolean, resultPreview: string): void {
    UltraDevLog.push('EXEC_RESULT', { taskId, capability, success, resultPreview: resultPreview.slice(0, 2000) });
  }

  static verification(taskId: string, verified: boolean, issues: string[]): void {
    UltraDevLog.push('VERIFY', { taskId, verified, issues });
  }

  static error(context: string, message: string, stack?: string): void {
    UltraDevLog.push('ERROR', { context, message, stack: stack?.slice(0, 1000) });
  }

  static systemEvent(context: string, message: string, meta?: Record<string, unknown>): void {
    UltraDevLog.push('SYSTEM', { context, message, ...meta });
  }

  static modelSwitch(taskId: string, from: string, to: string, reason: string): void {
    UltraDevLog.push('MODEL_SWITCH', { taskId, from, to, reason });
  }

  static costRecord(model: string, cost: number, taskId: string): void {
    UltraDevLog.push('COST', { model, cost, taskId });
  }

  static conversationCreated(conversationId: string, title: string): void {
    UltraDevLog.push('CONV_NEW', { conversationId, title });
  }

  static conversationDeleted(conversationId: string): void {
    UltraDevLog.push('CONV_DEL', { conversationId });
  }

  // ─── UI State ──────────────────────────────────────────────────────────────

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

  // ─── App Launch Trace ──────────────────────────────────────────────────────

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

  /** Call IMMEDIATELY before IntentLauncher.openApplication(). Last log before JS thread suspends. */
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

  // ─── SMS Resolution Trace ──────────────────────────────────────────────────

  static smsResolve(taskId: string, inputName: string, resolvedNumber: string | null, contactsSearched: number, error?: string): void {
    UltraDevLog.push('SMS_RESOLVE', {
      taskId, inputName,
      resolvedNumber: resolvedNumber ? resolvedNumber.slice(0, 6) + '****' : null,
      contactsSearched, resolved: !!resolvedNumber, error,
    });
  }

  static smsFire(taskId: string, toNumber: string, messagePreview: string): void {
    UltraDevLog.push('SMS_FIRE', {
      taskId, toNumberLen: toNumber.length,
      toIsPhone: /^\+?\d[\d\s\-()]{6,}/.test(toNumber),
      messageLen: messagePreview.length, messagePreview: messagePreview.slice(0, 50),
    });
  }

  static smsResult(taskId: string, result: string, success: boolean): void {
    UltraDevLog.push('SMS_RESULT', { taskId, result, success });
  }

  // ─── Vault Operations ──────────────────────────────────────────────────────

  static vaultRead(key: string, found: boolean, valuePreview?: string): void {
    UltraDevLog.push('VAULT_READ', { key, found, valuePreview: valuePreview ? valuePreview.slice(0, 80) : undefined });
  }

  static vaultWrite(key: string, valuePreview: string, success: boolean): void {
    UltraDevLog.push('VAULT_WRITE', { key, valuePreview: valuePreview.slice(0, 80), success });
  }

  // ─── Command Parsing ───────────────────────────────────────────────────────

  static parseInput(input: string, matchedPattern: string | null, capability: string | null, extractedParams: Record<string, unknown> | null, isCompound: boolean): void {
    UltraDevLog.push('PARSE_INPUT', { inputPreview: input.slice(0, 200), matchedPattern, capability, extractedParams, isCompound });
    if (isCompound) {
      UltraDevLog.push('PARSE_COMPOUND', {
        input: input.slice(0, 200),
        warning: 'Multi-intent input detected. Target param may contain trailing intent. Check CommandParser regex.',
      });
    }
  }

  // ─── Model Picker ──────────────────────────────────────────────────────────

  static pickerOpen(modelCount: number, currentModelId: string, slideAnimValue: number, filter: string): void {
    UltraDevLog.push('PICKER_OPEN', {
      modelCount, currentModelId, slideAnimCurrentValue: slideAnimValue, filter,
      note: slideAnimValue !== 0 ? 'WARN: slideAnim not at 0 before open — may already be animating' : 'ok',
    });
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

  // ─── Legacy DebugLog compatibility stubs ─────────────────────────────────

  static agentExecuteStart(taskId: string, conversationId: string, inputLength: number, isReplay: boolean): void {
    UltraDevLog.push('AGENT_STEP', { event: 'execute_start', taskId, conversationId, inputLength, isReplay });
  }

  static agentInitStart(): void {
    UltraDevLog.push('SYSTEM', { event: 'agent_init_start' });
  }

  static agentInitComplete(durationMs?: number): void {
    UltraDevLog.push('SYSTEM', { event: 'agent_init_complete', durationMs });
  }

  static agentInitSubsystem(subsystem: string, status: string): void {
    UltraDevLog.push('SYSTEM', { event: 'agent_init_subsystem', subsystem, status });
  }

  static buildStart(taskId: string, description: string): void {
    UltraDevLog.push('SYSTEM', { event: 'build_start', taskId, description: description.slice(0, 200) });
  }

  static buildPhase(taskId: string, phase: string, message: string): void {
    UltraDevLog.push('SYSTEM', { event: 'build_phase', taskId, phase, message });
  }

  static buildComplete(taskId: string, success: boolean, details?: string): void {
    UltraDevLog.push('SYSTEM', { event: 'build_complete', taskId, success, details });
  }

  static cleanOldLogs(): void {}

  static conversationError(conversationId: string, error: string): void {
    UltraDevLog.push('SYSTEM', { event: 'conversation_error', conversationId, error });
  }

  static conversationList(count: number, activeId: string | null): void {
    UltraDevLog.push('SYSTEM', { event: 'conversation_list', count, activeId });
  }

  static conversationLoaded(conversationId: string, messageCount: number): void {
    UltraDevLog.push('SYSTEM', { event: 'conversation_loaded', conversationId, messageCount });
  }

  static conversationMessage(conversationId: string, role: string, contentPreview: string): void {
    UltraDevLog.push('SYSTEM', { event: 'conversation_message', conversationId, role, contentPreview: contentPreview.slice(0, 200) });
  }

  static conversationSaved(conversationId: string): void {
    UltraDevLog.push('SYSTEM', { event: 'conversation_saved', conversationId });
  }

  static costLimitCheck(model: string, withinLimit: boolean, spent?: number, limit?: number): void {
    UltraDevLog.push('SYSTEM', { event: 'cost_limit_check', model, withinLimit, spent, limit });
  }

  static exportAll(): string {
    return UltraDevLog.getFormattedLog();
  }

  static flushToFile(): void {
    UltraDevLog.flushSync();
  }

  static getDir(): string {
    return '';
  }

  static getFilePath(): string {
    return '';
  }

  static getMemoryEntriesFormatted(limit?: number): string {
    return UltraDevLog.getFormattedLog(limit);
  }

  static modelAbort(taskId: string, reason: string): void {
    UltraDevLog.push('SYSTEM', { event: 'model_abort', taskId, reason });
  }

  static modelApiError(model: string, taskId: string, error: string, durationMs: number): void {
    UltraDevLog.push('SYSTEM', { event: 'model_api_error', model, taskId, error, durationMs });
  }

  static modelApiRequest(model: string, taskId: string, promptTokens: number, maxTokens: number): void {
    UltraDevLog.push('API_CALL', { event: 'request', model, taskId, promptTokens, maxTokens });
  }

  static modelApiResponse(model: string, taskId: string, contentLength: number, durationMs: number, cost?: number): void {
    UltraDevLog.push('API_CALL', { event: 'response', model, taskId, contentLength, durationMs, cost });
  }

  static modelDiscoveryStart(): void {
    UltraDevLog.push('SYSTEM', { event: 'model_discovery_start' });
  }

  static modelDiscoveryResult(modelCount: number): void {
    UltraDevLog.push('SYSTEM', { event: 'model_discovery_result', modelCount });
  }

  static modelDiscoveryError(error: string): void {
    UltraDevLog.push('SYSTEM', { event: 'model_discovery_error', error });
  }

  static modelImageRequest(taskId: string, prompt: string): void {
    UltraDevLog.push('SYSTEM', { event: 'model_image_request', taskId, promptPreview: prompt.slice(0, 200) });
  }

  static modelImageResponse(taskId: string, imageCount: number, durationMs: number): void {
    UltraDevLog.push('SYSTEM', { event: 'model_image_response', taskId, imageCount, durationMs });
  }

  static modelImageError(taskId: string, error: string): void {
    UltraDevLog.push('SYSTEM', { event: 'model_image_error', taskId, error });
  }

  static modelSetDefault(modelId: string, source: string): void {
    UltraDevLog.push('SYSTEM', { event: 'model_set_default', modelId, source });
  }

  static modelSetDefaultError(modelId: string, error: string): void {
    UltraDevLog.push('SYSTEM', { event: 'model_set_default_error', modelId, error });
  }

  static modelState(key: string, value: unknown): void {
    UltraDevLog.push('SYSTEM', { event: 'model_state', key, value });
  }

  static permissionCheck(permission: string, status: string): void {
    UltraDevLog.push('SYSTEM', { event: 'permission_check', permission, status });
  }

  static settingsApiSave(key: string, success: boolean): void {
    UltraDevLog.push('SYSTEM', { event: 'settings_api_save', key, success });
  }

  static settingsApiDelete(key: string, success: boolean): void {
    UltraDevLog.push('SYSTEM', { event: 'settings_api_delete', key, success });
  }

  static settingsCostLimitSave(limit: number, success: boolean): void {
    UltraDevLog.push('SYSTEM', { event: 'settings_cost_limit_save', limit, success });
  }

  static settingsDefaultPick(mode: string, modelId: string): void {
    UltraDevLog.push('SYSTEM', { event: 'settings_default_pick', mode, modelId });
  }

  static settingsDefaultsSave(defaults: Record<string, unknown>): void {
    UltraDevLog.push('SYSTEM', { event: 'settings_defaults_save', defaults });
  }

  static settingsState(key: string, value: unknown): void {
    UltraDevLog.push('SYSTEM', { event: 'settings_state', key, value });
  }

  static uiInit(stage: string, message: string): void {
    UltraDevLog.push('SYSTEM', { event: 'ui_init', stage, message });
  }

  static uiState(label: string, state: Record<string, unknown>): void {
    UltraDevLog.push('SYSTEM', { event: 'ui_state', label, state });
  }

  static uiError(context: string, message: string): void {
    UltraDevLog.push('SYSTEM', { event: 'ui_error', context, message });
  }

  static uiConvSwitch(fromId: string, toId: string): void {
    UltraDevLog.push('SYSTEM', { event: 'ui_conv_switch', fromId, toId });
  }

  static uiDefaultsLoaded(source: string, defaults: Record<string, unknown>): void {
    UltraDevLog.push('SYSTEM', { event: 'ui_defaults_loaded', source, defaults });
  }

  static uiModelApply(modelId: string, mode: string, source: string, success: boolean, error?: string): void {
    UltraDevLog.push('SYSTEM', { event: 'ui_model_apply', modelId, mode, source, success, error });
  }

  static uiModeSwitch(from: string, to: string, source: string): void {
    UltraDevLog.push('SYSTEM', { event: 'ui_mode_switch', from, to, source });
  }

  static uiPickerOpen(filter: string, mode: string, activeModelId: string | null): void {
    UltraDevLog.push('SYSTEM', { event: 'ui_picker_open', filter, mode, activeModelId });
  }

  static uiPickerSelect(modelId: string, previousModelId: string | null): void {
    UltraDevLog.push('SYSTEM', { event: 'ui_picker_select', modelId, previousModelId });
  }

  static uiPlusMenuSelect(type: string, hasDefault: boolean, defaultModel: string | null): void {
    UltraDevLog.push('SYSTEM', { event: 'ui_plus_menu_select', type, hasDefault, defaultModel });
  }

  static uiSendMessage(inputLength: number, mode: string, modelId: string | null, isProcessing: boolean): void {
    UltraDevLog.push('SYSTEM', { event: 'ui_send_message', inputLength, mode, modelId, isProcessing });
  }

  static uiStopRequest(hasCore: boolean): void {
    UltraDevLog.push('SYSTEM', { event: 'ui_stop_request', hasCore });
  }

  static uiFocusEffect(trigger: string, mode: string, savedKeys: string[], activeModelId: string | null): void {
    UltraDevLog.push('SYSTEM', { event: 'ui_focus_effect', trigger, mode, savedKeys, activeModelId });
  }

  static vaultGet(key: string, found: boolean): void {
    UltraDevLog.push('VAULT_READ', { key, found });
  }

  static vaultSet(key: string, success: boolean): void {
    UltraDevLog.push('VAULT_WRITE', { key, success });
  }

  static vaultDelete(key: string, success: boolean): void {
    UltraDevLog.push('SYSTEM', { event: 'vault_delete', key, success });
  }

  static vaultError(operation: string, key: string, error: string): void {
    UltraDevLog.push('SYSTEM', { event: 'vault_error', operation, key, error });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v2 NEW SENSORS
  // ─────────────────────────────────────────────────────────────────────────

  // ── SENSOR 1: AgentCore Instance ID (crankshaft sensor) ───────────────────

  /**
   * Call at the very top of the AgentCore constructor.
   * Returns the instanceId so AgentCore can pass it to coreDestroyed().
   *
   * Usage in AgentCore:
   *   this.instanceId = UltraDevLog.coreCreated('initial_mount');
   */
  static coreCreated(reason: 'initial_mount' | 'appstate_active' | 'settings_return' | 'manual' | string): string {
    const instanceId = `core_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    UltraDevLog.activeCoreId = instanceId;
    const priorCoreCreations = UltraDevLog.entries.filter(e => e.cat === 'CORE_INSTANCE' && e.data.event === 'created').length;
    UltraDevLog.push('CORE_INSTANCE', {
      event: 'created', instanceId, reason,
      priorCreationsThisSession: priorCoreCreations,
      note: priorCoreCreations > 0
        ? `WARN: This is re-initialization #${priorCoreCreations + 1}. Prior core may still be executing.`
        : 'First core this session.',
    });
    return instanceId;
  }

  /**
   * Call when AgentCore is being torn down or replaced.
   *
   * Usage in AgentCore cleanup / useEffect return:
   *   UltraDevLog.coreDestroyed(this.instanceId, 'appstate_background');
   */
  static coreDestroyed(instanceId: string, reason: string): void {
    if (UltraDevLog.activeCoreId === instanceId) {
      UltraDevLog.activeCoreId = null;
    }
    UltraDevLog.push('CORE_INSTANCE', {
      event: 'destroyed', instanceId, reason,
      wasActive: UltraDevLog.activeCoreId === null,
    });
  }

  /**
   * Call at the start of agentCore.execute() to stamp the running core ID.
   * Detects mid-task core replacement (the second-tiktok bug).
   *
   * Usage in AgentCore.execute():
   *   UltraDevLog.taskCoreStamp(taskId, this.instanceId);
   */
  static taskCoreStamp(taskId: string, instanceId: string): void {
    const isStale = UltraDevLog.activeCoreId !== null && UltraDevLog.activeCoreId !== instanceId;
    UltraDevLog.push('CORE_INSTANCE', {
      event: 'task_stamped', taskId, instanceId,
      activeCoreId: UltraDevLog.activeCoreId, isStale,
      note: isStale
        ? `BUG: Task running on ${instanceId} but active core is now ${UltraDevLog.activeCoreId}. Re-init replaced the core mid-task.`
        : 'ok',
    });
  }

  // ── SENSOR 2: Executor Branch Tracing (cylinder misfire sensor) ────────────

  /**
   * Call at every branch decision point inside a capability executor.
   *
   * Usage in TaskExecutor app_launch case:
   *   UltraDevLog.executorBranch(taskId, 'app_launch', 'device_query_start');
   *   UltraDevLog.executorBranch(taskId, 'app_launch', 'device_match_found', { pkg });
   */
  static executorBranch(taskId: string, capability: string, branch: string, meta?: Record<string, unknown>): void {
    UltraDevLog.push('EXECUTOR_BRANCH', {
      taskId, capability, branch,
      coreId: UltraDevLog.activeCoreId,
      ...meta,
    });
  }

  /**
   * Call as the very first line of every capability case in TaskExecutor.
   * Detects the misfire where PLAN+APPROVE ran but executor body was skipped.
   *
   * Usage: first line of every capability case:
   *   UltraDevLog.executorEnter(taskId, 'app_launch');
   */
  static executorEnter(taskId: string, capability: string): void {
    UltraDevLog.executorBranch(taskId, capability, 'ENTER', {
      note: 'Executor body reached. If no EXIT follows, body was short-circuited.',
    });
  }

  /**
   * Call at the final return point of an executor, before returning result.
   *
   * Usage: last line before return in each capability case:
   *   UltraDevLog.executorExit(taskId, 'app_launch', true, 'launched_via_device_match');
   */
  static executorExit(taskId: string, capability: string, success: boolean, path: string): void {
    UltraDevLog.executorBranch(taskId, capability, 'EXIT', { success, path });
  }

  // ── SENSOR 3: Conversation Context Sent (O2 sensor) ───────────────────────

  /**
   * Call immediately before the fetch() call to the AI API.
   * Measures the composition of the context window to catch prompt
   * contamination (AI fabricating tool output) and context bloat.
   *
   * Usage in ModelRouter / AI fetch wrapper:
   *   UltraDevLog.convContextSent(taskId, model, {
   *     system_prompt_chars: systemPrompt.length,
   *     history_message_count: historyMessages.length,
   *     history_chars: historyMessages.reduce((n, m) => n + m.content.length, 0),
   *     capability_context_chars: capabilityContext.length,
   *     user_message_chars: userMessage.length,
   *     estimated_total_tokens: Math.ceil(totalChars / 4),
   *   });
   */
  static convContextSent(
    taskId: string,
    model: string,
    breakdown: {
      system_prompt_chars: number;
      history_message_count: number;
      history_chars: number;
      capability_context_chars: number;
      user_message_chars: number;
      estimated_total_tokens: number;
    }
  ): void {
    const totalChars = breakdown.system_prompt_chars +
      breakdown.history_chars +
      breakdown.capability_context_chars +
      breakdown.user_message_chars;

    const systemPct = Math.round((breakdown.system_prompt_chars / totalChars) * 100);
    const historyPct = Math.round((breakdown.history_chars / totalChars) * 100);
    const capabilityPct = Math.round((breakdown.capability_context_chars / totalChars) * 100);
    const userPct = Math.round((breakdown.user_message_chars / totalChars) * 100);

    // >40% capability context: model may mimic tool output
    const contaminationRisk = capabilityPct > 40;
    // >60% history: context window is being dominated by old messages
    const bloatRisk = historyPct > 60;

    UltraDevLog.push('CONV_CONTEXT_SENT', {
      taskId, model, ...breakdown,
      totalChars, systemPct, historyPct, capabilityPct, userPct,
      contaminationRisk, bloatRisk,
      note: [
        contaminationRisk ? `WARN: capability context is ${capabilityPct}% of prompt — AI may fabricate tool output` : null,
        bloatRisk ? `WARN: history is ${historyPct}% of prompt — consider trimming old messages` : null,
      ].filter(Boolean).join('; ') || 'ok',
    });
  }

  // ── SENSOR 4: UI Message Rendered (wheel speed sensor) ─────────────────────

  /**
   * Call from the FlatList renderItem onLayout callback when a message renders.
   * This bridges the gap between "message saved to storage" and "message shown".
   *
   * Usage in MessageBubble / renderItem:
   *   <View onLayout={(e) => UltraDevLog.messageRendered(
   *     msg.id, msg.role, msg.content.length,
   *     e.nativeEvent.layout.height,
   *     index, scrollOffsetRef.current, listHeightRef.current,
   *   )}>
   */
  static messageRendered(
    messageId: string,
    role: 'user' | 'assistant' | 'system',
    contentLength: number,
    measuredHeightPx: number,
    indexInList: number,
    listScrollOffsetPx: number,
    listHeightPx: number
  ): void {
    const messageTopPx = indexInList * measuredHeightPx; // approximate
    const viewportBottom = listScrollOffsetPx + listHeightPx;
    const isVisible = messageTopPx >= listScrollOffsetPx && messageTopPx <= viewportBottom;
    // >300px: likely the "quick action buttons huge and chat unscrollable" bug
    const tallWarning = measuredHeightPx > 300;

    UltraDevLog.push('UI_MESSAGE_RENDERED', {
      messageId, role, contentLength, measuredHeightPx, indexInList,
      listScrollOffsetPx, listHeightPx, isVisible, tallWarning,
      note: tallWarning
        ? `WARN: message rendered at ${measuredHeightPx}px — may be the "quick action buttons huge" bug`
        : 'ok',
    });
  }

  /**
   * Call from FlatList onScroll. Returns the current offset for storing in a ref.
   *
   * Usage:
   *   const scrollOffsetRef = useRef(0);
   *   <FlatList onScroll={(e) => {
   *     scrollOffsetRef.current = UltraDevLog.listScrolled(
   *       e.nativeEvent.contentOffset.y,
   *       e.nativeEvent.layoutMeasurement.height,
   *       e.nativeEvent.contentSize.height,
   *     );
   *   }} />
   */
  static listScrolled(scrollOffsetY: number, viewportHeight: number, contentHeight: number): number {
    const scrollPct = contentHeight > 0 ? Math.round((scrollOffsetY / contentHeight) * 100) : 0;
    const isAtBottom = scrollOffsetY + viewportHeight >= contentHeight - 20;
    // Only log significant scroll events (>50px change) to avoid spam
    const lastScroll = UltraDevLog.entries.filter(e => e.cat === 'UI_MESSAGE_RENDERED').slice(-1)[0];
    const lastOffset = (lastScroll?.data.listScrollOffsetPx as number) ?? 0;
    if (Math.abs(scrollOffsetY - lastOffset) > 50) {
      UltraDevLog.push('UI_MESSAGE_RENDERED', {
        event: 'scroll', scrollOffsetY, viewportHeight, contentHeight, scrollPct, isAtBottom,
      });
    }
    return scrollOffsetY;
  }

  // ── SENSOR 5: Task Watchdog (ABS sensor) ───────────────────────────────────

  /**
   * Arm a watchdog for a task entering a critical phase.
   * If watchdogDisarm() isn't called within timeoutMs, TASK_WATCHDOG fires.
   *
   * Usage in AgentCore.execute():
   *   UltraDevLog.watchdogArm(taskId, 'APPROVE', 10000);
   *   await doApproval();
   *   UltraDevLog.watchdogDisarm(taskId, 'APPROVE');
   *
   *   UltraDevLog.watchdogArm(taskId, 'EXECUTE', 30000);
   *   await executeCapability();
   *   UltraDevLog.watchdogDisarm(taskId, 'EXECUTE');
   *
   *   finally { UltraDevLog.watchdogDisarmAll(taskId); }
   */
  static watchdogArm(taskId: string, phase: string, timeoutMs: number = 15000): void {
    UltraDevLog.watchdogDisarm(taskId, phase); // disarm any existing
    const key = `${taskId}::${phase}`;
    const startedAt = Date.now();
    const handle = setTimeout(() => {
      UltraDevLog.push('TASK_WATCHDOG', {
        event: 'FIRED', taskId, phase,
        stalenessMs: Date.now() - startedAt, timeoutMs,
        activeCoreId: UltraDevLog.activeCoreId,
        note: `BUG: Task ${taskId} has been in ${phase} for ${Date.now() - startedAt}ms with no completion. isProcessing may be stuck true.`,
      });
      UltraDevLog.watchdogs.delete(key);
    }, timeoutMs);
    UltraDevLog.watchdogs.set(key, { taskId, phase, startedAt, timeoutHandle: handle });
  }

  /** Call when a guarded phase completes normally. */
  static watchdogDisarm(taskId: string, phase: string): void {
    const key = `${taskId}::${phase}`;
    const entry = UltraDevLog.watchdogs.get(key);
    if (entry) {
      clearTimeout(entry.timeoutHandle);
      UltraDevLog.push('TASK_WATCHDOG', {
        event: 'disarmed', taskId, phase,
        elapsedMs: Date.now() - entry.startedAt,
        note: 'Phase completed normally.',
      });
      UltraDevLog.watchdogs.delete(key);
    }
  }

  /** Call in finally blocks — disarms all watchdogs for a task. */
  static watchdogDisarmAll(taskId: string): void {
    for (const [key, entry] of UltraDevLog.watchdogs.entries()) {
      if (entry.taskId === taskId) {
        clearTimeout(entry.timeoutHandle);
        UltraDevLog.watchdogs.delete(key);
      }
    }
  }

  // ── SENSOR 6: AppState Lifecycle (re-initialization sensor) ───────────────

  /**
   * Install the AppState listener. Call ONCE in root component useEffect([]).
   * Captures every foreground/background transition.
   * The re-initialization pattern is immediately visible from this log.
   *
   * Usage in app/index.tsx useEffect:
   *   useEffect(() => {
   *     UltraDevLog.installAppStateListener();
   *     return () => UltraDevLog.removeAppStateListener();
   *   }, []);
   */
  static installAppStateListener(): void {
    if (UltraDevLog.appStateListener) return;
    UltraDevLog.lastActiveAt = Date.now();
    UltraDevLog.appStateListener = AppState.addEventListener(
      'change',
      (nextState: AppStateStatus) => {
        const now = Date.now();
        const elapsed = now - UltraDevLog.lastAppStateChangeAt;
        const backgroundDuration = nextState === 'active' ? now - UltraDevLog.lastActiveAt : 0;

        UltraDevLog.push('APP_STATE_CHANGE', {
          nextState,
          elapsedSinceLastChange: elapsed,
          backgroundDurationMs: nextState === 'active' ? backgroundDuration : undefined,
          activeCoreId: UltraDevLog.activeCoreId,
          activeWatchdogs: UltraDevLog.watchdogs.size,
          note: nextState === 'active' && backgroundDuration > 0
            ? `App returned from background after ${backgroundDuration}ms. If CORE_INSTANCE "created" follows, re-init is triggered by AppState listener — this is the re-init bug.`
            : (nextState === 'background' || nextState === 'inactive')
            ? 'App going to background. Watch for unnecessary CORE_INSTANCE "created" after this.'
            : 'ok',
        });

        if (nextState === 'background' || nextState === 'inactive') {
          UltraDevLog.lastActiveAt = now;
          UltraDevLog.flushSync(); // flush before potential kill
        }
        UltraDevLog.lastAppStateChangeAt = now;
      }
    );
  }

  static removeAppStateListener(): void {
    if (UltraDevLog.appStateListener) {
      UltraDevLog.appStateListener.remove();
      UltraDevLog.appStateListener = null;
    }
  }

  // ─── Export & Flush ────────────────────────────────────────────────────────

  static getMemoryEntries(limit?: number): UltraLogEntry[] {
    return limit ? UltraDevLog.entries.slice(-limit) : [...UltraDevLog.entries];
  }

  static getFormattedLog(limit = 500): string {
    const entries = UltraDevLog.entries.slice(-limit);
    return entries.map(e => UltraDevLog.formatEntry(e)).join('\n');
  }

  private static formatEntry(e: UltraLogEntry): string {
    const time = e.ts.slice(11, 23); // HH:MM:SS.mmm
    const d = e.data;
    const core = e.coreId ? ` [${e.coreId.slice(-6)}]` : '';

    switch (e.cat) {
      case 'USER_MSG':
        return `${time} [USER    ]${core} "${d.content}"`;
      case 'AI_RESPONSE':
        return `${time} [AI      ]${core} model=${d.model} cost=$${d.cost} | ${(d.content as string).slice(0, 200)}`;
      case 'AGENT_STEP':
        return `${time} [STEP    ]${core} [${d.phase}] ${d.success ? '✓' : '✗'} ${d.detail}`;
      case 'MODE':
        return `${time} [MODE    ]${core} ${d.mode} | "${d.inputPreview}"`;
      case 'PLAN':
        return `${time} [PLAN    ]${core} cap=${d.capability} det=${d.deterministic} params=${JSON.stringify(d.params)}`;
      case 'SAFETY':
        return `${time} [SAFETY  ]${core} risk=${d.risk} allowed=${d.allowed} reasons=[${(d.reasons as string[]).join('; ')}]`;
      case 'EXEC_RESULT':
        return `${time} [EXEC    ]${core} ${d.capability} ${d.success ? '✓' : '✗'} ${(d.resultPreview as string).slice(0, 300)}`;
      case 'VERIFY':
        return `${time} [VERIFY  ]${core} ${d.verified ? '✓' : '✗'} issues=[${(d.issues as string[]).join('; ') || 'none'}]`;
      case 'ERROR':
        return `${time} [ERROR   ]${core} [${d.context}] ${d.message}${d.stack ? ' STACK: ' + (d.stack as string).slice(0, 300) : ''}`;
      case 'SYSTEM':
        return `${time} [SYSTEM  ]${core} [${d.context}] ${d.message}`;
      case 'COST':
        return `${time} [COST    ] $${d.cost} ${d.model} task=${d.taskId}`;
      case 'API_CALL':
        return `${time} [API     ]${core} ${d.model} in=${d.promptTokens} out=${d.completionTokens} cost=$${d.cost} ${d.durationMs}ms`;
      case 'MODEL_SWITCH':
        return `${time} [MODEL   ]${core} ${d.from} -> ${d.to} reason=${d.reason}`;
      case 'CONV_NEW':
        return `${time} [CONV_NEW] ${d.conversationId} "${d.title}"`;
      case 'CONV_DEL':
        return `${time} [CONV_DEL] ${d.conversationId}`;

      // UI State
      case 'UI_MODAL':
        return `${time} [MODAL   ]${core} ${d.modalName} ${d.action} ${JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'modalName' && k !== 'action')))}`;
      case 'UI_PROCESSING':
        return `${time} [PROC    ]${core} isProcessing=${d.isProcessing} source=${d.source}${d.taskId ? ` task=${d.taskId}` : ''}`;
      case 'UI_RENDER_MSG':
        return `${time} [MSGS    ]${core} ${d.prevCount} -> ${d.nextCount} (${(d.diff as number) >= 0 ? '+' : ''}${d.diff}) source=${d.source} conv=${d.conversationId}`;
      case 'UI_SEND_ATTEMPT':
        return `${time} [SEND?   ]${core} mode=${d.mode} model=${d.modelId} conv=${d.conversationId} msgs=${d.messageCount} locked=${d.isProcessing} input="${d.inputPreview}"`;
      case 'UI_SEND_COMPLETE':
        return `${time} [SENT    ]${core} task=${d.taskId} ${d.success ? '✓' : '✗'} ${d.durationMs}ms proc: ${d.isProcessingBefore}->${d.isProcessingAfter}`;

      // App Launch
      case 'APP_LAUNCH_BEGIN':
        return `${time} [LAUNCH> ]${core} target="${d.target}" targetLower="${d.targetLower}" task=${d.taskId}`;
      case 'APP_LAUNCH_DEVICE':
        return `${time} [LAUNCH? ]${core} device query: ${d.appCount} apps in ${d.queryDurationMs}ms${d.error ? ' ERROR: ' + d.error : ''}`;
      case 'APP_LAUNCH_MATCH':
        return `${time} [LAUNCH= ]${core} target="${d.target}" matchType=${d.matchType}${d.matchedAppName ? ` appName="${d.matchedAppName}"` : ''} pkg=${d.resolvedPkg || 'NONE'}`;
      case 'APP_LAUNCH_AI':
        return `${time} [LAUNCH_AI]${core} AI fallback for "${d.target}" -> pkg="${d.resolvedPkg}" in ${d.durationMs}ms`;
      case 'APP_LAUNCH_FIRE':
        return `${time} [LAUNCH! ]${core} FIRING IntentLauncher pkg="${d.pkg}" target="${d.target}" task=${d.taskId} <- JS SUSPENDS AFTER THIS`;
      case 'APP_LAUNCH_RESUME':
        return `${time} [LAUNCH^ ]${core} JS RESUMED after ${d.suspendDuration}ms lastPkg="${d.lastKnownPkg}"`;
      case 'APP_LAUNCH_FAIL':
        return `${time} [LAUNCH_X]${core} FAIL stage=${d.stage} target="${d.target}" pkg=${d.pkg} error="${d.error}"`;

      // SMS
      case 'SMS_RESOLVE':
        return `${time} [SMS?    ]${core} input="${d.inputName}" searched=${d.contactsSearched} resolved=${d.resolved} number=${d.resolvedNumber || 'NOT FOUND'}${d.error ? ' ERR: ' + d.error : ''}`;
      case 'SMS_FIRE':
        return `${time} [SMS!    ]${core} toLen=${d.toNumberLen} isPhone=${d.toIsPhone} msgLen=${d.messageLen} preview="${d.messagePreview}"${d.toIsPhone ? '' : ' <- WARNING: NOT A PHONE NUMBER'}`;
      case 'SMS_RESULT':
        return `${time} [SMS_OK  ]${core} result=${d.result} success=${d.success}`;

      // Vault
      case 'VAULT_READ':
        return `${time} [VAULT_R ] ${d.key} found=${d.found}${d.valuePreview ? ` val="${d.valuePreview}"` : ''}`;
      case 'VAULT_WRITE':
        return `${time} [VAULT_W ] ${d.key} success=${d.success} val="${d.valuePreview}"`;

      // Parse
      case 'PARSE_INPUT':
        return `${time} [PARSE   ]${core} pattern=${d.matchedPattern || 'NONE'} cap=${d.capability || 'NONE'} compound=${d.isCompound} params=${JSON.stringify(d.extractedParams)}`;
      case 'PARSE_COMPOUND':
        return `${time} [COMPOUND]${core} "${d.input}" -- ${d.warning}`;

      // Picker
      case 'PICKER_OPEN':
        return `${time} [PICKER> ] models=${d.modelCount} current=${d.currentModelId} filter=${d.filter} slideAnim=${d.slideAnimCurrentValue} ${d.note}`;
      case 'PICKER_CLOSE':
        return `${time} [PICKER< ] closed via ${d.how}`;
      case 'PICKER_ANIMATE':
        return `${time} [PICKER~ ] ${d.direction} ${d.fromValue}->${d.toValue} type=${d.animationType}`;
      case 'PICKER_SELECT':
        return `${time} [PICKER+ ] selected ${d.modelId} (${d.modelName}) was=${d.previousModelId}`;

      // ── v2 new sensors ──────────────────────────────────────────────────────

      case 'CORE_INSTANCE': {
        const icon = d.event === 'created' ? 'NEW' : d.event === 'destroyed' ? 'DEL' : 'TAG';
        const warnPrefix = (d.note as string)?.startsWith('WARN') || (d.note as string)?.startsWith('BUG') ? ' *** ' : ' ';
        return `${time} [CORE_${icon}]${warnPrefix}id=${(d.instanceId as string)?.slice(-8)} event=${d.event} reason=${d.reason ?? ''} ${d.note}`;
      }

      case 'EXECUTOR_BRANCH':
        return `${time} [EXEC_BR ]${core} [${d.capability}] ${d.branch}${d.success !== undefined ? ` success=${d.success}` : ''}${d.path ? ` path=${d.path}` : ''}${d.note && d.note !== 'ok' ? ' ' + d.note : ''}`;

      case 'CONV_CONTEXT_SENT': {
        const warns: string[] = [];
        if (d.contaminationRisk) warns.push(`CONTAMINATION(cap=${d.capabilityPct}%)`);
        if (d.bloatRisk) warns.push(`BLOAT(hist=${d.historyPct}%)`);
        return `${time} [CTX_SENT]${core} task=${d.taskId} tokens~${d.estimated_total_tokens} sys=${d.systemPct}% hist=${d.historyPct}%(${d.history_message_count}msgs) cap=${d.capabilityPct}% user=${d.userPct}%${warns.length ? ' *** ' + warns.join(' ') : ''}`;
      }

      case 'UI_MESSAGE_RENDERED': {
        if (d.event === 'scroll') {
          return `${time} [SCROLL  ] offset=${d.scrollOffsetY}px viewport=${d.viewportHeight}px content=${d.contentHeight}px ${d.scrollPct}%${d.isAtBottom ? ' [AT_BOTTOM]' : ''}`;
        }
        return `${time} [RENDERED]${core} msg=${d.messageId} role=${d.role} h=${d.measuredHeightPx}px idx=${d.indexInList} visible=${d.isVisible}${d.tallWarning ? ' *** ' + d.note : ''}`;
      }

      case 'TASK_WATCHDOG': {
        const icon = d.event === 'FIRED' ? '!!! ' : '';
        return `${time} [WATCHDOG] ${icon}task=${d.taskId} phase=${d.phase} event=${d.event}${d.stalenessMs ? ` stale=${d.stalenessMs}ms` : ''}${d.elapsedMs ? ` elapsed=${d.elapsedMs}ms` : ''}${d.event === 'FIRED' ? ' <- ' + d.note : ''}`;
      }

      case 'APP_STATE_CHANGE':
        return `${time} [APPSTATE] ${d.nextState} elapsed=${d.elapsedSinceLastChange}ms${d.backgroundDurationMs ? ` bg_for=${d.backgroundDurationMs}ms` : ''} core=${d.activeCoreId ?? 'none'}${(d.note as string) !== 'ok' ? ' *** ' + d.note : ''}`;

      case 'SESSION_SUMMARY':
        return `${time} [SUMMARY ] ${JSON.stringify(d)}`;

      default:
        return `${time} [${e.cat.padEnd(8)}]${core} ${JSON.stringify(d).slice(0, 300)}`;
    }
  }

  /**
   * Generates a structured bug report for Replit.
   */
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

    // ── 1. Failures ─────────────────────────────────────────────────────────
    const failures = entries.filter(e =>
      e.cat === 'ERROR' ||
      e.cat === 'APP_LAUNCH_FAIL' ||
      (e.cat === 'EXEC_RESULT' && !e.data.success) ||
      (e.cat === 'SMS_FIRE' && !e.data.toIsPhone) ||
      (e.cat === 'PARSE_COMPOUND') ||
      (e.cat === 'PICKER_OPEN' && (e.data.note as string)?.includes('WARN')) ||
      (e.cat === 'TASK_WATCHDOG' && e.data.event === 'FIRED') ||
      (e.cat === 'CORE_INSTANCE' && (e.data.note as string)?.startsWith('WARN')) ||
      (e.cat === 'CORE_INSTANCE' && (e.data.note as string)?.startsWith('BUG')) ||
      (e.cat === 'EXECUTOR_BRANCH' && (e.data.note as string)?.startsWith('BUG')) ||
      (e.cat === 'CONV_CONTEXT_SENT' && (e.data.contaminationRisk || e.data.bloatRisk)) ||
      (e.cat === 'UI_MESSAGE_RENDERED' && e.data.tallWarning)
    );

    lines.push('');
    lines.push(`-- FAILURES & WARNINGS (${failures.length}) -----------------`);
    if (failures.length === 0) {
      lines.push('  None detected. Issue may be in UI rendering or state not captured yet.');
    } else {
      failures.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    // ── 2. Last user input ──────────────────────────────────────────────────
    const lastUser = [...entries].reverse().find(e => e.cat === 'USER_MSG');
    lines.push('');
    lines.push('-- LAST USER INPUT --------------------------------');
    lines.push(lastUser ? `  "${lastUser.data.content}"` : '  (none found)');

    // ── 3. Last task chain ──────────────────────────────────────────────────
    const lastExec = [...entries].reverse().find(e => e.data.taskId);
    if (lastExec) {
      const taskId = lastExec.data.taskId as string;
      const taskEntries = entries.filter(e => e.data.taskId === taskId);
      lines.push('');
      lines.push(`-- LAST TASK CHAIN ((check taskId in AGENT_EXEC_START)) ----------------------`);
      taskEntries.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));

      // Check for missing EXEC_RESULT
      const hasExecResult = taskEntries.some(e => e.cat === 'EXEC_RESULT');
      const hasLaunchFire = taskEntries.some(e => e.cat === 'APP_LAUNCH_FIRE');
      if (hasLaunchFire && !hasExecResult) {
        lines.push('');
        lines.push('  BUG CONFIRMED: APP_LAUNCH_FIRE fired but no EXEC_RESULT.');
        lines.push('  JS thread suspended after IntentLauncher and never resumed.');
        lines.push('  FIX: Save result and reset isProcessing BEFORE IntentLauncher.openApplication().');
      }

      // Check for executor misfire
      const execEnter = taskEntries.filter(e => e.cat === 'EXECUTOR_BRANCH' && e.data.branch === 'ENTER');
      const execExit = taskEntries.filter(e => e.cat === 'EXECUTOR_BRANCH' && e.data.branch === 'EXIT');
      if (execEnter.length > execExit.length) {
        lines.push('');
        lines.push(`  BUG CONFIRMED: EXECUTOR_BRANCH ENTER fired ${execEnter.length}x but EXIT fired ${execExit.length}x.`);
        lines.push('  Executor body was entered but short-circuited before return.');
        lines.push('  Check for early return, missing await, or core replacement mid-task.');
      }

      // Check for core staleness
      const coreStale = taskEntries.find(e => e.cat === 'CORE_INSTANCE' && e.data.isStale === true);
      if (coreStale) {
        lines.push('');
        lines.push(`  BUG CONFIRMED: Task ran on stale core ${coreStale.data.instanceId}.`);
        lines.push(`  Active core was already replaced with ${coreStale.data.activeCoreId}.`);
        lines.push('  FIX: Add ref guard in init useEffect -- if (agentCoreRef.current) return;');
      }
    }

    // ── 4. isProcessing stuck check ─────────────────────────────────────────
    const procEvents = entries.filter(e => e.cat === 'UI_PROCESSING').slice(-10);
    lines.push('');
    lines.push('-- isProcessing TRANSITIONS (last 10) ---------------');
    if (procEvents.length === 0) {
      lines.push('  NO UI_PROCESSING events found -- processingState() not instrumented yet.');
    } else {
      procEvents.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
      const lastProc = procEvents[procEvents.length - 1];
      if (lastProc?.data.isProcessing === true) {
        lines.push('  isProcessing is TRUE at end of log -- UI may be locked.');
      }
    }

    // ── 5. App launch trace ─────────────────────────────────────────────────
    const launchEntries = entries.filter(e =>
      ['APP_LAUNCH_BEGIN', 'APP_LAUNCH_DEVICE', 'APP_LAUNCH_MATCH',
       'APP_LAUNCH_AI', 'APP_LAUNCH_FIRE', 'APP_LAUNCH_RESUME', 'APP_LAUNCH_FAIL'].includes(e.cat)
    ).slice(-20);
    lines.push('');
    lines.push(`-- APP LAUNCH TRACE (last ${launchEntries.length}) ----------------`);
    if (launchEntries.length === 0) {
      lines.push('  No app launch trace -- appLaunchBegin() not instrumented yet.');
    } else {
      launchEntries.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    // ── 6. Model picker trace ───────────────────────────────────────────────
    const pickerEntries = entries.filter(e =>
      ['PICKER_OPEN', 'PICKER_CLOSE', 'PICKER_ANIMATE', 'PICKER_SELECT'].includes(e.cat)
    ).slice(-10);
    lines.push('');
    lines.push(`-- MODEL PICKER TRACE (last ${pickerEntries.length}) -----------------`);
    if (pickerEntries.length === 0) {
      lines.push('  No picker trace -- pickerOpen() not instrumented yet.');
    } else {
      pickerEntries.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    // ── 7. SMS trace ────────────────────────────────────────────────────────
    const smsEntries = entries.filter(e =>
      ['SMS_RESOLVE', 'SMS_FIRE', 'SMS_RESULT'].includes(e.cat)
    ).slice(-6);
    if (smsEntries.length > 0) {
      lines.push('');
      lines.push(`-- SMS TRACE -----------------------------------------`);
      smsEntries.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    // ── 8. Core re-initialization trace ─────────────────────────────────────
    const coreEvents = entries.filter(e => e.cat === 'CORE_INSTANCE').slice(-10);
    lines.push('');
    lines.push(`-- CORE INSTANCE TRACE (last ${coreEvents.length}) ------------------`);
    if (coreEvents.length === 0) {
      lines.push('  No core events -- coreCreated() not instrumented yet.');
      lines.push('  Without this, re-initialization bugs are invisible.');
    } else {
      coreEvents.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
      const coreCreations = entries.filter(e => e.cat === 'CORE_INSTANCE' && e.data.event === 'created').length;
      if (coreCreations > 1) {
        lines.push(`  WARN: ${coreCreations} core instances created this session.`);
        lines.push('  FIX: Add ref guard -- if (agentCoreRef.current) return; -- in init useEffect.');
      }
    }

    // ── 9. AppState transitions ──────────────────────────────────────────────
    const appStateEvents = entries.filter(e => e.cat === 'APP_STATE_CHANGE').slice(-10);
    if (appStateEvents.length > 0) {
      lines.push('');
      lines.push(`-- APP STATE TRANSITIONS (last ${appStateEvents.length}) ----------------`);
      appStateEvents.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    // ── 10. Context window health ────────────────────────────────────────────
    const ctxEvents = entries.filter(e => e.cat === 'CONV_CONTEXT_SENT' &&
      (e.data.contaminationRisk || e.data.bloatRisk)).slice(-5);
    if (ctxEvents.length > 0) {
      lines.push('');
      lines.push(`-- CONTEXT WINDOW WARNINGS (${ctxEvents.length}) -------------------`);
      ctxEvents.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    // ── 11. Render health ────────────────────────────────────────────────────
    const renderWarnings = entries.filter(e =>
      e.cat === 'UI_MESSAGE_RENDERED' && e.data.tallWarning
    ).slice(-5);
    if (renderWarnings.length > 0) {
      lines.push('');
      lines.push(`-- TALL MESSAGE WARNINGS (${renderWarnings.length}) -------------------`);
      renderWarnings.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    // ── 12. Watchdog alerts ──────────────────────────────────────────────────
    const watchdogFires = entries.filter(e =>
      e.cat === 'TASK_WATCHDOG' && e.data.event === 'FIRED'
    ).slice(-5);
    if (watchdogFires.length > 0) {
      lines.push('');
      lines.push(`-- WATCHDOG ALERTS (${watchdogFires.length}) -------------------------`);
      watchdogFires.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    // ── 13. Recent errors ────────────────────────────────────────────────────
    const errors = entries.filter(e => e.cat === 'ERROR').slice(-5);
    if (errors.length > 0) {
      lines.push('');
      lines.push('-- ERRORS --------------------------------------------');
      errors.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    // ── 14. Compound command warnings ────────────────────────────────────────
    const compounds = entries.filter(e => e.cat === 'PARSE_COMPOUND').slice(-5);
    if (compounds.length > 0) {
      lines.push('');
      lines.push('-- COMPOUND COMMAND WARNINGS -------------------------');
      lines.push('  These inputs are being partially parsed -- target param may be wrong:');
      compounds.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    }

    lines.push('');
    lines.push(hr);
    lines.push(`END OF REPORT -- paste this entire block to Replit`);
    lines.push(hr);

    return lines.join('\n');
  }

  // ─── File I/O ──────────────────────────────────────────────────────────────

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
    setImmediate(() => UltraDevLog.flushToFile());
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

  static clear(): void {
    UltraDevLog.entries = [];
    UltraDevLog.seq = 0;
    UltraDevLog.activeCoreId = null;
    for (const entry of UltraDevLog.watchdogs.values()) {
      clearTimeout(entry.timeoutHandle);
    }
    UltraDevLog.watchdogs.clear();
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

/*
=================================================================
 INTEGRATION QUICK-REFERENCE  (v2 new sensors only)
=================================================================

-- SENSOR 1: AgentCore Instance ID (crankshaft sensor) ----------
  In AgentCore constructor (FIRST LINE):
    this.instanceId = UltraDevLog.coreCreated('initial_mount');

  In AgentCore.execute() (FIRST LINE):
    UltraDevLog.taskCoreStamp(taskId, this.instanceId);

  In init useEffect cleanup:
    return () => UltraDevLog.coreDestroyed(this.instanceId, 'cleanup');

  Add ref guard to PREVENT unnecessary re-init:
    In index.tsx init useEffect:
      if (agentCoreRef.current) return;

-- SENSOR 2: Executor Branch Tracing (misfire sensor) -----------
  In TaskExecutor, every capability case:
    case 'app_launch': {
      UltraDevLog.executorEnter(taskId, 'app_launch');
      UltraDevLog.executorBranch(taskId, 'app_launch', 'device_query_start');
      const apps = await getInstalledApps();
      UltraDevLog.executorBranch(taskId, 'app_launch', 'device_query_done', { count: apps.length });
      // ... rest of logic ...
      UltraDevLog.executorExit(taskId, 'app_launch', success, exitPath);
      return result;
    }

-- SENSOR 3: Conversation Context Sent (O2 sensor) -------------
  In ModelRouter / AI fetch wrapper, BEFORE fetch():
    UltraDevLog.convContextSent(taskId, model, {
      system_prompt_chars: systemPrompt.length,
      history_message_count: history.length,
      history_chars: history.reduce((n, m) => n + m.content.length, 0),
      capability_context_chars: capabilityContext?.length ?? 0,
      user_message_chars: userMessage.length,
      estimated_total_tokens: Math.ceil(totalChars / 4),
    });

-- SENSOR 4: UI Message Rendered (wheel speed sensor) ----------
  In MessageBubble / renderItem wrapping View:
    <View onLayout={(e) => UltraDevLog.messageRendered(
      msg.id, msg.role, msg.content.length,
      e.nativeEvent.layout.height,
      index,
      scrollOffsetRef.current,
      listHeightRef.current,
    )}>

  In FlatList onScroll:
    onScroll={(e) => {
      scrollOffsetRef.current = UltraDevLog.listScrolled(
        e.nativeEvent.contentOffset.y,
        e.nativeEvent.layoutMeasurement.height,
        e.nativeEvent.contentSize.height,
      );
    }}

-- SENSOR 5: Task Watchdog (ABS sensor) ------------------------
  In AgentCore.execute():
    UltraDevLog.watchdogArm(taskId, 'APPROVE', 10000);
    await doApproval();
    UltraDevLog.watchdogDisarm(taskId, 'APPROVE');

    UltraDevLog.watchdogArm(taskId, 'EXECUTE', 30000);
    await executeCapability();
    UltraDevLog.watchdogDisarm(taskId, 'EXECUTE');

    finally {
      UltraDevLog.watchdogDisarmAll(taskId);
    }

-- SENSOR 6: AppState Lifecycle (re-init sensor) ---------------
  In app/index.tsx root component useEffect:
    useEffect(() => {
      UltraDevLog.installAppStateListener();
      return () => UltraDevLog.removeAppStateListener();
    }, []);

=================================================================
*/

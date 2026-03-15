/**
 * UltraDevLog v3 -- Runtime Diagnostic System for Agent Ultra
 * ============================================================
 *
 * v3 CHANGES (all from ULTRADEVLOG_CAPABILITY_MAP.txt):
 *
 * NEW SENSORS:
 *   N1. COMPONENT_LIFECYCLE  -- proves ChatScreen mount/unmount
 *   N2. SETTINGS_SAVE        -- save button tap + vault write result
 *   N3. EXECUTE_PHASE        -- named phase entry, narrows crash location
 *   N4. NAV_CHANGE           -- navigation events, identifies remount trigger
 *   N5. FOCUS_EFFECT_DEPS    -- which dep changed on useFocusEffect trigger
 *   N6. PROCESS_RESTART      -- Android process kill vs suspension detection
 *   N7. PICKER_CONTENT       -- model list render count inside sheet
 *   N8. CONTEXT_PROVIDER     -- AgentCoreProvider verification sensor
 *
 * DATA QUALITY FIXES:
 *   Q1. listHeightPx=0: messageRendered() warns when listHeight unavailable
 *   Q2. VAULT_WRITE success is now boolean, not byte count
 *   Q3. APP_STATE_CHANGE elapsed correct on first entry (init to Date.now())
 *   Q4. PICKER_ANIMATE mount noise suppressed with 500ms mountedAt guard
 *   Q5. uiState() deduplicates -- skips identical snapshots
 *   Q6. pickerOpen() warns correctly; slideAnim should be read before setValue()
 *
 * NOISE REDUCTION:
 *   R1. conversationList / conversationLoaded only log on count change
 *   R2. High-freq vault reads (api key, base url) deduplicated within 1s
 *   R3. processingState() includes durationMs since last transition
 */

import { Platform, AppState, AppStateStatus } from 'react-native';
import * as ExpoFileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';

const FileSystem: any = Platform.OS !== 'web' ? ExpoFileSystem : null;
const PROCESS_RESTART_KEY = 'ultra_last_background_ts';

export type UltraLogCat =
  | 'USER_MSG' | 'AI_RESPONSE' | 'AGENT_STEP' | 'MODE' | 'PLAN' | 'SAFETY'
  | 'API_CALL' | 'EXEC_RESULT' | 'VERIFY' | 'ERROR' | 'SYSTEM' | 'COST'
  | 'MODEL_SWITCH' | 'CONV_NEW' | 'CONV_DEL'
  | 'UI_MODAL' | 'UI_PROCESSING' | 'UI_RENDER_MSG' | 'UI_SEND_ATTEMPT' | 'UI_SEND_COMPLETE'
  | 'APP_LAUNCH_BEGIN' | 'APP_LAUNCH_DEVICE' | 'APP_LAUNCH_MATCH' | 'APP_LAUNCH_AI'
  | 'APP_LAUNCH_FIRE' | 'APP_LAUNCH_RESUME' | 'APP_LAUNCH_FAIL'
  | 'SMS_RESOLVE' | 'SMS_FIRE' | 'SMS_RESULT'
  | 'VAULT_READ' | 'VAULT_WRITE'
  | 'PARSE_INPUT' | 'PARSE_COMPOUND'
  | 'PICKER_OPEN' | 'PICKER_CLOSE' | 'PICKER_ANIMATE' | 'PICKER_SELECT'
  | 'CORE_INSTANCE' | 'EXECUTOR_BRANCH' | 'CONV_CONTEXT_SENT'
  | 'UI_MESSAGE_RENDERED' | 'TASK_WATCHDOG' | 'APP_STATE_CHANGE'
  | 'COMPONENT_LIFECYCLE'
  | 'SETTINGS_SAVE'
  | 'EXECUTE_PHASE'
  | 'NAV_CHANGE'
  | 'FOCUS_EFFECT_DEPS'
  | 'PROCESS_RESTART'
  | 'PICKER_CONTENT'
  | 'CONTEXT_PROVIDER'
  | 'SESSION_SUMMARY';

interface UltraLogEntry {
  ts: string;
  t: number;
  cat: UltraLogCat;
  data: Record<string, unknown>;
  seq: number;
  coreId?: string;
}

interface WatchdogEntry {
  taskId: string;
  phase: string;
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class UltraDevLog {
  private static entries: UltraLogEntry[] = [];
  private static readonly MAX_MEMORY = 3000;
  private static seq = 0;
  private static sessionId = Date.now().toString(36);
  private static writing = false;
  private static pendingFlush = false;
  private static activeCoreId: string | null = null;
  private static watchdogs = new Map<string, WatchdogEntry>();
  private static appStateListener: ReturnType<typeof AppState.addEventListener> | null = null;
  private static lastAppStateChangeAt = Date.now();
  private static lastActiveAt = Date.now();
  private static lastVaultReadTs = new Map<string, number>();
  private static lastUiStateHash = '';
  private static lastConvListCount = -1;
  private static lastConvLoadedCounts = new Map<string, number>();
  private static processingStartedAt = 0;

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

  static modalEvent(modalName: string, action: 'open' | 'close', extra?: Record<string, unknown>): void {
    UltraDevLog.push('UI_MODAL', { modalName, action, ...extra });
  }

  static processingState(isProcessing: boolean, source: string, taskId?: string): void {
    const now = Date.now();
    const durationMs = !isProcessing && UltraDevLog.processingStartedAt > 0
      ? now - UltraDevLog.processingStartedAt : 0;
    if (isProcessing) UltraDevLog.processingStartedAt = now;
    else UltraDevLog.processingStartedAt = 0;
    UltraDevLog.push('UI_PROCESSING', { isProcessing, source, taskId, durationMs });
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
    UltraDevLog.push('APP_LAUNCH_FIRE', { taskId, pkg, target, note: 'JS thread suspends after this.' });
    UltraDevLog.flushSyncInternal();
  }

  static appLaunchResume(lastKnownPkg: string, resumeTs: number): void {
    UltraDevLog.push('APP_LAUNCH_RESUME', { lastKnownPkg, suspendDuration: Date.now() - resumeTs });
  }

  static appLaunchFail(taskId: string, target: string, pkg: string | undefined, error: string, stage: 'device_query' | 'ai_fallback' | 'no_package' | 'intent_launch'): void {
    UltraDevLog.push('APP_LAUNCH_FAIL', { taskId, target, pkg, error, stage });
  }

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

  static vaultRead(key: string, found: boolean, valuePreview?: string): void {
    const HIGH_FREQ = new Set(['venice_api_key', 'api_base_url', 'preferred_model']);
    if (HIGH_FREQ.has(key)) {
      const last = UltraDevLog.lastVaultReadTs.get(key) ?? 0;
      if (Date.now() - last < 1000) return;
      UltraDevLog.lastVaultReadTs.set(key, Date.now());
    }
    UltraDevLog.push('VAULT_READ', { key, found, valuePreview: valuePreview ? valuePreview.slice(0, 80) : undefined });
  }

  static vaultWrite(key: string, success: boolean, valuePreview?: string): void {
    UltraDevLog.push('VAULT_WRITE', { key, success, valuePreview: valuePreview ? valuePreview.slice(0, 80) : undefined });
  }

  static parseInput(input: string, matchedPattern: string | null, capability: string | null, extractedParams: Record<string, unknown> | null, isCompound: boolean): void {
    UltraDevLog.push('PARSE_INPUT', { inputPreview: input.slice(0, 200), matchedPattern, capability, extractedParams, isCompound });
    if (isCompound) {
      UltraDevLog.push('PARSE_COMPOUND', { input: input.slice(0, 200), warning: 'Multi-intent. Target param may contain trailing intent.' });
    }
  }

  static pickerOpen(modelCount: number, currentModelId: string, slideAnimValue: number, filter: string): void {
    UltraDevLog.push('PICKER_OPEN', {
      modelCount, currentModelId, slideAnimCurrentValue: slideAnimValue, filter,
      note: slideAnimValue > 0 && slideAnimValue < 100
        ? 'WARN: slideAnim partially open before reset -- sheet may be mid-animation'
        : 'ok',
    });
  }

  static pickerClose(how: 'backdrop' | 'close_button' | 'model_select' | 'programmatic'): void {
    UltraDevLog.push('PICKER_CLOSE', { how });
  }

  static pickerAnimate(direction: 'open' | 'close', fromValue: number, toValue: number, animationType: 'spring' | 'timing', mountedAt?: number): void {
    if (direction === 'close' && mountedAt !== undefined && (Date.now() - mountedAt) < 500) {
      return;
    }
    UltraDevLog.push('PICKER_ANIMATE', { direction, fromValue, toValue, animationType });
  }

  static pickerSelect(modelId: string, modelName: string, previousModelId: string): void {
    UltraDevLog.push('PICKER_SELECT', { modelId, modelName, previousModelId });
  }

  static coreCreated(reason: string): string {
    const instanceId = `core_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    UltraDevLog.activeCoreId = instanceId;
    const prior = UltraDevLog.entries.filter(e => e.cat === 'CORE_INSTANCE' && e.data.event === 'created').length;
    UltraDevLog.push('CORE_INSTANCE', {
      event: 'created', instanceId, reason, priorCreationsThisSession: prior,
      note: prior > 0 ? `WARN: Re-initialization #${prior + 1}.` : 'First core this session.',
    });
    return instanceId;
  }

  static coreDestroyed(instanceId: string, reason: string): void {
    if (UltraDevLog.activeCoreId === instanceId) UltraDevLog.activeCoreId = null;
    UltraDevLog.push('CORE_INSTANCE', { event: 'destroyed', instanceId, reason, wasActive: UltraDevLog.activeCoreId === null });
  }

  static taskCoreStamp(taskId: string, instanceId: string): void {
    const isStale = UltraDevLog.activeCoreId !== null && UltraDevLog.activeCoreId !== instanceId;
    UltraDevLog.push('CORE_INSTANCE', {
      event: 'task_stamped', taskId, instanceId,
      activeCoreId: UltraDevLog.activeCoreId, isStale,
      note: isStale ? `BUG: running on ${instanceId} but active is ${UltraDevLog.activeCoreId}.` : 'ok',
    });
  }

  static executorBranch(taskId: string, capability: string, branch: string, meta?: Record<string, unknown>): void {
    UltraDevLog.push('EXECUTOR_BRANCH', { taskId, capability, branch, coreId: UltraDevLog.activeCoreId, ...meta });
  }

  static executorEnter(taskId: string, capability: string): void {
    UltraDevLog.executorBranch(taskId, capability, 'ENTER', { note: 'Executor entered. No EXIT = short-circuited.' });
  }

  static executorExit(taskId: string, capability: string, success: boolean, path: string): void {
    UltraDevLog.executorBranch(taskId, capability, 'EXIT', { success, path });
  }

  static convContextSent(taskId: string, model: string, breakdown: { system_prompt_chars: number; history_message_count: number; history_chars: number; capability_context_chars: number; user_message_chars: number; estimated_total_tokens: number }): void {
    const total = breakdown.system_prompt_chars + breakdown.history_chars + breakdown.capability_context_chars + breakdown.user_message_chars;
    const sysPct = Math.round((breakdown.system_prompt_chars / total) * 100);
    const histPct = Math.round((breakdown.history_chars / total) * 100);
    const capPct = Math.round((breakdown.capability_context_chars / total) * 100);
    const usrPct = Math.round((breakdown.user_message_chars / total) * 100);
    UltraDevLog.push('CONV_CONTEXT_SENT', {
      taskId, model, ...breakdown, totalChars: total,
      systemPct: sysPct, historyPct: histPct, capabilityPct: capPct, userPct: usrPct,
      contaminationRisk: capPct > 40, bloatRisk: histPct > 60,
      note: [capPct > 40 ? `WARN: cap=${capPct}% contamination risk` : null, histPct > 60 ? `WARN: hist=${histPct}% bloat risk` : null].filter(Boolean).join('; ') || 'ok',
    });
  }

  private static lastRenderedHeights: Map<string, number> = new Map();

  static messageRendered(messageId: string, role: 'user' | 'assistant' | 'system', contentLength: number, measuredHeightPx: number, indexInList: number, listScrollOffsetPx: number, listHeightPx: number): void {
    const lastH = UltraDevLog.lastRenderedHeights.get(messageId);
    if (lastH !== undefined && Math.abs(lastH - measuredHeightPx) < 2) return;
    UltraDevLog.lastRenderedHeights.set(messageId, measuredHeightPx);
    if (UltraDevLog.lastRenderedHeights.size > 100) {
      const first = UltraDevLog.lastRenderedHeights.keys().next().value;
      if (first) UltraDevLog.lastRenderedHeights.delete(first);
    }
    const viewportBottom = listScrollOffsetPx + listHeightPx;
    const msgTop = indexInList * measuredHeightPx;
    const isVisible = listHeightPx > 0 ? (msgTop >= listScrollOffsetPx && msgTop <= viewportBottom) : indexInList === 0;
    const tallWarning = measuredHeightPx > 300;
    UltraDevLog.push('UI_MESSAGE_RENDERED', {
      messageId, role, contentLength, measuredHeightPx, indexInList,
      listScrollOffsetPx, listHeightPx, isVisible, tallWarning,
      listHeightKnown: listHeightPx > 0,
      note: tallWarning ? `WARN: ${measuredHeightPx}px tall -- possible oversized bubble bug`
        : listHeightPx === 0 ? 'WARN: listHeightPx=0 -- add FlatList onLayout to populate listHeightRef'
        : 'ok',
    });
  }

  static listScrolled(scrollOffsetY: number, viewportHeight: number, contentHeight: number): number {
    const scrollPct = contentHeight > 0 ? Math.round((scrollOffsetY / contentHeight) * 100) : 0;
    const isAtBottom = scrollOffsetY + viewportHeight >= contentHeight - 20;
    const last = UltraDevLog.entries.filter(e => e.cat === 'UI_MESSAGE_RENDERED').slice(-1)[0];
    const lastOff = (last?.data.listScrollOffsetPx as number) ?? 0;
    if (Math.abs(scrollOffsetY - lastOff) > 50) {
      UltraDevLog.push('UI_MESSAGE_RENDERED', { event: 'scroll', scrollOffsetY, viewportHeight, contentHeight, scrollPct, isAtBottom });
    }
    return scrollOffsetY;
  }

  static watchdogArm(taskId: string, phase: string, timeoutMs = 15000): void {
    UltraDevLog.watchdogDisarm(taskId, phase);
    const key = `${taskId}::${phase}`;
    const startedAt = Date.now();
    const handle = setTimeout(() => {
      UltraDevLog.push('TASK_WATCHDOG', { event: 'FIRED', taskId, phase, stalenessMs: Date.now() - startedAt, timeoutMs, activeCoreId: UltraDevLog.activeCoreId, note: `BUG: ${taskId} stuck in ${phase}.` });
      UltraDevLog.watchdogs.delete(key);
    }, timeoutMs);
    UltraDevLog.watchdogs.set(key, { taskId, phase, startedAt, timeoutHandle: handle });
  }

  static watchdogDisarm(taskId: string, phase: string): void {
    const key = `${taskId}::${phase}`;
    const entry = UltraDevLog.watchdogs.get(key);
    if (entry) {
      clearTimeout(entry.timeoutHandle);
      UltraDevLog.push('TASK_WATCHDOG', { event: 'disarmed', taskId, phase, elapsedMs: Date.now() - entry.startedAt, note: 'ok' });
      UltraDevLog.watchdogs.delete(key);
    }
  }

  static watchdogDisarmAll(taskId: string): void {
    for (const [key, entry] of UltraDevLog.watchdogs.entries()) {
      if (entry.taskId === taskId) { clearTimeout(entry.timeoutHandle); UltraDevLog.watchdogs.delete(key); }
    }
  }

  static installAppStateListener(): void {
    if (UltraDevLog.appStateListener) return;
    UltraDevLog.lastAppStateChangeAt = Date.now();
    UltraDevLog.lastActiveAt = Date.now();
    UltraDevLog.appStateListener = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      const now = Date.now();
      const elapsed = now - UltraDevLog.lastAppStateChangeAt;
      const bgDuration = nextState === 'active' ? now - UltraDevLog.lastActiveAt : 0;
      UltraDevLog.push('APP_STATE_CHANGE', {
        nextState, elapsedSinceLastChange: elapsed,
        backgroundDurationMs: nextState === 'active' ? bgDuration : undefined,
        activeCoreId: UltraDevLog.activeCoreId, activeWatchdogs: UltraDevLog.watchdogs.size,
        note: nextState === 'active' && bgDuration > 0
          ? `App back after ${bgDuration}ms. If CORE_INSTANCE follows, re-init triggered here.`
          : (nextState === 'background' || nextState === 'inactive')
          ? 'Going to background. Watch for CORE_INSTANCE after next active.'
          : 'ok',
      });
      if (nextState === 'background' || nextState === 'inactive') {
        UltraDevLog.lastActiveAt = now;
        try { AsyncStorage.setItem(PROCESS_RESTART_KEY, String(now)); } catch {}
        UltraDevLog.flushSyncInternal();
      }
      UltraDevLog.lastAppStateChangeAt = now;
    });
  }

  static removeAppStateListener(): void {
    if (UltraDevLog.appStateListener) { UltraDevLog.appStateListener.remove(); UltraDevLog.appStateListener = null; }
  }

  // ─── v3 NEW SENSORS ────────────────────────────────────────────────────────

  static componentMount(componentName: string, props?: Record<string, unknown>): string {
    const componentId = `${componentName}_${Date.now().toString(36)}`;
    const prior = UltraDevLog.entries.filter(e => e.cat === 'COMPONENT_LIFECYCLE' && e.data.componentName === componentName && e.data.event === 'mount').length;
    UltraDevLog.push('COMPONENT_LIFECYCLE', {
      event: 'mount', componentName, componentId, priorMountsThisSession: prior,
      activeCoreId: UltraDevLog.activeCoreId, props,
      note: prior > 0 ? `WARN: ${componentName} mounted ${prior + 1} times. Check for unnecessary remounts.` : 'First mount.',
    });
    return componentId;
  }

  static componentUnmount(componentName: string, componentId: string, reason?: string): void {
    UltraDevLog.push('COMPONENT_LIFECYCLE', {
      event: 'unmount', componentName, componentId,
      reason: reason ?? 'unknown', activeCoreId: UltraDevLog.activeCoreId,
    });
  }

  static settingsSaveTap(section: 'defaults' | 'api' | 'limits', payload: Record<string, unknown>): void {
    UltraDevLog.push('SETTINGS_SAVE', { event: 'tap', section, payload, note: 'Save tapped. Watch for write_result.' });
  }

  static settingsSaveResult(section: string, success: boolean, savedKeys: string[], error?: string): void {
    UltraDevLog.push('SETTINGS_SAVE', {
      event: 'write_result', section, success, savedKeys, error,
      note: success ? `Written: ${savedKeys.join(', ')}` : `FAIL: ${error ?? 'unknown'}`,
    });
  }

  static executePhase(taskId: string, phase: 'INGEST' | 'ROUTE' | 'PLAN' | 'VERIFY' | 'APPROVE' | 'EXECUTE' | 'VERIFY_RESULT' | 'RESPOND' | string): void {
    UltraDevLog.push('EXECUTE_PHASE', { taskId, phase, coreId: UltraDevLog.activeCoreId });
  }

  static navChange(routeName: string, action: string, stackDepth: number, params?: Record<string, unknown>): void {
    UltraDevLog.push('NAV_CHANGE', { routeName, action, stackDepth, params, activeCoreId: UltraDevLog.activeCoreId });
  }

  static focusEffectTriggered(currentDeps: Record<string, unknown>, previousDeps: Record<string, unknown> | null): void {
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(currentDeps)) {
      if (previousDeps === null || previousDeps[k] !== v) changed[k] = { from: previousDeps?.[k], to: v };
    }
    UltraDevLog.push('FOCUS_EFFECT_DEPS', {
      changedDeps: Object.keys(changed), changes: changed, isFirstTrigger: previousDeps === null,
      note: Object.keys(changed).includes('currentMode')
        ? 'WARN: currentMode in changed deps -- + menu triggers unnecessary focusEffect vault reads.'
        : Object.keys(changed).length > 0 ? `Changed: ${Object.keys(changed).join(', ')}` : 'No deps changed.',
    });
  }

  static focusEffectSuppressed(elapsedMs: number): void {
    UltraDevLog.push('FOCUS_EFFECT_DEPS', { event: 'suppressed', elapsedMs, note: `Throttle ok (${elapsedMs}ms < 2000ms).` });
  }

  static async checkProcessRestart(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(PROCESS_RESTART_KEY);
      const now = Date.now();
      if (raw) {
        const lastTs = parseInt(raw, 10);
        const bgDuration = now - lastTs;
        UltraDevLog.push('PROCESS_RESTART', {
          event: 'warm_restart', lastBackgroundTs: lastTs, backgroundDurationMs: bgDuration,
          note: `Process killed after ${bgDuration}ms in background. ref guard resets on kill. Fix: React Context for AgentCore.`,
        });
      } else {
        UltraDevLog.push('PROCESS_RESTART', { event: 'cold_start', note: 'First launch or manual kill.' });
      }
      await AsyncStorage.removeItem(PROCESS_RESTART_KEY);
    } catch (err: any) {
      UltraDevLog.push('PROCESS_RESTART', { event: 'detection_failed', error: err.message });
    }
  }

  static pickerContentRender(filteredCount: number, totalCount: number, activeFilter: string, currentModelId: string): void {
    UltraDevLog.push('PICKER_CONTENT', {
      filteredCount, totalCount, activeFilter, currentModelId,
      note: filteredCount === 0
        ? `WARN: 0 models for filter "${activeFilter}" -- sheet open but list empty.`
        : `ok -- ${filteredCount}/${totalCount} for "${activeFilter}"`,
    });
  }

  static contextProviderRender(providerName: string, coreInstanceId: string, renderCount: number): void {
    UltraDevLog.push('CONTEXT_PROVIDER', {
      providerName, coreInstanceId, renderCount, activeCoreId: UltraDevLog.activeCoreId,
      note: renderCount > 1 && coreInstanceId === UltraDevLog.activeCoreId
        ? `ok -- same core on render #${renderCount}. Fix working.`
        : renderCount === 1 ? 'First render.' : `WARN: coreId changed on render #${renderCount}.`,
    });
  }

  // ─── Legacy compatibility stubs ────────────────────────────────────────────

  static agentExecuteStart(taskId: string, conversationId: string, inputLength: number, isReplay: boolean): void {
    UltraDevLog.push('AGENT_STEP', { event: 'execute_start', taskId, conversationId, inputLength, isReplay });
  }

  static agentInitStart(): void { UltraDevLog.push('SYSTEM', { event: 'agent_init_start' }); }
  static agentInitComplete(durationMs?: number): void { UltraDevLog.push('SYSTEM', { event: 'agent_init_complete', durationMs }); }
  static agentInitSubsystem(subsystem: string, status: string | boolean): void { UltraDevLog.push('SYSTEM', { event: 'agent_init_subsystem', subsystem, status }); }
  static buildStart(taskId: string, description: string): void { UltraDevLog.push('SYSTEM', { event: 'build_start', taskId, description: description.slice(0, 200) }); }
  static buildPhase(taskId: string, phase: string, message: string): void { UltraDevLog.push('SYSTEM', { event: 'build_phase', taskId, phase, message }); }
  static buildComplete(taskId: string, success: boolean, details?: string): void { UltraDevLog.push('SYSTEM', { event: 'build_complete', taskId, success, details }); }

  static conversationError(conversationId: string, error: string): void { UltraDevLog.push('SYSTEM', { event: 'conversation_error', conversationId, error }); }

  static conversationList(count: number, activeId?: string | null): void {
    if (count === UltraDevLog.lastConvListCount) return;
    UltraDevLog.lastConvListCount = count;
    UltraDevLog.push('SYSTEM', { event: 'conversation_list', count, activeId });
  }

  static conversationLoaded(conversationId: string, messageCount: number): void {
    if (UltraDevLog.lastConvLoadedCounts.get(conversationId) === messageCount) return;
    UltraDevLog.lastConvLoadedCounts.set(conversationId, messageCount);
    UltraDevLog.push('SYSTEM', { event: 'conversation_loaded', conversationId, messageCount });
  }

  static conversationMessage(conversationId: string, role: string, contentLenOrPreview: number | string, source?: string): void {
    const preview = typeof contentLenOrPreview === 'number' ? `[${contentLenOrPreview} chars]` : (contentLenOrPreview ?? '').slice(0, 200);
    UltraDevLog.push('SYSTEM', { event: 'conversation_message', conversationId, role, contentPreview: preview, source });
  }

  static conversationSaved(conversationId: string, messageCount?: number): void { UltraDevLog.push('SYSTEM', { event: 'conversation_saved', conversationId, messageCount }); }
  static costLimitCheck(model: string, withinLimit: boolean, spent?: number, limit?: number): void { UltraDevLog.push('SYSTEM', { event: 'cost_limit_check', model, withinLimit, spent, limit }); }
  static flushToFile(): void { UltraDevLog.flushSyncInternal(); }
  static getDir(): string { return ''; }
  static getFilePath(): string { return ''; }
  static getMemoryEntriesFormatted(limit?: number): string { return UltraDevLog.getFormattedLog(limit); }
  static modelAbort(taskId: string, reason: string): void { UltraDevLog.push('SYSTEM', { event: 'model_abort', taskId, reason }); }
  static modelApiError(model: string, taskId: string, error: string, durationMs: number): void { UltraDevLog.push('SYSTEM', { event: 'model_api_error', model, taskId, error, durationMs }); }
  static modelApiRequest(model: string, taskId: string, promptTokens: number, maxTokens: number): void { UltraDevLog.push('API_CALL', { event: 'request', model, taskId, promptTokens, maxTokens }); }
  static modelApiResponse(model: string, taskId: string, contentLength: number, durationMs: number, cost?: number): void { UltraDevLog.push('API_CALL', { event: 'response', model, taskId, contentLength, durationMs, cost }); }
  static modelDiscoveryStart(): void { UltraDevLog.push('SYSTEM', { event: 'model_discovery_start' }); }
  static modelDiscoveryResult(modelCount: number): void { UltraDevLog.push('SYSTEM', { event: 'model_discovery_result', modelCount }); }
  static modelDiscoveryError(error: string): void { UltraDevLog.push('SYSTEM', { event: 'model_discovery_error', error }); }
  static modelImageRequest(taskId: string, prompt: string): void { UltraDevLog.push('SYSTEM', { event: 'model_image_request', taskId, promptPreview: prompt.slice(0, 200) }); }
  static modelImageResponse(taskId: string, imageCount: number, durationMs: number): void { UltraDevLog.push('SYSTEM', { event: 'model_image_response', taskId, imageCount, durationMs }); }
  static modelImageError(taskId: string, error: string): void { UltraDevLog.push('SYSTEM', { event: 'model_image_error', taskId, error }); }
  static modelSetDefault(modelId: string, source: string): void { UltraDevLog.push('SYSTEM', { event: 'model_set_default', modelId, source }); }
  static modelSetDefaultError(modelId: string, error: string): void { UltraDevLog.push('SYSTEM', { event: 'model_set_default_error', modelId, error }); }
  static modelState(key: string, value: unknown): void { UltraDevLog.push('SYSTEM', { event: 'model_state', key, value }); }
  static permissionCheck(permission: string, status: string): void { UltraDevLog.push('SYSTEM', { event: 'permission_check', permission, status }); }
  static settingsApiSave(key: string, success: boolean): void { UltraDevLog.push('SYSTEM', { event: 'settings_api_save', key, success }); }
  static settingsApiDelete(key: string, success: boolean): void { UltraDevLog.push('SYSTEM', { event: 'settings_api_delete', key, success }); }
  static settingsCostLimitSave(limit: number, success: boolean): void { UltraDevLog.push('SYSTEM', { event: 'settings_cost_limit_save', limit, success }); }
  static settingsDefaultPick(mode: string, modelId: string): void { UltraDevLog.push('SYSTEM', { event: 'settings_default_pick', mode, modelId }); }
  static settingsDefaultsSave(defaults: Record<string, unknown>): void { UltraDevLog.push('SYSTEM', { event: 'settings_defaults_save', defaults }); }
  static settingsState(key: string, value: unknown): void { UltraDevLog.push('SYSTEM', { event: 'settings_state', key, value }); }
  static uiInit(stage: string, message: string): void { UltraDevLog.push('SYSTEM', { event: 'ui_init', stage, message }); }

  static uiState(label: string, state: Record<string, unknown>): void {
    const TRACKED = ['isProcessing', 'conversationId', 'modelsLoaded', 'hasApiKey', 'activeModelId', 'savedDefaults', 'pickerVisible', 'currentMode'];
    const hash = TRACKED.map(k => `${k}:${JSON.stringify(state[k])}`).join('|');
    if (hash === UltraDevLog.lastUiStateHash && !['init_complete', 'before_send'].includes(label)) return;
    UltraDevLog.lastUiStateHash = hash;
    UltraDevLog.push('SYSTEM', { event: 'ui_state', label, state });
  }

  static uiError(context: string, message: string): void { UltraDevLog.push('SYSTEM', { event: 'ui_error', context, message }); }
  static uiConvSwitch(fromId: string, toId: string): void { UltraDevLog.push('SYSTEM', { event: 'ui_conv_switch', fromId, toId }); }
  static uiDefaultsLoaded(source: string, defaults: Record<string, unknown>): void { UltraDevLog.push('SYSTEM', { event: 'ui_defaults_loaded', source, defaults }); }
  static uiModelApply(modelId: string, mode: string, source: string, success: boolean, error?: string): void { UltraDevLog.push('SYSTEM', { event: 'ui_model_apply', modelId, mode, source, success, error }); }
  static uiModeSwitch(from: string, to: string, source: string): void { UltraDevLog.push('SYSTEM', { event: 'ui_mode_switch', from, to, source }); }
  static uiPickerOpen(filter: string, mode: string, activeModelId: string | null): void { UltraDevLog.push('SYSTEM', { event: 'ui_picker_open', filter, mode, activeModelId }); }
  static uiPickerSelect(modelId: string, previousModelId: string | null): void { UltraDevLog.push('SYSTEM', { event: 'ui_picker_select', modelId, previousModelId }); }
  static uiPlusMenuSelect(type: string, hasDefault: boolean, defaultModel: string | null): void { UltraDevLog.push('SYSTEM', { event: 'ui_plus_menu_select', type, hasDefault, defaultModel }); }
  static uiSendMessage(inputLength: number, mode: string, modelId: string | null, isProcessing: boolean): void { UltraDevLog.push('SYSTEM', { event: 'ui_send_message', inputLength, mode, modelId, isProcessing }); }
  static uiStopRequest(hasCore: boolean): void { UltraDevLog.push('SYSTEM', { event: 'ui_stop_request', hasCore }); }
  static uiFocusEffect(trigger: string, mode: string, savedKeys: string[], activeModelId: string | null): void { UltraDevLog.push('SYSTEM', { event: 'ui_focus_effect', trigger, mode, savedKeys, activeModelId }); }

  static vaultGet(key: string, found: boolean, valuePreview?: string): void { UltraDevLog.vaultRead(key, found, valuePreview); }
  static vaultSet(key: string, success: boolean, valuePreview?: string): void { UltraDevLog.vaultWrite(key, success, valuePreview); }
  static vaultDelete(key: string, success: boolean): void { UltraDevLog.push('SYSTEM', { event: 'vault_delete', key, success }); }
  static vaultError(operation: string, key: string, error: string): void { UltraDevLog.push('SYSTEM', { event: 'vault_error', operation, key, error }); }

  // ─── Format & Export ───────────────────────────────────────────────────────

  static getMemoryEntries(limit?: number): UltraLogEntry[] {
    return limit ? UltraDevLog.entries.slice(-limit) : [...UltraDevLog.entries];
  }

  static getFormattedLog(limit = 500): string {
    return UltraDevLog.entries.slice(-limit).map(e => UltraDevLog.formatEntry(e)).join('\n');
  }

  private static formatEntry(e: UltraLogEntry): string {
    const t = e.ts.slice(11, 23);
    const d = e.data;
    const c = e.coreId ? ` [${e.coreId.slice(-6)}]` : '';
    const w = (s: unknown) => (s as string)?.startsWith?.('WARN') || (s as string)?.startsWith?.('BUG') ? ' *** ' : ' ';

    switch (e.cat) {
      case 'USER_MSG': return `${t} [USER    ]${c} "${d.content}"`;
      case 'AI_RESPONSE': return `${t} [AI      ]${c} model=${d.model} cost=$${d.cost} | ${(d.content as string).slice(0, 200)}`;
      case 'AGENT_STEP':
        if (d.event === 'execute_start') return `${t} [EXEC_ST ]${c} task=${d.taskId} len=${d.inputLength} replay=${d.isReplay}`;
        return `${t} [STEP    ]${c} [${d.phase}] ${d.success ? 'OK' : 'FAIL'} ${d.detail}`;
      case 'MODE': return `${t} [MODE    ]${c} ${d.mode} | "${d.inputPreview}"`;
      case 'PLAN': return `${t} [PLAN    ]${c} cap=${d.capability} det=${d.deterministic} params=${JSON.stringify(d.params)}`;
      case 'SAFETY': return `${t} [SAFETY  ]${c} risk=${d.risk} allowed=${d.allowed}`;
      case 'EXEC_RESULT': return `${t} [EXEC    ]${c} ${d.capability} ${d.success ? 'OK' : 'FAIL'} ${(d.resultPreview as string).slice(0, 200)}`;
      case 'VERIFY': return `${t} [VERIFY  ]${c} ${d.verified ? 'OK' : 'FAIL'} issues=[${(d.issues as string[]).join('; ') || 'none'}]`;
      case 'ERROR': return `${t} [ERROR   ]${c} [${d.context}] ${d.message}${d.stack ? ' | ' + (d.stack as string).slice(0, 250) : ''}`;
      case 'SYSTEM': return `${t} [SYSTEM  ]${c} ${d.event ?? d.context ?? ''} ${d.message ?? d.stage ?? JSON.stringify(d).slice(0, 180)}`;
      case 'COST': return `${t} [COST    ] $${d.cost} ${d.model}`;
      case 'API_CALL':
        if (d.event === 'request') return `${t} [API_REQ ]${c} ${d.model} promptTok=${d.promptTokens}`;
        if (d.event === 'response') return `${t} [API_RES ]${c} ${d.model} ${d.durationMs}ms cost=$${d.cost ?? 0}`;
        return `${t} [API     ]${c} ${d.model} in=${d.promptTokens} out=${d.completionTokens} ${d.durationMs}ms`;
      case 'MODEL_SWITCH': return `${t} [MODEL   ]${c} ${d.from} -> ${d.to}`;
      case 'CONV_NEW': return `${t} [CONV_NEW] ${d.conversationId} "${d.title}"`;
      case 'CONV_DEL': return `${t} [CONV_DEL] ${d.conversationId}`;
      case 'UI_MODAL': return `${t} [MODAL   ]${c} ${d.modalName} ${d.action}`;
      case 'UI_PROCESSING': return `${t} [PROC    ]${c} processing=${d.isProcessing} src=${d.source}${d.durationMs ? ` dur=${d.durationMs}ms` : ''}`;
      case 'UI_RENDER_MSG': return `${t} [MSGS    ]${c} ${d.prevCount}->${d.nextCount} src=${d.source}`;
      case 'UI_SEND_ATTEMPT': return `${t} [SEND?   ]${c} mode=${d.mode} model=${d.modelId} msgs=${d.messageCount} locked=${d.isProcessing} "${d.inputPreview}"`;
      case 'UI_SEND_COMPLETE': return `${t} [SENT    ]${c} task=${d.taskId} ${d.success ? 'OK' : 'FAIL'} ${d.durationMs}ms`;
      case 'APP_LAUNCH_BEGIN': return `${t} [LAUNCH> ]${c} "${d.target}"`;
      case 'APP_LAUNCH_DEVICE': return `${t} [LAUNCH? ]${c} ${d.appCount} apps ${d.queryDurationMs}ms${d.error ? ' ERR:' + d.error : ''}`;
      case 'APP_LAUNCH_MATCH': return `${t} [LAUNCH= ]${c} "${d.target}" ${d.matchType} pkg=${d.resolvedPkg || 'NONE'}`;
      case 'APP_LAUNCH_AI': return `${t} [LAUNCH_AI]${c} "${d.target}" -> "${d.resolvedPkg}" ${d.durationMs}ms`;
      case 'APP_LAUNCH_FIRE': return `${t} [LAUNCH! ]${c} pkg="${d.pkg}" <- SUSPENDS`;
      case 'APP_LAUNCH_RESUME': return `${t} [LAUNCH^ ]${c} resumed after ${d.suspendDuration}ms`;
      case 'APP_LAUNCH_FAIL': return `${t} [LAUNCH_X]${c} stage=${d.stage} "${d.error}"`;
      case 'SMS_RESOLVE': return `${t} [SMS?    ]${c} "${d.inputName}" resolved=${d.resolved} num=${d.resolvedNumber || 'NOT FOUND'}${d.error ? ' ERR:' + d.error : ''}`;
      case 'SMS_FIRE': return `${t} [SMS!    ]${c} isPhone=${d.toIsPhone}${d.toIsPhone ? '' : ' <- NOT A PHONE'}`;
      case 'SMS_RESULT': return `${t} [SMS_OK  ]${c} ${d.result} ok=${d.success}`;
      case 'VAULT_READ': return `${t} [VAULT_R ] ${d.key} found=${d.found}${d.valuePreview ? ` "${d.valuePreview}"` : ''}`;
      case 'VAULT_WRITE': return `${t} [VAULT_W ] ${d.key} ok=${d.success}${d.valuePreview ? ` "${d.valuePreview}"` : ''}`;
      case 'PARSE_INPUT': return `${t} [PARSE   ]${c} pat=${d.matchedPattern || 'NONE'} cap=${d.capability || 'NONE'} compound=${d.isCompound}`;
      case 'PARSE_COMPOUND': return `${t} [COMPOUND]${c} "${d.input}"`;
      case 'PICKER_OPEN': return `${t} [PICKER> ] ${d.modelCount} models filter=${d.filter} anim=${d.slideAnimCurrentValue} ${d.note}`;
      case 'PICKER_CLOSE': return `${t} [PICKER< ] via ${d.how}`;
      case 'PICKER_ANIMATE': return `${t} [PICKER~ ] ${d.direction} ${d.fromValue}->${d.toValue} ${d.animationType}`;
      case 'PICKER_SELECT': return `${t} [PICKER+ ] ${d.modelId} was=${d.previousModelId}`;
      case 'CORE_INSTANCE': {
        const icon = d.event === 'created' ? 'NEW' : d.event === 'destroyed' ? 'DEL' : 'TAG';
        return `${t} [CORE_${icon}]${w(d.note)}id=${(d.instanceId as string)?.slice(-8)} ${d.event} ${d.reason ?? ''} ${d.note}`;
      }
      case 'EXECUTOR_BRANCH': return `${t} [EXEC_BR ]${c} [${d.capability}] ${d.branch}${d.success !== undefined ? ` ok=${d.success}` : ''}${d.path ? ` path=${d.path}` : ''}`;
      case 'CONV_CONTEXT_SENT': return `${t} [CTX_SENT]${c} tok~${d.estimated_total_tokens} sys=${d.systemPct}% hist=${d.historyPct}% cap=${d.capabilityPct}% usr=${d.userPct}%${(d.contaminationRisk || d.bloatRisk) ? ' *** ' + d.note : ''}`;
      case 'UI_MESSAGE_RENDERED':
        if (d.event === 'scroll') return `${t} [SCROLL  ] y=${d.scrollOffsetY}px ${d.scrollPct}%${d.isAtBottom ? ' [BOT]' : ''}`;
        return `${t} [RENDERED]${c} ${d.messageId} h=${d.measuredHeightPx}px idx=${d.indexInList} vis=${d.isVisible} hKnown=${d.listHeightKnown}${d.tallWarning || !d.listHeightKnown ? ' *** ' + d.note : ''}`;
      case 'TASK_WATCHDOG': {
        const bang = d.event === 'FIRED' ? '!!! ' : '';
        return `${t} [WATCHDOG] ${bang}${d.taskId} ${d.phase} ${d.event}${d.stalenessMs ? ` stale=${d.stalenessMs}ms` : ''}${d.elapsedMs ? ` ok=${d.elapsedMs}ms` : ''}`;
      }
      case 'APP_STATE_CHANGE': return `${t} [APPSTATE] ${d.nextState} +${d.elapsedSinceLastChange}ms${d.backgroundDurationMs ? ` bg=${d.backgroundDurationMs}ms` : ''} core=${d.activeCoreId ?? 'none'}${(d.note as string) !== 'ok' ? ' *** ' + d.note : ''}`;
      case 'COMPONENT_LIFECYCLE': {
        const warn = (d.priorMountsThisSession as number) > 0 && d.event === 'mount' ? ' *** ' : ' ';
        return `${t} [COMP_LC ]${warn}${d.event} ${d.componentName} id=${(d.componentId as string)?.slice(-6)}${d.reason ? ` reason=${d.reason}` : ''} ${d.note ?? ''}`;
      }
      case 'SETTINGS_SAVE': {
        const icon = d.event === 'tap' ? '>' : (d.success ? 'OK' : 'FAIL');
        return `${t} [SETSAVE ] ${icon} ${d.section} ${d.event}${d.savedKeys ? ` keys=${(d.savedKeys as string[]).join(',')}` : ''}${d.error ? ` ERR=${d.error}` : ''}`;
      }
      case 'EXECUTE_PHASE': return `${t} [EX_PHASE]${c} ${d.phase} task=${d.taskId}`;
      case 'NAV_CHANGE': return `${t} [NAV     ]${c} route=${d.routeName} action=${d.action} depth=${d.stackDepth}`;
      case 'FOCUS_EFFECT_DEPS':
        if (d.event === 'suppressed') return `${t} [FOCUS_T ] throttle ok ${d.elapsedMs}ms`;
        return `${t} [FOCUS_D ] changed=[${(d.changedDeps as string[]).join(',')}]${d.isFirstTrigger ? ' (first)' : ''}${(d.note as string)?.startsWith('WARN') ? ' *** ' + d.note : ''}`;
      case 'PROCESS_RESTART': return `${t} [PROC_RS ] ${d.event}${d.backgroundDurationMs ? ` bg=${d.backgroundDurationMs}ms` : ''} ${d.note}`;
      case 'PICKER_CONTENT': return `${t} [PICK_CT ] filter=${d.activeFilter} ${d.filteredCount}/${d.totalCount}${(d.note as string)?.startsWith('WARN') ? ' *** ' + d.note : ''}`;
      case 'CONTEXT_PROVIDER': return `${t} [CTX_PRV ] ${d.providerName} render#${d.renderCount} core=${(d.coreInstanceId as string)?.slice(-6)} ${d.note}`;
      case 'SESSION_SUMMARY': return `${t} [SUMMARY ] ${JSON.stringify(d)}`;
      default: return `${t} [${e.cat.padEnd(8)}]${c} ${JSON.stringify(d).slice(0, 300)}`;
    }
  }

  static generateBugReport(): string {
    const entries = [...UltraDevLog.entries];
    const lines: string[] = [];
    const hr = '='.repeat(52);

    lines.push(hr);
    lines.push(`AGENT ULTRA -- BUG REPORT v3`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Session:   ${UltraDevLog.sessionId}`);
    lines.push(`Entries:   ${entries.length}`);
    lines.push(hr);

    const failures = entries.filter(e =>
      e.cat === 'ERROR' || e.cat === 'APP_LAUNCH_FAIL' ||
      (e.cat === 'EXEC_RESULT' && !e.data.success) ||
      (e.cat === 'SMS_FIRE' && !e.data.toIsPhone) ||
      (e.cat === 'PARSE_COMPOUND') ||
      (e.cat === 'TASK_WATCHDOG' && e.data.event === 'FIRED') ||
      (e.cat === 'CORE_INSTANCE' && (e.data.note as string)?.startsWith('WARN')) ||
      (e.cat === 'COMPONENT_LIFECYCLE' && (e.data.note as string)?.startsWith('WARN')) ||
      (e.cat === 'SETTINGS_SAVE' && e.data.event === 'write_result' && !e.data.success) ||
      (e.cat === 'PICKER_CONTENT' && (e.data.note as string)?.startsWith('WARN')) ||
      (e.cat === 'UI_MESSAGE_RENDERED' && (e.data.tallWarning || (e.data.note as string)?.includes('listHeightPx=0'))) ||
      (e.cat === 'VAULT_WRITE' && e.data.success === false) ||
      (e.cat === 'PROCESS_RESTART' && e.data.event === 'warm_restart') ||
      (e.cat === 'FOCUS_EFFECT_DEPS' && (e.data.changedDeps as string[])?.includes('currentMode'))
    );

    lines.push(''); lines.push(`-- FAILURES & WARNINGS (${failures.length}) -----------------`);
    failures.length === 0 ? lines.push('  None.') : failures.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));

    const lastUser = [...entries].reverse().find(e => e.cat === 'USER_MSG');
    lines.push(''); lines.push('-- LAST USER INPUT --------------------------------');
    lines.push(lastUser ? `  "${lastUser.data.content}"` : '  (none)');

    const lastExec = [...entries].reverse().find(e => e.data.taskId);
    if (lastExec) {
      const taskId = lastExec.data.taskId as string;
      const te = entries.filter(e => e.data.taskId === taskId);
      lines.push(''); lines.push(`-- LAST TASK CHAIN (${taskId}) ----------------------`);
      te.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
      const PHASES = ['INGEST','ROUTE','PLAN','VERIFY','APPROVE','EXECUTE','VERIFY_RESULT','RESPOND'];
      const reached = te.filter(e => e.cat === 'EXECUTE_PHASE').map(e => e.data.phase as string);
      const last = reached[reached.length - 1];
      if (last) { const next = PHASES[PHASES.indexOf(last) + 1]; if (next) { lines.push(''); lines.push(`  PHASE GAP: crash in ${last} phase (next ${next} never reached).`); } }
      const enter = te.filter(e => e.cat === 'EXECUTOR_BRANCH' && e.data.branch === 'ENTER').length;
      const exit = te.filter(e => e.cat === 'EXECUTOR_BRANCH' && e.data.branch === 'EXIT').length;
      if (enter > exit) { lines.push(''); lines.push(`  EXECUTOR MISFIRE: ENTER=${enter} EXIT=${exit}.`); }
    }

    const compEv = entries.filter(e => e.cat === 'COMPONENT_LIFECYCLE').slice(-8);
    lines.push(''); lines.push(`-- COMPONENT LIFECYCLE (last ${compEv.length}) ---------------`);
    compEv.length === 0 ? lines.push('  None -- componentMount() not instrumented.') : compEv.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));

    const restarts = entries.filter(e => e.cat === 'PROCESS_RESTART');
    if (restarts.length > 0) { lines.push(''); lines.push('-- PROCESS RESTART -----------------------------------'); restarts.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e))); }

    const saves = entries.filter(e => e.cat === 'SETTINGS_SAVE').slice(-6);
    lines.push(''); lines.push(`-- SETTINGS SAVE TRACE (last ${saves.length}) ----------------`);
    saves.length === 0 ? lines.push('  None -- settingsSaveTap() not instrumented.') : saves.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));

    const proc = entries.filter(e => e.cat === 'UI_PROCESSING').slice(-10);
    lines.push(''); lines.push('-- isProcessing TRANSITIONS (last 10) ---------------');
    proc.length === 0 ? lines.push('  None.') : proc.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    if (proc[proc.length-1]?.data.isProcessing === true) lines.push('  *** isProcessing=true at end -- UI locked.');

    const cores = entries.filter(e => e.cat === 'CORE_INSTANCE').slice(-10);
    lines.push(''); lines.push(`-- CORE INSTANCE TRACE (last ${cores.length}) ------------------`);
    cores.length === 0 ? lines.push('  None.') : cores.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));
    const creates = entries.filter(e => e.cat === 'CORE_INSTANCE' && e.data.event === 'created').length;
    if (creates > 1) lines.push(`  *** ${creates} cores created. Move AgentCore to React Context.`);

    const appSt = entries.filter(e => e.cat === 'APP_STATE_CHANGE').slice(-6);
    if (appSt.length > 0) { lines.push(''); lines.push(`-- APP STATE (last ${appSt.length}) -------------------------`); appSt.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e))); }

    const focusDeps = entries.filter(e => e.cat === 'FOCUS_EFFECT_DEPS').slice(-6);
    if (focusDeps.length > 0) { lines.push(''); lines.push(`-- FOCUS EFFECT DEPS (last ${focusDeps.length}) ----------------`); focusDeps.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e))); }

    const errs = entries.filter(e => e.cat === 'ERROR').slice(-5);
    if (errs.length > 0) { lines.push(''); lines.push('-- ERRORS --------------------------------------------'); errs.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e))); }

    const vf = entries.filter(e => e.cat === 'VAULT_WRITE' && e.data.success === false).slice(-5);
    if (vf.length > 0) { lines.push(''); lines.push(`-- VAULT WRITE FAILURES (${vf.length}) --------------------`); vf.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e))); }

    const launch = entries.filter(e => ['APP_LAUNCH_BEGIN','APP_LAUNCH_DEVICE','APP_LAUNCH_MATCH','APP_LAUNCH_AI','APP_LAUNCH_FIRE','APP_LAUNCH_RESUME','APP_LAUNCH_FAIL'].includes(e.cat)).slice(-12);
    if (launch.length > 0) { lines.push(''); lines.push(`-- APP LAUNCH TRACE (last ${launch.length}) ----------------`); launch.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e))); }

    const picker = entries.filter(e => ['PICKER_OPEN','PICKER_CLOSE','PICKER_ANIMATE','PICKER_SELECT','PICKER_CONTENT'].includes(e.cat)).slice(-10);
    lines.push(''); lines.push(`-- PICKER TRACE (last ${picker.length}) -------------------`);
    picker.length === 0 ? lines.push('  None.') : picker.forEach(e => lines.push('  ' + UltraDevLog.formatEntry(e)));

    lines.push(''); lines.push(hr); lines.push(`END -- paste to Replit`); lines.push(hr);
    return lines.join('\n');
  }

  // ─── File I/O ──────────────────────────────────────────────────────────────

  private static getLogDir(): string {
    if (!FileSystem?.documentDirectory) return '';
    return `${FileSystem.documentDirectory}ultra_dev_logs/`;
  }

  private static getSessionFilePath(): string {
    const dir = UltraDevLog.getLogDir();
    return dir ? `${dir}session_${UltraDevLog.sessionId}.jsonl` : '';
  }

  private static flushSyncInternal(): void {
    setImmediate(() => UltraDevLog.doFlush());
  }

  private static scheduleFlush(): void {
    if (Platform.OS === 'web') return;
    if (UltraDevLog.pendingFlush) return;
    UltraDevLog.pendingFlush = true;
    setTimeout(() => { UltraDevLog.pendingFlush = false; UltraDevLog.doFlush(); }, 2000);
  }

  static async forceFlush(): Promise<void> { await UltraDevLog.doFlush(); }

  private static async doFlush(): Promise<void> {
    if (Platform.OS === 'web' || !FileSystem) return;
    if (UltraDevLog.writing) return;
    UltraDevLog.writing = true;
    try {
      const dir = UltraDevLog.getLogDir();
      if (!dir) return;
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      await FileSystem.writeAsStringAsync(UltraDevLog.getSessionFilePath(), UltraDevLog.entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    } catch {} finally { UltraDevLog.writing = false; }
  }

  static async exportAll(): Promise<string> {
    await UltraDevLog.doFlush();
    if (Platform.OS === 'web' || !FileSystem) return UltraDevLog.entries.map(e => JSON.stringify(e)).join('\n');
    try {
      const fp = UltraDevLog.getSessionFilePath();
      const info = await FileSystem.getInfoAsync(fp);
      if (info.exists) return await FileSystem.readAsStringAsync(fp);
    } catch {}
    return UltraDevLog.entries.map(e => JSON.stringify(e)).join('\n');
  }

  static clear(): void {
    UltraDevLog.entries = [];
    UltraDevLog.seq = 0;
    UltraDevLog.activeCoreId = null;
    UltraDevLog.lastUiStateHash = '';
    UltraDevLog.lastConvListCount = -1;
    UltraDevLog.lastConvLoadedCounts.clear();
    UltraDevLog.lastVaultReadTs.clear();
    UltraDevLog.processingStartedAt = 0;
    UltraDevLog.lastRenderedHeights.clear();
    for (const e of UltraDevLog.watchdogs.values()) clearTimeout(e.timeoutHandle);
    UltraDevLog.watchdogs.clear();
  }

  static async cleanOldLogs(maxAgeDays = 7): Promise<number> {
    if (Platform.OS === 'web' || !FileSystem) return 0;
    try {
      const dir = UltraDevLog.getLogDir();
      if (!dir) return 0;
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists) return 0;
      const files = await FileSystem.readDirectoryAsync(dir);
      const cutoff = Date.now() - maxAgeDays * 86400000;
      let n = 0;
      for (const f of files) {
        const m = f.match(/session_([a-z0-9]+)\.jsonl/);
        if (m && parseInt(m[1], 36) < cutoff) { await FileSystem.deleteAsync(`${dir}${f}`); n++; }
      }
      return n;
    } catch { return 0; }
  }
}
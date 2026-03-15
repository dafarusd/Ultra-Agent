# Agent Ultra -- Changelog

All notable changes to this project are documented here, organized by feature version. Dates reflect when work was completed.

---

## [v3.22.0] -- 2026-03-15 -- Fix: Model Picker Empty Categories (Image/Video/Reasoning)

### Fixed -- Model picker filter tabs
- **Image tab**: Was showing 0 models. Venice image models (flux, fluently, stable-diffusion, etc.) were all classified as "text" because Venice API returns `type: "text"` for everything.
- **Video tab**: Was showing 0 models. Same root cause — no name-based heuristics existed.
- **Reasoning tab**: Was showing 29/47 models. `supportsReasoning` capability flag from Venice API is set on most models, making the Reasoning tab a dumping ground.

### Added -- Shared model classifier
- New `src/utils/classifyModelType.ts` — single source of truth for model category classification
- Uses name/ID pattern matching: image (flux, fluently, sdxl, stable-diffusion, pony-realism), video (wan-, luma, runway, kling), code (code, codestral), reasoning (reason, qwq, deepseek-r1)
- Removed dependency on Venice `supportsReasoning` capability flag for tab classification
- Both `app/index.tsx` (picker) and `app/settings.tsx` (defaults) now use the same classifier

### Added -- Classification devlog
- `MODEL_CLASSIFY` entry logged via `UltraDevLog.modelState('picker_classification', counts)` on each picker build
- Shows `{text:N, image:N, code:N, reasoning:N, video:N}` for remote debugging

### Fixed -- Model picker sheet height (v3.21.1)
- Added `height: SHEET_MAX_HEIGHT` to sheet `Animated.View` — FlatList with `flex: 1` previously resolved to 0 height because parent only had `maxHeight`
- Sheet now fully slides up showing the model list

---

## [v3.20.0] -- 2026-03-15 -- Fix: Log File Proliferation (Hundreds → 3-4 Files)

### Fixed -- Log file explosion
- **Root cause:** `agent-ultra-logs/` used timestamped filenames, creating a new file every 2-3 seconds instead of updating existing ones.
- **Solution:** Changed to fixed filenames (`ultra-devlog.jsonl`, `debug-log.jsonl`, `raw-export.jsonl`). Since `writeAsStringAsync` overwrites (doesn't append), each flush now updates the same file, making it grow naturally over the session.
- **Cleanup:** Added automatic deletion of old timestamped files on app startup to clean up accumulated files from prior versions.
- **Result:** 3-4 files max, ~5 MB max total, growing naturally to several MB per session. Files are never truncated mid-session.

### Added -- Comprehensive log proliferation report
- `LOG-FILE-PROLIFERATION-REPORT.md` contains full analysis, data flow, file cross-linkage, why it happened, and technical explanation.

### Changed
- `src/utils/UltraDevLog.ts` line 840: Fixed filename `ultra-devlog.jsonl`
- `src/utils/DebugLog.ts` line 395: Fixed filename `debug-log.jsonl`
- `src/utils/DebugLog.ts` lines 417, 422: Fixed filename `raw-export.jsonl`
- `src/services/LogFolder.ts` lines 45-52: Added cleanup block for old timestamped files

---

## [v3.19.0] -- 2026-03-15 -- Fix: Logs Tab Crash + Comprehensive Bug Report

### Fixed -- Logs tab crash (3 bugs)
- **Bug 1:** `loadDebugLogs()` called on mount and tab switch but never defined in settings.tsx. Replaced with `loadLogs()`.
- **Bug 2:** `setImmediate` in `UltraDevLog.flushSyncInternal()` doesn't exist in React Native (Hermes/web). Replaced with `setTimeout(..., 0)`.
- **Bug 3:** Dead state variables `debugLogs`/`debugLogsLoaded` removed from settings.tsx (remnants of incomplete refactor).

### Identified -- Remaining latent bugs (documented, not yet fixed)
- **Bug 4:** `LogFolder.getLogsDir()` line 27 tries `DocumentDirectoryPath` (react-native-fs property, doesn't exist in expo-file-system). Harmless -- fallback to `documentDirectory` works.
- **Bug 5:** Double-slash in path (`documentDirectory` ends with `/`, then `/agent-ultra-logs` adds another).
- **Bug 6:** Three separate log directories (`ultra_dev_logs/`, `debug_logs/`, `agent-ultra-logs/`) -- Logs tab only reads `agent-ultra-logs/`. DebugLog auto-flush writes only to `debug_logs/`, invisible in Settings.
- **Bug 7:** `settingsCostLimitSave(dailyLimit, taskLimit)` passes (string, string) where UltraDevLog expects (number, boolean).

### Removed -- metro.config.js
- Metro config with `path.resolve` blockList broke EAS builds on Windows CI (ESM loader can't handle `c:` protocol in regex).
- Both `.js` and `.cjs` extensions failed identically. File removed -- Metro ENOENT in Replit is transient.

### Added -- Comprehensive bug report
- `AGENT-ULTRA-BUG-REPORT.md` contains full cross-linkage analysis, data flow diagrams, all file contents, and quick-fix patches for external resolution.

### Changed
- `ultra-full-source.txt` regenerated (19,085 lines).

---

## [v3.18.0] -- 2026-03-15 -- Feature: Log Folder Download System

### Added -- Downloadable log folder in Settings > Logs
- Created LogFolder service (`src/services/LogFolder.ts`) that manages log storage in `documentDirectory/agent-ultra-logs/`.
- All logs (from UltraDevLog and DebugLog) automatically written to disk whenever they're flushed or exported.
- New "Log Files" tab in Settings shows all saved logs with file sizes, sorted newest first.
- Click any log file to trigger native "Save file" dialog (Android File Picker) -- no more clipboard size limits.
- LogFolder.listLogs() handles file listing; Sharing.shareAsync() handles download.

### Implementation details:
- UltraDevLog.doFlush() writes JSONL logs to LogFolder with timestamped filenames.
- DebugLog.exportAll() also writes to LogFolder so all logs sync to disk.
- Settings UI: Refresh button, file size display, one-tap download to device storage.
- Logs persisted on disk, accessible via Android File Manager and email attachments.

---

## [v3.17.0] -- 2026-03-15 -- Fix: Quick Reply Chip Sizing, Samsung Notes Share

### Fixed -- Quick reply chips rendering as oversized cards
- Replaced horizontal `ScrollView` with a `View` using `flexDirection: "row"` and `flexWrap: "wrap"` in QuickReplies component.
- Inside the message bubble (vertical flex), the horizontal ScrollView's default `alignItems: "stretch"` was stretching chips to fill all available vertical space, making them ~200px tall cards instead of ~25px pill chips.
- This also fixes the oversized bubble issue: msg bubbles were measured at 4971px because the stretched chips inflated the total height.

### Reverted -- Samsung Notes share
- File-based sharing approach kept; Samsung Notes limitation (no .txt import) is app-specific, not a code issue.
- Created LogFolder system instead: all logs automatically saved to device storage, downloadable via Android File Picker.

---

## [v3.16.0] -- 2026-03-15 -- Fix: Quick Replies, Model Picker, Log Corruption

### Fixed -- Quick reply buttons not showing on AI responses
- Added `extraData` prop to the message FlatList so it re-renders when `isProcessing`, `pendingReplay`, `copiedId`, and `expandedMsgs` change.
- Without `extraData`, FlatList didn't know to re-render items when processing finished, so `showQuickReplies` stayed stale.
- Added fallback in `getQuickReplies()`: messages without a `source` property now also show generic quick reply chips (Go deeper, Summarize, Make actionable).

### Fixed -- Model picker not opening on tap
- Added `hitSlop` (10px top/bottom, 6px left/right) to the model pill Pressable in the input bar.
- The pill's 20px touch target was too small on Android -- taps were missing the Pressable hit area.

### Fixed -- Bug report and formatted log "file corrupted" in Samsung Notes
- Replaced all Unicode symbols (checkmarks, arrows, em dashes, box-drawing) with ASCII equivalents in both UltraDevLog and DebugLog format strings.
- Samsung Notes rejects files with these characters as "corrupted" when received via Android share sheet.
- JSONL export now uses `.txt` extension and `text/plain` mime type for broader share target support.

---

## [v3.15.0] -- 2026-03-14 -- Fix: Oversized Bubble, Render Loop, and Log Download

### Fixed — Oversized message bubbles
- Messages over 4000 characters are now truncated with a "Show more" / "Show less" toggle.
- Prevents 5800px-tall bubbles that caused layout thrashing and poor scrolling performance.

### Fixed — Render loop spam in debug logs
- `messageRendered()` now deduplicates by message ID — only logs when the measured height changes by ≥2px.
- Eliminates the 150ms render-loop that was filling the 3000-entry log buffer with identical RENDERED entries.

### Changed — Log export uses file download instead of clipboard
- "Bug Report", "Full Log", and "JSONL" exports now write to a temp file and open the system share sheet.
- Users can save to Files, email, or any share target — no more clipboard size limits.
- Falls back to clipboard on web where file sharing isn't available.
- Error alerts now shown instead of silently swallowing failures.

---

## [v3.14.0] — 2026-03-14 — Fix: Remove Hardcoded Biometric Gate (Root Cause of UI State Loss)

### Removed — Biometric gate from `_layout.tsx`
- Removed hardcoded biometric authentication that ran on every app launch and background return.
- Removed `AppState` listener that set `authenticated=false` on foreground return, which unmounted the entire component tree (ChatScreen, Stack, all providers).
- Removed `authenticated`, `authChecked`, `appStateRef`, `biometricAvailableRef` state/refs.
- Removed conditional render blocks ("Authenticating...", "Authentication required", "Tap to retry").
- Removed `lockStyles` stylesheet and `BiometricGate` import.
- `RootLayout` now always renders the full app tree — ChatScreen stays mounted across background/foreground transitions.

### Why
- **Root cause of UI state loss bug:** Every background→foreground cycle triggered biometric re-auth, which set `authenticated=false`, causing React to unmount `RootLayoutNav` and everything beneath it. ChatScreen remounted with all `useState` defaults (`agentCore=null`, `messages=[]`, `status="Initializing..."`, `activeModelId=""`). The module-level `_agentCoreInitialized` guard blocked re-initialization, so no recovery was possible.
- **Confirmed by dev logs:** LOG 1 (v3.12) showed duplicate CORE_INSTANCE creation on every background cycle. LOG 2 (v3.13) showed no CORE_INSTANCE but state deadlock — `activeModelId=""`, `modelsLoaded=0`, `hasApiKey=false` permanently after first background return.
- **BiometricGate.ts retained** in `src/security/` for future opt-in biometric+PIN feature in Settings.

---

## [v3.13.0] — 2026-03-14 — UltraDevLog v3: Full Sensor Instrumentation

### Added — UltraDevLog v3 new sensors instrumented
- **N1 (COMPONENT_LIFECYCLE)**: `componentMount/Unmount` in ChatScreen useEffect tracks mount IDs.
- **N2 (SETTINGS_SAVE)**: `settingsSaveTap/settingsSaveResult` wrapping api, defaults, and limits save handlers in settings.tsx.
- **N3 (EXECUTE_PHASE)**: `executePhase()` at all 9 steps in AgentCore.execute() (INGEST→ROUTE→PLAN→VERIFY→APPROVE→EXECUTE→VERIFY_RESULT→WRITE_MEMORY→ADAPT).
- **N4 (NAV_CHANGE)**: Sensor defined in UltraDevLog but NOT wired — `useNavigationContainerRef` crashes expo-router's internal NavigationContainer. Deferred until safe hook available.
- **N5 (FOCUS_EFFECT_DEPS)**: `focusEffectTriggered/Suppressed` in useFocusEffect with prevFocusDepsRef dependency diff tracking.
- **N6 (PROCESS_RESTART)**: `checkProcessRestart()` called before AgentCore init to detect Android process kills.
- **N7 (PICKER_CONTENT)**: `pickerContentRender()` on first FlatList renderItem in ModelPickerSheet.

### Fixed — v3 caller signature updates
- `SecureVault.ts` vaultGet: Changed from `vaultGet(key, cached, 'cache')` to `vaultGet(key, true, cached.slice(0,80))` and `vaultGet(key, !!value, value?.slice(0,80))`.
- `settings.tsx` settingsApiSave: Changed from `settingsApiSave(primary.id, primary.baseUrl)` to `settingsApiSave(primary.id, true)`.
- `settings.tsx` settingsApiDelete: Changed from `settingsApiDelete(id)` to `settingsApiDelete(id, true)`.
- `settings.tsx` settingsDefaultPick: Changed from `settingsDefaultPick(role, m.id, m.name || m.id)` to `settingsDefaultPick(role, m.id)`.

### Changed — ModelPickerSheet mount noise fix
- Replaced `hasBeenVisible` ref with `mountedAtRef` timestamp. Close animation suppression now uses `pickerAnimate`'s built-in `mountedAt < 500ms` guard instead of a separate boolean.

---

## [v3.12.0] — 2026-03-14 — Critical: Fix Re-Init Bug, conversationMessage Crash & Defaults Persistence

### Fixed — Re-init on background return (CRITICAL)
- Root cause: `agentCoreInitialized` was a `useRef(false)` inside the component. When Android unmounts/remounts the component on background return, the ref resets to `false`, causing a new AgentCore to be created every time.
- Fix: Replaced with module-level `let _agentCoreInitialized = false` that survives component remount cycles.
- Removed `coreRef.destroy('component_unmount')` cleanup that was actively tearing down the core on every background transition.

### Fixed — "undefined is not a function" crash on every message send (CRITICAL)
- Root cause: `ConversationManager.addMessage()` calls `DebugLog.conversationMessage(conversationId, role, msg.content?.length ?? 0, source)` — passing a **number** as the 3rd arg. `UltraDevLog.conversationMessage` expected a **string** and called `.slice(0, 200)` on it. Numbers don't have `.slice()`, causing the crash.
- Fix: Updated `UltraDevLog.conversationMessage` to accept `number | string` for the 3rd parameter, with type-safe handling.

### Fixed — Spurious PICKER_ANIMATE close on every mount
- ModelPickerSheet's `useEffect([visible])` fired the close animation on initial mount when `visible=false`. Added `hasBeenVisible` ref guard to skip the close branch until the picker has been opened at least once.

### Fixed — Default model picks not persisting (Bug 3)
- Root cause: Picking a default model in settings only updated local state (`setDefaults`). The user had to separately press "Save Defaults" — a step they were missing, so `VAULT_WRITE api_defaults` never fired.
- Fix: Each model pick and "Auto" selection now auto-saves to vault immediately via `vault.set("api_defaults", ...)`.
- Also fixed `SecureVault.set()` calling `DebugLog.vaultSet(key, value.length)` — was passing a number where boolean was expected. Now correctly passes `true`.

### Changed
- `ultra-full-source.txt` regenerated (18,490 lines).

---

## [v3.11.0] — 2026-03-14 — Three-Fix Instrumentation Completion

### Fixed — Issue 1: taskId propagation
- Added `taskId?: string` field to `UltraExecutionResult` interface (src/types/ultra.ts).
- All 14 return statements in `AgentCore.execute()` now include `taskId` in the returned object.
- `sendComplete()` in app/index.tsx now uses `result.taskId` instead of placeholder string.

### Fixed — Issue 2: pickerOpen slideAnim value
- Moved `UltraDevLog.pickerOpen()` call from ChatScreen (where slideAnim was inaccessible, always 0) into `ModelPickerSheet.useEffect([visible])` where `slideAnim._value` is directly readable.
- Removed duplicate `pickerOpen` call from ChatScreen; `modalEvent` and `snapUI` remain.

### Fixed — Issue 3: AgentCore cleanup on unmount
- Init useEffect now captures `coreRef` locally and returns cleanup that calls `coreRef.destroy('component_unmount')`.
- Ensures `coreDestroyed` sensor fires on component teardown.

### Changed
- `ultra-full-source.txt` regenerated (18,476 lines).

---

## [v3.10.0] — 2026-03-14 — UltraDevLog v2 Sensor Integration

### Added — 6 New Diagnostic Sensors
- **CORE_INSTANCE sensor**: `coreCreated()` in AgentCore constructor stamps a unique `instanceId` on every entry. `coreDestroyed()` logs teardown with reason. `taskCoreStamp()` at execute() start correlates tasks to core instances. Detects mid-task re-initialization.
- **EXECUTOR_BRANCH sensor**: `executorEnter/Branch/Exit` added to `app_launch` (rich intent + simple launch paths), `sms_send`, `self_modify` (with per-cycle branch logging), `self_replicate` (compile/build phases). Traces which code path each capability executor took.
- **CONV_CONTEXT_SENT sensor**: `convContextSent()` fires before both `complete()` and `completeWithConversation()` API calls in ModelRouter with full token breakdown (system prompt chars, history message count, history chars, user message chars, estimated total tokens).
- **UI_MESSAGE_RENDERED sensor**: `messageRendered()` fires on FlatList renderItem onLayout with pixel height, scroll offset, viewport height, and tall-warning flag. `listScrolled()` fires on FlatList onScroll (throttled >50px changes).
- **TASK_WATCHDOG sensor**: `watchdogArm(taskId, 'APPROVE', 10000)` and `watchdogArm(taskId, 'EXECUTE', 90000)` guard critical phases. Auto-fires TASK_WATCHDOG alert if phase exceeds timeout without disarm. `watchdogDisarmAll` in catch blocks.
- **APP_STATE_CHANGE sensor**: `installAppStateListener()` in root component useEffect captures every foreground/background transition with timing and active watchdog count.

### Added — Legacy DebugLog Compatibility Layer
- Added 54 missing method stubs to UltraDevLog (uiInit, uiState, uiError, uiConvSwitch, uiDefaultsLoaded, uiModelApply, uiModeSwitch, uiPickerOpen, uiPickerSelect, uiPlusMenuSelect, uiSendMessage, uiStopRequest, uiFocusEffect, agentExecuteStart, agentInitStart/Complete/Subsystem, buildStart/Phase/Complete, modelAbort/ApiError/ApiRequest/ApiResponse, modelDiscoveryStart/Result/Error, modelImageRequest/Response/Error, modelSetDefault/Error, modelState, conversationError/List/Loaded/Message/Saved, costLimitCheck, settingsApiSave/Delete, settingsCostLimitSave, settingsDefaultPick/Save, settingsState, permissionCheck, vaultGet/Set/Delete/Error, cleanOldLogs, exportAll, flushToFile, getDir, getFilePath, getMemoryEntriesFormatted). All route through UltraDevLog.push() for unified JSONL output.

### Added — Genome Instrumentation
- `GenomeCompiler.compile()` now logs ENTER/EXIT with source count, asset count, dependency count.
- `SelfImprover.improveCycle()` now logs ENTER with genome generation and user goal, proposals_generated with count, and EXIT with fitness score, improvement delta, and rollback status.

### Changed
- `AgentCore` now has `instanceId` field, `getInstanceId()` accessor, and `destroy(reason)` method.
- `ultra-full-source.txt` regenerated (17,893 lines) with complete file inventory including all src/, components/, app/, and server/ files.

---

## [v3.9.0] — 2026-03-14 — 6-Bug Fix Pass (Log-Driven Diagnostics)

### Fixed — Abort error message (Bug 1)
- ModelRouter `complete()` and `completeWithConversation()` now distinguish user-initiated abort (Stop button) from timeout. User abort shows "Request stopped by user." instead of "Request timed out after 60s."
- Detection: `abortCurrentRequest()` sets `activeController = null` before the AbortError catch fires.

### Fixed — Second app launch silent fail (Bug 2 — idempotency + re-init)
- **Idempotency bypass for repeatable capabilities:** `app_launch`, `camera_capture`, `media_access`, `device_location`, `contacts_read` are now exempt from the duplicate-prevention check in ExecutionLedger. These are valid repeat actions.
- **Re-init guard:** Added `agentCoreInitialized` ref to `app/index.tsx` — prevents full AgentCore re-initialization on every AppState foreground return. Init runs exactly once.

### Fixed — Model picker animation (Bug 3)
- `ModelPickerSheet.tsx`: On open, `slideAnim.setValue(SHEET_MAX_HEIGHT)` and `fadeAnim.setValue(0)` are called synchronously before animation starts. This ensures the sheet always starts from the correct off-screen position, even after a prior close cycle left slideAnim at SHEET_MAX_HEIGHT.

### Fixed — Duplicate focus effects / 4x model discovery (Bug 4)
- `useFocusEffect` in `app/index.tsx` now debounces with a 2-second `lastFocusTime` ref guard — prevents rapid-fire duplicate triggers on screen focus.
- `ModelRouter.refreshApiKey()` now skips `discoverModels()` after the first successful discovery (`hasDiscoveredModels` flag). Discovery runs once on init, not on every focus/return.

### Fixed — Missing command verbs (Bug 5 — CommandParser)
- **Email:** `email john@example.com hello` now routes to `app_launch` with `SENDTO` intent. Supports `about`, `saying`, and bare-text patterns. Also added `e-mail` alias.
- **Calendar/Schedule:** `schedule a dentist appointment` routes to `app_launch` with `INSERT` intent on calendar content URI. Supports `add event`, `create event`, `add to calendar` patterns.
- **Mode detection updated:** `detectMode()` and `ultraCommand` regex now include `play`, `schedule`, `email`, `mail`, `dial`, `navigate`, `directions`, `timer`, `map` as imperative verbs.

### Fixed — Contacts permission (Bug 6)
- `contacts_read` capability now calls `Contacts.requestPermissionsAsync()` before reading.
- `sms_send` capability now requests contacts permission before contact name resolution.

### Fixed — Weather app AI hallucination
- Added `weather`, `google weather`, `accuweather`, `weather channel` to AppDirectory static map.
- AI fallback prompt now explicitly blocks `com.android.weather` (doesn't exist) and suggests valid alternatives.

---

## [v3.8.0] — 2026-03-14 — UltraDevLog Integration & Full Instrumentation

### Added — UltraDevLog replaces DebugLog as the unified diagnostic system
- **`src/utils/UltraDevLog.ts`** — Complete superset of DebugLog with 70+ methods covering every subsystem. All existing DebugLog methods preserved with identical signatures. New diagnostic categories: APP_LAUNCH_*, SMS_*, PICKER_*, UI_PROCESSING, UI_SEND_ATTEMPT, UI_SEND_COMPLETE, UI_MODAL, UI_RENDER_MSG, VAULT_READ/WRITE, PARSE_INPUT/PARSE_COMPOUND, SESSION_SUMMARY.
- **`generateBugReport()`** — Structured diagnostic report with failures, last task chain, isProcessing transitions, app launch trace, picker trace, SMS trace, errors, and compound command warnings. One-tap copy from Settings.
- **`getFormattedLog()`** — Human-readable formatted log optimized for pasting to Replit.
- **`flushSync()`** — setImmediate-based flush before IntentLauncher suspends JS thread.
- **Bug Report button** (orange) in Settings > Logs — copies structured bug report to clipboard.
- **Full Log button** (green) in Settings > Logs — copies formatted log to clipboard.

### Changed — All 10 files migrated from DebugLog to UltraDevLog
- Import alias pattern: `import { UltraDevLog as DebugLog } from '@/src/utils/UltraDevLog'` — zero call-site changes required for existing DebugLog.* calls.
- Files migrated: AgentCore, ModelRouter, SafetyChecker, BuildSystem, SecureVault, CostTracker, ConversationManager, TaskExecutor, app/index.tsx, app/settings.tsx, ModelPickerSheet.tsx.

### Instrumented — TaskExecutor app_launch PATH B
- `appLaunchBegin` → `appLaunchDeviceQuery` → `appLaunchMatch` → `appLaunchAiFallback` → `appLaunchFire` → result pre-computed before IntentLauncher.openApplication() fires (fixes JS suspend bug).

### Instrumented — TaskExecutor sms_send
- `smsResolve` → `smsFire` → `smsResult` with contact search count, phone validation, and masked number logging.

### Instrumented — app/index.tsx
- `sendAttempt` / `sendComplete` / `processingState(true/false)` on handleSend with try/finally for reliable cleanup.
- `processingState` transitions on handleApprove, handleDeny.
- `modalEvent` open/close tracking on modelPicker, convList, plusMenu, promptViewer.
- `pickerOpen` / `pickerClose` / `pickerSelect` on model picker interactions.

### Instrumented — ModelPickerSheet.tsx
- `pickerAnimate` logging on open/close animation with current slideAnim value and animation type.
- Error callback on open animation not finishing.

### Technical
- `ultra-full-source.txt` regenerated (12,018 lines)

---

## [v3.7.0] — 2026-03-13 — State Snapshot Logging System

### Changed — Fundamental shift from event-only logging to state-enriched logging
- **Memory buffer tripled** — 5,000 → 15,000 entries in memory. Display limit raised to 5,000 formatted entries. Scroll area increased to 800px.
- **New `UI_STATE` snapshots** — Every critical action in index.tsx now captures full React state: currentMode, activeModelId, isProcessing, conversationId, messageCount, savedDefaults, modelsLoaded count, hasApiKey, status, buildPhase, genomePhase, pendingReplay, pickerVisible, plusMenuVisible, convListVisible. Snapshots at: init_complete, focus_effect, before_send, model_select, conv_switch, plus_menu_select, picker_open, stop_request.
- **New `SETTINGS_STATE` snapshots** — Settings page captures: tab, defaults map, apiCount, availableModelsCount, defaultsExpanded, editingApi, isNewApi, dailyLimit, taskLimit. Snapshots at: loaded (mount), defaults_expanded (section opened with model count), default_pick (each model selection with full defaults map), defaults_saved (save action with all context).
- **New `MODEL_STATE` snapshots** — ModelRouter captures: discoveredCount, defaultModel, hasApiKey, baseUrl, first 20 modelIds. Snapshots at: post_discovery (after successful model fetch), discovery_failed (on error with partial state), post_init (after AgentCore initializes ModelRouter).
- **Generic `snapshot()` method** — For ad-hoc state captures from any subsystem.
- **Formatters added** — STATE, UI_STATE, SETTINGS_STATE, MODEL_STATE all have human-readable formatters with 500-char JSON truncation.

### Fixed
- **Models not appearing in default mode picker** — Settings now uses useEffect + local state to load models when section expands.

---

## [v3.6.1] — 2026-03-13 — Debug Log Display Expansion

### Fixed
- **Debug log display limit increased** — Changed from 500 entries to 2000 entries displayed when tapping Refresh in Settings > Logs > Debug Log. Full buffer remains 5000 entries in memory with JSONL file export via "Download" button for complete history.
- **Log scroll area increased** — Debug log ScrollView `maxHeight` increased from 400px to 600px for better visibility on all screen sizes.

### Changed
- `ultra-full-source.txt` regenerated (15,724 lines)

---

## [v3.6.0] — 2026-03-13 — All-Encompassing Debug Logging System

### Added — Production-grade DebugLog with 40+ categories instrumented across every subsystem
- **DebugLog.ts fully rewritten** — 5000-entry memory buffer, auto-flush to JSONL files, human-readable formatter for every category
- **SecureVault instrumented** — Every `get()`, `set()`, `delete()` logs key, value length, source (cache vs store), and errors
- **ModelRouter instrumented** — Model discovery start/result/error, API request/response/error with timing and token counts, model default changes with source tracking, abort events, image generation lifecycle
- **AgentCore instrumented** — Init with per-subsystem timing, execute start with task/conv/replay context, all 9 agent loop steps now auto-log via `step()` wrapper
- **ConversationManager instrumented** — Create, load, save, delete, addMessage, listConversations all logged with conversation ID and message counts
- **CostTracker instrumented** — Record with model/cost/task, limit checks (daily/task) with spent/allowed, cleanup events
- **BuildSystem instrumented** — Build start/phase/complete with timing, progress callbacks wrapped to log each phase
- **SafetyChecker instrumented** — Permission checks logged for every capability evaluation
- **UI (index.tsx) fully instrumented** — Init lifecycle (vault → agentCore → defaults → model → conversation), useFocusEffect triggers, mode switches via PlusMenu with saved default application, model picker open/select/close, send message with mode/model/processing state, stop button, conversation switching
- **Settings (settings.tsx) instrumented** — API save/delete, defaults save with full defaults map, cost limit saves, individual default model picks by role

### Changed
- `ultra-full-source.txt` regenerated (15,723 lines)

---

## [v3.5.2] — 2026-03-13 — Defaults Sync for ALL Modes

### Fixed
- **Plus menu reads defaults directly from vault** — When tapping "+" and selecting any mode (Image, Code, Reasoning, Video), the handler now reads saved defaults directly from SecureVault as a fallback if the React state hasn't loaded yet. This fixes the issue where only Chat mode defaults were being applied while other modes fell through to the model picker.
- **Removed model existence check on apply** — Previously, applying a saved default required the model to be found in `getAvailableModels()`. If the model list wasn't loaded yet (race condition), the default would be silently skipped. Now defaults are applied directly.
- **Status bar shows mode + model** — When a saved default is applied via Plus menu, the status text now shows e.g. "code: grok-3-code" to confirm the switch visually.

### Changed
- `ultra-full-source.txt` regenerated (15,246 lines).

---

## [v3.5.1] — 2026-03-13 — Defaults Sync Fix + Collapsible Settings

### Fixed
- **Defaults sync to AI pill (root cause fix)** — `useFocusEffect` now looks up the current mode's saved default and calls `setDefaultModel()` + `setActiveModelId()` when returning from Settings. Previously it only read the engine's last-used model, ignoring saved per-mode defaults. Added `currentMode` as a dependency so mode switches also trigger the correct default lookup.

### Added
- **Collapsible "Default Models by Mode"** — The settings card is now collapsed by default with a "Tap to configure" hint and chevron toggle. Reduces visual clutter in the API Setup tab.

### Changed
- `ultra-full-source.txt` regenerated (15,241 lines).

---

## [v3.5] — 2026-03-13 — UX Polish + Quick Actions + Model Defaults Overhaul

### Fixed
- **Save Defaults visual confirmation** — Button now shows green "Saved!" with checkmark icon for 2 seconds instead of unreliable Alert dialog.
- **Debug log auto-loading** — Both Application Logs and Debug Log now auto-load when switching to the Logs tab (no more "Tap refresh to load").
- **Long-press message behavior** — Removed expand/shrink animation from long-press. Messages now have an inline copy icon button. Text is also `selectable` for partial copy.
- **Stop button styling** — Removed red background (`#ef4444`), now uses neutral dark (`#333`) matching the UI.
- **Default model picker shows ALL models** — No longer filters to only "matching" models per mode. All available models are shown, with recommended ones sorted first and marked with a star icon. Users own their API and choose freely.
- **AI pill reflects saved defaults** — Selecting a mode from Plus menu now auto-applies the saved default model for that mode (if set), without requiring the model picker.
- **Green accent toned down** — All bright greens (`#4ade80`, `#00ff88`) replaced with softer `#34d399` across all components.

### Added
- **Quick Action commands** — Side drawer now has a "Quick Actions" section with 6 command buttons: System Status (`/status`), Show Capabilities (`/capabilities`), Usage & Costs (`/cost`), List Models (`/models`), Help (`/help`), Clear Context (`/clear`).
- Inline copy button on every message bubble (replaces long-press-to-copy).
- `savedFeedback` state in Settings for visual save confirmation.
- `onQuickCommand` prop on ConversationList.
- `savedDefaults` loaded in chat screen via SecureVault on focus.

### Changed
- `ultra-full-source.txt` regenerated (15,185 lines).

---

## [v3.4] — 2026-03-13 — Bug Fixes + Stop Button + Model Defaults

### Fixed
- **Input editable during AI response** — Text input is no longer disabled while the agent is processing. Users can type their next message while waiting; send button still gated.
- **Model picker tabs empty** — Venice models (all typed as "text") are now auto-classified into Code and Reasoning tabs based on model ID patterns and capabilities (e.g., `deepseek-r1` → Reasoning, `codestral` → Code).
- **Star conversation** — Fully implemented: persists starred state via `ConversationManager.updateMeta()`, shows filled star icon in 3-dot menu and conversation list, supports toggle (Star/Unstar). Starred state resets on new chat and delete→create.
- **Model picker syncs category from Plus menu** — Selecting a mode (Image, Code, Reasoning, Video) in the Plus menu now opens the model picker pre-filtered to that tab via `initialFilter` prop.
- **Save Defaults button** — Added `keyboardShouldPersistTaps="handled"` to ScrollViews in Settings to ensure all buttons register taps reliably.
- **API settings persistence** — Primary API key and base URL are always synced to `venice_api_key`/`api_base_url` vault keys on every save (including clears), ensuring ModelRouter picks them up on relaunch.
- **Cost display clarification** — Added "Estimated costs — may be included in your API plan" note below the usage pill.
- **Delete from 3-dot menu on web** — Now uses `window.confirm` on web platform instead of `Alert.alert` which is unreliable on web.
- **Can't send while processing** — `onSubmitEditing` now checks `isProcessing` flag before calling handleSend.

### Added
- **Stop button** — Red square stop button replaces send button during AI processing. Aborts the active API request via `ModelRouter.abortCurrentRequest()` and shows "Stopped" status.
- **Default Models by Mode** — Settings "Default APIs by Mode" replaced with "Default Models by Mode" — now shows actual AI models filtered by relevance to each mode (Chat/Image/Code/Reasoning/Video) instead of just API names.
- `ModelRouter.abortCurrentRequest()` — Aborts the active fetch request using the shared AbortController.
- `AgentCore.abortCurrentRequest()` — Exposed abort method for UI stop button.
- `ConversationManager.updateMeta()` — Generic metadata setter for conversations.
- `Conversation.meta` field and `ConversationMeta.starred` flag in types.
- `ModelPickerSheet.initialFilter` prop.

### Changed
- `ultra-full-source.txt` regenerated (15,090 lines).

---

## [v3.3] — 2026-03-13 — Debug Log System

### Added
- **DebugLog** (`src/utils/DebugLog.ts`) — Comprehensive file-based debug log for development. Captures full user prompts, AI responses (with model, cost, tokens), all 9 agent loop phases with timing, API call durations, safety checks, execution results, verification outcomes, cost records, model discovery events, and errors with stack traces. Writes JSONL to device filesystem (`debug_logs/` directory), auto-flushes every 3 seconds, and supports 7-day auto-cleanup.
- **Debug Log UI** (settings.tsx Logs tab) — New "Debug Log" section below Application Logs with refresh, copy, and export buttons. Human-readable formatted view for quick scanning; export button copies full JSONL for machine parsing by AI assistants or dev tools.
- **Instrumented AgentCore** — Every step of the 9-step agent loop (INTAKE, ROUTE, PLAN, VERIFY, APPROVE, EXECUTE, VERIFY_RESULT, WRITE_MEMORY, ADAPT) now emits debug log entries with full context.
- **Instrumented ModelRouter** — API calls log model, prompt/completion tokens, cost, and duration in milliseconds. Model discovery and initialization events logged.
- **Instrumented CostTracker** — Every cost record emits a debug entry with model, cost, and task ID.

---

## [v3.2] — 2026-03-13 — New UI Components & Multi-API Settings

### Added
- **ActionMenu** (`components/ActionMenu.tsx`) — Contextual 3-dot dropdown menu with icon support, destructive items, and disabled state. Used for conversation actions (rename, delete, star, new chat).
- **ModelPickerSheet** (`components/ModelPickerSheet.tsx`) — Bottom sheet for browsing and selecting AI models with type filter tabs (All/Chat/Image/Code/Reasoning/Video), cost indicators, and radio selection.
- **PlusMenu** (`components/PlusMenu.tsx`) — Mode selector bottom sheet for switching between Chat, Image, Code, Reasoning, and Video action types.
- **QuickReplies** (`components/QuickReplies.tsx`) — Context-aware quick-reply chips that appear below assistant messages. Dynamically generates suggestions based on capability type, error state, code presence, and message length.
- **UsageIndicator** (`components/UsageIndicator.tsx`) — Cost usage pill with expandable detail sheet showing per-model breakdown, daily limit progress bar, and call counts.
- **Multi-API management** (settings.tsx) — Full CRUD for saved API endpoints with name, base URL, API key, and auth token. Includes per-mode default API assignment (Chat/Image/Code/Reasoning/Video) and backwards-compatible migration from legacy single Venice key.
- **Settings tabs** — Settings screen reorganized into three tabs: API Setup, Cost Limits, and Logs.
- **ConversationList folders** — UI-ready folder system with system "Logs" folder and user-created folders (persistence TODO).
- **Rename modal for Android** — Custom TextInput modal replaces iOS-only `Alert.prompt` for renaming conversations on Android.

### Fixed
- **`Alert.prompt` Android crash** — `Alert.prompt()` is iOS-only and would crash on Android. Replaced with a custom modal dialog with TextInput for native platforms.
- **`callsByModel` undefined** — Settings referenced `CostSummary.callsByModel` which doesn't exist. Fixed to proportionally distribute `totalCalls` across models based on cost share.

### Changed
- **index.tsx** — Integrated ActionMenu, ModelPickerSheet, PlusMenu, QuickReplies. Added model indicator pill, processing activity icons, and long-press copy on messages.
- **ConversationList** — Added `onOpenSettings` and `onOpenLogs` props, settings gear moved into drawer, folder section added.
- **ultra-full-source.txt** regenerated (14,615 lines).

---

## [v3.1] — 2026-03-12 — Bug Fixes & Audit Response

### Fixed
- **TaskEvaluator race condition** — `AbortController` wired through `runChallenge()`. Timeout now calls `abort()` and every loop iteration checks `signal.aborted`, preventing background resource leaks after `Promise.race` resolves.
- **GenomeCompiler silent failure** — Unresolved genome source files no longer silently pass through as raw `FIXED:*` strings to the Java compiler. Now throws a clear, actionable error naming the missing file and instructing the user to run `self_replicate` first.
- **Image base64 data URI strip** — `result.images[0].replace(/^data:image\/\w+;base64,/, '')` applied defensively before `writeAsStringAsync` so image writes work whether Venice returns raw base64 or a data-URI-prefixed string.
- **Metro blockList anchored** — `/scripts\/.*/` was too broad, blocking `node_modules/react-native-reanimated/scripts/validate-worklets-version` during web bundling. Fixed by anchoring to `path.join(__dirname, 'scripts')` so only the project-root `scripts/` directory is excluded. Resolved blank-screen bundler failure.

### Investigated (Forensic Audit — 13 findings)
- **8 confirmed false**: R.java generation (BinaryManifestWriter uses TYPE_STRING not TYPE_REFERENCE), GenomeCompiler pop() claim, accessibility bypass, conversation duplication, genome mutation safety bypass, cost math direction, base64 truncation, race condition description.
- **3 real and fixed**: TaskEvaluator timeout (fixed above), GenomeCompiler silent pass-through (fixed above), image data URI prefix (fixed above).
- **1 already fixed**: Cost tracker /1000 double-division (fixed in v3.0).
- **1 intentional**: Biometric gate always passes on web (no biometric hardware in dev/web environment).

---

## [v3.0] — 2026-03-12 — Ultra Overhaul

### Core Engine
- **ModelRouter full overhaul**: `baseUrl` property, `setBaseUrl()`/`getBaseUrl()`, `getModelsByType(type)` filter, `complete()` timeout parameter (default 60,000 ms). `discoverModels()` stores Venice `pricing.input.usd` directly as `costPer1kInput` (no /1000 division). Type validation whitelist (`text`, `code`, `image`, `embedding`) with safe fallback to `'text'` for unknown types.
- **AgentCore**: `setApiBaseUrl()` delegates to `ModelRouter.setBaseUrl()`. `getModelRouter()` getter exposed for settings screen.
- **TaskExecutor**: `app_launch` device-aware (native uses `android-app://` intent URI; web opens tab). SMS `action: 'send'` uses `Linking.openURL('smsto:...')`. `image_generate` with 60 s AbortController timeout (180 s for self_replicate). `self_replicate` extended to 180 s.
- **CapabilityRegistry / CapabilitySchemas**: `image_generate` capability added with full JSON schema.
- **CommandParser**: `run`/`start` recognised as `app_launch` verbs. `generate image`, `create image`, `draw` patterns added for `image_generate`.
- **SafetyChecker**: Scope keyword map updated for all new capabilities.
- **CostTracker**: Defaults now `enabled: false`, `monthlyLimitUsd: 0`, `dailyLimitUsd: 0`.

### Native Module
- **getInstalledApps**: Java implementation via `QUERY_ALL_PACKAGES` permission. Both catch blocks now emit `logger.warn` (previously silent).

### UI
- **ConversationList redesign**: Left-side animated spring drawer (width 280, translucent backdrop).
- **index.tsx**: Optimistic message rendering (instant bubble before network round-trip, deduplication on reload). Conversation rename via long-press on header title.
- **settings.tsx**: Model dropdown with type badge per model, editable API base URL field, cost limits defaulting to 0.

### Bug Fixes (within v3.0 session)
- **Cost calculation**: Removed `/1000` double-division in `discoverModels()` — Venice returns per-1K price directly.
- **Type assertion crash**: Runtime type validation whitelist prevents unknown model types crashing the app.
- **AbortController leak**: `generateImage` uses `finally { clearTimeout(timeout) }` so the timer always clears.
- **Optimistic message dedup**: `reloadMessages` fully replaces state from storage, overwriting optimistic bubbles.
- **Optimistic ID collision**: IDs now use `Date.now() + random string` instead of `Date.now()` alone.
- **Path separator**: Image file path ensures trailing `/` on `docDir` before appending filename.
- **Silent `getInstalledApps` failures**: Both catch blocks now log via `logger.warn`.

---

## [v1.4] — 2026-03-11 — Execution Trace & Debug Logging

- **PromptTrace enriched**: Added `ExecutionStep`, `TraceSafetyCheck`, `TraceVerification`, `TraceLedgerEvent` types and 12 new optional fields to `src/types/ultra.ts`.
- **AgentCore instrumented**: `execute()` tracks all 9 loop phases with timestamp, detail, and pass/fail. Captures stack traces. Builds rich `PromptTrace`.
- **PromptViewer upgraded**: Shows execution timeline, action plan, raw result, safety check, verification, permissions, error/stack. Per-trace "Download" button exports trace as text via `Sharing.shareAsync`.
- **Download button**: Settings "Share Logs" replaced with "Download" — exports full conversation history with prompt traces, ledger events, and Logger entries.

---

## [v1.3] — 2026-03-11 — Device Capability Fixes

- **compileSdkVersion 36**: `androidx.core:core-ktx:1.17.0` requires compileSdk 36; updated `app.json`.
- **API key gating fix**: Venice API key now only required for AI fallback and conversation mode — not for deterministic commands (SMS, camera, location, file ops, etc.).
- **Camera capture**: Replaced stub with real `ImagePicker.launchCameraAsync()`.
- **Gallery picker**: `media_access` supports `action: 'pick'` via `ImagePicker.launchImageLibraryAsync()`.
- **App share**: `Sharing.shareAsync()` for file URIs, `Share.share()` for text content.
- **Device location**: New `device_location` capability via `expo-location` (native GPS) with web geolocation fallback.
- **SMS contact resolution**: Resolves contact names to phone numbers via `expo-contacts`.
- **CommandParser expanded**: `pick/choose/select photo`, `share [content]`, `where am i`, `get my location`, `gps`, `take selfie/picture`.
- **SafetyChecker**: Comprehensive scope keywords for `device_location`, `camera_capture`, `media_access`.
- **detectMode**: Added `share`, `pick`, `choose`, `select`, `where`, `get` verbs; `gps` and `my location` special cases.

---

## [v1.2] — 2026-03-11 — Build & Offspring Improvements

- **Build progress persisted**: `app_build`, `self_modify`, `self_replicate` events saved as a "BUILD LOG" message in the conversation.
- **Build log UI**: Distinct amber/console style — dark background, monospace font, console icon, "BUILD LOG" label.
- **Rich build summaries**: `summarizeResult()` produces capability-specific summaries (app name, APK path, fitness score, generation, parent ID).
- **Genome persistence on web**: Genome state persists to `localStorage` on web (previously native file system only).
- **ChatMessage type extended**: `isBuildLog` and `data` fields added to `meta`.

---

## [v1.1] — 2026-03-11 — QA Bug Fixes

- **"hello ultra" misrouting**: Removed broad `includes('ultra')` check. "Ultra" as prefix only triggers command mode when followed by an imperative verb.
- **Raw JSON responses**: `summarizeResult()` AI summarization step added in AgentCore Step 7.
- **Scrollable/downloadable logs**: Settings log viewer uses nested ScrollView (max height 400 px). "Share Logs" button added.
- **Prompt trace duplication**: Fixed `buildPromptTrace()` to filter system prompt and framed user message from `includedMessages`.
- **Biometric re-auth on resume**: AppState listener in `_layout.tsx` triggers re-auth on background→active transition.
- **Conversation persistence**: Atomic writes (tmp→rename) in `ConversationManager`. Per-file try/catch in `listConversations()`.
- **Copy message on long press**: `onLongPress` on message bubbles uses `expo-clipboard`. Shows "Copied" label and green border flash.
- **Command routing**: `create an app`, `make an app` patterns added. `app_build` patterns ordered before generic `write/save` file pattern.
- **Empty state text fix**: `scaleY: -1` transform separated for web vs native on inverted FlatList.

---

## [v1.0] — 2026-03-08 to 2026-03-10 — Initial Build

- **Project scaffolded**: Expo + Express stack, expo-router, TypeScript, dark theme.
- **Venice API integration**: `ModelRouter` with `llama-3.3-70b` default, API key storage via `expo-secure-store`.
- **9-step agent loop**: INGEST → ROUTE → PLAN → VERIFY → APPROVE → EXECUTE → VERIFY_RESULT → WRITE_MEMORY → ADAPT.
- **22 capabilities**: File ops, camera, SMS, contacts, location, app build, self-modify, self-replicate, and more via `CapabilityRegistry` and `TaskExecutor`.
- **On-device APK build pipeline**: `AppArchitect` (NLP → AppSpec) → `BuildOrchestrator` → ECJ Java compiler → D8/R8 DEX → `ApkPackager` → `ApkSignerV1` (RSA-2048, V1 JAR signing) → install.
- **Von Neumann Genome system**: `GenomeFactory`, `GenomeCompiler`, `GenomeMutator`, `SelfImprover`. Lineage tracking, AI-driven mutations, fitness evaluation via `TaskEvaluator` and accessibility service.
- **Multi-agent swarm**: `Orchestrator` + `TaskAgent` instances communicating over `AgentBus`.
- **Safety & security**: `SafetyChecker` (risk scoring, scope validation), `PermissionBroker`, `SecureVault`, `BiometricGate`.
- **Persistence**: `ConversationManager` (chat history), `ExecutionLedger` (idempotency, autonomy budgets), `CostTracker` (API spend).
- **Native module plugin**: `plugins/withAgentNative.js` Expo config plugin — injects Java classes for compilation, packaging, signing, installation, and `AppController` accessibility service.
- **New Architecture**: `newArchEnabled: true` (required for react-native-reanimated v4).
- **`ultra-full-source.txt`**: 55-file full-source snapshot regenerated after every session.

## v3.7.1 – Defaults sync fix (Focus effect)
**2026-03-13**

Fixed stale-closure bug in `useFocusEffect` where updating mode defaults in Settings would not immediately sync to `activeModelId` on the chat screen.

**Changes:**
- Focus effect now reads updated defaults from vault AND applies the current mode's default to `activeModelId` if it has changed
- Added `uiModelApply` log when sync occurs: `focusEffect_default_sync` source
- Fixed dependency array to include `currentMode` and `activeModelId` (was previously only `[agentCore]`)

**Before:** Save new chat default to llama-3.3-70b → return to chat → activeModelId still "venice-uncensored" (stale) → eventually updates on next render
**After:** Save new defaults → return to chat → activeModelId immediately updates to llama-3.3-70b in focus effect

**Log pattern:**
- `UI_DEFAULTS_LOADED` from focusEffect reads new defaults from vault
- If `parsed[currentMode]` differs from `activeModelId`, immediately call `setActiveModelId(parsed[currentMode])`
- Log source: `focusEffect_default_sync`

This fix was exposed by the v3.7.0 state snapshot logging — the snapshot showed `activeModelId` stale while `savedDefaults` had new values, making the desync visible in logs.

## v3.8.0 – Rich Android Intents & AppDirectory (App Launch v2)
**2026-03-13**

### New Files
- `src/core/AppDirectory.ts` — Static ~150-app directory + fuzzy scoring matcher (no AI credits)
- `src/core/IntentResolver.ts` — Natural language → Android intent resolver (play/call/navigate/email/alarm/timer/search)

### Modified Files
- **CapabilitySchemas.ts** — app_launch v1→v2: added `action`, `data`, `extras`, `packageName`, `mimeType` optionalParams
- **CommandParser.ts** — 16 new rich intent patterns (music, calls, navigation, web, alarms, timers, email)
- **SafetyChecker.ts** — app_launch scope expanded with play/call/dial/navigate/search/alarm/timer/email
- **TaskExecutor.ts** — Complete rewrite of app_launch:
  - PATH A: Rich intents via `startActivityAsync` (plays music, dials numbers, navigates, etc.)
  - PATH B: Simple app launch via `openApplication` (with static dir + fuzzy matching + AI fallback)
  - Contact resolution for "call Mom" → resolves contact name to phone number via expo-contacts
  - Removed duplicate app_launch in exec()

### What This Enables

| User Says | Action | Result |
|---|---|---|
| "play Bad to the Bone on Spotify" | MEDIA_PLAY_FROM_SEARCH + query | Spotify opens and plays song |
| "play music by Adele" | MEDIA_PLAY_FROM_SEARCH + artist | Spotify plays Adele |
| "call 555-1234" | DIAL intent + tel: URI | Phone dials |
| "call Mom" | DIAL intent + contact resolution | Resolves Mom's number, then dials |
| "navigate to Times Square" | VIEW intent + google.navigation: URI | Google Maps opens navigation |
| "search for coffee shops" | WEB_SEARCH intent | Browser opens search |
| "set alarm for 7 am" | SET_ALARM intent + extras | Clock app sets alarm |
| "set timer for 5 minutes" | SET_TIMER intent + length=300 | Timer starts |
| "email john@x.com about meeting" | SENDTO intent + subject | Email compose with recipient and subject |
| "open spotify" | openApplication (static dir) | Instant lookup, no AI credits |
| "pandora" | openApplication (fuzzy match) | Scoring finds "Pandora - Music & Podcasts" |

### Architecture

**AppDirectory** (`lookupPackage` + `findBestMatch`):
- Instant lookup: 150+ app names → package names (chat, spotify, maps, etc.)
- Fuzzy scorer: Handles partial matches (youtube music vs youtube), capitalization, word overlap
- Threshold: 35 points (exact=100, starts_with=80, contains=60, word_overlap=30)

**IntentResolver** (`resolveIntent` + `looksLikeRichIntent`):
- 15 pattern sets: music (play X, play by artist, play album), calls (call number, call contact, dial), navigation (navigate to, map of), search, alarms, timers, email, URLs
- Returns: `ResolvedIntent` with action, data URI, extras, packageName
- Returns null for ambiguous commands → falls back to simple app launch

**CommandParser** (16 new rules):
- Rules execute BEFORE simple open/launch/run patterns
- Each rule extracts target, action, data, extras, packageName
- Validation: All plans validated against v2 schema

**TaskExecutor** (Path A + B):
- **Rich intent path**: params.action is set → `startActivityAsync(action, {data, packageName, extra, type})`
- **Simple app launch path**: params.action not set → static dir → fuzzy match → AI fallback → `openApplication(pkg)`

### Backward Compatibility

- All existing simple app launches still work ("open spotify", "launch chrome")
- v1 schema still accepted (action/data/extras optional)
- No breaking changes to other capabilities

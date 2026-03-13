# Agent Ultra — Changelog

All notable changes to this project are documented here, organized by feature version. Dates reflect when work was completed.

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

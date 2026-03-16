# Agent Ultra

## Overview
Agent Ultra is an autonomous AI agent application for Android focused on on-device APK compilation with self-replicating capabilities and a self-healing debug engine. The project's vision is to create an AI that can design, build, test, and continuously improve Android applications, including itself, directly on mobile devices. This includes features like multi-agent swarm orchestration, a self-evolving genome system, and real-world task-based fitness evaluation for generated applications, aiming to revolutionize mobile app development through AI-driven innovation.

## User Preferences
- **CRITICAL: Do NOT make any code changes, file edits, package installs, workflow restarts, or any other actions unless the user EXPLICITLY says to do so. "Make a plan" means produce a document only — never implement. When in doubt, ask first.**
- The agent should prioritize the use of the Venice API.
- The agent should only make changes to the codebase when explicitly instructed or when it's part of its self-improvement cycle.
- The agent should ask for user approval for dangerous actions.
- The agent should provide real-time build progress updates in the chat UI.
- The agent should allow users to configure the AI model used and API key via in-app settings.
- The agent should persist conversations and allow switching between them.
- **Key reports for sharing with Claude:** CHANGELOG.md, gitlog.md, replit.md, ultra-full-source.txt

## System Architecture
**Frontend:** Built with Expo (React Native) and `expo-router` for file-based routing with a dark theme. UI is programmatic, avoiding XML layouts. Biometric gate removed from hardcoded startup (v3.14.0) -- `BiometricGate.ts` retained for future opt-in biometric+PIN feature in Settings. FlatList uses `extraData` to ensure re-renders on `isProcessing`/`pendingReplay`/`copiedId`/`expandedMsgs` state changes (v3.16.0). Model picker pill has `hitSlop` for reliable Android tap handling.

**Backend:** A lightweight Express.js server on port 5000 handles API requests.

**AI Integration:** All AI interactions leverage the Venice API via a `ModelRouter` for context-aware model recommendations.

**On-Device Build System:** A `BuildSystem` manages the entire APK pipeline, from natural language `AppArchitect` to `BuildOrchestrator` handling dependency resolution, code generation, compilation (ECJ), DEX conversion (D8/R8), packaging, V1 JAR signing, and installation.

**Self-Evolution and Genome System:** A `Von Neumann Genome` system, managed by `GenomeFactory`, `GenomeCompiler`, `GenomeMutator`, and `SelfImprover`, enables continuous evolution through AI-driven mutations and fitness evaluation using `TaskChallenges` and `TaskEvaluator` via accessibility services.

**Multi-Agent Orchestration:** An `Orchestrator` manages `TaskAgent` instances, communicating via an `AgentBus`.

**Safety and Security:** Includes `SafetyChecker` for pattern scanning, `PermissionBroker` for device permissions, `SecureVault` for sensitive data, and `BiometricGate` for authentication.

**Core Agent Loop:** A 9-step autonomous loop (INGEST, ROUTE, PLAN, VERIFY, APPROVE, EXECUTE, VERIFY_RESULT, WRITE_MEMORY, ADAPT) governs agent decision-making.

**Capability Management (v3.24.0):** `CapabilityRegistry` defines 49 capabilities (23 original + 26 new) with risk levels, executed by `TaskExecutor`. The 26 new capabilities added in v3.24.0 are:
- flashlight_toggle, alarm_set, timer_set, volume_set, brightness_set
- wifi_toggle, bluetooth_toggle, airplane_mode, do_not_disturb
- battery_status, clipboard_read, clipboard_write
- media_play, media_next, screenshot, screen_record_start
- open_url, web_search, calendar_create, reminder_create, note_create
- file_open, share_content, app_info, notification_read, device_info

Risk levels: safe (flashlight, clipboard_write, media controls, open_url, web_search, note_create, share_content, app_info, device_info, alarm_set, timer_set, battery_status), moderate (volume, brightness, wifi, bluetooth, airplane, DND, screenshot, screen_record, calendar_create, reminder_create), sensitive (clipboard_read, notification_read).

**Total Access Features (v3.23.0):**
- **Settings Intent Resolution:** 37 Android settings entries with deep linking (WiFi, Bluetooth, Display, Sound, Developer Options, Accessibility, etc.)
- **App Deep Links:** 19 built-in deep links for popular apps (Spotify, YouTube, Gmail, Maps, WhatsApp, Instagram, TikTok, Calendar, Clock, Play Store)
- **System Actions:** WiFi toggle, Bluetooth toggle, Airplane Mode, Brightness adjustment (all route to settings panels due to Android 12+ restrictions)
- **System Information:** Battery level/state/low-power-mode, RAM usage, storage capacity, CPU temperature, device model/Android version
- **Preference Backup:** Export/import user settings (API defaults, learned patterns, cost limits) to JSON via DocumentPicker + Sharing
- **Package Learning:** Automatically capture successful app launches for faster future lookups

**Error Handling and Debugging:** An `ErrorBoundary` handles UI errors, and a `DebugEngine` provides AI-driven self-healing for build errors.

**Persistence and Monitoring:** `ConversationManager` for chat storage, `ExecutionLedger` for event logging and idempotency/autonomy budgets, and `CostTracker` for API usage.

**Debug Logging (v3.23.0 — SESSION STATE):** 
- **UltraDevLog** (primary logger) — 60+ sensors covering conversations, agent loop, intents, SMS, UI state, lifecycle events, system info, preferences, and package learning. 3,000-entry in-memory buffer updated every 2 seconds.
- **Three log files on device:**
  1. `ultra-devlog.jsonl` — UltraDevLog auto-flush (fixed filename, grows naturally)
  2. `debug-log.jsonl` — Legacy DebugLog (alias to UltraDevLog)
  3. `raw-export.jsonl` — Manual export snapshot
- **File location:** `agent-ultra-logs/` directory via `LogFolder` service. Old timestamped files cleaned up on startup (v3.20.0).
- **File system import:** MUST use `expo-file-system/legacy` — SDK 54 removed `writeAsStringAsync` from main export.
- **Bug report generation:** `generateBugReport()` produces pre-formatted diagnostic summaries with failures, phase gaps, watchdog fires, core re-initializations.
- **Logs tab:** Settings > Logs displays all files with sizes, refresh, download, and Android share sheet integration.
- **Session summary:** Available via `generateBugReport()` and settings page. Includes phase traces, executor misfires, component lifecycle warnings.

**Idempotency:** ExecutionLedger prevents duplicate actions, but `app_launch`, `camera_capture`, `media_access`, `device_location`, and `contacts_read` are exempt (repeatable capabilities). AgentCore init runs exactly once via module-level `_agentCoreInitialized` guard (not useRef — survives Android component remount). No cleanup/destroy on unmount — core persists across background transitions.

**Model Discovery:** Runs once during ModelRouter.initialize(). Subsequent `refreshApiKey()` calls skip re-discovery. Focus effects are debounced (2s guard).

**Quick Actions:** The side drawer (ConversationList) includes quick command buttons: `/status`, `/capabilities`, `/cost`, `/models`, `/help`, `/clear`. These send the command directly as a message.

**UI Color:** The accent green is `#34d399` (softer mint) used consistently across all components. Messages show inline copy buttons instead of long-press behavior, with selectable text for partial copying.

**Default Models by Mode:** Settings shows ALL available AI models for each mode (chat/image/code/reasoning/video) with recommended models marked with a star icon. No hardcoded presets — users can pick any model. The Plus menu applies saved defaults automatically when switching modes. Model classification uses shared `src/utils/classifyModelType.ts` — name/ID pattern matching for image (flux, fluently, sdxl), video (wan-, luma), code (code, codestral), reasoning (reason, qwq, deepseek-r1). Does NOT use Venice `supportsReasoning` capability flag (too broad — 29/47 models).

**Stop Button:** Neutral dark styling (`#333` background), no red.

**Debug Log Display:** Displays up to 5000 formatted entries (from 3000-entry memory buffer). Tap Refresh to reload. Download button exports full JSONL history with complete structured data. State snapshots (`UI_STATE`, `SETTINGS_STATE`, `MODEL_STATE`) capture full React state at every critical action — not just what happened, but what the entire system looked like at that moment. This enables diagnosing race conditions, async timing issues, and state desynchronization.

**Native Module Integration:** A custom `AgentNativeModule` (Java classes via Expo config plugin) provides direct access to native functions like file writing, Java compilation, APK packaging, signing, and installation. `AppController` uses accessibility services for UI automation and E2E testing of generated apps.

## Core Source Files (v3.24.0)

| File | Lines | Purpose |
|------|-------|---------|
| `src/core/TaskExecutor.ts` | 1347 | 49 capability executors, flashlight toggle, parseTimeString, parseDurationToSeconds, gatherSystemInfo, contact disambiguation |
| `src/core/CommandParser.ts` | 759 | Natural language → capability routing, 26 new pattern groups, verb typo correction, findBestMatch (threshold=35) |
| `src/core/CapabilityRegistry.ts` | 107 | 49 capability registrations with risk levels and permissions |
| `src/core/CapabilitySchemas.ts` | 466 | 49 schema definitions with required/optional params and type validation |
| `src/core/AgentCore.ts` | 1008 | 9-step agent loop, Ultra persona system prompt, detectMode, runWithPlan |
| `src/core/SettingsDirectory.ts` | 194 | 50+ Android settings entries with trigger arrays and intent actions |
| `src/native/AgentNative.ts` | 110 | TypeScript bridge to native module (setFlashlight, getInstalledApps, exec) |
| `plugins/withAgentNative.js` | 1652 | Java source constants (AgentNativeModule, BinaryManifestWriter, ApkPackager, ApkSignerV1, AgentAccessibilityService, AccessibilityBridgeModule), config plugin, 32 manifest permissions |

**Total: 5,635 lines across 8 core files**

## External Dependencies
*   **Venice API:** For all AI functionalities.
*   **Expo (React Native):** Frontend framework.
*   **Express.js:** Backend server.
*   **EAS Build:** For building standalone Android APKs.
*   **Maven Central:** For downloading JAR/AAR dependencies.
*   **ECJ (Eclipse Compiler for Java):** On-device Java compilation.
*   **D8/R8:** Java bytecode to Dalvik bytecode conversion.
*   **`expo-secure-store`:** Secure key-value storage.
*   **`expo-file-system`:** File system operations (must import from `/legacy` in SDK 54+).
*   **`@expo/vector-icons`:** UI icons.
*   **`expo-clipboard`:** Copy-to-clipboard.
*   **`expo-sharing`:** File sharing via Android intents.
*   **`expo-image-picker`:** Camera and gallery access.
*   **`expo-location`:** GPS/device location access.
*   **`expo-battery`:** Battery level and state (v3.23.0).
*   **`expo-document-picker`:** Document/file selection (v3.23.0).
*   **`react-native-device-info`:** Device system information (v3.23.0).
*   **`expo-intent-launcher`:** Native intent launching for settings and deep links (v3.23.0).

## Android Manifest Permissions (32 total)
QUERY_ALL_PACKAGES, CAMERA, FLASHLIGHT, READ_CONTACTS, WRITE_CONTACTS, READ_CALL_LOG, SEND_SMS, READ_SMS, RECEIVE_SMS, READ_CALENDAR, WRITE_CALENDAR, SET_ALARM, VIBRATE, MODIFY_AUDIO_SETTINGS, READ_EXTERNAL_STORAGE, WRITE_EXTERNAL_STORAGE, INTERNET, ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE, CHANGE_WIFI_STATE, ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION, RECORD_AUDIO, FOREGROUND_SERVICE, RECEIVE_BOOT_COMPLETED, USE_BIOMETRIC, USE_FINGERPRINT, CHANGE_NETWORK_STATE, NFC, BLUETOOTH, BLUETOOTH_ADMIN, BLUETOOTH_CONNECT, BLUETOOTH_SCAN

## Known Issues (v3.24.0)
- **None critical.** All 49 capabilities registered, schemed, parsed, and executed across 8 core files.

## Recent Changes (v3.24.0 — Capability Expansion)
- **26 New Capabilities:** Flashlight, alarms, timers, volume, brightness, wifi/bluetooth/airplane/DND toggles, battery status, clipboard, media controls, screenshot, screen record, URL/search, calendar/reminder/note creation, file open, share, app info, notifications, device info.
- **Contacts Fix:** Contacts/people/phonebook now use `startActivityAsync('android.intent.action.VIEW', { data: 'content://com.android.contacts/contacts' })` instead of `openApplication`.
- **Messages Fix:** Messages/SMS app uses Samsung messaging component intent with `sms:` URI fallback.
- **SMS Bug Fix:** `sendSMSAsync` result now checks `result.data?.sent === true` instead of `result === 'sent'`.
- **Contact Disambiguation:** SMS and phone call handlers return disambiguation prompt when multiple contacts match.
- **Verb Typo Correction:** CommandParser auto-corrects 30+ common verb misspellings (opin→open, lauch→launch, tect→text, etc.).
- **System Prompt Upgrade:** AgentCore uses new Ultra persona — direct, action-oriented, no hedging.
- **Settings Directory Expansion:** 50+ new settings entries covering display, sound, battery, security, privacy, Samsung-specific, developer, and accessibility.
- **Flashlight Native Bridge:** `setFlashlight(boolean)` Java method via CameraManager with toggle state tracking.
- **Android Manifest Permissions:** 32 permissions auto-injected (camera, contacts, SMS, calendar, alarm, Bluetooth, NFC, location, etc.).
- **Result Propagation Fix:** `runWithPlan` now honors `result.success === false` for disambiguation and other explicit failures.

## Recent Fixes (v3.23.0)
- **Total Access Implementation:** Added settings intent resolution, deep link routing, system actions, system info gathering, preference backup/restore.
- **Comprehensive Sensor Integration:** All Total Access operations logged to UltraDevLog with 6 new categories and dedicated formatting.
- **Deduplication:** Fixed networkStatus() and modelState() to suppress identical repeated logs.

## Technical Notes
- **newArchEnabled** MUST be true — react-native-reanimated v4 requires New Architecture.
- DO NOT add metro.config.js — breaks EAS builds on Windows.
- Venice API: `https://api.venice.ai/api/v1`. Default model: `llama-3.3-70b`. 60s timeouts.
- Flashlight toggle: tracks `this._flashlightOn` instance variable.
- Contact disambiguation returns `{ success: false, requiresDisambiguation: true, matches, summary }`.
- `runWithPlan` detects explicit failures via `result.success === false`.
- 32 permissions auto-injected via `withAgentNative.js`.
- findBestMatch threshold = 35. KNOWN_APPS is Samsung-ified.

## File Structure
```
agent-ultra/
├── app/
│   ├── _layout.tsx          # Root layout, providers
│   ├── index.tsx            # Main chat UI
│   └── settings.tsx         # Settings & logs tab
├── components/
│   ├── ErrorBoundary.tsx    # Error UI fallback
│   ├── ModelPickerSheet.tsx # Model selection sheet
│   ├── ConversationList.tsx # Sidebar conversations
│   ├── PlusMenu.tsx         # Quick actions menu
│   └── [other components]
├── src/
│   ├── core/                # Agent loop & execution
│   │   ├── AgentCore.ts     # 9-step loop (1008 lines)
│   │   ├── TaskExecutor.ts  # 49 capabilities (1347 lines)
│   │   ├── CommandParser.ts # NL parsing (759 lines)
│   │   ├── CapabilityRegistry.ts # 49 registrations (107 lines)
│   │   ├── CapabilitySchemas.ts  # 49 schemas (466 lines)
│   │   ├── ModelRouter.ts   # Venice API interface
│   │   ├── SettingsDirectory.ts  # 50+ settings entries (194 lines)
│   │   ├── DeepLinkDirectory.ts  # 19 app deep links
│   │   ├── SystemActions.ts      # WiFi/BT/Airplane/Brightness
│   │   └── [others]
│   ├── services/            # Persistence & logging
│   │   ├── LogFolder.ts     # Log file management
│   │   ├── ConversationManager.ts
│   │   ├── CostTracker.ts
│   │   ├── PreferenceBackup.ts  # Export/import preferences
│   │   └── [others]
│   ├── genome/              # Self-evolution
│   │   ├── GenomeFactory.ts
│   │   ├── SelfImprover.ts
│   │   └── [others]
│   ├── utils/
│   │   ├── UltraDevLog.ts   # Main diagnostic logger
│   │   ├── PreferenceLearner.ts # App package learning
│   │   ├── classifyModelType.ts # Model category classifier
│   │   └── [others]
│   ├── security/
│   │   └── SecureVault.ts   # Encrypted storage
│   └── native/              # Native bridge
│       └── AgentNative.ts   # TypeScript bridge (110 lines)
├── plugins/
│   └── withAgentNative.js   # Config plugin + Java sources (1652 lines)
├── server/
│   ├── index.ts             # Express server
│   └── [routes]
├── ultra-full-source.txt    # All 8 core files concatenated (5678 lines)
├── CHANGELOG.md             # Full version history
├── gitlog.md                # Git commit history (50 commits)
└── [config files]
```

## Quick Reference
- **Venice API:** `https://api.venice.ai/api/v1` — Default model: `llama-3.3-70b` — 60s timeout
- **EAS Build:** `eas build --platform android --profile preview` (from Windows local machine)
- **Logs for Claude:** CHANGELOG.md, gitlog.md, replit.md, ultra-full-source.txt
- **Update at end of session:** CHANGELOG.md, gitlog.md, replit.md, ultra-full-source.txt
- **Git HEAD:** e186c58 (v3.24.0)
- **Total capabilities:** 49 (23 original + 26 new)
- **Total core source lines:** 5,635 across 8 files
- **Total manifest permissions:** 32

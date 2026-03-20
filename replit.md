# Agent Ultra

## Overview
Agent Ultra is an autonomous AI agent application for Android. It operates through a 9-step execution loop (INGEST → ROUTE → PLAN → VERIFY → APPROVE → EXECUTE → VERIFY_RESULT → WRITE_MEMORY → ADAPT), executes 49+ device capabilities, can replicate and evolve its own APK on-device via a Von Neumann Genome system, and is built to compile and install a new APK entirely from within the phone. The stack is Expo (React Native) front-end, Express.js back-end, Venice API for AI, and a custom Java Accessibility Service + native bridge for device control.

## User Preferences
- **CRITICAL: Do NOT make any code changes, file edits, package installs, workflow restarts, or any other actions unless the user EXPLICITLY says to do so. "Make a plan" means produce a document only — never implement. When in doubt, ask first.**
- The agent should prioritize the use of the Venice API.
- The agent should only make changes to the codebase when explicitly instructed or when it's part of its self-improvement cycle.
- The agent should ask for user approval for dangerous actions.
- The agent should provide real-time build progress updates in the chat UI.
- The agent should allow users to configure the AI model used and API key via in-app settings.
- The agent should persist conversations and allow switching between them.
- **Key reports for sharing with Claude:** CHANGELOG.md, gitlog.md, replit.md, ultra-full-source.txt
- **DO NOT TOUCH:** location/GPS, PermissionBroker, calls, texts/SMS, Pandora/media control, UI code, genome/build system, AgentCore.ts init flow.

## System Architecture

### Frontend
- Expo (React Native) + `expo-router` for file-based routing, dark theme
- Chat screen: `app/index.tsx` — FlatList (inverted), model picker, quick replies, multi-conversation sidebar
- Settings screen: `app/settings.tsx` — 4 tabs: API Setup / Cost Limits / Logs / Blocked
- `components/OnboardingScreen.tsx` — first-launch 3-step onboarding (Welcome, API Key, Accessibility)
- `components/BlockedAppsTab.tsx` — manage blocked package names (agent will refuse to control them)
- `components/BiometricGate` (lock screen) — embedded in `app/index.tsx` render path

### Backend
- Express.js on port 5000; static landing page at `server/templates/landing-page.html`
- Expo dev server on port 8081

### AI Integration
- Venice API (`https://api.venice.ai/api/v1`) via `ModelRouter`
- Default model: `llama-3.3-70b`
- Context-aware model routing; `classifyModelType` utility for picker tab classification
- API payload logged to UltraDevLog on every `complete()` and `completeWithConversation()` call
- `canHandleLocally(taskType)` checks for offline-capable models in model registry

### Core Agent Loop (9-step)
1. **INGEST** — persist user message to conversation
2. **ROUTE** — `detectMode()` classifies: `command` | `conversation` | `ai_instruction`
3. **PLAN** — `CommandParser` (deterministic regex) → AI fallback if no match
4. **VERIFY** — `validatePlan()` against CapabilitySchemas
5. **APPROVE** — `SafetyChecker` risk assessment; dangerous actions require user confirmation
6. **EXECUTE** — `TaskExecutor.runWithPlan()` → 49 capability implementations
7. **VERIFY_RESULT** — result honesty check (toggles say "check status bar", screenshots have 1000ms delay)
8. **WRITE_MEMORY** — `MemoryManager` and `PreferenceLearner` update learned patterns
9. **ADAPT** — `AgentCore` updates model preferences and persona

### Capability System (49 capabilities)
All capabilities registered in `CapabilityRegistry`, schema-validated in `CapabilitySchemas`, parsed in `CommandParser`, executed in `TaskExecutor`:

**File & Storage:** file_read, file_write, file_delete, file_organize
**Communication:** sms_send, contacts_read
**App Control:** app_launch, react_navigate (ReActLoop), camera_capture, media_access
**Device Status:** battery_status, device_info, system_info
**Media:** media_play, media_next, screenshot, screen_record_start
**Toggles:** flashlight_toggle, wifi_toggle, bluetooth_toggle, airplane_mode, do_not_disturb
**Audio:** volume_set, brightness_set
**Clipboard:** clipboard_read, clipboard_write
**Web:** web_search, open_url
**Content Creation:** alarm_set, timer_set, calendar_create, reminder_create, note_create, file_open, share_content, app_info
**Notifications:** notification_read
**Build System:** build_apk, genome_replicate, self_improve, run_tests, etc.

### Safety & Security
- `SafetyChecker` — pattern scanning, risk level assessment (safe / moderate / sensitive / dangerous)
- `PermissionBroker` — device permission management (do not touch)
- `SecureVault` (`expo-secure-store`) — encrypted key-value storage for API keys, preferences, learned patterns
- `BiometricGate` — biometric lock with configurable timeout (Never / 1m / 5m / 15m / 30m / 1h); initialized from vault in app/index.tsx; settings picker in app/settings.tsx APIs tab
- **Self-Interaction Block** — `checkPackageAllowed()` in AccessibilityService blocks `com.agent.ultra` from being controlled by itself
- **ReActLoop Safety** — each iteration checks `getActivePackage()` and aborts if foreground is Agent Ultra
- **Blocked Apps** — `blockedPackages` Set in AccessibilityService; `blockPackage/unblockPackage/getBlockedPackages` native bridge methods; managed via BlockedAppsTab in Settings → Blocked tab

### Privacy
- `refreshSystemContext()` called ONLY in the LLM routing block (not on every user request) — prevents unnecessary GPS/sensor polling
- `sanitizeSystemContext()` strips GPS coordinates (lat/lon regex), IMEI, and serial numbers before any context is sent to Venice API

### ReActLoop (UI Automation)
- `src/core/ReActLoop.ts` — observe → reason → act loop over Android Accessibility tree
- Reads screen via `getScreenContentFlat()` → compact JSON node array `[{i, t, d, c, e, s, x, y}]`
- Actions: `tap(x,y)`, `tap_index(N)`, `type("text")`, `scroll(up/down)`, `swipe(x1,y1,x2,y2)`, `back()`, `home()`, `done`
- Self-interaction safety stop per iteration
- Stuck-detection: same tree prefix 2× → scroll down
- Used by: `react_navigate`, `camera_capture`, Quick Settings toggle, screenshot

### Native Bridge (Java AccessibilityService)
Defined in `plugins/withAgentNative.js` via Expo config plugin (inline Java strings):
- `AgentAccessibilityService` — extends `AccessibilityService`, handles UI automation
- `AgentNativeModule` — React Native bridge module
- Key methods exposed: `getScreenContent`, `getScreenContentFlat`, `performTap`, `performSwipe`, `performScroll`, `performText`, `performBack`, `performHome`, `getActivePackage`, `isServiceEnabled`, `openAccessibilitySettings`, `allowPackage`, `revokePackage`, `waitForUiChange`, `performQuickSettings`, `takeScreenshot`, `toggleQuickSetting`, `setVolume`, `getVolume`, `adjustVolume`, `blockPackage`, `unblockPackage`, `getBlockedPackages`, `sendSms`, `setFlashlight`, `installApk`, `writeFile`, `compileJava`, `dexConvert`, `signApk`
- **Quick Settings:** gesture-based tap on tile center bounds (not deprecated tapQuickSettingsTile); `toggleQuickSetting` waits for UI change
- **Volume:** `AudioManager` bridge — `setVolume(streamType, level)`, `getVolume(streamType)`, `adjustVolume(up/down)`
- **Blocked Apps:** static `blockedPackages` Set; blocks controlled entirely in native layer
- `AppController.ts` — TypeScript wrapper with `noopController` for web + `createNativeController()` for Android

### On-Device Build System
- `BuildSystem` orchestrates APK pipeline: `AppArchitect` → `BuildOrchestrator` → ECJ compilation → D8/R8 DEX → packaging → V1 JAR signing → installation
- `MavenResolver` downloads JAR/AAR dependencies from Maven Central
- `DebugEngine` provides AI-driven self-healing for build errors

### Self-Evolution / Genome System
- `Von Neumann Genome` — managed by `GenomeFactory`, `GenomeCompiler`, `GenomeMutator`, `SelfImprover`
- Fitness evaluation via `TaskChallenges` and `TaskEvaluator`
- `GenomeLineage` tracks mutation history
- Genome JSON stored at `documentDirectory/genome.json`
- Source files staged to `documentDirectory/genome_sources/` on first run

### Multi-Agent Orchestration
- `Orchestrator` manages `TaskAgent` instances
- `AgentBus` handles inter-agent communication

### Persistence & Monitoring
- `ConversationManager` — SQLite-backed chat storage
- `ExecutionLedger` — logs events, manages cost budgets
- `CostTracker` — tracks Venice API usage per model/task/session
- `EventMonitor` — background monitoring for scheduled events

### Logging System
- `UltraDevLog` — primary logger, 60+ sensor types, 3,000-entry in-memory ring buffer
- Flushes to `ultra-devlog.jsonl` (fixed filename — no proliferation)
- `generateBugReport()` produces human-readable diagnostic summaries
- `Logger` — per-component structured logging to `debug-log.jsonl`
- API payload logged on every Venice API call (both `complete()` and `completeWithConversation()`)

### CommandParser Priority Order
1. Rich intent patterns (music playback, phone calls, navigation, email)
2. **react_navigate** — named popular apps (Amazon, Reddit, YouTube, etc.) — FIRST before web_search
3. Web search patterns
4. Alarms, timers, calendar, reminder
5. URL patterns
6. Flashlight, volume, brightness, WiFi, Bluetooth, airplane mode, DND
7. Media controls (play/pause/skip)
8. Clipboard, screenshot, notifications, note create, app info, device info
9. App launch (generic)

### Multi-Step Routing
- Detects multi-step connectors: "then", "and then", "after that", etc.
- Executes steps sequentially; 2nd+ steps use AI routing if deterministic parse fails, with context from previous step result

### UI / UX
- Accent color: `#34d399` (mint green)
- Model picker with tab filters (text/image/code/reasoning/video), powered by `classifyModelType`
- Quick replies on latest message
- Inline copy buttons, selectable text
- Message collapse for >4000 chars with "Show more"
- `OnboardingScreen` on first launch (AsyncStorage `onboarding_done` flag)
- Biometric lock screen when `BiometricGate.isLocked()` is true on app open

## File Map (Key Files)

| File | Purpose |
|------|---------|
| `app/index.tsx` | Chat screen — main UI, onboarding, biometric lock |
| `app/settings.tsx` | Settings — APIs/Cost/Logs/Blocked tabs, biometric timeout picker |
| `app/_layout.tsx` | Root layout, font loading, error boundary |
| `components/OnboardingScreen.tsx` | First-launch 3-step flow |
| `components/BlockedAppsTab.tsx` | Blocked packages manager |
| `components/ModelPickerSheet.tsx` | Model selector bottom sheet |
| `components/ConversationList.tsx` | Side drawer conversation list |
| `src/core/AgentCore.ts` | 9-step execution loop, persona, mode detection |
| `src/core/ModelRouter.ts` | Venice API client, model discovery, canHandleLocally() |
| `src/core/TaskExecutor.ts` | 49 capability implementations |
| `src/core/ReActLoop.ts` | UI automation observe-reason-act loop |
| `src/core/CommandParser.ts` | Deterministic regex routing (1008 lines) |
| `src/core/CapabilityRegistry.ts` | 49 capabilities with risk levels |
| `src/core/CapabilitySchemas.ts` | Schema definitions for VERIFY phase |
| `src/core/SafetyChecker.ts` | Risk pattern scanner |
| `src/native/AppController.ts` | TypeScript wrapper for native bridge |
| `src/native/AgentNative.ts` | Additional native module bridge |
| `src/security/BiometricGate.ts` | Biometric lock with configurable timeout |
| `src/security/SecureVault.ts` | Encrypted key-value storage |
| `src/utils/UltraDevLog.ts` | Primary logger (60+ sensor types) |
| `src/utils/classifyModelType.ts` | Model type classifier for picker tabs |
| `src/utils/PreferenceLearner.ts` | App launch and preference learning |
| `src/services/ConversationManager.ts` | Chat persistence |
| `src/services/CostTracker.ts` | API usage tracking |
| `src/services/ExecutionLedger.ts` | Task event log and budget |
| `plugins/withAgentNative.js` | Expo config plugin — Java source injection |
| `attached_assets/replit-v5-complete_1773977717586.md` | v5 20-task plan |

## External Dependencies
- **Venice API** — AI (text, image, code, reasoning, video models)
- **Expo / React Native** — frontend framework
- **Express.js** — backend server
- **EAS Build** — standalone Android APK (`eas build --platform android --profile preview --local`)
- **expo-secure-store** — SecureVault
- **expo-file-system/legacy** — file operations (MUST use `/legacy` import)
- **expo-local-authentication** — BiometricGate
- **expo-contacts** — contacts access
- **expo-sms** — SMS compose fallback
- **expo-intent-launcher** — Android intents
- **expo-battery** — battery state
- **expo-document-picker** — file import
- **expo-sharing** — file export
- **expo-image-picker** — camera/gallery
- **expo-clipboard** — clipboard
- **expo-device** — device info
- **react-native-device-info** — system info (RAM, storage)
- **@react-native-community/netinfo** — network state
- **@react-native-async-storage/async-storage** — onboarding flag, general persistence
- **@tanstack/react-query** — server state (backend API)
- **react-native-keyboard-controller** — keyboard handling
- **@expo/vector-icons** — Ionicons, MaterialCommunityIcons
- **ECJ** — on-device Java compilation
- **D8/R8** — DEX conversion
- **Maven Central** — JAR/AAR dependency resolution

## Build Notes
- `newArchEnabled: true` required in app.json
- Always import from `expo-file-system/legacy` (not `expo-file-system`)
- EAS local build: `eas build --platform android --profile preview --local`
- Bundle ID: `com.agent.ultra`
- Java in `withAgentNative.js`: always use fully qualified class names (no imports in inline Java strings)
- Metro watches all workspace directories — `.local/skills/` changes can cause watcher errors (transient, restart frontend to recover)

## v5 Task Plan Status (attached_assets/replit-v5-complete_1773977717586.md)

### PHASE 1-2: SAFETY & QUICK SETTINGS — COMPLETE
- Task 1: Self-interaction block in `checkPackageAllowed()` — DONE
- Task 2: ReActLoop safety stop per iteration — DONE
- Task 3: No-auth-blocking acknowledgement — DONE
- Task 4: Gesture-based Quick Settings tile tap — DONE

### PHASE 3: PRIVACY — COMPLETE
- Task 5: `refreshSystemContext()` moved to LLM routing block only — DONE
- Task 6: `sanitizeSystemContext()` strips GPS/IMEI/serial — DONE
- Task 7: Deterministic ReActLoop (getNodes/nodesToObservation/parseGoal/findNodeByText/executeDeterministic) — PENDING
- Task 8: LLM fallback only when deterministic fails — PENDING
- Task 9: API Payload Logger in ModelRouter — DONE

### PHASE 4: BUG FIXES — COMPLETE
- Task 10: `react_navigate` pattern as FIRST in CommandParser — DONE
- Task 11: Volume via AudioManager (Java + AppController + TaskExecutor) — DONE
- Task 12: `detectMode()` fix for "whats"/"where's" without apostrophe — DONE
- Task 13: Multi-step 2nd+ step AI fallback with previous step context — DONE
- Task 14: Toggle/screenshot result honesty (check status bar, 1000ms delay) — DONE
- Task 15: API payload visible in logs — DONE (same as Task 9)

### PHASE 5: FEATURES — COMPLETE
- Task 16: Blocked apps (Java Set + native bridge + BlockedAppsTab + settings "Blocked" tab) — DONE
- Task 17: `canHandleLocally()` in ModelRouter — DONE
- Task 18: First-launch onboarding (OnboardingScreen + AsyncStorage flag) — DONE
- Task 19: BiometricGate lock (timeout options + lock screen in app/index.tsx + picker in settings) — DONE
- Task 20: Model classification wired into `discoverModels()` — DONE

**Remaining:** Tasks 7 & 8 (deterministic ReActLoop execution path)

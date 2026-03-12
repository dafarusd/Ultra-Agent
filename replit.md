# Agent Ultra

## Overview
Agent Ultra is an autonomous AI agent application for Android that integrates with the Venice API. Its core purpose is to enable on-device APK compilation with self-replicating capabilities and a self-healing debug engine. The project aims to create an AI that can design, build, test, and iteratively improve Android applications, including itself. Key features include multi-agent swarm orchestration, a sophisticated self-evolving genome system for continuous improvement, and real-world task-based fitness evaluation for generated applications. This initiative pushes the boundaries of autonomous software development directly on mobile devices, offering significant potential for rapid prototyping, personalized app generation, and AI-driven mobile innovation.

## User Preferences
The agent should prioritize the use of the Venice API.
The agent should only make changes to the codebase when explicitly instructed or when it's part of its self-improvement cycle.
The agent should ask for user approval for dangerous actions.
The agent should provide real-time build progress updates in the chat UI.
The agent should allow users to configure the AI model used and API key via in-app settings.
The agent should persist conversations and allow switching between them.

## System Architecture
**Frontend:** The application uses Expo (React Native) with `expo-router` for file-based routing, providing a consistent UI across different screens like chat, settings, and conversation lists. The design incorporates a biometric gate for security and a dark theme.
**Backend:** A lightweight Express.js server runs on port 5000, handling API requests.
**AI Integration:** All AI interactions are managed via the Venice API, with users providing their own API key. A `ModelRouter` intelligently recommends context-aware models.
**On-Device Build System:** A comprehensive `BuildSystem` orchestrates the entire APK build pipeline, from `AppArchitect` generating `AppSpec` from natural language to `BuildOrchestrator` handling dependency resolution, code generation, compilation (ECJ Java compiler), DEX conversion (D8/R8), packaging, V1 JAR signing (RSA-2048), and installation.
**Self-Evolution and Genome System:** A `Von Neumann Genome` system, managed by `GenomeFactory`, `GenomeCompiler`, `GenomeMutator`, and `SelfImprover`, enables the agent to evolve. It tracks lineage, performs AI-driven mutations, compiles offspring, and evaluates fitness based on real-world task performance using `TaskChallenges` and `TaskEvaluator` via accessibility services.
**Multi-Agent Orchestration:** `Orchestrator` manages a swarm of individual `TaskAgent` instances, communicating via an `AgentBus`.
**Safety and Security:** A `SafetyChecker` scans for dangerous patterns and validates scope. `PermissionBroker` manages device permissions. `SecureVault` handles sensitive data storage. `BiometricGate` provides biometric authentication.
**Core Agent Loop:** A 9-step autonomous loop (INGEST, ROUTE, PLAN, VERIFY, APPROVE, EXECUTE, VERIFY_RESULT, WRITE_MEMORY, ADAPT) guides the agent's decision-making and execution.
**Capability Management:** `CapabilityRegistry` defines 22 distinct capabilities (e.g., file operations, camera capture, device location, app build, self-modify) with associated risk levels, executed by `TaskExecutor`.
**Error Handling and Debugging:** An `ErrorBoundary` handles UI errors, and a `DebugEngine` provides a self-healing loop for build errors, involving AI-driven fixes and recompilation.
**Persistence and Monitoring:** `ConversationManager` handles persistent chat storage, `ExecutionLedger` logs events and manages idempotency and autonomy budgets, and `CostTracker` monitors API usage.
**Native Module Integration:** A custom `AgentNativeModule` (Java classes injected via an Expo config plugin) provides direct access to native functionalities like file writing, Java compilation, APK packaging, signing, installation, and process execution, crucial for the on-device build process. `AppController` utilizes an accessibility service for UI automation and E2E testing of generated apps.
**UI/UX Decisions:** The project uses a programmatic-only UI approach, avoiding XML layouts. Color schemes, layouts, and overall design are managed within React Native components.

## External Dependencies
*   **Venice API:** Used for all AI-related functionalities.
*   **Expo (React Native):** Frontend framework.
*   **Express.js:** Backend server framework.
*   **EAS Build:** For building standalone Android APKs.
*   **Maven Central:** For downloading JAR/AAR dependencies.
*   **ECJ (Eclipse Compiler for Java):** Used for on-device Java compilation.
*   **D8/R8:** Used for converting Java bytecode to Dalvik bytecode (DEX).
*   **`expo-secure-store`:** For secure key-value storage.
*   **`expo-file-system`:** For file system operations on the device.
*   **`@expo/vector-icons`:** For UI icons.
*   **`expo-clipboard`:** For copy-to-clipboard functionality on message long-press.
*   **`expo-sharing`:** For exporting/sharing log files and native share sheet.
*   **`expo-image-picker`:** For camera capture and gallery image picking.
*   **`expo-location`:** For GPS/device location access.

## QA Bug Fixes (v1.1)
*   **"hello ultra" misrouting:** Removed broad `includes('ultra')` check from `detectMode()`. Now only routes to command mode when "ultra" appears as a prefix before an imperative verb (e.g., "ultra open..."). Greetings and casual mentions of "ultra" correctly route to conversation mode.
*   **Raw JSON responses:** Added `summarizeResult()` AI summarization step in AgentCore Step 7. Capability results now display as readable sentences instead of raw JSON dumps. Raw data preserved in `meta.data` for debugging.
*   **Scrollable/downloadable logs:** Settings log viewer now uses a nested ScrollView with max height 400px. Added "Share Logs" button (uses expo-sharing on native, clipboard on web).
*   **Prompt trace duplication:** Fixed `buildPromptTrace()` and conversation flow to filter out system prompt and framed user message from `includedMessages` since they're already shown separately in the PromptViewer.
*   **Biometric re-auth on resume:** Added AppState listener in `_layout.tsx` that triggers biometric re-authentication when app transitions from background to active.
*   **Conversation persistence:** Added atomic writes (tmp→rename) in `ConversationManager.saveConversation()` to prevent corruption during force stops. Added per-file try/catch in `listConversations()` so one corrupt file doesn't kill the entire list.
*   **Copy message on long press:** Added `onLongPress` handler to message bubbles using expo-clipboard. Shows "Copied" label and green border flash for 1.5s feedback.
*   **Command routing improvements:** Added "create an app", "make an app" patterns to CommandParser. Fixed pattern ordering so `app_build` patterns match before the generic `write/save` file pattern. Removed `create` from the file-write pattern to prevent it from eating build commands.
*   **Empty state text fix:** Separated `scaleY: -1` transform for web vs native to ensure greeting text renders correctly on both platforms with inverted FlatList.

## Build & Offspring Improvements (v1.2)
*   **Build progress persisted to conversation:** Build progress events (`app_build`, `self_modify`, `self_replicate`) are now captured and saved as a dedicated "BUILD LOG" message in the conversation. Users can scroll back and review the step-by-step build log.
*   **Build log UI:** Build log messages render with a distinct amber/console style — dark background, monospace font, console icon, and "BUILD LOG" label to differentiate from regular messages.
*   **Rich build result summaries:** `summarizeResult()` now produces capability-specific summaries for `app_build` (app name, APK path, file count), `self_modify` (cycles, improvements, fitness score, task performance, full evolution report), and `self_replicate` (generation, parent ID, APK path, package name).
*   **Genome persistence on web:** Genome state now persists to `localStorage` on web (previously only saved to native file system). Users can evolve the genome in web preview without losing progress between sessions.
*   **ChatMessage type extended:** Added `isBuildLog` and `data` fields to `meta` for richer message metadata.

## Device Capability Fixes (v1.3)
*   **compileSdkVersion bumped to 36:** `androidx.core:core-ktx:1.17.0` requires compileSdk 36. Updated `app.json` from 35 to 36 to fix EAS build failure.
*   **API key gating fix:** Moved Venice API key check from before routing to after deterministic command parsing. Commands that match CommandParser patterns (SMS, contacts, camera, location, file ops, etc.) now execute without needing an API key. Only AI fallback planning and conversation mode require the key.
*   **Camera capture implemented:** Replaced stub with `ImagePicker.launchCameraAsync()`. Returns photo URI, dimensions, and file size.
*   **Gallery image picker added:** `media_access` now supports `action: 'pick'` parameter to open the gallery picker via `ImagePicker.launchImageLibraryAsync()`. Default behavior (listing recent media) preserved.
*   **App share implemented:** Replaced availability-check stub with real sharing. File URIs use `Sharing.shareAsync()`, text content uses React Native `Share.share()`.
*   **Device location added:** New `device_location` capability using `expo-location` for native GPS and web geolocation API fallback. Registered in CapabilityRegistry, PermissionBroker, SafetyChecker, CommandParser, and CapabilitySchemas.
*   **SMS contact resolution:** SMS handler now looks up contact names via `expo-contacts` to resolve "mom" → phone number. Message parameter made optional (opens SMS composer without pre-filled text if not specified).
*   **CommandParser expanded:** Added patterns for: `pick/choose/select photo`, `share [content]`, `where am i`, `get my location`, `my location/coordinates/gps`, `gps`, `find/show my location/position/coordinates`, `take selfie/picture`.
*   **SafetyChecker scope keywords updated:** Added comprehensive scope keywords for all capabilities including `device_location`, expanded `camera_capture` and `media_access` keywords.
*   **detectMode expanded:** Added imperative verbs: `share`, `pick`, `choose`, `select`, `where`, `get`. Added special-case patterns for `gps` and `my location/coordinates/gps`.

## Execution Trace & Debug Logging (v1.4)
*   **PromptTrace enriched:** Extended `PromptTrace` interface in `src/types/ultra.ts` with `ExecutionStep`, `TraceSafetyCheck`, `TraceVerification`, `TraceLedgerEvent` types and 12 new optional fields (steps, plan, rawResult, safetyCheck, verification, permissionState, error, durationMs, taskId, mode, deterministic, ledgerEvents).
*   **AgentCore instrumented:** `execute()` now tracks all 9 agent loop phases with step name, timestamp, detail string, and pass/fail. Captures stack traces via `err.stack`. Builds rich `PromptTrace` with all fields. Added `getExecutionLedger()` getter.
*   **PromptViewer upgraded:** Shows execution timeline, action plan, raw result, safety check, verification, permissions, error/stack trace, ledger events. Added per-trace "Download" button that exports full trace as text file via `Sharing.shareAsync`.
*   **Download button overhauled:** Settings page "Share Logs" replaced with "Download" button. Exports comprehensive debug log including: full conversation history with prompt traces for every message, execution ledger events, and all Logger entries with ISO timestamps and metadata.

## Ultra Overhaul v3.0
*   **ModelRouter full overhaul:** `baseUrl` property added (defaults to `https://api.venice.ai/api/v1`). `setBaseUrl()`/`getBaseUrl()` added. `getModelsByType(type)` filters by model type. `complete()` accepts a `timeout` parameter (default 60 000 ms). `discoverModels()` now stores `pricing.input.usd` directly as `costPer1kInput` (no `/1000` division — Venice returns per-1K price). Type validation whitelist (`text`, `code`, `image`, `embedding`) with safe fallback to `'text'` for unknown types.
*   **AgentCore delegate:** `setApiBaseUrl()` delegates to `ModelRouter.setBaseUrl()`. `getModelRouter()` getter exposed for settings screen.
*   **TaskExecutor overhaul:** `app_launch` runs device-aware: native path uses `Linking.openURL()` with `android-app://` intent URI; web path opens a tab. SMS `action: 'send'` uses `Linking.openURL('smsto:...')`. `image_generate` AbortController timeout (180 s for self_replicate, 60 s default); base64 data-URI prefix stripped defensively before `writeAsStringAsync`. `self_replicate` timeout extended to 180 s.
*   **getInstalledApps native module:** Java `getInstalledApps()` implemented via `QUERY_ALL_PACKAGES` permission. Both catch blocks now emit `logger.warn` (previously silent).
*   **CapabilityRegistry / CapabilitySchemas:** `image_generate` capability registered with full JSON schema.
*   **CommandParser:** Recognises `run`/`start` as `app_launch` verbs; `generate image`, `create image`, `draw` patterns added for `image_generate`.
*   **SafetyChecker:** Scope keyword map updated for all new capabilities.
*   **CostTracker:** Defaults (`enabled: false`, `monthlyLimitUsd: 0`, `dailyLimitUsd: 0`).

## UI Overhaul v3.0
*   **ConversationList redesign:** Left-side animated spring drawer (width 280, translucent backdrop). Spring animation on open/close. Conversation items show timestamp and truncated last message.
*   **index.tsx:** Optimistic message rendering (instant bubble before network round-trip, deduplication on reloadMessages). Conversation rename via long-press on header title (inline TextInput). Unique optimistic IDs use `Date.now() + random` to avoid collision.
*   **settings.tsx:** Model dropdown shows type badge per model. API URL field (editable base URL). Cost limits default to 0.

## Bug Fixes & Audit Response (v3.1)
*   **Forensic audit findings investigated (13 total):** 8 confirmed false, 3 real (fixed), 2 already fixed or intentional.
*   **TaskEvaluator race condition fixed:** `AbortController` wired through `runChallenge()`. On timeout, `abort()` is called and every loop iteration checks `signal.aborted` before proceeding. Prevents background resource leak after `Promise.race` resolves.
*   **GenomeCompiler unresolved source:** Silent fallback (passing raw `FIXED:build_toolchain` string to the Java compiler) replaced with a clear `throw new Error(...)` that names the missing file and instructs the user to run `self_replicate` first.
*   **Image write defensive strip:** `result.images[0].replace(/^data:image\/\w+;base64,/, '')` applied before `writeAsStringAsync` so the image write works whether Venice returns raw base64 or a data-URI-prefixed string.
*   **Metro blockList anchored:** `/scripts\/.*/` regex was accidentally blocking `node_modules/react-native-reanimated/scripts/validate-worklets-version`, preventing the web bundle from building. Fixed by anchoring to `path.join(__dirname, 'scripts')` so only the project-root `scripts/` directory is excluded.

## Key File Reference
| File | Purpose |
|---|---|
| `src/core/AgentCore.ts` | 9-step agent loop, mode detection, safety gate, cost gate |
| `src/core/ModelRouter.ts` | Venice API client, model discovery, image generation |
| `src/core/TaskExecutor.ts` | 22 capability implementations |
| `src/core/CommandParser.ts` | NLP pattern → capability routing |
| `src/core/SafetyChecker.ts` | Risk scoring and scope validation |
| `src/genome/GenomeCompiler.ts` | Genome → Java source → APK compilation |
| `src/genome/GenomeMutator.ts` | AI-driven genome mutation |
| `src/genome/TaskEvaluator.ts` | Fitness evaluation via accessibility service |
| `src/services/CostTracker.ts` | API spend tracking with monthly/daily limits |
| `plugins/withAgentNative.js` | Expo config plugin — injects Java native modules |
| `app/index.tsx` | Chat screen with optimistic messages and rename |
| `components/ConversationList.tsx` | Animated left-side drawer |
| `app/settings.tsx` | API key, model selector, cost limits |
| `ultra-full-source.txt` | Full 55-file source snapshot (regenerated after every change) |
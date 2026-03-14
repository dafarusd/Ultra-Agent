# Agent Ultra

## Overview
Agent Ultra is an autonomous AI agent application for Android focused on on-device APK compilation with self-replicating capabilities and a self-healing debug engine. The project's vision is to create an AI that can design, build, test, and continuously improve Android applications, including itself, directly on mobile devices. This includes features like multi-agent swarm orchestration, a self-evolving genome system, and real-world task-based fitness evaluation for generated applications, aiming to revolutionize mobile app development through AI-driven innovation.

## User Preferences
The agent should prioritize the use of the Venice API.
The agent should only make changes to the codebase when explicitly instructed or when it's part of its self-improvement cycle.
The agent should ask for user approval for dangerous actions.
The agent should provide real-time build progress updates in the chat UI.
The agent should allow users to configure the AI model used and API key via in-app settings.
The agent should persist conversations and allow switching between them.

## System Architecture
**Frontend:** Built with Expo (React Native) and `expo-router` for file-based routing, featuring a biometric gate for security and a dark theme. UI is programmatic, avoiding XML layouts.
**Backend:** A lightweight Express.js server on port 5000 handles API requests.
**AI Integration:** All AI interactions leverage the Venice API via a `ModelRouter` for context-aware model recommendations.
**On-Device Build System:** A `BuildSystem` manages the entire APK pipeline, from natural language `AppArchitect` to `BuildOrchestrator` handling dependency resolution, code generation, compilation (ECJ), DEX conversion (D8/R8), packaging, V1 JAR signing, and installation.
**Self-Evolution and Genome System:** A `Von Neumann Genome` system, managed by `GenomeFactory`, `GenomeCompiler`, `GenomeMutator`, and `SelfImprover`, enables continuous evolution through AI-driven mutations and fitness evaluation using `TaskChallenges` and `TaskEvaluator` via accessibility services.
**Multi-Agent Orchestration:** An `Orchestrator` manages `TaskAgent` instances, communicating via an `AgentBus`.
**Safety and Security:** Includes `SafetyChecker` for pattern scanning, `PermissionBroker` for device permissions, `SecureVault` for sensitive data, and `BiometricGate` for authentication.
**Core Agent Loop:** A 9-step autonomous loop (INGEST, ROUTE, PLAN, VERIFY, APPROVE, EXECUTE, VERIFY_RESULT, WRITE_MEMORY, ADAPT) governs agent decision-making.
**Capability Management:** `CapabilityRegistry` defines 22 capabilities (e.g., file operations, camera, location, app build, self-modify) with risk levels, executed by `TaskExecutor`.
**Error Handling and Debugging:** An `ErrorBoundary` handles UI errors, and a `DebugEngine` provides AI-driven self-healing for build errors.
**Persistence and Monitoring:** `ConversationManager` for chat storage, `ExecutionLedger` for event logging and idempotency/autonomy budgets, and `CostTracker` for API usage.
**Debug Logging:** Three-tier system: `Logger` (user-facing, in-memory, Settings > Logs), `DebugLog` (legacy, still exists), and `UltraDevLog` (primary, 3000-entry memory + file-based JSONL in `ultra_dev_logs/`). UltraDevLog v2 is a complete superset of DebugLog with 100+ methods including 54 legacy compatibility stubs. All instrumented files import `UltraDevLog as DebugLog` — zero call-site changes needed. v2 diagnostic sensors: CORE_INSTANCE (AgentCore instance lifecycle), EXECUTOR_BRANCH (code path tracing in executors), CONV_CONTEXT_SENT (token breakdown before API calls), UI_MESSAGE_RENDERED (FlatList message layout with pixel heights), TASK_WATCHDOG (proactive phase timeout alerts for APPROVE/EXECUTE), APP_STATE_CHANGE (foreground/background transitions). Existing categories: APP_LAUNCH_* (5-stage trace), SMS_* (resolve/fire/result), PICKER_* (open/close/animate/select), UI_PROCESSING, UI_SEND_ATTEMPT/COMPLETE, UI_MODAL, PARSE_INPUT/PARSE_COMPOUND, VAULT_READ/WRITE. `generateBugReport()` produces structured diagnostic reports. Settings > Logs has Bug Report (orange) and Full Log (green) buttons. **v3.11.0 completions:** `taskId` propagated through all 14 execute() returns and surfaced in sendComplete(); `pickerOpen` moved into ModelPickerSheet where slideAnim is accessible. **v3.12.0 critical fixes:** AgentCore init guard moved to module-level `let _agentCoreInitialized` (survives Android component remount on background return — `useRef` was destroyed each cycle); removed `coreRef.destroy()` cleanup that tore down core on every background transition; fixed `conversationMessage` crash (`.slice()` called on number — now accepts `number | string`); `hasBeenVisible` ref guard in ModelPickerSheet suppresses spurious PICKER_ANIMATE close on initial mount; default model picks auto-save to vault immediately (no separate Save button required); fixed `vaultSet` type mismatch (was passing `value.length` as `boolean`).
**Idempotency:** ExecutionLedger prevents duplicate actions, but `app_launch`, `camera_capture`, `media_access`, `device_location`, and `contacts_read` are exempt (repeatable capabilities). AgentCore init runs exactly once via module-level `_agentCoreInitialized` guard (not useRef — survives Android component remount). No cleanup/destroy on unmount — core persists across background transitions.
**Model Discovery:** Runs once during ModelRouter.initialize(). Subsequent `refreshApiKey()` calls skip re-discovery. Focus effects are debounced (2s guard).
**Quick Actions:** The side drawer (ConversationList) includes quick command buttons: `/status`, `/capabilities`, `/cost`, `/models`, `/help`, `/clear`. These send the command directly as a message.
**UI Color:** The accent green is `#34d399` (softer mint) used consistently across all components. Messages show inline copy buttons instead of long-press behavior, with selectable text for partial copying.
**Default Models by Mode:** Settings shows ALL available AI models for each mode (chat/image/code/reasoning/video) with recommended models marked with a star icon. No hardcoded presets — users can pick any model. The Plus menu applies saved defaults automatically when switching modes.
**Stop Button:** Neutral dark styling (`#333` background), no red.
**Debug Log Display:** Displays up to 5000 formatted entries (from 15000-entry memory buffer). Tap Refresh to reload. Download button exports full JSONL history with complete structured data. State snapshots (`UI_STATE`, `SETTINGS_STATE`, `MODEL_STATE`) capture full React state at every critical action — not just what happened, but what the entire system looked like at that moment. This enables diagnosing race conditions, async timing issues, and state desynchronization.
**Native Module Integration:** A custom `AgentNativeModule` (Java classes via Expo config plugin) provides direct access to native functions like file writing, Java compilation, APK packaging, signing, and installation. `AppController` uses accessibility services for UI automation and E2E testing of generated apps.

## External Dependencies
*   **Venice API:** For all AI functionalities.
*   **Expo (React Native):** Frontend framework.
*   **Express.js:** Backend server.
*   **EAS Build:** For building standalone Android APKs.
*   **Maven Central:** For downloading JAR/AAR dependencies.
*   **ECJ (Eclipse Compiler for Java):** On-device Java compilation.
*   **D8/R8:** Java bytecode to Dalvik bytecode conversion.
*   **`expo-secure-store`:** Secure key-value storage.
*   **`expo-file-system`:** File system operations.
*   **`@expo/vector-icons`:** UI icons.
*   **`expo-clipboard`:** Copy-to-clipboard.
*   **`expo-sharing`:** File sharing.
*   **`expo-image-picker`:** Camera and gallery access.
*   **`expo-location`:** GPS/device location access.
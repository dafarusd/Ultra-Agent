# Agent Ultra

## Overview
Agent Ultra is an autonomous AI agent application for Android focused on on-device APK compilation with self-replicating capabilities and a self-healing debug engine. The project's vision is to create an AI that can design, build, test, and continuously improve Android applications, including itself, directly on mobile devices. This includes features like multi-agent swarm orchestration, a self-evolving genome system, and real-world task-based fitness evaluation for generated applications, aiming to revolutionize mobile app development through AI-driven innovation.

## User Preferences
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

**Capability Management:** `CapabilityRegistry` defines 22 capabilities (e.g., file operations, camera, location, app build, self-modify) with risk levels, executed by `TaskExecutor`.

**Error Handling and Debugging:** An `ErrorBoundary` handles UI errors, and a `DebugEngine` provides AI-driven self-healing for build errors.

**Persistence and Monitoring:** `ConversationManager` for chat storage, `ExecutionLedger` for event logging and idempotency/autonomy budgets, and `CostTracker` for API usage.

**Debug Logging (v3.20.0 — SESSION STATE):** 
- **UltraDevLog** (primary logger) — 60+ sensors covering conversations, agent loop, intents, SMS, UI state, lifecycle events. 3,000-entry in-memory buffer updated every 2 seconds.
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

**Default Models by Mode:** Settings shows ALL available AI models for each mode (chat/image/code/reasoning/video) with recommended models marked with a star icon. No hardcoded presets — users can pick any model. The Plus menu applies saved defaults automatically when switching modes.

**Stop Button:** Neutral dark styling (`#333` background), no red.

**Debug Log Display:** Displays up to 5000 formatted entries (from 3000-entry memory buffer). Tap Refresh to reload. Download button exports full JSONL history with complete structured data. State snapshots (`UI_STATE`, `SETTINGS_STATE`, `MODEL_STATE`) capture full React state at every critical action — not just what happened, but what the entire system looked like at that moment. This enables diagnosing race conditions, async timing issues, and state desynchronization.

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
*   **`expo-file-system`:** File system operations (must import from `/legacy` in SDK 54+).
*   **`@expo/vector-icons`:** UI icons.
*   **`expo-clipboard`:** Copy-to-clipboard.
*   **`expo-sharing`:** File sharing via Android intents.
*   **`expo-image-picker`:** Camera and gallery access.
*   **`expo-location`:** GPS/device location access.

## Known Issues (v3.20.0)
- **None critical.** All 7 original bugs fixed.

## Recent Fixes (v3.20.0)
- **Bug 8:** Early `loadLogs()` call in mount removed — it fired before useCallback was initialized, causing crash.
- **Log file proliferation:** Fixed hundreds of timestamped files being created. Now uses fixed filenames (`ultra-devlog.jsonl`, etc.) that are overwritten on flush.
- **Comprehensive reporting:** Two detailed bug reports written for user to share with Claude.

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
│   │   ├── AgentCore.ts     # 9-step loop
│   │   ├── TaskExecutor.ts  # 22 capabilities
│   │   ├── ModelRouter.ts   # Venice API interface
│   │   └── [others]
│   ├── services/            # Persistence & logging
│   │   ├── LogFolder.ts     # Log file management
│   │   ├── ConversationManager.ts
│   │   ├── CostTracker.ts
│   │   └── [others]
│   ├── genome/              # Self-evolution
│   │   ├── GenomeFactory.ts
│   │   ├── SelfImprover.ts
│   │   └── [others]
│   ├── utils/
│   │   ├── UltraDevLog.ts   # Main diagnostic logger
│   │   └── [others]
│   ├── security/
│   │   └── SecureVault.ts   # Encrypted storage
│   └── native/              # Native bridge
├── server/
│   ├── index.ts             # Express server
│   └── [routes]
└── [config files]
```

## Quick Reference
- **Venice API:** `https://api.venice.ai/api/v1` — Default model: `llama-3.3-70b` — 60s timeout
- **EAS Build:** `eas build --platform android --profile preview` (from Windows local machine)
- **Logs for Claude:** CHANGELOG.md, gitlog.md, replit.md, ultra-full-source.txt
- **Update at end of session:** CHANGELOG.md, gitlog.md, replit.md, ultra-full-source.txt

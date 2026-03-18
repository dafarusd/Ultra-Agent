# Agent Ultra

## Overview
Agent Ultra is an autonomous AI agent application for Android focused on on-device APK compilation with self-replicating capabilities and a self-healing debug engine. The project aims to create an AI that can design, build, test, and continuously improve Android applications, including itself, directly on mobile devices. Key features include multi-agent swarm orchestration, a self-evolving genome system, and real-world task-based fitness evaluation for generated applications, intending to revolutionize mobile app development through AI-driven innovation.

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
**Frontend:** Developed with Expo (React Native) and `expo-router` for file-based routing, featuring a dark theme and programmatic UI. The UI includes `FlatList` with `extraData` for efficient re-renders and a model picker with `hitSlop` for improved touch accuracy.

**Backend:** A lightweight Express.js server on port 5000 handles API requests.

**AI Integration:** All AI interactions use the Venice API via a `ModelRouter` for context-aware model recommendations.

**On-Device Build System:** A `BuildSystem` orchestrates the entire APK pipeline, from natural language `AppArchitect` to `BuildOrchestrator`, covering dependency resolution, code generation, compilation (ECJ), DEX conversion (D8/R8), packaging, V1 JAR signing, and installation.

**Self-Evolution and Genome System:** A `Von Neumann Genome` system, managed by `GenomeFactory`, `GenomeCompiler`, `GenomeMutator`, and `SelfImprover`, enables continuous evolution through AI-driven mutations and fitness evaluation using `TaskChallenges` and `TaskEvaluator` via accessibility services.

**Multi-Agent Orchestration:** An `Orchestrator` manages `TaskAgent` instances, facilitating communication via an `AgentBus`.

**Safety and Security:** Components include `SafetyChecker` for pattern scanning, `PermissionBroker` for device permissions, `SecureVault` for sensitive data, and `BiometricGate` for authentication.

**Core Agent Loop:** A 9-step autonomous loop (INGEST, ROUTE, PLAN, VERIFY, APPROVE, EXECUTE, VERIFY_RESULT, WRITE_MEMORY, ADAPT) governs agent decision-making.

**Capability Management:** A `CapabilityRegistry` defines 49 capabilities with associated risk levels, executed by `TaskExecutor`. These capabilities cover a wide range of device interactions from basic toggles (flashlight, WiFi, Bluetooth) to system information retrieval and content creation (alarms, timers, notes, calendar events).

**Total Access Features:** Includes settings intent resolution for 37 Android settings entries, 19 built-in deep links for popular apps, system actions (e.g., WiFi toggle), system information retrieval (battery, RAM, storage, CPU), preference backup/restore, and package learning for faster app launches.

**Error Handling and Debugging:** An `ErrorBoundary` manages UI errors, and a `DebugEngine` provides AI-driven self-healing for build errors.

**Persistence and Monitoring:** `ConversationManager` handles chat storage, `ExecutionLedger` logs events and manages budgets, and `CostTracker` monitors API usage.

**Debug Logging:** `UltraDevLog` is the primary logger, capturing over 60 sensors related to agent activity, UI state, and system information into a 3,000-entry in-memory buffer. This data is flushed to `ultra-devlog.jsonl` and can be exported manually. `generateBugReport()` provides pre-formatted diagnostic summaries.

**Idempotency:** The `ExecutionLedger` prevents duplicate actions, though some capabilities like `app_launch` are repeatable. The `AgentCore` initialization is guarded to run only once.

**Model Discovery:** Performed once during `ModelRouter.initialize()`, with subsequent API key refreshes skipping re-discovery.

**Quick Actions:** The side drawer provides quick command buttons for common actions like `/status`, `/capabilities`, and `/help`.

**UI Color:** The accent green is `#34d399`. Messages feature inline copy buttons and selectable text.

**Default Models by Mode:** Settings allow users to select any available AI model for chat, image, code, reasoning, and video modes, with recommended models indicated.

**Native Module Integration:** A custom `AgentNativeModule` (Java classes via Expo config plugin) provides direct access to native functions for file writing, Java compilation, APK packaging, signing, and installation. `AppController` utilizes accessibility services for UI automation and E2E testing.

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
*   **`expo-clipboard`:** Copy-to-clipboard functionality.
*   **`expo-sharing`:** File sharing via Android intents.
*   **`expo-image-picker`:** Camera and gallery access.
*   **`expo-location`:** GPS/device location access.
*   **`expo-battery`:** Battery level and state information.
*   **`expo-document-picker`:** Document/file selection.
*   **`react-native-device-info`:** Device system information.
*   **`expo-intent-launcher`:** Native intent launching for settings and deep links.
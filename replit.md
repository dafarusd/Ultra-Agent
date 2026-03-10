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
**Capability Management:** `CapabilityRegistry` defines 20 distinct capabilities (e.g., file operations, app build, self-modify) with associated risk levels, executed by `TaskExecutor`.
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
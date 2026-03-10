# Agent Ultra

Autonomous AI agent app for Android with Venice API integration, multi-agent swarm orchestration, on-device APK compilation with self-replicating capability, and self-healing debug engine.

## Architecture

- **Frontend**: Expo (React Native) with file-based routing (expo-router)
- **Backend**: Express.js serving APIs on port 5000
- **AI Provider**: Venice API (user provides their own API key via Settings)
- **Target**: Standalone Android APK via EAS Build

## Directory Structure

```
app/                    # Expo Router screens
  _layout.tsx           # Root layout (biometric gate, Stack nav, dark theme)
  index.tsx             # Chat screen (main UI, full 9-step agent integration, build progress)
  settings.tsx          # Settings (API key, cost limits, logs)

components/
  ConversationList.tsx  # Modal conversation list (create, switch, delete)
  PromptViewer.tsx      # Modal prompt trace viewer (read-only)
  ErrorBoundary.tsx     # Error boundary with reload

src/
  types/
    ultra.ts            # Shared type definitions (ChatMessage, ActionPlan, PromptTrace, etc.)
    appspec.ts          # AppSpec, FileSpec, ActivitySpec, BuildPhase, BuildProgress types
  core/
    AgentCore.ts        # Main brain - 9-step autonomous loop
    ModelRouter.ts      # Venice API integration with context-aware model recommendations
    CommandParser.ts    # Deterministic command parser (pattern-matches before AI)
    SafetyChecker.ts    # Safety verification (dangerous patterns, scope validation, risk classification)
    CapabilitySchemas.ts # Tool contract schemas with validation
    BuildSystem.ts      # Build system facade — delegates to BuildOrchestrator, manages build tool downloads
    BuildOrchestrator.ts # Full build pipeline: SPEC → DEPS → GENERATE → SCAFFOLD → COMPILE → DEBUG → DEX → PACKAGE → SIGN → INSTALL
    AppArchitect.ts     # AI-powered app design: natural language → AppSpec JSON
    ProjectGenerator.ts # Topological code generation with per-file dependency context
    MavenResolver.ts    # Maven Central JAR/AAR dependency resolver with caching
    TestRunner.ts       # On-device E2E test runner via accessibility service
    TaskExecutor.ts     # 20 capability executors (file, contacts, SMS, build, test, app control, deps, genome)
    CapabilityRegistry.ts  # Capability definitions with risk levels (20 capabilities)
    PermissionBroker.ts    # Device permission management
    AgentBus.ts         # Inter-agent message bus
    TaskGraph.ts        # Dependency-aware task graph
    TaskAgent.ts        # Individual AI agent
    DebugEngine.ts      # Self-healing debug loop
    Orchestrator.ts     # Multi-agent swarm orchestration
  security/
    SecureVault.ts      # expo-secure-store wrapper
    BiometricGate.ts    # Biometric authentication
  services/
    ConversationManager.ts  # Persistent chat storage (native/web/memory)
    ExecutionLedger.ts      # Event sourcing + idempotency + autonomy budget
    CostTracker.ts      # API cost tracking per call/task/day
    StorageManager.ts   # File system management with budget
    BackgroundTaskManager.ts  # Background task scheduling
  genome/
    types.ts            # Genome type system (Genome, Capability, MutationRecord, FitnessMetrics, etc.)
    GenomeFactory.ts    # Default genome creation (17 capabilities, safety invariants)
    GenomeCompiler.ts   # Genome → source files (template resolution, AI behavioral code gen)
    GenomeValidator.ts  # Safety invariant validation, dependency graph checks
    GenomeMutator.ts    # AI-driven mutation engine (10 mutation operations)
    GenomeFitness.ts    # Weighted composite fitness scoring (0-100)
    GenomeLineage.ts    # Hash chain ancestry tracking, lineage verification
    SelfImprover.ts     # Evolution loop orchestrator (analyze → mutate → compile → build → evaluate)
    templates/
      BuildTemplates.ts   # Fixed build infrastructure Java sources (9 entries)
      AgentTemplates.ts   # Handlebars-style Java templates for agent classes
      GenomeTemplates.ts  # Java templates for GenomeManager + GenomeCompilerNative
  utils/
    Logger.ts           # Multi-level logging with file persistence
    PreferenceLearner.ts  # Pattern learning and user preferences
    crypto.ts           # Hash utility (expo-crypto SHA-256 on native, fallback on web)
  native/
    AgentNative.ts      # Native build module TypeScript interface (writeFile, compileJava, convertToDex, packageApk, signApk, installApk, exec)
    AppController.ts    # Accessibility service TypeScript interface (screen reading, click, scroll, type, back, home)

plugins/
  withAgentNative.js    # Config plugin — injects 7 Java classes at EAS build time:
                        #   AgentNativeModule (build pipeline bridge)
                        #   AgentNativePackage (module registration)
                        #   BinaryManifestWriter (AXML format AndroidManifest)
                        #   ApkPackager (ZIP-aligned APK assembly)
                        #   ApkSignerV1 (real JAR/V1 signing with RSA-2048 + PKCS#7)
                        #   AgentAccessibilityService (UI automation)
                        #   AccessibilityBridgeModule (React Native bridge for a11y)

server/                 # Express backend
```

## Build Pipeline

Full self-replicating build pipeline:
1. **SPECIFY** — AppArchitect generates AppSpec from natural language
2. **PLAN** — Topological file ordering, dependency resolution
3. **RESOLVE DEPS** — MavenResolver downloads JARs from Maven Central
4. **GENERATE** — ProjectGenerator creates each file with context from dependencies
5. **SCAFFOLD** — Write all files to device filesystem
6. **COMPILE** — ECJ Java compiler via dalvikvm with multi-source support
7. **DEBUG LOOP** — Parse errors per-file, AI-fix, recompile (max 4 iterations per file, 3 global retries)
8. **DEX** — D8/R8 conversion to Dalvik bytecode
9. **PACKAGE** — Binary AXML manifest + ZIP-aligned APK assembly
10. **SIGN** — Real V1 JAR signing (SHA-256 digests, PKCS#7 SignedData, self-signed RSA-2048 cert)
11. **INSTALL** — FileProvider intent to system installer
12. **TEST** — Optional E2E testing via accessibility service

## Native Module (AgentNativeModule)

7 Java classes injected by config plugin:
- **AgentNativeModule**: `writeFile`, `compileJava(ReadableArray sourcePaths)`, `convertToDex(classDir, outputDir, extraClasspath)`, `packageApk(projectDir, packageName, ...)`, `signApk(unsignedPath)`, `installApk`, `exec` (with command allowlist + audit log), `getStorageInfo`
- **BinaryManifestWriter**: Encodes AndroidManifest.xml in AXML binary format (string pool, resource IDs, namespace chunks, typed attributes)
- **ApkPackager**: ZIP with STORED entries and CRC32 for alignment
- **ApkSignerV1**: Real V1 signing — BKS keystore with RSA-2048, SHA-256 digests in MANIFEST.MF/CERT.SF, DER-encoded PKCS#7 in CERT.RSA
- **AgentAccessibilityService**: UI tree capture, click/scroll/type/back/home, package allowlist
- **AccessibilityBridgeModule**: React Native bridge (getName = "AppController")
- **AgentNativePackage**: Registers both modules

## Shell Exec Safety

- Command allowlist: `dalvikvm`, `keytool`, `ls`, `mkdir`, `cp`, `cat`, `chmod`, `find`
- Blocked metacharacters: `;`, `|`, `&&`, `||`, `$(`, backtick
- Audit log: every exec call logged to `exec_audit.log` with timestamp and status
- Client-side validation in AgentNative.ts mirrors native allowlist

## Capabilities (20)

| ID | Risk | Description |
|---|---|---|
| file_read | safe | Read files from device storage |
| file_write | moderate | Write files to device storage |
| file_delete | dangerous | Delete files |
| file_organize | moderate | Move and organize files |
| contacts_read | sensitive | Read device contacts |
| sms_send | dangerous | Send text messages |
| camera_capture | moderate | Take photos |
| media_access | safe | Access photos and videos |
| app_launch | safe | Open other installed apps |
| app_share | safe | Share data between apps |
| code_generate | safe | Generate source code via AI |
| app_build | moderate | Compile Android APK on device |
| app_install | dangerous | Install built APK |
| network_request | moderate | Make HTTP requests |
| ai_query | safe | Query AI for assistance |
| dependency_resolve | moderate | Download Maven/JAR dependencies |
| app_control | dangerous | Control other apps via accessibility |
| app_test | moderate | Run E2E tests on built apps |
| self_modify | dangerous | Evolve own genome via mutation and fitness evaluation |
| self_replicate | dangerous | Compile genome into offspring APK |

## Agent Core Loop (9 Steps)

1. **INGEST** — Receive input, log intake event, save user message to conversation
2. **ROUTE** — Classify as command/conversation/ai_instruction
3. **PLAN** — Deterministic CommandParser tries first; falls back to AI with strict JSON schema
4. **VERIFY** — SafetyChecker scans for dangerous patterns, validates scope, classifies risk
5. **APPROVE** — Budget check via ExecutionLedger; dangerous actions require user approval; model switch recommendations shown to user
6. **EXECUTE** — TaskExecutor runs with pre-validated params; idempotency prevents duplicates; build pipeline streams progress
7. **VERIFY_RESULT** — SafetyChecker.verifyResult checks output correctness
8. **WRITE_MEMORY** — Save assistant message with PromptTrace to ConversationManager
9. **ADAPT** — PreferenceLearner records outcome for future routing

## Key Features

- **Venice API**: All AI calls go through Venice API. User enters their own key in Settings. Default model: llama-3.3-70b (configurable in Settings model picker).
- **Self-Replication**: Can design, compile, sign, and install apps as complex as itself
- **Von Neumann Genome**: Self-evolving genome system — mutation, validation, fitness evaluation, lineage tracking, and SelfImprover evolution loop. Offspring carry their own genome and can reproduce further.
- **AppSpec Architecture**: Rich build specification with file dependency ordering, activities, theme, Maven dependencies
- **Programmatic UI Only**: No XML layouts (no aapt2/R.java) — all views built in code
- **Real APK Signing**: V1 JAR signing with RSA-2048 keypair, SHA-256 digests, PKCS#7 SignedData
- **Binary Manifest**: Custom AXML writer for AndroidManifest.xml
- **Maven Dependencies**: Download JARs/AARs from Maven Central with caching
- **App Control**: Accessibility service for UI automation of other apps
- **E2E Testing**: AI-generated test plans executed via accessibility service
- **Model Selection**: Settings screen has a model picker that discovers all available Venice models
- **Deterministic Command Parser**: Pattern-matches obvious commands directly to capabilities without calling AI
- **Safety System**: Dangerous pattern scanning, scope validation, risk classification, shell exec hardening
- **Execution Ledger**: Immutable event log with idempotency keys, session budget tracking
- **Prompt Tracing**: Every AI response carries a PromptTrace viewable in the UI
- **Build Progress**: Real-time phase indicators in chat UI during builds
- **Conversation Persistence**: Auto-save, multiple conversations, titles from first message

## Build for APK

```bash
npx eas build --platform android --profile preview
```

Profiles defined in `eas.json`:
- `development`: Dev client APK
- `preview`: Internal distribution APK
- `production`: Release APK

## Environment

- Frontend: port 8081 (Expo dev server)
- Backend: port 5000 (Express)
- No external API keys needed in env — user provides Venice API key in-app

## EAS Build Configuration

- `newArchEnabled: true` (react-native-reanimated v4 + react-native-worklets require New Architecture)
- `compileSdkVersion: 35`, `targetSdkVersion: 35`, `minSdkVersion: 26`
- All expo packages aligned to SDK 54 compatible versions
- SafeAreaProvider wraps entire app in _layout.tsx
- Font loading is failure-safe
- AgentNative has null-safety fallback (noop when native module unavailable)
- AgentCore initialization is defensive (safeInit wrappers per subsystem)
- Custom SimpleEmitter replaces Node.js `events` module

## Adaptations from Original Source

- `axios` replaced with native `fetch` (Expo Go compatible)
- `lottie-react-native` replaced with React Native Animated API
- `scrollToEnd` replaced with inverted FlatList
- Emoji characters replaced with @expo/vector-icons (Ionicons, MaterialCommunityIcons)
- ConversationManager uses three storage modes: native (expo-file-system), web (localStorage), memory (fallback)
- ExecutionLedger persists via expo-file-system (native) or localStorage (web)

## Critical Notes

- `AppController.ts` uses `NativeModules.AppController` — matching `AccessibilityBridgeModule.getName()` return value
- `AgentNative.ts` `compileJava` takes `string[]` sourcePaths (ReadableArray on native side)
- `signApk` takes only `unsignedPath` (returns signed path)
- `packageApk` takes structured args (projectDir, packageName, appName, versionCode, etc.)
- AppArchitect enforces programmatic-only UI in all prompts
- Build tools: ECJ (ecj.jar) + D8/R8 (r8-8.2.47.jar) downloaded on first build

# Agent Ultra

Autonomous AI agent app for Android with Venice API integration, multi-agent swarm orchestration, on-device APK compilation, and self-healing debug engine.

## Architecture

- **Frontend**: Expo (React Native) with file-based routing (expo-router)
- **Backend**: Express.js serving APIs on port 5000
- **AI Provider**: Venice API (user provides their own API key via Settings)
- **Target**: Standalone Android APK via EAS Build

## Directory Structure

```
app/                    # Expo Router screens
  _layout.tsx           # Root layout (biometric gate, Stack nav, dark theme)
  index.tsx             # Chat screen (main UI, full 9-step agent integration)
  settings.tsx          # Settings (API key, cost limits, logs)

components/
  ConversationList.tsx  # Modal conversation list (create, switch, delete)
  PromptViewer.tsx      # Modal prompt trace viewer (read-only)
  ErrorBoundary.tsx     # Error boundary with reload

src/
  types/
    ultra.ts            # Shared type definitions (ChatMessage, ActionPlan, PromptTrace, etc.)
  core/
    AgentCore.ts        # Main brain - 9-step autonomous loop (INGEST→ROUTE→PLAN→VERIFY→APPROVE→EXECUTE→VERIFY_RESULT→WRITE_MEMORY→ADAPT)
    ModelRouter.ts      # Venice API integration with context-aware model recommendations
    CommandParser.ts    # Deterministic command parser (pattern-matches before AI)
    SafetyChecker.ts    # Safety verification (dangerous patterns, scope validation, risk classification)
    CapabilitySchemas.ts # Tool contract schemas with validation
    BuildSystem.ts      # On-device APK compilation pipeline
    TaskExecutor.ts     # 15 capability executors (supports pre-validated params via runWithPlan)
    CapabilityRegistry.ts  # Capability definitions with risk levels
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
  utils/
    Logger.ts           # Multi-level logging with file persistence
    PreferenceLearner.ts  # Pattern learning and user preferences
  native/
    AgentNative.ts      # Native module TypeScript interface

plugins/
  withAgentNative.js    # Config plugin (injects Java native module at EAS build time)

server/                 # Express backend
```

## Agent Core Loop (9 Steps)

1. **INGEST** — Receive input, log intake event, save user message to conversation
2. **ROUTE** — Classify as command/conversation/ai_instruction
3. **PLAN** — Deterministic CommandParser tries first; falls back to AI with strict JSON schema
4. **VERIFY** — SafetyChecker scans for dangerous patterns, validates scope, classifies risk
5. **APPROVE** — Budget check via ExecutionLedger; dangerous actions require user approval; model switch recommendations shown to user
6. **EXECUTE** — TaskExecutor runs with pre-validated params; idempotency prevents duplicates
7. **VERIFY_RESULT** — SafetyChecker.verifyResult checks output correctness
8. **WRITE_MEMORY** — Save assistant message with PromptTrace to ConversationManager
9. **ADAPT** — PreferenceLearner records outcome for future routing

## Key Features

- **Venice API**: All AI calls go through Venice API. User enters their own key in Settings. Default model: llama-3.3-70b (configurable in Settings model picker).
- **Model Selection**: Settings screen has a model picker that discovers all available Venice models and lets user choose. Selection persists across restarts via SecureVault.
- **Deterministic Command Parser**: Pattern-matches obvious commands ("open Chrome", "send text to Mom") directly to capabilities WITHOUT calling AI. Falls back to AI only when needed.
- **Three Interaction Modes**: command (action pipeline), conversation (AI chat), ai_instruction (meta-instructions for AI)
- **Safety System**: Dangerous pattern scanning, scope validation, risk classification (safe/moderate/dangerous/blocked), result verification
- **Execution Ledger**: Immutable event log with idempotency keys, session budget tracking (max actions, max cost, max high-risk ops)
- **Tool Contract Schemas**: Every capability has a formal JSON schema; plans validated before execution
- **Prompt Tracing**: Every AI response carries a PromptTrace viewable in the UI
- **Visual Distinction**: Ultra messages (green, robot icon, "ULTRA" label) vs AI messages (blue, sparkles icon, "AI" label)
- **Conversation Persistence**: Auto-save, multiple conversations, titles from first message, conversation list with CRUD
- **Context Management**: Token-aware context building, automatic summarization of older messages
- **Model Recommendations**: Context-aware scoring with user approval flow (never silent switches)
- **Native Build System**: AgentNative Java module for on-device Java compilation, DEX conversion, APK packaging
- **Multi-Agent Swarm**: Orchestrator decomposes complex tasks into parallel subtasks
- **Self-Healing Debug**: DebugEngine runs iterative fix loops on failed compilations
- **Cost Tracking**: Per-call cost recording with daily and per-task budget limits
- **Biometric Auth**: Optional biometric gate on app launch
- **Request Timeout**: All Venice API calls have 60-second AbortController timeout

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

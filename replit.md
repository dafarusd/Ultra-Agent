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
  index.tsx             # Chat screen (main UI)
  settings.tsx          # Settings (API key, cost limits, logs)

src/
  core/
    AgentCore.ts        # Main brain - ties all systems together
    ModelRouter.ts      # Venice API integration (fetch-based)
    BuildSystem.ts      # On-device APK compilation pipeline
    TaskExecutor.ts     # 15 capability executors
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

## Key Features

- **Venice API**: All AI calls go through Venice API. User enters their own key in Settings.
- **Native Build System**: AgentNative Java module for on-device Java compilation, DEX conversion, APK packaging. Requires EAS Build (not Expo Go).
- **Multi-Agent Swarm**: Orchestrator decomposes complex tasks into parallel subtasks executed by independent TaskAgents via AgentBus.
- **Self-Healing Debug**: DebugEngine runs iterative fix loops on failed compilations, learning from past fixes.
- **Cost Tracking**: Per-call cost recording with daily and per-task budget limits.
- **Background Tasks**: expo-background-fetch for periodic background execution.
- **Biometric Auth**: Optional biometric gate on app launch.

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

## Adaptations from Original Source

- `axios` replaced with native `fetch` (Expo Go compatible)
- `lottie-react-native` replaced with React Native Animated API
- `scrollToEnd` replaced with inverted FlatList
- Emoji characters replaced with @expo/vector-icons (Ionicons, MaterialCommunityIcons)
- Missing `Platform` import added to settings screen

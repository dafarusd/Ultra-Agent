import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Platform,
  Alert,
  Modal,
  TouchableWithoutFeedback,
  Image,
  Share,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppStorage } from "@/src/utils/AppStorage";
import * as Clipboard from "expo-clipboard";
import * as Device from 'expo-device';
import NetInfo from '@react-native-community/netinfo';
import { useRouter, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { SecureVault } from "@/src/security/SecureVault";
import { UltraDevLog as DebugLog, UltraDevLog } from "@/src/utils/UltraDevLog";
import { classifyModelType } from "@/src/utils/classifyModelType";
import { AgentCore, setAgentCoreInstance } from "@/src/core/AgentCore";
import { BiometricGate } from "@/src/security/BiometricGate";
import type { ExecuteArgs } from "@/src/core/AgentCore";
import type { ChatMessage, UltraExecutionResult, ConversationMeta, PromptTrace } from "@/src/types/ultra";
import ConversationList from "@/components/ConversationList";
import PromptViewer from "@/components/PromptViewer";
import ActionMenu, { ActionMenuItem } from "@/components/ActionMenu";
import ModelPickerSheet, { PickerModel } from "@/components/ModelPickerSheet";
import PlusMenu, { ActionType } from "@/components/PlusMenu";
import ActionGrid from "@/components/ActionGrid";
import ZoneEditor from "@/components/ZoneEditor";
import { ZoneConfig, loadZoneConfig } from "@/src/data/ZoneConfig";
import ContextBar from "@/components/ContextBar";
import TaskBuilder from "@/components/TaskBuilder";
import SystemInfoCard from "@/components/SystemInfoCard";
import OnboardingScreen from "@/components/OnboardingScreen";
import type { TaskTemplate, TaskStep, TaskRunResult } from "@/src/types/actionGrid";
import type { ActionPlan } from "@/src/types/ultra";
import { DEFAULT_CATEGORIES } from "@/src/data/defaultGrid";

// ── Color Palette (softened green accent) ──────────────
const ACCENT = "#e5e5e5";       // clean near-white (Claude/ChatGPT style)
const BG = "#000000";
const SURFACE = "#111111";
const SURFACE2 = "#1a1a1a";
const DIM = "#666666";
const AI_COLOR = "#6bc5ff";
const ULTRA_COLOR = ACCENT;
const WARN_COLOR = "#ff6600";
const BLOCKED_COLOR = "#ff4444";

// ── 3-dot menu items ───────────────────────────────────
function getHeaderMenuItems(starred: boolean): ActionMenuItem[] {
  return [
    { id: "rename", label: "Rename", icon: "create-outline" },
    { id: "star", label: starred ? "Unstar" : "Star", icon: starred ? "star" : "star-outline", disabled: false },
    { id: "build_task", label: "Build a Task", icon: "construct-outline" },
    { id: "add_home", label: "Add to home", icon: "home-outline", disabled: true },
    { id: "delete", label: "Delete", icon: "trash-outline", destructive: true },
    { id: "new_chat", label: "New chat", icon: "add-circle-outline" },
  ];
}

// ── Activity icon helper ───────────────────────────────
function getActivityIcon(status: string, buildPhase: string | null, genomePhase: string | null): {
  name: string; family: "ionicons" | "material"; color: string;
} {
  if (buildPhase || (status.toLowerCase().includes("build"))) {
    return { name: "hammer-wrench", family: "material", color: "#ffaa00" };
  }
  if (genomePhase) {
    if (genomePhase.includes("testing") || genomePhase.includes("task")) return { name: "test-tube", family: "material", color: "#ff9900" };
    if (genomePhase.includes("fitness") || genomePhase.includes("Computing")) return { name: "chart-line", family: "material", color: "#00ccff" };
    return { name: "dna", family: "material", color: "#bb66ff" };
  }
  if (status.toLowerCase().includes("image") || status.toLowerCase().includes("generat")) {
    return { name: "palette", family: "material", color: "#f472b6" };
  }
  if (status.toLowerCase().includes("code") || status.toLowerCase().includes("compil")) {
    return { name: "code-braces", family: "material", color: "#60a5fa" };
  }
  if (status.toLowerCase().includes("video")) {
    return { name: "video", family: "material", color: "#fb923c" };
  }
  // Default: thinking/brain
  return { name: "brain", family: "material", color: "#c084fc" };
}

// ── Main Screen ────────────────────────────────────────
export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  useEffect(() => {
    UltraDevLog.setCurrentScreen('ChatScreen');
    loadZoneConfig().then(zc => {
      setZoneConfig(zc);
      UltraDevLog.push('EFFECT', {
        component: 'ChatScreen', action: 'zone_config_loaded',
        favCount: zc.favorites.length, gridCats: zc.grid.length,
        sidebarCount: zc.sidebar.length, success: true,
      });
    });
    return () => UltraDevLog.setCurrentScreen('unknown');
  }, []);

  // Onboarding & biometric lock
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [isAppLocked, setIsAppLocked] = useState(false);
  const biometricGateRef = useRef<BiometricGate | null>(null);

  // Core state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState("Initializing...");
  const [agentCore, setAgentCore] = useState<AgentCore | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState("Agent Ultra");
  const [conversationStarred, setConversationStarred] = useState(false);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);

  // UI panel state
  const [convListVisible, setConvListVisible] = useState(false);
  const [promptViewerVisible, setPromptViewerVisible] = useState(false);
  const [selectedTrace, setSelectedTrace] = useState<PromptTrace | null>(null);
  const [headerMenuVisible, setHeaderMenuVisible] = useState(false);
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [modelPickerInitialFilter, setModelPickerInitialFilter] = useState<"all" | "text" | "image" | "code" | "reasoning" | "video">("all");
  const [plusMenuVisible, setPlusMenuVisible] = useState(false);

  // Current mode & replay
  const [currentMode, setCurrentMode] = useState<ActionType>("chat");
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [contextBarDismissed, setContextBarDismissed] = useState(false);
  const [pendingImage, setPendingImage] = useState<{ uri: string; base64: string; mimeType: string } | null>(null);
  const [pendingReplay, setPendingReplay] = useState<{
    userInput: string;
    type: "approval";
  } | null>(null);

  // Build/genome progress
  const [buildPhase, setBuildPhase] = useState<string | null>(null);
  const [genomePhase, setGenomePhase] = useState<string | null>(null);

  // Copy feedback
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Expanded long messages
  const [expandedMsgs, setExpandedMsgs] = useState<Set<string>>(new Set());

  // Action Grid / Task Builder
  const [gridCollapsed, setGridCollapsed] = useState(true);
  const [zoneEditorVisible, setZoneEditorVisible] = useState(false);
  const [zoneConfig, setZoneConfig] = useState<ZoneConfig | null>(null);
  const [taskBuilderVisible, setTaskBuilderVisible] = useState(false);
  const [savedTasks, setSavedTasks] = useState<TaskTemplate[]>([]);

  const inputRef = useRef<TextInput>(null);
  const pulseAnim = useRef(new Animated.Value(0.3)).current;
  
  const scrollOffsetRef = useRef(0);
  const listHeightRef = useRef(0);
  const initGuardRef = useRef(false);
  const agentCoreRef = useRef<AgentCore | null>(null);
  const netInfoUnsubscribeRef = useRef<(() => void) | null>(null);
  const diagIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Pulse animation for status dot ─────────────────
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0.3, duration: 1000, useNativeDriver: true }),
      ])
    ).start();
  }, [pulseAnim]);

  // ── Force grid layout reset on v5.1 upgrade ───────
  useEffect(() => {
    AppStorage.get('grid_config_version').then(v => {
      if (v !== '5.1') {
        AppStorage.remove('action_grid_config');
        AppStorage.set('grid_config_version', '5.1');
      }
    });
  }, []);

  // ── Load saved tasks from storage ──────────────────
  useEffect(() => {
    AppStorage.get('task_templates').then(raw => {
      if (raw) { try { setSavedTasks(JSON.parse(raw)); } catch (e: any) { DebugLog.uiError('task_templates_parse', e?.message || 'invalid JSON'); } }
    });
  }, []);

  // ── Data loaders ───────────────────────────────────
  const reloadMessages = useCallback(async (core: AgentCore, convId: string) => {
    const cm = core.getConversationManager();
    const conv = await cm.loadConversation(convId);
    if (conv) {
      setMessages([...conv.messages].reverse());
      setConversationTitle(conv.title);
      setConversationStarred(!!conv.meta?.starred);
    } else {
      setMessages((prev) => prev.filter((m) => !m.id.startsWith("optimistic_")));
    }
  }, []);

  const refreshConversations = useCallback(async (core: AgentCore) => {
    const cm = core.getConversationManager();
    const list = await cm.listConversations();
    setConversations(list);
  }, []);

  // ── State ref for stale-closure-safe snapshots ────
  const uiStateRef = useRef<Record<string, unknown>>({});
  useEffect(() => {
    uiStateRef.current = {
      currentMode,
      activeModelId,
      isProcessing,
      conversationId,
      messageCount: messages.length,
      modelsLoaded: agentCore?.getAvailableModels()?.length ?? 0,
      hasApiKey: agentCore?.hasApiKey() ?? false,
      status,
      buildPhase,
      genomePhase,
      pendingReplay: !!pendingReplay,
      pickerVisible: modelPickerVisible,
      plusMenuVisible: plusMenuVisible,
      convListVisible: convListVisible,
    };
  });

  const snapUI = useCallback((label: string, extras?: Record<string, unknown>) => {
    DebugLog.uiState(label, { ...uiStateRef.current, ...extras });
  }, []);

  // ── N1: Component Lifecycle Sensor ────────────────
  const compIdRef = useRef('');
  useEffect(() => {
    compIdRef.current = UltraDevLog.componentMount('ChatScreen');
    return () => UltraDevLog.componentUnmount('ChatScreen', compIdRef.current);
  }, []);

  // ── V5 Fix 13: Proactive suggestion tracking ──────
  // suggestions[] is populated by ProactiveEngine via agentCore callback (wired in V3)
  const [suggestions, setSuggestions] = useState<Array<{
    id: string;
    title: string;
    body?: string;
    urgency?: string;
    suggestedCommand?: string;
    confidence?: number;
  }>>([]);
  const visibleSuggestionIds = useRef<Set<string>>(new Set());

  // Expire suggestions older than 1 hour and log each expiry
  useEffect(() => {
    if (suggestions.length === 0) return;
    const timer = setInterval(() => {
      setSuggestions(prev => {
        const now = Date.now();
        const expired = prev.filter(s => {
          const age = now - parseInt(s.id.split('_')[1] || '0', 10);
          return age > 3_600_000;
        });
        if (expired.length > 0) {
          for (const s of expired) {
            const wasVisible = visibleSuggestionIds.current.has(s.id);
            UltraDevLog.push('PROACTIVE_SUGGEST' as any, {
              event: 'suggestion_expired',
              suggestionId: s.id,
              title: s.title,
              wasVisible,
              wasDismissed: false,
              wasActed: false,
            });
            visibleSuggestionIds.current.delete(s.id);
          }
          return prev.filter(s => !expired.includes(s));
        }
        return prev;
      });
    }, 60_000);
    return () => clearInterval(timer);
  }, [suggestions.length]);

  // ── AppState Lifecycle Sensor + A11y Health Monitor ─
  useEffect(() => {
    UltraDevLog.installAppStateListener();
    UltraDevLog.startA11yDrain();
    UltraDevLog.startHeartbeat();

    const { AppState } = require('react-native');
    const healthSub = AppState.addEventListener('change', async (nextState: string) => {
      if (nextState === 'active' && agentCore) {
        try {
          const AppCtrl = (await import('@/src/native/AppController')).default;
          const { NativeModules: NM } = require('react-native');

          // Detailed a11y health check: distinguish frozen vs actually dead
          let a11yStatus = 'unknown';
          let a11yDetail = '';
          try {
            const isEnabled = await AppCtrl.isServiceEnabled();
            const a11yState = await NM.AppController?.getA11yServiceState?.();

            if (!isEnabled) {
              a11yStatus = 'disabled';
              a11yDetail = 'Accessibility service is disabled — re-enable in Settings';
              DebugLog.error('HealthMonitor', 'Accessibility service disabled');
            } else if (a11yState && a11yState.eventAgeSec > 120) {
              a11yStatus = 'frozen';
              a11yDetail = `Accessibility service frozen — no events for ${Math.round(a11yState.eventAgeSec)}s. Toggle it off/on in Settings.`;
              DebugLog.error('HealthMonitor', `Accessibility service frozen: eventAge=${Math.round(a11yState.eventAgeSec)}s lastPkg=${a11yState.lastEventPkg}`);
            } else {
              a11yStatus = 'active';
            }

            UltraDevLog.push('A11Y_STATE', {
              state: a11yState?.state || 'unknown',
              eventAgeSec: Math.round(a11yState?.eventAgeSec || -1),
              lastEventPkg: a11yState?.lastEventPkg || '',
              healthStatus: a11yStatus,
            });
          } catch {}

          if (a11yStatus === 'disabled' || a11yStatus === 'frozen') {
            setStatus(`⚠ ${a11yDetail}`);
            try {
              const { DebugScreenshots } = await import('@/src/services/DebugScreenshots');
              await DebugScreenshots.capture(a11yStatus === 'frozen' ? 'a11y_frozen' : 'a11y_disabled');
            } catch {}
          }
        } catch {}

        // A11y lifecycle: logged above in detailed health check block

        // A11y current status from dumpsys (live confirmation)
        try {
          const { DeviceDiagnostics } = await import('@/src/services/DeviceDiagnostics');
          await DeviceDiagnostics.logA11yStatus();
        } catch {}
      }
    });

    return () => {
      UltraDevLog.removeAppStateListener();
      UltraDevLog.stopA11yDrain();
      UltraDevLog.stopHeartbeat();
      healthSub.remove();
    };
  }, [agentCore]);

  // ── Render performance monitor ─────────────────────
  useEffect(() => {
    let frameCount = 0;
    let lastCheck = Date.now();
    const interval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastCheck;
      if (elapsed > 0) {
        const fps = Math.round((frameCount / elapsed) * 1000);
        if (fps < 30) {
          UltraDevLog.push('RENDER_PERF', { fps, frameCount, elapsed, warning: 'low_fps' });
        }
      }
      frameCount = 0;
      lastCheck = now;
    }, 5000);

    const frameCallback = () => {
      frameCount++;
      requestAnimationFrame(frameCallback);
    };
    requestAnimationFrame(frameCallback);

    return () => clearInterval(interval);
  }, []);

  // ── Init ───────────────────────────────────────────
  useEffect(() => {
    async function init() {
      if (initGuardRef.current) return;
      initGuardRef.current = true;
      UltraDevLog.checkProcessRestart();
      DebugLog.uiInit("start", "Beginning app initialization");

      try {
        const { Dimensions: Dims } = require('react-native');
        const win = Dims.get('window');
        UltraDevLog.deviceInfo({
          os: Platform.OS,
          osVersion: String(Platform.Version),
          model: Device.modelName ?? 'unknown',
          screenWidth: Math.round(win.width),
          screenHeight: Math.round(win.height),
          totalMemory: Device.totalMemory ?? undefined,
        });
      } catch (diErr: any) {
        UltraDevLog.push('INIT_CHECKPOINT', { point: 'device_info_failed', error: diErr?.message });
      }

      try {
        NetInfo.fetch().then(state => {
          UltraDevLog.networkStatus(!!state.isConnected, state.type);
        }).catch(() => {});
        netInfoUnsubscribeRef.current = NetInfo.addEventListener(state => {
          UltraDevLog.networkStatus(!!state.isConnected, state.type, state.isConnected ? undefined : 'WARN: went offline');
        });
      } catch (netErr: any) {
        UltraDevLog.push('INIT_CHECKPOINT', { point: 'netinfo_failed', error: netErr?.message });
      }

      try {
        const vault = await SecureVault.initialize();
        DebugLog.uiInit("vault", "SecureVault initialized");

        // ── Version-based SecureStore reset ──
        // Expo SecureStore persists across uninstalls on Android.
        // When the app versionCode changes, clear stale state so a
        // fresh install or upgrade behaves like a true first launch.
        try {
          const Constants = require('expo-constants').default;
          const currentVersionCode = String(Constants.expoConfig?.android?.versionCode || '0');
          const storedVersionCode = await vault.get('installed_version_code');
          if (storedVersionCode !== currentVersionCode) {
            const RESET_ON_UPGRADE = [
              'onboarding_done',
              'battery_optim_prompted',
              'dev_mode_enabled',
              'user_tier',
              'tier_usage_today',
              'grid_config_version',
            ];
            for (const key of RESET_ON_UPGRADE) {
              try { await vault.delete(key); } catch {}
            }
            for (const key of RESET_ON_UPGRADE) {
              try { await AsyncStorage.removeItem(key); } catch {}
            }
            await vault.set('installed_version_code', currentVersionCode);
            UltraDevLog.push('VERSION_RESET', {
              previous: storedVersionCode || '(none)',
              current: currentVersionCode,
              clearedKeys: RESET_ON_UPGRADE,
              note: 'Stale SecureStore keys cleared for fresh-install experience',
            });
          }
        } catch (vErr: any) {
          UltraDevLog.push('VERSION_RESET', { error: vErr?.message, note: 'WARN: version check failed' });
        }

        // ── Migrate AsyncStorage → Vault (one-time per session) ──
        // AsyncStorage doesn't survive process kills on Samsung.
        // SecureVault (Expo SecureStore) does. Move critical keys.
        const MIGRATE_KEYS = [
          'action_grid_config',
          'preferred_model', 'dev_mode_enabled', 'onboarding_done',
          'battery_optim_prompted', 'user_folders', 'task_templates',
          'grid_config_version',
        ];
        for (const key of MIGRATE_KEYS) {
          try {
            const vaultVal = await vault.get(key);
            if (vaultVal) continue;
            const asVal = await AsyncStorage.getItem(key);
            if (asVal) {
              await vault.set(key, asVal);
              UltraDevLog.push('STORAGE_MIGRATE', { key, from: 'async', to: 'vault', size: asVal.length });
            }
          } catch {}
        }

        const core = new AgentCore(vault, (msg: string, type: string) => {
          setStatus(msg);
          if (type === "build_progress") setBuildPhase(msg);
          if (type === "genome_progress") setGenomePhase(msg);
        });
        await core.initialize();
        setAgentCore(core);
        agentCoreRef.current = core;
        setAgentCoreInstance(core);

        // Device diagnostics — automatic, no permissions needed
        const { DeviceDiagnostics } = await import('@/src/services/DeviceDiagnostics');
        // Full deep scan on init
        DeviceDiagnostics.runAll();
        DeviceDiagnostics.runDeep();
        // Core every 30s, deep every 5min
        diagIntervalRef.current = setInterval(() => { DeviceDiagnostics.runAll(); }, 30000);
        deepIntervalRef.current = setInterval(() => { DeviceDiagnostics.runDeep(); }, 300000);

        // Start foreground service to prevent process kill
        try {
          const AppCtrl = (await import('@/src/native/AppController')).default;
          await AppCtrl.startBackgroundService();
          DebugLog.systemEvent('ForegroundService', 'Background service started');
        } catch (bgErr: any) {
          DebugLog.error('ForegroundService', `Failed to start: ${bgErr?.message}`);
        }
        const modelsAvailable = core.getAvailableModels()?.length ?? 0;
        DebugLog.uiInit("agentCore", "AgentCore initialized, default model: " + core.getDefaultModel());
        DebugLog.modelState("post_init", { discoveredCount: modelsAvailable, defaultModel: core.getDefaultModel(), hasApiKey: core.hasApiKey() });

        setActiveModelId(core.getDefaultModel());
        setStatus("Ready");

        const cm = core.getConversationManager();
        let activeId = await cm.getMostRecentConversationId();
        if (!activeId) {
          const conv = await cm.createConversation();
          activeId = conv.id;
        }
        setConversationId(activeId);
        await reloadMessages(core, activeId);
        await refreshConversations(core);
        DebugLog.uiInit("complete", `Ready. Conv: ${activeId}, Model: ${core.getDefaultModel()}`);
        DebugLog.uiState("init_complete", {
          currentMode: "chat",
          activeModelId: core.getDefaultModel(),
          isProcessing: false,
          conversationId: activeId,
          modelsLoaded: modelsAvailable,
          hasApiKey: core.hasApiKey(),
          status: "Ready",
        });

        // First-launch onboarding
        const onboardingDone = await AppStorage.get("onboarding_done");
        if (!onboardingDone) setShowOnboarding(true);

        // Samsung-specific: prompt battery optimization exclusion
        const isSamsung = Device.manufacturer?.toLowerCase().includes('samsung') ?? false;
        if (isSamsung) {
          const batteryPromptDone = await AppStorage.get('battery_optim_prompted');
          if (!batteryPromptDone) {
            setTimeout(() => {
              Alert.alert(
                'Samsung Device Detected',
                'Samsung phones aggressively kill background apps. For Agent Ultra to work reliably, please disable battery optimization for this app.\n\nSettings → Apps → Agent Ultra → Battery → Unrestricted',
                [
                  { text: 'Open Settings', onPress: async () => {
                    try {
                      const { startActivityAsync } = await import('expo-intent-launcher');
                      await startActivityAsync(
                        'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
                        { data: 'package:com.agent.ultra' }
                      );
                    } catch {
                      const { Linking } = require('react-native');
                      Linking.openSettings();
                    }
                    AppStorage.set('battery_optim_prompted', '1');
                  }},
                  { text: 'Later', onPress: () => {
                    AppStorage.set('battery_optim_prompted', '1');
                  }},
                ]
              );
            }, 3000);
          }
        }

        // Biometric gate — load biometric_timeout (ms) override if set
        const gate = new BiometricGate();
        await gate.init(vault);
        const biometricTimeout = await vault.get('biometric_timeout').catch(() => null);
        if (biometricTimeout !== null) {
          const timeoutMs = parseInt(biometricTimeout, 10) || 0;
          const mins = Math.round(timeoutMs / 60000);
          if (mins !== gate.getLockTimeout()) await gate.setLockTimeout(mins);
        }
        biometricGateRef.current = gate;
        const authed = await gate.authenticateIfNeeded('Unlock Agent Ultra');
        setIsAppLocked(!authed);

        if (!core.hasApiKey()) {
          setStatus("Add AI provider in Settings → AI Providers");
        }

      } catch (err: any) {
        UltraDevLog.push('INIT_FATAL', { message: err?.message ?? 'Unknown', stack: (err?.stack ?? '').slice(0, 500) });
        DebugLog.uiError("init", err?.message ?? "Unknown init error");
        setStatus("Init failed: " + (err?.message ?? "unknown"));
      }
    }
    init();
  }, []);

  const lastFocusTime = useRef(0);
  const prevFocusDepsRef = useRef<Record<string, unknown> | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!agentCore) return;
      const deps = { agentCore: !!agentCore };
      UltraDevLog.focusEffectTriggered(deps, prevFocusDepsRef.current);
      prevFocusDepsRef.current = deps;
      const now = Date.now();
      if (now - lastFocusTime.current < 2000) {
        UltraDevLog.focusEffectSuppressed(now - lastFocusTime.current);
        return;
      }
      lastFocusTime.current = now;
      DebugLog.uiFocusEffect("triggered", currentMode, [], activeModelId);
      snapUI("focus_effect");
      agentCore.refreshApiKey().then(() => {
        if (agentCore.hasApiKey()) setStatus("Ready");
        const engineDefault = agentCore.getDefaultModel();
        if (engineDefault && !activeModelId) {
          setActiveModelId(engineDefault);
        }
      });
    }, [agentCore])
  );


  useEffect(() => {
    return () => {
      netInfoUnsubscribeRef.current?.();
      netInfoUnsubscribeRef.current = null;
      if (diagIntervalRef.current) clearInterval(diagIntervalRef.current);
      if (deepIntervalRef.current) clearInterval(deepIntervalRef.current);
      diagIntervalRef.current = null;
      deepIntervalRef.current = null;
      try {
        agentCoreRef.current?.destroy('ChatScreen unmount');
      } catch {}
      agentCoreRef.current = null;
      setAgentCoreInstance(null);
      initGuardRef.current = false;
    };
  }, []);

  // ── Result handler ─────────────────────────────────
  const handleResult = useCallback(
    async (result: UltraExecutionResult, core: AgentCore, convId: string) => {
      if (result.type === "approval_required") {
        setPendingReplay({ userInput: result.data?.replayUserInput || "", type: "approval" });
      }
      await reloadMessages(core, convId);
      await refreshConversations(core);
    },
    [reloadMessages, refreshConversations]
  );

  // ── Send message ───────────────────────────────────
  const handleSend = useCallback(async (overrideText?: string) => {
    const text = (overrideText || input).trim();
    if (!text || isProcessing || !agentCore || !conversationId) {
      UltraDevLog.push('CHAIN', { component: 'ChatScreen', action: 'send', trigger: {}, state: { hasText: !!text, isProcessing, hasCore: !!agentCore }, data: {}, outcome: 'EMPTY:guard_failed' });
      return;
    }
    UltraDevLog.push('CHAIN', { component: 'ChatScreen', action: 'send', trigger: {}, state: { isSlash: text.startsWith('/'), textLen: text.length }, data: {}, outcome: 'sending' });

    // ── Slash commands: handle locally ──
    if (text.startsWith('/')) {
      if (!overrideText) setInput('');
      const slashStart = Date.now();
      const cmd = text.toLowerCase().trim();
      let response = '';
      try {
        if (cmd === '/status') {
          let hb = { alive: false, foregroundPackage: 'unknown' };
          try {
            const AppCtrl = (await import('@/src/native/AppController')).default;
            hb = await AppCtrl.heartbeatPing();
          } catch {}
          const tier = agentCore.getTierService();
          const usage = tier.getUsage();
          const models = agentCore.getAvailableModels?.() || [];
          const costSummary = agentCore.getCostSummary?.() || { totalCost: 0, totalCalls: 0 };
          const now = new Date();
          response = [
            `━━ Agent Ultra Status ━━`,
            `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`,
            ``,
            `Accessibility: ${hb.alive ? '✓ Active' : '✗ OFF — enable in Settings'}`,
            `Foreground App: ${hb.foregroundPackage || 'unknown'}`,
            ``,
            `Tier: ${tier.getTier().toUpperCase()}`,
            `Messages Today: ${usage.messageCount} (${usage.aiCallCount} AI)`,
            `Session Spend: $${(costSummary as any).totalCost?.toFixed(4) || '0'}`,
            `Total Calls: ${(costSummary as any).totalCalls || 0}`,
            ``,
            `Models: ${models.length} available`,
            `Active: ${agentCore.getDefaultModel() || 'None'}`,
            `API: ${agentCore.hasApiKey() ? '✓ Connected' : '✗ No key'}`,
          ].join('\n');
        } else if (cmd === '/capabilities') {
          const caps = agentCore.getCapabilities?.() || [];
          response = `${caps.length} capabilities:\n${caps.map((c: any) => '• ' + c.id).join('\n')}`;
        } else if (cmd === '/models') {
          const models = agentCore.getAvailableModels?.() || [];
          const byType: Record<string, number> = {};
          models.forEach((m: any) => { byType[m.type] = (byType[m.type] || 0) + 1; });
          response = `${models.length} models:\n${Object.entries(byType).map(([t, c]) => '• ' + t + ': ' + c).join('\n')}`;
        } else if (cmd === '/cost') {
          const summary = agentCore.getCostSummary?.() || { totalCost: 0, totalCalls: 0 };
          response = `Usage: $${(summary as any).totalCost?.toFixed(4) || '0'} across ${(summary as any).totalCalls || 0} calls`;
        } else if (cmd === '/help') {
          response = 'Commands:\n• /status — System status\n• /capabilities — List capabilities\n• /models — Model counts by type\n• /cost — Usage summary\n• /help — This message';
        } else {
          response = 'Unknown: ' + cmd + '. Type /help';
        }
      } catch (e: any) { response = 'Error: ' + (e?.message || 'unknown'); }
      UltraDevLog.slashCommand(cmd, response, Date.now() - slashStart);
      const sysMsg: ChatMessage = {
        id: `msg_cmd_${Date.now()}`,
        role: 'assistant',
        content: response,
        createdAt: Date.now(),
        source: 'system' as any,
        meta: { mode: 'system' },
      };
      await agentCore.getConversationManager().addMessage(conversationId, sysMsg);
      await reloadMessages(agentCore, conversationId);
      return;
    }

    UltraDevLog.newRun();
    UltraDevLog.sendAttempt(text, currentMode, activeModelId || '', conversationId, messages.length, isProcessing);
    DebugLog.uiSendMessage(text.length, currentMode, activeModelId, isProcessing);
    snapUI("before_send");
    if (!overrideText) setInput("");
    setIsProcessing(true);
    setContextBarDismissed(false);
    UltraDevLog.processingState(true, 'handleSend_start');
    setStatus("Processing...");

    const optimisticId = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setMessages((prev) => [
      { id: optimisticId, role: "user" as const, content: text, createdAt: Date.now() } as ChatMessage,
      ...prev,
    ]);

    const _sendStart = Date.now();
    try {
      let result: UltraExecutionResult;

      if (pendingImage) {
        const imageData = pendingImage;
        setPendingImage(null);
        try {
          const visionResult = await agentCore.getModelRouter().completeWithVision(
            text || 'What do you see in this image?',
            imageData.base64,
            imageData.mimeType,
            { taskId: `vision_${Date.now().toString(36)}` }
          );
          const visionMsg: ChatMessage = {
            id: `msg_vision_${Date.now()}`,
            role: 'assistant',
            content: visionResult.content,
            createdAt: Date.now(),
            source: 'ultra',
            meta: { mode: 'vision', model: visionResult.model, cost: visionResult.cost },
          };
          await agentCore.getConversationManager().addMessage(conversationId, visionMsg);
          result = { type: 'action_result', message: visionResult.content, taskId: `vision_${Date.now().toString(36)}` };
        } catch (visionErr: any) {
          result = { type: 'error', message: `Vision failed: ${visionErr.message}`, taskId: '' };
        }
      } else {
        result = await agentCore.execute({ conversationId, userInput: text });
      }
      UltraDevLog.sendComplete(result?.taskId ?? '(unknown)', result?.success !== false, Date.now() - _sendStart, true, false);
      await handleResult(result, agentCore, conversationId);
    } catch (err: any) {
      UltraDevLog.error('handleSend', err?.message || 'unknown', err?.stack);
      const isAbort = err?.message?.includes("aborted") || err?.message?.includes("timed out");
      if (isAbort) {
        setStatus("Stopped");
      }
      await reloadMessages(agentCore, conversationId);
    } finally {
      setIsProcessing(false);
      UltraDevLog.processingState(false, 'handleSend_finally');
      setStatus("Ready");
      setBuildPhase(null);
      setGenomePhase(null);
    }
  }, [input, isProcessing, agentCore, conversationId, handleResult, reloadMessages, messages.length, currentMode, activeModelId]);

  // ── Gap 16G: Notification tap handler (proactive suggestion) ──────
  useEffect(() => {
    let notifSub: any;
    try {
      import('expo-notifications').then(Notifications => {
        notifSub = Notifications.addNotificationResponseReceivedListener(response => {
          const data = response.notification.request.content.data as any;
          if (data?.command) {
            handleSend(data.command as string);
          } else if (data?.suggestionId) {
            setSuggestions((prev: any[]) => {
              if (prev.some((s: any) => s.id === data.suggestionId)) return prev;
              return [...prev, {
                id: data.suggestionId as string,
                title: response.notification.request.content.title?.replace('💡 ', '') || '',
                body: response.notification.request.content.body || '',
                urgency: 'medium' as const,
                suggestedCommand: data.command as string | undefined,
              }];
            });
          }
        });
      }).catch(() => {});
    } catch {}
    return () => { try { notifSub?.remove(); } catch {} };
  }, [handleSend, setSuggestions]);

  // ── Quick reply handler ────────────────────────────
  const handleQuickReply = useCallback((prompt: string, messageContent: string) => {
    if (prompt === "__COPY_ERROR__") {
      Clipboard.setStringAsync(messageContent);
      return;
    }
    handleSend(prompt);
  }, [handleSend]);

  // ── Approval handlers ──────────────────────────────
  const handleApprove = useCallback(async () => {
    if (!agentCore || !conversationId || !pendingReplay) {
      UltraDevLog.push('CHAIN', { component: 'ChatScreen', action: 'approve', trigger: {}, state: { hasReplay: !!pendingReplay }, data: {}, outcome: 'FAIL:guard_failed' });
      return;
    }
    UltraDevLog.push('CHAIN', { component: 'ChatScreen', action: 'approve', trigger: {}, state: { replayType: pendingReplay.type }, data: {}, outcome: 'executing' });
    const replay = pendingReplay;
    setPendingReplay(null);
    setIsProcessing(true);
    UltraDevLog.processingState(true, 'handleApprove');
    setStatus("Executing approved action...");
    try {
      const args: ExecuteArgs = { conversationId, userInput: replay.userInput, replay: true };
      if (replay.type === "approval") args.approvedAction = true;
      const result = await agentCore.execute(args);
      await handleResult(result, agentCore, conversationId);
      UltraDevLog.push('EFFECT', { component: 'ChatScreen', action: 'approve', success: result.type !== 'error', resultType: result.type });
    } catch (e: any) {
      UltraDevLog.push('EFFECT', { component: 'ChatScreen', action: 'approve', success: false, error: e?.message });
      UltraDevLog.error('handleApprove', e?.message || 'approval execute failed', e?.stack);
      await reloadMessages(agentCore, conversationId);
    }
    setIsProcessing(false);
    UltraDevLog.processingState(false, 'handleApprove_done');
    setStatus("Ready");
  }, [agentCore, conversationId, pendingReplay, handleResult, reloadMessages]);

  const handleDeny = useCallback(async () => {
    if (!agentCore || !conversationId || !pendingReplay) {
      UltraDevLog.push('CHAIN', { component: 'ChatScreen', action: 'deny', trigger: {}, state: { hasReplay: !!pendingReplay }, data: {}, outcome: 'FAIL:guard_failed' });
      return;
    }
    UltraDevLog.push('CHAIN', { component: 'ChatScreen', action: 'deny', trigger: {}, state: { replayType: pendingReplay.type }, data: {}, outcome: 'denied' });
    const replay = pendingReplay;
    setPendingReplay(null);
    const cm = agentCore.getConversationManager();
    await cm.addMessage(conversationId, { id: `msg_${Math.random().toString(36).slice(2)}_${Date.now()}`, role: "assistant", content: "Cancelled.", createdAt: Date.now(), source: "ultra" });
    await reloadMessages(agentCore, conversationId);
    UltraDevLog.push('EFFECT', { component: 'ChatScreen', action: 'deny_cancel', success: true, replayType: replay.type });
  }, [agentCore, conversationId, pendingReplay, reloadMessages]);

  // ── Conversation management ────────────────────────
  const handleNewChat = useCallback(async () => {
    if (!agentCore) return;
    UltraDevLog.push('CHAIN', { component: 'ChatScreen', action: 'new_chat', trigger: {}, state: { prevConvId: conversationId ?? 'none' }, data: {}, outcome: 'creating_conversation' });
    const cm = agentCore.getConversationManager();
    const conv = await cm.createConversation();
    setConversationId(conv.id);
    setMessages([]);
    setConversationTitle("New Chat");
    setConversationStarred(false);
    setPendingReplay(null);
    setConvListVisible(false);
    await refreshConversations(agentCore);
    UltraDevLog.push('EFFECT', { component: 'ChatScreen', action: 'new_chat', success: true, newConvId: conv.id });
  }, [agentCore, refreshConversations]);

  const handleSelectConversation = useCallback(async (id: string) => {
    if (!agentCore) return;
    UltraDevLog.push('CHAIN', { component: 'ChatScreen', action: 'select_conversation', trigger: { convId: id }, state: { prevConvId: conversationId ?? 'none' }, data: {}, outcome: 'loading_conversation' });
    DebugLog.uiConvSwitch(conversationId ?? "none", id);
    snapUI("conv_switch");
    setConversationId(id);
    setPendingReplay(null);
    setContextBarDismissed(false);
    const conv = await agentCore.getConversationManager().loadConversation(id);
    setConversationStarred(!!conv?.meta?.starred);
    await reloadMessages(agentCore, id);
    setConvListVisible(false);
    UltraDevLog.push('EFFECT', { component: 'ChatScreen', action: 'select_conversation', success: true, convId: id });
  }, [agentCore, reloadMessages, conversationId]);

  const handleDeleteConversation = useCallback(async (id: string) => {
    if (!agentCore) return;
    UltraDevLog.push('CHAIN', { component: 'ChatScreen', action: 'delete_conversation', trigger: { convId: id }, state: { isActive: id === conversationId }, data: {}, outcome: 'deleting' });
    const cm = agentCore.getConversationManager();
    await cm.deleteConversation(id);
    if (id === conversationId) {
      const remaining = await cm.listConversations();
      if (remaining.length > 0) {
        setConversationId(remaining[0].id);
        await reloadMessages(agentCore, remaining[0].id);
      } else {
        const conv = await cm.createConversation();
        setConversationId(conv.id);
        setMessages([]);
        setConversationTitle("New Chat");
        setConversationStarred(false);
      }
    }
    await refreshConversations(agentCore);
    UltraDevLog.push('EFFECT', { component: 'ChatScreen', action: 'delete_conversation', success: true, deletedId: id });
  }, [agentCore, conversationId, reloadMessages, refreshConversations]);

  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [renameText, setRenameText] = useState("");

  const handleRenameConversation = useCallback(() => {
    if (!agentCore || !conversationId) return;
    UltraDevLog.push('CHAIN', { component: 'ChatScreen', action: 'rename_conversation', trigger: {}, state: { convId: conversationId, platform: Platform.OS }, data: { currentTitle: conversationTitle }, outcome: Platform.OS === 'web' ? 'web_prompt' : 'modal_opened' });
    if (Platform.OS === "web") {
      const name = window.prompt("Rename conversation:", conversationTitle);
      if (name?.trim()) {
        agentCore.getConversationManager().updateTitle(conversationId, name.trim()).then(() => {
          setConversationTitle(name.trim());
          refreshConversations(agentCore);
        });
      }
    } else {
      setRenameText(conversationTitle);
      setRenameModalVisible(true);
    }
  }, [agentCore, conversationId, conversationTitle, refreshConversations]);

  const confirmRename = useCallback(() => {
    if (!agentCore || !conversationId || !renameText.trim()) return;
    UltraDevLog.push('CHAIN', { component: 'ChatScreen', action: 'confirm_rename', trigger: {}, state: { convId: conversationId }, data: { newTitle: renameText.trim() }, outcome: 'renamed' });
    agentCore.getConversationManager().updateTitle(conversationId, renameText.trim()).then(() => {
      setConversationTitle(renameText.trim());
      refreshConversations(agentCore);
    });
    setRenameModalVisible(false);
  }, [agentCore, conversationId, renameText, refreshConversations]);

  // ── 3-dot menu handler ─────────────────────────────
  const handleMenuAction = useCallback((id: string) => {
    switch (id) {
      case "rename": handleRenameConversation(); break;
      case "delete":
        if (conversationId) {
          if (Platform.OS === "web") {
            const confirmed = window.confirm("Delete this conversation?");
            if (confirmed) handleDeleteConversation(conversationId);
          } else {
            Alert.alert("Delete", "Delete this conversation?", [
              { text: "Cancel", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: () => handleDeleteConversation(conversationId) },
            ]);
          }
        }
        break;
      case "star":
        if (agentCore && conversationId) {
          const cm = agentCore.getConversationManager();
          cm.loadConversation(conversationId).then(async (conv) => {
            if (!conv) return;
            const isStarred = !!conv.meta?.starred;
            await cm.updateMeta(conversationId, { starred: !isStarred });
            setConversationStarred(!isStarred);
            await refreshConversations(agentCore);
          });
        }
        break;
      case "new_chat": handleNewChat(); break;
      case "build_task": setTaskBuilderVisible(true); break;
    }
  }, [handleRenameConversation, handleDeleteConversation, handleNewChat, conversationId, agentCore, refreshConversations]);

  // ── Model picker data ──────────────────────────────
  const getPickerModels = useCallback((): PickerModel[] => {
    if (!agentCore) return [];
    const models = (agentCore as any).getAllModelsWithProvider?.() || agentCore.getAvailableModels();
    const currentModel = activeModelId || agentCore.getDefaultModel();
    const result = models.map((m: any) => {
      const pickerType = classifyModelType(m.id, m.name || m.id, m.type);
      return {
        id: m.id,
        name: m.name || m.id,
        type: pickerType,
        apiName: m.providerName || "API",
        costIndicator: m.costPer1kInput > 0 ? `$${m.costPer1kInput.toFixed(4)}/1K` : "Free",
        isSelected: m.id === currentModel,
      };
    });
    const tierService = agentCore?.getTierService();
    const tierFiltered = tierService ? tierService.filterModelsForTier(result) : result;
    const counts: Record<string, number> = {};
    tierFiltered.forEach((m) => { counts[m.type] = (counts[m.type] || 0) + 1; });
    UltraDevLog.modelState("picker_classification", counts);
    return tierFiltered;
  }, [agentCore, activeModelId]);

  const handleModelSelect = useCallback(async (modelId: string) => {
    if (!agentCore) return;
    UltraDevLog.pickerSelect(modelId, modelId, activeModelId || '');
    UltraDevLog.pickerClose('model_select');
    const prev = activeModelId;
    DebugLog.uiPickerSelect(modelId, prev);
    snapUI("model_select");
    await agentCore.setDefaultModel(modelId);
    setActiveModelId(modelId);
    const confirmed = agentCore.getDefaultModel();
    UltraDevLog.push('EFFECT', {
      component: 'ChatScreen', action: 'model_select_result',
      requested: modelId, previous: prev,
      confirmed, match: confirmed === modelId,
      note: confirmed === modelId ? 'ok' : `BUG: requested ${modelId} but engine has ${confirmed}`,
    });
  }, [agentCore, activeModelId, snapUI]);

  // ── Action Grid execution ──────────────────────────
  const handleGridExecute = useCallback(async (capability: string, params: Record<string, any>) => {
    if (!agentCore) return;
    UltraDevLog.push('CHAIN', { component: 'ChatScreen', action: 'grid_execute', trigger: { capability }, state: { hasConvId: !!conversationId }, data: { params }, outcome: 'running' });
    setGridCollapsed(true);
    const plan: ActionPlan = { capability, params, reason: 'Action Grid' };
    try {
      UltraDevLog.gridTap(capability, params);
      UltraDevLog.processingState(true, 'gridAction_start');
      setIsProcessing(true);
      const result = await agentCore.getTaskExecutor().runWithPlan(plan, `grid_${capability}_${Date.now()}`);
      UltraDevLog.push('EFFECT', {
        component: 'ChatScreen', action: 'grid_execute_result', capability,
        success: result.success !== false,
        summary: (result.summary || '').slice(0, 200),
        hasData: !!result.data,
      });
      const msg: ChatMessage = {
        id: `msg_grid_${Date.now()}`,
        role: 'assistant',
        content: result.summary || `${capability}: ${result.success ? 'Done' : 'Failed'}`,
        createdAt: Date.now(),
        source: 'ultra',
        meta: { capability, mode: 'command' },
      };
      if (conversationId) {
        await agentCore.getConversationManager().addMessage(conversationId, msg);
        await reloadMessages(agentCore, conversationId);
      }
    } catch (err: any) {
      UltraDevLog.error('gridAction', err.message);
      UltraDevLog.push('EFFECT', { component: 'ChatScreen', action: 'grid_execute_result', capability, success: false, error: err?.message });
    } finally {
      UltraDevLog.processingState(false, 'gridAction_finally');
      setIsProcessing(false);
    }
  }, [agentCore, conversationId, reloadMessages]);

  // ── Context Bar plan execution ─────────────────────
  const handleContextPlan = useCallback(async (capability: string, params: Record<string, any>) => {
    if (!agentCore) return;
    const plan: ActionPlan = { capability, params, reason: 'Context Bar' };
    try {
      UltraDevLog.contextTap(capability, params);
      UltraDevLog.processingState(true, 'contextAction_start');
      setIsProcessing(true);
      const result = await agentCore.getTaskExecutor().runWithPlan(plan, `ctx_${capability}_${Date.now()}`);
      UltraDevLog.push('EFFECT', {
        component: 'ChatScreen', action: 'context_execute_result', capability,
        success: result.success !== false,
        summary: (result.summary || '').slice(0, 200),
        hasData: !!result.data,
      });
      const msg: ChatMessage = {
        id: `msg_ctx_${Date.now()}`,
        role: 'assistant',
        content: result.summary || `${capability}: ${result.success ? 'Done' : 'Failed'}`,
        createdAt: Date.now(),
        source: 'ultra',
        meta: { capability, mode: 'command' },
      };
      if (conversationId) {
        await agentCore.getConversationManager().addMessage(conversationId, msg);
        await reloadMessages(agentCore, conversationId);
      }
    } catch (err: any) {
      UltraDevLog.error('contextAction', err.message);
      UltraDevLog.push('EFFECT', { component: 'ChatScreen', action: 'context_execute_result', capability, success: false, error: err?.message });
    } finally {
      UltraDevLog.processingState(false, 'contextAction_finally');
      setIsProcessing(false);
    }
  }, [agentCore, conversationId, reloadMessages]);

  // ── Task Builder test runner ───────────────────────
  const handleTestRun = useCallback(async (steps: TaskStep[]): Promise<TaskRunResult> => {
    const startedAt = Date.now();
    const results: TaskRunResult['steps'] = [];
    for (const step of steps) {
      const stepStart = Date.now();
      try {
        if (!agentCore) throw new Error('AgentCore not initialized');
        const plan = { capability: step.capability, params: step.params, reason: 'TaskBuilder test' };
        const result = await agentCore.getTaskExecutor().runWithPlan(plan, `test_${step.id}`);
        results.push({
          stepId: step.id,
          success: result.success,
          result: result.summary || 'Done',
          durationMs: Date.now() - stepStart,
        });
        if (!result.success) break;
        if (step.delayMs) await new Promise(r => setTimeout(r, step.delayMs));
      } catch (err: any) {
        results.push({
          stepId: step.id,
          success: false,
          result: err.message,
          durationMs: Date.now() - stepStart,
        });
        break;
      }
    }
    return {
      templateId: 'test',
      startedAt,
      completedAt: Date.now(),
      steps: results,
      overallSuccess: results.every(r => r.success),
    };
  }, [agentCore]);

  // ── Task save handler ──────────────────────────────
  const handleSaveTask = useCallback(async (template: TaskTemplate) => {
    const updated = [...savedTasks.filter(t => t.id !== template.id), template];
    setSavedTasks(updated);
    await AppStorage.set('task_templates', JSON.stringify(updated));
  }, [savedTasks]);

  // ── Task runner (from Action Grid "My Tasks") ──────
  const handleRunTask = useCallback(async (template: TaskTemplate) => {
    if (!agentCore) return;
    setGridCollapsed(true);
    for (const step of template.steps) {
      try {
        const plan = { capability: step.capability, params: step.params, reason: `Task: ${template.name}` };
        const result = await agentCore.getTaskExecutor().runWithPlan(plan, `task_${template.id}_${step.id}`);
        if (!result.success) break;
        if (step.delayMs) await new Promise(r => setTimeout(r, step.delayMs));
      } catch { break; }
    }
    template.lastUsed = Date.now();
    template.useCount++;
    handleSaveTask(template);
  }, [agentCore, handleSaveTask]);

  // ── Misc handlers ──────────────────────────────────
  const openConvList = useCallback(async () => {
    if (agentCore) await refreshConversations(agentCore);
    UltraDevLog.modalEvent('convList', 'open');
    setConvListVisible(true);
  }, [agentCore, refreshConversations]);

  const openPromptViewer = useCallback((trace: PromptTrace) => {
    UltraDevLog.modalEvent('promptViewer', 'open');
    setSelectedTrace(trace);
    setPromptViewerVisible(true);
  }, []);

  const handleCopyMessage = useCallback(async (msg: ChatMessage) => {
    try {
      await Clipboard.setStringAsync(msg.content);
      setCopiedId(msg.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (e: any) { DebugLog.uiError('clipboard_copy', e?.message || 'copy failed'); }
  }, []);

  // ── Message style classifier ───────────────────────
  const getMessageStyle = (msg: ChatMessage) => {
    if (msg.role === "user") return "user" as const;
    if (msg.role === "system") return "system" as const;
    if (msg.source === "ultra") {
      if (msg.meta?.isBuildLog) return "buildLog" as const;
      const risk = msg.meta?.risk;
      if (risk === "dangerous" || risk === "blocked") return "blocked" as const;
      return "ultra" as const;
    }
    return "ai" as const;
  };

  // ── Message renderer ───────────────────────────────
  const renderMessage = useCallback(
    ({ item }: { item: ChatMessage }) => {
      const msgStyle = getMessageStyle(item);
      const isUser = msgStyle === "user";
      const trace = item.meta?.promptTrace;
      const isApprovalOrSwitch = item.content.startsWith("Approval required") || item.content.startsWith("I recommend switching");
      const isLatestMessage = messages.length > 0 && item.id === messages[0].id;
      const showPendingButtons = !!pendingReplay && isApprovalOrSwitch && isLatestMessage;
      const isCopied = copiedId === item.id;

      // Show quick replies only on the most recent assistant message (not on failures or errors)
      const verificationFailed = item.meta?.promptTrace?.verification?.verified === false;
      const isError = (item.content || '').toLowerCase().includes('error') || (item.content || '').toLowerCase().includes('failed');
      const showContextBar = !isUser && isLatestMessage && !isProcessing && !pendingReplay
        && item.role !== 'system' && !verificationFailed && !isError && !item.meta?.isBuildLog;

      const msgIndex = messages.indexOf(item);

      return (
        <>
          <View
            onLayout={(e) => {
            const { height, width } = e.nativeEvent.layout;
            UltraDevLog.messageRendered(
              item.id, item.role as 'user' | 'assistant' | 'system', item.content.length,
              height,
              msgIndex >= 0 ? msgIndex : 0,
              scrollOffsetRef.current, listHeightRef.current,
            );
            UltraDevLog.bubbleDiag(
              item.id, item.role, height, width, item.content.length,
              msgIndex >= 0 ? msgIndex : 0, msgStyle,
            );
          }}
          style={[
            styles.messageBubble,
            msgStyle === "user" ? styles.userBubble :
            msgStyle === "ultra" ? styles.ultraBubble :
            msgStyle === "ai" ? styles.aiBubble :
            msgStyle === "blocked" ? styles.blockedBubble :
            msgStyle === "buildLog" ? styles.buildLogBubble :
            styles.systemBubble,
            isCopied && styles.copiedBubble,
          ]}
        >
          {/* Header with icon */}
          {!isUser && (
            <View style={styles.messageHeader}>
              {msgStyle === "ultra" ? (
                <MaterialCommunityIcons name="robot" size={14} color={ULTRA_COLOR} />
              ) : msgStyle === "ai" ? (
                <Ionicons name="sparkles" size={14} color={AI_COLOR} />
              ) : msgStyle === "blocked" ? (
                <Ionicons name="shield" size={14} color={BLOCKED_COLOR} />
              ) : msgStyle === "buildLog" ? (
                <MaterialCommunityIcons name="console" size={14} color="#ff9900" />
              ) : (
                <Ionicons name="information-circle" size={14} color={DIM} />
              )}
              <Text style={[
                styles.roleLabel,
                msgStyle === "ultra" ? { color: ULTRA_COLOR } :
                msgStyle === "ai" ? { color: AI_COLOR } :
                msgStyle === "blocked" ? { color: BLOCKED_COLOR } :
                msgStyle === "buildLog" ? { color: "#ff9900" } :
                { color: DIM },
              ]}>
                {msgStyle === "ultra" ? "ULTRA" :
                 msgStyle === "ai" ? "AI" :
                 msgStyle === "blocked" ? "BLOCKED" :
                 msgStyle === "buildLog" ? "BUILD LOG" :
                 "SYSTEM"}
              </Text>
              {item.meta?.capability && (
                <Text style={styles.capBadge}>{item.meta.capability}</Text>
              )}
            </View>
          )}

          {/* Message content */}
          {(() => {
            const MAX_CHARS = 4000;
            const isLong = item.content.length > MAX_CHARS;
            const isExpanded = expandedMsgs.has(item.id);
            const displayText = isLong && !isExpanded ? item.content.slice(0, MAX_CHARS) + "…" : item.content;
            return (
              <>
                <Text selectable style={[
                  styles.messageText,
                  isUser && styles.userText,
                  msgStyle === "buildLog" && styles.buildLogText,
                ]}>
                  {displayText}
                </Text>
                {isLong && (
                  <Pressable
                    onPress={() => setExpandedMsgs(prev => {
                      const next = new Set(prev);
                      if (isExpanded) next.delete(item.id); else next.add(item.id);
                      return next;
                    })}
                    style={styles.showMoreBtn}
                  >
                    <Text style={styles.showMoreText}>
                      {isExpanded ? "Show less" : `Show more (${Math.round(item.content.length / 1000)}k chars)`}
                    </Text>
                  </Pressable>
                )}
              </>
            );
          })()}

          {/* System Info Card */}
          {item.meta?.data?.systemInfoData && (
            <SystemInfoCard data={item.meta.data.systemInfoData} />
          )}

          {/* Upgrade button on tier-blocked messages */}
          {item.meta?.needsUpgrade && (
            <Pressable
              onPress={() => router.push('/settings')}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8,
                       paddingVertical: 8, paddingHorizontal: 14, backgroundColor: '#2a2a2a',
                       borderRadius: 10, alignSelf: 'flex-start' }}
            >
              <Ionicons name="arrow-up-circle" size={16} color={ACCENT} />
              <Text style={{ color: ACCENT, fontSize: 13, fontWeight: '600' }}>Add API Key or Upgrade</Text>
            </Pressable>
          )}

          {/* Message action row: copy + share + prompt trace */}
          <View style={styles.msgActions}>
            <Pressable onPress={() => handleCopyMessage(item)} hitSlop={8} style={styles.copyBtn}>
              <Ionicons name={isCopied ? "checkmark" : "copy-outline"} size={14} color={isCopied ? ACCENT : DIM} />
              {isCopied && <Text style={styles.copiedInline}>Copied</Text>}
            </Pressable>
            {!isUser && (
              <Pressable
                hitSlop={8}
                style={styles.copyBtn}
                onPress={async () => {
                  UltraDevLog.push('CHAIN', { component: 'ChatScreen', action: 'share_message', trigger: { msgId: item.id }, state: {}, data: { contentLength: item.content.length }, outcome: 'sharing' });
                  try {
                    const shareResult = await Share.share({ message: item.content });
                    UltraDevLog.push('EFFECT', { component: 'ChatScreen', action: 'share_message', success: shareResult.action !== Share.dismissedAction, action: shareResult.action });
                  } catch (e: any) {
                    UltraDevLog.push('EFFECT', { component: 'ChatScreen', action: 'share_message', success: false, error: e?.message });
                  }
                }}
              >
                <Ionicons name="share-outline" size={14} color={DIM} />
              </Pressable>
            )}
            {trace && !isUser && (
              <Pressable onPress={() => openPromptViewer(trace)} style={styles.viewPromptBtn} hitSlop={8}>
                <Ionicons name="eye-outline" size={12} color={DIM} />
                <Text style={styles.viewPromptText}>View Prompt</Text>
              </Pressable>
            )}
          </View>

          {/* Approval/deny buttons */}
          {showPendingButtons && (
            <View style={styles.approvalRow}>
              <Pressable onPress={handleApprove} style={[styles.approvalBtn, styles.approveBtn]} disabled={isProcessing}>
                <Ionicons name="checkmark" size={16} color="#000" />
                <Text style={styles.approveBtnText}>Approve</Text>
              </Pressable>
              <Pressable onPress={handleDeny} style={[styles.approvalBtn, styles.denyBtn]} disabled={isProcessing}>
                <Ionicons name="close" size={16} color="#fff" />
                <Text style={styles.denyBtnText}>Deny</Text>
              </Pressable>
            </View>
          )}

        </View>

        {/* Context chips — OUTSIDE bubble to prevent height/width inflation */}
        {showContextBar && !contextBarDismissed && (
          <View style={{ alignSelf: 'flex-start', maxWidth: '90%', marginBottom: 8, flexDirection: 'row', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <ContextBar
                message={item}
                currentMode={currentMode}
                onExecutePlan={handleContextPlan}
                onSendPrompt={(text) => handleSend(text)}
              />
            </View>
            <Pressable
              onPress={() => setContextBarDismissed(true)}
              hitSlop={8}
              style={{ paddingLeft: 6, paddingTop: 10 }}
            >
              <Ionicons name="close-circle" size={16} color="#444" />
            </Pressable>
          </View>
        )}
      </>
      );
    },
    [pendingReplay, messages, isProcessing, openPromptViewer, handleApprove, handleDeny, handleCopyMessage, copiedId, expandedMsgs, currentMode, handleContextPlan, handleSend, contextBarDismissed]
  );

  // ── Layout values ──────────────────────────────────
  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;
  const currentModelName = activeModelId || agentCore?.getDefaultModel() || "No model";
  const shortModelName = currentModelName.length > 18 ? currentModelName.slice(0, 18) + "…" : currentModelName;

  if (showOnboarding) {
    return (
      <OnboardingScreen
        onComplete={async () => {
          await AppStorage.set("onboarding_done", "1");
          setShowOnboarding(false);
        }}
      />
    );
  }

  if (isAppLocked) {
    return (
      <View style={[lockStyles.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
        <Ionicons name="lock-closed" size={56} color={ACCENT} />
        <Text style={lockStyles.title}>Agent Ultra Locked</Text>
        <Text style={lockStyles.sub}>Authenticate to continue</Text>
        <Pressable
          style={lockStyles.btn}
          onPress={async () => {
            const gate = biometricGateRef.current;
            if (!gate) return;
            const ok = await gate.authenticate();
            if (ok) setIsAppLocked(false);
          }}
        >
          <Ionicons name="finger-print" size={20} color={BG} />
          <Text style={lockStyles.btnText}>Unlock</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopInset }]} testID="ChatScreen">

      {/* ══════════════════════════════════════════════
          HEADER BAR
          ══════════════════════════════════════════════ */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Pressable onPress={openConvList} style={styles.menuBtn}>
            <Ionicons name="menu" size={22} color="#ffffff" />
          </Pressable>
          <Pressable onLongPress={handleRenameConversation} delayLongPress={500} style={{ flex: 1 }}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              Agent Ultra
            </Text>
          </Pressable>
        </View>
        <View style={styles.headerRight}>
          {isProcessing && <Animated.View style={[styles.statusDot, { opacity: pulseAnim }]} />}
          <Text style={styles.statusText}>{status}</Text>
          <Pressable onPress={() => setHeaderMenuVisible(true)} style={styles.dotsBtn}>
            <Ionicons name="ellipsis-vertical" size={20} color="#aaa" />
          </Pressable>
        </View>
      </View>

      {/* ══════════════════════════════════════════════
          MESSAGE LIST
          ══════════════════════════════════════════════ */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
        <FlatList
          data={messages}
          renderItem={renderMessage}
          keyExtractor={(item) => item.id}
          extraData={`${isProcessing}_${pendingReplay?.type ?? 'none'}_${copiedId}_${expandedMsgs.size}`}
          inverted
          style={styles.messageList}
          contentContainerStyle={styles.messageListContent}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onLayout={(e) => { listHeightRef.current = e.nativeEvent.layout.height; }}
          onScroll={(e) => {
            scrollOffsetRef.current = UltraDevLog.listScrolled(
              e.nativeEvent.contentOffset.y,
              e.nativeEvent.layoutMeasurement.height,
              e.nativeEvent.contentSize.height,
            );
            listHeightRef.current = e.nativeEvent.layoutMeasurement.height;
          }}
          scrollEventThrottle={100}
        />

        {/* ══════════════════════════════════════════════
            INPUT BAR
            ══════════════════════════════════════════════ */}
        <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, webBottomInset) + 8 }]}>

          {/* Processing indicator with activity-aware icon */}
          {isProcessing && (
            <View style={styles.processingBar}>
              {(() => {
                const ai = getActivityIcon(status, buildPhase, genomePhase);
                return ai.family === "material" ? (
                  <MaterialCommunityIcons name={ai.name as any} size={16} color={ai.color} />
                ) : (
                  <Ionicons name={ai.name as any} size={16} color={ai.color} />
                );
              })()}
              <Text style={styles.processingText}>{buildPhase || genomePhase || status}</Text>
            </View>
          )}

          {/* Action Grid */}
          <ActionGrid
            collapsed={gridCollapsed}
            onToggle={() => setGridCollapsed(prev => !prev)}
            currentMode={currentMode}
            onExecute={handleGridExecute}
            onRunTask={handleRunTask}
            savedTasks={savedTasks}
            onOpenZoneEditor={() => setZoneEditorVisible(true)}
            zoneConfig={zoneConfig}
          />

          {/* Tier indicator */}
          {agentCore && (
            <View style={{ flexDirection: 'row', justifyContent: 'center', paddingBottom: 2 }}>
              <Text style={{ color: '#444', fontSize: 10 }}>
                {agentCore.getTierService().getTier() === 'dev' ? '🛠 Dev'
                  : agentCore.getTierService().getTier() === 'pro' ? '⭐ Pro'
                  : agentCore.getTierService().getTier() === 'no_ads' ? '🚫 No Ads'
                  : '🆓 Free (Agent Only)'}
                {' • '}{agentCore.getTierService().getUsage().messageCount} msgs today
              </Text>
            </View>
          )}

          {/* Model indicator pill */}
          <View style={styles.modelIndicatorRow}>
            <Pressable
              onPress={() => {
                const modeToFilter: Record<string, "all" | "text" | "image" | "code" | "reasoning" | "video"> = {
                  chat: "text", image: "image", code: "code", reasoning: "reasoning", video: "video",
                };
                const filter = modeToFilter[currentMode] || "all";
                DebugLog.uiPickerOpen(filter, currentMode, activeModelId);
                UltraDevLog.modalEvent('modelPicker', 'open', { modelCount: getPickerModels().length });
                snapUI("picker_open");
                setModelPickerInitialFilter(filter);
                setModelPickerVisible(true);
              }}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
              style={({ pressed }) => [styles.modelPill, pressed && styles.modelPillPressed]}
            >
              <MaterialCommunityIcons name="robot" size={12} color={DIM} />
              <Text style={styles.modelPillText} numberOfLines={1}>{shortModelName}</Text>
              <Ionicons name="chevron-up" size={12} color="#444" />
            </Pressable>
          </View>

          {/* Pending image preview */}
          {pendingImage && (
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, gap: 8 }}>
              <Image source={{ uri: pendingImage.uri }} style={{ width: 48, height: 48, borderRadius: 8 }} />
              <Text style={{ color: '#999', fontSize: 12, flex: 1 }}>Image attached — send with your message</Text>
              <Pressable onPress={() => setPendingImage(null)} hitSlop={8}>
                <Ionicons name="close-circle" size={18} color="#666" />
              </Pressable>
            </View>
          )}

          {/* Input row: + button | image button | text input | send button */}
          <View style={styles.inputRow}>
            <Pressable
              onPress={() => setPlusMenuVisible(true)}
              style={({ pressed }) => [styles.plusBtn, pressed && styles.plusBtnPressed]}
            >
              <Ionicons name="add" size={22} color={DIM} />
            </Pressable>

            <Pressable
              onPress={async () => {
                try {
                  const ImagePicker = await import('expo-image-picker');
                  const result = await ImagePicker.launchImageLibraryAsync({
                    mediaTypes: ['images'],
                    quality: 0.7,
                    base64: true,
                    allowsEditing: false,
                  });
                  if (!result.canceled && result.assets?.[0]?.base64) {
                    setPendingImage({
                      uri: result.assets[0].uri,
                      base64: result.assets[0].base64!,
                      mimeType: result.assets[0].mimeType || 'image/jpeg',
                    });
                  }
                } catch (e: any) { DebugLog.error('ImagePicker', e?.message || 'unknown'); }
              }}
              style={({ pressed }) => [styles.plusBtn, pressed && styles.plusBtnPressed, { marginRight: -4 }]}
            >
              <Ionicons name="image-outline" size={20} color={DIM} />
            </Pressable>

            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              placeholder="Ask Agent Ultra..."
              placeholderTextColor="#444"
              style={styles.input}
              multiline
              maxLength={4000}
              returnKeyType="send"
              onSubmitEditing={() => { if (!isProcessing) handleSend(); }}
              blurOnSubmit={false}
              editable
            />

            {isProcessing ? (
              <Pressable
                onPress={() => {
                  DebugLog.uiStopRequest(!!agentCore);
                  snapUI("stop_request");
                  if (agentCore) agentCore.abortCurrentRequest();
                }}
                style={styles.stopBtn}
              >
                <Ionicons name="stop" size={18} color="#fff" />
              </Pressable>
            ) : (
              <Pressable
                onPress={() => { handleSend(); inputRef.current?.focus(); }}
                disabled={!input.trim()}
                style={[styles.sendBtn, !input.trim() && styles.sendBtnDisabled]}
              >
                <Ionicons name="send" size={18} color={!input.trim() ? DIM : BG} />
              </Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* ══════════════════════════════════════════════
          OVERLAY PANELS
          ══════════════════════════════════════════════ */}
      <ConversationList
        visible={convListVisible}
        conversations={conversations}
        currentConversationId={conversationId}
        onSelect={handleSelectConversation}
        onDelete={handleDeleteConversation}
        onNewChat={handleNewChat}
        onClose={() => { UltraDevLog.modalEvent('convList', 'close'); setConvListVisible(false); }}
        onOpenSettings={() => router.push("/settings")}
        onOpenLogs={() => {
          router.push("/settings?tab=logs");
        }}
        onQuickCommand={(cmd) => handleSend(cmd)}
        onExecuteToggle={handleGridExecute}
        onOpenZoneEditor={() => { setConvListVisible(false); setZoneEditorVisible(true); }}
      />

      <ZoneEditor
        visible={zoneEditorVisible}
        onClose={() => setZoneEditorVisible(false)}
        onSaved={(zc) => { setZoneConfig(zc); }}
        savedTasks={savedTasks}
      />

      <PromptViewer
        visible={promptViewerVisible}
        trace={selectedTrace}
        onClose={() => setPromptViewerVisible(false)}
      />

      <ActionMenu
        visible={headerMenuVisible}
        items={getHeaderMenuItems(conversationStarred)}
        onSelect={handleMenuAction}
        onClose={() => setHeaderMenuVisible(false)}
        anchorRight={12}
        anchorTop={insets.top + webTopInset + 50}
      />

      <ModelPickerSheet
        visible={modelPickerVisible}
        models={getPickerModels()}
        currentModelId={activeModelId || agentCore?.getDefaultModel() || ""}
        onSelect={handleModelSelect}
        onClose={() => {
          UltraDevLog.pickerClose('close_button');
          UltraDevLog.modalEvent('modelPicker', 'close', { how: 'close_button' });
          setModelPickerVisible(false);
          setModelPickerInitialFilter("all");
        }}
        initialFilter={modelPickerInitialFilter}
      />

      <PlusMenu
        visible={plusMenuVisible}
        currentType={currentMode}
        onSelect={async (type) => {
          DebugLog.uiModeSwitch(currentMode, type, "plusMenu");
          DebugLog.uiPlusMenuSelect(type, false, null);
          snapUI("plus_menu_select");
          setCurrentMode(type);
          setPlusMenuVisible(false);
          if (agentCore) {
            DebugLog.uiPickerOpen("auto_from_plus", type, activeModelId);
            const filterMap: Record<string, typeof modelPickerInitialFilter> = {
              chat: "text", image: "image", code: "code",
              reasoning: "reasoning", video: "video",
            };
            setModelPickerInitialFilter(filterMap[type] || "all");
            setModelPickerVisible(true);
          }
        }}
        onClose={() => { UltraDevLog.modalEvent('plusMenu', 'close'); setPlusMenuVisible(false); }}
      />

      {Platform.OS !== "web" && (
        <Modal visible={renameModalVisible} transparent animationType="fade" onRequestClose={() => setRenameModalVisible(false)} statusBarTranslucent>
          <TouchableWithoutFeedback onPress={() => setRenameModalVisible(false)}>
            <View style={renameStyles.backdrop}>
              <TouchableWithoutFeedback>
                <View style={renameStyles.dialog}>
                  <Text style={renameStyles.title}>Rename Conversation</Text>
                  <TextInput
                    value={renameText}
                    onChangeText={setRenameText}
                    style={renameStyles.input}
                    autoFocus
                    placeholder="Conversation name"
                    placeholderTextColor="#444"
                    onSubmitEditing={confirmRename}
                    returnKeyType="done"
                    selectTextOnFocus
                  />
                  <View style={renameStyles.btnRow}>
                    <Pressable onPress={() => setRenameModalVisible(false)} style={renameStyles.cancelBtn}>
                      <Text style={renameStyles.cancelText}>Cancel</Text>
                    </Pressable>
                    <Pressable onPress={confirmRename} style={renameStyles.saveBtn}>
                      <Text style={renameStyles.saveText}>Rename</Text>
                    </Pressable>
                  </View>
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>
      )}

      <TaskBuilder
        visible={taskBuilderVisible}
        onClose={() => setTaskBuilderVisible(false)}
        onSave={handleSaveTask}
        onTestRun={handleTestRun}
        categories={DEFAULT_CATEGORIES}
      />
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: SURFACE,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  menuBtn: { padding: 4 },
  headerTitle: {
    color: "#ffffff",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    flex: 1,
  },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: ACCENT },
  statusText: { color: DIM, fontSize: 11, fontFamily: "Inter_400Regular", maxWidth: 100 },
  dotsBtn: { padding: 4 },

  // Messages
  messageList: { flex: 1 },
  messageListContent: { paddingHorizontal: 16, paddingVertical: 8 },
  messageBubble: { borderRadius: 12, padding: 12, marginBottom: 8, maxWidth: "85%" },
  userBubble: { backgroundColor: "#2a2a2a", alignSelf: "flex-end" },
  ultraBubble: { backgroundColor: SURFACE, alignSelf: "flex-start", borderWidth: 1, borderColor: "#2a2a2a" },
  aiBubble: { backgroundColor: SURFACE, alignSelf: "flex-start", borderWidth: 1, borderColor: "#1a2a3a" },
  blockedBubble: { backgroundColor: "#1a0a0a", alignSelf: "flex-start", borderWidth: 1, borderColor: "#3a1a1a" },
  buildLogBubble: { backgroundColor: "#1a1400", alignSelf: "flex-start", borderWidth: 1, borderColor: "#3a2a00", maxWidth: "95%" },
  buildLogText: { fontFamily: Platform.OS === "web" ? "monospace" : "Courier", fontSize: 11, color: "#ccaa44", lineHeight: 16 },
  systemBubble: { backgroundColor: SURFACE2, alignSelf: "flex-start", borderWidth: 1, borderColor: "#222222" },
  messageHeader: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 },
  roleLabel: { fontSize: 10, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5 },
  capBadge: { fontSize: 9, color: DIM, fontFamily: "Inter_400Regular", backgroundColor: "#1a1a1a", paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, overflow: "hidden", marginLeft: 4 },
  messageText: { color: "#cccccc", fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20 },
  userText: { color: "#e5e5e5" },
  msgActions: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 6 },
  copyBtn: { flexDirection: "row", alignItems: "center", gap: 3, padding: 2 },
  copiedInline: { color: ACCENT, fontSize: 10, fontFamily: "Inter_500Medium" },
  viewPromptBtn: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" },
  viewPromptText: { color: DIM, fontSize: 11, fontFamily: "Inter_400Regular" },
  approvalRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  approvalBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  approveBtn: { backgroundColor: ACCENT },
  denyBtn: { backgroundColor: "#333" },
  approveBtnText: { color: "#000", fontSize: 13, fontFamily: "Inter_600SemiBold" },
  denyBtnText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
  copiedBubble: { borderColor: ACCENT, borderWidth: 1 },
  copiedLabel: { color: ACCENT, fontSize: 10, fontFamily: "Inter_500Medium", marginTop: 4, alignSelf: "flex-end" },
  showMoreBtn: { marginTop: 6, paddingVertical: 4 },
  showMoreText: { color: AI_COLOR, fontSize: 12, fontFamily: "Inter_600SemiBold" },

  // Input bar
  inputBar: { borderTopWidth: 1, borderTopColor: SURFACE, paddingHorizontal: 14, paddingTop: 6, backgroundColor: BG },
  processingBar: { flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 6, paddingHorizontal: 2 },
  processingText: { color: "#c084fc", fontSize: 12, fontFamily: "Inter_500Medium", flex: 1 },
  modelIndicatorRow: { paddingBottom: 6 },
  modelPill: {
    flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start",
    backgroundColor: SURFACE2, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12,
    borderWidth: 1, borderColor: "#222",
  },
  modelPillPressed: { backgroundColor: "#222" },
  modelPillText: { color: DIM, fontSize: 11, fontFamily: "Inter_400Regular", maxWidth: 160 },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
  plusBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: SURFACE2, justifyContent: "center", alignItems: "center",
    borderWidth: 1, borderColor: "#222",
  },
  plusBtnPressed: { backgroundColor: "#222" },
  input: {
    flex: 1, backgroundColor: SURFACE, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
    color: "#ffffff", fontSize: 14, fontFamily: "Inter_400Regular", maxHeight: 120, borderWidth: 1, borderColor: SURFACE2,
  },
  sendBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: ACCENT, justifyContent: "center", alignItems: "center" },
  sendBtnDisabled: { backgroundColor: SURFACE },
  stopBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#333", justifyContent: "center", alignItems: "center" },
});

const lockStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG, alignItems: 'center', justifyContent: 'center', gap: 16 },
  title: { fontSize: 24, fontWeight: '700', color: '#e0e0e0', fontFamily: 'Inter_700Bold' },
  sub: { fontSize: 14, color: '#666', fontFamily: 'Inter_400Regular', marginBottom: 8 },
  btn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: ACCENT, borderRadius: 12,
    paddingVertical: 14, paddingHorizontal: 28,
  },
  btnText: { color: BG, fontWeight: '700', fontSize: 16, fontFamily: 'Inter_700Bold' },
});

const renameStyles = StyleSheet.create({
  backdrop: {
    flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "rgba(0,0,0,0.6)",
  },
  dialog: {
    width: "85%", backgroundColor: "#1a1a1a", borderRadius: 16, padding: 20,
    borderWidth: 1, borderColor: "#2a2a2a",
  },
  title: { color: "#e0e0e0", fontSize: 17, fontFamily: "Inter_700Bold", marginBottom: 14 },
  input: {
    backgroundColor: "#111", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
    color: "#fff", fontSize: 14, fontFamily: "Inter_400Regular", borderWidth: 1, borderColor: "#333",
  },
  btnRow: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 },
  cancelBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: "#222" },
  cancelText: { color: "#888", fontSize: 14, fontFamily: "Inter_500Medium" },
  saveBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: ACCENT },
  saveText: { color: "#000", fontSize: 14, fontFamily: "Inter_600SemiBold" },
});

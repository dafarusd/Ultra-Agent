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
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { useRouter, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { SecureVault } from "@/src/security/SecureVault";
import { UltraDevLog as DebugLog, UltraDevLog } from "@/src/utils/UltraDevLog";
import { AgentCore, setAgentCoreInstance } from "@/src/core/AgentCore";
import type { ExecuteArgs } from "@/src/core/AgentCore";
import type { ChatMessage, UltraExecutionResult, ConversationMeta, PromptTrace } from "@/src/types/ultra";
import ConversationList from "@/components/ConversationList";
import PromptViewer from "@/components/PromptViewer";
import ActionMenu, { ActionMenuItem } from "@/components/ActionMenu";
import ModelPickerSheet, { PickerModel } from "@/components/ModelPickerSheet";
import PlusMenu, { ActionType } from "@/components/PlusMenu";
import QuickReplies from "@/components/QuickReplies";

// ── Color Palette (softened green accent) ──────────────
const ACCENT = "#34d399";       // softer mint green (was #00ff88)
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
  const [savedDefaults, setSavedDefaults] = useState<Record<string, string>>({});
  const [activeModelId, setActiveModelId] = useState<string>("");
  const [pendingReplay, setPendingReplay] = useState<{
    userInput: string;
    type: "approval" | "model_switch";
    recommendedModel?: string;
  } | null>(null);

  // Build/genome progress
  const [buildPhase, setBuildPhase] = useState<string | null>(null);
  const [genomePhase, setGenomePhase] = useState<string | null>(null);

  // Copy feedback
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const inputRef = useRef<TextInput>(null);
  const pulseAnim = useRef(new Animated.Value(0.3)).current;
  const agentCoreInitialized = useRef(false);
  const scrollOffsetRef = useRef(0);
  const listHeightRef = useRef(0);

  // ── Pulse animation for status dot ─────────────────
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0.3, duration: 1000, useNativeDriver: true }),
      ])
    ).start();
  }, [pulseAnim]);

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
      savedDefaults,
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

  // ── AppState Lifecycle Sensor ─────────────────────
  useEffect(() => {
    UltraDevLog.installAppStateListener();
    return () => UltraDevLog.removeAppStateListener();
  }, []);

  // ── Init ───────────────────────────────────────────
  useEffect(() => {
    let coreRef: AgentCore | null = null;
    async function init() {
      if (agentCoreInitialized.current) return;
      agentCoreInitialized.current = true;
      DebugLog.uiInit("start", "Beginning app initialization");
      try {
        const vault = await SecureVault.initialize();
        DebugLog.uiInit("vault", "SecureVault initialized");
        const core = new AgentCore(vault, (msg: string, type: string) => {
          setStatus(msg);
          if (type === "build_progress") setBuildPhase(msg);
          if (type === "genome_progress") setGenomePhase(msg);
        });
        await core.initialize();
        coreRef = core;
        setAgentCore(core);
        setAgentCoreInstance(core);
        const modelsAvailable = core.getAvailableModels()?.length ?? 0;
        DebugLog.uiInit("agentCore", "AgentCore initialized, default model: " + core.getDefaultModel());
        DebugLog.modelState("post_init", { discoveredCount: modelsAvailable, defaultModel: core.getDefaultModel(), hasApiKey: core.hasApiKey() });

        const savedRaw = await vault.get("api_defaults");
        if (savedRaw) {
          try {
            const parsed = JSON.parse(savedRaw);
            setSavedDefaults(parsed);
            DebugLog.uiDefaultsLoaded("init", parsed);
            const chatDefault = parsed["chat"];
            if (chatDefault) {
              await core.setDefaultModel(chatDefault);
              setActiveModelId(chatDefault);
              DebugLog.uiModelApply(chatDefault, "chat", "init_default", true);
            } else {
              setActiveModelId(core.getDefaultModel());
              DebugLog.uiInit("model", "No chat default saved, using engine default: " + core.getDefaultModel());
            }
          } catch {
            setActiveModelId(core.getDefaultModel());
            DebugLog.uiInit("model", "Failed to parse saved defaults, using engine default");
          }
        } else {
          setActiveModelId(core.getDefaultModel());
          DebugLog.uiInit("model", "No saved defaults, using engine default: " + core.getDefaultModel());
        }
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

        if (!core.hasApiKey()) setStatus("No API key");
      } catch (err: any) {
        DebugLog.uiError("init", err?.message ?? "Unknown init error");
        setStatus("Init failed");
      }
    }
    init();
    return () => {
      if (coreRef) coreRef.destroy('component_unmount');
    };
  }, []);

  const lastFocusTime = useRef(0);
  useFocusEffect(
    useCallback(() => {
      if (!agentCore) return;
      const now = Date.now();
      if (now - lastFocusTime.current < 2000) return;
      lastFocusTime.current = now;
      DebugLog.uiFocusEffect("triggered", currentMode, Object.keys(savedDefaults), activeModelId);
      snapUI("focus_effect");
      agentCore.refreshApiKey().then(() => {
        if (agentCore.hasApiKey()) setStatus("Ready");
      });
      SecureVault.initialize().then(async (v) => {
        try {
          const raw = await v.get("api_defaults");
          if (raw) {
            const parsed = JSON.parse(raw);
            setSavedDefaults(parsed);
            const modeDefault = parsed[currentMode];
            if (modeDefault && modeDefault !== activeModelId) {
              setActiveModelId(modeDefault);
              DebugLog.uiModelApply(modeDefault, currentMode, "focusEffect_default_sync", true);
            }
            DebugLog.uiDefaultsLoaded("focusEffect", parsed);
          }
        } catch {}
      });
    }, [agentCore, currentMode, activeModelId])
  );

  // ── Result handler ─────────────────────────────────
  const handleResult = useCallback(
    async (result: UltraExecutionResult, core: AgentCore, convId: string) => {
      switch (result.type) {
        case "model_switch_request":
          setPendingReplay({ userInput: result.data?.replayUserInput || "", type: "model_switch", recommendedModel: result.data?.recommendedModel });
          break;
        case "approval_required":
          setPendingReplay({ userInput: result.data?.replayUserInput || "", type: "approval" });
          break;
      }
      await reloadMessages(core, convId);
      await refreshConversations(core);
    },
    [reloadMessages, refreshConversations]
  );

  // ── Send message ───────────────────────────────────
  const handleSend = useCallback(async (overrideText?: string) => {
    const text = (overrideText || input).trim();
    if (!text || isProcessing || !agentCore || !conversationId) return;
    UltraDevLog.sendAttempt(text, currentMode, activeModelId || '', conversationId, messages.length, isProcessing);
    DebugLog.uiSendMessage(text.length, currentMode, activeModelId, isProcessing);
    snapUI("before_send");
    if (!overrideText) setInput("");
    setIsProcessing(true);
    UltraDevLog.processingState(true, 'handleSend_start');
    setStatus("Processing...");

    const optimisticId = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setMessages((prev) => [
      { id: optimisticId, role: "user" as const, content: text, createdAt: Date.now() } as ChatMessage,
      ...prev,
    ]);

    const _sendStart = Date.now();
    try {
      const result = await agentCore.execute({ conversationId, userInput: text });
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
    if (!agentCore || !conversationId || !pendingReplay) return;
    const replay = pendingReplay;
    setPendingReplay(null);
    setIsProcessing(true);
    UltraDevLog.processingState(true, 'handleApprove');
    setStatus("Executing approved action...");
    try {
      const args: ExecuteArgs = { conversationId, userInput: replay.userInput, replay: true };
      if (replay.type === "approval") args.approvedAction = true;
      else if (replay.type === "model_switch") args.approvedModel = replay.recommendedModel;
      const result = await agentCore.execute(args);
      await handleResult(result, agentCore, conversationId);
    } catch {
      await reloadMessages(agentCore, conversationId);
    }
    setIsProcessing(false);
    UltraDevLog.processingState(false, 'handleApprove_done');
    setStatus("Ready");
  }, [agentCore, conversationId, pendingReplay, handleResult, reloadMessages]);

  const handleDeny = useCallback(async () => {
    if (!agentCore || !conversationId || !pendingReplay) return;
    const replay = pendingReplay;
    setPendingReplay(null);
    if (replay.type === "model_switch") {
      setIsProcessing(true);
      UltraDevLog.processingState(true, 'handleDeny_modelSwitch');
      setStatus("Continuing with current model...");
      try {
        const result = await agentCore.execute({ conversationId, userInput: replay.userInput, replay: true, skipModelSwitchPrompt: true });
        await handleResult(result, agentCore, conversationId);
      } catch {
        await reloadMessages(agentCore, conversationId);
      }
      setIsProcessing(false);
      UltraDevLog.processingState(false, 'handleDeny_modelSwitch_done');
      setStatus("Ready");
    } else {
      const cm = agentCore.getConversationManager();
      await cm.addMessage(conversationId, { id: `msg_${Math.random().toString(36).slice(2)}_${Date.now()}`, role: "assistant", content: "Cancelled.", createdAt: Date.now(), source: "ultra" });
      await reloadMessages(agentCore, conversationId);
    }
  }, [agentCore, conversationId, pendingReplay, handleResult, reloadMessages]);

  // ── Conversation management ────────────────────────
  const handleNewChat = useCallback(async () => {
    if (!agentCore) return;
    const cm = agentCore.getConversationManager();
    const conv = await cm.createConversation();
    setConversationId(conv.id);
    setMessages([]);
    setConversationTitle("New Chat");
    setConversationStarred(false);
    setPendingReplay(null);
    setConvListVisible(false);
    await refreshConversations(agentCore);
  }, [agentCore, refreshConversations]);

  const handleSelectConversation = useCallback(async (id: string) => {
    if (!agentCore) return;
    DebugLog.uiConvSwitch(conversationId ?? "none", id);
    snapUI("conv_switch");
    setConversationId(id);
    setPendingReplay(null);
    const conv = await agentCore.getConversationManager().loadConversation(id);
    setConversationStarred(!!conv?.meta?.starred);
    await reloadMessages(agentCore, id);
    setConvListVisible(false);
  }, [agentCore, reloadMessages, conversationId]);

  const handleDeleteConversation = useCallback(async (id: string) => {
    if (!agentCore) return;
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
  }, [agentCore, conversationId, reloadMessages, refreshConversations]);

  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [renameText, setRenameText] = useState("");

  const handleRenameConversation = useCallback(() => {
    if (!agentCore || !conversationId) return;
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
    }
  }, [handleRenameConversation, handleDeleteConversation, handleNewChat, conversationId, agentCore, refreshConversations]);

  // ── Model picker data ──────────────────────────────
  const getPickerModels = useCallback((): PickerModel[] => {
    if (!agentCore) return [];
    const models = agentCore.getAvailableModels();
    const currentModel = activeModelId || agentCore.getDefaultModel();
    return models.map((m: any) => {
      let pickerType: PickerModel["type"] = m.type || "text";
      if (pickerType === "text") {
        const idLower = (m.id || "").toLowerCase();
        const nameLower = (m.name || "").toLowerCase();
        if (m.capabilities?.supportsReasoning || idLower.includes("reason") || nameLower.includes("reason") || idLower.includes("qwq") || idLower.includes("deepseek-r1")) {
          pickerType = "reasoning";
        } else if (idLower.includes("code") || nameLower.includes("code") || idLower.includes("codestral") || idLower.includes("deepseek-coder")) {
          pickerType = "code";
        }
      }
      return {
        id: m.id,
        name: m.name || m.id,
        type: pickerType,
        apiName: "Venice",
        costIndicator: m.costPer1kInput > 0 ? `$${m.costPer1kInput.toFixed(4)}/1K` : "Free",
        isSelected: m.id === currentModel,
      };
    });
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
  }, [agentCore, activeModelId, snapUI]);

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
    } catch {}
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

      // Show quick replies only on the most recent assistant message
      const showQuickReplies = !isUser && isLatestMessage && !isProcessing && !pendingReplay && item.role !== "system";

      const msgIndex = messages.indexOf(item);

      return (
        <View
          onLayout={(e) => {
            UltraDevLog.messageRendered(
              item.id, item.role as 'user' | 'assistant' | 'system', item.content.length,
              e.nativeEvent.layout.height,
              msgIndex >= 0 ? msgIndex : 0,
              scrollOffsetRef.current, listHeightRef.current,
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
          <Text selectable style={[
            styles.messageText,
            isUser && styles.userText,
            msgStyle === "buildLog" && styles.buildLogText,
          ]}>
            {item.content}
          </Text>

          {/* Message action row: copy + prompt trace */}
          <View style={styles.msgActions}>
            <Pressable onPress={() => handleCopyMessage(item)} hitSlop={8} style={styles.copyBtn}>
              <Ionicons name={isCopied ? "checkmark" : "copy-outline"} size={14} color={isCopied ? ACCENT : DIM} />
              {isCopied && <Text style={styles.copiedInline}>Copied</Text>}
            </Pressable>
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

          {/* Contextual quick-reply chips */}
          {showQuickReplies && (
            <QuickReplies message={item} onSelect={handleQuickReply} />
          )}
        </View>
      );
    },
    [pendingReplay, messages, isProcessing, openPromptViewer, handleApprove, handleDeny, handleCopyMessage, copiedId, handleQuickReply]
  );

  // ── Layout values ──────────────────────────────────
  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;
  const currentModelName = activeModelId || agentCore?.getDefaultModel() || "No model";
  const shortModelName = currentModelName.length > 18 ? currentModelName.slice(0, 18) + "…" : currentModelName;

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopInset }]}>

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
              {conversationTitle}
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
          inverted
          style={styles.messageList}
          contentContainerStyle={styles.messageListContent}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onScroll={(e) => {
            scrollOffsetRef.current = UltraDevLog.listScrolled(
              e.nativeEvent.contentOffset.y,
              e.nativeEvent.layoutMeasurement.height,
              e.nativeEvent.contentSize.height,
            );
            listHeightRef.current = e.nativeEvent.layoutMeasurement.height;
          }}
          scrollEventThrottle={100}
          ListEmptyComponent={
            <View style={[styles.emptyState, Platform.OS !== "web" && { transform: [{ scaleY: -1 }] }]}>
              <MaterialCommunityIcons name="robot-outline" size={48} color={SURFACE2} />
              <Text style={styles.emptyText}>
                Ask me anything. I can manage files, contacts, build apps, and more.
              </Text>
            </View>
          }
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
              style={({ pressed }) => [styles.modelPill, pressed && styles.modelPillPressed]}
            >
              <MaterialCommunityIcons name="robot" size={12} color={DIM} />
              <Text style={styles.modelPillText} numberOfLines={1}>{shortModelName}</Text>
              <Ionicons name="chevron-up" size={12} color="#444" />
            </Pressable>
          </View>

          {/* Input row: + button | text input | send button */}
          <View style={styles.inputRow}>
            <Pressable
              onPress={() => setPlusMenuVisible(true)}
              style={({ pressed }) => [styles.plusBtn, pressed && styles.plusBtnPressed]}
            >
              <Ionicons name="add" size={22} color={DIM} />
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
          DebugLog.uiPlusMenuSelect(type, !!savedDefaults[type], savedDefaults[type] || null);
          snapUI("plus_menu_select");
          setCurrentMode(type);
          setPlusMenuVisible(false);
          const defaultModelId = savedDefaults[type];
          if (defaultModelId && agentCore) {
            try {
              await agentCore.setDefaultModel(defaultModelId);
              setActiveModelId(defaultModelId);
              DebugLog.uiModelApply(defaultModelId, type, "plusMenu_savedDefault", true);
            } catch (err: any) {
              DebugLog.uiModelApply(defaultModelId, type, "plusMenu_savedDefault", false, err?.message);
            }
          } else if (agentCore) {
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
  messageListContent: { paddingHorizontal: 16, paddingVertical: 8, flexGrow: 1 },
  emptyState: {
    flex: 1, justifyContent: "center", alignItems: "center", paddingVertical: 80,
    ...(Platform.OS === "web" ? { transform: [{ scaleY: -1 }] } : {}),
  },
  emptyText: { color: DIM, fontSize: 14, textAlign: "center", marginTop: 12, fontFamily: "Inter_400Regular", maxWidth: 280 },
  messageBubble: { borderRadius: 12, padding: 12, marginBottom: 8, maxWidth: "85%" },
  userBubble: { backgroundColor: ACCENT, alignSelf: "flex-end" },
  ultraBubble: { backgroundColor: SURFACE, alignSelf: "flex-start", borderWidth: 1, borderColor: "#1a3a2a" },
  aiBubble: { backgroundColor: SURFACE, alignSelf: "flex-start", borderWidth: 1, borderColor: "#1a2a3a" },
  blockedBubble: { backgroundColor: "#1a0a0a", alignSelf: "flex-start", borderWidth: 1, borderColor: "#3a1a1a" },
  buildLogBubble: { backgroundColor: "#1a1400", alignSelf: "flex-start", borderWidth: 1, borderColor: "#3a2a00", maxWidth: "95%" },
  buildLogText: { fontFamily: Platform.OS === "web" ? "monospace" : "Courier", fontSize: 11, color: "#ccaa44", lineHeight: 16 },
  systemBubble: { backgroundColor: SURFACE2, alignSelf: "flex-start", borderWidth: 1, borderColor: "#222222" },
  messageHeader: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 },
  roleLabel: { fontSize: 10, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5 },
  capBadge: { fontSize: 9, color: DIM, fontFamily: "Inter_400Regular", backgroundColor: "#1a1a1a", paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, overflow: "hidden", marginLeft: 4 },
  messageText: { color: "#cccccc", fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20 },
  userText: { color: BG },
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

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
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { SecureVault } from "@/src/security/SecureVault";
import { AgentCore, setAgentCoreInstance } from "@/src/core/AgentCore";
import type { ExecuteArgs } from "@/src/core/AgentCore";
import type { ChatMessage, UltraExecutionResult, ConversationMeta, PromptTrace } from "@/src/types/ultra";
import ConversationList from "@/components/ConversationList";
import PromptViewer from "@/components/PromptViewer";

const ACCENT = "#00ff88";
const BG = "#000000";
const SURFACE = "#111111";
const SURFACE2 = "#1a1a1a";
const DIM = "#666666";
const AI_COLOR = "#6bc5ff";
const ULTRA_COLOR = ACCENT;
const WARN_COLOR = "#ff6600";
const BLOCKED_COLOR = "#ff4444";

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState("Initializing...");
  const [agentCore, setAgentCore] = useState<AgentCore | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState("Agent Ultra");
  const [convListVisible, setConvListVisible] = useState(false);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [promptViewerVisible, setPromptViewerVisible] = useState(false);
  const [selectedTrace, setSelectedTrace] = useState<PromptTrace | null>(null);
  const [pendingReplay, setPendingReplay] = useState<{
    userInput: string;
    type: "approval" | "model_switch";
    recommendedModel?: string;
  } | null>(null);
  const inputRef = useRef<TextInput>(null);
  const pulseAnim = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0.3,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, [pulseAnim]);

  const reloadMessages = useCallback(
    async (core: AgentCore, convId: string) => {
      const cm = core.getConversationManager();
      const conv = await cm.loadConversation(convId);
      if (conv) {
        setMessages([...conv.messages].reverse());
        setConversationTitle(conv.title);
      }
    },
    []
  );

  const refreshConversations = useCallback(
    async (core: AgentCore) => {
      const cm = core.getConversationManager();
      const list = await cm.listConversations();
      setConversations(list);
    },
    []
  );

  useEffect(() => {
    async function init() {
      try {
        const vault = await SecureVault.initialize();
        const core = new AgentCore(vault, (msg: string, _type: string) => {
          setStatus(msg);
        });
        await core.initialize();
        setAgentCore(core);
        setAgentCoreInstance(core);
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

        if (!core.hasApiKey()) {
          setStatus("No API key");
        }
      } catch (err: any) {
        setStatus("Init failed");
      }
    }
    init();
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (agentCore) {
        agentCore.refreshApiKey().then(() => {
          if (agentCore.hasApiKey()) {
            setStatus("Ready");
          }
        });
      }
    }, [agentCore])
  );

  const handleResult = useCallback(
    async (result: UltraExecutionResult, core: AgentCore, convId: string) => {
      switch (result.type) {
        case "model_switch_request":
          setPendingReplay({
            userInput: result.data?.replayUserInput || "",
            type: "model_switch",
            recommendedModel: result.data?.recommendedModel,
          });
          break;
        case "approval_required":
          setPendingReplay({
            userInput: result.data?.replayUserInput || "",
            type: "approval",
          });
          break;
        default:
          break;
      }
      await reloadMessages(core, convId);
      await refreshConversations(core);
    },
    [reloadMessages, refreshConversations]
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isProcessing || !agentCore || !conversationId) return;
    setInput("");
    setIsProcessing(true);
    setStatus("Processing...");

    try {
      const result = await agentCore.execute({
        conversationId,
        userInput: text,
      });
      await handleResult(result, agentCore, conversationId);
    } catch (err: any) {
      await reloadMessages(agentCore, conversationId);
    }
    setIsProcessing(false);
    setStatus("Ready");
  }, [input, isProcessing, agentCore, conversationId, handleResult, reloadMessages]);

  const handleApprove = useCallback(async () => {
    if (!agentCore || !conversationId || !pendingReplay) return;
    const replay = pendingReplay;
    setPendingReplay(null);
    setIsProcessing(true);
    setStatus("Executing approved action...");

    try {
      const args: ExecuteArgs = {
        conversationId,
        userInput: replay.userInput,
        replay: true,
      };
      if (replay.type === "approval") {
        args.approvedAction = true;
      } else if (replay.type === "model_switch") {
        args.approvedModel = replay.recommendedModel;
      }
      const result = await agentCore.execute(args);
      await handleResult(result, agentCore, conversationId);
    } catch (err: any) {
      await reloadMessages(agentCore, conversationId);
    }
    setIsProcessing(false);
    setStatus("Ready");
  }, [agentCore, conversationId, pendingReplay, handleResult, reloadMessages]);

  const handleDeny = useCallback(async () => {
    if (!agentCore || !conversationId || !pendingReplay) return;
    const replay = pendingReplay;
    setPendingReplay(null);

    if (replay.type === "model_switch") {
      setIsProcessing(true);
      setStatus("Continuing with current model...");
      try {
        const result = await agentCore.execute({
          conversationId,
          userInput: replay.userInput,
          replay: true,
          skipModelSwitchPrompt: true,
        });
        await handleResult(result, agentCore, conversationId);
      } catch (err: any) {
        await reloadMessages(agentCore, conversationId);
      }
      setIsProcessing(false);
      setStatus("Ready");
    } else {
      const cm = agentCore.getConversationManager();
      await cm.addMessage(conversationId, {
        id: `msg_${Math.random().toString(36).slice(2)}_${Date.now()}`,
        role: "assistant",
        content: "Cancelled.",
        createdAt: Date.now(),
        source: "ultra",
      });
      await reloadMessages(agentCore, conversationId);
    }
  }, [agentCore, conversationId, pendingReplay, handleResult, reloadMessages]);

  const handleNewChat = useCallback(async () => {
    if (!agentCore) return;
    const cm = agentCore.getConversationManager();
    const conv = await cm.createConversation();
    setConversationId(conv.id);
    setMessages([]);
    setConversationTitle("New Chat");
    setPendingReplay(null);
    setConvListVisible(false);
    await refreshConversations(agentCore);
  }, [agentCore, refreshConversations]);

  const handleSelectConversation = useCallback(
    async (id: string) => {
      if (!agentCore) return;
      setConversationId(id);
      setPendingReplay(null);
      await reloadMessages(agentCore, id);
      setConvListVisible(false);
    },
    [agentCore, reloadMessages]
  );

  const handleDeleteConversation = useCallback(
    async (id: string) => {
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
        }
      }
      await refreshConversations(agentCore);
    },
    [agentCore, conversationId, reloadMessages, refreshConversations]
  );

  const openConvList = useCallback(async () => {
    if (agentCore) await refreshConversations(agentCore);
    setConvListVisible(true);
  }, [agentCore, refreshConversations]);

  const openPromptViewer = useCallback((trace: PromptTrace) => {
    setSelectedTrace(trace);
    setPromptViewerVisible(true);
  }, []);

  const getMessageStyle = (msg: ChatMessage) => {
    if (msg.role === "user") return "user" as const;
    if (msg.role === "system") return "system" as const;
    if (msg.source === "ultra") {
      const risk = msg.meta?.risk;
      if (risk === "dangerous" || risk === "blocked") return "blocked" as const;
      return "ultra" as const;
    }
    return "ai" as const;
  };

  const renderMessage = useCallback(
    ({ item }: { item: ChatMessage }) => {
      const msgStyle = getMessageStyle(item);
      const isUser = msgStyle === "user";
      const trace = item.meta?.promptTrace;
      const isApprovalOrSwitch =
        item.content.startsWith("Approval required") ||
        item.content.startsWith("I recommend switching");
      const isLatestMessage = messages.length > 0 && item.id === messages[0].id;
      const showPendingButtons = !!pendingReplay && isApprovalOrSwitch && isLatestMessage;

      return (
        <View
          style={[
            styles.messageBubble,
            msgStyle === "user" ? styles.userBubble :
            msgStyle === "ultra" ? styles.ultraBubble :
            msgStyle === "ai" ? styles.aiBubble :
            msgStyle === "blocked" ? styles.blockedBubble :
            styles.systemBubble,
          ]}
        >
          {!isUser && (
            <View style={styles.messageHeader}>
              {msgStyle === "ultra" ? (
                <MaterialCommunityIcons name="robot" size={14} color={ULTRA_COLOR} />
              ) : msgStyle === "ai" ? (
                <Ionicons name="sparkles" size={14} color={AI_COLOR} />
              ) : msgStyle === "blocked" ? (
                <Ionicons name="shield" size={14} color={BLOCKED_COLOR} />
              ) : (
                <Ionicons name="information-circle" size={14} color={DIM} />
              )}
              <Text
                style={[
                  styles.roleLabel,
                  msgStyle === "ultra" ? { color: ULTRA_COLOR } :
                  msgStyle === "ai" ? { color: AI_COLOR } :
                  msgStyle === "blocked" ? { color: BLOCKED_COLOR } :
                  { color: DIM },
                ]}
              >
                {msgStyle === "ultra" ? "ULTRA" :
                 msgStyle === "ai" ? "AI" :
                 msgStyle === "blocked" ? "BLOCKED" :
                 "SYSTEM"}
              </Text>
              {item.meta?.capability && (
                <Text style={styles.capBadge}>{item.meta.capability}</Text>
              )}
            </View>
          )}
          <Text style={[styles.messageText, isUser && styles.userText]}>
            {item.content}
          </Text>
          {trace && !isUser && (
            <Pressable
              onPress={() => openPromptViewer(trace)}
              style={styles.viewPromptBtn}
              hitSlop={8}
            >
              <Ionicons name="eye-outline" size={12} color={DIM} />
              <Text style={styles.viewPromptText}>View Prompt</Text>
            </Pressable>
          )}
          {showPendingButtons && (
            <View style={styles.approvalRow}>
              <Pressable
                onPress={handleApprove}
                style={[styles.approvalBtn, styles.approveBtn]}
                disabled={isProcessing}
              >
                <Ionicons name="checkmark" size={16} color="#000" />
                <Text style={styles.approveBtnText}>Approve</Text>
              </Pressable>
              <Pressable
                onPress={handleDeny}
                style={[styles.approvalBtn, styles.denyBtn]}
                disabled={isProcessing}
              >
                <Ionicons name="close" size={16} color="#fff" />
                <Text style={styles.denyBtnText}>Deny</Text>
              </Pressable>
            </View>
          )}
        </View>
      );
    },
    [pendingReplay, messages, isProcessing, openPromptViewer, handleApprove, handleDeny]
  );

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopInset }]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Pressable onPress={openConvList} style={styles.convListBtn} testID="open-conversations">
            <Ionicons name="menu" size={22} color="#ffffff" />
          </Pressable>
          <Animated.View style={[styles.statusDot, { opacity: pulseAnim }]} />
          <Text style={styles.headerTitle} numberOfLines={1}>
            {conversationTitle}
          </Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.statusText}>{status}</Text>
          <Pressable
            onPress={() => router.push("/settings")}
            style={styles.settingsBtn}
            testID="settings-button"
          >
            <Ionicons name="settings-outline" size={22} color={ACCENT} />
          </Pressable>
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        keyboardVerticalOffset={0}
      >
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
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <MaterialCommunityIcons
                name="robot-outline"
                size={48}
                color={SURFACE2}
              />
              <Text style={styles.emptyText}>
                Ask me anything. I can manage files, contacts, build apps, and
                more.
              </Text>
            </View>
          }
          testID="message-list"
        />

        <View
          style={[
            styles.inputBar,
            {
              paddingBottom: Math.max(insets.bottom, webBottomInset) + 8,
            },
          ]}
        >
          {isProcessing && (
            <View style={styles.processingBar}>
              <ActivityIndicator size="small" color={ACCENT} />
              <Text style={styles.processingText}>{status}</Text>
            </View>
          )}
          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              placeholder="Ask Agent Ultra..."
              placeholderTextColor={DIM}
              style={styles.input}
              multiline
              maxLength={4000}
              returnKeyType="send"
              onSubmitEditing={handleSend}
              blurOnSubmit={false}
              editable={!isProcessing}
              testID="chat-input"
            />
            <Pressable
              onPress={() => {
                handleSend();
                inputRef.current?.focus();
              }}
              disabled={isProcessing || !input.trim()}
              style={[
                styles.sendBtn,
                (!input.trim() || isProcessing) && styles.sendBtnDisabled,
              ]}
              testID="send-button"
            >
              <Ionicons
                name="send"
                size={20}
                color={!input.trim() || isProcessing ? DIM : BG}
              />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      <ConversationList
        visible={convListVisible}
        conversations={conversations}
        currentConversationId={conversationId}
        onSelect={handleSelectConversation}
        onDelete={handleDeleteConversation}
        onNewChat={handleNewChat}
        onClose={() => setConvListVisible(false)}
      />

      <PromptViewer
        visible={promptViewerVisible}
        trace={selectedTrace}
        onClose={() => setPromptViewerVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BG,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: SURFACE,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  convListBtn: {
    padding: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: ACCENT,
  },
  headerTitle: {
    color: "#ffffff",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    flex: 1,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  statusText: {
    color: DIM,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  settingsBtn: {
    padding: 4,
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexGrow: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 80,
    transform: [{ scaleY: -1 }],
  },
  emptyText: {
    color: DIM,
    fontSize: 14,
    textAlign: "center",
    marginTop: 12,
    fontFamily: "Inter_400Regular",
    maxWidth: 280,
  },
  messageBubble: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    maxWidth: "85%",
  },
  userBubble: {
    backgroundColor: ACCENT,
    alignSelf: "flex-end",
  },
  ultraBubble: {
    backgroundColor: SURFACE,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#1a3a2a",
  },
  aiBubble: {
    backgroundColor: SURFACE,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#1a2a3a",
  },
  blockedBubble: {
    backgroundColor: "#1a0a0a",
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#3a1a1a",
  },
  systemBubble: {
    backgroundColor: SURFACE2,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#222222",
  },
  messageHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 4,
  },
  roleLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  capBadge: {
    fontSize: 9,
    color: DIM,
    fontFamily: "Inter_400Regular",
    backgroundColor: "#1a1a1a",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: "hidden",
    marginLeft: 4,
  },
  messageText: {
    color: "#cccccc",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  userText: {
    color: BG,
  },
  viewPromptBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 6,
    alignSelf: "flex-start",
  },
  viewPromptText: {
    color: DIM,
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  approvalRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
  },
  approvalBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  approveBtn: {
    backgroundColor: ACCENT,
  },
  denyBtn: {
    backgroundColor: "#333",
  },
  approveBtnText: {
    color: "#000",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  denyBtnText: {
    color: "#fff",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  inputBar: {
    borderTopWidth: 1,
    borderTopColor: SURFACE,
    paddingHorizontal: 16,
    paddingTop: 8,
    backgroundColor: BG,
  },
  processingBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingBottom: 8,
  },
  processingText: {
    color: ACCENT,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: SURFACE,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: "#ffffff",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    maxHeight: 120,
    borderWidth: 1,
    borderColor: SURFACE2,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: ACCENT,
    justifyContent: "center",
    alignItems: "center",
  },
  sendBtnDisabled: {
    backgroundColor: SURFACE,
  },
});

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
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { SecureVault } from "@/src/security/SecureVault";
import { AgentCore, ExecutionResult } from "@/src/core/AgentCore";

interface ChatMessage {
  id: string;
  role: "user" | "agent" | "system" | "confirm";
  content: string;
  timestamp: number;
  cost?: number;
  agentCount?: number;
  originalRequest?: string;
}

const ACCENT = "#00ff88";
const BG = "#000000";
const SURFACE = "#111111";
const SURFACE2 = "#1a1a1a";
const DIM = "#666666";

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState("Initializing...");
  const [agentCore, setAgentCore] = useState<AgentCore | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);
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

  useEffect(() => {
    async function init() {
      try {
        const vault = await SecureVault.initialize();
        const core = new AgentCore(vault, (msg: string, type: string) => {
          setStatus(msg);
          if (type === "system" || type === "agent") {
            addMessage("system", msg);
          }
        });
        await core.initialize();
        setAgentCore(core);
        setStatus("Ready");

        const hasKey = core["ai" as keyof AgentCore] &&
          (core["ai" as keyof AgentCore] as any).hasApiKey();
        if (!hasKey) {
          addMessage(
            "system",
            "Welcome to Agent Ultra. Add your Venice API key in Settings to get started."
          );
        } else {
          addMessage("system", "Agent Ultra online. All systems operational.");
        }
      } catch (err: any) {
        setStatus("Init failed");
        addMessage("system", "Initialization error: " + err.message);
      }
    }
    init();
  }, []);

  const addMessage = useCallback(
    (role: ChatMessage["role"], content: string, extra?: Partial<ChatMessage>) => {
      const msg: ChatMessage = {
        id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
        role,
        content,
        timestamp: Date.now(),
        ...extra,
      };
      setMessages((prev) => [msg, ...prev]);
    },
    []
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isProcessing || !agentCore) return;
    setInput("");
    addMessage("user", text);

    if (pendingConfirm) {
      const confirmed = text.toLowerCase() === "yes";
      setIsProcessing(true);
      setStatus("Processing confirmation...");
      try {
        const result = await agentCore.handleConfirmation(confirmed, pendingConfirm);
        handleResult(result);
      } catch (err: any) {
        addMessage("system", "Error: " + err.message);
      }
      setPendingConfirm(null);
      setIsProcessing(false);
      setStatus("Ready");
      return;
    }

    setIsProcessing(true);
    setStatus("Processing...");
    try {
      const result = await agentCore.execute(text);
      handleResult(result);
    } catch (err: any) {
      addMessage("system", "Error: " + err.message);
    }
    setIsProcessing(false);
    setStatus("Ready");
  }, [input, isProcessing, agentCore, pendingConfirm, addMessage]);

  const handleResult = useCallback(
    (result: ExecutionResult) => {
      switch (result.type) {
        case "result":
          addMessage("agent", result.summary || "Done.", {
            cost: result.cost,
            agentCount: result.agentCount,
          });
          break;
        case "clarify":
          addMessage("agent", result.question || "Could you clarify?");
          break;
        case "confirm":
          addMessage("confirm", result.warning || "Confirm?");
          setPendingConfirm(result.warning || "");
          break;
        case "error":
          addMessage("system", result.error || "Unknown error");
          break;
      }
    },
    [addMessage]
  );

  const renderMessage = useCallback(
    ({ item }: { item: ChatMessage }) => {
      const isUser = item.role === "user";
      const isSystem = item.role === "system";
      const isConfirm = item.role === "confirm";

      return (
        <View
          style={[
            styles.messageBubble,
            isUser
              ? styles.userBubble
              : isConfirm
              ? styles.confirmBubble
              : isSystem
              ? styles.systemBubble
              : styles.agentBubble,
          ]}
        >
          {!isUser && (
            <View style={styles.messageHeader}>
              {isConfirm ? (
                <Ionicons name="warning" size={14} color="#ff6600" />
              ) : isSystem ? (
                <Ionicons name="information-circle" size={14} color={DIM} />
              ) : (
                <MaterialCommunityIcons name="robot" size={14} color={ACCENT} />
              )}
              <Text
                style={[
                  styles.roleLabel,
                  isConfirm
                    ? { color: "#ff6600" }
                    : isSystem
                    ? { color: DIM }
                    : { color: ACCENT },
                ]}
              >
                {isConfirm ? "CONFIRM" : isSystem ? "SYSTEM" : "AGENT"}
              </Text>
            </View>
          )}
          <Text style={[styles.messageText, isUser && styles.userText]}>
            {item.content}
          </Text>
          {(item.cost !== undefined || item.agentCount !== undefined) && (
            <View style={styles.metaRow}>
              {item.cost !== undefined && (
                <View style={styles.metaItem}>
                  <Ionicons name="cash-outline" size={10} color={DIM} />
                  <Text style={styles.metaText}>
                    ${item.cost.toFixed(4)}
                  </Text>
                </View>
              )}
              {item.agentCount !== undefined && (
                <View style={styles.metaItem}>
                  <MaterialCommunityIcons
                    name="account-group"
                    size={10}
                    color={DIM}
                  />
                  <Text style={styles.metaText}>
                    {item.agentCount} agents
                  </Text>
                </View>
              )}
            </View>
          )}
          {isConfirm && (
            <Text style={styles.confirmHint}>
              Reply "yes" to proceed or anything else to cancel
            </Text>
          )}
        </View>
      );
    },
    []
  );

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopInset }]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Animated.View
            style={[styles.statusDot, { opacity: pulseAnim }]}
          />
          <Text style={styles.headerTitle}>Agent Ultra</Text>
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
              placeholder={
                pendingConfirm
                  ? 'Type "yes" to confirm...'
                  : "Ask Agent Ultra..."
              }
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
                color={
                  !input.trim() || isProcessing ? DIM : BG
                }
              />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: SURFACE,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: ACCENT,
  },
  headerTitle: {
    color: "#ffffff",
    fontSize: 18,
    fontFamily: "Inter_700Bold",
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
  agentBubble: {
    backgroundColor: SURFACE,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#1a3a2a",
  },
  systemBubble: {
    backgroundColor: SURFACE2,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#222222",
  },
  confirmBubble: {
    backgroundColor: "#1a1200",
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#4a3000",
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
  metaRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 6,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  metaText: {
    color: DIM,
    fontSize: 10,
    fontFamily: "Inter_400Regular",
  },
  confirmHint: {
    color: "#996600",
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 6,
    fontStyle: "italic",
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

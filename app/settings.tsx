import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  StyleSheet,
  Alert,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as Clipboard from "expo-clipboard";
import { SecureVault } from "@/src/security/SecureVault";
import { getAgentCoreInstance } from "@/src/core/AgentCore";
import { ModelDef } from "@/src/core/ModelRouter";
import { Logger } from "@/src/utils/Logger";

const ACCENT = "#00ff88";
const BG = "#000000";
const SURFACE = "#111111";
const SURFACE2 = "#1a1a1a";
const DIM = "#666666";

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [storedKey, setStoredKey] = useState(false);
  const [dailyLimit, setDailyLimit] = useState("5.00");
  const [taskLimit, setTaskLimit] = useState("1.00");
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [models, setModels] = useState<ModelDef[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    loadSettings();
    loadModels();
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const vault = await SecureVault.initialize();
      const key = await vault.get("venice_api_key");
      if (key) {
        setStoredKey(true);
        setApiKey("••••••••" + key.slice(-4));
      }
      const dl = await vault.get("daily_cost_limit");
      if (dl) setDailyLimit(dl);
      const tl = await vault.get("task_cost_limit");
      if (tl) setTaskLimit(tl);
    } catch (err: any) {
      Alert.alert("Error", "Failed to load settings: " + err.message);
    }
  }, []);

  const loadModels = useCallback(async () => {
    const core = getAgentCoreInstance();
    if (!core) return;
    setLoadingModels(true);
    try {
      await core.refreshApiKey();
      const available = core.getAvailableModels();
      setModels(available);
      setSelectedModel(core.getDefaultModel());
    } catch (err: any) {
      // silently fail
    }
    setLoadingModels(false);
  }, []);

  const selectModel = useCallback(async (modelId: string) => {
    const core = getAgentCoreInstance();
    if (!core) return;
    try {
      await core.setDefaultModel(modelId);
      setSelectedModel(modelId);
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }, []);

  const saveApiKey = useCallback(async () => {
    if (!apiKey || apiKey.startsWith("••")) return;
    try {
      const vault = await SecureVault.initialize();
      await vault.set("venice_api_key", apiKey.trim());
      setStoredKey(true);
      setApiKey("••••••••" + apiKey.trim().slice(-4));
      Alert.alert("Saved", "Venice API key stored securely. Go back to start chatting.");
      loadModels();
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }, [apiKey, loadModels]);

  const clearApiKey = useCallback(async () => {
    try {
      const vault = await SecureVault.initialize();
      await vault.delete("venice_api_key");
      setStoredKey(false);
      setApiKey("");
      setModels([]);
      Alert.alert("Cleared", "API key removed.");
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }, []);

  const saveLimits = useCallback(async () => {
    try {
      const vault = await SecureVault.initialize();
      await vault.set("daily_cost_limit", dailyLimit);
      await vault.set("task_cost_limit", taskLimit);
      Alert.alert("Saved", "Cost limits updated.");
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }, [dailyLimit, taskLimit]);

  const loadLogs = useCallback(() => {
    const entries = Logger.getEntries(undefined, 200);
    setLogs(
      entries.map(
        (e) =>
          `[${new Date(e.timestamp).toISOString()}][${e.level}][${e.context}] ${e.message}${e.metadata ? ' ' + JSON.stringify(e.metadata) : ''}`
      )
    );
    setShowLogs(!showLogs);
  }, [showLogs]);

  const downloadLogs = useCallback(async () => {
    const hr = '='.repeat(60);
    const sections: string[] = [];
    const ts = (t: number) => new Date(t).toISOString();

    sections.push(hr);
    sections.push('AGENT ULTRA — FULL DEBUG LOG');
    sections.push(hr);
    sections.push(`Generated: ${new Date().toISOString()}`);
    sections.push(`Platform: ${Platform.OS}`);
    sections.push('');

    const core = getAgentCoreInstance();

    if (core) {
      try {
        const cm = core.getConversationManager();
        const convList = await cm.listConversations();
        for (let ci = 0; ci < convList.length; ci++) {
          const convMeta = convList[ci];
          const conv = await cm.loadConversation(convMeta.id);
          if (!conv || conv.messages.length === 0) continue;

          sections.push(hr);
          sections.push(`CONVERSATION ${ci + 1}/${convList.length}: "${conv.title}" (${conv.messages.length} messages)`);
          sections.push(`ID: ${conv.id}`);
          sections.push(hr);
          sections.push('');

          for (const msg of conv.messages) {
            const role = msg.role.toUpperCase();
            const source = msg.source ? ` [${msg.source}]` : '';
            const cap = msg.meta?.capability ? ` {${msg.meta.capability}}` : '';
            const risk = msg.meta?.risk ? ` risk=${msg.meta.risk}` : '';
            sections.push(`--- ${ts(msg.createdAt)} ${role}${source}${cap}${risk} ---`);
            sections.push(msg.content);
            sections.push('');

            if (msg.meta?.promptTrace) {
              const t = msg.meta.promptTrace;
              sections.push('  [TRACE] Model: ' + t.model);
              if (t.mode) sections.push('  [TRACE] Mode: ' + t.mode);
              if (t.deterministic !== undefined) sections.push('  [TRACE] Deterministic: ' + t.deterministic);
              if (t.durationMs !== undefined) sections.push('  [TRACE] Duration: ' + t.durationMs + 'ms');
              if (t.taskId) sections.push('  [TRACE] Task ID: ' + t.taskId);

              if (t.plan) {
                sections.push('  [TRACE] Plan: ' + JSON.stringify(t.plan));
              }

              if (t.safetyCheck) {
                sections.push('  [TRACE] Safety: risk=' + t.safetyCheck.risk + ' allowed=' + t.safetyCheck.allowed + ' reasons=[' + t.safetyCheck.reasons.join('; ') + ']');
              }

              if (t.verification) {
                sections.push('  [TRACE] Verification: verified=' + t.verification.verified + (t.verification.issues.length > 0 ? ' issues=[' + t.verification.issues.join('; ') + ']' : ''));
              }

              if (t.permissionState) {
                sections.push('  [TRACE] Permissions: ' + t.permissionState);
              }

              if (t.error) {
                sections.push('  [TRACE] ERROR:');
                sections.push('  ' + t.error);
              }

              if (t.rawResult) {
                const rawTrunc = t.rawResult.length > 2000 ? t.rawResult.slice(0, 2000) + '...' : t.rawResult;
                sections.push('  [TRACE] Raw Result: ' + rawTrunc);
              }

              if (t.executionSteps && t.executionSteps.length > 0) {
                sections.push('  [TRACE] Execution Steps:');
                t.executionSteps.forEach((s, i) => {
                  sections.push(`    ${i + 1}. ${s.step} [${s.success ? 'PASS' : 'FAIL'}] @ ${ts(s.timestamp)}`);
                  sections.push(`       ${s.detail}`);
                });
              }

              sections.push('  [TRACE] System Prompt: ' + t.systemPrompt.slice(0, 500));
              sections.push('  [TRACE] Framed Message: ' + t.framedUserMessage);
              sections.push('');
            }
          }
        }
      } catch {}

      try {
        const ledger = core.getExecutionLedger();
        const events = await ledger.getEvents();
        if (events.length > 0) {
          sections.push(hr);
          sections.push(`EXECUTION LEDGER (${events.length} events)`);
          sections.push(hr);
          for (const e of events) {
            sections.push(`${ts(e.timestamp)} | ${e.phase} | ${e.capability || '-'} | ${e.success ? 'OK' : 'FAIL'} | model=${e.model || '-'} | cost=${e.cost ?? 0}`);
            sections.push(`  input: ${e.inputSummary}`);
            sections.push(`  output: ${e.outputSummary}`);
          }
          sections.push('');
        }
      } catch {}
    }

    const entries = Logger.getEntries(undefined, 500);
    if (entries.length > 0) {
      sections.push(hr);
      sections.push(`SYSTEM LOGS (${entries.length} entries)`);
      sections.push(hr);
      for (const e of entries) {
        sections.push(`${ts(e.timestamp)} [${e.level.toUpperCase()}][${e.context}] ${e.message}${e.metadata ? ' ' + JSON.stringify(e.metadata) : ''}`);
      }
      sections.push('');
    }

    sections.push(hr);
    sections.push('END OF LOG');
    sections.push(hr);

    const logText = sections.join('\n');

    if (Platform.OS === "web") {
      try {
        await Clipboard.setStringAsync(logText);
        Alert.alert("Copied", "Full debug log copied to clipboard.");
      } catch {
        Alert.alert("Error", "Failed to copy logs.");
      }
      return;
    }
    try {
      const dir = FileSystem.documentDirectory;
      if (!dir) {
        await Clipboard.setStringAsync(logText);
        Alert.alert("Copied", "File system unavailable. Log copied to clipboard.");
        return;
      }
      const path = `${dir}agent_ultra_debug_${Date.now()}.txt`;
      await FileSystem.writeAsStringAsync(path, logText, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(path, {
          mimeType: "text/plain",
          dialogTitle: "Download Agent Ultra Logs",
          UTI: "public.plain-text",
        });
      } else {
        await Clipboard.setStringAsync(logText);
        Alert.alert("Copied", "Sharing unavailable. Log copied to clipboard.");
      }
    } catch (err: any) {
      console.error("Log download failed:", err);
      try {
        await Clipboard.setStringAsync(logText);
        Alert.alert("Copied", `Share failed (${err.message}). Log copied to clipboard instead.`);
      } catch {
        Alert.alert("Error", `Export failed: ${err.message}`);
      }
    }
  }, []);

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top + webTopInset,
          paddingBottom: insets.bottom + webBottomInset,
        },
      ]}
    >
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backBtn}
          testID="back-button"
        >
          <Ionicons name="chevron-back" size={24} color={ACCENT} />
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="key-outline" size={18} color={ACCENT} />
            <Text style={styles.sectionTitle}>Venice API Key</Text>
          </View>
          <Text style={styles.sectionDesc}>
            Get your API key from venice.ai. Required for all AI features.
          </Text>
          <TextInput
            value={apiKey}
            onChangeText={setApiKey}
            placeholder="Enter Venice API key..."
            placeholderTextColor={DIM}
            style={styles.textInput}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={!apiKey.startsWith("••")}
            testID="api-key-input"
          />
          <View style={styles.buttonRow}>
            <Pressable
              onPress={saveApiKey}
              style={[styles.btn, styles.primaryBtn]}
              testID="save-key-button"
            >
              <Ionicons name="save-outline" size={16} color={BG} />
              <Text style={styles.primaryBtnText}>Save Key</Text>
            </Pressable>
            {storedKey && (
              <Pressable
                onPress={clearApiKey}
                style={[styles.btn, styles.dangerBtn]}
              >
                <Ionicons name="trash-outline" size={16} color="#ff4444" />
                <Text style={styles.dangerBtnText}>Clear</Text>
              </Pressable>
            )}
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <MaterialCommunityIcons name="robot-outline" size={18} color={ACCENT} />
            <Text style={styles.sectionTitle}>AI Model</Text>
          </View>
          {!storedKey ? (
            <Text style={styles.sectionDesc}>
              Add your API key above to see available models.
            </Text>
          ) : loadingModels ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={ACCENT} />
              <Text style={styles.sectionDesc}>Loading models...</Text>
            </View>
          ) : models.length === 0 ? (
            <View>
              <Text style={styles.sectionDesc}>
                No models discovered. Check your API key or connection.
              </Text>
              <Pressable
                onPress={loadModels}
                style={[styles.btn, styles.secondaryBtn, { alignSelf: "flex-start", marginTop: 8 }]}
              >
                <Ionicons name="refresh-outline" size={16} color={ACCENT} />
                <Text style={styles.secondaryBtnText}>Retry</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.modelList}>
              <Text style={styles.sectionDesc}>
                Select the default model for AI requests.
              </Text>
              {models.map((m) => {
                const isSelected = m.id === selectedModel;
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => selectModel(m.id)}
                    style={[
                      styles.modelRow,
                      isSelected && styles.modelRowSelected,
                    ]}
                  >
                    <View style={styles.modelInfo}>
                      <Text
                        style={[
                          styles.modelName,
                          isSelected && styles.modelNameSelected,
                        ]}
                        numberOfLines={1}
                      >
                        {m.id}
                      </Text>
                      {m.strengths.length > 0 && (
                        <Text style={styles.modelStrengths} numberOfLines={1}>
                          {m.strengths.join(" · ")}
                        </Text>
                      )}
                    </View>
                    <View
                      style={[
                        styles.radioOuter,
                        isSelected && styles.radioOuterSelected,
                      ]}
                    >
                      {isSelected && <View style={styles.radioInner} />}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="cash-outline" size={18} color={ACCENT} />
            <Text style={styles.sectionTitle}>Cost Limits</Text>
          </View>
          <View style={styles.limitRow}>
            <Text style={styles.limitLabel}>Daily limit ($)</Text>
            <TextInput
              value={dailyLimit}
              onChangeText={setDailyLimit}
              style={styles.limitInput}
              keyboardType="decimal-pad"
              placeholderTextColor={DIM}
            />
          </View>
          <View style={styles.limitRow}>
            <Text style={styles.limitLabel}>Per-task limit ($)</Text>
            <TextInput
              value={taskLimit}
              onChangeText={setTaskLimit}
              style={styles.limitInput}
              keyboardType="decimal-pad"
              placeholderTextColor={DIM}
            />
          </View>
          <Pressable
            onPress={saveLimits}
            style={[styles.btn, styles.primaryBtn, { alignSelf: "flex-start" }]}
          >
            <Ionicons name="save-outline" size={16} color={BG} />
            <Text style={styles.primaryBtnText}>Save Limits</Text>
          </Pressable>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <MaterialCommunityIcons name="wrench-outline" size={18} color={ACCENT} />
            <Text style={styles.sectionTitle}>System</Text>
          </View>
          <Pressable
            onPress={loadLogs}
            style={[styles.btn, styles.secondaryBtn]}
          >
            <Ionicons name="document-text-outline" size={16} color={ACCENT} />
            <Text style={styles.secondaryBtnText}>
              {showLogs ? "Hide Logs" : "View Logs"}
            </Text>
          </Pressable>
          {showLogs && (
            <View style={styles.logContainer}>
              <ScrollView
                nestedScrollEnabled
                style={styles.logScroll}
                showsVerticalScrollIndicator
              >
                {logs.length === 0 ? (
                  <Text style={styles.logText}>No logs yet</Text>
                ) : (
                  logs.map((log, i) => (
                    <Text key={i} style={styles.logText}>
                      {log}
                    </Text>
                  ))
                )}
              </ScrollView>
              {logs.length > 0 && (
                <Pressable
                  onPress={downloadLogs}
                  style={[styles.btn, styles.secondaryBtn, { marginTop: 8 }]}
                >
                  <Ionicons name="download-outline" size={16} color={ACCENT} />
                  <Text style={styles.secondaryBtnText}>Download</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="information-circle-outline" size={18} color={ACCENT} />
            <Text style={styles.sectionTitle}>About</Text>
          </View>
          <Text style={styles.aboutText}>Agent Ultra v1.0.0</Text>
          <Text style={styles.aboutText}>
            Autonomous AI agent with Venice API integration, multi-agent swarm
            orchestration, on-device APK compilation, and self-healing debug
            engine.
          </Text>
        </View>
      </ScrollView>
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
  backBtn: {
    padding: 4,
  },
  headerTitle: {
    color: "#ffffff",
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 24,
    paddingBottom: 40,
  },
  section: {
    backgroundColor: SURFACE,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sectionTitle: {
    color: "#ffffff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  sectionDesc: {
    color: DIM,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  textInput: {
    backgroundColor: SURFACE2,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#ffffff",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    borderWidth: 1,
    borderColor: "#222222",
  },
  buttonRow: {
    flexDirection: "row",
    gap: 12,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  primaryBtn: {
    backgroundColor: ACCENT,
  },
  primaryBtnText: {
    color: BG,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  secondaryBtn: {
    backgroundColor: SURFACE2,
    borderWidth: 1,
    borderColor: "#1a3a2a",
  },
  secondaryBtnText: {
    color: ACCENT,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  dangerBtn: {
    backgroundColor: "#1a0000",
    borderWidth: 1,
    borderColor: "#4a0000",
  },
  dangerBtnText: {
    color: "#ff4444",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  limitRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  limitLabel: {
    color: "#cccccc",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  limitInput: {
    backgroundColor: SURFACE2,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: "#ffffff",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    width: 100,
    textAlign: "center",
    borderWidth: 1,
    borderColor: "#222222",
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  modelList: {
    gap: 8,
  },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: SURFACE2,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#222222",
  },
  modelRowSelected: {
    borderColor: ACCENT,
    backgroundColor: "#001a0d",
  },
  modelInfo: {
    flex: 1,
    marginRight: 12,
  },
  modelName: {
    color: "#cccccc",
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  modelNameSelected: {
    color: ACCENT,
  },
  modelStrengths: {
    color: DIM,
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#444444",
    alignItems: "center",
    justifyContent: "center",
  },
  radioOuterSelected: {
    borderColor: ACCENT,
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: ACCENT,
  },
  logContainer: {
    backgroundColor: SURFACE2,
    borderRadius: 8,
    padding: 12,
  },
  logScroll: {
    maxHeight: 400,
  },
  logText: {
    color: "#888888",
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    lineHeight: 16,
  },
  aboutText: {
    color: DIM,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
});

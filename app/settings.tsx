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
import { useRouter, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { SecureVault } from "@/src/security/SecureVault";
import { getAgentCoreInstance } from "@/src/core/AgentCore";
import { Logger } from "@/src/utils/Logger";
import UsageIndicator, { ModelUsage } from "@/components/UsageIndicator";

// ── Palette ────────────────────────────────────────────
const ACCENT = "#4ade80";
const BG = "#000000";
const SURFACE = "#0e0e0e";
const SURFACE2 = "#161616";
const SURFACE3 = "#222222";
const DIM = "#666666";
const TEXT = "#e0e0e0";
const DANGER = "#ef4444";

// ── Types ──────────────────────────────────────────────
interface SavedApi {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  password: string; // optional auth token/password
}

type DefaultRole = "chat" | "image" | "code" | "reasoning" | "video";

interface ApiDefaults {
  chat: string;       // API id
  image: string;
  code: string;
  reasoning: string;
  video: string;
}

// Settings tabs
type SettingsTab = "apis" | "costs" | "logs";

// ── Main Component ─────────────────────────────────────
export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();
  const initialTab = (params.tab === "costs" || params.tab === "logs") ? params.tab : "apis";
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  // ── API state ──────────────────────────────────────
  const [apis, setApis] = useState<SavedApi[]>([]);
  const [editingApi, setEditingApi] = useState<SavedApi | null>(null);
  const [isNewApi, setIsNewApi] = useState(false);
  const [defaults, setDefaults] = useState<ApiDefaults>({
    chat: "", image: "", code: "", reasoning: "", video: "",
  });

  // ── Cost state ─────────────────────────────────────
  const [dailyLimit, setDailyLimit] = useState("0");
  const [taskLimit, setTaskLimit] = useState("0");
  const [totalCost, setTotalCost] = useState(0);
  const [totalCalls, setTotalCalls] = useState(0);
  const [modelUsages, setModelUsages] = useState<ModelUsage[]>([]);

  // ── Log state ──────────────────────────────────────
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoaded, setLogsLoaded] = useState(false);

  // ── Load settings on mount ─────────────────────────
  useEffect(() => {
    loadSettings();
    loadCostData();
    if (initialTab === "logs") loadLogs();
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const vault = await SecureVault.initialize();

      // Load saved APIs
      const savedApis = await vault.get("saved_apis");
      if (savedApis) {
        try { setApis(JSON.parse(savedApis)); } catch {}
      } else {
        // Migration: if there's an existing Venice API key, create a saved API entry for it
        const legacyKey = await vault.get("venice_api_key");
        const legacyUrl = await vault.get("api_base_url");
        if (legacyKey) {
          const migratedApi: SavedApi = {
            id: `api_${Date.now()}`,
            name: "Venice",
            baseUrl: legacyUrl || "https://api.venice.ai/api/v1",
            apiKey: legacyKey,
            password: "",
          };
          setApis([migratedApi]);
          await vault.set("saved_apis", JSON.stringify([migratedApi]));
        }
      }

      // Load defaults
      const savedDefaults = await vault.get("api_defaults");
      if (savedDefaults) {
        try { setDefaults(JSON.parse(savedDefaults)); } catch {}
      }

      // Load cost limits
      const dl = await vault.get("daily_cost_limit");
      setDailyLimit(dl || "0");
      const tl = await vault.get("task_cost_limit");
      setTaskLimit(tl || "0");
    } catch (err: any) {
      Alert.alert("Error", "Failed to load settings: " + err.message);
    }
  }, []);

  const loadCostData = useCallback(() => {
    const core = getAgentCoreInstance();
    if (!core) return;
    try {
      const summary = core.getCostSummary();
      setTotalCost(summary.totalCost);
      setTotalCalls(summary.totalCalls);
      // Build per-model usage list
      const usages: ModelUsage[] = Object.entries(summary.costByModel || {}).map(([modelId, cost]) => ({
        modelId,
        modelName: modelId,
        apiName: "Venice",
        calls: summary.callsByModel?.[modelId] || 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: cost as number,
      }));
      setModelUsages(usages);
    } catch {}
  }, []);

  // ── API CRUD ───────────────────────────────────────
  const startNewApi = useCallback(() => {
    setEditingApi({
      id: `api_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: "",
      baseUrl: "",
      apiKey: "",
      password: "",
    });
    setIsNewApi(true);
  }, []);

  const startEditApi = useCallback((api: SavedApi) => {
    setEditingApi({ ...api });
    setIsNewApi(false);
  }, []);

  const saveApi = useCallback(async () => {
    if (!editingApi) return;
    if (!editingApi.name.trim()) {
      Alert.alert("Required", "API name is required");
      return;
    }
    if (!editingApi.baseUrl.trim()) {
      Alert.alert("Required", "Base URL is required");
      return;
    }

    let updated: SavedApi[];
    if (isNewApi) {
      updated = [...apis, editingApi];
    } else {
      updated = apis.map((a) => a.id === editingApi.id ? editingApi : a);
    }

    setApis(updated);
    setEditingApi(null);
    setIsNewApi(false);

    try {
      const vault = await SecureVault.initialize();
      await vault.set("saved_apis", JSON.stringify(updated));

      // If this is the first API saved, also set it as the Venice key for backwards compat
      if (updated.length === 1 && updated[0].apiKey) {
        await vault.set("venice_api_key", updated[0].apiKey);
        await vault.set("api_base_url", updated[0].baseUrl);
        const core = getAgentCoreInstance();
        if (core) {
          await core.refreshApiKey();
          await core.setApiBaseUrl(updated[0].baseUrl);
        }
      }
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }, [editingApi, isNewApi, apis]);

  const deleteApi = useCallback(async (id: string) => {
    const updated = apis.filter((a) => a.id !== id);
    setApis(updated);
    // Clean up defaults that referenced this API
    const cleanDefaults = { ...defaults };
    for (const role of Object.keys(cleanDefaults) as DefaultRole[]) {
      if (cleanDefaults[role] === id) cleanDefaults[role] = "";
    }
    setDefaults(cleanDefaults);

    try {
      const vault = await SecureVault.initialize();
      await vault.set("saved_apis", JSON.stringify(updated));
      await vault.set("api_defaults", JSON.stringify(cleanDefaults));
    } catch {}
  }, [apis, defaults]);

  const saveDefaults = useCallback(async () => {
    try {
      const vault = await SecureVault.initialize();
      await vault.set("api_defaults", JSON.stringify(defaults));
      Alert.alert("Saved", "API defaults updated.");
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }, [defaults]);

  // ── Cost limit save ────────────────────────────────
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

  // ── Logs ───────────────────────────────────────────
  const loadLogs = useCallback(() => {
    const entries = Logger.getEntries(undefined, 300);
    setLogs(
      entries.map(
        (e) => `[${new Date(e.timestamp).toISOString()}][${e.level}][${e.context}] ${e.message}${e.metadata ? " " + JSON.stringify(e.metadata) : ""}`
      )
    );
    setLogsLoaded(true);
  }, []);

  const copyLogs = useCallback(async () => {
    if (logs.length === 0) return;
    try {
      await Clipboard.setStringAsync(logs.join("\n"));
      Alert.alert("Copied", "Log entries copied to clipboard.");
    } catch {}
  }, [logs]);

  // ── Render ─────────────────────────────────────────
  const webTopInset = Platform.OS === "web" ? 67 : 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopInset }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={TEXT} />
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 32 }} />
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar}>
        {(["apis", "costs", "logs"] as SettingsTab[]).map((t) => (
          <Pressable
            key={t}
            onPress={() => {
              setTab(t);
              if (t === "logs" && !logsLoaded) loadLogs();
              if (t === "costs") loadCostData();
            }}
            style={[styles.tab, tab === t && styles.tabActive]}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === "apis" ? "API Setup" : t === "costs" ? "Cost Limits" : "Logs"}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator={false}>

        {/* ══════════════════════════════════════════
            TAB: API SETUP
            ══════════════════════════════════════════ */}
        {tab === "apis" && (
          <>
            {/* Editing form (shown when adding/editing an API) */}
            {editingApi ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{isNewApi ? "Add API" : "Edit API"}</Text>

                <Text style={styles.fieldLabel}>Name *</Text>
                <TextInput
                  value={editingApi.name}
                  onChangeText={(t) => setEditingApi({ ...editingApi, name: t })}
                  placeholder='e.g., "Venice", "OpenAI", "Local"'
                  placeholderTextColor="#444"
                  style={styles.textInput}
                />

                <Text style={styles.fieldLabel}>Base URL *</Text>
                <TextInput
                  value={editingApi.baseUrl}
                  onChangeText={(t) => setEditingApi({ ...editingApi, baseUrl: t })}
                  placeholder="https://api.example.com/v1"
                  placeholderTextColor="#444"
                  style={styles.textInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />

                <Text style={styles.fieldLabel}>API Key (optional)</Text>
                <TextInput
                  value={editingApi.apiKey}
                  onChangeText={(t) => setEditingApi({ ...editingApi, apiKey: t })}
                  placeholder="Leave blank if not required"
                  placeholderTextColor="#444"
                  style={styles.textInput}
                  autoCapitalize="none"
                  secureTextEntry
                />

                <Text style={styles.fieldLabel}>Password / Auth Token (optional)</Text>
                <TextInput
                  value={editingApi.password}
                  onChangeText={(t) => setEditingApi({ ...editingApi, password: t })}
                  placeholder="Leave blank if not required"
                  placeholderTextColor="#444"
                  style={styles.textInput}
                  autoCapitalize="none"
                  secureTextEntry
                />

                <View style={styles.btnRow}>
                  <Pressable onPress={saveApi} style={[styles.btn, styles.primaryBtn]}>
                    <Ionicons name="save-outline" size={16} color={BG} />
                    <Text style={styles.primaryBtnText}>Save API</Text>
                  </Pressable>
                  <Pressable onPress={() => { setEditingApi(null); setIsNewApi(false); }} style={[styles.btn, styles.secondaryBtn]}>
                    <Text style={styles.secondaryBtnText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <>
                {/* Saved APIs list */}
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>Saved APIs</Text>
                  <Pressable onPress={startNewApi} style={styles.addBtn}>
                    <Ionicons name="add" size={18} color={ACCENT} />
                    <Text style={styles.addBtnText}>Add API</Text>
                  </Pressable>
                </View>

                {apis.length === 0 ? (
                  <View style={styles.emptyCard}>
                    <MaterialCommunityIcons name="api" size={32} color="#222" />
                    <Text style={styles.emptyText}>No APIs configured</Text>
                    <Text style={styles.emptySubtext}>Tap "Add API" to connect your first provider</Text>
                  </View>
                ) : (
                  apis.map((api) => (
                    <View key={api.id} style={styles.apiCard}>
                      <View style={styles.apiCardHeader}>
                        <View style={styles.apiNameRow}>
                          <MaterialCommunityIcons name="api" size={18} color={ACCENT} />
                          <Text style={styles.apiName}>{api.name}</Text>
                        </View>
                        <View style={styles.apiActions}>
                          <Pressable onPress={() => startEditApi(api)} hitSlop={8}>
                            <Ionicons name="create-outline" size={18} color={DIM} />
                          </Pressable>
                          <Pressable
                            onPress={() => {
                              Alert.alert("Delete API", `Remove "${api.name}"?`, [
                                { text: "Cancel", style: "cancel" },
                                { text: "Delete", style: "destructive", onPress: () => deleteApi(api.id) },
                              ]);
                            }}
                            hitSlop={8}
                          >
                            <Ionicons name="trash-outline" size={18} color={DANGER} />
                          </Pressable>
                        </View>
                      </View>
                      <Text style={styles.apiUrl} numberOfLines={1}>{api.baseUrl}</Text>
                      <Text style={styles.apiKeyStatus}>
                        {api.apiKey ? `Key: ••••${api.apiKey.slice(-4)}` : "No API key"}
                        {api.password ? " | Auth: ••••" : ""}
                      </Text>
                    </View>
                  ))
                )}

                {/* API Defaults */}
                {apis.length > 0 && (
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>Default APIs by Mode</Text>
                    <Text style={styles.cardSubtitle}>
                      Select which API to use for each mode. These are used when you tap the "+" button in chat.
                    </Text>

                    {(["chat", "image", "code", "reasoning", "video"] as DefaultRole[]).map((role) => (
                      <View key={role} style={styles.defaultRow}>
                        <Text style={styles.defaultLabel}>{role.charAt(0).toUpperCase() + role.slice(1)}</Text>
                        <View style={styles.defaultPicker}>
                          {/* Simple button-group style picker */}
                          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                            <Pressable
                              onPress={() => setDefaults({ ...defaults, [role]: "" })}
                              style={[styles.defaultOption, !defaults[role] && styles.defaultOptionActive]}
                            >
                              <Text style={[styles.defaultOptionText, !defaults[role] && styles.defaultOptionTextActive]}>None</Text>
                            </Pressable>
                            {apis.map((api) => (
                              <Pressable
                                key={api.id}
                                onPress={() => setDefaults({ ...defaults, [role]: api.id })}
                                style={[styles.defaultOption, defaults[role] === api.id && styles.defaultOptionActive]}
                              >
                                <Text style={[styles.defaultOptionText, defaults[role] === api.id && styles.defaultOptionTextActive]}>
                                  {api.name}
                                </Text>
                              </Pressable>
                            ))}
                          </ScrollView>
                        </View>
                      </View>
                    ))}

                    <Pressable onPress={saveDefaults} style={[styles.btn, styles.primaryBtn, { marginTop: 12 }]}>
                      <Ionicons name="save-outline" size={16} color={BG} />
                      <Text style={styles.primaryBtnText}>Save Defaults</Text>
                    </Pressable>
                  </View>
                )}
              </>
            )}
          </>
        )}

        {/* ══════════════════════════════════════════
            TAB: COST LIMITS
            ══════════════════════════════════════════ */}
        {tab === "costs" && (
          <>
            {/* Usage indicator */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Usage Overview</Text>
              <UsageIndicator
                totalCost={totalCost}
                totalCalls={totalCalls}
                modelUsages={modelUsages}
                dailyLimit={parseFloat(dailyLimit) || 0}
              />
            </View>

            {/* Limits */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Spending Limits</Text>
              <Text style={styles.cardSubtitle}>
                Set to 0 for no limit. The agent will warn you before performing actions that exceed these limits.
              </Text>

              <Text style={styles.fieldLabel}>Daily Limit (USD)</Text>
              <TextInput
                value={dailyLimit}
                onChangeText={setDailyLimit}
                placeholder="0"
                placeholderTextColor="#444"
                style={styles.textInput}
                keyboardType="decimal-pad"
              />
              {dailyLimit === "0" && <Text style={styles.noLimitHint}>No daily limit set</Text>}

              <Text style={styles.fieldLabel}>Per-Task Limit (USD)</Text>
              <TextInput
                value={taskLimit}
                onChangeText={setTaskLimit}
                placeholder="0"
                placeholderTextColor="#444"
                style={styles.textInput}
                keyboardType="decimal-pad"
              />
              {taskLimit === "0" && <Text style={styles.noLimitHint}>No per-task limit set</Text>}

              <Pressable onPress={saveLimits} style={[styles.btn, styles.primaryBtn, { marginTop: 12 }]}>
                <Ionicons name="save-outline" size={16} color={BG} />
                <Text style={styles.primaryBtnText}>Save Limits</Text>
              </Pressable>
            </View>
          </>
        )}

        {/* ══════════════════════════════════════════
            TAB: LOGS
            ══════════════════════════════════════════ */}
        {tab === "logs" && (
          <View style={styles.card}>
            <View style={styles.logHeader}>
              <Text style={styles.cardTitle}>Application Logs</Text>
              <View style={styles.logActions}>
                <Pressable onPress={loadLogs} style={styles.logActionBtn}>
                  <Ionicons name="refresh" size={16} color={DIM} />
                </Pressable>
                <Pressable onPress={copyLogs} style={styles.logActionBtn}>
                  <Ionicons name="copy-outline" size={16} color={DIM} />
                </Pressable>
              </View>
            </View>

            {logs.length === 0 ? (
              <Text style={styles.emptyText}>
                {logsLoaded ? "No log entries" : "Tap refresh to load logs"}
              </Text>
            ) : (
              <ScrollView style={styles.logScroll} nestedScrollEnabled>
                {logs.map((line, i) => (
                  <Text key={i} style={styles.logLine}>{line}</Text>
                ))}
              </ScrollView>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },

  // Header
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: SURFACE3,
  },
  backBtn: { padding: 4, width: 32 },
  headerTitle: { color: TEXT, fontSize: 17, fontFamily: "Inter_700Bold" },

  // Tabs
  tabBar: {
    flexDirection: "row", paddingHorizontal: 16, paddingVertical: 10, gap: 8,
    borderBottomWidth: 1, borderBottomColor: "#1a1a1a",
  },
  tab: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, backgroundColor: SURFACE2 },
  tabActive: { backgroundColor: ACCENT },
  tabText: { color: DIM, fontSize: 13, fontFamily: "Inter_500Medium" },
  tabTextActive: { color: BG, fontFamily: "Inter_600SemiBold" },

  // Body
  body: { flex: 1 },
  bodyContent: { padding: 16, paddingBottom: 40 },

  // Cards
  card: {
    backgroundColor: SURFACE2, borderRadius: 14, padding: 16, marginBottom: 14,
    borderWidth: 1, borderColor: "#1e1e1e",
  },
  cardTitle: { color: TEXT, fontSize: 15, fontFamily: "Inter_600SemiBold", marginBottom: 4 },
  cardSubtitle: { color: DIM, fontSize: 12, fontFamily: "Inter_400Regular", marginBottom: 12, lineHeight: 17 },

  // Section headers
  sectionHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10,
  },
  sectionTitle: { color: TEXT, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  addBtnText: { color: ACCENT, fontSize: 13, fontFamily: "Inter_500Medium" },

  // Form fields
  fieldLabel: { color: DIM, fontSize: 12, fontFamily: "Inter_500Medium", marginTop: 10, marginBottom: 4 },
  textInput: {
    backgroundColor: SURFACE, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
    color: TEXT, fontSize: 14, fontFamily: "Inter_400Regular", borderWidth: 1, borderColor: "#222",
  },
  noLimitHint: { color: ACCENT, fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 3, opacity: 0.7 },

  // Buttons
  btnRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  btn: {
    flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10,
  },
  primaryBtn: { backgroundColor: ACCENT },
  primaryBtnText: { color: BG, fontSize: 13, fontFamily: "Inter_600SemiBold" },
  secondaryBtn: { backgroundColor: SURFACE3 },
  secondaryBtnText: { color: TEXT, fontSize: 13, fontFamily: "Inter_500Medium" },

  // API cards
  apiCard: {
    backgroundColor: SURFACE2, borderRadius: 12, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: "#1e1e1e",
  },
  apiCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  apiNameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  apiName: { color: TEXT, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  apiActions: { flexDirection: "row", gap: 12 },
  apiUrl: { color: DIM, fontSize: 12, fontFamily: "Inter_400Regular", marginBottom: 3 },
  apiKeyStatus: { color: "#444", fontSize: 11, fontFamily: "Inter_400Regular" },

  // Empty state
  emptyCard: { alignItems: "center", paddingVertical: 30, backgroundColor: SURFACE2, borderRadius: 14, marginBottom: 14 },
  emptyText: { color: DIM, fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 8 },
  emptySubtext: { color: "#444", fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },

  // Defaults
  defaultRow: { marginBottom: 10 },
  defaultLabel: { color: TEXT, fontSize: 13, fontFamily: "Inter_500Medium", marginBottom: 6, textTransform: "capitalize" },
  defaultPicker: { flexDirection: "row" },
  defaultOption: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16,
    backgroundColor: SURFACE, borderWidth: 1, borderColor: "#222",
  },
  defaultOptionActive: { borderColor: ACCENT, backgroundColor: `rgba(74, 222, 128, 0.1)` },
  defaultOptionText: { color: DIM, fontSize: 12, fontFamily: "Inter_400Regular" },
  defaultOptionTextActive: { color: ACCENT, fontFamily: "Inter_500Medium" },

  // Logs
  logHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  logActions: { flexDirection: "row", gap: 8 },
  logActionBtn: { padding: 4 },
  logScroll: { maxHeight: 400, backgroundColor: SURFACE, borderRadius: 8, padding: 10 },
  logLine: {
    color: "#888", fontSize: 10,
    fontFamily: Platform.OS === "web" ? "monospace" : "Courier",
    lineHeight: 14, marginBottom: 1,
  },
});

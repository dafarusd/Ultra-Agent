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
import { UltraDevLog as DebugLog, UltraDevLog } from "@/src/utils/UltraDevLog";
import UsageIndicator, { ModelUsage } from "@/components/UsageIndicator";

// ── Palette ────────────────────────────────────────────
const ACCENT = "#34d399";
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
  chat: string;       // model id
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
  const [debugLogs, setDebugLogs] = useState<string>("");
  const [debugLogsLoaded, setDebugLogsLoaded] = useState(false);

  const [savedFeedback, setSavedFeedback] = useState<string | null>(null);
  const [defaultsExpanded, setDefaultsExpanded] = useState(false);
  const [availableModels, setAvailableModels] = useState<any[]>([]);

  // ── Draft persistence (survives app switches) ──────
  const saveDraft = useCallback(async (draft: SavedApi | null, isNew: boolean) => {
    try {
      const vault = await SecureVault.initialize();
      if (draft) {
        await vault.set("api_edit_draft", JSON.stringify({ draft, isNew }));
      } else {
        await vault.set("api_edit_draft", "");
      }
    } catch {}
  }, []);

  const loadDraft = useCallback(async () => {
    try {
      const vault = await SecureVault.initialize();
      const raw = await vault.get("api_edit_draft");
      if (raw) {
        const { draft, isNew } = JSON.parse(raw);
        if (draft && draft.id) {
          setEditingApi(draft);
          setIsNewApi(isNew);
        }
      }
    } catch {}
  }, []);

  // ── Load settings on mount ─────────────────────────
  useEffect(() => {
    loadSettings();
    loadDraft();
    loadCostData();
    if (initialTab === "logs") {
      loadLogs();
      loadDebugLogs();
    }
  }, []);

  // ── Load models when defaults section expands ─────
  useEffect(() => {
    if (defaultsExpanded) {
      const core = getAgentCoreInstance();
      const models = core ? core.getAvailableModels() || [] : [];
      setAvailableModels(models);
      DebugLog.settingsState("defaults_expanded", {
        tab,
        defaults,
        apiCount: apis.length,
        availableModelsCount: models.length,
        defaultsExpanded: true,
      });
    }
  }, [defaultsExpanded]);

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

      try {
        DebugLog.settingsState("loaded", {
          tab: initialTab,
          defaults: savedDefaults ? JSON.parse(savedDefaults) : {},
          apiCount: savedApis ? JSON.parse(savedApis).length : 0,
          availableModelsCount: 0,
          defaultsExpanded: false,
          dailyLimit: dl || "0",
          taskLimit: tl || "0",
        });
      } catch {}
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

  // ── Auto-save draft on field changes ────────────────
  useEffect(() => {
    if (editingApi) {
      saveDraft(editingApi, isNewApi);
    }
  }, [editingApi, isNewApi]);

  // ── API CRUD ───────────────────────────────────────
  const startNewApi = useCallback(() => {
    const draft: SavedApi = {
      id: `api_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: "Venice",
      baseUrl: "https://api.venice.ai/api/v1",
      apiKey: "",
      password: "",
    };
    setEditingApi(draft);
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
    saveDraft(null, false);

    UltraDevLog.settingsSaveTap('api', { count: updated.length, primaryId: updated[0]?.id });
    try {
      const vault = await SecureVault.initialize();
      await vault.set("saved_apis", JSON.stringify(updated));

      const primary = updated[0];
      if (primary) {
        await vault.set("venice_api_key", primary.apiKey || "");
        await vault.set("api_base_url", primary.baseUrl);
        DebugLog.settingsApiSave(primary.id, true);
        const core = getAgentCoreInstance();
        if (core) {
          await core.refreshApiKey();
          await core.setApiBaseUrl(primary.baseUrl);
        }
      } else {
        await vault.set("venice_api_key", "");
        await vault.set("api_base_url", "");
      }
      UltraDevLog.settingsSaveResult('api', true, ['saved_apis', 'venice_api_key', 'api_base_url']);
    } catch (err: any) {
      UltraDevLog.settingsSaveResult('api', false, [], err.message);
      DebugLog.uiError("settings_saveApi", err.message);
      Alert.alert("Error", err.message);
    }
  }, [editingApi, isNewApi, apis]);

  const deleteApi = useCallback(async (id: string) => {
    DebugLog.settingsApiDelete(id, true);
    const updated = apis.filter((a) => a.id !== id);
    setApis(updated);
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
    UltraDevLog.settingsSaveTap('defaults', { defaults });
    try {
      const vault = await SecureVault.initialize();
      await vault.set("api_defaults", JSON.stringify(defaults));
      DebugLog.settingsDefaultsSave(defaults);
      DebugLog.settingsState("defaults_saved", {
        tab,
        defaults,
        apiCount: apis.length,
        availableModelsCount: availableModels.length,
        defaultsExpanded,
      });
      setSavedFeedback("defaults");
      setTimeout(() => setSavedFeedback(null), 2000);
      UltraDevLog.settingsSaveResult('defaults', true, ['api_defaults']);
    } catch (err: any) {
      UltraDevLog.settingsSaveResult('defaults', false, [], err.message);
      DebugLog.uiError("settings_saveDefaults", err.message);
      Alert.alert("Error", err.message);
    }
  }, [defaults, tab, apis.length, availableModels.length, defaultsExpanded]);

  // ── Cost limit save ────────────────────────────────
  const saveLimits = useCallback(async () => {
    UltraDevLog.settingsSaveTap('limits', { dailyLimit, taskLimit });
    try {
      const vault = await SecureVault.initialize();
      await vault.set("daily_cost_limit", dailyLimit);
      await vault.set("task_cost_limit", taskLimit);
      DebugLog.settingsCostLimitSave(dailyLimit, taskLimit);
      Alert.alert("Saved", "Cost limits updated.");
      UltraDevLog.settingsSaveResult('limits', true, ['daily_cost_limit', 'task_cost_limit']);
    } catch (err: any) {
      UltraDevLog.settingsSaveResult('limits', false, [], err.message);
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

  const loadDebugLogs = useCallback(async () => {
    const formatted = DebugLog.getMemoryEntriesFormatted(5000);
    setDebugLogs(formatted);
    setDebugLogsLoaded(true);
  }, []);

  const copyDebugLogs = useCallback(async () => {
    if (!debugLogs) return;
    try {
      await Clipboard.setStringAsync(debugLogs);
      Alert.alert("Copied", "Debug log copied to clipboard.");
    } catch {}
  }, [debugLogs]);

  const exportFullDebugLog = useCallback(async () => {
    try {
      const full = await DebugLog.exportAll();
      await Clipboard.setStringAsync(full);
      Alert.alert("Exported", "Full debug log (JSONL) copied to clipboard.");
    } catch {}
  }, []);

  const copyBugReport = useCallback(async () => {
    try {
      await UltraDevLog.forceFlush();
      const report = UltraDevLog.generateBugReport();
      await Clipboard.setStringAsync(report);
      Alert.alert("Bug Report Copied", `${report.length} chars ready to paste into Replit.`);
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }, []);

  const copyFormattedLog = useCallback(async () => {
    try {
      await UltraDevLog.forceFlush();
      const log = UltraDevLog.getFormattedLog(500);
      await Clipboard.setStringAsync(log);
      Alert.alert("Log Copied", `${log.split('\n').length} lines`);
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }, []);

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
              if (t === "logs") { loadLogs(); loadDebugLogs(); }
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

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

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
                  <Pressable onPress={() => { setEditingApi(null); setIsNewApi(false); saveDraft(null, false); }} style={[styles.btn, styles.secondaryBtn]}>
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

                {/* Model Defaults by Mode (collapsible) */}
                {apis.length > 0 && (
                  <View style={styles.card}>
                    <Pressable
                      onPress={() => setDefaultsExpanded(!defaultsExpanded)}
                      style={styles.collapsibleHeader}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.cardTitle}>Default Models by Mode</Text>
                        {!defaultsExpanded && (
                          <Text style={[styles.cardSubtitle, { marginBottom: 0 }]}>
                            Tap to configure
                          </Text>
                        )}
                      </View>
                      <Ionicons
                        name={defaultsExpanded ? "chevron-up" : "chevron-down"}
                        size={20}
                        color={DIM}
                      />
                    </Pressable>

                    {defaultsExpanded && (
                      <>
                        <Text style={[styles.cardSubtitle, { marginTop: 10 }]}>
                          Pick a preferred model for each mode. Used when you tap "+" in chat.
                        </Text>

                        {(["chat", "image", "code", "reasoning", "video"] as DefaultRole[]).map((role) => {
                          const allModels = availableModels;
                          const isRecommended = (m: any): boolean => {
                            const t = (m.type || "text").toLowerCase();
                            const id = (m.id || "").toLowerCase();
                            const caps = m.capabilities || {};
                            if (role === "chat") return t === "text" && !caps.supportsReasoning && !id.includes("code");
                            if (role === "image") return t === "image";
                            if (role === "code") return t === "text" && (id.includes("code") || id.includes("codestral") || id.includes("deepseek-coder"));
                            if (role === "reasoning") return t === "text" && (caps.supportsReasoning || id.includes("reason") || id.includes("qwq") || id.includes("deepseek-r1"));
                            if (role === "video") return t === "video";
                            return false;
                          };
                          const recommended = allModels.filter(isRecommended);
                          const others = allModels.filter((m: any) => !isRecommended(m));
                          const sortedModels = [...recommended, ...others];

                          return (
                            <View key={role} style={styles.defaultRow}>
                              <Text style={styles.defaultLabel}>
                                {role.charAt(0).toUpperCase() + role.slice(1)}
                              </Text>
                              <View style={styles.defaultPicker}>
                                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} keyboardShouldPersistTaps="handled">
                                  <Pressable
                                    onPress={async () => {
                                      const updated = { ...defaults, [role]: "" };
                                      setDefaults(updated);
                                      try {
                                        const vault = await SecureVault.initialize();
                                        await vault.set("api_defaults", JSON.stringify(updated));
                                        DebugLog.settingsDefaultsSave(updated);
                                      } catch {}
                                    }}
                                    style={[styles.defaultOption, !defaults[role] && styles.defaultOptionActive]}
                                  >
                                    <Text style={[styles.defaultOptionText, !defaults[role] && styles.defaultOptionTextActive]}>Auto</Text>
                                  </Pressable>
                                  {sortedModels.map((m: any) => {
                                    const isRec = isRecommended(m);
                                    const isActive = defaults[role] === m.id;
                                    return (
                                      <Pressable
                                        key={m.id}
                                        onPress={async () => {
                                          const updated = { ...defaults, [role]: m.id };
                                          DebugLog.settingsDefaultPick(role, m.id);
                                          DebugLog.settingsState("default_pick", {
                                            defaults: updated,
                                            availableModelsCount: availableModels.length,
                                            defaultsExpanded,
                                          });
                                          setDefaults(updated);
                                          try {
                                            const vault = await SecureVault.initialize();
                                            await vault.set("api_defaults", JSON.stringify(updated));
                                            DebugLog.settingsDefaultsSave(updated);
                                          } catch {}
                                        }}
                                        style={[styles.defaultOption, isActive && styles.defaultOptionActive, isRec && !isActive && styles.recommendedOption]}
                                      >
                                        {isRec && <Ionicons name="star" size={10} color={isActive ? BG : "#f59e0b"} style={{ marginRight: 2 }} />}
                                        <Text style={[styles.defaultOptionText, isActive && styles.defaultOptionTextActive]} numberOfLines={1}>
                                          {(m.name || m.id).replace(/^(Venice|v1)\s*/i, "").slice(0, 20)}
                                        </Text>
                                      </Pressable>
                                    );
                                  })}
                                </ScrollView>
                              </View>
                            </View>
                          );
                        })}

                        <Pressable onPress={saveDefaults} style={[styles.btn, savedFeedback === "defaults" ? styles.savedBtn : styles.primaryBtn, { marginTop: 12 }]}>
                          <Ionicons name={savedFeedback === "defaults" ? "checkmark-circle" : "save-outline"} size={16} color={savedFeedback === "defaults" ? "#fff" : BG} />
                          <Text style={savedFeedback === "defaults" ? styles.savedBtnText : styles.primaryBtnText}>
                            {savedFeedback === "defaults" ? "Saved!" : "Save Defaults"}
                          </Text>
                        </Pressable>
                      </>
                    )}
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
          <>
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

            <View style={[styles.card, { marginTop: 12 }]}>
              <View style={styles.logHeader}>
                <Text style={styles.cardTitle}>Debug Log</Text>
                <View style={styles.logActions}>
                  <Pressable onPress={loadDebugLogs} style={styles.logActionBtn}>
                    <Ionicons name="refresh" size={16} color={DIM} />
                  </Pressable>
                  <Pressable onPress={copyDebugLogs} style={styles.logActionBtn}>
                    <Ionicons name="copy-outline" size={16} color={DIM} />
                  </Pressable>
                  <Pressable onPress={exportFullDebugLog} style={styles.logActionBtn}>
                    <Ionicons name="download-outline" size={16} color={DIM} />
                  </Pressable>
                </View>
              </View>
              <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                <Pressable onPress={copyBugReport} style={[styles.logActionBtn, { borderWidth: 1, borderColor: '#ff6b00', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 }]}>
                  <Text style={{ color: '#ff6b00', fontSize: 12, fontFamily: "Inter_600SemiBold" }}>Bug Report</Text>
                </Pressable>
                <Pressable onPress={copyFormattedLog} style={[styles.logActionBtn, { borderWidth: 1, borderColor: ACCENT, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 }]}>
                  <Text style={{ color: ACCENT, fontSize: 12, fontFamily: "Inter_600SemiBold" }}>Full Log</Text>
                </Pressable>
              </View>
              <Text style={styles.debugHint}>Full dev log with prompts, AI responses, agent steps, costs, and errors. Copy and share with your dev team or AI assistant.</Text>
              {!debugLogsLoaded ? (
                <Text style={styles.emptyText}>Tap refresh to load debug log</Text>
              ) : !debugLogs ? (
                <Text style={styles.emptyText}>No debug entries yet</Text>
              ) : (
                <ScrollView style={styles.logScroll} nestedScrollEnabled>
                  <Text style={styles.logLine} selectable>{debugLogs}</Text>
                </ScrollView>
              )}
            </View>
          </>
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
  collapsibleHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 2,
  },
  savedBtn: { backgroundColor: "#22804a" },
  savedBtnText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
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
    flexDirection: "row" as const, alignItems: "center" as const,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16,
    backgroundColor: SURFACE, borderWidth: 1, borderColor: "#222",
  },
  defaultOptionActive: { borderColor: ACCENT, backgroundColor: "rgba(52, 211, 153, 0.1)" },
  recommendedOption: { borderColor: "#44371a" },
  defaultOptionText: { color: DIM, fontSize: 12, fontFamily: "Inter_400Regular" },
  defaultOptionTextActive: { color: ACCENT, fontFamily: "Inter_500Medium" },

  // Logs
  logHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  logActions: { flexDirection: "row", gap: 8 },
  logActionBtn: { padding: 4 },
  logScroll: { maxHeight: 800, backgroundColor: SURFACE, borderRadius: 8, padding: 10 },
  logLine: {
    color: "#888", fontSize: 10,
    fontFamily: Platform.OS === "web" ? "monospace" : "Courier",
    lineHeight: 14, marginBottom: 1,
  },
  debugHint: {
    color: DIM, fontSize: 11, fontFamily: "Inter_400Regular",
    marginBottom: 8, lineHeight: 15,
  },
});

import React, { useState, useEffect, useCallback, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
  Share,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { exportPreferences, importPreferences } from '@/src/services/PreferenceBackup';
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { LogFolder, type LogFile } from "@/src/services/LogFolder";
import { SecureVault } from "@/src/security/SecureVault";
import { getAgentCoreInstance } from "@/src/core/AgentCore";
import { Logger } from "@/src/utils/Logger";
import { UltraDevLog as DebugLog, UltraDevLog } from "@/src/utils/UltraDevLog";
import { classifyModelType } from "@/src/utils/classifyModelType";
import UsageIndicator, { ModelUsage } from "@/components/UsageIndicator";
import BlockedAppsTab from "@/components/BlockedAppsTab";
import { BiometricGate } from "@/src/security/BiometricGate";

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
  isBuiltIn?: boolean; // hidden from non-dev UI
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
type SettingsTab = "apis" | "costs" | "logs" | "blocked";

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

  // ── Dev mode state ─────────────────────────────────
  const [isDevMode, setIsDevMode] = useState<boolean>(false);
  const devTapCountRef = useRef<number>(0);
  const devTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Logs state ─────────────────────────────────────
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [logsLoaded, setLogsLoaded] = useState(false);

  const [savedFeedback, setSavedFeedback] = useState<string | null>(null);
  const [defaultsExpanded, setDefaultsExpanded] = useState(false);
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [backupExporting, setBackupExporting] = useState(false);
  const [biometricGate] = useState(() => new BiometricGate());
  const [lockTimeout, setLockTimeout] = useState(0);
  const [backupImporting, setBackupImporting] = useState(false);

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

  // ── Load dev mode on mount ─────────────────────────
  useEffect(() => {
    AsyncStorage.getItem("dev_mode_enabled").then((v) => { if (v === "1") setIsDevMode(true); });
  }, []);

  // ── Load settings on mount ─────────────────────────
  useEffect(() => {
    loadSettings();
    loadDraft();
    loadCostData();
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

  const handleVersionTap = useCallback(() => {
    devTapCountRef.current += 1;
    if (devTapTimerRef.current) clearTimeout(devTapTimerRef.current);
    devTapTimerRef.current = setTimeout(() => { devTapCountRef.current = 0; }, 2000);
    if (devTapCountRef.current >= 7) {
      devTapCountRef.current = 0;
      const next = !isDevMode;
      setIsDevMode(next);
      AsyncStorage.setItem("dev_mode_enabled", next ? "1" : "0");
      Alert.alert(next ? "Dev Mode ON" : "Dev Mode OFF", next ? "Logs tab and advanced options enabled." : "Dev mode disabled.");
    }
  }, [isDevMode]);

  const visibleApis = isDevMode ? apis : apis.filter((a) => !a.isBuiltIn);

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

      // Init biometric gate
      await biometricGate.init(vault);
      setLockTimeout(biometricGate.getLockTimeout());

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

    try {
      const vault = await SecureVault.initialize();
      await vault.set("saved_apis", JSON.stringify(updated));
      // Only clear defaults if no APIs remain — otherwise preserve them.
      // Stale defaults pointing to models from the deleted API will fail
      // gracefully at ModelRouter and fall back to the engine default.
      if (updated.length === 0) {
        const cleanDefaults = { chat: "", image: "", code: "", reasoning: "", video: "" };
        setDefaults(cleanDefaults);
        await vault.set("api_defaults", JSON.stringify(cleanDefaults));
      }
    } catch (e: any) { DebugLog.uiError("deleteApi_vault", e?.message || "unknown"); }
  }, [apis]);

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
      UltraDevLog.settingsCostLimitSave(parseFloat(dailyLimit) || 0, true);
      Alert.alert("Saved", "Cost limits updated.");
      UltraDevLog.settingsSaveResult('limits', true, ['daily_cost_limit', 'task_cost_limit']);
    } catch (err: any) {
      UltraDevLog.settingsSaveResult('limits', false, [], err.message);
      Alert.alert("Error", err.message);
    }
  }, [dailyLimit, taskLimit]);

  // ── Logs ───────────────────────────────────────────
  const loadLogs = useCallback(async () => {
    try {
      const files = await LogFolder.listLogs();
      setLogFiles(files);
      setLogsLoaded(true);
    } catch (err: any) {
      console.error('[Settings] loadLogs error:', err);
      setLogFiles([]);
      setLogsLoaded(true);
    }
  }, []);

  const downloadLog = useCallback(async (filePath: string, filename: string) => {
    try {
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(filePath, { mimeType: "text/plain", dialogTitle: filename });
      } else {
        Alert.alert("Sharing unavailable", "Your device doesn't support file sharing.");
      }
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to share log file.");
    }
  }, []);

  useEffect(() => {
    if (tab === "logs" && !logsLoaded) loadLogs();
  }, [tab, logsLoaded, loadLogs]);

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
        {(["apis", "costs", "logs", "blocked"] as SettingsTab[]).filter((t) => t !== "logs" || isDevMode).map((t) => (
          <Pressable
            key={t}
            onPress={() => {
              setTab(t);
              if (t === "logs") { loadLogs(); }
              if (t === "costs") loadCostData();
            }}
            style={[styles.tab, tab === t && styles.tabActive]}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === "apis" ? "API Setup" : t === "costs" ? "Cost Limits" : t === "logs" ? "Logs" : "Blocked"}
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

                {visibleApis.length === 0 ? (
                  <View style={styles.emptyCard}>
                    <MaterialCommunityIcons name="api" size={32} color="#222" />
                    <Text style={styles.emptyText}>No APIs configured</Text>
                    <Text style={styles.emptySubtext}>Tap "Add API" to connect your first provider</Text>
                  </View>
                ) : (
                  visibleApis.map((api) => (
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
                            const classified = classifyModelType(m.id, m.name || m.id, m.type);
                            return classified === role;
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
                                      } catch (e: any) { DebugLog.uiError('defaults_auto_save', e?.message || 'vault write failed'); }
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
                                          } catch (e: any) { DebugLog.uiError('defaults_pick_save', e?.message || 'vault write failed'); }
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

        {tab === "apis" && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>App Lock</Text>
            <Text style={styles.cardSubtitle}>
              Require biometric authentication after the app has been in the background for this duration.
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {[0, 1, 5, 15, 30, 60].map(mins => {
                const label = mins === 0 ? 'Never' : mins < 60 ? `${mins}m` : '1h';
                const active = lockTimeout === mins;
                return (
                  <Pressable
                    key={mins}
                    style={[styles.btn, active ? styles.primaryBtn : styles.secondaryBtn, { paddingHorizontal: 14 }]}
                    onPress={async () => {
                      await biometricGate.setLockTimeout(mins);
                      setLockTimeout(mins);
                    }}
                  >
                    <Text style={active ? styles.primaryBtnText : styles.secondaryBtnText}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        {tab === "apis" && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Preferences Backup</Text>
            <Text style={styles.cardSubtitle}>
              Export your settings, model defaults, and learned patterns to a file. API keys are excluded for security. Import to restore on a new device or after reinstalling.
            </Text>
            <View style={styles.btnRow}>
              <Pressable
                style={[styles.btn, styles.primaryBtn, { flex: 1, justifyContent: 'center' }, backupExporting && { opacity: 0.6 }]}
                disabled={backupExporting}
                onPress={async () => {
                  setBackupExporting(true);
                  try {
                    const result = await exportPreferences();
                    Alert.alert(result.success ? 'Export Complete' : 'Export Failed', result.message);
                  } finally {
                    setBackupExporting(false);
                  }
                }}
              >
                {backupExporting
                  ? <ActivityIndicator size="small" color={BG} />
                  : <Ionicons name="share-outline" size={16} color={BG} />}
                <Text style={styles.primaryBtnText}>{backupExporting ? 'Exporting…' : 'Export'}</Text>
              </Pressable>
              <Pressable
                style={[styles.btn, styles.secondaryBtn, { flex: 1, justifyContent: 'center' }, backupImporting && { opacity: 0.6 }]}
                disabled={backupImporting}
                onPress={async () => {
                  setBackupImporting(true);
                  try {
                    const result = await importPreferences();
                    Alert.alert(result.success ? 'Import Complete' : 'Import Failed', result.message);
                  } finally {
                    setBackupImporting(false);
                  }
                }}
              >
                {backupImporting
                  ? <ActivityIndicator size="small" color={TEXT} />
                  : <Ionicons name="download-outline" size={16} color={TEXT} />}
                <Text style={styles.secondaryBtnText}>{backupImporting ? 'Importing…' : 'Import'}</Text>
              </Pressable>
            </View>
          </View>
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
                <Text style={styles.cardTitle}>Log Files</Text>
                <Pressable onPress={loadLogs} style={styles.logActionBtn}>
                  <Ionicons name="refresh" size={16} color={DIM} />
                </Pressable>
              </View>
              {!logsLoaded ? (
                <Text style={styles.emptyText}>Loading logs...</Text>
              ) : logFiles.length === 0 ? (
                <Text style={styles.emptyText}>No log files yet. Tap refresh to check.</Text>
              ) : (
                <ScrollView style={styles.logScroll} nestedScrollEnabled>
                  {logFiles.map((file) => (
                    <Pressable
                      key={file.path}
                      onPress={() => downloadLog(file.path, file.name)}
                      style={styles.logFileRow}
                    >
                      <View style={styles.logFileInfo}>
                        <Text style={styles.logFileName}>{file.name}</Text>
                        <Text style={styles.logFileSize}>{(file.size / 1024).toFixed(1)} KB</Text>
                      </View>
                      <Ionicons name="download-outline" size={16} color={ACCENT} />
                    </Pressable>
                  ))}
                </ScrollView>
              )}
            </View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Bug Report</Text>
              <Text style={styles.cardSubtitle}>
                Generates a human-readable summary of failures, warnings, last task chain, and key traces. Auto-generated when the app goes to background. Share this file with Claude to diagnose issues.
              </Text>
              <Pressable
                style={[styles.btn, styles.primaryBtn, { marginTop: 4 }]}
                onPress={async () => {
                  const ok = await UltraDevLog.generateBugReportFile();
                  if (ok) {
                    await loadLogs();
                    Alert.alert("Done", "bug-report.txt written. Tap it in the list above to share.");
                  } else {
                    Alert.alert("Error", "Could not write bug-report.txt (web or no storage).");
                  }
                }}
              >
                <Ionicons name="bug-outline" size={16} color={BG} />
                <Text style={styles.primaryBtnText}>Generate Report</Text>
              </Pressable>
            </View>
          </>
        )}

        {/* ══════════════════════════════════════════
            TAB: BLOCKED APPS
            ══════════════════════════════════════════ */}
        {tab === "blocked" && (
          <BlockedAppsTab isNative={Platform.OS === "android"} />
        )}

        {/* Version tap area — tap 7 times within 2s to toggle dev mode */}
        <Pressable onPress={handleVersionTap} style={styles.versionTap}>
          <Text style={styles.versionText}>Agent Ultra{isDevMode ? "  [DEV]" : ""}</Text>
        </Pressable>

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

  // Log files
  logFileRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: SURFACE3 },
  logFileInfo: { flex: 1 },
  logFileName: { color: TEXT, fontSize: 13, fontFamily: "Inter_500Medium" },
  logFileSize: { color: DIM, fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },

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
  versionTap: {
    alignItems: "center" as const, paddingVertical: 20, marginTop: 8,
  },
  versionText: {
    color: "#333", fontSize: 11, fontFamily: "Inter_400Regular",
  },
});

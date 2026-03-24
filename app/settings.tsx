import React, { useState, useEffect, useCallback, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppStorage } from "@/src/utils/AppStorage";
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
import type { ApiCategory, ApiProvider } from "@/src/types/ultra";

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
type DefaultRole = "chat" | "image" | "code" | "reasoning" | "video" | "audio";

interface ApiDefaults {
  chat: string;
  image: string;
  code: string;
  reasoning: string;
  video: string;
  audio: string;
}

// Settings tabs
type SettingsTab = "apis" | "costs" | "security" | "devtools" | "blocked";

// ── Main Component ─────────────────────────────────────
export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();

  useEffect(() => {
    UltraDevLog.setCurrentScreen('SettingsScreen');
    return () => UltraDevLog.setCurrentScreen('ChatScreen');
  }, []);
  const initialTab = (params.tab === "costs" || params.tab === "security" || params.tab === "devtools") ? params.tab as SettingsTab : "apis";
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  // ── API state ──────────────────────────────────────
  const [apis, setApis] = useState<ApiProvider[]>([]);
  const [editingApi, setEditingApi] = useState<ApiProvider | null>(null);
  const [isNewApi, setIsNewApi] = useState(false);
  const [providersExpanded, setProvidersExpanded] = useState(true);
  const [providerBilling, setProviderBilling] = useState<Record<string, { plan: string; usage: string; limit: string }>>({});
  const [providerEndpoints, setProviderEndpoints] = useState<Record<string, string[]>>({});
  const [defaults, setDefaults] = useState<ApiDefaults>({
    chat: "", image: "", code: "", reasoning: "", video: "", audio: "",
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
  const [tierVersion, setTierVersion] = useState(0);
  const [biometricGate] = useState(() => new BiometricGate());
  const [lockTimeout, setLockTimeout] = useState(0);
  const [backupImporting, setBackupImporting] = useState(false);

  // ── Draft persistence (survives app switches) ──────
  const saveDraft = useCallback(async (draft: ApiProvider | null, isNew: boolean) => {
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
    AppStorage.get("dev_mode_enabled").then((v) => { if (v === "1") setIsDevMode(true); });
  }, []);

  useEffect(() => {
    if (tab === 'devtools' && !isDevMode) setTab('apis');
  }, [isDevMode]);

  // ── Load settings on mount ─────────────────────────
  useEffect(() => {
    loadSettings();
    loadDraft();
    loadCostData();
  }, []);

  // ── Load models when API tab is shown ─────
  useEffect(() => {
    if (tab === 'apis') {
      const core = getAgentCoreInstance();
      const models = core ? core.getAvailableModels() || [] : [];
      setAvailableModels(models);
    }
  }, [tab, apis.length]);

  const handleVersionTap = useCallback(() => {
    devTapCountRef.current += 1;
    if (devTapTimerRef.current) clearTimeout(devTapTimerRef.current);
    devTapTimerRef.current = setTimeout(() => { devTapCountRef.current = 0; }, 2000);
    if (devTapCountRef.current >= 7) {
      devTapCountRef.current = 0;
      const next = !isDevMode;
      setIsDevMode(next);
      UltraDevLog.push('CHAIN', { component: 'Settings', action: 'version_tap_dev_mode', trigger: {}, state: { wasDevMode: isDevMode }, data: { taps: 7 }, outcome: next ? 'dev_mode_enabled' : 'dev_mode_disabled' });
      AppStorage.set("dev_mode_enabled", next ? "1" : "0");
      // Set TierService directly so it takes effect immediately without restart
      const core = getAgentCoreInstance();
      if (next && core?.getTierService()) {
        core.getTierService()!.setTier('dev');
        setTierVersion(v => v + 1);
      } else if (!next && core?.getTierService()) {
        core.getTierService()!.setTier('free');
        setTierVersion(v => v + 1);
      }
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
        try {
          const parsed: ApiProvider[] = JSON.parse(savedApis);
          // Migration: ensure all providers have categories and isActive fields
          const migrated = parsed.map((a) => ({
            ...a,
            categories: a.categories && a.categories.length > 0 ? a.categories : ['text' as ApiCategory],
            isActive: a.isActive !== undefined ? a.isActive : true,
          }));
          const needsWrite = migrated.some((a, i) => a.categories !== parsed[i]?.categories || a.isActive !== parsed[i]?.isActive);
          setApis(migrated);
          if (needsWrite) {
            await vault.set('saved_apis', JSON.stringify(migrated));
          }
        } catch {}
      } else {
        // Migration: if there's an existing Venice API key, create a saved API entry for it
        const legacyKey = await vault.get("venice_api_key");
        const legacyUrl = await vault.get("api_base_url");
        if (legacyKey) {
          const migratedApi: ApiProvider = {
            id: `api_${Date.now()}`,
            name: "Venice",
            baseUrl: legacyUrl || "https://api.venice.ai/api/v1",
            apiKey: legacyKey,
            password: "",
            categories: ['text', 'image', 'video', 'audio', 'code', 'reasoning'],
            isActive: true,
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
    UltraDevLog.push('CHAIN', { component: 'Settings', action: 'start_new_api', trigger: {}, state: { apiCount: apis.length }, data: {}, outcome: 'new_api_draft_created' });
    const draft: ApiProvider = {
      id: `api_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: "",
      baseUrl: "",
      apiKey: "",
      password: "",
      categories: ['text'],
      isActive: true,
    };
    setEditingApi(draft);
    setIsNewApi(true);
  }, [apis.length]);

  const startEditApi = useCallback((api: ApiProvider) => {
    UltraDevLog.push('CHAIN', { component: 'Settings', action: 'start_edit_api', trigger: { apiId: api.id }, state: {}, data: { name: api.name }, outcome: 'edit_form_opened' });
    setEditingApi({ ...api });
    setIsNewApi(false);
  }, []);

  const saveApi = useCallback(async () => {
    if (!editingApi?.name || !editingApi?.baseUrl) {
      UltraDevLog.push('CHAIN', { component: 'Settings', action: 'save_api', trigger: {}, state: { isNew: isNewApi }, data: { hasName: !!editingApi?.name, hasUrl: !!editingApi?.baseUrl }, outcome: 'EMPTY:validation_failed' });
      Alert.alert('Error', 'Name and Base URL are required.');
      return;
    }

    UltraDevLog.push('UI_TAP', { component: 'settings', target: 'save_api', provider: editingApi.name });
    UltraDevLog.push('CHAIN', { component: 'Settings', action: 'save_api', trigger: {}, state: { isNew: isNewApi }, data: { name: editingApi.name }, outcome: 'saving' });

    const updated: ApiProvider[] = isNewApi
      ? [...apis, editingApi]
      : apis.map((a) => a.id === editingApi.id ? editingApi : a);

    setApis(updated);
    setEditingApi(null);
    setIsNewApi(false);
    saveDraft(null, false);

    try {
      const vault = await SecureVault.initialize();
      await vault.set('saved_apis', JSON.stringify(updated));

      // Set the first active provider with a key as the engine's primary
      const primary = updated.find((a) => a.isActive && a.apiKey && (a.categories || []).includes('text'));
      if (primary) {
        await vault.set('venice_api_key', primary.apiKey);
        await vault.set('api_base_url', primary.baseUrl);
        DebugLog.settingsApiSave(primary.id, true);
        const core = getAgentCoreInstance();
        if (core) {
          await core.refreshApiKey();
          await core.setApiBaseUrl(primary.baseUrl);
        }
      } else {
        await vault.set('venice_api_key', '');
        await vault.set('api_base_url', '');
      }

      UltraDevLog.settingsSaveResult('api', true, ['saved_apis', 'venice_api_key', 'api_base_url']);
      setSavedFeedback('api');
      setTimeout(() => setSavedFeedback(null), 2000);
    } catch (err: any) {
      UltraDevLog.settingsSaveResult('api', false, [], err.message);
      DebugLog.uiError('settings_saveApi', err.message);
      Alert.alert('Error', err.message);
    }
  }, [editingApi, isNewApi, apis]);

  // Recompute + apply the primary engine key/URL from the current provider list
  const refreshPrimaryEngine = useCallback(async (providers: ApiProvider[]) => {
    try {
      const vault = await SecureVault.initialize();
      const primary = providers.find((a) => a.isActive && a.apiKey && (a.categories || []).includes('text'));
      if (primary) {
        await vault.set('venice_api_key', primary.apiKey);
        await vault.set('api_base_url', primary.baseUrl);
        const core = getAgentCoreInstance();
        if (core) {
          await core.refreshApiKey();
          await core.setApiBaseUrl(primary.baseUrl);
        }
      } else {
        await vault.set('venice_api_key', '');
        await vault.set('api_base_url', '');
      }
    } catch {}
  }, []);

  const probeProvider = useCallback(async (api: ApiProvider) => {
    try {
      const res = await fetch(`${api.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${api.apiKey}` },
      });
      if (res.ok) {
        const json = await res.json();
        const ids: string[] = (json.data || []).map((m: any) => m.id || m.name || String(m));
        setProviderEndpoints(prev => ({ ...prev, [api.id]: ids }));
      }
    } catch {}
  }, []);

  const fetchProviderBilling = useCallback(async (api: ApiProvider) => {
    try {
      const res = await fetch(`${api.baseUrl}/billing`, {
        headers: { Authorization: `Bearer ${api.apiKey}` },
      });
      if (res.ok) {
        const json = await res.json();
        setProviderBilling(prev => ({
          ...prev,
          [api.id]: {
            plan: json.plan || 'unknown',
            usage: json.usage != null ? `$${Number(json.usage).toFixed(4)}` : '—',
            limit: json.limit != null ? `$${Number(json.limit).toFixed(2)}` : '—',
          },
        }));
      }
    } catch {}
  }, []);

  const deleteApi = useCallback(async (id: string) => {
    UltraDevLog.push('CHAIN', { component: 'Settings', action: 'delete_api', trigger: { apiId: id }, state: { apiCount: apis.length }, data: {}, outcome: 'deleting' });
    UltraDevLog.push('EFFECT', { component: 'Settings', action: 'delete_api', success: true, apiId: id, remainingCount: apis.length - 1 });
    DebugLog.settingsApiDelete(id, true);
    const updated = apis.filter((a) => a.id !== id);
    setApis(updated);

    try {
      const vault = await SecureVault.initialize();
      await vault.set("saved_apis", JSON.stringify(updated));
      await refreshPrimaryEngine(updated);
      // Only clear defaults if no APIs remain — otherwise preserve them.
      if (updated.length === 0) {
        const cleanDefaults = { chat: "", image: "", code: "", reasoning: "", video: "", audio: "" };
        setDefaults(cleanDefaults);
        await vault.set("api_defaults", JSON.stringify(cleanDefaults));
      }
    } catch (e: any) { DebugLog.uiError("deleteApi_vault", e?.message || "unknown"); }
  }, [apis, refreshPrimaryEngine]);

  const saveDefaults = useCallback(async () => {
    UltraDevLog.push('CHAIN', { component: 'Settings', action: 'save_defaults', trigger: {}, state: { tab }, data: { defaults }, outcome: 'saving' });
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
    UltraDevLog.push('CHAIN', { component: 'Settings', action: 'save_limits', trigger: {}, state: {}, data: { dailyLimit, taskLimit }, outcome: 'saving' });
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
    if (tab === "devtools" && !logsLoaded) loadLogs();
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
        {(["apis", "costs", "security", ...(isDevMode ? ["devtools" as SettingsTab] : []), "blocked"] as SettingsTab[]).map((t) => (
          <Pressable
            key={t}
            testID={`SettingsTab-${t}`}
            onPress={() => {
              UltraDevLog.push('SETTINGS_TAB_SWITCH', { from: tab, to: t });
              UltraDevLog.push('CHAIN', { component: 'Settings', action: 'tab_switch', trigger: {}, state: { from: tab }, data: { to: t }, outcome: `switched_to_${t}` });
              setTab(t);
              if (t === "devtools") { loadLogs(); }
              if (t === "costs") loadCostData();
            }}
            style={[styles.tab, tab === t && styles.tabActive]}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === "apis" ? "API Setup" : t === "costs" ? "Cost Limits" : t === "security" ? "Security" : t === "devtools" ? "Dev Tools" : "Blocked"}
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
            {/* ── Tier gate: API locked for free/no_ads ── */}
            {!getAgentCoreInstance()?.getTierService()?.isApiUnlocked() && getAgentCoreInstance()?.getTierService()?.getTier() !== 'dev' && (
              <View style={styles.card}>
                <Ionicons name="lock-closed" size={32} color="#666" style={{ alignSelf: 'center', marginBottom: 8 }} />
                <Text style={[styles.cardTitle, { textAlign: 'center' }]}>API Setup — Pro Feature</Text>
                <Text style={[styles.cardSubtitle, { textAlign: 'center' }]}>
                  Upgrade to Pro ($9.99/mo) to connect your own AI providers.{'\n'}
                  The agent works without AI — try "Open camera" or "Toggle flashlight".
                </Text>
                <Pressable
                  onPress={() => {
                    Alert.alert('Coming Soon', 'Subscription will be available on Google Play.');
                  }}
                  style={[styles.btn, styles.primaryBtn, { marginTop: 12, alignSelf: 'center' }]}
                >
                  <Ionicons name="arrow-up-circle" size={16} color={BG} />
                  <Text style={styles.primaryBtnText}>Upgrade to Pro</Text>
                </Pressable>
              </View>
            )}

            {/* ── API Management (Pro/Dev only) ── */}
            {(getAgentCoreInstance()?.getTierService()?.isApiUnlocked() || getAgentCoreInstance()?.getTierService()?.getTier() === 'dev') && (
              <>
                {/* Editing form */}
                {editingApi ? (
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>{isNewApi ? "Add API Provider" : "Edit Provider"}</Text>

                    <Text style={styles.fieldLabel}>Provider Name *</Text>
                    <TextInput
                      value={editingApi.name}
                      onChangeText={(t) => setEditingApi({ ...editingApi, name: t })}
                      placeholder='e.g., "Venice AI", "OpenRouter", "Local LLM"'
                      placeholderTextColor="#444"
                      style={styles.textInput}
                    />

                    <Text style={styles.fieldLabel}>Base URL *</Text>
                    <TextInput
                      value={editingApi.baseUrl}
                      onChangeText={(t) => setEditingApi({ ...editingApi, baseUrl: t })}
                      placeholder="https://api.venice.ai/api/v1"
                      placeholderTextColor="#444"
                      style={styles.textInput}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                    />

                    <Text style={styles.fieldLabel}>API Key</Text>
                    <TextInput
                      value={editingApi.apiKey}
                      onChangeText={(t) => setEditingApi({ ...editingApi, apiKey: t })}
                      placeholder="Your provider's API key"
                      placeholderTextColor="#444"
                      style={styles.textInput}
                      autoCapitalize="none"
                      secureTextEntry
                    />

                    <Text style={styles.fieldLabel}>Auth Token (optional)</Text>
                    <TextInput
                      value={editingApi.password || ''}
                      onChangeText={(t) => setEditingApi({ ...editingApi, password: t })}
                      placeholder="Bearer token if required"
                      placeholderTextColor="#444"
                      style={styles.textInput}
                      autoCapitalize="none"
                      secureTextEntry
                    />

                    <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Use For (select all that apply)</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                      {(['text', 'image', 'video', 'audio', 'code', 'reasoning'] as ApiCategory[]).map(cat => {
                        const active = (editingApi.categories || []).includes(cat);
                        return (
                          <Pressable
                            key={cat}
                            onPress={() => {
                              const cats = editingApi.categories || [];
                              const updated = active ? cats.filter((c) => c !== cat) : [...cats, cat];
                              setEditingApi({ ...editingApi, categories: updated });
                            }}
                            style={[styles.btn, active ? styles.primaryBtn : styles.secondaryBtn, { paddingHorizontal: 14 }]}
                          >
                            <Text style={active ? styles.primaryBtnText : styles.secondaryBtnText}>
                              {cat.charAt(0).toUpperCase() + cat.slice(1)}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>

                    <View style={[styles.btnRow, { marginTop: 14 }]}>
                      <Pressable onPress={saveApi} style={[styles.btn, styles.primaryBtn]}>
                        <Ionicons name="save-outline" size={16} color={BG} />
                        <Text style={styles.primaryBtnText}>Save Provider</Text>
                      </Pressable>
                      <Pressable onPress={() => { setEditingApi(null); setIsNewApi(false); saveDraft(null, false); }} style={[styles.btn, styles.secondaryBtn]}>
                        <Text style={styles.secondaryBtnText}>Cancel</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <>
                    {/* ── Provider list ── */}
                    <Pressable style={styles.sectionHeader} onPress={() => setProvidersExpanded(v => !v)}>
                      <Text style={styles.sectionTitle}>API Providers</Text>
                      <Ionicons name={providersExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={DIM} />
                    </Pressable>

                    {providersExpanded && apis.length === 0 && (
                      <View style={styles.card}>
                        <Text style={{ color: '#666', textAlign: 'center', fontSize: 13 }}>
                          No providers configured.{'\n'}Add one to unlock AI features.
                        </Text>
                      </View>
                    )}

                    {providersExpanded && apis.map((api) => {
                      const hasKey = !!api.apiKey;
                      return (
                        <View key={api.id} style={[styles.card, { borderColor: hasKey && api.isActive ? '#1a3a2a' : '#1e1e1e' }]}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                              <View style={{
                                width: 8, height: 8, borderRadius: 4, marginRight: 8,
                                backgroundColor: hasKey && api.isActive ? '#34d399' : '#666',
                              }} />
                              <Text style={{ color: TEXT, fontSize: 14, fontFamily: 'Inter_600SemiBold' }} numberOfLines={1}>
                                {api.name}
                              </Text>
                            </View>
                            <View style={{ flexDirection: 'row', gap: 8 }}>
                              <Pressable onPress={() => startEditApi(api)}>
                                <Ionicons name="pencil-outline" size={16} color={DIM} />
                              </Pressable>
                              {!api.isBuiltIn && (
                                <Pressable onPress={() => {
                                  Alert.alert('Delete Provider', `Remove ${api.name}?`, [
                                    { text: 'Cancel', style: 'cancel' },
                                    { text: 'Delete', style: 'destructive', onPress: () => deleteApi(api.id) },
                                  ]);
                                }}>
                                  <Ionicons name="trash-outline" size={16} color="#ef4444" />
                                </Pressable>
                              )}
                            </View>
                          </View>

                          <Text style={{ color: '#444', fontSize: 11, marginTop: 4 }} numberOfLines={1}>
                            {api.baseUrl}
                          </Text>

                          {/* Category badges */}
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                            {(api.categories || []).map((cat) => (
                              <View key={cat} style={{ paddingHorizontal: 8, paddingVertical: 2, backgroundColor: '#1a1a1a', borderRadius: 4 }}>
                                <Text style={{ color: '#888', fontSize: 10 }}>{cat}</Text>
                              </View>
                            ))}
                            {(!api.categories || api.categories.length === 0) && (
                              <Text style={{ color: '#444', fontSize: 10, fontStyle: 'italic' }}>No categories assigned</Text>
                            )}
                          </View>

                          {/* Active toggle */}
                          <Pressable
                            onPress={async () => {
                              const updated = apis.map((a) => a.id === api.id ? { ...a, isActive: !a.isActive } : a);
                              setApis(updated);
                              try {
                                const vault = await SecureVault.initialize();
                                await vault.set('saved_apis', JSON.stringify(updated));
                                await refreshPrimaryEngine(updated);
                              } catch {}
                            }}
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}
                          >
                            <Ionicons name={api.isActive ? 'checkmark-circle' : 'ellipse-outline'} size={16} color={api.isActive ? ACCENT : DIM} />
                            <Text style={{ color: api.isActive ? ACCENT : DIM, fontSize: 12 }}>
                              {api.isActive ? 'Active' : 'Disabled'}
                            </Text>
                          </Pressable>

                          {/* Probe / Billing row */}
                          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                            <Pressable
                              onPress={() => probeProvider(api)}
                              style={[styles.btn, styles.secondaryBtn, { flex: 1, justifyContent: 'center', paddingVertical: 4 }]}
                            >
                              <Ionicons name="search-outline" size={12} color={DIM} />
                              <Text style={[styles.secondaryBtnText, { fontSize: 11 }]}>Probe Models</Text>
                            </Pressable>
                            <Pressable
                              onPress={() => fetchProviderBilling(api)}
                              style={[styles.btn, styles.secondaryBtn, { flex: 1, justifyContent: 'center', paddingVertical: 4 }]}
                            >
                              <Ionicons name="card-outline" size={12} color={DIM} />
                              <Text style={[styles.secondaryBtnText, { fontSize: 11 }]}>Fetch Billing</Text>
                            </Pressable>
                          </View>

                          {providerEndpoints[api.id] && (
                            <Text style={{ color: '#888', fontSize: 10, marginTop: 4 }}>
                              {providerEndpoints[api.id].length} model{providerEndpoints[api.id].length !== 1 ? 's' : ''} discovered
                            </Text>
                          )}

                          {providerBilling[api.id] && (
                            <View style={{ backgroundColor: '#0d1a0f', borderRadius: 6, padding: 8, marginTop: 6 }}>
                              <Text style={{ color: '#aaa', fontSize: 11 }}>
                                Plan: <Text style={{ color: TEXT }}>{providerBilling[api.id].plan}</Text>
                                {'  ·  '}Usage: <Text style={{ color: TEXT }}>{providerBilling[api.id].usage}</Text>
                                {'  ·  '}Limit: <Text style={{ color: TEXT }}>{providerBilling[api.id].limit}</Text>
                              </Text>
                            </View>
                          )}
                        </View>
                      );
                    })}

                    {/* Add Provider button */}
                    <Pressable
                      onPress={startNewApi}
                      style={[styles.btn, styles.secondaryBtn, { alignSelf: 'stretch', justifyContent: 'center', marginTop: 8 }]}
                    >
                      <Ionicons name="add-circle-outline" size={16} color={ACCENT} />
                      <Text style={[styles.secondaryBtnText, { color: ACCENT }]}>Add Provider</Text>
                    </Pressable>

                    {/* ── Quick presets ── */}
                    <View style={[styles.card, { marginTop: 12 }]}>
                      <Text style={styles.cardTitle}>Quick Setup</Text>
                      <Text style={[styles.cardSubtitle, { marginBottom: 8 }]}>Tap to auto-fill a provider. You still need your own API key.</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        {[
                          { name: 'Venice AI', url: 'https://api.venice.ai/api/v1', cats: ['text', 'image', 'video', 'audio', 'code', 'reasoning'] as ApiCategory[] },
                          { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', cats: ['text', 'code', 'reasoning'] as ApiCategory[] },
                          { name: 'OpenAI', url: 'https://api.openai.com/v1', cats: ['text', 'image', 'code', 'reasoning'] as ApiCategory[] },
                          { name: 'Anthropic', url: 'https://api.anthropic.com/v1', cats: ['text', 'code', 'reasoning'] as ApiCategory[] },
                          { name: 'Local Ollama', url: 'http://localhost:11434/v1', cats: ['text', 'code'] as ApiCategory[] },
                          { name: 'Local LM Studio', url: 'http://localhost:1234/v1', cats: ['text', 'code'] as ApiCategory[] },
                        ].map(preset => (
                          <Pressable
                            key={preset.name}
                            onPress={() => {
                              setEditingApi({
                                id: `api_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                                name: preset.name,
                                apiKey: '',
                                password: '',
                                isBuiltIn: false,
                                isActive: true,
                                baseUrl: preset.url,
                                categories: preset.cats,
                              });
                              setIsNewApi(true);
                            }}
                            style={[styles.btn, styles.secondaryBtn]}
                          >
                            <Text style={styles.secondaryBtnText}>{preset.name}</Text>
                          </Pressable>
                        ))}
                      </View>
                    </View>

                    {/* ── Default Model Per Category ── */}
                    <View style={styles.card}>
                      <Text style={styles.cardTitle}>Default Model Per Category</Text>
                      <Text style={[styles.cardSubtitle, { marginBottom: 8 }]}>
                        Choose which model handles each type of request. Models come from your active providers.
                      </Text>

                      {(['chat', 'image', 'code', 'reasoning', 'video', 'audio'] as DefaultRole[]).map(role => {
                        const catMap: Record<string, ApiCategory> = { chat: 'text', image: 'image', code: 'code', reasoning: 'reasoning', video: 'video', audio: 'audio' };
                        const targetCat = catMap[role];
                        const filteredModels = (availableModels || []).filter((m: any) => {
                          const type = classifyModelType(m.id || m.name || '');
                          if (targetCat === 'text') return type === 'text' || type === 'chat';
                          return type === targetCat;
                        });
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
                                    } catch {}
                                  }}
                                  style={[styles.defaultOption, !defaults[role] && styles.defaultOptionActive]}
                                >
                                  <Text style={[styles.defaultOptionText, !defaults[role] && styles.defaultOptionTextActive]}>Auto</Text>
                                </Pressable>
                                {filteredModels.length === 0 && (availableModels || []).length > 0 && (
                                  <Text style={{ color: '#444', fontSize: 11, alignSelf: 'center', paddingHorizontal: 8 }}>No {targetCat} models</Text>
                                )}
                                {filteredModels.map((m: any) => {
                                  const isActive = defaults[role] === m.id;
                                  return (
                                    <Pressable
                                      key={m.id}
                                      onPress={async () => {
                                        const updated = { ...defaults, [role]: m.id };
                                        setDefaults(updated);
                                        try {
                                          const vault = await SecureVault.initialize();
                                          await vault.set("api_defaults", JSON.stringify(updated));
                                        } catch {}
                                      }}
                                      style={[styles.defaultOption, isActive && styles.defaultOptionActive]}
                                    >
                                      <Text style={[styles.defaultOptionText, isActive && styles.defaultOptionTextActive]} numberOfLines={1}>
                                        {(m.name || m.id).slice(0, 22)}
                                      </Text>
                                    </Pressable>
                                  );
                                })}
                              </ScrollView>
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  </>
                )}
              </>
            )}
          </>
        )}

        {tab === "security" && (
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
                      UltraDevLog.push('CHAIN', { component: 'Settings', action: 'set_lock_timeout', trigger: { mins }, state: { prevTimeout: lockTimeout }, data: {}, outcome: 'saving' });
                      await biometricGate.setLockTimeout(mins);
                      setLockTimeout(mins);
                      UltraDevLog.push('EFFECT', { component: 'Settings', action: 'set_lock_timeout', success: true, mins });
                    }}
                  >
                    <Text style={active ? styles.primaryBtnText : styles.secondaryBtnText}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        {tab === "security" && (
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
                  UltraDevLog.push('CHAIN', { component: 'Settings', action: 'export_preferences', trigger: {}, state: {}, data: {}, outcome: 'exporting' });
                  try {
                    const result = await exportPreferences();
                    UltraDevLog.push('EFFECT', { component: 'Settings', action: 'export_preferences', success: result.success, message: result.message });
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
                  UltraDevLog.push('CHAIN', { component: 'Settings', action: 'import_preferences', trigger: {}, state: {}, data: {}, outcome: 'importing' });
                  try {
                    const result = await importPreferences();
                    UltraDevLog.push('EFFECT', { component: 'Settings', action: 'import_preferences', success: result.success, message: result.message });
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

        {tab === "devtools" && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Dev Tier Override</Text>
            <Text style={[styles.cardSubtitle, { marginBottom: 10 }]}>
              Force a specific tier for testing. Resets on next full load.
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {(['free', 'no_ads', 'pro', 'dev'] as const).map(t => {
                const current = getAgentCoreInstance()?.getTierService()?.getTier();
                const isActive = current === t;
                return (
                  <Pressable
                    key={t}
                    onPress={async () => {
                      const core = getAgentCoreInstance();
                      if (core?.getTierService()) {
                        await core.getTierService()!.setTier(t);
                        setTierVersion(v => v + 1);
                      }
                    }}
                    style={[styles.btn, isActive ? styles.primaryBtn : styles.secondaryBtn]}
                  >
                    <Text style={isActive ? styles.primaryBtnText : styles.secondaryBtnText}>
                      {t}
                    </Text>
                  </Pressable>
                );
              })}
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

            {/* Per-provider billing summary */}
            {apis.filter(a => providerBilling[a.id]).length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Provider Billing</Text>
                {apis.filter(a => providerBilling[a.id]).map(a => (
                  <View key={a.id} style={{ marginBottom: 8 }}>
                    <Text style={{ color: TEXT, fontSize: 13, fontFamily: 'Inter_600SemiBold', marginBottom: 2 }}>{a.name}</Text>
                    <Text style={{ color: '#888', fontSize: 11 }}>
                      Plan: <Text style={{ color: TEXT }}>{providerBilling[a.id].plan}</Text>
                      {'  ·  '}Usage: <Text style={{ color: TEXT }}>{providerBilling[a.id].usage}</Text>
                      {'  ·  '}Limit: <Text style={{ color: TEXT }}>{providerBilling[a.id].limit}</Text>
                    </Text>
                  </View>
                ))}
              </View>
            )}

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
            TAB: DEV TOOLS
            ══════════════════════════════════════════ */}
        {tab === "devtools" && (
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

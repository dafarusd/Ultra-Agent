import React, { useState, useEffect, useCallback, useRef } from "react";
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
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { exportPreferences, importPreferences } from '@/src/services/PreferenceBackup';
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Sharing from "expo-sharing";
import { LogFolder, type LogFile } from "@/src/services/LogFolder";
import { SecureVault } from "@/src/security/SecureVault";
import { getAgentCoreInstance } from "@/src/core/AgentCore";
import { UltraDevLog as DebugLog, UltraDevLog } from "@/src/utils/UltraDevLog";
import UsageIndicator, { ModelUsage } from "@/components/UsageIndicator";
import BlockedAppsTab from "@/components/BlockedAppsTab";
import { BiometricGate } from "@/src/security/BiometricGate";
import type {
  ApiProvider,
  ModelGroup,
  GroupMember,
  AllowedOperation,
  SelectionStrategy,
  AuthMode,
} from "@/src/types/provider";

// ── Palette ──────────────────────────────────────────────
const ACCENT = "#e5e5e5";
const BG = "#000000";
const SURFACE = "#0e0e0e";
const SURFACE2 = "#161616";
const SURFACE3 = "#222222";
const DIM = "#666666";
const TEXT = "#e0e0e0";
const DANGER = "#ef4444";
const SUCCESS = "#22c55e";

// ── Types ────────────────────────────────────────────────
type SettingsTab = "apis" | "costs" | "security" | "devtools" | "blocked";
type ApisSubTab = "providers" | "groups" | "defaults";

const ALL_OPERATIONS: AllowedOperation[] = [
  'chat', 'reason', 'vision', 'image_generate', 'audio_generate',
  'audio_transcribe', 'video_generate', 'embeddings', 'tool_use', 'generic_text',
];

const STRATEGY_LABELS: Record<SelectionStrategy, string> = {
  priority: 'Priority',
  round_robin: 'Round Robin',
  cheapest_first: 'Cheapest First',
  fastest_first: 'Fastest First',
  highest_context: 'Most Context',
  last_known_good: 'Last Known Good',
  fallback_chain: 'Fallback Chain',
};

const AUTH_MODES: AuthMode[] = ['bearer', 'api_key_header', 'basic', 'custom_header', 'none'];

const PRESETS = [
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', authMode: 'bearer' as AuthMode },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', authMode: 'bearer' as AuthMode },
  { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', authMode: 'bearer' as AuthMode },
  { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', authMode: 'bearer' as AuthMode },
  { name: 'Local Ollama', baseUrl: 'http://localhost:11434/v1', authMode: 'none' as AuthMode },
];

// ── ProviderForm state ───────────────────────────────────
interface ProviderDraft {
  id: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  apiKey: string;
  password: string;
  capabilities: AllowedOperation[];
  enabled: boolean;
}

function emptyDraft(): ProviderDraft {
  return {
    id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    baseUrl: '',
    authMode: 'bearer',
    apiKey: '',
    password: '',
    capabilities: ['chat'],
    enabled: true,
  };
}

// ── GroupForm state ──────────────────────────────────────
interface GroupDraft {
  id: string;
  name: string;
  operations: AllowedOperation[];
  strategy: SelectionStrategy;
  enabled: boolean;
  members: GroupMember[];
  tags: string[];
}

function emptyGroupDraft(): GroupDraft {
  return {
    id: `g_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    operations: ['chat'],
    strategy: 'priority',
    enabled: true,
    members: [],
    tags: [],
  };
}

// ── Main Component ────────────────────────────────────────
export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();

  useEffect(() => {
    UltraDevLog.setCurrentScreen('SettingsScreen');
    return () => UltraDevLog.setCurrentScreen('ChatScreen');
  }, []);

  const initialTab = (['costs', 'security', 'devtools', 'blocked'] as SettingsTab[]).includes(params.tab as SettingsTab)
    ? params.tab as SettingsTab
    : 'apis';
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [apisSubTab, setApisSubTab] = useState<ApisSubTab>('providers');

  // ── Provider state ──────────────────────────────────────
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(null);
  const [isNewProvider, setIsNewProvider] = useState(false);
  const [probingId, setProbingId] = useState<string | null>(null);

  // ── Group state ─────────────────────────────────────────
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);
  const [isNewGroup, setIsNewGroup] = useState(false);
  const [memberModelInput, setMemberModelInput] = useState('');
  const [memberProviderInput, setMemberProviderInput] = useState('');

  // ── Defaults state ──────────────────────────────────────
  const [operationMapping, setOperationMapping] = useState<Record<string, string | null>>({});

  // ── Cost state ──────────────────────────────────────────
  const [dailyLimit, setDailyLimit] = useState('0');
  const [taskLimit, setTaskLimit] = useState('0');
  const [totalCost, setTotalCost] = useState(0);
  const [totalCalls, setTotalCalls] = useState(0);
  const [modelUsages, setModelUsages] = useState<ModelUsage[]>([]);

  // ── Dev mode ────────────────────────────────────────────
  const [isDevMode, setIsDevMode] = useState(false);
  const [tierVersion, setTierVersion] = useState(0);
  const devTapCountRef = useRef(0);
  const devTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Logs ────────────────────────────────────────────────
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [logsLoaded, setLogsLoaded] = useState(false);

  // ── Security ─────────────────────────────────────────────
  const [backupExporting, setBackupExporting] = useState(false);
  const [backupImporting, setBackupImporting] = useState(false);
  const [biometricGate] = useState(() => new BiometricGate());
  const [lockTimeout, setLockTimeout] = useState(0);

  // ── Load on mount ────────────────────────────────────────
  useEffect(() => {
    AppStorage.get('dev_mode_enabled').then(v => { if (v === '1') setIsDevMode(true); });
    loadProviders();
    loadGroups();
    loadDefaults();
    loadCostData();
    loadLimits();
    initBiometric();
  }, []);

  useEffect(() => {
    if (tab === 'devtools' && !isDevMode) setTab('apis');
  }, [isDevMode]);

  useEffect(() => {
    if (tab === 'devtools' && !logsLoaded) loadLogs();
  }, [tab, logsLoaded]);

  useEffect(() => {
    if (tab === 'costs') loadCostData();
  }, [tab]);

  const loadProviders = useCallback(() => {
    const core = getAgentCoreInstance();
    if (!core) return;
    try {
      const pm = (core as any).getProviderManager?.();
      if (pm) setProviders(pm.getAll());
    } catch {}
  }, []);

  const loadGroups = useCallback(() => {
    const core = getAgentCoreInstance();
    if (!core) return;
    try {
      const gm = (core as any).getGroupManager?.();
      if (gm) setGroups(gm.getAll());
    } catch {}
  }, []);

  const loadDefaults = useCallback(() => {
    const core = getAgentCoreInstance();
    if (!core) return;
    try {
      const ai = (core as any).getAiService?.();
      if (ai) setOperationMapping(ai.getOperationMapping?.() || {});
    } catch {}
  }, []);

  const loadCostData = useCallback(() => {
    const core = getAgentCoreInstance();
    if (!core) return;
    try {
      const summary = core.getCostSummary();
      setTotalCost(summary.totalCost);
      setTotalCalls(summary.totalCalls);
      const usages: ModelUsage[] = Object.entries(summary.costByModel || {}).map(([modelId, cost]) => ({
        modelId,
        modelName: modelId,
        apiName: summary.costByProvider?.[modelId] ?? '',
        calls: summary.callsByModel?.[modelId] || 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: cost as number,
      }));
      setModelUsages(usages);
    } catch {}
  }, []);

  const loadLimits = useCallback(async () => {
    try {
      const vault = await SecureVault.initialize();
      const dl = await vault.get('daily_cost_limit');
      setDailyLimit(dl || '0');
      const tl = await vault.get('task_cost_limit');
      setTaskLimit(tl || '0');
    } catch {}
  }, []);

  const initBiometric = useCallback(async () => {
    try {
      const vault = await SecureVault.initialize();
      await biometricGate.init(vault);
      setLockTimeout(biometricGate.getLockTimeout());
    } catch {}
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      const files = await LogFolder.listLogs();
      setLogFiles(files);
      setLogsLoaded(true);
    } catch {
      setLogFiles([]);
      setLogsLoaded(true);
    }
  }, []);

  // ── Dev mode tap ─────────────────────────────────────────
  const handleVersionTap = useCallback(() => {
    devTapCountRef.current += 1;
    if (devTapTimerRef.current) clearTimeout(devTapTimerRef.current);
    devTapTimerRef.current = setTimeout(() => { devTapCountRef.current = 0; }, 2000);
    if (devTapCountRef.current >= 7) {
      devTapCountRef.current = 0;
      const next = !isDevMode;
      setIsDevMode(next);
      AppStorage.set('dev_mode_enabled', next ? '1' : '0');
      const core = getAgentCoreInstance();
      if (core?.getTierService()) {
        core.getTierService()!.setTier(next ? 'dev' : 'free');
        setTierVersion(v => v + 1);
      }
      Alert.alert(next ? 'Dev Mode ON' : 'Dev Mode OFF', next ? 'Logs tab enabled.' : 'Dev mode off.');
    }
  }, [isDevMode]);

  // ── Tier check ───────────────────────────────────────────
  const isApiUnlocked = () => {
    const core = getAgentCoreInstance();
    const ts = core?.getTierService?.();
    return !ts || ts.isApiUnlocked?.() || ts.getTier?.() === 'dev' || ts.getTier?.() === 'pro';
  };

  // ── Provider CRUD ────────────────────────────────────────
  const startNewProvider = useCallback((preset?: typeof PRESETS[0]) => {
    const d = emptyDraft();
    if (preset) {
      d.name = preset.name;
      d.baseUrl = preset.baseUrl;
      d.authMode = preset.authMode;
      d.capabilities = [...(preset.capabilities || d.capabilities || [])];
    }
    setProviderDraft(d);
    setIsNewProvider(true);
  }, []);

  const startEditProvider = useCallback((p: ProviderRecord) => {
    setProviderDraft({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      authMode: p.authMode ?? 'bearer',
      apiKey: p.apiKey ?? '',
      password: p.password ?? '',
      capabilities: [...(p.capabilities ?? [])],
      enabled: p.isActive,
    });
    setIsNewProvider(false);
  }, []);

  const saveProvider = useCallback(async () => {
    if (!providerDraft?.name.trim() || !providerDraft?.baseUrl.trim()) {
      Alert.alert('Error', 'Name and Base URL are required.');
      return;
    }
    const core = getAgentCoreInstance();
    const pm = (core as any)?.getProviderManager?.();
    if (!pm) { Alert.alert('Error', 'Provider manager not available. Is the agent running?'); return; }
    try {
      if (isNewProvider) {
        await pm.addProvider({
          name: providerDraft.name.trim(),
          baseUrl: providerDraft.baseUrl.trim(),
          authMode: providerDraft.authMode,
          apiKey: providerDraft.apiKey.trim() || '',
          password: providerDraft.password.trim() || undefined,
          capabilities: providerDraft.capabilities,
          enabled: providerDraft.enabled,
        });
      } else {
        await pm.updateProvider(providerDraft.id, {
          name: providerDraft.name.trim(),
          baseUrl: providerDraft.baseUrl.trim(),
          authMode: providerDraft.authMode,
          apiKey: providerDraft.apiKey.trim() || undefined,
          password: providerDraft.password.trim() || undefined,
          capabilities: providerDraft.capabilities,
          isActive: providerDraft.enabled,
        });
      }
      setProviderDraft(null);
      loadProviders();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  }, [providerDraft, isNewProvider, loadProviders]);

  const deleteProvider = useCallback(async (id: string, name: string) => {
    Alert.alert('Delete Provider', `Remove "${name}"? Groups using this provider will need updating.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        const core = getAgentCoreInstance();
        const pm = (core as any)?.getProviderManager?.();
        if (!pm) return;
        try {
          await pm.deleteProvider(id);
          loadProviders();
        } catch (err: any) { Alert.alert('Error', err.message); }
      }},
    ]);
  }, [loadProviders]);

  const toggleProvider = useCallback(async (id: string, enabled: boolean) => {
    const core = getAgentCoreInstance();
    const pm = (core as any)?.getProviderManager?.();
    if (!pm) return;
    try {
      await pm.setActive(id, enabled);
      loadProviders();
    } catch {}
  }, [loadProviders]);

  const probeProvider = useCallback(async (id: string) => {
    setProbingId(id);
    try {
      const core = getAgentCoreInstance();
      const pm = (core as any)?.getProviderManager?.();
      if (!pm) return;
      await pm.probe(id);
      loadProviders();
    } catch (err: any) {
      Alert.alert('Probe failed', err.message);
    } finally {
      setProbingId(null);
    }
  }, [loadProviders]);

  // ── Group CRUD ───────────────────────────────────────────
  const startNewGroup = useCallback(() => {
    setGroupDraft(emptyGroupDraft());
    setIsNewGroup(true);
    setMemberModelInput('');
    setMemberProviderInput('');
  }, []);

  const startEditGroup = useCallback((g: ModelGroup) => {
    setGroupDraft({
      id: g.id,
      name: g.name,
      operations: [...(g.operations ?? [])],
      strategy: g.selectionStrategy ?? 'priority',
      enabled: g.isActive,
      members: [...(g.members ?? [])],
      tags: [...(g.tags ?? [])],
    });
    setIsNewGroup(false);
    setMemberModelInput('');
    setMemberProviderInput('');
  }, []);

  const saveGroup = useCallback(async () => {
    if (!groupDraft?.name.trim()) {
      Alert.alert('Error', 'Group name is required.');
      return;
    }
    if (!groupDraft.members.length) {
      Alert.alert('Error', 'Add at least one model member to the group.');
      return;
    }
    const core = getAgentCoreInstance();
    const gm = (core as any)?.getGroupManager?.();
    if (!gm) { Alert.alert('Error', 'Group manager not available.'); return; }
    try {
      if (isNewGroup) {
        await gm.createGroup({
          id: groupDraft.id,
          name: groupDraft.name.trim(),
          operations: groupDraft.operations,
          strategy: groupDraft.strategy,
          enabled: groupDraft.enabled,
          members: groupDraft.members,
          tags: groupDraft.tags,
        });
      } else {
        await gm.updateGroup(groupDraft.id, {
          name: groupDraft.name.trim(),
          operations: groupDraft.operations,
          strategy: groupDraft.strategy,
          enabled: groupDraft.enabled,
          members: groupDraft.members,
          tags: groupDraft.tags,
        });
      }
      setGroupDraft(null);
      loadGroups();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  }, [groupDraft, isNewGroup, loadGroups]);

  const deleteGroup = useCallback(async (id: string, name: string) => {
    Alert.alert('Delete Group', `Remove "${name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        const core = getAgentCoreInstance();
        const gm = (core as any)?.getGroupManager?.();
        if (!gm) return;
        try {
          await gm.deleteGroup(id);
          loadGroups();
        } catch (err: any) { Alert.alert('Error', err.message); }
      }},
    ]);
  }, [loadGroups]);

  const toggleGroup = useCallback(async (id: string, enabled: boolean) => {
    const core = getAgentCoreInstance();
    const gm = (core as any)?.getGroupManager?.();
    if (!gm) return;
    try {
      await gm.updateGroup(id, { enabled });
      loadGroups();
    } catch {}
  }, [loadGroups]);

  const addMemberToGroupDraft = useCallback(() => {
    if (!groupDraft) return;
    const modelId = memberModelInput.trim();
    const providerId = memberProviderInput.trim();
    if (!modelId || !providerId) {
      Alert.alert('Error', 'Enter both a provider ID and a model ID.');
      return;
    }
    const member: GroupMember = {
      providerId,
      modelId,
      priority: groupDraft.members.length + 1,
      weight: 1,
      enabled: true,
    };
    setGroupDraft({ ...groupDraft, members: [...groupDraft.members, member] });
    setMemberModelInput('');
    setMemberProviderInput('');
  }, [groupDraft, memberModelInput, memberProviderInput]);

  const removeMemberFromGroupDraft = useCallback((idx: number) => {
    if (!groupDraft) return;
    const members = groupDraft.members.filter((_, i) => i !== idx);
    setGroupDraft({ ...groupDraft, members });
  }, [groupDraft]);

  // ── Defaults ─────────────────────────────────────────────
  const setOperationGroup = useCallback(async (op: AllowedOperation, groupId: string | null) => {
    const core = getAgentCoreInstance();
    const ai = (core as any)?.getAiService?.();
    if (!ai) return;
    try {
      await ai.setOperationGroup?.(op, groupId);
      setOperationMapping(ai.getOperationMapping?.() || {});
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  }, []);

  // ── Cost limits ───────────────────────────────────────────
  const saveLimits = useCallback(async () => {
    try {
      const vault = await SecureVault.initialize();
      await vault.set('daily_cost_limit', dailyLimit);
      await vault.set('task_cost_limit', taskLimit);
      Alert.alert('Saved', 'Cost limits updated.');
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  }, [dailyLimit, taskLimit]);

  const webTopInset = Platform.OS === 'web' ? 67 : 0;

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
        {(['apis', 'costs', 'security', ...(isDevMode ? ['devtools' as SettingsTab] : []), 'blocked'] as SettingsTab[]).map(t => (
          <Pressable
            key={t}
            testID={`SettingsTab-${t}`}
            onPress={() => {
              setTab(t);
              if (t === 'devtools') loadLogs();
              if (t === 'costs') loadCostData();
            }}
            style={[styles.tab, tab === t && styles.tabActive]}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'apis' ? 'AI Providers' : t === 'costs' ? 'Costs' : t === 'security' ? 'Security' : t === 'devtools' ? 'Dev Tools' : 'Blocked'}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

        {/* ══ TAB: AI Providers ══ */}
        {tab === 'apis' && (
          <>
            {/* Tier gate */}
            {!isApiUnlocked() && (
              <View style={[styles.card, { alignItems: 'center' }]}>
                <Ionicons name="lock-closed" size={32} color={DIM} style={{ marginBottom: 8 }} />
                <Text style={[styles.cardTitle, { textAlign: 'center' }]}>AI Setup — Pro Feature</Text>
                <Text style={[styles.cardSubtitle, { textAlign: 'center' }]}>
                  Upgrade to Pro to connect your own AI providers.
                </Text>
                <Pressable
                  onPress={() => Alert.alert('Coming Soon', 'Subscription will be available on Google Play.')}
                  style={[styles.btn, styles.primaryBtn, { marginTop: 12 }]}
                >
                  <Ionicons name="arrow-up-circle" size={16} color={BG} />
                  <Text style={styles.primaryBtnText}>Upgrade to Pro</Text>
                </Pressable>
              </View>
            )}

            {isApiUnlocked() && (
              <>
                {/* Sub-tab bar */}
                <View style={styles.subTabBar}>
                  {(['providers', 'groups', 'defaults'] as ApisSubTab[]).map(st => (
                    <Pressable
                      key={st}
                      onPress={() => { setProviderDraft(null); setGroupDraft(null); setApisSubTab(st); }}
                      style={[styles.subTab, apisSubTab === st && styles.subTabActive]}
                    >
                      <Text style={[styles.subTabText, apisSubTab === st && styles.subTabTextActive]}>
                        {st === 'providers' ? 'Providers' : st === 'groups' ? 'Groups' : 'Routing'}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {/* ─ Providers sub-tab ─ */}
                {apisSubTab === 'providers' && (
                  <>
                    {/* Provider form */}
                    {providerDraft ? (
                      <View style={styles.card}>
                        <Text style={styles.cardTitle}>{isNewProvider ? 'Add Provider' : 'Edit Provider'}</Text>

                        <Text style={styles.fieldLabel}>Name *</Text>
                        <TextInput
                          value={providerDraft.name}
                          onChangeText={t => setProviderDraft({ ...providerDraft, name: t })}
                          placeholder='e.g. My Cloud API'
                          placeholderTextColor="#444"
                          style={styles.textInput}
                        />

                        <Text style={styles.fieldLabel}>Base URL *</Text>
                        <TextInput
                          value={providerDraft.baseUrl}
                          onChangeText={t => setProviderDraft({ ...providerDraft, baseUrl: t })}
                          placeholder="https://api.example.com/v1"
                          placeholderTextColor="#444"
                          style={styles.textInput}
                          autoCapitalize="none"
                          autoCorrect={false}
                          keyboardType="url"
                        />

                        <Text style={styles.fieldLabel}>Auth Type</Text>
                        <View style={styles.chipRow}>
                          {AUTH_MODES.map(at => (
                            <Pressable
                              key={at}
                              onPress={() => setProviderDraft({ ...providerDraft, authMode: at })}
                              style={[styles.chip, providerDraft.authMode === at && styles.chipActive]}
                            >
                              <Text style={[styles.chipText, providerDraft.authMode === at && styles.chipTextActive]}>{at}</Text>
                            </Pressable>
                          ))}
                        </View>

                        {providerDraft.authMode !== 'none' && (
                          <>
                            <Text style={styles.fieldLabel}>API Key</Text>
                            <TextInput
                              value={providerDraft.apiKey}
                              onChangeText={t => setProviderDraft({ ...providerDraft, apiKey: t })}
                              placeholder="Your API key"
                              placeholderTextColor="#444"
                              style={styles.textInput}
                              autoCapitalize="none"
                              secureTextEntry
                            />
                          </>
                        )}

                        {providerDraft.authMode === 'basic' && (
                          <>
                            <Text style={styles.fieldLabel}>Password</Text>
                            <TextInput
                              value={providerDraft.password}
                              onChangeText={t => setProviderDraft({ ...providerDraft, password: t })}
                              placeholder="Password for basic auth"
                              placeholderTextColor="#444"
                              style={styles.textInput}
                              autoCapitalize="none"
                              secureTextEntry
                            />
                          </>
                        )}

                        <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Capabilities</Text>
                        <View style={styles.chipRow}>
                          {ALL_OPERATIONS.map(op => {
                            const active = providerDraft.capabilities.includes(op);
                            return (
                              <Pressable
                                key={op}
                                onPress={() => {
                                  const caps = active
                                    ? providerDraft.capabilities.filter(c => c !== op)
                                    : [...providerDraft.capabilities, op];
                                  setProviderDraft({ ...providerDraft, capabilities: caps });
                                }}
                                style={[styles.chip, active && styles.chipActive]}
                              >
                                <Text style={[styles.chipText, active && styles.chipTextActive]}>{op}</Text>
                              </Pressable>
                            );
                          })}
                        </View>

                        <View style={styles.btnRow}>
                          <Pressable onPress={saveProvider} style={[styles.btn, styles.primaryBtn]}>
                            <Ionicons name="save-outline" size={16} color={BG} />
                            <Text style={styles.primaryBtnText}>Save</Text>
                          </Pressable>
                          <Pressable onPress={() => setProviderDraft(null)} style={[styles.btn, styles.secondaryBtn]}>
                            <Text style={styles.secondaryBtnText}>Cancel</Text>
                          </Pressable>
                        </View>
                      </View>
                    ) : (
                      <>
                        {/* Provider list */}
                        {providers.length === 0 && (
                          <View style={[styles.card, { alignItems: 'center', paddingVertical: 24 }]}>
                            <Ionicons name="server-outline" size={28} color={DIM} />
                            <Text style={[styles.emptyText, { marginTop: 8 }]}>No providers yet</Text>
                            <Text style={{ color: '#444', fontSize: 12, marginTop: 4, textAlign: 'center' }}>
                              Add a provider to start using AI features.
                            </Text>
                          </View>
                        )}
                        {providers.map(p => (
                          <View key={p.id} style={[styles.card, !p.isActive && { opacity: 0.55 }]}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                                <View style={{
                                  width: 8, height: 8, borderRadius: 4, marginRight: 8,
                                  backgroundColor: p.isActive && p.lastProbeSummary?.probedAt && !p.probeError ? SUCCESS : p.isActive ? ACCENT : DIM,
                                }} />
                                <Text style={styles.apiName} numberOfLines={1}>{p.name}</Text>
                              </View>
                              <View style={{ flexDirection: 'row', gap: 12 }}>
                                <Pressable onPress={() => startEditProvider(p)}>
                                  <Ionicons name="pencil-outline" size={16} color={DIM} />
                                </Pressable>
                                <Pressable onPress={() => deleteProvider(p.id, p.name)}>
                                  <Ionicons name="trash-outline" size={16} color={DANGER} />
                                </Pressable>
                              </View>
                            </View>

                            <Text style={styles.apiUrl} numberOfLines={1}>{p.baseUrl}</Text>

                            {/* Capabilities */}
                            <View style={[styles.chipRow, { marginTop: 6 }]}>
                              {(p.capabilities ?? []).map(c => (
                                <View key={c} style={styles.capBadge}>
                                  <Text style={styles.capBadgeText}>{c}</Text>
                                </View>
                              ))}
                            </View>

                            {/* Probe result */}
                            {p.probeError && (
                              <Text style={{ color: DANGER, fontSize: 11, marginTop: 4 }}>{p.probeError}</Text>
                            )}
                            {p.lastProbeSummary?.probedAt && !p.probeError && (
                              <Text style={{ color: SUCCESS, fontSize: 11, marginTop: 4 }}>
                                Connected · {p.lastProbeSummary?.modelsFound != null ? `${p.accountInfo.modelsCount} models` : 'probed'}
                              </Text>
                            )}

                            {/* Actions */}
                            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                              <Pressable
                                onPress={() => toggleProvider(p.id, !p.isActive)}
                                style={[styles.btn, p.isActive ? styles.secondaryBtn : styles.primaryBtn, { flex: 1, justifyContent: 'center', paddingVertical: 6 }]}
                              >
                                <Ionicons name={p.isActive ? 'pause-circle-outline' : 'play-circle-outline'} size={14} color={p.isActive ? TEXT : BG} />
                                <Text style={[p.isActive ? styles.secondaryBtnText : styles.primaryBtnText, { fontSize: 12 }]}>
                                  {p.isActive ? 'Disable' : 'Enable'}
                                </Text>
                              </Pressable>
                              <Pressable
                                onPress={() => probeProvider(p.id)}
                                disabled={probingId === p.id}
                                style={[styles.btn, styles.secondaryBtn, { flex: 1, justifyContent: 'center', paddingVertical: 6 }]}
                              >
                                {probingId === p.id
                                  ? <ActivityIndicator size="small" color={DIM} />
                                  : <Ionicons name="radio-outline" size={14} color={DIM} />}
                                <Text style={[styles.secondaryBtnText, { fontSize: 12 }]}>
                                  {probingId === p.id ? 'Probing…' : 'Probe'}
                                </Text>
                              </Pressable>
                            </View>
                          </View>
                        ))}

                        {/* Add provider */}
                        <Pressable
                          onPress={() => startNewProvider()}
                          style={[styles.btn, styles.secondaryBtn, { alignSelf: 'stretch', justifyContent: 'center', marginBottom: 12 }]}
                        >
                          <Ionicons name="add-circle-outline" size={16} color={ACCENT} />
                          <Text style={[styles.secondaryBtnText, { color: ACCENT }]}>Add Provider</Text>
                        </Pressable>

                        {/* Quick presets */}
                        <View style={styles.card}>
                          <Text style={styles.cardTitle}>Quick Setup</Text>
                          <Text style={[styles.cardSubtitle, { marginBottom: 8 }]}>
                            Tap to auto-fill a preset. You still need your own API key.
                          </Text>
                          <View style={styles.chipRow}>
                            {PRESETS.map(preset => (
                              <Pressable
                                key={preset.name}
                                onPress={() => startNewProvider(preset)}
                                style={styles.chip}
                              >
                                <Text style={styles.chipText}>{preset.name}</Text>
                              </Pressable>
                            ))}
                          </View>
                        </View>
                      </>
                    )}
                  </>
                )}

                {/* ─ Groups sub-tab ─ */}
                {apisSubTab === 'groups' && (
                  <>
                    {groupDraft ? (
                      <View style={styles.card}>
                        <Text style={styles.cardTitle}>{isNewGroup ? 'Create Group' : 'Edit Group'}</Text>

                        <Text style={styles.fieldLabel}>Group Name *</Text>
                        <TextInput
                          value={groupDraft.name}
                          onChangeText={t => setGroupDraft({ ...groupDraft, name: t })}
                          placeholder='e.g. "Primary Chat", "Image Gen"'
                          placeholderTextColor="#444"
                          style={styles.textInput}
                        />

                        <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Operations</Text>
                        <View style={styles.chipRow}>
                          {ALL_OPERATIONS.map(op => {
                            const active = groupDraft.operations.includes(op);
                            return (
                              <Pressable
                                key={op}
                                onPress={() => {
                                  const ops = active
                                    ? groupDraft.operations.filter(o => o !== op)
                                    : [...groupDraft.operations, op];
                                  setGroupDraft({ ...groupDraft, operations: ops });
                                }}
                                style={[styles.chip, active && styles.chipActive]}
                              >
                                <Text style={[styles.chipText, active && styles.chipTextActive]}>{op}</Text>
                              </Pressable>
                            );
                          })}
                        </View>

                        <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Selection Strategy</Text>
                        <View style={styles.chipRow}>
                          {(Object.keys(STRATEGY_LABELS) as SelectionStrategy[]).map(s => (
                            <Pressable
                              key={s}
                              onPress={() => setGroupDraft({ ...groupDraft, strategy: s })}
                              style={[styles.chip, groupDraft.strategy === s && styles.chipActive]}
                            >
                              <Text style={[styles.chipText, groupDraft.strategy === s && styles.chipTextActive]}>
                                {STRATEGY_LABELS[s]}
                              </Text>
                            </Pressable>
                          ))}
                        </View>

                        <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Members</Text>
                        {groupDraft.members.map((m, idx) => (
                          <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                            <View style={{ flex: 1, backgroundColor: SURFACE, borderRadius: 8, padding: 8 }}>
                              <Text style={{ color: ACCENT, fontSize: 12 }}>{m.modelId}</Text>
                              <Text style={{ color: DIM, fontSize: 11 }}>via {m.providerId}</Text>
                            </View>
                            <Pressable onPress={() => removeMemberFromGroupDraft(idx)}>
                              <Ionicons name="close-circle" size={20} color={DANGER} />
                            </Pressable>
                          </View>
                        ))}

                        <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Add Member</Text>
                        <TextInput
                          value={memberProviderInput}
                          onChangeText={setMemberProviderInput}
                          placeholder="Provider ID (from Providers tab)"
                          placeholderTextColor="#444"
                          style={[styles.textInput, { marginBottom: 6 }]}
                          autoCapitalize="none"
                          autoCorrect={false}
                        />
                        <TextInput
                          value={memberModelInput}
                          onChangeText={setMemberModelInput}
                          placeholder="Model ID (e.g. llama-3.3-70b)"
                          placeholderTextColor="#444"
                          style={[styles.textInput, { marginBottom: 8 }]}
                          autoCapitalize="none"
                          autoCorrect={false}
                        />
                        <Pressable
                          onPress={addMemberToGroupDraft}
                          style={[styles.btn, styles.secondaryBtn, { alignSelf: 'flex-start' }]}
                        >
                          <Ionicons name="add" size={14} color={TEXT} />
                          <Text style={styles.secondaryBtnText}>Add Model</Text>
                        </Pressable>

                        {providers.length > 0 && (
                          <>
                            <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Provider IDs for reference</Text>
                            {providers.map(p => (
                              <Text key={p.id} style={{ color: DIM, fontSize: 11, marginBottom: 2 }}>
                                <Text style={{ color: ACCENT }}>{p.id}</Text> — {p.name}
                              </Text>
                            ))}
                          </>
                        )}

                        <View style={styles.btnRow}>
                          <Pressable onPress={saveGroup} style={[styles.btn, styles.primaryBtn]}>
                            <Ionicons name="save-outline" size={16} color={BG} />
                            <Text style={styles.primaryBtnText}>Save Group</Text>
                          </Pressable>
                          <Pressable onPress={() => setGroupDraft(null)} style={[styles.btn, styles.secondaryBtn]}>
                            <Text style={styles.secondaryBtnText}>Cancel</Text>
                          </Pressable>
                        </View>
                      </View>
                    ) : (
                      <>
                        {groups.length === 0 && (
                          <View style={[styles.card, { alignItems: 'center', paddingVertical: 24 }]}>
                            <Ionicons name="layers-outline" size={28} color={DIM} />
                            <Text style={[styles.emptyText, { marginTop: 8 }]}>No groups yet</Text>
                            <Text style={{ color: '#444', fontSize: 12, marginTop: 4, textAlign: 'center' }}>
                              Groups let you route operations to specific models.
                            </Text>
                          </View>
                        )}
                        {groups.map(g => (
                          <View key={g.id} style={[styles.card, !g.isActive && { opacity: 0.55 }]}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                              <Text style={styles.apiName}>{g.name}</Text>
                              <View style={{ flexDirection: 'row', gap: 12 }}>
                                <Pressable onPress={() => startEditGroup(g)}>
                                  <Ionicons name="pencil-outline" size={16} color={DIM} />
                                </Pressable>
                                <Pressable onPress={() => deleteGroup(g.id, g.name)}>
                                  <Ionicons name="trash-outline" size={16} color={DANGER} />
                                </Pressable>
                              </View>
                            </View>
                            <Text style={{ color: DIM, fontSize: 12, marginTop: 2 }}>
                              {STRATEGY_LABELS[g.selectionStrategy] ?? g.selectionStrategy} · {g.members?.length ?? 0} model{(g.members?.length ?? 0) !== 1 ? 's' : ''}
                            </Text>
                            <View style={[styles.chipRow, { marginTop: 6 }]}>
                              {(g.operations ?? []).map(op => (
                                <View key={op} style={styles.capBadge}>
                                  <Text style={styles.capBadgeText}>{op}</Text>
                                </View>
                              ))}
                            </View>
                            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                              <Pressable
                                onPress={() => toggleGroup(g.id, !g.isActive)}
                                style={[styles.btn, g.isActive ? styles.secondaryBtn : styles.primaryBtn, { paddingVertical: 6, paddingHorizontal: 14 }]}
                              >
                                <Text style={[g.isActive ? styles.secondaryBtnText : styles.primaryBtnText, { fontSize: 12 }]}>
                                  {g.isActive ? 'Disable' : 'Enable'}
                                </Text>
                              </Pressable>
                            </View>
                          </View>
                        ))}
                        <Pressable
                          onPress={startNewGroup}
                          style={[styles.btn, styles.secondaryBtn, { alignSelf: 'stretch', justifyContent: 'center' }]}
                        >
                          <Ionicons name="add-circle-outline" size={16} color={ACCENT} />
                          <Text style={[styles.secondaryBtnText, { color: ACCENT }]}>Create Group</Text>
                        </Pressable>
                      </>
                    )}
                  </>
                )}

                {/* ─ Defaults/Routing sub-tab ─ */}
                {apisSubTab === 'defaults' && (
                  <>
                    <View style={styles.card}>
                      <Text style={styles.cardTitle}>Operation Routing</Text>
                      <Text style={styles.cardSubtitle}>
                        Map each AI operation to a model group. Requests are fail-closed — if no group is set or no model is available, the agent throws an error rather than silently failing.
                      </Text>
                    </View>
                    {ALL_OPERATIONS.map(op => {
                      const currentGroupId = operationMapping[op] ?? null;
                      const currentGroup = groups.find(g => g.id === currentGroupId);
                      return (
                        <View key={op} style={styles.card}>
                          <Text style={[styles.cardTitle, { fontSize: 14 }]}>
                            {op.charAt(0).toUpperCase() + op.slice(1)}
                          </Text>
                          <Text style={{ color: DIM, fontSize: 12, marginBottom: 8 }}>
                            {currentGroup ? `→ ${currentGroup.name}` : 'Not mapped (will fail if called)'}
                          </Text>
                          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} keyboardShouldPersistTaps="handled">
                            <Pressable
                              onPress={() => setOperationGroup(op, null)}
                              style={[styles.chip, !currentGroupId && styles.chipActive]}
                            >
                              <Text style={[styles.chipText, !currentGroupId && styles.chipTextActive]}>None</Text>
                            </Pressable>
                            {groups.filter(g => g.isActive && (g.operations ?? []).includes(op)).map(g => (
                              <Pressable
                                key={g.id}
                                onPress={() => setOperationGroup(op, g.id)}
                                style={[styles.chip, currentGroupId === g.id && styles.chipActive]}
                              >
                                <Text style={[styles.chipText, currentGroupId === g.id && styles.chipTextActive]}>
                                  {g.name}
                                </Text>
                              </Pressable>
                            ))}
                            {groups.filter(g => g.isActive && (g.operations ?? []).includes(op)).length === 0 && (
                              <Text style={{ color: '#444', fontSize: 11, alignSelf: 'center' }}>No eligible groups</Text>
                            )}
                          </ScrollView>
                        </View>
                      );
                    })}
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* ══ TAB: COSTS ══ */}
        {tab === 'costs' && (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Usage Overview</Text>
              <UsageIndicator
                totalCost={totalCost}
                totalCalls={totalCalls}
                modelUsages={modelUsages}
                dailyLimit={parseFloat(dailyLimit) || 0}
              />
            </View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Spending Limits</Text>
              <Text style={styles.cardSubtitle}>
                Set to 0 for no limit. The agent will refuse actions that exceed these limits.
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
              {dailyLimit === '0' && <Text style={styles.noLimitHint}>No daily limit set</Text>}
              <Text style={styles.fieldLabel}>Per-Task Limit (USD)</Text>
              <TextInput
                value={taskLimit}
                onChangeText={setTaskLimit}
                placeholder="0"
                placeholderTextColor="#444"
                style={styles.textInput}
                keyboardType="decimal-pad"
              />
              {taskLimit === '0' && <Text style={styles.noLimitHint}>No per-task limit set</Text>}
              <Pressable onPress={saveLimits} style={[styles.btn, styles.primaryBtn, { marginTop: 12 }]}>
                <Ionicons name="save-outline" size={16} color={BG} />
                <Text style={styles.primaryBtnText}>Save Limits</Text>
              </Pressable>
            </View>
          </>
        )}

        {/* ══ TAB: SECURITY ══ */}
        {tab === 'security' && (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>App Lock</Text>
              <Text style={styles.cardSubtitle}>
                Require biometric authentication after the app has been in the background.
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
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Preferences Backup</Text>
              <Text style={styles.cardSubtitle}>
                Export or import your settings. API keys are excluded from export.
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
                  {backupExporting ? <ActivityIndicator size="small" color={BG} /> : <Ionicons name="share-outline" size={16} color={BG} />}
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
                  {backupImporting ? <ActivityIndicator size="small" color={TEXT} /> : <Ionicons name="download-outline" size={16} color={TEXT} />}
                  <Text style={styles.secondaryBtnText}>{backupImporting ? 'Importing…' : 'Import'}</Text>
                </Pressable>
              </View>
            </View>
          </>
        )}

        {/* ══ TAB: DEV TOOLS ══ */}
        {tab === 'devtools' && (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Dev Tier Override</Text>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                {(['free', 'no_ads', 'pro', 'dev'] as const).map(t => {
                  const current = getAgentCoreInstance()?.getTierService?.()?.getTier?.();
                  const isActive = current === t;
                  return (
                    <Pressable
                      key={t}
                      onPress={() => {
                        const core = getAgentCoreInstance();
                        if (core?.getTierService?.()) {
                          core.getTierService()!.setTier(t);
                          setTierVersion(v => v + 1);
                        }
                      }}
                      style={[styles.btn, isActive ? styles.primaryBtn : styles.secondaryBtn]}
                    >
                      <Text style={isActive ? styles.primaryBtnText : styles.secondaryBtnText}>{t}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <View style={styles.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <Text style={styles.cardTitle}>Log Files</Text>
                <Pressable onPress={loadLogs}>
                  <Ionicons name="refresh" size={16} color={DIM} />
                </Pressable>
              </View>
              {!logsLoaded ? (
                <Text style={styles.emptyText}>Loading logs…</Text>
              ) : logFiles.length === 0 ? (
                <Text style={styles.emptyText}>No log files yet.</Text>
              ) : (
                <ScrollView style={{ maxHeight: 300 }} nestedScrollEnabled>
                  {logFiles.map(file => (
                    <Pressable
                      key={file.path}
                      onPress={async () => {
                        const canShare = await Sharing.isAvailableAsync();
                        if (canShare) await Sharing.shareAsync(file.path, { mimeType: 'text/plain', dialogTitle: file.name });
                        else Alert.alert('Sharing unavailable');
                      }}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: SURFACE3 }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: TEXT, fontSize: 13 }}>{file.name}</Text>
                        <Text style={{ color: DIM, fontSize: 11 }}>{(file.size / 1024).toFixed(1)} KB</Text>
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
                Generates a summary of failures, traces, and key events. Share with diagnostics.
              </Text>
              <Pressable
                style={[styles.btn, styles.primaryBtn, { marginTop: 4 }]}
                onPress={async () => {
                  const ok = await UltraDevLog.generateBugReportFile();
                  if (ok) { await loadLogs(); Alert.alert('Done', 'bug-report.txt created.'); }
                  else Alert.alert('Error', 'Could not write bug-report.txt');
                }}
              >
                <Ionicons name="bug-outline" size={16} color={BG} />
                <Text style={styles.primaryBtnText}>Generate Report</Text>
              </Pressable>
            </View>
          </>
        )}

        {/* ══ TAB: BLOCKED ══ */}
        {tab === 'blocked' && (
          <BlockedAppsTab isNative={Platform.OS === 'android'} />
        )}

        {/* Version tap area */}
        <Pressable onPress={handleVersionTap} style={styles.versionTap}>
          <Text style={styles.versionText}>Agent Ultra{isDevMode ? '  [DEV]' : ''}</Text>
        </Pressable>

      </ScrollView>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: SURFACE3,
  },
  backBtn: { padding: 4, width: 32 },
  headerTitle: { color: TEXT, fontSize: 17, fontFamily: 'Inter_700Bold' },

  tabBar: {
    flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, gap: 8,
    borderBottomWidth: 1, borderBottomColor: '#1a1a1a',
  },
  tab: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, backgroundColor: SURFACE2 },
  tabActive: { backgroundColor: ACCENT },
  tabText: { color: DIM, fontSize: 12, fontFamily: 'Inter_500Medium' },
  tabTextActive: { color: BG, fontFamily: 'Inter_600SemiBold' },

  subTabBar: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  subTab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10, backgroundColor: SURFACE2 },
  subTabActive: { backgroundColor: SURFACE3, borderBottomWidth: 2, borderBottomColor: ACCENT },
  subTabText: { color: DIM, fontSize: 13, fontFamily: 'Inter_500Medium' },
  subTabTextActive: { color: ACCENT, fontFamily: 'Inter_600SemiBold' },

  body: { flex: 1 },
  bodyContent: { padding: 16, paddingBottom: 50 },

  card: {
    backgroundColor: SURFACE2, borderRadius: 14, padding: 16, marginBottom: 14,
    borderWidth: 1, borderColor: '#1e1e1e',
  },
  cardTitle: { color: TEXT, fontSize: 15, fontFamily: 'Inter_600SemiBold', marginBottom: 4 },
  cardSubtitle: { color: DIM, fontSize: 12, fontFamily: 'Inter_400Regular', marginBottom: 12, lineHeight: 17 },

  fieldLabel: { color: DIM, fontSize: 12, fontFamily: 'Inter_500Medium', marginTop: 10, marginBottom: 4 },
  textInput: {
    backgroundColor: SURFACE, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
    color: TEXT, fontSize: 14, fontFamily: 'Inter_400Regular', borderWidth: 1, borderColor: '#222',
  },
  noLimitHint: { color: ACCENT, fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 3, opacity: 0.7 },

  btnRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  primaryBtn: { backgroundColor: ACCENT },
  primaryBtnText: { color: BG, fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  secondaryBtn: { backgroundColor: SURFACE3 },
  secondaryBtnText: { color: TEXT, fontSize: 13, fontFamily: 'Inter_500Medium' },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: SURFACE3 },
  chipActive: { backgroundColor: ACCENT },
  chipText: { color: DIM, fontSize: 12, fontFamily: 'Inter_500Medium' },
  chipTextActive: { color: BG, fontFamily: 'Inter_600SemiBold' },

  capBadge: { paddingHorizontal: 8, paddingVertical: 2, backgroundColor: '#1a1a1a', borderRadius: 4 },
  capBadgeText: { color: '#888', fontSize: 10 },

  apiName: { color: TEXT, fontSize: 14, fontFamily: 'Inter_600SemiBold', flex: 1 },
  apiUrl: { color: DIM, fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 4 },

  emptyText: { color: DIM, fontSize: 13, fontFamily: 'Inter_400Regular' },

  versionTap: { alignItems: 'center', marginTop: 20, paddingVertical: 12 },
  versionText: { color: '#333', fontSize: 11, fontFamily: 'Inter_400Regular' },
});

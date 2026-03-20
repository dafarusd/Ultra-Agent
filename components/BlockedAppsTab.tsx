import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, FlatList, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AppController from '@/src/native/AppController';

const ACCENT = '#34d399';
const BG = '#000000';
const SURFACE = '#111111';
const SURFACE2 = '#1a1a1a';
const DIM = '#666666';
const DANGER = '#ef4444';
const TEXT = '#e0e0e0';

interface BlockedAppsTabProps {
  isNative: boolean;
}

export default function BlockedAppsTab({ isNative }: BlockedAppsTabProps) {
  const [blockedPackages, setBlockedPackages] = useState<string[]>([]);
  const [newPackage, setNewPackage] = useState('');
  const [loading, setLoading] = useState(false);
  const [serviceAvailable, setServiceAvailable] = useState(false);

  const loadBlocked = useCallback(async () => {
    if (!isNative) return;
    setLoading(true);
    try {
      const isEnabled = await AppController.isServiceEnabled();
      setServiceAvailable(isEnabled);
      if (isEnabled) {
        const list = await AppController.getBlockedPackages();
        setBlockedPackages(list);
      }
    } catch (e: any) {
      setBlockedPackages([]);
    } finally {
      setLoading(false);
    }
  }, [isNative]);

  useEffect(() => { loadBlocked(); }, [loadBlocked]);

  const handleBlock = useCallback(async () => {
    const pkg = newPackage.trim().toLowerCase();
    if (!pkg) return;
    if (blockedPackages.includes(pkg)) {
      Alert.alert('Already blocked', `${pkg} is already in the blocklist.`);
      return;
    }
    try {
      await AppController.blockPackage(pkg);
      setBlockedPackages(prev => [...prev, pkg].sort());
      setNewPackage('');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }, [newPackage, blockedPackages]);

  const handleUnblock = useCallback(async (pkg: string) => {
    try {
      await AppController.unblockPackage(pkg);
      setBlockedPackages(prev => prev.filter(p => p !== pkg));
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }, []);

  if (!isNative) {
    return (
      <View style={s.empty}>
        <Text style={s.emptyText}>Blocked apps requires Android device</Text>
      </View>
    );
  }

  if (!serviceAvailable) {
    return (
      <View style={s.empty}>
        <Ionicons name="lock-closed-outline" size={36} color={DIM} />
        <Text style={s.emptyText}>Accessibility service must be enabled to manage blocked apps</Text>
        <Pressable style={s.settingsBtn} onPress={() => AppController.openAccessibilitySettings()}>
          <Text style={s.settingsBtnText}>Open Accessibility Settings</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <Text style={s.sectionTitle}>Blocked Apps</Text>
      <Text style={s.sectionDesc}>Agent Ultra will refuse to interact with these apps, even when asked.</Text>

      <View style={s.inputRow}>
        <TextInput
          style={s.input}
          value={newPackage}
          onChangeText={setNewPackage}
          placeholder="com.example.app"
          placeholderTextColor={DIM}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={handleBlock}
          returnKeyType="done"
        />
        <Pressable style={s.addBtn} onPress={handleBlock}>
          <Ionicons name="add" size={22} color={BG} />
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator color={ACCENT} style={{ marginTop: 24 }} />
      ) : blockedPackages.length === 0 ? (
        <View style={s.empty}>
          <Ionicons name="shield-checkmark-outline" size={32} color={DIM} />
          <Text style={s.emptyText}>No blocked apps — Ultra can interact with all apps</Text>
        </View>
      ) : (
        <FlatList
          data={blockedPackages}
          keyExtractor={item => item}
          style={{ marginTop: 12 }}
          renderItem={({ item }) => (
            <View style={s.row}>
              <Ionicons name="ban-outline" size={18} color={DANGER} style={{ marginRight: 10 }} />
              <Text style={s.rowText} numberOfLines={1}>{item}</Text>
              <Pressable onPress={() => handleUnblock(item)} style={s.removeBtn}>
                <Ionicons name="trash-outline" size={18} color={DIM} />
              </Pressable>
            </View>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG, paddingHorizontal: 16, paddingTop: 16 },
  sectionTitle: { fontSize: 17, fontWeight: '600', color: TEXT, marginBottom: 4 },
  sectionDesc: { fontSize: 13, color: DIM, marginBottom: 16, lineHeight: 18 },
  inputRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  input: {
    flex: 1,
    backgroundColor: SURFACE,
    color: TEXT,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: SURFACE2,
  },
  addBtn: {
    backgroundColor: ACCENT,
    borderRadius: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: SURFACE,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 6,
  },
  rowText: { flex: 1, color: TEXT, fontSize: 13, fontFamily: 'monospace' },
  removeBtn: { padding: 4 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingTop: 48, gap: 12 },
  emptyText: { color: DIM, fontSize: 14, textAlign: 'center', maxWidth: 260 },
  settingsBtn: {
    backgroundColor: ACCENT,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginTop: 8,
  },
  settingsBtnText: { color: BG, fontWeight: '700', fontSize: 14 },
});

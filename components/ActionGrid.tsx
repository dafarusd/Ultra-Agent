import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, ScrollView, TextInput,
  Animated, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GridCategory, GridAction, GridConfig, TaskTemplate } from '@/src/types/actionGrid';
import { DEFAULT_CATEGORIES, DEFAULT_GRID_CONFIG, getGridForMode } from '@/src/data/defaultGrid';

const BG = '#000';
const SURFACE = '#111';
const SURFACE2 = '#1a1a1a';
const ACCENT = '#34d399';
const DIM = '#666';
const TEXT = '#e0e0e0';

interface ActionGridProps {
  collapsed: boolean;
  onToggle: () => void;
  currentMode: string;
  onExecute: (capability: string, params: Record<string, any>) => void;
  onRunTask: (template: TaskTemplate) => void;
  savedTasks: TaskTemplate[];
}

interface InputState {
  actionId: string;
  value: string;
  action: GridAction;
}

export default function ActionGrid({
  collapsed,
  onToggle,
  currentMode,
  onExecute,
  onRunTask,
  savedTasks,
}: ActionGridProps) {
  const [config, setConfig] = useState<GridConfig>(DEFAULT_GRID_CONFIG);
  const [editMode, setEditMode] = useState(false);
  const [inputState, setInputState] = useState<InputState | null>(null);
  const expandAnim = useRef(new Animated.Value(collapsed ? 0 : 1)).current;
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    AsyncStorage.getItem('action_grid_config').then(raw => {
      if (raw) {
        try { setConfig(JSON.parse(raw)); } catch (e: any) { console.warn('[ActionGrid] config parse failed:', e?.message); }
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    Animated.timing(expandAnim, {
      toValue: collapsed ? 0 : 1,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [collapsed, expandAnim]);

  const saveConfig = useCallback(async (newConfig: GridConfig) => {
    setConfig(newConfig);
    await AsyncStorage.setItem('action_grid_config', JSON.stringify(newConfig)).catch(() => {});
  }, []);

  const allCategories = getGridForMode(currentMode, DEFAULT_CATEGORIES.map(c => {
    if (c.id === 'quick') {
      return {
        ...c,
        actions: savedTasks.map(t => ({
          id: `task_${t.id}`,
          label: t.name,
          icon: t.icon || 'flash',
          iconFamily: 'ionicons' as const,
          capability: '__task__',
          params: { templateId: t.id },
        })),
      };
    }
    return c;
  }));

  const orderedCategories = allCategories
    .filter(c => !config.hiddenCategories.includes(c.id))
    .sort((a, b) => {
      const ai = config.categoryOrder.indexOf(a.id);
      const bi = config.categoryOrder.indexOf(b.id);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return 0;
    });

  const allActions = allCategories.flatMap(c => c.actions);
  const favoriteActions = config.favorites
    .map(fid => allActions.find(a => a.id === fid))
    .filter(Boolean) as GridAction[];

  const handleActionPress = useCallback((action: GridAction) => {
    if (action.capability === '__task__') {
      const template = savedTasks.find(t => t.id === action.params.templateId);
      if (template) onRunTask(template);
      return;
    }
    if (action.requiresInput && action.inputKey) {
      setInputState({ actionId: action.id, value: '', action });
      setTimeout(() => inputRef.current?.focus(), 80);
      return;
    }
    onExecute(action.capability, action.params);
  }, [savedTasks, onRunTask, onExecute]);

  const handleInputSubmit = useCallback(() => {
    if (!inputState) return;
    const { action, value } = inputState;
    if (!value.trim()) { setInputState(null); return; }
    const params = { ...action.params, [action.inputKey!]: value.trim() };
    onExecute(action.capability, params);
    setInputState(null);
  }, [inputState, onExecute]);

  const toggleFavorite = useCallback((actionId: string) => {
    const isFav = config.favorites.includes(actionId);
    const newFavs = isFav
      ? config.favorites.filter(f => f !== actionId)
      : [...config.favorites, actionId];
    saveConfig({ ...config, favorites: newFavs });
  }, [config, saveConfig]);

  const toggleHideCategory = useCallback((catId: string) => {
    const isHidden = config.hiddenCategories.includes(catId);
    const newHidden = isHidden
      ? config.hiddenCategories.filter(h => h !== catId)
      : [...config.hiddenCategories, catId];
    saveConfig({ ...config, hiddenCategories: newHidden });
  }, [config, saveConfig]);

  const resetDefaults = useCallback(() => {
    saveConfig(DEFAULT_GRID_CONFIG);
    setEditMode(false);
  }, [saveConfig]);

  const expandedHeight = expandAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 280],
  });

  return (
    <View style={styles.wrapper}>
      {/* ── Collapsed: favorites row ── */}
      <View style={styles.favRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.favContent}
          keyboardShouldPersistTaps="handled"
        >
          {favoriteActions.map(action => (
            <Pressable
              key={action.id}
              onPress={() => handleActionPress(action)}
              style={({ pressed }) => [styles.favBtn, pressed && styles.favBtnPressed]}
            >
              <Ionicons name={action.icon as any} size={20} color={DIM} />
              {inputState?.actionId === action.id && (
                <TextInput
                  ref={inputRef}
                  style={styles.inlineInput}
                  value={inputState.value}
                  onChangeText={v => setInputState(s => s ? { ...s, value: v } : null)}
                  placeholder={action.inputPlaceholder}
                  placeholderTextColor="#444"
                  onSubmitEditing={handleInputSubmit}
                  onBlur={() => setInputState(null)}
                  returnKeyType="go"
                  autoFocus
                />
              )}
            </Pressable>
          ))}
        </ScrollView>
        <Pressable
          onPress={onToggle}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.chevronBtn}
        >
          <Ionicons
            name={collapsed ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={DIM}
          />
        </Pressable>
      </View>

      {/* ── Expanded: full category grid ── */}
      <Animated.View style={[styles.expandedContainer, { maxHeight: expandedHeight }]}>
        <ScrollView
          style={styles.expandedScroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
          <View style={styles.expandedHeader}>
            <Text style={styles.expandedTitle}>Actions</Text>
            <View style={styles.expandedHeaderRight}>
              {editMode && (
                <Pressable onPress={resetDefaults} style={styles.resetBtn}>
                  <Text style={styles.resetText}>Reset</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => setEditMode(e => !e)}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Ionicons name={editMode ? 'checkmark' : 'pencil'} size={16} color={editMode ? ACCENT : DIM} />
              </Pressable>
            </View>
          </View>

          {orderedCategories.map(cat => (
            <View key={cat.id} style={styles.categoryBlock}>
              <View style={styles.categoryHeader}>
                <Ionicons name={cat.icon as any} size={14} color={cat.color} />
                <Text style={[styles.categoryLabel, { color: cat.color }]}>{cat.label}</Text>
                {editMode && (
                  <Pressable
                    onPress={() => toggleHideCategory(cat.id)}
                    style={styles.hideBtn}
                  >
                    <Ionicons name="eye-off-outline" size={14} color={DIM} />
                  </Pressable>
                )}
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.actionsRow}
                keyboardShouldPersistTaps="handled"
              >
                {cat.actions.map(action => (
                  <View key={action.id} style={styles.actionCell}>
                    <Pressable
                      onPress={() => {
                        if (editMode) return;
                        handleActionPress(action);
                      }}
                      style={({ pressed }) => [styles.actionBtn, pressed && !editMode && styles.actionBtnPressed]}
                    >
                      <Ionicons name={action.icon as any} size={22} color={TEXT} />
                      {editMode && (
                        <View style={styles.editOverlay}>
                          <Pressable
                            onPress={() => toggleFavorite(action.id)}
                            style={styles.editStarBtn}
                          >
                            <Ionicons
                              name={config.favorites.includes(action.id) ? 'star' : 'star-outline'}
                              size={11}
                              color={ACCENT}
                            />
                          </Pressable>
                        </View>
                      )}
                    </Pressable>
                    <Text style={styles.actionLabel} numberOfLines={1}>{action.label}</Text>
                    {inputState?.actionId === action.id && (
                      <TextInput
                        ref={inputRef}
                        style={styles.actionInlineInput}
                        value={inputState.value}
                        onChangeText={v => setInputState(s => s ? { ...s, value: v } : null)}
                        placeholder={action.inputPlaceholder}
                        placeholderTextColor="#444"
                        onSubmitEditing={handleInputSubmit}
                        onBlur={() => setInputState(null)}
                        returnKeyType="go"
                        autoFocus
                      />
                    )}
                  </View>
                ))}
                {cat.actions.length === 0 && cat.id === 'quick' && (
                  <Text style={styles.emptyTasksText}>No saved tasks yet. Use "Build a Task" to create one.</Text>
                )}
              </ScrollView>
            </View>
          ))}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { backgroundColor: BG },
  favRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, paddingVertical: 4, minHeight: 48,
  },
  favContent: { flexDirection: 'row', gap: 12, paddingRight: 8 },
  favBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: SURFACE, justifyContent: 'center', alignItems: 'center',
  },
  favBtnPressed: { backgroundColor: SURFACE2 },
  chevronBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  inlineInput: {
    position: 'absolute', left: 40, width: 140, height: 32,
    backgroundColor: SURFACE2, borderRadius: 8, color: TEXT,
    paddingHorizontal: 8, fontSize: 13, borderWidth: 1, borderColor: '#333',
  },
  expandedContainer: { overflow: 'hidden' },
  expandedScroll: { flex: 1 },
  expandedHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 12, paddingTop: 6, paddingBottom: 4,
  },
  expandedTitle: { color: TEXT, fontSize: 13, fontWeight: '600' },
  expandedHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  resetBtn: { paddingHorizontal: 8, paddingVertical: 3, backgroundColor: '#2a0000', borderRadius: 6 },
  resetText: { color: '#ef4444', fontSize: 11 },
  categoryBlock: { marginBottom: 8 },
  categoryHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingBottom: 4,
  },
  categoryLabel: { fontSize: 11, fontWeight: '600', flex: 1 },
  hideBtn: { paddingHorizontal: 4 },
  actionsRow: { paddingHorizontal: 8, gap: 6 },
  actionCell: { alignItems: 'center', width: 54 },
  actionBtn: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: SURFACE, justifyContent: 'center', alignItems: 'center',
  },
  actionBtnPressed: { backgroundColor: SURFACE2 },
  editOverlay: {
    position: 'absolute', top: -4, right: -4,
    backgroundColor: SURFACE2, borderRadius: 10, padding: 2,
  },
  editStarBtn: { padding: 2 },
  actionLabel: { color: DIM, fontSize: 10, marginTop: 3, textAlign: 'center', maxWidth: 54 },
  actionInlineInput: {
    marginTop: 4, width: 120, height: 28,
    backgroundColor: SURFACE2, borderRadius: 6, color: TEXT,
    paddingHorizontal: 6, fontSize: 12, borderWidth: 1, borderColor: '#333',
  },
  emptyTasksText: { color: DIM, fontSize: 11, fontStyle: 'italic', paddingHorizontal: 8, paddingVertical: 12 },
});

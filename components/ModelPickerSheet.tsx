import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  Modal,
  Animated,
  TouchableWithoutFeedback,
  Dimensions,
  Platform,
  ScrollView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { UltraDevLog } from "@/src/utils/UltraDevLog";

const ACCENT = "#34d399";
const BG = "#000000";
const SURFACE = "#111111";
const SURFACE2 = "#1a1a1a";
const SURFACE3 = "#222222";
const DIM = "#666666";
const TEXT = "#e0e0e0";
const SHEET_MAX_HEIGHT = Dimensions.get("window").height * 0.55;

export interface SavedApi {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  password?: string;
}

export interface PickerModel {
  id: string;
  name: string;
  type: "text" | "image" | "code" | "video" | "embedding" | "reasoning";
  apiName: string;
  costIndicator?: string;
  isSelected: boolean;
}

type FilterTab = "all" | "text" | "image" | "code" | "reasoning" | "video";

interface ModelPickerSheetProps {
  visible: boolean;
  models: PickerModel[];
  currentModelId: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
  initialFilter?: FilterTab;
}

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "text", label: "Chat" },
  { key: "image", label: "Image" },
  { key: "code", label: "Code" },
  { key: "reasoning", label: "Reasoning" },
  { key: "video", label: "Video" },
];

export default function ModelPickerSheet({
  visible,
  models,
  currentModelId,
  onSelect,
  onClose,
  initialFilter,
}: ModelPickerSheetProps) {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<FilterTab>("all");
  const fadeAnim = React.useRef(new Animated.Value(0)).current;
  const slideAnim = React.useRef(new Animated.Value(SHEET_MAX_HEIGHT)).current;

  const mountedAtRef = React.useRef(Date.now());
  React.useEffect(() => {
    if (visible) {
      if (initialFilter) setFilter(initialFilter);
      UltraDevLog.pickerOpen(models.length, currentModelId, (slideAnim as any)._value ?? SHEET_MAX_HEIGHT, initialFilter ?? 'all');
      slideAnim.setValue(SHEET_MAX_HEIGHT);
      fadeAnim.setValue(0);
      const currentSlide = (slideAnim as any)._value ?? -1;
      UltraDevLog.pickerAnimate('open', currentSlide, 0, 'spring');
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.spring(slideAnim, { toValue: 0, tension: 65, friction: 11, useNativeDriver: true }),
      ]).start((result) => {
        if (!result.finished) {
          UltraDevLog.error('ModelPickerSheet', 'Open animation did not finish', `started=${currentSlide} visible=${visible}`);
        }
      });
    } else {
      const currentSlide = (slideAnim as any)._value ?? -1;
      UltraDevLog.pickerAnimate('close', currentSlide, SHEET_MAX_HEIGHT, 'timing', mountedAtRef.current);
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 0, duration: 150, useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: SHEET_MAX_HEIGHT, duration: 150, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  const filteredRaw = filter === "all"
    ? models
    : models.filter((m) => m.type === filter);
  const filtered = [...filteredRaw].sort((a, b) => {
    const aActive = a.id === currentModelId ? 1 : 0;
    const bActive = b.id === currentModelId ? 1 : 0;
    return bActive - aActive;
  });

  const renderModel = useCallback(
    ({ item, index }: { item: PickerModel; index: number }) => {
      if (index === 0) UltraDevLog.pickerContentRender(filtered.length, models.length, filter, currentModelId);
      const isActive = item.id === currentModelId;
      return (
        <Pressable
          onPress={() => { onSelect(item.id); onClose(); }}
          style={({ pressed }) => [
            styles.modelRow,
            isActive && styles.modelRowActive,
            pressed && styles.modelRowPressed,
          ]}
        >
          <View style={styles.modelInfo}>
            <Text style={[styles.modelName, isActive && styles.modelNameActive]} numberOfLines={1}>
              {item.name}
            </Text>
            <View style={styles.modelBadges}>
              <View style={styles.typeBadge}>
                <Text style={styles.typeBadgeText}>{item.type}</Text>
              </View>
              <Text style={styles.apiLabel}>{item.apiName}</Text>
              {item.costIndicator && item.costIndicator !== "Free" && (
                <View style={styles.costBadge}>
                  <Text style={styles.costBadgeText}>{item.costIndicator}</Text>
                </View>
              )}
            </View>
          </View>
          <View style={[styles.radioOuter, isActive && styles.radioOuterActive]}>
            {isActive && <View style={styles.radioInner} />}
          </View>
        </Pressable>
      );
    },
    [currentModelId, onSelect, onClose]
  );

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root} testID="ModelPickerSheet">
        <TouchableWithoutFeedback onPress={onClose}>
          <Animated.View style={[styles.backdrop, { opacity: fadeAnim }]} />
        </TouchableWithoutFeedback>

        <Animated.View
          style={[
            styles.sheet,
            {
              transform: [{ translateY: slideAnim }],
              paddingBottom: Math.max(insets.bottom, 16),
              maxHeight: SHEET_MAX_HEIGHT,
              height: SHEET_MAX_HEIGHT,
            },
          ]}
        >
          <View style={styles.handleBar}>
            <View style={styles.handle} />
          </View>

          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Models</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={20} color={DIM} />
            </Pressable>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterRow} contentContainerStyle={{ gap: 6, paddingHorizontal: 16, paddingBottom: 10 }}>
            {FILTER_TABS.map((tab) => {
              const isActive = filter === tab.key;
              return (
                <Pressable
                  key={tab.key}
                  onPress={() => setFilter(tab.key)}
                  style={[styles.filterTab, isActive && styles.filterTabActive]}
                >
                  <Text style={[styles.filterTabText, isActive && styles.filterTabTextActive]}>
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <FlatList
            data={filtered}
            renderItem={renderModel}
            keyExtractor={(item) => item.id}
            style={styles.list}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyText}>No models for this category</Text>
              </View>
            }
          />
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  sheet: {
    backgroundColor: SURFACE,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: "hidden",
  },
  handleBar: { alignItems: "center", paddingTop: 10, paddingBottom: 4 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: SURFACE3 },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  sheetTitle: {
    color: TEXT,
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  filterRow: {
    flexDirection: "row",
    paddingBottom: 0,
  },
  filterTab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: SURFACE2,
  },
  filterTabActive: {
    backgroundColor: ACCENT,
  },
  filterTabText: {
    color: DIM,
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  filterTabTextActive: {
    color: BG,
    fontFamily: "Inter_600SemiBold",
  },
  list: { flex: 1, paddingHorizontal: 12 },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginBottom: 2,
  },
  modelRowActive: {
    backgroundColor: "rgba(74, 222, 128, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(74, 222, 128, 0.25)",
  },
  modelRowPressed: { opacity: 0.7 },
  modelInfo: { flex: 1, marginRight: 12 },
  modelName: {
    color: TEXT,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    marginBottom: 4,
  },
  modelNameActive: { color: ACCENT },
  modelBadges: { flexDirection: "row", alignItems: "center", gap: 6 },
  typeBadge: {
    backgroundColor: SURFACE3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  typeBadgeText: {
    color: DIM,
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    textTransform: "capitalize",
  },
  apiLabel: {
    color: "#555",
    fontSize: 10,
    fontFamily: "Inter_400Regular",
  },
  costBadge: {
    backgroundColor: "#332200",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  costBadgeText: {
    color: "#ffaa44",
    fontSize: 9,
    fontFamily: "Inter_500Medium",
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#333",
    justifyContent: "center",
    alignItems: "center",
  },
  radioOuterActive: { borderColor: ACCENT },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: ACCENT,
  },
  emptyState: { paddingVertical: 30, alignItems: "center" },
  emptyText: { color: DIM, fontSize: 13, fontFamily: "Inter_400Regular" },
});

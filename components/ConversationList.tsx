import React, { useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  Modal,
  Alert,
  Platform,
  Animated,
  Dimensions,
  TouchableWithoutFeedback,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConversationMeta } from "@/src/types/ultra";

const ACCENT = "#00ff88";
const BG = "#000000";
const SURFACE = "#0e0e0e";
const SURFACE2 = "#1a1a1a";
const DIM = "#555555";
const DRAWER_WIDTH = Dimensions.get("window").width * 0.78;

interface ConversationListProps {
  visible: boolean;
  conversations: ConversationMeta[];
  currentConversationId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNewChat: () => void;
  onClose: () => void;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - ts;
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}

function ConversationItem({
  item,
  isCurrent,
  onSelect,
  onDelete,
}: {
  item: ConversationMeta;
  isCurrent: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const handleLongPress = useCallback(() => {
    if (Platform.OS === "web") {
      const confirmed = window.confirm(`Delete "${item.title}"?`);
      if (confirmed) onDelete(item.id);
    } else {
      Alert.alert("Delete Conversation", `Delete "${item.title}"?`, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => onDelete(item.id) },
      ]);
    }
  }, [item.id, item.title, onDelete]);

  const preview = item.preview
    ? item.preview.length > 55
      ? item.preview.slice(0, 55) + "…"
      : item.preview
    : "No messages yet";

  return (
    <Pressable
      onPress={() => onSelect(item.id)}
      onLongPress={handleLongPress}
      style={({ pressed }) => [
        styles.convItem,
        isCurrent && styles.convItemCurrent,
        pressed && styles.convItemPressed,
      ]}
      testID={`conversation-item-${item.id}`}
    >
      {isCurrent && <View style={styles.activeBar} />}
      <View style={styles.convItemContent}>
        <View style={styles.convItemTop}>
          <Text style={[styles.convTitle, isCurrent && styles.convTitleActive]} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.convDate}>{formatDate(item.updatedAt)}</Text>
        </View>
        <Text style={styles.convPreview} numberOfLines={1}>
          {preview}
        </Text>
      </View>
    </Pressable>
  );
}

export default function ConversationList({
  visible,
  conversations,
  currentConversationId,
  onSelect,
  onDelete,
  onNewChat,
  onClose,
}: ConversationListProps) {
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          tension: 65,
          friction: 11,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: -DRAWER_WIDTH,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, slideAnim, fadeAnim]);

  const renderItem = useCallback(
    ({ item }: { item: ConversationMeta }) => (
      <ConversationItem
        item={item}
        isCurrent={item.id === currentConversationId}
        onSelect={onSelect}
        onDelete={onDelete}
      />
    ),
    [currentConversationId, onSelect, onDelete]
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <TouchableWithoutFeedback onPress={onClose}>
          <Animated.View style={[styles.backdrop, { opacity: fadeAnim }]} />
        </TouchableWithoutFeedback>

        <Animated.View
          style={[
            styles.drawer,
            {
              transform: [{ translateX: slideAnim }],
              paddingTop: insets.top + webTopInset,
              paddingBottom: Math.max(insets.bottom, webBottomInset),
            },
          ]}
        >
          <View style={styles.drawerHeader}>
            <View style={styles.drawerLogoRow}>
              <View style={styles.drawerLogo}>
                <Text style={styles.drawerLogoText}>U</Text>
              </View>
              <Text style={styles.drawerBrand}>Agent Ultra</Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn} testID="close-conversation-list">
              <Ionicons name="close" size={20} color={DIM} />
            </Pressable>
          </View>

          <Pressable
            onPress={onNewChat}
            style={({ pressed }) => [
              styles.newChatBtn,
              pressed && styles.newChatBtnPressed,
            ]}
            testID="new-chat-button"
          >
            <Ionicons name="add" size={18} color="#000000" />
            <Text style={styles.newChatText}>New Chat</Text>
          </Pressable>

          {conversations.length > 0 && (
            <Text style={styles.listLabel}>
              {conversations.length} {conversations.length === 1 ? "conversation" : "conversations"}
            </Text>
          )}

          <FlatList
            data={conversations}
            renderItem={renderItem}
            keyExtractor={(item) => item.id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            scrollEnabled={!!conversations.length}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Ionicons name="chatbubbles-outline" size={32} color="#222" />
                <Text style={styles.emptyText}>No conversations yet</Text>
              </View>
            }
            testID="conversation-list"
          />
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    flexDirection: "row",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.65)",
  },
  drawer: {
    width: DRAWER_WIDTH,
    backgroundColor: SURFACE,
    borderRightWidth: 1,
    borderRightColor: "#1a1a1a",
    paddingHorizontal: 0,
  },
  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#151515",
  },
  drawerLogoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  drawerLogo: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: ACCENT,
    alignItems: "center",
    justifyContent: "center",
  },
  drawerLogoText: {
    color: "#000",
    fontSize: 14,
    fontWeight: "700" as const,
  },
  drawerBrand: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700" as const,
  },
  closeBtn: {
    padding: 4,
  },
  newChatBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: ACCENT,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 16,
    marginHorizontal: 12,
    marginVertical: 12,
  },
  newChatBtnPressed: {
    opacity: 0.8,
  },
  newChatText: {
    color: "#000000",
    fontSize: 14,
    fontWeight: "600" as const,
  },
  listLabel: {
    color: DIM,
    fontSize: 10,
    fontWeight: "600" as const,
    letterSpacing: 1,
    textTransform: "uppercase",
    paddingHorizontal: 16,
    paddingBottom: 6,
    marginTop: 4,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 8,
    paddingBottom: 16,
  },
  convItem: {
    flexDirection: "row",
    alignItems: "stretch",
    borderRadius: 8,
    marginBottom: 2,
    overflow: "hidden",
  },
  convItemCurrent: {
    backgroundColor: "#161616",
  },
  convItemPressed: {
    opacity: 0.7,
  },
  activeBar: {
    width: 3,
    backgroundColor: ACCENT,
    borderRadius: 2,
  },
  convItemContent: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 3,
  },
  convItemTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  convTitle: {
    color: "#aaaaaa",
    fontSize: 13,
    fontWeight: "500" as const,
    flex: 1,
    marginRight: 6,
  },
  convTitleActive: {
    color: "#ffffff",
    fontWeight: "600" as const,
  },
  convDate: {
    color: DIM,
    fontSize: 10,
  },
  convPreview: {
    color: "#555555",
    fontSize: 12,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 50,
    gap: 10,
  },
  emptyText: {
    color: DIM,
    fontSize: 13,
  },
});

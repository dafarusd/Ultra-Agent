import React, { useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  Modal,
  Alert,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConversationMeta } from "@/src/types/ultra";

const ACCENT = "#00ff88";
const BG_OVERLAY = "#000000cc";
const SURFACE = "#111111";
const SURFACE2 = "#1a1a1a";
const DIM = "#666666";

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
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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
    ? item.preview.length > 60
      ? item.preview.slice(0, 60) + "..."
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
      <View style={styles.convItemContent}>
        <View style={styles.convItemTop}>
          <Text style={styles.convTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.convDate}>{formatDate(item.updatedAt)}</Text>
        </View>
        <Text style={styles.convPreview} numberOfLines={1}>
          {preview}
        </Text>
        <Text style={styles.convMsgCount}>
          {item.messageCount} {item.messageCount === 1 ? "message" : "messages"}
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
  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;

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
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View
          style={[
            styles.surface,
            {
              paddingTop: insets.top + webTopInset + 16,
              paddingBottom: Math.max(insets.bottom, webBottomInset) + 16,
            },
          ]}
        >
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Conversations</Text>
            <Pressable onPress={onClose} testID="close-conversation-list">
              <Ionicons name="close" size={24} color="#ffffff" />
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
            <Ionicons name="add" size={20} color="#000000" />
            <Text style={styles.newChatText}>New Chat</Text>
          </Pressable>

          <FlatList
            data={conversations}
            renderItem={renderItem}
            keyExtractor={(item) => item.id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            scrollEnabled={conversations.length > 0}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Ionicons name="chatbubbles-outline" size={36} color={SURFACE2} />
                <Text style={styles.emptyText}>No conversations yet</Text>
              </View>
            }
            testID="conversation-list"
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: BG_OVERLAY,
  },
  surface: {
    flex: 1,
    backgroundColor: SURFACE,
    marginTop: 40,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  headerTitle: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "700" as const,
  },
  newChatBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: ACCENT,
    borderRadius: 12,
    paddingVertical: 12,
    marginBottom: 16,
  },
  newChatBtnPressed: {
    opacity: 0.8,
  },
  newChatText: {
    color: "#000000",
    fontSize: 15,
    fontWeight: "600" as const,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 16,
  },
  convItem: {
    backgroundColor: SURFACE2,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#222222",
  },
  convItemCurrent: {
    borderColor: ACCENT,
    borderWidth: 2,
  },
  convItemPressed: {
    opacity: 0.7,
  },
  convItemContent: {
    gap: 4,
  },
  convItemTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  convTitle: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "600" as const,
    flex: 1,
    marginRight: 8,
  },
  convDate: {
    color: DIM,
    fontSize: 11,
  },
  convPreview: {
    color: "#999999",
    fontSize: 13,
  },
  convMsgCount: {
    color: DIM,
    fontSize: 11,
    marginTop: 2,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    gap: 12,
  },
  emptyText: {
    color: DIM,
    fontSize: 14,
  },
});

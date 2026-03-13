import React, { useCallback, useRef, useEffect, useState } from "react";
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
  Alert,
  Platform,
  TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import type { ConversationMeta } from "@/src/types/ultra";

const ACCENT = "#4ade80";
const BG = "#000000";
const SURFACE = "#0a0a0a";
const SURFACE2 = "#141414";
const SURFACE3 = "#1e1e1e";
const DIM = "#555555";
const TEXT = "#e0e0e0";
const TEXT_DIM = "#888888";
const DRAWER_WIDTH = Dimensions.get("window").width * 0.80;

// ── Types ──────────────────────────────────────────────
interface Folder {
  id: string;
  name: string;
  isSystem: boolean; // "Logs" is system, user folders are not
}

interface ConversationListProps {
  visible: boolean;
  conversations: ConversationMeta[];
  currentConversationId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNewChat: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenLogs: () => void;
}

// ── Helpers ────────────────────────────────────────────
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

// ── Conversation Item ──────────────────────────────────
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
    ? item.preview.length > 50 ? item.preview.slice(0, 50) + "…" : item.preview
    : "No messages yet";

  return (
    <Pressable
      onPress={() => onSelect(item.id)}
      onLongPress={handleLongPress}
      style={({ pressed }) => [
        styles.convItem,
        isCurrent && styles.convItemActive,
        pressed && styles.convItemPressed,
      ]}
    >
      <Ionicons
        name="chatbubble-outline"
        size={16}
        color={isCurrent ? ACCENT : "#333"}
        style={styles.convIcon}
      />
      <View style={styles.convContent}>
        <Text style={[styles.convTitle, isCurrent && styles.convTitleActive]} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.convPreview} numberOfLines={1}>{preview}</Text>
      </View>
      <Text style={styles.convDate}>{formatDate(item.updatedAt)}</Text>
    </Pressable>
  );
}

// ── Main Component ─────────────────────────────────────
export default function ConversationList({
  visible,
  conversations,
  currentConversationId,
  onSelect,
  onDelete,
  onNewChat,
  onClose,
  onOpenSettings,
  onOpenLogs,
}: ConversationListProps) {
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;

  // Folder state (UI-only for now — persistence comes later)
  const [folders, setFolders] = useState<Folder[]>([
    { id: "folder_logs", name: "Logs", isSystem: true },
  ]);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideAnim, { toValue: 0, tension: 65, friction: 11, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, { toValue: -DRAWER_WIDTH, duration: 200, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  const handleCreateFolder = useCallback(() => {
    const name = newFolderName.trim();
    if (!name) return;
    const id = `folder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setFolders((prev) => [...prev, { id, name, isSystem: false }]);
    setNewFolderName("");
    setShowNewFolder(false);
    // TODO: Persist folders to storage
  }, [newFolderName]);

  const handleFolderTap = useCallback((folder: Folder) => {
    if (folder.id === "folder_logs") {
      onClose();
      onOpenLogs();
    }
    // TODO: Open folder contents for user-created folders
  }, [onClose, onOpenLogs]);

  const renderConversation = useCallback(
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
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
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
          {/* ── Header ─────────────────────────────────── */}
          <View style={styles.drawerHeader}>
            <View style={styles.drawerLogoRow}>
              <View style={styles.drawerLogo}>
                <MaterialCommunityIcons name="robot" size={18} color={ACCENT} />
              </View>
              <Text style={styles.drawerBrand}>Agent Ultra</Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color={DIM} />
            </Pressable>
          </View>

          {/* ── New Chat (plain row, no green bg) ──────── */}
          <Pressable
            onPress={() => { onNewChat(); onClose(); }}
            style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
          >
            <Ionicons name="add-outline" size={20} color={TEXT} />
            <Text style={styles.menuRowText}>New Chat</Text>
          </Pressable>

          {/* ── Settings (gear moved here) ─────────────── */}
          <Pressable
            onPress={() => { onClose(); onOpenSettings(); }}
            style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
          >
            <Ionicons name="settings-outline" size={20} color={TEXT} />
            <Text style={styles.menuRowText}>Settings</Text>
          </Pressable>

          {/* ── Divider ─────────────────────────────────── */}
          <View style={styles.divider} />

          {/* ── FOLDERS section ─────────────────────────── */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>FOLDERS</Text>
            <Pressable
              onPress={() => setShowNewFolder(true)}
              hitSlop={12}
              style={styles.sectionAction}
            >
              <Ionicons name="add" size={18} color={DIM} />
            </Pressable>
          </View>

          {folders.map((folder) => (
            <Pressable
              key={folder.id}
              onPress={() => handleFolderTap(folder)}
              style={({ pressed }) => [styles.folderRow, pressed && styles.menuRowPressed]}
            >
              <Ionicons
                name={folder.id === "folder_logs" ? "document-text-outline" : "folder-outline"}
                size={18}
                color={folder.id === "folder_logs" ? "#f59e0b" : TEXT_DIM}
              />
              <Text style={styles.folderName}>{folder.name}</Text>
              {folder.isSystem && (
                <View style={styles.systemBadge}>
                  <Text style={styles.systemBadgeText}>Dev</Text>
                </View>
              )}
            </Pressable>
          ))}

          {/* New folder inline input */}
          {showNewFolder && (
            <View style={styles.newFolderRow}>
              <TextInput
                value={newFolderName}
                onChangeText={setNewFolderName}
                placeholder="Folder name..."
                placeholderTextColor="#444"
                style={styles.newFolderInput}
                autoFocus
                onSubmitEditing={handleCreateFolder}
                returnKeyType="done"
              />
              <Pressable onPress={handleCreateFolder} style={styles.newFolderSave}>
                <Ionicons name="checkmark" size={16} color={ACCENT} />
              </Pressable>
              <Pressable onPress={() => { setShowNewFolder(false); setNewFolderName(""); }} style={styles.newFolderCancel}>
                <Ionicons name="close" size={16} color={DIM} />
              </Pressable>
            </View>
          )}

          {/* ── Divider ─────────────────────────────────── */}
          <View style={styles.divider} />

          {/* ── CHATS section ──────────────────────────── */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>CHATS</Text>
            {conversations.length > 0 && (
              <Text style={styles.sectionCount}>{conversations.length}</Text>
            )}
          </View>

          <FlatList
            data={conversations}
            renderItem={renderConversation}
            keyExtractor={(item) => item.id}
            style={styles.chatList}
            contentContainerStyle={styles.chatListContent}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyText}>Start your first conversation</Text>
              </View>
            }
          />
        </Animated.View>
      </View>
    </Modal>
  );
}

// ── Styles ─────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  drawer: {
    width: DRAWER_WIDTH,
    backgroundColor: SURFACE,
    borderRightWidth: 1,
    borderRightColor: "#1a1a1a",
  },

  // Header
  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  drawerLogoRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  drawerLogo: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: SURFACE3,
    justifyContent: "center",
    alignItems: "center",
  },
  drawerBrand: {
    color: TEXT,
    fontSize: 16,
    fontFamily: "Inter_700Bold",
  },
  closeBtn: { padding: 4 },

  // Menu rows (New Chat, Settings)
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginHorizontal: 8,
    borderRadius: 8,
  },
  menuRowPressed: { backgroundColor: SURFACE2 },
  menuRowText: {
    color: TEXT,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },

  // Divider
  divider: {
    height: 1,
    backgroundColor: "#1a1a1a",
    marginHorizontal: 16,
    marginVertical: 8,
  },

  // Section headers
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  sectionLabel: {
    color: DIM,
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  sectionCount: {
    color: "#444",
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  sectionAction: { padding: 2 },

  // Folder rows
  folderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 20,
    marginHorizontal: 8,
    borderRadius: 8,
  },
  folderName: {
    color: TEXT_DIM,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    flex: 1,
  },
  systemBadge: {
    backgroundColor: "#332200",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  systemBadgeText: {
    color: "#f59e0b",
    fontSize: 9,
    fontFamily: "Inter_500Medium",
  },

  // New folder input
  newFolderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 20,
    marginHorizontal: 8,
    paddingVertical: 6,
  },
  newFolderInput: {
    flex: 1,
    backgroundColor: SURFACE2,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: TEXT,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    borderWidth: 1,
    borderColor: "#2a2a2a",
  },
  newFolderSave: { padding: 4 },
  newFolderCancel: { padding: 4 },

  // Chat list
  chatList: { flex: 1 },
  chatListContent: { paddingHorizontal: 4, paddingBottom: 16 },
  convItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginHorizontal: 4,
    borderRadius: 8,
    gap: 10,
  },
  convItemActive: {
    backgroundColor: "rgba(74, 222, 128, 0.06)",
  },
  convItemPressed: {
    backgroundColor: SURFACE2,
  },
  convIcon: { marginTop: 1 },
  convContent: { flex: 1 },
  convTitle: {
    color: TEXT_DIM,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    marginBottom: 2,
  },
  convTitleActive: { color: ACCENT },
  convPreview: {
    color: "#444",
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  convDate: {
    color: "#3a3a3a",
    fontSize: 10,
    fontFamily: "Inter_400Regular",
  },

  // Empty
  emptyState: {
    paddingVertical: 30,
    alignItems: "center",
  },
  emptyText: {
    color: DIM,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
});

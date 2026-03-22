import React from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Modal,
  Animated,
  TouchableWithoutFeedback,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";

const ACCENT = "#34d399";
const BG = "#000000";
const SURFACE = "#111111";
const SURFACE2 = "#1a1a1a";
const SURFACE3 = "#222222";
const DIM = "#666666";
const TEXT = "#e0e0e0";

export type ActionType = "chat" | "image" | "code" | "reasoning" | "video";

interface ActionOption {
  type: ActionType;
  label: string;
  icon: string;
  iconFamily: "ionicons" | "material";
  color: string;
  description: string;
}

const ACTION_OPTIONS: ActionOption[] = [
  {
    type: "chat",
    label: "Chat",
    icon: "chatbubble-ellipses-outline",
    iconFamily: "ionicons",
    color: "#34d399",
    description: "Conversation with your default chat model",
  },
  {
    type: "image",
    label: "Image",
    icon: "image-outline",
    iconFamily: "ionicons",
    color: "#f472b6",
    description: "Generate images with your default image model",
  },
  {
    type: "code",
    label: "Code",
    icon: "code-braces",
    iconFamily: "material",
    color: "#60a5fa",
    description: "Code generation and debugging",
  },
  {
    type: "reasoning",
    label: "Reasoning",
    icon: "brain",
    iconFamily: "material",
    color: "#c084fc",
    description: "Complex reasoning and analysis",
  },
  {
    type: "video",
    label: "Video",
    icon: "videocam-outline",
    iconFamily: "ionicons",
    color: "#fb923c",
    description: "Video generation with your default video model",
  },
];

interface PlusMenuProps {
  visible: boolean;
  currentType: ActionType;
  onSelect: (type: ActionType) => void;
  onClose: () => void;
}

export default function PlusMenu({
  visible,
  currentType,
  onSelect,
  onClose,
}: PlusMenuProps) {
  const insets = useSafeAreaInsets();
  const fadeAnim = React.useRef(new Animated.Value(0)).current;
  const slideAnim = React.useRef(new Animated.Value(300)).current;

  React.useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.spring(slideAnim, { toValue: 0, tension: 65, friction: 11, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: 300, duration: 120, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root} testID="PlusMenu">
        <TouchableWithoutFeedback onPress={onClose}>
          <Animated.View style={[styles.backdrop, { opacity: fadeAnim }]} />
        </TouchableWithoutFeedback>

        <Animated.View
          style={[
            styles.sheet,
            {
              transform: [{ translateY: slideAnim }],
              paddingBottom: Math.max(insets.bottom, 16),
            },
          ]}
        >
          <View style={styles.handleBar}>
            <View style={styles.handle} />
          </View>

          <Text style={styles.sheetTitle}>Choose mode</Text>

          <View style={styles.optionsGrid}>
            {ACTION_OPTIONS.map((opt) => {
              const isActive = currentType === opt.type;
              return (
                <Pressable
                  key={opt.type}
                  onPress={() => onSelect(opt.type)}
                  style={({ pressed }) => [
                    styles.optionCard,
                    isActive && { borderColor: opt.color, backgroundColor: `${opt.color}10` },
                    pressed && styles.optionCardPressed,
                  ]}
                >
                  <View style={[styles.optionIconWrap, { backgroundColor: `${opt.color}18` }]}>
                    {opt.iconFamily === "material" ? (
                      <MaterialCommunityIcons name={opt.icon as any} size={22} color={opt.color} />
                    ) : (
                      <Ionicons name={opt.icon as any} size={22} color={opt.color} />
                    )}
                  </View>
                  <Text style={[styles.optionLabel, isActive && { color: opt.color }]}>
                    {opt.label}
                  </Text>
                  <Text style={styles.optionDesc} numberOfLines={2}>
                    {opt.description}
                  </Text>
                  {isActive && (
                    <View style={[styles.activeDot, { backgroundColor: opt.color }]} />
                  )}
                </Pressable>
              );
            })}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    backgroundColor: SURFACE,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 4,
    paddingHorizontal: 16,
  },
  handleBar: { alignItems: "center", paddingTop: 10, paddingBottom: 8 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: SURFACE3 },
  sheetTitle: {
    color: TEXT,
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 14,
    paddingHorizontal: 4,
  },
  optionsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    paddingBottom: 8,
  },
  optionCard: {
    width: "47%",
    flexGrow: 1,
    backgroundColor: SURFACE2,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "transparent",
    position: "relative",
  },
  optionCardPressed: { opacity: 0.7 },
  optionIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },
  optionLabel: {
    color: TEXT,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 3,
  },
  optionDesc: {
    color: DIM,
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    lineHeight: 15,
  },
  activeDot: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});

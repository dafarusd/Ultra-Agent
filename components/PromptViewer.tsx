import { Modal, View, Text, ScrollView, Pressable, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { PromptTrace, MessageRole } from '@/src/types/ultra';

interface PromptViewerProps {
  visible: boolean;
  trace: PromptTrace | null;
  onClose: () => void;
}

const ROLE_COLORS: Record<MessageRole, string> = {
  system: '#ff6b6b',
  user: '#00ff88',
  assistant: '#6bc5ff',
  tool: '#ffd166',
};

function RoleLabel({ role }: { role: string }) {
  const color = ROLE_COLORS[role as MessageRole] ?? '#aaa';
  return (
    <View style={[styles.roleTag, { borderColor: color }]}>
      <Text style={[styles.roleText, { color }]}>{role.toUpperCase()}</Text>
    </View>
  );
}

export default function PromptViewer({ visible, trace, onClose }: PromptViewerProps) {
  if (!trace) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent>
      <View style={styles.overlay}>
        <View style={styles.surface}>
          <View style={styles.header}>
            <Text style={styles.title}>Prompt Trace</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={24} color="#fff" />
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <View style={styles.section}>
              <Text style={styles.label}>Model</Text>
              <Text style={styles.mono}>{trace.model}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.section}>
              <Text style={styles.label}>System Prompt</Text>
              <Text style={styles.mono}>{trace.systemPrompt}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.section}>
              <Text style={styles.label}>Framed User Message</Text>
              <Text style={styles.mono}>{trace.framedUserMessage}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.section}>
              <Text style={styles.label}>Included Messages ({trace.includedMessages.length})</Text>
              {trace.includedMessages.map((msg, i) => (
                <View key={i} style={styles.messageBlock}>
                  <RoleLabel role={msg.role} />
                  <Text style={styles.messageContent}>{msg.content}</Text>
                </View>
              ))}
            </View>

            <View style={styles.section}>
              <Text style={styles.timestamp}>
                {new Date(trace.createdAt).toLocaleString()}
              </Text>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: '#000000cc',
    justifyContent: 'flex-end',
  },
  surface: {
    backgroundColor: '#111',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '90%',
    paddingBottom: Platform.OS === 'web' ? 34 : 0,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  title: {
    color: '#00ff88',
    fontSize: 18,
    fontWeight: '700' as const,
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 16,
  },
  label: {
    color: '#00ff88',
    fontSize: 13,
    fontWeight: '600' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  mono: {
    color: '#ddd',
    fontSize: 13,
    lineHeight: 20,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#333',
    marginBottom: 16,
  },
  messageBlock: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  roleTag: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginBottom: 6,
  },
  roleText: {
    fontSize: 10,
    fontWeight: '700' as const,
    letterSpacing: 1,
  },
  messageContent: {
    color: '#ccc',
    fontSize: 13,
    lineHeight: 19,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  timestamp: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center' as const,
  },
});

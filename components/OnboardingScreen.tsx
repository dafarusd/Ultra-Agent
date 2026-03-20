import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Platform, ScrollView, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AppController from '@/src/native/AppController';

const ACCENT = '#34d399';
const BG = '#000000';
const SURFACE = '#111111';
const SURFACE2 = '#1a1a1a';
const DIM = '#666666';
const TEXT = '#e0e0e0';

interface Step {
  icon: string;
  title: string;
  desc: string;
}

const STEPS: Step[] = [
  {
    icon: 'flash',
    title: 'Welcome to Agent Ultra',
    desc: 'An autonomous AI agent that lives on your Android device. It can open apps, send messages, control settings, take screenshots, and more — all from a single conversation.',
  },
  {
    icon: 'key',
    title: 'Venice API Key',
    desc: 'Agent Ultra uses the Venice AI API to think and plan. Add your API key in Settings → APIs after setup. You can get a free key at venice.ai.',
  },
  {
    icon: 'shield-checkmark',
    title: 'Allow Restricted Settings',
    desc: 'Android blocks accessibility for sideloaded apps. First: Settings → Apps → Agent Ultra → tap ⋮ menu (top right) → "Allow restricted settings" → verify your identity.',
  },
  {
    icon: 'accessibility',
    title: 'Enable Accessibility Service',
    desc: 'Now go to Settings → Accessibility → Installed Services → Agent Ultra and toggle it on. Grant "Full control" when prompted. This lets Ultra interact with other apps on your behalf.',
  },
];

interface OnboardingScreenProps {
  onComplete: () => void;
}

export default function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  const handleNext = () => {
    if (isLast) {
      onComplete();
    } else {
      setStep(prev => prev + 1);
    }
  };

  const handleAccessibilitySettings = () => {
    if (Platform.OS === 'android') {
      AppController.openAccessibilitySettings().catch(() => {});
    }
  };

  return (
    <View style={[s.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <View style={s.dotsRow}>
        {STEPS.map((_, i) => (
          <View key={i} style={[s.dot, i === step && s.dotActive]} />
        ))}
      </View>

      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.iconCircle}>
          <Ionicons name={current.icon as any} size={48} color={ACCENT} />
        </View>

        <Text style={s.title}>{current.title}</Text>
        <Text style={s.desc}>{current.desc}</Text>

        {step === 1 && (
          <Pressable
            style={s.linkBtn}
            onPress={() => Linking.openURL('https://venice.ai').catch(() => {})}
          >
            <Ionicons name="open-outline" size={16} color={ACCENT} />
            <Text style={s.linkText}>Get API key at venice.ai</Text>
          </Pressable>
        )}

        {step === 2 && Platform.OS === 'android' && (
          <Pressable style={s.linkBtn} onPress={handleAccessibilitySettings}>
            <Ionicons name="settings-outline" size={16} color={ACCENT} />
            <Text style={s.linkText}>Open Accessibility Settings</Text>
          </Pressable>
        )}
      </ScrollView>

      <View style={s.footer}>
        {step > 0 ? (
          <Pressable style={s.backBtn} onPress={() => setStep(prev => prev - 1)}>
            <Ionicons name="arrow-back" size={20} color={DIM} />
          </Pressable>
        ) : (
          <View style={{ width: 44 }} />
        )}
        <Pressable style={s.nextBtn} onPress={handleNext}>
          <Text style={s.nextText}>{isLast ? "Let's go" : 'Next'}</Text>
          <Ionicons name={isLast ? 'checkmark' : 'arrow-forward'} size={18} color={BG} />
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG, paddingHorizontal: 28 },
  dotsRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 40 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: SURFACE2 },
  dotActive: { backgroundColor: ACCENT, width: 24 },
  content: { alignItems: 'center', paddingBottom: 32 },
  iconCircle: {
    width: 100, height: 100, borderRadius: 50,
    backgroundColor: SURFACE, alignItems: 'center',
    justifyContent: 'center', marginBottom: 32,
  },
  title: { fontSize: 26, fontWeight: '700', color: TEXT, textAlign: 'center', marginBottom: 16 },
  desc: { fontSize: 16, color: DIM, textAlign: 'center', lineHeight: 24, maxWidth: 320 },
  linkBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 24, paddingVertical: 10, paddingHorizontal: 16,
    backgroundColor: SURFACE, borderRadius: 10,
  },
  linkText: { color: ACCENT, fontSize: 15, fontWeight: '600' },
  footer: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginTop: 16,
  },
  backBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: SURFACE, alignItems: 'center', justifyContent: 'center',
  },
  nextBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: ACCENT, borderRadius: 12,
    paddingVertical: 14, paddingHorizontal: 28,
  },
  nextText: { color: BG, fontWeight: '700', fontSize: 16 },
});

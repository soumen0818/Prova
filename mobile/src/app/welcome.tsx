import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Lock, Send, ShieldCheck } from 'lucide-react-native';
import type { ComponentType } from 'react';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

type IconType = ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
type Slide = { Icon: IconType; title: string; body: string };

const SLIDES: Slide[] = [
  {
    Icon: Send,
    title: 'Send money home, privately',
    body: 'Fast, low-cost transfers on Stellar — without anyone in the middle seeing your amount.',
  },
  {
    Icon: Lock,
    title: 'Only you can unlock it',
    body: 'Keys stay encrypted on your device, guarded by your PIN and fingerprint — with encrypted cloud backup for a lost phone.',
  },
  {
    Icon: ShieldCheck,
    title: 'Provably legal, privately',
    body: 'Verify your identity once. Each transfer proves it’s compliant — revealing nothing.',
  },
];

/** First screen for a signed-out user: value-prop slides, then "Get started" → email sign-in. */
export default function WelcomeScreen() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const slide = SLIDES[step];
  const Icon = slide.Icon;
  const isLast = step === SLIDES.length - 1;

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={[Palette.glowOlive, 'transparent']}
        style={styles.glow}
        pointerEvents="none"
      />
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <Image
          source={require('@/assets/images/brand-wordmark.png')}
          style={styles.wordmark}
          contentFit="contain"
        />
        <View style={styles.body}>
          <View style={styles.badge}>
            <Icon color={Palette.accent} size={40} strokeWidth={1.6} />
          </View>
          <Text style={styles.title}>{slide.title}</Text>
          <Text style={styles.subtitle}>{slide.body}</Text>
        </View>

        <View style={styles.dots}>
          {SLIDES.map((_, i) => (
            <View key={i} style={[styles.dot, i === step && styles.dotActive]} />
          ))}
        </View>

        <View style={styles.actions}>
          {isLast ? (
            <Button label="Get started" onPress={() => router.push('/email')} />
          ) : (
            <Button label="Continue" onPress={() => setStep((s) => s + 1)} />
          )}
          <Button
            label={isLast ? 'Back' : 'Skip'}
            variant="glass"
            onPress={() => (isLast ? setStep((s) => s - 1) : router.push('/email'))}
          />
          <Pressable hitSlop={8} onPress={() => router.push('/restore')}>
            <Text style={styles.restoreLink}>Already used Prova? Restore your account</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.bgBase },
  glow: { position: 'absolute', top: 0, left: 0, right: 0, height: 320 },
  safe: { flex: 1, paddingHorizontal: Spacing.six, justifyContent: 'space-between' },
  wordmark: { width: 120, height: 36, marginTop: Spacing.four, alignSelf: 'center' },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.four },
  badge: {
    width: 84,
    height: 84,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.glassBorder,
    marginBottom: Spacing.two,
  },
  title: { ...Typography.title, color: Palette.white, textAlign: 'center' },
  subtitle: { ...Typography.body, color: Palette.textSecondary, textAlign: 'center' },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.two,
    marginBottom: Spacing.five,
  },
  dot: { width: 7, height: 7, borderRadius: 999, backgroundColor: Palette.bgSelected },
  dotActive: { backgroundColor: Palette.accent, width: 20 },
  actions: { gap: Spacing.three, paddingBottom: Spacing.four },
  restoreLink: {
    ...Typography.caption,
    color: Palette.textSecondary,
    textAlign: 'center',
    textDecorationLine: 'underline',
    paddingVertical: Spacing.two,
  },
});

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Lock, ScanFace, Send, ShieldCheck } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import type { ComponentType } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui';
import { canUseBiometrics } from '@/lib/auth';
import { captureError } from '@/lib/reporting';
import { getOrCreateSecret } from '@/lib/wallet';
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
    title: 'Your amount never leaves your phone',
    body: 'A zero-knowledge proof is generated on-device. Only a commitment goes on-chain.',
  },
  {
    Icon: ShieldCheck,
    title: 'Provably legal, privately',
    body: 'Verify your identity once. Each transfer proves it’s compliant — revealing nothing.',
  },
];

/** First-run onboarding: intro slides, then create the on-device wallet. Calls `onDone` when the
 * secure wallet secret has been created. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isLast = step === SLIDES.length;

  const createWallet = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await getOrCreateSecret(); // secure RNG, stored in the enclave
      await canUseBiometrics().catch(() => false); // warm up; AppLock enforces it next launch
      onDone();
    } catch (e) {
      captureError(e, { step: 'create-wallet' });
      setError('Could not create your wallet. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [onDone]);

  const slide = SLIDES[Math.min(step, SLIDES.length - 1)];
  const Icon = isLast ? ScanFace : slide.Icon;

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
          <Text style={styles.title}>{isLast ? 'Create your wallet' : slide.title}</Text>
          <Text style={styles.subtitle}>
            {isLast
              ? 'We’ll generate a private key on this device, secured by your biometrics/PIN. It never leaves your phone.'
              : slide.body}
          </Text>
        </View>

        <View style={styles.dots}>
          {[...SLIDES, null].map((_, i) => (
            <View key={i} style={[styles.dot, i === step && styles.dotActive]} />
          ))}
        </View>

        <View style={styles.actions}>
          {isLast ? (
            <Button
              label={busy ? 'Creating…' : 'Create wallet & continue'}
              onPress={createWallet}
              disabled={busy}
            />
          ) : (
            <Button label="Continue" onPress={() => setStep((s) => s + 1)} />
          )}
          {busy ? <ActivityIndicator color={Palette.accent} style={styles.spinner} /> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
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
  spinner: { marginTop: Spacing.two },
  error: { ...Typography.caption, color: '#ff6b6b', textAlign: 'center' },
});

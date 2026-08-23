import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Fingerprint } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Loader } from '@/components/loader';
import { PinPad } from '@/components/pin-pad';
import { GlassIconButton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { authenticate, canUseBiometrics } from '@/lib/auth';
import { syncBackup } from '@/lib/cloud-backup';
import { captureError } from '@/lib/reporting';
import { hasPin, PIN_LENGTH, setPin, verifyPin } from '@/lib/pin';
import { hasVault, sealVault } from '@/lib/vault';
import { Palette, Spacing, Typography } from '@/constants/theme';

type Step = 'current' | 'enter' | 'confirm';

/**
 * Set or change the 6-digit PIN. Changing an existing PIN first requires proving the current one
 * (or biometrics — the spec's forgot-PIN-with-phone path), so a picked-up unlocked phone can't
 * silently re-key the account/backup. Then two steps (enter → confirm) prevent typo lockouts.
 * On change with an existing vault, the backup is re-sealed under the new PIN and re-uploaded.
 */
export default function SetPinScreen() {
  const router = useRouter();
  const toast = useToast();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const isChange = mode === 'change';

  const [step, setStep] = useState<Step>('enter');
  const [gateReady, setGateReady] = useState(!isChange);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [first, setFirst] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Change mode: decide whether a current PIN exists (require it) and whether biometrics can vouch.
  useEffect(() => {
    if (!isChange) return;
    let active = true;
    Promise.all([hasPin(), canUseBiometrics()]).then(([pinExists, bio]) => {
      if (!active) return;
      setBioAvailable(bio);
      setStep(pinExists ? 'current' : 'enter');
      setGateReady(true);
    });
    return () => {
      active = false;
    };
  }, [isChange]);

  const onBiometricVouch = useCallback(async () => {
    setError('');
    const ok = await authenticate('Confirm it’s you to change your PIN');
    if (ok) {
      setValue('');
      setStep('enter');
    } else {
      setError('Authentication failed — try again.');
    }
  }, []);

  const onComplete = useCallback(
    async (pin: string) => {
      setError('');

      if (step === 'current') {
        // Prove knowledge of the existing PIN before allowing a change (rate-limited).
        setBusy(true);
        try {
          const res = await verifyPin(pin);
          setValue('');
          if (res.ok) {
            setStep('enter');
          } else if (res.lockedUntil > Date.now()) {
            setError('Too many attempts. Try again later.');
          } else {
            setError(
              res.attemptsRemaining > 0
                ? `Wrong PIN — ${res.attemptsRemaining} attempt${res.attemptsRemaining === 1 ? '' : 's'} left.`
                : 'Wrong PIN.',
            );
          }
        } finally {
          setBusy(false);
        }
        return;
      }

      if (step === 'enter') {
        setFirst(pin);
        setValue('');
        setStep('confirm');
        return;
      }

      // step === 'confirm'
      if (pin !== first) {
        setError('PINs didn’t match. Start again.');
        setFirst('');
        setValue('');
        setStep('enter');
        return;
      }
      setBusy(true);
      try {
        // Store the PIN verifier (fast). The Argon2id vault seal is deferred off the onboarding
        // path — the vault is created when cloud backup is enabled. On a PIN change with an
        // existing vault, re-seal under the new PIN and push the updated box to the cloud so the
        // old PIN can no longer open the backup.
        await setPin(pin);
        if (await hasVault()) {
          await sealVault(pin);
          void syncBackup();
        }
        toast.success(isChange ? 'PIN updated' : 'PIN set');
        if (isChange) {
          router.back();
        } else {
          router.replace('/');
        }
      } catch (e) {
        captureError(e, { step: 'set-pin' });
        setError('Could not save your PIN. Try again.');
        setFirst('');
        setValue('');
        setStep('enter');
      } finally {
        setBusy(false);
      }
    },
    [first, isChange, router, step, toast],
  );

  const title =
    step === 'current'
      ? 'Enter your current PIN'
      : step === 'enter'
        ? isChange
          ? 'Enter a new PIN'
          : 'Create your PIN'
        : 'Confirm your PIN';
  const subtitle =
    step === 'current'
      ? 'Confirm it’s you before choosing a new PIN.'
      : step === 'enter'
        ? `Choose a ${PIN_LENGTH}-digit PIN. You’ll use it to unlock Prova and approve payments.`
        : 'Enter it once more to confirm.';

  if (!gateReady) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.loading}>
          <Loader size={12} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      {isChange ? (
        <GlassIconButton accessibilityLabel="Back" onPress={() => router.back()}>
          <ArrowLeft color={Palette.white} size={20} strokeWidth={2} />
        </GlassIconButton>
      ) : null}

      <View style={styles.body}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>

        <View style={styles.padWrap}>
          <PinPad
            value={value}
            onChange={setValue}
            length={PIN_LENGTH}
            disabled={busy}
            onComplete={onComplete}
          />
        </View>

        <View style={styles.footer}>
          {busy ? (
            <View style={styles.busyRow}>
              <Loader />
              <Text style={styles.busyText}>
                {step === 'current' ? 'Checking…' : 'Securing your account…'}
              </Text>
            </View>
          ) : error ? (
            <Text style={styles.error}>{error}</Text>
          ) : null}
        </View>

        {step === 'current' && bioAvailable && !busy ? (
          <Pressable onPress={onBiometricVouch} hitSlop={8}>
            <View style={styles.bioLink}>
              <Fingerprint color={Palette.accent} size={18} strokeWidth={2} />
              <Text style={styles.bioLinkText}>Use biometrics instead</Text>
            </View>
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.bgBase, paddingHorizontal: Spacing.six },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, alignItems: 'center', paddingTop: Spacing.seven },
  title: { ...Typography.title, fontSize: 24, color: Palette.white, textAlign: 'center' },
  warning: {
    ...Typography.caption,
    color: Palette.accent,
    textAlign: 'center',
    marginTop: Spacing.three,
    paddingHorizontal: Spacing.two,
  },
  subtitle: {
    ...Typography.body,
    color: Palette.textSecondary,
    textAlign: 'center',
    marginTop: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  padWrap: { flex: 1, justifyContent: 'center' },
  footer: { height: 40, justifyContent: 'center' },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  busyText: { ...Typography.caption, color: Palette.textSecondary },
  error: { ...Typography.caption, color: Palette.statusDown, textAlign: 'center' },
  bioLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingBottom: Spacing.six,
  },
  bioLinkText: { ...Typography.caption, color: Palette.accent, fontWeight: '600' },
});

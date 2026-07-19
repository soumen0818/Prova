import { X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PinPad } from '@/components/pin-pad';
import { PIN_LENGTH, verifyPin } from '@/lib/pin';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/**
 * A modal that asks for the PIN and resolves only on a correct entry (rate-limited via lib/pin).
 * Used as the step-up before payments and before sealing the backup vault. The verified PIN is
 * passed to `onSuccess` for callers that need it as key material (e.g. enabling cloud backup).
 */
export function PinPromptModal({
  visible,
  title = 'Enter your PIN',
  subtitle = 'Confirm it’s you to continue.',
  onSuccess,
  onCancel,
}: {
  visible: boolean;
  title?: string;
  subtitle?: string;
  onSuccess: (pin: string) => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // Clear transient input on close (so a reopened prompt starts fresh); lockout state persists.
  const handleCancel = useCallback(() => {
    setPin('');
    setError('');
    onCancel();
  }, [onCancel]);

  useEffect(() => {
    if (lockedUntil <= now) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [lockedUntil, now]);

  const isLockedOut = lockedUntil > now;

  const submit = useCallback(
    async (candidate: string) => {
      setVerifying(true);
      try {
        const res = await verifyPin(candidate);
        if (res.ok) {
          setPin('');
          onSuccess(candidate);
          return;
        }
        setPin('');
        if (res.lockedUntil > Date.now()) {
          setLockedUntil(res.lockedUntil);
          setNow(Date.now());
          setError('Too many attempts. Locked temporarily.');
        } else {
          setError(
            res.attemptsRemaining > 0
              ? `Wrong PIN — ${res.attemptsRemaining} attempt${res.attemptsRemaining === 1 ? '' : 's'} left.`
              : 'Wrong PIN.',
          );
        }
      } finally {
        setVerifying(false);
      }
    },
    [onSuccess],
  );

  const secondsLeft = Math.max(0, Math.ceil((lockedUntil - now) / 1000));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleCancel}>
      <View style={styles.backdrop}>
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={handleCancel} hitSlop={10} accessibilityLabel="Cancel">
              <X color={Palette.textSecondary} size={22} />
            </Pressable>
          </View>
          <Text style={styles.subtitle}>{subtitle}</Text>

          <View style={styles.padWrap}>
            <PinPad
              value={pin}
              onChange={setPin}
              length={PIN_LENGTH}
              disabled={verifying || isLockedOut}
              onComplete={submit}
            />
          </View>

          <View style={styles.footer}>
            {isLockedOut ? (
              <Text style={styles.error}>Try again in {secondsLeft}s</Text>
            ) : error ? (
              <Text style={styles.error}>{error}</Text>
            ) : null}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Palette.bgBase,
    borderTopLeftRadius: Radius.card,
    borderTopRightRadius: Radius.card,
    paddingHorizontal: Spacing.six,
    paddingTop: Spacing.six,
    paddingBottom: Spacing.four,
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  title: { ...Typography.section, color: Palette.white },
  subtitle: {
    ...Typography.caption,
    color: Palette.textSecondary,
    alignSelf: 'flex-start',
    marginTop: Spacing.one,
    marginBottom: Spacing.five,
  },
  padWrap: { marginVertical: Spacing.two },
  footer: { height: 24, justifyContent: 'center' },
  error: { ...Typography.caption, color: Palette.statusDown },
});

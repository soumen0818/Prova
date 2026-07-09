import { ShieldCheck } from 'lucide-react-native';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui';
import { authenticate, canUseBiometrics } from '@/lib/auth';
import { hasWallet } from '@/lib/wallet';
import { Palette, Spacing, Typography } from '@/constants/theme';

type LockState = 'checking' | 'locked' | 'unlocked';

/**
 * Gates the app behind device authentication (biometric/PIN). Locks when a wallet exists and the
 * device supports auth; re-locks whenever the app returns from the background. If there's no wallet
 * (fresh install) or the device has no lock method, it passes through — there's nothing to protect
 * or no way to authenticate.
 */
export function AppLock({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LockState>('checking');
  const [error, setError] = useState('');

  const evaluate = useCallback(async () => {
    setError('');
    const [wallet, bio] = await Promise.all([hasWallet(), canUseBiometrics()]);
    setState(wallet && bio ? 'locked' : 'unlocked');
  }, []);

  const unlock = useCallback(async () => {
    setError('');
    const ok = await authenticate('Unlock Prova');
    if (ok) setState('unlocked');
    else setError('Authentication failed — try again.');
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const [wallet, bio] = await Promise.all([hasWallet(), canUseBiometrics()]);
      if (active) setState(wallet && bio ? 'locked' : 'unlocked');
    })();
    return () => {
      active = false;
    };
  }, []);

  // Re-lock when the app comes back to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') evaluate();
    });
    return () => sub.remove();
  }, [evaluate]);

  // Keep children (the navigator) mounted; cover them with an opaque overlay while locked/checking.
  return (
    <View style={styles.root}>
      {children}
      {state !== 'unlocked' ? (
        <View style={styles.overlay}>
          {state === 'locked' ? (
            <View style={styles.center}>
              <View style={styles.badge}>
                <ShieldCheck color={Palette.accent} size={36} strokeWidth={1.8} />
              </View>
              <Text style={styles.title}>Prova is locked</Text>
              <Text style={styles.subtitle}>Unlock to access your private wallet.</Text>
              <Button label="Unlock" onPress={unlock} />
              {error ? <Text style={styles.error}>{error}</Text> : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.bgBase },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Palette.bgBase,
    zIndex: 100,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.seven,
    gap: Spacing.four,
  },
  badge: {
    width: 72,
    height: 72,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.glassBorder,
    marginBottom: Spacing.two,
  },
  title: { ...Typography.title, color: Palette.white },
  subtitle: {
    ...Typography.caption,
    color: Palette.textSecondary,
    textAlign: 'center',
    marginBottom: Spacing.two,
  },
  error: { ...Typography.caption, color: '#ff6b6b' },
});

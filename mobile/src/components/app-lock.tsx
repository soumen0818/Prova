import { Fingerprint, ShieldCheck } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import { PinPad } from '@/components/pin-pad';
import { authenticate, canUseBiometrics } from '@/lib/auth';
import { hasPin, PIN_LENGTH, verifyPin } from '@/lib/pin';
import { hasWallet } from '@/lib/wallet';
import { Palette, Spacing, Typography } from '@/constants/theme';

type LockState = 'checking' | 'locked' | 'unlocked';

/**
 * Gates the app behind device authentication. Locks whenever a wallet exists and at least one
 * factor is set up (a PIN or device biometrics), and re-locks when the app returns from background.
 * Unlock with biometrics (auto-prompted) or by entering the PIN; the PIN is rate-limited (see
 * lib/pin). If there's no wallet or no factor at all, it passes through — nothing to protect.
 */
export function AppLock({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LockState>('checking');
  const [bioAvailable, setBioAvailable] = useState(false);
  const [pinSet, setPinSet] = useState(false);

  const [pin, setPin] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const autoPrompted = useRef(false);

  const unlockBiometric = useCallback(async () => {
    const ok = await authenticate('Unlock Prova');
    if (ok) {
      setState('unlocked');
      setError('');
    } else {
      setError('Authentication failed — try again.');
    }
  }, []);

  const evaluate = useCallback(async () => {
    const [wallet, bio, pinExists] = await Promise.all([hasWallet(), canUseBiometrics(), hasPin()]);
    setBioAvailable(bio);
    setPinSet(pinExists);
    const shouldLock = wallet && (bio || pinExists);
    if (shouldLock) {
      setState('locked');
      setPin('');
      setError('');
      // Auto-prompt biometrics once per lock; the PIN pad stays available as a fallback.
      if (bio && !autoPrompted.current) {
        autoPrompted.current = true;
        unlockBiometric();
      }
    } else {
      setState('unlocked');
    }
  }, [unlockBiometric]);

  // Initial evaluation on mount (inline async + guard — the pattern the compiler lint accepts).
  useEffect(() => {
    let active = true;
    (async () => {
      const [wallet, bio, pinExists] = await Promise.all([
        hasWallet(),
        canUseBiometrics(),
        hasPin(),
      ]);
      if (!active) return;
      setBioAvailable(bio);
      setPinSet(pinExists);
      if (wallet && (bio || pinExists)) {
        setState('locked');
        if (bio && !autoPrompted.current) {
          autoPrompted.current = true;
          unlockBiometric();
        }
      } else {
        setState('unlocked');
      }
    })();
    return () => {
      active = false;
    };
  }, [unlockBiometric]);

  // Re-lock when the app returns to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        autoPrompted.current = false;
        evaluate();
      }
    });
    return () => sub.remove();
  }, [evaluate]);

  // Tick while locked out so the countdown updates and the pad re-enables on time.
  useEffect(() => {
    if (lockedUntil <= now) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [lockedUntil, now]);

  const isLockedOut = lockedUntil > now;

  const submitPin = useCallback(async (candidate: string) => {
    setVerifying(true);
    try {
      const res = await verifyPin(candidate);
      if (res.ok) {
        setState('unlocked');
        setError('');
        setPin('');
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
  }, []);

  const secondsLeft = Math.max(0, Math.ceil((lockedUntil - now) / 1000));

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
              <Text style={styles.subtitle}>
                {pinSet ? 'Enter your PIN to unlock.' : 'Unlock to access your private wallet.'}
              </Text>

              {pinSet ? (
                <View style={styles.padWrap}>
                  <PinPad
                    value={pin}
                    onChange={setPin}
                    length={PIN_LENGTH}
                    disabled={verifying || isLockedOut}
                    onComplete={submitPin}
                  />
                </View>
              ) : (
                <Pressable style={styles.bioBtn} onPress={unlockBiometric}>
                  <Fingerprint color={Palette.onAccent} size={20} strokeWidth={2} />
                  <Text style={styles.bioBtnText}>Unlock</Text>
                </Pressable>
              )}

              <View style={styles.footer}>
                {isLockedOut ? (
                  <Text style={styles.error}>Try again in {secondsLeft}s</Text>
                ) : error ? (
                  <Text style={styles.error}>{error}</Text>
                ) : null}
              </View>

              {pinSet && bioAvailable ? (
                <Pressable onPress={unlockBiometric} hitSlop={8}>
                  <View style={styles.bioLink}>
                    <Fingerprint color={Palette.accent} size={18} strokeWidth={2} />
                    <Text style={styles.bioLinkText}>Use biometrics</Text>
                  </View>
                </Pressable>
              ) : null}
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
    paddingHorizontal: Spacing.six,
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
  },
  title: { ...Typography.title, color: Palette.white },
  subtitle: {
    ...Typography.caption,
    color: Palette.textSecondary,
    textAlign: 'center',
    marginBottom: Spacing.two,
  },
  padWrap: { marginTop: Spacing.two },
  bioBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: Palette.accent,
    borderRadius: 999,
    paddingHorizontal: Spacing.six,
    paddingVertical: Spacing.three,
  },
  bioBtnText: { ...Typography.button, color: Palette.onAccent },
  footer: { height: 24, justifyContent: 'center' },
  error: { ...Typography.caption, color: '#ff6b6b' },
  bioLink: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  bioLinkText: { ...Typography.caption, color: Palette.accent, fontWeight: '600' },
});

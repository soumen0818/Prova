import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, GlassIconButton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { env } from '@/config/env';
import { requestOtp, verifyOtp } from '@/lib/auth-otp';
import { ApiError } from '@/lib/api';
import { captureError } from '@/lib/reporting';
import { validateOtp } from '@/lib/validation';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

const CODE_LENGTH = 6;

/** Step 2 of sign-in: verify the emailed one-time code. */
export default function OtpScreen() {
  const router = useRouter();
  const toast = useToast();
  const { email } = useLocalSearchParams<{ email: string }>();
  const { devCode } = useLocalSearchParams<{ devCode?: string }>();
  // Pre-filled only when the server had no mail sender and handed one back — never invented here.
  const [code, setCode] = useState(devCode ?? '');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Seconds until another code may be requested. The server owns the real limit; this mirrors it so
  // the button explains itself instead of failing when tapped.
  const [cooldown, setCooldown] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    timer.current = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [cooldown]);

  const check = validateOtp(code, CODE_LENGTH);
  const showError = submitted && !check.ok ? check.error : '';

  const onVerify = useCallback(async () => {
    setSubmitted(true);
    const v = validateOtp(code, CODE_LENGTH);
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    const clean = code.replace(/\D/g, '');
    setBusy(true);
    try {
      await verifyOtp(email ?? '', clean);
      router.push({ pathname: '/profile-setup', params: { email: email ?? '' } });
    } catch (e) {
      captureError(e, { step: 'verify-otp' });
      // The server's message is written for a person and says what to do next — how many attempts
      // remain, or that a new code is needed. Showing it verbatim is the point.
      toast.error(e instanceof Error ? e.message : 'That code isn’t right.');
      if (e instanceof ApiError && e.isRateLimited && e.retryAfterSeconds) {
        setCooldown(e.retryAfterSeconds);
      }
      // A rejected code is almost always mistyped, so clear it rather than making them delete it.
      setCode('');
    } finally {
      setBusy(false);
    }
  }, [code, email, router, toast]);

  /** Ask for a fresh code. Disabled while the server's cooldown is running. */
  const onResend = useCallback(async () => {
    if (cooldown > 0 || busy) return;
    setBusy(true);
    try {
      const challenge = await requestOtp(email ?? '');
      setCode(challenge.devCode ?? '');
      toast.success('New code sent');
      // Mirrors the server's 60s cooldown so the button disables itself rather than 429-ing.
      setCooldown(60);
    } catch (e) {
      captureError(e, { step: 'resend-otp' });
      toast.error(e instanceof Error ? e.message : 'Could not send a new code');
      if (e instanceof ApiError && e.retryAfterSeconds) {
        setCooldown(e.retryAfterSeconds);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, cooldown, email, toast]);

  const boxes = Array.from({ length: CODE_LENGTH }, (_, i) => code[i] ?? '');

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <GlassIconButton accessibilityLabel="Back" onPress={() => router.back()}>
          <ArrowLeft color={Palette.white} size={20} strokeWidth={2} />
        </GlassIconButton>

        <View style={styles.body}>
          <Text style={styles.title}>Enter the code</Text>
          <Text style={styles.subtitle}>
            Sent to {email || 'your email'}. It may take a moment to arrive.
          </Text>

          {/* Visual boxes over a single hidden input for reliable native keyboard handling. */}
          <View style={styles.boxesWrap}>
            <View style={styles.boxes} pointerEvents="none">
              {boxes.map((d, i) => (
                <View key={i} style={[styles.box, i === code.length && styles.boxActive]}>
                  <Text style={styles.boxText}>{d}</Text>
                </View>
              ))}
            </View>
            <TextInput
              style={styles.hiddenInput}
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, CODE_LENGTH))}
              keyboardType="number-pad"
              maxLength={CODE_LENGTH}
              autoFocus
              editable={!busy}
            />
          </View>

          {showError ? <Text style={styles.error}>{showError}</Text> : null}

          {env.auth.isDev ? (
            <Text style={styles.devHint}>Dev mode — code is {env.auth.devOtp}.</Text>
          ) : null}
        </View>

        <Pressable onPress={onResend} disabled={cooldown > 0 || busy} hitSlop={8}>
          <Text style={[styles.resend, cooldown > 0 && styles.resendDisabled]}>
            {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Didn’t get it? Resend code'}
          </Text>
        </Pressable>

        <Button label={busy ? 'Verifying…' : 'Verify'} onPress={onVerify} loading={busy} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  resend: {
    ...Typography.caption,
    color: Palette.accent,
    textAlign: 'center',
    marginBottom: Spacing.four,
  },
  resendDisabled: { color: Palette.textMuted },
  root: { flex: 1, backgroundColor: Palette.bgBase, paddingHorizontal: Spacing.six },
  flex: { flex: 1 },
  body: { flex: 1, gap: Spacing.four, paddingTop: Spacing.seven },
  title: { ...Typography.title, fontSize: 26, lineHeight: 32, color: Palette.white },
  subtitle: { ...Typography.body, color: Palette.textSecondary },
  boxesWrap: { marginTop: Spacing.four },
  boxes: { flexDirection: 'row', gap: Spacing.two, justifyContent: 'space-between' },
  box: {
    flex: 1,
    height: 60,
    borderRadius: Radius.input,
    backgroundColor: Palette.bgInput,
    borderWidth: 1,
    borderColor: Palette.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxActive: { borderColor: Palette.accent },
  boxText: { ...Typography.title, fontSize: 24, color: Palette.white },
  hiddenInput: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 60,
    opacity: 0,
    color: 'transparent',
  },
  error: { ...Typography.caption, color: Palette.statusDown },
  devHint: { ...Typography.micro, color: Palette.accent },
});

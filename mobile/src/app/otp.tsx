import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, GlassIconButton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { env } from '@/config/env';
import { verifyOtp } from '@/lib/auth-otp';
import { captureError } from '@/lib/reporting';
import { validateOtp } from '@/lib/validation';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

const CODE_LENGTH = 6;

/** Step 2 of sign-in: verify the OTP code. */
export default function OtpScreen() {
  const router = useRouter();
  const toast = useToast();
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const [code, setCode] = useState(env.auth.isDev ? env.auth.devOtp : '');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

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
      await verifyOtp(phone ?? '', clean);
      router.push({ pathname: '/profile-setup', params: { phone: phone ?? '' } });
    } catch (e) {
      captureError(e, { step: 'verify-otp' });
      toast.error(e instanceof Error ? e.message : 'Incorrect code');
    } finally {
      setBusy(false);
    }
  }, [code, phone, router, toast]);

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
            Sent to {phone || 'your phone'}. It may take a moment to arrive.
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

        <Button label={busy ? 'Verifying…' : 'Verify'} onPress={onVerify} loading={busy} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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

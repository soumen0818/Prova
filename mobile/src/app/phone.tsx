import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, GlassIconButton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { env } from '@/config/env';
import { requestOtp } from '@/lib/auth-otp';
import { captureError } from '@/lib/reporting';
import { validatePhone } from '@/lib/validation';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/** Step 1 of sign-in: enter a phone number and request an OTP. */
export default function PhoneScreen() {
  const router = useRouter();
  const toast = useToast();
  const [phone, setPhone] = useState(env.auth.isDev ? env.auth.devPhone : '');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const check = validatePhone(phone);
  const showError = submitted && !check.ok ? check.error : '';

  const onContinue = useCallback(async () => {
    setSubmitted(true);
    const v = validatePhone(phone);
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    const trimmed = phone.trim();
    setBusy(true);
    try {
      await requestOtp(trimmed);
      router.push({ pathname: '/otp', params: { phone: trimmed } });
    } catch (e) {
      captureError(e, { step: 'request-otp' });
      toast.error(e instanceof Error ? e.message : 'Could not send code');
    } finally {
      setBusy(false);
    }
  }, [phone, router, toast]);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <GlassIconButton accessibilityLabel="Back" onPress={() => router.back()}>
          <ArrowLeft color={Palette.white} size={20} strokeWidth={2} />
        </GlassIconButton>

        <View style={styles.body}>
          <Text style={styles.title}>What’s your number?</Text>
          <Text style={styles.subtitle}>
            We’ll text you a one-time code to confirm it’s you. Your number is your account.
          </Text>

          <View style={styles.field}>
            <Text style={styles.label}>Phone number</Text>
            <TextInput
              style={[styles.input, showError ? styles.inputError : null]}
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              placeholder="+971 50 000 0000"
              placeholderTextColor={Palette.textMuted}
              autoFocus
              editable={!busy}
            />
            {showError ? <Text style={styles.error}>{showError}</Text> : null}
          </View>

          {env.auth.isDev ? (
            <Text style={styles.devHint}>
              Dev mode — any number works and the code is {env.auth.devOtp}.
            </Text>
          ) : null}
        </View>

        <Button label={busy ? 'Sending…' : 'Continue'} onPress={onContinue} loading={busy} />
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
  field: { gap: Spacing.two, marginTop: Spacing.four },
  label: { ...Typography.caption, color: Palette.textSecondary },
  input: {
    ...Typography.title,
    color: Palette.white,
    backgroundColor: Palette.bgInput,
    borderRadius: Radius.input,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
  },
  inputError: { borderWidth: 1, borderColor: Palette.statusDown },
  error: { ...Typography.caption, color: Palette.statusDown },
  devHint: { ...Typography.micro, color: Palette.accent },
});

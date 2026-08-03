import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, GlassIconButton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { requestOtp } from '@/lib/auth-otp';
import { captureError } from '@/lib/reporting';
import { validateEmail } from '@/lib/validation';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/**
 * Step 1 of sign-in: enter an email address and request a one-time code.
 *
 * The email is the **account identifier**. The phone number is collected separately during identity
 * verification, because it is an attribute the anchor needs rather than who the account is — so
 * someone changing their number never risks losing access.
 */
export default function EmailScreen() {
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const check = validateEmail(email);
  const showError = submitted && !check.ok ? check.error : '';

  const onContinue = useCallback(async () => {
    setSubmitted(true);
    const v = validateEmail(email);
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    // Normalised before it travels, so "User@Example.com" and "user@example.com" cannot become two
    // accounts. The server normalises again — it cannot trust the client to have done it.
    const normalized = email.trim().toLowerCase();
    setBusy(true);
    try {
      const challenge = await requestOtp(normalized);
      router.push({
        pathname: '/otp',
        // Carried only when the server had no mail sender and handed one back. With SMTP configured
        // this is absent and the user types the code they were emailed.
        params: { email: normalized, ...(challenge.devCode ? { devCode: challenge.devCode } : {}) },
      });
    } catch (e) {
      captureError(e, { step: 'request-otp' });
      // The server's message says what actually happened — rate limited, address rejected, provider
      // unavailable — and what to do about it.
      toast.error(e instanceof Error ? e.message : 'Could not send code');
    } finally {
      setBusy(false);
    }
  }, [email, router, toast]);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <GlassIconButton accessibilityLabel="Back" onPress={() => router.back()}>
          <ArrowLeft color={Palette.white} size={20} strokeWidth={2} />
        </GlassIconButton>

        <View style={styles.body}>
          <Text style={styles.title}>What’s your email?</Text>
          <Text style={styles.subtitle}>We’ll send you a 6-digit code.</Text>

          <View style={styles.field}>
            <TextInput
              style={[styles.input, showError ? styles.inputError : null]}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              // Autocorrect and auto-capitalisation are the usual cause of a "wrong" address that
              // looks right to the user, so both are off.
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              placeholder="you@example.com"
              placeholderTextColor={Palette.textMuted}
              autoFocus
              editable={!busy}
              onSubmitEditing={onContinue}
              returnKeyType="go"
            />
            {showError ? <Text style={styles.error}>{showError}</Text> : null}
          </View>
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
});

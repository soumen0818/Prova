import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, GlassIconButton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { canUseBiometrics } from '@/lib/auth';
import { QK } from '@/lib/queries';
import { captureError } from '@/lib/reporting';
import { saveSession, type Session } from '@/lib/session';
import { validateName } from '@/lib/validation';
import { getOrCreateSecret } from '@/lib/wallet';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/** Step 3 of sign-in: pick a display name, then create the on-device wallet + account. */
export default function ProfileSetupScreen() {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const check = validateName(name);
  const showError = submitted && !check.ok ? check.error : '';

  const onCreate = useCallback(async () => {
    setSubmitted(true);
    const v = validateName(name);
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    setBusy(true);
    try {
      // Generate the on-device ZK wallet secret (secure RNG, secure enclave) — never leaves phone.
      await getOrCreateSecret();
      await canUseBiometrics().catch(() => false); // warm up; AppLock enforces it next launch
      const session: Session = {
        phone: phone ?? '',
        name: name.trim(),
        createdAt: Math.floor(Date.now() / 1000),
      };
      await saveSession(session);
      // Write straight into the cache so the root gate sees the session synchronously — avoids a
      // stale-null read that would bounce back to /welcome (the "onboarding twice" bug).
      queryClient.setQueryData(QK.session, session);
      // Clear the auth screens from the back stack, then set a PIN before entering the app.
      if (router.canDismiss()) router.dismissAll();
      router.replace('/set-pin');
    } catch (e) {
      captureError(e, { step: 'create-account' });
      toast.error('Could not create your account. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [name, phone, queryClient, router, toast]);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <GlassIconButton accessibilityLabel="Back" onPress={() => router.back()}>
          <ArrowLeft color={Palette.white} size={20} strokeWidth={2} />
        </GlassIconButton>

        <View style={styles.body}>
          <Text style={styles.title}>Set up your profile</Text>
          <Text style={styles.subtitle}>
            We’ll create a private key on this device, secured by your biometrics. It never leaves
            your phone.
          </Text>

          <View style={styles.field}>
            <Text style={styles.label}>Your name</Text>
            <TextInput
              style={[styles.input, showError ? styles.inputError : null]}
              value={name}
              onChangeText={setName}
              placeholder="Ravi Kumar"
              placeholderTextColor={Palette.textMuted}
              autoFocus
              autoCapitalize="words"
              maxLength={60}
              editable={!busy}
            />
            {showError ? <Text style={styles.error}>{showError}</Text> : null}
          </View>
        </View>

        <Button
          label={busy ? 'Creating your account…' : 'Create account'}
          onPress={onCreate}
          loading={busy}
        />
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
});

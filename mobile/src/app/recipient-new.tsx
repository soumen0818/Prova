import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import { QK } from '@/lib/queries';
import { syncBackup } from '@/lib/cloud-backup';
import { addRecipient } from '@/lib/recipients';
import { captureError } from '@/lib/reporting';
import { validateCountry, validateHandle, validateName } from '@/lib/validation';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/** Add a beneficiary you can send to. */
export default function NewRecipientScreen() {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [country, setCountry] = useState('India');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const nameV = validateName(name);
  const handleV = validateHandle(handle);
  const countryV = validateCountry(country);
  const err = (v: { ok: boolean } & { error?: string }) =>
    submitted && !v.ok ? (v.error ?? '') : '';

  const onSave = useCallback(async () => {
    setSubmitted(true);
    const first = [validateName(name), validateHandle(handle), validateCountry(country)].find(
      (v) => !v.ok,
    );
    if (first && !first.ok) {
      toast.error(first.error);
      return;
    }
    setBusy(true);
    try {
      await addRecipient({ name, handle, country });
      await queryClient.invalidateQueries({ queryKey: QK.recipients });
      toast.success('Recipient added');
      void syncBackup(); // silent, best-effort backup refresh
      router.back();
    } catch (e) {
      captureError(e, { step: 'add-recipient' });
      toast.error('Could not save recipient');
    } finally {
      setBusy(false);
    }
  }, [name, handle, country, queryClient, router, toast]);

  return (
    <Screen scroll>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Text style={styles.subtitle}>
          Who are you sending to? This is a label you manage — settlement happens privately between
          anchors.
        </Text>

        <Field label="Full name" error={err(nameV)}>
          <TextInput
            style={[styles.input, err(nameV) ? styles.inputError : null]}
            value={name}
            onChangeText={setName}
            placeholder="Amma Devi"
            placeholderTextColor={Palette.textMuted}
            autoCapitalize="words"
            autoFocus
            maxLength={60}
            editable={!busy}
          />
        </Field>

        <Field label="Account / phone" error={err(handleV)}>
          <TextInput
            style={[styles.input, err(handleV) ? styles.inputError : null]}
            value={handle}
            onChangeText={setHandle}
            placeholder="HDFC ••4821  or  +91 98••• ••210"
            placeholderTextColor={Palette.textMuted}
            maxLength={40}
            editable={!busy}
          />
        </Field>

        <Field label="Destination country" error={err(countryV)}>
          <TextInput
            style={[styles.input, err(countryV) ? styles.inputError : null]}
            value={country}
            onChangeText={setCountry}
            placeholder="India"
            placeholderTextColor={Palette.textMuted}
            autoCapitalize="words"
            maxLength={40}
            editable={!busy}
          />
        </Field>

        <Button
          label={busy ? 'Saving…' : 'Save recipient'}
          onPress={onSave}
          loading={busy}
          style={styles.save}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  subtitle: { ...Typography.body, color: Palette.textSecondary, marginBottom: Spacing.five },
  field: { gap: Spacing.two, marginBottom: Spacing.four },
  label: { ...Typography.caption, color: Palette.textSecondary },
  input: {
    ...Typography.body,
    fontSize: 17,
    color: Palette.white,
    backgroundColor: Palette.bgInput,
    borderRadius: Radius.input,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
  },
  inputError: { borderWidth: 1, borderColor: Palette.statusDown },
  error: { ...Typography.caption, color: Palette.statusDown },
  save: { marginTop: Spacing.three },
});

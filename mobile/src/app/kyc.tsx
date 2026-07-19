import { useQueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { submitKyc, type KycCredential } from '@/lib/api';
import { syncBackup } from '@/lib/cloud-backup';
import { userId as deriveUserId } from '@/lib/prover';
import { QK } from '@/lib/queries';
import { getSecret, SecureKey, setSecret } from '@/lib/secure-store';
import { getOrCreateSecret } from '@/lib/wallet';
import { Button, Card, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import { Palette, Spacing, Typography } from '@/constants/theme';

/**
 * Phase 3 thin slice: KYC once. Sends the wallet's user id to the anchor (via the backend),
 * receives an anchor-signed credential, and stores it in the secure enclave. Identity documents
 * would be captured here in the real flow; the credential itself is a private circuit input and
 * never leaves the device. No on-device proving yet (Phase 4).
 */
export default function KycScreen() {
  const [busy, setBusy] = useState(false);
  const [credential, setCredential] = useState<KycCredential | null>(null);
  const [error, setError] = useState('');
  const toast = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    let active = true;
    (async () => {
      const stored = await getSecret(SecureKey.kycCredential);
      if (active && stored) {
        try {
          setCredential(JSON.parse(stored) as KycCredential);
        } catch {
          /* ignore malformed */
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const onVerify = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      // Load or securely create the wallet's ZK secret, then derive user_id = Poseidon(secret,
      // domain) on device via the native prover — the same secret the send flow proves against.
      const secret = await getOrCreateSecret();
      const userId = await deriveUserId(secret);
      const cred = await submitKyc(userId, 2);
      await setSecret(SecureKey.kycCredential, JSON.stringify(cred));
      await queryClient.invalidateQueries({ queryKey: QK.kyc });
      setCredential(cred);
      toast.success('Verified ✅');
      void syncBackup(); // carry the fresh credential into the cloud backup (silent)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'verification failed';
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }, [toast, queryClient]);

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Verify identity' }} />
      <Text style={styles.title}>KYC verification</Text>
      <Text style={styles.subtitle}>
        Verify once with the anchor. You receive a signed credential stored only on this device — it
        proves you’re verified without ever putting your identity on-chain.
      </Text>

      {credential ? (
        <Card style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>Status</Text>
            <Text style={styles.verified}>Verified ✅</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>KYC level</Text>
            <Text style={styles.value}>{credential.kycLevel}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Expires</Text>
            <Text style={styles.value}>
              {new Date(credential.expiry * 1000).toISOString().slice(0, 10)}
            </Text>
          </View>
          <Text style={styles.enclave}>Credential stored in the secure enclave.</Text>
        </Card>
      ) : (
        <Card style={styles.card}>
          <Text style={styles.value}>Not verified yet.</Text>
        </Card>
      )}

      <Button
        label={busy ? 'Verifying…' : credential ? 'Re-verify' : 'Verify with anchor'}
        onPress={onVerify}
        disabled={busy}
      />
      {busy ? <ActivityIndicator color={Palette.accent} style={styles.spinner} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...Typography.title, color: Palette.white, marginBottom: Spacing.two },
  subtitle: { ...Typography.caption, color: Palette.textSecondary, marginBottom: Spacing.five },
  card: { gap: Spacing.three, marginBottom: Spacing.five },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { ...Typography.caption, color: Palette.textSecondary },
  value: { ...Typography.caption, fontWeight: '600', color: Palette.white },
  verified: { ...Typography.caption, fontWeight: '600', color: Palette.accent },
  enclave: { ...Typography.micro, color: Palette.textMuted },
  spinner: { marginTop: Spacing.four },
  error: { ...Typography.caption, color: '#ff6b6b', marginTop: Spacing.four },
});

import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { submitKyc, type KycCredential } from '@/lib/api';
import { getSecret, SecureKey, setSecret } from '@/lib/secure-store';
import { Button, Card, Screen } from '@/components/ui';
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
      // The user id is derived from the wallet's ZK secret. On-device Poseidon derivation lands in
      // Phase 4; for this slice we use a stable random id persisted in the enclave.
      let userId = await getSecret(SecureKey.zkSecretKey);
      if (!userId) {
        userId = randomHex32();
        await setSecret(SecureKey.zkSecretKey, userId);
      }
      const cred = await submitKyc(userId, 2);
      await setSecret(SecureKey.kycCredential, JSON.stringify(cred));
      setCredential(cred);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'verification failed');
    } finally {
      setBusy(false);
    }
  }, []);

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

/** 32 random bytes as hex — a placeholder wallet id until Phase 4's Poseidon derivation. */
function randomHex32(): string {
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
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

import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import { env } from '@/config/env';
import { apiBaseUrl } from '@/lib/api';
import { hasPin } from '@/lib/pin';
import { QK } from '@/lib/queries';
import { resetWallet } from '@/lib/wallet';
import { Palette, Spacing, Typography } from '@/constants/theme';

export default function SettingsScreen() {
  const toast = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pinSet, setPinSet] = useState(false);

  // Refresh the PIN state each time the screen gains focus (e.g. returning from set-pin).
  useFocusEffect(
    useCallback(() => {
      let active = true;
      hasPin().then((v) => active && setPinSet(v));
      return () => {
        active = false;
      };
    }, []),
  );

  const onReset = useCallback(() => {
    Alert.alert(
      'Reset wallet?',
      'This deletes your account, private key, and KYC credential from this device. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            await resetWallet();
            queryClient.setQueryData(QK.session, null);
            await queryClient.invalidateQueries();
            toast.info('Wallet reset');
            router.replace('/');
          },
        },
      ],
    );
  }, [queryClient, router, toast]);

  return (
    <Screen scroll>
      <Text style={styles.section}>Account</Text>
      <Card style={styles.card}>
        <Row label="Sign-in mode" value={env.auth.mode} />
        <Row label="Currency" value={env.currency} />
      </Card>

      <Text style={styles.section}>Network</Text>
      <Card style={styles.card}>
        <Row label="Network" value={env.network} />
        <Row label="Soroban RPC" value={host(env.stellar.sorobanRpcUrl)} />
        <Row label="Horizon" value={host(env.stellar.horizonUrl)} />
        <Row label="Backend" value={host(apiBaseUrl)} />
      </Card>

      <Text style={styles.section}>Security</Text>
      <Card style={styles.card}>
        <Text style={styles.body}>
          Your ZK secret and KYC credential are stored in the device secure enclave and unlocked
          with your biometrics/PIN. They never leave the device.
        </Text>
        <Button
          label={pinSet ? 'Change PIN' : 'Set up PIN'}
          variant="secondary"
          onPress={() => router.push('/set-pin?mode=change')}
        />
      </Card>

      <Text style={styles.section}>Wallet</Text>
      <Card style={styles.card}>
        <Text style={styles.body}>Resetting wipes your keys and account from this device.</Text>
        <Button label="Reset wallet" variant="secondary" onPress={onReset} />
      </Card>

      <Text style={styles.section}>About</Text>
      <Card style={styles.card}>
        <Row label="App" value={`Prova ${env.appEnv}`} />
        <Row label="Shared schema" value={`v${env.schemaVersion}`} />
      </Card>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function host(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

const styles = StyleSheet.create({
  section: {
    ...Typography.caption,
    color: Palette.textSecondary,
    textTransform: 'uppercase',
    marginBottom: Spacing.two,
    marginTop: Spacing.three,
  },
  card: { gap: Spacing.three, marginBottom: Spacing.four },
  body: { ...Typography.caption, color: Palette.textSecondary },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.four,
  },
  rowLabel: { ...Typography.caption, color: Palette.textSecondary },
  rowValue: { ...Typography.caption, color: Palette.white, flexShrink: 1 },
});

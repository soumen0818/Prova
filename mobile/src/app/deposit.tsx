import { Stack } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { apiBaseUrl, getHealth, startDeposit } from '@/lib/api';
import { Button, Card, Screen } from '@/components/ui';
import { Palette, Spacing, Typography } from '@/constants/theme';

type Connection = 'checking' | 'online' | 'offline';

/**
 * Phase 2 thin slice: "connect + deposit". Checks the backend is reachable, then drives a SEP-24
 * interactive deposit through the backend and opens the anchor's page. No on-device proving yet.
 */
export default function DepositScreen() {
  const [connection, setConnection] = useState<Connection>('checking');
  const [schemaVersion, setSchemaVersion] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');

  const checkConnection = useCallback(async () => {
    setConnection('checking');
    setError('');
    try {
      const h = await getHealth();
      setSchemaVersion(h.schemaVersion);
      setConnection('online');
    } catch {
      setConnection('offline');
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const h = await getHealth();
        if (!active) return;
        setSchemaVersion(h.schemaVersion);
        setConnection('online');
      } catch {
        if (active) setConnection('offline');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const onDeposit = useCallback(async () => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const dep = await startDeposit();
      setStatus(`Deposit ${dep.id.slice(0, 8)}… started — opening anchor`);
      await WebBrowser.openBrowserAsync(dep.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'deposit failed');
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Deposit (testnet)' }} />

      <Text style={styles.title}>Add funds</Text>
      <Text style={styles.subtitle}>
        Deposit a test asset via the SDF testanchor (SEP-24). The backend authenticates (SEP-10) and
        opens the anchor’s deposit page.
      </Text>

      <Card style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>Backend</Text>
          <Text style={[styles.value, styles[connection]]}>{connection}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>API</Text>
          <Text style={styles.mono}>{apiBaseUrl}</Text>
        </View>
        {schemaVersion ? (
          <View style={styles.row}>
            <Text style={styles.label}>@prova/shared</Text>
            <Text style={styles.mono}>v{schemaVersion}</Text>
          </View>
        ) : null}
      </Card>

      <View style={styles.actions}>
        <Button
          label={busy ? 'Starting…' : 'Deposit test funds'}
          onPress={onDeposit}
          disabled={busy || connection !== 'online'}
        />
        {connection === 'offline' ? (
          <Button label="Retry connection" variant="secondary" onPress={checkConnection} />
        ) : null}
      </View>

      {busy ? <ActivityIndicator color={Palette.accent} style={styles.spinner} /> : null}
      {status ? <Text style={styles.status}>{status}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {connection === 'offline' ? (
        <Text style={styles.hint}>
          Can’t reach the backend. Start it with `go run ./cmd/api` in `backend/`, and on the
          Android emulator the API host is `10.0.2.2` (handled automatically).
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...Typography.title, color: Palette.white, marginBottom: Spacing.two },
  subtitle: { ...Typography.caption, color: Palette.textSecondary, marginBottom: Spacing.five },
  card: { gap: Spacing.three, marginBottom: Spacing.five },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { ...Typography.caption, color: Palette.textSecondary },
  value: { ...Typography.caption, fontWeight: '600' },
  mono: { ...Typography.micro, color: Palette.textMuted },
  checking: { color: Palette.textMuted },
  online: { color: Palette.accent },
  offline: { color: '#ff6b6b' },
  actions: { gap: Spacing.three },
  spinner: { marginTop: Spacing.four },
  status: { ...Typography.caption, color: Palette.accent, marginTop: Spacing.four },
  error: { ...Typography.caption, color: '#ff6b6b', marginTop: Spacing.four },
  hint: {
    ...Typography.micro,
    color: Palette.textMuted,
    marginTop: Spacing.four,
  },
});

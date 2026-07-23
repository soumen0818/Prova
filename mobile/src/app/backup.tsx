import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { Cloud, CloudOff, RefreshCw, ShieldCheck } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, View } from 'react-native';

import { Loader } from '@/components/loader';
import { Button, Card, Screen } from '@/components/ui';
import { PinPromptModal } from '@/components/pin-prompt';
import { useToast } from '@/components/toast';
import {
  BackupError,
  disableBackup,
  enableBackup,
  syncBackup,
  type BackupMeta,
} from '@/lib/cloud-backup';
import { hasPin } from '@/lib/pin';
import { captureError } from '@/lib/reporting';
import { QK, useBackupMeta } from '@/lib/queries';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

const PROVIDER_LABEL = Platform.OS === 'ios' ? 'iCloud' : 'Google Drive';

/**
 * Cloud backup — enable, status, back-up-now, turn off (Docs/account-recovery.md §3, Phase B).
 * Enabling asks for the PIN (it is the key that seals the vault), signs in to the user's own
 * cloud, and uploads the encrypted box. Only ciphertext leaves the device.
 */
export default function BackupScreen() {
  const toast = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: meta } = useBackupMeta();
  const [busy, setBusy] = useState<'enable' | 'sync' | 'disable' | null>(null);
  const [askPin, setAskPin] = useState(false);
  const [pinSet, setPinSet] = useState(true);
  const [error, setError] = useState('');

  // A PIN is the key that seals the backup — without one, route to PIN setup first.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      hasPin().then((v) => active && setPinSet(v));
      return () => {
        active = false;
      };
    }, []),
  );

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: QK.backup }),
    [queryClient],
  );

  const onEnableWithPin = useCallback(
    async (pin: string) => {
      setAskPin(false);
      setBusy('enable');
      setError('');
      try {
        const account = await enableBackup(pin);
        await refresh();
        toast.success(`Backed up to ${account}`);
      } catch (e) {
        const be = e instanceof BackupError ? e : null;
        if (be?.code !== 'cancelled') captureError(e, { step: 'enable-backup' });
        setError(be?.message ?? 'Could not enable backup.');
        if (be && be.code !== 'cancelled') toast.error(be.message);
      } finally {
        setBusy(null);
      }
    },
    [refresh, toast],
  );

  const onSyncNow = useCallback(async () => {
    setBusy('sync');
    setError('');
    try {
      await syncBackup(false);
      await refresh();
      toast.success('Backup up to date');
    } catch (e) {
      const be = e instanceof BackupError ? e : null;
      captureError(e, { step: 'sync-backup' });
      setError(be?.message ?? 'Backup sync failed.');
    } finally {
      setBusy(null);
    }
  }, [refresh, toast]);

  const onDisable = useCallback(() => {
    Alert.alert(
      'Turn off backup?',
      'The backup will be deleted from your cloud. If you lose this phone afterwards, your account cannot be recovered.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Turn off',
          style: 'destructive',
          onPress: async () => {
            setBusy('disable');
            try {
              await disableBackup();
              await refresh();
              toast.info('Backup turned off');
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  }, [refresh, toast]);

  const enabled = meta?.enabled === true;

  return (
    <Screen scroll>
      {/* Status hero */}
      <Card style={styles.hero}>
        <View style={[styles.heroBadge, enabled && styles.heroBadgeOn]}>
          {enabled ? (
            <Cloud color={Palette.onAccent} size={30} strokeWidth={1.9} />
          ) : (
            <CloudOff color={Palette.textSecondary} size={30} strokeWidth={1.9} />
          )}
        </View>
        <Text style={styles.heroTitle}>{enabled ? 'Backup is on' : 'Backup is off'}</Text>
        <Text style={styles.heroBody}>
          {enabled
            ? `Encrypted and stored in ${meta?.account ?? PROVIDER_LABEL}. Restore on any phone with your PIN.`
            : `Keep your account safe even if you lose this phone. Encrypted with your PIN, stored in your own ${PROVIDER_LABEL}.`}
        </Text>
        {enabled && meta ? <LastSynced meta={meta} /> : null}
      </Card>

      {/* Actions */}
      {enabled ? (
        <>
          <Button
            label={busy === 'sync' ? 'Backing up…' : 'Back up now'}
            icon={<RefreshCw color={Palette.onAccent} size={18} strokeWidth={2} />}
            onPress={onSyncNow}
            loading={busy === 'sync'}
            disabled={busy !== null}
            style={styles.action}
          />
          <Button
            label={busy === 'disable' ? 'Turning off…' : 'Turn off backup'}
            variant="secondary"
            onPress={onDisable}
            disabled={busy !== null}
            style={styles.action}
          />
        </>
      ) : pinSet ? (
        <Button
          label={busy === 'enable' ? 'Securing your backup…' : 'Turn on backup'}
          onPress={() => setAskPin(true)}
          loading={busy === 'enable'}
          disabled={busy !== null}
          style={styles.action}
        />
      ) : (
        <Button
          label="Set up a PIN first"
          onPress={() => router.push('/set-pin?mode=change')}
          style={styles.action}
        />
      )}

      {busy === 'enable' ? (
        <View style={styles.busyRow}>
          <Loader />
          <Text style={styles.busyText}>Encrypting and uploading — a few seconds…</Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {/* What's protected */}
      <Card style={styles.infoCard}>
        <ShieldCheck color={Palette.accent} size={18} strokeWidth={2} />
        <Text style={styles.infoText}>
          The backup contains your keys, profile, balance, and recipients — sealed with strong
          encryption only your PIN can open. Prova, Google, and Apple cannot read it.
        </Text>
      </Card>
      <Text style={styles.note}>
        To restore: install Prova on a new phone, choose “Restore account”, sign in to{' '}
        {PROVIDER_LABEL}, and enter your PIN.
      </Text>

      <PinPromptModal
        visible={askPin}
        title="Confirm your PIN"
        subtitle="Your PIN is the key that seals the backup."
        onSuccess={onEnableWithPin}
        onCancel={() => setAskPin(false)}
      />
    </Screen>
  );
}

function LastSynced({ meta }: { meta: BackupMeta }) {
  const d = new Date(meta.lastSyncedAt * 1000);
  const label = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return (
    <View style={styles.syncPill}>
      <Text style={styles.syncText}>
        Last backed up {label} · {providerLabel(meta.provider)}
      </Text>
    </View>
  );
}

function providerLabel(p: BackupMeta['provider']): string {
  return p === 'icloud' ? 'iCloud' : 'Google Drive';
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: Spacing.three, marginBottom: Spacing.six },
  heroBadge: {
    width: 68,
    height: 68,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.bgSelected,
  },
  heroBadgeOn: { backgroundColor: Palette.accent },
  heroTitle: { ...Typography.title, color: Palette.white },
  heroBody: { ...Typography.caption, color: Palette.textSecondary, textAlign: 'center' },
  syncPill: {
    backgroundColor: Palette.bgElevated,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  syncText: { ...Typography.micro, color: Palette.textSecondary },
  action: { marginBottom: Spacing.three },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    marginBottom: Spacing.three,
  },
  busyText: { ...Typography.caption, color: Palette.textSecondary },
  error: { ...Typography.caption, color: Palette.statusDown, marginBottom: Spacing.four },
  infoCard: {
    flexDirection: 'row',
    gap: Spacing.three,
    alignItems: 'flex-start',
    marginTop: Spacing.three,
    marginBottom: Spacing.four,
  },
  infoText: { ...Typography.caption, color: Palette.textSecondary, flex: 1 },
  note: { ...Typography.micro, color: Palette.textMuted },
});

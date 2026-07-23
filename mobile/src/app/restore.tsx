import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ArrowLeft, CloudDownload, ShieldCheck } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Loader } from '@/components/loader';
import { PinPad } from '@/components/pin-pad';
import { Button, GlassIconButton } from '@/components/ui';
import { useToast } from '@/components/toast';
import { restoreBalanceMinor } from '@/lib/balance';
import { adoptBackupMeta, BackupError, fetchCloudBackup } from '@/lib/cloud-backup';
import { PIN_LENGTH, setPin as savePin } from '@/lib/pin';
import { QK } from '@/lib/queries';
import { restoreRecipients } from '@/lib/recipients';
import { captureError } from '@/lib/reporting';
import { saveSession, type Session } from '@/lib/session';
import { SecureKey, setSecret } from '@/lib/secure-store';
import { adoptVault, openVaultBox, type VaultBox } from '@/lib/vault';
import { ensureAccount } from '@/lib/wallet';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

const PROVIDER_LABEL = Platform.OS === 'ios' ? 'iCloud' : 'Google Drive';

type Step = 'intro' | 'fetching' | 'pin' | 'restoring' | 'done';

/** In-memory wrong-PIN throttle for the restore flow (each attempt already costs ~seconds of KDF). */
const MAX_TRIES_BEFORE_PAUSE = 5;
const PAUSE_MS = 30_000;

/**
 * Restore an account on a (new) phone: sign in to the user's own cloud, download the encrypted
 * box, open it with the PIN, and rebuild everything — master, keys, profile, KYC credential,
 * balance, recipients — then re-arm the local PIN + backup (Docs/account-recovery.md §7).
 */
export default function RestoreScreen() {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>('intro');
  const [box, setBox] = useState<VaultBox | null>(null);
  const [account, setAccount] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tries = useRef(0);
  const pausedUntil = useRef(0);

  const onFetch = useCallback(async () => {
    setStep('fetching');
    setError('');
    try {
      const res = await fetchCloudBackup();
      setBox(res.box);
      setAccount(res.account);
      setStep('pin');
    } catch (e) {
      const be = e instanceof BackupError ? e : null;
      if (be?.code !== 'cancelled' && be?.code !== 'not_found') {
        captureError(e, { step: 'restore-fetch' });
      }
      setError(be?.message ?? 'Could not reach your cloud backup.');
      setStep('intro');
    }
  }, []);

  const onPinComplete = useCallback(
    async (candidate: string) => {
      if (!box) return;
      const now = Date.now();
      if (pausedUntil.current > now) {
        setPin('');
        setError(
          `Too many attempts — try again in ${Math.ceil((pausedUntil.current - now) / 1000)}s.`,
        );
        return;
      }
      setBusy(true);
      setError('');
      // Let the UI paint the busy state before the CPU-heavy Argon2id derivation blocks the JS thread.
      await new Promise((r) => setTimeout(r, 60));
      try {
        const opened = openVaultBox(box, candidate);
        if (!opened) {
          tries.current += 1;
          setPin('');
          if (tries.current >= MAX_TRIES_BEFORE_PAUSE) {
            tries.current = 0;
            pausedUntil.current = Date.now() + PAUSE_MS;
            setError('Too many attempts. Wait 30s and try again.');
          } else {
            setError('Wrong PIN — check and try again.');
          }
          return;
        }

        // PIN is correct → rebuild the whole account from the snapshot.
        setStep('restoring');
        const { data } = opened;

        await setSecret(SecureKey.masterSeed, data.master);
        await ensureAccount(); // re-derive + persist ZK secret and Stellar keypair
        if (data.kycCredential) {
          await setSecret(SecureKey.kycCredential, JSON.stringify(data.kycCredential));
        }
        if (data.profile) {
          await saveSession(data.profile as Session);
        }
        await restoreBalanceMinor(data.balanceMinor ?? 0);
        await restoreRecipients(data.recipients ?? []);
        await savePin(candidate); // re-arm the local PIN verifier on this device
        await adoptVault(box, opened.dekHex); // this box is now the local vault
        await adoptBackupMeta(account); // backup stays on — the cloud copy already exists

        // Refresh every cached view of the world, then enter the app.
        if (data.profile) queryClient.setQueryData(QK.session, data.profile);
        await queryClient.invalidateQueries();
        setStep('done');
        toast.success('Account restored');
        setTimeout(() => router.replace('/'), 900);
      } catch (e) {
        captureError(e, { step: 'restore-apply' });
        setError('Restore failed — please try again.');
        setStep('pin');
        setPin('');
      } finally {
        setBusy(false);
      }
    },
    [account, box, queryClient, router, toast],
  );

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      {step === 'intro' || step === 'pin' ? (
        <GlassIconButton
          accessibilityLabel="Back"
          onPress={() => (step === 'pin' ? setStep('intro') : router.back())}>
          <ArrowLeft color={Palette.white} size={20} strokeWidth={2} />
        </GlassIconButton>
      ) : null}

      {step === 'intro' ? (
        <View style={styles.body}>
          <View style={styles.badge}>
            <CloudDownload color={Palette.accent} size={36} strokeWidth={1.7} />
          </View>
          <Text style={styles.title}>Restore your account</Text>
          <Text style={styles.subtitle}>
            Sign in to {PROVIDER_LABEL} to find your encrypted backup, then unlock it with your
            Prova PIN.
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button
            label={`Find my backup in ${PROVIDER_LABEL}`}
            onPress={onFetch}
            style={styles.cta}
          />
        </View>
      ) : null}

      {step === 'fetching' ? (
        <View style={styles.center}>
          <Loader size={12} />
          <Text style={styles.progressText}>Looking for your backup…</Text>
        </View>
      ) : null}

      {step === 'pin' ? (
        <View style={styles.body}>
          <Text style={styles.title}>Enter your PIN</Text>
          <Text style={styles.subtitle}>
            Backup found in {account}. Your PIN unlocks it — it was set when you created the backup.
          </Text>
          <View style={styles.padWrap}>
            <PinPad
              value={pin}
              onChange={setPin}
              length={PIN_LENGTH}
              disabled={busy}
              onComplete={onPinComplete}
            />
          </View>
          <View style={styles.footer}>
            {busy ? (
              <View style={styles.busyRow}>
                <Loader />
                <Text style={styles.progressText}>Unlocking…</Text>
              </View>
            ) : error ? (
              <Text style={styles.error}>{error}</Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {step === 'restoring' || step === 'done' ? (
        <View style={styles.center}>
          <View style={styles.badge}>
            <ShieldCheck color={Palette.accent} size={36} strokeWidth={1.7} />
          </View>
          <Text style={styles.title}>{step === 'done' ? 'Welcome back' : 'Restoring…'}</Text>
          <Text style={styles.subtitle}>
            {step === 'done'
              ? 'Your account, balance, and settings are back.'
              : 'Rebuilding your keys and account on this phone.'}
          </Text>
          {step === 'restoring' ? <Loader size={12} /> : null}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.bgBase, paddingHorizontal: Spacing.six },
  body: { flex: 1, alignItems: 'center', paddingTop: Spacing.seven, gap: Spacing.four },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.four },
  badge: {
    width: 84,
    height: 84,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.glassBorder,
  },
  title: { ...Typography.title, fontSize: 24, color: Palette.white, textAlign: 'center' },
  subtitle: {
    ...Typography.body,
    color: Palette.textSecondary,
    textAlign: 'center',
    paddingHorizontal: Spacing.four,
  },
  cta: { alignSelf: 'stretch', marginTop: Spacing.four },
  padWrap: { flex: 1, justifyContent: 'center' },
  footer: { height: 40, justifyContent: 'center' },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  progressText: { ...Typography.caption, color: Palette.textSecondary },
  error: { ...Typography.caption, color: Palette.statusDown, textAlign: 'center' },
});

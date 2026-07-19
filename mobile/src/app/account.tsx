import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ChevronRight,
  Cloud,
  Copy,
  Fingerprint,
  KeyRound,
  ShieldCheck,
  UsersRound,
} from 'lucide-react-native';
import type { ComponentType } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Card, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import { canUseBiometrics } from '@/lib/auth';
import { hasPin } from '@/lib/pin';
import { useBackupMeta, useKycVerified } from '@/lib/queries';
import { ensureAccount } from '@/lib/wallet';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

type IconType = ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
type Tone = 'ok' | 'muted';

/**
 * Account details — the single place for everything account-related (Docs/account-recovery.md §8):
 * the Stellar receive address (the money address) with QR + copy, backup/recovery status, and KYC.
 * Backup, PIN, and social recovery are shown as upcoming until their phases land.
 */
export default function AccountScreen() {
  const toast = useToast();
  const router = useRouter();
  const [address, setAddress] = useState<string | null>(null);
  const [pinSet, setPinSet] = useState(false);
  const [bioOn, setBioOn] = useState(false);
  const kyc = useKycVerified();
  const verified = kyc.data === true;
  const { data: backup } = useBackupMeta();
  const backupOn = backup?.enabled === true;

  useEffect(() => {
    let active = true;
    ensureAccount()
      .then((a) => active && setAddress(a.address))
      .catch(() => active && setAddress(null));
    return () => {
      active = false;
    };
  }, []);

  // Refresh security state on focus (e.g. after setting a PIN).
  useFocusEffect(
    useCallback(() => {
      let active = true;
      Promise.all([hasPin(), canUseBiometrics()]).then(([p, b]) => {
        if (active) {
          setPinSet(p);
          setBioOn(b);
        }
      });
      return () => {
        active = false;
      };
    }, []),
  );

  const onCopy = async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    toast.success('Address copied');
  };

  const short = address ? `${address.slice(0, 8)}…${address.slice(-6)}` : 'Loading…';

  return (
    <Screen scroll>
      <Card style={styles.addrCard}>
        <Text style={styles.cardLabel}>Your Stellar address</Text>
        <Text style={styles.hint}>Where money is received on Stellar. Safe to share.</Text>
        <View style={styles.qrWrap}>
          {address ? (
            <View style={styles.qrBox}>
              <QRCode value={address} size={168} backgroundColor="#FFFFFF" color="#0E0E11" />
            </View>
          ) : (
            <View style={[styles.qrBox, styles.qrPlaceholder]} />
          )}
        </View>
        <Pressable
          onPress={onCopy}
          disabled={!address}
          style={({ pressed }) => [styles.addrPill, pressed && styles.pressed]}>
          <Text style={styles.addrMono} numberOfLines={1}>
            {short}
          </Text>
          <Copy color={Palette.accent} size={16} strokeWidth={2} />
        </Pressable>
      </Card>

      <Text style={styles.section}>Backup & recovery</Text>
      <Card style={styles.statusCard}>
        <Pressable onPress={() => router.push('/backup')} style={styles.statusRowPress}>
          <Cloud color={Palette.textSecondary} size={18} strokeWidth={1.8} />
          <Text style={styles.statusLabel}>Cloud backup</Text>
          <Text
            style={[
              styles.statusValue,
              { color: backupOn ? Palette.accent : Palette.textMuted },
            ]}>
            {backupOn ? (backup?.account ?? 'On') : 'Set up'}
          </Text>
          <ChevronRight color={Palette.textMuted} size={18} />
        </Pressable>
        <StatusRow
          Icon={KeyRound}
          label="Recovery PIN"
          value={pinSet ? 'Set' : 'Not set'}
          tone={pinSet ? 'ok' : 'muted'}
        />
        <StatusRow
          Icon={Fingerprint}
          label="Biometric lock"
          value={bioOn ? 'On' : 'Unavailable'}
          tone={bioOn ? 'ok' : 'muted'}
        />
        <StatusRow Icon={UsersRound} label="Social recovery" value="Coming soon" tone="muted" />
      </Card>
      <Text style={styles.note}>
        {backupOn
          ? 'Your account is backed up. On a new phone, choose “Restore account” and enter your PIN.'
          : 'Turn on cloud backup so your account survives a lost phone. Without it, this device is the only copy.'}
      </Text>

      <Text style={styles.section}>Identity</Text>
      <Card style={styles.statusCard}>
        <StatusRow
          Icon={ShieldCheck}
          label="KYC status"
          value={verified ? 'Verified' : 'Not verified'}
          tone={verified ? 'ok' : 'muted'}
        />
      </Card>
    </Screen>
  );
}

function StatusRow({
  Icon,
  label,
  value,
  tone,
}: {
  Icon: IconType;
  label: string;
  value: string;
  tone: Tone;
}) {
  return (
    <View style={styles.statusRow}>
      <Icon color={Palette.textSecondary} size={18} strokeWidth={1.8} />
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={[styles.statusValue, { color: tone === 'ok' ? Palette.accent : Palette.textMuted }]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  addrCard: { alignItems: 'center', gap: Spacing.two, marginBottom: Spacing.six },
  cardLabel: { ...Typography.section, color: Palette.white },
  hint: { ...Typography.micro, color: Palette.textMuted, textAlign: 'center' },
  qrWrap: { marginVertical: Spacing.four },
  qrBox: {
    padding: Spacing.four,
    backgroundColor: '#FFFFFF',
    borderRadius: Radius.input,
  },
  qrPlaceholder: { width: 200, height: 200, backgroundColor: Palette.bgElevated },
  addrPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: Palette.bgElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    maxWidth: '100%',
  },
  addrMono: { ...Typography.caption, color: Palette.white },
  pressed: { opacity: 0.6 },
  section: {
    ...Typography.caption,
    color: Palette.textSecondary,
    textTransform: 'uppercase',
    marginBottom: Spacing.two,
    marginTop: Spacing.three,
  },
  statusCard: { gap: Spacing.four, marginBottom: Spacing.three },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  statusRowPress: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  statusLabel: { ...Typography.body, color: Palette.white, flex: 1 },
  statusValue: { ...Typography.caption, fontWeight: '600' },
  note: { ...Typography.micro, color: Palette.textMuted, marginBottom: Spacing.six },
});

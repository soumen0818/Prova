import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import {
  ChevronRight,
  LogOut,
  QrCode,
  Settings,
  ShieldCheck,
  UsersRound,
  Wallet,
} from 'lucide-react-native';
import type { ComponentType } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import { formatMinor } from '@/lib/balance';
import { useBalance, useKycVerified, useSession, QK } from '@/lib/queries';
import { initials } from '@/lib/recipients';
import { clearSession } from '@/lib/session';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

type IconType = ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;

/** Profile tab: account identity, verification status, balance, shortcuts, and sign-out. */
export function ProfileScreen() {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const session = useSession();
  const balance = useBalance();
  const kyc = useKycVerified();
  const verified = kyc.data === true;

  const onSignOut = () => {
    Alert.alert('Sign out?', 'You’ll need your phone number to sign back in.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await clearSession();
          queryClient.setQueryData(QK.session, null);
          toast.info('Signed out');
          router.replace('/');
        },
      },
    ]);
  };

  return (
    <Screen scroll>
      <Text style={styles.title}>Profile</Text>

      <Card style={styles.identityCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(session.data?.name ?? '?')}</Text>
        </View>
        <View style={styles.identityText}>
          <Text style={styles.name}>{session.data?.name ?? '—'}</Text>
          <Text style={styles.phone}>{session.data?.phone ?? '—'}</Text>
        </View>
      </Card>

      <View style={styles.statRow}>
        <Card style={styles.statCard}>
          <Text style={styles.statLabel}>Balance</Text>
          <Text style={styles.statValue}>
            {balance.isLoading ? '—' : formatMinor(balance.data ?? 0)}
          </Text>
        </Card>
        <Pressable style={styles.flex} onPress={() => !verified && router.push('/kyc')}>
          <Card style={styles.statCard}>
            <Text style={styles.statLabel}>Identity</Text>
            <Text
              style={[
                styles.statValue,
                { color: verified ? Palette.accent : Palette.textSecondary },
              ]}>
              {verified ? 'Verified' : 'Verify now'}
            </Text>
          </Card>
        </Pressable>
      </View>

      <View style={styles.menu}>
        <MenuRow
          Icon={QrCode}
          label="Account details"
          onPress={() => router.push('/account')}
        />
        <MenuRow Icon={UsersRound} label="Recipients" onPress={() => router.push('/recipients')} />
        <MenuRow
          Icon={ShieldCheck}
          label={verified ? 'Identity verified' : 'Verify identity'}
          onPress={() => router.push('/kyc')}
        />
        <MenuRow Icon={Wallet} label="Add money" onPress={() => router.push('/deposit')} />
        <MenuRow Icon={Settings} label="Settings" onPress={() => router.push('/settings')} />
      </View>

      <Card style={styles.privacyCard}>
        <ShieldCheck color={Palette.accent} size={18} strokeWidth={2} />
        <Text style={styles.privacyText}>
          Your amount is proved compliant on this device and never leaves it — only a commitment is
          written on-chain.
        </Text>
      </Card>

      <Pressable
        style={({ pressed }) => [styles.signOut, pressed && styles.signOutPressed]}
        onPress={onSignOut}>
        <LogOut color={Palette.statusDown} size={18} strokeWidth={2} />
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </Screen>
  );
}

function MenuRow({ Icon, label, onPress }: { Icon: IconType; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}>
      <Icon color={Palette.white} size={20} strokeWidth={1.8} />
      <Text style={styles.menuLabel}>{label}</Text>
      <ChevronRight color={Palette.textMuted} size={20} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: { ...Typography.title, color: Palette.white, marginBottom: Spacing.five },
  flex: { flex: 1 },
  identityCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.four,
    marginBottom: Spacing.four,
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: Radius.full,
    backgroundColor: Palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { ...Typography.title, color: Palette.onAccent },
  identityText: { flex: 1 },
  name: { ...Typography.title, color: Palette.white },
  phone: { ...Typography.caption, color: Palette.textSecondary },
  statRow: { flexDirection: 'row', gap: Spacing.three, marginBottom: Spacing.six },
  statCard: { flex: 1, gap: Spacing.one, padding: Spacing.four },
  statLabel: { ...Typography.micro, color: Palette.textSecondary, textTransform: 'uppercase' },
  statValue: { ...Typography.section, color: Palette.white },
  menu: { gap: Spacing.two, marginBottom: Spacing.six },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: Palette.bgElevated,
    borderRadius: Radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
  },
  menuRowPressed: { backgroundColor: Palette.bgSelected },
  menuLabel: { ...Typography.body, color: Palette.white, flex: 1 },
  privacyCard: {
    flexDirection: 'row',
    gap: Spacing.three,
    alignItems: 'flex-start',
    marginBottom: Spacing.six,
  },
  privacyText: { ...Typography.caption, color: Palette.textSecondary, flex: 1 },
  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.four,
  },
  signOutPressed: { opacity: 0.6 },
  signOutText: { ...Typography.button, fontSize: 15, color: Palette.statusDown },
});

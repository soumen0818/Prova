import { useRouter } from 'expo-router';
import {
  ArrowDownToLine,
  ArrowUpRight,
  ChevronRight,
  Plus,
  Settings,
  ShieldCheck,
} from 'lucide-react-native';
import type { ComponentType } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, GlassIconButton, Screen } from '@/components/ui';
import { env } from '@/config/env';
import { formatMinor } from '@/lib/balance';
import { useRequireKyc } from '@/hooks/use-require-kyc';
import { useBalance, useHistory, useKycVerified, useRecipients, useSession } from '@/lib/queries';
import { initials, type Recipient } from '@/lib/recipients';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

type IconType = ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;

/** Home tab: greeting, private balance, quick actions, saved recipients, recent activity. */
export function HomeScreen({ onNavigateTab }: { onNavigateTab: (tab: 'activity') => void }) {
  const router = useRouter();
  const requireKyc = useRequireKyc();
  const session = useSession();
  const balance = useBalance();
  const recipients = useRecipients();
  const kyc = useKycVerified();
  const history = useHistory();

  const firstName = (session.data?.name ?? '').split(' ')[0] || 'there';
  const verified = kyc.data === true;
  const recent = (history.data ?? []).slice(0, 3);

  return (
    <Screen scroll>
      {/* Greeting + settings */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Hi, {firstName}</Text>
          <Text style={styles.subGreeting}>Send money home, privately</Text>
        </View>
        <GlassIconButton accessibilityLabel="Settings" onPress={() => router.push('/settings')}>
          <Settings color={Palette.white} size={20} strokeWidth={1.8} />
        </GlassIconButton>
      </View>

      {/* Balance card */}
      <Card tone="accent" style={styles.balanceCard}>
        <View style={styles.balanceTopRow}>
          <Text style={styles.balanceLabel}>Available balance</Text>
          <View style={styles.netChip}>
            <Text style={styles.netChipText}>{env.network}</Text>
          </View>
        </View>
        <Text style={styles.balanceValue}>
          {balance.isLoading ? '—' : formatMinor(balance.data ?? 0)}
        </Text>
        <View style={styles.balanceActions}>
          <BalanceButton
            label="Add money"
            Icon={ArrowDownToLine}
            onPress={() => requireKyc(() => router.push('/deposit'))}
          />
          <BalanceButton
            label="Send"
            Icon={ArrowUpRight}
            onPress={() => requireKyc(() => router.push('/send'))}
          />
        </View>
      </Card>

      {/* KYC gate */}
      {!verified ? (
        <Pressable onPress={() => router.push('/kyc')}>
          <Card style={styles.kycCard}>
            <ShieldCheck color={Palette.accent} size={22} strokeWidth={2} />
            <View style={styles.kycText}>
              <Text style={styles.kycTitle}>Verify your identity</Text>
              <Text style={styles.kycBody}>One quick check unlocks private transfers.</Text>
            </View>
            <ChevronRight color={Palette.textMuted} size={20} />
          </Card>
        </Pressable>
      ) : null}

      {/* Recipients */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Recipients</Text>
        <Pressable onPress={() => router.push('/recipients')} hitSlop={8}>
          <Text style={styles.link}>Manage</Text>
        </Pressable>
      </View>
      <View style={styles.recipientsRow}>
        <Pressable style={styles.addRecipient} onPress={() => router.push('/recipient-new')}>
          <View style={styles.addCircle}>
            <Plus color={Palette.white} size={22} strokeWidth={2} />
          </View>
          <Text style={styles.recipientName}>Add</Text>
        </Pressable>
        {(recipients.data ?? []).slice(0, 4).map((r) => (
          <RecipientChip
            key={r.id}
            recipient={r}
            onPress={() =>
              requireKyc(() => router.push({ pathname: '/send', params: { recipientId: r.id } }))
            }
          />
        ))}
      </View>

      {/* Recent activity */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Recent activity</Text>
        <Pressable onPress={() => onNavigateTab('activity')} hitSlop={8}>
          <Text style={styles.link}>See all</Text>
        </Pressable>
      </View>
      {recent.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyText}>
            No transfers yet — your private sends will show here.
          </Text>
        </Card>
      ) : (
        <View style={styles.activityList}>
          {recent.map((t) => (
            <View key={t.transferId} style={styles.activityRow}>
              <View style={styles.activityIcon}>
                <ArrowUpRight color={Palette.white} size={18} strokeWidth={2} />
              </View>
              <View style={styles.activityMain}>
                <Text style={styles.activityTitle}>Private transfer</Text>
                <Text style={styles.activityDate}>{t.createdAt.slice(0, 10)}</Text>
              </View>
              <Text style={[styles.activityStatus, { color: statusColor(t.status) }]}>
                {t.status}
              </Text>
            </View>
          ))}
        </View>
      )}
    </Screen>
  );
}

function BalanceButton({
  label,
  Icon,
  onPress,
}: {
  label: string;
  Icon: IconType;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.balanceBtn, pressed && styles.balanceBtnPressed]}>
      <Icon color={Palette.onAccent} size={18} strokeWidth={2.2} />
      <Text style={styles.balanceBtnLabel}>{label}</Text>
    </Pressable>
  );
}

function RecipientChip({ recipient, onPress }: { recipient: Recipient; onPress: () => void }) {
  return (
    <Pressable style={styles.addRecipient} onPress={onPress}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initials(recipient.name)}</Text>
      </View>
      <Text style={styles.recipientName} numberOfLines={1}>
        {recipient.name.split(' ')[0]}
      </Text>
    </Pressable>
  );
}

function statusColor(status: string): string {
  if (status === 'confirmed') return Palette.statusUp;
  if (status === 'rejected' || status === 'failed') return Palette.statusDown;
  return Palette.textSecondary;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: Spacing.five,
  },
  greeting: { ...Typography.title, fontSize: 24, color: Palette.white },
  subGreeting: { ...Typography.caption, color: Palette.textSecondary },
  balanceCard: { gap: Spacing.four, marginBottom: Spacing.five },
  balanceTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  balanceLabel: { ...Typography.caption, color: 'rgba(17,19,26,0.7)', fontWeight: '600' },
  netChip: {
    backgroundColor: 'rgba(17,19,26,0.12)',
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.three,
    paddingVertical: 2,
  },
  netChipText: { ...Typography.micro, color: Palette.onAccent, textTransform: 'uppercase' },
  balanceValue: { ...Typography.displayBalance, color: Palette.onAccent },
  balanceActions: { flexDirection: 'row', gap: Spacing.three },
  balanceBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    backgroundColor: 'rgba(17,19,26,0.10)',
    borderRadius: Radius.input,
    paddingVertical: Spacing.three,
  },
  balanceBtnPressed: { backgroundColor: 'rgba(17,19,26,0.18)' },
  balanceBtnLabel: { ...Typography.button, fontSize: 15, color: Palette.onAccent },
  kycCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    marginBottom: Spacing.five,
    padding: Spacing.four,
  },
  kycText: { flex: 1 },
  kycTitle: { ...Typography.section, color: Palette.white },
  kycBody: { ...Typography.caption, color: Palette.textSecondary },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.three,
  },
  sectionTitle: { ...Typography.section, color: Palette.white },
  link: { ...Typography.caption, color: Palette.accent, fontWeight: '600' },
  recipientsRow: { flexDirection: 'row', gap: Spacing.four, marginBottom: Spacing.six },
  addRecipient: { alignItems: 'center', gap: Spacing.two, width: 60 },
  addCircle: {
    width: 52,
    height: 52,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Palette.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.bgElevated,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: Radius.full,
    backgroundColor: Palette.bgSelected,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { ...Typography.section, color: Palette.white },
  recipientName: { ...Typography.micro, color: Palette.textSecondary },
  emptyCard: { padding: Spacing.four },
  emptyText: { ...Typography.caption, color: Palette.textSecondary },
  activityList: { gap: Spacing.two },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: Palette.bgElevated,
    borderRadius: Radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.three,
  },
  activityIcon: {
    width: 38,
    height: 38,
    borderRadius: Radius.full,
    backgroundColor: Palette.bgSelected,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityMain: { flex: 1 },
  activityTitle: { ...Typography.body, color: Palette.white },
  activityDate: { ...Typography.micro, color: Palette.textMuted },
  activityStatus: { ...Typography.micro, fontWeight: '600', textTransform: 'capitalize' },
});

import { useRouter } from 'expo-router';
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowUpRight,
  ChevronRight,
  CircleAlert,
  Clock,
  Plus,
  Settings,
  ShieldCheck,
} from 'lucide-react-native';
import type { ComponentType } from 'react';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, GlassIconButton, Screen } from '@/components/ui';
import { env } from '@/config/env';
import { activityStatus, describeActivity } from '@/lib/activity';
import { formatBalance } from '@/lib/balance';
import { useRequireKyc } from '@/hooks/use-require-kyc';
import { useActivity, useKycVerified, useRecipients } from '@/lib/queries';
import { useMoney } from '@/hooks/use-money';
import { initials, type Recipient } from '@/lib/recipients';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

type IconType = ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;

/** Home tab: greeting, private balance, quick actions, saved recipients, recent activity. */
export function HomeScreen({ onNavigateTab }: { onNavigateTab: (tab: 'activity') => void }) {
  const router = useRouter();
  const requireKyc = useRequireKyc();
  const money = useMoney();
  const recipients = useRecipients();
  const kyc = useKycVerified();
  const activity = useActivity();

  const verified = kyc.data === true;
  // The same on-device log the Activity tab reads. Home used to read the server's transfer list,
  // which is always empty in pool mode — so it said "No transfers yet" to someone who had just
  // watched money move. Two screens describing the same account differently is worse than either
  // being wrong on its own.
  const recent = (activity.data ?? []).slice(0, 3);

  return (
    <Screen scroll>
      {/* Greeting + settings */}
      <View style={styles.header}>
        {/*
          No name here, deliberately. The legal name is compliance data the anchor requires — it is
          not a display preference, and putting a real name on the home screen of a privacy product
          is the wrong signal. The product promise leads instead.
        */}
        <View>
          {/*
            The wordmark as artwork rather than text, so the brand letterforms are the real ones
            instead of whatever the system font approximates. This is the transparent 29 KB export;
            `assets/Brand core/Wordmark.png` is the same artwork at print resolution (4.9 MB) and has
            no business inside an APK.

            accessibilityLabel carries the word itself — a screen reader would otherwise announce
            nothing where the app's name used to be.
          */}
          <Image
            source={require('@/assets/images/brand-wordmark.png')}
            style={styles.wordmark}
            contentFit="contain"
            accessible
            accessibilityLabel="Prova"
          />
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
          {money.isLoading
            ? '—'
            : formatBalance(money.spendable, money.denom, 'No money added yet')}
        </Text>
        {/*
          Confirming money is shown separately and never added to the figure above. A note cannot
          move until its fold lands, so summing them would invite a tap on money that can't go
          anywhere — and the refusal would come from the contract instead of the screen.

          But it is named when we know what it is. After paying 200 from a 900 note, 700 returns as
          change and waits here — and "700.00 XLM confirming" beside a 200 payment reads as something
          having gone wrong with a sum three times larger than the one that was sent. The figure is
          correct and the sentence still alarms. Calling it change makes it obvious instead.
        */}
        {money.pending > 0 ? (
          <Text style={styles.pendingNote}>
            {money.pendingIsChange
              ? `${formatBalance(money.pending, money.denom)} change coming back — a few seconds`
              : `${formatBalance(money.pending, money.denom)} confirming — usually a few seconds`}
          </Text>
        ) : null}
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
            Nothing yet — money you add, send or receive shows up here.
          </Text>
        </Card>
      ) : (
        <View style={styles.activityList}>
          {recent.map((entry) => {
            const status = activityStatus(entry);
            const meta = describeActivity(entry.kind, status);
            // A row that did not complete must not be read at a glance as one that did: the amount
            // is muted, and struck through once it is certain the money never moved.
            const amountColor =
              status === 'complete'
                ? meta.positive
                  ? Palette.statusUp
                  : Palette.white
                : Palette.textMuted;
            return (
              <View key={entry.id} style={styles.activityRow}>
                <View style={styles.activityIcon}>
                  {status === 'failed' ? (
                    <CircleAlert color={Palette.textMuted} size={18} strokeWidth={2} />
                  ) : status === 'pending' ? (
                    <Clock color={Palette.accent} size={18} strokeWidth={2} />
                  ) : meta.positive ? (
                    <ArrowDownLeft color={Palette.statusUp} size={18} strokeWidth={2} />
                  ) : (
                    <ArrowUpRight color={Palette.white} size={18} strokeWidth={2} />
                  )}
                </View>
                <View style={styles.activityMain}>
                  <Text style={styles.activityTitle}>{meta.label}</Text>
                  <Text style={styles.activityDate}>{formatWhen(entry.at)}</Text>
                </View>
                <Text
                  style={[
                    styles.activityStatus,
                    { color: amountColor },
                    status === 'failed' && styles.activityStruck,
                  ]}>
                  {meta.sign}
                  {formatBalance(entry.amountMinor, money.denom, String(entry.amountMinor / 100))}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

/** Relative for the recent past, a date after that — the same rule the Activity tab uses. */
function formatWhen(atSeconds: number): string {
  const date = new Date(atSeconds * 1000);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) {
    const hours = Math.floor(minutes / 60);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
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

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: Spacing.five,
  },
  // 1024x338 source → 3.03:1. Height drives the size; width follows the ratio exactly so the
  // letterforms are never stretched.
  wordmark: { width: 97, height: 32, marginBottom: 2 },
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
  pendingNote: { ...Typography.micro, color: 'rgba(17,19,26,0.7)', marginTop: Spacing.one },
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
  activityStruck: { textDecorationLine: 'line-through' },
});

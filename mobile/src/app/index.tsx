import { useRouter } from 'expo-router';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Bell,
  Clock,
  Settings,
  ShieldCheck,
} from 'lucide-react-native';
import type { ComponentType } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Card, GlassIconButton, Screen } from '@/components/ui';
import { env } from '@/config/env';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

type IconType = ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;

const QUICK_ACTIONS: { label: string; Icon: IconType }[] = [
  { label: 'Send', Icon: ArrowUpRight },
  { label: 'Request', Icon: ArrowDownToLine },
  { label: 'Deposit', Icon: ArrowDownToLine },
  { label: 'History', Icon: Clock },
];

export default function HomeScreen() {
  const router = useRouter();
  return (
    <Screen scroll>
      {/* Top bar */}
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>R</Text>
        </View>
        <View style={styles.headerActions}>
          <GlassIconButton badge accessibilityLabel="Notifications">
            <Bell color={Palette.white} size={20} strokeWidth={1.8} />
          </GlassIconButton>
          <GlassIconButton accessibilityLabel="Settings">
            <Settings color={Palette.white} size={20} strokeWidth={1.8} />
          </GlassIconButton>
        </View>
      </View>

      {/* Balance */}
      <View style={styles.balanceBlock}>
        <Text style={styles.balanceCaption}>Total balance</Text>
        <Text style={styles.balance}>
          AED 10,560<Text style={styles.balanceDecimals}>.00</Text>
        </Text>
      </View>

      {/* Quick actions */}
      <View style={styles.quickRow}>
        {QUICK_ACTIONS.map(({ label, Icon }) => (
          <View key={label} style={styles.quickItem}>
            <GlassIconButton size={56} accessibilityLabel={label}>
              <Icon color={Palette.white} size={22} strokeWidth={1.8} />
            </GlassIconButton>
            <Text style={styles.quickLabel}>{label}</Text>
          </View>
        ))}
      </View>

      {/* Highlight cards */}
      <View style={styles.cardRow}>
        <Card tone="accent" style={styles.halfCard}>
          <Text style={[styles.cardTitle, styles.onAccent]}>Send privately</Text>
          <Text style={[styles.cardSubtitle, styles.onAccent]}>UAE → India</Text>
          <Text style={[styles.cardValue, styles.onAccent]}>Ready</Text>
        </Card>
        <Card tone="lilac" style={styles.halfCard}>
          <View style={styles.cardIconRow}>
            <ShieldCheck color={Palette.onAccent} size={18} strokeWidth={2} />
          </View>
          <Text style={[styles.cardTitle, styles.onAccent]}>Privacy</Text>
          <Text style={[styles.cardValue, styles.onAccent]}>Active</Text>
        </Card>
      </View>

      {/* Style preview — confirms the design system renders. Remove once real screens land. */}
      <Text style={styles.sectionTitle}>Foundation preview</Text>
      <View style={styles.previewGroup}>
        <Button
          label="Deposit (testnet)"
          trailing={<ArrowDownToLine color={Palette.onAccent} size={18} />}
          onPress={() => router.push('/deposit')}
        />
        <Button
          label="Verify identity (KYC)"
          variant="secondary"
          onPress={() => router.push('/kyc')}
        />
        <Button label="Learn how proofs work" variant="glass" />
      </View>
      <Text style={styles.note}>
        Prova design system is live — Urbanist type, chartreuse accent, glass controls, dark
        surfaces.
      </Text>
      <Text style={styles.note}>{`@prova/shared v${env.schemaVersion} · ${env.network}`}</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.six,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: Radius.full,
    backgroundColor: Palette.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
  },
  avatarText: {
    ...Typography.section,
    color: Palette.white,
  },
  headerActions: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  balanceBlock: {
    alignItems: 'center',
    marginBottom: Spacing.seven,
  },
  balanceCaption: {
    ...Typography.caption,
    color: Palette.textSecondary,
    marginBottom: Spacing.two,
  },
  balance: {
    ...Typography.displayBalance,
    color: Palette.white,
  },
  balanceDecimals: {
    color: Palette.textMuted,
  },
  quickRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.seven,
  },
  quickItem: {
    alignItems: 'center',
    gap: Spacing.two,
  },
  quickLabel: {
    ...Typography.micro,
    color: Palette.textSecondary,
  },
  cardRow: {
    flexDirection: 'row',
    gap: Spacing.four,
    marginBottom: Spacing.seven,
  },
  halfCard: {
    flex: 1,
    minHeight: 120,
    justifyContent: 'space-between',
  },
  cardIconRow: {
    flexDirection: 'row',
  },
  cardTitle: {
    ...Typography.section,
  },
  cardSubtitle: {
    ...Typography.caption,
    opacity: 0.7,
  },
  cardValue: {
    ...Typography.title,
  },
  onAccent: {
    color: Palette.onAccent,
  },
  sectionTitle: {
    ...Typography.section,
    color: Palette.white,
    marginBottom: Spacing.four,
  },
  previewGroup: {
    gap: Spacing.three,
    marginBottom: Spacing.five,
  },
  note: {
    ...Typography.caption,
    color: Palette.textMuted,
    textAlign: 'center',
  },
});

import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { ArrowDownToLine, ArrowUpRight, Clock, Settings, ShieldCheck } from 'lucide-react-native';
import type { ComponentType } from 'react';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { GlassIconButton, Screen } from '@/components/ui';
import { env } from '@/config/env';
import { useHealth } from '@/lib/queries';
import { hasSecret, SecureKey } from '@/lib/secure-store';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

type IconType = ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
type QuickAction = {
  label: string;
  Icon: IconType;
  route: '/send' | '/deposit' | '/kyc' | '/activity';
};

const QUICK_ACTIONS: QuickAction[] = [
  { label: 'Send', Icon: ArrowUpRight, route: '/send' },
  { label: 'Deposit', Icon: ArrowDownToLine, route: '/deposit' },
  { label: 'Verify', Icon: ShieldCheck, route: '/kyc' },
  { label: 'Activity', Icon: Clock, route: '/activity' },
];

export default function HomeScreen() {
  const router = useRouter();
  const health = useHealth();
  const [verified, setVerified] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    hasSecret(SecureKey.kycCredential).then((v) => {
      if (active) setVerified(v);
    });
    return () => {
      active = false;
    };
  }, []);

  const online = !health.isError && health.data != null;

  return (
    <Screen scroll>
      {/* Top bar: brand logo + settings */}
      <View style={styles.header}>
        <Image
          source={require('@/assets/images/brand-wordmark.png')}
          style={styles.wordmark}
          contentFit="contain"
        />
        <GlassIconButton accessibilityLabel="Settings" onPress={() => router.push('/settings')}>
          <Settings color={Palette.white} size={20} strokeWidth={1.8} />
        </GlassIconButton>
      </View>

      {/* Wallet status — honest, no fake balance */}
      <View style={styles.walletCard}>
        <Text style={styles.walletTitle}>Private wallet</Text>
        <View style={styles.chipRow}>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{env.network}</Text>
          </View>
          <StatusRow
            label="Identity"
            value={verified == null ? '…' : verified ? 'Verified' : 'Not verified'}
            color={verified ? Palette.accent : Palette.textSecondary}
          />
          <StatusRow
            label="Backend"
            value={health.isLoading ? '…' : online ? 'Online' : 'Offline'}
            color={online ? Palette.statusUp : Palette.statusDown}
          />
        </View>
      </View>

      {/* Quick actions */}
      <View style={styles.quickRow}>
        {QUICK_ACTIONS.map(({ label, Icon, route }) => (
          <View key={label} style={styles.quickItem}>
            <GlassIconButton
              size={56}
              accessibilityLabel={label}
              onPress={() => router.push(route)}>
              <Icon color={Palette.white} size={22} strokeWidth={1.8} />
            </GlassIconButton>
            <Text style={styles.quickLabel}>{label}</Text>
          </View>
        ))}
      </View>

      {/* Privacy explainer */}
      <View style={styles.explainer}>
        <ShieldCheck color={Palette.accent} size={18} strokeWidth={2} />
        <Text style={styles.explainerText}>
          Your amount is proved compliant on this device and never leaves it — only a commitment is
          written on-chain.
        </Text>
      </View>

      <Text style={styles.note}>{`@prova/shared v${env.schemaVersion} · ${env.network}`}</Text>
    </Screen>
  );
}

function StatusRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={[styles.statusValue, { color }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.six,
  },
  wordmark: { width: 104, height: 30 },
  walletCard: {
    backgroundColor: Palette.bgElevated,
    borderRadius: Radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.five,
    marginBottom: Spacing.seven,
    gap: Spacing.four,
  },
  walletTitle: { ...Typography.section, color: Palette.white },
  chipRow: { gap: Spacing.three },
  chip: {
    alignSelf: 'flex-start',
    backgroundColor: Palette.glass,
    borderColor: Palette.glassBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  chipText: { ...Typography.micro, color: Palette.textSecondary, textTransform: 'uppercase' },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statusLabel: { ...Typography.caption, color: Palette.textSecondary },
  statusValue: { ...Typography.caption, fontWeight: '600' },
  quickRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: Spacing.seven },
  quickItem: { alignItems: 'center', gap: Spacing.two },
  quickLabel: { ...Typography.micro, color: Palette.textSecondary },
  explainer: {
    flexDirection: 'row',
    gap: Spacing.three,
    alignItems: 'flex-start',
    backgroundColor: Palette.bgElevated,
    borderRadius: Radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    padding: Spacing.four,
    marginBottom: Spacing.six,
  },
  explainerText: { ...Typography.caption, color: Palette.textSecondary, flex: 1 },
  note: { ...Typography.caption, color: Palette.textMuted, textAlign: 'center' },
});

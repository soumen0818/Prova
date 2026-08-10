import { ArrowDownLeft, ArrowUpRight, Banknote, ChevronRight, Plus } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ActivityEntry, ActivityKind } from '@/lib/activity';
import { formatBalance } from '@/lib/balance';
import { useActivity, useDenomination } from '@/lib/queries';
import { EmptyMark } from '@/components/illustrations';
import { Loader } from '@/components/loader';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui';
import { TransactionSheet } from '@/components/transaction-sheet';
import { BottomTabInset, Palette, Radius, Spacing, Typography } from '@/constants/theme';

/**
 * Activity tab: what this wallet has done, read from the device.
 *
 * Deliberately not a server call. The backend never learns an amount — that is the whole point of
 * the pool — so a server-rendered history could only ever show opaque commitments, and asking for
 * "my transfers" would hand over the very link between a person and their notes that the design
 * exists to break. The device already knows, so the device is what we ask.
 */
export function ActivityScreen() {
  const router = useRouter();
  const { data, isLoading, refetch, isRefetching } = useActivity();
  const { data: denom } = useDenomination();

  // Which entry the detail sheet is showing. Held here rather than in the row so only one sheet can
  // ever be open, and so it survives the list re-rendering underneath it during a refresh.
  const [selected, setSelected] = useState<ActivityEntry | null>(null);
  const close = useCallback(() => setSelected(null), []);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <Text style={styles.title}>Activity</Text>

      {isLoading ? (
        <View style={styles.center}>
          <Loader size={12} />
        </View>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(e) => e.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={Palette.accent}
            />
          }
          ListEmptyComponent={
            <StateView
              fullscreen={false}
              illustration={<EmptyMark />}
              title="Nothing here yet"
              body="Money you add, send or receive shows up here. Only this phone keeps this list — the amounts are never sent to us."
              primaryLabel="Add money"
              onPrimary={() => router.push('/deposit')}
            />
          }
          ListFooterComponent={
            (data?.length ?? 0) > 0 ? <Text style={styles.footer}>{FOOTER}</Text> : null
          }
          renderItem={({ item }) => (
            <Row item={item} denom={denom} onPress={() => setSelected(item)} />
          )}
        />
      )}

      <TransactionSheet entry={selected} denom={denom} onClose={close} />
    </SafeAreaView>
  );
}

/**
 * Why this list is on the phone and not on a server, said in one sentence a person can act on.
 *
 * The previous wording led with "stored on your phone only", which reads as a limitation. The point
 * is the opposite: the amounts are not on a server because there is no server that has them. The
 * consequence a user actually needs to know — a new phone starts this list empty — comes second.
 */
const FOOTER =
  'Only your phone has this list. Prova never receives your amounts, so there is nothing for us to keep — which also means a new phone starts the list again.';

function Row({
  item,
  denom,
  onPress,
}: {
  item: ActivityEntry;
  denom: Parameters<typeof formatBalance>[1];
  onPress: () => void;
}) {
  const meta = kindMeta(item.kind);
  const Icon = meta.Icon;
  const amount = formatBalance(item.amountMinor, denom, String(item.amountMinor / 100));

  return (
    <Pressable onPress={onPress}>
      <Card style={styles.row}>
        <View style={[styles.icon, { backgroundColor: meta.tint }]}>
          <Icon color={meta.color} size={18} strokeWidth={2} />
        </View>
        <View style={styles.rowMain}>
          <Text style={styles.label}>{meta.label}</Text>
          <Text style={styles.date} numberOfLines={1}>
            {formatWhen(item.at)}
            {item.counterparty ? ` · ${shorten(item.counterparty)}` : ''}
          </Text>
        </View>
        <Text style={[styles.amount, { color: meta.color }]}>
          {meta.sign}
          {amount}
        </Text>
        <ChevronRight color={Palette.textMuted} size={17} strokeWidth={2} />
      </Card>
    </Pressable>
  );
}

function kindMeta(kind: ActivityKind) {
  switch (kind) {
    case 'added':
      return {
        label: 'Added to private balance',
        Icon: Plus,
        sign: '+',
        color: Palette.statusUp,
        tint: 'rgba(126, 217, 87, 0.12)',
      };
    case 'received':
      return {
        label: 'Received',
        Icon: ArrowDownLeft,
        sign: '+',
        color: Palette.statusUp,
        tint: 'rgba(126, 217, 87, 0.12)',
      };
    case 'withdrawn':
      return {
        label: 'Cashed out',
        Icon: Banknote,
        sign: '−',
        color: Palette.white,
        tint: 'rgba(255, 255, 255, 0.08)',
      };
    case 'sent':
    default:
      return {
        label: 'Sent privately',
        Icon: ArrowUpRight,
        sign: '−',
        color: Palette.white,
        tint: 'rgba(255, 255, 255, 0.08)',
      };
  }
}

/**
 * Relative for the recent past, absolute after that.
 *
 * "2 hours ago" is what someone checking whether their transfer went through wants; "12 March" is
 * what they want when scrolling back. Both, at the point each stops being useful.
 */
function formatWhen(atSeconds: number): string {
  const date = new Date(atSeconds * 1000);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) {
    const hours = Math.floor(minutes / 60);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Addresses are long and the middle carries no meaning at a glance. */
function shorten(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.bgBase },
  title: {
    ...Typography.title,
    color: Palette.white,
    paddingHorizontal: Spacing.five,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.four,
  },
  list: {
    paddingHorizontal: Spacing.five,
    paddingBottom: BottomTabInset + Spacing.six,
    gap: Spacing.three,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.eight,
    gap: Spacing.three,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  icon: {
    width: 38,
    height: 38,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMain: { flex: 1, gap: Spacing.one },
  label: { ...Typography.body, color: Palette.white },
  date: { ...Typography.micro, color: Palette.textMuted },
  amount: { ...Typography.body, fontVariant: ['tabular-nums'] },
  footer: {
    ...Typography.micro,
    color: Palette.textMuted,
    lineHeight: 18,
    paddingTop: Spacing.four,
  },
});

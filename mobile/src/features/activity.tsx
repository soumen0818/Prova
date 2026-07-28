import * as WebBrowser from 'expo-web-browser';
import { useCallback } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRouter } from 'expo-router';

import { env } from '@/config/env';
import type { TransferRecord } from '@/lib/api';
import { useHistory } from '@/lib/queries';
import { EmptyMark, OfflineMark } from '@/components/illustrations';
import { Loader } from '@/components/loader';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui';
import { BottomTabInset, Palette, Radius, Spacing, Typography } from '@/constants/theme';

/** Activity tab: recent transfers from the backend (relays + on-chain indexer). Commitments only —
 * amounts are never on-chain. */
export function ActivityScreen() {
  const router = useRouter();
  const { data, isLoading, isError, refetch, isRefetching } = useHistory();

  const openTx = useCallback((txHash?: string) => {
    if (!txHash) return;
    WebBrowser.openBrowserAsync(`https://stellar.expert/explorer/${env.network}/tx/${txHash}`);
  }, []);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <Text style={styles.title}>Activity</Text>

      {isLoading ? (
        <View style={styles.center}>
          <Loader size={12} />
        </View>
      ) : isError ? (
        <StateView
          fullscreen={false}
          illustration={<OfflineMark />}
          title="Couldn’t load activity"
          body="We couldn’t reach Prova to fetch your transfers."
          reassurance="Your funds and history are safe."
          primaryLabel="Try again"
          onPrimary={() => refetch()}
        />
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(t) => t.transferId}
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
              title="No transfers yet"
              body="When you send money, each transfer appears here — with a commitment on-chain and the amount known only to you."
              primaryLabel="Send money"
              onPrimary={() => router.push('/send')}
            />
          }
          renderItem={({ item }) => <Row item={item} onPress={() => openTx(item.txHash)} />}
        />
      )}
    </SafeAreaView>
  );
}

function Row({ item, onPress }: { item: TransferRecord; onPress: () => void }) {
  const status = statusMeta(item.status);
  return (
    <Pressable onPress={onPress} disabled={!item.txHash}>
      <Card style={styles.row}>
        <View style={styles.rowMain}>
          <Text style={styles.commitment}>{item.commitment.slice(0, 10)}…</Text>
          <Text style={styles.date}>{item.createdAt.slice(0, 10)}</Text>
        </View>
        <View style={[styles.pill, { borderColor: status.color }]}>
          <Text style={[styles.pillText, { color: status.color }]}>{status.label}</Text>
        </View>
      </Card>
    </Pressable>
  );
}

function statusMeta(status: string): { label: string; color: string } {
  switch (status) {
    case 'confirmed':
      return { label: 'Confirmed', color: Palette.statusUp };
    case 'rejected':
    case 'failed':
      return { label: status === 'failed' ? 'Failed' : 'Rejected', color: Palette.statusDown };
    default:
      return { label: 'Pending', color: Palette.textSecondary };
  }
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
  muted: { ...Typography.body, color: Palette.textSecondary },
  hint: { ...Typography.caption, color: Palette.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowMain: { gap: Spacing.one },
  commitment: { ...Typography.body, color: Palette.white, fontVariant: ['tabular-nums'] },
  date: { ...Typography.micro, color: Palette.textMuted },
  pill: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  pillText: { ...Typography.micro, fontWeight: '600' },
});

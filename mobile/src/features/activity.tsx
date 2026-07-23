import * as WebBrowser from 'expo-web-browser';
import { useCallback } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { env } from '@/config/env';
import type { TransferRecord } from '@/lib/api';
import { useHistory } from '@/lib/queries';
import { Loader } from '@/components/loader';
import { Button, Card } from '@/components/ui';
import { BottomTabInset, Palette, Radius, Spacing, Typography } from '@/constants/theme';

/** Activity tab: recent transfers from the backend (relays + on-chain indexer). Commitments only —
 * amounts are never on-chain. */
export function ActivityScreen() {
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
        <View style={styles.center}>
          <Text style={styles.muted}>Couldn’t load activity.</Text>
          <Button label="Retry" variant="secondary" onPress={() => refetch()} fullWidth={false} />
        </View>
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
            <View style={styles.center}>
              <Text style={styles.muted}>No transfers yet.</Text>
              <Text style={styles.hint}>Your private transfers will appear here.</Text>
            </View>
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

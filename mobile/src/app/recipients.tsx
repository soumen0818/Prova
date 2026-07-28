import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Plus, Send, Trash2 } from 'lucide-react-native';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { EmptyMark } from '@/components/illustrations';
import { StateView } from '@/components/state-view';
import { Button, Card, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useRecipients, QK } from '@/lib/queries';
import { initials, removeRecipient, type Recipient } from '@/lib/recipients';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/** Manage saved beneficiaries. Tap to send; long-press / trash to remove. */
export default function RecipientsScreen() {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: recipients, isLoading } = useRecipients();

  const onRemove = (r: Recipient) => {
    Alert.alert('Remove recipient?', `${r.name} will be removed from your list.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await removeRecipient(r.id);
          await queryClient.invalidateQueries({ queryKey: QK.recipients });
          toast.info('Recipient removed');
        },
      },
    ]);
  };

  const list = recipients ?? [];

  return (
    <Screen scroll>
      {isLoading ? null : list.length === 0 ? (
        <StateView
          fullscreen={false}
          illustration={<EmptyMark />}
          title="No recipients yet"
          body="Add the people you send money to. Saving someone once means you can pay them in a couple of taps next time."
          primaryLabel="Add recipient"
          onPrimary={() => router.push('/recipient-new')}
        />
      ) : (
        <View style={styles.list}>
          {list.map((r) => (
            <Card key={r.id} style={styles.row}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initials(r.name)}</Text>
              </View>
              <View style={styles.info}>
                <Text style={styles.name}>{r.name}</Text>
                <Text style={styles.handle} numberOfLines={1}>
                  {r.handle} · {r.country}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={`Send to ${r.name}`}
                hitSlop={8}
                style={styles.iconBtn}
                onPress={() => router.push({ pathname: '/send', params: { recipientId: r.id } })}>
                <Send color={Palette.accent} size={20} strokeWidth={2} />
              </Pressable>
              <Pressable
                accessibilityLabel={`Remove ${r.name}`}
                hitSlop={8}
                style={styles.iconBtn}
                onPress={() => onRemove(r)}>
                <Trash2 color={Palette.textMuted} size={20} strokeWidth={2} />
              </Pressable>
            </Card>
          ))}
        </View>
      )}

      <Button
        label="Add recipient"
        variant="secondary"
        icon={<Plus color={Palette.white} size={18} strokeWidth={2} />}
        onPress={() => router.push('/recipient-new')}
        style={styles.add}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: Spacing.three, marginBottom: Spacing.four },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three, padding: Spacing.four },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: Radius.full,
    backgroundColor: Palette.bgSelected,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { ...Typography.section, color: Palette.white },
  info: { flex: 1 },
  name: { ...Typography.body, color: Palette.white },
  handle: { ...Typography.micro, color: Palette.textSecondary },
  iconBtn: { padding: Spacing.one },
  empty: {
    alignItems: 'center',
    gap: Spacing.two,
    marginBottom: Spacing.four,
    paddingVertical: Spacing.six,
  },
  emptyTitle: { ...Typography.section, color: Palette.white },
  emptyBody: { ...Typography.caption, color: Palette.textSecondary },
  add: { marginTop: Spacing.two },
});

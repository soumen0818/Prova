import type { SupportMessage } from '@prova/shared';
import { MAX_SUPPORT_BODY_CHARS } from '@prova/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SendHorizontal } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getSupportThread, sendSupportMessage } from '@/lib/api';
import { poolUserId } from '@/lib/pool';
import { QK } from '@/lib/queries';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/** How often to look for a reply while the screen is open. */
const POLL_MS = 5_000;

/**
 * Chat with the Prova team.
 *
 * Polled rather than pushed over a socket. A support thread moves at human speed — a reply arrives
 * minutes apart, not milliseconds — so a five-second poll is indistinguishable to the user and costs
 * a fraction of the complexity of holding a connection open through backgrounding, network changes
 * and reconnection.
 *
 * The conversation is addressed by the same opaque wallet identifier used everywhere else, so the
 * team answering sees a hash, not a person.
 */
export default function SupportScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList<SupportMessage>>(null);

  const { data: userId } = useQuery({ queryKey: ['pool-user-id'], queryFn: poolUserId });

  const thread = useQuery({
    queryKey: QK.support,
    queryFn: () => getSupportThread(userId!),
    enabled: !!userId,
    refetchInterval: POLL_MS,
    placeholderData: (previous) => previous,
  });

  const messages = thread.data?.messages ?? [];

  const send = useMutation({
    mutationFn: (body: string) => sendSupportMessage(userId!, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QK.support }),
  });

  const onSend = useCallback(() => {
    const body = draft.trim();
    if (!body || !userId || send.isPending) return;
    // Cleared optimistically: the message is about to be sent, and leaving the text sitting in the
    // box while it flies makes people press send twice.
    setDraft('');
    send.mutate(body);
  }, [draft, userId, send]);

  // Follow the conversation as it grows. Only on new messages, never on every render, so it does
  // not fight someone scrolling back through what was said.
  useEffect(() => {
    if (messages.length > 0) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [messages.length]);

  const failed = send.isError;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={insets.top + 56}>
      {thread.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Palette.accent} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => String(m.id)}
          contentContainerStyle={styles.list}
          ListHeaderComponent={<Greeting />}
          renderItem={({ item }) => <Bubble message={item} />}
          ListFooterComponent={
            messages.length === 0 ? null : <Text style={styles.privacyNote}>{PRIVACY_NOTE}</Text>
          }
        />
      )}

      {failed ? <Text style={styles.error}>Message not sent. Check your connection.</Text> : null}

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, Spacing.three) }]}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Type your message"
          placeholderTextColor={Palette.textMuted}
          multiline
          maxLength={MAX_SUPPORT_BODY_CHARS}
          editable={!!userId}
        />
        <Pressable
          onPress={onSend}
          disabled={!draft.trim() || send.isPending}
          style={[styles.sendButton, (!draft.trim() || send.isPending) && styles.sendDisabled]}>
          {send.isPending ? (
            <ActivityIndicator size="small" color={Palette.onAccent} />
          ) : (
            <SendHorizontal color={Palette.onAccent} size={18} strokeWidth={2.2} />
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const PRIVACY_NOTE =
  'We will never ask for your PIN or recovery phrase. Anyone who does is not us.';

/**
 * The opening message, shown as a message from the team rather than as a block of page text.
 *
 * A heading and a paragraph read as terms and conditions — something to skim past on the way to the
 * text box. The same words in a chat bubble read as somebody saying hello, which is what makes a
 * person answer rather than close the screen.
 *
 * Two decisions worth keeping:
 *
 *  - It is **rendered on the device, not stored** as a message. A greeting nobody typed should not
 *    become a row in a support record, and it has to appear before the first message, when there is
 *    no conversation on the server at all.
 *  - There is **no fake typing indicator and no delay.** Simulating a person typing when nobody is
 *    there would be a small lie told to somebody who may be anxious about their money. The bubble is
 *    written the way a person writes, and says plainly that a reply is coming rather than pretending
 *    one is already being composed.
 */
function Greeting() {
  return (
    <View style={styles.greetingWrap}>
      <View style={[styles.bubble, styles.theirs]}>
        <Text style={styles.bubbleText}>
          Hi — you’re through to the Prova team. Tell us what’s happened and we’ll look into it.
        </Text>
      </View>
      <View style={[styles.bubble, styles.theirs]}>
        <Text style={styles.bubbleText}>
          Someone replies here, usually within a few hours and always within 24. You can close the
          app — your messages will be waiting when you come back.
        </Text>
      </View>
    </View>
  );
}

function Bubble({ message }: { message: SupportMessage }) {
  const mine = message.author === 'user';
  return (
    <View style={[styles.bubbleRow, mine ? styles.rowRight : styles.rowLeft]}>
      <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
        <Text style={[styles.bubbleText, mine && styles.mineText]}>{message.body}</Text>
        <Text style={[styles.time, mine && styles.mineTime]}>{formatTime(message.sentAt)}</Text>
      </View>
    </View>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) +
        ' ' +
        date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.bgBase },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: Spacing.five, gap: Spacing.three },
  greetingWrap: { gap: Spacing.three, marginBottom: Spacing.three, alignItems: 'flex-start' },
  privacyNote: {
    ...Typography.micro,
    color: Palette.textMuted,
    textAlign: 'center',
    lineHeight: 18,
    paddingTop: Spacing.four,
  },
  bubbleRow: { flexDirection: 'row' },
  rowLeft: { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '82%',
    borderRadius: Radius.card,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    gap: Spacing.one,
  },
  mine: { backgroundColor: Palette.accent, borderBottomRightRadius: Radius.input },
  theirs: { backgroundColor: Palette.bgElevated, borderBottomLeftRadius: Radius.input },
  bubbleText: { ...Typography.body, color: Palette.white, lineHeight: 21 },
  mineText: { color: Palette.onAccent },
  time: { ...Typography.micro, color: Palette.textMuted },
  mineTime: { color: 'rgba(14, 14, 17, 0.55)' },
  error: {
    ...Typography.micro,
    color: Palette.statusDown,
    paddingHorizontal: Spacing.five,
    paddingBottom: Spacing.two,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.three,
    paddingHorizontal: Spacing.five,
    paddingTop: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.border,
    backgroundColor: Palette.bgBase,
  },
  input: {
    flex: 1,
    ...Typography.body,
    color: Palette.white,
    backgroundColor: Palette.bgElevated,
    borderRadius: Radius.card,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    maxHeight: 120,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: Radius.pill,
    backgroundColor: Palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.4 },
});

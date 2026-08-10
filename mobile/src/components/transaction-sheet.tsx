import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { ArrowUpRight, Check, Copy, X } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { env } from '@/config/env';
import type { ActivityEntry } from '@/lib/activity';
import { formatBalance } from '@/lib/balance';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/**
 * Details of one transaction, in a sheet from the bottom.
 *
 * Tapping a row used to jump straight out to a block explorer. That was the wrong default twice
 * over: it threw the user out of the app to a dense technical page to answer a simple question
 * ("what was this?"), and for a **private send it shows nothing useful anyway** — the chain records
 * no amount and no recipient, so the explorer page is less informative than this screen.
 *
 * So the details live here, and the explorer is offered as a link for anyone who wants to verify
 * the transaction independently. Which is the honest ordering: our record first, the public record
 * available on request.
 */
export function TransactionSheet({
  entry,
  denom,
  onClose,
}: {
  entry: ActivityEntry | null;
  denom: Parameters<typeof formatBalance>[1];
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback(async (label: string, value: string) => {
    await Clipboard.setStringAsync(value);
    setCopied(label);
    // Reverts on its own so the tick does not sit there implying the last copy is still "current".
    setTimeout(() => setCopied(null), 1600);
  }, []);

  const openExplorer = useCallback(() => {
    if (!entry?.txHash) return;
    void WebBrowser.openBrowserAsync(
      `https://stellar.expert/explorer/${env.network}/tx/${entry.txHash}`,
    );
  }, [entry]);

  if (!entry) return null;

  const meta = describe(entry.kind);
  const amount = formatBalance(entry.amountMinor, denom, String(entry.amountMinor / 100));

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      {/* Tapping the dimmed area closes, which is what every sheet on this platform does. */}
      <Pressable style={styles.backdrop} onPress={onClose} />

      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, Spacing.five) }]}>
        <View style={styles.grabber} />

        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title}>{meta.title}</Text>
            <Text style={styles.when}>{formatFull(entry.at)}</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close">
            <X color={Palette.textSecondary} size={22} strokeWidth={2} />
          </Pressable>
        </View>

        <Text style={[styles.amount, { color: meta.positive ? Palette.statusUp : Palette.white }]}>
          {meta.sign}
          {amount}
        </Text>

        <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
          <Text style={styles.explain}>{meta.explain}</Text>

          <View style={styles.rows}>
            <Row label="Type" value={meta.title} />
            {entry.counterparty ? <Row label={meta.partyLabel} value={entry.counterparty} /> : null}
            <Row label="Date" value={formatFull(entry.at)} />
            <Row label="Status" value="Completed" tone={Palette.statusUp} />

            {entry.txHash ? (
              <CopyRow
                label="Transaction ID"
                value={entry.txHash}
                copied={copied === 'tx'}
                onCopy={() => copy('tx', entry.txHash!)}
              />
            ) : null}

            {entry.commitment ? (
              <CopyRow
                label="Commitment"
                value={entry.commitment}
                copied={copied === 'commitment'}
                onCopy={() => copy('commitment', entry.commitment!)}
                hint="The sealed record of this note on the blockchain. It proves the transfer happened without revealing the amount."
              />
            ) : null}
          </View>

          {entry.txHash ? (
            <Pressable style={styles.explorer} onPress={openExplorer}>
              <Text style={styles.explorerText}>View on Stellar Explorer</Text>
              <ArrowUpRight color={Palette.accent} size={17} strokeWidth={2} />
            </Pressable>
          ) : null}

          <Text style={styles.footnote}>{meta.footnote}</Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, tone ? { color: tone } : null]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

/** A long identifier: shown truncated, copied in full. */
function CopyRow({
  label,
  value,
  copied,
  onCopy,
  hint,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  hint?: string;
}) {
  return (
    <View style={styles.copyBlock}>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Pressable style={styles.copyButton} onPress={onCopy} hitSlop={8}>
          <Text style={styles.copyValue} numberOfLines={1}>
            {shorten(value)}
          </Text>
          {copied ? (
            <Check color={Palette.statusUp} size={15} strokeWidth={2.4} />
          ) : (
            <Copy color={Palette.textMuted} size={15} strokeWidth={2} />
          )}
        </Pressable>
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {copied ? <Text style={styles.copiedNote}>Copied to clipboard</Text> : null}
    </View>
  );
}

/** What each kind of entry is, and what the person should understand about it. */
function describe(kind: ActivityEntry['kind']) {
  switch (kind) {
    case 'added':
      return {
        title: 'Added to private balance',
        sign: '+',
        positive: true,
        partyLabel: 'From',
        explain: 'You moved money from your public balance into your private balance.',
        footnote:
          'This step is public on the blockchain by design — the anchor you deposited with already knows about it. What stays private is everything you do with the money afterwards.',
      };
    case 'received':
      return {
        title: 'Received',
        sign: '+',
        positive: true,
        partyLabel: 'From',
        explain: 'Somebody sent this to your private balance.',
        footnote:
          'Only your phone could open this payment. The blockchain shows that a transfer happened, but not the amount, and not that it was for you.',
      };
    case 'withdrawn':
      return {
        title: 'Cashed out',
        sign: '−',
        positive: false,
        partyLabel: 'To',
        explain: 'You moved money out of your private balance to a public Stellar address.',
        footnote:
          'A cash-out is public, because the destination has to be paid openly. The proof still hides which of your notes it came from.',
      };
    case 'sent':
    default:
      return {
        title: 'Sent privately',
        sign: '−',
        positive: false,
        partyLabel: 'To',
        explain: 'You sent this from your private balance.',
        footnote:
          'The blockchain recorded a proof for this transfer — not the amount, not who you sent it to, and not that it came from you. The recipient’s name above is stored only on this phone.',
      };
  }
}

/** Long hex is unreadable in full; the ends are what people compare. */
function shorten(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatFull(atSeconds: number): string {
  const date = new Date(atSeconds * 1000);
  return `${date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })} at ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '86%',
    backgroundColor: Palette.bgElevated,
    borderTopLeftRadius: Radius.sheet,
    borderTopRightRadius: Radius.sheet,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    paddingHorizontal: Spacing.five,
    paddingTop: Spacing.three,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Palette.border,
    marginBottom: Spacing.four,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.three },
  headerText: { flex: 1, gap: Spacing.one },
  title: { ...Typography.section, color: Palette.white },
  when: { ...Typography.micro, color: Palette.textMuted },
  amount: {
    ...Typography.displayBalance,
    marginTop: Spacing.four,
    marginBottom: Spacing.two,
    fontVariant: ['tabular-nums'],
  },
  body: { marginTop: Spacing.two },
  explain: { ...Typography.body, color: Palette.textSecondary, marginBottom: Spacing.five },
  rows: {
    borderRadius: Radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    backgroundColor: Palette.bgBase,
    paddingHorizontal: Spacing.four,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.four,
    paddingVertical: Spacing.three,
  },
  rowLabel: { ...Typography.caption, color: Palette.textMuted },
  rowValue: { ...Typography.caption, color: Palette.white, flexShrink: 1, textAlign: 'right' },
  copyBlock: { paddingBottom: Spacing.two },
  copyButton: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, flexShrink: 1 },
  copyValue: { ...Typography.caption, color: Palette.white, fontVariant: ['tabular-nums'] },
  hint: {
    ...Typography.micro,
    color: Palette.textMuted,
    lineHeight: 18,
    paddingBottom: Spacing.two,
  },
  copiedNote: { ...Typography.micro, color: Palette.statusUp, paddingBottom: Spacing.two },
  explorer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    marginTop: Spacing.four,
    paddingVertical: Spacing.four,
    borderRadius: Radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
  },
  explorerText: { ...Typography.body, color: Palette.accent },
  footnote: {
    ...Typography.micro,
    color: Palette.textMuted,
    lineHeight: 19,
    marginTop: Spacing.four,
    marginBottom: Spacing.six,
  },
});

import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { Copy, Share2 } from 'lucide-react-native';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { ErrorMark, ProcessingMark, SuccessMark } from '@/components/illustrations';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui';
import { useToast } from '@/components/toast';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/** Everything shown on a receipt. Assembled by the caller from what it actually knows. */
export interface Receipt {
  amount: string;
  recipientName: string;
  recipientHandle?: string;
  /** Transaction reference — the on-chain tx hash for a confirmed transfer. */
  reference?: string;
  dateTime: string;
  method: string;
  status: string;
}

/**
 * Terminal outcome of a payment: succeeded, failed, or still processing.
 *
 * Kept as one component because the three outcomes must feel like one family — a user who sees the
 * failure screen should recognise the layout from the success screen. Each gives the user exactly
 * the actions that make sense for that outcome, and nothing that doesn't.
 */
export function PaymentResult({
  outcome,
  receipt,
  reasonCode,
  detail,
  onRetry,
  onDone,
}: {
  outcome: 'success' | 'failed' | 'processing';
  receipt: Receipt;
  /** Machine-readable decline reason; drives the explanation and whether retry is offered. */
  reasonCode?: string;
  /**
   * The failure as the server described it, shown when `reasonCode` has no specific copy.
   *
   * Without it every unrecognised failure read "Something went wrong and the payment didn't go
   * through" — true, useless, and identical whether the cause was an expired credential, a rejected
   * proof or a dropped connection. The backend writes its messages for a person to read, so showing
   * one beats inventing a vaguer sentence on top of it.
   */
  detail?: string;
  onRetry?: () => void;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const done = onDone ?? (() => router.replace('/'));

  const shareReceipt = async () => {
    await Share.share({
      message: [
        `Prova payment ${receipt.status}`,
        `Amount: ${receipt.amount}`,
        `To: ${receipt.recipientName}`,
        receipt.reference ? `Reference: ${receipt.reference}` : '',
        `Date: ${receipt.dateTime}`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  };

  if (outcome === 'processing') {
    return (
      <StateView
        illustration={<ProcessingMark />}
        title="Payment processing"
        body="This is taking longer than usual. We're still confirming it with the network."
        reassurance="Your money is safe. Please don't go back or send it again."
        primaryLabel="Done"
        onPrimary={done}>
        <ReceiptCard receipt={receipt} onCopy={() => copyRef(receipt, toast)} />
      </StateView>
    );
  }

  if (outcome === 'failed') {
    const { text, retryable } = declineCopy(reasonCode, detail);
    return (
      <StateView
        illustration={<ErrorMark />}
        title="Payment failed"
        body={text}
        reassurance="You have not been charged."
        primaryLabel={retryable && onRetry ? 'Try again' : 'Done'}
        onPrimary={retryable && onRetry ? onRetry : done}
        secondaryLabel={retryable && onRetry ? 'Back to home' : undefined}
        onSecondary={retryable && onRetry ? done : undefined}>
        <ReceiptCard receipt={receipt} onCopy={() => copyRef(receipt, toast)} />
      </StateView>
    );
  }

  return (
    <StateView
      illustration={<SuccessMark />}
      title="Payment successful"
      body={`${receipt.amount} is on its way to ${receipt.recipientName}.`}
      reassurance="Securely processed. A receipt is saved in your transaction history."
      primaryLabel="Done"
      onPrimary={done}>
      <ReceiptCard receipt={receipt} onCopy={() => copyRef(receipt, toast)} />
      <Pressable onPress={shareReceipt} hitSlop={8} style={styles.shareRow}>
        <Share2 color={Palette.accent} size={16} strokeWidth={2} />
        <Text style={styles.shareText}>Share receipt</Text>
      </Pressable>
    </StateView>
  );
}

function ReceiptCard({ receipt, onCopy }: { receipt: Receipt; onCopy: () => void }) {
  return (
    <Animated.View entering={FadeInDown.duration(320).delay(120)} style={styles.cardWrap}>
      <Card style={styles.card}>
        <Line label="Amount" value={receipt.amount} strong />
        <Line label="To" value={receipt.recipientName} />
        {receipt.recipientHandle ? <Line label="Account" value={receipt.recipientHandle} /> : null}
        <Line label="Method" value={receipt.method} />
        <Line label="Date" value={receipt.dateTime} />
        <Line label="Status" value={receipt.status} accent />
        {receipt.reference ? (
          <Pressable onPress={onCopy} style={styles.refRow} hitSlop={6}>
            <View style={styles.refText}>
              <Text style={styles.label}>Reference</Text>
              <Text style={styles.mono} numberOfLines={1}>
                {shorten(receipt.reference)}
              </Text>
            </View>
            <Copy color={Palette.accent} size={15} strokeWidth={2} />
          </Pressable>
        ) : null}
      </Card>
    </Animated.View>
  );
}

function Line({
  label,
  value,
  strong,
  accent,
}: {
  label: string;
  value: string;
  strong?: boolean;
  accent?: boolean;
}) {
  return (
    <View style={styles.line}>
      <Text style={styles.label}>{label}</Text>
      <Text
        style={[styles.value, strong && styles.valueStrong, accent && styles.valueAccent]}
        numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/** Plain-language decline reasons, and whether retrying could plausibly succeed. */
function declineCopy(code?: string, detail?: string): { text: string; retryable: boolean } {
  switch (code) {
    case 'insufficient_funds':
      return { text: 'You don’t have enough balance for this transfer.', retryable: false };
    case 'incorrect_pin':
      return { text: 'That PIN wasn’t right, so we stopped the payment.', retryable: true };
    case 'limit_exceeded':
      return {
        text: 'This amount is above your current limit. Verifying your identity raises it.',
        retryable: false,
      };
    case 'bank_declined':
      return { text: 'Your bank declined this transfer.', retryable: true };
    case 'expired_credential':
      return { text: 'Your verification expired. Verify again to keep sending.', retryable: false };
    case 'rejected':
      return { text: 'The network rejected this transfer, so nothing was sent.', retryable: false };
    case 'timeout':
      return {
        text: 'The network didn’t respond in time, so we stopped the payment.',
        retryable: true,
      };
    default:
      /*
       * `detail` is the server's own sentence, and only ever that — send.tsx passes it through only
       * for an `ApiError` with a real status, because those messages are written for the person
       * reading them. Anything thrown locally (the prover, the native module, the JS runtime) is
       * deliberately dropped there and lands on the generic line below.
       *
       * That split is the whole point. A specific sentence someone can act on beats a reassuring one
       * that says nothing — but only while it stays a sentence. When raw relay output was allowed
       * down this path, what people saw mid-payment was `Event log (newest first): | 0: [Diagnostic
       * Event] contract:CBLL…, topics:[error, Error(Contract, #4)]`.
       */
      return {
        text: detail?.trim()
          ? detail.trim()
          : 'We couldn’t complete this payment, so nothing was sent. Your money is still in your balance.',
        retryable: true,
      };
  }
}

function shorten(ref: string): string {
  return ref.length > 22 ? `${ref.slice(0, 10)}…${ref.slice(-8)}` : ref;
}

function copyRef(receipt: Receipt, toast: { success: (m: string) => void }): void {
  if (!receipt.reference) return;
  void Clipboard.setStringAsync(receipt.reference);
  toast.success('Reference copied');
}

const styles = StyleSheet.create({
  cardWrap: { alignSelf: 'stretch' },
  card: { gap: Spacing.three },
  line: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.four,
  },
  label: { ...Typography.caption, color: Palette.textSecondary },
  value: { ...Typography.caption, color: Palette.white, fontWeight: '600', flexShrink: 1 },
  valueStrong: { ...Typography.section, color: Palette.white },
  valueAccent: { color: Palette.accent },
  refRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.border,
    paddingTop: Spacing.three,
  },
  refText: { flex: 1, gap: 2 },
  mono: { ...Typography.micro, color: Palette.white },
  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  shareText: { ...Typography.caption, color: Palette.accent, fontWeight: '600' },
  refPill: { borderRadius: Radius.pill },
});

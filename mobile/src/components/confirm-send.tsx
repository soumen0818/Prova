import { ShieldCheck } from 'lucide-react-native';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

/**
 * The last thing shown before money leaves.
 *
 * A private send is submitted by the relayer, so — unlike a deposit — there is no wallet signature
 * and therefore no signing sheet. The step-up that follows is the OS fingerprint prompt, which can
 * carry a single line of text and cannot show an amount or a recipient. Without this, the final
 * confirmation a person sees before an irreversible transfer is a generic "Approve this transfer".
 *
 * So this restates the two facts that matter — how much, and to whom — in the largest type on the
 * screen, and makes cancelling as easy as continuing. It is deliberately plain: no progress, no
 * marketing, nothing to read past.
 */
export function ConfirmSendSheet({
  visible,
  amount,
  recipientName,
  country,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  amount: string;
  recipientName: string;
  country?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onCancel}
      statusBarTranslucent>
      {/* Tapping outside cancels. Confirming must be deliberate; backing out should not be. */}
      <Pressable style={styles.backdrop} onPress={onCancel} />

      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, Spacing.five) }]}>
        <View style={styles.grabber} />

        <Text style={styles.title}>Confirm transfer</Text>

        <Text style={styles.amount}>{amount}</Text>

        <View style={styles.rows}>
          <View style={styles.row}>
            <Text style={styles.label}>To</Text>
            <Text style={styles.value} numberOfLines={1}>
              {recipientName}
            </Text>
          </View>
          {country ? (
            <View style={styles.row}>
              <Text style={styles.label}>Destination</Text>
              <Text style={styles.value}>{country}</Text>
            </View>
          ) : null}
          <View style={styles.row}>
            <Text style={styles.label}>Arrives</Text>
            <Text style={styles.value}>In a few seconds</Text>
          </View>
        </View>

        <View style={styles.note}>
          <ShieldCheck color={Palette.accent} size={17} strokeWidth={2} />
          <Text style={styles.noteText}>
            This cannot be reversed once sent. The amount and the recipient stay on this phone.
          </Text>
        </View>

        <Button label={`Send ${amount}`} onPress={onConfirm} style={styles.confirm} />
        <Button label="Cancel" variant="secondary" onPress={onCancel} />
      </View>
    </Modal>
  );
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
    backgroundColor: Palette.bgElevated,
    borderTopLeftRadius: Radius.sheet,
    borderTopRightRadius: Radius.sheet,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    paddingHorizontal: Spacing.five,
    paddingTop: Spacing.three,
    gap: Spacing.three,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Palette.border,
    marginBottom: Spacing.two,
  },
  title: { ...Typography.section, color: Palette.textSecondary },
  amount: {
    ...Typography.displayBalance,
    color: Palette.white,
    fontVariant: ['tabular-nums'],
    marginBottom: Spacing.two,
  },
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
  label: { ...Typography.caption, color: Palette.textMuted },
  value: { ...Typography.caption, color: Palette.white, flexShrink: 1, textAlign: 'right' },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
  },
  noteText: { ...Typography.micro, color: Palette.textSecondary, flex: 1, lineHeight: 19 },
  confirm: { marginTop: Spacing.one },
});

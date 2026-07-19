import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { startDeposit } from '@/lib/api';
import { credit, formatMinor } from '@/lib/balance';
import { syncBackup } from '@/lib/cloud-backup';
import { useBalance, QK } from '@/lib/queries';
import { Button, Card, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import { env } from '@/config/env';
import { captureError } from '@/lib/reporting';
import { validateAmount } from '@/lib/validation';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

const QUICK = [100, 500, 1000, 2500];
const MAX_DEPOSIT = 100_000;

/**
 * Add money. In development this instantly tops up the on-device testnet balance so the send flow
 * is usable end-to-end. In production it drives a SEP-24 interactive deposit through the anchor.
 * (Balance is device-local because the amount is private — the backend never sees it.)
 */
export default function DepositScreen() {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: balanceMinor } = useBalance();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const amt = Number(amount);
  const check = validateAmount(amount, { min: 1, max: MAX_DEPOSIT });
  const showError = submitted && !check.ok ? check.error : '';

  const onDevCredit = useCallback(async () => {
    setSubmitted(true);
    const v = validateAmount(amount, { min: 1, max: MAX_DEPOSIT });
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    setBusy(true);
    try {
      await credit(amt);
      await queryClient.invalidateQueries({ queryKey: QK.balance });
      toast.success(`Added ${formatMinor(amt * 100)}`);
      void syncBackup(); // silent, best-effort backup refresh
      router.back();
    } catch (e) {
      captureError(e, { step: 'dev-deposit' });
      toast.error('Could not add funds');
    } finally {
      setBusy(false);
    }
  }, [amount, amt, queryClient, router, toast]);

  const onSep24 = useCallback(async () => {
    setBusy(true);
    try {
      const dep = await startDeposit();
      toast.info('Opening the anchor…');
      await WebBrowser.openBrowserAsync(dep.url);
    } catch (e) {
      captureError(e, { step: 'sep24-deposit' });
      toast.error(e instanceof Error ? e.message : 'Deposit failed');
    } finally {
      setBusy(false);
    }
  }, [toast]);

  return (
    <Screen scroll>
      <Card tone="accent" style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>Current balance</Text>
        <Text style={styles.balanceValue}>{formatMinor(balanceMinor ?? 0)}</Text>
      </Card>

      <Text style={styles.label}>Amount to add ({env.currency})</Text>
      <View style={styles.amountRow}>
        <Text style={styles.currency}>{env.currency}</Text>
        <TextInput
          style={styles.amountInput}
          value={amount}
          onChangeText={setAmount}
          keyboardType="number-pad"
          placeholder="0"
          placeholderTextColor={Palette.textMuted}
          editable={!busy}
          autoFocus
        />
      </View>
      {showError ? <Text style={styles.error}>{showError}</Text> : null}

      <View style={styles.chips}>
        {QUICK.map((q) => (
          <Pressable key={q} style={styles.chip} onPress={() => setAmount(String(q))}>
            <Text style={styles.chipText}>
              {env.currency} {q}
            </Text>
          </Pressable>
        ))}
      </View>

      {env.auth.isDev ? (
        <>
          <Button
            label={busy ? 'Adding…' : 'Add to balance'}
            onPress={onDevCredit}
            loading={busy}
            disabled={!check.ok}
            style={styles.action}
          />
          <Text style={styles.note}>
            Testnet top-up — funds are credited instantly on this device for testing. Switch
            `EXPO_PUBLIC_AUTH_MODE=production` to use the real anchor (SEP-24) deposit.
          </Text>
        </>
      ) : (
        <>
          <Button
            label={busy ? 'Starting…' : 'Deposit via anchor'}
            onPress={onSep24}
            loading={busy}
            style={styles.action}
          />
          <Text style={styles.note}>
            Deposit a test asset via the anchor (SEP-24). The backend authenticates (SEP-10) and
            opens the anchor’s deposit page.
          </Text>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  balanceCard: { gap: Spacing.one, marginBottom: Spacing.six, alignItems: 'flex-start' },
  balanceLabel: { ...Typography.caption, color: 'rgba(17,19,26,0.7)', fontWeight: '600' },
  balanceValue: { ...Typography.title, fontSize: 28, color: Palette.onAccent },
  label: { ...Typography.caption, color: Palette.textSecondary, marginBottom: Spacing.two },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.two,
    marginBottom: Spacing.four,
  },
  currency: { ...Typography.title, color: Palette.textSecondary },
  amountInput: { ...Typography.displayBalance, color: Palette.white, flex: 1, padding: 0 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, marginBottom: Spacing.six },
  chip: {
    backgroundColor: Palette.bgElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  chipText: { ...Typography.caption, color: Palette.white },
  action: { marginBottom: Spacing.four },
  note: { ...Typography.micro, color: Palette.textMuted },
  error: { ...Typography.caption, color: Palette.statusDown, marginBottom: Spacing.four },
});

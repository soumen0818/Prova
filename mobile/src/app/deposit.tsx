import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatAmount, minorPerUnit } from '@prova/shared';

import { credit, formatBalance, settlementDenomination } from '@/lib/balance';
import { ConnectionGate } from '@/components/connection-gate';
import { LockedMark } from '@/components/illustrations';
import { StateView } from '@/components/state-view';
import { syncBackup } from '@/lib/cloud-backup';
import {
  activateAccount,
  establishTrustline,
  getOnChainStatus,
  startUserDeposit,
  UserRejectedError,
} from '@/lib/onchain';
import { useAssetMismatch, useBalance, useDenomination, useKycVerified, QK } from '@/lib/queries';
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
  const { data: denom } = useDenomination();
  const assetMismatch = useAssetMismatch();
  const { data: verified } = useKycVerified();
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
      // A simulated top-up stands in for an anchor deposit, so it credits the same settlement asset
      // the anchor would deliver — never a currency, which no one has actually paid.
      const d = settlementDenomination();
      await credit(amt, d);
      await queryClient.invalidateQueries({ queryKey: QK.balance });
      await queryClient.invalidateQueries({ queryKey: QK.denomination });
      toast.success(`Added ${formatAmount(amt * minorPerUnit(d), d)}`);
      void syncBackup(); // silent, best-effort backup refresh
      router.back();
    } catch (e) {
      captureError(e, { step: 'dev-deposit' });
      toast.error('Could not add funds');
    } finally {
      setBusy(false);
    }
  }, [amount, amt, queryClient, router, toast]);

  // Real testnet deposit: activate the account + trustline (each once), then the USER authenticates
  // (SEP-10) so the anchor deposits into their wallet. Every signature is reviewed first.
  const onAnchorDeposit = useCallback(async () => {
    setBusy(true);
    try {
      const status = await getOnChainStatus();
      if (!status.activated) {
        toast.info('Activating your account…');
        await activateAccount();
      }
      const trusted = status.trusted || (await getOnChainStatus()).trusted;
      if (!trusted) {
        await establishTrustline(); // prompts a review before signing
      }
      const dep = await startUserDeposit(); // user-authenticated; prompts a review before signing
      toast.info('Opening the anchor…');
      await WebBrowser.openBrowserAsync(dep.url);
      await queryClient.invalidateQueries({ queryKey: QK.balance });
      await queryClient.invalidateQueries({ queryKey: QK.denomination });
    } catch (e) {
      if (e instanceof UserRejectedError) return; // user cancelled a review — not an error
      captureError(e, { step: 'anchor-deposit' });
      toast.error(e instanceof Error ? e.message : 'Deposit failed');
    } finally {
      setBusy(false);
    }
  }, [toast, queryClient]);

  // Defence in depth: the Home buttons already gate on verification, but a deep link or a stale
  // navigation stack can land here directly, so the screen refuses on its own too.
  if (verified === false) {
    return (
      <StateView
        illustration={<LockedMark color={Palette.accent} />}
        title="Verify your identity first"
        body="Adding money needs a verified account. It's a one-time check that takes a couple of minutes."
        reassurance="Your details go to the licensed anchor — never stored by Prova."
        primaryLabel="Verify identity"
        onPrimary={() => router.replace('/kyc')}
        secondaryLabel="Not now"
        onSecondary={() => router.back()}
      />
    );
  }

  return (
    // Adding money is a money-moving action: block it outright when we can't reach the network,
    // rather than letting someone believe a top-up succeeded.
    <ConnectionGate>
      <Screen scroll>
        <Card tone="accent" style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>Current balance</Text>
          <Text style={styles.balanceValue}>
            {formatBalance(balanceMinor ?? 0, denom, 'Nothing added yet')}
          </Text>
        </Card>

        {/*
          Warn here as well as in Settings: this is the screen where a wrong asset label actually
          costs something, because the user is about to act on it.
        */}
        {assetMismatch ? (
          <Text style={styles.mismatch}>
            This app is built for {assetMismatch.app} but the backend settles in{' '}
            {assetMismatch.backend}. Amounts here are labelled with the wrong asset.
          </Text>
        ) : null}

        {env.depositMode === 'anchor' ? (
          // No amount field here: the anchor's own interactive page asks how much and in which
          // currency, and `onAnchorDeposit` never reads a local amount. Collecting one would be a
          // control that changes nothing — and it is exactly where a wrong currency used to appear.
          <>
            <Button
              label={busy ? 'Preparing…' : 'Add money via anchor'}
              onPress={onAnchorDeposit}
              loading={busy}
              style={styles.action}
            />
            <Text style={styles.note}>
              Real testnet rails: we activate your Stellar account, add a trustline (signed on your
              device), then open the anchor’s deposit page — where you choose the amount. You
              receive {env.depositAsset}, a test asset with no real value.
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.label}>Amount to add ({env.depositAsset})</Text>
            <View style={styles.amountRow}>
              <Text style={styles.assetCode}>{env.depositAsset}</Text>
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
                    {env.depositAsset} {q}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Button
              label={busy ? 'Adding…' : 'Add to balance'}
              onPress={onDevCredit}
              loading={busy}
              disabled={!check.ok}
              style={styles.action}
            />
            <Text style={styles.note}>
              Testnet top-up — {env.depositAsset} is credited instantly on this device for testing
              and has no real value. Set `EXPO_PUBLIC_DEPOSIT_MODE=anchor` for the real on-chain
              deposit flow.
            </Text>
          </>
        )}
      </Screen>
    </ConnectionGate>
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
  assetCode: { ...Typography.title, color: Palette.textSecondary },
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
  mismatch: { ...Typography.micro, color: Palette.statusDown, marginBottom: Spacing.four },
});

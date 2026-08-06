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
import { useAssetMismatch, useKycVerified, QK } from '@/lib/queries';
import { useMoney } from '@/hooks/use-money';
import { shieldToPool } from '@/lib/pool';
import { Button, Card, Screen } from '@/components/ui';
import { useToast } from '@/components/toast';
import { env } from '@/config/env';
import { captureError } from '@/lib/reporting';
import { validateAmount } from '@/lib/validation';
import { Palette, Radius, Spacing, Typography } from '@/constants/theme';

const QUICK = [100, 500, 1000, 2500];

/** Progress copy for each shield stage. Proving is the slow one, so it says so plainly. */
const SHIELD_STAGES: Record<'proving' | 'approving' | 'submitting', string> = {
  proving: 'Proving the amount…',
  approving: 'Waiting for approval…',
  submitting: 'Submitting to Stellar…',
};
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
  const money = useMoney();
  const assetMismatch = useAssetMismatch();
  const { data: verified } = useKycVerified();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  /** Honest progress label while shielding — proving is the slow part and must be visible. */
  const [shieldStage, setShieldStage] = useState('');

  const amt = Number(amount);
  const check = validateAmount(amount, { min: 1, max: MAX_DEPOSIT });
  const showError = submitted && !check.ok ? check.error : '';

  /**
   * Step 2 of the real flow: move the public on-chain balance into the shielded pool.
   *
   * A `pending` result is reported as processing, never failure — the deposit may still land, and
   * telling someone it failed is how they shield twice.
   */
  const onShield = useCallback(async () => {
    setSubmitted(true);
    const v = validateAmount(amount, { min: 1, max: MAX_DEPOSIT });
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    setBusy(true);
    try {
      const res = await shieldToPool(amt, (stage) => setShieldStage(SHIELD_STAGES[stage]));
      await queryClient.invalidateQueries({ queryKey: QK.poolBalance });
      await queryClient.invalidateQueries({ queryKey: QK.denomination });
      if (res.status === 'pending') {
        toast.info('Deposit submitted — confirming. It will appear shortly.');
      } else {
        // Confirmed on-chain, but not yet spendable: the note still has to be folded into the tree.
        toast.success('Added to your private balance — confirming for a few seconds.');
      }
      router.back();
    } catch (e) {
      if (e instanceof UserRejectedError) return; // declined the review — a cancel, not a failure
      captureError(e, { step: 'pool-shield' });
      toast.error(e instanceof Error ? e.message : 'Could not move funds into the pool');
    } finally {
      setBusy(false);
      setShieldStage('');
    }
  }, [amount, amt, queryClient, router, toast]);

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
            {formatBalance(money.spendable, money.denom, 'Nothing added yet')}
          </Text>
          {money.pending > 0 ? (
            <Text style={styles.balanceLabel}>
              {formatBalance(money.pending, money.denom)} confirming
            </Text>
          ) : null}
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
            <Text style={styles.stepTitle}>1. Add money</Text>
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

            {/*
              Two steps, not one, because they are genuinely different events. The anchor deposit
              puts a public balance in the user's own Stellar account; shielding then moves it into
              the pool, which is where privacy begins. Collapsing them into one button would hide
              a second signature and a second on-chain transaction the user is paying for.
            */}
            <View style={styles.divider} />
            <Text style={styles.stepTitle}>2. Make it private</Text>
            <Text style={styles.note}>
              Moves {env.depositAsset} from your public Stellar balance into the shielded pool. Your
              device proves the amount without revealing it. This step needs your signature because
              the contract moves your own tokens.
            </Text>
            <Text style={styles.label}>Amount to shield ({env.depositAsset})</Text>
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
              />
            </View>
            {showError ? <Text style={styles.error}>{showError}</Text> : null}
            <Button
              label={busy ? shieldStage : 'Move into private pool'}
              onPress={onShield}
              loading={busy}
              disabled={!check.ok}
              variant="secondary"
              style={styles.action}
            />
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
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Palette.border,
    marginVertical: Spacing.six,
  },
  stepTitle: { ...Typography.section, color: Palette.white, marginBottom: Spacing.two },
});

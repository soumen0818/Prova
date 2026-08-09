import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

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
  // Plain language: the user does not need to know what a proof is, only that it takes a moment
  // and that their approval is next.
  proving: 'Securing…',
  approving: 'Waiting for your approval…',
  submitting: 'Finishing up…',
};
const MAX_DEPOSIT = 100_000;

/**
 * XLM is the network's own asset: no issuer, no trustline, and a faucet that always works. That
 * makes the funding step a single call instead of a trustline + SEP-10 + a hosted web page.
 */
const isNativeAsset = env.depositAsset === 'XLM';
/** Only the pool flow has a public on-chain balance to bound the shield amount by. */
const usesPoolMode = env.depositMode === 'anchor';

/** How long to keep watching for the anchor's transfer after its page closes. */
const ANCHOR_POLL_MS = 4000;
const ANCHOR_POLLS = 8;

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
  /**
   * Tracked per action, not shared. One flag drove both buttons: starting the anchor deposit put
   * the shield button into a loading state too — and blanked its label, since it renders
   * `shieldStage`, which is empty during the anchor flow.
   */
  const [busyAnchor, setBusyAnchor] = useState(false);
  const [busyShield, setBusyShield] = useState(false);
  const busy = busyAnchor || busyShield;
  const [submitted, setSubmitted] = useState(false);
  /** Honest progress label while shielding — proving is the slow part and must be visible. */
  const [shieldStage, setShieldStage] = useState('');
  /**
   * Public (unshielded) balance held on Stellar — the ceiling for step 2. Without it a user can
   * type more than they hold, sit through proving and a signature, and only fail on-chain.
   */
  const [publicBalance, setPublicBalance] = useState<number | null>(null);
  /** Watching for the anchor's transfer to land after its page closed. */
  const [waitingForAnchor, setWaitingForAnchor] = useState(false);
  /** Balance recorded before handing off, so "did anything arrive?" has something to compare to. */
  const balanceBeforeAnchor = useRef<number | null>(null);

  const amt = Number(amount);
  const check = validateAmount(amount, {
    min: 1,
    max: MAX_DEPOSIT,
    // Only bound once we actually know the balance; `undefined` means "not yet loaded", not zero.
    available: env.depositMode === 'anchor' && publicBalance !== null ? publicBalance : undefined,
  });
  // Show the moment it is true, rather than waiting for a press. "You typed more than you have" is
  // information the user needs while typing — making them submit first to find out is a worse
  // experience, and here it would mean sitting through proving before being told.
  const showError = (submitted || amount.trim().length > 0) && !check.ok ? check.error : '';

  /**
   * Step 2 of the real flow: move the public on-chain balance into the shielded pool.
   *
   * A `pending` result is reported as processing, never failure — the deposit may still land, and
   * telling someone it failed is how they shield twice.
   */
  const onShield = useCallback(async () => {
    // Guarded here rather than by disabling the other button: grey-ing out a control the user did
    // not touch reads as breakage. Refusing a second concurrent run is the actual requirement.
    if (busy) return;
    setSubmitted(true);
    const v = validateAmount(amount, { min: 1, max: MAX_DEPOSIT });
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    setBusyShield(true);
    try {
      const res = await shieldToPool(amt, (stage) => setShieldStage(SHIELD_STAGES[stage]));
      await queryClient.invalidateQueries({ queryKey: QK.poolBalance });
      await queryClient.invalidateQueries({ queryKey: QK.denomination });
      // Deliberately stays on this screen. Bouncing straight to Home landed the user there before
      // the note had been scanned back off-chain, so Home briefly said "No money added yet" about
      // money they had just watched being deposited. Confirming here, where they acted, is both
      // calmer and truthful.
      Keyboard.dismiss();
      setAmount('');
      setSubmitted(false);
      toast[res.status === 'pending' ? 'info' : 'success'](
        'Added — confirming. Ready to send in a few seconds.',
      );
      // Refresh what is left in the public balance so step 2's ceiling stays accurate.
      const after = await getOnChainStatus().catch(() => null);
      if (after) setPublicBalance(Math.floor(Number(after.assetBalance) || 0));
    } catch (e) {
      if (e instanceof UserRejectedError) return; // declined the review — a cancel, not a failure
      captureError(e, { step: 'pool-shield' });
      toast.error(e instanceof Error ? e.message : 'Could not move funds into the pool');
    } finally {
      setBusyShield(false);
      setShieldStage('');
    }
  }, [amount, amt, busy, queryClient, toast]);

  const onDevCredit = useCallback(async () => {
    if (busy) return;
    setSubmitted(true);
    const v = validateAmount(amount, { min: 1, max: MAX_DEPOSIT });
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    setBusyShield(true);
    try {
      // A simulated top-up stands in for an anchor deposit, so it credits the same settlement asset
      // the anchor would deliver — never a currency, which no one has actually paid.
      const d = settlementDenomination();
      await credit(amt, d);
      await queryClient.invalidateQueries({ queryKey: QK.balance });
      await queryClient.invalidateQueries({ queryKey: QK.denomination });
      toast.success(`Added ${formatAmount(amt * minorPerUnit(d), d)}`);
      void syncBackup(); // silent, best-effort backup refresh
      Keyboard.dismiss();
      router.back();
    } catch (e) {
      captureError(e, { step: 'dev-deposit' });
      toast.error('Could not add funds');
    } finally {
      setBusyShield(false);
    }
  }, [amount, amt, busy, queryClient, router, toast]);

  // Real testnet deposit: activate the account + trustline (each once), then the USER authenticates
  // (SEP-10) so the anchor deposits into their wallet. Every signature is reviewed first.
  const onAnchorDeposit = useCallback(async () => {
    if (busy) return;
    setBusyAnchor(true);
    try {
      const status = await getOnChainStatus();
      if (!status.activated) {
        toast.info('Setting up your account…');
        await activateAccount();
      }

      // Native XLM needs neither a trustline (it is the network's own asset) nor an anchor: the
      // testnet faucet funds the account directly. That removes two signatures and a third-party
      // web page from the path — and unlike the anchor's sandbox, it actually delivers.
      if (isNativeAsset) {
        const after = await getOnChainStatus().catch(() => null);
        const now = after ? Math.floor(Number(after.assetBalance) || 0) : 0;
        setPublicBalance(now);
        await queryClient.invalidateQueries({ queryKey: QK.balance });
        toast.success(
          now > 0 ? `${now} ${env.depositAsset} ready. Continue to step 2.` : 'Account funded.',
        );
        return;
      }

      const trusted = status.trusted || (await getOnChainStatus()).trusted;
      if (!trusted) {
        await establishTrustline(); // prompts a review before signing
      }
      const dep = await startUserDeposit(); // user-authenticated; prompts a review before signing
      // In-app, not a handoff to the phone's default browser: the anchor's page is a JS app that a
      // shields-up browser breaks, and leaving Prova mid-payment is its own problem.
      balanceBeforeAnchor.current = publicBalance ?? 0;
      router.push({ pathname: '/anchor', params: { url: dep.url } });
    } catch (e) {
      if (e instanceof UserRejectedError) return; // user cancelled a review — not an error
      captureError(e, { step: 'anchor-deposit' });
      toast.error(e instanceof Error ? e.message : 'Deposit failed');
    } finally {
      setBusyAnchor(false);
    }
  }, [toast, router, queryClient, busy, publicBalance]);

  /**
   * Learn the public balance whenever the screen is shown.
   *
   * It used to be set only inside the deposit flow, so anyone arriving with funds already in their
   * wallet had `publicBalance === null` — and the amount check silently had no ceiling to compare
   * against. Typing more than you hold passed validation and only failed on-chain, after proving
   * and a signature.
   */
  useFocusEffect(
    useCallback(() => {
      if (!usesPoolMode) return;
      let active = true;
      getOnChainStatus()
        .then((s) => {
          if (active) setPublicBalance(Math.floor(Number(s.assetBalance) || 0));
        })
        .catch(() => {
          /* leave null: "unknown", which must not be treated as zero */
        });
      return () => {
        active = false;
      };
    }, []),
  );

  /**
   * Watch for the anchor's transfer once its screen closes.
   *
   * The anchor settles asynchronously — closing the page does not mean funds have landed, so a
   * single read on return is almost always too early. That silence is what made the screen look
   * like nothing had happened.
   */
  useFocusEffect(
    useCallback(() => {
      const before = balanceBeforeAnchor.current;
      if (before === null) return;
      balanceBeforeAnchor.current = null;

      let active = true;
      (async () => {
        setWaitingForAnchor(true);
        let landed = false;
        for (let i = 0; i < ANCHOR_POLLS && active; i++) {
          await new Promise((r) => setTimeout(r, ANCHOR_POLL_MS));
          const after = await getOnChainStatus().catch(() => null);
          if (!after || !active) continue;
          const now = Math.floor(Number(after.assetBalance) || 0);
          setPublicBalance(now);
          if (now > before) {
            landed = true;
            break;
          }
        }
        if (!active) return;
        setWaitingForAnchor(false);
        toast[landed ? 'success' : 'info'](
          landed
            ? 'Funds received. Continue to step 2.'
            : 'Not received yet — this can take a few minutes.',
        );
        await queryClient.invalidateQueries({ queryKey: QK.balance });
      })();

      return () => {
        active = false;
      };
    }, [toast, queryClient]),
  );

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
            <Text style={styles.stepTitle}>Step 1 · Add funds</Text>
            <Text style={styles.note}>
              {isNativeAsset
                ? 'Adds test funds to your wallet instantly.'
                : 'Choose your amount on the next screen. You may be asked to approve a step or two the first time.'}
            </Text>
            <Button
              label={
                waitingForAnchor ? 'Waiting for funds…' : busyAnchor ? 'Opening…' : 'Add funds'
              }
              onPress={onAnchorDeposit}
              loading={busyAnchor}
              style={styles.action}
            />

            {/*
              Two steps, not one, because they are genuinely different events. The anchor deposit
              puts a public balance in the user's own Stellar account; shielding then moves it into
              the pool, which is where privacy begins. Collapsing them into one button would hide
              a second signature and a second on-chain transaction the user is paying for.
            */}
            <View style={styles.divider} />
            <Text style={styles.stepTitle}>Step 2 · Make it private</Text>
            <Text style={styles.note}>
              Hides your balance and any amount you send. You will be asked to approve it.
            </Text>
            <Text style={styles.label}>
              Amount
              {publicBalance !== null ? ` · ${publicBalance} ${env.depositAsset} available` : ''}
            </Text>
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
              label={busyShield && shieldStage ? shieldStage : 'Make private'}
              onPress={onShield}
              loading={busyShield}
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
              label={busyShield ? 'Adding…' : 'Add to balance'}
              onPress={onDevCredit}
              loading={busyShield}
              disabled={!check.ok}
              style={styles.action}
            />
            <Text style={styles.note}>Test funds, added instantly. No real value.</Text>
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
    marginBottom: Spacing.five,
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
  note: { ...Typography.micro, color: Palette.textMuted, marginBottom: Spacing.four },
  error: { ...Typography.caption, color: Palette.statusDown, marginBottom: Spacing.four },
  mismatch: { ...Typography.micro, color: Palette.statusDown, marginBottom: Spacing.four },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Palette.border,
    marginVertical: Spacing.six,
  },
  stepTitle: { ...Typography.section, color: Palette.white, marginBottom: Spacing.three },
});

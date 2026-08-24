/**
 * Shielded-pool state for screens (Docs/shielded-pool.md).
 *
 * Two numbers, deliberately kept apart: money you can spend now, and money still confirming. A note
 * is not spendable until it has been folded into the Merkle tree — a spend proves membership, and an
 * unfolded commitment is not yet a leaf. Showing the two as one figure would let someone tap Send on
 * money that cannot move, and the failure would come from the contract rather than the UI.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { poolBalance, scanForNotes, type ScanResult } from '@/lib/pool';
import { QK } from '@/lib/queries';

/** How often to look for incoming money. Scanning is ~0.4 ms per note, so this is cheap. */
const SCAN_INTERVAL_MS = 15_000;

/**
 * How often to look while something is still confirming.
 *
 * The backend folds every 8 seconds (`POOL_FOLD_INTERVAL_SECONDS`), so a note is usually spendable
 * within 8 — but at a flat 15-second poll the *app* took up to 23 seconds to notice, and most of
 * that wait was us not looking rather than the chain being slow.
 *
 * That gap is felt hardest right after a send. Spending a 900 note to pay 200 returns 700 as change,
 * and until the fold lands that 700 sits on screen as "confirming" — a large, unexplained number
 * that appeared because the user paid a small one. Shortening the window is the difference between a
 * blink and long enough to wonder what went wrong.
 *
 * Only while `pending > 0`, so the steady state is unchanged: no extra battery or server load for
 * the overwhelming majority of the time, when there is nothing to wait for.
 */
const FAST_SCAN_INTERVAL_MS = 3_000;

export interface PoolBalance {
  /** Spendable now, in minor units. */
  spendable: number;
  /** Arrived but still confirming — real money, not yet movable. */
  pending: number;
  /**
   * The largest single note, in minor units: the most that can leave in one transfer.
   *
   * Lower than `spendable` whenever the balance is split across notes, because the spend circuit
   * takes exactly one input.
   */
  largestNote: number;
  /**
   * True when everything in `pending` is change returning from this wallet's own send, rather than
   * money arriving. Wording only — see `poolBalance`.
   */
  pendingIsChange: boolean;
}

/**
 * The wallet's pool balance, refreshed on a timer.
 *
 * `pending > 0` is the state the UI must explain: the money is theirs and safe, it is simply waiting
 * for the next fold. Silence there reads as "my transfer vanished".
 */
export function usePoolBalance() {
  return useQuery<PoolBalance>({
    queryKey: QK.poolBalance,
    queryFn: poolBalance,
    // Follows the scan: there is no point re-reading the balance faster than the notes behind it
    // change, and no point reading it slower while the user is watching a figure move.
    refetchInterval: ({ state }) =>
      (state.data?.pending ?? 0) > 0 ? FAST_SCAN_INTERVAL_MS : SCAN_INTERVAL_MS,
    // Money should never look stale; showing the last known figure while refreshing is right here.
    placeholderData: (previous) => previous,
  });
}

/**
 * Keep the wallet's view of the pool current, for the lifetime of the app.
 *
 * Mount this **once**, near the root. It scans on start, on a timer, and whenever the app returns to
 * the foreground — that last one matters because money that arrived while the phone was locked is
 * exactly what a user opens the app to check.
 *
 * Failures are deliberately silent: a scan is a refresh, and a red banner because one poll missed
 * the network would be alarming about nothing. The next pass picks it up.
 */
export function usePoolSync(enabled = true): void {
  const { scan } = useNoteScan();
  const queryClient = useQueryClient();
  // Kept in a ref so the effect below does not re-subscribe on every render — `scan` is recreated
  // whenever a scan starts or finishes, which would otherwise tear down the timer mid-flight.
  const scanRef = useRef(scan);
  useEffect(() => {
    scanRef.current = scan;
  }, [scan]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    /*
     * A self-rescheduling timeout rather than setInterval, so the delay can be chosen fresh each
     * cycle from what the wallet is actually waiting for.
     *
     * With a fixed interval the app was the slowest link in the chain: the fold lands in ~8s and we
     * would not look for another 15. Re-reading `pending` here means the poll tightens by itself
     * exactly while a note is unfolded — which is the only time anybody is watching the number — and
     * relaxes the moment there is nothing outstanding.
     */
    const run = async () => {
      if (!active) return;
      await scanRef.current();
      if (!active) return;
      const pending = queryClient.getQueryData<PoolBalance>(QK.poolBalance)?.pending ?? 0;
      timer = setTimeout(run, pending > 0 ? FAST_SCAN_INTERVAL_MS : SCAN_INTERVAL_MS);
    };

    void run();
    const subscription = AppState.addEventListener('change', (state) => {
      // Returning to the app is the moment someone most wants a current figure, so jump the queue
      // rather than waiting out whatever delay is in flight.
      if (state === 'active') {
        clearTimeout(timer);
        void run();
      }
    });

    return () => {
      active = false;
      clearTimeout(timer);
      subscription.remove();
    };
  }, [enabled, queryClient]);
}

/**
 * Scan for incoming notes.
 *
 * Every note in the feed is trial-decrypted on-device; what opens is ours. The feed is unfiltered on
 * purpose — asking the server for "my notes" would tell it who is being paid.
 */
export function useNoteScan() {
  const queryClient = useQueryClient();
  const [scanning, setScanning] = useState(false);
  const [lastResult, setLastResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    if (scanning) return null; // one pass at a time; overlapping scans would double-count the cursor
    setScanning(true);
    setError(null);
    try {
      const result = await scanForNotes();
      setLastResult(result);
      if (
        result.found > 0 ||
        result.newlySpendable > 0 ||
        result.newlySpent > 0 ||
        result.settled > 0
      ) {
        await queryClient.invalidateQueries({ queryKey: QK.poolBalance });
        // A scan is also how received money first appears in history, and how a send stops being
        // "Processing" — `settled` is in the condition because a send that timed out changes no note
        // at all, so without it the row would spin forever.
        await queryClient.invalidateQueries({ queryKey: QK.activity });
      }
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check for new payments.');
      return null;
    } finally {
      setScanning(false);
    }
  }, [queryClient, scanning]);

  return { scan, scanning, lastResult, error };
}

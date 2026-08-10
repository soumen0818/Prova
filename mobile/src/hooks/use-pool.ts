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

export interface PoolBalance {
  /** Spendable now, in minor units. */
  spendable: number;
  /** Arrived but still confirming — real money, not yet movable. */
  pending: number;
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
    refetchInterval: SCAN_INTERVAL_MS,
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
  // Kept in a ref so the effect below does not re-subscribe on every render — `scan` is recreated
  // whenever a scan starts or finishes, which would otherwise tear down the timer mid-flight.
  const scanRef = useRef(scan);
  useEffect(() => {
    scanRef.current = scan;
  }, [scan]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const run = () => {
      if (active) void scanRef.current();
    };

    run();
    const timer = setInterval(run, SCAN_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });

    return () => {
      active = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [enabled]);
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
      if (result.found > 0 || result.newlySpendable > 0 || result.newlySpent > 0) {
        await queryClient.invalidateQueries({ queryKey: QK.poolBalance });
        // A scan is also how received money first appears in history, so the list must refresh.
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

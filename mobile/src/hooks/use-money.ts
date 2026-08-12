/**
 * The one balance a screen should ask for.
 *
 * Prova has two balance sources and they must not be mixed up:
 *
 *   - **simulated** (`EXPO_PUBLIC_DEPOSIT_MODE=simulated`) — a counter in the enclave. No chain,
 *     instant, for the dev loop.
 *   - **anchor** — the real shielded pool: value backed by tokens the contract custodies.
 *
 * Docs/shielded-pool.md is explicit that the pool *supersedes* the local counter, so the counter is
 * a development convenience, not a second kind of money. This hook picks the right source once, so
 * no screen has to know which mode it is in — and so the two can never be added together, which
 * would invent money that does not exist.
 */

import { usePoolBalance } from './use-pool';
import { settlementDenomination } from '@/lib/balance';
import { useBalance, useDenomination } from '@/lib/queries';
import { env } from '@/config/env';
import type { Denomination } from '@prova/shared';

/** Whether this build's money lives in the shielded pool rather than a local counter. */
export const usesPool = env.depositMode === 'anchor';

export interface Money {
  /** Spendable now, in minor units. */
  spendable: number;
  /**
   * Arrived but still confirming, in minor units — real money that cannot move yet.
   *
   * Always zero in simulated mode. In pool mode this is a note waiting to be folded into the Merkle
   * tree; a spend proves membership, and an unfolded commitment is not yet a leaf.
   */
  pending: number;
  /**
   * The most that can be sent in a single transfer, in minor units.
   *
   * Equal to `spendable` unless the balance is split across notes — the spend circuit takes one
   * input note, so the total is not always sendable at once.
   */
  largestNote: number;
  /** What the amounts are denominated in — `null` until money has actually arrived. */
  denom: Denomination | null | undefined;
  isLoading: boolean;
}

/**
 * Spendable and confirming balance for the current deposit mode.
 *
 * Callers must render `pending` separately and never sum it into `spendable`: offering to send
 * money that cannot move produces a contract-level failure instead of a UI-level explanation.
 */
export function useMoney(): Money {
  const local = useBalance();
  const pool = usePoolBalance();
  const denom = useDenomination();

  if (usesPool) {
    const spendable = pool.data?.spendable ?? 0;
    const pending = pool.data?.pending ?? 0;
    const largestNote = pool.data?.largestNote ?? 0;
    // Pool notes are denominated in whatever the contract custodies, which is this build's
    // settlement asset. The recorded denomination is only written by the simulated-credit path, so
    // it is not the source of truth here — but "no money at all" still means no unit to show.
    return {
      spendable,
      pending,
      largestNote,
      denom: spendable + pending > 0 ? settlementDenomination() : null,
      isLoading: pool.isLoading,
    };
  }
  return {
    spendable: local.data ?? 0,
    pending: 0,
    // Simulated mode is a single counter, not notes, so the whole balance is always sendable.
    largestNote: local.data ?? 0,
    denom: denom.data,
    isLoading: local.isLoading || denom.isLoading,
  };
}

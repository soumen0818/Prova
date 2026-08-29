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
  /**
   * Everything this wallet owns, in minor units — `spendable + pending`.
   *
   * **This is the figure to display.** `spendable` is a spending constraint, not a statement of what
   * someone has, and showing it as "your balance" makes money appear to vanish: paying the whole of a
   * single note marks that note spent and returns the change unfolded, so `spendable` legitimately
   * drops to zero for a fold cycle while the person still owns almost all of it. A payments app that
   * shows 0.00 right after a payment reads as "my money is gone", which is the one thing it must
   * never say by accident.
   *
   * Pair it with `pending` — which names the part that cannot move yet — so nothing is hidden.
   */
  total: number;
  /**
   * Spendable now, in minor units.
   *
   * The **guard**, not the display value. Anything deciding whether a send can proceed reads this;
   * anything telling a person what they have reads `total`.
   */
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
  /**
   * True when everything in `pending` is change returning from this wallet's own send.
   *
   * Lets the balance screen name the number instead of just showing it. Paying 200 out of a 900 note
   * leaves 700 confirming, and an unexplained 700 beside a 200 payment reads as a much larger sum
   * having gone astray. Always false in simulated mode, which has no notes.
   */
  pendingIsChange: boolean;
  /** What the amounts are denominated in — `null` until money has actually arrived. */
  denom: Denomination | null | undefined;
  isLoading: boolean;
}

/**
 * Balance for the current deposit mode, split by what it is for.
 *
 * **Display `total`. Gate on `spendable`.** Those are two different questions — "how much do I have"
 * and "how much can leave right now" — and the earlier rule here answered both with `spendable`.
 * That was wrong in a way that only showed up on the most ordinary action in the app: send your whole
 * balance from a single note, and the input is marked spent while the change comes back unfolded, so
 * `spendable` is genuinely 0 for a fold cycle. The screen said **0.00** to somebody who had just
 * paid, and who still owned nearly all of it.
 *
 * `pending` is still rendered separately and still must never be offered as sendable — a note that is
 * not yet a leaf cannot be spent, and letting someone tap Send on it moves the refusal from the
 * screen to the contract. Showing it inside the total is not the same as offering it.
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
      total: spendable + pending,
      spendable,
      pending,
      largestNote,
      pendingIsChange: pool.data?.pendingIsChange ?? false,
      denom: spendable + pending > 0 ? settlementDenomination() : null,
      isLoading: pool.isLoading,
    };
  }
  return {
    // Simulated mode has a single counter and nothing unfolded, so the two are always equal.
    total: local.data ?? 0,
    spendable: local.data ?? 0,
    pending: 0,
    // Simulated mode is a single counter, not notes, so the whole balance is always sendable.
    largestNote: local.data ?? 0,
    pendingIsChange: false,
    denom: denom.data,
    isLoading: local.isLoading || denom.isLoading,
  };
}

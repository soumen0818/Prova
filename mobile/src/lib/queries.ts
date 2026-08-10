/**
 * React Query data layer — shared client + typed hooks over the backend API. Screens use these for
 * caching, retries, and loading/error states instead of hand-rolled fetches.
 */
import { QueryClient, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { env } from '@/config/env';
import { listActivity } from './activity';
import { getHealth, getHistory } from './api';
import { logger } from './logger';
import { getBalanceMinor, getDenomination } from './balance';
import { getBackupMeta } from './cloud-backup';
import { getStoredCredential, isExpired } from './kyc';
import { listRecipients } from './recipients';
import { getSession } from './session';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

/** Backend liveness — polled, drives the connection-status indicator. */
export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
    refetchInterval: 20_000,
    retry: 0,
  });
}

/**
 * The backend's settlement asset when it disagrees with this build's — otherwise `null`.
 *
 * `env.depositAsset` is printed on every balance, but nothing on the client validates it. The
 * backend's `ANCHOR_ASSET` is the checked one: discovering the issuer fails outright if the anchor's
 * stellar.toml doesn't list that code. So a difference means this app is labelling the asset wrongly
 * — real USDC shown as `SRT`, say — which is worth surfacing rather than swallowing.
 *
 * `null` also covers "backend unreachable, or too old to report it". An unknown value is not a
 * mismatch, and must not be presented as one.
 */
export function useAssetMismatch(): { backend: string; app: string } | null {
  const { data } = useHealth();
  const backend = data?.anchorAsset;
  const app = env.depositAsset;
  const mismatched = !!backend && backend !== app;

  useEffect(() => {
    if (mismatched) {
      logger.warn('settlement asset mismatch: balances are labelled with the wrong asset', {
        backend,
        app,
      });
    }
  }, [mismatched, backend, app]);

  return mismatched && backend ? { backend, app } : null;
}

/** Recent transfer history. */
export function useHistory() {
  return useQuery({ queryKey: ['history'], queryFn: getHistory });
}

/**
 * The wallet's own transaction history, read from the device.
 *
 * Not a server call, and it cannot become one: the backend never learns an amount, and asking it
 * "what did I do?" would hand it the link between a user and their notes. See `lib/activity`.
 */
export function useActivity() {
  return useQuery({ queryKey: QK.activity, queryFn: listActivity, staleTime: 0 });
}

/** On-device spendable balance (minor units). Invalidate `['balance']` after deposit/send. */
export function useBalance() {
  return useQuery({ queryKey: ['balance'], queryFn: getBalanceMinor, staleTime: 0 });
}

/**
 * What the balance is denominated in — `null` until money has actually arrived.
 *
 * Separate from `useBalance` because it changes on a different clock: the amount moves on every
 * send, the unit is written once when funds first land. Invalidated by `QK.balance` callers via
 * `QK.denomination`.
 */
export function useDenomination() {
  return useQuery({ queryKey: ['denomination'], queryFn: getDenomination, staleTime: 0 });
}

/** Saved beneficiaries. Invalidate `['recipients']` after add/remove. */
export function useRecipients() {
  return useQuery({ queryKey: ['recipients'], queryFn: listRecipients, staleTime: 0 });
}

/** Signed-in account. Invalidate `['session']` after rename. */
export function useSession() {
  return useQuery({ queryKey: ['session'], queryFn: getSession, staleTime: 0 });
}

/**
 * Whether the user may transact: a credential is present **and still valid**.
 *
 * Expiry matters — an expired credential produces a proof the contract rejects, so treating "a
 * credential exists" as "verified" would let someone start a payment that could only fail.
 */
export function useKycVerified() {
  return useQuery({
    queryKey: ['kyc-verified'],
    queryFn: async () => {
      const cred = await getStoredCredential();
      return cred !== null && !isExpired(cred);
    },
    staleTime: 0,
  });
}

/** Cloud-backup state (enabled, account, last sync). Invalidate `['backup']` after changes. */
export function useBackupMeta() {
  return useQuery({ queryKey: ['backup'], queryFn: getBackupMeta, staleTime: 0 });
}

/** Query keys, so screens invalidate consistently after mutations. */
export const QK = {
  balance: ['balance'] as const,
  /** Balance denomination. Invalidate alongside `balance` after a deposit — funding can set it. */
  denomination: ['denomination'] as const,
  recipients: ['recipients'] as const,
  session: ['session'] as const,
  kyc: ['kyc-verified'] as const,
  history: ['history'] as const,
  /** The device's own record of deposits, sends and cash-outs. */
  activity: ['activity'] as const,
  /** The user's support conversation with the team. */
  support: ['support'] as const,
  backup: ['backup'] as const,
  /** Shielded-pool balance: spendable vs still-confirming. */
  poolBalance: ['pool-balance'] as const,
  /** Pool health — tree size and folder queue depth. */
  poolStatus: ['pool-status'] as const,
};

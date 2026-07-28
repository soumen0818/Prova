/**
 * React Query data layer — shared client + typed hooks over the backend API. Screens use these for
 * caching, retries, and loading/error states instead of hand-rolled fetches.
 */
import { QueryClient, useQuery } from '@tanstack/react-query';

import { getHealth, getHistory } from './api';
import { getBalanceMinor } from './balance';
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

/** Recent transfer history. */
export function useHistory() {
  return useQuery({ queryKey: ['history'], queryFn: getHistory });
}

/** On-device spendable balance (minor units). Invalidate `['balance']` after deposit/send. */
export function useBalance() {
  return useQuery({ queryKey: ['balance'], queryFn: getBalanceMinor, staleTime: 0 });
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
  recipients: ['recipients'] as const,
  session: ['session'] as const,
  kyc: ['kyc-verified'] as const,
  history: ['history'] as const,
  backup: ['backup'] as const,
};

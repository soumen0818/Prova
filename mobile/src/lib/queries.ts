/**
 * React Query data layer — shared client + typed hooks over the backend API. Screens use these for
 * caching, retries, and loading/error states instead of hand-rolled fetches.
 */
import { QueryClient, useQuery } from '@tanstack/react-query';

import { getHealth, getHistory } from './api';

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

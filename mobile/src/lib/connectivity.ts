/**
 * Connectivity state — the single source of truth for "can the app work right now?".
 *
 * Combines three independent signals so the UI can tell the user something *true* rather than a
 * generic failure:
 *
 *   1. **device network** (`expo-network`) — is there a link at all, and is the internet reachable?
 *   2. **backend health** — can we reach Prova, and is it in maintenance? (server-driven, see
 *      backend `/healthz`; maintenance is announced by the server, never hardcoded here)
 *   3. **latency** — how long the health probe took, which distinguishes "slow" from "broken"
 *
 * Precedence matters: offline beats maintenance beats unreachable beats slow. A user with no signal
 * should be told they're offline, not that our servers are down.
 */
import { useNetworkState } from 'expo-network';
import { useMemo } from 'react';

import { useHealth } from './queries';

/** Requests slower than this mean a weak connection — warn, but keep working. */
export const SLOW_MS = 2500;

export type ConnectionState =
  /** No usable device network. */
  | 'offline'
  /** Backend reports planned downtime. */
  | 'maintenance'
  /** Device is online but Prova can't be reached. */
  | 'unreachable'
  /** Working, but slow enough that the user should be warned before paying. */
  | 'slow'
  | 'online';

export interface Connectivity {
  state: ConnectionState;
  /** True while the first health probe is still resolving (avoid flashing an error at launch). */
  isChecking: boolean;
  /** Anything that should block money movement. */
  canTransact: boolean;
  /** Server-supplied maintenance copy (never invented client-side). */
  maintenanceMessage?: string;
  /** Optional ISO-8601 estimate of when service returns. */
  maintenanceUntil?: string;
  /** Last measured round-trip to the backend, in ms. */
  latencyMs?: number;
  /** Re-run the health probe (the Retry button). */
  retry: () => void;
}

/**
 * Resolve the current connectivity state.
 *
 * Note it deliberately does NOT treat "backend unreachable" as offline: the distinction changes what
 * the user should do (check your wifi vs. wait for us).
 */
export function useConnectivity(): Connectivity {
  const net = useNetworkState();
  const health = useHealth();

  return useMemo(() => {
    const retry = () => void health.refetch();
    const latencyMs = health.data?.latencyMs;

    // `isInternetReachable` is undefined until probed — only trust an explicit false.
    const deviceOffline = net.isConnected === false || net.isInternetReachable === false;
    if (deviceOffline) {
      return { state: 'offline', isChecking: false, canTransact: false, retry, latencyMs };
    }

    if (health.isLoading && !health.data) {
      return { state: 'online', isChecking: true, canTransact: false, retry };
    }

    if (health.data?.maintenance) {
      return {
        state: 'maintenance',
        isChecking: false,
        canTransact: false,
        maintenanceMessage: health.data.maintenanceMessage,
        maintenanceUntil: health.data.maintenanceUntil,
        retry,
        latencyMs,
      };
    }

    if (health.isError) {
      return { state: 'unreachable', isChecking: false, canTransact: false, retry, latencyMs };
    }

    if (latencyMs !== undefined && latencyMs > SLOW_MS) {
      // Still usable — we warn rather than block, but callers should guard against double-submits.
      return { state: 'slow', isChecking: false, canTransact: true, retry, latencyMs };
    }

    return { state: 'online', isChecking: false, canTransact: true, retry, latencyMs };
  }, [net.isConnected, net.isInternetReachable, health]);
}

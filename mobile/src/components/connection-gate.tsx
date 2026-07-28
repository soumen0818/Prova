import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';

import { MaintenanceMark, OfflineMark } from '@/components/illustrations';
import { StateView } from '@/components/state-view';
import { useConnectivity } from '@/lib/connectivity';

/**
 * Hard gate for screens that move money or show live balances (send, deposit, activity).
 *
 * The banner informs everywhere; this *blocks*. Rendering a stale balance or accepting a transfer
 * while we can't reach the network is worse than refusing: the user would act on numbers we can't
 * confirm, or fire a payment we can't track. So those screens are replaced entirely until service
 * returns, with an explicit Retry rather than a silent spinner.
 *
 * Note what it does NOT block: a merely *slow* connection still lets the user proceed (the banner
 * warns instead), because blocking on latency would strand people on bad mobile networks — exactly
 * the users this product exists for.
 */
export function ConnectionGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { state, isChecking, maintenanceMessage, maintenanceUntil, retry } = useConnectivity();

  // Don't flash an error while the first probe is still in flight.
  if (isChecking) return <>{children}</>;

  if (state === 'offline') {
    return (
      <StateView
        illustration={<OfflineMark />}
        title="You’re offline"
        body="Check your mobile data or Wi-Fi. We’ve paused anything that moves money until you’re back."
        reassurance="Your balance and account are safe."
        primaryLabel="Try again"
        onPrimary={retry}
        secondaryLabel="Go to home"
        onSecondary={() => router.replace('/')}
      />
    );
  }

  if (state === 'maintenance') {
    return (
      <StateView
        illustration={<MaintenanceMark />}
        title="Back shortly"
        body={maintenanceMessage ?? 'We’re carrying out scheduled maintenance.'}
        reassurance={
          maintenanceUntil
            ? `Expected back around ${formatUntil(maintenanceUntil)}. Your funds are safe.`
            : 'Your funds and account are safe.'
        }
        primaryLabel="Check again"
        onPrimary={retry}
        secondaryLabel="Go to home"
        onSecondary={() => router.replace('/')}
      />
    );
  }

  if (state === 'unreachable') {
    return (
      <StateView
        illustration={<OfflineMark />}
        title="Can’t reach Prova"
        body="You’re connected, but our service isn’t responding right now."
        reassurance="Your funds are safe. Nothing was sent."
        primaryLabel="Try again"
        onPrimary={retry}
        secondaryLabel="Go to home"
        onSecondary={() => router.replace('/')}
      />
    );
  }

  return <>{children}</>;
}

/** Render the server's ISO estimate in the device's locale, falling back to the raw value. */
function formatUntil(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

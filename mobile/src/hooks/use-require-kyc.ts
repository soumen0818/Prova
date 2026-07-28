import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import { useToast } from '@/components/toast';
import { useKycVerified } from '@/lib/queries';

/**
 * Gate for anything that moves money.
 *
 * Deliberately blocks the **action**, not the screen: an unverified user can still browse the app,
 * see their balance and read their history — they simply can't send or add funds. Hiding the
 * product until someone hands over their passport is a bad way to earn that trust.
 *
 * Verification is legally required before value moves (see Docs/kyc-verification.md), so this is a
 * hard stop rather than a warning. It explains why, then takes the user somewhere they can fix it.
 *
 * Usage:
 *   const requireKyc = useRequireKyc();
 *   <Button onPress={() => requireKyc(() => router.push('/send'))} />
 */
export function useRequireKyc() {
  const router = useRouter();
  const toast = useToast();
  const { data: verified, isLoading } = useKycVerified();

  return useCallback(
    (action: () => void) => {
      // Still resolving — don't guess. Letting the action through could start an unverified
      // payment; blocking it would nag a verified user. Ask them to retry in a moment instead.
      if (isLoading) {
        toast.info('One moment…');
        return;
      }
      if (verified) {
        action();
        return;
      }
      toast.error('Verify your identity to send or add money');
      router.push('/kyc');
    },
    [isLoading, verified, router, toast],
  );
}

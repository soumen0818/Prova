import { Stack, useRouter } from 'expo-router';

import { NotFoundMark } from '@/components/illustrations';
import { StateView } from '@/components/state-view';

/**
 * 404 — reached via an invalid deep link, a stale QR code, or an internal route that no longer
 * exists. Expo Router renders this automatically for any unmatched path, so it covers links we
 * never anticipated rather than only the ones we remembered to handle.
 */
export default function NotFoundScreen() {
  const router = useRouter();
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <StateView
        illustration={<NotFoundMark />}
        title="Page not found"
        body="That link doesn’t lead anywhere. It may have expired, or been mistyped."
        primaryLabel="Go to home"
        onPrimary={() => router.replace('/')}
      />
    </>
  );
}

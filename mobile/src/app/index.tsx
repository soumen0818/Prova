import { Redirect } from 'expo-router';

import { BrandedLoading } from '@/components/animated-icon';
import { AppShell } from '@/components/app-shell';
import { useSession } from '@/lib/queries';

/**
 * Root gate. While the session is loading we show the branded loading screen; a signed-out user is
 * sent to the welcome/sign-in flow; a signed-in user gets the app shell (tabs + flows).
 */
export default function Index() {
  const { data: session, isLoading } = useSession();

  if (isLoading) {
    return <BrandedLoading caption="Securing your session…" />;
  }
  if (!session) {
    return <Redirect href="/welcome" />;
  }
  return <AppShell />;
}

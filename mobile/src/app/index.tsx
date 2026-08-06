import { Redirect } from 'expo-router';

import { AppShell } from '@/components/app-shell';
import { useSession } from '@/lib/queries';

/**
 * Root gate: a signed-out user goes to the welcome/sign-in flow, a signed-in user gets the app
 * shell (tabs + flows).
 *
 * The session is a single secure-store read, so `isLoading` lasts a frame or two. Rendering nothing
 * for that beat leaves the navigator's own brand background showing — deliberately quieter than a
 * spinner, which would flash in and straight back out and make launch feel slower than it is.
 */
export default function Index() {
  const { data: session, isLoading } = useSession();

  if (isLoading) return null;
  if (!session) return <Redirect href="/welcome" />;
  return <AppShell />;
}

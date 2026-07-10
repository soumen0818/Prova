import { Redirect } from 'expo-router';
import { View } from 'react-native';

import { AppShell } from '@/components/app-shell';
import { useSession } from '@/lib/queries';
import { Palette } from '@/constants/theme';

/**
 * Root gate. While the session is loading we hold a blank dark screen; a signed-out user is sent to
 * the welcome/sign-in flow; a signed-in user gets the app shell (tabs + flows).
 */
export default function Index() {
  const { data: session, isLoading } = useSession();

  if (isLoading) {
    return <View style={{ flex: 1, backgroundColor: Palette.bgBase }} />;
  }
  if (!session) {
    return <Redirect href="/welcome" />;
  }
  return <AppShell />;
}
